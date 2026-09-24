"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { calculateRun, createRun } from "@keka/services";

const P = PERMISSIONS;

async function audit(opts: {
  tenantId: string; actorId: string; actorLabel: string;
  action: "CREATE" | "UPDATE" | "LOCK" | "UNLOCK" | "APPROVE" | "DELETE";
  entityId: string; summary: string;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: opts.tenantId,
      module: "PAYROLL",
      action: opts.action,
      entityType: "PayrollRun",
      entityId: opts.entityId,
      actorId: opts.actorId,
      actorLabel: opts.actorLabel,
      summary: opts.summary,
    },
  });
}

export async function startPayrollRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const payGroupId = String(formData.get("payGroupId"));
  const year = Number(formData.get("year"));
  const month = Number(formData.get("month"));

  const payGroup = await prisma.payGroup.findFirst({
    where: { id: payGroupId, tenantId: viewer.tenantId },
  });
  if (!payGroup) throw new Error("Pay group not found");

  const runId = await createRun({ tenantId: viewer.tenantId, payGroupId, year, month });
  await calculateRun(runId);

  await audit({
    tenantId: viewer.tenantId,
    actorId: viewer.user.id,
    actorLabel: viewer.user.email,
    action: "CREATE",
    entityId: runId,
    summary: `Started payroll for ${formatPeriod(year, month)} — ${payGroup.name}`,
  });

  redirect(`/payroll/runs/${runId}`);
}

export async function recalculateRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run) throw new Error("Payroll run not found");
  if (run.status === "FINALIZED") {
    throw new Error("Finalised payroll cannot be recalculated. Roll it back first.");
  }

  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

export async function setRunStep(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const step = Math.min(6, Math.max(1, Number(formData.get("step"))));

  await prisma.payrollRun.updateMany({
    where: { id: runId, tenantId: viewer.tenantId, status: { not: "FINALIZED" } },
    data: { currentStep: step },
  });
  revalidatePath(`/payroll/runs/${runId}`);
}

/** Step 2 and 3: set the pay action for one employee. */
export async function setPayAction(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const employeeId = String(formData.get("employeeId"));
  const payAction = String(formData.get("payAction")) as
    "PROCESS_AS_SALARY" | "HOLD_SALARY_PROCESSING" | "VOID_SALARY_PROCESSING"
    | "HOLD_PAYOUT" | "VOID_PAYOUT" | "ALREADY_PAID";
  const comment = String(formData.get("comment") ?? "") || null;

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  await prisma.payrollRunEmployee.update({
    where: { runId_employeeId: { runId, employeeId } },
    data: { payAction, comment },
  });

  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

/** Step 1: manual LOP adjustment. */
export async function setLopAdjustment(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const employeeId = String(formData.get("employeeId"));
  const days = Number(formData.get("days") ?? 0);
  const note = String(formData.get("note") ?? "") || null;

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  // One manual adjustment row per employee per period — replace rather than
  // stack, so repeated edits do not compound.
  await prisma.lopAdjustment.deleteMany({
    where: { tenantId: viewer.tenantId, employeeId, year: run.year, month: run.month },
  });
  if (days !== 0) {
    await prisma.lopAdjustment.create({
      data: {
        tenantId: viewer.tenantId, employeeId,
        year: run.year, month: run.month,
        days, note, runId, createdBy: viewer.user.id,
      },
    });
  }

  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

/** Step 4: ad-hoc payment or deduction. */
export async function addAdhoc(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const employeeId = String(formData.get("employeeId"));
  const type = String(formData.get("type")) as "PAYMENT" | "DEDUCTION";
  const name = String(formData.get("name") ?? "").trim();
  const amount = Number(formData.get("amount") ?? 0);
  const taxable = formData.get("taxable") === "on";

  if (!name || amount <= 0) throw new Error("Enter a description and a positive amount");

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  await prisma.adhocTransaction.create({
    data: {
      employeeId, type, name, amount,
      taxTreatment: taxable ? "TAXABLE" : "NON_TAXABLE",
      year: run.year, month: run.month, runId,
      createdBy: viewer.user.id,
    },
  });

  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

export async function deleteAdhoc(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const id = String(formData.get("id"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  await prisma.adhocTransaction.delete({ where: { id } });
  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

/** Step 6: override a statutory figure. */
export async function setStatutoryOverride(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const employeeId = String(formData.get("employeeId"));
  const field = String(formData.get("field")) as "pt" | "esi" | "tds" | "lwf";
  const raw = String(formData.get("value") ?? "").trim();
  const note = String(formData.get("note") ?? "") || null;

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  const value = raw === "" ? null : Number(raw);
  const column = {
    pt: "ptOverride", esi: "esiOverride", tds: "tdsOverride", lwf: "lwfOverride",
  }[field];

  await prisma.payrollRunEmployee.update({
    where: { runId_employeeId: { runId, employeeId } },
    data: { [column]: value, overrideNote: note },
  });

  await calculateRun(runId);
  revalidatePath(`/payroll/runs/${runId}`);
}

/**
 * Lock the run. With maker-checker enabled this raises an approval request
 * instead, and the button reads "Lock & Send for Approval".
 */
export async function lockRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
    include: { payGroup: { include: { approvalRules: { where: { action: "LOCK_PAYROLL", isActive: true } } } } },
  });
  if (!run) throw new Error("Payroll run not found");
  if (run.status === "FINALIZED" || run.status === "LOCKED") return;

  const needsApproval = run.payGroup.approvalWorkflowEnabled &&
    run.payGroup.approvalRules.length > 0;

  if (needsApproval) {
    await prisma.payrollApprovalRequest.create({
      data: {
        runId,
        action: "LOCK_PAYROLL",
        status: "PENDING",
        currentLevel: 0,
        requestedBy: viewer.user.id,
      },
    });
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { status: "PENDING_APPROVAL" },
    });
    await audit({
      tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
      action: "UPDATE", entityId: runId,
      summary: `Sent ${formatPeriod(run.year, run.month)} payroll for lock approval`,
    });
  } else {
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { status: "LOCKED", lockedAt: new Date(), lockedBy: viewer.user.id },
    });
    await audit({
      tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
      action: "LOCK", entityId: runId,
      summary: `Locked ${formatPeriod(run.year, run.month)} payroll`,
    });
  }

  revalidatePath(`/payroll/runs/${runId}`);
}

export async function withdrawApproval(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId, status: "PENDING_APPROVAL" },
  });
  if (!run) return;

  // The initiator can withdraw before the approver acts.
  await prisma.payrollApprovalRequest.updateMany({
    where: { runId, status: "PENDING" },
    data: { status: "WITHDRAWN", resolvedAt: new Date() },
  });
  await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "IN_PROGRESS" },
  });
  revalidatePath(`/payroll/runs/${runId}`);
}

export async function approveLock(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_APPROVE);
  const runId = String(formData.get("runId"));
  const decision = String(formData.get("decision"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId, status: "PENDING_APPROVAL" },
  });
  if (!run) throw new Error("No pending approval for this run");

  if (decision === "approve") {
    await prisma.payrollApprovalRequest.updateMany({
      where: { runId, status: "PENDING" },
      data: { status: "APPROVED", resolvedAt: new Date() },
    });
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { status: "LOCKED", lockedAt: new Date(), lockedBy: viewer.user.id },
    });
    await audit({
      tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
      action: "APPROVE", entityId: runId,
      summary: `Approved and locked ${formatPeriod(run.year, run.month)} payroll`,
    });
  } else {
    await prisma.payrollApprovalRequest.updateMany({
      where: { runId, status: "PENDING" },
      data: { status: "REJECTED", resolvedAt: new Date() },
    });
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS" } });
  }

  revalidatePath(`/payroll/runs/${runId}`);
}

/** Finalise: close the month and generate payslips. */
export async function finalizeRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
    include: { lines: true },
  });
  if (!run) throw new Error("Payroll run not found");
  if (run.status !== "LOCKED") {
    throw new Error("Lock the payroll before finalising it.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: "FINALIZED", finalizedAt: new Date(), finalizedBy: viewer.user.id },
    });

    // Generate a payslip per processed employee. Held and voided rows do not
    // get one.
    for (const line of run.lines) {
      if (line.payAction === "VOID_SALARY_PROCESSING" || line.payAction === "HOLD_SALARY_PROCESSING") {
        continue;
      }
      await tx.payslip.upsert({
        where: {
          runId_employeeId_isSegregated: { runId, employeeId: line.employeeId, isSegregated: false },
        },
        create: {
          runId, employeeId: line.employeeId,
          year: run.year, month: run.month,
          status: "GENERATED",
          netPay: line.netPay,
          isPasswordProtected: true,
        },
        update: { status: "GENERATED", netPay: line.netPay },
      });
    }

    // Mark the inputs consumed so they are not picked up again next month.
    await tx.arrear.updateMany({
      where: { paidInRunId: null, employee: { payGroupId: run.payGroupId } , isProcessed: false },
      data: { isProcessed: true, paidInRunId: runId },
    });
    await tx.adhocTransaction.updateMany({
      where: { year: run.year, month: run.month, runId, isProcessed: false },
      data: { isProcessed: true },
    });
    await tx.loanInstallment.updateMany({
      where: {
        year: run.year, month: run.month, status: "SCHEDULED",
        loan: { employee: { payGroupId: run.payGroupId } },
      },
      data: { status: "DEDUCTED", runId, deductedAt: new Date() },
    });
    await tx.componentClaim.updateMany({
      where: { payoutYear: run.year, payoutMonth: run.month, status: "APPROVED" },
      data: { status: "PAID", runId },
    });
  }, { timeout: 60_000 });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "LOCK", entityId: runId,
    summary: `Finalised ${formatPeriod(run.year, run.month)} payroll — ${run.lines.length} employees`,
  });

  revalidatePath(`/payroll/runs/${runId}`);
}

export async function releasePayslips(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYSLIP_RELEASE);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId, status: "FINALIZED" },
  });
  if (!run) throw new Error("Only a finalised run can have payslips released");

  await prisma.payslip.updateMany({
    where: { runId, status: { in: ["GENERATED", "NOT_GENERATED"] } },
    data: { status: "RELEASED", releasedAt: new Date(), releasedBy: viewer.user.id },
  });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "UPDATE", entityId: runId,
    summary: `Released payslips for ${formatPeriod(run.year, run.month)}`,
  });

  revalidatePath(`/payroll/runs/${runId}`);
}

/**
 * Roll back a finalised run. Payslips are removed and consumed inputs are
 * released so the month can be re-run.
 */
export async function rollbackRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_ROLLBACK);
  const runId = String(formData.get("runId"));
  const reason = String(formData.get("reason") ?? "").trim();

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run) throw new Error("Payroll run not found");

  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId } });
    await tx.arrear.updateMany({
      where: { paidInRunId: runId },
      data: { isProcessed: false, paidInRunId: null },
    });
    await tx.adhocTransaction.updateMany({ where: { runId }, data: { isProcessed: false } });
    await tx.loanInstallment.updateMany({
      where: { runId }, data: { status: "SCHEDULED", runId: null, deductedAt: null },
    });
    await tx.componentClaim.updateMany({
      where: { runId, status: "PAID" }, data: { status: "APPROVED", runId: null },
    });
    // Journal vouchers are never deleted after export, only archived.
    await tx.journalVoucher.updateMany({
      where: { runId }, data: { status: "ARCHIVED" },
    });
    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        status: "IN_PROGRESS",
        rolledBackAt: new Date(),
        rollbackReason: reason || "No reason given",
        lockedAt: null, lockedBy: null, finalizedAt: null, finalizedBy: null,
      },
    });
  }, { timeout: 60_000 });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "UNLOCK", entityId: runId,
    summary: `Rolled back ${formatPeriod(run.year, run.month)} payroll — ${reason || "no reason given"}`,
  });

  revalidatePath(`/payroll/runs/${runId}`);
}
