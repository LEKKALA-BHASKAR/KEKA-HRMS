/**
 * The custom report engine: a saved spec (columns, filters, grouping,
 * totals, sort) applied to rows a dataset has already loaded and scoped.
 * It is pure, so the same spec gives the same table on screen, in CSV and
 * in tests, and nothing a user types ever reaches a query.
 */

export type FieldType = "text" | "number" | "date" | "bool";
export type FieldFormat = "text" | "int" | "inr" | "pct" | "date" | "num";
export interface FieldDef { key: string; label: string; type: FieldType; format?: FieldFormat }

export const FILTER_OPS = {
  eq: "is", neq: "is not", contains: "contains", gt: "more than", gte: "at least", lt: "less than", lte: "at most", in: "is one of", empty: "is empty", notEmpty: "is not empty",
} as const;
export type FilterOp = keyof typeof FILTER_OPS;
export const AGG_FNS = { count: "Count", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum" } as const;
export type AggFn = keyof typeof AGG_FNS;

export interface ReportFilter { field: string; op: FilterOp; value?: string }
export interface ReportAggregate { field: string; fn: AggFn }
export interface ReportSpec {
  dataset: string;
  columns: string[];
  filters: ReportFilter[];
  groupBy?: string | null;
  aggregates: ReportAggregate[];
  sort?: { field: string; dir: "asc" | "desc" } | null;
  /** Date window the dataset loads, YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
}

export const MAX_REPORT_ROWS = 5000;
export const MAX_COLUMNS = 25;

export function validateSpec(spec: ReportSpec, fields: FieldDef[]): string[] {
  const known = new Map(fields.map((f) => [f.key, f]));
  const errors: string[] = [];
  if (!spec.groupBy && spec.columns.length === 0) errors.push("Choose at least one column.");
  if (spec.columns.length > MAX_COLUMNS) errors.push(`Choose at most ${MAX_COLUMNS} columns.`);
  for (const c of spec.columns) if (!known.has(c)) errors.push(`Unknown column ${c}.`);
  for (const f of spec.filters) {
    const def = known.get(f.field);
    if (!def) { errors.push(`Unknown filter field ${f.field}.`); continue; }
    if (!(f.op in FILTER_OPS)) errors.push(`Unknown filter on ${def.label}.`);
    if (!["empty", "notEmpty"].includes(f.op) && !(f.value ?? "").trim()) errors.push(`Give a value for the ${def.label} filter.`);
    if (["gt", "gte", "lt", "lte"].includes(f.op) && def.type === "number" && Number.isNaN(Number(f.value))) errors.push(`${def.label} needs a number.`);
    if (["gt", "gte", "lt", "lte"].includes(f.op) && def.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(f.value ?? "")) errors.push(`${def.label} needs a date as YYYY-MM-DD.`);
  }
  if (spec.groupBy && !known.has(spec.groupBy)) errors.push(`Unknown grouping ${spec.groupBy}.`);
  for (const a of spec.aggregates) {
    const def = known.get(a.field);
    if (!def) { errors.push(`Unknown total field ${a.field}.`); continue; }
    if (!(a.fn in AGG_FNS)) errors.push(`Unknown total on ${def.label}.`);
    if (["sum", "avg"].includes(a.fn) && def.type !== "number") errors.push(`${AGG_FNS[a.fn]} needs a number field; ${def.label} is not.`);
  }
  if (spec.sort && !known.has(spec.sort.field) && !spec.aggregates.some((a) => aggKey(a) === spec.sort!.field)) errors.push("Unknown sort field.");
  for (const d of [spec.from, spec.to]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push("Dates are YYYY-MM-DD.");
  return errors;
}

const aggKey = (a: ReportAggregate) => `${a.fn}_${a.field}`;
const asDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);

function cmpValue(v: unknown, type: FieldType): number | string | null {
  if (v === null || v === undefined || v === "") return null;
  if (type === "number") return Number(v);
  if (type === "date") return asDate(v);
  if (type === "bool") return v ? "yes" : "no";
  return String(v).toLowerCase();
}

function matches(row: Record<string, unknown>, f: ReportFilter, def: FieldDef): boolean {
  const v = cmpValue(row[f.field], def.type);
  if (f.op === "empty") return v === null;
  if (f.op === "notEmpty") return v !== null;
  if (v === null) return f.op === "neq";
  const raw = (f.value ?? "").trim();
  const target = def.type === "number" ? Number(raw) : def.type === "bool" ? (/^(y|yes|true|1)$/i.test(raw) ? "yes" : "no") : raw.toLowerCase();
  switch (f.op) {
    case "eq": return v === target;
    case "neq": return v !== target;
    case "contains": return String(v).includes(String(target));
    case "in": return raw.split(",").map((s) => (def.type === "number" ? Number(s.trim()) : s.trim().toLowerCase())).includes(v as never);
    case "gt": return v > target;
    case "gte": return v >= target;
    case "lt": return v < target;
    case "lte": return v <= target;
  }
  return false;
}

function aggregate(rows: Array<Record<string, unknown>>, a: ReportAggregate, type: FieldType): number | string | null {
  if (a.fn === "count") return rows.length;
  const vals = rows.map((r) => r[a.field]).filter((v) => v !== null && v !== undefined && v !== "");
  if (a.fn === "sum") return Math.round(vals.reduce((s: number, v) => s + Number(v), 0) * 100) / 100;
  if (a.fn === "avg") return vals.length ? Math.round((vals.reduce((s: number, v) => s + Number(v), 0) / vals.length) * 100) / 100 : null;
  const keyed = vals.map((v) => ({ v, k: cmpValue(v, type)! })).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
  const pick = a.fn === "min" ? keyed[0] : keyed[keyed.length - 1];
  if (!pick) return null;
  return type === "date" ? asDate(pick.v) : type === "number" ? Number(pick.v) : (pick.v as string);
}

export interface EngineResult {
  columns: Array<{ key: string; label: string; format?: FieldFormat }>;
  rows: Array<Record<string, unknown>>;
  totals: Record<string, unknown> | null;
  truncated: boolean;
  matched: number;
}

export function runSpec(input: Array<Record<string, unknown>>, spec: ReportSpec, fields: FieldDef[]): EngineResult {
  const def = new Map(fields.map((f) => [f.key, f]));
  const filtered = input.filter((r) => spec.filters.every((f) => matches(r, f, def.get(f.field)!)));
  const aggCols = spec.aggregates.map((a) => {
    const d = def.get(a.field)!;
    return { key: aggKey(a), label: a.fn === "count" ? "Count" : `${AGG_FNS[a.fn]} of ${d.label}`, format: (a.fn === "count" ? "int" : a.fn === "avg" && d.format === "int" ? "num" : d.format) as FieldFormat | undefined };
  });
  let columns: EngineResult["columns"];
  let rows: Array<Record<string, unknown>>;
  if (spec.groupBy) {
    const g = def.get(spec.groupBy)!;
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const r of filtered) {
      const k = r[g.key] === null || r[g.key] === undefined || r[g.key] === "" ? "(none)" : g.type === "date" ? asDate(r[g.key])! : g.type === "bool" ? (r[g.key] ? "Yes" : "No") : String(r[g.key]);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const aggs = spec.aggregates.length ? spec.aggregates : [{ field: g.key, fn: "count" as const }];
    if (!spec.aggregates.length) aggCols.push({ key: aggKey(aggs[0]!), label: "Count", format: "int" });
    columns = [{ key: g.key, label: g.label, format: g.format }, ...aggCols];
    rows = [...groups].map(([k, list]) => Object.fromEntries([[g.key, k], ...aggs.map((a) => [aggKey(a), aggregate(list, a, def.get(a.field)!.type)])]));
  } else {
    columns = spec.columns.map((c) => ({ key: c, label: def.get(c)!.label, format: def.get(c)!.format }));
    rows = filtered.map((r) => Object.fromEntries(spec.columns.map((c) => [c, r[c] ?? null])));
  }
  if (spec.sort) {
    const s = spec.sort;
    const type = def.get(s.field)?.type ?? "number";
    rows.sort((x, y) => {
      const a = cmpValue(x[s.field], type), b = cmpValue(y[s.field], type);
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * (s.dir === "desc" ? -1 : 1);
    });
  }
  const totals = !spec.groupBy && spec.aggregates.length ? Object.fromEntries(spec.aggregates.filter((a) => spec.columns.includes(a.field)).map((a) => [a.field, aggregate(filtered, a, def.get(a.field)!.type)])) : null;
  return { columns, rows: rows.slice(0, MAX_REPORT_ROWS), totals, truncated: rows.length > MAX_REPORT_ROWS, matched: filtered.length };
}

/** Parse a spec that came from a form or storage; anything malformed becomes empty. */
export function parseSpec(raw: unknown): ReportSpec {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    dataset: str(o.dataset),
    columns: arr(o.columns).map(str).filter(Boolean).slice(0, MAX_COLUMNS + 1),
    filters: arr(o.filters).map((f) => ({ field: str((f as ReportFilter)?.field), op: str((f as ReportFilter)?.op) as FilterOp, value: str((f as ReportFilter)?.value) })).filter((f) => f.field).slice(0, 20),
    groupBy: str(o.groupBy) || null,
    aggregates: arr(o.aggregates).map((a) => ({ field: str((a as ReportAggregate)?.field), fn: str((a as ReportAggregate)?.fn) as AggFn })).filter((a) => a.field).slice(0, 10),
    sort: o.sort && typeof o.sort === "object" && str((o.sort as { field?: unknown }).field) ? { field: str((o.sort as { field: unknown }).field), dir: (o.sort as { dir?: unknown }).dir === "desc" ? "desc" : "asc" } : null,
    from: str(o.from) || null,
    to: str(o.to) || null,
  };
}
