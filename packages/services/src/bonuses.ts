import { prisma } from "@keka/db";
import { formatPeriod } from "@keka/shared";

/**
 * Bonuses and reimbursement claims as payroll inputs.
 *
 * A bonus is scheduled for a payout month and the regular run for that month
 * picks it up (see calculateRun). In step 3 of the run payroll decides what
 * happens to each one: pay it, pay part of it, hold it for a later month, pay
 * it outside payroll, or void it. A held bonus keeps showing up in each later
 * run until someone pays or voids it.
 *
 * Reimbursement claims are decided in step 4: approved claims are paid in
 * that run, for the amount the reviewer accepts.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** The regular run for an employee's pay group and month, if already finalised. */
async function finalisedRun(employeeId: string, year: number, month: number) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { payGroupId: true } });
  if (!emp?.payGroupId) return null;
  return prisma.payrollRun.findFirst({ where: { payGroupId: emp.payGroupId, year, month, type: "REGULAR", status: "FINALIZED" }, select: { id: true } });
}

export async function scheduleBonus(input: {
  tenantId: string; employeeId: string; bonusTypeId: string; amount: number; payoutYear: number; payoutMonth: number; note?: string | null;
}): Promise<Result & { id?: string }> {
  const [emp, type] = await Promise.all([
    prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { status: true, displayName: true, dateOfJoining: true } }),
    prisma.bonusType.findFirst({ where: { id: input.bonusTypeId, tenantId: input.tenantId } }),
  ]);
  if (!emp) return { ok: false, message: "That employee was not found." };
  if (emp.status === "EXITED") return { ok: false, message: `${emp.displayName} has left; pay a bonus through their full and final settlement.` };
  if (!type || !type.isActive) return { ok: false, message: "Choose an active bonus type." };
  if (!(input.amount > 0)) return { ok: false, message: "The bonus amount must be more than zero." };
  if (input.payoutMonth < 1 || input.payoutMonth > 12) return { ok: false, message: "Choose a payout month." };
  if (await finalisedRun(input.employeeId, input.payoutYear, input.payoutMonth)) {
    return { ok: false, message: `Payroll for ${formatPeriod(input.payoutYear, input.payoutMonth)} is already finalised. Schedule it for a later month.` };
  }
  const b = await prisma.employeeBonus.create({
    data: { employeeId: input.employeeId, bonusTypeId: type.id, amount: r2(input.amount), payoutYear: input.payoutYear, payoutMonth: input.payoutMonth, note: input.note ?? null },
  });
  return { ok: true, id: b.id, message: `${type.name} of ${rupees(r2(input.amount))} scheduled for ${emp.displayName} in ${formatPeriod(input.payoutYear, input.payoutMonth)}.` };
}

export async function removeBonus(tenantId: string, bonusId: string): Promise<Result> {
  const b = await prisma.employeeBonus.findFirst({ where: { id: bonusId, employee: { tenantId } } });
  if (!b) return { ok: false, message: "That bonus was not found." };
  if (b.isProcessed) return { ok: false, message: "This bonus has already been paid." };
  await prisma.employeeBonus.delete({ where: { id: b.id } });
  return { ok: true, message: "Bonus removed." };
}

export type BonusDecision = "PAY" | "PARTIALLY_PAY" | "ON_HOLD" | "PAY_OUTSIDE_PAYROLL" | "VOID";

/**
 * Step 3: decide a bonus within an open run. Paying (in full or part) moves a
 * bonus held from an earlier month into this run's month.
 */
export async function decideBonus(input: { runId: string; tenantId: string; bonusId: string; action: BonusDecision; paidAmount?: number | null; note?: string | null }): Promise<Result> {
  const run = await prisma.payrollRun.findFirst({ where: { id: input.runId, tenantId: input.tenantId } });
  if (!run || run.status === "FINALIZED") return { ok: false, message: "This run can no longer be edited." };
  const b = await prisma.employeeBonus.findFirst({ where: { id: input.bonusId, employee: { tenantId: input.tenantId } }, include: { bonusType: true } });
  if (!b) return { ok: false, message: "That bonus was not found." };
  if (b.isProcessed) return { ok: false, message: "This bonus has already been paid." };
  const inRun = await prisma.payrollRunEmployee.count({ where: { runId: run.id, employeeId: b.employeeId } });
  if (!inRun) return { ok: false, message: "That employee is not in this run." };
  const due = b.payoutYear * 12 + b.payoutMonth, now = run.year * 12 + run.month;
  if (due > now) return { ok: false, message: "This bonus is scheduled for a later month." };
  if (due < now && b.payAction !== "ON_HOLD") return { ok: false, message: "Only a held bonus can be brought into a later run." };

  const amount = Number(b.amount);
  let paidAmount: number | null = null;
  if (input.action === "PARTIALLY_PAY") {
    paidAmount = r2(input.paidAmount ?? 0);
    if (!(paidAmount > 0) || paidAmount >= amount) return { ok: false, message: `A partial payment must be more than zero and less than ${rupees(amount)}.` };
  }
  const intoThisRun = input.action === "PAY" || input.action === "PARTIALLY_PAY";
  await prisma.employeeBonus.update({
    where: { id: b.id },
    data: {
      payAction: input.action, paidAmount,
      ...(intoThisRun ? { payoutYear: run.year, payoutMonth: run.month } : {}),
      // Paid outside payroll is settled now; it never reaches a run.
      ...(input.action === "PAY_OUTSIDE_PAYROLL" ? { isProcessed: true } : {}),
      ...(input.note ? { note: input.note } : {}),
    },
  });
  const label: Record<BonusDecision, string> = {
    PAY: "will be paid in this run", PARTIALLY_PAY: `will be part-paid (${rupees(paidAmount ?? 0)})`, ON_HOLD: "is on hold for a later month",
    PAY_OUTSIDE_PAYROLL: "is marked paid outside payroll", VOID: "is void",
  };
  return { ok: true, message: `${b.bonusType.name} ${label[input.action]}.` };
}

/** Bonuses step 3 of a run shows: due this month, plus any held from before. */
export function bonusesForRun(run: { year: number; month: number }, employeeIds: string[]) {
  return prisma.employeeBonus.findMany({
    where: {
      employeeId: { in: employeeIds },
      OR: [
        { payoutYear: run.year, payoutMonth: run.month },
        { payAction: "ON_HOLD", isProcessed: false, OR: [{ payoutYear: { lt: run.year } }, { payoutYear: run.year, payoutMonth: { lt: run.month } }] },
      ],
    },
    include: { bonusType: { select: { name: true, isTaxable: true } }, employee: { select: { displayName: true, employeeNumber: true } } },
    orderBy: [{ payoutYear: "asc" }, { payoutMonth: "asc" }],
  });
}

/** Step 4: approve (for the claimed amount or less) or reject a component claim, paying it in this run. */
export async function decideComponentClaim(input: {
  runId: string; tenantId: string; claimId: string; approve: boolean; payableAmount?: number | null; note?: string | null; reviewerUserId: string;
}): Promise<Result & { employeeUserId?: string | null }> {
  const run = await prisma.payrollRun.findFirst({ where: { id: input.runId, tenantId: input.tenantId } });
  if (!run || run.status === "FINALIZED") return { ok: false, message: "This run can no longer be edited." };
  const c = await prisma.componentClaim.findFirst({ where: { id: input.claimId, employee: { tenantId: input.tenantId } }, include: { component: true, employee: { select: { userId: true } } } });
  if (!c) return { ok: false, message: "That claim was not found." };
  if (c.status === "DRAFT") return { ok: false, message: "This claim has not been submitted yet." };
  if (c.status === "PAID" || c.status === "REJECTED") return { ok: false, message: `This claim is already ${c.status.toLowerCase()}.` };
  if (c.status === "APPROVED" && (c.payoutYear !== run.year || c.payoutMonth !== run.month)) return { ok: false, message: "This claim is being paid in another month." };
  if (!(await prisma.payrollRunEmployee.count({ where: { runId: run.id, employeeId: c.employeeId } }))) return { ok: false, message: "That employee is not in this run." };
  const claimed = Number(c.claimedAmount);
  const note = input.note?.trim() || null;
  if (!input.approve) {
    if (!note) return { ok: false, message: "Give a reason for rejecting the claim." };
    await prisma.componentClaim.update({ where: { id: c.id }, data: { status: "REJECTED", payableAmount: 0, payoutYear: null, payoutMonth: null, reviewerNote: note, reviewedBy: input.reviewerUserId, reviewedAt: new Date() } });
    return { ok: true, employeeUserId: c.employee.userId, message: `${c.component.name} claim rejected.` };
  }
  const payable = r2(input.payableAmount ?? claimed);
  if (!(payable > 0) || payable > claimed + 0.001) return { ok: false, message: `The payable amount must be more than zero and at most the ${rupees(claimed)} claimed.` };
  if (payable < claimed - 0.001 && !note) return { ok: false, message: "Say why less than the claimed amount is paid." };
  await prisma.componentClaim.update({
    where: { id: c.id },
    data: { status: "APPROVED", payableAmount: payable, payoutYear: run.year, payoutMonth: run.month, reviewerNote: note, reviewedBy: input.reviewerUserId, reviewedAt: new Date() },
  });
  return { ok: true, employeeUserId: c.employee.userId, message: `${c.component.name} claim approved for ${rupees(payable)}, paid in ${formatPeriod(run.year, run.month)}.` };
}
