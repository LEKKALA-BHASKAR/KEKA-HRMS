"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import {
  saveOpsSettings, proposeConfigChange, isOpsConfigKind, OPS_CONFIG_KINDS, lockOpsPeriod, reopenOpsPeriod, runAttendanceAnomalies, resolveAnomaly,
  saveEarlyDepartureRule, applyEarlyDeparturePenalties, runDeviceHealth, certifyDay, certifyMonth, saveReasonCode, saveBreakRule, startBreak, endBreak,
  saveBreakEntry, requestBreakException, saveLeaveBlackout, requestAbsence, certifyReturnToWork, tickReturnChecklist, completeReturn, cancelAbsence,
  requestBalanceAdjustment, type OpsSettingsInput,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, actorOf, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Time Attend controls: the ops settings, configuration changes under
 * approval, attendance locks and certification, anomalies, early departure,
 * devices, reason catalogues, breaks, leave blackouts and peak periods,
 * long absences with return to work, and balance adjustments.
 */

const P = PERMISSIONS;
const PATHS = ["/time/controls", "/time/insights", "/time/leave-controls", "/me/attendance", "/me/leave", "/inbox"];
type Area = "ATTENDANCE" | "LEAVE" | "PAYROLL" | "PROJECTS" | "LIFECYCLE" | "EMPLOYEE";
async function audit(v: Viewer, module: Area, entityType: string, entityId: string | null | undefined, summary: string, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "LOCK" | "UNLOCK" = "UPDATE") {
  await writeAudit(v, { module, action, entityType, entityId: entityId ?? null, summary });
}

// ---------------------------------------------------------------------------
//  Settings and configuration changes
// ---------------------------------------------------------------------------

const SECTION_PERM: Record<string, string> = {
  attendance: P.ATTENDANCE_MANAGE, time: P.PROJECT_MANAGE, leave: P.LEAVE_MANAGE, payroll: P.PAYROLL_SETTINGS, lifecycle: P.HR_ACTIVITY_MANAGE, governance: P.WORKFLOW_MANAGE,
};
const n = (fd: FormData, k: string) => { const v = int(fd, k); return v === null ? undefined : v; };
const optN = (fd: FormData, k: string) => (str(fd, k) === "" ? null : int(fd, k));

export async function saveOpsSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const section = str(fd, "section");
  if (!SECTION_PERM[section] || !can(v, SECTION_PERM[section] as Permission)) return DENIED;
  let input: OpsSettingsInput;
  switch (section) {
    case "attendance": input = { attendanceCutoffDay: n(fd, "attendanceCutoffDay"), cutoffAlertDaysBefore: n(fd, "cutoffAlertDaysBefore"), deviceStaleMinutes: n(fd, "deviceStaleMinutes"), deviceOfflineMinutes: n(fd, "deviceOfflineMinutes"), sourceMismatchMinutes: n(fd, "sourceMismatchMinutes"), anomalyNotify: bool(fd, "anomalyNotify") }; break;
    case "time": input = { requireEntryComment: bool(fd, "requireEntryComment"), entryCommentMinLength: n(fd, "entryCommentMinLength"), requireTimeCode: bool(fd, "requireTimeCode"), requireAttestation: bool(fd, "requireAttestation"), timesheetCutoffDays: optN(fd, "timesheetCutoffDays"), taskBudgetMode: str(fd, "taskBudgetMode") || "OFF", taskBudgetTolerancePct: n(fd, "taskBudgetTolerancePct"), projectVarianceAlertPct: n(fd, "projectVarianceAlertPct"), standardDailyHours: money(fd, "standardDailyHours") ?? undefined }; break;
    case "leave": input = { leaveWithdrawalWindowDays: optN(fd, "leaveWithdrawalWindowDays"), requireLeaveCancellationApproval: bool(fd, "requireLeaveCancellationApproval"), leaveEscalationHours: optN(fd, "leaveEscalationHours"), leaveCalendarVisibility: str(fd, "leaveCalendarVisibility") || "TEAM", leaveCalendarHideType: bool(fd, "leaveCalendarHideType"), requireBalanceAdjustmentApproval: bool(fd, "requireBalanceAdjustmentApproval") }; break;
    case "payroll": input = { netPayRoundTo: n(fd, "netPayRoundTo"), netPayRoundingMode: str(fd, "netPayRoundingMode") || "NEAREST", negativeNetPayAction: str(fd, "negativeNetPayAction") || "WARN", requirePayslipApproval: bool(fd, "requirePayslipApproval"), requireFilingApproval: bool(fd, "requireFilingApproval"), requireCloseChecklist: bool(fd, "requireCloseChecklist") }; break;
    case "lifecycle": input = { eventTypesNeedingApproval: formList(fd, "eventTypesNeedingApproval"), contractAlertDays: str(fd, "contractAlertDays").split(/[\s,]+/).filter(Boolean).map(Number) }; break;
    default: input = { approvalKinds: formList(fd, "approvalKinds") };
  }
  for (const [k, val] of Object.entries(input)) if (typeof val === "number" && Number.isNaN(val)) return no(`${k} must be a number.`);
  if (input.timesheetCutoffDays !== undefined && input.timesheetCutoffDays !== null && (input.timesheetCutoffDays < 0 || input.timesheetCutoffDays > 60)) return no("The timesheet cut-off is 0 to 60 days.");
  if (input.leaveWithdrawalWindowDays !== undefined && input.leaveWithdrawalWindowDays !== null && (input.leaveWithdrawalWindowDays < 0 || input.leaveWithdrawalWindowDays > 90)) return no("The withdrawal window is 0 to 90 days.");
  if (input.leaveEscalationHours !== undefined && input.leaveEscalationHours !== null && (input.leaveEscalationHours < 1 || input.leaveEscalationHours > 720)) return no("Escalate after 1 to 720 hours.");
  const before = await prisma.opsSetting.findUnique({ where: { tenantId: v.tenantId } });
  const r = await saveOpsSettings(v.tenantId, input);
  if (r.ok) await writeAudit(v, { module: section === "payroll" ? "PAYROLL" : section === "leave" ? "LEAVE" : section === "time" ? "PROJECTS" : section === "lifecycle" ? "LIFECYCLE" : "ATTENDANCE", action: "UPDATE", entityType: "OpsSetting", entityId: v.tenantId, summary: `Updated ${section} controls`, oldValue: before ? Object.fromEntries(Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k]])) : null, newValue: input });
  return result(r, [...PATHS, "/payroll/controls", "/projects/time-controls", "/lifecycle"]);
}

export async function proposeConfigChangeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const kind = str(fd, "kind");
  if (!isOpsConfigKind(kind)) return no("Choose what to change.");
  if (!can(v, OPS_CONFIG_KINDS[kind].permission as Permission)) return DENIED;
  const values: Record<string, string> = {};
  for (const f of OPS_CONFIG_KINDS[kind].fields) {
    if (f.type === "bool") { if (fd.has(`has_${f.key}`)) values[f.key] = bool(fd, `f_${f.key}`) ? "true" : "false"; continue; }
    const raw = str(fd, `f_${f.key}`);
    if (raw !== "") values[f.key] = raw;
  }
  const r = await proposeConfigChange({ tenantId: v.tenantId, kind, targetId: str(fd, "targetId"), values, effectiveFrom: day(fd, "effectiveFrom"), reason: optStr(fd, "reason"), userId: v.user.id });
  return result(r, [...PATHS, "/leave", "/attendance", "/payroll/structures", "/payroll/pay-groups", "/projects/settings/timesheets"]);
}

// ---------------------------------------------------------------------------
//  Locks, anomalies, early departure, devices, certification
// ---------------------------------------------------------------------------

export async function lockPeriodAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const domain = str(fd, "domain") === "TIMESHEET" ? "TIMESHEET" : "ATTENDANCE";
  if (!can(v, domain === "ATTENDANCE" ? P.ATTENDANCE_MANAGE : P.PROJECT_MANAGE)) return DENIED;
  const from = day(fd, "periodStart"), to = day(fd, "periodEnd");
  if (!from || !to) return no("Pick the period.");
  const r = await lockOpsPeriod({ actor: actorOf(v), domain, periodStart: from, periodEnd: to, reason: optStr(fd, "reason") });
  return result(r, [...PATHS, "/projects/time-controls"]);
}

export async function reopenPeriodAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const lock = await prisma.opsPeriodLock.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!lock) return no("Lock not found.");
  if (!can(v, lock.domain === "ATTENDANCE" ? P.ATTENDANCE_MANAGE : P.PROJECT_MANAGE)) return DENIED;
  const r = await reopenOpsPeriod({ actor: actorOf(v), id: lock.id, reason: str(fd, "reason") });
  return result(r, [...PATHS, "/projects/time-controls"]);
}

export async function runAnomaliesAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const from = day(fd, "from"), to = day(fd, "to");
  if (!from || !to || to < from) return no("Pick the dates.");
  if ((to.getTime() - from.getTime()) / 86_400_000 > 62) return no("Classify at most two months at a time.");
  const r = await runAttendanceAnomalies(v.tenantId, from, to, { notify: bool(fd, "notify") });
  await audit(v, "ATTENDANCE", "OpsAttendanceAnomaly", null, `Classified attendance ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}: ${r.found} exception(s)`, "CREATE");
  return result({ ok: true, message: `${r.found} exception(s) over ${r.days} day(s); ${r.created} new, ${r.notified} notified.` }, PATHS);
}

export async function resolveAnomalyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE])) return DENIED;
  const a = await prisma.opsAttendanceAnomaly.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!a) return no("Not found.");
  if (!can(v, P.ATTENDANCE_MANAGE) && !(await managesEmployee(v, a.employeeId))) return DENIED;
  return result(await resolveAnomaly({ actor: actorOf(v), id: a.id, action: str(fd, "action") === "WAIVED" ? "WAIVED" : "RESOLVED", note: str(fd, "note") }), PATHS);
}

async function managesEmployee(v: Viewer, employeeId: string): Promise<boolean> {
  if (!v.employee) return false;
  return !!(await prisma.employee.findFirst({ where: { id: employeeId, tenantId: v.tenantId, reportingManagerId: v.employee.id }, select: { id: true } }));
}

export async function saveEarlyDepartureRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const r = await saveEarlyDepartureRule({ tenantId: v.tenantId, policyKey: str(fd, "policyKey") || "DEFAULT", graceMinutes: int(fd, "graceMinutes") ?? 0, exemptPerMonth: int(fd, "exemptPerMonth") ?? 0, penaltyDays: money(fd, "penaltyDays") ?? 0, isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, "ATTENDANCE", "OpsEarlyDepartureRule", str(fd, "policyKey") || "DEFAULT", "Saved early departure rule");
  return result(r, PATHS);
}

export async function applyEarlyDepartureAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const year = int(fd, "year"), month = int(fd, "month");
  if (!year || !month || month < 1 || month > 12) return no("Pick the month.");
  return result(await applyEarlyDeparturePenalties({ actor: actorOf(v), year, month }), PATHS);
}

export async function runDeviceHealthAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const r = await runDeviceHealth(v.tenantId);
  return result({ ok: true, message: `Checked ${r.checked} device(s): ${r.offline} offline.` }, PATHS);
}

export async function certifyDayAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee || !canAny(v, [P.ATTENDANCE_APPROVE, P.ATTENDANCE_MANAGE])) return DENIED;
  const d = day(fd, "date");
  if (!d) return no("Pick the day.");
  return result(await certifyDay({ actor: actorOf(v), managerEmployeeId: v.employee.id, date: d, note: optStr(fd, "note"), allowOpen: bool(fd, "allowOpen") }), [...PATHS, "/team/attendance"]);
}

export async function certifyMonthAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const year = int(fd, "year"), month = int(fd, "month");
  if (!year || !month || month < 1 || month > 12) return no("Pick the month.");
  return result(await certifyMonth({ actor: actorOf(v), year, month, departmentId: optStr(fd, "departmentId"), note: optStr(fd, "note") }), PATHS);
}

// ---------------------------------------------------------------------------
//  Reason catalogues
// ---------------------------------------------------------------------------

const REASON_PERM: Record<string, string> = { REGULARISATION: P.ATTENDANCE_MANAGE, ABSENCE: P.LEAVE_MANAGE, STATUS: P.EMPLOYEE_UPDATE, IDLE: P.PROJECT_MANAGE };

export async function saveReasonCodeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const kind = str(fd, "kind");
  if (!REASON_PERM[kind] || !can(v, REASON_PERM[kind] as Permission)) return DENIED;
  const r = await saveReasonCode({ tenantId: v.tenantId, id: optStr(fd, "id"), kind, code: str(fd, "code"), label: str(fd, "label"), description: optStr(fd, "description"), parentId: optStr(fd, "parentId"), appliesTo: optStr(fd, "appliesTo"), sortOrder: int(fd, "sortOrder") ?? 0, isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, kind === "STATUS" ? "EMPLOYEE" : kind === "ABSENCE" ? "LEAVE" : kind === "IDLE" ? "PROJECTS" : "ATTENDANCE", "OpsReasonCode", r.id, `Saved ${kind.toLowerCase()} reason ${str(fd, "code").toUpperCase()}`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, [...PATHS, "/lifecycle", "/projects/time-controls"]);
}

// ---------------------------------------------------------------------------
//  Breaks
// ---------------------------------------------------------------------------

export async function saveBreakRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const r = await saveBreakRule({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), code: str(fd, "code"), maxMinutes: int(fd, "maxMinutes") ?? 0, maxPerDay: int(fd, "maxPerDay") ?? 1, isPaid: bool(fd, "isPaid"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, "ATTENDANCE", "OpsBreakRule", optStr(fd, "id"), `Saved break type ${str(fd, "name")}`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, PATHS);
}

export async function startBreakAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  return result(await startBreak({ tenantId: v.tenantId, employeeId: v.employee.id, ruleId: str(fd, "ruleId") }), PATHS);
}

export async function endBreakAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  return result(await endBreak({ tenantId: v.tenantId, employeeId: v.employee.id, note: optStr(fd, "note") }), PATHS);
}

export async function saveBreakEntryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ATTENDANCE_MANAGE)) return DENIED;
  const d = day(fd, "date");
  const at = (k: string) => { const t = str(fd, k); return d && /^\d{2}:\d{2}$/.test(t) ? new Date(d.getTime() + (Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) - 330) * 60_000) : null; };
  const s = at("start"), e = at("end");
  if (!s || !e) return no("Enter the day and the start and end as HH:MM.");
  return result(await saveBreakEntry({ actor: actorOf(v), id: optStr(fd, "id"), employeeId: str(fd, "employeeId"), ruleId: str(fd, "ruleId"), startAt: s, endAt: e, note: optStr(fd, "note") }), PATHS);
}

export async function requestBreakExceptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("No employee record linked to this login.");
  return result(await requestBreakException({ actor: actorOf(v), employeeId: v.employee.id, breakId: str(fd, "breakId"), reason: str(fd, "reason") }), PATHS);
}

// ---------------------------------------------------------------------------
//  Leave controls
// ---------------------------------------------------------------------------

export async function saveLeaveBlackoutAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  const from = day(fd, "startDate"), to = day(fd, "endDate");
  if (!from || !to) return no("Pick the dates.");
  const pct = int(fd, "maxConcurrentPct"), max = int(fd, "maxConcurrent");
  if (Number.isNaN(pct) || Number.isNaN(max)) return no("Caps are whole numbers.");
  const r = await saveLeaveBlackout({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), kind: str(fd, "kind"), startDate: from, endDate: to, departmentId: optStr(fd, "departmentId"), locationId: optStr(fd, "locationId"), leaveTypeIds: formList(fd, "leaveTypeIds"), maxConcurrent: max, maxConcurrentPct: pct, reason: optStr(fd, "reason"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, "LEAVE", "OpsLeaveBlackout", optStr(fd, "id"), `Saved ${str(fd, "kind").toLowerCase()} period ${str(fd, "name")}`, optStr(fd, "id") ? "UPDATE" : "CREATE");
  return result(r, PATHS);
}

export async function deleteLeaveBlackoutAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  const n2 = await prisma.opsLeaveBlackout.deleteMany({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!n2.count) return no("Not found.");
  await audit(v, "LEAVE", "OpsLeaveBlackout", str(fd, "id"), "Removed a blackout/peak period", "DELETE");
  return result({ ok: true, message: "Removed." }, PATHS);
}

export async function requestBalanceAdjustmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  const days = money(fd, "days");
  if (days === null || Number.isNaN(days)) return no("Enter the days.");
  const r = await requestBalanceAdjustment({ actor: actorOf(v), employeeId: str(fd, "employeeId"), leaveTypeId: str(fd, "leaveTypeId"), days, note: str(fd, "note") || "Adjustment" });
  if (r.ok) await audit(v, "LEAVE", "LeaveBalance", str(fd, "employeeId"), `Requested a balance adjustment of ${days} day(s)`, "CREATE");
  return result(r, [...PATHS, "/leave"]);
}

/** HR raises a long absence for an employee, or an employee for themselves. */
export async function requestAbsenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const employeeId = optStr(fd, "employeeId") ?? v.employee?.id;
  if (!employeeId) return no("No employee record linked to this login.");
  if (employeeId !== v.employee?.id && !can(v, P.LEAVE_MANAGE)) return DENIED;
  const from = day(fd, "startDate"), to = day(fd, "expectedReturn");
  if (!from || !to) return no("Pick the start and the expected return.");
  const r = await requestAbsence({ actor: actorOf(v), employeeId, kind: str(fd, "kind"), reasonCode: optStr(fd, "reasonCode"), startDate: from, expectedReturn: to, rtwRequired: fd.has("rtwRequired") ? bool(fd, "rtwRequired") : true, note: optStr(fd, "note") });
  if (r.ok) await audit(v, "LEAVE", "OpsAbsenceCase", r.id, `Requested a ${str(fd, "kind").toLowerCase()} absence`, "CREATE");
  return result(r, PATHS);
}

export async function certifyReturnAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  return result(await certifyReturnToWork({ actor: actorOf(v), caseId: str(fd, "caseId"), fitForWork: str(fd, "fitForWork") !== "no", restrictions: optStr(fd, "restrictions"), note: optStr(fd, "note"), fileId: optStr(fd, "fileId") }), PATHS);
}

export async function tickReturnChecklistAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  return result(await tickReturnChecklist({ actor: actorOf(v), caseId: str(fd, "caseId"), done: formList(fd, "done") }), PATHS);
}

export async function completeReturnAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LEAVE_MANAGE)) return DENIED;
  const d = day(fd, "returnedOn");
  if (!d) return no("Pick the return date.");
  return result(await completeReturn({ actor: actorOf(v), caseId: str(fd, "caseId"), returnedOn: d }), PATHS);
}

export async function cancelAbsenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: str(fd, "caseId"), tenantId: v.tenantId } });
  if (!c) return no("Not found.");
  if (c.employeeId !== v.employee?.id && !can(v, P.LEAVE_MANAGE)) return DENIED;
  const r = await cancelAbsence({ actor: actorOf(v), caseId: c.id });
  if (r.ok) await audit(v, "LEAVE", "OpsAbsenceCase", c.id, "Cancelled a leave of absence");
  return result(r, PATHS);
}
