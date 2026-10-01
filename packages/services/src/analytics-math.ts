/**
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
  }
  return out;
}

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
}
