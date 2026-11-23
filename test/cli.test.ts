import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CLI_VERSION, parseCliArgs } from "../src/cli.js";
import { parsePayrollCsv } from "../src/csv.js";
import { createInitialRunState, resolveAsset, resolveNetwork } from "../src/runner.js";
import { createInitialSolanaRunState, planSolanaPayroll, resolveSolanaAsset } from "../src/solana.js";
import { saveRunState } from "../src/state.js";

const DIST_CLI = resolve("dist/cli.js");

function runDistCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [DIST_CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

test("parseCliArgs does not swallow filenames after boolean flags and rejects unknown flags", () => {
  const directRun = parseCliArgs(["run", "--direct", "sample-payroll.csv", "--network", "base-mainnet"]);
  assert.equal(directRun.cmd, "run");
  assert.deepEqual(directRun.positional, ["sample-payroll.csv"]);
  assert.equal(directRun.values.direct, true);
  assert.equal(directRun.values.network, "base-mainnet");

  const snarkVerify = parseCliArgs(["verify-token", "--snark", "--json", "proof.txt"]);
  assert.equal(snarkVerify.cmd, "verify-token");
  assert.deepEqual(snarkVerify.positional, ["proof.txt"]);
  assert.equal(snarkVerify.values.snark, true);
  assert.equal(snarkVerify.values.json, true);

  const versionArgs = parseCliArgs(["--version"]);
  assert.equal(versionArgs.cmd, "version");

  assert.throws(() => parseCliArgs(["plan", "--netwrok", "base-mainnet", "sample-payroll.csv"]));
});

test("compiled dist/cli.js handles --version, networks, plan, status (secret-free), and prove guards", () => {
  const ver = runDistCli(["--version"]);
  assert.equal(ver.exitCode, 0);
  assert.equal(ver.stdout.trim(), `gloam-payroll-cli v${CLI_VERSION}`);

  const nets = runDistCli(["networks", "--json"]);
  assert.equal(nets.exitCode, 0);
  const netsJson = JSON.parse(nets.stdout) as {
    evm: Array<{ key: string }>;
    solana: Array<{ key: string }>;
  };
  const evmKeys = netsJson.evm.map((n) => n.key);
  assert.ok(evmKeys.includes("robinhood-mainnet"));
  assert.ok(evmKeys.includes("base-mainnet"));
  assert.ok(evmKeys.includes("bnb-mainnet"));
  assert.ok(netsJson.solana.some((s) => s.key === "solana"));

  const planEvm = runDistCli(["plan", "sample-payroll.csv", "--json"]);
  assert.equal(planEvm.exitCode, 0);
  const planJson = JSON.parse(planEvm.stdout) as { kind: string; validCount: number };
  assert.equal(planJson.kind, "evm");
  assert.equal(planJson.validCount, 3);

  const dir = mkdtempSync(join(tmpdir(), "gloam-cli-test-"));
  try {
    // Solana plan via CLI.
    const solCsvPath = join(dir, "solana.csv");
    writeFileSync(
      solCsvPath,
      "name,address,amount\nAda,11111111111111111111111111111111,250\n"
    );
    const planSol = runDistCli(["plan", solCsvPath, "--network", "solana", "--asset", "USDC", "--json"]);
    assert.equal(planSol.exitCode, 0);
    const solJson = JSON.parse(planSol.stdout) as { kind: string; assetSymbol: string; validCount: number };
    assert.equal(solJson.kind, "solana");
    assert.equal(solJson.assetSymbol, "USDC");
    assert.equal(solJson.validCount, 1);

    // Status prints progress safely without leaking note secrets.
    const net = resolveNetwork("base-mainnet");
    const asset = resolveAsset(net, "USDC");
    const parsed = parsePayrollCsv("name,gloam_address,amount\nAda,,10\nBob,,20\n", asset.decimals);
    const secretSentinel = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const evmState = createInitialRunState({
      id: "status-test",
      net,
      asset,
      rows: parsed.rows,
      relay: true,
      activeNote: {
        secret: secretSentinel,
        commitment: "0x1111111111111111111111111111111111111111111111111111111111111111",
        amountWei: "30000000",
        asset: asset.address,
      },
    });
    evmState.rows[0]!.status = "paid";
    evmState.rows[0]!.paymentSecret = secretSentinel;
    evmState.rows[0]!.spendSecret = secretSentinel;
    evmState.rows[0]!.spendAmountWei = "30000000";
    evmState.status = "paused";

    const evmLedgerPath = join(dir, "evm.run.json");
    saveRunState(evmLedgerPath, evmState);

    const statusRes = runDistCli(["status", evmLedgerPath, "--json"]);
    assert.equal(statusRes.exitCode, 0);
    assert.equal(statusRes.stdout.includes(secretSentinel), false, "status output must never print note secrets");
    const statusJson = JSON.parse(statusRes.stdout) as { counts: { paid: number; queued: number } };
    assert.equal(statusJson.counts.paid, 1);
    assert.equal(statusJson.counts.queued, 1);

    // Prove refuses incomplete EVM runs without --allow-partial.
    const partialProve = runDistCli(["prove", evmLedgerPath, "--for", "Acme Audit"]);
    assert.equal(partialProve.exitCode, 1);
    assert.match(partialProve.stderr, /--allow-partial/);

    // Prove refuses Solana runs clearly.
    const solPlan = planSolanaPayroll({
      csvText: "name,address,amount\nAda,11111111111111111111111111111111,10\n",
      networkKey: "solana",
      assetInput: "USDC",
    });
    const solState = createInitialSolanaRunState({
      id: "sol-prove-test",
      network: "mainnet",
      asset: resolveSolanaAsset("mainnet", "USDC"),
      mainAddress: "11111111111111111111111111111111",
      privateAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      rows: solPlan.validRows,
    });
    const solLedgerPath = join(dir, "sol.run.json");
    saveRunState(solLedgerPath, solState);
    const solProve = runDistCli(["prove", solLedgerPath, "--for", "Acme Audit"]);
    assert.equal(solProve.exitCode, 1);
    assert.match(solProve.stderr, /EVM ShieldPool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
