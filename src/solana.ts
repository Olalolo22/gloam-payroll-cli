import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOLANA_ASSETS,
  SOLANA_PRIVACY_NOTE,
  solanaAsset,
  solanaExplorerTx,
  solanaNetworkInfo,
  type SolanaAsset,
  type SolanaNetworkKey,
} from "@gloamtrade/sdk";
import type { SolanaTxState } from "@gloamtrade/sdk/solana";
import { formatUnits } from "viem";
import {
  formatSolanaPayoutCsv,
  parseSolanaPayrollCsv,
  type CsvRowIssue,
  type ParsedSolanaPayrollRow,
  type SolanaPayoutExportRow,
} from "./csv.js";
import {
  saveRunState,
  type SolanaPayrollRunState,
  type StoredSolanaPayrollRow,
} from "./state.js";

/** Minimum gap between relayed Solana sends (Gloam's relay allows 10/min per IP -> max 9/min). */
export const SOLANA_RELAY_MIN_GAP_MS = 7_000;
const RELAY_429_MAX_TRIES = 6;
const RELAY_429_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isSolanaNetworkKey(keyInput?: string): boolean {
  const k = keyInput?.trim().toLowerCase();
  return k === "solana" || k === "solana-mainnet" || k === "solana-devnet";
}

export function resolveSolanaNetwork(keyInput?: string): SolanaNetworkKey {
  const k = keyInput?.trim().toLowerCase();
  if (k === "solana-devnet") return "devnet";
  if (k === "solana" || k === "solana-mainnet") return "mainnet";
  throw new Error(`Unknown Solana network "${keyInput}". Use "solana" (or "solana-mainnet") or "solana-devnet".`);
}

export function resolveSolanaAsset(network: SolanaNetworkKey, assetInput?: string): SolanaAsset {
  const list = SOLANA_ASSETS[network];
  if (!assetInput?.trim()) {
    const usdc = list.find((a) => a.id === "usdc");
    const first = usdc ?? list[0];
    if (!first) throw new Error(`No listed Solana assets for ${network}.`);
    return first;
  }
  const match = solanaAsset(assetInput.trim(), network);
  if (!match) {
    throw new Error(
      `Asset "${assetInput}" is not listed on Solana ${network}. Listed: ${list.map((a) => a.symbol).join(", ")}.`
    );
  }
  return match;
}

/**
 * Load a Solana main wallet secret from `GLOAM_SOLANA_KEY` (base58 string, JSON 64-byte array,
 * or a filesystem path to a Solana CLI keypair JSON file).
 */
export function readSolanaSecretInput(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      "Solana payroll requires GLOAM_SOLANA_KEY (a base58 secret key, JSON byte array, or path to a Solana keypair file)."
    );
  }
  if (!trimmed.startsWith("[") && existsSync(resolve(trimmed))) {
    return readFileSync(resolve(trimmed), "utf8").trim();
  }
  return trimmed;
}

export interface SolanaPayrollPlanSummary {
  network: SolanaNetworkKey;
  networkLabel: string;
  assetId: string;
  assetSymbol: string;
  assetDecimals: number;
  assetNote?: string;
  validRows: ParsedSolanaPayrollRow[];
  issues: CsvRowIssue[];
  fatalError: string | null;
  totalUnits: bigint;
  totalFormatted: string;
  privacyNote: string;
}

export function planSolanaPayroll(args: {
  csvText: string;
  networkKey?: string;
  assetInput?: string;
  maxTotalUnits?: bigint;
}): SolanaPayrollPlanSummary {
  const network = resolveSolanaNetwork(args.networkKey);
  const asset = resolveSolanaAsset(network, args.assetInput);
  const info = solanaNetworkInfo(network);
  const parsed = parseSolanaPayrollCsv(args.csvText, asset.decimals, {
    maxTotalUnits: args.maxTotalUnits,
  });

  return {
    network,
    networkLabel: info.name,
    assetId: asset.id,
    assetSymbol: asset.symbol,
    assetDecimals: asset.decimals,
    ...(asset.note ? { assetNote: asset.note } : {}),
    validRows: parsed.rows,
    issues: parsed.issues,
    fatalError: parsed.fatalError,
    totalUnits: parsed.totalUnits,
    totalFormatted: formatUnits(parsed.totalUnits, asset.decimals),
    privacyNote: SOLANA_PRIVACY_NOTE,
  };
}

export function createInitialSolanaRunState(args: {
  id: string;
  network: SolanaNetworkKey;
  asset: SolanaAsset;
  mainAddress: string;
  privateAddress: string;
  rows: ParsedSolanaPayrollRow[];
}): SolanaPayrollRunState {
  const now = Date.now();
  return {
    v: 1,
    kind: "solana",
    id: args.id,
    createdAt: now,
    updatedAt: now,
    network: args.network,
    assetId: args.asset.id,
    assetSymbol: args.asset.symbol,
    assetDecimals: args.asset.decimals,
    mainAddress: args.mainAddress,
    privateAddress: args.privateAddress,
    status: "ready",
    rows: args.rows.map((r, index) => ({
      index,
      line: r.line,
      name: r.name,
      address: r.address,
      amountInput: r.amountInput,
      amountUnits: r.amountUnits.toString(),
      status: "queued",
      attempts: 0,
    })),
  };
}

export function buildSolanaPayoutExport(state: SolanaPayrollRunState): string {
  const rows: SolanaPayoutExportRow[] = state.rows.map((r) => ({
    name: r.name,
    address: r.address,
    amount: formatUnits(BigInt(r.amountUnits), state.assetDecimals),
    asset: state.assetSymbol,
    status: r.status,
    signature: r.signature ?? "",
    explorer: r.explorer ?? (r.signature ? solanaExplorerTx(r.signature, state.network) : ""),
  }));
  return formatSolanaPayoutCsv(rows);
}

export type SolanaTxChecker = (input: {
  signature: string;
  blockhash?: string;
}) => Promise<SolanaTxState>;

/**
 * Reconcile an `unconfirmed` Solana payroll row before sending again:
 * - `"landed"` -> mark `"paid"` (never pay twice).
 * - `"failed"` or `"dropped"` (blockhash expired unseen) -> reset to `"queued"`, safe to resend.
 * - `"pending"` -> still live on Solana; halt safely instead of double-paying.
 * - Missing signature (relay dropped before returning a signature) -> halt safely so operator verifies.
 */
export async function reconcileSolanaUnconfirmedRow(
  row: StoredSolanaPayrollRow,
  network: SolanaNetworkKey,
  checkTx: SolanaTxChecker
): Promise<"already_paid" | "retry_safe" | "still_pending" | "ambiguous_no_signature"> {
  if (!row.signature) {
    return "ambiguous_no_signature";
  }

  const st = await checkTx({ signature: row.signature, blockhash: row.blockhash });
  if (st.state === "landed") {
    row.status = "paid";
    row.slot = st.slot.toString();
    row.explorer = solanaExplorerTx(st.signature, network);
    row.error = undefined;
    return "already_paid";
  }
  if (st.state === "failed" || st.state === "dropped") {
    row.status = "queued";
    row.signature = undefined;
    row.blockhash = undefined;
    row.error = undefined;
    return "retry_safe";
  }
  return "still_pending";
}

export interface ExecuteSolanaPayrollOptions {
  state: SolanaPayrollRunState;
  stateFilePath: string;
  secretKeyInput: string;
  baseUrl?: string;
  accountIndex?: number;
  noAdd?: boolean;
  log?: (msg: string) => void;
}

/**
 * Execute or resume a Solana private payroll run through `@gloamtrade/sdk/solana`
 * (Helius Solana Privacy Rings + Gloam's Solana relay).
 */
export async function executeSolanaPayrollRun(
  opts: ExecuteSolanaPayrollOptions
): Promise<SolanaPayrollRunState> {
  const log = opts.log ?? console.log;
  const { state, stateFilePath } = opts;

  const sdk = await import("@gloamtrade/sdk/solana");
  const solanaOpts = {
    network: state.network,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  };

  const wallet = await sdk.solanaKeypairWallet(opts.secretKeyInput);
  const account = await sdk.openSolanaAccount({
    wallet,
    index: opts.accountIndex ?? 0,
    ...solanaOpts,
  });

  try {
    if (state.privateAddress && state.privateAddress !== account.address) {
      throw new Error(
        `Run ledger belongs to Solana private account ${state.privateAddress}, but GLOAM_SOLANA_KEY opened ${account.address}.`
      );
    }
    state.mainAddress = account.mainAddress;
    state.privateAddress = account.address;

    const remainingUnits = state.rows
      .filter((r) => r.status !== "paid")
      .reduce((sum, r) => sum + BigInt(r.amountUnits), 0n);

    if (remainingUnits === 0n) {
      state.status = "done";
      saveRunState(stateFilePath, state);
      log("All rows in this Solana payroll run are already paid.");
      return state;
    }

    state.status = "running";
    saveRunState(stateFilePath, state);

    // Ensure the payer's private account is registered on Privacy Rings.
    const reg = await sdk.registerSolanaAccount(account);
    if (!reg.alreadyRegistered) {
      log(`Registered Solana private account ${account.address} (${reg.signature}).`);
    }

    // Reconcile any unconfirmed rows first before checking recipients/balances.
    for (const row of state.rows) {
      if (row.status !== "unconfirmed") continue;
      log(`Row ${row.index + 1} (${row.name}) was unconfirmed; checking Solana status...`);
      const verdict = await reconcileSolanaUnconfirmedRow(row, state.network, (input) =>
        sdk.waitForSolanaTx({ ...input, timeoutMs: 30_000 }, solanaOpts)
      );
      saveRunState(stateFilePath, state);
      if (verdict === "already_paid") {
        log(`  Row ${row.index + 1} (${row.name}) already landed (${row.signature}).`);
        continue;
      }
      if (verdict === "still_pending") {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(
          `Row ${row.index + 1} (${row.name}, tx ${row.signature}) is still pending on Solana. Wait a minute and run "resume".`
        );
      }
      if (verdict === "ambiguous_no_signature") {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(
          `Row ${row.index + 1} (${row.name}) lost the relay reply before a signature was returned (blockhash ${row.blockhash ?? "unknown"}). Check balances on chain before re-sending so nobody is paid twice.`
        );
      }
      log(`  Row ${row.index + 1} (${row.name}) did not land; safe to re-send.`);
    }

    const unpaidRows = state.rows.filter((r) => r.status !== "paid");
    if (unpaidRows.length === 0) {
      state.status = "done";
      saveRunState(stateFilePath, state);
      return state;
    }

    // Verify every unpaid recipient is a registered Privacy Rings account (and not our own).
    log(`Checking Privacy Rings registration for ${unpaidRows.length} recipient(s)...`);
    const checked = new Map<string, boolean>();
    const badRecipients: string[] = [];
    for (const row of unpaidRows) {
      if (row.address === account.address) {
        badRecipients.push(`Line ${row.line} (${row.name}): cannot pay your own private account.`);
        continue;
      }
      if (!checked.has(row.address)) {
        checked.set(row.address, await sdk.isSolanaAccountRegistered(account, row.address));
      }
      if (checked.get(row.address) !== true) {
        badRecipients.push(
          `Line ${row.line} (${row.name}): ${row.address} is not registered on Gloam Privacy Rings yet.`
        );
      }
    }
    if (badRecipients.length > 0) {
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(`Unpayable Solana recipient(s):\n  ${badRecipients.join("\n  ")}`);
    }

    // Check private balance and optionally top up from the main wallet.
    const unpaidTotal = unpaidRows.reduce((sum, r) => sum + BigInt(r.amountUnits), 0n);
    const balances = await sdk.solanaBalances(account);
    const currentBalance = balances[state.assetId] ?? 0n;
    if (currentBalance < unpaidTotal) {
      const shortfall = unpaidTotal - currentBalance;
      if (opts.noAdd) {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(
          `Private balance (${formatUnits(currentBalance, state.assetDecimals)} ${state.assetSymbol}) is short by ${formatUnits(shortfall, state.assetDecimals)} ${state.assetSymbol} (--no-add set).`
        );
      }
      log(
        `Adding ${formatUnits(shortfall, state.assetDecimals)} ${state.assetSymbol} from main wallet ${account.mainAddress} into private account ${account.address}...`
      );
      const added = await sdk.addToSolanaPrivate(account, {
        asset: state.assetId,
        amount: shortfall,
      });
      state.fundingSignature = added.signature;
      saveRunState(stateFilePath, state);
      if (added.state === "pending") {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(
          `Funding deposit ${added.signature} is still pending on Solana. Wait a moment and run "resume".`
        );
      }
      log(`Added privately: ${added.explorer}`);
    }

    // Pay unpaid rows sequentially with relay pacing (max 9/min under the relay's 10/min limit).
    let lastSendAt = 0;
    for (const row of unpaidRows) {
      const elapsed = Date.now() - lastSendAt;
      if (lastSendAt > 0 && elapsed < SOLANA_RELAY_MIN_GAP_MS) {
        await sleep(SOLANA_RELAY_MIN_GAP_MS - elapsed);
      }

      row.attempts += 1;
      row.status = "unconfirmed";
      row.error = undefined;
      row.sentAt = Date.now();
      saveRunState(stateFilePath, state);

      log(
        `[${row.index + 1}/${state.rows.length}] Paying ${row.amountInput} ${state.assetSymbol} privately to ${row.name} (${row.address})...`
      );

      let result;
      for (let rateTry = 1; ; rateTry++) {
        try {
          lastSendAt = Date.now();
          result = await sdk.paySolanaPrivately(account, {
            to: row.address,
            asset: state.assetId,
            amount: BigInt(row.amountUnits),
          });
          break;
        } catch (err) {
          if (err instanceof sdk.SolanaRelayError && err.status === 429 && rateTry <= RELAY_429_MAX_TRIES) {
            log(`  Relay rate-limited (429); waiting ${RELAY_429_WAIT_MS / 1000}s before retrying (${rateTry}/${RELAY_429_MAX_TRIES})...`);
            await sleep(RELAY_429_WAIT_MS);
            continue;
          }
          const msg = sdk.solanaErrorMessage(err);
          row.error = msg;
          if (err instanceof sdk.SolanaRelayError && err.maybeSent) {
            row.blockhash = err.pending?.blockhash;
            row.signature = err.pending?.signature;
            row.status = "unconfirmed";
          } else if (err instanceof sdk.SolanaTxError) {
            // Failed or dropped on Solana: nothing moved, safe to retry on resume.
            row.status = "failed";
          } else {
            row.status = "failed";
          }
          state.status = "paused";
          saveRunState(stateFilePath, state);
          throw new Error(msg);
        }
      }

      row.signature = result.signature;
      row.blockhash = result.blockhash;
      row.explorer = result.explorer;
      if (result.state === "landed") {
        row.status = "paid";
        row.slot = result.slot?.toString();
        saveRunState(stateFilePath, state);
        log(`  Landed: ${result.explorer}`);
      } else {
        row.status = "unconfirmed";
        row.error = "Still pending on Solana after wait window; run resume to settle.";
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(`Row ${row.index + 1} (${row.name}) is still pending (${result.signature}). Run "resume".`);
      }
    }

    state.status = state.rows.every((r) => r.status === "paid") ? "done" : "paused";
    saveRunState(stateFilePath, state);
    return state;
  } finally {
    sdk.closeSolanaAccount(account);
  }
}
