"use server";

import { PERMISSIONS } from "@keka/rbac";
import {
  editHrActivity, editJobChange, correctJobRecord, requestAssignment, extendAssignment, startAssignment, completeAssignment, cancelAssignment,
  changeEmployeeStatus, rehireEmployee, setRehireEligibility, requestFteConversion, saveConfirmationRule,
} from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { writeAudit, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, actorOf, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Lifecycle controls: HR event edits, job change maintenance, assignments
 * and secondments, status changes with reasons, rehire, FTE conversion and
 * confirmation rules.
 */

const P = PERMISSIONS;
const PATHS = ["/lifecycle", "/activities", "/employees", "/inbox"];

export async function editHrActivityAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HR_ACTIVITY_MANAGE)) return DENIED;
  const d = day(fd, "occurredOn");
  if (!d) return no("Pick the date.");
  return result(await editHrActivity({ actor: actorOf(v), id: str(fd, "id"), title: str(fd, "title"), description: optStr(fd, "description"), occurredOn: d, severity: optStr(fd, "severity"), fromValue: optStr(fd, "fromValue"), toValue: optStr(fd, "toValue"), destination: optStr(fd, "destination") }), PATHS);
}

export async function editJobChangeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const d = day(fd, "effectiveFrom");
  if (!d) return no("Pick the effective date.");
  const keep = (k: string) => (fd.has(k) ? optStr(fd, k) : undefined);
  return result(await editJobChange({ actor: actorOf(v), id: str(fd, "id"), effectiveFrom: d, note: optStr(fd, "note"), jobTitleId: keep("jobTitleId"), departmentId: keep("departmentId"), locationId: keep("locationId"), reportingManagerId: keep("reportingManagerId") }), PATHS);
}

export async function correctJobRecordAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const d = day(fd, "effectiveFrom");
  if (!d) return no("Pick the effective date.");
  return result(await correctJobRecord({ actor: actorOf(v), recordId: str(fd, "recordId"), effectiveFrom: d, note: optStr(fd, "note") }), PATHS);
}

export async function requestAssignmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const from = day(fd, "startDate"), to = day(fd, "endDate");
  if (!from || !to) return no("Pick the dates.");
  const share = int(fd, "costSharePct");
  if (Number.isNaN(share)) return no("The cost share is a whole percentage.");
  const r = await requestAssignment({ actor: actorOf(v), employeeId: str(fd, "employeeId"), kind: str(fd, "kind"), hostDepartmentId: optStr(fd, "hostDepartmentId"), hostLocationId: optStr(fd, "hostLocationId"), hostOrganisation: optStr(fd, "hostOrganisation"), role: optStr(fd, "role"), hostManagerId: optStr(fd, "hostManagerId"), startDate: from, endDate: to, costSharePct: share, note: optStr(fd, "note") });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "CREATE", entityType: "OpsAssignment", entityId: r.id, summary: `Requested a ${str(fd, "kind").toLowerCase()} assignment` });
  return result(r, PATHS);
}

export async function moveAssignmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const id = str(fd, "id"), to = str(fd, "to");
  if (to === "EXTEND") { const d = day(fd, "endDate"); if (!d) return no("Pick the new end date."); return result(await extendAssignment({ actor: actorOf(v), id, endDate: d, note: optStr(fd, "note") }), PATHS); }
  if (to === "ACTIVE") return result(await startAssignment(actorOf(v), id), PATHS);
  if (to === "COMPLETED") return result(await completeAssignment(actorOf(v), id, str(fd, "note")), PATHS);
  if (to === "CANCELLED") return result(await cancelAssignment(actorOf(v), id), PATHS);
  return no("Unknown step.");
}

export async function changeStatusAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const d = day(fd, "effectiveOn") ?? new Date();
  return result(await changeEmployeeStatus({ actor: actorOf(v), employeeId: str(fd, "employeeId"), toStatus: str(fd, "toStatus"), reasonCode: str(fd, "reasonCode"), effectiveOn: d, note: optStr(fd, "note") }), PATHS);
}

export async function rehireAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_CREATE) && !can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const d = day(fd, "joinDate");
  if (!d) return no("Pick the new joining date.");
  return result(await rehireEmployee({ actor: actorOf(v), employeeId: str(fd, "employeeId"), joinDate: d, override: optStr(fd, "override"), note: optStr(fd, "note") }), PATHS);
}

export async function setRehireEligibilityAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EXIT_MANAGE) && !can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const val = str(fd, "eligible");
  return result(await setRehireEligibility({ actor: actorOf(v), employeeId: str(fd, "employeeId"), eligible: val === "yes" ? true : val === "no" ? false : null, note: optStr(fd, "note") }), PATHS);
}

export async function requestFteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.EMPLOYEE_UPDATE)) return DENIED;
  const d = day(fd, "effectiveFrom");
  const fte = money(fd, "toFte");
  if (!d || fte === null || Number.isNaN(fte)) return no("Enter the new FTE and the effective date.");
  const r = await requestFteConversion({ actor: actorOf(v), employeeId: str(fd, "employeeId"), toFte: fte, effectiveFrom: d, workerTypeId: optStr(fd, "workerTypeId"), reason: str(fd, "reason") });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "CREATE", entityType: "OpsFteConversion", entityId: r.id, summary: `Requested an FTE change to ${fte}` });
  return result(r, PATHS);
}

export async function saveConfirmationRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PROBATION_MANAGE)) return DENIED;
  const nums = ["minServiceDays", "maxLateMarks", "noWarningsMonths"].map((k) => int(fd, k));
  if (nums.some((x) => Number.isNaN(x))) return no("Use whole numbers.");
  const r = await saveConfirmationRule({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), probationPolicyId: optStr(fd, "probationPolicyId"), minServiceDays: nums[0] ?? 0, maxLopDays: money(fd, "maxLopDays"), maxLateMarks: nums[1], noWarningsMonths: nums[2], requireEvaluation: bool(fd, "requireEvaluation"), minRating: money(fd, "minRating"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: optStr(fd, "id") ? "UPDATE" : "CREATE", entityType: "OpsConfirmationRule", entityId: optStr(fd, "id"), summary: `Saved confirmation rule "${str(fd, "name")}"` });
  return result(r, PATHS);
}
