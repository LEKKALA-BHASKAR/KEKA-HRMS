"use server";

import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { safeRevalidate } from "@/lib/forms";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { calculateRun, createRun, decideApproval, finalizePayrollRun, openApproval, releasePayslipsForRun, rollbackPayrollRun, withdrawApprovalRequest } from "@keka/services";

const P = PERMISSIONS;

/** An employee id from a run form must be someone this run actually pays. */
async function inRun(runId: string, employeeId: string): Promise<boolean> {
  return (await prisma.payrollRunEmployee.count({ where: { runId, employeeId } })) > 0;
}

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
  safeRevalidate(`/payroll/runs/${runId}`);
}

export async function setRunStep(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const step = Math.min(6, Math.max(1, Number(formData.get("step"))));

  await prisma.payrollRun.updateMany({
    where: { id: runId, tenantId: viewer.tenantId, status: { not: "FINALIZED" } },
    data: { currentStep: step },
  });
  safeRevalidate(`/payroll/runs/${runId}`);
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
  safeRevalidate(`/payroll/runs/${runId}`);
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
  if (!(await inRun(runId, employeeId))) throw new Error("That employee is not in this run");

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
  safeRevalidate(`/payroll/runs/${runId}`);
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
  if (!(await inRun(runId, employeeId))) throw new Error("That employee is not in this run");

  await prisma.adhocTransaction.create({
    data: {
      employeeId, type, name, amount,
      taxTreatment: taxable ? "TAXABLE" : "NON_TAXABLE",
      year: run.year, month: run.month, runId,
      createdBy: viewer.user.id,
    },
  });

  await calculateRun(runId);
  safeRevalidate(`/payroll/runs/${runId}`);
}

export async function deleteAdhoc(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId"));
  const id = String(formData.get("id"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
  });
  if (!run || run.status === "FINALIZED") throw new Error("This run can no longer be edited");

  // Only this run's own manual rows: reimbursements and recoveries placed by
  // expenses and advances are withdrawn at their source, not here.
  const removed = await prisma.adhocTransaction.deleteMany({ where: { id, runId, sourceType: null, employee: { tenantId: viewer.tenantId } } });
  if (removed.count === 0) throw new Error("That entry is not a manual entry on this run");
  await calculateRun(runId);
  safeRevalidate(`/payroll/runs/${runId}`);
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
  safeRevalidate(`/payroll/runs/${runId}`);
}

/**
 * Lock the run. With maker-checker enabled this raises an approval request
 * that climbs the pay group's lock-approval chain, and the button reads
 * "Lock & Send for Approval".
 */
export async function lockRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId } });
  if (!run) throw new Error("Payroll run not found");
  if (run.status === "FINALIZED" || run.status === "LOCKED" || run.status === "PENDING_APPROVAL") return;

  const approval = await openApproval({
    tenantId: viewer.tenantId, payGroupId: run.payGroupId, action: "LOCK_PAYROLL", requestedBy: viewer.user.id, runId,
    summary: `Lock ${formatPeriod(run.year, run.month)} payroll`, link: `/payroll/runs/${runId}`,
  });
  if (approval.required && approval.status === "PENDING") {
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "PENDING_APPROVAL" } });
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

  safeRevalidate(`/payroll/runs/${runId}`);
}

export async function withdrawApproval(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId, status: "PENDING_APPROVAL" },
  });
  if (!run) return;
  const req = await prisma.payrollApprovalRequest.findFirst({ where: { runId, status: "PENDING" } });
  if (req) {
    const res = await withdrawApprovalRequest(viewer.tenantId, req.id, viewer.user.id);
    if (!res.ok) throw new Error(res.message);
  }
  await prisma.payrollRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS" } });
  safeRevalidate(`/payroll/runs/${runId}`);
}

export async function approveLock(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_APPROVE);
  const runId = String(formData.get("runId"));
  const decision = String(formData.get("decision"));

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId, status: "PENDING_APPROVAL" },
  });
  if (!run) throw new Error("No pending approval for this run");
  const req = await prisma.payrollApprovalRequest.findFirst({ where: { runId, status: "PENDING" } });
  if (!req) throw new Error("No pending approval for this run");

  const res = await decideApproval({
    tenantId: viewer.tenantId, requestId: req.id, userId: viewer.user.id, approve: decision === "approve",
    comment: String(formData.get("comment") ?? "") || (decision === "approve" ? null : "Rejected from the payroll run"), link: `/payroll/runs/${runId}`,
  });
  if (!res.ok) throw new Error(res.message);
  await applyLockOutcome(runId, res.outcome, viewer.user.id);
  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "APPROVE", entityId: runId,
    summary: `${res.outcome === "REJECTED" ? "Rejected" : "Approved"} the lock of ${formatPeriod(run.year, run.month)} payroll${res.outcome === "ADVANCED" ? " (next level)" : ""}`,
  });
  safeRevalidate(`/payroll/runs/${runId}`);
}

/** What a lock decision does to the run. */
async function applyLockOutcome(runId: string, outcome: "ADVANCED" | "APPROVED" | "REJECTED", byUserId: string): Promise<void> {
  if (outcome === "APPROVED") {
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: byUserId } });
  } else if (outcome === "REJECTED") {
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS" } });
  }
}

/** Finalise: close the month and generate payslips. */
export async function finalizeRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId"));
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId }, include: { _count: { select: { lines: true } } } });
  if (!run) throw new Error("Payroll run not found");
  const res = await finalizePayrollRun(runId, viewer.user.id);
  if (!res.ok) throw new Error(res.message);

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "LOCK", entityId: runId,
    summary: `Finalised ${formatPeriod(run.year, run.month)} payroll — ${run._count.lines} employees`,
  });

  safeRevalidate(`/payroll/runs/${runId}`);
}

export async function releasePayslips(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYSLIP_RELEASE);
  const runId = String(formData.get("runId"));
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId } });
  if (!run) throw new Error("Payroll run not found");
  const res = await releasePayslipsForRun(runId, viewer.user.id);
  if (!res.ok) throw new Error(res.message);

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "UPDATE", entityId: runId,
    summary: `Released payslips for ${formatPeriod(run.year, run.month)}`,
  });

  safeRevalidate(`/payroll/runs/${runId}`);
}

/**
 * Roll back a finalised run. Payslips are removed and consumed inputs are
 * released so the month can be re-run.
 */
export async function rollbackRun(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_ROLLBACK);
  const runId = String(formData.get("runId"));
  const reason = String(formData.get("reason") ?? "").trim();
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId } });
  if (!run) throw new Error("Payroll run not found");
  const res = await rollbackPayrollRun(runId, reason);
  if (!res.ok) throw new Error(res.message);

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    action: "UNLOCK", entityId: runId,
    summary: `Rolled back ${formatPeriod(run.year, run.month)} payroll — ${reason || "no reason given"}`,
  });

  safeRevalidate(`/payroll/runs/${runId}`);
}
