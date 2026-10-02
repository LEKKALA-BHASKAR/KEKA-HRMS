import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee, type Permission } from "@keka/rbac";
import {
  decideLeave, decideAttendanceRequest, decideShiftRequest, decideOvertimeRequest, decideCompOffRequest,
  decideEncashmentRequest, notifyTimeRequest, formatHhmm, TIME_ENTITIES, type TimeEntity, type LeaveApprovalActor,
} from "@keka/services";
import { formatDate } from "@keka/shared";
import { can, type Viewer } from "./context";
import { writeAudit } from "./forms";
import { ATTENDANCE_TYPE_LABEL } from "./time-approvals";

/**
 * Deciding any time request, by entity. The one path every approve/reject
 * button, the inbox's "Approve all" and the approvals tables use, so the
 * checks are identical everywhere: the right permission, the request in the
 * viewer's tenant and scope, never your own, a reason to reject.
 */

const P = PERMISSIONS;

export const ENTITY_PERMISSION: Record<TimeEntity, Permission> = {
  LeaveRequest: P.LEAVE_APPROVE, CompOffRequest: P.LEAVE_APPROVE, LeaveEncashmentRequest: P.LEAVE_APPROVE,
  AttendanceRequest: P.ATTENDANCE_APPROVE, OvertimeRequest: P.ATTENDANCE_APPROVE, ShiftRequest: P.ATTENDANCE_APPROVE,
};
export const isTimeEntity = (v: unknown): v is TimeEntity => typeof v === "string" && (TIME_ENTITIES as readonly string[]).includes(v);

export interface TimeRequestRef {
  entity: TimeEntity;
  id: string;
  employeeId: string;
  status: string;
  family: "LEAVE" | "ATTENDANCE";
  /** "Work From Home on 07 Oct 2026" */
  what: string;
  notifyEmployeeIds: string[];
}

const on = (a: Date, b: Date) => (a.getTime() === b.getTime() ? `on ${formatDate(a)}` : `from ${formatDate(a)} to ${formatDate(b)}`);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Load a time request inside the viewer's tenant, whatever its kind. */
export async function loadTimeRequest(tenantId: string, entity: TimeEntity, id: string): Promise<TimeRequestRef | null> {
  const where = { id, tenantId };
  switch (entity) {
    case "LeaveRequest": {
      const r = await prisma.leaveRequest.findFirst({ where, include: { leaveType: { select: { name: true } } } });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "LEAVE", what: `${r.leaveType.name} ${on(r.fromDate, r.toDate)}`, notifyEmployeeIds: list(r.notifyEmployeeIds) };
    }
    case "AttendanceRequest": {
      const r = await prisma.attendanceRequest.findFirst({ where });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "ATTENDANCE", what: `${ATTENDANCE_TYPE_LABEL[r.type] ?? r.type} ${on(r.fromDate, r.toDate)}`, notifyEmployeeIds: list(r.notifyEmployeeIds) };
    }
    case "ShiftRequest": {
      const r = await prisma.shiftRequest.findFirst({ where, include: { shift: { select: { name: true } } } });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "ATTENDANCE", what: `${r.kind === "SHIFT_CHANGE" ? `a change to ${r.shift?.name ?? "another shift"}` : "weekly off"} ${on(r.fromDate, r.toDate)}`, notifyEmployeeIds: list(r.notifyEmployeeIds) };
    }
    case "OvertimeRequest": {
      const r = await prisma.overtimeRequest.findFirst({ where });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "ATTENDANCE", what: `${formatHhmm(r.requestedMinutes)} hrs of overtime ${on(r.fromDate, r.toDate)}`, notifyEmployeeIds: list(r.notifyEmployeeIds) };
    }
    case "CompOffRequest": {
      const r = await prisma.compOffRequest.findFirst({ where });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "LEAVE", what: `${Number(r.days)} day(s) of comp off for work ${on(r.fromDate, r.toDate)}`, notifyEmployeeIds: [] };
    }
    case "LeaveEncashmentRequest": {
      const r = await prisma.leaveEncashmentRequest.findFirst({ where, include: { leaveType: { select: { name: true } } } });
      return r && { entity, id, employeeId: r.employeeId, status: r.status, family: "LEAVE", what: `encashment of ${Number(r.days)} day(s) of ${r.leaveType.name}`, notifyEmployeeIds: [] };
    }
  }
}

/** Does the viewer's scope reach this employee for this permission? */
export async function reachesEmployee(viewer: Viewer, employeeId: string, permission: Permission): Promise<boolean> {
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

/**
 * The viewer as a leave approver for one employee, for approval chains: who
 * they are, whether they manage leave for this person (HR), and whether they
 * may approve for them at all.
 */
export async function leaveActor(viewer: Viewer, employeeId: string): Promise<LeaveApprovalActor> {
  const [isHr, canApprove] = await Promise.all([
    can(viewer, P.LEAVE_MANAGE) ? reachesEmployee(viewer, employeeId, P.LEAVE_MANAGE) : Promise.resolve(false),
    can(viewer, P.LEAVE_APPROVE) ? reachesEmployee(viewer, employeeId, P.LEAVE_APPROVE) : Promise.resolve(false),
  ]);
  return { employeeId: viewer.employee?.id ?? null, isHr, canApprove };
}

/** Decide one time request on the viewer's behalf. */
export async function decideTimeRequest(
  viewer: Viewer, entity: TimeEntity, id: string, decision: "APPROVE" | "REJECT", note: string | null,
): Promise<{ ok: boolean; message: string }> {
  const permission = ENTITY_PERMISSION[entity];
  if (!can(viewer, permission)) return { ok: false, message: "You do not have permission to decide these requests." };
  const ref = await loadTimeRequest(viewer.tenantId, entity, id);
  if (!ref) return { ok: false, message: "Request not found." };
  if (ref.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own request." };
  if (!(await reachesEmployee(viewer, ref.employeeId, permission))) {
    return { ok: false, message: "This request is outside the employees your roles reach." };
  }
  if (ref.status !== "PENDING") return { ok: false, message: `This request is already ${ref.status.toLowerCase()}.` };
  if (decision === "REJECT" && !note?.trim()) return { ok: false, message: "Give a reason when rejecting." };

  const decider = viewer.employee?.id ?? null;
  const cleanNote = note?.trim() || null;
  const res = entity === "LeaveRequest" ? await decideLeave({ requestId: id, decision, approverEmployeeId: decider, note: cleanNote, actor: await leaveActor(viewer, ref.employeeId) })
    : entity === "AttendanceRequest" ? await decideAttendanceRequest({ requestId: id, decision, deciderEmployeeId: decider, note: cleanNote })
    : entity === "ShiftRequest" ? await decideShiftRequest({ requestId: id, decision, deciderEmployeeId: decider, note: cleanNote })
    : entity === "OvertimeRequest" ? await decideOvertimeRequest({ requestId: id, decision, deciderEmployeeId: decider, note: cleanNote })
    : entity === "CompOffRequest" ? await decideCompOffRequest({ requestId: id, decision, deciderEmployeeId: decider, note: cleanNote })
    : await decideEncashmentRequest({ requestId: id, decision, deciderEmployeeId: decider, note: cleanNote });
  if (!res.ok) return { ok: false, message: res.message };

  await writeAudit(viewer, {
    module: ref.family, action: decision === "APPROVE" ? "APPROVE" : "REJECT",
    entityType: entity, entityId: id,
    summary: `${decision === "APPROVE" ? "Approved" : "Rejected"} ${ref.what}`,
  });
  // An approval that only clears one level of a chain is not the outcome yet.
  if (!("pendingLevel" in res && res.pendingLevel)) {
    await notifyTimeRequest({
      tenantId: viewer.tenantId, employeeId: ref.employeeId, kind: ref.family,
      event: decision === "APPROVE" ? "APPROVED" : "REJECTED", what: ref.what, note: cleanNote,
    });
  }
  return { ok: true, message: res.message };
}
