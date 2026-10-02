/**
 * Timesheet policy, pure: the limits a week of time must keep, how time not
 * in whole increments is treated, who approves and in what order, when a
 * sheet approves itself, and when the unsubmitted are reminded.
 *
 * DEFAULT_TIMESHEET_POLICY is exactly the rules that used to be hardcoded:
 * quarter hours or nothing, at most 24 hours on a day, the line manager or
 * the project manager approves, nothing approves itself and nobody is chased.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export type TimesheetRounding = "REJECT" | "NEAREST" | "UP";
export type TimesheetApprovalChain = "EITHER" | "LINE_MANAGER" | "PROJECT_MANAGER" | "LINE_THEN_PROJECT";
export type TimesheetApprover = "EITHER" | "LINE_MANAGER" | "PROJECT_MANAGER";

export interface TimesheetPolicy {
  minHoursPerDay: number | null;
  maxHoursPerDay: number;
  minHoursPerWeek: number | null;
  maxHoursPerWeek: number | null;
  incrementMinutes: number;
  rounding: TimesheetRounding;
  approvalChain: TimesheetApprovalChain;
  autoApprove: boolean;
  autoApproveMaxHours: number | null;
  flagWeeklyHoursAbove: number;
  remindersEnabled: boolean;
  reminderAfterDays: number;
  escalationEnabled: boolean;
  escalateAfterDays: number;
}

export const DEFAULT_TIMESHEET_POLICY: TimesheetPolicy = {
  minHoursPerDay: null, maxHoursPerDay: 24, minHoursPerWeek: null, maxHoursPerWeek: null,
  incrementMinutes: 15, rounding: "REJECT", approvalChain: "EITHER", autoApprove: false, autoApproveMaxHours: null,
  flagWeeklyHoursAbove: 50, remindersEnabled: false, reminderAfterDays: 1, escalationEnabled: false, escalateAfterDays: 3,
};

/** Increments that divide an hour evenly. */
export const TIMESHEET_INCREMENTS = [1, 5, 6, 10, 15, 30, 60];

export const APPROVAL_CHAIN_LABEL: Record<TimesheetApprovalChain, string> = {
  EITHER: "Line manager or project manager",
  LINE_MANAGER: "Line manager only",
  PROJECT_MANAGER: "Project manager only",
  LINE_THEN_PROJECT: "Line manager, then project manager",
};

/** "quarter hours", "half hours", "steps of 10 minutes". */
export function incrementLabel(minutes: number): string {
  return minutes === 15 ? "quarter hours" : minutes === 30 ? "half hours" : minutes === 60 ? "whole hours" : minutes === 1 ? "whole minutes" : `steps of ${minutes} minutes`;
}

/** Whether `hours` is a whole number of increments. */
export function onIncrement(hours: number, incrementMinutes: number): boolean {
  const steps = (hours * 60) / incrementMinutes;
  return Math.abs(steps - Math.round(steps)) <= 1e-6;
}

/** Hours rounded to the policy's increment (unchanged when the policy refuses odd time). */
export function roundHours(hours: number, p: Pick<TimesheetPolicy, "incrementMinutes" | "rounding">): number {
  if (p.rounding === "REJECT" || onIncrement(hours, p.incrementMinutes)) return hours;
  const steps = (hours * 60) / p.incrementMinutes;
  const n = p.rounding === "UP" ? Math.ceil(steps - 1e-9) : Math.round(steps);
  return r2((n * p.incrementMinutes) / 60);
}

export interface PolicyEntry { date: Date; hours: number }

/**
 * Problems the policy has with a week: odd increments, day limits (the cap on
 * every day, the floor on each day time is logged) and, when submitting, the
 * weekly floor and cap. Callers round first when the policy rounds.
 */
export function policyIssues(entries: PolicyEntry[], p: TimesheetPolicy, opts: { submit?: boolean } = {}): string[] {
  const issues: string[] = [];
  const perDay = new Map<number, number>();
  for (const e of entries) {
    if (e.hours > 0 && !onIncrement(e.hours, p.incrementMinutes)) issues.push(`${e.hours} h — log in ${incrementLabel(p.incrementMinutes)}.`);
    perDay.set(e.date.getTime(), (perDay.get(e.date.getTime()) ?? 0) + e.hours);
  }
  for (const [t, raw] of perDay) {
    const h = r2(raw), day = new Date(t).toISOString().slice(0, 10);
    if (h > p.maxHoursPerDay) issues.push(p.maxHoursPerDay === 24 ? `${day} has ${h} hours — a day has 24.` : `${day} has ${h} hours — the limit is ${p.maxHoursPerDay} a day.`);
    if (p.minHoursPerDay !== null && h > 0 && h < p.minHoursPerDay) issues.push(`${day} has ${h} hours — log at least ${p.minHoursPerDay} on a day you work.`);
  }
  if (opts.submit) {
    const total = r2(entries.reduce((s, e) => s + e.hours, 0));
    if (p.maxHoursPerWeek !== null && total > p.maxHoursPerWeek) issues.push(`${total} hours is over the ${p.maxHoursPerWeek}-hour weekly limit.`);
    if (p.minHoursPerWeek !== null && total < p.minHoursPerWeek) issues.push(`${total} hours is under the ${p.minHoursPerWeek} hours a week needs before it can be submitted.`);
  }
  return [...new Set(issues)];
}

/** Problems with a policy as entered. */
export function checkPolicy(p: TimesheetPolicy): string[] {
  const out: string[] = [];
  if (!(p.maxHoursPerDay > 0 && p.maxHoursPerDay <= 24)) out.push("The daily limit is more than 0 and at most 24 hours.");
  if (p.minHoursPerDay !== null && !(p.minHoursPerDay > 0 && p.minHoursPerDay <= p.maxHoursPerDay)) out.push("The daily minimum is more than 0 and no more than the daily limit.");
  if (p.maxHoursPerWeek !== null && !(p.maxHoursPerWeek > 0 && p.maxHoursPerWeek <= 168)) out.push("The weekly limit is more than 0 and at most 168 hours.");
  if (p.minHoursPerWeek !== null && !(p.minHoursPerWeek > 0 && (p.maxHoursPerWeek === null || p.minHoursPerWeek <= p.maxHoursPerWeek))) out.push("The weekly minimum is more than 0 and no more than the weekly limit.");
  if (!TIMESHEET_INCREMENTS.includes(p.incrementMinutes)) out.push(`Log time in steps of ${TIMESHEET_INCREMENTS.join(", ")} minutes.`);
  if (p.autoApproveMaxHours !== null && !(p.autoApproveMaxHours > 0)) out.push("The auto-approve ceiling is more than 0 hours.");
  if (!(p.flagWeeklyHoursAbove > 0)) out.push("The weekly warning is more than 0 hours.");
  if (!(Number.isInteger(p.reminderAfterDays) && p.reminderAfterDays >= 0 && p.reminderAfterDays <= 30)) out.push("Remind 0 to 30 days after the week ends.");
  if (!(Number.isInteger(p.escalateAfterDays) && p.escalateAfterDays >= 0 && p.escalateAfterDays <= 60)) out.push("Escalate 0 to 60 days after the week ends.");
  if (p.remindersEnabled && p.escalationEnabled && p.escalateAfterDays < p.reminderAfterDays) out.push("Escalate no sooner than the reminder goes out.");
  return out;
}

/** Who a freshly submitted sheet waits for. */
export function firstApprover(chain: TimesheetApprovalChain): TimesheetApprover {
  return chain === "LINE_MANAGER" || chain === "LINE_THEN_PROJECT" ? "LINE_MANAGER" : chain === "PROJECT_MANAGER" ? "PROJECT_MANAGER" : "EITHER";
}

/** After an approval at `awaiting`, who is next — or null when the sheet is approved. */
export function nextApprover(chain: TimesheetApprovalChain, awaiting: TimesheetApprover, step: number): TimesheetApprover | null {
  if (chain === "LINE_THEN_PROJECT" && awaiting === "LINE_MANAGER" && step === 0) return "PROJECT_MANAGER";
  return null;
}

/**
 * A sheet approves itself when the policy says so and the week is within its
 * ceiling, or when none of its projects asks for approval at all.
 */
export function autoApproves(p: Pick<TimesheetPolicy, "autoApprove" | "autoApproveMaxHours">, totalHours: number, projectsNeedApproval: boolean[]): boolean {
  if (projectsNeedApproval.length > 0 && projectsNeedApproval.every((x) => !x)) return true;
  return p.autoApprove && (p.autoApproveMaxHours === null || totalHours <= p.autoApproveMaxHours);
}

/** Whole days from the end (Sunday) of the week starting `week` to `today`. */
export function daysAfterWeek(week: Date, today: Date): number {
  const end = week.getTime() + 6 * DAY;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((t - end) / DAY);
}

/** What the reminder job owes a week that is still not submitted. */
export function chaseDue(p: TimesheetPolicy, week: Date, today: Date): { remind: boolean; escalate: boolean } {
  const after = daysAfterWeek(week, today);
  if (after <= 0) return { remind: false, escalate: false };
  return {
    remind: p.remindersEnabled && after >= Math.max(1, p.reminderAfterDays),
    escalate: p.escalationEnabled && after >= Math.max(1, p.escalateAfterDays),
  };
}
