"use server";

import { prisma } from "@keka/db";
import {
  raiseShiftRequest, raiseOvertimeRequest, raiseCompOffRequest, raiseEncashmentRequest,
  withdrawTimeRequest, addRequestComment, notifyTimeRequest, parseHhmm, formatHhmm,
  type ExtraTimeEntity,
} from "@keka/services";
import { formatDate } from "@keka/shared";
import { requireViewer, type Viewer } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone as done, formList, zName, zOptional, zRequiredDate, zDate, zId, type ActionState } from "@/lib/forms";
import { decideTimeRequest, isTimeEntity, loadTimeRequest, reachesEmployee, ENTITY_PERMISSION } from "@/lib/time-decide";

/**
 * Employee-raised time requests beyond leave and attendance corrections —
 * shift and weekly-off changes, overtime, comp-off credit, encashment — and
 * the shared decide / bulk-decide / comment / withdraw actions for every
 * time request. Each re-checks who may act on the server.
 */

const PATHS = ["/me/attendance", "/me/leave", "/inbox", "/time", "/time/approvals", "/team/leave", "/team/attendance"];

/** Colleagues the employee copied ("Notify"), kept to real people in the tenant. */
async function notifyIds(viewer: Viewer, formData: FormData): Promise<string[]> {
  const raw = [...new Set(formList(formData, "notify"))].filter((id) => id !== viewer.employee?.id).slice(0, 20);
  if (raw.length === 0) return [];
  const rows = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: raw }, status: { notIn: ["EXITED"] } }, select: { id: true } });
  return rows.map((r) => r.id);
}

const range = (a: Date, b: Date) => (a.getTime() === b.getTime() ? `on ${formatDate(a)}` : `from ${formatDate(a)} to ${formatDate(b)}`);

// ---------------------------------------------------------------------------
//  Shift change and weekly off
// ---------------------------------------------------------------------------

const shiftSchema = z.object({
  kind: z.enum(["SHIFT_CHANGE", "WEEKLY_OFF"]),
  fromDate: zRequiredDate(),
  toDate: zDate(),
  shiftId: z.string().optional(),
  reason: zName(500),
});

export async function raiseShiftRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(shiftSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const to = d.toDate ?? d.fromDate;
  const notify = await notifyIds(viewer, formData);
  const res = await raiseShiftRequest({
    employeeId: viewer.employee.id, kind: d.kind, from: d.fromDate, to,
    shiftId: d.kind === "SHIFT_CHANGE" ? d.shiftId ?? null : null, reason: d.reason, notifyEmployeeIds: notify,
  });
  if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) };
  const what = `${d.kind === "SHIFT_CHANGE" ? "a shift change" : "weekly off"} ${range(d.fromDate, to)}`;
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "ShiftRequest", entityId: res.requestId, summary: `Requested ${what}` });
  await notifyTimeRequest({ tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "ATTENDANCE", event: "RAISED", what, notifyEmployeeIds: notify, note: d.reason });
  return done(PATHS, `Requested ${what}. It is now awaiting approval.`);
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

const overtimeSchema = z.object({
  fromDate: zRequiredDate(),
  toDate: zDate(),
  hours: z.string().min(1, "Required"),
  note: zOptional(500),
});

export async function raiseOvertimeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(overtimeSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const minutes = parseHhmm(d.hours);
  if (minutes === null) return { ok: false, message: "Enter the overtime as hh:mm, e.g. 02:30.", errors: { hours: "Use hh:mm" } };
  const to = d.toDate ?? d.fromDate;
  const notify = await notifyIds(viewer, formData);
  const res = await raiseOvertimeRequest({ employeeId: viewer.employee.id, from: d.fromDate, to, minutes, note: d.note, notifyEmployeeIds: notify });
  if (!res.ok) return { ok: false, message: res.message };
  const what = `${formatHhmm(minutes)} hrs of overtime ${range(d.fromDate, to)}`;
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OvertimeRequest", entityId: res.requestId, summary: `Requested ${what}` });
  await notifyTimeRequest({ tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "ATTENDANCE", event: "RAISED", what, notifyEmployeeIds: notify, note: d.note });
  return done(PATHS, `Requested ${what}. It is now awaiting approval.`);
}

// ---------------------------------------------------------------------------
//  Compensatory off credit
// ---------------------------------------------------------------------------

const compOffSchema = z.object({ fromDate: zRequiredDate(), toDate: zDate(), note: zOptional(500) });

export async function raiseCompOffAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(compOffSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const to = d.toDate ?? d.fromDate;
  const res = await raiseCompOffRequest({ employeeId: viewer.employee.id, from: d.fromDate, to, note: d.note });
  if (!res.ok) return { ok: false, message: res.message };
  const what = `${res.days} day(s) of comp off for work ${range(d.fromDate, to)}`;
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "CompOffRequest", entityId: res.requestId, summary: `Requested ${what}` });
  await notifyTimeRequest({ tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "LEAVE", event: "RAISED", what, note: d.note });
  return done(PATHS, `${res.message} It is now awaiting approval.`);
}

// ---------------------------------------------------------------------------
//  Leave encashment
// ---------------------------------------------------------------------------

const encashSchema = z.object({
  leaveTypeId: zId(),
  mode: z.enum(["all", "custom"]).default("all"),
  days: z.string().optional(),
  note: zOptional(500),
});

export async function raiseEncashmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(encashSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const type = await prisma.leaveType.findFirst({ where: { id: d.leaveTypeId, tenantId: viewer.tenantId }, select: { id: true } });
  if (!type) return { ok: false, message: "Leave type not found." };
  const days = d.mode === "custom" ? Number(d.days) : null;
  if (d.mode === "custom" && !(days! > 0)) return { ok: false, message: "Enter how many days to encash.", errors: { days: "Required" } };
  const res = await raiseEncashmentRequest({ employeeId: viewer.employee.id, leaveTypeId: type.id, all: d.mode === "all", days, note: d.note });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "LeaveEncashmentRequest", entityId: res.requestId, summary: res.message });
  await notifyTimeRequest({ tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "LEAVE", event: "RAISED", what: res.message.replace(/^Requested /, "").replace(/\.$/, ""), note: d.note });
  return done(PATHS, "Leave Encashment Request submitted successfully");
}

// ---------------------------------------------------------------------------
//  Decide, decide many, comment, withdraw
// ---------------------------------------------------------------------------

export async function decideTimeRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const entity = String(formData.get("entity") ?? "");
  const id = String(formData.get("requestId") ?? "");
  if (!isTimeEntity(entity) || !id) return { ok: false, message: "Request not found." };
  const decision = String(formData.get("decision")) === "approve" ? "APPROVE" : "REJECT";
  const note = String(formData.get("note") ?? "").slice(0, 1000) || null;
  const res = await decideTimeRequest(viewer, entity, id, decision, note);
  if (!res.ok) return { ok: false, message: res.message, ...(decision === "REJECT" && !note ? { errors: { note: "Required" } } : {}) };
  return done(PATHS, res.message);
}

/** "Approve all" / "Reject all" on a selection. Each item is checked on its own. */
export async function decideManyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const entity = String(formData.get("entity") ?? "");
  if (!isTimeEntity(entity)) return { ok: false, message: "Nothing selected." };
  const ids = [...new Set(formList(formData, "ids"))].slice(0, 100);
  if (ids.length === 0) return { ok: false, message: "Select at least one request." };
  const decision = String(formData.get("decision")) === "approve" ? "APPROVE" : "REJECT";
  const note = String(formData.get("note") ?? "").slice(0, 1000) || null;
  if (decision === "REJECT" && !note?.trim()) return { ok: false, message: "Give a reason when rejecting.", errors: { note: "Required" } };
  let done_ = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const res = await decideTimeRequest(viewer, entity, id, decision, note);
    if (res.ok) done_++; else failed.push(res.message);
  }
  if (done_ === 0) return { ok: false, message: failed[0] ?? "Nothing was decided." };
  const verb = decision === "APPROVE" ? "approved" : "rejected";
  return done(PATHS, failed.length
    ? `${done_} of ${ids.length} requests ${verb}. ${failed.length} could not be: ${failed[0]}`
    : `${done_} request${done_ === 1 ? " is" : "s are"} ${verb} successfully`);
}

const commentSchema = z.object({ entity: z.string(), requestId: zId(), body: zName(1024) });

/** A comment on a request: by the employee who raised it, or anyone who may decide it. */
export async function addRequestCommentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(commentSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!isTimeEntity(d.entity)) return { ok: false, message: "Request not found." };
  const ref = await loadTimeRequest(viewer.tenantId, d.entity, d.requestId);
  if (!ref) return { ok: false, message: "Request not found." };
  const own = ref.employeeId === viewer.employee?.id;
  if (!own && !(await reachesEmployee(viewer, ref.employeeId, ENTITY_PERMISSION[d.entity]))) {
    return { ok: false, message: "You cannot comment on this request." };
  }
  const res = await addRequestComment({
    tenantId: viewer.tenantId, entityType: d.entity, entityId: d.requestId, body: d.body,
    authorEmployeeId: viewer.employee?.id ?? null, authorUserId: viewer.user.id,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: ref.family, action: "UPDATE", entityType: d.entity, entityId: d.requestId, summary: `Commented on ${ref.what}` });
  return done(PATHS, "Comment added.");
}

export async function withdrawTimeRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const entity = String(formData.get("entity") ?? "") as ExtraTimeEntity;
  if (!["ShiftRequest", "OvertimeRequest", "CompOffRequest", "LeaveEncashmentRequest"].includes(entity)) return { ok: false, message: "Request not found." };
  const id = String(formData.get("requestId") ?? "");
  const res = await withdrawTimeRequest(entity, id, viewer.employee.id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: entity === "ShiftRequest" || entity === "OvertimeRequest" ? "ATTENDANCE" : "LEAVE", action: "UPDATE", entityType: entity, entityId: id, summary: "Withdrew a pending request" });
  return done(PATHS, "Withdrawn.");
}
