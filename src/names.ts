import { getGloamNetwork, gloamReadTransport, isReceiveTag } from "@gloamtrade/sdk";
import { createPublicClient, getAddress, http, isAddress, zeroAddress, type Address, type Hex } from "viem";

/** GloamNames registry on Robinhood Chain mainnet (chain 4663, block 119798738). */
export const GLOAM_NAMES_ADDRESS: Address = "0x62c435CE6886fa91e3b0e91500c6dC9219723457";
export const GLOAM_NAMES_CHAIN_ID = 4663;

export const GLOAM_NAMES_ABI = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "view",
    inputs: [{ name: "name", type: "string" }],
    outputs: [
      { name: "holder", type: "address" },
      { name: "keyX", type: "bytes32" },
      { name: "keyY", type: "bytes32" },
      { name: "expires", type: "uint64" },
    ],
  },
] as const;

/** DER header of an uncompressed P-256 public key in SPKI form (id-ecPublicKey, prime256v1). */
const P256_SPKI_HEAD = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
] as const;

const NAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Reserved / impersonation-risk names refused by official Gloam (`app/src/lib/gloamNames.ts`),
 * so paying `@support` or `@gloam` in a payroll CSV can never reach an impersonator.
 */
const BLOCKED_NAMES = new Set([
  "glim", "glimbot",
  "support", "help", "helpdesk", "team", "admin", "administrator", "official", "security",
  "mod", "mods", "moderator", "staff", "dev", "devs", "developer", "developers",
  "founder", "cofounder", "ceo", "cto", "treasury", "owner", "root", "system",
  "airdrop", "airdrops", "claim", "claims", "reward", "rewards", "refund", "refunds", "giveaway",
  "verify", "verified", "verification", "wallet", "recovery", "service",
  "customercare", "customerservice", "info", "contact",
  "robinhood", "tempo", "base", "ethereum", "eth", "bnb", "binance", "coinbase",
  "metamask", "okx", "relay", "safe", "elysium", "kinetiq",
  "usdg", "usdc", "usdt", "tether", "circle", "helpcenter", "helpcentre",
]);

const BLOCKED_INSIDE = [
  "support", "official", "moderator", "helpdesk", "airdrop", "refund", "giveaway",
  "security", "recovery", "treasury", "verify", "verification", "customercare",
];

const BLOCKED_EDGES = [
  "admin", "robinhood", "binance", "coinbase", "metamask", "okx", "kinetiq", "elysium", "tether",
];

const BLOCKED_PARTS = new Set([
  ...BLOCKED_EDGES, "support", "help", "helpdesk", "official", "mod", "mods", "moderator", "staff",
  "security", "verify", "verified", "refund", "airdrop", "recovery", "treasury",
]);

const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");
const BLOCKED_COLLAPSED = new Set([...BLOCKED_NAMES].filter((w) => w.length >= 5).map(collapse));
const BLOCKED_INSIDE_COLLAPSED = BLOCKED_INSIDE.map(collapse);

const LOOKALIKE: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

/** True for 3–20 lowercase ASCII letters, digits, or underscores. */
export function isValidGloamName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Parse `@ada` / `@Ada` into `"ada"`, or null for anything else. */
export function nameFromPayInput(input: string): string | null {
  const text = input.trim();
  if (!text.startsWith("@")) return null;
  const name = text.slice(1).toLowerCase();
  return isValidGloamName(name) ? name : null;
}

/** True for impersonation-risk names refused by official Gloam. */
export function isBlockedGloamName(name: string): boolean {
  const parts = name.toLowerCase().split("_").filter(Boolean);
  if (
    parts.length > 1 &&
    parts.some((p) => BLOCKED_PARTS.has(p.replace(/\d/g, (d) => LOOKALIKE[d] ?? d)))
  ) {
    return true;
  }
  const plain = name.toLowerCase().replace(/_/g, "");
  const digits = [
    plain,
    plain.replace(/\d+$/, ""),
    plain.replace(/\d/g, (d) => LOOKALIKE[d] ?? d),
    plain.replace(/\d/g, (d) => (d === "1" ? "i" : (LOOKALIKE[d] ?? d))),
  ];
  const forms = digits.flatMap((f) => {
    const letters = f.replace(/rn/g, "m").replace(/vv/g, "w");
    return [f, letters, letters.replace(/l/g, "i")];
  });
  return forms.some((f) => {
    const c = collapse(f);
    return (
      c.includes("gloam") ||
      BLOCKED_NAMES.has(f) ||
      BLOCKED_COLLAPSED.has(c) ||
      BLOCKED_INSIDE_COLLAPSED.some((w) => c.includes(w)) ||
      BLOCKED_EDGES.some((w) => f.startsWith(w) || f.endsWith(w))
    );
  });
}

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Reconstruct a `gloamr1.` receive tag from the uncompressed P-256 point `(keyX, keyY)`
 * stored in `GloamNames`, verified on-curve via `@gloamtrade/sdk`'s `isReceiveTag`.
 */
export function receiveTagFromPoint(x: string, y: string): string | null {
  const word = /^0x[0-9a-fA-F]{64}$/;
  if (!word.test(x) || !word.test(y)) return null;
  const bytes = new Uint8Array(P256_SPKI_HEAD.length + 64);
  bytes.set(P256_SPKI_HEAD);
  for (let i = 0; i < 32; i++) {
    bytes[P256_SPKI_HEAD.length + i] = parseInt(x.slice(2 + i * 2, 4 + i * 2), 16);
    bytes[P256_SPKI_HEAD.length + 32 + i] = parseInt(y.slice(2 + i * 2, 4 + i * 2), 16);
  }
  const tag = "gloamr1." + b64urlEncode(bytes);
  return isReceiveTag(tag) ? tag : null;
}

export interface GloamNameRecord {
  name: string;
  tag: string;
  holder: Address;
  expires: number;
}

export type NameLookupAnswer = GloamNameRecord | "none" | "failed";

export type NameReader = (name: string) => Promise<readonly [Address, Hex, Hex, bigint]>;

/** Look up one Gloam name via a `GloamNames.resolve` reader. Never throws. */
export async function lookupGloamName(name: string, read: NameReader): Promise<NameLookupAnswer> {
  const normalized = name.toLowerCase();
  if (!isValidGloamName(normalized) || isBlockedGloamName(normalized)) return "none";
  let raw: readonly [Address, Hex, Hex, bigint];
  try {
    raw = await read(normalized);
  } catch {
    return "failed";
  }
  const [holder, x, y, expires] = raw;
  if (!isAddress(holder) || holder === zeroAddress) return "none";
  const tag = receiveTagFromPoint(x, y);
  if (!tag) return "none";
  return { name: normalized, tag, holder: getAddress(holder), expires: Number(expires) };
}

/** Resolve a set of Gloam names against the live `GloamNames` registry on Robinhood Chain mainnet. */
export async function resolveGloamNames(
  names: readonly string[],
  opts?: { rpcUrl?: string; reader?: NameReader }
): Promise<Map<string, NameLookupAnswer>> {
  const unique = [...new Set(names.map((n) => n.toLowerCase()))];
  const answers = new Map<string, NameLookupAnswer>();
  if (unique.length === 0) return answers;

  let reader = opts?.reader;
  if (!reader) {
    const rhMainnet = getGloamNetwork("robinhood-mainnet");
    if (!rhMainnet) {
      for (const n of unique) answers.set(n, "failed");
      return answers;
    }
    const transport = opts?.rpcUrl ? http(opts.rpcUrl) : gloamReadTransport(rhMainnet);
    const client = createPublicClient({ chain: rhMainnet.chain, transport });
    reader = (name: string) =>
      client.readContract({
        address: GLOAM_NAMES_ADDRESS,
        abi: GLOAM_NAMES_ABI,
        functionName: "resolve",
        args: [name],
      });
  }

  const settled = await Promise.all(
    unique.map(async (name) => [name, await lookupGloamName(name, reader!)] as const)
  );
  for (const [name, answer] of settled) {
    answers.set(name, answer);
  }
  return answers;
}
