"use server";

import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { reviewProof } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { actionDone, parseForm, writeAudit, z, zId, zNumber, zOptional, type ActionState } from "@/lib/forms";

/**
 * Payroll's side of investment proofs: accept a submitted proof, in full or
 * for what it actually supports, or send it back with a reason. Reviewers
 * only see and act on employees inside their payroll scope, never their own.
 */

const schema = z.object({
  itemId: zId(),
  decision: z.enum(["approve", "reject"]),
  approvedAmount: zNumber({ min: 0 }),
  remark: zOptional(),
});

export async function reviewProofAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(PERMISSIONS.TAX_DECLARATION_APPROVE);
  const parsed = parseForm(schema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data!;
  const item = await prisma.declarationItem.findFirst({
    where: { id: d.itemId, declaration: { employee: { tenantId: viewer.tenantId } } },
    select: { section: true, category: true, declaration: { select: { employee: { select: { id: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } } },
  });
  if (!item) return { ok: false, message: "That proof was not found." };
  if (!canAccessEmployee(viewer, item.declaration.employee, PERMISSIONS.TAX_DECLARATION_APPROVE)) forbidden();

  const res = await reviewProof({
    itemId: d.itemId, tenantId: viewer.tenantId, approve: d.decision === "approve",
    approvedAmount: d.approvedAmount ?? null, remark: d.remark ?? null,
    reviewerUserId: viewer.userId, reviewerEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, {
    module: "PAYROLL", action: d.decision === "approve" ? "APPROVE" : "REJECT", entityType: "DeclarationItem", entityId: d.itemId,
    summary: `${d.decision === "approve" ? "Accepted" : "Rejected"} ${item.section} proof (${item.category}) for ${item.declaration.employee.displayName ?? "employee"}`,
  });
  return actionDone(["/payroll/tax-proofs", "/finances/tax"], res.message);
}
