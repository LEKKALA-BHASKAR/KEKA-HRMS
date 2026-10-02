/**
 * Pure helpers for bulk import: reading a CSV, matching its headers to the
 * columns an import expects, and normalising the values people actually type
 * into spreadsheets (dates in three shapes, "Yes"/"y"/"1", amounts with
 * commas). No database: the import action resolves names to records.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  // Spreadsheets leave trailing blank lines; they are not rows.
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** "Date of Joining", "date_of_joining" and "DateOfJoining" all mean the same column. */
export function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ImportColumn {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  example: string;
}

export interface MappedRows {
  rows: Array<{ line: number; values: Record<string, string> }>;
  /** Headers in the file that match no column — usually a typo worth showing. */
  unknown: string[];
  /** Required columns the file does not have. */
  missing: string[];
}

/** Match a CSV's header row to the expected columns and key each data row by column. */
export function mapRows(table: string[][], columns: ImportColumn[]): MappedRows {
  const [header = [], ...data] = table;
  const byKey = new Map(columns.map((c) => [headerKey(c.key), c.key] as const));
  for (const c of columns) byKey.set(headerKey(c.label), c.key);
  const index = header.map((h) => byKey.get(headerKey(h)) ?? null);
  const present = new Set(index.filter((k): k is string => !!k));
  return {
    unknown: header.filter((_, i) => !index[i]).map((h) => h.trim()).filter(Boolean),
    missing: columns.filter((c) => c.required && !present.has(c.key)).map((c) => c.label),
    rows: data.map((cells, n) => {
      const values: Record<string, string> = {};
      index.forEach((k, i) => { if (k) values[k] = (cells[i] ?? "").trim(); });
      // Line numbers as a spreadsheet shows them: the header is line 1.
      return { line: n + 2, values };
    }),
  };
}

/**
 * A date as yyyy-mm-dd, from yyyy-mm-dd, dd-mm-yyyy, dd/mm/yyyy or
 * dd.mm.yyyy. Day-first is the Indian convention; an ambiguous month-first
 * date is not guessed. Null when it is not a real calendar date.
 */
export function normaliseDate(v: string): string | null {
  const s = v.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!match) return null;
    d = +match[1]; m = +match[2]; y = +match[3];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Yes/no as people type it. Null for anything else, so a typo is reported rather than read as "no". */
export function normaliseYesNo(v: string, fallback: boolean): boolean | null {
  const s = v.trim().toLowerCase();
  if (s === "") return fallback;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

/** "12,00,000" or "1200000.00" → "1200000"; null when it is not a number. */
export function normaliseAmount(v: string): string | null {
  const s = v.trim().replace(/[,₹\s]/g, "");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return String(Number(s));
}
