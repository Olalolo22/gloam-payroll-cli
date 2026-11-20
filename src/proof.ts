import {
  buildPayrollWitness,
  fieldToHex,
  hexToField,
  payrollParts,
  payrollPaymentsHash,
  proofContext,
  proveGroth16,
  readPayrollSignals,
  verifyGroth16,
  type Groth16Proof,
  type PayrollPaymentInput,
} from "@gloamtrade/sdk";
import type { Address, Hex } from "viem";
import type { PayrollRunState } from "./state.js";

/** Prefix expected by `https://www.gloam.trade/verify`. */
export const PAYROLL_PROOF_PREFIX = "gloamroll1:";
export const PAYROLL_MAX_PAYMENTS_TOTAL = 256;
export const VERIFIER_LABEL_MAX = 80;

export interface PayrollProofPayment {
  commitment: Hex;
  nullifier: Hex;
  txHash: Hex | null;
}

export interface PayrollProofPart {
  proof: Groth16Proof | unknown;
  publicSignals: string[];
}

/**
 * Exact `v: 1` JSON payload schema accepted by `https://www.gloam.trade/verify`
 * (`app/src/lib/proofs/types.ts` + `app/src/lib/proofs/index.ts`).
 */
export interface PayrollProofBundle {
  v: 1;
  kind: "payroll";
  chainId: number;
  pool: Address;
  verifier: string;
  expiresAt: number;
  asset: Address;
  total: string;
  count: number;
  payments: PayrollProofPayment[];
  parts: PayrollProofPart[];
}

export type PayrollPartProver = (
  circomInput: Record<string, string | string[]>
) => Promise<{ proof: unknown; publicSignals: string[] }>;

/**
 * Sanitize verifier label identically to Gloam's `plainLabel` rules: strip ASCII/BiDi
 * control characters, collapse whitespace, trim, and enforce length cap.
 */
export function cleanVerifierLabel(raw: string): string {
  const cleaned = raw
    // Remove control chars and Unicode BiDi overrides
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error("Verifier label cannot be empty (e.g. --for \"Acme Audit\").");
  if (Array.from(cleaned).length > VERIFIER_LABEL_MAX) {
    throw new Error(`Keep the verifier label under ${VERIFIER_LABEL_MAX} characters.`);
  }
  return cleaned;
}

export function encodePayrollProofToken(bundle: PayrollProofBundle): string {
  const json = JSON.stringify(bundle);
  return PAYROLL_PROOF_PREFIX + Buffer.from(json, "utf8").toString("base64");
}

export function decodePayrollProofToken(token: string): PayrollProofBundle {
  const trimmed = token.trim();
  if (!trimmed.startsWith(PAYROLL_PROOF_PREFIX)) {
    throw new Error(`Expected token starting with "${PAYROLL_PROOF_PREFIX}".`);
  }
  const b64 = trimmed.slice(PAYROLL_PROOF_PREFIX.length).replace(/\s+/g, "");
  const raw = Buffer.from(b64, "base64").toString("utf8");
  const parsed = JSON.parse(raw) as PayrollProofBundle;
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.kind !== "payroll" ||
    !Array.isArray(parsed.payments) ||
    !Array.isArray(parsed.parts)
  ) {
    throw new Error("Malformed gloamroll1 payroll proof payload.");
  }
  return parsed;
}

/** Extract provable paid rows from a saved payroll run ledger. */
export function extractPaidProofInputs(state: PayrollRunState): {
  inputs: (PayrollPaymentInput & { txHash: Hex | null })[];
  skipped: number;
} {
  const inputs: (PayrollPaymentInput & { txHash: Hex | null })[] = [];
  let skipped = 0;

  for (const row of state.rows) {
    if (row.status !== "paid") {
      skipped++;
      continue;
    }
    if (!row.paymentSecret || !row.spendSecret || !row.spendAmountWei) {
      throw new Error(
        `Paid row #${row.index + 1} (${row.name}) is missing saved proof openings (paymentSecret / spendSecret).`
      );
    }
    inputs.push({
      secretHex: row.paymentSecret,
      amount: BigInt(row.amountWei),
      spendSecretHex: row.spendSecret,
      spendAmount: BigInt(row.spendAmountWei),
      commitment: row.paymentCommitment,
      nullifier: row.spendNullifier,
      txHash: row.txHash ?? null,
    });
  }

  return { inputs, skipped };
}

/**
 * Generate a multi-part `PayrollProofBundle` using `@gloamtrade/sdk`'s `buildPayrollWitness`,
 * `payrollParts` (even splits so no part reveals a single salary), and `proofContext`.
 */
export async function generatePayrollProofBundle(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  payments: readonly (PayrollPaymentInput & { txHash: Hex | null })[];
  verifier: string;
  expiresAt?: number;
  prover: PayrollPartProver;
  onPart?: (done: number, total: number) => void;
}): Promise<{ bundle: PayrollProofBundle; token: string }> {
  const verifier = cleanVerifierLabel(args.verifier);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = args.expiresAt ?? nowSec + 30 * 24 * 3600;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSec) {
    throw new Error("expiresAt must be a future Unix timestamp (seconds).");
  }

  if (args.payments.length < 1) {
    throw new Error("No paid rows available to prove.");
  }
  if (args.payments.length > PAYROLL_MAX_PAYMENTS_TOTAL) {
    throw new Error(`Payroll proofs cover at most ${PAYROLL_MAX_PAYMENTS_TOTAL} payments.`);
  }

  const context = proofContext({
    kind: "payroll",
    chainId: args.chainId,
    pool: args.pool,
    verifier,
    expiresAt,
  });

  const sizes = payrollParts(args.payments.length);
  const parts: PayrollProofPart[] = [];
  const listed: PayrollProofPayment[] = [];
  let offset = 0;

  for (const size of sizes) {
    const slice = args.payments.slice(offset, offset + size);
    offset += size;

    const witness = await buildPayrollWitness({
      asset: args.asset,
      context,
      payments: slice.map((p) => ({
        secretHex: p.secretHex,
        amount: p.amount,
        spendSecretHex: p.spendSecretHex,
        spendAmount: p.spendAmount,
        commitment: p.commitment,
        nullifier: p.nullifier,
      })),
    });

    if (witness.blocker) {
      throw new Error(witness.blocker);
    }

    const proved = await args.prover(witness.circomInput);
    if (
      proved.publicSignals.length !== witness.publicSignals.length ||
      proved.publicSignals.some((s, i) => s !== witness.publicSignals[i])
    ) {
      throw new Error("Prover public signals diverged from expected payroll_total witness signals.");
    }

    parts.push({ proof: proved.proof, publicSignals: proved.publicSignals });
    witness.payments.forEach((p, idx) => {
      listed.push({
        commitment: fieldToHex(p.commitment),
        nullifier: fieldToHex(p.nullifier),
        txHash: slice[idx]!.txHash,
      });
    });

    args.onPart?.(parts.length, sizes.length);
  }

  const total = args.payments.reduce((sum, p) => sum + p.amount, 0n);
  const bundle: PayrollProofBundle = {
    v: 1,
    kind: "payroll",
    chainId: args.chainId,
    pool: args.pool,
    verifier,
    expiresAt,
    asset: args.asset,
    total: total.toString(),
    count: args.payments.length,
    payments: listed,
    parts,
  };

  return { bundle, token: encodePayrollProofToken(bundle) };
}

/** Build a real Groth16 prover function backed by local `payroll_total.wasm` and `.zkey`. */
export function createSnarkPayrollProver(wasmPath: string, zkeyPath: string): PayrollPartProver {
  return async (circomInput) => {
    const { proof, publicSignals } = await proveGroth16(circomInput, wasmPath, zkeyPath);
    return { proof, publicSignals };
  };
}

export interface StructuralCheckResult {
  ok: boolean;
  expired: boolean;
  partCount: number;
  errors: string[];
}

/**
 * Verify a `gloamroll1:` bundle's structural integrity, `proofContext` binding,
 * `payrollPaymentsHash` per part, uniqueness of commitments/nullifiers, total sum,
 * and (when `vkey` is provided) Groth16 pairing verification via `@gloamtrade/sdk`.
 */
export async function verifyPayrollProofBundleOffline(
  bundle: PayrollProofBundle,
  opts?: { vkey?: unknown; nowSec?: number }
): Promise<StructuralCheckResult> {
  const errors: string[] = [];
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const expired = bundle.expiresAt <= nowSec;

  if (bundle.payments.length !== bundle.count) {
    errors.push(`Payment count mismatch: count=${bundle.count} vs payments.length=${bundle.payments.length}.`);
  }

  const expectedContext = proofContext({
    kind: "payroll",
    chainId: bundle.chainId,
    pool: bundle.pool,
    verifier: bundle.verifier,
    expiresAt: bundle.expiresAt,
  });
  const expectedAssetField = BigInt(bundle.asset);

  const seenCommitments = new Set<string>();
  const seenNullifiers = new Set<string>();
  for (const p of bundle.payments) {
    const c = p.commitment.toLowerCase();
    const n = p.nullifier.toLowerCase();
    if (seenCommitments.has(c)) errors.push(`Duplicate commitment in payroll bundle: ${p.commitment}`);
    if (seenNullifiers.has(n)) errors.push(`Duplicate nullifier in payroll bundle: ${p.nullifier}`);
    seenCommitments.add(c);
    seenNullifiers.add(n);
  }

  let offset = 0;
  let summedTotal = 0n;
  let summedCount = 0;

  for (let i = 0; i < bundle.parts.length; i++) {
    const part = bundle.parts[i]!;
    let sig: ReturnType<typeof readPayrollSignals>;
    try {
      sig = readPayrollSignals(part.publicSignals);
    } catch (e) {
      errors.push(`Part ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (sig.asset !== expectedAssetField) {
      errors.push(`Part ${i + 1}: asset public signal does not match bundle.asset.`);
    }
    if (sig.context !== expectedContext) {
      errors.push(`Part ${i + 1}: context public signal does not match (chainId, pool, verifier, expiresAt).`);
    }

    const partCount = Number(sig.count);
    const slice = bundle.payments.slice(offset, offset + partCount);
    offset += partCount;

    if (slice.length !== partCount) {
      errors.push(`Part ${i + 1}: expected ${partCount} payments, only ${slice.length} left in bundle.`);
      continue;
    }

    const computedHash = await payrollPaymentsHash(
      slice.map((p) => ({
        commitment: hexToField(p.commitment),
        nullifier: hexToField(p.nullifier),
      }))
    );

    if (computedHash !== sig.paymentsHash) {
      errors.push(`Part ${i + 1}: paymentsHash public signal does not match listed (commitment, nullifier) pairs.`);
    }

    if (opts?.vkey !== undefined) {
      const validSnark = await verifyGroth16(opts.vkey, part.publicSignals, part.proof);
      if (!validSnark) {
        errors.push(`Part ${i + 1}: Groth16 proof failed verification against payroll_total vkey.`);
      }
    }

    summedTotal += sig.total;
    summedCount += partCount;
  }

  if (offset !== bundle.payments.length) {
    errors.push(`Parts covered ${offset} payments, but bundle lists ${bundle.payments.length}.`);
  }
  if (summedCount !== bundle.count) {
    errors.push(`Summed part counts (${summedCount}) != bundle.count (${bundle.count}).`);
  }
  if (summedTotal.toString() !== bundle.total) {
    errors.push(`Summed part totals (${summedTotal.toString()}) != bundle.total (${bundle.total}).`);
  }

  return {
    ok: errors.length === 0,
    expired,
    partCount: bundle.parts.length,
    errors,
  };
}
