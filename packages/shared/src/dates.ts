/**
 * Date helpers. Everything here works on UTC-midnight dates so a pay period
 * never shifts under a timezone change.
 */

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** UTC midnight for a Y-M-D. month is 1-12. */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** Strip time, keeping the calendar date in UTC. */
export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function startOfMonth(year: number, month: number): Date {
  return utcDate(year, month, 1);
}

export function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const targetDay = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  out.setUTCDate(Math.min(targetDay, daysInMonth(out.getUTCFullYear(), out.getUTCMonth() + 1)));
  return out;
}

/** Inclusive day count between two dates. */
export function daysBetween(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function isBetween(d: Date, from: Date, to: Date): boolean {
  const t = startOfDay(d).getTime();
  return t >= startOfDay(from).getTime() && t <= startOfDay(to).getTime();
}

/** Every calendar date in an inclusive range. */
export function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cursor = startOfDay(from);
  const end = startOfDay(to);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

// --- Indian financial year -------------------------------------------------

/** FY start year for a date. 15 Jun 2026 -> 2026; 15 Feb 2026 -> 2025. */
export function fyStartYear(d: Date, fyStartMonth = 4): number {
  const m = d.getUTCMonth() + 1;
  return m >= fyStartMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export function fyRange(startYear: number, fyStartMonth = 4): { start: Date; end: Date } {
  const start = utcDate(startYear, fyStartMonth, 1);
  const end = addDays(addMonths(start, 12), -1);
  return { start, end };
}

/** "FY 2026-27" */
export function fyLabel(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Ordered pay periods of a financial year, starting at the FY start month.
 * Used to spread annual TDS across the remaining months.
 */
export function fyMonths(startYear: number, fyStartMonth = 4): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < 12; i++) {
    const m0 = fyStartMonth - 1 + i;
    out.push({ year: startYear + Math.floor(m0 / 12), month: (m0 % 12) + 1 });
  }
  return out;
}

/** How many pay periods remain in the FY, inclusive of the current one. */
export function monthsRemainingInFy(
  year: number,
  month: number,
  fyStartMonth = 4,
): number {
  const startYear = month >= fyStartMonth ? year : year - 1;
  const months = fyMonths(startYear, fyStartMonth);
  const idx = months.findIndex((m) => m.year === year && m.month === month);
  return idx === -1 ? 12 : 12 - idx;
}

/** Completed years of service, used for gratuity eligibility. */
export function yearsOfService(joinDate: Date, endDate: Date): number {
  let years = endDate.getUTCFullYear() - joinDate.getUTCFullYear();
  const monthDiff = endDate.getUTCMonth() - joinDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && endDate.getUTCDate() < joinDate.getUTCDate())) {
    years--;
  }
  return Math.max(0, years);
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatPeriod(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function formatPeriodShort(year: number, month: number): string {
  return `${MONTH_SHORT[month - 1]} ${year}`;
}
