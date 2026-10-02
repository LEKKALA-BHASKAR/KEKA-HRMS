import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { sectionName } from "./declarations";

/**
 * Reviewing investment proofs. A reviewer accepts a line (in full or for a
 * lower amount) or rejects it with a reason; what they accept is what the
 * tax projection counts from then on (see effectiveAmount). The declaration's
 * approved total and status follow its lines.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
type Result = { ok: boolean; message: string };

export async function reviewProof(opts: {
  itemId: string; tenantId: string; approve: boolean; approvedAmount?: number | null; remark?: string | null;
  reviewerUserId: string; reviewerEmployeeId?: string | null;
}): Promise<Result> {
  const item = await prisma.declarationItem.findFirst({
    where: { id: opts.itemId, declaration: { employee: { tenantId: opts.tenantId } } },
    include: { declaration: { include: { employee: { select: { id: true, userId: true, displayName: true } } } } },
  });
  if (!item) return { ok: false, message: "That proof was not found." };
  if (item.declaration.employeeId === opts.reviewerEmployeeId) return { ok: false, message: "You cannot review your own proofs." };
  if (item.proofStatus !== "SUBMITTED") return { ok: false, message: item.proofStatus === "NOT_SUBMITTED" ? "No proof has been uploaded for this line." : `Already ${item.proofStatus.toLowerCase()}.` };
  const declared = Number(item.declaredAmount);
  const remark = opts.remark?.trim() || null;
  let approved = 0;
  if (opts.approve) {
    approved = r2(opts.approvedAmount ?? declared);
    if (!(approved > 0)) return { ok: false, message: "Enter the amount the proof supports, or reject it." };
    if (approved > declared + 0.001) return { ok: false, message: `You can accept at most the ₹${declared.toLocaleString("en-IN")} declared.` };
    if (approved < declared - 0.001 && !remark) return { ok: false, message: "Say why less than the declared amount is accepted." };
  } else if (!remark) {
    return { ok: false, message: "Give the employee a reason, so they can upload the right proof." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.declarationItem.update({
      where: { id: item.id },
      data: { proofStatus: opts.approve ? "APPROVED" : "REJECTED", approvedAmount: approved, proofRemark: remark, reviewedBy: opts.reviewerUserId, reviewedAt: new Date() },
    });
    const items = await tx.declarationItem.findMany({ where: { declarationId: item.declarationId } });
    const approvedTotal = r2(items.reduce((s, i) => s + (i.proofStatus === "APPROVED" ? Number(i.approvedAmount) : 0), 0));
    const reviewed = items.filter((i) => i.proofStatus === "APPROVED" || i.proofStatus === "REJECTED");
    const anyApproved = items.some((i) => i.proofStatus === "APPROVED");
    const status = reviewed.length === items.length
      ? (anyApproved ? (items.every((i) => i.proofStatus === "APPROVED" && Number(i.approvedAmount) >= Number(i.declaredAmount) - 0.001) ? "APPROVED" : "PARTIALLY_APPROVED") : "REJECTED")
      : anyApproved ? "PARTIALLY_APPROVED" : item.declaration.status;
    await tx.investmentDeclaration.update({
      where: { id: item.declarationId },
      data: { approvedTotal, status, ...(status === "APPROVED" ? { approvedAt: new Date(), approvedBy: opts.reviewerUserId } : {}) },
    });
  });

  const what = `${sectionName(item.section)} — ${item.category}`;
  await notify({
    tenantId: opts.tenantId, userIds: [item.declaration.employee.userId], kind: "PAYROLL",
    title: opts.approve
      ? `Proof accepted: ${what}${approved < declared ? ` (₹${approved.toLocaleString("en-IN")} of ₹${declared.toLocaleString("en-IN")})` : ""}`
      : `Proof rejected: ${what}`,
    body: remark, link: "/finances/tax", email: !opts.approve,
  });
  return { ok: true, message: opts.approve ? `Accepted ₹${approved.toLocaleString("en-IN")} for ${item.declaration.employee.displayName}.` : `Rejected; ${item.declaration.employee.displayName} has been told why.` };
}
