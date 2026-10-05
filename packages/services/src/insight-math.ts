/**
 * Insight depth — the pure rules behind reporting & dashboards, people
 * analytics, OKRs & KPIs, continuous feedback & 360, performance management
 * and PIPs & coaching. No database access here, so every rule is unit tested.
 */

const DAY_MS = 86_400_000;
const round = (n: number, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f; };

// ---------------------------------------------------------------------------
//  Workflow types (plugged into the generic engine)
// ---------------------------------------------------------------------------

export const INSIGHT_WORKFLOW_TYPES = {
  INSIGHT_METRIC: "Metric definition approval",
  INSIGHT_KRA: "Key result area approval",
  INSIGHT_DASHBOARD: "Company-wide dashboard publication",
  REPORT_ACCESS: "Report access requests",
  REPORT_PUBLISH: "Custom report publication",
  REPORT_SCHEDULE: "Report schedules mailing outside the company",
  REPORT_EXPORT: "Sensitive report exports",
  GOAL_APPROVAL: "Goal and key result approval",
  OKR_CLOSEOUT: "OKR period close-out",
  REVIEW_REOPEN: "Reopening a performance review",
  PIP_REQUEST: "Improvement plan extensions, escalations and check-in sign-off",
} as const;
export type InsightWorkflowType = keyof typeof INSIGHT_WORKFLOW_TYPES;
export const isInsightWorkflowType = (v: string): v is InsightWorkflowType => v in INSIGHT_WORKFLOW_TYPES;

// ---------------------------------------------------------------------------
//  Metric catalog
// ---------------------------------------------------------------------------

export const METRIC_CATEGORIES = {
  HEADCOUNT: "Headcount", ATTRITION: "Attrition", ABSENCE: "Absence", COMPENSATION: "Compensation",
  TALENT: "Talent", PERFORMANCE: "Performance", HIRING: "Hiring", ENGAGEMENT: "Engagement",
} as const;
export type MetricCategory = keyof typeof METRIC_CATEGORIES;

export const METRIC_UNITS = { COUNT: "Count", PERCENT: "Percent", INR: "Rupees", DAYS: "Days", SCORE: "Score" } as const;
export type MetricUnit = keyof typeof METRIC_UNITS;

/** The built-in calculators a governed metric can use. */
export const INSIGHT_CALCULATORS: Record<string, { label: string; category: MetricCategory; unit: MetricUnit; direction: "UP_GOOD" | "DOWN_GOOD" | "NEUTRAL"; formula: string }> = {
  HEADCOUNT: { label: "Active headcount", category: "HEADCOUNT", unit: "COUNT", direction: "NEUTRAL", formula: "People on the books on the as-of date (joined, not yet left)." },
  NEW_HIRES: { label: "New hires", category: "HEADCOUNT", unit: "COUNT", direction: "UP_GOOD", formula: "People whose date of joining falls in the window." },
  FEMALE_SHARE: { label: "Women in the workforce", category: "HEADCOUNT", unit: "PERCENT", direction: "UP_GOOD", formula: "Women ÷ active headcount × 100." },
  ATTRITION_RATE: { label: "Annualised attrition", category: "ATTRITION", unit: "PERCENT", direction: "DOWN_GOOD", formula: "Leavers in the window ÷ average headcount × (12 ÷ months) × 100." },
  VOLUNTARY_ATTRITION: { label: "Voluntary attrition", category: "ATTRITION", unit: "PERCENT", direction: "DOWN_GOOD", formula: "Resignations in the window ÷ average headcount × (12 ÷ months) × 100." },
  ABSENCE_RATE: { label: "Absence rate", category: "ABSENCE", unit: "PERCENT", direction: "DOWN_GOOD", formula: "Absent or unmarked workdays ÷ recorded workdays × 100." },
  LEAVE_DAYS_PER_HEAD: { label: "Leave days per head", category: "ABSENCE", unit: "DAYS", direction: "NEUTRAL", formula: "Approved leave days in the window ÷ active headcount." },
  AVERAGE_CTC: { label: "Average CTC", category: "COMPENSATION", unit: "INR", direction: "NEUTRAL", formula: "Mean of each active person's latest applied annual CTC." },
  PAYROLL_COST: { label: "Monthly payroll cost", category: "COMPENSATION", unit: "INR", direction: "NEUTRAL", formula: "Employer cost of the latest finalised payroll month." },
  OVERTIME_COST: { label: "Overtime cost", category: "COMPENSATION", unit: "INR", direction: "DOWN_GOOD", formula: "Overtime amounts in the window (paid or to be paid)." },
  HIGH_RISK_SHARE: { label: "High flight-risk share", category: "TALENT", unit: "PERCENT", direction: "DOWN_GOOD", formula: "People with a high attrition-risk score in the latest snapshot ÷ people scored × 100." },
  AVERAGE_RATING: { label: "Average final rating", category: "PERFORMANCE", unit: "SCORE", direction: "UP_GOOD", formula: "Mean final rating of reviews shared in the window." },
  GOALS_AT_RISK: { label: "Goals at risk", category: "PERFORMANCE", unit: "PERCENT", direction: "DOWN_GOOD", formula: "Live goals at risk or needing attention ÷ live goals × 100." },
  TIME_TO_FILL: { label: "Time to fill", category: "HIRING", unit: "DAYS", direction: "DOWN_GOOD", formula: "Median days from requisition approval to the first hire against it." },
  COST_PER_HIRE: { label: "Cost per hire", category: "HIRING", unit: "INR", direction: "DOWN_GOOD", formula: "Recorded recruiting spend in the window ÷ hires in the window." },
  POSITIVE_FEEDBACK_SHARE: { label: "Positive feedback share", category: "ENGAGEMENT", unit: "PERCENT", direction: "UP_GOOD", formula: "Feedback classified positive ÷ all feedback in the window × 100." },
  LEARNING_COMPLETION: { label: "Course completion", category: "TALENT", unit: "PERCENT", direction: "UP_GOOD", formula: "Completed enrolments ÷ enrolments assigned in the window × 100." },
};

/** A stable key from a name: "Voluntary attrition (Eng)" → "voluntary-attrition-eng". */
export function metricKeyOf(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "metric";
}

export type ThresholdState = "OK" | "WARN" | "ALERT";

/**
 * Where a value sits against its warning and alert levels. For DOWN_GOOD the
 * levels are ceilings (above is bad); for UP_GOOD they are floors.
 */
export function thresholdState(value: number | null, warnAt: number | null, alertAt: number | null, direction: string): ThresholdState {
  if (value === null || !Number.isFinite(value)) return "OK";
  const bad = (level: number | null) => level !== null && (direction === "UP_GOOD" ? value < level : value > level);
  if (bad(alertAt)) return "ALERT";
  if (bad(warnAt)) return "WARN";
  return "OK";
}

/** Problems with a warning/alert pair for a direction (the alert level must be the more extreme). */
export function thresholdProblem(warnAt: number | null, alertAt: number | null, direction: string): string | null {
  if (warnAt === null || alertAt === null) return null;
  if (direction === "UP_GOOD" && alertAt > warnAt) return "When higher is better, the alert level must be below the warning level.";
  if (direction !== "UP_GOOD" && alertAt < warnAt) return "When lower is better, the alert level must be above the warning level.";
  return null;
}

// ---------------------------------------------------------------------------
//  KPIs: RAG against the target in force, versioned targets, periods
// ---------------------------------------------------------------------------

export type Rag = "GREEN" | "AMBER" | "RED";

/** Achievement percent of a target; for DOWN_GOOD, hitting below the target is above 100%. */
export function kpiAchievement(value: number, target: number, direction: string): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return null;
  if (direction === "DOWN_GOOD") {
    if (value <= 0) return target <= 0 ? 100 : 200;
    return round((target / value) * 100, 1);
  }
  if (target === 0) return value >= 0 ? 100 : 0;
  return round((value / target) * 100, 1);
}

export function kpiRag(value: number, target: number, direction: string, greenAt = 100, amberAt = 80): { rag: Rag; achievement: number } {
  const a = kpiAchievement(value, target, direction) ?? 0;
  return { rag: a >= greenAt ? "GREEN" : a >= amberAt ? "AMBER" : "RED", achievement: a };
}

/** "YYYY-MM" for a month; a quarter is keyed by its first month. */
export function kpiPeriodOf(d: Date, frequency: string): string {
  const y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  if (frequency === "QUARTERLY") m = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function isPeriodKey(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** The target version in force for a period: the latest effective by the end of the period's first month. */
export function targetInForce<T extends { version: number; effectiveFrom: Date }>(targets: T[], period: string): T | null {
  const [y, m] = period.split("-").map(Number);
  const end = Date.UTC(y!, m ?? 1, 1) - 1;
  let best: T | null = null;
  for (const t of targets) {
    if (t.effectiveFrom.getTime() > end) continue;
    if (!best || t.effectiveFrom.getTime() > best.effectiveFrom.getTime() || (t.effectiveFrom.getTime() === best.effectiveFrom.getTime() && t.version > best.version)) best = t;
  }
  return best;
}

export function kraWeightProblem(weights: number[]): string | null {
  const total = round(weights.reduce((s, w) => s + w, 0));
  return total > 100 ? `KRA weights for a role add up to ${total}; keep them at or under 100.` : null;
}

// ---------------------------------------------------------------------------
//  Report operations: calculated fields, exceptions, joins, snapshots
// ---------------------------------------------------------------------------

type Tok = { t: "num"; v: number } | { t: "ref"; v: string } | { t: "op"; v: string };

function tokenize(expr: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === " ") { i++; continue; }
    if ("+-*/()".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "[") {
      const j = expr.indexOf("]", i);
      if (j < 0) return "A column reference is missing its closing ].";
      const name = expr.slice(i + 1, j).trim();
      if (!name) return "Empty column reference [].";
      out.push({ t: "ref", v: name }); i = j + 1; continue;
    }
    const m = /^\d+(\.\d+)?/.exec(expr.slice(i));
    if (m) { out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
    return `Unexpected “${c}”. Use numbers, [column] references, + - * / and brackets.`;
  }
  return out;
}

/**
 * A calculated field: arithmetic over columns, e.g. "[gross] / [employees]".
 * Returns the column references used, or an error. Evaluation never runs code.
 */
export function parseCalculatedField(expr: string): { ok: true; refs: string[] } | { ok: false; message: string } {
  if (!expr.trim()) return { ok: false, message: "Write a formula." };
  if (expr.length > 300) return { ok: false, message: "Keep the formula under 300 characters." };
  const toks = tokenize(expr);
  if (typeof toks === "string") return { ok: false, message: toks };
  const r = evalTokens(toks, () => 1);
  if (typeof r === "string") return { ok: false, message: r };
  return { ok: true, refs: [...new Set(toks.filter((t): t is { t: "ref"; v: string } => t.t === "ref").map((t) => t.v))] };
}

function evalTokens(toks: Tok[], get: (ref: string) => number | null): number | null | string {
  let pos = 0;
  const peek = () => toks[pos];
  function primary(): number | null | string {
    const t = toks[pos++];
    if (!t) return "The formula ends too early.";
    if (t.t === "num") return t.v;
    if (t.t === "ref") return get(t.v);
    if (t.v === "(") {
      const v = expr();
      if (typeof v === "string") return v;
      const close = toks[pos++];
      if (!close || close.t !== "op" || close.v !== ")") return "A bracket is not closed.";
      return v;
    }
    if (t.v === "-") { const v = primary(); return typeof v === "number" ? -v : v; }
    return `Unexpected “${t.v}”.`;
  }
  function term(): number | null | string {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || (t.v !== "*" && t.v !== "/")) return left;
      pos++;
      const right = primary();
      if (typeof left === "string") return left;
      if (typeof right === "string") return right;
      if (left === null || right === null) { left = null; continue; }
      left = t.v === "*" ? left * right : right === 0 ? null : left / right;
    }
  }
  function expr(): number | null | string {
    let left = term();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || (t.v !== "+" && t.v !== "-")) return left;
      pos++;
      const right = term();
      if (typeof left === "string") return left;
      if (typeof right === "string") return right;
      left = left === null || right === null ? null : t.v === "+" ? left + right : left - right;
    }
  }
  const v = expr();
  if (typeof v !== "string" && pos < toks.length) return `Unexpected “${(toks[pos] as { v: unknown }).v}”.`;
  return v;
}

/** Evaluate a calculated field for one row; non-numeric or missing inputs, or division by zero, give null. */
export function evalCalculatedField(expr: string, row: Record<string, unknown>): number | null {
  const toks = tokenize(expr);
  if (typeof toks === "string") return null;
  const v = evalTokens(toks, (ref) => {
    const raw = row[ref];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  });
  return typeof v === "number" && Number.isFinite(v) ? round(v, 4) : null;
}

export const EXCEPTION_OPS = { GT: ">", GTE: "≥", LT: "<", LTE: "≤", EQ: "=", NEQ: "≠", EMPTY: "is empty", NOT_EMPTY: "is not empty", CONTAINS: "contains" } as const;
export type ExceptionOp = keyof typeof EXCEPTION_OPS;
export interface ExceptionRule { column: string; op: ExceptionOp; value?: string }

export function rowMatchesRule(row: Record<string, unknown>, rule: ExceptionRule): boolean {
  const v = row[rule.column];
  const empty = v === null || v === undefined || v === "";
  if (rule.op === "EMPTY") return empty;
  if (rule.op === "NOT_EMPTY") return !empty;
  if (empty) return false;
  if (rule.op === "CONTAINS") return String(v).toLowerCase().includes(String(rule.value ?? "").toLowerCase());
  const a = typeof v === "number" ? v : Number(v instanceof Date ? v.getTime() : v);
  const b = Number(rule.value);
  if (["GT", "GTE", "LT", "LTE"].includes(rule.op)) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return rule.op === "GT" ? a > b : rule.op === "GTE" ? a >= b : rule.op === "LT" ? a < b : a <= b;
  }
  const same = Number.isFinite(a) && Number.isFinite(b) ? a === b : String(v).toLowerCase() === String(rule.value ?? "").toLowerCase();
  return rule.op === "EQ" ? same : !same;
}

/** Exception-only reporting: rows breaking any (mode ANY) or every (ALL) rule. */
export function exceptionRows<T extends Record<string, unknown>>(rows: T[], rules: ExceptionRule[], mode: "ANY" | "ALL" = "ANY"): T[] {
  if (!rules.length) return [];
  return rows.filter((r) => (mode === "ALL" ? rules.every((x) => rowMatchesRule(r, x)) : rules.some((x) => rowMatchesRule(r, x))));
}

/** A left join of two row sets on a key column, prefixing the right side's columns. */
export function joinRowSets(left: Array<Record<string, unknown>>, right: Array<Record<string, unknown>>, key: string, prefix: string): Array<Record<string, unknown>> {
  const idx = new Map<unknown, Record<string, unknown>>();
  for (const r of right) if (r[key] !== undefined && !idx.has(r[key])) idx.set(r[key], r);
  return left.map((l) => {
    const r = idx.get(l[key]);
    const out: Record<string, unknown> = { ...l };
    if (r) for (const [k, v] of Object.entries(r)) if (k !== key) out[`${prefix}${k}`] = v;
    return out;
  });
}

/** Compare a snapshot with today's rows: what was added, removed, or changed (by key). */
export function compareSnapshots(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>, key: string): { added: number; removed: number; changed: number; unchanged: number } {
  const b = new Map(before.map((r) => [String(r[key]), JSON.stringify(r)]));
  const a = new Map(after.map((r) => [String(r[key]), JSON.stringify(r)]));
  let added = 0, removed = 0, changed = 0, unchanged = 0;
  for (const [k, v] of a) { if (!b.has(k)) added++; else if (b.get(k) !== v) changed++; else unchanged++; }
  for (const k of b.keys()) if (!a.has(k)) removed++;
  return { added, removed, changed, unchanged };
}

/** Keep only the chosen columns (an export profile), in the chosen order; empty keeps all. */
export function pickColumns<C extends { key: string }>(columns: C[], keep: string[]): C[] {
  if (!keep.length) return columns;
  const by = new Map(columns.map((c) => [c.key, c]));
  return keep.map((k) => by.get(k)).filter((c): c is C => !!c);
}

/** Report access expiry: a grant is live while approved and before its expiry. */
export function grantLive(g: { status: string; expiresAt: Date | null }, now = new Date()): boolean {
  return g.status === "APPROVED" && !!g.expiresAt && g.expiresAt.getTime() > now.getTime();
}

/** Recipients outside the company's own email domains. */
export function externalRecipients(recipients: string[], companyDomains: string[]): string[] {
  const doms = new Set(companyDomains.map((d) => d.toLowerCase()));
  return recipients.filter((r) => !doms.has((r.split("@")[1] ?? "").toLowerCase()));
}

// ---------------------------------------------------------------------------
//  People analytics
// ---------------------------------------------------------------------------

export interface Quantiles { n: number; min: number; p25: number; median: number; p75: number; max: number; mean: number }

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function quantilesOf(values: number[]): Quantiles | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length, min: v[0]!, max: v[v.length - 1]!, mean: round(v.reduce((s, x) => s + x, 0) / v.length),
    p25: round(quantileOf(v, 0.25)), median: round(quantileOf(v, 0.5)), p75: round(quantileOf(v, 0.75)),
  };
}

/** Equal-width buckets between the min and max. */
export function histogramOf(values: number[], buckets = 6): Array<{ from: number; to: number; count: number }> {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return [];
  const min = Math.min(...v), max = Math.max(...v);
  if (min === max) return [{ from: min, to: max, count: v.length }];
  const w = (max - min) / buckets;
  const out = Array.from({ length: buckets }, (_, i) => ({ from: round(min + i * w), to: round(min + (i + 1) * w), count: 0 }));
  for (const x of v) out[Math.min(buckets - 1, Math.floor((x - min) / w))]!.count++;
  return out;
}

/**
 * Pay equity: within each comparable group (same job title or band), the
 * median pay of each gender. The adjusted gap is the headcount-weighted mean
 * of each group's (men's median − women's median) ÷ men's median, over groups
 * that have both. Groups under `min` per gender are not compared.
 */
export function payEquity(rows: Array<{ group: string; gender: string | null; pay: number }>, min = 1) {
  const groups = new Map<string, { male: number[]; female: number[] }>();
  for (const r of rows) {
    if (!(r.pay > 0)) continue;
    const g = groups.get(r.group) ?? { male: [], female: [] };
    if (r.gender === "MALE") g.male.push(r.pay); else if (r.gender === "FEMALE") g.female.push(r.pay);
    groups.set(r.group, g);
  }
  const med = (a: number[]) => quantilesOf(a)?.median ?? 0;
  const out: Array<{ group: string; men: number; women: number; maleMedian: number | null; femaleMedian: number | null; gapPercent: number | null }> = [];
  let wSum = 0, wGap = 0;
  for (const [group, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const comparable = g.male.length >= min && g.female.length >= min;
    const mm = g.male.length ? med(g.male) : null, fm = g.female.length ? med(g.female) : null;
    const gap = comparable && mm ? round(((mm - (fm ?? 0)) / mm) * 100, 1) : null;
    if (gap !== null) { const w = g.male.length + g.female.length; wSum += w; wGap += gap * w; }
    out.push({ group, men: g.male.length, women: g.female.length, maleMedian: mm, femaleMedian: fm, gapPercent: gap });
  }
  const all = { male: rows.filter((r) => r.gender === "MALE" && r.pay > 0).map((r) => r.pay), female: rows.filter((r) => r.gender === "FEMALE" && r.pay > 0).map((r) => r.pay) };
  const rawM = all.male.length ? med(all.male) : null, rawF = all.female.length ? med(all.female) : null;
  return {
    groups: out,
    rawGapPercent: rawM && rawF !== null ? round(((rawM - rawF) / rawM) * 100, 1) : null,
    adjustedGapPercent: wSum ? round(wGap / wSum, 1) : null,
  };
}

/** Months between consecutive promotions (and from joining to the first). */
export function promotionVelocity(people: Array<{ joinedOn: Date; promotions: Date[] }>): { promoted: number; avgMonthsToFirst: number | null; avgMonthsBetween: number | null } {
  const months = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (30.4375 * DAY_MS);
  const first: number[] = [], between: number[] = [];
  for (const p of people) {
    const ps = [...p.promotions].sort((a, b) => a.getTime() - b.getTime());
    if (!ps.length) continue;
    first.push(months(p.joinedOn, ps[0]!));
    for (let i = 1; i < ps.length; i++) between.push(months(ps[i - 1]!, ps[i]!));
  }
  const avg = (a: number[]) => (a.length ? round(a.reduce((s, x) => s + x, 0) / a.length, 1) : null);
  return { promoted: first.length, avgMonthsToFirst: avg(first), avgMonthsBetween: avg(between) };
}

/** Cohort survival: of people who joined in each quarter, how many are still here after N months. */
export function cohortSurvival(people: Array<{ joinedOn: Date; leftOn: Date | null }>, asOf: Date, checkpoints = [3, 6, 12, 24]) {
  const key = (d: Date) => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  const groups = new Map<string, Array<{ joinedOn: Date; leftOn: Date | null }>>();
  for (const p of people) { const k = key(p.joinedOn); groups.set(k, [...(groups.get(k) ?? []), p]); }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cohort, members]) => ({
    cohort, joined: members.length,
    retained: checkpoints.map((m) => {
      const eligible = members.filter((p) => addMonthsUtc(p.joinedOn, m).getTime() <= asOf.getTime());
      if (!eligible.length) return { months: m, percent: null as number | null };
      const stayed = eligible.filter((p) => !p.leftOn || p.leftOn.getTime() >= addMonthsUtc(p.joinedOn, m).getTime()).length;
      return { months: m, percent: round((stayed / eligible.length) * 100, 1) };
    }),
  }));
}

export function addMonthsUtc(d: Date, months: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}

export interface CohortFilters {
  departmentIds?: string[]; locationIds?: string[]; genders?: string[];
  joinedFrom?: string | null; joinedTo?: string | null;
  minTenureYears?: number | null; maxTenureYears?: number | null; includeExited?: boolean;
}

/** Whether a person belongs to a saved cohort. */
export function inCohort(p: { departmentId: string | null; locationId: string | null; gender: string | null; dateOfJoining: Date; leftOn: Date | null }, f: CohortFilters, asOf: Date): boolean {
  if (!f.includeExited && p.leftOn && p.leftOn.getTime() < asOf.getTime()) return false;
  if (f.departmentIds?.length && !f.departmentIds.includes(p.departmentId ?? "")) return false;
  if (f.locationIds?.length && !f.locationIds.includes(p.locationId ?? "")) return false;
  if (f.genders?.length && !f.genders.includes(p.gender ?? "")) return false;
  if (f.joinedFrom && p.dateOfJoining.toISOString().slice(0, 10) < f.joinedFrom) return false;
  if (f.joinedTo && p.dateOfJoining.toISOString().slice(0, 10) > f.joinedTo) return false;
  const tenure = (asOf.getTime() - p.dateOfJoining.getTime()) / (365.25 * DAY_MS);
  if (f.minTenureYears !== null && f.minTenureYears !== undefined && tenure < f.minTenureYears) return false;
  if (f.maxTenureYears !== null && f.maxTenureYears !== undefined && tenure > f.maxTenureYears) return false;
  return true;
}

export function cohortFiltersOf(json: unknown): CohortFilters {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    departmentIds: list(o.departmentIds), locationIds: list(o.locationIds), genders: list(o.genders),
    joinedFrom: typeof o.joinedFrom === "string" && o.joinedFrom ? o.joinedFrom : null,
    joinedTo: typeof o.joinedTo === "string" && o.joinedTo ? o.joinedTo : null,
    minTenureYears: num(o.minTenureYears), maxTenureYears: num(o.maxTenureYears), includeExited: !!o.includeExited,
  };
}

/**
 * Anomalies in a monthly series: points more than `z` standard deviations
 * from the mean of the other points, or a month-on-month swing over `swing`%.
 */
export function seriesAnomalies(series: Array<{ label: string; value: number }>, z = 2, swing = 50): Array<{ label: string; value: number; reason: string }> {
  const out: Array<{ label: string; value: number; reason: string }> = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i]!;
    const others = series.filter((_, j) => j !== i).map((x) => x.value);
    if (others.length >= 3) {
      const mean = others.reduce((s, x) => s + x, 0) / others.length;
      const sd = Math.sqrt(others.reduce((s, x) => s + (x - mean) ** 2, 0) / others.length);
      if (sd > 0 && Math.abs(p.value - mean) / sd > z) { out.push({ label: p.label, value: p.value, reason: `${round(Math.abs(p.value - mean) / sd, 1)}σ from the usual level (${round(mean)})` }); continue; }
    }
    if (i > 0) {
      const prev = series[i - 1]!.value;
      if (prev > 0 && Math.abs(p.value - prev) / prev * 100 > swing && Math.abs(p.value - prev) >= 2) out.push({ label: p.label, value: p.value, reason: `${p.value > prev ? "up" : "down"} ${round(Math.abs(p.value - prev) / prev * 100, 0)}% on the month before` });
    }
  }
  return out;
}

/** Engagement drivers: the mean score of each driver and its gap to the overall mean (scores 1-5). */
export function engagementDriverScores(answers: Array<{ driver: string | null; score: number | null }>): Array<{ driver: string; responses: number; mean: number; favourable: number; gap: number }> {
  const scored = answers.filter((a) => a.score !== null && a.driver) as Array<{ driver: string; score: number }>;
  if (!scored.length) return [];
  const overall = scored.reduce((s, a) => s + a.score, 0) / scored.length;
  const by = new Map<string, number[]>();
  for (const a of scored) by.set(a.driver, [...(by.get(a.driver) ?? []), a.score]);
  return [...by.entries()].map(([driver, s]) => {
    const mean = s.reduce((x, y) => x + y, 0) / s.length;
    return { driver, responses: s.length, mean: round(mean), favourable: round((s.filter((x) => x >= 4).length / s.length) * 100, 1), gap: round(mean - overall) };
  }).sort((a, b) => a.gap - b.gap);
}

/** Manager effectiveness from team outcomes; each signal is 0-100 and missing signals are skipped. */
export function managerEffectiveness(m: { teamSize: number; leavers12m: number; avgTeamRating: number | null; feedbackGiven90d: number; oneOnOnes90d: number; ratingScaleMax?: number }): { score: number; signals: Array<{ label: string; value: number }> } {
  const signals: Array<{ label: string; value: number }> = [];
  if (m.teamSize > 0) {
    signals.push({ label: "Retention", value: round(Math.max(0, 100 - (m.leavers12m / m.teamSize) * 100), 0) });
    signals.push({ label: "Feedback cadence", value: round(Math.min(100, (m.feedbackGiven90d / m.teamSize) * 50), 0) });
    signals.push({ label: "1:1 cadence", value: round(Math.min(100, (m.oneOnOnes90d / (m.teamSize * 3)) * 100), 0) });
  }
  if (m.avgTeamRating !== null) signals.push({ label: "Team performance", value: round((m.avgTeamRating / (m.ratingScaleMax ?? 5)) * 100, 0) });
  const score = signals.length ? round(signals.reduce((s, x) => s + x.value, 0) / signals.length, 0) : 0;
  return { score, signals };
}

export function medianOf(values: number[]): number | null {
  return quantilesOf(values)?.median ?? null;
}

// ---------------------------------------------------------------------------
//  Dashboards
// ---------------------------------------------------------------------------

/** A widget shows when it names no roles, or the viewer holds one of them (role names, MANAGER, EMPLOYEE). */
export function widgetVisible(roles: string[], viewer: { roleNames: string[]; isManager: boolean; isEmployee: boolean }): boolean {
  if (!roles.length) return true;
  return roles.some((r) => (r === "MANAGER" ? viewer.isManager : r === "EMPLOYEE" ? viewer.isEmployee : viewer.roleNames.includes(r)));
}

export function refreshOutcome(results: Array<{ error: string | null }>): "OK" | "PARTIAL" | "FAILED" {
  if (!results.length) return "OK";
  const bad = results.filter((r) => r.error).length;
  return bad === 0 ? "OK" : bad === results.length ? "FAILED" : "PARTIAL";
}

export function shareLive(s: { expiresAt: Date | null }, now = new Date()): boolean {
  return !s.expiresAt || s.expiresAt.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
//  Performance management
// ---------------------------------------------------------------------------

export interface ScalePoint { value: number; label: string; description: string }

export function scalePointsOf(json: unknown): ScalePoint[] {
  return (Array.isArray(json) ? json : []).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { value: Number(o.value), label: String(o.label ?? ""), description: String(o.description ?? "") };
  }).filter((p) => Number.isFinite(p.value));
}

/** Parse "value | label | description" lines into a rating scale. */
export function parseScalePoints(text: string): { ok: true; points: ScalePoint[] } | { ok: false; message: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: false, message: "A scale needs at least two points, one per line: value | label | description." };
  if (lines.length > 10) return { ok: false, message: "Up to 10 points." };
  const points: ScalePoint[] = [];
  for (const l of lines) {
    const [v, label, ...rest] = l.split("|").map((x) => x.trim());
    const value = Number(v);
    if (!Number.isInteger(value) || value < 1) return { ok: false, message: `“${l}”: start each line with a whole number from 1.` };
    if (!label) return { ok: false, message: `“${l}”: give the point a label.` };
    points.push({ value, label: label.slice(0, 60), description: rest.join(" | ").slice(0, 400) });
  }
  points.sort((a, b) => a.value - b.value);
  for (let i = 0; i < points.length; i++) if (points[i]!.value !== i + 1) return { ok: false, message: "Number the points 1, 2, 3… with no gaps or repeats." };
  return { ok: true, points };
}

/** The description library: what a rating means on a scale. */
export function describeRating(points: ScalePoint[], rating: number | null): ScalePoint | null {
  if (rating === null || !points.length) return null;
  const r = Math.round(rating);
  return points.find((p) => p.value === r) ?? null;
}

/** Weighted competency score: competency answers weighted by their question weight (unweighted = 1). */
export function weightedCompetencyScore(questions: Array<{ id: string; kind: string; weight: number | null }>, answers: Record<string, unknown>): number | null {
  let w = 0, s = 0;
  for (const q of questions) {
    if (q.kind !== "COMPETENCY") continue;
    const v = Number(answers[q.id]);
    if (!Number.isFinite(v) || answers[q.id] === undefined || answers[q.id] === null || answers[q.id] === "") continue;
    const wt = q.weight !== null && q.weight > 0 ? q.weight : 1;
    w += wt; s += v * wt;
  }
  return w ? round(s / w) : null;
}

/** Does a conditional section show, given the answers so far? */
export function sectionShows(section: { conditionQuestionId: string | null; conditionOp: string | null; conditionValue: number | null }, answers: Record<string, unknown>): boolean {
  if (!section.conditionQuestionId || !section.conditionOp || section.conditionValue === null) return true;
  const raw = answers[section.conditionQuestionId];
  if (raw === undefined || raw === null || raw === "") return false;
  const v = Number(raw);
  if (!Number.isFinite(v)) return false;
  return section.conditionOp === "LTE" ? v <= section.conditionValue : section.conditionOp === "GTE" ? v >= section.conditionValue : v === section.conditionValue;
}

/**
 * Rating normalization: each manager's ratings are moved so their mean and
 * spread match the whole population's (z-score per manager), clamped to the
 * scale. A manager with one rating or no spread keeps the shift only.
 */
export function normalizeRatings(rows: Array<{ id: string; manager: string; rating: number }>, scaleMax = 5): Array<{ id: string; manager: string; rating: number; normalized: number; delta: number }> {
  if (!rows.length) return [];
  const all = rows.map((r) => r.rating);
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  const sd = Math.sqrt(all.reduce((s, x) => s + (x - mean) ** 2, 0) / all.length);
  const byMgr = new Map<string, number[]>();
  for (const r of rows) byMgr.set(r.manager, [...(byMgr.get(r.manager) ?? []), r.rating]);
  const stats = new Map([...byMgr.entries()].map(([m, v]) => {
    const mm = v.reduce((s, x) => s + x, 0) / v.length;
    return [m, { mean: mm, sd: Math.sqrt(v.reduce((s, x) => s + (x - mm) ** 2, 0) / v.length) }];
  }));
  return rows.map((r) => {
    const st = stats.get(r.manager)!;
    const n = st.sd > 0 && sd > 0 ? mean + ((r.rating - st.mean) / st.sd) * sd : r.rating - st.mean + mean;
    const normalized = round(Math.min(scaleMax, Math.max(1, n)));
    return { ...r, normalized, delta: round(normalized - r.rating) };
  });
}

/** A generated performance summary from the facts of a review (no AI; every sentence comes from data). */
export function performanceSummary(f: {
  name: string; cycle: string; rating: number | null; scaleMax: number; band: string | null; ratingLabel?: string | null;
  goalsTotal: number; goalsCompleted: number; avgGoalProgress: number | null;
  strengths: string[]; improvements: string[]; peerCount: number; competencyScore: number | null; previousRating: number | null;
}): string {
  const s: string[] = [];
  if (f.rating !== null) s.push(`${f.name} was rated ${f.rating} of ${f.scaleMax}${f.ratingLabel ? ` (${f.ratingLabel})` : ""}${f.band ? `, in the “${f.band}” band` : ""} for ${f.cycle}.`);
  else s.push(`${f.name}'s ${f.cycle} review has no final rating yet.`);
  if (f.previousRating !== null && f.rating !== null) {
    const d = round(f.rating - f.previousRating);
    s.push(d === 0 ? `That matches the previous cycle.` : `That is ${d > 0 ? "up" : "down"} ${Math.abs(d)} on the previous cycle (${f.previousRating}).`);
  }
  if (f.goalsTotal) s.push(`${f.goalsCompleted} of ${f.goalsTotal} goal(s) were completed${f.avgGoalProgress !== null ? `, with average progress of ${f.avgGoalProgress}%` : ""}.`);
  if (f.competencyScore !== null) s.push(`The weighted competency score is ${f.competencyScore}.`);
  if (f.peerCount) s.push(`${f.peerCount} colleague(s) gave 360 feedback.`);
  const firstSentence = (t: string) => (t.split(/(?<=[.!?])\s/)[0] ?? t).trim().slice(0, 200);
  if (f.strengths.length) s.push(`Strengths noted: ${f.strengths.map(firstSentence).join(" ")}`);
  if (f.improvements.length) s.push(`To develop: ${f.improvements.map(firstSentence).join(" ")}`);
  return s.join(" ");
}

export const PERF_EXCEPTION_KINDS = {
  OVERDUE: "Overdue past the review window",
  SELF_GAP: "Self rating far from the manager's",
  NO_REASON: "Rating changed in calibration without a reason",
  NO_GOALS: "No goals counted in the review",
  OUT_OF_BAND: "Final rating outside every band",
  MISSING_MANAGER: "No manager reviewer",
} as const;
export type PerfExceptionKind = keyof typeof PERF_EXCEPTION_KINDS;

/** The exceptions one review raises. */
export function reviewExceptionKinds(r: {
  status: string; closesAt: Date | null; selfRating: number | null; managerRating: number | null;
  rawRating: number | null; finalRating: number | null; calibrationReason: string | null;
  goalCount: number; inBand: boolean | null; hasManagerSlot: boolean;
}, now = new Date()): Array<{ kind: PerfExceptionKind; detail: string }> {
  const out: Array<{ kind: PerfExceptionKind; detail: string }> = [];
  const open = ["NOT_STARTED", "SELF_PENDING", "MANAGER_PENDING"].includes(r.status);
  if (open && r.closesAt && r.closesAt.getTime() < now.getTime()) out.push({ kind: "OVERDUE", detail: `Still ${r.status.toLowerCase().replace(/_/g, " ")} after ${r.closesAt.toISOString().slice(0, 10)}` });
  if (r.selfRating !== null && r.managerRating !== null && Math.abs(r.selfRating - r.managerRating) >= 2) out.push({ kind: "SELF_GAP", detail: `Self ${r.selfRating} vs manager ${r.managerRating}` });
  if (r.finalRating !== null && r.rawRating !== null && Math.abs(r.finalRating - r.rawRating) > 0.001 && !r.calibrationReason?.trim()) out.push({ kind: "NO_REASON", detail: `Moved from ${r.rawRating} to ${r.finalRating}` });
  if (r.goalCount === 0) out.push({ kind: "NO_GOALS", detail: "No goals in the review period count towards the review" });
  if (r.finalRating !== null && r.inBand === false) out.push({ kind: "OUT_OF_BAND", detail: `Final rating ${r.finalRating} falls in no band` });
  if (!r.hasManagerSlot) out.push({ kind: "MISSING_MANAGER", detail: "Nobody is set to review as manager" });
  return out;
}

/** Ratings across cycles for a trend: per cycle, the average and the distribution by whole point. */
export function ratingTrend(cycles: Array<{ name: string; end: Date; ratings: number[] }>): Array<{ cycle: string; reviews: number; average: number | null; high: number; low: number }> {
  return [...cycles].sort((a, b) => a.end.getTime() - b.end.getTime()).map((c) => ({
    cycle: c.name, reviews: c.ratings.length,
    average: c.ratings.length ? round(c.ratings.reduce((s, x) => s + x, 0) / c.ratings.length) : null,
    high: c.ratings.filter((x) => x >= 4).length, low: c.ratings.filter((x) => x < 2.5).length,
  }));
}

/** Which reviewer slots are due a completion reminder. */
export function reviewReminderDue(r: { submittedAt: Date | null; remindedAt: Date | null }, closesAt: Date | null, now = new Date(), everyDays = 3, windowDays = 7): boolean {
  if (r.submittedAt) return false;
  if (r.remindedAt && now.getTime() - r.remindedAt.getTime() < everyDays * DAY_MS) return false;
  if (!closesAt) return !r.remindedAt || now.getTime() - r.remindedAt.getTime() >= everyDays * DAY_MS;
  return closesAt.getTime() - now.getTime() <= windowDays * DAY_MS;
}

export function cycleTemplateConfigOf(json: unknown): { reviewerTypes: Array<{ type: string; weight: number }>; ratingMax: number; maxPeers: number; anonymousFeedback: boolean; bands: Array<{ name: string; minRating: number; maxRating: number; targetPercent: number | null; color: string | null }>; sections: Array<{ title: string; questions: Array<{ kind: string; prompt: string; competency: string | null; isRequired: boolean; appliesTo: string[]; weight: number | null }> }> } {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
  return {
    reviewerTypes: arr(o.reviewerTypes).map((r) => ({ type: String(r.type), weight: Number(r.weight) || 0 })),
    ratingMax: Number(o.ratingMax) || 5,
    maxPeers: Number(o.maxPeers) || 3,
    anonymousFeedback: o.anonymousFeedback !== false,
    bands: arr(o.bands).map((b) => ({ name: String(b.name), minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null || b.targetPercent === undefined ? null : Number(b.targetPercent), color: b.color ? String(b.color) : null })),
    sections: arr(o.sections).map((s) => ({
      title: String(s.title),
      questions: arr(s.questions).map((q) => ({ kind: String(q.kind ?? "RATING"), prompt: String(q.prompt), competency: q.competency ? String(q.competency) : null, isRequired: q.isRequired !== false, appliesTo: Array.isArray(q.appliesTo) ? (q.appliesTo as unknown[]).map(String) : [], weight: q.weight === null || q.weight === undefined ? null : Number(q.weight) })),
    })),
  };
}

// ---------------------------------------------------------------------------
//  OKRs
// ---------------------------------------------------------------------------

export const CHECKIN_CADENCES = { WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 31 } as const;
export type CheckInCadence = keyof typeof CHECKIN_CADENCES;

/** A check-in is overdue once the cadence and the grace days have passed since the last one (or the start). */
export function checkInOverdue(lastCheckIn: Date | null, startDate: Date, cadence: string, graceDays: number, now = new Date()): { overdue: boolean; dueOn: Date; daysLate: number } {
  const every = CHECKIN_CADENCES[cadence as CheckInCadence] ?? 31;
  const from = lastCheckIn ?? startDate;
  const dueOn = new Date(from.getTime() + every * DAY_MS);
  const late = Math.floor((now.getTime() - dueOn.getTime()) / DAY_MS);
  return { overdue: late > graceDays, dueOn, daysLate: Math.max(0, late) };
}

/** Progress against a stretch target, beyond 100% of the committed one. */
export function stretchProgress(start: number, target: number, stretch: number | null, current: number): { committed: number; stretch: number | null } {
  const span = target - start;
  const committed = span === 0 ? (current >= target ? 100 : 0) : round(((current - start) / span) * 100, 1);
  if (stretch === null) return { committed, stretch: null };
  const sspan = stretch - start;
  return { committed, stretch: sspan === 0 ? null : round(((current - start) / sspan) * 100, 1) };
}

export function stretchProblem(start: number, target: number, stretch: number | null): string | null {
  if (stretch === null) return null;
  if (target >= start && stretch <= target) return "The stretch target must be beyond the target.";
  if (target < start && stretch >= target) return "For a decrease, the stretch target must be below the target.";
  return null;
}

export function confidenceLabel(c: number | null): "HIGH" | "MEDIUM" | "LOW" | null {
  if (c === null || c === undefined) return null;
  return c >= 7 ? "HIGH" : c >= 4 ? "MEDIUM" : "LOW";
}

/** Would linking from → to (DEPENDS_ON/BLOCKS) close a loop? */
export function dependencyLoop(links: Array<{ from: string; to: string }>, from: string, to: string): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const l of links) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(out.get(n) ?? []));
  }
  return false;
}

/** The close-out summary of a period's goals. */
export function closeoutSummary(goals: Array<{ status: string; progress: number }>): { goals: number; completed: number; missed: number; averageProgress: number } {
  const live = goals.filter((g) => g.status !== "CANCELLED" && g.status !== "DRAFT");
  return {
    goals: live.length,
    completed: live.filter((g) => g.status === "COMPLETED" || g.progress >= 100).length,
    missed: live.filter((g) => g.status !== "COMPLETED" && g.progress < 100).length,
    averageProgress: live.length ? round(live.reduce((s, g) => s + Math.min(100, g.progress), 0) / live.length, 1) : 0,
  };
}

/** Final status of a goal at close-out. */
export function closeoutStatus(status: string, progress: number): "COMPLETED" | "MISSED" | "CANCELLED" | "DRAFT" {
  if (status === "CANCELLED" || status === "DRAFT") return status;
  return status === "COMPLETED" || progress >= 100 ? "COMPLETED" : "MISSED";
}

// ---------------------------------------------------------------------------
//  Continuous feedback
// ---------------------------------------------------------------------------

const POSITIVE = ["great", "excellent", "thanks", "thank", "appreciate", "appreciated", "helpful", "brilliant", "outstanding", "well done", "impressive", "clear", "proactive", "supportive", "good", "strong", "kudos", "amazing", "reliable", "thorough", "creative", "fantastic", "love", "awesome"];
const NEGATIVE = ["poor", "late", "missed", "rude", "careless", "unclear", "slow", "disappointing", "disappointed", "frustrating", "frustrated", "mistake", "mistakes", "error", "errors", "unprofessional", "ignored", "blocked", "lacking", "lack", "inconsistent", "sloppy", "concern", "concerned", "problem", "issue", "issues", "bad", "worse", "worst", "harass", "harassment", "abusive", "unacceptable"];
const NEGATORS = ["not", "never", "no", "hardly", "isn't", "wasn't", "don't", "didn't"];

/** Lexicon sentiment: −100..100 and a label. Negators flip the next sentiment word. */
export function classifySentiment(text: string): { sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE"; score: number } {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  const words = t.trim().split(" ");
  let pos = 0, neg = 0;
  for (const phrase of POSITIVE.filter((p) => p.includes(" "))) if (t.includes(` ${phrase} `)) pos++;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const flipped = i > 0 && NEGATORS.includes(words[i - 1]!) || i > 1 && NEGATORS.includes(words[i - 2]!);
    const p = POSITIVE.includes(w), n = NEGATIVE.includes(w);
    if (!p && !n) continue;
    if (p !== flipped) pos++; else neg++;
  }
  const total = pos + neg;
  const score = total ? Math.round(((pos - neg) / total) * 100) : 0;
  return { sentiment: score >= 25 ? "POSITIVE" : score <= -25 ? "NEGATIVE" : "NEUTRAL", score };
}

export function parseTagList(raw: string): string[] {
  return [...new Set(raw.split(/[,;#\n]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")).filter((t) => t.length >= 2 && t.length <= 30))].slice(0, 8);
}

/**
 * Feedback quality prompts: nudges shown before sending (specific, an
 * example, what to do next). Empty when the feedback reads well.
 */
export function feedbackQualityPrompts(text: string): string[] {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  if (words.length < 12) out.push("Add detail: say what happened and why it mattered (at least a couple of sentences).");
  if (!/\b(when|during|in the|on the|yesterday|last week|meeting|project|release|demo|call|presentation|sprint|review|report)\b/i.test(t)) out.push("Point to a specific situation or piece of work.");
  if (!/\b(next time|could|try|suggest|keep|continue|would help|consider|recommend|start|stop)\b/i.test(t)) out.push("Suggest what to keep doing or try next time.");
  if (/\b(always|never|everyone|nobody|lazy|stupid|useless|terrible)\b/i.test(t)) out.push("Avoid absolutes and labels; describe the behaviour instead.");
  return out;
}

export interface EscalationRuleShape { id: string; trigger: string; keyword: string | null; topicId: string | null; isActive: boolean }

export function escalationRuleMatches(rule: EscalationRuleShape, f: { message: string; sentiment: string | null; topicId: string | null }): boolean {
  if (!rule.isActive) return false;
  if (rule.trigger === "NEGATIVE") return f.sentiment === "NEGATIVE";
  if (rule.trigger === "KEYWORD") return !!rule.keyword && f.message.toLowerCase().includes(rule.keyword.toLowerCase());
  if (rule.trigger === "TOPIC") return !!rule.topicId && f.topicId === rule.topicId;
  return false;
}

/** Monthly feedback counts by sentiment. */
export function feedbackTrend(rows: Array<{ createdAt: Date; sentiment: string | null }>): Array<{ month: string; total: number; positive: number; neutral: number; negative: number; positiveShare: number }> {
  const by = new Map<string, { total: number; positive: number; neutral: number; negative: number }>();
  for (const r of rows) {
    const k = r.createdAt.toISOString().slice(0, 7);
    const m = by.get(k) ?? { total: 0, positive: 0, neutral: 0, negative: 0 };
    m.total++;
    if (r.sentiment === "POSITIVE") m.positive++; else if (r.sentiment === "NEGATIVE") m.negative++; else m.neutral++;
    by.set(k, m);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, m]) => ({ month, ...m, positiveShare: round((m.positive / m.total) * 100, 1) }));
}

/** Anonymous 360 answers are pooled and shown only once enough have arrived. */
export function anonymityMet(responses: number, minimum: number): boolean {
  return responses >= Math.max(1, minimum);
}

/** Feedback may be edited or deleted by its author within this window. */
export const FEEDBACK_EDIT_HOURS = 48;
export function feedbackEditable(createdAt: Date, now = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= FEEDBACK_EDIT_HOURS * 3_600_000;
}

/** A feedback template's questions and answers, folded into one message. */
export function templateMessage(questions: string[], answers: string[]): { ok: true; message: string } | { ok: false; message: string } {
  const parts: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = (answers[i] ?? "").trim();
    if (!a) return { ok: false, message: `Answer “${questions[i]}”.` };
    parts.push(`${questions[i]}\n${a}`);
  }
  return { ok: true, message: parts.join("\n\n") };
}

// ---------------------------------------------------------------------------
//  PIPs and coaching
// ---------------------------------------------------------------------------

export interface PipEligibilityRules { minTenureDays: number; maxRating: number | null; blockProbation: boolean; blockNotice: boolean }

export function pipEligibility(e: { dateOfJoining: Date; status: string; lastRating: number | null; activePip: boolean }, rules: PipEligibilityRules, today = new Date()): string[] {
  const out: string[] = [];
  if (e.activePip) out.push("There is already an active plan.");
  const days = Math.floor((today.getTime() - e.dateOfJoining.getTime()) / DAY_MS);
  if (days < rules.minTenureDays) out.push(`Joined ${days} day(s) ago; a plan needs at least ${rules.minTenureDays} days' service.`);
  if (rules.blockProbation && e.status === "PROBATION") out.push("On probation — use the probation review instead.");
  if (rules.blockNotice && e.status === "NOTICE_PERIOD") out.push("Serving notice.");
  if (rules.maxRating !== null && e.lastRating !== null && e.lastRating > rules.maxRating) out.push(`Last rating ${e.lastRating} is above the ${rules.maxRating} threshold for a plan.`);
  return out;
}

/** What still stands between an active plan and closing it. */
export function pipCompletionProblems(p: {
  objectives: Array<{ status: string }>; checklist: Array<{ required: boolean; doneAt: Date | null; label: string }>;
  milestones: Array<{ status: string }>; checkIns: number; requireChecklist: boolean; outcome: string;
}): string[] {
  const out: string[] = [];
  const openObj = p.objectives.filter((o) => o.status === "OPEN").length;
  if (openObj) out.push(`${openObj} objective(s) are not assessed as met or not met.`);
  const openMs = p.milestones.filter((m) => m.status === "OPEN").length;
  if (openMs) out.push(`${openMs} milestone(s) are still open.`);
  if (p.checkIns === 0) out.push("No check-in has been recorded.");
  if (p.requireChecklist) {
    const missing = p.checklist.filter((c) => c.required && !c.doneAt).map((c) => c.label);
    if (missing.length) out.push(`Compliance checklist not done: ${missing.join(", ")}.`);
  }
  if (p.outcome === "SUCCESSFUL" && p.objectives.length && p.objectives.some((o) => o.status === "NOT_MET")) out.push("A successful outcome needs every objective met.");
  return out;
}

export function milestonesFromTemplate(json: unknown, start: Date, end: Date): Array<{ title: string; dueDate: Date }> {
  return (Array.isArray(json) ? json : []).map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const due = new Date(start.getTime() + (Number(o.offsetDays) || 0) * DAY_MS);
    return { title: String(o.title ?? "").slice(0, 200), dueDate: due.getTime() > end.getTime() ? end : due };
  }).filter((m) => m.title);
}

/** "Title @ 14" lines → milestones with day offsets. */
export function parseMilestoneLines(text: string): { ok: true; milestones: Array<{ title: string; offsetDays: number }> } | { ok: false; message: string } {
  const out: Array<{ title: string; offsetDays: number }> = [];
  for (const l of text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.*?)\s*@\s*(\d{1,3})$/.exec(l);
    if (!m || !m[1]) return { ok: false, message: `“${l}”: write each milestone as “title @ day”, e.g. “First review @ 30”.` };
    out.push({ title: m[1].slice(0, 200), offsetDays: Number(m[2]) });
  }
  return { ok: true, milestones: out.slice(0, 12) };
}

/** Behaviour trend: first-half vs second-half average of 1-5 observations. */
export function behaviourTrend(logs: Array<{ observedOn: Date; rating: number }>): { average: number | null; trend: "IMPROVING" | "STEADY" | "DECLINING" | null } {
  if (!logs.length) return { average: null, trend: null };
  const s = [...logs].sort((a, b) => a.observedOn.getTime() - b.observedOn.getTime());
  const avg = (a: typeof s) => a.reduce((x, y) => x + y.rating, 0) / a.length;
  const average = round(avg(s), 1);
  if (s.length < 2) return { average, trend: null };
  const half = Math.floor(s.length / 2);
  const d = avg(s.slice(half)) - avg(s.slice(0, half));
  return { average, trend: d >= 0.5 ? "IMPROVING" : d <= -0.5 ? "DECLINING" : "STEADY" };
}

/** Broader performance risk: 0-100 from rating, goals at risk, PIP, negative feedback and missed check-ins. */
export function performanceRisk(f: { lastRating: number | null; scaleMax?: number; ratingDrop: number | null; goalsAtRisk: number; goals: number; activePip: boolean; negativeFeedback90d: number; overdueCheckIns: number }): { score: number; band: "HIGH" | "MEDIUM" | "LOW"; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const max = f.scaleMax ?? 5;
  if (f.lastRating !== null && f.lastRating <= max * 0.5) { score += 30; reasons.push(`Last rating ${f.lastRating}`); }
  if (f.ratingDrop !== null && f.ratingDrop >= 1) { score += 15; reasons.push(`Rating fell by ${f.ratingDrop}`); }
  if (f.goals > 0 && f.goalsAtRisk / f.goals >= 0.5) { score += 20; reasons.push(`${f.goalsAtRisk} of ${f.goals} goals at risk`); }
  if (f.activePip) { score += 20; reasons.push("On an improvement plan"); }
  if (f.negativeFeedback90d >= 2) { score += 10; reasons.push(`${f.negativeFeedback90d} negative feedback in 90 days`); }
  if (f.overdueCheckIns >= 2) { score += 5; reasons.push(`${f.overdueCheckIns} goal check-ins overdue`); }
  score = Math.min(100, score);
  return { score, band: score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW", reasons };
}

/** A coaching plan needs a follow-up when no session has been logged for `days`. */
export function coachingFollowUpDue(lastSession: Date | null, startDate: Date, days: number, now = new Date()): boolean {
  const from = lastSession ?? startDate;
  return now.getTime() - from.getTime() >= days * DAY_MS;
}

export const PIP_REQUEST_KINDS = { EXTENSION: "Extension", ESCALATION: "Escalation", CHECKIN_SIGNOFF: "Check-in sign-off" } as const;

export function extensionProblem(p: { startDate: Date; endDate: Date }, days: number, maxTotalDays = 180): string | null {
  if (!Number.isInteger(days) || days < 7 || days > 90) return "Extend by 7 to 90 days.";
  const total = (p.endDate.getTime() - p.startDate.getTime()) / DAY_MS + days;
  if (total > maxTotalDays) return `With the extension the plan would run ${Math.round(total)} days; the limit is ${maxTotalDays}.`;
  return null;
}

// ---------------------------------------------------------------------------
//  Timelines
// ---------------------------------------------------------------------------

export interface TimelineEvent { at: Date; kind: string; title: string; detail?: string | null }
export function mergeTimeline(...lists: TimelineEvent[][]): TimelineEvent[] {
  return lists.flat().sort((a, b) => b.at.getTime() - a.at.getTime());
}
