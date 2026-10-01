import type { PrismaClient } from "@prisma/client";

/**
 * Accounting seed. The opening position goes in first, so the payroll months
 * finalised by the payroll-history seed post on top of it; afterwards each
 * month's salaries are paid from the bank, the statutory dues collected are
 * remitted by the 15th of the next month (the latest month's are still owed),
 * and the first quarter is closed.
 */
const d = (s: string) => new Date(`${s}T00:00:00Z`);

export async function seedAccountingOpening(prisma: PrismaClient, ctx: { tenantId: string; byUserId: string }) {
  const svc = await import("@keka/services");
  const opening = d("2026-04-01");
  await svc.ensureChart(ctx.tenantId);
  // Staff loans lent before the year opened are carried in as an asset; the
  // rest are posted as they were disbursed.
  const loans = await prisma.loan.findMany({ where: { employee: { tenantId: ctx.tenantId }, disbursedAt: { not: null } }, include: { schedule: true } });
  const carried = loans.filter((l) => l.disbursedAt! < opening)
    .reduce((s, l) => s + Number(l.principal) - l.schedule.filter((i) => Date.UTC(i.year, i.month - 1, 1) < opening.getTime()).reduce((p, i) => p + Number(i.principalPart), 0), 0);
  const bank = 50_000_000 - carried;
  const r = await svc.postEntry({
    tenantId: ctx.tenantId, date: opening, source: "OPENING_BALANCE", ref: { type: "Opening", id: ctx.tenantId }, postedBy: ctx.byUserId,
    narration: "Opening balances brought forward at 1 April 2026",
    lines: [
      { accountCode: "1100", debit: bank, credit: 0, narration: "HDFC current account" },
      ...(carried > 0 ? [{ accountCode: "1310", debit: carried, credit: 0, narration: "Staff loans outstanding" }] : []),
      { accountCode: "3100", debit: 0, credit: 10_000_000, narration: "Share capital" },
      { accountCode: "3200", debit: 0, credit: 40_000_000, narration: "Retained earnings" },
    ],
  });
  if (!r.ok) throw new Error(`Opening balance: ${r.message}`);
  for (const l of loans.filter((x) => x.disbursedAt! >= opening)) {
    const p = await svc.postLoanDisbursement(l.id, ctx.byUserId);
    if (!p.ok) throw new Error(`Loan disbursement: ${p.message}`);
  }
}

export async function seedAccountingActivity(prisma: PrismaClient, ctx: { tenantId: string; byUserId: string }) {
  const svc = await import("@keka/services");
  const runs = await prisma.payrollRun.findMany({ where: { tenantId: ctx.tenantId, status: "FINALIZED" }, orderBy: [{ year: "asc" }, { month: "asc" }] });
  let paid = 0, remitted = 0;
  for (const [i, run] of runs.entries()) {
    const pay = await svc.recordSalaryPayment(run.id, { byUserId: ctx.byUserId, date: run.payDate ?? run.periodEnd, reference: `NEFT batch ${run.year}${String(run.month).padStart(2, "0")}` });
    if (!pay.ok) throw new Error(`Salary payment ${run.month}/${run.year}: ${pay.message}`);
    paid++;
    if (i === runs.length - 1) continue; // the latest month's dues are not due yet
    // Remit exactly what the month's accrual collected for each authority.
    const accrual = await prisma.ledgerEntry.findFirstOrThrow({ where: { tenantId: ctx.tenantId, sourceRefType: "PayrollRun", sourceRefId: run.id, status: "POSTED" }, include: { lines: { include: { account: true } } } });
    const due = new Date(Date.UTC(run.year, run.month, 15));
    for (const [code, what] of [["2200", "EPF challan (ECR)"], ["2210", "ESI challan"], ["2220", "Professional tax"], ["2230", "TDS on salaries (challan 281)"], ["2240", "LWF"]] as const) {
      const amount = accrual.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.credit), 0);
      if (amount <= 0) continue;
      const r = await svc.postEntry({
        tenantId: ctx.tenantId, date: due, source: "PAYMENT", postedBy: ctx.byUserId,
        narration: `${what} for ${run.month}/${run.year}`,
        lines: [{ accountCode: code, debit: Math.round(amount * 100) / 100, credit: 0 }, { accountCode: "1100", debit: 0, credit: Math.round(amount * 100) / 100 }],
      });
      if (!r.ok) throw new Error(`Remittance ${code}: ${r.message}`);
      remitted++;
    }
  }
  for (const m of ["2026-04", "2026-05", "2026-06"]) await svc.setPeriodClosed(ctx.tenantId, m, true, ctx.byUserId);
  const tb = await svc.trialBalance(ctx.tenantId);
  if (tb.debit !== tb.credit) throw new Error(`Trial balance out: ${tb.debit} vs ${tb.credit}`);
  return { entries: await prisma.ledgerEntry.count({ where: { tenantId: ctx.tenantId } }), paid, remitted, closed: 3, total: tb.debit };
}
