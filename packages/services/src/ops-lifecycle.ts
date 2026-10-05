import { prisma, type OpsApprovalRequest, type Prisma } from "@keka/db";
import { usersWithPermission } from "./lifecycle";
import { applySalaryRevision } from "./salary-revisions";
import { requestJobChange, jobChangeLabel } from "./job-changes";
import { getOpsSettings, opsAudit, opsAlertOnce, opsRequestApproval, type OpsActor } from "./ops-core";
import { opsLifecycleState } from "./ops-leave";
import {
  opsAssignmentCanMove, opsAssignmentIssues, opsConfirmationEligibility, opsFteConversion, opsContractMilestonesDue, opsLifecycleConflicts, opsDay, opsYmd,
} from "./ops-math";

/**
 * Ops depth — employee lifecycle: HR events through approval with edits and
 * export, maintaining recorded job changes and the movement reports, temporary
 * assignments and secondments, status changes with reason codes, rehire with
 * the employment timeline, FTE conversion, confirmation rules, contract
 * renewal milestones and the dependency checks between lifecycle actions.
 */

type Result = { ok: boolean; message: string };
type LifecycleAction = Parameters<typeof opsLifecycleConflicts>[1];

/** What stops a lifecycle action for an employee right now; empty when nothing does. */
export async function lifecycleDependencyIssues(tenantId: string, employeeId: string, action: LifecycleAction): Promise<string[]> {
  const state = await opsLifecycleState(tenantId, employeeId);
  if (!state) return ["Employee not found."];
  return opsLifecycleConflicts(state, action);
}

// ---------------------------------------------------------------------------
//  HR events (activities)
// ---------------------------------------------------------------------------

export const HR_EVENT_TYPES = ["PROMOTION", "TRANSFER", "WARNING", "COMPLAINT", "WORK_TRIP", "TERMINATION", "RESIGNATION", "APPRECIATION", "SALARY_REVISION"] as const;

export async function hrEventNeedsApproval(tenantId: string, type: string): Promise<boolean> {
  return (await getOpsSettings(tenantId)).eventTypesNeedingApproval.includes(type);
}

/** Send a just-recorded activity for approval; it shows as pending until decided. */
export async function requestHrEventApproval(actor: OpsActor, activityId: string): Promise<Result & { status?: string }> {
  const a = await prisma.hrActivity.findFirst({ where: { id: activityId, tenantId: actor.tenantId }, include: { employee: { select: { displayName: true } } } });
  if (!a) return { ok: false, message: "Activity not found." };
  await prisma.hrActivity.update({ where: { id: a.id }, data: { approvalStatus: "PENDING" } });
  const res = await opsRequestApproval({
    tenantId: actor.tenantId, entityType: "OPS_HR_EVENT", targetId: a.id, targetLabel: `${a.employee.displayName}: ${jobChangeLabel(a.type)} · ${a.title}`, employeeId: a.employeeId,
    reason: a.description, requestedBy: actor.userId, title: `HR event for ${a.employee.displayName}: ${jobChangeLabel(a.type)} — ${a.title}`, link: `/activities?q=${encodeURIComponent(a.title)}`, changeKind: a.type,
  });
  if (!res.ok) await prisma.hrActivity.update({ where: { id: a.id }, data: { approvalStatus: null } });
  return res;
}

export async function applyHrEventDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (!a.targetId) return;
  const status = outcome === "APPROVED" ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN";
  await prisma.hrActivity.updateMany({ where: { id: a.targetId, tenantId: a.tenantId }, data: { approvalStatus: status } });
  await opsAudit(a.tenantId, actorUserId, { module: "LIFECYCLE", action: status === "APPROVED" ? "APPROVE" : "REJECT", entityType: "HrActivity", entityId: a.targetId, summary: `HR event ${status.toLowerCase()}: ${a.targetLabel}` });
}

export async function editHrActivity(input: { actor: OpsActor; id: string; title: string; description?: string | null; occurredOn: Date; severity?: string | null; fromValue?: string | null; toValue?: string | null; destination?: string | null }): Promise<Result> {
  const a = await prisma.hrActivity.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!a) return { ok: false, message: "Activity not found." };
  if (!input.title.trim()) return { ok: false, message: "Give the event a title." };
  if (input.severity && !["MINOR", "MAJOR", "FINAL"].includes(input.severity)) return { ok: false, message: "Severity is minor, major or final." };
  if (a.approvalStatus === "REJECTED") return { ok: false, message: "A rejected event cannot be edited; record a new one." };
  const before = { title: a.title, description: a.description, occurredOn: opsYmd(a.occurredOn), severity: a.severity, fromValue: a.fromValue, toValue: a.toValue, destination: a.destination };
  const after = { title: input.title.trim(), description: input.description?.trim() || null, occurredOn: opsYmd(input.occurredOn), severity: input.severity || null, fromValue: input.fromValue ?? a.fromValue, toValue: input.toValue ?? a.toValue, destination: input.destination ?? a.destination };
  await prisma.hrActivity.update({ where: { id: a.id }, data: { ...after, occurredOn: opsDay(input.occurredOn), editedBy: input.actor.userId, editedAt: new Date() } });
  const changed = Object.keys(after).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "HrActivity", entityId: a.id, summary: `Edited HR event "${after.title}": ${changed.join(", ") || "no changes"}`, oldValue: before, newValue: after });
  return { ok: true, message: changed.length ? `Saved (${changed.join(", ")}).` : "No changes." };
}

export async function searchHrActivities(tenantId: string, f: { q?: string | null; type?: string | null; status?: string | null; from?: Date | null; to?: Date | null; employeeIds?: string[] | null; take?: number }) {
  return prisma.hrActivity.findMany({
    where: {
      tenantId,
      ...(f.type ? { type: f.type as never } : {}),
      ...(f.status === "PENDING" ? { approvalStatus: "PENDING" } : f.status === "REJECTED" ? { approvalStatus: "REJECTED" } : {}),
      ...(f.from || f.to ? { occurredOn: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(f.employeeIds ? { employeeId: { in: f.employeeIds } } : {}),
      AND: <Prisma.HrActivityWhereInput[]>[
        ...(f.status === "RECORDED" ? [{ OR: [{ approvalStatus: null }, { approvalStatus: "APPROVED" }] }] : []),
        ...(f.q ? [{ OR: [{ title: { contains: f.q, mode: "insensitive" as const } }, { description: { contains: f.q, mode: "insensitive" as const } }, { employee: { displayName: { contains: f.q, mode: "insensitive" as const } } }, { employee: { employeeNumber: { contains: f.q, mode: "insensitive" as const } } }] }] : []),
      ],
    },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } } },
    orderBy: { occurredOn: "desc" }, take: f.take ?? 300,
  });
}

// ---------------------------------------------------------------------------
//  Job changes: maintain and report
// ---------------------------------------------------------------------------

/** Change a job change that is still waiting (approval or its date). */
export async function editJobChange(input: { actor: OpsActor; id: string; effectiveFrom: Date; note?: string | null; jobTitleId?: string | null; departmentId?: string | null; locationId?: string | null; reportingManagerId?: string | null }): Promise<Result> {
  const c = await prisma.jobChange.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!c) return { ok: false, message: "Job change not found." };
  if (!["PENDING_APPROVAL", "SCHEDULED"].includes(c.status)) return { ok: false, message: "An applied change is corrected on its job record instead." };
  const t = input.actor.tenantId;
  if (input.jobTitleId && !(await prisma.jobTitle.findFirst({ where: { id: input.jobTitleId, tenantId: t } }))) return { ok: false, message: "Job title not found." };
  if (input.departmentId && !(await prisma.department.findFirst({ where: { id: input.departmentId, tenantId: t } }))) return { ok: false, message: "Department not found." };
  if (input.locationId && !(await prisma.location.findFirst({ where: { id: input.locationId, tenantId: t } }))) return { ok: false, message: "Location not found." };
  if (input.reportingManagerId && (input.reportingManagerId === c.employeeId || !(await prisma.employee.findFirst({ where: { id: input.reportingManagerId, tenantId: t } })))) return { ok: false, message: "Choose another employee as manager." };
  const before = { effectiveFrom: opsYmd(c.effectiveFrom), note: c.note, jobTitleId: c.jobTitleId, departmentId: c.departmentId, locationId: c.locationId, reportingManagerId: c.reportingManagerId };
  const data = { effectiveFrom: opsDay(input.effectiveFrom), note: input.note ?? c.note, jobTitleId: input.jobTitleId === undefined ? c.jobTitleId : input.jobTitleId || null, departmentId: input.departmentId === undefined ? c.departmentId : input.departmentId || null, locationId: input.locationId === undefined ? c.locationId : input.locationId || null, reportingManagerId: input.reportingManagerId === undefined ? c.reportingManagerId : input.reportingManagerId || null };
  await prisma.jobChange.update({ where: { id: c.id }, data });
  await opsAudit(t, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "JobChange", entityId: c.id, summary: `Edited ${jobChangeLabel(c.reason).toLowerCase()} effective ${opsYmd(data.effectiveFrom)}`, oldValue: before, newValue: { ...data, effectiveFrom: opsYmd(data.effectiveFrom) } });
  return { ok: true, message: "Saved." };
}

/** Correct the date or note of an applied job record; the record order must hold. */
export async function correctJobRecord(input: { actor: OpsActor; recordId: string; effectiveFrom: Date; note?: string | null }): Promise<Result> {
  const r = await prisma.employeeJobRecord.findFirst({ where: { id: input.recordId, employee: { tenantId: input.actor.tenantId } } });
  if (!r) return { ok: false, message: "Job record not found." };
  const siblings = await prisma.employeeJobRecord.findMany({ where: { employeeId: r.employeeId, id: { not: r.id } }, orderBy: { effectiveFrom: "asc" } });
  const prev = siblings.filter((s) => s.effectiveFrom < r.effectiveFrom).pop() ?? null;
  const next = siblings.find((s) => s.effectiveFrom > r.effectiveFrom) ?? null;
  const d = opsDay(input.effectiveFrom);
  if ((prev && d <= prev.effectiveFrom) || (next && d >= next.effectiveFrom)) return { ok: false, message: "The date must stay between the records before and after it." };
  await prisma.$transaction([
    prisma.employeeJobRecord.update({ where: { id: r.id }, data: { effectiveFrom: d, note: input.note ?? r.note } }),
    ...(prev ? [prisma.employeeJobRecord.update({ where: { id: prev.id }, data: { effectiveTo: new Date(d.getTime() - 86_400_000) } })] : []),
  ]);
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "EmployeeJobRecord", entityId: r.id, summary: `Corrected ${jobChangeLabel(r.reason).toLowerCase()} record: ${opsYmd(r.effectiveFrom)} → ${opsYmd(d)}`, oldValue: { effectiveFrom: opsYmd(r.effectiveFrom), note: r.note }, newValue: { effectiveFrom: opsYmd(d), note: input.note ?? r.note } });
  return { ok: true, message: "Corrected." };
}

export const MOVEMENT_KINDS = { PROMOTION: "Promotions", TRANSFER: "Transfers", DESIGNATION: "Designation changes" } as const;

/** Promotions, transfers or designation changes in a window, each with before and after. */
export async function movementReport(tenantId: string, kind: keyof typeof MOVEMENT_KINDS, from: Date, to: Date) {
  const recs = await prisma.employeeJobRecord.findMany({
    where: { employee: { tenantId }, effectiveFrom: { gte: opsDay(from), lte: opsDay(to) }, reason: { not: "NEW_HIRE" } },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true } }, jobTitle: { select: { name: true } } },
    orderBy: { effectiveFrom: "desc" },
  });
  const empIds = [...new Set(recs.map((r) => r.employeeId))];
  const all = await prisma.employeeJobRecord.findMany({ where: { employeeId: { in: empIds } }, include: { jobTitle: { select: { name: true } } }, orderBy: { effectiveFrom: "asc" } });
  const [depts, locs] = await Promise.all([prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }), prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } })]);
  const dn = new Map(depts.map((d) => [d.id, d.name])), ln = new Map(locs.map((l) => [l.id, l.name]));
  const rows = recs.flatMap((r) => {
    const hist = all.filter((x) => x.employeeId === r.employeeId);
    const prev = hist.filter((x) => x.effectiveFrom < r.effectiveFrom).pop() ?? null;
    const titleChanged = !!prev && prev.jobTitleId !== r.jobTitleId;
    const moved = !!prev && (prev.departmentId !== r.departmentId || prev.locationId !== r.locationId);
    const include = kind === "PROMOTION" ? ["PROMOTION", "DEMOTION"].includes(r.reason) : kind === "TRANSFER" ? ["TRANSFER", "DEPARTMENT_CHANGE", "LOCATION_CHANGE"].includes(r.reason) || moved : titleChanged;
    if (!include) return [];
    return [{
      id: r.id, employeeId: r.employeeId, employee: `${r.employee.displayName ?? ""} (${r.employee.employeeNumber})`, effectiveFrom: r.effectiveFrom, reason: jobChangeLabel(r.reason),
      fromTitle: prev?.jobTitle?.name ?? "—", toTitle: r.jobTitle?.name ?? "—",
      fromDepartment: prev?.departmentId ? dn.get(prev.departmentId) ?? "—" : "—", toDepartment: r.departmentId ? dn.get(r.departmentId) ?? "—" : "—",
      fromLocation: prev?.locationId ? ln.get(prev.locationId) ?? "—" : "—", toLocation: r.locationId ? ln.get(r.locationId) ?? "—" : "—", note: r.note ?? "",
    }];
  });
  const pending = await prisma.jobChange.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "SCHEDULED"] }, ...(kind === "PROMOTION" ? { reason: { in: ["PROMOTION", "DEMOTION"] } } : kind === "TRANSFER" ? { reason: { in: ["TRANSFER", "DEPARTMENT_CHANGE", "LOCATION_CHANGE"] } } : { jobTitleId: { not: null } }) }, orderBy: { effectiveFrom: "asc" } });
  return { rows, pending };
}

// ---------------------------------------------------------------------------
//  Temporary assignments and secondments
// ---------------------------------------------------------------------------

export async function requestAssignment(input: { actor: OpsActor; employeeId: string; kind: string; hostDepartmentId?: string | null; hostLocationId?: string | null; hostOrganisation?: string | null; role?: string | null; hostManagerId?: string | null; startDate: Date; endDate: Date; costSharePct?: number | null; note?: string | null }): Promise<Result & { id?: string; status?: string }> {
  const t = input.actor.tenantId;
  if (!["TEMPORARY", "SECONDMENT"].includes(input.kind)) return { ok: false, message: "Temporary assignment or secondment?" };
  const issues = opsAssignmentIssues({ kind: input.kind, startDate: input.startDate, endDate: input.endDate, hostDepartmentId: input.hostDepartmentId ?? null, hostOrganisation: input.hostOrganisation ?? null, costSharePct: input.costSharePct ?? null });
  if (input.hostDepartmentId && !(await prisma.department.findFirst({ where: { id: input.hostDepartmentId, tenantId: t } }))) issues.push("Host department not found.");
  if (input.hostLocationId && !(await prisma.location.findFirst({ where: { id: input.hostLocationId, tenantId: t } }))) issues.push("Host location not found.");
  if (input.hostManagerId && (input.hostManagerId === input.employeeId || !(await prisma.employee.findFirst({ where: { id: input.hostManagerId, tenantId: t } })))) issues.push("Choose another employee as the host manager.");
  issues.push(...(await lifecycleDependencyIssues(t, input.employeeId, "ASSIGNMENT")));
  const overlap = await prisma.opsAssignment.findFirst({ where: { tenantId: t, employeeId: input.employeeId, status: { in: ["REQUESTED", "APPROVED", "ACTIVE"] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } } });
  if (overlap) issues.push(`It overlaps another ${overlap.kind.toLowerCase()} assignment (${opsYmd(overlap.startDate)} to ${opsYmd(overlap.endDate)}).`);
  if (issues.length) return { ok: false, message: issues.join(" ") };
  const a = await prisma.opsAssignment.create({ data: { tenantId: t, kind: input.kind, employeeId: input.employeeId, hostDepartmentId: input.hostDepartmentId || null, hostLocationId: input.hostLocationId || null, hostOrganisation: input.hostOrganisation?.trim() || null, role: input.role?.trim() || null, hostManagerId: input.hostManagerId || null, startDate: opsDay(input.startDate), endDate: opsDay(input.endDate), originalEndDate: opsDay(input.endDate), costSharePct: input.costSharePct ?? null, note: input.note ?? null, createdBy: input.actor.userId } });
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { displayName: true } });
  const where = input.hostOrganisation?.trim() || (input.hostDepartmentId ? (await prisma.department.findUnique({ where: { id: input.hostDepartmentId }, select: { name: true } }))?.name : null) || "another team";
  const label = `${emp.displayName}: ${input.kind === "SECONDMENT" ? "secondment" : "temporary assignment"} to ${where}, ${opsYmd(a.startDate)} to ${opsYmd(a.endDate)}`;
  const res = await opsRequestApproval({ tenantId: t, entityType: "OPS_ASSIGNMENT", targetId: a.id, targetLabel: label, employeeId: input.employeeId, reason: input.note ?? null, requestedBy: input.actor.userId, title: label.charAt(0).toUpperCase() + label.slice(1), link: `/lifecycle?tab=assignments` });
  if (!res.ok) { await prisma.opsAssignment.delete({ where: { id: a.id } }); return res; }
  await prisma.opsAssignment.update({ where: { id: a.id }, data: { approvalId: res.id } });
  return { ...res, id: a.id };
}

export async function applyAssignmentDecision(a: OpsApprovalRequest, outcome: string): Promise<void> {
  if (!a.targetId) return;
  const x = await prisma.opsAssignment.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!x || x.status !== "REQUESTED") return;
  if (outcome !== "APPROVED") { await prisma.opsAssignment.update({ where: { id: x.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "CANCELLED" } }); return; }
  const active = x.startDate.getTime() <= opsDay(new Date()).getTime();
  await prisma.opsAssignment.update({ where: { id: x.id }, data: { status: active ? "ACTIVE" : "APPROVED" } });
}

async function moveAssignment(actor: OpsActor, id: string, to: string, data: Record<string, unknown>, summary: (k: string) => string): Promise<Result> {
  const x = await prisma.opsAssignment.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!x) return { ok: false, message: "Assignment not found." };
  if (!opsAssignmentCanMove(x.status, to)) return { ok: false, message: `A ${x.status.toLowerCase()} assignment cannot become ${to.toLowerCase()}.` };
  await prisma.opsAssignment.update({ where: { id }, data: { status: to, ...data } });
  await opsAudit(actor.tenantId, actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "OpsAssignment", entityId: id, summary: summary(x.kind === "SECONDMENT" ? "Secondment" : "Temporary assignment") });
  return { ok: true, message: `Marked ${to.toLowerCase()}.` };
}

export async function extendAssignment(input: { actor: OpsActor; id: string; endDate: Date; note?: string | null }): Promise<Result> {
  const x = await prisma.opsAssignment.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!x) return { ok: false, message: "Assignment not found." };
  if (!["APPROVED", "ACTIVE"].includes(x.status)) return { ok: false, message: "Only an approved or active assignment can be extended." };
  if (input.endDate <= x.endDate) return { ok: false, message: "The new end must be after the current end." };
  const issues = opsAssignmentIssues({ kind: x.kind, startDate: x.startDate, endDate: input.endDate, hostDepartmentId: x.hostDepartmentId, hostOrganisation: x.hostOrganisation, costSharePct: x.costSharePct });
  if (issues.length) return { ok: false, message: issues.join(" ") };
  await prisma.opsAssignment.update({ where: { id: x.id }, data: { endDate: opsDay(input.endDate), extensions: { increment: 1 }, note: input.note ? `${x.note ? `${x.note}\n` : ""}Extended: ${input.note}` : x.note } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "OpsAssignment", entityId: x.id, summary: `Extended to ${opsYmd(input.endDate)} (was ${opsYmd(x.endDate)})` });
  return { ok: true, message: `Extended to ${opsYmd(input.endDate)}.` };
}

export const startAssignment = (actor: OpsActor, id: string) => moveAssignment(actor, id, "ACTIVE", {}, (k) => `${k} started`);
export const completeAssignment = (actor: OpsActor, id: string, returnNote: string) => moveAssignment(actor, id, "COMPLETED", { completedAt: new Date(), returnNote: returnNote || null }, (k) => `${k} completed${returnNote ? `: ${returnNote}` : ""}`);
export const cancelAssignment = (actor: OpsActor, id: string) => moveAssignment(actor, id, "CANCELLED", {}, (k) => `${k} cancelled`);

/** Nightly: start approved assignments that have begun; remind of ones past their end. */
export async function runAssignmentTransitions(tenantId: string, now = new Date()): Promise<{ started: number; overdue: number }> {
  const today = opsDay(now);
  const s = await prisma.opsAssignment.updateMany({ where: { tenantId, status: "APPROVED", startDate: { lte: today } }, data: { status: "ACTIVE" } });
  const late = await prisma.opsAssignment.findMany({ where: { tenantId, status: "ACTIVE", endDate: { lt: today } } });
  const hr = await usersWithPermission(tenantId, "employee.record.update");
  let overdue = 0;
  for (const a of late) {
    const e = await prisma.employee.findUnique({ where: { id: a.employeeId }, select: { displayName: true } });
    if (await opsAlertOnce(tenantId, "ASSIGNMENT_ENDED", `${a.id}:${opsYmd(a.endDate)}`, { userIds: hr, title: `${e?.displayName}'s ${a.kind === "SECONDMENT" ? "secondment" : "assignment"} ended on ${opsYmd(a.endDate)}: complete or extend it`, link: "/lifecycle?tab=assignments" })) overdue++;
  }
  return { started: s.count, overdue };
}

// ---------------------------------------------------------------------------
//  Status changes with reason codes
// ---------------------------------------------------------------------------

const MANUAL_STATUSES = ["PROBATION", "CONFIRMED", "NOTICE_PERIOD", "INACTIVE"];

export async function changeEmployeeStatus(input: { actor: OpsActor; employeeId: string; toStatus: string; reasonCode: string; effectiveOn: Date; note?: string | null }): Promise<Result> {
  const t = input.actor.tenantId;
  if (!MANUAL_STATUSES.includes(input.toStatus)) return { ok: false, message: "Status can be set to probation, confirmed, notice period or inactive here; exits go through Exits." };
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: t }, select: { status: true, displayName: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.status === "EXITED") return { ok: false, message: "The employee has exited; rehire them instead." };
  if (emp.status === input.toStatus) return { ok: false, message: "That is already the status." };
  const reason = await prisma.opsReasonCode.findFirst({ where: { tenantId: t, kind: "STATUS", code: input.reasonCode, isActive: true } });
  if (!reason) return { ok: false, message: "Choose a reason from the status reason codes." };
  if (reason.appliesTo && !reason.appliesTo.split(",").map((s) => s.trim()).includes(input.toStatus)) return { ok: false, message: `"${reason.label}" is not a reason for ${input.toStatus.toLowerCase().replace("_", " ")}.` };
  await prisma.$transaction([
    prisma.employee.update({ where: { id: input.employeeId }, data: { status: input.toStatus as never } }),
    prisma.opsStatusChange.create({ data: { tenantId: t, employeeId: input.employeeId, fromStatus: emp.status, toStatus: input.toStatus, reasonCode: reason.code, reasonLabel: reason.label, effectiveOn: opsDay(input.effectiveOn), note: input.note ?? null, createdBy: input.actor.userId } }),
  ]);
  await opsAudit(t, input.actor.userId, { module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: input.employeeId, summary: `${emp.displayName}: status ${emp.status} → ${input.toStatus} (${reason.label})`, oldValue: { status: emp.status }, newValue: { status: input.toStatus, reason: reason.code } });
  return { ok: true, message: `Status set to ${input.toStatus.toLowerCase().replace("_", " ")}.` };
}

export async function statusChangeReport(tenantId: string, from: Date, to: Date) {
  const rows = await prisma.opsStatusChange.findMany({ where: { tenantId, effectiveOn: { gte: opsDay(from), lte: opsDay(to) } }, orderBy: { effectiveOn: "desc" } });
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true } });
  const en = new Map(emps.map((e) => [e.id, `${e.displayName ?? ""} (${e.employeeNumber})`]));
  const byReason = new Map<string, number>();
  for (const r of rows) byReason.set(r.reasonLabel, (byReason.get(r.reasonLabel) ?? 0) + 1);
  return { rows: rows.map((r) => ({ ...r, employee: en.get(r.employeeId) ?? r.employeeId })), byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

// ---------------------------------------------------------------------------
//  Rehire and the employment timeline
// ---------------------------------------------------------------------------

async function ensureFirstStint(tenantId: string, employeeId: string) {
  if (await prisma.opsEmploymentStint.count({ where: { employeeId } })) return;
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { dateOfJoining: true, lastWorkingDay: true, employeeNumber: true, isRehireEligible: true, exitRecord: { select: { type: true, reason: true, lastWorkingDay: true, isRehireEligible: true } } } });
  await prisma.opsEmploymentStint.create({ data: { tenantId, employeeId, stintNo: 1, startDate: e.dateOfJoining, endDate: e.exitRecord?.lastWorkingDay ?? e.lastWorkingDay, employeeNumber: e.employeeNumber, exitType: e.exitRecord?.type ?? null, exitReason: e.exitRecord?.reason ?? null, rehireEligible: e.exitRecord?.isRehireEligible ?? e.isRehireEligible } });
}

/** Bring back someone who left: a new stint, status back to onboarding, the exit cleared from the live record. */
export async function rehireEmployee(input: { actor: OpsActor; employeeId: string; joinDate: Date; override?: string | null; note?: string | null }): Promise<Result> {
  const t = input.actor.tenantId;
  const e = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: t }, select: { status: true, displayName: true, isRehireEligible: true, lastWorkingDay: true, userId: true, employeeNumber: true, exitRecord: { select: { isRehireEligible: true, lastWorkingDay: true, status: true } } } });
  if (!e) return { ok: false, message: "Employee not found." };
  if (e.status !== "EXITED") return { ok: false, message: "Only someone who has exited can be rehired." };
  const eligible = e.exitRecord?.isRehireEligible ?? e.isRehireEligible;
  if (eligible === false && !input.override?.trim()) return { ok: false, message: "Marked not eligible for rehire at exit. Give an override reason to proceed." };
  const left = e.exitRecord?.lastWorkingDay ?? e.lastWorkingDay;
  if (left && input.joinDate <= left) return { ok: false, message: `The new joining date must be after the last working day (${opsYmd(left)}).` };
  await ensureFirstStint(t, input.employeeId);
  const last = await prisma.opsEmploymentStint.findFirst({ where: { employeeId: input.employeeId }, orderBy: { stintNo: "desc" } });
  await prisma.$transaction([
    ...(last && !last.endDate && left ? [prisma.opsEmploymentStint.update({ where: { id: last.id }, data: { endDate: left } })] : []),
    prisma.opsEmploymentStint.create({ data: { tenantId: t, employeeId: input.employeeId, stintNo: (last?.stintNo ?? 1) + 1, startDate: opsDay(input.joinDate), employeeNumber: e.employeeNumber, rehireEligible: eligible ?? null, override: eligible === false ? input.override!.trim() : null, note: input.note ?? null, createdBy: input.actor.userId } }),
    prisma.employee.update({ where: { id: input.employeeId }, data: { status: "ONBOARDING", dateOfJoining: opsDay(input.joinDate), lastWorkingDay: null, exitInitiatedAt: null, confirmationDate: null } }),
    prisma.opsStatusChange.create({ data: { tenantId: t, employeeId: input.employeeId, fromStatus: "EXITED", toStatus: "ONBOARDING", reasonCode: "REHIRE", reasonLabel: "Rehired", effectiveOn: opsDay(input.joinDate), note: input.override ? `Override: ${input.override}` : input.note ?? null, createdBy: input.actor.userId } }),
    ...(e.userId ? [prisma.user.update({ where: { id: e.userId }, data: { loginDisabled: false } })] : []),
    // The previous exit lives on in the stint above; clearing it lets a later exit be recorded.
    prisma.exitRecord.deleteMany({ where: { employeeId: input.employeeId } }),
  ]);
  await opsAudit(t, input.actor.userId, { module: "LIFECYCLE", action: "CREATE", entityType: "Employee", entityId: input.employeeId, summary: `Rehired ${e.displayName} from ${opsYmd(input.joinDate)}${eligible === false ? ` (override: ${input.override})` : ""}` });
  return { ok: true, message: `${e.displayName} rehired from ${opsYmd(input.joinDate)}.` };
}

/** Stints, status changes, job records and exits in one timeline. */
export async function employmentTimeline(tenantId: string, employeeId: string) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, displayName: true, employeeNumber: true, status: true, dateOfJoining: true, isRehireEligible: true, exitRecord: { select: { type: true, status: true, lastWorkingDay: true, isRehireEligible: true, reason: true } } } });
  if (!e) return null;
  const [stints, statuses, jobs, assignments, absences] = await Promise.all([
    prisma.opsEmploymentStint.findMany({ where: { employeeId }, orderBy: { stintNo: "asc" } }),
    prisma.opsStatusChange.findMany({ where: { tenantId, employeeId }, orderBy: { effectiveOn: "asc" } }),
    prisma.employeeJobRecord.findMany({ where: { employeeId }, include: { jobTitle: { select: { name: true } } }, orderBy: { effectiveFrom: "asc" } }),
    prisma.opsAssignment.findMany({ where: { tenantId, employeeId }, orderBy: { startDate: "asc" } }),
    prisma.opsAbsenceCase.findMany({ where: { tenantId, employeeId }, orderBy: { startDate: "asc" } }),
  ]);
  const events = [
    ...stints.map((s) => ({ date: s.startDate, kind: "STINT", text: s.stintNo === 1 ? "Joined" : `Rehired (stint ${s.stintNo})${s.override ? ` — override: ${s.override}` : ""}` })),
    ...stints.filter((s) => s.endDate).map((s) => ({ date: s.endDate!, kind: "EXIT", text: `Left${s.exitType ? ` (${s.exitType.toLowerCase()})` : ""}${s.rehireEligible === false ? " · not eligible for rehire" : s.rehireEligible ? " · eligible for rehire" : ""}` })),
    ...statuses.map((s) => ({ date: s.effectiveOn, kind: "STATUS", text: `${s.fromStatus} → ${s.toStatus}: ${s.reasonLabel}` })),
    ...jobs.map((j) => ({ date: j.effectiveFrom, kind: "JOB", text: `${jobChangeLabel(j.reason)}${j.jobTitle ? ` · ${j.jobTitle.name}` : ""}` })),
    ...assignments.map((a) => ({ date: a.startDate, kind: "ASSIGNMENT", text: `${a.kind === "SECONDMENT" ? "Secondment" : "Temporary assignment"} to ${opsYmd(a.endDate)} (${a.status.toLowerCase()})` })),
    ...absences.map((a) => ({ date: a.startDate, kind: "ABSENCE", text: `Leave of absence (${a.kind.toLowerCase()}) to ${opsYmd(a.actualReturn ?? a.expectedReturn)} (${a.status.toLowerCase().replace("_", " ")})` })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  return { employee: e, stints, events, rehireEligible: e.exitRecord?.isRehireEligible ?? e.isRehireEligible ?? null };
}

/** People who left, with their rehire eligibility. */
export async function rehireEligibilityList(tenantId: string, filter?: "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN" | null) {
  const rows = await prisma.employee.findMany({ where: { tenantId, status: "EXITED" }, select: { id: true, displayName: true, employeeNumber: true, lastWorkingDay: true, isRehireEligible: true, exitRecord: { select: { type: true, isRehireEligible: true, lastWorkingDay: true } } }, orderBy: { lastWorkingDay: "desc" } });
  return rows.map((r) => {
    const v = r.exitRecord?.isRehireEligible ?? r.isRehireEligible;
    return { id: r.id, name: r.displayName ?? "", employeeNumber: r.employeeNumber, lastWorkingDay: r.exitRecord?.lastWorkingDay ?? r.lastWorkingDay, exitType: r.exitRecord?.type ?? null, eligibility: v === true ? "ELIGIBLE" : v === false ? "NOT_ELIGIBLE" : "UNKNOWN" };
  }).filter((r) => !filter || r.eligibility === filter);
}

export async function setRehireEligibility(input: { actor: OpsActor; employeeId: string; eligible: boolean | null; note?: string | null }): Promise<Result> {
  const e = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.actor.tenantId }, select: { displayName: true, isRehireEligible: true, exitRecord: { select: { id: true } } } });
  if (!e) return { ok: false, message: "Employee not found." };
  await prisma.employee.update({ where: { id: input.employeeId }, data: { isRehireEligible: input.eligible } });
  if (e.exitRecord) await prisma.exitRecord.update({ where: { id: e.exitRecord.id }, data: { isRehireEligible: input.eligible } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "LIFECYCLE", action: "UPDATE", entityType: "Employee", entityId: input.employeeId, summary: `${e.displayName}: rehire eligibility ${input.eligible === null ? "cleared" : input.eligible ? "eligible" : "not eligible"}${input.note ? ` (${input.note})` : ""}`, oldValue: { isRehireEligible: e.isRehireEligible }, newValue: { isRehireEligible: input.eligible } });
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
//  FTE conversion
// ---------------------------------------------------------------------------

export async function currentFte(tenantId: string, employeeId: string) {
  const s = await getOpsSettings(tenantId);
  const last = await prisma.opsFteConversion.findFirst({ where: { tenantId, employeeId, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" } });
  const rev = await prisma.salaryRevision.findFirst({ where: { employeeId, status: "APPLIED", effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: "desc" } });
  const fte = last ? Number(last.toFte) : 1;
  return { fte, weeklyHours: last ? Number(last.toWeeklyHours) : Math.round(Number(s.standardDailyHours) * 5 * 100) / 100, ctc: rev ? Number(rev.annualCtc) : 0, structureId: rev?.structureId ?? null, revision: rev };
}

export async function requestFteConversion(input: { actor: OpsActor; employeeId: string; toFte: number; effectiveFrom: Date; workerTypeId?: string | null; reason: string }): Promise<Result & { id?: string; status?: string }> {
  const t = input.actor.tenantId;
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: t }, select: { displayName: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (!input.reason.trim()) return { ok: false, message: "Give the reason for the change." };
  const blocks = await lifecycleDependencyIssues(t, input.employeeId, "FTE_CONVERSION");
  if (blocks.length) return { ok: false, message: blocks.join(" ") };
  if (input.workerTypeId && !(await prisma.workerType.findFirst({ where: { id: input.workerTypeId, tenantId: t } }))) return { ok: false, message: "Worker type not found." };
  const cur = await currentFte(t, input.employeeId);
  if (!cur.ctc) return { ok: false, message: "The employee has no salary to pro-rate." };
  const calc = opsFteConversion({ fte: cur.fte, weeklyHours: cur.weeklyHours, ctc: cur.ctc }, input.toFte);
  if ("error" in calc) return { ok: false, message: calc.error };
  const c = await prisma.opsFteConversion.create({ data: { tenantId: t, employeeId: input.employeeId, direction: calc.direction, fromFte: cur.fte, toFte: input.toFte, fromWeeklyHours: cur.weeklyHours, toWeeklyHours: calc.toWeeklyHours, fromCtc: cur.ctc, toCtc: calc.toCtc, workerTypeId: input.workerTypeId || null, effectiveFrom: opsDay(input.effectiveFrom), reason: input.reason.trim(), createdBy: input.actor.userId } });
  const label = `${emp.displayName}: ${calc.direction === "FT_TO_PT" ? "full-time to part-time" : "part-time to full-time"} (FTE ${cur.fte} → ${input.toFte}, CTC ${cur.ctc} → ${calc.toCtc}) from ${opsYmd(c.effectiveFrom)}`;
  const res = await opsRequestApproval({ tenantId: t, entityType: "OPS_FTE_CHANGE", targetId: c.id, targetLabel: label, employeeId: input.employeeId, reason: input.reason, requestedBy: input.actor.userId, amount: calc.toCtc, title: label, link: "/lifecycle?tab=fte" });
  if (!res.ok) { await prisma.opsFteConversion.delete({ where: { id: c.id } }); return res; }
  await prisma.opsFteConversion.update({ where: { id: c.id }, data: { approvalId: res.id } });
  return { ...res, id: c.id };
}

export async function applyFteDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (!a.targetId) return;
  const c = await prisma.opsFteConversion.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!c || c.status !== "PENDING") return;
  if (outcome !== "APPROVED") { await prisma.opsFteConversion.update({ where: { id: c.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN" } }); return; }
  const cur = await currentFte(a.tenantId, c.employeeId);
  const rev = await prisma.salaryRevision.create({ data: { employeeId: c.employeeId, structureId: cur.structureId, effectiveFrom: c.effectiveFrom, annualCtc: c.toCtc, previousCtc: cur.ctc, reason: `FTE conversion ${Number(c.fromFte)} → ${Number(c.toFte)}`, status: "APPROVED", approvedBy: actorUserId, approvedAt: new Date(), createdBy: c.createdBy } });
  await applySalaryRevision(rev.id);
  let jobChangeId: string | null = null;
  if (c.workerTypeId) {
    const r = await requestJobChange({ tenantId: a.tenantId, employeeId: c.employeeId, requestedBy: c.createdBy, fields: { effectiveFrom: c.effectiveFrom, reason: "WORKER_TYPE_CHANGE", workerTypeId: c.workerTypeId, note: `FTE conversion to ${Number(c.toFte)}` }, holdUntilEffective: true, summary: `Worker type change with FTE conversion` });
    jobChangeId = r.jobChangeId;
  }
  await prisma.opsFteConversion.update({ where: { id: c.id }, data: { status: "APPLIED", revisionId: rev.id, jobChangeId } });
  await opsAudit(a.tenantId, actorUserId, { module: "LIFECYCLE", action: "APPROVE", entityType: "OpsFteConversion", entityId: c.id, summary: `Applied ${a.targetLabel}` });
}

export async function fteReport(tenantId: string) {
  const rows = await prisma.opsFteConversion.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 });
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, displayName: true } });
  const en = new Map(emps.map((e) => [e.id, e.displayName ?? ""]));
  return rows.map((r) => ({ ...r, employee: en.get(r.employeeId) ?? "" }));
}

// ---------------------------------------------------------------------------
//  Confirmation rules
// ---------------------------------------------------------------------------

export async function saveConfirmationRule(input: { tenantId: string; id?: string | null; name: string; probationPolicyId?: string | null; minServiceDays: number; maxLopDays?: number | null; maxLateMarks?: number | null; noWarningsMonths?: number | null; requireEvaluation: boolean; minRating?: number | null; isActive: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the rule." };
  if (input.minServiceDays < 0 || input.minServiceDays > 1095) return { ok: false, message: "Minimum service is 0 to 1095 days." };
  if (input.minRating != null && (input.minRating < 1 || input.minRating > 5)) return { ok: false, message: "Rating is 1 to 5." };
  if (input.probationPolicyId && !(await prisma.probationPolicy.findFirst({ where: { id: input.probationPolicyId, tenantId: input.tenantId } }))) return { ok: false, message: "Probation policy not found." };
  const data = { name: input.name.trim(), probationPolicyId: input.probationPolicyId || null, minServiceDays: input.minServiceDays, maxLopDays: input.maxLopDays ?? null, maxLateMarks: input.maxLateMarks ?? null, noWarningsMonths: input.noWarningsMonths ?? null, requireEvaluation: input.requireEvaluation, minRating: input.minRating ?? null, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsConfirmationRule.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Saved." } : { ok: false, message: "Rule not found." };
    }
    await prisma.opsConfirmationRule.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: `Rule "${data.name}" added.` };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, message: "A rule with that name exists." };
    throw e;
  }
}

/** Whether an employee on probation meets the confirmation rules that apply to them. */
export async function confirmationEligibility(tenantId: string, employeeId: string, today = new Date()) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, displayName: true, dateOfJoining: true, probation: { select: { id: true, policyId: true, evaluations: { select: { status: true, rating: true } } } } } });
  if (!e) return null;
  const rules = await prisma.opsConfirmationRule.findMany({ where: { tenantId, isActive: true, OR: [{ probationPolicyId: null }, ...(e.probation ? [{ probationPolicyId: e.probation.policyId }] : [])] } });
  if (!rules.length) return { employee: e.displayName ?? "", rules: [], eligible: true, reasons: [] as string[] };
  const serviceDays = Math.floor((opsDay(today).getTime() - opsDay(e.dateOfJoining).getTime()) / 86_400_000);
  const [lop, late] = await Promise.all([
    prisma.attendanceRecord.aggregate({ where: { employeeId, date: { gte: e.dateOfJoining, lte: today } }, _sum: { lopValue: true } }),
    prisma.opsAttendanceAnomaly.count({ where: { tenantId, employeeId, kind: "LATE_ARRIVAL", date: { gte: e.dateOfJoining } } }),
  ]);
  const subs = (e.probation?.evaluations ?? []).filter((x) => x.status === "SUBMITTED");
  const ratings = subs.map((x) => x.rating).filter((r): r is number => r !== null);
  const out = await Promise.all(rules.map(async (r) => {
    const warnings = r.noWarningsMonths ? await prisma.hrActivity.count({ where: { tenantId, employeeId, type: "WARNING", approvalStatus: { not: "REJECTED" }, occurredOn: { gte: new Date(today.getTime() - r.noWarningsMonths * 30 * 86_400_000) } } }) : 0;
    const res = opsConfirmationEligibility({ serviceDays, lopDays: Number(lop._sum.lopValue ?? 0), lateMarks: late, warningsInWindow: warnings, evaluationDone: subs.length > 0, rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null }, { minServiceDays: r.minServiceDays, maxLopDays: r.maxLopDays === null ? null : Number(r.maxLopDays), maxLateMarks: r.maxLateMarks, noWarningsMonths: r.noWarningsMonths, requireEvaluation: r.requireEvaluation, minRating: r.minRating === null ? null : Number(r.minRating) });
    return { rule: r.name, ...res };
  }));
  return { employee: e.displayName ?? "", rules: out, eligible: out.every((o) => o.eligible), reasons: out.flatMap((o) => o.reasons.map((x) => `${o.rule}: ${x}`)) };
}

// ---------------------------------------------------------------------------
//  Contract renewal milestones
// ---------------------------------------------------------------------------

export async function runContractAlerts(tenantId: string, now = new Date()): Promise<{ contracts: number; sent: number }> {
  const s = await getOpsSettings(tenantId);
  const horizon = Math.max(0, ...s.contractAlertDays);
  const today = opsDay(now);
  const contracts = await prisma.employeeContract.findMany({ where: { tenantId, status: "ACTIVE", endDate: { gte: today, lte: new Date(today.getTime() + horizon * 86_400_000) } }, include: { employee: { select: { displayName: true, userId: true, status: true, reportingManager: { select: { userId: true } } } }, renewals: { select: { id: true } } } });
  const hr = await usersWithPermission(tenantId, "employee.record.update");
  let sent = 0;
  for (const c of contracts) {
    if (c.employee.status === "EXITED" || c.renewals.length) continue;
    const already = new Set((await prisma.opsAlertLog.findMany({ where: { tenantId, kind: "CONTRACT_MILESTONE", dedupeKey: { startsWith: `${c.id}:` } }, select: { dedupeKey: true } })).map((x) => Number(x.dedupeKey.split(":")[1])));
    for (const m of opsContractMilestonesDue(c.endDate!, s.contractAlertDays, today, already)) {
      if (await opsAlertOnce(tenantId, "CONTRACT_MILESTONE", `${c.id}:${m}`, { userIds: [...hr, c.employee.reportingManager?.userId ?? ""], email: true, link: `/lifecycle?tab=contracts`, title: `${c.employee.displayName}'s contract${c.contractNumber ? ` ${c.contractNumber}` : ""} ends on ${opsYmd(c.endDate!)} (${m} day milestone): renew or plan the exit` })) sent++;
    }
  }
  return { contracts: contracts.length, sent };
}

export async function contractRenewalBoard(tenantId: string, days = 90, now = new Date()) {
  const today = opsDay(now);
  const rows = await prisma.employeeContract.findMany({ where: { tenantId, status: "ACTIVE", endDate: { not: null, lte: new Date(today.getTime() + days * 86_400_000) } }, include: { employee: { select: { id: true, displayName: true, employeeNumber: true } }, renewals: { select: { id: true } } }, orderBy: { endDate: "asc" } });
  const alerts = await prisma.opsAlertLog.findMany({ where: { tenantId, kind: "CONTRACT_MILESTONE", dedupeKey: { in: rows.flatMap((r) => [60, 30, 7, 14, 90].map((m) => `${r.id}:${m}`)) } }, select: { dedupeKey: true, createdAt: true } });
  return rows.map((r) => ({ id: r.id, employee: `${r.employee.displayName ?? ""} (${r.employee.employeeNumber})`, employeeId: r.employee.id, contractNumber: r.contractNumber, endDate: r.endDate!, daysLeft: Math.round((opsDay(r.endDate!).getTime() - today.getTime()) / 86_400_000), renewed: r.renewals.length > 0, alertsSent: alerts.filter((a) => a.dedupeKey.startsWith(`${r.id}:`)).map((a) => Number(a.dedupeKey.split(":")[1])) }));
}

