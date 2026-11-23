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
  fieldToBytes32,
  generateReceiveKey,
  hexToField,
  makeBoundNotePoseidon,
  openSealedTicket,
  shortClaimBodyIn,
} from "@gloamtrade/sdk";
import type { Hex } from "viem";
import {
  escapeCsvCell,
  formatPayoutCsv,
  parseAmountUnits,
  parsePayrollCsv,
  parseSolanaPayrollCsv,
} from "../src/csv.js";
import {
  isBlockedGloamName,
  lookupGloamName,
  nameFromPayInput,
  receiveTagFromPoint,
} from "../src/names.js";
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
  planPayrollWithNames,
  preparePayrollTransfer,
  prepareSamePayrollTransfer,
  reconcileFundingNote,
  reconcileUnconfirmedRow,
  resolveAsset,
  resolveNetwork,
  ticketToMemoBytes,
} from "../src/runner.js";
import {
  buildSolanaPayoutExport,
  createInitialSolanaRunState,
  planSolanaPayroll,
  reconcileSolanaUnconfirmedRow,
  resolveSolanaAsset,
} from "../src/solana.js";
import {
  isSolanaRunState,
  loadAnyRunState,
  loadRunState,
  saveRunState,
} from "../src/state.js";

function p256CoordsFromTag(tag: string): { x: Hex; y: Hex } {
  const b64 = tag.slice("gloamr1.".length).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const spki = Buffer.from(b64 + pad, "base64");
  const xy = spki.subarray(27);
  return {
    x: `0x${xy.subarray(0, 32).toString("hex")}` as Hex,
    y: `0x${xy.subarray(32, 64).toString("hex")}` as Hex,
  };
}

test("parsePayrollCsv handles delimiters, quoted thousands, gloam tags, @names, 0x refusal, and caps", async () => {
  const receiveKey = await generateReceiveKey();

  const csv = [
    "name,gloam_address,amount,note",
    `Ada Obi,${receiveKey.tag},"1,250.50",November salary`,
    "Yomi Ade,@Yomi_1,500,Design retainer",
    "Tunde Bello,,980,Invoice 7",
  ].join("\n");

  const parsed = parsePayrollCsv(csv, 6);
  assert.equal(parsed.fatalError, null);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0]!.kind, "gloam");
  assert.equal(parsed.rows[0]!.amountWei, 1_250_500_000n);
  assert.equal(parsed.rows[1]!.kind, "gloam");
  assert.equal(parsed.rows[1]!.payName, "yomi_1");
  assert.equal(parsed.rows[1]!.recipient, "");
  assert.equal(parsed.rows[2]!.kind, "link");
  assert.equal(parsed.rows[2]!.amountWei, 980_000_000n);
  assert.equal(parsed.totalWei, 2_730_500_000n);

  // Semicolon list with ambiguous European decimal comma must be rejected cleanly.
  const euroCsv = "name;gloam_address;amount\nBad Row;;1,25\n";
  const euro = parsePayrollCsv(euroCsv, 6);
  assert.equal(euro.rows.length, 0);
  assert.equal(euro.issues.length, 1);

  // Public 0x wallet address must be refused explicitly.
  const ethAddrCsv = "name,gloam_address,amount\nPublic,0x1111111111111111111111111111111111111111,100";
  const ethRes = parsePayrollCsv(ethAddrCsv, 6);
  assert.equal(ethRes.rows.length, 0);
  assert.match(ethRes.issues[0]?.message ?? "", /Public 0x wallet.*refused/);

  // Blocked/impersonation @names must be rejected at parse time.
  const blockedCsv = "name,gloam_name,amount\nScammer,@supp0rt,100\nFake,@gloam_help,50";
  const blockedRes = parsePayrollCsv(blockedCsv, 6);
  assert.equal(blockedRes.rows.length, 0);
  assert.equal(blockedRes.issues.length, 2);
  assert.equal(isBlockedGloamName("support"), true);
  assert.equal(isBlockedGloamName("gloam_team"), true);
  assert.equal(isBlockedGloamName("ada_obi"), false);
  assert.equal(nameFromPayInput("@Ada"), "ada");
  assert.equal(nameFromPayInput("@ab"), null);

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

test("GloamNames resolution reconstructs P-256 receive tags and resolves @name CSV rows", async () => {
  const adaKey = await generateReceiveKey();
  const { x, y } = p256CoordsFromTag(adaKey.tag);

  assert.equal(receiveTagFromPoint(x, y), adaKey.tag);
  // Off-curve point must be rejected.
  assert.equal(
    receiveTagFromPoint(`0x${"00".repeat(31)}01`, `0x${"00".repeat(31)}02`),
    null
  );

  const holder = "0x1234567890123456789012345678901234567890" as const;
  const mockReader = async (name: string) => {
    if (name === "ada") return [holder, x, y, 1_900_000_000n] as const;
    if (name === "flaky") throw new Error("RPC timeout");
    return ["0x0000000000000000000000000000000000000000" as const, `0x${"00".repeat(32)}` as Hex, `0x${"00".repeat(32)}` as Hex, 0n] as const;
  };

  const okRec = await lookupGloamName("ada", mockReader);
  assert.ok(typeof okRec === "object");
  assert.equal(okRec.tag, adaKey.tag);
  assert.equal(await lookupGloamName("nobody", mockReader), "none");
  assert.equal(await lookupGloamName("flaky", mockReader), "failed");
  assert.equal(await lookupGloamName("support", mockReader), "none");

  const csv = [
    "name,gloam_name,amount,note",
    "Ada Obi,@ada,1200,Salary",
    "Ghost,@nobody,500,Missing",
    "Retry,@flaky,300,RPC down",
  ].join("\n");

  const { plan } = await planPayrollWithNames({
    csvText: csv,
    networkKey: "base-mainnet",
    assetInput: "USDC",
    nameReader: mockReader,
  });

  assert.equal(plan.validRows.length, 1);
  assert.equal(plan.validRows[0]!.payName, "ada");
  assert.equal(plan.validRows[0]!.recipient, adaKey.tag);
  assert.equal(plan.nameCount, 1);
  assert.equal(plan.unresolvedNameCount, 0);
  assert.equal(plan.issues.length, 2);
  assert.match(plan.issues[0]!.message, /No one holds @nobody/);
  assert.match(plan.issues[1]!.message, /Couldn't look up @flaky/);
});

test("CSV payout export neutralizes spreadsheet formula injection", () => {
  assert.equal(escapeCsvCell("=HYPERLINK(\"https://evil.example\")"), "\"'=HYPERLINK(\"\"https://evil.example\"\")\"");
  assert.equal(escapeCsvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(escapeCsvCell("-2+3"), "'-2+3");
  assert.equal(escapeCsvCell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(escapeCsvCell("\t=1+1"), "'\t=1+1");
  assert.equal(escapeCsvCell("Ada Obi"), "Ada Obi");

  const exported = formatPayoutCsv([
    {
      name: "=IMPORTXML(A1)",
      payName: "ada",
      kind: "gloam",
      amount: "100",
      note: "+bonus",
      status: "paid",
      delivery: "https://gloam.trade/c#secret",
      txHash: "0xabc",
      memoTxHash: "",
    },
  ]);
  assert.match(exported, /^name,pay_name,kind,amount,note,status,delivery,tx_hash,memo_tx_hash\n/);
  assert.match(exported, /'=IMPORTXML\(A1\),'@ada,gloam,100,'\+bonus,paid,https:\/\/gloam\.trade\/c#secret/);
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
      assert.ok(delivery.delivery.startsWith("https://gloam.trade/c#"));
      const body = shortClaimBodyIn(delivery.delivery);
      assert.ok(body, "short claim link body should parse");
      const decoded = await decodeShortClaim(body!);
      assert.equal(decoded.commitment.toLowerCase(), prepared.paymentCommitment.toLowerCase());
      assert.equal(decoded.amountWei, payAmountWei.toString());
      assert.equal(decoded.note, row.note);
    }

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

  assert.equal(state.activeNote, null);

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

    const tampered = { ...bundle, verifier: "Wrong Auditor" };
    const tamperedCheck = await verifyPayrollProofBundleOffline(tampered);
    assert.equal(tamperedCheck.ok, false);
    assert.match(tamperedCheck.errors[0] ?? "", /context public signal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSamePayrollTransfer re-proves identical outputs against a newer Merkle root", async () => {
  const net = resolveNetwork("base-mainnet");
  const asset = resolveAsset(net, "USDC");
  const funding = await makeBoundNotePoseidon(2_000_000n, asset.address);

  const tree = new IncrementalMerkleTreePoseidon();
  await tree.init();
  const leafIdx = await tree.insert(hexToField(funding.commitment));
  const path1 = await tree.path(leafIdx);

  const stubProver = async (input: Record<string, string | string[]>) => {
    assert.ok(input.secretPay);
    assert.ok(input.newCommitment0);
    return { proofBytes: "0xabcd" as Hex };
  };

  const first = await preparePayrollTransfer({
    chainId: net.chainId,
    pool: net.pool,
    asset: asset.address,
    spendSecret: funding.secret,
    spendAmountWei: 2_000_000n,
    payAmountWei: 750_000n,
    path: path1,
    prove: stubProver,
    useShortSeed: true,
  });

  // Simulate another user's deposit changing the vault root before resume runs.
  const unrelated = await makeBoundNotePoseidon(500_000n, asset.address);
  await tree.insert(hexToField(unrelated.commitment));
  const path2 = await tree.path(leafIdx);
  assert.notEqual(path1.root, path2.root);

  const resent = await prepareSamePayrollTransfer({
    chainId: net.chainId,
    pool: net.pool,
    asset: asset.address,
    spendSecret: funding.secret,
    spendAmountWei: 2_000_000n,
    payAmountWei: 750_000n,
    expectedNullifier: first.nullifier,
    paymentSecret: first.paymentNote.secret,
    paymentCommitment: first.paymentCommitment,
    paymentSeed: first.paymentSeed,
    changeSecret: first.changeNote.secret,
    changeCommitment: first.changeCommitment,
    path: path2,
    prove: stubProver,
  });

  // Same nullifier + exact same payment/change notes & commitments, against the fresh root.
  assert.equal(resent.nullifier, first.nullifier);
  assert.equal(resent.paymentCommitment, first.paymentCommitment);
  assert.equal(resent.changeCommitment, first.changeCommitment);
  assert.equal(resent.paymentNote.secret, first.paymentNote.secret);
  assert.equal(resent.changeNote.secret, first.changeNote.secret);
  assert.equal(resent.intent.exec.args[1], fieldToBytes32(path2.root));

  // Refuses mismatched secret.
  await assert.rejects(
    () =>
      prepareSamePayrollTransfer({
        chainId: net.chainId,
        pool: net.pool,
        asset: asset.address,
        spendSecret: funding.secret,
        spendAmountWei: 2_000_000n,
        payAmountWei: 750_000n,
        expectedNullifier: first.nullifier,
        paymentSecret: `0x${"11".repeat(32)}` as Hex,
        paymentCommitment: first.paymentCommitment,
        changeSecret: first.changeNote.secret,
        changeCommitment: first.changeCommitment,
        path: path2,
        prove: stubProver,
      }),
    /does not open paymentCommitment/
  );
});

test("reconcileFundingNote recovers confirmed, reverted, unsent, and pending shield deposits", async () => {
  const net = resolveNetwork("robinhood");
  const asset = resolveAsset(net);
  const parsed = parsePayrollCsv("name,gloam_address,amount\nAda,,0.0005\n", asset.decimals);

  const make = (over?: { sent?: boolean; txHash?: Hex }) => {
    const s = createInitialRunState({
      id: "fund-test",
      net,
      asset,
      rows: parsed.rows,
      relay: true,
      activeNote: {
        secret: `0x${"01".repeat(32)}` as Hex,
        commitment: `0x${"02".repeat(32)}` as Hex,
        amountWei: "500000000000000",
        asset: asset.address,
      },
    });
    s.fundingShieldSent = over?.sent;
    s.fundingTxHash = over?.txHash;
    return s;
  };

  // Already confirmed on chain.
  const sConfirmed = make({ sent: true, txHash: `0x${"aa".repeat(32)}` as Hex });
  assert.equal(
    await reconcileFundingNote(sConfirmed, {
      commitmentSeen: async () => true,
      isSpent: async () => false,
    }),
    "confirmed"
  );
  assert.notEqual(sConfirmed.activeNote, null);

  // Crashed before writeContract ever broadcast.
  const sUnsent = make({ sent: false });
  assert.equal(
    await reconcileFundingNote(sUnsent, {
      commitmentSeen: async () => false,
      isSpent: async () => false,
    }),
    "cleared_unsent"
  );
  assert.equal(sUnsent.activeNote, null);

  // Broadcast shield tx reverted on chain.
  const sReverted = make({ sent: true, txHash: `0x${"bb".repeat(32)}` as Hex });
  assert.equal(
    await reconcileFundingNote(sReverted, {
      commitmentSeen: async () => false,
      isSpent: async () => false,
      getReceiptStatus: async () => "reverted",
    }),
    "cleared_reverted"
  );
  assert.equal(sReverted.activeNote, null);
  assert.equal(sReverted.fundingTxHash, undefined);

  // Broadcast shield tx still pending: keep activeNote so we never double-shield.
  const sPending = make({ sent: true, txHash: `0x${"cc".repeat(32)}` as Hex });
  assert.equal(
    await reconcileFundingNote(sPending, {
      commitmentSeen: async () => false,
      isSpent: async () => false,
      getReceiptStatus: async () => null,
    }),
    "pending"
  );
  assert.notEqual(sPending.activeNote, null);
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

  const s1 = makeState();
  const v1 = await reconcileUnconfirmedRow(s1, s1.rows[0]!, {
    commitmentSeen: async () => true,
    isSpent: async () => true,
  });
  assert.equal(v1, "already_paid");
  assert.equal(s1.rows[0]!.status, "paid");
  assert.equal(s1.activeNote?.commitment, s1.rows[0]!.changeCommitment);

  const s2 = makeState();
  const v2 = await reconcileUnconfirmedRow(s2, s2.rows[0]!, {
    commitmentSeen: async () => false,
    isSpent: async () => true,
  });
  assert.equal(v2, "spent_elsewhere");
  assert.equal(s2.rows[0]!.status, "failed");

  const s3 = makeState();
  const v3 = await reconcileUnconfirmedRow(s3, s3.rows[0]!, {
    commitmentSeen: async () => false,
    isSpent: async () => false,
  });
  assert.equal(v3, "retry_safe");
});

test("Solana payroll CSV parsing, planning, crash-safe reconciliation, and ledger export", async () => {
  const solAddr1 = "11111111111111111111111111111111";
  const solAddr2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  const csv = [
    "name,address,amount",
    `Ada Obi,${solAddr1},"1,250.50"`,
    `=EvilFormula,${solAddr2},500`,
    `Ada Bonus,${solAddr1},100`,
  ].join("\n");

  const parsed = parseSolanaPayrollCsv(csv, 6);
  assert.equal(parsed.fatalError, null);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.totalUnits, 1_850_500_000n);
  assert.match(parsed.rows[2]!.warning ?? "", /Same address as line 2/);

  // Rejects EVM 0x address and blank address cleanly.
  const badSol = parseSolanaPayrollCsv(
    "name,address,amount\nEvm,0x1111111111111111111111111111111111111111,10\nBlank,,5",
    6
  );
  assert.equal(badSol.rows.length, 0);
  assert.equal(badSol.issues.length, 2);
  assert.match(badSol.issues[0]!.message, /EVM 0x address/);
  assert.match(badSol.issues[1]!.message, /Missing Solana private address/);

  const plan = planSolanaPayroll({ csvText: csv, networkKey: "solana", assetInput: "USDC" });
  assert.equal(plan.network, "mainnet");
  assert.equal(plan.assetSymbol, "USDC");
  assert.match(plan.privacyNote, /Helius/);

  const state = createInitialSolanaRunState({
    id: "sol-run-1",
    network: "mainnet",
    asset: resolveSolanaAsset("mainnet", "USDC"),
    mainAddress: solAddr1,
    privateAddress: solAddr2,
    rows: plan.validRows,
  });

  // Reconciliation states.
  const r0 = state.rows[0]!;
  r0.status = "unconfirmed";
  r0.signature = "5sigLanded";
  r0.blockhash = "bh1";
  assert.equal(
    await reconcileSolanaUnconfirmedRow(r0, "mainnet", async () => ({
      state: "landed",
      signature: "5sigLanded",
      slot: 12345n,
    })),
    "already_paid"
  );
  assert.equal(r0.status, "paid");
  assert.equal(r0.slot, "12345");

  const r1 = state.rows[1]!;
  r1.status = "unconfirmed";
  r1.signature = "5sigDropped";
  r1.blockhash = "bh2";
  assert.equal(
    await reconcileSolanaUnconfirmedRow(r1, "mainnet", async () => ({
      state: "dropped",
      signature: "5sigDropped",
    })),
    "retry_safe"
  );
  assert.equal(r1.status, "queued");
  assert.equal(r1.signature, undefined);

  const r2 = state.rows[2]!;
  r2.status = "unconfirmed";
  r2.signature = "5sigPending";
  assert.equal(
    await reconcileSolanaUnconfirmedRow(r2, "mainnet", async () => ({
      state: "pending",
      signature: "5sigPending",
    })),
    "still_pending"
  );

  // Missing signature halts safely.
  r2.signature = undefined;
  assert.equal(
    await reconcileSolanaUnconfirmedRow(r2, "mainnet", async () => ({
      state: "pending",
      signature: "",
    })),
    "ambiguous_no_signature"
  );

  // Ledger persistence + formula-safe export.
  const dir = mkdtempSync(join(tmpdir(), "gloam-sol-test-"));
  try {
    const ledgerPath = join(dir, "sol.run.json");
    saveRunState(ledgerPath, state);
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
    const loaded = loadAnyRunState(ledgerPath);
    assert.equal(isSolanaRunState(loaded), true);
    assert.throws(() => loadRunState(ledgerPath), /Solana payroll run/);
    const exported = buildSolanaPayoutExport(state);
    assert.match(exported, /'=EvilFormula/);
    assert.match(exported, /https:\/\/solscan\.io\/tx\/5sigLanded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
