import { prisma } from "@keka/db";
import { calculateAnnualTax } from "@keka/payroll";
import { formatPeriod, fyStartYear } from "@keka/shared";
import { ageAtFyEnd, loadStatutoryTables, slabsFor } from "./payroll-run";
import { postPayrollRun, reversePayrollPostings } from "./accounting";

/**
 * Off-cycle payroll: paying a few people something outside the monthly run
 * (a bonus, a correction, a one-off payment) once that month's regular
 * payroll is finalised. An off-cycle run carries only what is added to it:
 * ad-hoc payments and deductions, and bonuses pulled in from the schedule.
 * No salary components and no PF, ESI, PT or LWF apply; income tax is the
 * extra tax the payment adds to the employee's year, deducted in full.
 *
 * Its gross and TDS count towards year-to-date figures in later months.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function openRun(runId: string, tenantId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId, type: "OFF_CYCLE" } });
  if (!run) return { error: "Off-cycle payroll not found." } as const;
  if (run.status === "FINALIZED") return { error: "This off-cycle payroll is finalised." } as const;
  return { run } as const;
}

export async function startOffCycleRun(input: { tenantId: string; baseRunId: string; employeeIds: string[]; reason: string; payDate?: Date | null }): Promise<Result & { runId?: string }> {
  const base = await prisma.payrollRun.findFirst({ where: { id: input.baseRunId, tenantId: input.tenantId }, include: { payGroup: { select: { name: true } } } });
  if (!base || base.type !== "REGULAR") return { ok: false, message: "Choose a regular payroll month to run off-cycle against." };
  if (base.status !== "FINALIZED") return { ok: false, message: "Finalise that month's regular payroll first; until then, add the payment to it instead." };
  const ids = [...new Set(input.employeeIds)];
  if (ids.length === 0) return { ok: false, message: "Choose at least one employee." };
  const inBase = await prisma.payrollRunEmployee.findMany({ where: { runId: base.id, employeeId: { in: ids } }, select: { employeeId: true, totalDays: true } });
  if (inBase.length !== ids.length) return { ok: false, message: "Everyone in an off-cycle payroll must have been in that month's regular payroll." };
  if (!input.reason.trim()) return { ok: false, message: "Say what the off-cycle payroll is for." };
  const last = await prisma.payrollRun.findFirst({ where: { payGroupId: base.payGroupId, year: base.year, month: base.month, type: "OFF_CYCLE" }, orderBy: { sequence: "desc" } });
  const run = await prisma.payrollRun.create({
    data: {
      tenantId: input.tenantId, payGroupId: base.payGroupId, year: base.year, month: base.month,
      periodStart: base.periodStart, periodEnd: base.periodEnd, payDate: input.payDate ?? new Date(),
      type: "OFF_CYCLE", baseRunId: base.id, sequence: (last?.sequence ?? 0) + 1, status: "DRAFT", currentStep: 1,
      stepState: { reason: input.reason.trim() }, employeeCount: ids.length,
      lines: { create: inBase.map((e) => ({ employeeId: e.employeeId, totalDays: e.totalDays, payAction: "PROCESS_AS_SALARY" as const })) },
    },
  });
  return { ok: true, runId: run.id, message: `Started off-cycle payroll ${run.sequence} for ${formatPeriod(base.year, base.month)} (${base.payGroup.name}) with ${ids.length} employee(s).` };
}

export async function addOffCycleItem(input: { runId: string; tenantId: string; employeeId: string; type: "PAYMENT" | "DEDUCTION"; name: string; amount: number; taxable: boolean; byUserId: string }): Promise<Result> {
  const o = await openRun(input.runId, input.tenantId);
  if ("error" in o) return { ok: false, message: o.error! };
  if (!(await prisma.payrollRunEmployee.count({ where: { runId: input.runId, employeeId: input.employeeId } }))) return { ok: false, message: "That employee is not in this off-cycle payroll." };
  if (!input.name.trim() || !(input.amount > 0)) return { ok: false, message: "Enter a description and an amount above zero." };
  await prisma.adhocTransaction.create({
    data: {
      employeeId: input.employeeId, type: input.type, name: input.name.trim(), amount: r2(input.amount), taxTreatment: input.taxable ? "TAXABLE" : "NON_TAXABLE",
      year: o.run.year, month: o.run.month, runId: o.run.id, createdBy: input.byUserId,
    },
  });
  await calculateOffCycleRun(o.run.id);
  return { ok: true, message: `Added ${input.name.trim()} of ${rupees(r2(input.amount))}.` };
}

export async function removeOffCycleItem(input: { runId: string; tenantId: string; itemId: string }): Promise<Result> {
  const o = await openRun(input.runId, input.tenantId);
  if ("error" in o) return { ok: false, message: o.error! };
  const removed = await prisma.adhocTransaction.deleteMany({ where: { id: input.itemId, runId: o.run.id } });
  if (!removed.count) return { ok: false, message: "That item is not on this off-cycle payroll." };
  await calculateOffCycleRun(o.run.id);
  return { ok: true, message: "Removed." };
}

/** Bring a scheduled or held bonus into this off-cycle payroll, or send it back. */
export async function toggleOffCycleBonus(input: { runId: string; tenantId: string; bonusId: string; include: boolean }): Promise<Result> {
  const o = await openRun(input.runId, input.tenantId);
  if ("error" in o) return { ok: false, message: o.error! };
  const b = await prisma.employeeBonus.findFirst({ where: { id: input.bonusId, employee: { tenantId: input.tenantId } }, include: { bonusType: true } });
  if (!b || b.isProcessed || b.payAction === "VOID") return { ok: false, message: "That bonus cannot be paid." };
  if (!(await prisma.payrollRunEmployee.count({ where: { runId: o.run.id, employeeId: b.employeeId } }))) return { ok: false, message: "That employee is not in this off-cycle payroll." };
  if (input.include) {
    if (b.runId && b.runId !== o.run.id) return { ok: false, message: "That bonus is already on another payroll." };
    await prisma.employeeBonus.update({ where: { id: b.id }, data: { runId: o.run.id, payAction: b.payAction === "PARTIALLY_PAY" ? "PARTIALLY_PAY" : "PAY" } });
  } else {
    if (b.runId !== o.run.id) return { ok: false, message: "That bonus is not on this payroll." };
    await prisma.employeeBonus.update({ where: { id: b.id }, data: { runId: null } });
  }
  await calculateOffCycleRun(o.run.id);
  return { ok: true, message: input.include ? `${b.bonusType.name} added.` : `${b.bonusType.name} sent back to the schedule.` };
}

/**
 * Work out each person's off-cycle pay: what was added, less the extra
 * income tax it causes for the year (on their current annual salary, under
 * their regime), less any deductions.
 */
export async function calculateOffCycleRun(runId: string): Promise<{ employeeCount: number; totalGross: number; totalNet: number }> {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { payGroup: true, lines: true } });
  if (run.type !== "OFF_CYCLE") throw new Error("Not an off-cycle payroll.");
  if (run.status === "FINALIZED") throw new Error("This off-cycle payroll is finalised.");
  const ids = run.lines.map((l) => l.employeeId);
  const fy = fyStartYear(run.periodEnd, 4);
  const [tables, adhoc, bonuses, employees] = await Promise.all([
    loadStatutoryTables(run.payGroupId, fy, run.periodEnd),
    prisma.adhocTransaction.findMany({ where: { runId, employeeId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    prisma.employeeBonus.findMany({ where: { runId, employeeId: { in: ids } }, include: { bonusType: true } }),
    prisma.employee.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, dateOfBirth: true, statutoryProfile: { select: { taxRegime: true, tdsDisabled: true } },
        salaryRevisions: { where: { status: "APPLIED", effectiveFrom: { lte: run.periodEnd } }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } },
      },
    }),
  ]);
  let totalGross = 0, totalNet = 0, totalDed = 0;
  await prisma.$transaction(async (tx) => {
    for (const line of run.lines) {
      const emp = employees.find((e) => e.id === line.employeeId)!;
      const pays = adhoc.filter((a) => a.employeeId === emp.id && a.type === "PAYMENT");
      const deds = adhoc.filter((a) => a.employeeId === emp.id && a.type === "DEDUCTION");
      const bons = bonuses.filter((b) => b.employeeId === emp.id);
      const out: Array<{ code: string; name: string; type: "EARNING" | "REIMBURSEMENT" | "DEDUCTION"; amount: number; sequence: number }> = [];
      bons.forEach((b, i) => out.push({ code: `BONUS_${i + 1}`, name: b.bonusType.name, type: b.bonusType.isTaxable ? "EARNING" : "REIMBURSEMENT", amount: Number(b.paidAmount ?? b.amount), sequence: 900 + i }));
      pays.forEach((a, i) => out.push({ code: `ADHOC_PAY_${i + 1}`, name: a.name, type: a.taxTreatment === "NON_TAXABLE" ? "REIMBURSEMENT" : "EARNING", amount: Number(a.amount), sequence: 910 + i }));
      const gross = r2(out.reduce((s, l) => s + l.amount, 0));
      const taxableExtra = r2(out.filter((l) => l.type === "EARNING").reduce((s, l) => s + l.amount, 0));
      let tds = 0;
      const regime = emp.statutoryProfile?.taxRegime ?? "NEW";
      if (taxableExtra > 0 && run.payGroup.tdsEnabled && !emp.statutoryProfile?.tdsDisabled) {
        const base = Number(emp.salaryRevisions[0]?.annualCtc ?? 0);
        const slabs = slabsFor(tables.taxSlabBands.get(regime), ageAtFyEnd(emp.dateOfBirth, fy));
        const config = tables.taxConfigs.get(regime)!;
        const tax = (gross: number) => Number(calculateAnnualTax({ regime, grossSalary: gross, slabs, config }).totalTaxLiability);
        tds = Math.max(0, Math.round(tax(base + taxableExtra) - tax(base)));
        out.push({ code: "TDS", name: "Income Tax (TDS)", type: "DEDUCTION", amount: tds, sequence: 1000 });
      }
      deds.forEach((a, i) => out.push({ code: `ADHOC_DED_${i + 1}`, name: a.name, type: "DEDUCTION", amount: Number(a.amount), sequence: 1010 + i }));
      const deductions = r2(out.filter((l) => l.type === "DEDUCTION").reduce((s, l) => s + l.amount, 0));
      const net = r2(gross - deductions);
      await tx.payslipLine.deleteMany({ where: { runEmployeeId: line.id } });
      await tx.payrollRunEmployee.update({
        where: { id: line.id },
        data: {
          grossEarnings: gross, totalDeductions: deductions, netPay: net, tds, employerCost: 0, payableDays: 0, lopDays: 0,
          pfWage: 0, pfEmployee: 0, pfEmployer: 0, epsEmployer: 0, vpf: 0, esiGross: 0, esiEmployee: 0, esiEmployer: 0, professionalTax: 0, lwfEmployee: 0, lwfEmployer: 0,
          errors: net < 0 ? ["Deductions exceed the payment."] : undefined, calculatedAt: new Date(),
        },
      });
      if (out.length) await tx.payslipLine.createMany({ data: out.map((l) => ({ runEmployeeId: line.id, code: l.code, name: l.name, type: l.type, fullAmount: l.amount, amount: l.amount, sequence: l.sequence })) });
      totalGross += gross; totalNet += net; totalDed += deductions;
    }
    await tx.payrollRun.update({
      where: { id: runId },
      data: { employeeCount: run.lines.length, totalGross: r2(totalGross), totalNetPay: r2(totalNet), totalDeductions: r2(totalDed), totalEmployerCost: 0, status: run.status === "DRAFT" ? "IN_PROGRESS" : run.status },
    });
  });
  return { employeeCount: run.lines.length, totalGross: r2(totalGross), totalNet: r2(totalNet) };
}

export async function finalizeOffCycleRun(runId: string, tenantId: string, actorUserId: string): Promise<Result> {
  const o = await openRun(runId, tenantId);
  if ("error" in o) return { ok: false, message: o.error! };
  await calculateOffCycleRun(runId);
  const lines = await prisma.payrollRunEmployee.findMany({ where: { runId } });
  const paying = lines.filter((l) => Number(l.grossEarnings) > 0);
  if (paying.length === 0) return { ok: false, message: "Nothing has been added to pay." };
  if (lines.some((l) => Number(l.netPay) < 0)) return { ok: false, message: "Someone's deductions exceed their payment. Fix that first." };
  await prisma.$transaction(async (tx) => {
    for (const l of paying) {
      await tx.payslip.upsert({
        where: { runId_employeeId_isSegregated: { runId, employeeId: l.employeeId, isSegregated: false } },
        create: { runId, employeeId: l.employeeId, year: o.run.year, month: o.run.month, status: "GENERATED", netPay: l.netPay, isPasswordProtected: true },
        update: { status: "GENERATED", netPay: l.netPay },
      });
    }
    // Employees with nothing to pay drop out, so they do not show a zero payslip.
    await tx.payrollRunEmployee.deleteMany({ where: { runId, id: { notIn: paying.map((l) => l.id) } } });
    await tx.adhocTransaction.updateMany({ where: { runId }, data: { isProcessed: true } });
    await tx.employeeBonus.updateMany({ where: { runId }, data: { isProcessed: true } });
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "FINALIZED", employeeCount: paying.length, lockedAt: new Date(), lockedBy: actorUserId, finalizedAt: new Date(), finalizedBy: actorUserId } });
  });
  const ledger = await postPayrollRun(runId, actorUserId).catch((e: Error) => ({ ok: false, message: e.message }));
  return { ok: true, message: `Finalised: ${paying.length} payslip(s).${ledger.ok ? ` ${ledger.message}` : ` Not posted to the ledger: ${ledger.message}`}` };
}

export async function rollbackOffCycleRun(runId: string, tenantId: string, reason: string): Promise<Result> {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId, type: "OFF_CYCLE" } });
  if (!run || run.status !== "FINALIZED") return { ok: false, message: "Only a finalised off-cycle payroll can be rolled back." };
  const later = await prisma.payrollRun.findFirst({
    where: { payGroupId: run.payGroupId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: { gt: run.year } }, { year: run.year, month: { gt: run.month } }, { year: run.year, month: run.month, type: "OFF_CYCLE", sequence: { gt: run.sequence } }] },
  });
  if (later) return { ok: false, message: "A later payroll has been finalised on top of this one. Roll that back first." };
  if (await prisma.paymentBatchItem.count({ where: { status: "PAID", batch: { runId } } })) return { ok: false, message: "Transfers from this payroll are marked paid; it cannot be rolled back." };
  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId } });
    await tx.paymentBatch.deleteMany({ where: { runId } });
    await tx.adhocTransaction.updateMany({ where: { runId }, data: { isProcessed: false } });
    await tx.employeeBonus.updateMany({ where: { runId }, data: { isProcessed: false } });
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS", rolledBackAt: new Date(), rollbackReason: reason || "No reason given", lockedAt: null, lockedBy: null, finalizedAt: null, finalizedBy: null } });
  });
  const reversed = await reversePayrollPostings(runId, reason || "No reason given");
  return { ok: true, message: `Rolled back.${reversed.length ? ` Ledger: ${reversed.join(" ")}` : ""}` };
}
