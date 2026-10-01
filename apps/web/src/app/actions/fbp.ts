"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee } from "@keka/rbac";
import { notify, reopenFbpDeclaration, saveFbpDeclaration } from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/**
 * Flexible benefit plan: the employee's own declaration (only ever their
 * own; no id from the form selects whose), and payroll reopening a locked one.
 */

export async function saveFbpDeclarationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "This login is not linked to an employee record." };
  const amounts: Record<string, number | null> = {};
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("amount:") || typeof v !== "string") continue;
    const t = v.replace(/,/g, "").trim();
    const num = t === "" ? null : Number(t);
    if (num !== null && Number.isNaN(num)) return { ok: false, message: "Enter amounts as numbers.", errors: { [k]: "Enter a number" } };
    amounts[k.slice(7)] = num;
  }
  const res = await saveFbpDeclaration(viewer.employee.id, amounts);
  if (!res.ok) return { ok: false, message: res.message, errors: res.field ? { [`amount:${res.field}`]: res.message } : undefined };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "FbpDeclaration", entityId: viewer.employee.id, summary: res.message });
  return done(["/finances/pay/fbp", "/finances/pay/component-claims", "/payroll/fbp"], res.message);
}

export async function reopenFbpDeclarationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const id = String(formData.get("id") ?? "");
  const d = await prisma.fbpDeclaration.findFirst({
    where: { id, employee: { tenantId: viewer.tenantId } },
    select: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!d || !canAccessEmployee(viewer, d.employee, P.PAYROLL_RUN)) return { ok: false, message: "That declaration was not found." };
  const res = await reopenFbpDeclaration(viewer.tenantId, id);
  if (!res.ok) return { ok: false, message: res.message };
  if (res.employeeUserId) {
    await notify({ tenantId: viewer.tenantId, userIds: [res.employeeUserId], kind: "PAYROLL", title: "Your flexible benefit declaration is open to change", link: "/finances/pay/fbp" });
  }
  await writeAudit(viewer, { module: "PAYROLL", action: "UNLOCK", entityType: "FbpDeclaration", entityId: id, summary: res.message });
  return done(["/payroll/fbp", "/finances/pay/fbp"], res.message);
}
