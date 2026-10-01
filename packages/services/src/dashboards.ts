/**
 * Pure helpers for the hiring, expense and attendance dashboards. Pages load
 * rows through the viewer's scope and hand them here, so every figure on a
 * dashboard can be unit tested without a database.
 */

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Last `n` months ending with the one holding `asOf`, oldest first: [{ key: "2026-09", label: "Sep" }]. */
export function lastMonths(asOf: Date, n: number): Array<{ key: string; label: string }> {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - (n - 1 - i), 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleString("en", { month: "short", timeZone: "UTC" }) };
  });
}

// ---------------------------------------------------------------------------
// Hiring

export interface FunnelApp {
  status: string;
  source: string;
  appliedAt: Date;
  /** Highest stage sequence the application ever reached, from its history. */
  furthestSequence: number | null;
  hiredAt?: Date | null;
}

/**
 * How many applications reached each stage of a flow (reaching a later stage
 * counts as passing the earlier ones), and the share that moved on.
 */
export function hiringFunnel(apps: FunnelApp[], stages: Array<{ sequence: number; name: string }>): Array<{ label: string; value: number; conversion: number | null }> {
  const ordered = [...stages].sort((a, b) => a.sequence - b.sequence);
  const counts = ordered.map((s) => apps.filter((a) => (a.furthestSequence ?? -1) >= s.sequence || a.status === "HIRED").length);
  return ordered.map((s, i) => ({ label: s.name, value: counts[i]!, conversion: i === 0 || !counts[i - 1] ? null : Math.round((counts[i]! / counts[i - 1]!) * 100) }));
}

/** Per source: applications, hires and the hire rate. Sorted by hires, then volume. */
export function sourceEffectiveness(apps: FunnelApp[]): Array<{ source: string; applications: number; hires: number; rate: number }> {
  const by = new Map<string, { applications: number; hires: number }>();
  for (const a of apps) {
    const s = by.get(a.source) ?? { applications: 0, hires: 0 };
    s.applications++;
    if (a.status === "HIRED" || a.status === "OFFER_ACCEPTED") s.hires++;
    by.set(a.source, s);
  }
  return [...by].map(([source, s]) => ({ source, ...s, rate: s.applications ? Math.round((s.hires / s.applications) * 100) : 0 }))
    .sort((a, b) => b.hires - a.hires || b.applications - a.applications);
}

/** Median days from application to hire, over hired applications with a hire date. */
export function timeToHire(apps: FunnelApp[]): number | null {
  const days = apps.filter((a) => a.hiredAt && (a.status === "HIRED" || a.status === "OFFER_ACCEPTED")).map((a) => (a.hiredAt!.getTime() - a.appliedAt.getTime()) / DAY);
  const m = median(days);
  return m === null ? null : Math.round(m);
}

/** Share of decided offers that were accepted, in percent. */
export function offerAcceptance(statuses: string[]): number | null {
  const accepted = statuses.filter((s) => s === "ACCEPTED").length;
  const decided = accepted + statuses.filter((s) => s === "DECLINED" || s === "EXPIRED").length;
  return decided ? Math.round((accepted / decided) * 100) : null;
}

// ---------------------------------------------------------------------------
// Expenses

export interface SpendLine { date: Date; amount: number; category: string; department: string; stage: string }
const COUNTED = new Set(["APPROVED", "PARTIALLY_APPROVED", "PAYMENT_PENDING", "PAID"]);

/** Approved spend per month (keys from `months`), by expense date. */
export function spendByMonth(lines: SpendLine[], months: Array<{ key: string; label: string }>): Array<{ label: string; value: number }> {
  return months.map((m) => ({ label: m.label, value: Math.round(lines.filter((l) => COUNTED.has(l.stage) && l.date.toISOString().slice(0, 7) === m.key).reduce((s, l) => s + l.amount, 0)) }));
}

/** Approved spend grouped by a key, largest first. */
export function spendBy(lines: SpendLine[], key: (l: SpendLine) => string): Array<{ label: string; value: number }> {
  const by = new Map<string, number>();
  for (const l of lines) if (COUNTED.has(l.stage)) by.set(key(l), (by.get(key(l)) ?? 0) + l.amount);
  return [...by].map(([label, v]) => ({ label, value: Math.round(v) })).sort((a, b) => b.value - a.value);
}

/** Median days from submission to approval, over approved claims. */
export function approvalTurnaround(claims: Array<{ submittedAt: Date | null; approvedAt: Date | null }>): number | null {
  const m = median(claims.filter((c) => c.submittedAt && c.approvedAt).map((c) => (c.approvedAt!.getTime() - c.submittedAt!.getTime()) / DAY));
  return m === null ? null : r1(m);
}

// ---------------------------------------------------------------------------
// Attendance

export interface DayRecord { employeeId: string; date: Date; status: string; effectiveHours: number; late: boolean; lop: number }
const OFF = new Set(["WEEKLY_OFF", "HOLIDAY"]);
const PRESENTISH = new Set(["PRESENT", "WORK_FROM_HOME", "ON_DUTY", "HALF_DAY"]);
/** No punch and no leave counts as an absence too. */
export const isAbsence = (status: string) => status === "ABSENT" || status === "NO_ATTENDANCE";

/** Monday of the week holding `d`, as YYYY-MM-DD. */
export function weekOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - day * DAY).toISOString().slice(0, 10);
}

/** Per week: attendance rate on working days, late marks, and average effective hours on days worked. */
export function attendanceTrend(records: DayRecord[]): Array<{ week: string; rate: number; late: number; hours: number; absent: number }> {
  const by = new Map<string, DayRecord[]>();
  for (const r of records) if (!OFF.has(r.status)) by.set(weekOf(r.date), [...(by.get(weekOf(r.date)) ?? []), r]);
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, list]) => {
    const worked = list.filter((r) => PRESENTISH.has(r.status));
    return {
      week, rate: list.length ? Math.round((worked.length / list.length) * 100) : 0, late: list.filter((r) => r.late).length,
      hours: worked.length ? r1(worked.reduce((s, r) => s + r.effectiveHours, 0) / worked.length) : 0,
      absent: list.filter((r) => isAbsence(r.status)).length,
    };
  });
}

/**
 * Per person over the window: working days, days absent, late marks, LOP and
 * average hours. Leaderboards sort this list.
 */
export function attendanceByPerson(records: DayRecord[]): Array<{ employeeId: string; workdays: number; absent: number; late: number; lop: number; hours: number; rate: number }> {
  const by = new Map<string, DayRecord[]>();
  for (const r of records) if (!OFF.has(r.status)) by.set(r.employeeId, [...(by.get(r.employeeId) ?? []), r]);
  return [...by].map(([employeeId, list]) => {
    const worked = list.filter((r) => PRESENTISH.has(r.status));
    return {
      employeeId, workdays: list.length, absent: list.filter((r) => isAbsence(r.status)).length, late: list.filter((r) => r.late).length,
      lop: r1(list.reduce((s, r) => s + r.lop, 0)), hours: worked.length ? r1(worked.reduce((s, r) => s + r.effectiveHours, 0) / worked.length) : 0,
      rate: list.length ? Math.round((worked.length / list.length) * 100) : 0,
    };
  });
}

/** Bradford factor (spells² × days) of absence: frequent short absences weigh more than one long one. */
export function bradfordFactor(dates: Date[]): number {
  if (dates.length === 0) return 0;
  const days = [...new Set(dates.map((d) => d.toISOString().slice(0, 10)))].sort();
  let spells = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = (Date.parse(days[i]!) - Date.parse(days[i - 1]!)) / DAY;
    // A weekend between two absences still counts as one spell.
    if (gap > 3 || (gap > 1 && new Date(days[i]!).getUTCDay() !== 1)) spells++;
  }
  return spells * spells * days.length;
}
