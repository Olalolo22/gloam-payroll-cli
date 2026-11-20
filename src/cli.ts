import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeNotePackage,
  generateReceiveKey,
  notePackageToExport,
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
  planPayroll,
  resolveAsset,
  resolveNetwork,
} from "./runner.js";
import { loadRunState, saveRunState, type StoredNote } from "./state.js";

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const cmd = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd, positional, flags };
}

function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function printHelp(): void {
  console.log(`gloam-payroll-cli — Headless private CSV payroll & gloamroll1 proof CLI on @gloamtrade/sdk

Commands:
  plan <csv> [options]          Validate CSV, check deposit limits, and print note-chain + proof plan (no key needed)
  run <csv> [options]           Execute private payroll on testnet or mainnet and write crash-safe state + payout CSV
  resume <run.json> [options]   Reconcile any unconfirmed row against the pool and finish remaining payments
  prove <run.json> --for <who>  Generate a gloamroll1:... payroll total proof for https://www.gloam.trade/verify
  verify-token <token|file>     Decode and offline-verify a gloamroll1:... proof (pass --snark to verify Groth16)
  new-receive-key               Generate a fresh gloamr1. receive tag + private JWK for testing

Common options:
  --network <key>               Default: GLOAM_NETWORK or "robinhood" (testnet). Mainnet: tempo-mainnet, robinhood-mainnet, base-mainnet, ethereum-mainnet, elysium-mainnet, bnb-mainnet
  --asset <symbol|0x...>        Pool asset symbol or address (defaults to network's first asset)
  --max-total <amount>          Refuse the run if CSV total exceeds this cap
  --direct                      Sign transfers with GLOAM_PAY_KEY instead of the Gloam relay
  --funding-note <gloam1...>    Spend an existing private note package instead of shielding a new deposit
  --state <file>                Path for crash-safe run ledger (default: runs/<id>.run.json)
  --out <file>                  Path for payout CSV export (default: runs/<id>.payouts.csv)
  --days <n>                    Proof validity window in days for "prove" (default: 30)
  --rpc <url>                   Override RPC URL (or set GLOAM_RPC)
  --relay <url>                 Override relay URL (or set GLOAM_RELAY_URL)
`);
}

async function cmdPlan(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const csvPath = positional[0];
  if (!csvPath) throw new Error("Usage: plan <csv> [--network robinhood] [--asset USDG] [--max-total 5000]");

  const net = resolveNetwork(strFlag(flags, "network") ?? process.env.GLOAM_NETWORK);
  const asset = resolveAsset(net, strFlag(flags, "asset") ?? process.env.GLOAM_ASSET);
  const maxTotalRaw = strFlag(flags, "max-total");
  const maxTotalWei = maxTotalRaw ? parseAmountUnits(maxTotalRaw, asset.decimals) ?? undefined : undefined;
  if (maxTotalRaw && maxTotalWei === undefined) {
    throw new Error(`Invalid --max-total value "${maxTotalRaw}".`);
  }

  const csvText = readFileSync(resolve(csvPath), "utf8");
  const plan = planPayroll({
    csvText,
    networkKey: net.key,
    assetInput: asset.symbol,
    maxTotalWei,
  });

  console.log(`Network:     ${plan.networkLabel} (${plan.networkKey}, chain ${plan.chainId}, ${plan.ceremony} keys)`);
  console.log(`Vault pool:  ${plan.pool}`);
  console.log(`Asset:       ${plan.assetSymbol} (${plan.assetAddress}, ${plan.assetDecimals} decimals)`);
  console.log(`Memo board:  ${plan.hasMemoBoard ? "live (gloamr1. payees auto-notified)" : "none (share sealed gloam2t tickets manually)"}`);
  console.log(`Payees:      ${plan.validRows.length} valid (${plan.gloamCount} Gloam tag, ${plan.linkCount} claim link)`);
  console.log(`Run total:   ${plan.totalFormatted} ${plan.assetSymbol}`);
  console.log(`Total proof: ${plan.proofParts.length} Groth16 part(s) [${plan.proofParts.join(" + ")}] (max 32 payments/part)`);

  if (plan.perDepositLimitWei !== null) {
    console.log(
      `Deposit cap: ${formatUnits(plan.perDepositLimitWei, plan.assetDecimals)} ${plan.assetSymbol} per single shield${plan.exceedsSingleDepositLimit ? " (EXCEEDED — split deposits or supply --funding-note)" : " (ok)"}`
    );
  }

  if (plan.issues.length > 0) {
    console.log("\nRow issues:");
    for (const issue of plan.issues) {
      console.log(`  Line ${issue.line}: ${issue.message}`);
    }
  }
  if (plan.fatalError) {
    console.error(`\nBlocked: ${plan.fatalError}`);
    process.exitCode = 1;
    return;
  }
  if (plan.issues.length > 0) {
    process.exitCode = 1;
  }
}

async function cmdRun(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const csvPath = positional[0];
  if (!csvPath) throw new Error("Usage: run <csv> [--network robinhood] [--asset USDG] [--direct]");

  const net = resolveNetwork(strFlag(flags, "network") ?? process.env.GLOAM_NETWORK);
  const asset = resolveAsset(net, strFlag(flags, "asset") ?? process.env.GLOAM_ASSET);
  const maxTotalRaw = strFlag(flags, "max-total");
  const maxTotalWei = maxTotalRaw ? parseAmountUnits(maxTotalRaw, asset.decimals) ?? undefined : undefined;
  if (maxTotalRaw && maxTotalWei === undefined) {
    throw new Error(`Invalid --max-total value "${maxTotalRaw}".`);
  }

  const csvText = readFileSync(resolve(csvPath), "utf8");
  const plan = planPayroll({
    csvText,
    networkKey: net.key,
    assetInput: asset.symbol,
    maxTotalWei,
  });

  if (plan.fatalError) throw new Error(plan.fatalError);
  if (plan.issues.length > 0) {
    throw new Error(
      `Fix ${plan.issues.length} CSV issue(s) before running:\n` +
        plan.issues.map((i) => `  Line ${i.line}: ${i.message}`).join("\n")
    );
  }

  let activeNote: StoredNote | null = null;
  const fundingNoteCode = strFlag(flags, "funding-note");
  if (fundingNoteCode) {
    const pack = decodeNotePackage(fundingNoteCode);
    const exp = await notePackageToExport(pack);
    if (exp.pool.toLowerCase() !== net.pool.toLowerCase()) {
      throw new Error(`Funding note pool (${exp.pool}) does not match ${net.key} vault (${net.pool}).`);
    }
    if (exp.asset.toLowerCase() !== asset.address.toLowerCase()) {
      throw new Error(`Funding note asset (${exp.asset}) does not match ${asset.symbol} (${asset.address}).`);
    }
    activeNote = {
      secret: exp.secret,
      commitment: exp.commitment,
      amountWei: exp.amountWei.toString(),
      asset: exp.asset,
    };
  }

  const id = `payroll-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`;
  const statePath = resolve(strFlag(flags, "state") ?? `runs/${id}.run.json`);
  const outPath = resolve(strFlag(flags, "out") ?? `runs/${id}.payouts.csv`);
  const relay = !Boolean(flags.direct);

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
    rpcUrl: strFlag(flags, "rpc") ?? process.env.GLOAM_RPC,
    relayUrl: strFlag(flags, "relay") ?? process.env.GLOAM_RELAY_URL,
  });

  writeFileSync(outPath, buildPayoutExport(state), { mode: 0o600 });
  console.log(`\nRun finished (${state.status}).`);
  console.log(`State ledger (keep private): ${statePath}`);
  console.log(`Payouts export:              ${outPath}`);
}

async function cmdResume(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const stateFile = positional[0];
  if (!stateFile) throw new Error("Usage: resume <run.json>");
  const statePath = resolve(stateFile);
  const state = loadRunState(statePath);

  const privateKey = process.env.GLOAM_PAY_KEY?.trim() as Hex | undefined;
  await executePayrollRun({
    state,
    stateFilePath: statePath,
    privateKey,
    rpcUrl: strFlag(flags, "rpc") ?? process.env.GLOAM_RPC,
    relayUrl: strFlag(flags, "relay") ?? process.env.GLOAM_RELAY_URL,
  });

  const outPath = resolve(strFlag(flags, "out") ?? statePath.replace(/\.run\.json$/, ".payouts.csv"));
  writeFileSync(outPath, buildPayoutExport(state), { mode: 0o600 });
  console.log(`\nResume finished (${state.status}). Updated export: ${outPath}`);
}

async function cmdProve(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const stateFile = positional[0];
  const verifier = strFlag(flags, "for");
  if (!stateFile || !verifier) {
    throw new Error('Usage: prove <run.json> --for "Auditor Name" [--days 30] [--out proof.txt]');
  }
  const days = Number(strFlag(flags, "days") ?? "30");
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number.");

  const state = loadRunState(resolve(stateFile));
  const { inputs, skipped } = extractPaidProofInputs(state);
  if (skipped > 0) {
    console.log(`Note: ${skipped} unpaid row(s) excluded from payroll total proof.`);
  }

  console.log(`Resolving payroll_total circuit artifacts for chain ${state.chainId}...`);
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
    onPart: (done, total) => console.log(`Proved part ${done}/${total}`),
  });

  const outFile = strFlag(flags, "out");
  if (outFile) {
    writeFileSync(resolve(outFile), token + "\n");
    console.log(`Wrote gloamroll1 proof token (${bundle.count} payments, ${bundle.parts.length} part(s)) to ${resolve(outFile)}`);
  } else {
    console.log(`\nPaste into https://www.gloam.trade/verify:\n`);
    console.log(token);
  }
}

async function cmdVerifyToken(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const input = positional[0];
  if (!input) throw new Error("Usage: verify-token <gloamroll1:...|file> [--snark]");

  const token = input.startsWith("gloamroll1:") ? input : readFileSync(resolve(input), "utf8");
  const bundle = decodePayrollProofToken(token);
  const vkey = flags.snark ? await loadPayrollVkey(bundle.chainId) : undefined;
  const result = await verifyPayrollProofBundleOffline(bundle, { vkey });

  console.log(`Verifier: ${bundle.verifier}`);
  console.log(`Chain:    ${bundle.chainId} · Pool: ${bundle.pool}`);
  console.log(`Asset:    ${bundle.asset}`);
  console.log(`Payments: ${bundle.count} across ${result.partCount} part(s) · Total (base units): ${bundle.total}`);
  console.log(`Expires:  ${new Date(bundle.expiresAt * 1000).toISOString()} (${result.expired ? "EXPIRED" : "valid"})`);
  console.log(`Checks:   ${result.ok ? "PASS" : "FAIL"}${flags.snark ? " (with Groth16 snark check)" : " (structural + Poseidon hash + context; pass --snark for Groth16)"}`);

  if (!result.ok) {
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
  }
}

async function cmdNewReceiveKey(): Promise<void> {
  const key = await generateReceiveKey();
  console.log(JSON.stringify(key, null, 2));
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "plan":
      await cmdPlan(positional, flags);
      break;
    case "run":
      await cmdRun(positional, flags);
      break;
    case "resume":
      await cmdResume(positional, flags);
      break;
    case "prove":
      await cmdProve(positional, flags);
      break;
    case "verify-token":
      await cmdVerifyToken(positional, flags);
      break;
    case "new-receive-key":
      await cmdNewReceiveKey();
      break;
    case "help":
    case "--help":
    case "-h":
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
