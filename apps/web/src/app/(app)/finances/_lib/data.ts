import "server-only";
import { prisma } from "@keka/db";
import {
  resolveStructure, calculateAnnualTax, compareRegimes, calculateHraExemption,
  type AnnualTaxResult, type ResolvedStructure,
} from "@keka/payroll";
import { loadStatutoryTables, slabsFor, ageAtFyEnd, previousIncomeApplies } from "@keka/services";
import { fyMonths, fyRange, fyStartYear } from "@keka/shared";
import type { Viewer } from "@/lib/context";
import { cappedDeductions, declarationWindows, regimeSwitchState, type DeductionTotals, type WindowState } from "./rules";

/**
 * Data loaders for My Finances. Every query is pinned to the viewer's own
 * employee id and tenant: these pages show one person their own money and
 * nothing else.
 */

const n = (v: unknown) => Number(v ?? 0);

type StructureWithComponents = {
  roundComponents: boolean;
  components: Array<{
    calculationType: "FIXED" | "PERCENTAGE" | "FORMULA" | "BALANCE";
    formula: string | null; fixedAmount: unknown; percentage: unknown; percentageOf: string | null; sequence: number;
    component: {
      code: string; name: string; type: "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION" | "REIMBURSEMENT" | "PERK";
      isOutsideCtc: boolean; isLopApplicable: boolean; affectsPfWage: boolean; affectsEsiGross: boolean; showOnPayslip: boolean; isPartOfFbp: boolean;
    };
  }>;
};

export const STRUCTURE_INCLUDE = { components: { include: { component: true } } } as const;

/** The component split a salary structure produces for one CTC. */
export function resolveFor(annualCtc: unknown, structure: StructureWithComponents | null): ResolvedStructure | null {
  if (!structure) return null;
  return resolveStructure({
    annualCtc: n(annualCtc),
    components: structure.components.map((sc) => ({
      code: sc.component.code,
      name: sc.component.name,
      type: sc.component.type,
      calculationType: sc.calculationType,
      formula: sc.formula,
      fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
      percentage: sc.percentage === null ? null : Number(sc.percentage),
      percentageOf: sc.percentageOf,
      sequence: sc.sequence,
      isOutsideCtc: sc.component.isOutsideCtc,
      isLopApplicable: sc.component.isLopApplicable,
      affectsPfWage: sc.component.affectsPfWage,
      affectsEsiGross: sc.component.affectsEsiGross,
      showOnPayslip: sc.component.showOnPayslip,
      isPartOfFbp: sc.component.isPartOfFbp,
    })),
    roundComponents: structure.roundComponents,
  });
}

/** Financial years the viewer has something in, newest first, always including the current one. */
export async function financialYears(viewer: Viewer): Promise<number[]> {
  const employeeId = viewer.employee!.id;
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const current = fyStartYear(new Date(), fyStartMonth);
  const [runs, decls] = await Promise.all([
    prisma.payrollRunEmployee.findMany({
      where: { employeeId, run: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null } },
      select: { run: { select: { year: true, month: true } } },
    }),
    prisma.investmentDeclaration.findMany({ where: { employeeId }, select: { fyStartYear: true } }),
  ]);
  const set = new Set<number>([current]);
  for (const r of runs) set.add(r.run.month >= fyStartMonth ? r.run.year : r.run.year - 1);
  for (const d of decls) set.add(d.fyStartYear);
  return [...set].filter((y) => y <= current).sort((a, b) => b - a);
}

export function pickFy(raw: string | undefined, years: number[]): number {
  const y = Number(raw);
  return years.includes(y) ? y : years[0];
}

export interface MonthRow {
  year: number;
  month: number;
  /** processed: a finalised run paid it; projected: still to come; none: not employed. */
  kind: "processed" | "projected" | "none";
  gross: number;
  tds: number;
}

export interface TaxPicture {
  fy: number;
  currentFy: number;
  regime: "OLD" | "NEW";
  age: number;
  /** Null when the tax tables for the year are missing. */
  result: AnnualTaxResult | null;
  comparison: { old: AnnualTaxResult; new: AnnualTaxResult; better: "OLD" | "NEW"; saving: number } | null;
  missingTables: boolean;

  actualGross: number;
  projectedGross: number;
  monthlyGross: number;
  processedMonths: number;
  projectedMonths: number;
  reimbursements: number;
  previousIncome: number;
  hraExemption: number;
  professionalTax: number;
  deductions: DeductionTotals;

  tdsDeducted: number;
  previousTds: number;
  otherTds: number;
  taxPaid: number;
  totalTax: number;
  remaining: number;
  perProjectedMonth: number;
  months: MonthRow[];
  /** Taxable earnings by component and month: paid where processed, at the current structure where projected. */
  grid: Array<{ code: string; name: string; cells: number[]; total: number }>;
  /** Whether previous-employer figures belong to this FY (the year of joining). */
  previousApplies: boolean;

  declaration: Awaited<ReturnType<typeof loadDeclaration>>;
  profile: {
    taxRegime: "OLD" | "NEW"; regimeLockedAt: Date | null;
    previousEmployerIncome: number | null; previousEmployerTds: number | null; previousEmployerPf: number | null; previousEmployerPt: number | null;
  } | null;
  payGroup: {
    id: string; name: string; frequency: string; allowRegimeChoice: boolean; regimeChangeCutoff: Date | null;
    proofMandatory: boolean; proofSubmissionDue: Date | null;
  } | null;
  windows: { declaration: WindowState; proof: WindowState };
  regimeSwitch: { allowed: boolean; note: string };
}

async function loadDeclaration(employeeId: string, fy: number) {
  return prisma.investmentDeclaration.findUnique({
    where: { employeeId_fyStartYear: { employeeId, fyStartYear: fy } },
    include: { items: { orderBy: [{ section: "asc" }, { id: "asc" }] }, hraDetail: true },
  });
}

/**
 * The year's income-tax picture for the viewer: what has been paid, what is
 * projected for the months still to run at the current salary, the
 * declarations that count, the liability under each regime and how the
 * balance spreads over the remaining months.
 *
 * Declared amounts count until a reviewer rules on the proof; after that the
 * accepted amount does. Previous-employer figures apply to the year the
 * employee joined in only — the profile does not record a year, and any
 * other year was either before them or entirely with this employer.
 */
export async function loadTaxPicture(viewer: Viewer, fy: number): Promise<TaxPicture> {
  const employeeId = viewer.employee!.id;
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const now = new Date();
  const currentFy = fyStartYear(now, fyStartMonth);
  const { end } = fyRange(fy, fyStartMonth);
  const months = fyMonths(fy, fyStartMonth);

  const [emp, declaration, runLines, revision] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      select: {
        dateOfBirth: true, dateOfJoining: true, lastWorkingDay: true,
        statutoryProfile: true,
        payGroup: {
          select: {
            id: true, name: true, frequency: true, tdsEnabled: true,
            declarationOpenDay: true, declarationCloseDay: true, declarationFyCutoff: true, newJoinerWindowDays: true,
            proofSubmissionDue: true, proofMandatory: true, allowLateDeclaration: true, allowRegimeChoice: true, regimeChangeCutoff: true,
          },
        },
      },
    }),
    loadDeclaration(employeeId, fy),
    prisma.payrollRunEmployee.findMany({
      where: {
        employeeId,
        run: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null, OR: months.map((m) => ({ year: m.year, month: m.month })) },
      },
      select: {
        grossEarnings: true, tds: true, professionalTax: true,
        run: { select: { year: true, month: true } },
        lines: { where: { type: { in: ["EARNING", "REIMBURSEMENT"] } }, orderBy: { sequence: "asc" }, select: { code: true, name: true, type: true, amount: true } },
      },
    }),
    prisma.salaryRevision.findFirst({
      where: { employeeId, status: "APPLIED", effectiveFrom: { lte: end } },
      orderBy: { effectiveFrom: "desc" },
      include: { structure: { include: STRUCTURE_INCLUDE } },
    }),
  ]);
  if (!emp) throw new Error("Employee record not found.");

  const profile = emp.statutoryProfile;
  const regime: "OLD" | "NEW" = fy === currentFy ? (profile?.taxRegime ?? "NEW") : (declaration?.regime ?? profile?.taxRegime ?? "NEW");
  const age = ageAtFyEnd(emp.dateOfBirth, fy);

  // --- Income, month by month ---------------------------------------------
  const resolved = resolveFor(revision?.annualCtc, revision?.structure ?? null);
  const monthlyGross = resolved ? resolved.monthlyGross.toNumber() : 0;
  const comp = (code: string) => resolved?.byCode.get(code)?.monthly.toNumber() ?? 0;

  const byMonth = new Map<string, typeof runLines>();
  for (const l of runLines) {
    const k = `${l.run.year}-${l.run.month}`;
    byMonth.set(k, [...(byMonth.get(k) ?? []), l]);
  }
  const employed = (y: number, m: number) => {
    const mStart = new Date(Date.UTC(y, m - 1, 1)), mEnd = new Date(Date.UTC(y, m, 0));
    return emp.dateOfJoining <= mEnd && (!emp.lastWorkingDay || emp.lastWorkingDay >= mStart);
  };

  let lastPt = 0;
  const rows: MonthRow[] = months.map(({ year, month }) => {
    const ls = byMonth.get(`${year}-${month}`);
    if (ls?.length) {
      const pt = ls.reduce((s, l) => s + n(l.professionalTax), 0);
      if (pt > 0) lastPt = pt;
      return { year, month, kind: "processed", gross: ls.reduce((s, l) => s + n(l.grossEarnings), 0), tds: ls.reduce((s, l) => s + n(l.tds), 0) };
    }
    if (employed(year, month) && monthlyGross > 0) return { year, month, kind: "projected", gross: monthlyGross, tds: 0 };
    return { year, month, kind: "none", gross: 0, tds: 0 };
  });
  const processed = rows.filter((r) => r.kind === "processed");
  const projected = rows.filter((r) => r.kind === "projected");
  const actualGross = processed.reduce((s, r) => s + r.gross, 0);
  const projectedGross = projected.reduce((s, r) => s + r.gross, 0);
  const allLines = runLines.flatMap((l) => l.lines);
  const sumCode = (code: string) => allLines.filter((l) => l.code === code && l.type !== "REIMBURSEMENT").reduce((s, l) => s + n(l.amount), 0);
  const reimbursements = allLines.filter((l) => l.type === "REIMBURSEMENT").reduce((s, l) => s + n(l.amount), 0);
  const ptActual = runLines.reduce((s, l) => s + n(l.professionalTax), 0);
  const professionalTax = Math.min(2500, ptActual + lastPt * projected.length);

  // --- Declarations ---------------------------------------------------------
  const items = (declaration?.items ?? []).map((i) => ({
    section: i.section, declaredAmount: n(i.declaredAmount), approvedAmount: n(i.approvedAmount), proofStatus: i.proofStatus,
  }));
  const deductions = cappedDeductions(items, age);

  let hraExemption = 0;
  const hra = declaration?.hraDetail;
  if (hra) {
    const rent = hra.annualRent !== null
      ? n(hra.annualRent)
      : Object.values((hra.monthlyRent ?? {}) as Record<string, unknown>).reduce<number>((s, v) => s + n(v), 0);
    if (rent > 0) {
      hraExemption = calculateHraExemption({
        hraReceived: sumCode("HRA") + comp("HRA") * projected.length,
        rentPaid: rent,
        salaryForHra: sumCode("BASIC") + sumCode("DA") + (comp("BASIC") + comp("DA")) * projected.length,
        isMetro: hra.isMetro,
      }).exemption.toNumber();
    }
  }

  const isCurrent = fy === currentFy;
  // Previous-employer figures belong to the FY the employee joined in, and only that one.
  const previousApplies = previousIncomeApplies(emp.dateOfJoining, fy, fyStartMonth);
  const previousIncome = previousApplies ? n(profile?.previousEmployerIncome) : 0;
  const previousTds = previousApplies ? n(profile?.previousEmployerTds) : 0;

  // --- Gross earnings, component by month (section A of the computation) -----
  const gridRows = new Map<string, { code: string; name: string; cells: number[] }>();
  const cell = (code: string, name: string, i: number, amount: number) => {
    const row = gridRows.get(code) ?? { code, name, cells: months.map(() => 0) };
    row.cells[i] += amount;
    gridRows.set(code, row);
  };
  rows.forEach((r, i) => {
    if (r.kind === "processed") {
      for (const l of byMonth.get(`${r.year}-${r.month}`) ?? []) for (const x of l.lines) if (x.type === "EARNING") cell(x.code, x.name, i, n(x.amount));
    } else if (r.kind === "projected" && resolved) {
      for (const c of resolved.components) if (c.type === "EARNING" && !c.monthly.isZero()) cell(c.code, c.name, i, c.monthly.toNumber());
    }
  });
  const grid = [...gridRows.values()].map((g) => ({ ...g, total: g.cells.reduce((a, b) => a + b, 0) })).filter((g) => g.total !== 0);

  // --- Tax --------------------------------------------------------------------
  let result: AnnualTaxResult | null = null;
  let comparison: TaxPicture["comparison"] = null;
  let missingTables = true;
  if (emp.payGroup) {
    const tables = await loadStatutoryTables(emp.payGroup.id, fy, end);
    const oldCfg = tables.taxConfigs.get("OLD"), newCfg = tables.taxConfigs.get("NEW");
    const base = {
      grossSalary: actualGross + projectedGross,
      exemptAllowances: hraExemption,
      exemptReimbursements: reimbursements,
      previousEmployerIncome: previousIncome || undefined,
      housePropertyIncome: deductions.houseProperty,
      otherIncome: deductions.otherIncome,
      chapterViaDeductions: deductions.chapterVia,
      professionalTax,
      employerNpsDeduction: deductions.employerNps,
    };
    if (oldCfg && newCfg) {
      missingTables = false;
      const c = compareRegimes(
        base,
        slabsFor(tables.taxSlabBands.get("OLD"), age), oldCfg,
        slabsFor(tables.taxSlabBands.get("NEW"), age), newCfg,
      );
      comparison = { old: c.old, new: c.new, better: c.better, saving: c.saving.toNumber() };
      result = regime === "OLD" ? c.old : c.new;
    } else {
      const cfg = tables.taxConfigs.get(regime);
      if (cfg) {
        missingTables = false;
        result = calculateAnnualTax({ ...base, regime, slabs: slabsFor(tables.taxSlabBands.get(regime), age), config: cfg });
      }
    }
  }
  if (emp.payGroup && !emp.payGroup.tdsEnabled) result = null;

  const tdsDeducted = processed.reduce((s, r) => s + r.tds, 0);
  const taxPaid = tdsDeducted + previousTds + deductions.otherTds;
  const totalTax = result ? result.totalTaxLiability.toNumber() : 0;
  const remaining = Math.max(0, totalTax - taxPaid);
  const perProjectedMonth = projected.length ? Math.round(remaining / projected.length) : 0;
  for (const r of rows) if (r.kind === "projected") r.tds = perProjectedMonth;

  // --- Windows ----------------------------------------------------------------
  const windows = declarationWindows(emp.payGroup, {
    fy, currentFy, now, joinedOn: emp.dateOfJoining, locked: declaration?.status === "LOCKED", fyStartMonth,
  });
  const pg = emp.payGroup;
  const regimeSwitch = regimeSwitchState(pg, profile?.regimeLockedAt ?? null, { isCurrentFy: isCurrent, now });

  return {
    fy, currentFy, regime, age, result, comparison, missingTables,
    actualGross, projectedGross, monthlyGross, processedMonths: processed.length, projectedMonths: projected.length,
    reimbursements, previousIncome, hraExemption, professionalTax, deductions,
    tdsDeducted, previousTds, otherTds: deductions.otherTds, taxPaid, totalTax, remaining, perProjectedMonth, months: rows, grid, previousApplies,
    declaration,
    profile: profile ? {
      taxRegime: profile.taxRegime, regimeLockedAt: profile.regimeLockedAt,
      previousEmployerIncome: profile.previousEmployerIncome === null ? null : n(profile.previousEmployerIncome),
      previousEmployerTds: profile.previousEmployerTds === null ? null : n(profile.previousEmployerTds),
      previousEmployerPf: profile.previousEmployerPf === null ? null : n(profile.previousEmployerPf),
      previousEmployerPt: profile.previousEmployerPt === null ? null : n(profile.previousEmployerPt),
    } : null,
    payGroup: pg ? {
      id: pg.id, name: pg.name, frequency: pg.frequency, allowRegimeChoice: pg.allowRegimeChoice, regimeChangeCutoff: pg.regimeChangeCutoff,
      proofMandatory: pg.proofMandatory, proofSubmissionDue: pg.proofSubmissionDue,
    } : null,
    windows,
    regimeSwitch,
  };
}
