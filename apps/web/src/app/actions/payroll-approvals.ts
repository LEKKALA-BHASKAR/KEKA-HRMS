"use server";

import { prisma } from "@keka/db";
import { applySalaryRevision, decideApproval, withdrawApprovalRequest, settleJobChangeApproval } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/**
 * Deciding payroll approval requests from the approvals queue. The chain
 * itself (who may act at which level) is enforced by the service; this
 * applies the outcome: lock or reopen the run, apply or reject the salary
 * change.
 */

async function applyOutcome(r: { action: string; outcome: string; runId: string | null; revisionId?: string; jobChangeId?: string }, byUserId: string) {
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

/** Job changes settle separately: applied now, scheduled for their date, or closed. */
async function settleJobChange(r: { action: string; outcome: string; jobChangeId?: string }) {
  if (r.action !== "JOB_CHANGE" || !r.jobChangeId) return null;
  return settleJobChangeApproval(r.jobChangeId, r.outcome as "APPROVED" | "REJECTED" | "WITHDRAWN" | "ADVANCED");
}

const KIND_NOUN: Record<string, string> = { LOCK_PAYROLL: "payroll lock", COMPENSATION_CHANGE: "salary change", JOB_CHANGE: "job change" };

export async function decideApprovalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const res = await decideApproval({ tenantId: viewer.tenantId, requestId, userId: viewer.user.id, approve, comment: String(formData.get("comment") ?? "") || null, link: "/payroll/approvals" });
  if (!res.ok) return { ok: false, message: res.message };
  const applied = await applyOutcome(res, viewer.user.id);
  const job = await settleJobChange(res);
  const message = res.outcome !== "APPROVED" ? res.message
    : res.action === "LOCK_PAYROLL" ? `${res.message} The payroll is locked.`
    : res.action === "JOB_CHANGE"
      ? `${res.message} ${job?.status === "SCHEDULED" ? "The job change will be applied on its effective date." : "The job change is applied."}`
      : `${res.message} The salary change is applied${applied?.arrears ? " and arrears were raised for the closed months" : ""}.`;
  await writeAudit(viewer, {
    module: res.action === "JOB_CHANGE" ? "EMPLOYEE" : "PAYROLL", action: approve ? "APPROVE" : "REJECT",
    entityType: res.action === "LOCK_PAYROLL" ? "PayrollRun" : res.action === "JOB_CHANGE" ? "JobChange" : "SalaryRevision",
    entityId: res.runId ?? res.revisionId ?? res.jobChangeId, summary: `${approve ? "Approved" : "Rejected"} a ${KIND_NOUN[res.action]}: ${message}`,
  });
  return done(["/payroll/approvals", "/payroll/runs", "/inbox", "/employees", ...(res.runId ? [`/payroll/runs/${res.runId}`] : [])], message);
}

export async function withdrawApprovalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // Only the requester can withdraw; the service checks that.
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId") ?? "");
  const res = await withdrawApprovalRequest(viewer.tenantId, requestId, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await applyOutcome({ action: res.action!, outcome: "WITHDRAWN", runId: res.runId ?? null, revisionId: res.revisionId }, viewer.user.id);
  await settleJobChange({ action: res.action!, outcome: "WITHDRAWN", jobChangeId: res.jobChangeId });
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "PayrollApprovalRequest", entityId: requestId, summary: "Withdrew an approval request" });
  return done(["/payroll/approvals", "/payroll/runs"], res.message);
}
