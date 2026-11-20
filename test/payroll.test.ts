import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IncrementalMerkleTreePoseidon,
  NATIVE_ASSET,
  decodeNotePackage,
  decodeShortClaim,
  generateReceiveKey,
  hexToField,
  makeBoundNotePoseidon,
  openSealedTicket,
  shortClaimBodyIn,
} from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { parseAmountUnits, parsePayrollCsv } from "../src/csv.js";
import {
  decodePayrollProofToken,
  extractPaidProofInputs,
  generatePayrollProofBundle,
  verifyPayrollProofBundleOffline,
} from "../src/proof.js";
import {
  buildPaymentDelivery,
  buildPayoutExport,
  createInitialRunState,
  planPayroll,
  preparePayrollTransfer,
  reconcileUnconfirmedRow,
  resolveAsset,
  resolveNetwork,
  ticketToMemoBytes,
} from "../src/runner.js";
import { loadRunState, saveRunState } from "../src/state.js";

test("parsePayrollCsv handles delimiters, quoted thousands, gloam tags, and caps", async () => {
  const receiveKey = await generateReceiveKey();

  const csv = [
    "name,gloam_address,amount,note",
    `Ada Obi,${receiveKey.tag},"1,250.50",November salary`,
    "Tunde Bello,,980,Invoice 7",
  ].join("\n");

  const parsed = parsePayrollCsv(csv, 6);
  assert.equal(parsed.fatalError, null);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]!.kind, "gloam");
  assert.equal(parsed.rows[0]!.amountWei, 1_250_500_000n);
  assert.equal(parsed.rows[1]!.kind, "link");
  assert.equal(parsed.rows[1]!.amountWei, 980_000_000n);
  assert.equal(parsed.totalWei, 2_230_500_000n);

  // Semicolon list with ambiguous European decimal comma must be rejected cleanly.
  const euroCsv = "name;gloam_address;amount\nBad Row;;1,25\n";
  const euro = parsePayrollCsv(euroCsv, 6);
  assert.equal(euro.rows.length, 0);
  assert.equal(euro.issues.length, 1);

  // Invalid gloamr1 tag must fail row validation.
  const badTag = parsePayrollCsv("name,gloam_address,amount\nEve,gloamr1.notvalid,100", 6);
  assert.equal(badTag.rows.length, 0);
  assert.equal(badTag.issues.length, 1);

  // Cap guard blocks runs over --max-total.
  const capped = parsePayrollCsv(csv, 6, { maxTotalWei: 2_000_000_000n });
  assert.match(capped.fatalError ?? "", /exceeds configured --max-total/);
  assert.equal(parseAmountUnits("1,25", 6), null);
  assert.equal(parseAmountUnits("1,250.1234567", 6), null);
});

test("note-chain private payroll + ECDH ticket + compact short claim link + gloamroll1 proof round-trip", async () => {
  const net = resolveNetwork("tempo-mainnet");
  const asset = resolveAsset(net, "USDC.e");
  const adaKey = await generateReceiveKey();
  const chidiKey = await generateReceiveKey();

  const csv = [
    "name,gloam_address,amount,note",
    `Ada Obi,${adaKey.tag},1250,November salary`,
    "Tunde Bello,,980,Contractor invoice",
    `Chidi Eze,${chidiKey.tag},770,Security review`,
  ].join("\n");

  const plan = planPayroll({ csvText: csv, networkKey: net.key, assetInput: asset.symbol });
  assert.equal(plan.fatalError, null);
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.totalWei, 3_000_000_000n);
  assert.deepEqual(plan.proofParts, [3]);

  // Seed a real Poseidon funding note into an IncrementalMerkleTreePoseidon.
  const funding = await makeBoundNotePoseidon(plan.totalWei, asset.address);
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.init();
  let currentLeafIndex = await tree.insert(hexToField(funding.commitment));

  const state = createInitialRunState({
    id: "test-run-1",
    net,
    asset,
    rows: plan.validRows,
    relay: true,
    activeNote: {
      secret: funding.secret,
      commitment: funding.commitment,
      amountWei: plan.totalWei.toString(),
      asset: asset.address,
    },
  });

  // Mock only the snarkjs Groth16 binary call while running 100% real SDK Poseidon/Merkle/ECDH/shortLink math.
  const stubTransferProver = async () => ({ proofBytes: "0x1234" as Hex });

  for (const row of state.rows) {
    const active = state.activeNote!;
    const path = await tree.path(currentLeafIndex);
    const payAmountWei = BigInt(row.amountWei);

    const prepared = await preparePayrollTransfer({
      chainId: net.chainId,
      pool: net.pool,
      asset: asset.address,
      spendSecret: active.secret,
      spendAmountWei: BigInt(active.amountWei),
      payAmountWei,
      path,
      prove: stubTransferProver,
      useShortSeed: row.kind === "link",
    });

    const delivery = await buildPaymentDelivery({
      chainId: net.chainId,
      pool: net.pool,
      asset: asset.address,
      kind: row.kind,
      recipient: row.recipient,
      amountWei: payAmountWei,
      secret: prepared.paymentNote.secret,
      commitment: prepared.paymentCommitment,
      seed: prepared.paymentSeed,
      note: row.note || undefined,
    });

    // Verify delivery artifacts decode cleanly with real SDK receivers.
    if (row.kind === "gloam") {
      assert.ok(delivery.sealedTicket?.startsWith("gloam2t."));
      const receiverKey = row.name === "Ada Obi" ? adaKey : chidiKey;
      const plaintext = await openSealedTicket(delivery.sealedTicket!, receiverKey);
      const opened = decodeNotePackage(plaintext);
      assert.equal(opened.commitment.toLowerCase(), prepared.paymentCommitment.toLowerCase());
      assert.equal(opened.amountWei, payAmountWei.toString());
      assert.equal(opened.note, row.note);
      const memoHex = ticketToMemoBytes(delivery.sealedTicket!);
      assert.ok(memoHex.startsWith("0x") && memoHex.length > 20);
    } else {
      // Seed-backed short link must stay compact (~30-60 chars) and decode to the exact commitment.
      assert.ok(delivery.delivery.startsWith("https://gloam.trade/c#"));
      const body = shortClaimBodyIn(delivery.delivery);
      assert.ok(body, "short claim link body should parse");
      const decoded = await decodeShortClaim(body!);
      assert.equal(decoded.commitment.toLowerCase(), prepared.paymentCommitment.toLowerCase());
      assert.equal(decoded.amountWei, payAmountWei.toString());
      assert.equal(decoded.note, row.note);
    }

    // Insert transfer outputs [paymentCommitment, changeCommitment] into tree just like the vault contract.
    await tree.insert(hexToField(prepared.paymentCommitment));
    const changeLeafIdx = await tree.insert(hexToField(prepared.changeCommitment));

    const changeAmt = BigInt(active.amountWei) - payAmountWei;
    row.status = "paid";
    row.spendSecret = active.secret;
    row.spendAmountWei = active.amountWei;
    row.spendCommitment = active.commitment;
    row.spendNullifier = prepared.nullifier;
    row.paymentSeed = prepared.paymentSeed;
    row.paymentSecret = prepared.paymentNote.secret;
    row.paymentCommitment = prepared.paymentCommitment;
    row.changeSecret = prepared.changeNote.secret;
    row.changeCommitment = prepared.changeCommitment;
    row.changeAmountWei = changeAmt.toString();
    row.delivery = delivery.delivery;
    row.sealedTicket = delivery.sealedTicket;
    row.txHash = (`0x${(row.index + 1).toString(16).padStart(64, "0")}`) as Hex;

    if (changeAmt > 0n) {
      currentLeafIndex = changeLeafIdx;
      state.activeNote = {
        secret: prepared.changeNote.secret,
        commitment: prepared.changeCommitment,
        amountWei: changeAmt.toString(),
        asset: asset.address,
      };
    } else {
      state.activeNote = null;
    }
  }

  // Final change note should be 0 (exact funding spent).
  assert.equal(state.activeNote, null);

  // Persist atomically with 0600 permissions and reload.
  const dir = mkdtempSync(join(tmpdir(), "gloam-payroll-test-"));
  try {
    const ledgerPath = join(dir, "run.json");
    saveRunState(ledgerPath, state);
    const mode = statSync(ledgerPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const reloaded = loadRunState(ledgerPath);
    assert.equal(reloaded.rows.length, 3);

    const exportCsv = buildPayoutExport(reloaded);
    assert.match(exportCsv, /Ada Obi,gloam,1250/);
    assert.match(exportCsv, /Tunde Bello,link,980,Contractor invoice,paid,https:\/\/gloam\.trade\/c#/);

    // Build and verify gloamroll1 proof bundle from reloaded ledger.
    const { inputs, skipped } = extractPaidProofInputs(reloaded);
    assert.equal(skipped, 0);
    assert.equal(inputs.length, 3);

    const { bundle, token } = await generatePayrollProofBundle({
      chainId: net.chainId,
      pool: net.pool,
      asset: asset.address,
      payments: inputs,
      verifier: "Acme External Audit",
      prover: async (circomInput) => ({
        proof: { pi_a: [], pi_b: [], pi_c: [] },
        publicSignals: [
          String(circomInput.asset),
          String(circomInput.total),
          String(circomInput.count),
          String(circomInput.paymentsHash),
          String(circomInput.context),
        ],
      }),
    });

    assert.ok(token.startsWith("gloamroll1:"));
    const decoded = decodePayrollProofToken(token);
    assert.equal(decoded.total, "3000000000");
    assert.equal(decoded.count, 3);
    assert.equal(decoded.parts.length, 1);

    const check = await verifyPayrollProofBundleOffline(decoded);
    assert.equal(check.ok, true, check.errors.join("; "));
    assert.equal(check.expired, false);

    // Tampering with verifier label must fail context binding check.
    const tampered = { ...bundle, verifier: "Wrong Auditor" };
    const tamperedCheck = await verifyPayrollProofBundleOffline(tampered);
    assert.equal(tamperedCheck.ok, false);
    assert.match(tamperedCheck.errors[0] ?? "", /context public signal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-part payroll proof splits 33 payments evenly into [17, 16] (never a lone salary)", async () => {
  const net = resolveNetwork("robinhood");
  const asset = NATIVE_ASSET;
  const payments = [];

  for (let i = 0; i < 33; i++) {
    const spend = await makeBoundNotePoseidon(10_000n, asset);
    const pay = await makeBoundNotePoseidon(BigInt(100 + i), asset);
    payments.push({
      secretHex: pay.secret,
      amount: BigInt(100 + i),
      spendSecretHex: spend.secret,
      spendAmount: 10_000n,
      txHash: (`0x${(i + 1).toString(16).padStart(64, "0")}`) as Hex,
    });
  }

  const { bundle } = await generatePayrollProofBundle({
    chainId: net.chainId,
    pool: net.pool,
    asset,
    payments,
    verifier: "Board Audit",
    prover: async (circomInput) => ({
      proof: { pi_a: [], pi_b: [], pi_c: [] },
      publicSignals: [
        String(circomInput.asset),
        String(circomInput.total),
        String(circomInput.count),
        String(circomInput.paymentsHash),
        String(circomInput.context),
      ],
    }),
  });

  assert.equal(bundle.parts.length, 2);
  assert.equal(bundle.parts[0]!.publicSignals[2], "17");
  assert.equal(bundle.parts[1]!.publicSignals[2], "16");

  const check = await verifyPayrollProofBundleOffline(bundle);
  assert.equal(check.ok, true, check.errors.join("; "));
  assert.equal(check.partCount, 2);
});

test("crash-safe resume reconciliation handles landed, spent-elsewhere, and retry-safe states", async () => {
  const net = resolveNetwork("robinhood");
  const asset = resolveAsset(net);
  const parsed = parsePayrollCsv("name,gloam_address,amount\nAda,,0.0005\n", asset.decimals);

  const makeState = () => {
    const s = createInitialRunState({
      id: "resume-test",
      net,
      asset,
      rows: parsed.rows,
      relay: true,
      activeNote: null,
    });
    const r = s.rows[0]!;
    r.status = "unconfirmed";
    r.spendNullifier = `0x${"aa".repeat(32)}` as Hex;
    r.paymentCommitment = `0x${"bb".repeat(32)}` as Hex;
    r.changeSecret = `0x${"cc".repeat(32)}` as Hex;
    r.changeCommitment = `0x${"dd".repeat(32)}` as Hex;
    r.changeAmountWei = "250000000000000";
    return s;
  };

  // Case 1: Commitment already seen in pool -> mark paid and recover changeNote.
  const s1 = makeState();
  const v1 = await reconcileUnconfirmedRow(s1, s1.rows[0]!, {
    commitmentSeen: async () => true,
    isSpent: async () => true,
  });
  assert.equal(v1, "already_paid");
  assert.equal(s1.rows[0]!.status, "paid");
  assert.equal(s1.activeNote?.commitment, s1.rows[0]!.changeCommitment);

  // Case 2: Commitment absent, nullifier spent elsewhere -> halt safely.
  const s2 = makeState();
  const v2 = await reconcileUnconfirmedRow(s2, s2.rows[0]!, {
    commitmentSeen: async () => false,
    isSpent: async () => true,
  });
  assert.equal(v2, "spent_elsewhere");
  assert.equal(s2.rows[0]!.status, "failed");

  // Case 3: Neither seen nor spent -> safe to retry.
  const s3 = makeState();
  const v3 = await reconcileUnconfirmedRow(s3, s3.rows[0]!, {
    commitmentSeen: async () => false,
    isSpent: async () => false,
  });
  assert.equal(v3, "retry_safe");
});
