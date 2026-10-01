import type { PrismaClient } from "@prisma/client";

/**
 * My Finances seed: what makes Keka's finance screens look lived-in for
 * Meera (ACM0009) and a couple of colleagues —
 *  - bonuses on her salary timeline (two paid, one due);
 *  - loan category codes, two more categories under the loan policy, a
 *    cleared emergency advance and a vehicle loan awaiting approval;
 *  - flexible-benefit claims this year: approved, pending and rejected;
 *  - previous-employer income for Swati, who joined mid-year;
 *  - one payslip held back (Arjun's August), to show the "not released" state.
 *
 * Idempotent: it removes only rows it creates (matched by type, category or
 * employee) before writing them again, so it can run on its own.
 */

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const at = (s: string) => new Date(`${s}T10:30:00Z`);

export async function seedFinances(prisma: PrismaClient, ctx: { tenantId: string }) {
  const t = ctx.tenantId;
  const byNumber = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, employeeNumber: n } });
  const byName = (first: string, last: string) => prisma.employee.findFirst({ where: { tenantId: t, firstName: first, lastName: last } });
  const meera = await byNumber("ACM0009");
  const ramesh = await prisma.user.findFirst({ where: { tenantId: t, email: "ramesh.iyer@acme.test" }, select: { id: true } });

  // --- Bonuses on Meera's salary timeline -----------------------------------
  const bonusType = (name: string, description: string) => prisma.bonusType.upsert({
    where: { tenantId_name: { tenantId: t, name } },
    create: { tenantId: t, name, description, isPartOfCtc: false, isTaxable: true },
    update: { description, isActive: true },
  });
  const pli = await bonusType("Performance Linked Incentive", "Paid once a year against the annual performance rating");
  const annual = await bonusType("Annual Bonus", "Company-wide bonus for the financial year");
  await prisma.employeeBonus.deleteMany({ where: { employeeId: meera.id, bonusTypeId: { in: [pli.id, annual.id] } } });
  await prisma.employeeBonus.createMany({ data: [
    { employeeId: meera.id, bonusTypeId: annual.id, amount: 40000, payoutYear: 2024, payoutMonth: 6, payAction: "PAY", isProcessed: true, note: "FY 2023-24 company bonus" },
    { employeeId: meera.id, bonusTypeId: pli.id, amount: 50000, payoutYear: 2025, payoutMonth: 6, payAction: "PAY", isProcessed: true, note: "FY 2024-25 rating: Exceeds expectations" },
    { employeeId: meera.id, bonusTypeId: pli.id, amount: 60000, payoutYear: 2027, payoutMonth: 3, payAction: "PAY", isProcessed: false, note: "FY 2026-27 — paid with the March payroll after the annual review" },
  ] });

  // --- Loans: codes, categories, Meera's history ------------------------------
  const policy = await prisma.loanPolicy.findFirst({ where: { tenantId: t, isActive: true }, orderBy: { createdAt: "asc" } });
  const category = async (name: string, data: { code: string; description: string; icon: string; color: string }) => {
    const existing = await prisma.loanCategory.findFirst({ where: { tenantId: t, name } });
    return existing
      ? prisma.loanCategory.update({ where: { id: existing.id }, data })
      : prisma.loanCategory.create({ data: { tenantId: t, name, ...data, isConcessional: true, sbiBenchmarkRate: 9.15 } });
  };
  const personal = await category("Personal Loan", { code: "PL001", description: "Personal loans for employees", icon: "wallet", color: "#2563eb" });
  const emergency = await category("Emergency Advance", { code: "EA001", description: "Salary advance for medical and family emergencies", icon: "alert", color: "#dc2626" });
  const home = await category("Home Loan", { code: "HOME", description: "Down payment or construction of a first home", icon: "home", color: "#0f766e" });
  const vehicle = await category("Vehicle Loan", { code: "VEH", description: "Two-wheeler or car purchase", icon: "car", color: "#7c3aed" });
  if (policy) {
    const rule = (categoryId: string, data: { interestType: "NONE" | "FLAT" | "REDUCING"; interestRate: number; maxInstallments: number; maxAmount?: number | null; maxPercentOfSalary?: number | null }) =>
      prisma.loanPolicyRule.upsert({
        where: { policyId_categoryId: { policyId: policy.id, categoryId } },
        create: { policyId: policy.id, categoryId, commencementMonths: 1, ...data },
        update: {},
      });
    await rule(home.id, { interestType: "FLAT", interestRate: 8, maxInstallments: 24, maxAmount: 2000000 });
    await rule(vehicle.id, { interestType: "REDUCING", interestRate: 9, maxInstallments: 36, maxPercentOfSalary: 50 });
  }
  await prisma.loan.deleteMany({ where: { employeeId: meera.id, categoryId: { in: [emergency.id, vehicle.id] } } });
  const cleared = await prisma.loan.create({
    data: {
      employeeId: meera.id, categoryId: emergency.id, policyId: policy?.id ?? null,
      principal: 30000, interestType: "NONE", interestRate: 0, installments: 6, emiAmount: 5000,
      status: "CLOSED", requestedAt: at("2025-04-07"), approvedAt: at("2025-04-08"), approvedBy: ramesh?.id ?? null,
      disbursedAt: at("2025-04-10"), disbursedOutside: true, expectedYear: 2025, expectedMonth: 4,
      startYear: 2025, startMonth: 5, outstanding: 0, totalRepaid: 30000, closedAt: at("2025-10-31"),
      purpose: "Hospital deposit for my father's surgery",
    },
  });
  await prisma.loanInstallment.createMany({ data: Array.from({ length: 6 }, (_, i) => ({
    loanId: cleared.id, sequence: i + 1, year: 2025, month: 5 + i, principalPart: 5000, interestPart: 0, totalAmount: 5000,
    balanceAfter: 30000 - (i + 1) * 5000, status: "DEDUCTED" as const, deductedAt: d(`2025-${String(5 + i).padStart(2, "0")}-28`),
  })) });
  // A request waiting on the approver: 3,00,000 over 24 months at 9% reducing, from December.
  const { buildLoanSchedule } = await import("@keka/payroll");
  const plan = buildLoanSchedule({ principal: 300000, installments: 24, interestType: "REDUCING", annualRate: 9, startYear: 2026, startMonth: 12 });
  await prisma.loan.create({
    data: {
      employeeId: meera.id, categoryId: vehicle.id, policyId: policy?.id ?? null,
      principal: 300000, interestType: "REDUCING", interestRate: 9, installments: 24, emiAmount: plan.emi.toNumber(),
      status: "PENDING_APPROVAL", requestedAt: at("2026-09-24"), expectedYear: 2026, expectedMonth: 11,
      startYear: 2026, startMonth: 12, outstanding: 300000, purpose: "Two-wheeler purchase",
    },
  });
  void personal;

  // --- Flexible-benefit claims, FY 2026-27 -------------------------------------
  const comp = (code: string) => prisma.salaryComponent.findFirst({ where: { tenantId: t, code }, select: { id: true } });
  const [phone, fuel, books] = await Promise.all([comp("TELEPHONE_REIMB"), comp("FUEL_REIMB"), comp("BOOKS_REIMB")]);
  await prisma.componentClaim.deleteMany({ where: { employeeId: meera.id, fyStartYear: 2026 } });
  const claims = [
    phone && { employeeId: meera.id, componentId: phone.id, fyStartYear: 2026, claimedAmount: 6000, payableAmount: 6000, status: "APPROVED" as const, payoutYear: 2026, payoutMonth: 9, billDate: d("2026-08-30"), billNumber: "AIRTEL-0826", comment: "Broadband and mobile, June to August", reviewedBy: ramesh?.id ?? null, reviewedAt: at("2026-09-05"), createdAt: at("2026-09-01") },
    fuel && { employeeId: meera.id, componentId: fuel.id, fyStartYear: 2026, claimedAmount: 4800, status: "SUBMITTED" as const, billDate: d("2026-09-10"), billNumber: "HPCL-2291", comment: "Fuel bills, July and August", createdAt: at("2026-09-12") },
    books && { employeeId: meera.id, componentId: books.id, fyStartYear: 2026, claimedAmount: 1850, status: "REJECTED" as const, billDate: d("2026-07-02"), billNumber: "SAP-7781", comment: "Technical books", reviewerNote: "The bill is in a family member's name — claim again with a bill in yours.", reviewedBy: ramesh?.id ?? null, reviewedAt: at("2026-07-09"), createdAt: at("2026-07-04") },
  ].filter((c): c is NonNullable<typeof c> => !!c);
  for (const c of claims) await prisma.componentClaim.create({ data: c });

  // The approved claim is paid in September: refresh the open September run so step 4 and the totals show it.
  const sep = meera.payGroupId
    ? await prisma.payrollRun.findFirst({ where: { tenantId: t, payGroupId: meera.payGroupId, year: 2026, month: 9, type: "REGULAR", status: { in: ["DRAFT", "IN_PROGRESS"] } } })
    : null;

  // --- Previous employment for a mid-year joiner -------------------------------
  const swati = await byName("Swati", "Kulkarni");
  if (swati) {
    const prev = { previousEmployerIncome: 310000, previousEmployerTds: 12500, previousEmployerPf: 10800, previousEmployerPt: 400 };
    await prisma.employeeStatutoryProfile.upsert({ where: { employeeId: swati.id }, create: { employeeId: swati.id, ...prev }, update: prev });
  }

  // --- A payslip held back, for the "not released yet" state -------------------
  const arjun = await byName("Arjun", "Nair");
  let held = 0;
  if (arjun) {
    const r = await prisma.payslip.updateMany({
      where: { employeeId: arjun.id, year: 2026, month: 8, isSegregated: false, run: { status: "FINALIZED" } },
      data: { status: "HELD", heldAt: at("2026-09-03"), releasedAt: null, releasedBy: null },
    });
    held = r.count;
  }

  if (sep) {
    const svc = await import("@keka/services");
    await svc.calculateRun(sep.id);
  }

  return { bonuses: 3, loans: 2, categories: 4, claims: claims.length, held, recalculated: !!sep };
}
