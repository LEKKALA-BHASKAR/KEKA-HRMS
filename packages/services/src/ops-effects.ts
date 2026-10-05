import { prisma } from "@keka/db";
import type { StepSpec } from "./governance-math";
import { OPS_CONFIG_KINDS, isOpsConfigKind, type OpsWorkflowType } from "./ops-math";
import { applyConfigChange } from "./ops-core";
import { applyAttendanceCertDecision, applyBreakExceptionDecision } from "./ops-attendance";
import { applyTimeCorrectionDecision, applyTimeCertDecision, applyTaskSignoffDecision } from "./ops-time";
import { applyLeaveCancellationDecision, applyBalanceAdjustmentDecision, applyAbsenceDecision } from "./ops-leave";
import { applyPayslipReleaseDecision, applyStatutorySignoffDecision } from "./ops-payroll";
import { applyHrEventDecision, applyAssignmentDecision, applyFteDecision } from "./ops-lifecycle";

/**
 * Ops depth on the generic workflow engine: the built-in route for each
 * OPS_* entity type (used when the tenant has not configured a definition in
 * Admin › Workflows) and the effect of each outcome on its OpsApprovalRequest.
 */

const MANAGER: StepSpec = { order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" };
const perm = (name: string, permission: string, order = 1): StepSpec => ({ order, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS" });

export function opsBuiltInRoute(entityType: OpsWorkflowType, opts: { reviewerUserId?: string | null; changeKind?: string | null } = {}): StepSpec[] {
  switch (entityType) {
    case "OPS_CONFIG_CHANGE": {
      const k = opts.changeKind && isOpsConfigKind(opts.changeKind) ? OPS_CONFIG_KINDS[opts.changeKind] : null;
      return [perm(k ? `${k.label} administrator` : "Configuration administrator", k?.permission ?? "admin.workflow.manage")];
    }
    case "OPS_LEAVE_ADJUSTMENT": return [perm("Leave administrator", "time.leave.manage")];
    case "OPS_LEAVE_CANCELLATION": return [MANAGER];
    case "OPS_ABSENCE": return [MANAGER, perm("Leave administrator", "time.leave.manage", 2)];
    case "OPS_ATTENDANCE_CERT": return [perm("Payroll administrator", "payroll.run.execute")];
    case "OPS_BREAK_EXCEPTION":
    case "OPS_TIME_CORRECTION": return [MANAGER];
    case "OPS_TIME_CERT": return [perm("Project administrator", "psa.project.manage")];
    case "OPS_TASK_SIGNOFF": return opts.reviewerUserId
      ? [{ order: 1, name: "Project manager", approverType: "USER", approverUserId: opts.reviewerUserId, mode: "ANY", slaHours: 72, escalateTo: "ADMINS" }]
      : [perm("Project administrator", "psa.project.manage")];
    case "OPS_PAYSLIP_RELEASE":
    case "OPS_STATUTORY_SIGNOFF": return [perm("Payroll approver", "payroll.run.approve")];
    case "OPS_HR_EVENT": return [perm("HR administrator", "lifecycle.activity.manage")];
    case "OPS_ASSIGNMENT": return [MANAGER, perm("HR administrator", "employee.record.update", 2)];
    case "OPS_FTE_CHANGE": return [perm("Compensation approver", "payroll.salary.revise")];
  }
}

/** Run the outcome on its request. A failing effect marks the request FAILED and rethrows, so the workflow shows ERROR and can be retried. */
export async function applyOpsEffect(req: { tenantId: string; entityType: string; entityId: string | null }, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  if (!req.entityId) return;
  const a = await prisma.opsApprovalRequest.findFirst({ where: { id: req.entityId, tenantId: req.tenantId } });
  if (!a || !["PENDING", "FAILED"].includes(a.status)) return;
  if (outcome !== "APPROVED") {
    await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN", decidedAt: new Date() } });
    await dispatch(a, outcome, actorUserId);
    return;
  }
  try {
    await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { decidedAt: new Date() } });
    if (a.kind === "OPS_CONFIG_CHANGE") { await applyConfigChange(a.id, actorUserId); return; }
    await dispatch(a, outcome, actorUserId);
    await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { status: "APPLIED", appliedAt: new Date(), error: null } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { status: "FAILED", error: msg.slice(0, 500) } });
    throw err;
  }
}

async function dispatch(a: Awaited<ReturnType<typeof prisma.opsApprovalRequest.findFirstOrThrow>>, outcome: string, actorUserId: string | null): Promise<void> {
  switch (a.kind) {
    case "OPS_CONFIG_CHANGE": return;
    case "OPS_LEAVE_ADJUSTMENT": return applyBalanceAdjustmentDecision(a, outcome, actorUserId);
    case "OPS_LEAVE_CANCELLATION": return applyLeaveCancellationDecision(a, outcome, actorUserId);
    case "OPS_ABSENCE": return applyAbsenceDecision(a, outcome);
    case "OPS_ATTENDANCE_CERT": return applyAttendanceCertDecision(a, outcome, actorUserId);
    case "OPS_BREAK_EXCEPTION": return applyBreakExceptionDecision(a, outcome);
    case "OPS_TIME_CORRECTION": return applyTimeCorrectionDecision(a, outcome, actorUserId);
    case "OPS_TIME_CERT": return applyTimeCertDecision(a, outcome);
    case "OPS_TASK_SIGNOFF": return applyTaskSignoffDecision(a, outcome, actorUserId);
    case "OPS_PAYSLIP_RELEASE": return applyPayslipReleaseDecision(a, outcome, actorUserId);
    case "OPS_STATUTORY_SIGNOFF": return applyStatutorySignoffDecision(a, outcome, actorUserId);
    case "OPS_HR_EVENT": return applyHrEventDecision(a, outcome, actorUserId);
    case "OPS_ASSIGNMENT": return applyAssignmentDecision(a, outcome);
    case "OPS_FTE_CHANGE": return applyFteDecision(a, outcome, actorUserId);
    default: return;
  }
}
