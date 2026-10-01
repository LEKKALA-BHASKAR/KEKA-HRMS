/**
<<<<<<< HEAD
 * Pure workforce arithmetic — no database. Headcount over time, joiners and
 * leavers, attrition, and the tenure and age bands the dashboards group by.
 *
 * Every figure is computed from effective dates (joining and last working
 * day), not from today's status, so last March's headcount is what it was in
 * March even for someone who has since left.
 */

export interface WorkforceRow {
  id: string;
  dateOfJoining: Date;
  /** Set once someone has left — or is leaving, for those on notice. */
  lastWorkingDay: Date | null;
  exited: boolean;
  dateOfBirth?: Date | null;
}

export interface MonthPoint {
  /** yyyy-mm */
  key: string;
  label: string;
  year: number;
  month: number;
  headcount: number;
  joiners: number;
  leavers: number;
  /** Leavers ÷ average of opening and closing headcount, in percent. */
  attritionPct: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Was this person on the books at the end of the given UTC day? */
export function activeOn(e: WorkforceRow, day: Date): boolean {
  if (e.dateOfJoining.getTime() > day.getTime()) return false;
  // Someone on notice is still employed until their last day.
  if (e.exited && e.lastWorkingDay && e.lastWorkingDay.getTime() < day.getTime()) return false;
  return true;
}

/** The last `months` calendar months ending with the month containing `asOf`. */
export function monthlySeries(rows: WorkforceRow[], asOf: Date, months = 12): MonthPoint[] {
  const out: MonthPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const y = asOf.getUTCFullYear(), m = asOf.getUTCMonth() - i;
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    const close = end.getTime() > asOf.getTime() ? asOf : end;
    const dayBefore = new Date(start.getTime() - 86_400_000);
    const opening = rows.filter((e) => activeOn(e, dayBefore)).length;
    const headcount = rows.filter((e) => activeOn(e, close)).length;
    const joiners = rows.filter((e) => e.dateOfJoining >= start && e.dateOfJoining <= close).length;
    const leavers = rows.filter((e) => e.exited && e.lastWorkingDay && e.lastWorkingDay >= start && e.lastWorkingDay <= close).length;
    const avg = (opening + headcount) / 2;
    out.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      label: `${MONTHS[start.getUTCMonth()]} ${String(start.getUTCFullYear()).slice(2)}`,
      year: start.getUTCFullYear(), month: start.getUTCMonth() + 1,
      headcount, joiners, leavers,
      attritionPct: avg === 0 ? 0 : r1((leavers / avg) * 100),
    });
=======
 * Org analytics, pure: who counts as a leaver and when, headcount at a date,
 * rates over a window, the bands every chart groups by, the attrition-risk
 * model (risk-v1) and the guards around what an AI model is shown.
 *
 * Nothing here touches the database, so the numbers on screen, in the CSV
 * and in the AI payload all come from the same definitions and can be tested
 * in isolation.
 */

export const DAY = 86_400_000;

export const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const monthStartUtc = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1));
export const monthEndUtc = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whole months between two dates (floor), e.g. for tenure or "since raise". */
export function monthsBetween(from: Date, to: Date): number {
  let m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

export function yearsBetween(from: Date, to: Date): number {
  return monthsBetween(from, to) / 12;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Leavers and headcount
// ---------------------------------------------------------------------------

/** Exit statuses that mean the person is going (or gone), not withdrawn. */
export const LEAVING_EXIT_STATUSES = ["APPROVED", "IN_CLEARANCE", "SETTLED", "COMPLETED"] as const;
/** Exit statuses that end an exit without the person leaving. */
export const WITHDRAWN_EXIT_STATUSES = ["CANCELLED", "RETAINED", "REJECTED"] as const;

/**
 * The day someone left, or will leave: their last working day, once the exit
 * is approved (or they are EXITED). Null for anyone not leaving.
 */
export function leavingDate(e: {
  status: string;
  lastWorkingDay: Date | null;
  exitRecord?: { status: string; lastWorkingDay: Date } | null;
}): Date | null {
  const approved = !!e.exitRecord && (LEAVING_EXIT_STATUSES as readonly string[]).includes(e.exitRecord.status);
  if (!approved && e.status !== "EXITED") return null;
  return utcDay(e.exitRecord?.lastWorkingDay ?? e.lastWorkingDay ?? new Date(0));
}

export interface PopMember {
  id: string;
  dateOfJoining: Date;
  status: string;
  /** From `leavingDate`. */
  leftOn: Date | null;
}

/** On the books on day d: joined by d and not gone before d. */
export function onBooks(e: PopMember, d: Date): boolean {
  if (e.status === "PREBOARDING") return false;
  if (utcDay(e.dateOfJoining).getTime() > d.getTime()) return false;
  return !(e.leftOn && e.leftOn.getTime() < d.getTime());
}

export function headcountAt(pop: PopMember[], d: Date): number {
  let n = 0;
  for (const e of pop) if (onBooks(e, d)) n++;
  return n;
}

export interface Window { from: Date; to: Date }

/** Calendar months a window touches, oldest first. */
export function monthsIn(w: Window): Array<{ year: number; month: number; start: Date; end: Date; label: string }> {
  const out: Array<{ year: number; month: number; start: Date; end: Date; label: string }> = [];
  let y = w.from.getUTCFullYear(), m = w.from.getUTCMonth() + 1;
  for (let guard = 0; guard < 240; guard++) {
    const start = monthStartUtc(y, m);
    if (start.getTime() > w.to.getTime()) break;
    const end = monthEndUtc(y, m);
    out.push({
      year: y, month: m,
      start: start.getTime() < w.from.getTime() ? w.from : start,
      end: end.getTime() > w.to.getTime() ? w.to : end,
      label: `${MONTH_ABBR[m - 1]}-${y}`,
    });
    m++; if (m > 12) { m = 1; y++; }
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
  }
  return out;
}

<<<<<<< HEAD
/**
 * Trailing-twelve-month attrition: leavers in the window over the average
 * month-end headcount across it. The figure HR quotes as "annual attrition".
 */
export function annualAttrition(series: MonthPoint[]): number {
  if (series.length === 0) return 0;
  const leavers = series.reduce((s, p) => s + p.leavers, 0);
  const avg = series.reduce((s, p) => s + p.headcount, 0) / series.length;
  return avg === 0 ? 0 : r1((leavers / avg) * 100 * (12 / series.length));
}

export const TENURE_BANDS = ["< 6 months", "6–12 months", "1–2 years", "2–5 years", "5+ years"] as const;
export const AGE_BANDS = ["Under 25", "25–34", "35–44", "45–54", "55+", "Not recorded"] as const;

export function yearsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365.25 * 86_400_000);
}

export function tenureBand(doj: Date, asOf: Date): (typeof TENURE_BANDS)[number] {
  const y = yearsBetween(doj, asOf);
  if (y < 0.5) return "< 6 months";
  if (y < 1) return "6–12 months";
  if (y < 2) return "1–2 years";
  if (y < 5) return "2–5 years";
  return "5+ years";
}

export function ageBand(dob: Date | null | undefined, asOf: Date): (typeof AGE_BANDS)[number] {
  if (!dob) return "Not recorded";
  const y = Math.floor(yearsBetween(dob, asOf));
  if (y < 25) return "Under 25";
  if (y < 35) return "25–34";
  if (y < 45) return "35–44";
  if (y < 55) return "45–54";
  return "55+";
}

/** Count rows into named groups, keeping a fixed order where one is given. */
export function tally<T>(rows: T[], key: (r: T) => string, order?: readonly string[]): Array<{ label: string; value: number }> {
  const m = new Map<string, number>();
  for (const k of order ?? []) m.set(k, 0);
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  const list = [...m.entries()].map(([label, value]) => ({ label, value }));
  return order ? list : list.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Average tenure in years, one decimal. */
export function averageTenure(rows: WorkforceRow[], asOf: Date): number {
  const active = rows.filter((e) => activeOn(e, asOf));
  if (active.length === 0) return 0;
  return r1(active.reduce((s, e) => s + yearsBetween(e.dateOfJoining, asOf), 0) / active.length);
}

/** Percentage change from one figure to the next; null when there is no base. */
export function pctChange(from: number, to: number): number | null {
  return from === 0 ? null : r1(((to - from) / from) * 100);
=======
/** Mean of the opening headcount and every month-end headcount in the window. */
export function averageHeadcount(pop: PopMember[], w: Window): number {
  const points = [headcountAt(pop, w.from), ...monthsIn(w).map((mo) => headcountAt(pop, mo.end))];
  return points.reduce((s, n) => s + n, 0) / points.length;
}

export function leaversIn<T extends PopMember>(pop: T[], w: Window): T[] {
  return pop.filter((e) => e.leftOn && e.leftOn.getTime() >= w.from.getTime() && e.leftOn.getTime() <= w.to.getTime());
}

export function joinersIn<T extends PopMember>(pop: T[], w: Window): T[] {
  return pop.filter((e) => e.status !== "PREBOARDING" && e.dateOfJoining.getTime() >= w.from.getTime() && e.dateOfJoining.getTime() <= w.to.getTime());
}

/** Whole months in a window, at least 1 — for annualising. */
export function windowMonths(w: Window): number {
  return Math.max(1, monthsIn(w).length);
}

export interface GrowthKpis {
  opening: number; closing: number; avgHeadcount: number; joiners: number; leavers: number;
  /** Fractions, not percentages. */
  growthRate: number; retentionRate: number; attritionRate: number;
  retained: number;
}

export function growthKpis(pop: PopMember[], w: Window): GrowthKpis {
  const opening = headcountAt(pop, w.from);
  const closing = headcountAt(pop, w.to);
  const avg = averageHeadcount(pop, w);
  const leavers = leaversIn(pop, w).length;
  const openers = pop.filter((e) => onBooks(e, w.from));
  const retained = openers.filter((e) => onBooks(e, w.to)).length;
  return {
    opening, closing, avgHeadcount: avg, joiners: joinersIn(pop, w).length, leavers,
    growthRate: opening ? (closing - opening) / opening : 0,
    retentionRate: openers.length ? retained / openers.length : 0,
    attritionRate: avg ? leavers / avg : 0,
    retained,
  };
}

/** Window ending on `to` and starting `months` whole months earlier. */
export function trailingWindow(to: Date, months: number): Window {
  const end = utcDay(to);
  const start = monthStartUtc(end.getUTCFullYear(), end.getUTCMonth() + 1 - months + 1);
  return { from: start, to: end };
}

/**
 * "Last N months" means the last N full calendar months before `today`:
 * on 1 Oct 2026, 3 months is 1 Jul – 30 Sep 2026.
 */
export function presetWindow(today: Date, months: number): Window {
  const t = utcDay(today);
  const to = monthEndUtc(t.getUTCFullYear(), t.getUTCMonth()); // last day of previous month
  const from = monthStartUtc(to.getUTCFullYear(), to.getUTCMonth() + 1 - months + 1);
  return { from, to };
}

/** The window of the same length immediately before `w`. */
export function previousWindow(w: Window): Window {
  const n = windowMonths(w);
  const to = new Date(w.from.getTime() - DAY);
  const from = monthStartUtc(to.getUTCFullYear(), to.getUTCMonth() + 1 - n + 1);
  return { from, to };
}

// ---------------------------------------------------------------------------
//  Bands
// ---------------------------------------------------------------------------

export const TENURE_BANDS = ["<1", "1-2", "2-3", "3-5", "5-10", "10+"] as const;
export function tenureBand(years: number): (typeof TENURE_BANDS)[number] {
  if (years < 1) return "<1";
  if (years < 2) return "1-2";
  if (years < 3) return "2-3";
  if (years < 5) return "3-5";
  if (years < 10) return "5-10";
  return "10+";
}

export const AGE_BANDS = ["<22", "22-25", "26-30", "31-40", "41-55", "55+"] as const;
export function ageBand(age: number): (typeof AGE_BANDS)[number] {
  if (age < 22) return "<22";
  if (age <= 25) return "22-25";
  if (age <= 30) return "26-30";
  if (age <= 40) return "31-40";
  if (age <= 55) return "41-55";
  return "55+";
}

export const SINCE_RAISE_BANDS = ["0-6", "6-12", "12-18", "18-24", "24+", "Never"] as const;
export function sinceRaiseBand(months: number | null): (typeof SINCE_RAISE_BANDS)[number] {
  if (months === null) return "Never";
  if (months < 6) return "0-6";
  if (months < 12) return "6-12";
  if (months < 18) return "12-18";
  if (months < 24) return "18-24";
  return "24+";
}

export const PERF_BINS = ["1-2", "2-3", "3-4", "4-5", "Not rated"] as const;
export function perfBin(rating: number | null): (typeof PERF_BINS)[number] {
  if (rating === null) return "Not rated";
  if (rating < 2) return "1-2";
  if (rating < 3) return "2-3";
  if (rating < 4) return "3-4";
  return "4-5";
}

/** Count members by a key, keeping a fixed order and dropping empty bins when asked. */
export function countBy<T>(items: T[], key: (t: T) => string, order?: readonly string[], dropEmpty = false): Array<{ label: string; value: number }> {
  const m = new Map<string, number>();
  for (const it of items) { const k = key(it); m.set(k, (m.get(k) ?? 0) + 1); }
  const labels = order ? [...order, ...[...m.keys()].filter((k) => !order.includes(k))] : [...m.keys()].sort((a, b) => (m.get(b)! - m.get(a)!) || a.localeCompare(b));
  return labels.map((label) => ({ label, value: m.get(label) ?? 0 })).filter((r) => !dropEmpty || r.value > 0);
}

// ---------------------------------------------------------------------------
//  Attrition risk: risk-v1
// ---------------------------------------------------------------------------

export const RISK_MODEL_VERSION = "risk-v1";
export const RISK_HIGH = 50;
export const RISK_MEDIUM = 30;
export type RiskBandName = "LOW" | "MEDIUM" | "HIGH";
export const riskBand = (score: number): RiskBandName => (score >= RISK_HIGH ? "HIGH" : score >= RISK_MEDIUM ? "MEDIUM" : "LOW");

/**
 * What the model looks at for one person on one day. `null` means the signal
 * has no data, which scores nothing and lowers coverage. Protected attributes
 * (gender, age, marital status…) are deliberately absent.
 */
export interface RiskFeatures {
  tenureMonths: number;
  /** Months since the last raise, or since joining if never raised. */
  monthsSinceRaise: number;
  /** Last raise as a fraction (0.08 = 8%); null if never raised. */
  lastRaisePct: number | null;
  /** CTC ÷ pay-grade midpoint; null without a grade midpoint or CTC. */
  compaRatio: number | null;
  latestRating: number | null;
  previousRating: number | null;
  activePip: boolean;
  managerChanges12m: number;
  managerLeaving: boolean;
  peerExits6m: number;
  shortNoticeLeaves90d: number | null;
  unexplainedAbsences60d: number | null;
  /** Fractional drop in average effective hours vs the prior 60 days. */
  hoursDropPct: number | null;
  praise180d: number | null;
  priorResignation: boolean;
}

export interface RiskFactor { key: string; label: string; points: number; max: number; detail: string; hasData: boolean }
export interface RiskResult { score: number; band: RiskBandName; coverage: number; factors: RiskFactor[] }

export const RISK_FACTORS: Array<{ key: string; label: string; max: number }> = [
  { key: "tenure_stage", label: "Tenure stage", max: 10 },
  { key: "months_since_raise", label: "Time since last raise", max: 18 },
  { key: "last_raise_small", label: "Small last raise", max: 4 },
  { key: "pay_below_grade_mid", label: "Pay below grade midpoint", max: 8 },
  { key: "performance", label: "Performance", max: 10 },
  { key: "rating_drop", label: "Rating dropped", max: 5 },
  { key: "active_pip", label: "On an improvement plan", max: 8 },
  { key: "manager_changes_12m", label: "Manager changes", max: 7 },
  { key: "manager_leaving", label: "Manager leaving", max: 5 },
  { key: "peer_exits_6m", label: "Teammates leaving", max: 6 },
  { key: "short_notice_leave_90d", label: "Short-notice leave", max: 7 },
  { key: "attendance_drift_60d", label: "Attendance drift", max: 5 },
  { key: "no_recognition_180d", label: "No recognition", max: 2 },
  { key: "prior_resignation", label: "Resigned before", max: 5 },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tenureText = (m: number) => (m < 12 ? plural(m, "month") : `${r1(m / 12)} years`);

export function scoreRisk(f: RiskFeatures): RiskResult {
  const out: RiskFactor[] = [];
  const add = (key: string, points: number, detail: string, hasData = true) => {
    const def = RISK_FACTORS.find((x) => x.key === key)!;
    out.push({ key, label: def.label, max: def.max, points: hasData ? points : 0, detail, hasData });
  };

  // Tenure: the 1–3 year stretch is where most people move on.
  const t = f.tenureMonths;
  const tenurePts = t < 6 ? 5 : t < 12 ? 8 : t < 36 ? 10 : t < 60 ? 5 : 2;
  add("tenure_stage", tenurePts, `${tenureText(t)} in the organisation`);

  const noRaise12 = f.monthsSinceRaise >= 12;
  if (t < 12) add("months_since_raise", 0, "Not yet due a first review");
  else {
    const m = f.monthsSinceRaise;
    const pts = m >= 24 ? 18 : m >= 18 ? 12 : m >= 12 ? 7 : 0;
    add("months_since_raise", pts, f.lastRaisePct === null ? `No raise since joining, ${plural(m, "month")} ago` : `${plural(m, "month")} since last raise`);
  }

  if (f.lastRaisePct === null) add("last_raise_small", 0, "No raise yet", false);
  else {
    const p = f.lastRaisePct;
    add("last_raise_small", p < 0.05 ? 4 : p < 0.08 ? 2 : 0, p < 0.05 ? "Last raise under 5%" : p < 0.08 ? "Last raise between 5% and 8%" : "Last raise 8% or more");
  }

  if (f.compaRatio === null) add("pay_below_grade_mid", 0, "No grade midpoint to compare", false);
  else {
    const c = f.compaRatio;
    add("pay_below_grade_mid", c < 0.85 ? 8 : c < 0.95 ? 4 : 0, c < 0.85 ? "Pay below 85% of grade midpoint" : c < 0.95 ? "Pay 85–95% of grade midpoint" : "Pay at or above 95% of grade midpoint");
  }

  if (f.latestRating === null) add("performance", 0, "Not rated yet", false);
  else {
    const r = f.latestRating;
    const top = r >= 4 && noRaise12;
    add("performance", top ? 10 : r <= 2.5 ? 6 : 0, top ? `Rated ${r} with no raise in 12 months` : r <= 2.5 ? `Rated ${r}` : `Rated ${r}`);
  }

  if (f.latestRating === null || f.previousRating === null) add("rating_drop", 0, "Needs two review cycles", false);
  else {
    const drop = r2(f.previousRating - f.latestRating);
    add("rating_drop", drop >= 1 ? 5 : 0, drop >= 1 ? `Rating fell from ${f.previousRating} to ${f.latestRating}` : "No large drop");
  }

  add("active_pip", f.activePip ? 8 : 0, f.activePip ? "Active performance improvement plan" : "No active plan");
  add("manager_changes_12m", f.managerChanges12m >= 2 ? 7 : f.managerChanges12m === 1 ? 3 : 0, f.managerChanges12m ? `${plural(f.managerChanges12m, "manager change")} in 12 months` : "Same manager all year");
  add("manager_leaving", f.managerLeaving ? 5 : 0, f.managerLeaving ? "Their manager is leaving or left recently" : "Manager staying");
  add("peer_exits_6m", f.peerExits6m >= 2 ? 6 : f.peerExits6m === 1 ? 3 : 0, f.peerExits6m ? `${plural(f.peerExits6m, "teammate")} left or resigned in 6 months` : "No teammates left");

  if (f.shortNoticeLeaves90d === null) add("short_notice_leave_90d", 0, "No leave data", false);
  else {
    const n = f.shortNoticeLeaves90d;
    add("short_notice_leave_90d", n >= 3 ? 7 : n === 2 ? 3 : 0, n ? `${plural(n, "one-day leave")} applied at short notice in 90 days` : "No short-notice leave");
  }

  if (f.unexplainedAbsences60d === null) add("attendance_drift_60d", 0, "Not enough attendance history", false);
  else {
    const abs = f.unexplainedAbsences60d >= 2 ? 2 : 0;
    const hrs = f.hoursDropPct !== null && f.hoursDropPct >= 0.1 ? 3 : 0;
    const parts = [abs ? `${plural(f.unexplainedAbsences60d, "unexplained absence")}` : null, hrs ? `hours down ${Math.round((f.hoursDropPct ?? 0) * 100)}%` : null].filter(Boolean);
    add("attendance_drift_60d", abs + hrs, parts.length ? `${parts.join("; ")} in 60 days` : "Attendance steady");
  }

  if (f.praise180d === null) add("no_recognition_180d", 0, "Praise not in use", false);
  else add("no_recognition_180d", f.praise180d === 0 ? 2 : 0, f.praise180d === 0 ? "No praise received in 6 months" : `${plural(f.praise180d, "praise")} in 6 months`);

  add("prior_resignation", f.priorResignation ? 5 : 0, f.priorResignation ? "Resigned before and stayed" : "No earlier resignation");

  const score = Math.min(100, out.reduce((s, x) => s + x.points, 0));
  return { score, band: riskBand(score), coverage: out.filter((x) => x.hasData).length, factors: out };
}

// ---------------------------------------------------------------------------
//  Risk inputs → features, as at any date (so the backtest can rewind)
// ---------------------------------------------------------------------------

export interface RiskInputs {
  employees: Array<{
    id: string; status: string; dateOfJoining: Date; reportingManagerId: string | null;
    gradeMid: number | null;
    exit: { status: string; noticeDate: Date; lastWorkingDay: Date; type: string } | null;
    lastWorkingDay: Date | null;
  }>;
  revisions: Array<{ employeeId: string; effectiveFrom: Date; annualCtc: number; previousCtc: number | null }>;
  /** Final ratings and when they became known (shared date, else cycle end). */
  ratings: Array<{ employeeId: string; at: Date; rating: number }>;
  pips: Array<{ employeeId: string; startDate: Date; endDate: Date; status: string; decidedAt: Date | null }>;
  jobRecords: Array<{ employeeId: string; effectiveFrom: Date; reportingManagerId: string | null; reason: string }>;
  leaves: Array<{ employeeId: string; fromDate: Date; createdAt: Date; totalDays: number; status: string }>;
  attendance: Array<{ employeeId: string; date: Date; status: string; effectiveHours: number }>;
  praise: Array<{ toEmployeeId: string; createdAt: Date }>;
}

/** Is this person scoreable on `asOf`: on the books and not already resigning? */
export function riskEligible(e: RiskInputs["employees"][number], asOf: Date): boolean {
  if (e.status === "PREBOARDING") return false;
  if (utcDay(e.dateOfJoining).getTime() > asOf.getTime()) return false;
  const left = leavingDate({ status: e.status, lastWorkingDay: e.lastWorkingDay, exitRecord: e.exit });
  if (left && left.getTime() < asOf.getTime()) return false;
  if (e.exit && e.exit.noticeDate.getTime() <= asOf.getTime() && !(WITHDRAWN_EXIT_STATUSES as readonly string[]).includes(e.exit.status)) return false;
  if (e.status === "EXITED" && !e.exit) return false;
  return true;
}

export function riskFeaturesAt(input: RiskInputs, employeeId: string, asOfRaw: Date): RiskFeatures {
  const asOf = utcDay(asOfRaw);
  const t = asOf.getTime();
  const e = input.employees.find((x) => x.id === employeeId)!;
  const tenureMonths = monthsBetween(e.dateOfJoining, asOf);

  const revs = input.revisions.filter((r) => r.employeeId === e.id && r.effectiveFrom.getTime() <= t).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  const raises = revs.filter((r) => r.previousCtc !== null && r.previousCtc > 0 && r.annualCtc > r.previousCtc);
  const lastRaise = raises[raises.length - 1] ?? null;
  const monthsSinceRaise = monthsBetween(lastRaise ? lastRaise.effectiveFrom : e.dateOfJoining, asOf);
  const lastRaisePct = lastRaise ? (lastRaise.annualCtc - lastRaise.previousCtc!) / lastRaise.previousCtc! : null;
  const ctc = revs.length ? revs[revs.length - 1].annualCtc : null;
  const compaRatio = ctc && e.gradeMid ? ctc / e.gradeMid : null;

  const rated = input.ratings.filter((r) => r.employeeId === e.id && r.at.getTime() <= t).sort((a, b) => a.at.getTime() - b.at.getTime());
  const latestRating = rated.length ? rated[rated.length - 1].rating : null;
  const previousRating = rated.length > 1 ? rated[rated.length - 2].rating : null;

  const activePip = input.pips.some((p) => p.employeeId === e.id && p.status !== "CANCELLED" && p.startDate.getTime() <= t
    && (p.decidedAt ? p.decidedAt.getTime() > t : ["ACTIVE", "EXTENDED"].includes(p.status) || p.endDate.getTime() >= t));

  // Only records that name a manager count: a blank is "not recorded", not a change.
  const jr = input.jobRecords.filter((j) => j.employeeId === e.id && j.reportingManagerId && j.effectiveFrom.getTime() <= t).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  let managerChanges12m = 0;
  for (let i = 1; i < jr.length; i++) {
    if (jr[i].effectiveFrom.getTime() > t - 365 * DAY && jr[i].reportingManagerId !== jr[i - 1].reportingManagerId) managerChanges12m++;
  }

  const goneOrGoing = (x: RiskInputs["employees"][number]) => !!x.exit
    && !(WITHDRAWN_EXIT_STATUSES as readonly string[]).includes(x.exit.status)
    && x.exit.status !== "INITIATED"
    && x.exit.noticeDate.getTime() <= t
    && x.exit.lastWorkingDay.getTime() >= t - 183 * DAY;
  const manager = e.reportingManagerId ? input.employees.find((x) => x.id === e.reportingManagerId) : undefined;
  const managerLeaving = !!manager && goneOrGoing(manager);
  const peerExits6m = e.reportingManagerId
    ? input.employees.filter((x) => x.id !== e.id && x.reportingManagerId === e.reportingManagerId && goneOrGoing(x)).length
    : 0;

  const tenantHasLeave = input.leaves.some((l) => l.fromDate.getTime() <= t && l.fromDate.getTime() > t - 90 * DAY);
  const shortNoticeLeaves90d = tenantHasLeave
    ? input.leaves.filter((l) => l.employeeId === e.id && ["APPROVED", "PENDING"].includes(l.status)
        && l.fromDate.getTime() <= t && l.fromDate.getTime() > t - 90 * DAY
        && l.totalDays <= 1 && l.createdAt.getTime() >= l.fromDate.getTime() - DAY).length
    : null;

  const att = input.attendance.filter((a) => a.employeeId === e.id && a.date.getTime() <= t);
  const recent = att.filter((a) => a.date.getTime() > t - 60 * DAY);
  const prior = att.filter((a) => a.date.getTime() <= t - 60 * DAY && a.date.getTime() > t - 120 * DAY);
  let unexplainedAbsences60d: number | null = null, hoursDropPct: number | null = null;
  if (recent.length >= 20) {
    // The last couple of days are often not regularised yet, so they don't count.
    unexplainedAbsences60d = recent.filter((a) => (a.status === "ABSENT" || a.status === "NO_ATTENDANCE") && a.date.getTime() <= t - 3 * DAY).length;
    if (prior.length >= 20) {
      const avg = (xs: typeof att) => { const w = xs.filter((a) => a.effectiveHours > 0); return w.length ? w.reduce((s, a) => s + a.effectiveHours, 0) / w.length : 0; };
      const a1 = avg(prior), a2 = avg(recent);
      hoursDropPct = a1 > 0 ? Math.max(0, (a1 - a2) / a1) : null;
    }
  }

  const tenantHasPraise = input.praise.some((p) => p.createdAt.getTime() <= t);
  const praise180d = tenantHasPraise ? input.praise.filter((p) => p.toEmployeeId === e.id && p.createdAt.getTime() <= t && p.createdAt.getTime() > t - 180 * DAY).length : null;

  const priorResignation = !!e.exit && ["RETAINED", "CANCELLED"].includes(e.exit.status) && e.exit.noticeDate.getTime() <= t;

  return {
    tenureMonths, monthsSinceRaise, lastRaisePct, compaRatio, latestRating, previousRating, activePip,
    managerChanges12m, managerLeaving, peerExits6m, shortNoticeLeaves90d, unexplainedAbsences60d, hoursDropPct,
    praise180d, priorResignation,
  };
}

// ---------------------------------------------------------------------------
//  AI guards
// ---------------------------------------------------------------------------

/** Merge groups smaller than `min` people into one "Other" row. */
export function suppressSmall<T extends { label: string; headcount: number; leavers: number }>(rows: T[], min = 3): Array<{ label: string; headcount: number; leavers: number; ratePct: number }> {
  const keep = rows.filter((r) => r.headcount >= min);
  const small = rows.filter((r) => r.headcount < min);
  const out = keep.map((r) => ({ label: r.label, headcount: r.headcount, leavers: r.leavers, ratePct: r.headcount ? r1((r.leavers / r.headcount) * 100) : 0 }));
  if (small.length) {
    const h = small.reduce((s, r) => s + r.headcount, 0), l = small.reduce((s, r) => s + r.leavers, 0);
    if (h > 0 || l > 0) out.push({ label: "Other", headcount: h, leavers: l, ratePct: h ? r1((l / h) * 100) : 0 });
  }
  return out;
}

/** Every number that appears in a payload, in values or inside label strings. */
export function payloadNumbers(v: unknown, into = new Set<number>()): Set<number> {
  if (typeof v === "number" && Number.isFinite(v)) into.add(v);
  else if (typeof v === "string") for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) into.add(Number(m[0]));
  else if (Array.isArray(v)) for (const x of v) payloadNumbers(x, into);
  else if (v && typeof v === "object") for (const x of Object.values(v)) payloadNumbers(x, into);
  return into;
}

/**
 * Numbers in an AI answer that are not in what it was shown. Years, and the
 * small counts people write in prose ("3 months", "top 2"), are allowed;
 * anything else must match a payload number, allowing for rounding.
 */
export function ungroundedNumbers(text: string, payload: unknown): number[] {
  const known = [...payloadNumbers(payload)];
  const bad: number[] = [];
  for (const m of text.replace(/,(?=\d{3})/g, "").matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (n <= 12 && Number.isInteger(n)) continue;
    if (n >= 1990 && n <= 2100 && Number.isInteger(n)) continue;
    const ok = known.some((k) => Math.abs(k - n) < 0.051 || Math.round(k) === n || r1(k) === n);
    if (!ok) bad.push(n);
  }
  return bad;
}

/** Strip contact details and employee numbers from a free-text question. */
export function redactQuestion(q: string, employeeNumberPrefix = "[A-Z]{2,5}"): string {
  return q
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, "[phone]")
    .replace(new RegExp(`\\b${employeeNumberPrefix}\\d{3,6}\\b`, "g"), "[employee]")
    .trim();
}

/** Does a question name one of these people (full names, case-insensitive)? */
export function namesSomeone(q: string, names: string[]): boolean {
  const low = ` ${q.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ")} `;
  return names.some((n) => {
    const k = n.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
    return k.includes(" ") && low.includes(` ${k} `);
  });
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
}
