"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee, type Permission } from "@keka/rbac";
import {
  raiseCompOff, decideCompOff, cancelCompOff, raiseEncashment, decideEncashment, cancelEncashment, notify,
} from "@keka/services";
import { requireViewer, requireAuth, type Viewer } from "@/lib/context";
import { z, parseForm, toErrorState, writeAudit, actionDone as done, zRequiredDate, zName, zOptional, zId, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/me/leave", "/leave", "/inbox", "/"];

const issuesToState = (issues: Array<{ field: string; message: string }>, values?: Record<string, string>): ActionState => ({
  ok: false,
  message: issues.find((i) => i.field === "_form")?.message ?? issues[0]?.message ?? "Please check the request.",
  errors: Object.fromEntries(issues.filter((i) => i.field !== "_form").map((i) => [i.field, i.message])),
  values,
});

/** The decider must reach the employee through the permission, and may not decide their own request. */
async function mayDecide(viewer: Viewer, employeeId: string, permission: Permission): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return false;
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

const compOffSchema = z.object({
  workedOn: zRequiredDate(),
  days: z.enum(["1", "0.5"]),
  reason: zName(500),
});

export async function requestCompOffAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can claim comp-off." };
  const parsed = parseForm(compOffSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  try {
    const r = await raiseCompOff({ employeeId: viewer.employee.id, workedOn: d.workedOn, days: Number(d.days), reason: d.reason });
    if (!r.ok) return issuesToState(r.issues, values);
    const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { reportingManager: { select: { userId: true } } } });
    await notify({
      tenantId: viewer.tenantId, userIds: [me.reportingManager?.userId], kind: "LEAVE",
      title: `${viewer.employee.displayName} claimed comp-off`, body: `${d.days} day for working on ${d.workedOn.toISOString().slice(0, 10)}`, link: "/inbox",
    });
    return done(PATHS, "Comp-off requested. Your manager will review it.");
  } catch (err) {
    return toErrorState(err, values);
  }
}

const decideSchema = z.object({ requestId: zId(), decision: z.string().transform((v) => v.toUpperCase()).pipe(z.enum(["APPROVE", "REJECT"])), note: zOptional(500) });

export async function decideCompOffAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_APPROVE);
  const parsed = parseForm(decideSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const req = await prisma.compOffRequest.findFirst({ where: { id: d.requestId, tenantId: viewer.tenantId }, include: { employee: { select: { userId: true, displayName: true } } } });
  if (!req) return { ok: false, message: "Request not found." };
  if (!(await mayDecide(viewer, req.employeeId, P.LEAVE_APPROVE))) return { ok: false, message: "You cannot decide this request." };
  if (d.decision === "REJECT" && !d.note) return { ok: false, message: "Say why it is being rejected.", errors: { note: "Required to reject" } };
  try {
    const r = await decideCompOff({ requestId: req.id, approve: d.decision === "APPROVE", note: d.note, deciderEmployeeId: viewer.employee?.id ?? null });
    if (!r.ok) return { ok: false, message: r.message };
    await writeAudit(viewer, { module: "LEAVE", action: d.decision === "APPROVE" ? "APPROVE" : "REJECT", entityType: "CompOffRequest", entityId: req.id, summary: `${d.decision === "APPROVE" ? "Approved" : "Rejected"} comp-off for ${req.employee.displayName}` });
    await notify({ tenantId: viewer.tenantId, userIds: [req.employee.userId], kind: "LEAVE", title: `Comp-off ${d.decision === "APPROVE" ? "approved" : "rejected"}`, body: d.note ?? r.message, link: "/me/leave" });
    return done(PATHS, r.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function cancelCompOffAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record." };
  const id = String(formData.get("requestId"));
  if (!(await prisma.compOffRequest.count({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Request not found." };
  const r = await cancelCompOff(id, viewer.employee.id);
  return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
}

const encashSchema = z.object({
  leaveTypeId: zId(),
  days: z.string().min(1, "Required").transform((v) => Number(v)).refine((n) => Number.isFinite(n) && n > 0, "Enter the days to encash"),
  reason: zOptional(500),
});

export async function requestEncashmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can encash leave." };
  const parsed = parseForm(encashSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  if (!(await prisma.leaveType.count({ where: { id: d.leaveTypeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Leave type not found.", values };
  try {
    const r = await raiseEncashment({ employeeId: viewer.employee.id, leaveTypeId: d.leaveTypeId, days: d.days, reason: d.reason });
    if (!r.ok) return issuesToState(r.issues, values);
    return done(PATHS, `Encashment of ₹${r.amount.toLocaleString("en-IN")} requested. HR will review it.`);
  } catch (err) {
    return toErrorState(err, values);
  }
}

export async function decideEncashmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(decideSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const req = await prisma.leaveEncashmentRequest.findFirst({ where: { id: d.requestId, tenantId: viewer.tenantId }, include: { employee: { select: { userId: true, displayName: true } } } });
  if (!req) return { ok: false, message: "Request not found." };
  if (!(await mayDecide(viewer, req.employeeId, P.LEAVE_MANAGE))) return { ok: false, message: "You cannot decide this request." };
  if (d.decision === "REJECT" && !d.note) return { ok: false, message: "Say why it is being rejected.", errors: { note: "Required to reject" } };
  try {
    const r = await decideEncashment({ requestId: req.id, approve: d.decision === "APPROVE", note: d.note, deciderEmployeeId: viewer.employee?.id ?? null, actorUserId: viewer.user.id });
    if (!r.ok) return { ok: false, message: r.message };
    await writeAudit(viewer, { module: "LEAVE", action: d.decision === "APPROVE" ? "APPROVE" : "REJECT", entityType: "LeaveEncashmentRequest", entityId: req.id, summary: `${d.decision === "APPROVE" ? "Approved" : "Rejected"} ${Number(req.days)} day(s) encashment (₹${Number(req.amount)}) for ${req.employee.displayName}` });
    await notify({ tenantId: viewer.tenantId, userIds: [req.employee.userId], kind: "LEAVE", title: `Leave encashment ${d.decision === "APPROVE" ? "approved" : "rejected"}`, body: d.note ?? r.message, link: "/me/leave" });
    return done([...PATHS, ...(r.runId ? [`/payroll/runs/${r.runId}`] : [])], r.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function cancelEncashmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record." };
  const id = String(formData.get("requestId"));
  if (!(await prisma.leaveEncashmentRequest.count({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Request not found." };
  const r = await cancelEncashment(id, viewer.employee.id);
  return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
}
