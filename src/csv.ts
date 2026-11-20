import { cleanPaymentNote, isReceiveTag } from "@gloamtrade/sdk";
import { parseUnits } from "viem";

export const PAYROLL_MAX_ROWS = 200;

export type PayeeKind = "gloam" | "link";

export interface ParsedPayrollRow {
  line: number;
  name: string;
  /** Gloam receive tag (`gloamr1....`) or empty string for a short claim link. */
  recipient: string;
  kind: PayeeKind;
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

const DELIMITERS = ["\t", ";", ","] as const;
type Delimiter = (typeof DELIMITERS)[number];

const NAME_HEADERS = new Set(["name", "payee", "employee", "person", "contractor", "full name"]);
const RECIPIENT_HEADERS = new Set([
  "gloam_address",
  "gloam address",
  "gloam",
  "address",
  "recipient",
  "to",
  "wallet",
]);
const AMOUNT_HEADERS = new Set(["amount", "pay", "salary", "usd", "value", "total"]);
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
  const trimmed = raw.trim().replace(/^\$/, "");
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
 * Parse a Gloam payroll CSV/TSV/semicolon file (`name,gloam_address,amount[,note]`).
 * Matches the delimiter, column-shift, and header behavior of the Gloam web app.
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

    const name = (cols.name >= 0 ? cells[cols.name] ?? "" : "").trim() || `Payee ${rows.length + 1}`;
    const recipient = (cols.recipient >= 0 ? cells[cols.recipient] ?? "" : "").trim();
    const amountInput = (cols.amount >= 0 ? cells[cols.amount] ?? "" : "").trim();
    const rawNote = cols.note >= 0 ? cells[cols.note] ?? "" : "";

    const kind: PayeeKind = recipient ? "gloam" : "link";
    if (kind === "gloam" && !isReceiveTag(recipient)) {
      issues.push({
        line: lineNo,
        message: `Invalid Gloam receive tag for "${name}" (expected gloamr1... or leave blank for a claim link).`,
      });
      continue;
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
    rows.push({ line: lineNo, name, recipient, kind, amountInput, amountWei, note });
    totalWei += amountWei;
  }

  let fatalError: string | null = null;
  if (opts?.maxTotalWei !== undefined && totalWei > opts.maxTotalWei) {
    fatalError = `Run total (${totalWei.toString()} base units) exceeds configured --max-total cap (${opts.maxTotalWei.toString()}).`;
  }

  return { rows, issues, totalWei, fatalError };
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface PayoutExportRow {
  name: string;
  kind: PayeeKind;
  amount: string;
  note: string;
  status: string;
  delivery: string;
  txHash: string;
  memoTxHash: string;
}

/** Format a clean payout CSV for distribution (claim links, sealed tickets, and tx hashes). */
export function formatPayoutCsv(rows: readonly PayoutExportRow[]): string {
  const header = "name,kind,amount,note,status,delivery,tx_hash,memo_tx_hash";
  const body = rows.map((r) =>
    [r.name, r.kind, r.amount, r.note, r.status, r.delivery, r.txHash, r.memoTxHash]
      .map(escapeCsvCell)
      .join(",")
  );
  return [header, ...body].join("\n") + "\n";
}
