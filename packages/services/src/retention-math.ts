/**
 * Growth, retention and attrition arithmetic for the Growth & Retention and
 * Attrition Analysis pages. Pure: it works on the population analytics-math
 * defines (joining day, leaving day) and never reads the database.
 */
import { DAY, utcDay, onBooks, headcountAt, monthsIn, averageHeadcount, joinersIn, leaversIn, windowMonths, type PopMember, type Window } from "./analytics-math";

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface MonthFlow {
  label: string;
  start: Date;
  end: Date;
  /** On the books on the first day of the month (or of the window). */
  opening: number;
  /** On the books on the last day. */
  closing: number;
  joiners: number;
  leavers: number;
  /** Leavers ÷ the average of opening and closing headcount, in percent. */
  attritionPct: number;
  /** Share of the opening headcount still on the books at month end, in percent. */
  retentionPct: number;
}

/** Month by month: headcount at both ends, who joined, who left, and the monthly rates. */
export function monthlyFlow(pop: PopMember[], w: Window): MonthFlow[] {
  return monthsIn(w).map((m) => {
    const opening = headcountAt(pop, m.start);
    const closing = headcountAt(pop, m.end);
    const leavers = leaversIn(pop, { from: m.start, to: m.end }).length;
    const openers = pop.filter((e) => onBooks(e, m.start));
    const kept = openers.filter((e) => onBooks(e, m.end)).length;
    const avg = (opening + closing) / 2;
    return {
      label: m.label, start: m.start, end: m.end, opening, closing,
      joiners: joinersIn(pop, { from: m.start, to: m.end }).length, leavers,
      attritionPct: avg ? r1((leavers / avg) * 100) : 0,
      retentionPct: openers.length ? r1((kept / openers.length) * 100) : 0,
    };
  });
}

/** Leavers ÷ average headcount, scaled to a year, in percent (one decimal). */
export function annualisedRate(leavers: number, avgHeadcount: number, months: number): number {
  if (!avgHeadcount || months <= 0) return 0;
  return r1((leavers / avgHeadcount) * 100 * (12 / months));
}

export type ExitKind = "Voluntary" | "Involuntary" | "Other";
export const EXIT_KINDS: readonly ExitKind[] = ["Voluntary", "Involuntary", "Other"];

/**
 * Voluntary or not. The structured exit reason decides when one was picked
 * (its master says which kind it is); otherwise the exit type does: a
 * resignation is voluntary, a termination or absconding is not, and
 * retirement, end of contract and death are neither.
 */
export function exitKind(e: { exitType: string | null; exitReasonKind?: string | null }): ExitKind {
  if (e.exitReasonKind === "VOLUNTARY") return "Voluntary";
  if (e.exitReasonKind === "INVOLUNTARY") return "Involuntary";
  if (e.exitReasonKind === "OTHER") return "Other";
  if (e.exitType === "RESIGNATION") return "Voluntary";
  if (e.exitType === "TERMINATION" || e.exitType === "ABSCONDING") return "Involuntary";
  return "Other";
}

/** The rating at or above which a voluntary exit counts as regretted. */
export const REGRET_RATING = 4;

/**
 * A regretted exit: someone who chose to leave and whose last final rating
 * before leaving was high. Without a rating it cannot be called either way,
 * so it is not counted.
 */
export function isRegretted(e: { exitType: string | null; exitReasonKind?: string | null }, ratingAtExit: number | null, threshold = REGRET_RATING): boolean {
  return exitKind(e) === "Voluntary" && ratingAtExit !== null && ratingAtExit >= threshold;
}

export interface GroupAttrition { label: string; headcount: number; leavers: number; ratePct: number }

/**
 * Attrition per group over a window: average headcount of the group, leavers
 * from it, and the annualised rate. `key` reads the group a person was in on
 * the day given (their last day for leavers, the window's end otherwise).
 */
export function attritionByGroup<T extends PopMember>(pop: T[], leavers: T[], w: Window, key: (e: T, at: Date) => string, order?: readonly string[]): GroupAttrition[] {
  const at = (e: T) => (e.leftOn && e.leftOn.getTime() <= w.to.getTime() ? e.leftOn : w.to);
  const members = new Map<string, T[]>();
  for (const e of pop) {
    // Anyone on the books at some point in the window.
    if (e.status === "PREBOARDING" || utcDay(e.dateOfJoining).getTime() > w.to.getTime() || (e.leftOn && e.leftOn.getTime() < w.from.getTime())) continue;
    const k = key(e, at(e));
    const list = members.get(k) ?? [];
    list.push(e);
    members.set(k, list);
  }
  const months = windowMonths(w);
  const leaverSet = new Set(leavers.map((e) => e.id));
  const rows = [...members].map(([label, list]) => {
    const avg = averageHeadcount(list, w);
    const left = list.filter((e) => leaverSet.has(e.id)).length;
    return { label, headcount: Math.round(avg), leavers: left, ratePct: annualisedRate(left, avg, months) };
  });
  if (order) {
    const rank = (l: string) => { const i = order.indexOf(l); return i < 0 ? order.length : i; };
    return rows.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
  }
  return rows.sort((a, b) => b.leavers - a.leavers || b.ratePct - a.ratePct || a.label.localeCompare(b.label));
}

export const NEW_HIRE_DAYS = 90;

export interface NewHireRetention {
  /** Joined in the window. */
  hires: number;
  /** Hires whose first `days` days are over by `asOf`. */
  matured: number;
  /** …of whom were still on the books on day `days`. */
  retained: number;
  /** …and who left before it. */
  left: number;
  /** Hires too recent to judge. */
  pending: number;
  /** retained ÷ matured, in percent; null when nobody has matured. */
  ratePct: number | null;
}

/** The day a hire's first `days` days end on. */
export const probeDay = (doj: Date, days = NEW_HIRE_DAYS) => new Date(utcDay(doj).getTime() + days * DAY);

/** Of the people who joined in the window, how many were still here `days` days later. */
export function newHireRetention<T extends PopMember>(pop: T[], w: Window, asOf: Date, days = NEW_HIRE_DAYS): NewHireRetention {
  const hires = joinersIn(pop, w);
  const matured = hires.filter((e) => probeDay(e.dateOfJoining, days).getTime() <= asOf.getTime());
  const retained = matured.filter((e) => onBooks(e, probeDay(e.dateOfJoining, days))).length;
  return {
    hires: hires.length, matured: matured.length, retained, left: matured.length - retained, pending: hires.length - matured.length,
    ratePct: matured.length ? r1((retained / matured.length) * 100) : null,
  };
}

/** The same, one row per joining month. */
export function newHireRetentionByMonth<T extends PopMember>(pop: T[], w: Window, asOf: Date, days = NEW_HIRE_DAYS): Array<NewHireRetention & { label: string }> {
  return monthsIn(w).map((m) => ({ label: m.label, ...newHireRetention(pop, { from: m.start, to: m.end }, asOf, days) }));
}

/** Months from joining to leaving (whole months), for "how long did leavers stay". */
export function tenureAtExitMonths(e: PopMember): number | null {
  if (!e.leftOn) return null;
  const a = utcDay(e.dateOfJoining), b = e.leftOn;
  const m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
  return Math.max(0, m);
}
