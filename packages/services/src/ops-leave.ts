import { prisma, type OpsApprovalRequest } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { adjustBalance, cancelLeave } from "./time";
import { getOpsSettings, opsAudit, opsAlertOnce, opsRequestApproval, type OpsActor } from "./ops-core";
import {
  opsBlackoutIssues, opsWithdrawalOpen, opsEscalationDue, opsLeaveVisible, opsLiabilityForecast, opsAbsenceCanMove, opsReturnBlockers,
  opsLifecycleConflicts, opsDay, opsYmd, opsAddDays, OPS_ABSENCE_KINDS, OPS_RETURN_CHECKLIST, type OpsBlackout,
} from "./ops-math";

/**
 * Ops depth — leave and absence: blackout and peak-period controls, the
 * withdrawal window, cancellation and balance adjustments through approval,
 * escalation of waiting requests, calendar visibility, the absence reason
 * taxonomy, long absences with return-to-work certification and checklist,
 * and the leave liability forecast.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Blackouts and peak periods
// ---------------------------------------------------------------------------

export async function saveLeaveBlackout(input: { tenantId: string; id?: string | null; name: string; kind: string; startDate: Date; endDate: Date; departmentId?: string | null; locationId?: string | null; leaveTypeIds: string[]; maxConcurrent?: number | null; maxConcurrentPct?: number | null; reason?: string | null; isActive: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the period." };
  if (!["BLACKOUT", "PEAK"].includes(input.kind)) return { ok: false, message: "Choose blackout or peak period." };
  if (input.endDate < input.startDate) return { ok: false, message: "The period ends before it starts." };
  if (input.kind === "PEAK" && !input.maxConcurrent && !input.maxConcurrentPct) return { ok: false, message: "A peak period caps how many people (or what share) may be away." };
  if (input.maxConcurrentPct !== null && input.maxConcurrentPct !== undefined && (input.maxConcurrentPct < 1 || input.maxConcurrentPct > 100)) return { ok: false, message: "The share is 1 to 100%." };
  if (input.departmentId && !(await prisma.department.findFirst({ where: { id: input.departmentId, tenantId: input.tenantId } }))) return { ok: false, message: "Department not found." };
  if (input.locationId && !(await prisma.location.findFirst({ where: { id: input.locationId, tenantId: input.tenantId } }))) return { ok: false, message: "Location not found." };
  if (input.leaveTypeIds.length && (await prisma.leaveType.count({ where: { tenantId: input.tenantId, id: { in: input.leaveTypeIds } } })) !== input.leaveTypeIds.length) return { ok: false, message: "A leave type is not yours." };
  const data = { name: input.name.trim(), kind: input.kind, startDate: opsDay(input.startDate), endDate: opsDay(input.endDate), departmentId: input.departmentId || null, locationId: input.locationId || null, leaveTypeIds: input.leaveTypeIds, maxConcurrent: input.kind === "PEAK" ? input.maxConcurrent ?? null : null, maxConcurrentPct: input.kind === "PEAK" ? input.maxConcurrentPct ?? null : null, reason: input.reason?.trim() || null, isActive: input.isActive };
  if (input.id) {
    const n = await prisma.opsLeaveBlackout.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
    return n.count ? { ok: true, message: "Saved." } : { ok: false, message: "Not found." };
  }
  await prisma.opsLeaveBlackout.create({ data: { ...data, tenantId: input.tenantId } });
  return { ok: true, message: `${input.kind === "BLACKOUT" ? "Blackout" : "Peak period"} "${data.name}" added.` };
}

/** Blackout and peak-period issues for a leave request. */
export async function opsLeaveBlackoutIssues(input: { tenantId: string; employeeId: string; leaveTypeId: string; from: Date; to: Date; excludeRequestId?: string | null }): Promise<string[]> {
  const windows = await prisma.opsLeaveBlackout.findMany({ where: { tenantId: input.tenantId, isActive: true, startDate: { lte: opsDay(input.to) }, endDate: { gte: opsDay(input.from) } } });
  if (!windows.length) return [];
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { departmentId: true, locationId: true } });
  if (!emp) return [];
  const cache = new Map<string, { away: Set<string>; group: number }>();
  const awayOn = async (w: OpsBlackout) => {
    if (cache.has(w.id)) return cache.get(w.id)!;
    const scope = { tenantId: input.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] as never[] }, ...(w.departmentId ? { departmentId: w.departmentId } : {}), ...(w.locationId ? { locationId: w.locationId } : {}) };
    const ids = (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id);
    const group = ids.length;
    const days = await prisma.leaveRequestDay.findMany({ where: { date: { gte: opsDay(w.startDate), lte: opsDay(w.endDate) }, request: { tenantId: input.tenantId, status: { in: ["APPROVED", "PENDING"] }, employeeId: { in: ids, not: input.employeeId }, ...(input.excludeRequestId ? { id: { not: input.excludeRequestId } } : {}) } }, select: { date: true, request: { select: { employeeId: true } } } });
    const away = new Set(days.map((d) => `${opsYmd(d.date)}|${d.request.employeeId}`));
    const v = { away, group };
    cache.set(w.id, v);
    return v;
  };
  const pre = new Map<string, { away: Set<string>; group: number }>();
  for (const w of windows) if (w.kind === "PEAK") pre.set(w.id, await awayOn(w));
  return opsBlackoutIssues({ from: input.from, to: input.to, leaveTypeId: input.leaveTypeId, departmentId: emp.departmentId, locationId: emp.locationId }, windows, (day, w) => {
    const v = pre.get(w.id);
    if (!v) return { away: 0, group: 0 };
    const key = opsYmd(day);
    let n = 0;
    for (const k of v.away) if (k.startsWith(`${key}|`)) n++;
    return { away: n, group: v.group };
  });
}

// ---------------------------------------------------------------------------
//  Withdrawal, cancellation and adjustments
// ---------------------------------------------------------------------------

/** What an employee may do with their own approved leave: withdraw now, ask for approval, or nothing. */
export async function leaveCancelRoute(tenantId: string, request: { status: string; fromDate: Date }, now = new Date()): Promise<"DIRECT" | "APPROVAL" | "CLOSED"> {
  if (request.status !== "APPROVED") return "DIRECT";
  const s = await getOpsSettings(tenantId);
  if (!opsWithdrawalOpen(request.fromDate, now, s.leaveWithdrawalWindowDays)) return "CLOSED";
  return s.requireLeaveCancellationApproval ? "APPROVAL" : "DIRECT";
}

export async function requestLeaveCancellation(input: { actor: OpsActor; employeeId: string; requestId: string; reason: string }): Promise<Result & { status?: string }> {
  const r = await prisma.leaveRequest.findFirst({ where: { id: input.requestId, tenantId: input.actor.tenantId, employeeId: input.employeeId }, include: { leaveType: { select: { name: true } } } });
  if (!r) return { ok: false, message: "Leave request not found." };
  if (r.status !== "APPROVED") return { ok: false, message: "Only approved leave needs a cancellation request." };
  if (!input.reason.trim()) return { ok: false, message: "Say why the leave is being cancelled." };
  return opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_LEAVE_CANCELLATION", targetId: r.id, targetLabel: `${r.leaveType.name} ${opsYmd(r.fromDate)} to ${opsYmd(r.toDate)} (${Number(r.totalDays)} day(s))`, employeeId: input.employeeId,
    reason: input.reason.trim(), requestedBy: input.actor.userId, title: `Cancel approved ${r.leaveType.name}: ${opsYmd(r.fromDate)} – ${opsYmd(r.toDate)}`, link: "/team/leave",
  });
}

export async function applyLeaveCancellationDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.targetId) return;
  const r = await prisma.leaveRequest.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!r) throw new Error("Leave request not found.");
  if (r.status !== "APPROVED") return;
  const res = await cancelLeave({ requestId: r.id, byEmployeeId: r.employeeId, reason: a.reason });
  if (!res.ok) throw new Error(res.message);
  await opsAudit(a.tenantId, actorUserId, { module: "LEAVE", action: "APPROVE", entityType: "LeaveRequest", entityId: r.id, summary: `Cancellation approved: ${a.targetLabel}` });
}

export async function requestBalanceAdjustment(input: { actor: OpsActor; employeeId: string; leaveTypeId: string; days: number; note: string }): Promise<Result & { status?: string }> {
  const [emp, type] = await Promise.all([
    prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.actor.tenantId }, select: { displayName: true, employeeNumber: true } }),
    prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, tenantId: input.actor.tenantId }, select: { name: true } }),
  ]);
  if (!emp || !type) return { ok: false, message: "Employee or leave type not found." };
  if (!input.days || Math.abs(input.days) > 365) return { ok: false, message: "Adjust by a non-zero number of days, at most 365." };
  return opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_LEAVE_ADJUSTMENT", targetLabel: `${emp.displayName} (${emp.employeeNumber}) · ${type.name} ${input.days > 0 ? "+" : ""}${input.days} day(s)`, employeeId: input.employeeId,
    payload: { leaveTypeId: input.leaveTypeId, days: input.days }, reason: input.note, requestedBy: input.actor.userId, amount: Math.abs(input.days),
    title: `Leave balance adjustment: ${type.name} ${input.days > 0 ? "+" : ""}${input.days} for ${emp.displayName}`, link: "/time/leave-controls?tab=adjustments",
  });
}

export async function applyBalanceAdjustmentDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.employeeId) return;
  const p = (a.payload ?? {}) as { leaveTypeId?: string; days?: number };
  if (!p.leaveTypeId || !p.days) throw new Error("The adjustment is incomplete.");
  if (!(await prisma.leaveType.findFirst({ where: { id: p.leaveTypeId, tenantId: a.tenantId } }))) throw new Error("Leave type not found.");
  const after = await adjustBalance({ employeeId: a.employeeId, leaveTypeId: p.leaveTypeId, days: p.days, note: `${a.reason ?? "Adjustment"} (approved)`, actorUserId: a.requestedBy });
  await opsAudit(a.tenantId, actorUserId, { module: "LEAVE", action: "APPROVE", entityType: "LeaveBalance", entityId: a.employeeId, summary: `Approved balance adjustment ${a.targetLabel}; new balance ${after}` });
}

// ---------------------------------------------------------------------------
//  Escalation
// ---------------------------------------------------------------------------

/** Pending leave waiting past the window goes to the approver's manager and the leave administrators. */
export async function runLeaveEscalations(tenantId: string, now = new Date()): Promise<{ checked: number; escalated: number }> {
  const s = await getOpsSettings(tenantId);
  if (!s.leaveEscalationHours) return { checked: 0, escalated: 0 };
  const reqs = await prisma.leaveRequest.findMany({ where: { tenantId, status: "PENDING" }, include: { leaveType: { select: { name: true } } } });
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(reqs.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, reportingManager: { select: { displayName: true, reportingManager: { select: { userId: true } } } } } });
  const empBy = new Map(emps.map((e) => [e.id, e]));
  const pending = reqs.filter((r) => empBy.has(r.employeeId)).map((r) => ({ ...r, employee: empBy.get(r.employeeId)! }));
  const admins = await usersWithPermission(tenantId, "time.leave.manage");
  let escalated = 0;
  for (const r of pending) {
    const since = r.levelSince ?? r.createdAt;
    if (!opsEscalationDue(since, now, s.leaveEscalationHours)) continue;
    const to = [r.employee.reportingManager?.reportingManager?.userId ?? "", ...admins];
    if (await opsAlertOnce(tenantId, "LEAVE_ESCALATION", `${r.id}:${r.approvalLevel}`, { userIds: to, title: `Escalated: ${r.employee.displayName}'s ${r.leaveType.name} (${opsYmd(r.fromDate)}) has waited over ${s.leaveEscalationHours} h${r.employee.reportingManager ? ` for ${r.employee.reportingManager.displayName}` : ""}`, link: "/time/approvals", email: true })) escalated++;
  }
  return { checked: pending.length, escalated };
}

// ---------------------------------------------------------------------------
//  Calendar visibility
// ---------------------------------------------------------------------------

/** Leave on the calendar for a month, as the viewer may see it under the tenant's rules. */
export async function leaveCalendarFor(tenantId: string, viewerEmployeeId: string, year: number, month: number, opts: { seeAll?: boolean } = {}) {
  const s = await getOpsSettings(tenantId);
  const me = await prisma.employee.findFirst({ where: { id: viewerEmployeeId, tenantId }, select: { id: true, reportingManagerId: true, departmentId: true, _count: { select: { directReports: true } } } });
  if (!me) return { rule: s.leaveCalendarVisibility, hideType: s.leaveCalendarHideType, entries: [] };
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const raw = await prisma.leaveRequest.findMany({ where: { tenantId, status: { in: ["APPROVED", "PENDING"] }, fromDate: { lte: to }, toDate: { gte: from } }, include: { leaveType: { select: { name: true, color: true } } }, orderBy: { fromDate: "asc" } });
  const people = await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(raw.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, reportingManagerId: true, departmentId: true } });
  const pBy = new Map(people.map((p) => [p.id, p]));
  const reqs = raw.filter((r) => pBy.has(r.employeeId)).map((r) => ({ ...r, employee: pBy.get(r.employeeId)! }));
  const viewer = { employeeId: me.id, managerId: me.reportingManagerId, departmentId: me.departmentId, isManager: me._count.directReports > 0 };
  const entries = reqs.filter((r) => !!opts.seeAll || opsLeaveVisible(s.leaveCalendarVisibility, viewer, { employeeId: r.employee.id, managerId: r.employee.reportingManagerId, departmentId: r.employee.departmentId })).map((r) => {
    const own = r.employee.id === me.id || r.employee.reportingManagerId === me.id || !!opts.seeAll;
    return { id: r.id, employee: r.employee.displayName ?? "", from: r.fromDate, to: r.toDate, days: Number(r.totalDays), status: r.status, type: s.leaveCalendarHideType && !own ? "On leave" : r.leaveType.name, color: s.leaveCalendarHideType && !own ? null : r.leaveType.color };
  });
  return { rule: s.leaveCalendarVisibility, hideType: s.leaveCalendarHideType, entries };
}

// ---------------------------------------------------------------------------
//  Long absences and return to work
// ---------------------------------------------------------------------------

async function lifecycleState(tenantId: string, employeeId: string) {
  const [e, absence, assignment, jc, fte, exit] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { status: true } }),
    prisma.opsAbsenceCase.count({ where: { tenantId, employeeId, status: "ON_LEAVE" } }),
    prisma.opsAssignment.findFirst({ where: { tenantId, employeeId, status: "ACTIVE" }, select: { kind: true } }),
    prisma.jobChange.count({ where: { tenantId, employeeId, status: "PENDING_APPROVAL" } }),
    prisma.opsFteConversion.count({ where: { tenantId, employeeId, status: "PENDING" } }),
    prisma.exitRecord.count({ where: { employeeId, employee: { tenantId }, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED", "RETAINED"] } } }),
  ]);
  if (!e) return null;
  return { status: e.status, onLongAbsence: absence > 0, activeAssignment: assignment?.kind ?? null, pendingJobChange: jc > 0, pendingFte: fte > 0, openExit: exit > 0 };
}
export { lifecycleState as opsLifecycleState };

export async function requestAbsence(input: { actor: OpsActor; employeeId: string; kind: string; reasonCode?: string | null; startDate: Date; expectedReturn: Date; rtwRequired: boolean; note?: string | null }): Promise<Result & { id?: string }> {
  const t = input.actor.tenantId;
  if (!(input.kind in OPS_ABSENCE_KINDS)) return { ok: false, message: "Choose the kind of absence." };
  if (input.expectedReturn <= input.startDate) return { ok: false, message: "The return date must be after the start." };
  const days = (input.expectedReturn.getTime() - input.startDate.getTime()) / 86_400_000;
  if (days < 14) return { ok: false, message: "A long absence runs 14 days or more; apply for leave instead." };
  if (input.reasonCode && !(await prisma.opsReasonCode.findFirst({ where: { tenantId: t, kind: "ABSENCE", code: input.reasonCode, isActive: true } }))) return { ok: false, message: "Choose a reason from the absence taxonomy." };
  const state = await lifecycleState(t, input.employeeId);
  if (!state) return { ok: false, message: "Employee not found." };
  const blocks = opsLifecycleConflicts(state, "ABSENCE");
  if (state.onLongAbsence) blocks.push("The employee is already on a leave of absence.");
  if (await prisma.opsAbsenceCase.count({ where: { tenantId: t, employeeId: input.employeeId, status: { in: ["REQUESTED", "APPROVED"] } } })) blocks.push("A leave of absence is already requested or approved.");
  if (blocks.length) return { ok: false, message: blocks.join(" ") };
  const c = await prisma.opsAbsenceCase.create({ data: { tenantId: t, employeeId: input.employeeId, kind: input.kind, reasonCode: input.reasonCode || null, startDate: opsDay(input.startDate), expectedReturn: opsDay(input.expectedReturn), rtwRequired: input.rtwRequired, note: input.note ?? null, createdBy: input.actor.userId, checklist: OPS_RETURN_CHECKLIST.map((item) => ({ item, done: false })) } });
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { displayName: true } });
  const res = await opsRequestApproval({
    tenantId: t, entityType: "OPS_ABSENCE", targetId: c.id, targetLabel: `${emp.displayName}: ${OPS_ABSENCE_KINDS[input.kind]} ${opsYmd(c.startDate)} to ${opsYmd(c.expectedReturn)}`, employeeId: input.employeeId,
    reason: input.note ?? null, requestedBy: input.actor.userId, title: `${OPS_ABSENCE_KINDS[input.kind]} for ${emp.displayName}: ${opsYmd(c.startDate)} – ${opsYmd(c.expectedReturn)}`, link: `/time/leave-controls?tab=absences&case=${c.id}`,
  });
  if (!res.ok) { await prisma.opsAbsenceCase.delete({ where: { id: c.id } }); return res; }
  await prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { approvalId: res.id } });
  return { ...res, id: c.id };
}

export async function applyAbsenceDecision(a: OpsApprovalRequest, outcome: string): Promise<void> {
  if (!a.targetId) return;
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!c || c.status !== "REQUESTED") return;
  const to = outcome === "APPROVED" ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "CANCELLED";
  await prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { status: to } });
  if (to === "APPROVED" && c.startDate.getTime() <= opsDay(new Date()).getTime()) await startAbsence(a.tenantId, c.id, null);
}

/** Begin an approved absence: the employee goes inactive until they return. */
export async function startAbsence(tenantId: string, caseId: string, actorUserId: string | null): Promise<Result> {
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: caseId, tenantId } });
  if (!c) return { ok: false, message: "Absence not found." };
  if (!opsAbsenceCanMove(c.status, "ON_LEAVE")) return { ok: false, message: `An absence that is ${c.status.toLowerCase()} cannot start.` };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: c.employeeId }, select: { status: true, displayName: true, userId: true } });
  await prisma.$transaction([
    prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { status: "ON_LEAVE", previousStatus: emp.status } }),
    prisma.employee.update({ where: { id: c.employeeId }, data: { status: "INACTIVE" } }),
    prisma.opsStatusChange.create({ data: { tenantId, employeeId: c.employeeId, fromStatus: emp.status, toStatus: "INACTIVE", reasonCode: c.reasonCode ?? c.kind, reasonLabel: OPS_ABSENCE_KINDS[c.kind] ?? c.kind, effectiveOn: c.startDate, note: "Leave of absence began", createdBy: actorUserId ?? "system" } }),
  ]);
  await opsAudit(tenantId, actorUserId, { module: "LIFECYCLE", action: "UPDATE", entityType: "OpsAbsenceCase", entityId: c.id, summary: `${emp.displayName} began ${OPS_ABSENCE_KINDS[c.kind]?.toLowerCase()} (status ${emp.status} → INACTIVE)` });
  return { ok: true, message: "The absence has begun; the employee is inactive until they return." };
}

export async function certifyReturnToWork(input: { actor: OpsActor; caseId: string; fitForWork: boolean; restrictions?: string | null; note?: string | null; fileId?: string | null }): Promise<Result> {
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: input.caseId, tenantId: input.actor.tenantId } });
  if (!c) return { ok: false, message: "Absence not found." };
  if (c.status !== "ON_LEAVE") return { ok: false, message: "Certify the return of someone currently on leave." };
  if (!input.fitForWork && !input.restrictions?.trim() && !input.note?.trim()) return { ok: false, message: "Note why the employee is not fit to return." };
  if (input.fileId && !(await prisma.storedFile.findFirst({ where: { id: input.fileId, tenantId: input.actor.tenantId } }))) return { ok: false, message: "Certificate file not found." };
  await prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { fitForWork: input.fitForWork, restrictions: input.restrictions?.trim() || null, rtwNote: input.note?.trim() || null, rtwFileId: input.fileId ?? c.rtwFileId, rtwCertifiedBy: input.actor.userId, rtwCertifiedAt: new Date() } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "OpsAbsenceCase", entityId: c.id, summary: `Return to work certified: ${input.fitForWork ? "fit" : "not fit"}${input.restrictions ? ` (restrictions: ${input.restrictions})` : ""}` });
  return { ok: true, message: input.fitForWork ? "Certified fit to return." : "Recorded: not yet fit to return." };
}

export async function tickReturnChecklist(input: { actor: OpsActor; caseId: string; done: string[] }): Promise<Result> {
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: input.caseId, tenantId: input.actor.tenantId } });
  if (!c) return { ok: false, message: "Absence not found." };
  const list = (Array.isArray(c.checklist) ? c.checklist : []) as Array<{ item: string; done: boolean; by?: string; at?: string }>;
  const now = new Date().toISOString();
  const next = list.map((i, idx) => (input.done.includes(String(idx)) ? { ...i, done: true, by: i.done ? i.by : input.actor.userId, at: i.done ? i.at : now } : i));
  await prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { checklist: next } });
  return { ok: true, message: `${next.filter((i) => i.done).length} of ${next.length} done.` };
}

export async function completeReturn(input: { actor: OpsActor; caseId: string; returnedOn: Date }): Promise<Result> {
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: input.caseId, tenantId: input.actor.tenantId } });
  if (!c) return { ok: false, message: "Absence not found." };
  if (!opsAbsenceCanMove(c.status, "RETURNED")) return { ok: false, message: "Only someone on leave can return." };
  const blockers = opsReturnBlockers({ rtwRequired: c.rtwRequired, rtwCertifiedAt: c.rtwCertifiedAt, fitForWork: c.fitForWork, checklist: (Array.isArray(c.checklist) ? c.checklist : []) as Array<{ item: string; done: boolean }> });
  if (blockers.length) return { ok: false, message: blockers.join(" ") };
  if (input.returnedOn < c.startDate) return { ok: false, message: "The return is before the absence began." };
  const back = c.previousStatus && c.previousStatus !== "INACTIVE" ? c.previousStatus : "CONFIRMED";
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: c.employeeId }, select: { displayName: true, userId: true, reportingManager: { select: { userId: true } } } });
  await prisma.$transaction([
    prisma.opsAbsenceCase.update({ where: { id: c.id }, data: { status: "RETURNED", actualReturn: opsDay(input.returnedOn) } }),
    prisma.employee.update({ where: { id: c.employeeId }, data: { status: back as never } }),
    prisma.opsStatusChange.create({ data: { tenantId: input.actor.tenantId, employeeId: c.employeeId, fromStatus: "INACTIVE", toStatus: back, reasonCode: "RETURN_FROM_LEAVE", reasonLabel: "Returned from leave of absence", effectiveOn: opsDay(input.returnedOn), createdBy: input.actor.userId } }),
  ]);
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "OpsAbsenceCase", entityId: c.id, summary: `${emp.displayName} returned on ${opsYmd(input.returnedOn)}; status ${back}` });
  await notify({ tenantId: input.actor.tenantId, userIds: [emp.userId, emp.reportingManager?.userId], kind: "LIFECYCLE", title: `Welcome back: ${emp.displayName}'s return on ${opsYmd(input.returnedOn)} is recorded`, link: "/me/leave" });
  return { ok: true, message: `Returned; status set back to ${back.toLowerCase().replace(/_/g, " ")}.` };
}

export async function cancelAbsence(input: { actor: OpsActor; caseId: string }): Promise<Result> {
  const c = await prisma.opsAbsenceCase.findFirst({ where: { id: input.caseId, tenantId: input.actor.tenantId } });
  if (!c) return { ok: false, message: "Absence not found." };
  if (!opsAbsenceCanMove(c.status, "CANCELLED")) return { ok: false, message: "This absence can no longer be cancelled." };
  if (c.status === "REQUESTED") {
    const wf = c.approvalId ? await prisma.opsApprovalRequest.findUnique({ where: { id: c.approvalId }, select: { workflowRequestId: true, requestedBy: true } }) : null;
    if (wf?.workflowRequestId && wf.requestedBy === input.actor.userId) {
      const { withdrawWorkflow } = await import("./workflow-engine");
      await withdrawWorkflow({ tenantId: input.actor.tenantId, requestId: wf.workflowRequestId, userId: input.actor.userId });
    }
  }
  await prisma.opsAbsenceCase.updateMany({ where: { id: c.id, status: { in: ["REQUESTED", "APPROVED"] } }, data: { status: "CANCELLED" } });
  return { ok: true, message: "Cancelled." };
}

/** Nightly: start approved absences that have begun; remind HR of overdue returns. */
export async function runAbsenceTransitions(tenantId: string, now = new Date()): Promise<{ started: number; overdue: number }> {
  const today = opsDay(now);
  const due = await prisma.opsAbsenceCase.findMany({ where: { tenantId, status: "APPROVED", startDate: { lte: today } }, select: { id: true } });
  let started = 0;
  for (const d of due) if ((await startAbsence(tenantId, d.id, null)).ok) started++;
  const late = await prisma.opsAbsenceCase.findMany({ where: { tenantId, status: "ON_LEAVE", expectedReturn: { lt: today } }, });
  const hr = await usersWithPermission(tenantId, "time.leave.manage");
  let overdue = 0;
  for (const c of late) {
    const e = await prisma.employee.findUnique({ where: { id: c.employeeId }, select: { displayName: true } });
    if (await opsAlertOnce(tenantId, "ABSENCE_RETURN_OVERDUE", c.id, { userIds: hr, title: `${e?.displayName}: expected back on ${opsYmd(c.expectedReturn)} — record the return or extend the absence`, link: `/time/leave-controls?tab=absences&case=${c.id}` })) overdue++;
  }
  return { started, overdue };
}

// ---------------------------------------------------------------------------
//  Liability forecast
// ---------------------------------------------------------------------------

/** Encashable leave valued at today's pay, and the next months as accrual adds to it. */
export async function leaveLiabilityForecast(tenantId: string, months = 12, now = new Date()) {
  const types = await prisma.leaveType.findMany({ where: { tenantId, isActive: true, isPaid: true, isUnlimited: false }, select: { id: true, name: true, annualQuota: true, accrualFrequency: true, maxAccumulation: true, carryForwardMax: true, encashmentEnabled: true } });
  const typeMap = new Map(types.map((t) => [t.id, t]));
  const emps = await prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] as never[] } }, select: { id: true, displayName: true, department: { select: { name: true } } } });
  const empIds = emps.map((e) => e.id);
  const balances = await prisma.leaveBalance.findMany({ where: { employeeId: { in: empIds }, leaveTypeId: { in: [...typeMap.keys()] } }, orderBy: { yearStart: "desc" } });
  const latest = new Map<string, (typeof balances)[number]>();
  for (const b of balances) { const k = `${b.employeeId}|${b.leaveTypeId}`; if (!latest.has(k)) latest.set(k, b); }
  const revs = await prisma.salaryRevision.findMany({ where: { employeeId: { in: empIds }, effectiveFrom: { lte: now }, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, select: { employeeId: true, annualCtc: true } });
  const ctc = new Map<string, number>();
  for (const r of revs) if (!ctc.has(r.employeeId)) ctc.set(r.employeeId, Number(r.annualCtc));
  const rows = [...latest.values()].map((b) => {
    const t = typeMap.get(b.leaveTypeId)!;
    const perDay = r2((ctc.get(b.employeeId) ?? 0) / 12 / 30);
    const monthly = t.accrualFrequency === "MONTHLY" ? Number(t.annualQuota) / 12 : t.accrualFrequency === "QUARTERLY" ? Number(t.annualQuota) / 12 : 0;
    return { employeeId: b.employeeId, leaveTypeId: b.leaveTypeId, balance: Number(b.available), monthlyAccrual: monthly, perDay, cap: t.maxAccumulation === null ? null : Number(t.maxAccumulation), encashable: t.encashmentEnabled };
  });
  const total = opsLiabilityForecast(rows, months);
  const byType = types.map((t) => {
    const rs = rows.filter((r) => r.leaveTypeId === t.id);
    const f = opsLiabilityForecast(rs, months);
    return { leaveTypeId: t.id, leaveType: t.name, encashable: t.encashmentEnabled, employees: rs.length, days: r2(rs.reduce((s, r) => s + Math.max(0, r.balance), 0)), today: f.today, inTwelve: f.forecast[f.forecast.length - 1] ?? f.today };
  });
  const deptOf = new Map(emps.map((e) => [e.id, e.department?.name ?? "No department"]));
  const byDept = new Map<string, number>();
  for (const r of rows) if (r.encashable) byDept.set(deptOf.get(r.employeeId)!, r2((byDept.get(deptOf.get(r.employeeId)!) ?? 0) + Math.max(0, r.balance) * r.perDay));
  const label = (i: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  return { today: total.today, forecast: total.forecast.map((v, i) => ({ month: label(i), value: v })), byType, byDepartment: [...byDept.entries()].map(([department, value]) => ({ department, value })).sort((a, b) => b.value - a.value) };
}

export { opsAddDays as opsLeaveAddDays };
