import { prisma, Prisma } from "@keka/db";
import { buildLoanSchedule, resolveStructure, type InterestTypeLiteral } from "@keka/payroll";
import { notify, usersWithPermission } from "./lifecycle";
import { postLoanDisbursement, postLoanForeclosure } from "./accounting";
import { compareMonths, firstOpenPayrollMonth } from "./finances-math";

/**
 * Loans from request to closure. The schedule is built by the pure engine;
 * payroll deducts instalments; this keeps the loan's own balance honest after
 * every movement and decides eligibility against the policy.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  maxAmount: number | null;
  maxInstallments: number;
  interestType: InterestTypeLiteral;
  interestRate: number;
  commencementMonths: number;
  policyId: string | null;
}

/** Everything that stands between this employee and this loan. */
export async function checkLoanEligibility(employeeId: string, categoryId: string, amount?: number, installments?: number): Promise<EligibilityResult> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      tenantId: true, status: true, dateOfJoining: true, exitRecord: { select: { status: true } },
      salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } },
    },
  });
  const policy = await prisma.loanPolicy.findFirst({
    where: { tenantId: emp.tenantId, isActive: true, rules: { some: { categoryId } } },
    include: { rules: { where: { categoryId } } },
  });
  const rule = policy?.rules[0];
  const reasons: string[] = [];
  const ctc = Number(emp.salaryRevisions[0]?.annualCtc ?? 0);

  if (!policy || !rule) reasons.push("No loan policy covers this category.");
  if (policy?.requireProbationComplete && emp.status === "PROBATION") reasons.push("Loans open once probation is complete.");
  if (policy?.minDaysFromJoining) {
    const days = Math.floor((Date.now() - emp.dateOfJoining.getTime()) / DAY);
    if (days < policy.minDaysFromJoining) reasons.push(`Loans open ${policy.minDaysFromJoining} days after joining (you are at ${days}).`);
  }
  if (policy?.minAnnualSalary && ctc < Number(policy.minAnnualSalary)) reasons.push("Your salary is below the policy's minimum.");
  if (policy?.maxAnnualSalary && ctc > Number(policy.maxAnnualSalary)) reasons.push("Your salary is above the policy's maximum.");
  if (policy?.blockOnNoticePeriod && (emp.status === "NOTICE_PERIOD" || (emp.exitRecord && ["PENDING_APPROVAL", "APPROVED", "IN_CLEARANCE"].includes(emp.exitRecord.status)))) {
    reasons.push("Loans are not available during the notice period.");
  }
  const open = await prisma.loan.count({ where: { employeeId, categoryId, status: { in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "DISBURSED", "ACTIVE"] } } });
  if (open > 0) reasons.push("You already have an open loan in this category.");

  const capByAmount = rule?.maxAmount ? Number(rule.maxAmount) : null;
  const capBySalary = rule?.maxPercentOfSalary && ctc ? r2(ctc * Number(rule.maxPercentOfSalary) / 100) : null;
  const maxAmount = capByAmount !== null && capBySalary !== null ? Math.min(capByAmount, capBySalary) : capByAmount ?? capBySalary;
  if (amount !== undefined && maxAmount !== null && amount > maxAmount) reasons.push(`The most you can borrow is ₹${maxAmount.toLocaleString("en-IN")}.`);
  const maxInstallments = rule?.maxInstallments ?? 12;
  if (installments !== undefined && installments > maxInstallments) reasons.push(`Repay over at most ${maxInstallments} months.`);

  return {
    eligible: reasons.length === 0, reasons, maxAmount, maxInstallments,
    interestType: (rule?.interestType ?? "NONE") as InterestTypeLiteral,
    interestRate: Number(rule?.interestRate ?? 0),
    commencementMonths: rule?.commencementMonths ?? 1,
    policyId: policy?.id ?? null,
  };
}

/** The month repayment starts: N months after the given date. */
function startFrom(at: Date, commencementMonths: number) {
  const idx = at.getUTCFullYear() * 12 + at.getUTCMonth() + commencementMonths;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/**
 * The first payroll month a new loan can touch for this employee: this month,
 * or the month after their pay group's last locked or finalised run.
 */
export async function openPayrollMonthFor(employeeId: string, today = new Date()): Promise<{ year: number; month: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { payGroupId: true } });
  const last = emp.payGroupId
    ? await prisma.payrollRun.findFirst({
        where: { payGroupId: emp.payGroupId, type: "REGULAR", status: { in: ["LOCKED", "FINALIZED", "PENDING_APPROVAL"] } },
        orderBy: [{ year: "desc" }, { month: "desc" }], select: { year: true, month: true },
      })
    : null;
  return firstOpenPayrollMonth(today, last ? [last] : []);
}

export async function requestLoan(input: {
  employeeId: string; categoryId: string; amount: number; installments: number; purpose?: string | null;
  /** "Expected Month (Payroll Month)" — when the money is wanted. */
  expected?: { year: number; month: number } | null;
  /** "EMI Starts From (Payroll Month)". */
  start?: { year: number; month: number } | null;
}): Promise<{ ok: boolean; message: string; loanId?: string; reasons?: string[] }> {
  const e = await checkLoanEligibility(input.employeeId, input.categoryId, input.amount, input.installments);
  if (!e.eligible) return { ok: false, message: e.reasons.join(" "), reasons: e.reasons };
  const open = await openPayrollMonthFor(input.employeeId);
  if (input.expected && compareMonths(input.expected, open) < 0) {
    return { ok: false, message: `The expected month must be ${open.month}/${open.year} or later — earlier payroll months are closed.` };
  }
  if (input.start && compareMonths(input.start, input.expected ?? open) < 0) {
    return { ok: false, message: "EMIs cannot start before the month the loan is paid out." };
  }
  const start = input.start ?? startFrom(new Date(), e.commencementMonths);
  const preview = buildLoanSchedule({ principal: input.amount, installments: input.installments, interestType: e.interestType, annualRate: e.interestRate, startYear: start.year, startMonth: start.month });
  const loan = await prisma.loan.create({
    data: {
      employeeId: input.employeeId, categoryId: input.categoryId, policyId: e.policyId,
      principal: input.amount, interestType: e.interestType, interestRate: e.interestRate,
      installments: input.installments, emiAmount: preview.emi.toNumber(),
      status: "PENDING_APPROVAL", purpose: input.purpose ?? null, outstanding: input.amount,
      expectedYear: input.expected?.year ?? null, expectedMonth: input.expected?.month ?? null,
      startYear: input.start?.year ?? null, startMonth: input.start?.month ?? null,
    },
    include: { employee: { select: { tenantId: true, displayName: true } }, category: { select: { name: true } } },
  });
  await notify({
    tenantId: loan.employee.tenantId, userIds: await usersWithPermission(loan.employee.tenantId, "payroll.loan.approve"),
    kind: "LOAN", title: `${loan.employee.displayName} requested a ${loan.category.name}`,
    body: `₹${input.amount.toLocaleString("en-IN")} over ${input.installments} months, EMI ₹${preview.emi.toNumber().toLocaleString("en-IN")}.`,
    link: "/payroll/loans",
  });
  return { ok: true, message: `Requested. Your EMI would be ₹${preview.emi.toNumber().toLocaleString("en-IN")} from ${start.month}/${start.year}.`, loanId: loan.id };
}

/** Approve and write the schedule. Disbursal is a separate step. */
export async function approveLoan(loanId: string, byUserId: string, note?: string | null): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { policy: { include: { rules: true } }, employee: { select: { userId: true, tenantId: true } } } });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (!["REQUESTED", "PENDING_APPROVAL"].includes(loan.status)) return { ok: false, message: `This loan is already ${loan.status.toLowerCase()}.` };
  const rule = loan.policy?.rules.find((r) => r.categoryId === loan.categoryId);
  // Keep the month the employee asked EMIs to start in, unless payroll has moved past it.
  const asked = loan.startYear && loan.startMonth ? { year: loan.startYear, month: loan.startMonth } : null;
  const start = asked && compareMonths(asked, await openPayrollMonthFor(loan.employeeId)) >= 0
    ? asked
    : startFrom(new Date(), rule?.commencementMonths ?? 1);
  const s = buildLoanSchedule({ principal: Number(loan.principal), installments: loan.installments, interestType: loan.interestType, annualRate: Number(loan.interestRate), startYear: start.year, startMonth: start.month });
  await prisma.$transaction([
    prisma.loanInstallment.deleteMany({ where: { loanId } }),
    prisma.loanInstallment.createMany({
      data: s.installments.map((i) => ({
        loanId, sequence: i.sequence, year: i.year, month: i.month,
        principalPart: i.principalPart.toNumber(), interestPart: i.interestPart.toNumber(),
        totalAmount: i.totalAmount.toNumber(), balanceAfter: i.balanceAfter.toNumber(),
      })),
    }),
    prisma.loan.update({
      where: { id: loanId },
      data: { status: "APPROVED", approvedAt: new Date(), approvedBy: byUserId, emiAmount: s.emi.toNumber(), startYear: start.year, startMonth: start.month, outstanding: loan.principal, decisionNote: note ?? null },
    }),
  ]);
  await notify({ tenantId: loan.employee.tenantId, userIds: [loan.employee.userId], kind: "LOAN", title: "Your loan was approved", body: `EMI ₹${s.emi.toNumber().toLocaleString("en-IN")} from ${start.month}/${start.year}.`, link: "/finances/loans", email: true });
  return { ok: true, message: `Approved. ${loan.installments} instalments of ₹${s.emi.toNumber().toLocaleString("en-IN")} from ${start.month}/${start.year}; disburse to activate.` };
}

export async function rejectLoan(loanId: string, byUserId: string, note: string): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { employee: { select: { userId: true, tenantId: true } } } });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (!["REQUESTED", "PENDING_APPROVAL"].includes(loan.status)) return { ok: false, message: `This loan is already ${loan.status.toLowerCase()}.` };
  await prisma.loan.update({ where: { id: loanId }, data: { status: "REJECTED", approvedBy: byUserId, approvedAt: new Date(), decisionNote: note } });
  await notify({ tenantId: loan.employee.tenantId, userIds: [loan.employee.userId], kind: "LOAN", title: "Your loan request was declined", body: note, link: "/finances/loans?view=requests" });
  return { ok: true, message: "Rejected." };
}

/** The employee takes back a request nobody has decided yet. */
export async function withdrawLoan(loanId: string, employeeId: string): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, employeeId }, include: { category: { select: { name: true } } } });
  if (!loan) return { ok: false, message: "Loan request not found." };
  if (!["REQUESTED", "PENDING_APPROVAL"].includes(loan.status)) return { ok: false, message: `This request is already ${loan.status.toLowerCase().replace(/_/g, " ")} and cannot be withdrawn.` };
  await prisma.loan.update({ where: { id: loanId }, data: { status: "WITHDRAWN", decisionNote: "Withdrawn by the employee" } });
  return { ok: true, message: `Withdrew your ${loan.category.name} request.` };
}

/** Money paid out. Payroll starts deducting from the first scheduled month. */
export async function disburseLoan(loanId: string, opts: { outsidePayroll?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (loan.status !== "APPROVED") return { ok: false, message: "Only an approved loan can be disbursed." };
  await prisma.loan.update({ where: { id: loanId }, data: { status: "ACTIVE", disbursedAt: new Date(), disbursedOutside: !!opts.outsidePayroll } });
  const ledger = await postLoanDisbursement(loanId);
  return { ok: true, message: `Disbursed. EMIs start in ${loan.startMonth}/${loan.startYear} payroll.${ledger.ok ? "" : ` Not posted to the ledger: ${ledger.message}`}` };
}

/**
 * Recompute a loan's outstanding balance and repaid total from its schedule,
 * and close it once nothing is left to recover. Call after anything moves an
 * instalment: payroll finalise or rollback, a skip, a foreclosure.
 */
export async function syncLoanBalance(loanId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const loan = await tx.loan.findUnique({ where: { id: loanId }, include: { schedule: true } });
  if (!loan) return;
  const paid = loan.schedule.filter((i) => i.status === "DEDUCTED" || i.status === "PREPAID");
  const principalPaid = paid.reduce((s, i) => s + Number(i.principalPart), 0);
  const repaid = paid.reduce((s, i) => s + Number(i.totalAmount), 0);
  const outstanding = r2(Math.max(0, Number(loan.principal) - principalPaid - loan.schedule.filter((i) => i.status === "WAIVED").reduce((s, i) => s + Number(i.principalPart), 0)));
  const remaining = loan.schedule.filter((i) => i.status === "SCHEDULED").length;
  const closing = remaining === 0 && ["ACTIVE", "DISBURSED"].includes(loan.status);
  const reopening = remaining > 0 && loan.status === "CLOSED";
  await tx.loan.update({
    where: { id: loanId },
    data: {
      outstanding, totalRepaid: r2(repaid),
      ...(closing ? { status: "CLOSED", closedAt: new Date() } : {}),
      ...(reopening ? { status: "ACTIVE", closedAt: null } : {}),
    },
  });
}

/** Sync every loan touched by a payroll run. */
export async function syncLoansForRun(runId: string, year: number, month: number, payGroupId: string): Promise<number> {
  const loans = await prisma.loan.findMany({
    where: { employee: { payGroupId }, schedule: { some: { year, month } } }, select: { id: true },
  });
  for (const l of loans) await syncLoanBalance(l.id);
  return loans.length;
}

/** Skip one month's EMI; the schedule extends by a month at the end. */
export async function skipInstallment(loanId: string, year: number, month: number): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { schedule: { orderBy: { sequence: "asc" } } } });
  if (!loan || !["ACTIVE", "DISBURSED"].includes(loan.status)) return { ok: false, message: "Only an active loan's EMI can be skipped." };
  const inst = loan.schedule.find((i) => i.year === year && i.month === month);
  if (!inst || inst.status !== "SCHEDULED") return { ok: false, message: "There is no scheduled EMI for that month." };
  const run = await prisma.payrollRun.findFirst({ where: { year, month, status: { in: ["FINALIZED", "LOCKED"] }, lines: { some: { employeeId: loan.employeeId } } } });
  if (run) return { ok: false, message: "That month's payroll is already finalised." };
  const last = loan.schedule[loan.schedule.length - 1];
  const idx = last.year * 12 + (last.month - 1) + 1;
  await prisma.$transaction([
    prisma.loanInstallment.update({ where: { id: inst.id }, data: { status: "SKIPPED" } }),
    prisma.loanInstallment.create({
      data: {
        loanId, sequence: last.sequence + 1, year: Math.floor(idx / 12), month: (idx % 12) + 1,
        principalPart: inst.principalPart, interestPart: inst.interestPart, totalAmount: inst.totalAmount, balanceAfter: 0,
      },
    }),
  ]);
  await syncLoanBalance(loanId);
  return { ok: true, message: `Skipped ${month}/${year}. The loan now ends in ${(idx % 12) + 1}/${Math.floor(idx / 12)}.` };
}

/** Repay the rest at once, outside payroll. Future interest is not charged. */
export async function forecloseLoan(loanId: string): Promise<{ ok: boolean; message: string; amount?: number }> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { schedule: true } });
  if (!loan || !["ACTIVE", "DISBURSED"].includes(loan.status)) return { ok: false, message: "Only an active loan can be foreclosed." };
  const pending = loan.schedule.filter((i) => i.status === "SCHEDULED");
  const amount = r2(pending.reduce((s, i) => s + Number(i.principalPart), 0));
  await prisma.$transaction([
    ...pending.map((i) => prisma.loanInstallment.update({ where: { id: i.id }, data: { status: "PREPAID", interestPart: 0, totalAmount: i.principalPart, deductedAt: new Date() } })),
    prisma.loan.update({ where: { id: loanId }, data: { status: "FORECLOSED", closedAt: new Date() } }),
  ]);
  await syncLoanBalance(loanId);
  await postLoanForeclosure(loanId, amount);
  return { ok: true, message: `Foreclosed: ₹${amount.toLocaleString("en-IN")} outstanding principal settled; no further interest.`, amount };
}

/** Monthly salary the eligibility screen shows against the salary cap. */
export async function monthlyGrossOf(employeeId: string): Promise<number> {
  const rev = await prisma.salaryRevision.findFirst({
    where: { employeeId, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" },
    include: { structure: { include: { components: { include: { component: true } } } } },
  });
  if (!rev?.structure) return 0;
  const r = resolveStructure({
    annualCtc: Number(rev.annualCtc),
    components: rev.structure.components.filter((c) => c.isActive).map((sc) => ({
      code: sc.component.code, name: sc.component.name, type: sc.component.type, calculationType: sc.calculationType,
      formula: sc.formula, fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
      percentage: sc.percentage === null ? null : Number(sc.percentage), percentageOf: sc.percentageOf, sequence: sc.sequence,
      isOutsideCtc: sc.component.isOutsideCtc, isLopApplicable: sc.component.isLopApplicable,
      affectsPfWage: sc.component.affectsPfWage, affectsEsiGross: sc.component.affectsEsiGross,
      showOnPayslip: sc.component.showOnPayslip, isPartOfFbp: sc.component.isPartOfFbp,
    })),
  });
  return Number(r.monthlyGross);
}
