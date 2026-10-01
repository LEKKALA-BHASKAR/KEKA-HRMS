"use server";

import { prisma } from "@keka/db";
import { applySalaryRevision, decideApproval, withdrawApprovalRequest } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/**
 * Deciding payroll approval requests from the approvals queue. The chain
 * itself (who may act at which level) is enforced by the service; this
 * applies the outcome: lock or reopen the run, apply or reject the salary
 * change.
 */

async function applyOutcome(r: { action: string; outcome: string; runId: string | null; revisionId?: string }, byUserId: string) {
  if (r.action === "LOCK_PAYROLL" && r.runId) {
    if (r.outcome === "APPROVED") await prisma.payrollRun.update({ where: { id: r.runId }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: byUserId } });
    if (r.outcome === "REJECTED" || r.outcome === "WITHDRAWN") await prisma.payrollRun.update({ where: { id: r.runId }, data: { status: "IN_PROGRESS" } });
  }
  if (r.action === "COMPENSATION_CHANGE" && r.revisionId) {
    if (r.outcome === "APPROVED") return prisma.$transaction((tx) => applySalaryRevision(r.revisionId!, tx));
    if (r.outcome === "REJECTED" || r.outcome === "WITHDRAWN") await prisma.salaryRevision.update({ where: { id: r.revisionId }, data: { status: "REJECTED" } });
  }
  return null;
}

export async function decideApprovalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const res = await decideApproval({ tenantId: viewer.tenantId, requestId, userId: viewer.user.id, approve, comment: String(formData.get("comment") ?? "") || null, link: "/payroll/approvals" });
  if (!res.ok) return { ok: false, message: res.message };
  const applied = await applyOutcome(res, viewer.user.id);
  const message = res.outcome === "APPROVED"
    ? `${res.message} ${res.action === "LOCK_PAYROLL" ? "The payroll is locked." : `The salary change is applied${applied?.arrears ? " and arrears were raised for the closed months" : ""}.`}`
    : res.message;
  await writeAudit(viewer, {
    module: "PAYROLL", action: approve ? "APPROVE" : "REJECT", entityType: res.action === "LOCK_PAYROLL" ? "PayrollRun" : "SalaryRevision",
    entityId: res.runId ?? res.revisionId, summary: `${approve ? "Approved" : "Rejected"} a ${res.action === "LOCK_PAYROLL" ? "payroll lock" : "salary change"}: ${message}`,
  });
  return done(["/payroll/approvals", "/payroll/runs", ...(res.runId ? [`/payroll/runs/${res.runId}`] : [])], message);
}

export async function withdrawApprovalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // Only the requester can withdraw; the service checks that.
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId") ?? "");
  const res = await withdrawApprovalRequest(viewer.tenantId, requestId, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await applyOutcome({ action: res.action!, outcome: "WITHDRAWN", runId: res.runId ?? null, revisionId: res.revisionId }, viewer.user.id);
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "PayrollApprovalRequest", entityId: requestId, summary: "Withdrew an approval request" });
  return done(["/payroll/approvals", "/payroll/runs"], res.message);
}
