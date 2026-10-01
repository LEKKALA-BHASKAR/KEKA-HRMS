import { prisma } from "@keka/db";
import { syncLoansForRun } from "./loans";
import { settlePayrollSources } from "./expenses";
import { postPayrollRun, reversePayrollPostings } from "./accounting";

/**
 * Closing a payroll month: finalise (payslips plus consuming the month's
 * inputs), release, and roll back. Shared by the UI, the seed and tests so
 * there is exactly one definition of what "finalised" means.
 *
 * Every consumption is scoped to the employees actually processed in this
 * run — never to a month across the tenant, and never across tenants.
 */

const SKIPPED = new Set(["VOID_SALARY_PROCESSING", "HOLD_SALARY_PROCESSING"]);

export async function finalizePayrollRun(runId: string, actorUserId: string): Promise<{ ok: boolean; message: string; payslips?: number }> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, include: { lines: true } });
  if (!run) return { ok: false, message: "Payroll run not found." };
  if (run.status !== "LOCKED") return { ok: false, message: "Lock the payroll before finalising it." };
  const processed = run.lines.filter((l) => !SKIPPED.has(l.payAction));
  const ids = processed.map((l) => l.employeeId);

  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "FINALIZED", finalizedAt: new Date(), finalizedBy: actorUserId } });

    // A payslip per processed employee. Held and voided rows get none.
    for (const line of processed) {
      await tx.payslip.upsert({
        where: { runId_employeeId_isSegregated: { runId, employeeId: line.employeeId, isSegregated: false } },
        create: { runId, employeeId: line.employeeId, year: run.year, month: run.month, status: "GENERATED", netPay: line.netPay, isPasswordProtected: true },
        update: { status: "GENERATED", netPay: line.netPay },
      });
    }

    // Consume this month's inputs for exactly these people.
    await tx.arrear.updateMany({
      where: { employeeId: { in: ids }, isProcessed: false, paidInRunId: null },
      data: { isProcessed: true, paidInRunId: runId },
    });
    // Mirror exactly what calculateRun selected for these people this month.
    await tx.adhocTransaction.updateMany({
      where: { employeeId: { in: ids }, year: run.year, month: run.month, isPaidOutside: false, isProcessed: false },
      data: { isProcessed: true, runId },
    });
    await tx.employeeBonus.updateMany({
      where: { employeeId: { in: ids }, payoutYear: run.year, payoutMonth: run.month, isProcessed: false, payAction: { in: ["PAY", "PARTIALLY_PAY"] } },
      data: { isProcessed: true, runId },
    });
    // Only what the calculation deducted: active loans of processed people.
    await tx.loanInstallment.updateMany({
      where: { year: run.year, month: run.month, status: "SCHEDULED", loan: { status: { in: ["ACTIVE", "DISBURSED"] }, employeeId: { in: ids } } },
      data: { status: "DEDUCTED", runId, deductedAt: new Date() },
    });
    await tx.componentClaim.updateMany({
      where: { employeeId: { in: ids }, payoutYear: run.year, payoutMonth: run.month, status: "APPROVED" },
      data: { status: "PAID", runId },
    });
  }, { timeout: 60_000 });

  await syncLoansForRun(runId, run.year, run.month, run.payGroupId);
  // Reimbursements and advance recoveries ride on ad-hoc items; settle them too.
  await settlePayrollSources(runId, true);
  // The month reaches the books as one accrual. A ledger problem (a closed
  // period, say) does not undo a finalised payroll; it is reported instead.
  const ledger = await postPayrollRun(runId, actorUserId);
  return { ok: true, message: `Finalised: ${processed.length} payslip(s) generated.${ledger.ok ? ` ${ledger.message}` : ` Not posted to the ledger: ${ledger.message}`}`, payslips: processed.length };
}

export async function releasePayslipsForRun(runId: string, actorUserId: string): Promise<{ ok: boolean; message: string }> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "FINALIZED") return { ok: false, message: "Only a finalised run can have payslips released." };
  const r = await prisma.payslip.updateMany({
    where: { runId, status: { in: ["GENERATED", "NOT_GENERATED"] } },
    data: { status: "RELEASED", releasedAt: new Date(), releasedBy: actorUserId },
  });
  return { ok: true, message: `Released ${r.count} payslip(s).` };
}

export async function rollbackPayrollRun(runId: string, reason: string): Promise<{ ok: boolean; message: string }> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run) return { ok: false, message: "Payroll run not found." };
  // Rolling back an earlier month under a later finalised one would corrupt
  // the later month's year-to-date figures.
  const later = await prisma.payrollRun.findFirst({
    where: { payGroupId: run.payGroupId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: { gt: run.year } }, { year: run.year, month: { gt: run.month } }] },
  });
  if (later) return { ok: false, message: `Roll back ${later.month}/${later.year} first — it was finalised on top of this month.` };

  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId } });
    await tx.arrear.updateMany({ where: { paidInRunId: runId }, data: { isProcessed: false, paidInRunId: null } });
    await tx.adhocTransaction.updateMany({ where: { runId }, data: { isProcessed: false } });
    await tx.employeeBonus.updateMany({ where: { runId }, data: { isProcessed: false, runId: null } });
    await tx.loanInstallment.updateMany({ where: { runId }, data: { status: "SCHEDULED", runId: null, deductedAt: null } });
    await tx.componentClaim.updateMany({ where: { runId, status: "PAID" }, data: { status: "APPROVED", runId: null } });
    // Journal vouchers are never deleted after export, only archived.
    await tx.journalVoucher.updateMany({ where: { runId }, data: { status: "ARCHIVED" } });
    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: "IN_PROGRESS", rolledBackAt: new Date(), rollbackReason: reason || "No reason given", lockedAt: null, lockedBy: null, finalizedAt: null, finalizedBy: null },
    });
  }, { timeout: 60_000 });

  await syncLoansForRun(runId, run.year, run.month, run.payGroupId);
  await settlePayrollSources(runId, false);
  const reversed = await reversePayrollPostings(runId, reason || "No reason given");
  return { ok: true, message: `Rolled back. Inputs are released and the month can be re-run.${reversed.length ? ` Ledger: ${reversed.join(" ")}` : ""}` };
}
