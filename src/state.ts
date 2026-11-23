import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { PayeeKind } from "./csv.js";

export type RowStatus = "queued" | "unconfirmed" | "paid" | "failed";

export interface StoredNote {
  secret: Hex;
  commitment: Hex;
  amountWei: string;
  asset: Address;
  txHash?: Hex;
  blockNumber?: string;
}

export interface StoredPayrollRow {
  index: number;
  line: number;
  name: string;
  recipient: string;
  kind: PayeeKind;
  /** Gloam name without leading `@`, when the CSV paid a `@name`. */
  payName?: string;
  amountInput: string;
  amountWei: string;
  note: string;
  status: RowStatus;
  attempts: number;
  error?: string;
  // Persisted BEFORE submission so crash/resume can verify on-chain state
  // and re-prove the exact same payment without double-paying or losing change.
  spendSecret?: Hex;
  spendAmountWei?: string;
  spendCommitment?: Hex;
  spendNullifier?: Hex;
  paymentSeed?: Hex;
  paymentSecret?: Hex;
  paymentCommitment?: Hex;
  changeSecret?: Hex;
  changeCommitment?: Hex;
  changeAmountWei?: string;
  /** Sealed `gloam2t.` ticket (for `gloam`) or short claim URL `https://gloam.trade/c#...` (for `link`). */
  delivery?: string;
  /** Raw `gloam2t.` ticket string used for posting on-chain memo. */
  sealedTicket?: string;
  txHash?: Hex;
  blockNumber?: string;
  memoTxHash?: Hex;
  memoPosted?: boolean;
  sentAt?: number;
}

export interface PayrollRunState {
  v: 1;
  /** Omitted in v0.1.0 ledgers; treated as `"evm"`. */
  kind?: "evm";
  id: string;
  createdAt: number;
  updatedAt: number;
  networkKey: string;
  chainId: number;
  pool: Address;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  relay: boolean;
  /** Current spendable note funding the next queued row (starts as shielded deposit, then each row's change). */
  activeNote: StoredNote | null;
  /** Optional shield deposit tx when CLI funded the run itself. */
  fundingTxHash?: Hex;
  /** True once the CLI broadcast a `shieldBound` tx for `activeNote`, before confirmation. */
  fundingShieldSent?: boolean;
  status: "ready" | "running" | "paused" | "done";
  rows: StoredPayrollRow[];
}

export interface StoredSolanaPayrollRow {
  index: number;
  line: number;
  name: string;
  address: string;
  amountInput: string;
  amountUnits: string;
  status: RowStatus;
  attempts: number;
  error?: string;
  signature?: string;
  blockhash?: string;
  slot?: string;
  explorer?: string;
  sentAt?: number;
}

export interface SolanaPayrollRunState {
  v: 1;
  kind: "solana";
  id: string;
  createdAt: number;
  updatedAt: number;
  network: "mainnet" | "devnet";
  assetId: string;
  assetSymbol: string;
  assetDecimals: number;
  mainAddress: string;
  privateAddress: string;
  fundingSignature?: string;
  status: "ready" | "running" | "paused" | "done";
  rows: StoredSolanaPayrollRow[];
}

export type AnyPayrollRunState = PayrollRunState | SolanaPayrollRunState;

export function isSolanaRunState(state: AnyPayrollRunState): state is SolanaPayrollRunState {
  return state.kind === "solana";
}

/**
 * Atomically write a run state ledger with `0600` permissions so secrets
 * (`activeNote.secret`, `paymentSecret`, `changeSecret`) are owner-readable only
 * and a crash mid-write never corrupts the file.
 */
export function saveRunState(filePath: string, state: AnyPayrollRunState): void {
  state.updatedAt = Date.now();
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/** Load either an EVM or Solana payroll run ledger. */
export function loadAnyRunState(filePath: string): AnyPayrollRunState {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as AnyPayrollRunState;
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rows)) {
    throw new Error(`Invalid payroll run file: ${filePath}`);
  }
  return parsed;
}

/** Load an EVM payroll run ledger (rejects Solana ledgers with a clear error). */
export function loadRunState(filePath: string): PayrollRunState {
  const parsed = loadAnyRunState(filePath);
  if (isSolanaRunState(parsed)) {
    throw new Error(`Run file ${filePath} is a Solana payroll run, not an EVM vault run.`);
  }
  return parsed;
}
