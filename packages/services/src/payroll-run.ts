import { prisma, type Prisma } from "@keka/db";
import {
  calculatePayroll, type CalculatePayrollInput, type CalculatePayrollResult,
  type StructureComponentSpec, type PtSlab, type LwfRule, type TaxSlab, type TaxConfig,
  type PtFrequency,
} from "@keka/payroll";
import { daysInMonth, fyStartYear, endOfMonth, startOfMonth } from "@keka/shared";
import { cappedDeductions } from "./declarations";
import { claimEntitlement, previousIncomeApplies } from "./finances-math";
import { fbpCarveSpecs, unclaimedFbp } from "./fbp-math";

/**
 * The bridge between the database and the pure payroll engine.
 *
 * Lives in @keka/services rather than inside the web app so the same code
 * path is used by the UI, by scripts, and by scheduled jobs. @keka/payroll
 * stays free of any database dependency, which is what makes it testable.
 *
 * The engine takes plain values and returns a payslip. Everything here is
 * about assembling those values correctly — which is where the real
 * complexity of a payroll run lives.
 */

export type RunWithContext = Prisma.PayrollRunGetPayload<{
  include: { payGroup: { include: { filingDetail: true } } };
}>;

/** A slab band, retaining the age range it applies to. */
interface AgeBandedSlabs {
  minAge: number;
  maxAge: number;
  slabs: TaxSlab[];
}

/** Statutory tables cached for the duration of one run calculation. */
interface StatutoryTables {
  ptByState: Map<string, { slabs: PtSlab[]; frequency: PtFrequency; collectionMonths: number[] }>;
  lwfByState: Map<string, LwfRule>;
  /** Keyed by regime. The old regime has three age bands; the new regime one. */
  taxSlabBands: Map<string, AgeBandedSlabs[]>;
  taxConfigs: Map<string, TaxConfig>;
}

/**
 * Age for tax purposes is taken as at the last day of the financial year, so
 * someone who turns 60 in March gets the senior-citizen slabs for that year.
 */
export function ageAtFyEnd(dateOfBirth: Date | null, fyStart: number): number {
  if (!dateOfBirth) return 30;
  const fyEnd = new Date(Date.UTC(fyStart + 1, 2, 31));
  let age = fyEnd.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const m = fyEnd.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (m < 0 || (m === 0 && fyEnd.getUTCDate() < dateOfBirth.getUTCDate())) age--;
  return Math.max(0, age);
}

/**
 * Pick the single slab band that applies to this age.
 *
 * Getting this wrong is silently expensive: merging the bands produces one
 * table in which the upper slabs repeat, which over-deducts tax for every
 * old-regime employee.
 */
export function slabsFor(
  bands: AgeBandedSlabs[] | undefined,
  age: number,
): TaxSlab[] {
  if (!bands || bands.length === 0) return [];
  const match = bands.find((b) => age >= b.minAge && age <= b.maxAge);
  return (match ?? bands[0]).slabs;
}

export async function loadStatutoryTables(
  payGroupId: string,
  fyStart: number,
  periodEnd: Date,
): Promise<StatutoryTables> {
  const [ptRegs, lwfRegs, allPtSlabs, allLwfRules, slabRows, configRows] = await Promise.all([
    prisma.ptStateRegistration.findMany({
      where: { payGroupId, isActive: true },
      include: { linkedLocations: true },
    }),
    prisma.lwfStateRegistration.findMany({
      where: { payGroupId, isActive: true },
      include: { linkedLocations: true },
    }),
    prisma.ptSlab.findMany({
      where: { effectiveFrom: { lte: periodEnd } },
      orderBy: [{ effectiveFrom: "desc" }, { fromAmount: "asc" }],
    }),
    prisma.lwfRule.findMany({
      where: { effectiveFrom: { lte: periodEnd } },
      orderBy: { effectiveFrom: "desc" },
    }),
    prisma.incomeTaxSlab.findMany({ where: { fyStartYear: fyStart } }),
    prisma.incomeTaxConfig.findMany({ where: { fyStartYear: fyStart } }),
  ]);

  // PT is keyed by the employee's LOCATION, which maps to a registered state.
  const ptByState = new Map<string, { slabs: PtSlab[]; frequency: PtFrequency; collectionMonths: number[] }>();
  for (const reg of ptRegs) {
    const slabs = allPtSlabs
      .filter((s) => s.stateCode === reg.stateCode &&
        (reg.localBodyType === "" || s.localBodyType === reg.localBodyType || s.localBodyType === null))
      .map((s) => ({
        fromAmount: Number(s.fromAmount),
        toAmount: s.toAmount === null ? null : Number(s.toAmount),
        amount: Number(s.amount),
        specialMonth: s.specialMonth,
        specialAmount: s.specialAmount === null ? null : Number(s.specialAmount),
        gender: s.gender as "MALE" | "FEMALE" | null,
        frequency: s.frequency as PtFrequency,
      }));
    const entry = {
      slabs,
      frequency: reg.frequency as PtFrequency,
      // Half-yearly states collect in September and March; annual in March.
      collectionMonths: reg.frequency === "HALF_YEARLY" ? [9, 3]
        : reg.frequency === "ANNUAL" ? [3] : [],
    };
    for (const link of reg.linkedLocations) ptByState.set(link.locationId, entry);
  }

  const lwfByState = new Map<string, LwfRule>();
  for (const reg of lwfRegs) {
    const rule = allLwfRules.find((r) => r.stateCode === reg.stateCode);
    if (!rule) continue;
    const mapped: LwfRule = {
      frequency: rule.frequency as "MONTHLY" | "HALF_YEARLY" | "ANNUAL",
      deductionMonths: rule.deductionMonths as number[],
      employeeAmount: Number(rule.employeeAmount),
      employerAmount: Number(rule.employerAmount),
      wageLimit: rule.wageLimit === null ? null : Number(rule.wageLimit),
    };
    for (const link of reg.linkedLocations) lwfByState.set(link.locationId, mapped);
  }

  // Group by (regime, age band). The old regime publishes separate tables for
  // under-60, 60-79 and 80+; flattening them corrupts the progression.
  const taxSlabBands = new Map<string, AgeBandedSlabs[]>();
  for (const regime of ["OLD", "NEW"] as const) {
    const bandKeys = new Map<string, { minAge: number; maxAge: number }>();
    for (const row of slabRows) {
      if (row.regime !== regime) continue;
      bandKeys.set(`${row.minAge}-${row.maxAge}`, { minAge: row.minAge, maxAge: row.maxAge });
    }
    const bands: AgeBandedSlabs[] = [...bandKeys.values()]
      .sort((a, b) => a.minAge - b.minAge)
      .map((band) => ({
        minAge: band.minAge,
        maxAge: band.maxAge,
        slabs: slabRows
          .filter((s) => s.regime === regime && s.minAge === band.minAge && s.maxAge === band.maxAge)
          .sort((a, b) => Number(a.fromAmount) - Number(b.fromAmount))
          .map((s) => ({
            fromAmount: Number(s.fromAmount),
            toAmount: s.toAmount === null ? null : Number(s.toAmount),
            ratePercent: Number(s.ratePercent),
          })),
      }));
    taxSlabBands.set(regime, bands);
  }

  const taxConfigs = new Map<string, TaxConfig>();
  for (const c of configRows) {
    taxConfigs.set(c.regime, {
      standardDeduction: Number(c.standardDeduction),
      rebateLimit: Number(c.rebateLimit),
      rebateMaxAmount: Number(c.rebateMaxAmount),
      cessPercent: Number(c.cessPercent),
      surchargeBands: (c.surchargeBands ?? []) as Array<{ from: number; to: number | null; percent: number }>,
      marginalReliefEnabled: c.marginalReliefEnabled,
    });
  }

  return { ptByState, lwfByState, taxSlabBands, taxConfigs };
}

/**
 * Employees to include in a run: everyone in the pay group who was employed
 * for at least one day of the period.
 */
export async function eligibleEmployees(payGroupId: string, periodStart: Date, periodEnd: Date) {
  return prisma.employee.findMany({
    where: {
      payGroupId,
      dateOfJoining: { lte: periodEnd },
      OR: [
        { lastWorkingDay: null },
        { lastWorkingDay: { gte: periodStart } },
      ],
      status: { notIn: ["PREBOARDING"] },
    },
    orderBy: { employeeNumber: "asc" },
    include: {
      statutoryProfile: true,
      location: { select: { id: true, stateCode: true } },
      // dateOfBirth drives the old regime's senior-citizen slab selection.
      salaryRevisions: {
        where: { effectiveFrom: { lte: periodEnd }, status: "APPLIED" },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
        include: {
          structure: { include: { components: { include: { component: true } } } },
        },
      },
    },
  });
}

function byEmployeeId<T extends { employeeId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.employeeId, [...(m.get(r.employeeId) ?? []), r]);
  return m;
}

type EligibleEmployee = Awaited<ReturnType<typeof eligibleEmployees>>[number];

function toStructureSpecs(
  revision: EligibleEmployee["salaryRevisions"][number] | undefined,
): StructureComponentSpec[] {
  if (!revision?.structure) return [];
  return revision.structure.components
    .filter((sc) => sc.isActive)
    .map((sc) => ({
      code: sc.component.code,
      name: sc.component.name,
      type: sc.component.type,
      calculationType: sc.calculationType,
      formula: sc.formula,
      fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
      percentage: sc.percentage === null ? null : Number(sc.percentage),
      percentageOf: sc.percentageOf,
      sequence: sc.sequence,
      minAmount: sc.minAmount === null ? null : Number(sc.minAmount),
      maxAmount: sc.maxAmount === null ? null : Number(sc.maxAmount),
      isOutsideCtc: sc.component.isOutsideCtc,
      isLopApplicable: sc.component.isLopApplicable,
      affectsPfWage: sc.component.affectsPfWage,
      affectsEsiGross: sc.component.affectsEsiGross,
      showOnPayslip: sc.component.showOnPayslip,
      isPartOfFbp: sc.component.isPartOfFbp,
    }));
}

/**
 * Recalculate every employee in a run and persist the result.
 * Safe to re-run: existing lines are replaced, so this is how "recalculate"
 * works after an input changes at any step.
 */
export async function calculateRun(runId: string): Promise<{
  employeeCount: number;
  totalGross: number;
  totalNetPay: number;
  totalDeductions: number;
  totalEmployerCost: number;
  warnings: string[];
}> {
  const run = await prisma.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    include: { payGroup: { include: { filingDetail: true } } },
  });

  if (run.status === "FINALIZED") {
    throw new Error("This payroll run is finalised. Roll it back before recalculating.");
  }

  const { payGroup } = run;
  const filing = payGroup.filingDetail;
  const fyStart = fyStartYear(run.periodEnd, 4);
  const tables = await loadStatutoryTables(payGroup.id, fyStart, run.periodEnd);
  const employees = await eligibleEmployees(payGroup.id, run.periodStart, run.periodEnd);

  // Existing per-employee rows carry the pay actions and overrides set in
  // steps 2-6, so they are read first and merged back in.
  const existingRows = await prisma.payrollRunEmployee.findMany({ where: { runId } });
  const existingByEmployee = new Map(existingRows.map((r) => [r.employeeId, r]));

  const employeeIds = employees.map((e) => e.id);

  // Investment declarations for the year: what each line counts for, after
  // every section ceiling, feeds the TDS projection (declared amounts until
  // a proof is ruled on, then what was accepted).
  const declarations = await prisma.investmentDeclaration.findMany({
    where: { employeeId: { in: employeeIds }, fyStartYear: fyStart, status: { not: "REJECTED" } },
    include: { items: true, hraDetail: true },
  });
  const declarationOf = new Map(declarations.map((d) => [d.employeeId, d]));

  // Flexible benefit declarations: carved out of salary each month, claimed
  // back against bills, and what is left unclaimed paid in the year's last month.
  const fbpDeclarations = await prisma.fbpDeclaration.findMany({
    where: { employeeId: { in: employeeIds }, fyStartYear: fyStart },
    include: { lines: { include: { component: { select: { code: true, name: true } } } } },
  });
  const fbpOf = new Map(fbpDeclarations.map((d) => [d.employeeId, d]));

  // Perquisites active in the period, and those already taxed earlier in the
  // year (their payslip lines), which count towards year-to-date income.
  const [perkAssignments, taxablePerks, priorPerkLines] = await Promise.all([
    prisma.employeePerk.findMany({
      where: { employeeId: { in: employeeIds }, startDate: { lte: run.periodEnd }, OR: [{ endDate: null }, { endDate: { gte: run.periodStart } }] },
      include: { perk: { include: { component: { select: { code: true, name: true, isActive: true } } } } },
      orderBy: { startDate: "asc" },
    }),
    prisma.perk.findMany({ where: { component: { tenantId: run.tenantId }, isTaxable: true, taxBorneByEmployer: false }, select: { component: { select: { code: true } } } }),
    prisma.payslipLine.findMany({
      where: {
        type: "PERK",
        runEmployee: { employeeId: { in: employeeIds }, run: { payGroupId: payGroup.id, status: "FINALIZED", periodEnd: { lt: run.periodStart, gte: startOfMonth(fyStart, 4) } } },
      },
      select: { code: true, amount: true, runEmployee: { select: { employeeId: true } } },
    }),
  ]);
  const taxablePerkCodes = new Set(taxablePerks.map((p) => p.component.code));
  const perksByEmp = byEmployeeId(perkAssignments.filter((a) => a.perk.component.isActive));
  const lastMonthOfFy = run.month === 3;
  const fbpClaimed = lastMonthOfFy && fbpDeclarations.length
    ? await prisma.componentClaim.findMany({
        where: { employeeId: { in: fbpDeclarations.map((d) => d.employeeId) }, fyStartYear: fyStart, status: { in: ["APPROVED", "PAID"] } },
        select: { employeeId: true, componentId: true, payableAmount: true, claimedAmount: true },
      })
    : [];

  const [lopAdjustments, arrears, bonuses, adhoc, claims, loanInstallments, overtime, shiftAllowances, priorRuns] =
    await Promise.all([
      prisma.lopAdjustment.findMany({
        where: { employeeId: { in: employeeIds }, year: run.year, month: run.month },
      }),
      prisma.arrear.findMany({
        where: { employeeId: { in: employeeIds }, isProcessed: false },
      }),
      // Items pulled into an off-cycle run (runId set to it) belong to that run.
      prisma.employeeBonus.findMany({
        where: {
          employeeId: { in: employeeIds },
          payoutYear: run.year, payoutMonth: run.month,
          payAction: { in: ["PAY", "PARTIALLY_PAY"] },
          OR: [{ runId: null }, { runId: run.id }],
        },
      }),
      prisma.adhocTransaction.findMany({
        where: {
          employeeId: { in: employeeIds },
          year: run.year, month: run.month,
          isPaidOutside: false,
          OR: [{ runId: null }, { runId: run.id }],
        },
      }),
      prisma.componentClaim.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: "APPROVED",
          payoutYear: run.year, payoutMonth: run.month,
        },
        include: { component: true },
      }),
      prisma.loanInstallment.findMany({
        where: {
          loan: { employeeId: { in: employeeIds }, status: { in: ["ACTIVE", "DISBURSED"] } },
          year: run.year, month: run.month,
          status: "SCHEDULED",
        },
        include: { loan: { include: { category: true } } },
      }),
      prisma.overtimeEntry.findMany({
        where: {
          employeeId: { in: employeeIds }, year: run.year, month: run.month,
          payAction: "PAY", isProcessed: false,
        },
      }),
      prisma.shiftAllowanceEntry.findMany({
        where: {
          employeeId: { in: employeeIds }, year: run.year, month: run.month,
          payAction: "PAY", isProcessed: false,
        },
      }),
      // Year-to-date figures come from finalised runs earlier in the same FY.
      prisma.payrollRunEmployee.findMany({
        where: {
          employeeId: { in: employeeIds },
          run: {
            payGroupId: payGroup.id,
            status: "FINALIZED",
            periodEnd: { lt: run.periodStart, gte: startOfMonth(fyStart, 4) },
          },
        },
        select: {
          employeeId: true, grossEarnings: true, tds: true,
          professionalTax: true, pfEmployee: true,
        },
      }),
    ]);

  const byEmployee = <T extends { employeeId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.employeeId) ?? [];
      list.push(r);
      m.set(r.employeeId, list);
    }
    return m;
  };

  const lopByEmp = byEmployee(lopAdjustments);
  const arrearsByEmp = byEmployee(arrears);
  const bonusByEmp = byEmployee(bonuses);
  const adhocByEmp = byEmployee(adhoc);
  const claimsByEmp = byEmployee(claims);
  const otByEmp = byEmployee(overtime);
  const shiftByEmp = byEmployee(shiftAllowances);
  const emiByEmp = new Map<string, typeof loanInstallments>();
  for (const i of loanInstallments) {
    const list = emiByEmp.get(i.loan.employeeId) ?? [];
    list.push(i);
    emiByEmp.set(i.loan.employeeId, list);
  }

  const ytdByEmp = new Map<string, { gross: number; tds: number; pt: number }>();
  for (const row of priorRuns) {
    const cur = ytdByEmp.get(row.employeeId) ?? { gross: 0, tds: 0, pt: 0 };
    cur.gross += Number(row.grossEarnings);
    cur.tds += Number(row.tds);
    cur.pt += Number(row.professionalTax);
    ytdByEmp.set(row.employeeId, cur);
  }
  for (const line of priorPerkLines) {
    if (!taxablePerkCodes.has(line.code)) continue;
    const cur = ytdByEmp.get(line.runEmployee.employeeId) ?? { gross: 0, tds: 0, pt: 0 };
    cur.gross += Number(line.amount);
    ytdByEmp.set(line.runEmployee.employeeId, cur);
  }

  // Attendance-driven LOP for the period.
  const attendance = await prisma.attendanceRecord.groupBy({
    by: ["employeeId"],
    where: {
      employeeId: { in: employeeIds },
      date: { gte: run.periodStart, lte: run.periodEnd },
    },
    _sum: { lopValue: true },
  });
  const attendanceLop = new Map(
    attendance.map((a) => [a.employeeId, Number(a._sum.lopValue ?? 0)]),
  );

  // Unpaid leave in the period — the first documented LOP driver.
  const unpaidLeave = await prisma.leaveRequestDay.groupBy({
    by: ["requestId"],
    where: {
      date: { gte: run.periodStart, lte: run.periodEnd },
      isPaid: false,
      request: { status: "APPROVED", employeeId: { in: employeeIds } },
    },
    _sum: { dayValue: true },
  });
  const unpaidRequestIds = unpaidLeave.map((u) => u.requestId);
  const unpaidRequests = unpaidRequestIds.length > 0
    ? await prisma.leaveRequest.findMany({
        where: { id: { in: unpaidRequestIds } },
        select: { id: true, employeeId: true },
      })
    : [];
  const leaveLop = new Map<string, number>();
  for (const u of unpaidLeave) {
    const req = unpaidRequests.find((r) => r.id === u.requestId);
    if (!req) continue;
    leaveLop.set(req.employeeId, (leaveLop.get(req.employeeId) ?? 0) + Number(u._sum.dayValue ?? 0));
  }

  const totalDays = daysInMonth(run.year, run.month);
  const results: Array<{ employee: EligibleEmployee; result: CalculatePayrollResult }> = [];
  const allWarnings: string[] = [];

  for (const emp of employees) {
    const existing = existingByEmployee.get(emp.id);
    const payAction = existing?.payAction ?? "PROCESS_AS_SALARY";

    // A processing hold removes the employee from the register entirely:
    // no components get values and no statutory contributions apply.
    if (payAction === "HOLD_SALARY_PROCESSING" || payAction === "VOID_SALARY_PROCESSING") {
      results.push({
        employee: emp,
        result: null as unknown as CalculatePayrollResult,
      });
      continue;
    }

    const revision = emp.salaryRevisions[0];
    const fbp = revision?.structure?.isPartOfFbp ? fbpOf.get(emp.id) : undefined;
    const specs = fbp
      ? [
          ...toStructureSpecs(revision).filter((sc) => !(sc.type === "REIMBURSEMENT" && sc.isPartOfFbp)),
          ...fbpCarveSpecs(fbp.lines.map((l) => ({ code: l.component.code, name: l.component.name, annual: Number(l.annualAmount) }))),
        ]
      : toStructureSpecs(revision);
    let fbpUnclaimed = 0;
    if (fbp && lastMonthOfFy) {
      fbpUnclaimed = unclaimedFbp(fbp.lines.map((l) => {
        const claimed = fbpClaimed
          .filter((c) => c.employeeId === emp.id && c.componentId === l.componentId)
          .reduce((t, c) => t + Number(c.payableAmount ?? c.claimedAmount), 0);
        const ent = claimEntitlement({ annualLimit: Number(l.annualAmount), joinedOn: emp.dateOfJoining, lastWorkingDay: emp.lastWorkingDay, fy: fyStart, fyStartMonth: 4, today: run.periodEnd });
        return { accrued: ent.accrued, claimed };
      }));
    }
    if (specs.length === 0) {
      allWarnings.push(`${emp.employeeNumber} ${emp.firstName} ${emp.lastName}: no salary structure assigned`);
    }

    const manualLop = (lopByEmp.get(emp.id) ?? []).reduce((s, a) => s + Number(a.days), 0);
    const systemLop = (attendanceLop.get(emp.id) ?? 0) + (leaveLop.get(emp.id) ?? 0);

    const ptEntry = emp.locationId ? tables.ptByState.get(emp.locationId) : undefined;
    const lwfRule = emp.locationId ? tables.lwfByState.get(emp.locationId) ?? null : null;
    const regime = emp.statutoryProfile?.taxRegime ?? "NEW";
    const decl = declarationOf.get(emp.id);
    const declared = cappedDeductions(
      (decl?.items ?? []).map((i) => ({ section: i.section, declaredAmount: Number(i.declaredAmount), approvedAmount: Number(i.approvedAmount), proofStatus: i.proofStatus })),
      ageAtFyEnd(emp.dateOfBirth, fyStart),
    );
    const rentDeclared = decl?.hraDetail
      ? Number(decl.hraDetail.annualRent ?? 0) || Object.values((decl.hraDetail.monthlyRent ?? {}) as Record<string, number>).reduce((a, v) => a + Number(v || 0), 0)
      : 0;
    const ytd = ytdByEmp.get(emp.id) ?? { gross: 0, tds: 0, pt: 0 };
    const previousApplies = previousIncomeApplies(emp.dateOfJoining, fyStart, 4);

    const input: CalculatePayrollInput = {
      employeeId: emp.id,
      year: run.year,
      month: run.month,
      fyStartMonth: 4,
      annualCtc: revision ? Number(revision.annualCtc) : 0,
      structureComponents: specs,
      roundComponents: revision?.structure?.roundComponents ?? true,
      joiningDate: emp.dateOfJoining,
      lastWorkingDay: emp.lastWorkingDay,

      attendance: {
        totalDays,
        lopDays: systemLop,
        lopAdjustment: manualLop,
        lopReversalDays: 0,
      },

      variablePay: {
        arrears: (arrearsByEmp.get(emp.id) ?? []).reduce((s, a) => s + Number(a.amount), 0),
        bonus: (bonusByEmp.get(emp.id) ?? []).reduce(
          (s, b) => s + Number(b.paidAmount ?? b.amount), 0),
        overtimeAmount: (otByEmp.get(emp.id) ?? []).reduce((s, o) => s + Number(o.amount), 0),
        shiftAllowance: (shiftByEmp.get(emp.id) ?? []).reduce((s, o) => s + Number(o.amount), 0),
        adhocPayments: [
          ...(adhocByEmp.get(emp.id) ?? [])
            .filter((a) => a.type === "PAYMENT")
            .map((a) => ({ name: a.name, amount: Number(a.amount), isTaxable: a.taxTreatment !== "NON_TAXABLE" })),
          ...(fbpUnclaimed > 0 ? [{ name: "Unclaimed flexible benefits", amount: fbpUnclaimed, isTaxable: true }] : []),
        ],
        adhocDeductions: (adhocByEmp.get(emp.id) ?? [])
          .filter((a) => a.type === "DEDUCTION")
          .map((a) => ({ name: a.name, amount: Number(a.amount) })),
        componentClaims: (claimsByEmp.get(emp.id) ?? []).map((c) => ({
          code: c.component.code,
          name: c.component.name,
          amount: Number(c.payableAmount ?? c.claimedAmount),
          isTaxable: c.component.taxTreatment === "FULLY_TAXABLE",
        })),
        perquisites: (perksByEmp.get(emp.id) ?? []).map((a) => ({
          code: a.perk.component.code,
          name: a.perk.component.name,
          amount: a.perk.valuationMethod === "PER_EMPLOYEE" ? Number(a.monthlyValue ?? 0) : a.perk.valuationMethod === "FIXED_FOR_ALL" ? Number(a.perk.fixedAmount ?? 0) : null,
          formula: a.perk.valuationMethod === "FORMULA" ? a.perk.formula : null,
          employerBearsTax: a.perk.taxBorneByEmployer,
          isTaxable: a.perk.isTaxable,
        })),
        loanEmis: (emiByEmp.get(emp.id) ?? []).map((i) => ({
          name: `${i.loan.category.name} EMI`,
          amount: Number(i.totalAmount),
        })),
      },

      statutory: {
        pfEnabled: payGroup.pfEnabled && (emp.statutoryProfile?.pfEnabled ?? true),
        pfCapAtCeiling: emp.statutoryProfile?.pfCapAtCeiling ?? filing?.pfCapAtCeiling ?? true,
        epsApplicable: emp.statutoryProfile?.epsApplicable ?? true,
        vpfAmount: emp.statutoryProfile?.vpfAmount ? Number(emp.statutoryProfile.vpfAmount) : undefined,
        vpfPercent: emp.statutoryProfile?.vpfPercent ? Number(emp.statutoryProfile.vpfPercent) : undefined,
        pfConfig: filing ? {
          wageCeiling: Number(filing.pfWageCeiling),
          capAtCeiling: filing.pfCapAtCeiling,
          employeeRate: Number(filing.pfEmployeeRate),
          employerRate: Number(filing.pfEmployerRate),
          epsRate: Number(filing.epsRate),
          epsWageCeiling: Number(filing.epsWageCeiling),
          edliRate: Number(filing.edliRate),
          adminRate: Number(filing.pfAdminRate),
        } : undefined,

        esiEnabled: payGroup.esiEnabled && (emp.statutoryProfile?.esiEnabled ?? true),
        esiCycleEndDate: emp.statutoryProfile?.esiCycleEndDate ?? null,
        esiConfig: filing ? {
          wageLimit: Number(filing.esiWageLimit),
          employeeRate: Number(filing.esiEmployeeRate),
          employerRate: Number(filing.esiEmployerRate),
          capAtLimit: true,
        } : undefined,

        ptEnabled: payGroup.ptEnabled && (emp.statutoryProfile?.ptEnabled ?? true) && !!ptEntry,
        ptSlabs: ptEntry?.slabs ?? [],
        ptFrequency: ptEntry?.frequency,
        ptCollectionMonths: ptEntry?.collectionMonths,
        ptYtdDeducted: ytd.pt,
        gender: emp.gender === "MALE" || emp.gender === "FEMALE" ? emp.gender : null,

        lwfEnabled: payGroup.lwfEnabled && (emp.statutoryProfile?.lwfEnabled ?? true),
        lwfRule,
        lwfProrateNewJoiners: true,
      },

      tax: {
        enabled: payGroup.tdsEnabled && !(emp.statutoryProfile?.tdsDisabled ?? false),
        regime,
        slabs: slabsFor(tables.taxSlabBands.get(regime), ageAtFyEnd(emp.dateOfBirth, fyStart)),
        config: tables.taxConfigs.get(regime)!,
        ytdTaxableIncome: ytd.gross,
        ytdTdsDeducted: ytd.tds,
        // Previous-employer figures count only in the FY the employee joined.
        previousEmployerIncome: previousApplies && emp.statutoryProfile?.previousEmployerIncome
          ? Number(emp.statutoryProfile.previousEmployerIncome) : undefined,
        previousEmployerTds: ((previousApplies ? Number(emp.statutoryProfile?.previousEmployerTds ?? 0) : 0) + declared.otherTds) || undefined,
        chapterViaDeductions: declared.chapterVia || undefined,
        employerNpsDeduction: declared.employerNps || undefined,
        housePropertyIncome: declared.houseProperty || undefined,
        otherIncome: declared.otherIncome || undefined,
        rentPaidAnnual: rentDeclared || undefined,
        isMetro: decl?.hraDetail?.isMetro ?? false,
        flatTdsAmount: emp.statutoryProfile?.flatTdsAmount
          ? Number(emp.statutoryProfile.flatTdsAmount) : null,
        tdsDisabled: emp.statutoryProfile?.tdsDisabled ?? false,
      },

      overrides: {
        pt: existing?.ptOverride === null || existing?.ptOverride === undefined
          ? null : Number(existing.ptOverride),
        esi: existing?.esiOverride === null || existing?.esiOverride === undefined
          ? null : Number(existing.esiOverride),
        tds: existing?.tdsOverride === null || existing?.tdsOverride === undefined
          ? null : Number(existing.tdsOverride),
        lwf: existing?.lwfOverride === null || existing?.lwfOverride === undefined
          ? null : Number(existing.lwfOverride),
      },
    };

    const result = calculatePayroll(input);
    allWarnings.push(
      ...result.warnings.map((w) => `${emp.employeeNumber} ${emp.firstName}: ${w}`),
    );
    results.push({ employee: emp, result });
  }

  // --- Persist ----------------------------------------------------------
  let totalGross = 0, totalNet = 0, totalDed = 0, totalEmployer = 0, counted = 0;

  await prisma.$transaction(async (tx) => {
    await tx.payslipLine.deleteMany({ where: { runEmployee: { runId } } });

    for (const { employee, result } of results) {
      const existing = existingByEmployee.get(employee.id);

      if (!result) {
        // On hold or voided: keep the row so the action is visible, but zero
        // every figure. No components, no statutory — per the documented
        // consequence of a processing hold.
        await tx.payrollRunEmployee.upsert({
          where: { runId_employeeId: { runId, employeeId: employee.id } },
          create: {
            runId, employeeId: employee.id,
            payAction: existing?.payAction ?? "HOLD_SALARY_PROCESSING",
            totalDays, payableDays: 0, calculatedAt: new Date(),
          },
          update: {
            grossEarnings: 0, totalDeductions: 0, employerCost: 0, netPay: 0,
            pfWage: 0, pfEmployee: 0, pfEmployer: 0, epsEmployer: 0, vpf: 0,
            esiGross: 0, esiEmployee: 0, esiEmployer: 0,
            professionalTax: 0, lwfEmployee: 0, lwfEmployer: 0, tds: 0,
            payableDays: 0, calculatedAt: new Date(),
          },
        });
        continue;
      }

      const row = await tx.payrollRunEmployee.upsert({
        where: { runId_employeeId: { runId, employeeId: employee.id } },
        create: {
          runId, employeeId: employee.id,
          payAction: existing?.payAction ?? "PROCESS_AS_SALARY",
          totalDays: result.totalDays,
          payableDays: result.payableDays.toNumber(),
          lopDays: result.lopDays.toNumber(),
          grossEarnings: result.grossEarnings.toNumber(),
          totalDeductions: result.totalDeductions.toNumber(),
          employerCost: result.employerCost.toNumber(),
          netPay: result.netPay.toNumber(),
          pfWage: result.pf.pfWage.toNumber(),
          pfEmployee: result.pf.employeeContribution.toNumber(),
          pfEmployer: result.pf.employerEpf.toNumber(),
          epsEmployer: result.pf.employerEps.toNumber(),
          vpf: result.pf.vpf.toNumber(),
          esiGross: result.esi.esiWage.toNumber(),
          esiEmployee: result.esi.employeeContribution.toNumber(),
          esiEmployer: result.esi.employerContribution.toNumber(),
          professionalTax: result.pt.amount.toNumber(),
          lwfEmployee: result.lwf.employeeContribution.toNumber(),
          lwfEmployer: result.lwf.employerContribution.toNumber(),
          tds: result.tds.toNumber(),
          annualCtc: result.structure.annualCtc.toNumber(),
          errors: result.warnings.length > 0 ? result.warnings : undefined,
          calculatedAt: new Date(),
        },
        update: {
          totalDays: result.totalDays,
          payableDays: result.payableDays.toNumber(),
          lopDays: result.lopDays.toNumber(),
          grossEarnings: result.grossEarnings.toNumber(),
          totalDeductions: result.totalDeductions.toNumber(),
          employerCost: result.employerCost.toNumber(),
          netPay: result.netPay.toNumber(),
          pfWage: result.pf.pfWage.toNumber(),
          pfEmployee: result.pf.employeeContribution.toNumber(),
          pfEmployer: result.pf.employerEpf.toNumber(),
          epsEmployer: result.pf.employerEps.toNumber(),
          vpf: result.pf.vpf.toNumber(),
          esiGross: result.esi.esiWage.toNumber(),
          esiEmployee: result.esi.employeeContribution.toNumber(),
          esiEmployer: result.esi.employerContribution.toNumber(),
          professionalTax: result.pt.amount.toNumber(),
          lwfEmployee: result.lwf.employeeContribution.toNumber(),
          lwfEmployer: result.lwf.employerContribution.toNumber(),
          tds: result.tds.toNumber(),
          annualCtc: result.structure.annualCtc.toNumber(),
          errors: result.warnings.length > 0 ? result.warnings : undefined,
          calculatedAt: new Date(),
        },
      });

      await tx.payslipLine.createMany({
        data: result.lines.map((l) => ({
          runEmployeeId: row.id,
          code: l.code,
          name: l.name,
          type: l.type,
          fullAmount: l.fullAmount.toNumber(),
          amount: l.amount.toNumber(),
          sequence: l.sequence,
          showOnPayslip: l.showOnPayslip,
        })),
      });

      totalGross += result.grossEarnings.toNumber();
      totalNet += result.netPay.toNumber();
      totalDed += result.totalDeductions.toNumber();
      totalEmployer += result.employerCost.toNumber();
      counted++;
    }

    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        employeeCount: counted,
        totalGross, totalNetPay: totalNet,
        totalDeductions: totalDed, totalEmployerCost: totalEmployer,
        status: run.status === "DRAFT" ? "IN_PROGRESS" : run.status,
      },
    });
  }, { timeout: 60_000 });

  return {
    employeeCount: counted,
    totalGross, totalNetPay: totalNet,
    totalDeductions: totalDed, totalEmployerCost: totalEmployer,
    warnings: allWarnings,
  };
}

/** Create a run for a pay group and period, seeding one row per employee. */
export async function createRun(opts: {
  tenantId: string;
  payGroupId: string;
  year: number;
  month: number;
}): Promise<string> {
  const periodStart = startOfMonth(opts.year, opts.month);
  const periodEnd = endOfMonth(opts.year, opts.month);

  const existing = await prisma.payrollRun.findFirst({
    where: {
      payGroupId: opts.payGroupId, year: opts.year, month: opts.month,
      type: "REGULAR", sequence: 0,
    },
  });
  if (existing) return existing.id;

  const run = await prisma.payrollRun.create({
    data: {
      tenantId: opts.tenantId,
      payGroupId: opts.payGroupId,
      year: opts.year,
      month: opts.month,
      periodStart, periodEnd,
      payDate: periodEnd,
      type: "REGULAR",
      sequence: 0,
      status: "DRAFT",
      currentStep: 1,
    },
  });

  const employees = await eligibleEmployees(opts.payGroupId, periodStart, periodEnd);
  if (employees.length > 0) {
    await prisma.payrollRunEmployee.createMany({
      data: employees.map((e) => ({
        runId: run.id,
        employeeId: e.id,
        totalDays: daysInMonth(opts.year, opts.month),
        payAction: "PROCESS_AS_SALARY" as const,
      })),
      skipDuplicates: true,
    });
  }

  return run.id;
}
