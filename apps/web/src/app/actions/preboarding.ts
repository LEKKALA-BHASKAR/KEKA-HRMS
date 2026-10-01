"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee, type Permission } from "@keka/rbac";
import { markJoined, markNoShow, initiateBgv, updateBgv, usersWithPermission, type BgvStatus } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { saveFile, sniffUpload } from "@/lib/storage";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/** Preboarding (mark joined / did not join) and background checks. */

async function target(viewer: Awaited<ReturnType<typeof requireAuth>>, employeeId: string, perm: Permission) {
  const t = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  return t && canAccessEmployee(viewer, t, perm) ? t : null;
}

export async function markJoinedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const t = await target(viewer, String(formData.get("employeeId") ?? ""), P.ONBOARDING_MANAGE);
  if (!t) return { ok: false, message: "That employee is outside your scope." };
  const on = new Date(`${String(formData.get("joinedOn") ?? "")}T00:00:00Z`);
  if (Number.isNaN(on.getTime())) return { ok: false, message: "Pick the joining date." };
  const res = await markJoined({ tenantId: viewer.tenantId, employeeId: t.id, joinedOn: on });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "Employee", entityId: t.id, summary: res.message });
  return done(["/onboarding/preboarding", "/employees"], res.message);
}

export async function markNoShowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const t = await target(viewer, String(formData.get("employeeId") ?? ""), P.ONBOARDING_MANAGE);
  if (!t) return { ok: false, message: "That employee is outside your scope." };
  const res = await markNoShow({ tenantId: viewer.tenantId, employeeId: t.id, reason: String(formData.get("reason") ?? "") });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "Employee", entityId: t.id, summary: res.message });
  return done(["/onboarding/preboarding", "/employees"], res.message);
}

export async function initiateBgvAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const t = await target(viewer, String(formData.get("employeeId") ?? ""), P.BGV_MANAGE);
  if (!t) return { ok: false, message: "Pick an employee in your scope.", errors: { employeeId: "Required" } };
  const res = await initiateBgv({ tenantId: viewer.tenantId, employeeId: t.id, vendor: String(formData.get("vendor") ?? ""), checks: formData.getAll("checks").map(String) });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "BgvCheck", entityId: res.id, summary: res.message });
  return done(["/onboarding/preboarding"], res.message);
}

export async function updateBgvAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const id = String(formData.get("id") ?? "");
  const row = await prisma.bgvCheck.findFirst({ where: { id, tenantId: viewer.tenantId }, select: { id: true, employeeId: true } });
  if (!row?.employeeId || !(await target(viewer, row.employeeId, P.BGV_MANAGE))) return { ok: false, message: "Background check not found." };
  let reportUrl: string | null = null;
  const file = formData.get("report");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok) return { ok: false, message: sniff.reason };
    const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name || "bgv-report.pdf", mimeType: sniff.mimeType, data, relatedType: "BgvReport", employeeId: row.employeeId, uploadedBy: viewer.user.id });
    reportUrl = `/files/${stored.id}`;
  }
  const hr = await usersWithPermission(viewer.tenantId, P.BGV_MANAGE);
  const res = await updateBgv({
    tenantId: viewer.tenantId, id: row.id, status: String(formData.get("status") ?? "") as BgvStatus,
    findings: String(formData.get("findings") ?? "") || null, reportUrl, notifyUserIds: hr.filter((u) => u !== viewer.user.id),
  });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheck", entityId: row.id, summary: res.message });
  return done(["/onboarding/preboarding"], res.message);
}
