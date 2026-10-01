/**
 * Loans through the actions: eligibility, request, approval, the schedule,
 * payroll deduction, and the balance kept in step with every movement.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;403/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  const a = await import("../apps/web/src/app/actions/loans");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0013" } }); // no open loans
  const harish = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0025" } }); // on probation
  const cats = await prisma.loanCategory.findMany({ where: { tenantId: tenant.id, policyRules: { some: {} } }, include: { policyRules: true } });
  const cat = cats.find((c) => !c.name.toLowerCase().includes("salary")) ?? cats[0];
  const rule = cat.policyRules[0];
  const created: string[] = [];
  const started = new Date();

  console.log("\nLoans\n" + "=".repeat(72));
  try {
    section("Eligibility and request");
    const probation = await svc.checkLoanEligibility(harish.id, cat.id, 10000, 6);
    check("An employee on probation is not eligible", !probation.eligible && probation.reasons.some((r) => /probation/i.test(r)), probation.reasons.join(" "));

    await signInAs("nikhil.joshi@acme.test");
    const tooLong = await a.applyLoanAction({}, fd({ categoryId: cat.id, amount: 20000, installments: rule.maxInstallments + 1, intent: "preview" }));
    check("Repaying beyond the policy's months is refused", tooLong.ok === false && /at most/.test(tooLong.message ?? ""), tooLong.message);
    const preview = await a.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, intent: "preview" }));
    check("Preview shows the EMI without creating anything", preview.ok === true && /EMI ₹/.test(preview.message ?? "")
      && (await prisma.loan.count({ where: { employeeId: meera.id, status: "PENDING_APPROVAL" } })) === 0, preview.message);
    const applied = await a.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, purpose: "Smoke test loan" }));
    const loan = await prisma.loan.findFirstOrThrow({ where: { employeeId: meera.id, purpose: "Smoke test loan" } });
    created.push(loan.id);
    check("The request waits for approval", applied.ok === true && loan.status === "PENDING_APPROVAL", applied.message);
    const dup = await a.applyLoanAction({}, fd({ categoryId: cat.id, amount: 10000, installments: 2 }));
    check("A second open loan in the same category is refused", dup.ok === false, dup.message);
    check("The employee cannot approve it", await denied(() => a.decideLoanAction({}, fd({ loanId: loan.id, decision: "approve" }))));

    section("Approval and the schedule");
    await signInAs("ramesh.iyer@acme.test");
    const noReason = await a.decideLoanAction({}, fd({ loanId: loan.id, decision: "reject" }));
    check("Declining needs a reason", noReason.ok === false, noReason.message);
    const ok = await a.decideLoanAction({}, fd({ loanId: loan.id, decision: "approve" }));
    const sched = await prisma.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { sequence: "asc" } });
    const principalSum = sched.reduce((s, i) => s + Number(i.principalPart), 0);
    check("Approval writes a schedule that repays exactly the principal", ok.ok === true && sched.length === 6 && Math.abs(principalSum - 60000) < 0.01, ok.message);
    check("The last instalment leaves a zero balance", Number(sched[5].balanceAfter) === 0);

    // Before disbursal nothing is deducted, even if payroll runs that month.
    const first = sched[0];
    const disb = await a.loanOperationAction({}, fd({ loanId: loan.id, op: "disburse" }));
    check("Disbursal activates it", disb.ok === true && (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status === "ACTIVE", disb.message);

    section("Skipping and the balance");
    const skip = await a.loanOperationAction({}, fd({ loanId: loan.id, op: "skip", period: `${first.year}-${first.month}` }));
    const afterSkip = await prisma.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { sequence: "asc" } });
    check("Skipping an EMI pushes it to the end", skip.ok === true && afterSkip.length === 7 && afterSkip[0].status === "SKIPPED", skip.message);
    // Simulate two payroll deductions.
    await prisma.loanInstallment.updateMany({ where: { loanId: loan.id, sequence: { in: [2, 3] } }, data: { status: "DEDUCTED", deductedAt: new Date() } });
    await svc.syncLoanBalance(loan.id);
    const mid = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    const deducted = afterSkip.filter((i) => [2, 3].includes(i.sequence));
    check("Outstanding falls by exactly what was deducted", Math.abs(Number(mid.outstanding) - (60000 - deducted.reduce((s, i) => s + Number(i.principalPart), 0))) < 0.01, `${mid.outstanding}`);

    section("Foreclosure");
    const fc = await a.loanOperationAction({}, fd({ loanId: loan.id, op: "foreclose" }));
    const done = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    check("Foreclosing settles the rest and closes the loan", fc.ok === true && done.status === "FORECLOSED" && Number(done.outstanding) === 0, fc.message);
    check("No further EMIs are scheduled", (await prisma.loanInstallment.count({ where: { loanId: loan.id, status: "SCHEDULED" } })) === 0);

    section("The seeded loan agrees with its schedule");
    const seeded = await prisma.loan.findFirst({ where: { employee: { tenantId: tenant.id }, status: "ACTIVE", id: { notIn: created } }, include: { schedule: true } });
    if (seeded) {
      const ded = seeded.schedule.filter((i) => i.status === "DEDUCTED").reduce((s, i) => s + Number(i.principalPart), 0);
      check("Outstanding = principal − principal deducted", Math.abs(Number(seeded.outstanding) - (Number(seeded.principal) - ded)) < 0.01, `${seeded.outstanding} vs ${Number(seeded.principal) - ded}`);
    }
  } finally {
    await purgeLedgerSince(prisma, tenant.id, started);
    await prisma.loan.deleteMany({ where: { id: { in: created } } });
  }
  report("Loans");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
