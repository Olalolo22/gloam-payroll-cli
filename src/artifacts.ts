import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  GLOAM_ARTIFACTS_URL,
  ceremonyForChainId,
  circuitArtifactFiles,
  type CeremonyKind,
  type GloamCircuit,
} from "@gloamtrade/sdk";

/**
 * `payroll_total` verification key hashes for optional local `--snark` verification.
 * Proving artifacts (`.wasm` and dev/final `.zkey`) are resolved directly from
 * `@gloamtrade/sdk` (`circuitArtifactFiles` / `CIRCUIT_SHA256`, added in `0.8.2`).
 */
export const PAYROLL_TOTAL_VKEYS: Record<CeremonyKind, { path: string; sha256: string }> = {
  dev: {
    path: "payroll_total_vkey.json",
    sha256: "52be3bb32335f3ec838cf02aa6eab2b30134d6df3f32ffbc5f39a49862b8d44a",
  },
  production: {
    path: "final/payroll_total_vkey.json",
    sha256: "83f3d0998ac773db5556491908480fbdb3decaefd0fd8d908973d31fe5fc7bc8",
  },
};

export interface ResolvedCircuitPaths {
  wasm: string;
  zkey: string;
  vkey?: string;
  ceremony: CeremonyKind;
}

export function defaultCircuitsCacheDir(): string {
  return process.env.GLOAM_CIRCUITS_CACHE?.trim() || join(homedir(), ".cache", "gloam", "circuits");
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function ensureVerifiedFile(
  cacheDir: string,
  relPath: string,
  expectedSha256: string,
  baseUrl: string = GLOAM_ARTIFACTS_URL
): Promise<string> {
  const dest = join(cacheDir, relPath);
  if (existsSync(dest)) {
    const existing = readFileSync(dest);
    const actual = sha256Hex(existing);
    if (actual === expectedSha256) return dest;
    throw new Error(
      `Cached circuit file ${dest} failed SHA-256 check (got ${actual}, expected ${expectedSha256}). Delete it and retry.`
    );
  }

  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download circuit artifact ${url} (HTTP ${res.status}).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `Downloaded circuit artifact ${url} failed SHA-256 verification (got ${actual}, expected ${expectedSha256}).`
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return dest;
}

/**
 * Resolve and SHA-256-verify local circuit files via `@gloamtrade/sdk`'s pinned
 * `circuitArtifactFiles` matching the target chain's ceremony (`dev` vs `production`).
 */
export async function resolveCircuitArtifacts(
  circuit: GloamCircuit,
  chainId: number,
  opts?: { cacheDir?: string; baseUrl?: string; includeVkey?: boolean }
): Promise<ResolvedCircuitPaths> {
  const ceremony = ceremonyForChainId(chainId);
  const cacheDir = opts?.cacheDir ?? defaultCircuitsCacheDir();
  const baseUrl = opts?.baseUrl ?? GLOAM_ARTIFACTS_URL;

  const spec = circuitArtifactFiles(circuit, ceremony);
  const [wasm, zkey] = await Promise.all([
    ensureVerifiedFile(cacheDir, spec.wasm, spec.sha256.wasm, baseUrl),
    ensureVerifiedFile(cacheDir, spec.zkey, spec.sha256.zkey, baseUrl),
  ]);

  let vkey: string | undefined;
  if (opts?.includeVkey && circuit === "payroll_total") {
    const vkeySpec = PAYROLL_TOTAL_VKEYS[ceremony];
    vkey = await ensureVerifiedFile(cacheDir, vkeySpec.path, vkeySpec.sha256, baseUrl);
  }

  return { wasm, zkey, vkey, ceremony };
}

/** Load and parse a SHA-256-verified `payroll_total` verification key JSON. */
export async function loadPayrollVkey(
  chainId: number,
  opts?: { cacheDir?: string; baseUrl?: string }
): Promise<unknown> {
  const ceremony = ceremonyForChainId(chainId);
  const cacheDir = opts?.cacheDir ?? defaultCircuitsCacheDir();
  const baseUrl = opts?.baseUrl ?? GLOAM_ARTIFACTS_URL;
  const spec = PAYROLL_TOTAL_VKEYS[ceremony];
  const file = await ensureVerifiedFile(cacheDir, spec.path, spec.sha256, baseUrl);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}
