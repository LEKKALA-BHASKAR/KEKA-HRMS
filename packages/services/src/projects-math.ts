/**
 * Pure project arithmetic — no database: timesheet weeks and checks, GST on
 * invoices, project health and utilisation.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Monday of the week containing `d`, at UTC midnight. */
export function weekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY);
}

export interface EntryInput { projectId: string; date: Date; hours: number }

/**
 * Problems with a week's entries: impossible days, quarter-hour precision,
 * future days, and days outside the week.
 */
export function checkTimesheet(entries: EntryInput[], week: Date, today = new Date()): string[] {
  const issues: string[] = [];
  const end = new Date(week.getTime() + 7 * DAY);
  const todayEnd = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + DAY;
  const perDay = new Map<number, number>();
  for (const e of entries) {
    if (e.date < week || e.date >= end) issues.push(`${e.date.toISOString().slice(0, 10)} is outside this week.`);
    if (e.date.getTime() >= todayEnd) issues.push(`Time cannot be logged for ${e.date.toISOString().slice(0, 10)} yet.`);
    if (!(e.hours > 0)) issues.push("Hours must be more than zero.");
    if (Math.abs(e.hours * 4 - Math.round(e.hours * 4)) > 1e-9) issues.push(`${e.hours} h — log in quarter hours.`);
    perDay.set(e.date.getTime(), (perDay.get(e.date.getTime()) ?? 0) + e.hours);
  }
  for (const [t, h] of perDay) if (h > 24) issues.push(`${new Date(t).toISOString().slice(0, 10)} has ${h} hours — a day has 24.`);
  return [...new Set(issues)];
}

/**
 * GST on services: intra-state supply splits into CGST + SGST; inter-state is
 * IGST. Exports (no place of supply in India) are zero-rated.
 */
export function gst(subtotal: number, supplierState: string | null, clientState: string | null, rate = 18) {
  if (!clientState) return { cgst: 0, sgst: 0, igst: 0, total: 0, kind: "EXPORT" as const };
  if (supplierState && supplierState === clientState) {
    const half = r2((subtotal * rate) / 200);
    return { cgst: half, sgst: half, igst: 0, total: r2(half * 2), kind: "INTRA" as const };
  }
  const igst = r2((subtotal * rate) / 100);
  return { cgst: 0, sgst: 0, igst, total: igst, kind: "INTER" as const };
}

/**
 * Health compares hours burned and milestones with time elapsed. Burning
 * the budget much faster than the calendar, or a missed milestone, is red.
 */
export function projectHealth(p: { start: Date | null; end: Date | null; budgetHours: number | null; hoursUsed: number; overdueMilestones: number }, today = new Date()): { health: "GREEN" | "AMBER" | "RED"; reason: string } {
  if (p.overdueMilestones > 0) return { health: "RED", reason: `${p.overdueMilestones} milestone(s) past due` };
  if (!p.start || !p.end || !p.budgetHours) return { health: "GREEN", reason: "No budget to track against" };
  const elapsed = Math.max(0, Math.min(1, (today.getTime() - p.start.getTime()) / Math.max(DAY, p.end.getTime() - p.start.getTime())));
  const burned = p.hoursUsed / p.budgetHours;
  if (burned > 1) return { health: "RED", reason: `Over budget: ${Math.round(burned * 100)}% of hours used` };
  if (burned > elapsed + 0.2) return { health: "RED", reason: `${Math.round(burned * 100)}% of hours used with ${Math.round(elapsed * 100)}% of the time gone` };
  if (burned > elapsed + 0.1) return { health: "AMBER", reason: `Burning ahead of plan (${Math.round(burned * 100)}% vs ${Math.round(elapsed * 100)}%)` };
  return { health: "GREEN", reason: `${Math.round(burned * 100)}% of hours, ${Math.round(elapsed * 100)}% of time` };
}

/** Billable hours as a share of available hours (8 a working day). */
export function utilisation(billableHours: number, workingDays: number, allocationPercent = 100): number {
  const capacity = workingDays * 8 * (allocationPercent / 100);
  return capacity > 0 ? r2((billableHours / capacity) * 100) : 0;
}
