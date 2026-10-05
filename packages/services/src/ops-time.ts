import { prisma, type Prisma, type OpsApprovalRequest } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { getTimesheetPolicy } from "./timesheet-policy";
import { weekStart } from "./projects-math";
import { getOpsSettings, opsAudit, opsAlertOnce, opsRequestApproval, type OpsActor } from "./ops-core";
import { opsLockMessage } from "./ops-attendance";
import {
  opsEntryRuleIssues, opsTaskBudgetCheck, opsTimesheetCutoffPassed, opsAllocateOvertime, opsProjectVariance, opsUtilisation, opsTimeLeakage,
  opsExportColumns, opsDay, opsYmd, opsAddDays, OPS_EXPORT_COLUMNS, type OpsEntryRuleInput,
} from "./ops-math";

/**
 * Ops depth — time tracking and project time: activity codes, work
 * packages, templates, entry rules (comments, codes, task budgets, cut-off,
 * period locks), attestation, corrections and reopening, project and task
 * sign-off through approval, idle time, exception and variance alerts, and
 * the reports (audit trail, approvals, budgets, client allocation, skills,
 * utilisation targets, leakage, profitability, overtime allocation, export
 * profiles).
 */

type Result = { ok: boolean; message: string };
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Catalogues
// ---------------------------------------------------------------------------

export async function saveTimeCode(input: { tenantId: string; id?: string | null; code: string; label: string; billable: boolean | null; requiresTask: boolean; requiresComment: boolean; isActive: boolean }): Promise<Result> {
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!code || code.length > 20) return { ok: false, message: "A code is 1 to 20 letters, digits, - or _." };
  if (!input.label.trim()) return { ok: false, message: "Describe the activity." };
  const data = { code, label: input.label.trim(), billable: input.billable, requiresTask: input.requiresTask, requiresComment: input.requiresComment, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsTimeCode.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Activity code saved." } : { ok: false, message: "Code not found." };
    }
    await prisma.opsTimeCode.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: `Activity code ${code} added.` };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: `${code} already exists.` };
    throw err;
  }
}

export async function saveWorkPackage(input: { tenantId: string; id?: string | null; projectId: string; code: string; name: string; budgetHours: number | null; status: string }): Promise<Result> {
  const p = await prisma.project.findFirst({ where: { id: input.projectId, tenantId: input.tenantId }, select: { id: true } });
  if (!p) return { ok: false, message: "Project not found." };
  const code = input.code.trim().toUpperCase();
  if (!code || !input.name.trim()) return { ok: false, message: "Give the work package a code and a name." };
  if (input.budgetHours !== null && !(input.budgetHours >= 0)) return { ok: false, message: "Budget hours cannot be negative." };
  const data = { projectId: p.id, code, name: input.name.trim(), budgetHours: input.budgetHours, status: input.status === "CLOSED" ? "CLOSED" : "OPEN" };
  try {
    if (input.id) {
      const n = await prisma.opsWorkPackage.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Work package saved." } : { ok: false, message: "Work package not found." };
    }
    await prisma.opsWorkPackage.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: `Work package ${code} added.` };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: `${code} already exists on this project.` };
    throw err;
  }
}

export interface OpsTemplateRow { projectId: string; taskId: string; workPackageId: string; timeCode: string; hours: number[]; note: string }

/** Save a set of timesheet rows as a template: an employee's own, or shared by a project administrator. */
export async function saveTimeTemplate(input: { tenantId: string; userId: string; employeeId: string | null; name: string; rows: OpsTemplateRow[]; shared: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the template." };
  const rows = input.rows.filter((r) => r.projectId).map((r) => ({ ...r, hours: Array.from({ length: 7 }, (_, i) => Math.max(0, Math.min(24, Number(r.hours[i] ?? 0) || 0))) }));
  if (!rows.length) return { ok: false, message: "A template needs at least one row with a project." };
  const projects = await prisma.project.count({ where: { tenantId: input.tenantId, id: { in: [...new Set(rows.map((r) => r.projectId))] } } });
  if (projects !== new Set(rows.map((r) => r.projectId)).size) return { ok: false, message: "A project in the template is not one of yours." };
  await prisma.opsTimeTemplate.create({ data: { tenantId: input.tenantId, name: input.name.trim(), employeeId: input.shared ? null : input.employeeId, rows: rows as unknown as Prisma.InputJsonValue, createdBy: input.userId } });
  return { ok: true, message: `Template "${input.name.trim()}" saved.` };
}

export async function deleteTimeTemplate(input: { tenantId: string; id: string; employeeId: string | null; canManageShared: boolean }): Promise<Result> {
  const t = await prisma.opsTimeTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  if (t.employeeId ? t.employeeId !== input.employeeId : !input.canManageShared) return { ok: false, message: "You cannot remove this template." };
  await prisma.opsTimeTemplate.delete({ where: { id: t.id } });
  return { ok: true, message: "Template removed." };
}

export function timeTemplatesFor(tenantId: string, employeeId: string | null) {
  return prisma.opsTimeTemplate.findMany({ where: { tenantId, OR: [{ employeeId: null }, ...(employeeId ? [{ employeeId }] : [])] }, orderBy: [{ employeeId: "asc" }, { name: "asc" }] });
}

/** A template's rows, kept to the projects and tasks the employee can still log against this week. */
export function templateRowsFor(rows: unknown, allowedProjects: Set<string>, allowedTasks: Set<string>): OpsTemplateRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as OpsTemplateRow[]).filter((r) => r && allowedProjects.has(r.projectId)).map((r) => ({
    projectId: r.projectId, taskId: r.taskId && allowedTasks.has(r.taskId) ? r.taskId : "", workPackageId: r.workPackageId ?? "", timeCode: r.timeCode ?? "",
    hours: Array.from({ length: 7 }, (_, i) => Number(r.hours?.[i] ?? 0) || 0), note: r.note ?? "",
  }));
}

// ---------------------------------------------------------------------------
//  Entry rules, applied by saveTimesheet
// ---------------------------------------------------------------------------

export interface OpsSheetEntry extends OpsEntryRuleInput { date: Date; milestoneId?: string | null }

/**
 * The ops rules on a week of time: a locked or closed period, comment and
 * activity-code standards, work packages and milestones that belong to the
 * project, task budgets, and attestation on submit. Returns blocking issues
 * and warnings.
 */
export async function opsTimesheetGate(input: { tenantId: string; employeeId: string; week: Date; sheetId: string | null; entries: OpsSheetEntry[]; submit: boolean; attested?: boolean; now?: Date }): Promise<{ issues: string[]; warnings: string[] }> {
  const s = await getOpsSettings(input.tenantId);
  const issues: string[] = [], warnings: string[] = [];
  const end = opsAddDays(input.week, 6);
  const lock = await opsLockMessage(input.tenantId, "TIMESHEET", input.week, end);
  if (lock) issues.push(lock);
  if (opsTimesheetCutoffPassed(input.week, s.timesheetCutoffDays, input.now ?? new Date())) issues.push(`Time for the week of ${opsYmd(input.week)} closed ${s.timesheetCutoffDays} day(s) after the week ended. Ask for a correction instead.`);
  const codes = await prisma.opsTimeCode.findMany({ where: { tenantId: input.tenantId } });
  issues.push(...opsEntryRuleIssues(input.entries, { requireComment: s.requireEntryComment, minLength: s.entryCommentMinLength, requireTimeCode: s.requireTimeCode, codes: codes.map((c) => ({ ...c })) }));
  const wpIds = [...new Set(input.entries.map((e) => e.workPackageId).filter((x): x is string => !!x))];
  if (wpIds.length) {
    const wps = new Map((await prisma.opsWorkPackage.findMany({ where: { tenantId: input.tenantId, id: { in: wpIds } } })).map((w) => [w.id, w]));
    for (const e of input.entries) {
      if (!e.workPackageId) continue;
      const w = wps.get(e.workPackageId);
      if (!w || w.projectId !== e.projectId) issues.push("A work package does not belong to the project it is logged against.");
      else if (w.status !== "OPEN") issues.push(`Work package ${w.code} is closed to new time.`);
    }
  }
  const msIds = [...new Set(input.entries.map((e) => e.milestoneId).filter((x): x is string => !!x))];
  if (msIds.length) {
    const ms = new Map((await prisma.milestone.findMany({ where: { id: { in: msIds }, project: { tenantId: input.tenantId } }, select: { id: true, projectId: true } })).map((m) => [m.id, m.projectId]));
    if (input.entries.some((e) => e.milestoneId && ms.get(e.milestoneId) !== e.projectId)) issues.push("A milestone does not belong to the project it is logged against.");
  }
  if (s.taskBudgetMode !== "OFF") {
    const byTask = new Map<string, number>();
    for (const e of input.entries) if (e.taskId) byTask.set(e.taskId, (byTask.get(e.taskId) ?? 0) + e.hours);
    if (byTask.size) {
      const tasks = await prisma.task.findMany({ where: { tenantId: input.tenantId, id: { in: [...byTask.keys()] } }, select: { id: true, title: true, estimatedHours: true, loggedHours: true } });
      const mine = input.sheetId ? await prisma.timeEntry.groupBy({ by: ["taskId"], where: { timesheetId: input.sheetId, taskId: { in: [...byTask.keys()] } }, _sum: { hours: true } }) : [];
      const mineBy = new Map(mine.map((m) => [m.taskId, Number(m._sum.hours ?? 0)]));
      for (const t of tasks) {
        const c = opsTaskBudgetCheck({ title: t.title, estimated: t.estimatedHours === null ? null : Number(t.estimatedHours), loggedElsewhere: Number(t.loggedHours) - (mineBy.get(t.id) ?? 0), adding: byTask.get(t.id)! }, s.taskBudgetMode, s.taskBudgetTolerancePct);
        if (c.warning) (c.block ? issues : warnings).push(c.warning);
      }
    }
  }
  if (input.submit && s.requireAttestation && !input.attested) issues.push("Confirm that these hours are a true record of your work before submitting.");
  return { issues: [...new Set(issues)], warnings };
}

/** After a submit with attestation: the employee's certification of the week. */
export async function recordWeekAttestation(input: { tenantId: string; employeeId: string; userId: string; timesheetId: string; week: Date; hours: number }): Promise<void> {
  await prisma.opsTimeCertification.create({
    data: { tenantId: input.tenantId, scope: "EMPLOYEE_WEEK", timesheetId: input.timesheetId, employeeId: input.employeeId, periodStart: input.week, periodEnd: opsAddDays(input.week, 6), hours: input.hours, statement: "I confirm these hours are a true and complete record of my work for the week.", status: "CERTIFIED", certifiedBy: input.userId },
  });
}

// ---------------------------------------------------------------------------
//  Locks, reopen and corrections
// ---------------------------------------------------------------------------

/** Lock every approved timesheet in a period (and the period itself). */
export async function lockTimesheets(input: { actor: OpsActor; from: Date; to: Date; reason?: string | null }): Promise<Result> {
  const t = input.actor.tenantId;
  const from = weekStart(input.from), to = opsDay(input.to);
  const { lockOpsPeriod } = await import("./ops-attendance");
  const res = await lockOpsPeriod({ actor: input.actor, domain: "TIMESHEET", periodStart: from, periodEnd: to, reason: input.reason });
  if (!res.ok) return res;
  const n = await prisma.timesheet.updateMany({ where: { tenantId: t, status: "APPROVED", periodStart: { gte: from, lte: to } }, data: { status: "LOCKED" } });
  return { ok: true, message: `${res.message} ${n.count} approved timesheet(s) locked.` };
}

/** An administrator reopens a week: back to draft so the employee can change it. */
export async function reopenTimesheet(input: { actor: OpsActor; timesheetId: string; reason: string }): Promise<Result> {
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why the week is being reopened." };
  const s = await prisma.timesheet.findFirst({ where: { id: input.timesheetId, tenantId: input.actor.tenantId }, include: { entries: { select: { isInvoiced: true } }, employee: { select: { userId: true, displayName: true } } } });
  if (!s) return { ok: false, message: "Timesheet not found." };
  if (!["APPROVED", "LOCKED", "SUBMITTED"].includes(s.status)) return { ok: false, message: `A ${s.status.toLowerCase()} week is already open.` };
  if (s.entries.some((e) => e.isInvoiced)) return { ok: false, message: "Some of this time has been invoiced; raise a credit note instead." };
  const lock = await opsLockMessage(input.actor.tenantId, "TIMESHEET", s.periodStart, s.periodEnd);
  if (lock) return { ok: false, message: lock };
  await prisma.timesheet.update({ where: { id: s.id }, data: { status: "DRAFT", approvedAt: null, approvedBy: null, approvalStep: 0, firstApprovedBy: null, rejectReason: `Reopened: ${input.reason.trim()}` } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "PROJECTS", action: "UNLOCK", entityType: "Timesheet", entityId: s.id, summary: `Reopened ${s.employee.displayName}'s week of ${opsYmd(s.periodStart)} (was ${s.status.toLowerCase()}): ${input.reason.trim()}` });
  await notify({ tenantId: input.actor.tenantId, userIds: [s.employee.userId], kind: "TIMESHEET", title: `Your week of ${opsYmd(s.periodStart)} was reopened for changes`, body: input.reason.trim(), link: `/projects?tab=time&week=${opsYmd(s.periodStart)}` });
  return { ok: true, message: "Reopened for changes." };
}

/** The employee asks to correct an approved week; the manager decides. */
export async function requestTimeCorrection(input: { actor: OpsActor; employeeId: string; timesheetId: string; reason: string }): Promise<Result> {
  const s = await prisma.timesheet.findFirst({ where: { id: input.timesheetId, tenantId: input.actor.tenantId, employeeId: input.employeeId }, include: { entries: { select: { isInvoiced: true } } } });
  if (!s) return { ok: false, message: "Timesheet not found." };
  if (!["APPROVED", "LOCKED"].includes(s.status)) return { ok: false, message: "Only an approved week needs a correction request; edit a draft directly." };
  if (s.entries.some((e) => e.isInvoiced)) return { ok: false, message: "Some of this time has been invoiced and cannot be corrected." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say what needs correcting." };
  return opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_TIME_CORRECTION", targetId: s.id, targetLabel: `Week of ${opsYmd(s.periodStart)} (${Number(s.totalHours)} h)`, employeeId: input.employeeId,
    reason: input.reason.trim(), requestedBy: input.actor.userId, title: `Timesheet correction: week of ${opsYmd(s.periodStart)}`, link: `/projects?tab=time&week=${opsYmd(s.periodStart)}`,
  });
}

export async function applyTimeCorrectionDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.targetId) return;
  const s = await prisma.timesheet.findFirst({ where: { id: a.targetId, tenantId: a.tenantId }, include: { entries: { select: { isInvoiced: true } }, employee: { select: { userId: true } } } });
  if (!s) throw new Error("Timesheet not found.");
  if (s.entries.some((e) => e.isInvoiced)) throw new Error("The time was invoiced after the request was raised.");
  if (await opsLockMessage(a.tenantId, "TIMESHEET", s.periodStart, s.periodEnd)) throw new Error("The period is locked; reopen it first.");
  await prisma.timesheet.update({ where: { id: s.id }, data: { status: "DRAFT", approvedAt: null, approvedBy: null, approvalStep: 0, firstApprovedBy: null, rejectReason: `Correction approved: ${a.reason ?? ""}` } });
  await opsAudit(a.tenantId, actorUserId, { module: "PROJECTS", action: "UNLOCK", entityType: "Timesheet", entityId: s.id, summary: `Correction approved; week of ${opsYmd(s.periodStart)} reopened: ${a.reason ?? ""}` });
  await notify({ tenantId: a.tenantId, userIds: [s.employee.userId], kind: "TIMESHEET", title: `Correction approved: edit and resubmit your week of ${opsYmd(s.periodStart)}`, link: `/projects?tab=time&week=${opsYmd(s.periodStart)}` });
}

// ---------------------------------------------------------------------------
//  Certification and task sign-off
// ---------------------------------------------------------------------------

/** A project manager certifies a project's approved hours for a period; the PMO approves. */
export async function certifyProjectTime(input: { actor: OpsActor; projectId: string; from: Date; to: Date; statement: string }): Promise<Result> {
  const t = input.actor.tenantId;
  const p = await prisma.project.findFirst({ where: { id: input.projectId, tenantId: t }, select: { id: true, name: true } });
  if (!p) return { ok: false, message: "Project not found." };
  if (input.to < input.from) return { ok: false, message: "The period ends before it starts." };
  const from = opsDay(input.from), to = opsDay(input.to);
  const pending = await prisma.timeEntry.count({ where: { tenantId: t, projectId: p.id, date: { gte: from, lte: to }, timesheet: { status: { in: ["DRAFT", "SUBMITTED", "REJECTED"] } } } });
  if (pending) return { ok: false, message: `${pending} entr${pending === 1 ? "y is" : "ies are"} on weeks not yet approved; approve them first.` };
  const agg = await prisma.timeEntry.aggregate({ where: { tenantId: t, projectId: p.id, date: { gte: from, lte: to } }, _sum: { hours: true } });
  const hours = Number(agg._sum.hours ?? 0);
  if (!input.statement.trim()) return { ok: false, message: "Add the certification statement." };
  const cert = await prisma.opsTimeCertification.create({ data: { tenantId: t, scope: "PROJECT_PERIOD", projectId: p.id, periodStart: from, periodEnd: to, hours, statement: input.statement.trim(), status: "PENDING_APPROVAL", certifiedBy: input.actor.userId } });
  const res = await opsRequestApproval({
    tenantId: t, entityType: "OPS_TIME_CERT", targetId: cert.id, targetLabel: `${p.name}: ${hours} h, ${opsYmd(from)} to ${opsYmd(to)}`, payload: { hours },
    requestedBy: input.actor.userId, title: `Certify ${p.name} time ${opsYmd(from)} – ${opsYmd(to)} (${hours} h)`, details: input.statement.trim(), link: "/projects/time-controls?tab=certification",
  });
  if (!res.ok) { await prisma.opsTimeCertification.delete({ where: { id: cert.id } }); return res; }
  await prisma.opsTimeCertification.update({ where: { id: cert.id }, data: { approvalId: res.id } });
  return { ...res, message: res.status === "APPLIED" ? `Certified ${hours} h.` : `Certified ${hours} h and sent for approval.` };
}

export async function applyTimeCertDecision(a: OpsApprovalRequest, outcome: string): Promise<void> {
  if (!a.targetId) return;
  await prisma.opsTimeCertification.updateMany({ where: { id: a.targetId, tenantId: a.tenantId }, data: { status: outcome === "APPROVED" ? "APPROVED" : "REJECTED", decidedAt: new Date() } });
}

/** Ask the project manager to sign a task off as done. */
export async function requestTaskSignoff(input: { actor: OpsActor; taskId: string; employeeId: string | null; note?: string | null; canManage: boolean }): Promise<Result> {
  const task = await prisma.task.findFirst({ where: { id: input.taskId, tenantId: input.actor.tenantId }, include: { project: { select: { name: true, projectManager: { select: { userId: true } }, projectManagerId: true } } } });
  if (!task) return { ok: false, message: "Task not found." };
  if (!input.canManage && task.assigneeId !== input.employeeId && task.project.projectManagerId !== input.employeeId) return { ok: false, message: "Only the assignee or the project's people can ask for sign-off." };
  if (task.status === "DONE") return { ok: false, message: "This task is already done." };
  return opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_TASK_SIGNOFF", targetId: task.id, targetLabel: `${task.project.name}: ${task.title}`, employeeId: task.assigneeId,
    payload: { loggedHours: Number(task.loggedHours), estimatedHours: task.estimatedHours === null ? null : Number(task.estimatedHours) }, reason: input.note ?? null,
    requestedBy: input.actor.userId, title: `Sign off task "${task.title}"`, details: `${Number(task.loggedHours)} h logged${task.estimatedHours ? ` of ${Number(task.estimatedHours)} h estimated` : ""}.`, link: `/projects/${task.projectId}`,
    reviewerUserId: task.project.projectManager?.userId ?? null,
  });
}

export async function applyTaskSignoffDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.targetId) return;
  const n = await prisma.task.updateMany({ where: { id: a.targetId, tenantId: a.tenantId }, data: { status: "DONE", completedAt: new Date(), progressPercent: 100 } });
  if (!n.count) throw new Error("Task not found.");
  await opsAudit(a.tenantId, actorUserId, { module: "PROJECTS", action: "APPROVE", entityType: "Task", entityId: a.targetId, summary: `Task signed off: ${a.targetLabel}` });
}

// ---------------------------------------------------------------------------
//  Idle time
// ---------------------------------------------------------------------------

export async function logIdleTime(input: { actor: OpsActor; employeeId: string; date: Date; minutes: number; category: string; note?: string | null }): Promise<Result> {
  const t = input.actor.tenantId;
  if (!(input.minutes > 0 && input.minutes <= 24 * 60)) return { ok: false, message: "Idle time is 1 minute to 24 hours." };
  const cat = await prisma.opsReasonCode.findFirst({ where: { tenantId: t, kind: "IDLE", code: input.category, isActive: true } });
  if (!cat) return { ok: false, message: "Choose an idle-time category." };
  if (opsDay(input.date).getTime() > opsDay(new Date()).getTime()) return { ok: false, message: "Idle time is logged for today or earlier." };
  if (await opsLockMessage(t, "TIMESHEET", input.date)) return { ok: false, message: (await opsLockMessage(t, "TIMESHEET", input.date))! };
  await prisma.opsIdleLog.create({ data: { tenantId: t, employeeId: input.employeeId, date: opsDay(input.date), minutes: Math.round(input.minutes), category: cat.code, note: input.note ?? null, createdBy: input.actor.userId } });
  return { ok: true, message: `${Math.round(input.minutes)} minutes of ${cat.label.toLowerCase()} logged.` };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

/** Attendance, timesheet and idle hours per employee over a period: tracked vs scheduled, and leakage. */
export async function timeLeakageReport(tenantId: string, from: Date, to: Date, employeeIds?: string[]) {
  const where = { tenantId, ...(employeeIds ? { id: { in: employeeIds } } : {}), status: { notIn: ["EXITED", "PREBOARDING"] as never[] } };
  const emps = await prisma.employee.findMany({ where, select: { id: true, displayName: true, employeeNumber: true } });
  const ids = emps.map((e) => e.id);
  const [recs, entries, idle, shifts] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: opsDay(from), lte: opsDay(to) } }, select: { employeeId: true, status: true, manualStatus: true, effectiveHours: true, shiftId: true } }),
    prisma.timeEntry.groupBy({ by: ["employeeId"], where: { tenantId, employeeId: { in: ids }, date: { gte: opsDay(from), lte: opsDay(to) } }, _sum: { hours: true } }),
    prisma.opsIdleLog.groupBy({ by: ["employeeId"], where: { tenantId, employeeId: { in: ids }, date: { gte: opsDay(from), lte: opsDay(to) } }, _sum: { minutes: true } }),
    prisma.shift.findMany({ where: { tenantId } }),
  ]);
  const shiftHours = new Map(shifts.map((s) => {
    if (s.isFlexible && s.requiredHours) return [s.id, Number(s.requiredHours)];
    const [sh, sm] = s.startTime.split(":").map(Number), [eh, em] = s.endTime.split(":").map(Number);
    let span = (eh! * 60 + (em ?? 0)) - (sh! * 60 + (sm ?? 0));
    if (span <= 0 || s.crossesMidnight) span += 1440;
    return [s.id, Math.max(0, (span - s.breakMinutes) / 60)];
  }));
  const logged = new Map(entries.map((e) => [e.employeeId, Number(e._sum.hours ?? 0)]));
  const idleBy = new Map(idle.map((e) => [e.employeeId, (e._sum.minutes ?? 0) / 60]));
  return emps.map((e) => {
    const mine = recs.filter((r) => r.employeeId === e.id);
    const scheduled = r2(mine.filter((r) => !["WEEKLY_OFF", "HOLIDAY", "ON_LEAVE"].includes(r.manualStatus ?? r.status)).reduce((s, r) => s + (r.shiftId ? shiftHours.get(r.shiftId) ?? 8 : 8), 0));
    const attended = r2(mine.reduce((s, r) => s + Number(r.effectiveHours), 0));
    const l = r2(logged.get(e.id) ?? 0), i = r2(idleBy.get(e.id) ?? 0);
    return { employeeId: e.id, employee: e.displayName ?? "", employeeNumber: e.employeeNumber, scheduled, attended, logged: l, idle: i, ...opsTimeLeakage({ scheduled, attended, logged: l, idle: i }) };
  }).sort((a, b) => b.leakageHours - a.leakageHours);
}

/** Budgeted vs actual hours by project and task. */
export async function budgetVsActual(tenantId: string, projectId?: string | null) {
  const projects = await prisma.project.findMany({ where: { tenantId, ...(projectId ? { id: projectId } : {}), archivedAt: null }, select: { id: true, name: true, code: true, estimatedHours: true, startDate: true, endDate: true, status: true, client: { select: { name: true } }, tasks: { select: { id: true, title: true, estimatedHours: true, loggedHours: true, status: true } } }, orderBy: { name: "asc" } });
  const actual = new Map((await prisma.timeEntry.groupBy({ by: ["projectId"], where: { tenantId, projectId: { in: projects.map((p) => p.id) } }, _sum: { hours: true } })).map((a) => [a.projectId, Number(a._sum.hours ?? 0)]));
  const today = new Date();
  return projects.map((p) => {
    const act = actual.get(p.id) ?? 0;
    const v = opsProjectVariance({ budgetHours: p.estimatedHours === null ? null : Number(p.estimatedHours), actualHours: act, start: p.startDate, end: p.endDate }, today);
    return {
      id: p.id, name: p.name, code: p.code, client: p.client?.name ?? "", status: p.status, budget: p.estimatedHours === null ? null : Number(p.estimatedHours), actual: r2(act), ...v,
      tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, estimated: t.estimatedHours === null ? null : Number(t.estimatedHours), logged: Number(t.loggedHours), over: t.estimatedHours !== null && Number(t.loggedHours) > Number(t.estimatedHours) })),
    };
  });
}

/** Hours by client and employee (and billable share) over a period. */
export async function clientAllocation(tenantId: string, from: Date, to: Date) {
  const entries = await prisma.timeEntry.findMany({ where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) } }, select: { employeeId: true, hours: true, isBillable: true, clientId: true, project: { select: { clientId: true } } } });
  const clients = new Map((await prisma.client.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(entries.map((e) => e.employeeId))] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName ?? ""]));
  const by = new Map<string, { client: string; total: number; billable: number; people: Map<string, number> }>();
  for (const e of entries) {
    const cid = e.clientId ?? e.project.clientId ?? "INTERNAL";
    const r = by.get(cid) ?? { client: cid === "INTERNAL" ? "Internal (no client)" : clients.get(cid) ?? "Unknown client", total: 0, billable: 0, people: new Map() };
    r.total += Number(e.hours); if (e.isBillable) r.billable += Number(e.hours);
    r.people.set(e.employeeId, (r.people.get(e.employeeId) ?? 0) + Number(e.hours));
    by.set(cid, r);
  }
  const grand = [...by.values()].reduce((s, r) => s + r.total, 0);
  return [...by.entries()].map(([id, r]) => ({ clientId: id, client: r.client, total: r2(r.total), billable: r2(r.billable), share: grand ? r2((r.total / grand) * 100) : 0, people: [...r.people.entries()].map(([pid, h]) => ({ employee: emps.get(pid) ?? "", hours: r2(h) })).sort((a, b) => b.hours - a.hours) })).sort((a, b) => b.total - a.total);
}

/** Logged and billable hours by skill (each person counts toward every skill they hold). */
export async function utilisationBySkill(tenantId: string, from: Date, to: Date) {
  const entries = await prisma.timeEntry.groupBy({ by: ["employeeId", "isBillable"], where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) } }, _sum: { hours: true } });
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  const skills = await prisma.employeeSkill.findMany({ where: { employeeId: { in: ids }, skill: { tenantId } }, select: { employeeId: true, skill: { select: { name: true } } } });
  const workdays = Math.max(1, Math.round(((opsDay(to).getTime() - opsDay(from).getTime()) / DAY + 1) * 5 / 7));
  const by = new Map<string, { people: Set<string>; logged: number; billable: number }>();
  for (const s of skills) {
    const r = by.get(s.skill.name) ?? { people: new Set(), logged: 0, billable: 0 };
    if (!r.people.has(s.employeeId)) {
      r.people.add(s.employeeId);
      for (const e of entries.filter((x) => x.employeeId === s.employeeId)) { r.logged += Number(e._sum.hours ?? 0); if (e.isBillable) r.billable += Number(e._sum.hours ?? 0); }
    }
    by.set(s.skill.name, r);
  }
  return [...by.entries()].map(([skill, r]) => {
    const capacity = r.people.size * workdays * 8;
    const u = opsUtilisation(r.billable, r.logged, capacity, null);
    return { skill, people: r.people.size, logged: r2(r.logged), billable: r2(r.billable), capacity, ...u };
  }).sort((a, b) => b.billablePct - a.billablePct);
}

/** Billable utilisation per person against their target. */
export async function utilisationTargets(tenantId: string, from: Date, to: Date) {
  const profiles = await prisma.resourceProfile.findMany({ where: { tenantId }, select: { employeeId: true, targetUtilization: true, capacity: true, employee: { select: { displayName: true, employeeNumber: true, status: true } } } });
  const entries = await prisma.timeEntry.groupBy({ by: ["employeeId", "isBillable"], where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) } }, _sum: { hours: true } });
  const days = Math.round((opsDay(to).getTime() - opsDay(from).getTime()) / DAY) + 1;
  return profiles.filter((p) => p.employee.status !== "EXITED").map((p) => {
    const week = Array.isArray(p.capacity) ? (p.capacity as number[]).reduce((s, h) => s + Number(h || 0), 0) : 40;
    const capacity = r2((week * days) / 7);
    const mine = entries.filter((e) => e.employeeId === p.employeeId);
    const logged = mine.reduce((s, e) => s + Number(e._sum.hours ?? 0), 0);
    const billable = mine.filter((e) => e.isBillable).reduce((s, e) => s + Number(e._sum.hours ?? 0), 0);
    return { employeeId: p.employeeId, employee: p.employee.displayName ?? "", employeeNumber: p.employee.employeeNumber, target: p.targetUtilization, capacity, logged: r2(logged), billable: r2(billable), ...opsUtilisation(billable, logged, capacity, p.targetUtilization) };
  }).sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0));
}

/** Hours, cost and billable value per project from approved time: the feed for profitability. */
export async function profitabilityFeed(tenantId: string, from: Date, to: Date) {
  const entries = await prisma.timeEntry.findMany({ where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) }, timesheet: { status: { in: ["APPROVED", "LOCKED"] } } }, select: { projectId: true, hours: true, isBillable: true, billRate: true, costRate: true } });
  const projects = new Map((await prisma.project.findMany({ where: { tenantId }, select: { id: true, name: true, code: true, budget: true, client: { select: { name: true } } } })).map((p) => [p.id, p]));
  const ot = await prisma.opsProjectOvertimeAllocation.groupBy({ by: ["projectId"], where: { tenantId, date: { gte: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)), lte: opsDay(to) } }, _sum: { amount: true, hours: true } });
  const otBy = new Map(ot.map((o) => [o.projectId, { amount: Number(o._sum.amount ?? 0), hours: Number(o._sum.hours ?? 0) }]));
  const by = new Map<string, { hours: number; billable: number; revenue: number; cost: number }>();
  for (const e of entries) {
    const r = by.get(e.projectId) ?? { hours: 0, billable: 0, revenue: 0, cost: 0 };
    const h = Number(e.hours);
    r.hours += h; if (e.isBillable) { r.billable += h; r.revenue += h * Number(e.billRate ?? 0); }
    r.cost += h * Number(e.costRate ?? 0);
    by.set(e.projectId, r);
  }
  return [...by.entries()].map(([id, r]) => {
    const p = projects.get(id);
    const o = otBy.get(id) ?? { amount: 0, hours: 0 };
    const cost = r2(r.cost + o.amount);
    return { projectId: id, project: p?.name ?? "", code: p?.code ?? "", client: p?.client?.name ?? "", hours: r2(r.hours), billableHours: r2(r.billable), revenue: r2(r.revenue), labourCost: r2(r.cost), overtimeCost: r2(o.amount), cost, margin: r2(r.revenue - cost), marginPct: r.revenue ? r2(((r.revenue - cost) / r.revenue) * 100) : null };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** Share a month's approved overtime among the projects each person worked on that month. */
export async function allocateProjectOvertime(input: { actor: OpsActor; year: number; month: number }): Promise<Result & { allocated?: number }> {
  const t = input.actor.tenantId;
  const from = new Date(Date.UTC(input.year, input.month - 1, 1)), to = new Date(Date.UTC(input.year, input.month, 0));
  const ots = await prisma.overtimeEntry.findMany({ where: { tenantId: t, year: input.year, month: input.month } });
  let allocated = 0;
  for (const ot of ots) {
    const hours = await prisma.timeEntry.groupBy({ by: ["projectId"], where: { tenantId: t, employeeId: ot.employeeId, date: { gte: from, lte: to } }, _sum: { hours: true } });
    const split = opsAllocateOvertime(Number(ot.hours), Number(ot.amount), hours.map((h) => ({ projectId: h.projectId, hours: Number(h._sum.hours ?? 0) })));
    if (!split.length) continue;
    await prisma.$transaction(async (tx) => {
      await tx.opsProjectOvertimeAllocation.deleteMany({ where: { overtimeEntryId: ot.id } });
      await tx.opsProjectOvertimeAllocation.createMany({ data: split.map((s) => ({ tenantId: t, overtimeEntryId: ot.id, employeeId: ot.employeeId, projectId: s.projectId, date: from, hours: s.hours, amount: s.amount })) });
    });
    allocated++;
  }
  await opsAudit(t, input.actor.userId, { module: "PROJECTS", action: "UPDATE", entityType: "OpsProjectOvertimeAllocation", summary: `Allocated overtime for ${input.month}/${input.year} to projects: ${allocated} of ${ots.length} entr(ies)` });
  return { ok: true, allocated, message: ots.length ? `Allocated ${allocated} of ${ots.length} overtime entr${ots.length === 1 ? "y" : "ies"}${allocated < ots.length ? " (the rest have no project time that month)" : ""}.` : "No overtime that month." };
}

/** Timesheet audit trail and approval decisions. */
export async function timesheetAuditTrail(tenantId: string, from: Date, to: Date, employeeId?: string | null) {
  const sheetIds = employeeId ? (await prisma.timesheet.findMany({ where: { tenantId, employeeId }, select: { id: true } })).map((s) => s.id) : null;
  return prisma.auditLog.findMany({
    where: { tenantId, entityType: { in: ["Timesheet", "TimeEntry", "Task", "OpsTimeCertification"] }, createdAt: { gte: opsDay(from), lt: opsAddDays(to, 1) }, ...(sheetIds ? { entityId: { in: sheetIds } } : {}) },
    orderBy: { createdAt: "desc" }, take: 500,
  });
}

export async function approvalDecisionsReport(tenantId: string, from: Date, to: Date) {
  const sheets = await prisma.timesheet.findMany({ where: { tenantId, OR: [{ approvedAt: { gte: opsDay(from), lt: opsAddDays(to, 1) } }, { rejectedAt: { gte: opsDay(from), lt: opsAddDays(to, 1) } }] }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { periodStart: "desc" } });
  const users = new Map((await prisma.user.findMany({ where: { tenantId, id: { in: [...new Set(sheets.flatMap((s) => [s.approvedBy, s.rejectedBy]).filter((x): x is string => !!x))] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } })).map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const rows = sheets.map((s) => {
    const decidedAt = s.status === "REJECTED" ? s.rejectedAt : s.approvedAt;
    const by = s.status === "REJECTED" ? s.rejectedBy : s.approvedBy;
    return { id: s.id, employee: s.employee.displayName ?? "", employeeNumber: s.employee.employeeNumber, week: s.periodStart, hours: Number(s.totalHours), decision: s.status === "REJECTED" ? "REJECTED" : s.autoApproved ? "AUTO_APPROVED" : "APPROVED", by: by ? users.get(by) ?? "" : s.autoApproved ? "system" : "", decidedAt, turnaroundHours: decidedAt && s.submittedAt ? r2((decidedAt.getTime() - s.submittedAt.getTime()) / 3_600_000) : null, reason: s.rejectReason };
  });
  const byApprover = new Map<string, { approved: number; rejected: number; hours: number[] }>();
  for (const r of rows) {
    const k = r.by || "—";
    const a = byApprover.get(k) ?? { approved: 0, rejected: 0, hours: [] };
    if (r.decision === "REJECTED") a.rejected++; else a.approved++;
    if (r.turnaroundHours !== null) a.hours.push(r.turnaroundHours);
    byApprover.set(k, a);
  }
  return { rows, approvers: [...byApprover.entries()].map(([by, a]) => ({ by, approved: a.approved, rejected: a.rejected, avgTurnaroundHours: a.hours.length ? r2(a.hours.reduce((s, x) => s + x, 0) / a.hours.length) : null })) };
}

/** Task report: estimate vs logged, sign-off state. */
export async function taskReport(tenantId: string, projectId?: string | null) {
  const tasks = await prisma.task.findMany({ where: { tenantId, ...(projectId ? { projectId } : {}) }, include: { project: { select: { name: true } }, assignee: { select: { displayName: true } } }, orderBy: [{ projectId: "asc" }, { createdAt: "asc" }], take: 1000 });
  const signoffs = new Map((await prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_TASK_SIGNOFF", targetId: { in: tasks.map((t) => t.id) } }, orderBy: { createdAt: "asc" } })).map((a) => [a.targetId!, a.status]));
  return tasks.map((t) => ({ id: t.id, project: t.project.name, title: t.title, assignee: t.assignee?.displayName ?? "", status: t.status, estimated: t.estimatedHours === null ? null : Number(t.estimatedHours), logged: Number(t.loggedHours), variance: t.estimatedHours === null ? null : r2(Number(t.loggedHours) - Number(t.estimatedHours)), signoff: signoffs.get(t.id) ?? null, dueDate: t.dueDate }));
}

/** Rows for a saved export profile. */
export async function exportProfileRows(tenantId: string, profileId: string, from: Date, to: Date): Promise<{ name: string; head: string[]; rows: unknown[][] } | null> {
  const p = await prisma.opsExportProfile.findFirst({ where: { id: profileId, tenantId } });
  if (!p) return null;
  const cols = opsExportColumns(p.columns);
  const entries = await prisma.timeEntry.findMany({
    where: {
      tenantId, date: { gte: opsDay(from), lte: opsDay(to) }, ...(p.projectId ? { projectId: p.projectId } : {}), ...(p.billableOnly ? { isBillable: true } : {}),
      ...(p.clientId ? { OR: [{ clientId: p.clientId }, { clientId: null, project: { clientId: p.clientId } }] } : {}),
      ...(p.approvedOnly ? { timesheet: { status: { in: ["APPROVED", "LOCKED"] } } } : {}),
    },
    include: { project: { select: { name: true, client: { select: { name: true } } } }, task: { select: { title: true } }, timesheet: { select: { status: true } } },
    orderBy: [{ date: "asc" }, { employeeId: "asc" }],
  });
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(entries.map((e) => e.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
  const wps = new Map((await prisma.opsWorkPackage.findMany({ where: { tenantId } })).map((w) => [w.id, `${w.code} ${w.name}`]));
  const ms = new Map((await prisma.milestone.findMany({ where: { project: { tenantId } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
  const cell = (e: (typeof entries)[number], c: string): unknown => {
    const h = Number(e.hours);
    switch (c) {
      case "date": return opsYmd(e.date);
      case "employeeNumber": return emps.get(e.employeeId)?.employeeNumber ?? "";
      case "employee": return emps.get(e.employeeId)?.displayName ?? "";
      case "client": return e.project.client?.name ?? "";
      case "project": return e.project.name;
      case "task": return e.task?.title ?? "";
      case "workPackage": return e.workPackageId ? wps.get(e.workPackageId) ?? "" : "";
      case "milestone": return e.milestoneId ? ms.get(e.milestoneId) ?? "" : "";
      case "timeCode": return e.timeCode ?? "";
      case "hours": return h;
      case "billable": return e.isBillable ? "Yes" : "No";
      case "billRate": return e.billRate === null ? "" : Number(e.billRate);
      case "billAmount": return e.isBillable && e.billRate !== null ? r2(h * Number(e.billRate)) : "";
      case "costRate": return e.costRate === null ? "" : Number(e.costRate);
      case "costAmount": return e.costRate !== null ? r2(h * Number(e.costRate)) : "";
      case "note": return e.description ?? "";
      case "status": return e.timesheet?.status ?? "";
      default: return "";
    }
  };
  return { name: p.name, head: cols.map((c) => OPS_EXPORT_COLUMNS[c]!), rows: entries.map((e) => cols.map((c) => cell(e, c))) };
}

export async function saveExportProfile(input: { tenantId: string; userId: string; id?: string | null; name: string; columns: string[]; clientId?: string | null; projectId?: string | null; billableOnly: boolean; approvedOnly: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the profile." };
  if (input.clientId && !(await prisma.client.findFirst({ where: { id: input.clientId, tenantId: input.tenantId } }))) return { ok: false, message: "Client not found." };
  if (input.projectId && !(await prisma.project.findFirst({ where: { id: input.projectId, tenantId: input.tenantId } }))) return { ok: false, message: "Project not found." };
  const data = { name: input.name.trim(), columns: opsExportColumns(input.columns), clientId: input.clientId || null, projectId: input.projectId || null, billableOnly: input.billableOnly, approvedOnly: input.approvedOnly };
  try {
    if (input.id) {
      const n = await prisma.opsExportProfile.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Profile saved." } : { ok: false, message: "Profile not found." };
    }
    await prisma.opsExportProfile.create({ data: { ...data, tenantId: input.tenantId, createdBy: input.userId } });
    return { ok: true, message: `Profile "${data.name}" saved.` };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: "A profile with that name exists." };
    throw err;
  }
}

// ---------------------------------------------------------------------------
//  Alerts (nightly)
// ---------------------------------------------------------------------------

/** Last week's time-entry exceptions: days over the limit, time on leave or holidays, more time than attendance. */
export async function runTimeEntryExceptionAlerts(tenantId: string, now = new Date()): Promise<{ checked: number; alerted: number }> {
  const policy = await getTimesheetPolicy(tenantId);
  const week = new Date(weekStart(now).getTime() - 7 * DAY);
  const end = opsAddDays(week, 6);
  const entries = await prisma.timeEntry.groupBy({ by: ["employeeId", "date"], where: { tenantId, date: { gte: week, lte: end } }, _sum: { hours: true } });
  const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, date: { gte: week, lte: end }, employeeId: { in: [...new Set(entries.map((e) => e.employeeId))] } }, select: { employeeId: true, date: true, status: true, manualStatus: true, effectiveHours: true } });
  const rec = new Map(recs.map((r) => [`${r.employeeId}|${opsYmd(r.date)}`, r]));
  const issues = new Map<string, string[]>();
  for (const e of entries) {
    const h = Number(e._sum.hours ?? 0);
    const r = rec.get(`${e.employeeId}|${opsYmd(e.date)}`);
    const st = r ? r.manualStatus ?? r.status : null;
    const list: string[] = [];
    if (h > policy.maxHoursPerDay || h > 12) list.push(`${opsYmd(e.date)}: ${h} h logged in a day`);
    if (st === "ON_LEAVE") list.push(`${opsYmd(e.date)}: ${h} h logged while on leave`);
    else if (st === "HOLIDAY" || st === "WEEKLY_OFF") list.push(`${opsYmd(e.date)}: ${h} h logged on a ${st === "HOLIDAY" ? "holiday" : "weekly off"}`);
    else if (r && Number(r.effectiveHours) > 0 && h > Number(r.effectiveHours) + 1) list.push(`${opsYmd(e.date)}: ${h} h logged but ${Number(r.effectiveHours)} h in attendance`);
    if (list.length) issues.set(e.employeeId, [...(issues.get(e.employeeId) ?? []), ...list]);
  }
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...issues.keys()] } }, select: { id: true, userId: true, displayName: true, reportingManager: { select: { userId: true } } } });
  let alerted = 0;
  for (const e of emps) {
    const list = issues.get(e.id)!;
    if (await opsAlertOnce(tenantId, "TIME_ENTRY_EXCEPTION", `${opsYmd(week)}:${e.id}`, { userIds: [e.userId ?? "", e.reportingManager?.userId ?? ""], title: `${e.displayName}: ${list.length} time-entry exception(s) for the week of ${opsYmd(week)}`, body: list.join("\n"), link: `/projects?tab=time&week=${opsYmd(week)}` })) alerted++;
  }
  return { checked: entries.length, alerted };
}

/** Projects burning hours faster than their schedule: alert the project manager (and the PMO). */
export async function runProjectVarianceAlerts(tenantId: string, now = new Date()): Promise<{ projects: number; alerted: number }> {
  const s = await getOpsSettings(tenantId);
  const rows = (await budgetVsActual(tenantId)).filter((p) => ["ACTIVE", "PLANNING", "ON_HOLD"].includes(p.status) && p.budget);
  const pmo = await usersWithPermission(tenantId, "psa.project.manage");
  let alerted = 0;
  for (const p of rows) {
    const v = opsProjectVariance({ budgetHours: p.budget, actualHours: p.actual, start: null, end: null }, now);
    const full = await prisma.project.findUnique({ where: { id: p.id }, select: { startDate: true, endDate: true, projectManager: { select: { userId: true } } } });
    const vv = opsProjectVariance({ budgetHours: p.budget, actualHours: p.actual, start: full?.startDate ?? null, end: full?.endDate ?? null }, now, s.projectVarianceAlertPct);
    if (!vv.alert && !(v.burnPct !== null && v.burnPct > 100)) continue;
    const band = vv.burnPct !== null && vv.burnPct > 100 ? "OVER" : `V${Math.floor((vv.variancePct ?? 0) / 10) * 10}`;
    if (await opsAlertOnce(tenantId, "PROJECT_VARIANCE", `${p.id}:${band}`, { userIds: [full?.projectManager?.userId ?? "", ...pmo], title: `${p.name}: ${vv.burnPct}% of ${p.budget} budgeted hours used${vv.elapsedPct !== null ? ` with ${vv.elapsedPct}% of the schedule gone` : ""}`, link: `/projects/${p.id}` })) alerted++;
  }
  return { projects: rows.length, alerted };
}
