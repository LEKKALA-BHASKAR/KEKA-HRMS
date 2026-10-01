/**
 * Working-calendar primitives: weekly offs, holidays, and day keys.
 *
 * Every date here is a UTC-midnight Date, and every lookup is by an ISO
 * yyyy-mm-dd key, so nothing shifts with the server's timezone.
 */

export type DayPortion = "FULL_DAY" | "FIRST_HALF" | "SECOND_HALF" | "QUARTER";
export type OffPortion = "FULL_DAY" | "FIRST_HALF" | "SECOND_HALF";

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDaysUtc(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export function eachDayUtc(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let c = new Date(from.getTime()); c.getTime() <= to.getTime(); c = addDaysUtc(c, 1)) {
    out.push(c);
  }
  return out;
}

/**
 * Weekly-off policy, per weekday.
 *
 *   { SUN: { instances: "ALL" },
 *     SAT: { instances: [2, 4], portion: "FULL_DAY" } }
 *
 * `instances` selects which occurrences of that weekday in the month are off
 * — the primitive behind alternate-Saturday and nth-week patterns.
 */
export type WeeklyOffConfig = Partial<Record<Weekday, {
  instances: "ALL" | number[];
  portion?: OffPortion;
}>>;

export const DEFAULT_WEEKLY_OFF: WeeklyOffConfig = {
  SAT: { instances: "ALL" },
  SUN: { instances: "ALL" },
};

/** Which occurrence of its weekday within the month a date is: 1..5. */
export function weekdayInstance(d: Date): number {
  return Math.floor((d.getUTCDate() - 1) / 7) + 1;
}

/** The weekly-off portion for a date, or null if it is a working day. */
export function weeklyOffPortion(d: Date, config: WeeklyOffConfig): OffPortion | null {
  const rule = config[WEEKDAYS[d.getUTCDay()]];
  if (!rule) return null;
  const hit = rule.instances === "ALL" || rule.instances.includes(weekdayInstance(d));
  return hit ? rule.portion ?? "FULL_DAY" : null;
}

export interface WorkCalendar {
  weeklyOff: WeeklyOffConfig;
  /** Public (non-optional) holidays, keyed yyyy-mm-dd. */
  holidays: Set<string>;
}

export type DayKind = "WORKING" | "WEEKLY_OFF" | "HALF_WEEKLY_OFF" | "HOLIDAY";

export function classifyDay(d: Date, cal: WorkCalendar): DayKind {
  if (cal.holidays.has(dayKey(d))) return "HOLIDAY";
  const off = weeklyOffPortion(d, cal.weeklyOff);
  if (off === "FULL_DAY") return "WEEKLY_OFF";
  if (off) return "HALF_WEEKLY_OFF";
  return "WORKING";
}

export function isNonWorking(d: Date, cal: WorkCalendar): boolean {
  const k = classifyDay(d, cal);
  return k === "WEEKLY_OFF" || k === "HOLIDAY";
}

/** Count working days in a range — used for per-day rates and proration. */
export function workingDaysBetween(from: Date, to: Date, cal: WorkCalendar): number {
  let n = 0;
  for (const d of eachDayUtc(from, to)) {
    const k = classifyDay(d, cal);
    if (k === "WORKING") n += 1;
    else if (k === "HALF_WEEKLY_OFF") n += 0.5;
  }
  return n;
}
