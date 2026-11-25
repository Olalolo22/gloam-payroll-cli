#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  SOLANA_ASSETS,
  SOLANA_PRIVACY_NOTE,
  decodeNotePackage,
  generateReceiveKey,
  isNoLimit,
  notePackageToExport,
  payMemoBoardFor,
} from "@gloamtrade/sdk";
import { formatUnits, type Hex } from "viem";
import { loadPayrollVkey, resolveCircuitArtifacts } from "./artifacts.js";
import { parseAmountUnits } from "./csv.js";
import {
  createSnarkPayrollProver,
  decodePayrollProofToken,
  extractPaidProofInputs,
  generatePayrollProofBundle,
  verifyPayrollProofBundleOffline,
} from "./proof.js";
import {
  buildPayoutExport,
  createInitialRunState,
  executePayrollRun,
  listEvmNetworks,
  planPayrollWithNames,
  resolveAsset,
  resolveNetwork,
} from "./runner.js";
import {
  buildSolanaPayoutExport,
  createInitialSolanaRunState,
  executeSolanaPayrollRun,
  isSolanaNetworkKey,
  planSolanaPayroll,
  readSolanaSecretInput,
  resolveSolanaAsset,
  resolveSolanaNetwork,
} from "./solana.js";
import {
  isSolanaRunState,
  loadAnyRunState,
  loadRunState,
  saveRunState,
  type StoredNote,
} from "./state.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const CLI_VERSION = pkg.version;

export interface ParsedCliArgs {
  cmd: string;
  positional: string[];
  values: {
    network?: string;
    asset?: string;
    "max-total"?: string;
    direct: boolean;
    "funding-note"?: string;
    state?: string;
    out?: string;
    for?: string;
    days?: string;
    rpc?: string;
    relay?: string;
    "names-rpc"?: string;
    "solana-url"?: string;
    "account-index"?: string;
    snark: boolean;
    json: boolean;
    offline: boolean;
    "allow-partial": boolean;
    "no-add": boolean;
    help: boolean;
    version: boolean;
  };
}

/**
 * Strictly parse CLI arguments using Node's `util.parseArgs` so boolean flags never swallow
 * positional filenames (e.g. `run --direct list.csv`) and mistyped flags fail loudly.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const { values, positionals } = nodeParseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      network: { type: "string", short: "n" },
      asset: { type: "string", short: "a" },
      "max-total": { type: "string" },
      direct: { type: "boolean", default: false },
      "funding-note": { type: "string" },
      state: { type: "string" },
      out: { type: "string", short: "o" },
      for: { type: "string" },
      days: { type: "string" },
      rpc: { type: "string" },
      relay: { type: "string" },
      "names-rpc": { type: "string" },
      "solana-url": { type: "string" },
      "account-index": { type: "string" },
      snark: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      "allow-partial": { type: "boolean", default: false },
      "no-add": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  const cmd = values.version
    ? "version"
    : values.help
      ? "help"
      : (positionals[0] ?? "help");
  const positional = values.version || values.help ? [] : positionals.slice(1);

  return {
    cmd,
    positional,
    values: {
      network: values.network,
      asset: values.asset,
      "max-total": values["max-total"],
      direct: Boolean(values.direct),
      "funding-note": values["funding-note"],
      state: values.state,
      out: values.out,
      for: values.for,
      days: values.days,
      rpc: values.rpc,
      relay: values.relay,
      "names-rpc": values["names-rpc"],
      "solana-url": values["solana-url"],
      "account-index": values["account-index"],
      snark: Boolean(values.snark),
      json: Boolean(values.json),
      offline: Boolean(values.offline),
      "allow-partial": Boolean(values["allow-partial"]),
      "no-add": Boolean(values["no-add"]),
      help: Boolean(values.help),
      version: Boolean(values.version),
    },
  };
}

function printHelp(): void {
  console.log(`gloam-payroll v${CLI_VERSION} — Headless private CSV payroll & gloamroll1 proof CLI on @gloamtrade/sdk

Commands:
  plan <csv> [options]          Validate CSV (gloamr1., @name, claim link, or Solana), check limits, and print plan
  run <csv> [options]           Execute private payroll on EVM or Solana and write crash-safe ledger + payout CSV
  resume <run.json> [options]   Reconcile in-flight rows against the chain and finish remaining payments
  status <run.json> [--json]    Inspect run progress safely (prints no private keys or note secrets)
  prove <run.json> --for <who>  Generate a gloamroll1:... payroll total proof for https://www.gloam.trade/verify (EVM)
  verify-token <token|file>     Decode and offline-verify a gloamroll1:... proof (pass --snark for Groth16)
  networks [--json]             List all supported EVM networks, Solana, vaults, assets, and limits
  new-receive-key               Generate a fresh gloamr1. receive tag + private JWK for testing

Options:
  -n, --network <key>           Default: GLOAM_NETWORK or "robinhood" (testnet).
                                EVM mainnets: robinhood-mainnet, tempo-mainnet, base-mainnet, ethereum-mainnet, elysium-mainnet, bnb-mainnet
                                Solana: solana (mainnet), solana-devnet
  -a, --asset <symbol|address>  Asset symbol or address (defaults to network's first EVM asset, or USDC on Solana)
  --max-total <amount>          Refuse the run if CSV total exceeds this cap
  --direct                      EVM: sign transfers with GLOAM_PAY_KEY instead of the Gloam relay
  --funding-note <gloam1...>    EVM: spend an existing private note package instead of shielding a new deposit
  --no-add                      Solana: spend existing private balance only; refuse to top up from main wallet
  --offline                     Skip on-chain @name lookup during "plan"
  --allow-partial               Allow "prove" on an incomplete EVM run (proves only paid rows)
  --state <file>                Path for crash-safe run ledger (default: runs/<id>.run.json)
  -o, --out <file>              Path for payout CSV export (or proof output for "prove")
  --days <n>                    Proof validity window in days for "prove" (default: 30)
  --snark                       Verify Groth16 pairing proofs in "verify-token"
  --json                        Emit machine-readable JSON output (plan, status, prove, verify-token, networks)
  --rpc <url>                   Override EVM RPC URL (or set GLOAM_RPC; archive RPC required on bnb-mainnet)
  --relay <url>                 Override EVM relay URL (or set GLOAM_RELAY_URL)
  --names-rpc <url>             Override Robinhood Chain mainnet RPC for @name resolution (or GLOAM_NAMES_RPC)
  --solana-url <url>            Override Gloam Solana API base URL (or GLOAM_SOLANA_URL)
  --account-index <n>           Solana derived private account index (default: 0)
  -v, --version                 Print CLI version
  -h, --help                    Show this help message
`);
}

function parseAccountIndex(raw?: string): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`Invalid --account-index "${raw}" (expected an integer >= 0).`);
  }
  return n;
}

async function cmdNetworks(values: ParsedCliArgs["values"]): Promise<void> {
  const evm = listEvmNetworks().map((net) => ({
    key: net.key,
    label: net.label,
    chainId: net.chainId,
    testnet: net.testnet,
    ceremony: net.ceremony,
    pool: net.pool,
    hasMemoBoard: payMemoBoardFor(net.chainId) !== null,
    assets: net.assets.map((a) => ({
      symbol: a.symbol,
      address: a.address,
      decimals: a.decimals,
      perDepositLimit:
        a.depositLimit && !isNoLimit(a.depositLimit.perDeposit)
          ? formatUnits(a.depositLimit.perDeposit, a.decimals)
          : "none",
    })),
    ...(net.key === "bnb-mainnet"
      ? { note: "Requires an archive RPC (--rpc / GLOAM_RPC) because public BNB RPCs prune old logs." }
      : {}),
  }));

  const solana = (["mainnet", "devnet"] as const).map((n) => ({
    key: n === "mainnet" ? "solana" : "solana-devnet",
    label: n === "mainnet" ? "Solana" : "Solana Devnet",
    testnet: n === "devnet",
    assets: SOLANA_ASSETS[n].map((a) => ({
      id: a.id,
      symbol: a.symbol,
      decimals: a.decimals,
      mint: a.mint ?? "native",
      ...(a.note ? { note: a.note } : {}),
    })),
    privacyNote: SOLANA_PRIVACY_NOTE,
  }));

  if (values.json) {
    console.log(JSON.stringify({ evm, solana }, null, 2));
    return;
  }

  console.log("EVM Mainnets (ShieldPool + gloamroll1 total proofs):");
  for (const n of evm.filter((x) => !x.testnet)) {
    const assets = n.assets.map((a) => a.symbol).join(", ");
    console.log(`  ${n.key.padEnd(20)} chain ${String(n.chainId).padEnd(6)} · ${assets}${n.hasMemoBoard ? "" : " (no memo board)"}`);
    if (n.note) console.log(`    Note: ${n.note}`);
  }

  console.log("\nSolana (Helius Privacy Rings; no gloamroll1 total proof):");
  for (const s of solana) {
    console.log(`  ${s.key.padEnd(20)} · ${s.assets.map((a) => a.symbol).join(", ")}`);
  }

  console.log("\nEVM Testnets:");
  for (const n of evm.filter((x) => x.testnet)) {
    console.log(`  ${n.key.padEnd(20)} chain ${String(n.chainId).padEnd(9)} (${n.ceremony} keys) · ${n.assets.map((a) => a.symbol).join(", ")}`);
  }
}

async function cmdPlan(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const csvPath = positional[0];
  if (!csvPath) throw new Error("Usage: plan <csv> [--network robinhood] [--asset USDG] [--max-total 5000]");

  const networkInput = values.network ?? process.env.GLOAM_NETWORK;
  const csvText = readFileSync(resolve(csvPath), "utf8");

  if (isSolanaNetworkKey(networkInput)) {
    const solNet = resolveSolanaNetwork(networkInput);
    const asset = resolveSolanaAsset(solNet, values.asset ?? process.env.GLOAM_ASSET);
    const maxTotalUnits = values["max-total"]
      ? parseAmountUnits(values["max-total"], asset.decimals) ?? undefined
      : undefined;
    if (values["max-total"] && maxTotalUnits === undefined) {
      throw new Error(`Invalid --max-total value "${values["max-total"]}".`);
    }

    const plan = planSolanaPayroll({
      csvText,
      networkKey: networkInput,
      assetInput: asset.symbol,
      maxTotalUnits,
    });

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            kind: "solana",
            network: plan.network,
            networkLabel: plan.networkLabel,
            assetSymbol: plan.assetSymbol,
            assetDecimals: plan.assetDecimals,
            ...(plan.assetNote ? { assetNote: plan.assetNote } : {}),
            validCount: plan.validRows.length,
            totalUnits: plan.totalUnits.toString(),
            totalFormatted: plan.totalFormatted,
            issues: plan.issues,
            fatalError: plan.fatalError,
            warnings: plan.validRows
              .filter((r) => r.warning)
              .map((r) => ({ line: r.line, message: r.warning })),
            privacyNote: plan.privacyNote,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Network:     ${plan.networkLabel} (solana${plan.network === "devnet" ? "-devnet" : ""})`);
      console.log(`Asset:       ${plan.assetSymbol} (${plan.assetDecimals} decimals)`);
      console.log(`Payees:      ${plan.validRows.length} valid Solana private address(es)`);
      console.log(`Run total:   ${plan.totalFormatted} ${plan.assetSymbol}`);
      console.log(`Privacy:     ${plan.privacyNote}`);
      if (plan.assetNote) {
        console.log(`Asset note:  ${plan.assetNote}`);
      }
      const warnings = plan.validRows.filter((r) => r.warning);
      if (warnings.length > 0) {
        console.log("\nNotes:");
        for (const r of warnings) console.log(`  Line ${r.line}: ${r.warning}`);
      }
      if (plan.issues.length > 0) {
        console.log("\nRow issues:");
        for (const issue of plan.issues) console.log(`  Line ${issue.line}: ${issue.message}`);
      }
      if (plan.fatalError) console.error(`\nBlocked: ${plan.fatalError}`);
    }

    if (plan.fatalError || plan.issues.length > 0) process.exitCode = 1;
    return;
  }

  const net = resolveNetwork(networkInput);
  const asset = resolveAsset(net, values.asset ?? process.env.GLOAM_ASSET);
  const maxTotalWei = values["max-total"]
    ? parseAmountUnits(values["max-total"], asset.decimals) ?? undefined
    : undefined;
  if (values["max-total"] && maxTotalWei === undefined) {
    throw new Error(`Invalid --max-total value "${values["max-total"]}".`);
  }

  const { plan } = await planPayrollWithNames({
    csvText,
    networkKey: net.key,
    assetInput: asset.symbol,
    maxTotalWei,
    offline: values.offline,
    namesRpcUrl: values["names-rpc"] ?? process.env.GLOAM_NAMES_RPC,
  });

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          kind: "evm",
          networkKey: plan.networkKey,
          networkLabel: plan.networkLabel,
          chainId: plan.chainId,
          ceremony: plan.ceremony,
          pool: plan.pool,
          assetSymbol: plan.assetSymbol,
          assetAddress: plan.assetAddress,
          assetDecimals: plan.assetDecimals,
          hasMemoBoard: plan.hasMemoBoard,
          validCount: plan.validRows.length,
          gloamCount: plan.gloamCount,
          nameCount: plan.nameCount,
          linkCount: plan.linkCount,
          unresolvedNameCount: plan.unresolvedNameCount,
          totalWei: plan.totalWei.toString(),
          totalFormatted: plan.totalFormatted,
          proofParts: plan.proofParts,
          perDepositLimitWei: plan.perDepositLimitWei?.toString() ?? null,
          exceedsSingleDepositLimit: plan.exceedsSingleDepositLimit,
          resolvedNames: plan.validRows
            .filter((r) => r.payName && r.recipient)
            .map((r) => ({ line: r.line, payName: `@${r.payName}`, recipient: r.recipient })),
          issues: plan.issues,
          fatalError: plan.fatalError,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Network:     ${plan.networkLabel} (${plan.networkKey}, chain ${plan.chainId}, ${plan.ceremony} keys)`);
    console.log(`Vault pool:  ${plan.pool}`);
    console.log(`Asset:       ${plan.assetSymbol} (${plan.assetAddress}, ${plan.assetDecimals} decimals)`);
    console.log(
      `Memo board:  ${plan.hasMemoBoard ? "live (gloamr1. payees auto-notified)" : "none (share sealed gloam2t tickets manually)"}`
    );
    const nameSuffix = plan.nameCount > 0 ? `, incl. ${plan.nameCount} @name` : "";
    console.log(`Payees:      ${plan.validRows.length} valid (${plan.gloamCount} Gloam tag${nameSuffix}, ${plan.linkCount} claim link)`);
    console.log(`Run total:   ${plan.totalFormatted} ${plan.assetSymbol}`);
    console.log(`Total proof: ${plan.proofParts.length} Groth16 part(s) [${plan.proofParts.join(" + ")}] (max 32 payments/part)`);

    if (plan.perDepositLimitWei !== null) {
      console.log(
        `Deposit cap: ${formatUnits(plan.perDepositLimitWei, plan.assetDecimals)} ${plan.assetSymbol} per single shield${plan.exceedsSingleDepositLimit ? " (EXCEEDED — split deposits or supply --funding-note)" : " (ok)"}`
      );
    }

    const resolvedRows = plan.validRows.filter((r) => r.payName);
    if (resolvedRows.length > 0) {
      console.log("\nGloam @names:");
      for (const r of resolvedRows) {
        const target = r.recipient
          ? `${r.recipient.slice(0, 18)}…${r.recipient.slice(-6)}`
          : "(not looked up: --offline)";
        console.log(`  Line ${r.line}: @${r.payName} -> ${target}`);
      }
    }

    if (plan.issues.length > 0) {
      console.log("\nRow issues:");
      for (const issue of plan.issues) {
        console.log(`  Line ${issue.line}: ${issue.message}`);
      }
    }
    if (plan.fatalError) {
      console.error(`\nBlocked: ${plan.fatalError}`);
    }
  }

  if (plan.fatalError || plan.issues.length > 0) {
    process.exitCode = 1;
  }
}

async function cmdRun(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const csvPath = positional[0];
  if (!csvPath) throw new Error("Usage: run <csv> [--network robinhood] [--asset USDG] [--direct]");

  const networkInput = values.network ?? process.env.GLOAM_NETWORK;
  const csvText = readFileSync(resolve(csvPath), "utf8");
  const id = `payroll-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`;
  const statePath = resolve(values.state ?? `runs/${id}.run.json`);
  const outPath = resolve(values.out ?? `runs/${id}.payouts.csv`);

  if (isSolanaNetworkKey(networkInput)) {
    const solNet = resolveSolanaNetwork(networkInput);
    const asset = resolveSolanaAsset(solNet, values.asset ?? process.env.GLOAM_ASSET);
    const maxTotalUnits = values["max-total"]
      ? parseAmountUnits(values["max-total"], asset.decimals) ?? undefined
      : undefined;
    if (values["max-total"] && maxTotalUnits === undefined) {
      throw new Error(`Invalid --max-total value "${values["max-total"]}".`);
    }

    const plan = planSolanaPayroll({
      csvText,
      networkKey: networkInput,
      assetInput: asset.symbol,
      maxTotalUnits,
    });
    if (plan.fatalError) throw new Error(plan.fatalError);
    if (plan.issues.length > 0) {
      throw new Error(
        `Fix ${plan.issues.length} CSV issue(s) before running:\n` +
          plan.issues.map((i) => `  Line ${i.line}: ${i.message}`).join("\n")
      );
    }

    const secretKeyInput = readSolanaSecretInput(process.env.GLOAM_SOLANA_KEY);
    const state = createInitialSolanaRunState({
      id,
      network: solNet,
      asset,
      mainAddress: "",
      privateAddress: "",
      rows: plan.validRows,
    });
    saveRunState(statePath, state);

    await executeSolanaPayrollRun({
      state,
      stateFilePath: statePath,
      secretKeyInput,
      baseUrl: values["solana-url"] ?? process.env.GLOAM_SOLANA_URL,
      accountIndex: parseAccountIndex(values["account-index"]),
      noAdd: values["no-add"],
    });

    writeFileSync(outPath, buildSolanaPayoutExport(state), { mode: 0o600 });
    console.log(`\nSolana run finished (${state.status}).`);
    console.log(`State ledger:    ${statePath}`);
    console.log(`Payouts export:  ${outPath}`);
    return;
  }

  const net = resolveNetwork(networkInput);
  const asset = resolveAsset(net, values.asset ?? process.env.GLOAM_ASSET);
  const maxTotalWei = values["max-total"]
    ? parseAmountUnits(values["max-total"], asset.decimals) ?? undefined
    : undefined;
  if (values["max-total"] && maxTotalWei === undefined) {
    throw new Error(`Invalid --max-total value "${values["max-total"]}".`);
  }

  const { plan } = await planPayrollWithNames({
    csvText,
    networkKey: net.key,
    assetInput: asset.symbol,
    maxTotalWei,
    offline: false,
    namesRpcUrl: values["names-rpc"] ?? process.env.GLOAM_NAMES_RPC,
  });

  if (plan.fatalError) throw new Error(plan.fatalError);
  if (plan.issues.length > 0) {
    throw new Error(
      `Fix ${plan.issues.length} CSV issue(s) before running:\n` +
        plan.issues.map((i) => `  Line ${i.line}: ${i.message}`).join("\n")
    );
  }

  let activeNote: StoredNote | null = null;
  const fundingNoteCode = values["funding-note"];
  if (fundingNoteCode) {
    const pack = decodeNotePackage(fundingNoteCode);
    const exp = await notePackageToExport(pack);
    if (exp.pool.toLowerCase() !== net.pool.toLowerCase()) {
      throw new Error(`Funding note pool (${exp.pool}) does not match ${net.key} vault (${net.pool}).`);
    }
    if (exp.asset.toLowerCase() !== asset.address.toLowerCase()) {
      throw new Error(`Funding note asset (${exp.asset}) does not match ${asset.symbol} (${asset.address}).`);
    }
    const fundingAmountWei = BigInt(exp.amountWei);
    if (fundingAmountWei < plan.totalWei) {
      throw new Error(
        `Funding note holds ${formatUnits(fundingAmountWei, asset.decimals)} ${asset.symbol}, which is less than the run total (${plan.totalFormatted} ${asset.symbol}).`
      );
    }
    activeNote = {
      secret: exp.secret,
      commitment: exp.commitment,
      amountWei: fundingAmountWei.toString(),
      asset: exp.asset,
    };
  }

  const relay = !values.direct;
  const state = createInitialRunState({
    id,
    net,
    asset,
    rows: plan.validRows,
    relay,
    activeNote,
  });
  saveRunState(statePath, state);

  const privateKey = process.env.GLOAM_PAY_KEY?.trim() as Hex | undefined;
  await executePayrollRun({
    state,
    stateFilePath: statePath,
    privateKey,
    rpcUrl: values.rpc ?? process.env.GLOAM_RPC,
    relayUrl: values.relay ?? process.env.GLOAM_RELAY_URL,
  });

  writeFileSync(outPath, buildPayoutExport(state), { mode: 0o600 });
  console.log(`\nRun finished (${state.status}).`);
  console.log(`State ledger (keep private): ${statePath}`);
  console.log(`Payouts export:              ${outPath}`);
}

async function cmdResume(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const stateFile = positional[0];
  if (!stateFile) throw new Error("Usage: resume <run.json>");
  const statePath = resolve(stateFile);
  const state = loadAnyRunState(statePath);
  const outPath = resolve(values.out ?? statePath.replace(/\.run\.json$/, ".payouts.csv"));

  if (isSolanaRunState(state)) {
    const secretKeyInput = readSolanaSecretInput(process.env.GLOAM_SOLANA_KEY);
    await executeSolanaPayrollRun({
      state,
      stateFilePath: statePath,
      secretKeyInput,
      baseUrl: values["solana-url"] ?? process.env.GLOAM_SOLANA_URL,
      accountIndex: parseAccountIndex(values["account-index"]),
      noAdd: values["no-add"],
    });
    writeFileSync(outPath, buildSolanaPayoutExport(state), { mode: 0o600 });
    console.log(`\nSolana resume finished (${state.status}). Updated export: ${outPath}`);
    return;
  }

  const privateKey = process.env.GLOAM_PAY_KEY?.trim() as Hex | undefined;
  await executePayrollRun({
    state,
    stateFilePath: statePath,
    privateKey,
    rpcUrl: values.rpc ?? process.env.GLOAM_RPC,
    relayUrl: values.relay ?? process.env.GLOAM_RELAY_URL,
  });

  writeFileSync(outPath, buildPayoutExport(state), { mode: 0o600 });
  console.log(`\nResume finished (${state.status}). Updated export: ${outPath}`);
}

async function cmdStatus(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const stateFile = positional[0];
  if (!stateFile) throw new Error("Usage: status <run.json> [--json]");
  const state = loadAnyRunState(resolve(stateFile));

  if (isSolanaRunState(state)) {
    const counts = { paid: 0, queued: 0, unconfirmed: 0, failed: 0 };
    let paidUnits = 0n;
    let totalUnits = 0n;
    for (const r of state.rows) {
      counts[r.status]++;
      const amt = BigInt(r.amountUnits);
      totalUnits += amt;
      if (r.status === "paid") paidUnits += amt;
    }
    const summary = {
      kind: "solana" as const,
      id: state.id,
      status: state.status,
      network: state.network,
      assetSymbol: state.assetSymbol,
      privateAddress: state.privateAddress,
      counts,
      paidFormatted: formatUnits(paidUnits, state.assetDecimals),
      totalFormatted: formatUnits(totalUnits, state.assetDecimals),
      rows: state.rows.map((r) => ({
        index: r.index + 1,
        name: r.name,
        address: r.address,
        amount: formatUnits(BigInt(r.amountUnits), state.assetDecimals),
        status: r.status,
        signature: r.signature ?? null,
        error: r.error ?? null,
      })),
    };
    if (values.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`Run:      ${summary.id} (${summary.status})`);
    console.log(`Network:  Solana (${summary.network}) · Private account: ${summary.privateAddress || "(not opened yet)"}`);
    console.log(`Progress: ${counts.paid}/${state.rows.length} paid · ${summary.paidFormatted} / ${summary.totalFormatted} ${summary.assetSymbol}`);
    console.log(`Counts:   paid=${counts.paid} queued=${counts.queued} unconfirmed=${counts.unconfirmed} failed=${counts.failed}`);
    for (const r of summary.rows) {
      console.log(`  #${r.index} ${r.name} · ${r.amount} ${summary.assetSymbol} · ${r.status}${r.signature ? ` (${r.signature})` : ""}${r.error ? ` — ${r.error}` : ""}`);
    }
    return;
  }

  const counts = { paid: 0, queued: 0, unconfirmed: 0, failed: 0 };
  let paidWei = 0n;
  let totalWei = 0n;
  let unpostedMemos = 0;
  for (const r of state.rows) {
    counts[r.status]++;
    const amt = BigInt(r.amountWei);
    totalWei += amt;
    if (r.status === "paid") {
      paidWei += amt;
      if (r.kind === "gloam" && !r.memoPosted) unpostedMemos++;
    }
  }

  const summary = {
    kind: "evm" as const,
    id: state.id,
    status: state.status,
    networkKey: state.networkKey,
    chainId: state.chainId,
    pool: state.pool,
    assetSymbol: state.assetSymbol,
    relay: state.relay,
    counts,
    unpostedMemos,
    paidFormatted: formatUnits(paidWei, state.assetDecimals),
    totalFormatted: formatUnits(totalWei, state.assetDecimals),
    hasActiveNote: state.activeNote !== null,
    activeNoteRemaining: state.activeNote ? formatUnits(BigInt(state.activeNote.amountWei), state.assetDecimals) : "0",
    rows: state.rows.map((r) => ({
      index: r.index + 1,
      name: r.name,
      payName: r.payName ? `@${r.payName}` : null,
      kind: r.kind,
      amount: formatUnits(BigInt(r.amountWei), state.assetDecimals),
      status: r.status,
      memoPosted: r.kind === "gloam" ? Boolean(r.memoPosted) : null,
      txHash: r.txHash ?? null,
      error: r.error ?? null,
    })),
  };

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Run:      ${summary.id} (${summary.status})`);
  console.log(`Network:  ${summary.networkKey} (chain ${summary.chainId}) · ${summary.relay ? "Gloam relay" : "direct wallet"}`);
  console.log(`Progress: ${counts.paid}/${state.rows.length} paid · ${summary.paidFormatted} / ${summary.totalFormatted} ${summary.assetSymbol}`);
  console.log(`Counts:   paid=${counts.paid} queued=${counts.queued} unconfirmed=${counts.unconfirmed} failed=${counts.failed}${unpostedMemos > 0 ? ` unposted_memos=${unpostedMemos}` : ""}`);
  if (summary.hasActiveNote) {
    console.log(`Change:   ${summary.activeNoteRemaining} ${summary.assetSymbol} remaining in active note`);
  }
  for (const r of summary.rows) {
    const via = r.payName ?? r.kind;
    console.log(`  #${r.index} ${r.name} (${via}) · ${r.amount} ${summary.assetSymbol} · ${r.status}${r.txHash ? ` (${r.txHash})` : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
}

async function cmdProve(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const stateFile = positional[0];
  const verifier = values.for;
  if (!stateFile || !verifier) {
    throw new Error('Usage: prove <run.json> --for "Auditor Name" [--days 30] [--out proof.txt]');
  }
  const days = Number(values.days ?? "30");
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number.");

  const anyState = loadAnyRunState(resolve(stateFile));
  if (isSolanaRunState(anyState)) {
    throw new Error(
      "gloamroll1 payroll total proofs are only available for EVM ShieldPool runs (Solana Privacy Rings uses Helius proofs and does not emit gloamroll1 bundles)."
    );
  }
  const state = loadRunState(resolve(stateFile));
  const { inputs, skipped } = extractPaidProofInputs(state);
  if (skipped > 0 && !values["allow-partial"]) {
    throw new Error(
      `Run has ${skipped} unpaid row(s) (status: ${state.status}). Finish the run with "resume" first, or pass --allow-partial to prove only the ${inputs.length} paid row(s).`
    );
  }
  if (skipped > 0 && !values.json) {
    console.log(`Note: --allow-partial set; ${skipped} unpaid row(s) excluded from payroll total proof.`);
  }

  if (!values.json) {
    console.log(`Resolving payroll_total circuit artifacts for chain ${state.chainId}...`);
  }
  const artifacts = await resolveCircuitArtifacts("payroll_total", state.chainId);
  const prover = createSnarkPayrollProver(artifacts.wasm, artifacts.zkey);

  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const { bundle, token } = await generatePayrollProofBundle({
    chainId: state.chainId,
    pool: state.pool,
    asset: state.asset,
    payments: inputs,
    verifier,
    expiresAt,
    prover,
    onPart: values.json ? undefined : (done, total) => console.log(`Proved part ${done}/${total}`),
  });

  if (values.out) {
    writeFileSync(resolve(values.out), token + "\n");
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          verifier: bundle.verifier,
          chainId: bundle.chainId,
          pool: bundle.pool,
          asset: bundle.asset,
          count: bundle.count,
          parts: bundle.parts.length,
          total: bundle.total,
          expiresAt: bundle.expiresAt,
          ...(values.out ? { outFile: resolve(values.out) } : {}),
          token,
        },
        null,
        2
      )
    );
  } else if (values.out) {
    console.log(`Wrote gloamroll1 proof token (${bundle.count} payments, ${bundle.parts.length} part(s)) to ${resolve(values.out)}`);
  } else {
    console.log(`\nPaste into https://www.gloam.trade/verify:\n`);
    console.log(token);
  }
}

async function cmdVerifyToken(positional: string[], values: ParsedCliArgs["values"]): Promise<void> {
  const input = positional[0];
  if (!input) throw new Error("Usage: verify-token <gloamroll1:...|file> [--snark] [--json]");

  const token = input.startsWith("gloamroll1:") ? input : readFileSync(resolve(input), "utf8");
  const bundle = decodePayrollProofToken(token);
  const vkey = values.snark ? await loadPayrollVkey(bundle.chainId) : undefined;
  const result = await verifyPayrollProofBundleOffline(bundle, { vkey });

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          expired: result.expired,
          snarkVerified: values.snark,
          verifier: bundle.verifier,
          chainId: bundle.chainId,
          pool: bundle.pool,
          asset: bundle.asset,
          count: bundle.count,
          partCount: result.partCount,
          total: bundle.total,
          expiresAt: bundle.expiresAt,
          errors: result.errors,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Verifier: ${bundle.verifier}`);
    console.log(`Chain:    ${bundle.chainId} · Pool: ${bundle.pool}`);
    console.log(`Asset:    ${bundle.asset}`);
    console.log(`Payments: ${bundle.count} across ${result.partCount} part(s) · Total (base units): ${bundle.total}`);
    console.log(`Expires:  ${new Date(bundle.expiresAt * 1000).toISOString()} (${result.expired ? "EXPIRED" : "valid"})`);
    console.log(
      `Checks:   ${result.ok ? "PASS" : "FAIL"}${values.snark ? " (with Groth16 snark check)" : " (structural + Poseidon hash + context; pass --snark for Groth16)"}`
    );
    if (!result.ok) {
      for (const err of result.errors) console.error(`  - ${err}`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function cmdNewReceiveKey(): Promise<void> {
  const key = await generateReceiveKey();
  console.log(JSON.stringify(key, null, 2));
}

async function main(): Promise<void> {
  const { cmd, positional, values } = parseCliArgs(process.argv.slice(2));
  switch (cmd) {
    case "version":
      console.log(`gloam-payroll-cli v${CLI_VERSION}`);
      break;
    case "networks":
      await cmdNetworks(values);
      break;
    case "plan":
      await cmdPlan(positional, values);
      break;
    case "run":
      await cmdRun(positional, values);
      break;
    case "resume":
      await cmdResume(positional, values);
      break;
    case "status":
      await cmdStatus(positional, values);
      break;
    case "prove":
      await cmdProve(positional, values);
      break;
    case "verify-token":
      await cmdVerifyToken(positional, values);
      break;
    case "new-receive-key":
      await cmdNewReceiveKey();
      break;
    case "help":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command "${cmd}". Run with --help.`);
  }
}

async function shutdownSnarkWorkers(): Promise<void> {
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } };
  if (g.curve_bn128?.terminate) {
    await g.curve_bn128.terminate();
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main()
    .then(async () => {
      await shutdownSnarkWorkers();
      process.exit(process.exitCode ?? 0);
    })
    .catch(async (err) => {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await shutdownSnarkWorkers().catch(() => {});
      process.exit(1);
    });
}
