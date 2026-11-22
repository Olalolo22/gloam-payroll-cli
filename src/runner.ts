import {
  NATIVE_ASSET,
  POOL_STATE_ABI,
  POOL_TRANSFER_ABI,
  RELAY_MAYBE_SENT,
  GloamRelayError,
  approvalSteps,
  artifactProver,
  buildPrivateSendIntent,
  buildShieldBoundIntent,
  ceremonyForChainId,
  createTreeSync,
  encodeNotePackage,
  encodeShortClaim,
  getGloamNetwork,
  gloamLeafSeed,
  gloamNetworks,
  gloamReadTransport,
  isNoLimit,
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
  formatPayoutCsv,
  parsePayrollCsv,
  type ParsedPayrollRow,
  type PayoutExportRow,
} from "./csv.js";
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

export const SUPPORTED_NETWORK_KEYS: readonly GloamNetworkKey[] = [
  "robinhood",
  "tempo",
  "base",
  "ethereum",
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
  "elysium-mainnet",
  "bnb-mainnet",
];

export function isNativeAsset(asset: GloamAsset): boolean {
  return asset.address.toLowerCase() === NATIVE_ASSET.toLowerCase();
}

export function resolveNetwork(keyInput?: string): GloamNetwork {
  const key = (keyInput?.trim() || "robinhood") as GloamNetworkKey;
  if (!SUPPORTED_NETWORK_KEYS.includes(key)) {
    throw new Error(`Unknown network "${key}". Choose one of: ${SUPPORTED_NETWORK_KEYS.join(", ")}.`);
  }
  const net = getGloamNetwork(key);
  if (!net) {
    const liveKeys = gloamNetworks().map((n) => n.key);
    throw new Error(`Network "${key}" has no pool in this SDK version. Available: ${liveKeys.join(", ")}.`);
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
 * Build a signed-ready private transfer intent through `buildPrivateSendIntent`,
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
  issues: { line: number; message: string }[];
  fatalError: string | null;
  totalWei: bigint;
  totalFormatted: string;
  gloamCount: number;
  linkCount: number;
  proofParts: number[];
  perDepositLimitWei: bigint | null;
  exceedsSingleDepositLimit: boolean;
}

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

  const gloamCount = parsed.rows.filter((r) => r.kind === "gloam").length;
  const linkCount = parsed.rows.length - gloamCount;
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
    validRows: parsed.rows,
    issues: parsed.issues,
    fatalError: parsed.fatalError,
    totalWei: parsed.totalWei,
    totalFormatted: formatUnits(parsed.totalWei, asset.decimals),
    gloamCount,
    linkCount,
    proofParts: payrollParts(parsed.rows.length),
    perDepositLimitWei,
    exceedsSingleDepositLimit:
      perDepositLimitWei !== null && parsed.totalWei > perDepositLimitWei,
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
}

/**
 * Reconcile an `unconfirmed` row against on-chain pool state before re-submitting:
 * - `commitmentSeen(paymentCommitment) === true` -> transfer already landed -> mark `paid` and advance `activeNote`.
 * - `isSpent(spendNullifier) === true` -> input note was spent elsewhere -> mark `failed` and halt safely.
 * - Neither -> input note is still unspent -> safe to re-submit this row.
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
  };
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
 * Execute or resume a payroll run end-to-end on chain.
 * - Shields the total amount into a funding note if `state.activeNote` is null (requires `privateKey`).
 * - Syncs the vault Merkle tree incrementally via `createTreeSync` + `gloamLeafSeed`.
 * - Chains private transfers row-by-row using the relay (`relayIntent` + `relayMemo`) by default,
 *   or direct wallet signing when `state.relay === false`.
 * - Persists state atomically before and after each broadcast for crash-safe resume.
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

  const remainingWei = state.rows
    .filter((r) => r.status !== "paid")
    .reduce((sum, r) => sum + BigInt(r.amountWei), 0n);

  if (remainingWei === 0n) {
    state.status = "done";
    saveRunState(stateFilePath, state);
    log("All rows in this run are already paid.");
    return state;
  }

  state.status = "running";
  saveRunState(stateFilePath, state);

  // Step 1: Fund the private balance with a bound shield deposit if no funding note was provided.
  if (!state.activeNote) {
    if (!walletClient || !account) {
      throw new Error("Funding a new payroll run requires GLOAM_PAY_KEY (or pass --funding-note).");
    }
    const perDeposit = asset.depositLimit?.perDeposit;
    if (perDeposit && !isNoLimit(perDeposit) && remainingWei > perDeposit) {
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

    // Persist funding note secret BEFORE submitting deposit tx so a crash never loses funds.
    state.activeNote = {
      secret: shieldIntent.note.secret,
      commitment: shieldIntent.note.commitment,
      amountWei: remainingWei.toString(),
      asset: asset.address,
    };
    saveRunState(stateFilePath, state);

    const [argAsset, argAmount, argCommitment, argProof] = shieldIntent.exec.args as readonly [
      Address,
      bigint,
      Hex,
      Hex,
    ];
    const shieldHash = await walletClient.writeContract({
      address: shieldIntent.exec.poolAddress,
      abi: SHIELD_BOUND_ABI,
      functionName: "shieldBound",
      args: [argAsset, argAmount, argCommitment, argProof],
      value: shieldIntent.exec.valueWei,
    });
    log(`Shield deposit sent: ${shieldHash}`);
    const shieldReceipt = await publicClient.waitForTransactionReceipt({ hash: shieldHash });
    if (shieldReceipt.status !== "success") {
      throw new Error(`Shield deposit reverted (${shieldHash}).`);
    }
    state.fundingTxHash = shieldHash;
    state.activeNote.txHash = shieldHash;
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

  const poolReader = makePoolReader(publicClient, net.pool);
  const memoBoard = payMemoBoardFor(net.chainId);
  const relayOpts = opts.relayUrl ? { url: opts.relayUrl } : undefined;

  // Step 3: Process rows sequentially, chaining each row's change note into the next.
  for (const row of state.rows) {
    if (row.status === "paid") continue;

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

    const path = await treeSync.pathForCommitment(funding.commitment, {
      atBlock: funding.blockNumber ? BigInt(funding.blockNumber) : undefined,
    });
    if (!path) {
      throw new Error(
        `Active funding note commitment ${funding.commitment} was not found in the vault tree yet.`
      );
    }

    log(
      `[${row.index + 1}/${state.rows.length}] Proving private send of ${row.amountInput} ${asset.symbol} for ${row.name} (${row.kind})...`
    );
    const prepared = await preparePayrollTransfer({
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
      // If relay uncertainty exists, leave status as "unconfirmed" so resume checks on-chain first.
      if (!(err instanceof GloamRelayError && RELAY_MAYBE_SENT.has(err.code))) {
        row.status = "failed";
      }
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw err;
    }

    row.txHash = txHash;
    saveRunState(stateFilePath, state);
    log(`  Submitted: ${txHash} — waiting for confirmation...`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      row.status = "failed";
      row.error = `Transfer reverted on chain (${txHash}).`;
      state.status = "paused";
      saveRunState(stateFilePath, state);
      throw new Error(row.error);
    }

    row.status = "paid";
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
