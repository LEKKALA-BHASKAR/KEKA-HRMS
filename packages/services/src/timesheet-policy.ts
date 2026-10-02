import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { weekStart } from "./projects-math";
import { DEFAULT_TIMESHEET_POLICY, checkPolicy, chaseDue, type TimesheetPolicy } from "./timesheet-policy-math";

/**
 * The tenant's timesheet policy, kept on PsaSetting, and the job that chases
 * weeks nobody submitted: a reminder to the person, then an escalation to
 * their line manager. Each goes out once per person and week.
 */

type Result = { ok: boolean; message: string };
const DAY = 86_400_000;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The policy in force; a tenant that never saved one gets the defaults. */
export async function getTimesheetPolicy(tenantId: string): Promise<TimesheetPolicy> {
  const s = await prisma.psaSetting.findUnique({ where: { tenantId } });
  if (!s) return { ...DEFAULT_TIMESHEET_POLICY };
  return {
    minHoursPerDay: num(s.tsMinHoursPerDay), maxHoursPerDay: Number(s.tsMaxHoursPerDay),
    minHoursPerWeek: num(s.tsMinHoursPerWeek), maxHoursPerWeek: num(s.tsMaxHoursPerWeek),
    incrementMinutes: s.tsIncrementMinutes, rounding: s.tsRounding, approvalChain: s.tsApprovalChain,
    autoApprove: s.tsAutoApprove, autoApproveMaxHours: num(s.tsAutoApproveMaxHours), flagWeeklyHoursAbove: Number(s.tsFlagWeeklyHoursAbove),
    remindersEnabled: s.tsRemindersEnabled, reminderAfterDays: s.tsReminderAfterDays,
    escalationEnabled: s.tsEscalationEnabled, escalateAfterDays: s.tsEscalateAfterDays,
  };
}

export async function saveTimesheetPolicy(tenantId: string, p: TimesheetPolicy): Promise<Result> {
  const problems = checkPolicy(p);
  if (problems.length) return { ok: false, message: problems.join(" ") };
  const data = {
    tsMinHoursPerDay: p.minHoursPerDay, tsMaxHoursPerDay: p.maxHoursPerDay, tsMinHoursPerWeek: p.minHoursPerWeek, tsMaxHoursPerWeek: p.maxHoursPerWeek,
    tsIncrementMinutes: p.incrementMinutes, tsRounding: p.rounding, tsApprovalChain: p.approvalChain,
    tsAutoApprove: p.autoApprove, tsAutoApproveMaxHours: p.autoApproveMaxHours, tsFlagWeeklyHoursAbove: p.flagWeeklyHoursAbove,
    tsRemindersEnabled: p.remindersEnabled, tsReminderAfterDays: p.reminderAfterDays, tsEscalationEnabled: p.escalationEnabled, tsEscalateAfterDays: p.escalateAfterDays,
  };
  await prisma.psaSetting.upsert({ where: { tenantId }, create: { ...data, tenantId }, update: data });
  return { ok: true, message: "Timesheet policy saved." };
}

/**
 * Remind (and escalate) for the last `weeks` finished weeks: everyone with a
 * hard allocation on an open project that week whose sheet is not submitted.
 */
export async function runTimesheetReminders(tenantId: string, today = new Date(), opts: { weeks?: number; employeeIds?: string[] } = {}): Promise<{ reminded: number; escalated: number }> {
  const weeks = opts.weeks ?? 4;
  const policy = await getTimesheetPolicy(tenantId);
  const out = { reminded: 0, escalated: 0 };
  if (!policy.remindersEnabled && !policy.escalationEnabled) return out;
  const thisWeek = weekStart(today);
  for (let i = 1; i <= weeks; i++) {
    const week = new Date(thisWeek.getTime() - i * 7 * DAY);
    const due = chaseDue(policy, week, today);
    if (!due.remind && !due.escalate) continue;
    const end = new Date(week.getTime() + 6 * DAY);
    const allocated = await prisma.resourceAllocation.findMany({
      where: {
        kind: "HARD", startDate: { lte: end }, ...(opts.employeeIds ? { employeeId: { in: opts.employeeIds } } : {}), OR: [{ endDate: null }, { endDate: { gte: week } }],
        project: { tenantId, status: { notIn: ["CANCELLED"] }, archivedAt: null },
        employee: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, dateOfJoining: { lte: end } },
      },
      select: { employeeId: true },
    });
    const ids = [...new Set(allocated.map((a) => a.employeeId))];
    if (ids.length === 0) continue;
    const done = new Set((await prisma.timesheet.findMany({ where: { employeeId: { in: ids }, periodStart: week, status: { in: ["SUBMITTED", "APPROVED", "LOCKED"] } }, select: { employeeId: true } })).map((t) => t.employeeId));
    const owing = ids.filter((id) => !done.has(id));
    if (owing.length === 0) continue;
    const sent = await prisma.timesheetReminder.findMany({ where: { employeeId: { in: owing }, periodStart: week }, select: { employeeId: true, kind: true } });
    const has = (id: string, kind: string) => sent.some((s) => s.employeeId === id && s.kind === kind);
    const people = await prisma.employee.findMany({ where: { id: { in: owing } }, select: { id: true, displayName: true, userId: true, reportingManager: { select: { userId: true } } } });
    const label = week.toISOString().slice(0, 10);
    const link = `/projects?tab=time&week=${label}`;
    const escalations = new Map<string, string[]>();
    for (const p of people) {
      if (due.remind && !has(p.id, "REMINDER")) {
        // The unique row is the claim: a second run, or a parallel one, skips it.
        const claimed = await prisma.timesheetReminder.createMany({ data: [{ tenantId, employeeId: p.id, periodStart: week, kind: "REMINDER" }], skipDuplicates: true });
        if (claimed.count) {
          await notify({ tenantId, userIds: [p.userId], kind: "TIMESHEET", title: `Your timesheet for the week of ${label} is not submitted`, body: "Log your time and submit it for approval.", link, email: true });
          out.reminded++;
        }
      }
      if (due.escalate && !has(p.id, "ESCALATION") && p.reportingManager?.userId) {
        const claimed = await prisma.timesheetReminder.createMany({ data: [{ tenantId, employeeId: p.id, periodStart: week, kind: "ESCALATION" }], skipDuplicates: true });
        if (claimed.count) {
          escalations.set(p.reportingManager.userId, [...(escalations.get(p.reportingManager.userId) ?? []), p.displayName ?? "Someone"]);
          out.escalated++;
        }
      }
    }
    for (const [managerUserId, names] of escalations) {
      await notify({ tenantId, userIds: [managerUserId], kind: "TIMESHEET", title: `${names.length} timesheet(s) for the week of ${label} are still not submitted`, body: names.join(", "), link: "/projects?tab=approvals", email: true });
    }
  }
  return out;
}
