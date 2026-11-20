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
  amountInput: string;
  amountWei: string;
  note: string;
  status: RowStatus;
  attempts: number;
  error?: string;
  // Persisted BEFORE submission so crash/resume can verify on-chain state
  // and never double-pay or lose change.
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
  status: "ready" | "running" | "paused" | "done";
  rows: StoredPayrollRow[];
}

/**
 * Atomically write the run state ledger with 0600 permissions so secrets
 * (`activeNote.secret`, `paymentSecret`, `changeSecret`) are owner-readable only
 * and a crash mid-write never corrupts the file.
 */
export function saveRunState(filePath: string, state: PayrollRunState): void {
  state.updatedAt = Date.now();
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function loadRunState(filePath: string): PayrollRunState {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as PayrollRunState;
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rows)) {
    throw new Error(`Invalid payroll run file: ${filePath}`);
  }
  return parsed;
}
