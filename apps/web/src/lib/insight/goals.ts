import "server-only";
import { prisma } from "@keka/db";
import { startWorkflow } from "@keka/services";
import type { Viewer } from "@/lib/context";

/**
 * Goal approval (OKR settings › "Goals need approval"). When on, a goal an
 * employee sets for themselves goes to their reporting manager, and a
 * company, department or team goal goes to a goal administrator, before it
 * is live. A manager setting a report's goal needs no further approval.
 */
export async function goalNeedsApproval(viewer: Viewer, goal: { level: string; employeeId: string | null }): Promise<boolean> {
  const s = await prisma.insightOkrSetting.findUnique({ where: { tenantId: viewer.tenantId } });
  if (!s?.requireApproval) return false;
  if (goal.level === "INDIVIDUAL") return !!goal.employeeId && goal.employeeId === viewer.employee?.id;
  return true;
}

/** Put a goal into approval: it waits as a draft until decided. Returns the message to show. */
export async function submitGoalForApproval(viewer: Viewer, goalId: string): Promise<{ ok: boolean; message: string }> {
  const g = await prisma.goal.findFirst({ where: { id: goalId, tenantId: viewer.tenantId } });
  if (!g) return { ok: false, message: "Goal not found." };
  if (g.approvalStatus === "PENDING") return { ok: false, message: "This goal is already waiting for approval." };
  await prisma.goal.update({ where: { id: g.id }, data: { status: "DRAFT", approvalStatus: "PENDING" } });
  const wf = await startWorkflow({
    tenantId: viewer.tenantId, entityType: "GOAL_APPROVAL", entityId: g.id, title: `Approve ${g.level.toLowerCase()} goal “${g.title.slice(0, 120)}”`,
    details: g.description, requesterUserId: viewer.user.id, subjectEmployeeId: g.employeeId ?? viewer.employee?.id ?? null,
    changeKind: g.level === "INDIVIDUAL" ? "INDIVIDUAL" : "ORG", data: { link: "/performance/okr?tab=approvals" },
  });
  if (!wf.ok) { await prisma.goal.update({ where: { id: g.id }, data: { approvalStatus: null } }); return { ok: false, message: `Saved as a draft, but the approval could not start: ${wf.message}` }; }
  await prisma.goal.updateMany({ where: { id: g.id, approvalStatus: "PENDING" }, data: { approvalRequestId: wf.requestId ?? null } });
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "UPDATE", entityType: "Goal", entityId: g.id, summary: `Goal “${g.title.slice(0, 80)}” submitted for approval`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  const after = await prisma.goal.findUniqueOrThrow({ where: { id: g.id }, select: { approvalStatus: true } });
  return { ok: true, message: after.approvalStatus === "APPROVED" ? "Goal approved and live." : "Goal saved and sent for approval; it goes live once approved." };
}
