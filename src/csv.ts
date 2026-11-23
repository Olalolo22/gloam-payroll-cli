import { cleanPaymentNote, isReceiveTag, isSolanaAddress } from "@gloamtrade/sdk";
import { parseUnits } from "viem";
import { isBlockedGloamName, nameFromPayInput, type NameLookupAnswer } from "./names.js";

export const PAYROLL_MAX_ROWS = 200;
const U64_MAX = (1n << 64n) - 1n;

export type PayeeKind = "gloam" | "link";

export interface ParsedPayrollRow {
  line: number;
  name: string;
  /** Gloam receive tag (`gloamr1....`), or empty string for a claim link or pending `@name`. */
  recipient: string;
  kind: PayeeKind;
  /** Normalized Gloam name without leading `@` (e.g. `"ada"` for `"@ada"`), when the CSV used a name. */
  payName?: string;
  amountInput: string;
  amountWei: bigint;
  note: string;
}

export interface CsvRowIssue {
  line: number;
  message: string;
}

export interface ParsePayrollCsvResult {
  rows: ParsedPayrollRow[];
  issues: CsvRowIssue[];
  totalWei: bigint;
  fatalError: string | null;
}

export interface ParsedSolanaPayrollRow {
  line: number;
  name: string;
  address: string;
  amountInput: string;
  amountUnits: bigint;
  warning?: string;
}

export interface ParseSolanaPayrollCsvResult {
  rows: ParsedSolanaPayrollRow[];
  issues: CsvRowIssue[];
  totalUnits: bigint;
  fatalError: string | null;
}

const DELIMITERS = ["\t", ";", ","] as const;
type Delimiter = (typeof DELIMITERS)[number];

const NAME_HEADERS = new Set(["name", "payee", "employee", "person", "contractor", "full name"]);
const RECIPIENT_HEADERS = new Set([
  "gloam_address",
  "gloam address",
  "gloam_name",
  "gloam name",
  "gloam",
  "address",
  "recipient",
  "to",
  "wallet",
]);
const SOLANA_ADDRESS_HEADERS = new Set([
  "address",
  "solana_address",
  "solana address",
  "private_address",
  "private address",
  "solana",
  "wallet",
  "recipient",
  "to",
]);
const AMOUNT_HEADERS = new Set([
  "amount",
  "pay",
  "salary",
  "usd",
  "usdc",
  "sol",
  "zec",
  "value",
  "total",
]);
const NOTE_HEADERS = new Set(["note", "notes", "memo", "reference", "ref", "description"]);

function detectDelimiter(line: string): Delimiter {
  const counts: Record<Delimiter, number> = { "\t": 0, ";": 0, ",": 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as Delimiter]++;
  }
  return DELIMITERS.reduce((best, d) => (counts[d] > counts[best] ? d : best), DELIMITERS[0]);
}

function splitCsvLine(line: string, delimiter: Delimiter): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let state: "open" | "quoted" | "closed" = "open";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (state === "quoted") {
      if (ch !== '"') {
        cur += ch;
      } else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        state = "closed";
      }
    } else if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
      state = "open";
    } else if (state === "closed") {
      if (ch.trim()) return null;
    } else if (ch === '"' && !cur.trim()) {
      cur = "";
      state = "quoted";
    } else {
      cur += ch;
    }
  }

  if (state === "quoted") return null;
  cells.push(cur.trim());
  return cells;
}

function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/\s+/g, " ").trim();
}

function findColumn(headers: string[], candidates: Set<string>): number {
  return headers.findIndex((h) => candidates.has(normalizeHeader(h)));
}

/**
 * Parse an amount string like `"1,250.50"` or `"0.0005"` into smallest units.
 * Rejects scientific notation, negative values, zero, ambiguous European commas (`1,25`),
 * and excess decimal precision.
 */
export function parseAmountUnits(raw: string, decimals: number): bigint | null {
  const trimmed = raw.trim().replace(/^\$/, "").replace(/\s+/g, "");
  if (!trimmed) return null;

  // Allow US thousands separators only in exact 3-digit groups (e.g. 1,250 or 12,345.67).
  const normalized = trimmed.includes(",")
    ? /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)
      ? trimmed.replace(/,/g, "")
      : null
    : /^\d+(\.\d+)?$/.test(trimmed)
      ? trimmed
      : null;

  if (!normalized) return null;

  const dot = normalized.indexOf(".");
  if (dot >= 0 && normalized.length - dot - 1 > decimals) {
    return null;
  }

  try {
    const value = parseUnits(normalized, decimals);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse an EVM Gloam payroll CSV/TSV/semicolon file (`name,gloam_address,amount[,note]`).
 * Supports `gloamr1.` addresses, Gloam `@names` (resolved before execution), and blank claim links.
 */
export function parsePayrollCsv(
  text: string,
  decimals: number,
  opts?: { maxTotalWei?: bigint }
): ParsePayrollCsvResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .filter((entry) => entry.line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], issues: [], totalWei: 0n, fatalError: "Payroll file is empty." };
  }

  const delimiter = detectDelimiter(lines[0]!.line);
  const firstCells = splitCsvLine(lines[0]!.line, delimiter);
  if (!firstCells) {
    return {
      rows: [],
      issues: [],
      totalWei: 0n,
      fatalError: "Line 1 has an unclosed quote or trailing characters after a closing quote.",
    };
  }

  const looksLikeHeader = firstCells.some((c) => {
    const h = normalizeHeader(c);
    return NAME_HEADERS.has(h) || RECIPIENT_HEADERS.has(h) || AMOUNT_HEADERS.has(h);
  });

  let cols = { name: 0, recipient: 1, amount: 2, note: 3 };
  let start = 0;

  if (looksLikeHeader) {
    const name = findColumn(firstCells, NAME_HEADERS);
    const recipient = findColumn(firstCells, RECIPIENT_HEADERS);
    const amount = findColumn(firstCells, AMOUNT_HEADERS);
    const note = findColumn(firstCells, NOTE_HEADERS);
    if (amount < 0) {
      return {
        rows: [],
        issues: [],
        totalWei: 0n,
        fatalError: "Add an amount column (e.g. name,gloam_address,amount,note).",
      };
    }
    cols = { name, recipient, amount, note };
    start = 1;
  } else if (firstCells.length === 2) {
    cols = { name: 0, recipient: -1, amount: 1, note: -1 };
  }

  const expectedWidth = looksLikeHeader
    ? firstCells.length
    : firstCells.length === 2
      ? 2
      : Math.min(Math.max(firstCells.length, 3), 4);

  const body = lines.slice(start).filter(({ line }) => {
    const cells = splitCsvLine(line, delimiter);
    return !cells || cells.some((c) => c.trim().length > 0);
  });

  if (body.length === 0) {
    return { rows: [], issues: [], totalWei: 0n, fatalError: "No payroll rows found after the header." };
  }

  if (body.length > PAYROLL_MAX_ROWS) {
    return {
      rows: [],
      issues: [],
      totalWei: 0n,
      fatalError: `Up to ${PAYROLL_MAX_ROWS} people per run (got ${body.length}). Split into smaller batches.`,
    };
  }

  const rows: ParsedPayrollRow[] = [];
  const issues: CsvRowIssue[] = [];
  let totalWei = 0n;

  for (const { line, lineNo } of body) {
    const cells = splitCsvLine(line, delimiter);
    if (!cells) {
      issues.push({ line: lineNo, message: "Unclosed quote or malformed CSV line." });
      continue;
    }
    if (cells.length > expectedWidth) {
      issues.push({
        line: lineNo,
        message: `Expected at most ${expectedWidth} columns, found ${cells.length} (quote amounts containing commas like "1,250").`,
      });
      continue;
    }

    const name =
      (cols.name >= 0 ? cells[cols.name] ?? "" : "").trim().slice(0, 60) || `Payee ${rows.length + 1}`;
    const rawRecipient = (cols.recipient >= 0 ? cells[cols.recipient] ?? "" : "").trim();
    const amountInput = (cols.amount >= 0 ? cells[cols.amount] ?? "" : "").trim();
    const rawNote = cols.note >= 0 ? cells[cols.note] ?? "" : "";

    let kind: PayeeKind = "link";
    let recipient = "";
    let payName: string | undefined;

    if (rawRecipient) {
      if (isReceiveTag(rawRecipient)) {
        kind = "gloam";
        recipient = rawRecipient;
      } else {
        const parsedName = nameFromPayInput(rawRecipient);
        if (parsedName) {
          if (isBlockedGloamName(parsedName)) {
            issues.push({
              line: lineNo,
              message: `@${parsedName} is a blocked/reserved Gloam name and cannot be paid.`,
            });
            continue;
          }
          kind = "gloam";
          payName = parsedName;
        } else if (rawRecipient.startsWith("@")) {
          issues.push({
            line: lineNo,
            message: `Invalid Gloam name "${rawRecipient}" for "${name}" (use @ followed by 3–20 letters, numbers, or underscores).`,
          });
          continue;
        } else if (/^0x[0-9a-fA-F]{40}$/.test(rawRecipient)) {
          issues.push({
            line: lineNo,
            message: `Public 0x wallet for "${name}" is refused on purpose: paying it would expose the amount on-chain. Use their Gloam address (gloamr1…), @name, or leave blank for a claim link.`,
          });
          continue;
        } else if (rawRecipient.startsWith("gloamr1.")) {
          issues.push({
            line: lineNo,
            message: `Gloam address for "${name}" is incomplete or mistyped. Copy it again from Receive.`,
          });
          continue;
        } else {
          issues.push({
            line: lineNo,
            message: `Not a Gloam address or @name for "${name}" (expected gloamr1…, @name, or blank for a claim link).`,
          });
          continue;
        }
      }
    }

    const amountWei = parseAmountUnits(amountInput, decimals);
    if (amountWei === null) {
      issues.push({
        line: lineNo,
        message: `Invalid amount "${amountInput}" for "${name}" (max ${decimals} decimals, must be > 0).`,
      });
      continue;
    }

    const note = cleanPaymentNote(rawNote);
    rows.push({
      line: lineNo,
      name,
      recipient,
      kind,
      ...(payName ? { payName } : {}),
      amountInput,
      amountWei,
      note,
    });
    totalWei += amountWei;
  }

  let fatalError: string | null = null;
  if (opts?.maxTotalWei !== undefined && totalWei > opts.maxTotalWei) {
    fatalError = `Run total (${totalWei.toString()} base units) exceeds configured --max-total cap (${opts.maxTotalWei.toString()}).`;
  }

  return { rows, issues, totalWei, fatalError };
}

/**
 * Apply resolved Gloam `@name` answers onto parsed EVM payroll rows.
 * Any row whose `@name` has no holder or failed lookup is moved to `issues`.
 */
export function applyResolvedPayrollNames(
  rows: readonly ParsedPayrollRow[],
  answers: ReadonlyMap<string, NameLookupAnswer>
): { rows: ParsedPayrollRow[]; issues: CsvRowIssue[]; totalWei: bigint } {
  const valid: ParsedPayrollRow[] = [];
  const issues: CsvRowIssue[] = [];
  let totalWei = 0n;

  for (const row of rows) {
    if (!row.payName) {
      valid.push(row);
      totalWei += row.amountWei;
      continue;
    }
    const answer = answers.get(row.payName);
    if (!answer || answer === "failed") {
      issues.push({
        line: row.line,
        message: `Couldn't look up @${row.payName} for "${row.name}" just now. Check connectivity or use their gloamr1… address.`,
      });
      continue;
    }
    if (answer === "none") {
      issues.push({
        line: row.line,
        message: `No one holds @${row.payName} (for "${row.name}"). Check the name or use their gloamr1… address.`,
      });
      continue;
    }
    if (!isReceiveTag(answer.tag)) {
      issues.push({
        line: row.line,
        message: `@${row.payName} does not point to a valid Gloam address.`,
      });
      continue;
    }
    valid.push({ ...row, recipient: answer.tag });
    totalWei += row.amountWei;
  }

  return { rows: valid, issues, totalWei };
}

/**
 * Parse a Solana private payroll CSV/TSV/semicolon file (`name,address,amount`).
 * Matches official Gloam (`app/src/lib/solanaRings/payroll.ts`): requires valid base58
 * Solana private addresses (no blank claim links, no 0x EVM addresses) and uint64 amounts.
 */
export function parseSolanaPayrollCsv(
  text: string,
  decimals: number,
  opts?: { maxTotalUnits?: bigint }
): ParseSolanaPayrollCsvResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .filter((entry) => entry.line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], issues: [], totalUnits: 0n, fatalError: "Payroll file is empty." };
  }

  const delimiter = detectDelimiter(lines[0]!.line);
  const firstCells = splitCsvLine(lines[0]!.line, delimiter);
  if (!firstCells) {
    return {
      rows: [],
      issues: [],
      totalUnits: 0n,
      fatalError: "Line 1 has an unclosed quote or trailing characters after a closing quote.",
    };
  }

  const looksLikeHeader = firstCells.some((c) => {
    const h = normalizeHeader(c);
    return NAME_HEADERS.has(h) || SOLANA_ADDRESS_HEADERS.has(h) || AMOUNT_HEADERS.has(h);
  });

  let cols = { name: 0, address: 1, amount: 2 };
  let start = 0;

  if (looksLikeHeader) {
    const address = findColumn(firstCells, SOLANA_ADDRESS_HEADERS);
    const amount = findColumn(firstCells, AMOUNT_HEADERS);
    if (address < 0 || amount < 0) {
      return {
        rows: [],
        issues: [],
        totalUnits: 0n,
        fatalError: "The header needs an address column and an amount column (name,address,amount).",
      };
    }
    cols = { name: findColumn(firstCells, NAME_HEADERS), address, amount };
    start = 1;
  } else if (firstCells.length === 2) {
    cols = { name: -1, address: 0, amount: 1 };
  }

  const expectedWidth = looksLikeHeader ? firstCells.length : firstCells.length === 2 ? 2 : 3;

  const body = lines.slice(start).filter(({ line }) => {
    const cells = splitCsvLine(line, delimiter);
    return !cells || cells.some((c) => c.trim().length > 0);
  });

  if (body.length === 0) {
    return { rows: [], issues: [], totalUnits: 0n, fatalError: "No payroll rows found after the header." };
  }

  if (body.length > PAYROLL_MAX_ROWS) {
    return {
      rows: [],
      issues: [],
      totalUnits: 0n,
      fatalError: `Up to ${PAYROLL_MAX_ROWS} people per run (got ${body.length}). Split into smaller batches.`,
    };
  }

  const seen = new Map<string, number>();
  const rows: ParsedSolanaPayrollRow[] = [];
  const issues: CsvRowIssue[] = [];
  let totalUnits = 0n;

  for (const { line, lineNo } of body) {
    const cells = splitCsvLine(line, delimiter);
    if (!cells) {
      issues.push({ line: lineNo, message: "Unclosed quote or malformed CSV line." });
      continue;
    }
    if (cells.length > expectedWidth) {
      issues.push({
        line: lineNo,
        message: `Expected at most ${expectedWidth} columns, found ${cells.length} (quote amounts containing commas like "1,250").`,
      });
      continue;
    }

    const name =
      (cols.name >= 0 ? cells[cols.name] ?? "" : "").trim().slice(0, 60) || `Payee ${rows.length + 1}`;
    const address = (cells[cols.address] ?? "").trim();
    const amountInput = (cells[cols.amount] ?? "").trim();

    if (!address) {
      issues.push({
        line: lineNo,
        message: `Missing Solana private address for "${name}" (Solana payroll requires a registered Gloam private account).`,
      });
      continue;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
      issues.push({
        line: lineNo,
        message: `EVM 0x address for "${name}" cannot be paid on Solana. Use their Gloam private address on Solana.`,
      });
      continue;
    }
    if (!isSolanaAddress(address)) {
      issues.push({
        line: lineNo,
        message: `Invalid Solana address "${address}" for "${name}".`,
      });
      continue;
    }

    const amountUnits = parseAmountUnits(amountInput, decimals);
    if (amountUnits === null || amountUnits > U64_MAX) {
      issues.push({
        line: lineNo,
        message: `Invalid amount "${amountInput}" for "${name}" (max ${decimals} decimals, must be > 0 and <= uint64 max).`,
      });
      continue;
    }

    const priorLine = seen.get(address);
    const warning =
      priorLine !== undefined ? `Same address as line ${priorLine}. Both lines are paid.` : undefined;
    if (priorLine === undefined) seen.set(address, lineNo);

    rows.push({
      line: lineNo,
      name,
      address,
      amountInput,
      amountUnits,
      ...(warning ? { warning } : {}),
    });
    totalUnits += amountUnits;
  }

  let fatalError: string | null = null;
  if (opts?.maxTotalUnits !== undefined && totalUnits > opts.maxTotalUnits) {
    fatalError = `Run total (${totalUnits.toString()} base units) exceeds configured --max-total cap (${opts.maxTotalUnits.toString()}).`;
  }

  return { rows, issues, totalUnits, fatalError };
}

/**
 * Escape a CSV cell and neutralize spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`)
 * with a leading apostrophe, matching official Gloam (`app/src/lib/payroll.ts`).
 */
export function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export interface PayoutExportRow {
  name: string;
  payName?: string;
  kind: PayeeKind;
  amount: string;
  note: string;
  status: string;
  delivery: string;
  txHash: string;
  memoTxHash: string;
}

/** Format a clean EVM payout CSV for distribution (claim links, sealed tickets, and tx hashes). */
export function formatPayoutCsv(rows: readonly PayoutExportRow[]): string {
  const includePayName = rows.some((r) => Boolean(r.payName));
  const header = includePayName
    ? "name,pay_name,kind,amount,note,status,delivery,tx_hash,memo_tx_hash"
    : "name,kind,amount,note,status,delivery,tx_hash,memo_tx_hash";
  const body = rows.map((r) => {
    const cells = includePayName
      ? [
          r.name,
          r.payName ? `@${r.payName}` : "",
          r.kind,
          r.amount,
          r.note,
          r.status,
          r.delivery,
          r.txHash,
          r.memoTxHash,
        ]
      : [r.name, r.kind, r.amount, r.note, r.status, r.delivery, r.txHash, r.memoTxHash];
    return cells.map(escapeCsvCell).join(",");
  });
  return [header, ...body].join("\n") + "\n";
}

export interface SolanaPayoutExportRow {
  name: string;
  address: string;
  amount: string;
  asset: string;
  status: string;
  signature: string;
  explorer: string;
}

/** Format a clean Solana payout CSV with formula-injection protection. */
export function formatSolanaPayoutCsv(rows: readonly SolanaPayoutExportRow[]): string {
  const header = "name,address,amount,asset,status,signature,explorer";
  const body = rows.map((r) =>
    [r.name, r.address, r.amount, r.asset, r.status, r.signature, r.explorer]
      .map(escapeCsvCell)
      .join(",")
  );
  return [header, ...body].join("\n") + "\n";
}
