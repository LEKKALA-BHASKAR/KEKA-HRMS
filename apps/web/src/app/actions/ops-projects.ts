"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveTimeCode, saveWorkPackage, saveTimeTemplate, deleteTimeTemplate, lockTimesheets, reopenTimesheet, requestTimeCorrection, certifyProjectTime,
  requestTaskSignoff, logIdleTime, allocateProjectOvertime, saveExportProfile, type OpsTemplateRow,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, actorOf, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Project time controls: activity codes and work packages, entry templates,
 * period locks and reopen, correction requests, certification, task
 * sign-off, idle time, overtime allocation and export profiles.
 */

const P = PERMISSIONS;
const PATHS = ["/projects/time-controls", "/projects", "/inbox"];
async function audit(v: Viewer, entityType: string, entityId: string | null | undefined, summary: string, action: "CREATE" | "UPDATE" | "DELETE" | "LOCK" | "UNLOCK" = "UPDATE") {
  await writeAudit(v, { module: "PROJECTS", action, entityType, entityId: entityId ?? null, summary });
}

export async function saveTimeCodeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROJECT_MANAGE)) return DENIED;
  const billable = str(fd, "billable");
  const r = await saveTimeCode({ tenantId: v.tenantId, id: optStr(fd, "id"), code: str(fd, "code"), label: str(fd, "label"), billable: billable === "yes" ? true : billable === "no" ? false : null, requiresTask: bool(fd, "requiresTask"), requiresComment: bool(fd, "requiresComment"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, "OpsTimeCode", optStr(fd, "id"), `Saved activity code ${str(fd, "code").toUpperCase()}`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, PATHS);
}

export async function saveWorkPackageAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROJECT_MANAGE)) return DENIED;
  const budget = money(fd, "budgetHours");
  if (Number.isNaN(budget)) return no("Budget hours must be a number.");
  const r = await saveWorkPackage({ tenantId: v.tenantId, id: optStr(fd, "id"), projectId: str(fd, "projectId"), code: str(fd, "code"), name: str(fd, "name"), budgetHours: budget, status: str(fd, "status") || "OPEN" });
  if (r.ok) await audit(v, "OpsWorkPackage", optStr(fd, "id"), `Saved work package ${str(fd, "code")}`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, PATHS);
}

/** Save the employee's current week (or a typed grid) as a template. */
export async function saveTimeTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  const shared = bool(fd, "shared");
  if (shared && !can(v, P.PROJECT_MANAGE)) return DENIED;
  let rows: OpsTemplateRow[] = [];
  const week = day(fd, "week");
  if (week) {
    const sheet = await prisma.timesheet.findFirst({ where: { tenantId: v.tenantId, employeeId: v.employee.id, periodStart: week }, include: { entries: true } });
    const byKey = new Map<string, OpsTemplateRow>();
    for (const e of sheet?.entries ?? []) {
      const k = `${e.projectId}:${e.taskId ?? ""}:${e.timeCode ?? ""}:${e.workPackageId ?? ""}`;
      const r = byKey.get(k) ?? { projectId: e.projectId, taskId: e.taskId ?? "", workPackageId: e.workPackageId ?? "", timeCode: e.timeCode ?? "", hours: [0, 0, 0, 0, 0, 0, 0], note: e.description ?? "" };
      r.hours[Math.round((e.date.getTime() - week.getTime()) / 86_400_000)] += Number(e.hours);
      byKey.set(k, r);
    }
    rows = [...byKey.values()];
  } else {
    const projectId = str(fd, "projectId");
    const hours = Array.from({ length: 7 }, (_, i) => Number(str(fd, `h${i}`) || 0) || 0);
    if (projectId) rows = [{ projectId, taskId: str(fd, "taskId"), workPackageId: str(fd, "workPackageId"), timeCode: str(fd, "timeCode"), hours, note: str(fd, "note") }];
  }
  if (!rows.length) return no("Nothing to save: log time in the week first, or pick a project.");
  const r = await saveTimeTemplate({ tenantId: v.tenantId, userId: v.user.id, employeeId: shared ? null : v.employee.id, name: str(fd, "name"), rows, shared });
  if (r.ok) await audit(v, "OpsTimeTemplate", null, `Saved time template "${str(fd, "name")}"${shared ? " (shared)" : ""}`, "CREATE");
  return result(r, PATHS);
}

export async function deleteTimeTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  return result(await deleteTimeTemplate({ tenantId: v.tenantId, id: str(fd, "id"), employeeId: v.employee?.id ?? null, canManageShared: can(v, P.PROJECT_MANAGE) }), PATHS);
}

export async function lockTimesheetsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROJECT_MANAGE)) return DENIED;
  const from = day(fd, "from"), to = day(fd, "to");
  if (!from || !to) return no("Pick the period.");
  return result(await lockTimesheets({ actor: actorOf(v), from, to, reason: optStr(fd, "reason") }), PATHS);
}

export async function reopenTimesheetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PROJECT_MANAGE, P.TIMESHEET_APPROVE])) return DENIED;
  return result(await reopenTimesheet({ actor: actorOf(v), timesheetId: str(fd, "timesheetId"), reason: str(fd, "reason") }), PATHS);
}

export async function requestTimeCorrectionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  return result(await requestTimeCorrection({ actor: actorOf(v), employeeId: v.employee.id, timesheetId: str(fd, "timesheetId"), reason: str(fd, "reason") }), PATHS);
}

export async function certifyProjectTimeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const projectId = str(fd, "projectId");
  const pm = v.employee ? await prisma.project.count({ where: { id: projectId, tenantId: v.tenantId, projectManagerId: v.employee.id } }) : 0;
  if (!pm && !can(v, P.PROJECT_MANAGE)) return DENIED;
  const from = day(fd, "from"), to = day(fd, "to");
  if (!from || !to) return no("Pick the period.");
  return result(await certifyProjectTime({ actor: actorOf(v), projectId, from, to, statement: str(fd, "statement") }), PATHS);
}

export async function requestTaskSignoffAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  return result(await requestTaskSignoff({ actor: actorOf(v), taskId: str(fd, "taskId"), employeeId: v.employee?.id ?? null, note: optStr(fd, "note"), canManage: can(v, P.PROJECT_MANAGE) }), [...PATHS, `/projects/${str(fd, "projectId")}`]);
}

export async function logIdleTimeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  const d = day(fd, "date");
  if (!d) return no("Pick the day.");
  return result(await logIdleTime({ actor: actorOf(v), employeeId: v.employee.id, date: d, minutes: int(fd, "minutes") ?? 0, category: str(fd, "category"), note: optStr(fd, "note") }), PATHS);
}

export async function allocateOvertimeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROJECT_MANAGE)) return DENIED;
  const year = int(fd, "year"), month = int(fd, "month");
  if (!year || !month || month < 1 || month > 12) return no("Pick the month.");
  return result(await allocateProjectOvertime({ actor: actorOf(v), year, month }), PATHS);
}

export async function saveExportProfileAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROJECT_MANAGE)) return DENIED;
  const r = await saveExportProfile({ tenantId: v.tenantId, userId: v.user.id, id: optStr(fd, "id"), name: str(fd, "name"), columns: formList(fd, "columns"), clientId: optStr(fd, "clientId"), projectId: optStr(fd, "projectId"), billableOnly: bool(fd, "billableOnly"), approvedOnly: bool(fd, "approvedOnly") });
  if (r.ok) await audit(v, "OpsExportProfile", optStr(fd, "id"), `Saved export profile "${str(fd, "name")}"`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, PATHS);
}
