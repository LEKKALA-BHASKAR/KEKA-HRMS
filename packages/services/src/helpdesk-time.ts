/**
 * Helpdesk business time: the clock SLA targets run on.
 *
 * A schedule is a list of working windows per weekday in a named timezone
 * ([{ day: 1 (Mon) … 7 (Sun), from: "09:00", to: "18:00" }]). An empty
 * schedule is 24x7. A day missing from a non-empty schedule is a weekly off,
 * and dates in `holidays` (yyyy-mm-dd, in the schedule's timezone) are off
 * too. "23:59" as an end means the end of the day, so a 00:00–23:59 window
 * has no one-minute gap at midnight.
 *
 * Pure functions — no database — so the arithmetic is unit tested.
 */

export interface BusinessWindow { day: number; from: string; to: string }
export interface BusinessSchedule { timezone: string; days: BusinessWindow[] }

export const TWENTY_FOUR_SEVEN: BusinessSchedule = { timezone: "Asia/Kolkata", days: [] };

const MIN = 60_000;
const DAY_MIN = 1440;
/** Never walk further than this looking for working time (a schedule with no days but every date a holiday). */
const MAX_DAYS = 800;

/** "09:30" → 570. "23:59" and "24:00" → 1440 (end of day). */
export function clockMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return NaN;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 1439 ? DAY_MIN : v;
}

/** Parse and validate a stored schedule (JSON from the database). Bad rows are dropped. */
export function parseSchedule(raw: unknown, timezone = "Asia/Kolkata"): BusinessSchedule {
  const days: BusinessWindow[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const o = r as Partial<BusinessWindow>;
      if (typeof o?.day !== "number" || o.day < 1 || o.day > 7 || typeof o.from !== "string" || typeof o.to !== "string") continue;
      const f = clockMinutes(o.from), t = clockMinutes(o.to);
      if (Number.isNaN(f) || Number.isNaN(t) || t <= f) continue;
      days.push({ day: o.day, from: o.from, to: o.to });
    }
  }
  return { timezone, days };
}

const offsetCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = offsetCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    offsetCache.set(tz, f);
  }
  return f;
}

/** Minutes the timezone is ahead of UTC at this instant (IST → 330). */
export function zoneOffsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(fmt(tz).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MIN);
}

/** The local calendar date (as a UTC-midnight Date) of an instant in a timezone. */
export function localDate(at: Date, tz: string): Date {
  const local = new Date(at.getTime() + zoneOffsetMinutes(at, tz) * MIN);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Monday = 1 … Sunday = 7. */
const isoWeekday = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

/** The instant a local wall-clock minute of a local date happens. */
function instantOf(localDay: Date, minuteOfDay: number, tz: string): number {
  const guess = localDay.getTime() + minuteOfDay * MIN;
  // Two passes settle the offset across a DST change; IST has none.
  let off = zoneOffsetMinutes(new Date(guess), tz);
  off = zoneOffsetMinutes(new Date(guess - off * MIN), tz);
  return guess - off * MIN;
}

/** Working windows of one local day, as UTC instants. */
function windowsOn(localDay: Date, s: BusinessSchedule, holidays: Set<string>): Array<[number, number]> {
  if (holidays.has(ymd(localDay))) return [];
  if (s.days.length === 0) return [[instantOf(localDay, 0, s.timezone), instantOf(localDay, DAY_MIN, s.timezone)]];
  const wd = isoWeekday(localDay);
  return s.days
    .filter((w) => w.day === wd)
    .map((w) => [instantOf(localDay, clockMinutes(w.from), s.timezone), instantOf(localDay, clockMinutes(w.to), s.timezone)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

const is247 = (s: BusinessSchedule, holidays: Set<string>) => s.days.length === 0 && holidays.size === 0;

/** The instant `minutes` of working time after `start`. */
export function addBusinessMinutes(start: Date, minutes: number, s: BusinessSchedule, holidayDates: Iterable<string> = []): Date {
  const holidays = new Set(holidayDates);
  if (minutes <= 0) return new Date(start);
  if (is247(s, holidays)) return new Date(start.getTime() + minutes * MIN);
  let remaining = minutes * MIN;
  let day = localDate(start, s.timezone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [a, b] of windowsOn(day, s, holidays)) {
      const from = Math.max(a, start.getTime());
      if (from >= b) continue;
      if (remaining <= b - from) return new Date(from + remaining);
      remaining -= b - from;
    }
    day = new Date(day.getTime() + DAY_MIN * MIN);
  }
  // A schedule with no working time at all: fall back to wall-clock time.
  return new Date(start.getTime() + minutes * MIN);
}

/** Working minutes between two instants (0 when b ≤ a). */
export function businessMinutesBetween(a: Date, b: Date, s: BusinessSchedule, holidayDates: Iterable<string> = []): number {
  const holidays = new Set(holidayDates);
  if (b.getTime() <= a.getTime()) return 0;
  if (is247(s, holidays)) return Math.round((b.getTime() - a.getTime()) / MIN);
  let total = 0;
  let day = localDate(a, s.timezone);
  const last = localDate(b, s.timezone).getTime();
  for (let i = 0; i < MAX_DAYS && day.getTime() <= last; i++) {
    for (const [x, y] of windowsOn(day, s, holidays)) {
      const from = Math.max(x, a.getTime()), to = Math.min(y, b.getTime());
      if (to > from) total += to - from;
    }
    day = new Date(day.getTime() + DAY_MIN * MIN);
  }
  return Math.round(total / MIN);
}

/**
 * Keka's durations: "5 days 19 hours", "23 hours 17 minutes",
 * "2 hours 10 minutes", "45 minutes". `parts` caps how many units show.
 */
export function formatDuration(minutes: number, parts = 2): string {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / DAY_MIN), h = Math.floor((m % DAY_MIN) / 60), mm = m % 60;
  const units: Array<[number, string]> = [[d, "day"], [h, "hour"], [mm, "minute"]];
  const first = units.findIndex(([v]) => v > 0);
  if (first === -1) return "0 minutes";
  return units.slice(first, first + parts).filter(([v]) => v > 0).map(([v, u]) => `${v} ${u}${v === 1 ? "" : "s"}`).join(" ");
}

/** "20 hours left" / "Overdue by 6 days" for an SLA chip. */
export function slaLabel(due: Date, now: Date): { text: string; overdue: boolean } {
  const diff = Math.round((due.getTime() - now.getTime()) / MIN);
  if (diff >= 0) return { text: `${formatDuration(diff, 1)} left`, overdue: false };
  return { text: `Overdue by ${formatDuration(-diff, 1)}`, overdue: true };
}
