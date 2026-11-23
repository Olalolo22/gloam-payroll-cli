import {
  NATIVE_ASSET,
  POOL_STATE_ABI,
  POOL_TRANSFER_ABI,
  RELAY_MAYBE_SENT,
  GloamRelayError,
  PrunedLogsError,
  approvalSteps,
  artifactProver,
  buildPrivateSendIntent,
  buildShieldBoundIntent,
  buildTransferWitness,
  ceremonyForChainId,
  createTreeSync,
  encodeNotePackage,
  encodeShortClaim,
  fieldToBytes32,
  fieldToHex,
  getGloamNetwork,
  gloamLeafSeed,
  gloamNetworks,
  gloamReadTransport,
  hexToField,
  isNoLimit,
  networkName,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  payMemoBoardFor,
  payrollParts,
  randomNoteSeed,
  relayIntent,
  relayMemo,
  sealToReceiveTag,
  shortClaimLink,
  transferCallArgs,
  type GloamAsset,
  type GloamNetwork,
  type GloamNetworkKey,
  type NoteExport,
  type PoseidonMerklePath,
  type PrivateSendIntent,
  type Prover,
} from "@gloamtrade/sdk";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveCircuitArtifacts } from "./artifacts.js";
import {
  applyResolvedPayrollNames,
  formatPayoutCsv,
  parsePayrollCsv,
  type CsvRowIssue,
  type ParsedPayrollRow,
  type PayoutExportRow,
} from "./csv.js";
import { resolveGloamNames, type NameLookupAnswer, type NameReader } from "./names.js";
import {
  saveRunState,
  type PayrollRunState,
  type StoredNote,
  type StoredPayrollRow,
} from "./state.js";

const SHIELD_BOUND_ABI = [
  {
    type: "function",
    name: "shieldBound",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const PAY_MEMO_ABI = [
  {
    type: "function",
    name: "postMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentCommitment", type: "bytes32" },
      { name: "memo", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const TREE_SYNC_RETRIES = 8;
const TREE_SYNC_DELAY_MS = 1_250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** All live EVM networks exposed by the installed `@gloamtrade/sdk` (mainnets first, testnets below). */
export function listEvmNetworks(): GloamNetwork[] {
  const all = gloamNetworks();
  return [...all.filter((n) => !n.testnet), ...all.filter((n) => n.testnet)];
}

export function isNativeAsset(asset: GloamAsset): boolean {
  return asset.address.toLowerCase() === NATIVE_ASSET.toLowerCase();
}

export function resolveNetwork(keyInput?: string): GloamNetwork {
  const key = (keyInput?.trim() || "robinhood") as GloamNetworkKey;
  const net = getGloamNetwork(key);
  if (!net) {
    const liveKeys = listEvmNetworks().map((n) => n.key);
    throw new Error(
      `Unknown or unavailable EVM network "${key}". Available EVM networks: ${liveKeys.join(", ")} (or use "solana" / "solana-devnet" for Solana).`
    );
  }
  return net;
}

export function resolveAsset(net: GloamNetwork, assetInput?: string): GloamAsset {
  if (!assetInput?.trim()) {
    const first = net.assets[0];
    if (!first) throw new Error(`Network ${net.key} has no listed assets.`);
    return first;
  }
  const q = assetInput.trim().toLowerCase();
  const match = net.assets.find(
    (a) => a.symbol.toLowerCase() === q || a.address.toLowerCase() === q
  );
  if (!match) {
    throw new Error(
      `Asset "${assetInput}" is not listed on ${net.key}. Listed: ${net.assets.map((a) => a.symbol).join(", ")}.`
    );
  }
  return match;
}

/** Encode a `gloam2t.` sealed ticket as UTF-8 hex bytes for `GloamPayMemo.postMemo` / `relayMemo`. */
export function ticketToMemoBytes(ticket: string): Hex {
  const bytes = new TextEncoder().encode(ticket);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

/**
 * Create the payee delivery payload (byte-compatible with the Gloam web app):
 * - For a `gloamr1.` recipient: encrypt a `gloam1.` note package into a `gloam2t.` sealed ticket.
 * - For a blank recipient: build a compact `https://gloam.trade/c#...` short claim link (using
 *   `seed` when present for ~30-char links, falling back to `gloam1.` package if needed).
 */
export async function buildPaymentDelivery(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  kind: "gloam" | "link";
  recipient: string;
  amountWei: bigint;
  secret: Hex;
  commitment: Hex;
  seed?: Hex;
  note?: string;
}): Promise<{ delivery: string; sealedTicket?: string }> {
  if (args.kind === "gloam") {
    const pkg = encodeNotePackage({
      pool: args.pool,
      chainId: args.chainId,
      asset: args.asset,
      amountWei: args.amountWei.toString(),
      secret: args.secret,
      commitment: args.commitment,
      ...(args.note ? { note: args.note } : {}),
    });
    const sealed = await sealToReceiveTag(pkg, args.recipient);
    return { delivery: sealed, sealedTicket: sealed };
  }

  const shortBody = encodeShortClaim({
    chainId: args.chainId,
    pool: args.pool,
    asset: args.asset,
    amountWei: args.amountWei.toString(),
    secret: args.secret,
    ...(args.seed ? { seed: args.seed } : {}),
    ...(args.note ? { note: args.note } : {}),
  });

  if (shortBody) {
    return { delivery: shortClaimLink(shortBody) };
  }

  const fallbackPkg = encodeNotePackage({
    pool: args.pool,
    chainId: args.chainId,
    asset: args.asset,
    amountWei: args.amountWei.toString(),
    secret: args.secret,
    commitment: args.commitment,
    ...(args.note ? { note: args.note } : {}),
  });
  return { delivery: fallbackPkg };
}

export interface PreparedTransfer {
  intent: PrivateSendIntent;
  paymentNote: NoteExport;
  changeNote: NoteExport;
  paymentSeed?: Hex;
  nullifier: Hex;
  paymentCommitment: Hex;
  changeCommitment: Hex;
}

/**
 * Build a fresh signed-ready private transfer intent through `buildPrivateSendIntent`,
 * passing `paySeed` for claim-link rows so they encode into ~30-char short claim URLs.
 */
export async function preparePayrollTransfer(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  spendSecret: Hex;
  spendAmountWei: bigint;
  payAmountWei: bigint;
  path: PoseidonMerklePath;
  prove: Prover;
  useShortSeed: boolean;
}): Promise<PreparedTransfer> {
  const paymentSeed = args.useShortSeed ? randomNoteSeed().seed : undefined;
  const intent = await buildPrivateSendIntent({
    secretHex: args.spendSecret,
    amountInWei: args.spendAmountWei,
    amountPayWei: args.payAmountWei,
    asset: args.asset,
    path: args.path,
    prove: args.prove,
    poolAddress: args.pool,
    chainId: args.chainId,
    ...(paymentSeed ? { paySeed: paymentSeed } : {}),
  });

  const [, , nullifier] = transferCallArgs(intent);

  return {
    intent,
    paymentNote: intent.paymentNote,
    changeNote: intent.changeNote,
    paymentSeed,
    nullifier,
    paymentCommitment: intent.paymentNote.commitment,
    changeCommitment: intent.changeNote.commitment,
  };
}

/**
 * Re-prove an already-recorded unconfirmed payment against a fresh Merkle path:
 * spends the exact same input note into the exact same `(paymentCommitment, changeCommitment)`
 * with the exact same secrets. Mirrors upstream `samePaymentWitness` so retrying a payment
 * whose fate was uncertain can never double-pay or overwrite a still-in-flight payee/change note.
 */
export async function prepareSamePayrollTransfer(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  spendSecret: Hex;
  spendAmountWei: bigint;
  payAmountWei: bigint;
  expectedNullifier: Hex;
  paymentSecret: Hex;
  paymentCommitment: Hex;
  paymentSeed?: Hex;
  changeSecret?: Hex;
  changeCommitment?: Hex;
  path: PoseidonMerklePath;
  prove: Prover;
}): Promise<PreparedTransfer> {
  const changeAmountWei = args.spendAmountWei - args.payAmountWei;
  if (changeAmountWei < 0n) {
    throw new Error("Recorded spend amount is smaller than the payment amount.");
  }

  const w = await buildTransferWitness({
    secretHex: args.spendSecret,
    amountIn: args.spendAmountWei,
    amountPay: args.payAmountWei,
    asset: args.asset,
    path: args.path,
  });
  if (w.blocker) throw new Error(w.blocker);

  const nullifierHex = fieldToBytes32(w.publicInputs.nullifier);
  if (nullifierHex.toLowerCase() !== args.expectedNullifier.toLowerCase()) {
    throw new Error("Recorded spend nullifier does not match the input note; refusing to resend.");
  }

  const paySecretField = hexToField(args.paymentSecret);
  const payCommitField = await noteCommitmentPoseidon(paySecretField, args.payAmountWei, args.asset);
  if (fieldToHex(payCommitField).toLowerCase() !== args.paymentCommitment.toLowerCase()) {
    throw new Error("Recorded payment secret does not open paymentCommitment; refusing to resend.");
  }

  let changeSecretField: bigint;
  let changeCommitField: bigint;
  if (args.changeSecret && args.changeCommitment) {
    changeSecretField = hexToField(args.changeSecret);
    changeCommitField = await noteCommitmentPoseidon(changeSecretField, changeAmountWei, args.asset);
    if (fieldToHex(changeCommitField).toLowerCase() !== args.changeCommitment.toLowerCase()) {
      throw new Error("Recorded change secret does not open changeCommitment; refusing to resend.");
    }
  } else if (changeAmountWei > 0n) {
    throw new Error("Recorded non-zero change opening is missing; refusing to resend.");
  } else {
    changeSecretField = hexToField(w.changeNote.secret);
    changeCommitField = w.publicInputs.newCommitment1;
  }

  const circomInput: Record<string, string | string[]> = {
    ...w.circomInput,
    secretPay: paySecretField.toString(),
    newCommitment0: payCommitField.toString(),
    secretChange: changeSecretField.toString(),
    newCommitment1: changeCommitField.toString(),
  };

  const { proofBytes } = await args.prove(circomInput);

  const paymentNullifier = await noteNullifierPoseidon(paySecretField, payCommitField);
  const changeNullifier = await noteNullifierPoseidon(changeSecretField, changeCommitField);
  const c0 = fieldToBytes32(payCommitField);
  const c1 = fieldToBytes32(changeCommitField);

  const paymentNote: NoteExport = {
    secret: args.paymentSecret,
    commitment: c0,
    nullifier: fieldToHex(paymentNullifier),
    amountWei: args.payAmountWei.toString(),
    asset: args.asset,
    ...(args.paymentSeed ? { seed: args.paymentSeed } : {}),
  };
  const changeNote: NoteExport = {
    secret: fieldToHex(changeSecretField),
    commitment: c1,
    nullifier: fieldToHex(changeNullifier),
    amountWei: changeAmountWei.toString(),
    asset: args.asset,
  };

  const intent: PrivateSendIntent = {
    intent: "private_send",
    chainId: args.chainId,
    agentAddress: null,
    plan: {
      asset: args.asset.toLowerCase() === NATIVE_ASSET.toLowerCase() ? "ETH" : args.asset,
      amountWei: args.payAmountWei,
    },
    privacy:
      "Private send stays inside the vault: no public transfer, no visible amount. The recipient opens the payment note; the change note stays with you.",
    execution: `Unsigned. Sign and broadcast transfer(proof, root, nullifier, [c0, c1]) on ${networkName(args.chainId)}.`,
    exec: {
      poolAddress: args.pool,
      fn: "transfer",
      valueWei: 0n,
      args: [proofBytes, fieldToBytes32(w.publicInputs.root), nullifierHex, [c0, c1]],
    },
    paymentNote,
    changeNote,
  };

  return {
    intent,
    paymentNote,
    changeNote,
    paymentSeed: args.paymentSeed,
    nullifier: nullifierHex,
    paymentCommitment: c0,
    changeCommitment: c1,
  };
}

export interface PayrollPlanSummary {
  networkKey: string;
  networkLabel: string;
  chainId: number;
  ceremony: "dev" | "production";
  pool: Address;
  assetSymbol: string;
  assetAddress: Address;
  assetDecimals: number;
  hasMemoBoard: boolean;
  validRows: ParsedPayrollRow[];
  issues: CsvRowIssue[];
  fatalError: string | null;
  totalWei: bigint;
  totalFormatted: string;
  gloamCount: number;
  nameCount: number;
  linkCount: number;
  unresolvedNameCount: number;
  proofParts: number[];
  perDepositLimitWei: bigint | null;
  exceedsSingleDepositLimit: boolean;
}

function summarizeEvmPlan(
  net: GloamNetwork,
  asset: GloamAsset,
  rows: ParsedPayrollRow[],
  issues: CsvRowIssue[],
  totalWei: bigint,
  fatalError: string | null
): PayrollPlanSummary {
  const gloamCount = rows.filter((r) => r.kind === "gloam").length;
  const nameCount = rows.filter((r) => Boolean(r.payName)).length;
  const unresolvedNameCount = rows.filter((r) => Boolean(r.payName) && !r.recipient).length;
  const linkCount = rows.length - gloamCount;
  const perDepositLimitWei =
    asset.depositLimit && !isNoLimit(asset.depositLimit.perDeposit)
      ? asset.depositLimit.perDeposit
      : null;

  return {
    networkKey: net.key,
    networkLabel: net.label,
    chainId: net.chainId,
    ceremony: ceremonyForChainId(net.chainId),
    pool: net.pool,
    assetSymbol: asset.symbol,
    assetAddress: asset.address,
    assetDecimals: asset.decimals,
    hasMemoBoard: payMemoBoardFor(net.chainId) !== null,
    validRows: rows,
    issues,
    fatalError,
    totalWei,
    totalFormatted: formatUnits(totalWei, asset.decimals),
    gloamCount,
    nameCount,
    linkCount,
    unresolvedNameCount,
    proofParts: payrollParts(rows.length),
    perDepositLimitWei,
    exceedsSingleDepositLimit:
      perDepositLimitWei !== null && totalWei > perDepositLimitWei,
  };
}

/** Synchronous offline payroll planning (does not resolve `@name` recipients on chain). */
export function planPayroll(args: {
  csvText: string;
  networkKey?: string;
  assetInput?: string;
  maxTotalWei?: bigint;
}): PayrollPlanSummary {
  const net = resolveNetwork(args.networkKey);
  const asset = resolveAsset(net, args.assetInput);
  const parsed = parsePayrollCsv(args.csvText, asset.decimals, {
    maxTotalWei: args.maxTotalWei,
  });
  return summarizeEvmPlan(net, asset, parsed.rows, parsed.issues, parsed.totalWei, parsed.fatalError);
}

/**
 * Full payroll planning: parses the CSV and resolves any Gloam `@name` recipients
 * against `GloamNames` on Robinhood Chain mainnet (unless `offline: true`).
 */
export async function planPayrollWithNames(args: {
  csvText: string;
  networkKey?: string;
  assetInput?: string;
  maxTotalWei?: bigint;
  offline?: boolean;
  namesRpcUrl?: string;
  nameReader?: NameReader;
}): Promise<{ plan: PayrollPlanSummary; resolvedNames: Map<string, NameLookupAnswer> }> {
  const net = resolveNetwork(args.networkKey);
  const asset = resolveAsset(net, args.assetInput);
  const parsed = parsePayrollCsv(args.csvText, asset.decimals, {
    maxTotalWei: args.maxTotalWei,
  });

  const pendingNames = parsed.rows
    .map((r) => r.payName)
    .filter((n): n is string => Boolean(n));

  const resolvedNames = new Map<string, NameLookupAnswer>();
  if (pendingNames.length === 0 || args.offline) {
    return {
      plan: summarizeEvmPlan(net, asset, parsed.rows, parsed.issues, parsed.totalWei, parsed.fatalError),
      resolvedNames,
    };
  }

  const answers = await resolveGloamNames(pendingNames, {
    rpcUrl: args.namesRpcUrl,
    reader: args.nameReader,
  });
  for (const [k, v] of answers) resolvedNames.set(k, v);

  const applied = applyResolvedPayrollNames(parsed.rows, answers);
  const combinedIssues = [...parsed.issues, ...applied.issues].sort((a, b) => a.line - b.line);
  let fatalError = parsed.fatalError;
  if (!fatalError && args.maxTotalWei !== undefined && applied.totalWei > args.maxTotalWei) {
    fatalError = `Run total (${applied.totalWei.toString()} base units) exceeds configured --max-total cap (${args.maxTotalWei.toString()}).`;
  }

  return {
    plan: summarizeEvmPlan(net, asset, applied.rows, combinedIssues, applied.totalWei, fatalError),
    resolvedNames,
  };
}

export function createInitialRunState(args: {
  id: string;
  net: GloamNetwork;
  asset: GloamAsset;
  rows: ParsedPayrollRow[];
  relay: boolean;
  activeNote: StoredNote | null;
}): PayrollRunState {
  const now = Date.now();
  return {
    v: 1,
    kind: "evm",
    id: args.id,
    createdAt: now,
    updatedAt: now,
    networkKey: args.net.key,
    chainId: args.net.chainId,
    pool: args.net.pool,
    asset: args.asset.address,
    assetSymbol: args.asset.symbol,
    assetDecimals: args.asset.decimals,
    relay: args.relay,
    activeNote: args.activeNote,
    status: "ready",
    rows: args.rows.map((r, index) => ({
      index,
      line: r.line,
      name: r.name,
      recipient: r.recipient,
      kind: r.kind,
      ...(r.payName ? { payName: r.payName } : {}),
      amountInput: r.amountInput,
      amountWei: r.amountWei.toString(),
      note: r.note,
      status: "queued",
      attempts: 0,
    })),
  };
}

export function buildPayoutExport(state: PayrollRunState): string {
  const exportRows: PayoutExportRow[] = state.rows.map((row) => ({
    name: row.name,
    ...(row.payName ? { payName: row.payName } : {}),
    kind: row.kind,
    amount: formatUnits(BigInt(row.amountWei), state.assetDecimals),
    note: row.note,
    status: row.status,
    delivery: row.delivery ?? "",
    txHash: row.txHash ?? "",
    memoTxHash: row.memoTxHash ?? "",
  }));
  return formatPayoutCsv(exportRows);
}

export interface ChainPoolReader {
  commitmentSeen(commitment: Hex): Promise<boolean>;
  isSpent(nullifier: Hex): Promise<boolean>;
  getReceiptStatus?(hash: Hex): Promise<"success" | "reverted" | null>;
}

/**
 * Reconcile an `activeNote` that does not yet have a confirmed `blockNumber` (for example after a
 * crash or revert during `shieldBound`, or when funded via `--funding-note`).
 */
export async function reconcileFundingNote(
  state: PayrollRunState,
  poolReader: ChainPoolReader
): Promise<"none" | "confirmed" | "cleared_unsent" | "cleared_reverted" | "pending"> {
  const active = state.activeNote;
  if (!active) return "none";
  if (active.blockNumber) return "confirmed";

  const seen = await poolReader.commitmentSeen(active.commitment);
  if (seen) {
    return "confirmed";
  }

  // If CLI created this activeNote for a shield deposit and never reached broadcast, clear it safely.
  if (state.fundingShieldSent === false && !state.fundingTxHash) {
    state.activeNote = null;
    state.fundingShieldSent = undefined;
    return "cleared_unsent";
  }

  if (state.fundingTxHash && poolReader.getReceiptStatus) {
    const receiptStatus = await poolReader.getReceiptStatus(state.fundingTxHash);
    if (receiptStatus === "reverted") {
      state.activeNote = null;
      state.fundingShieldSent = undefined;
      state.fundingTxHash = undefined;
      return "cleared_reverted";
    }
    if (receiptStatus === "success") {
      return "confirmed";
    }
    return "pending";
  }

  return "pending";
}

/**
 * Reconcile an `unconfirmed` row against on-chain pool state before re-submitting:
 * - `commitmentSeen(paymentCommitment) === true` -> transfer already landed -> mark `paid` and advance `activeNote`.
 * - `isSpent(spendNullifier) === true` -> input note was spent elsewhere -> mark `failed` and halt safely.
 * - Neither -> input note is still unspent -> safe to re-prove & re-submit the exact same payment.
 */
export async function reconcileUnconfirmedRow(
  state: PayrollRunState,
  row: StoredPayrollRow,
  poolReader: ChainPoolReader
): Promise<"already_paid" | "spent_elsewhere" | "retry_safe"> {
  if (!row.paymentCommitment || !row.spendNullifier) {
    row.status = "queued";
    return "retry_safe";
  }

  const seen = await poolReader.commitmentSeen(row.paymentCommitment);
  if (seen) {
    row.status = "paid";
    row.error = undefined;
    if (row.changeSecret && row.changeCommitment && row.changeAmountWei) {
      const changeAmt = BigInt(row.changeAmountWei);
      state.activeNote =
        changeAmt > 0n
          ? {
              secret: row.changeSecret,
              commitment: row.changeCommitment,
              amountWei: row.changeAmountWei,
              asset: state.asset,
              txHash: row.txHash,
              blockNumber: row.blockNumber,
            }
          : null;
    }
    return "already_paid";
  }

  const spent = await poolReader.isSpent(row.spendNullifier);
  if (spent) {
    row.status = "failed";
    row.error = "Funding note nullifier was spent by another transaction; refusing to overwrite.";
    return "spent_elsewhere";
  }

  return "retry_safe";
}

function makePoolReader(client: PublicClient, pool: Address): ChainPoolReader {
  return {
    commitmentSeen: (commitment) =>
      client.readContract({
        address: pool,
        abi: POOL_STATE_ABI,
        functionName: "commitmentSeen",
        args: [commitment],
      }),
    isSpent: (nullifier) =>
      client.readContract({
        address: pool,
        abi: POOL_STATE_ABI,
        functionName: "isSpent",
        args: [nullifier],
      }),
    getReceiptStatus: async (hash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        return null;
      }
    },
  };
}

function formatSyncError(err: unknown, net: GloamNetwork): Error {
  if (err instanceof PrunedLogsError) {
    return new Error(
      `${err.message} Pass --rpc (or set GLOAM_RPC) to an archive RPC for ${net.label} (${net.key}) that retains full vault logs.`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function waitForCommitmentPath(
  treeSync: ReturnType<typeof createTreeSync>,
  commitment: Hex,
  net: GloamNetwork,
  atBlock?: bigint
): Promise<PoseidonMerklePath> {
  for (let attempt = 1; attempt <= TREE_SYNC_RETRIES; attempt++) {
    try {
      const path = await treeSync.pathForCommitment(commitment, { atBlock });
      if (path) return path;
    } catch (err) {
      if (err instanceof PrunedLogsError) throw formatSyncError(err, net);
      if (attempt === TREE_SYNC_RETRIES) throw formatSyncError(err, net);
    }
    if (attempt < TREE_SYNC_RETRIES) {
      await sleep(TREE_SYNC_DELAY_MS);
    }
  }
  throw new Error(
    `Active funding note commitment ${commitment} was not found in the vault tree after ${TREE_SYNC_RETRIES} sync attempts.`
  );
}

function hasRecordedPayment(row: StoredPayrollRow): boolean {
  return Boolean(
    row.spendSecret &&
      row.spendAmountWei &&
      row.spendNullifier &&
      row.paymentSecret &&
      row.paymentCommitment &&
      row.delivery
  );
}

export interface ExecutePayrollOptions {
  state: PayrollRunState;
  stateFilePath: string;
  privateKey?: Hex;
  rpcUrl?: string;
  relayUrl?: string;
  circuitsCacheDir?: string;
  log?: (msg: string) => void;
}

/**
 * Execute or resume an EVM payroll run end-to-end on chain.
 * - Reconciles any in-flight shield deposit or unconfirmed row before sending anything new.
 * - Re-proves an unconfirmed row with its exact recorded outputs (never overwriting secrets).
 * - Retries Merkle tree sync for RPC lag and retries unposted `GloamPayMemo` notices on resume.
 */
export async function executePayrollRun(opts: ExecutePayrollOptions): Promise<PayrollRunState> {
  const log = opts.log ?? console.log;
  const { state, stateFilePath } = opts;
  const net = resolveNetwork(state.networkKey);
  const asset = resolveAsset(net, state.asset);
  const transport = opts.rpcUrl ? http(opts.rpcUrl) : gloamReadTransport(net);
  const publicClient = createPublicClient({ chain: net.chain, transport });

  const account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
  const walletClient = account
    ? createWalletClient({ account, chain: net.chain, transport })
    : null;

  if (!state.relay && !walletClient) {
    throw new Error("Direct submission (--direct) requires GLOAM_PAY_KEY.");
  }

  const poolReader = makePoolReader(publicClient, net.pool);
  const memoBoard = payMemoBoardFor(net.chainId);
  const relayOpts = opts.relayUrl ? { url: opts.relayUrl } : undefined;

  const remainingWei = state.rows
    .filter((r) => r.status !== "paid")
    .reduce((sum, r) => sum + BigInt(r.amountWei), 0n);

  if (remainingWei === 0n) {
    // Still retry any unposted memos for already-paid Gloam-address rows.
    for (const row of state.rows) {
      if (row.status === "paid" && row.kind === "gloam" && !row.memoPosted) {
        await maybePostMemo(row, state, memoBoard, walletClient, relayOpts, log);
        saveRunState(stateFilePath, state);
      }
    }
    state.status = "done";
    saveRunState(stateFilePath, state);
    log("All rows in this run are already paid.");
    return state;
  }

  state.status = "running";
  saveRunState(stateFilePath, state);

  // Step 0: Reconcile an unconfirmed funding note (e.g. crash/revert during shieldBound, or --funding-note).
  if (state.activeNote && !state.activeNote.blockNumber) {
    const fundingStatus = await reconcileFundingNote(state, poolReader);
    saveRunState(stateFilePath, state);
    if (fundingStatus === "pending") {
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(
        state.fundingTxHash
          ? `Funding shield transaction ${state.fundingTxHash} is not confirmed in the vault yet. Wait a moment and run "resume".`
          : `Funding note ${state.activeNote?.commitment} is not confirmed in the vault yet.`
      );
    }
    if (fundingStatus === "cleared_reverted") {
      log("Previous shield deposit reverted on chain; preparing a fresh funding deposit.");
    } else if (fundingStatus === "cleared_unsent") {
      log("Previous shield deposit was never broadcast; preparing a fresh funding deposit.");
    } else if (fundingStatus === "confirmed" && state.activeNote) {
      // Verify the confirmed funding note hasn't already been spent externally.
      const fundingNullifier = fieldToBytes32(
        await noteNullifierPoseidon(hexToField(state.activeNote.secret), hexToField(state.activeNote.commitment))
      );
      if (await poolReader.isSpent(fundingNullifier)) {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(
          `Active funding note (${state.activeNote.commitment}) is already spent on chain. Supply a fresh --funding-note.`
        );
      }
    }
  }

  // Step 1: Fund the private balance with a bound shield deposit if no funding note is active.
  if (!state.activeNote) {
    if (!walletClient || !account) {
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error("Funding a new payroll run requires GLOAM_PAY_KEY (or pass --funding-note).");
    }
    const perDeposit = asset.depositLimit?.perDeposit;
    if (perDeposit && !isNoLimit(perDeposit) && remainingWei > perDeposit) {
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(
        `Run total (${formatUnits(remainingWei, asset.decimals)} ${asset.symbol}) exceeds this pool's single-deposit cap (${formatUnits(perDeposit, asset.decimals)} ${asset.symbol}). Shield across multiple deposits or pass --funding-note.`
      );
    }

    log(`Resolving shield circuit artifacts (${ceremonyForChainId(net.chainId)} keys)...`);
    const shieldArtifacts = await resolveCircuitArtifacts("shield", net.chainId, {
      cacheDir: opts.circuitsCacheDir,
    });
    const proveShield = artifactProver(shieldArtifacts);

    if (!isNativeAsset(asset)) {
      const allowance = await publicClient.readContract({
        address: asset.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, net.pool],
      });
      const steps = approvalSteps(net.chainId, asset.address, allowance, remainingWei);
      for (const stepAmount of steps) {
        log(`Approving ${formatUnits(stepAmount, asset.decimals)} ${asset.symbol} for vault...`);
        const approveHash = await walletClient.writeContract({
          address: asset.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [net.pool, stepAmount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    log(`Proving bound shield deposit of ${formatUnits(remainingWei, asset.decimals)} ${asset.symbol}...`);
    const shieldIntent = await buildShieldBoundIntent({
      amountWei: remainingWei,
      asset: asset.address,
      chainId: net.chainId,
      poolAddress: net.pool,
      prove: proveShield,
      client: publicClient,
    });

    // Persist funding note secret BEFORE broadcast so a crash right after send never loses funds.
    state.activeNote = {
      secret: shieldIntent.note.secret,
      commitment: shieldIntent.note.commitment,
      amountWei: remainingWei.toString(),
      asset: asset.address,
    };
    state.fundingShieldSent = false;
    saveRunState(stateFilePath, state);

    const [argAsset, argAmount, argCommitment, argProof] = shieldIntent.exec.args as readonly [
      Address,
      bigint,
      Hex,
      Hex,
    ];
    let shieldHash: Hex;
    try {
      shieldHash = await walletClient.writeContract({
        address: shieldIntent.exec.poolAddress,
        abi: SHIELD_BOUND_ABI,
        functionName: "shieldBound",
        args: [argAsset, argAmount, argCommitment, argProof],
        value: shieldIntent.exec.valueWei,
      });
    } catch (err) {
      // Failed before returning a tx hash: clear phantom activeNote so resume can retry funding cleanly.
      state.activeNote = null;
      state.fundingShieldSent = undefined;
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw err;
    }

    state.fundingTxHash = shieldHash;
    state.fundingShieldSent = true;
    state.activeNote.txHash = shieldHash;
    saveRunState(stateFilePath, state);
    log(`Shield deposit sent: ${shieldHash}`);

    const shieldReceipt = await publicClient.waitForTransactionReceipt({ hash: shieldHash });
    if (shieldReceipt.status !== "success") {
      state.activeNote = null;
      state.fundingShieldSent = undefined;
      state.fundingTxHash = undefined;
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(`Shield deposit reverted (${shieldHash}).`);
    }
    state.activeNote.blockNumber = shieldReceipt.blockNumber.toString();
    saveRunState(stateFilePath, state);
  }

  // Step 2: Prepare transfer prover and incremental Merkle tree sync.
  log(`Resolving transfer circuit artifacts (${ceremonyForChainId(net.chainId)} keys)...`);
  const transferArtifacts = await resolveCircuitArtifacts("transfer", net.chainId, {
    cacheDir: opts.circuitsCacheDir,
  });
  const proveTransfer = artifactProver(transferArtifacts);

  const treeSync = createTreeSync(publicClient, {
    pool: net.pool,
    fromBlock: net.deployBlock,
    seed: gloamLeafSeed(net.key),
    verifyRoot: true,
  });

  // Step 3: Process rows sequentially, chaining each row's change note into the next.
  for (const row of state.rows) {
    if (row.status === "paid") {
      if (row.kind === "gloam" && !row.memoPosted) {
        await maybePostMemo(row, state, memoBoard, walletClient, relayOpts, log);
        saveRunState(stateFilePath, state);
      }
      continue;
    }

    let resendRecorded = false;
    if (row.status === "unconfirmed") {
      log(`Row ${row.index + 1} (${row.name}) was unconfirmed; checking chain state...`);
      const verdict = await reconcileUnconfirmedRow(state, row, poolReader);
      saveRunState(stateFilePath, state);
      if (verdict === "already_paid") {
        log(`Row ${row.index + 1} (${row.name}) already settled on chain.`);
        await maybePostMemo(row, state, memoBoard, walletClient, relayOpts, log);
        saveRunState(stateFilePath, state);
        continue;
      }
      if (verdict === "spent_elsewhere") {
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(row.error);
      }
      resendRecorded = hasRecordedPayment(row);
    }

    const funding: StoredNote | null = state.activeNote;
    const payAmountWei = BigInt(row.amountWei);
    if (!funding || BigInt(funding.amountWei) < payAmountWei) {
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(
        `Insufficient private balance for row ${row.index + 1} (${row.name}): need ${formatUnits(payAmountWei, asset.decimals)} ${asset.symbol}.`
      );
    }

    const spendCommitment = resendRecorded && row.spendCommitment ? row.spendCommitment : funding.commitment;
    const path = await waitForCommitmentPath(
      treeSync,
      spendCommitment,
      net,
      funding.blockNumber ? BigInt(funding.blockNumber) : undefined
    );

    const payeeLabel = row.payName ? `@${row.payName}` : row.kind;
    let prepared: PreparedTransfer;

    if (resendRecorded) {
      log(
        `[${row.index + 1}/${state.rows.length}] Re-proving identical private send of ${row.amountInput} ${asset.symbol} for ${row.name} (${payeeLabel})...`
      );
      prepared = await prepareSamePayrollTransfer({
        chainId: net.chainId,
        pool: net.pool,
        asset: asset.address,
        spendSecret: row.spendSecret!,
        spendAmountWei: BigInt(row.spendAmountWei!),
        payAmountWei,
        expectedNullifier: row.spendNullifier!,
        paymentSecret: row.paymentSecret!,
        paymentCommitment: row.paymentCommitment!,
        paymentSeed: row.paymentSeed,
        changeSecret: row.changeSecret,
        changeCommitment: row.changeCommitment,
        path,
        prove: proveTransfer,
      });
      row.attempts += 1;
      row.status = "unconfirmed";
      row.error = undefined;
      row.sentAt = Date.now();
      saveRunState(stateFilePath, state);
    } else {
      log(
        `[${row.index + 1}/${state.rows.length}] Proving private send of ${row.amountInput} ${asset.symbol} for ${row.name} (${payeeLabel})...`
      );
      prepared = await preparePayrollTransfer({
        chainId: net.chainId,
        pool: net.pool,
        asset: asset.address,
        spendSecret: funding.secret,
        spendAmountWei: BigInt(funding.amountWei),
        payAmountWei,
        path,
        prove: proveTransfer,
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

      // Write-ahead persistence BEFORE broadcast (crash safety).
      const changeAmtWei: bigint = BigInt(funding.amountWei) - payAmountWei;
      row.attempts += 1;
      row.status = "unconfirmed";
      row.error = undefined;
      row.spendSecret = funding.secret;
      row.spendAmountWei = funding.amountWei;
      row.spendCommitment = funding.commitment;
      row.spendNullifier = prepared.nullifier;
      row.paymentSeed = prepared.paymentSeed;
      row.paymentSecret = prepared.paymentNote.secret;
      row.paymentCommitment = prepared.paymentCommitment;
      row.changeSecret = prepared.changeNote.secret;
      row.changeCommitment = prepared.changeCommitment;
      row.changeAmountWei = changeAmtWei.toString();
      row.delivery = delivery.delivery;
      row.sealedTicket = delivery.sealedTicket;
      row.sentAt = Date.now();
      saveRunState(stateFilePath, state);
    }

    let txHash: Hex;
    try {
      if (state.relay) {
        txHash = await relayIntent(prepared.intent, relayOpts);
      } else {
        const [proof, root, nullifier, commitments] = prepared.intent.exec.args as readonly [
          Hex,
          Hex,
          Hex,
          readonly [Hex, Hex],
        ];
        txHash = await walletClient!.writeContract({
          address: prepared.intent.exec.poolAddress,
          abi: POOL_TRANSFER_ABI,
          functionName: "transfer",
          args: [proof, root, nullifier, commitments],
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      row.error = msg;
      // Only mark "failed" when we are sure nothing was sent; ambiguous relay/network errors stay "unconfirmed".
      const definitelyNotSent =
        err instanceof GloamRelayError ? !RELAY_MAYBE_SENT.has(err.code) : !state.relay && !row.txHash;
      if (definitelyNotSent) {
        row.status = "failed";
      }
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw err;
    }

    row.txHash = txHash;
    saveRunState(stateFilePath, state);
    log(`  Submitted: ${txHash} — waiting for confirmation...`);

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw err;
    }

    if (receipt.status !== "success") {
      // Check if an earlier in-flight copy of the same payment landed despite this tx reverting.
      const landed = await poolReader.commitmentSeen(prepared.paymentCommitment);
      if (!landed) {
        row.status = "failed";
        row.error = `Transfer reverted on chain (${txHash}).`;
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(row.error);
      }
    } else {
      const seen = await poolReader.commitmentSeen(prepared.paymentCommitment);
      if (!seen) {
        row.error = `Transaction ${txHash} mined, but payment commitment was not seen yet. Run "resume" to confirm.`;
        state.status = "paused";
        saveRunState(stateFilePath, state);
        throw new Error(row.error);
      }
    }

    const changeAmtWei = BigInt(row.changeAmountWei ?? "0");
    row.status = "paid";
    row.error = undefined;
    row.blockNumber = receipt.blockNumber.toString();
    state.activeNote =
      changeAmtWei > 0n
        ? {
            secret: prepared.changeNote.secret,
            commitment: prepared.changeCommitment,
            amountWei: changeAmtWei.toString(),
            asset: asset.address,
            txHash,
            blockNumber: receipt.blockNumber.toString(),
          }
        : null;
    saveRunState(stateFilePath, state);

    await maybePostMemo(row, state, memoBoard, walletClient, relayOpts, log);
    saveRunState(stateFilePath, state);
  }

  state.status = state.rows.every((r) => r.status === "paid") ? "done" : "paused";
  saveRunState(stateFilePath, state);
  return state;
}

async function maybePostMemo(
  row: StoredPayrollRow,
  state: PayrollRunState,
  memoBoard: ReturnType<typeof payMemoBoardFor>,
  walletClient: ReturnType<typeof createWalletClient> | null,
  relayOpts: { url?: string } | undefined,
  log: (msg: string) => void
): Promise<void> {
  if (row.kind !== "gloam" || !row.sealedTicket || !row.paymentCommitment || row.memoPosted) {
    return;
  }
  if (!memoBoard) {
    log(`  Note: ${state.networkKey} has no GloamPayMemo board; share the sealed gloam2t ticket directly.`);
    return;
  }
  const memoBytes = ticketToMemoBytes(row.sealedTicket);
  try {
    if (state.relay) {
      row.memoTxHash = await relayMemo(
        { chainId: state.chainId, paymentCommitment: row.paymentCommitment, memo: memoBytes },
        relayOpts
      );
    } else if (walletClient) {
      row.memoTxHash = await walletClient.writeContract({
        address: memoBoard.address,
        abi: PAY_MEMO_ABI,
        functionName: "postMemo",
        args: [row.paymentCommitment, memoBytes],
        chain: walletClient.chain,
        account: walletClient.account!,
      });
    }
    row.memoPosted = true;
    log(`  Memo posted: ${row.memoTxHash}`);
  } catch (err) {
    log(
      `  Warning: payment settled, but posting the memo failed (${err instanceof Error ? err.message : String(err)}). Sealed ticket is saved in the payout export.`
    );
  }
}
