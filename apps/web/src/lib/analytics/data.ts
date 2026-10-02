import "server-only";
import {
  loadPopulation, ratingAt, monthsSinceRaiseAt, onBooks, headcountAt, leaversIn, joinersIn, monthsIn, averageHeadcount,
  growthKpis, previousWindow, windowMonths, attritionTenureBand, attritionAgeBand, sinceRaiseBand, perfBin, countBy, yearsBetween, monthsBetween,
  suppressSmall, ATTRITION_TENURE_BANDS, ATTRITION_AGE_BANDS, SINCE_RAISE_BANDS, PERF_BINS, utcDay,
  monthlyFlow, annualisedRate, exitKind, isRegretted, attritionByGroup, newHireRetention, newHireRetentionByMonth, probeDay,
  EXIT_KINDS, REGRET_RATING, NEW_HIRE_DAYS,
  type PopEmployee, type Window, type GroupAttrition,
} from "@keka/services";
import type { Prisma } from "@keka/db";
import { EXIT_TYPE_LABEL, GENDER_LABEL, TEN_TOKEN, type AnalyticsFilters } from "./filters";

/**
 * Every chart on the analytics pages and storyboards, defined once: the same
 * builder feeds the card, its raw-data drawer, its CSV/PDF export and the AI
 * digest, so they can never disagree.
 */

export type ChartKind = "donut" | "bar" | "area" | "combo" | "grouped";
export interface ChartRow { label: string; value: number; segments?: Array<{ label: string; value: number }> }
export interface RawRow { id: string; name: string; number: string; value: string }
export interface ChartData {
  key: string;
  title: string;
  info: string;
  kind: ChartKind;
  rows: ChartRow[];
  yLabel?: string;
  xLabel?: string;
  legend?: string;
  /** Combo charts: a line on a right-hand axis. */
  line?: { label: string; values: number[]; axisLabel: string };
  /** Grouped bars: one value per row per series. */
  series?: Array<{ label: string; values: number[] }>;
  /** Values are percentages. */
  pct?: boolean;
  centre?: string;
  insights?: Array<{ label: string; value: string }>;
  raw: RawRow[];
  rawLabel: string;
}

export const DIMENSIONS = ["department", "location", "businessUnit", "worker", "band", "gender", "age", "tenure", "sinceRaise", "exitType", "exitReason", "performance", "manager", "exitKind"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIM_LABEL: Record<Dimension, string> = {
  department: "Department", location: "Location", businessUnit: "Business unit", worker: "Worker type", band: "Band",
  gender: "Gender", age: "Age", tenure: "Tenure", sinceRaise: "Months since raise", exitType: "Exit type", exitReason: "Exit reason", performance: "Performance rating",
  manager: "Reporting manager", exitKind: "Voluntary or involuntary",
};

const TENURE_LABEL: Record<string, string> = { "<1": "<1 yr", "1-2": "1-2 yrs", "2-3": "2-3 yrs", "3-5": "3-5 yrs", "5-10": "5-10 yrs", "10+": "10+ yrs" };

export function ageAt(e: PopEmployee, d: Date): number | null {
  return e.dateOfBirth ? Math.floor(yearsBetween(e.dateOfBirth, d)) : null;
}

/** The value of a dimension for one person on one day (their last day, for leavers). */
export function dimValue(dim: Dimension, e: PopEmployee, d: Date): string {
  switch (dim) {
    case "department": return e.department;
    case "location": return e.location;
    case "businessUnit": return e.businessUnit;
    case "worker": return e.workerType;
    case "band": return e.band;
    case "gender": return e.gender ? GENDER_LABEL[e.gender] ?? "Not specified" : "Not specified";
    case "age": { const a = ageAt(e, d); return a === null ? "Not specified" : attritionAgeBand(a); }
    case "tenure": return TENURE_LABEL[attritionTenureBand(yearsBetween(e.dateOfJoining, d))];
    case "sinceRaise": return sinceRaiseBand(monthsSinceRaiseAt(e, d));
    case "exitType": return e.exitType ? EXIT_TYPE_LABEL[e.exitType] ?? e.exitType : "—";
    case "exitReason": return e.exitReason ?? "Not recorded";
    case "performance": return perfBin(ratingAt(e, d));
    case "manager": return e.manager;
    case "exitKind": return exitKind(e);
  }
}

const ORDER: Partial<Record<Dimension, readonly string[]>> = {
  tenure: ATTRITION_TENURE_BANDS.map((b) => TENURE_LABEL[b]), age: ATTRITION_AGE_BANDS, sinceRaise: SINCE_RAISE_BANDS, performance: PERF_BINS,
  gender: ["Female", "Male", "Non-binary", "Prefer not to respond", "Not specified"], exitKind: EXIT_KINDS,
};

/** The day a person's attributes are read: their last day if they left in the window, else the window's end. */
const asAt = (e: PopEmployee, w: Window) => (e.leftOn && e.leftOn.getTime() <= w.to.getTime() ? e.leftOn : w.to);

// ---------------------------------------------------------------------------
//  Population
// ---------------------------------------------------------------------------

export async function population(where: Prisma.EmployeeWhereInput): Promise<PopEmployee[]> {
  return loadPopulation(where);
}

/** In-memory dimension filters (storyboard Insights row). */
export function narrow(pop: PopEmployee[], f: AnalyticsFilters, keys: Array<"dept" | "loc" | "wt">): PopEmployee[] {
  const col = { dept: "departmentId", loc: "locationId", wt: "workerTypeId" } as const;
  return pop.filter((e) => keys.every((k) => {
    const vals = f.dims[k];
    if (!vals.length) return true;
    const v = e[col[k]];
    return v ? vals.includes(v) : vals.includes("none");
  }));
}

const GENDER_TOKEN: Record<string, string | null> = { MALE: "MALE", FEMALE: "FEMALE", OTHER: "OTHER", UNDISCLOSED: "UNDISCLOSED" };

/** Leavers in the window, narrowed by the exit-level filters. */
export function leaversFor(pop: PopEmployee[], w: Window, f: AnalyticsFilters): PopEmployee[] {
  return leaversIn(pop, w).filter((e) => {
    const at = e.leftOn!;
    if (f.post.xt.length && !f.post.xt.includes(e.exitType ?? "")) return false;
    if (f.post.xr.length && !f.post.xr.includes(e.exitReasonId ?? "none")) return false;
    if (f.post.g.length && !f.post.g.includes(e.gender ? GENDER_TOKEN[e.gender] ?? "none" : "none")) return false;
    if (f.post.perf.length) { const b = perfBin(ratingAt(e, at)); if (!f.post.perf.includes(b === "Not rated" ? "none" : b)) return false; }
    if (f.post.ten.length && !f.post.ten.some((tk) => TEN_TOKEN[tk] === attritionTenureBand(yearsBetween(e.dateOfJoining, at)))) return false;
    return true;
  });
}

const raw = (members: PopEmployee[], value: (e: PopEmployee) => string): RawRow[] =>
  members.map((e) => ({ id: e.id, name: e.name, number: e.employeeNumber, value: value(e) })).sort((a, b) => a.name.localeCompare(b.name));

function dimChart(key: string, title: string, info: string, dim: Dimension, members: PopEmployee[], w: Window, opts: { kind?: ChartKind; yLabel?: string; xLabel?: string; legend?: string; dropEmpty?: boolean; groupBy?: Dimension | null } = {}): ChartData {
  const at = (e: PopEmployee) => asAt(e, w);
  const rows: ChartRow[] = countBy(members, (e) => dimValue(dim, e, at(e)), ORDER[dim], opts.dropEmpty ?? !ORDER[dim]);
  if (opts.groupBy && opts.groupBy !== dim) {
    const gb = opts.groupBy;
    const segLabels = countBy(members, (e) => dimValue(gb, e, at(e)), ORDER[gb], true).map((r) => r.label);
    for (const r of rows) {
      const inRow = members.filter((e) => dimValue(dim, e, at(e)) === r.label);
      r.segments = segLabels.map((label) => ({ label, value: inRow.filter((e) => dimValue(gb, e, at(e)) === label).length }));
    }
  }
  const kind = opts.kind ?? "bar";
  return {
    key, title, info, kind, rows, yLabel: opts.yLabel ?? "Employees (Count)", xLabel: opts.xLabel, legend: opts.legend,
    centre: kind === "donut" ? String(members.length) : undefined,
    raw: raw(members, (e) => dimValue(dim, e, at(e))), rawLabel: DIM_LABEL[dim],
  };
}

// ---------------------------------------------------------------------------
//  Headcount by Demographics
// ---------------------------------------------------------------------------

export const HEADCOUNT_CHARTS: Array<{ key: string; title: string; dim: Dimension; kind: ChartKind; info: string }> = [
  { key: "hc-gender", title: "Gender", dim: "gender", kind: "donut", info: "Employees on the books at the end of the date range, by gender." },
  { key: "hc-worker", title: "Employment Type", dim: "worker", kind: "donut", info: "Employees by worker type: permanent, contract, intern or consultant." },
  { key: "hc-department", title: "Department", dim: "department", kind: "bar", info: "Headcount in each department." },
  { key: "hc-location", title: "Location", dim: "location", kind: "bar", info: "Headcount at each work location." },
  { key: "hc-age", title: "Age", dim: "age", kind: "bar", info: "Headcount by age band, on the last day of the range." },
  { key: "hc-tenure", title: "Years in Organisation", dim: "tenure", kind: "bar", info: "How long people have been with the organisation." },
  { key: "hc-band", title: "Band", dim: "band", kind: "bar", info: "Headcount in each band." },
];

export function headcountChart(key: string, pop: PopEmployee[], w: Window): ChartData | null {
  const def = HEADCOUNT_CHARTS.find((c) => c.key === key);
  if (!def) return null;
  const onDay = pop.filter((e) => onBooks(e, w.to));
  return dimChart(def.key, def.title, def.info, def.dim, onDay, { from: w.to, to: w.to }, { kind: def.kind, dropEmpty: def.dim === "age" });
}

// ---------------------------------------------------------------------------
//  Growth & Retention
// ---------------------------------------------------------------------------

export function growthData(pop: PopEmployee[], w: Window) {
  const k = growthKpis(pop, w);
  const months = monthsIn(w);
  const opening = headcountAt(pop, w.from);
  let prev = opening;
  const heads: number[] = [], growth: number[] = [], joiners: number[] = [], leavers: number[] = [];
  for (const m of months) {
    const h = headcountAt(pop, m.end);
    heads.push(h);
    growth.push(prev ? Math.round(((h - prev) / prev) * 10000) / 100 : 0);
    prev = h;
    joiners.push(joinersIn(pop, { from: m.start, to: m.end }).length);
    leavers.push(leaversIn(pop, { from: m.start, to: m.end }).length);
  }
  const openers = pop.filter((e) => onBooks(e, w.from));
  return {
    kpis: k,
    growthChart: {
      key: "gr-growth", title: "Growth Rate", info: "Month-end headcount (bars) and month-on-month growth (line).", kind: "combo" as ChartKind,
      rows: months.map((m, i) => ({ label: m.label, value: heads[i] })), yLabel: "Employees (Count)",
      line: { label: "Growth Rate", values: growth, axisLabel: "Growth Rate (%)" },
      raw: raw(pop.filter((e) => onBooks(e, w.to)), (e) => e.department), rawLabel: "Department",
    } satisfies ChartData,
    flowChart: {
      key: "gr-flow", title: "Joiners vs Leavers", info: "People who joined and left in each month.", kind: "grouped" as ChartKind,
      rows: months.map((m, i) => ({ label: m.label, value: joiners[i] + leavers[i] })), yLabel: "Employees (Count)",
      series: [{ label: "Joiners", values: joiners }, { label: "Leavers", values: leavers }],
      raw: raw([...joinersIn(pop, w), ...leaversIn(pop, w)], (e) => (e.leftOn && e.leftOn >= w.from && e.leftOn <= w.to ? `Left ${e.leftOn.toISOString().slice(0, 10)}` : `Joined ${e.dateOfJoining.toISOString().slice(0, 10)}`)),
      rawLabel: "Movement",
    } satisfies ChartData,
    retained: raw(openers.filter((e) => onBooks(e, w.to)), (e) => e.department),
    leaversRaw: raw(leaversIn(pop, w), (e) => (e.leftOn ? e.leftOn.toISOString().slice(0, 10) : "")),
  };
}

/** A KPI card on the Growth & Retention and Attrition Analysis pages. */
export interface PageKpi { key: string; label: string; value: string; meta: string; info: string; color: string; rawKey?: string; rawText?: string }

const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

/** Everything on Growth & Retention: KPI cards and five charts, from one population. */
export function growthPage(pop: PopEmployee[], w: Window, asOf: Date): { kpis: PageKpi[]; charts: ChartData[] } {
  const g = growthData(pop, w);
  const k = g.kpis;
  const flow = monthlyFlow(pop, w);
  const nh = newHireRetention(pop, w, asOf);
  const byMonth = newHireRetentionByMonth(pop, w, asOf);
  const lowest = [...flow].sort((a, b) => a.retentionPct - b.retentionPct)[0];
  const retention: ChartData = {
    key: "gr-retention", title: "Retention Rate", kind: "bar", pct: true, yLabel: "Retained (%)", legend: "Retention Rate",
    info: "Of the people on the books on the first day of each month, the share still on the books on its last day.",
    rows: flow.map((m) => ({ label: m.label, value: m.retentionPct })),
    insights: [
      { label: "Retained over the range", value: `${Math.round(k.retentionRate * 1000) / 10}%` },
      { label: "Lowest month", value: lowest ? `${lowest.label} · ${lowest.retentionPct}%` : "—" },
      { label: "Opening headcount", value: String(k.opening) },
    ],
    raw: g.retained, rawLabel: "Department",
  };
  const newHire: ChartData = {
    key: "gr-newhire", title: `New-hire ${NEW_HIRE_DAYS}-day Retention`, kind: "grouped", yLabel: "Hires (Count)", xLabel: "Joining month",
    info: `People who joined in each month: still here ${NEW_HIRE_DAYS} days after joining, or gone before. Hires from the last ${NEW_HIRE_DAYS} days are not judged yet.`,
    rows: byMonth.map((m) => ({ label: m.label, value: m.matured })),
    series: [{ label: "Retained", values: byMonth.map((m) => m.retained) }, { label: `Left within ${NEW_HIRE_DAYS} days`, values: byMonth.map((m) => m.left) }],
    insights: [
      { label: `${NEW_HIRE_DAYS}-day retention`, value: nh.ratePct === null ? "—" : `${nh.ratePct}%` },
      { label: "Hires judged", value: `${nh.matured} of ${nh.hires}` },
      { label: `Left within ${NEW_HIRE_DAYS} days`, value: String(nh.left) },
    ],
    raw: raw(joinersIn(pop, w), (e) => {
      const probe = probeDay(e.dateOfJoining);
      if (probe.getTime() > asOf.getTime()) return `Joined ${ymdOf(e.dateOfJoining)} · too recent`;
      return onBooks(e, probe) ? `Joined ${ymdOf(e.dateOfJoining)} · retained` : `Joined ${ymdOf(e.dateOfJoining)} · left ${ymdOf(e.leftOn!)}`;
    }),
    rawLabel: "Outcome",
  };
  const tenure = dimChart("gr-tenure", "Tenure Distribution", "People on the books on the last day of the range, by years in the organisation.", "tenure",
    pop.filter((e) => onBooks(e, w.to)), { from: w.to, to: w.to }, { xLabel: "Years in Organisation" });
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const net = k.closing - k.opening;
  const kpis: PageKpi[] = [
    { key: "headcount", label: "Headcount", value: String(k.closing), meta: `${k.opening} at the start · ${net >= 0 ? "+" : ""}${net}`, info: "People on the books on the last day of the range.", color: "#5bc0d0" },
    { key: "growth", label: "Net Growth", value: `${r1(k.growthRate * 100)}%`, meta: `${k.joiners} joined · ${k.leavers} left`, info: "(Closing − opening) ÷ opening headcount.", color: "#9b87c4", rawKey: "gr-leavers", rawText: "View leavers" },
    { key: "retention", label: "Retention Rate", value: `${r1(k.retentionRate * 100)}%`, meta: `${k.retained} of ${k.opening} still here`, info: "Share of the people on the books at the start of the range who are still on the books at its end.", color: "#7cc47f", rawKey: "gr-retained", rawText: "View employees" },
    { key: "newhire", label: `New-hire ${NEW_HIRE_DAYS}-day Retention`, value: nh.ratePct === null ? "—" : `${nh.ratePct}%`, meta: nh.matured ? `${nh.retained} of ${nh.matured} hires · ${nh.pending} too recent` : `${nh.pending} hire${nh.pending === 1 ? "" : "s"} too recent to judge`, info: `Hires in the range still on the books ${NEW_HIRE_DAYS} days after joining.`, color: "#f2c744", rawKey: "gr-newhire", rawText: "View hires" },
  ];
  return { kpis, charts: [g.growthChart, g.flowChart, retention, newHire, tenure] };
}

// ---------------------------------------------------------------------------
//  Attrition Analysis
// ---------------------------------------------------------------------------

export const ATTRITION_VIEWS: Array<{ view: string; label: string; group: "time" | "demo"; dim?: Dimension; kind: ChartKind; title: string; xLabel?: string }> = [
  { view: "overall", label: "Overall Attrition", group: "time", kind: "area", title: "Overall Attrition" },
  { view: "rate", label: "Monthly & Annualised Rate", group: "time", kind: "combo", title: "Attrition Rate" },
  { view: "tenure", label: "Years in Organisation", group: "time", dim: "tenure", kind: "bar", title: "Attrition by Years in Organisation", xLabel: "Years in Organisation" },
  { view: "since-raise", label: "Months since Salary Revision", group: "time", dim: "sinceRaise", kind: "bar", title: "Attrition by Months since Salary Revision", xLabel: "Months since last revision" },
  { view: "age", label: "Age", group: "demo", dim: "age", kind: "bar", title: "Attrition by Age", xLabel: "Age in Years" },
  { view: "gender", label: "Gender", group: "demo", dim: "gender", kind: "donut", title: "Attrition by Gender" },
  { view: "exit-type", label: "Exit Type", group: "demo", dim: "exitType", kind: "donut", title: "Exit Type" },
  { view: "kind", label: "Voluntary vs Involuntary", group: "demo", dim: "exitKind", kind: "donut", title: "Voluntary vs Involuntary" },
  { view: "exit-reason", label: "Exit Reason", group: "demo", dim: "exitReason", kind: "bar", title: "Exit Reason", xLabel: "Exit Reason" },
  { view: "regretted", label: "Regretted Exits", group: "demo", dim: "department", kind: "bar", title: "Regretted Exits", xLabel: "Department" },
  { view: "performance", label: "Performance Rating", group: "demo", dim: "performance", kind: "bar", title: "Performance Rating", xLabel: "Performance Rating" },
  { view: "department", label: "Department", group: "demo", dim: "department", kind: "bar", title: "Attrition by Department", xLabel: "Department" },
  { view: "location", label: "Location", group: "demo", dim: "location", kind: "bar", title: "Attrition by Location", xLabel: "Location" },
  { view: "manager", label: "Manager", group: "demo", dim: "manager", kind: "bar", title: "Attrition by Manager", xLabel: "Reporting manager" },
];

/** Views whose groups have a headcount, so a rate per group means something. */
export const RATE_TABLE_VIEWS = new Set(["tenure", "department", "location", "manager"]);

/** Voluntary exits by people rated at or above REGRET_RATING on their last day. */
export function regrettedLeavers(leavers: PopEmployee[]): PopEmployee[] {
  return leavers.filter((e) => isRegretted(e, ratingAt(e, e.leftOn!)));
}

const pct1 = (n: number) => `${Math.round(n * 10) / 10}%`;

export function attritionChart(view: string, pop: PopEmployee[], w: Window, f: AnalyticsFilters, measure: "count" | "pct" = "count"): ChartData | null {
  const def = ATTRITION_VIEWS.find((v) => v.view === view);
  if (!def) return null;
  const leavers = leaversFor(pop, w, f);
  if (def.view === "overall") {
    const months = monthsIn(w);
    const counts = months.map((m) => leavers.filter((e) => e.leftOn! >= m.start && e.leftOn! <= m.end).length);
    const heads = months.map((m) => headcountAt(pop, m.start));
    const values = measure === "pct" ? counts.map((c, i) => (heads[i] ? Math.round((c / heads[i]) * 10000) / 100 : 0)) : counts;
    const rows = months.map((m, i) => ({ label: m.label, value: values[i] }));
    const total = counts.reduce((s, c) => s + c, 0);
    let hi = 0, lo = 0;
    counts.forEach((c, i) => { if (c > counts[hi]) hi = i; if (c < counts[lo]) lo = i; });
    const label = (i: number) => (measure === "pct" ? `${months[i]?.label ?? "—"} · ${pct1(values[i] ?? 0)}` : `${months[i]?.label ?? "—"} · ${counts[i] ?? 0}`);
    return {
      key: "at-overall", title: def.title, info: "People whose last working day fell in each month.", kind: "area", rows, pct: measure === "pct",
      yLabel: measure === "pct" ? "Employees (%)" : "Employees (Count)", legend: measure === "pct" ? "Attrition Rate" : "Attrition Employee Count",
      insights: [
        { label: "Total attrition", value: String(total) },
        { label: measure === "pct" ? "Highest attrition month & %age" : "Highest attrition month & count", value: months.length ? label(hi) : "—" },
        { label: measure === "pct" ? "Lowest attrition month & %age" : "Lowest attrition month & count", value: months.length ? label(lo) : "—" },
        { label: "Average attrition/month", value: months.length ? String(Math.round((total / months.length) * 10) / 10) : "0" },
      ],
      raw: raw(leavers, (e) => e.leftOn!.toISOString().slice(0, 10)), rawLabel: "Last working day",
    };
  }
  if (def.view === "rate") {
    // Bars: leavers ÷ average headcount in the month. Line: the same over the
    // twelve months ending that month, which is the annualised figure.
    const months = monthsIn(w);
    const monthly = months.map((m) => {
      const mw = { from: m.start, to: m.end };
      const avg = (headcountAt(pop, m.start) + headcountAt(pop, m.end)) / 2;
      return avg ? Math.round((leaversFor(pop, mw, f).length / avg) * 1000) / 10 : 0;
    });
    const trailing = months.map((m) => {
      const tw = { from: new Date(Date.UTC(m.year, m.month - 12, 1)), to: m.end };
      return annualisedRate(leaversFor(pop, tw, f).length, averageHeadcount(pop, tw), 12);
    });
    const ann = annualisedRate(leavers.length, averageHeadcount(pop, w), windowMonths(w));
    return {
      key: "at-rate", title: def.title, kind: "combo", pct: true, yLabel: "Monthly attrition (%)", legend: "Monthly rate",
      info: "Bars: leavers in the month ÷ average headcount that month. Line: leavers in the twelve months to that month ÷ their average headcount.",
      rows: months.map((m, i) => ({ label: m.label, value: monthly[i] })),
      line: { label: "Annualised (trailing 12 months)", values: trailing, axisLabel: "Annualised (%)" },
      insights: [
        { label: "Annualised over the range", value: `${ann}%` },
        { label: "Average monthly rate", value: pct1(ann / 12) },
        { label: "Latest trailing 12 months", value: trailing.length ? `${trailing[trailing.length - 1]}%` : "—" },
      ],
      raw: raw(leavers, (e) => e.leftOn!.toISOString().slice(0, 10)), rawLabel: "Last working day",
    };
  }
  if (def.view === "regretted") {
    const voluntary = leavers.filter((e) => exitKind(e) === "Voluntary");
    const regretted = regrettedLeavers(leavers);
    const unrated = voluntary.filter((e) => ratingAt(e, e.leftOn!) === null).length;
    const c = dimChart("at-regretted", def.title, `Voluntary exits by people whose last final rating was ${REGRET_RATING} or higher, by department. There is no separate "regretted" flag on an exit, so the rating decides.`,
      "department", regretted, w, { xLabel: def.xLabel, legend: "Regretted exits", dropEmpty: true });
    c.raw = raw(regretted, (e) => `${e.department} · rated ${ratingAt(e, e.leftOn!)}`);
    c.rawLabel = "Department and rating";
    c.insights = [
      { label: "Regretted exits", value: String(regretted.length) },
      { label: "Share of voluntary exits", value: voluntary.length ? pct1((regretted.length / voluntary.length) * 100) : "—" },
      { label: "Voluntary exits with no rating", value: String(unrated) },
    ];
    return c;
  }
  const c = dimChart(`at-${def.view}`, def.title, `People who left in the range, by ${DIM_LABEL[def.dim!].toLowerCase()} on their last day.`, def.dim!, leavers, w,
    { kind: def.kind, xLabel: def.xLabel, legend: "Attrition Count", dropEmpty: def.dim === "age" || def.dim === "exitReason" });
  const total = leavers.length;
  c.insights = def.kind === "donut"
    ? c.rows.filter((r) => r.value > 0).map((r) => ({ label: `Attrition by ${r.label} ${def.dim === "exitType" || def.dim === "exitKind" ? "%age" : "count"}`, value: def.dim === "exitType" || def.dim === "exitKind" ? pct1(total ? (r.value / total) * 100 : 0) : String(r.value) }))
    : (() => {
        const top = [...c.rows].sort((a, b) => b.value - a.value)[0];
        return [
          { label: "Total attrition", value: String(total) },
          { label: `Highest ${DIM_LABEL[def.dim!].toLowerCase()}`, value: top && top.value ? `${top.label} · ${top.value}` : "—" },
          { label: "Share of exits", value: top && total ? pct1((top.value / total) * 100) : "—" },
        ];
      })();
  return c;
}

/** KPI cards over Attrition Analysis, from the same leavers as the charts. */
export function attritionPageKpis(pop: PopEmployee[], w: Window, f: AnalyticsFilters): PageKpi[] {
  const leavers = leaversFor(pop, w, f);
  const avg = averageHeadcount(pop, w);
  const n = windowMonths(w);
  const by = (k: string) => leavers.filter((e) => exitKind(e) === k).length;
  const vol = by("Voluntary"), invol = by("Involuntary");
  const regretted = regrettedLeavers(leavers).length;
  return [
    { key: "rate", label: "Annualised Attrition", value: `${annualisedRate(leavers.length, avg, n)}%`, meta: `${leavers.length} left · average headcount ${Math.round(avg)}`, info: `Leavers ÷ average headcount, scaled to a year (× 12 ÷ ${n}).`, color: "#e8735a", rawKey: "at-overall", rawText: "View leavers" },
    { key: "voluntary", label: "Voluntary Attrition", value: `${annualisedRate(vol, avg, n)}%`, meta: `${vol} voluntary · ${invol} involuntary · ${leavers.length - vol - invol} other`, info: "Exits the person chose (by exit reason, else resignations), annualised.", color: "#9b87c4", rawKey: "at-kind", rawText: "View exits" },
    { key: "monthly", label: "Average Monthly Rate", value: `${Math.round((annualisedRate(leavers.length, avg, n) / 12) * 10) / 10}%`, meta: `${Math.round((leavers.length / n) * 10) / 10} leavers a month`, info: "Leavers ÷ average headcount, per month of the range.", color: "#5bc0d0" },
    { key: "regretted", label: "Regretted Exits", value: String(regretted), meta: vol ? `${Math.round((regretted / vol) * 100)}% of voluntary exits` : "No voluntary exits", info: `Voluntary exits by people whose last final rating was ${REGRET_RATING} or higher.`, color: "#f2c744", rawKey: "at-regretted", rawText: "View exits" },
  ];
}

/** Headcount, leavers and annualised rate per group, for the views that have one. */
export function attritionRateTable(view: string, pop: PopEmployee[], w: Window, f: AnalyticsFilters): GroupAttrition[] | null {
  const def = ATTRITION_VIEWS.find((v) => v.view === view);
  if (!def?.dim || !RATE_TABLE_VIEWS.has(view)) return null;
  const dim = def.dim;
  return attritionByGroup(pop, leaversFor(pop, w, f), w, (e, at) => dimValue(dim, e, at), ORDER[dim]);
}

// ---------------------------------------------------------------------------
//  Storyboards
// ---------------------------------------------------------------------------

export const ATTRITION_WIDGETS: Array<{ widget: string; title: string; dim: Dimension; info: string; prompts: string[] }> = [
  { widget: "department", title: "Department wise", dim: "department", info: "Exits in the period by department.", prompts: ["department"] },
  { widget: "tenure", title: "Organisation tenure", dim: "tenure", info: "Exits by years in the organisation on the last day.", prompts: ["tenure"] },
  { widget: "exit-reason", title: "Exit reason", dim: "exitReason", info: "Exits by the reason recorded at exit.", prompts: ["exit reason"] },
  { widget: "location", title: "Location wise", dim: "location", info: "Exits by work location.", prompts: ["location"] },
  { widget: "performance", title: "Performance", dim: "performance", info: "Exits by the last final rating before leaving.", prompts: ["performance band"] },
  { widget: "since-raise", title: "Months since last raise", dim: "sinceRaise", info: "Exits by months since the person's last salary raise.", prompts: ["raise gap"] },
];

export const HEADCOUNT_WIDGETS: Array<{ widget: string; title: string; dim: Dimension; info: string }> = [
  { widget: "department", title: "Department wise", dim: "department", info: "Headcount at the end of the period by department." },
  { widget: "location", title: "Location wise", dim: "location", info: "Headcount by work location." },
  { widget: "tenure", title: "Organisation tenure", dim: "tenure", info: "Headcount by years in the organisation." },
  { widget: "worker", title: "Worker type", dim: "worker", info: "Headcount by worker type." },
  { widget: "gender", title: "Gender", dim: "gender", info: "Headcount by gender." },
];

export const GROUP_BYS: Array<{ value: Dimension; label: string }> = [
  { value: "gender", label: "Gender" }, { value: "worker", label: "Worker type" }, { value: "tenure", label: "Tenure" },
  { value: "exitType", label: "Exit type" }, { value: "performance", label: "Rating" },
];

export function attritionWidget(widget: string, pop: PopEmployee[], w: Window, f: AnalyticsFilters, groupBy: Dimension | null): ChartData | null {
  const def = ATTRITION_WIDGETS.find((x) => x.widget === widget);
  if (!def) return null;
  const leavers = leaversFor(narrow(pop, f, ["dept", "loc", "wt"]), w, f);
  return dimChart(`sb-${widget}`, def.title, def.info, def.dim, leavers, w, { yLabel: "Employee Count", groupBy, dropEmpty: def.dim !== "tenure" && def.dim !== "sinceRaise" && def.dim !== "performance" });
}

export function headcountWidget(widget: string, pop: PopEmployee[], w: Window, f: AnalyticsFilters, groupBy: Dimension | null): ChartData | null {
  const def = HEADCOUNT_WIDGETS.find((x) => x.widget === widget);
  if (!def) return null;
  const onDay = narrow(pop, f, ["dept", "loc", "wt"]).filter((e) => onBooks(e, w.to));
  return dimChart(`hb-${widget}`, def.title, def.info, def.dim, onDay, { from: w.to, to: w.to }, { yLabel: "Employee Count", groupBy: groupBy === "exitType" ? null : groupBy });
}

export interface Kpi { key: string; label: string; value: string; delta: number; deltaText: string; deltaUnit: string; spark: number[]; info: string; meta?: string }

/** Storyboard KPI cards: this period vs the previous one of equal length, with a 12-point sparkline. */
export function attritionKpis(pop: PopEmployee[], w: Window): Kpi[] {
  const n = windowMonths(w);
  const stats = (win: Window) => {
    const avg = averageHeadcount(pop, win) || 1;
    const left = leaversIn(pop, win);
    const vol = left.filter((e) => e.exitType === "RESIGNATION").length;
    const early = left.filter((e) => monthsBetween(e.dateOfJoining, e.leftOn!) < 12).length;
    const ann = 12 / windowMonths(win);
    return { rate: (left.length / avg) * 100 * ann, left: left.length, vol: (vol / avg) * 100 * ann, early, earlyShare: left.length ? (early / left.length) * 100 : 0 };
  };
  const cur = stats(w), prev = stats(previousWindow(w));
  // Sparkline: the same KPI over the 12 windows ending at each of the last 12 month-ends.
  const ends = monthsIn({ from: new Date(Date.UTC(w.to.getUTCFullYear(), w.to.getUTCMonth() - 11, 1)), to: w.to }).map((m) => m.end);
  const trail = ends.map((end) => {
    const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - n + 1, 1));
    return stats({ from, to: end });
  });
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [
    { key: "rate", label: "Overall Attrition rate", value: `${r1(cur.rate)}%`, delta: r1(cur.rate - prev.rate), deltaText: `${Math.abs(r1(cur.rate - prev.rate))}%`, deltaUnit: `in ${n} months`, spark: trail.map((s) => r1(s.rate)), info: `Leavers ÷ average headcount, annualised (× 12 ÷ ${n}).` },
    { key: "exited", label: "Exited Employees", value: String(cur.left), delta: cur.left - prev.left, deltaText: String(Math.abs(cur.left - prev.left)), deltaUnit: `in ${n} months`, spark: trail.map((s) => s.left), info: "People whose last working day fell in the period." },
    { key: "voluntary", label: "Voluntary Attrition rate", value: `${r1(cur.vol)}%`, delta: r1(cur.vol - prev.vol), deltaText: `${Math.abs(r1(cur.vol - prev.vol))}%`, deltaUnit: `in ${n} months`, spark: trail.map((s) => r1(s.vol)), info: "Resignations only, annualised." },
    { key: "early", label: "Early Attrition", value: String(cur.early), delta: cur.early - prev.early, deltaText: String(Math.abs(cur.early - prev.early)), deltaUnit: `in ${n} months`, spark: trail.map((s) => s.early), info: "Leavers with under 12 months' tenure.", meta: `${r1(cur.earlyShare)}% of exits` },
  ];
}

export function headcountKpis(pop: PopEmployee[], w: Window): Kpi[] {
  const n = windowMonths(w);
  const prevW = previousWindow(w);
  const cur = growthKpis(pop, w), prev = growthKpis(pop, prevW);
  const ends = monthsIn({ from: new Date(Date.UTC(w.to.getUTCFullYear(), w.to.getUTCMonth() - 11, 1)), to: w.to }).map((m) => m.end);
  const trail = ends.map((end) => growthKpis(pop, { from: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - n + 1, 1)), to: end }));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [
    { key: "headcount", label: "Headcount", value: String(cur.closing), delta: cur.closing - prev.closing, deltaText: String(Math.abs(cur.closing - prev.closing)), deltaUnit: `in ${n} months`, spark: trail.map((s) => s.closing), info: "People on the books on the last day of the period." },
    { key: "joiners", label: "Joiners", value: String(cur.joiners), delta: cur.joiners - prev.joiners, deltaText: String(Math.abs(cur.joiners - prev.joiners)), deltaUnit: `in ${n} months`, spark: trail.map((s) => s.joiners), info: "People who joined in the period." },
    { key: "leavers", label: "Leavers", value: String(cur.leavers), delta: cur.leavers - prev.leavers, deltaText: String(Math.abs(cur.leavers - prev.leavers)), deltaUnit: `in ${n} months`, spark: trail.map((s) => s.leavers), info: "People whose last working day fell in the period." },
    { key: "growth", label: "Net Growth", value: `${r1(cur.growthRate * 100)}%`, delta: r1((cur.growthRate - prev.growthRate) * 100), deltaText: `${Math.abs(r1((cur.growthRate - prev.growthRate) * 100))}%`, deltaUnit: `in ${n} months`, spark: trail.map((s) => r1(s.growthRate * 100)), info: "(Closing − opening) ÷ opening headcount." },
  ];
}

// ---------------------------------------------------------------------------
//  The AI digest: aggregates only
// ---------------------------------------------------------------------------

export interface Digest {
  board: "attrition" | "headcount" | "risk";
  widget?: string;
  period: { from: string; to: string; months: number };
  previous: { from: string; to: string };
  filters: Record<string, string[]>;
  kpis: { avgHeadcount: number; leavers: number; leaversPrev: number; attritionPct: number; attritionPrevPct: number; voluntaryPct: number; earlyLeavers: number };
  monthly: Array<{ month: string; headcount: number; leavers: number; voluntary: number }>;
  breakdowns: Record<string, Array<{ label: string; headcount?: number; leavers: number; ratePct?: number }>>;
  risk?: { high: number; medium: number; low: number; byDepartment: Array<{ label: string; high: number; medium: number }>; topDrivers: Array<{ factor: string; sharePct: number }> };
  note: string;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const r1 = (x: number) => Math.round(x * 10) / 10;

export function buildDigest(board: Digest["board"], pop: PopEmployee[], w: Window, filterLabels: Record<string, string[]>, widget?: string): Digest {
  const prevW = previousWindow(w);
  const n = windowMonths(w);
  const ann = 12 / n;
  const avg = averageHeadcount(pop, w) || 1;
  const left = leaversIn(pop, w), leftPrev = leaversIn(pop, prevW);
  const avgPrev = averageHeadcount(pop, prevW) || 1;
  const monthly = monthsIn(w).map((m) => {
    const l = leaversIn(pop, { from: m.start, to: m.end });
    return { month: m.label, headcount: headcountAt(pop, m.end), leavers: l.length, voluntary: l.filter((e) => e.exitType === "RESIGNATION").length };
  });
  // Static dimensions: group headcount and rates, small groups merged.
  const withRates = (dim: Dimension) => {
    const labels = new Set(pop.filter((e) => onBooks(e, w.to) || left.includes(e)).map((e) => dimValue(dim, e, asAt(e, w))));
    return suppressSmall([...labels].map((label) => {
      const members = pop.filter((e) => dimValue(dim, e, asAt(e, w)) === label);
      return { label, headcount: Math.round(averageHeadcount(members, w)), leavers: left.filter((e) => dimValue(dim, e, asAt(e, w)) === label).length };
    }));
  };
  // Leaver-only breakdowns: counts of exits, no individual attributes.
  const leaversBy = (dim: Dimension) => countBy(left, (e) => dimValue(dim, e, e.leftOn!), ORDER[dim], true).map((r) => ({ label: r.label, leavers: r.value }));
  const breakdowns: Digest["breakdowns"] = {
    department: withRates("department"), location: withRates("location"), workerType: withRates("worker"), gender: withRates("gender"),
    tenure: leaversBy("tenure"), sinceRaise: leaversBy("sinceRaise"), exitType: leaversBy("exitType"), exitReason: leaversBy("exitReason"),
    performance: leaversBy("performance"), ageBand: leaversBy("age"),
  };
  return {
    board, widget,
    period: { from: ymd(w.from), to: ymd(w.to), months: n },
    previous: { from: ymd(prevW.from), to: ymd(prevW.to) },
    filters: filterLabels,
    kpis: {
      avgHeadcount: r1(avg), leavers: left.length, leaversPrev: leftPrev.length,
      attritionPct: r1((left.length / avg) * 100 * ann), attritionPrevPct: r1((leftPrev.length / avgPrev) * 100 * ann),
      voluntaryPct: r1((left.filter((e) => e.exitType === "RESIGNATION").length / avg) * 100 * ann),
      earlyLeavers: left.filter((e) => monthsBetween(e.dateOfJoining, e.leftOn!) < 12).length,
    },
    monthly,
    breakdowns,
    note: "Attrition percentages are annualised. Groups under 3 people are merged into 'Other'. No individual records are included.",
  };
}

/** The non-AI summary: fixed sentences filled from the same digest. */
export function computedSummary(d: Digest): string[] {
  const out: string[] = [];
  const diff = d.kpis.leavers - d.kpis.leaversPrev;
  out.push(`${d.kpis.leavers} ${d.kpis.leavers === 1 ? "person" : "people"} left in the last ${d.period.months} months (${diff === 0 ? "the same as" : `${diff > 0 ? "↑" : "↓"} ${Math.abs(diff)} vs`} the previous ${d.period.months}).`);
  out.push(`Annualised attrition is ${d.kpis.attritionPct}% (previous period ${d.kpis.attritionPrevPct}%); voluntary attrition is ${d.kpis.voluntaryPct}%.`);
  const dept = [...d.breakdowns.department].filter((r) => r.label !== "Other").sort((a, b) => b.leavers - a.leavers)[0];
  if (dept && dept.leavers) out.push(`${dept.label} lost the most people: ${dept.leavers} of about ${dept.headcount}.`);
  const reason = [...d.breakdowns.exitReason].sort((a, b) => b.leavers - a.leavers)[0];
  if (reason && d.kpis.leavers) out.push(`The most common exit reason was ${reason.label} (${Math.round((reason.leavers / d.kpis.leavers) * 100)}% of exits).`);
  const stale = d.breakdowns.sinceRaise.filter((r) => ["18-24", "24+"].includes(r.label)).reduce((s, r) => s + r.leavers, 0);
  if (d.kpis.leavers) out.push(`${stale} of the ${d.kpis.leavers} leavers had gone 18 months or more without a raise; ${d.kpis.earlyLeavers} left within their first year.`);
  return out;
}

export function dayString(d: Date): string { return utcDay(d).toISOString().slice(0, 10); }

/** Any chart by its key, for the raw-data drawer and the export route. */
export function chartByKey(key: string, pop: PopEmployee[], w: Window, f: AnalyticsFilters, opts: { measure?: "count" | "pct"; groupBy?: Dimension | null; asOf?: Date; today?: Date } = {}): ChartData | null {
  if (key.startsWith("hc-")) return headcountChart(key, pop, opts.asOf ? { from: opts.asOf, to: opts.asOf } : w);
  if (key === "gr-growth" || key === "gr-flow" || key === "gr-retained" || key === "gr-leavers") {
    const g = growthData(pop, w);
    if (key === "gr-growth") return g.growthChart;
    if (key === "gr-flow") return g.flowChart;
    const base = { info: "", kind: "bar" as ChartKind, rows: [] as ChartRow[] };
    return key === "gr-retained"
      ? { ...base, key, title: "Retained employees", raw: g.retained, rawLabel: "Department" }
      : { ...base, key, title: "Employees who left", raw: g.leaversRaw, rawLabel: "Last working day" };
  }
  if (key === "gr-retention" || key === "gr-newhire" || key === "gr-tenure") return growthPage(pop, w, opts.today ?? utcDay(new Date())).charts.find((c) => c.key === key) ?? null;
  if (key.startsWith("at-")) return attritionChart(key.slice(3), pop, w, f, opts.measure ?? "count");
  if (key.startsWith("sb-")) return attritionWidget(key.slice(3), pop, w, f, opts.groupBy ?? null);
  if (key.startsWith("hb-")) return headcountWidget(key.slice(3), pop, w, f, opts.groupBy ?? null);
  return null;
}

export function parseGroupBy(v: unknown): Dimension | null {
  return typeof v === "string" && GROUP_BYS.some((g) => g.value === v) ? (v as Dimension) : null;
}
