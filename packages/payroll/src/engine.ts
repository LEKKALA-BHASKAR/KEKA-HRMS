import {
  Decimal, money, nonNegative, roundRupees, divide,
  daysInMonth, monthsRemainingInFy, fyStartYear, type Numeric,
} from "@keka/shared";
import { evaluateFormula } from "./formula";
import { resolveStructure, type ResolvedStructure, type StructureComponentSpec, type ResolvedComponent } from "./structure";
import { calculatePf, type PfConfig, type PfResult } from "./statutory/pf";
import { calculateEsi, type EsiConfig, type EsiResult } from "./statutory/esi";
import { calculatePt, type PtSlab, type PtFrequency, type PtResult } from "./statutory/pt";
import { calculateLwf, type LwfRule, type LwfResult } from "./statutory/lwf";
import {
  calculateAnnualTax, calculateMonthlyTds, calculateHraExemption,
  type TaxRegime, type TaxSlab, type TaxConfig, type AnnualTaxResult,
} from "./statutory/tax";

/**
 * The per-employee payroll calculation.
 *
 * This is the single place where attendance, compensation and statute meet.
 * It is deliberately a pure function: no database, no I/O, no clock. Give it
 * the same inputs and it produces the same payslip, which is what makes a
 * payroll run reproducible and auditable.
 *
 * Order of operations matters and follows Indian payroll convention:
 *   1. resolve the structure into full monthly entitlements
 *   2. prorate earnings for loss of pay
 *   3. add variable pay (arrears, bonus, overtime, ad-hoc, claims)
 *   4. compute PF and ESI on the prorated wage bases
 *   5. compute PT and LWF from the employee's work state
 *   6. project annual income and back out this month's TDS
 *   7. subtract deductions and recoveries to reach net pay
 */

export interface AttendanceInput {
  /** Calendar days in the pay period. */
  totalDays?: number;
  /** Loss-of-pay days, already net of reversals. */
  lopDays?: Numeric;
  /** Manual adjustment applied on top of the system figure. */
  lopAdjustment?: Numeric;
  /** LOP days reversed from earlier months. */
  lopReversalDays?: Numeric;
  /** For daily, hourly and per-unit staff. */
  payableUnits?: Numeric | null;
  unitRate?: Numeric | null;
}

export interface VariablePayInput {
  /** Arrears from back-dated revisions, hold releases or LOP reversals. */
  arrears?: Numeric;
  bonus?: Numeric;
  overtimeAmount?: Numeric;
  shiftAllowance?: Numeric;
  /** Approved reimbursement and FBP claims paid this month. */
  componentClaims?: Array<{ code: string; name: string; amount: Numeric; isTaxable: boolean }>;
  adhocPayments?: Array<{ name: string; amount: Numeric; isTaxable: boolean }>;
  adhocDeductions?: Array<{ name: string; amount: Numeric }>;
  /** Loan EMIs falling due this month. */
  loanEmis?: Array<{ name: string; amount: Numeric }>;
  /**
   * Perquisites: non-cash benefits whose monthly value is taxable salary.
   * Valued at a fixed amount or by a formula over the structure (e.g.
   * "[BASIC] * 0.1"). When the employer bears the tax, the value is shown
   * but kept out of the employee's taxable income.
   */
  perquisites?: Array<{ code: string; name: string; amount?: Numeric | null; formula?: string | null; employerBearsTax?: boolean; isTaxable?: boolean }>;
}

export interface StatutoryInput {
  pfEnabled: boolean;
  pfConfig?: Partial<PfConfig>;
  pfCapAtCeiling?: boolean | null;
  epsApplicable?: boolean;
  vpfAmount?: Numeric;
  vpfPercent?: Numeric;
  /** Employer PF inside CTC is already a structure component; avoid double-count. */
  pfEmployerInStructure?: boolean;

  esiEnabled: boolean;
  esiConfig?: Partial<EsiConfig>;
  esiCycleEndDate?: Date | null;

  ptEnabled: boolean;
  ptSlabs?: PtSlab[];
  ptFrequency?: PtFrequency;
  ptCollectionMonths?: number[];
  ptSpreadAcrossPeriod?: boolean;
  ptYtdDeducted?: Numeric;
  gender?: "MALE" | "FEMALE" | null;

  lwfEnabled: boolean;
  lwfRule?: LwfRule | null;
  lwfProrateNewJoiners?: boolean;
}

export interface TaxInput {
  enabled: boolean;
  regime: TaxRegime;
  slabs: TaxSlab[];
  config: TaxConfig;
  /** Taxable pay already drawn this FY, from the pay register. */
  ytdTaxableIncome?: Numeric;
  /** TDS already deducted this FY. */
  ytdTdsDeducted?: Numeric;
  previousEmployerIncome?: Numeric;
  previousEmployerTds?: Numeric;
  /** Approved investment declarations. */
  chapterViaDeductions?: Numeric;
  /** Rent declared, for the HRA exemption. */
  rentPaidAnnual?: Numeric;
  isMetro?: boolean;
  housePropertyIncome?: Numeric;
  otherIncome?: Numeric;
  employerNpsDeduction?: Numeric;
  /** Professional tax projected for the full year. */
  annualProfessionalTax?: Numeric;

  flatTdsAmount?: Numeric | null;
  tdsOverride?: Numeric | null;
  tdsDisabled?: boolean;
}

export interface CalculatePayrollInput {
  employeeId: string;
  year: number;
  /** 1-12. */
  month: number;
  fyStartMonth?: number;

  annualCtc: Numeric;
  structureComponents: StructureComponentSpec[];
  roundComponents?: boolean;

  /** Employee joined or left part-way through the period. */
  joiningDate?: Date | null;
  lastWorkingDay?: Date | null;

  attendance?: AttendanceInput;
  variablePay?: VariablePayInput;
  statutory: StatutoryInput;
  tax: TaxInput;

  /** Step 6 overrides. Null means no override. */
  overrides?: {
    pt?: Numeric | null;
    esi?: Numeric | null;
    tds?: Numeric | null;
    lwf?: Numeric | null;
    note?: string | null;
  };
}

export interface PayslipLineResult {
  code: string;
  name: string;
  type: "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION" | "REIMBURSEMENT" | "PERK";
  /** Full monthly entitlement before proration. */
  fullAmount: Decimal;
  /** Actual amount after LOP and overrides. */
  amount: Decimal;
  showOnPayslip: boolean;
  sequence: number;
}

export interface CalculatePayrollResult {
  employeeId: string;
  year: number;
  month: number;

  totalDays: number;
  payableDays: Decimal;
  lopDays: Decimal;
  prorationFactor: Decimal;

  lines: PayslipLineResult[];

  grossEarnings: Decimal;
  totalDeductions: Decimal;
  employerCost: Decimal;
  netPay: Decimal;

  pf: PfResult;
  esi: EsiResult;
  pt: PtResult;
  lwf: LwfResult;
  tds: Decimal;
  tdsComputed: Decimal;
  annualTax: AnnualTaxResult | null;

  pfWage: Decimal;
  esiGross: Decimal;
  taxableGrossThisMonth: Decimal;

  warnings: string[];
  notes: string[];
  structure: ResolvedStructure;
}

const ZERO = new Decimal(0);

export function calculatePayroll(input: CalculatePayrollInput): CalculatePayrollResult {
  const warnings: string[] = [];
  const notes: string[] = [];

  const totalDays = input.attendance?.totalDays ?? daysInMonth(input.year, input.month);

  // --- 1. Resolve the structure -----------------------------------------
  const structure = resolveStructure({
    annualCtc: input.annualCtc,
    components: input.structureComponents,
    roundComponents: input.roundComponents,
  });
  warnings.push(...structure.warnings);

  // --- 2. Attendance and proration --------------------------------------
  const rawLop = nonNegative(input.attendance?.lopDays)
    .plus(money(input.attendance?.lopAdjustment ?? 0))
    .minus(nonNegative(input.attendance?.lopReversalDays));
  const lopDays = nonNegative(rawLop);

  // A mid-period joiner or leaver is not payable for the days outside their
  // employment, on top of any LOP.
  let unpayableCalendarDays = new Decimal(0);
  if (input.joiningDate) {
    const j = input.joiningDate;
    if (j.getUTCFullYear() === input.year && j.getUTCMonth() + 1 === input.month) {
      unpayableCalendarDays = unpayableCalendarDays.plus(j.getUTCDate() - 1);
      notes.push(`Joined on day ${j.getUTCDate()} — earnings prorated`);
    }
  }
  if (input.lastWorkingDay) {
    const l = input.lastWorkingDay;
    if (l.getUTCFullYear() === input.year && l.getUTCMonth() + 1 === input.month) {
      unpayableCalendarDays = unpayableCalendarDays.plus(totalDays - l.getUTCDate());
      notes.push(`Last working day is ${l.getUTCDate()} — earnings prorated`);
    }
  }

  const payableDays = nonNegative(
    new Decimal(totalDays).minus(lopDays).minus(unpayableCalendarDays),
  );
  const prorationFactor = totalDays === 0
    ? ZERO
    : payableDays.dividedBy(totalDays);

  if (lopDays.greaterThan(0)) {
    notes.push(`${lopDays.toFixed(2)} day(s) of loss of pay`);
  }

  // --- 3. Prorate the structure ------------------------------------------
  const lines: PayslipLineResult[] = [];
  const proratedByCode = new Map<string, Decimal>();

  const isUnitBased = input.attendance?.payableUnits != null && input.attendance?.unitRate != null;

  for (const c of structure.components) {
    // Employer contributions computed by the statutory engine are added
    // later; a structure row for them would double-count.
    const isStatutoryEmployerRow =
      c.type === "EMPLOYER_CONTRIBUTION" &&
      ["PF_EMPLOYER", "ESI_EMPLOYER", "LWF_EMPLOYER", "EPS"].includes(c.code);

    let amount = c.monthly;
    if (c.isLopApplicable && c.type !== "DEDUCTION") {
      amount = c.monthly.times(prorationFactor);
    }
    amount = roundRupees(amount);

    proratedByCode.set(c.code, amount);

    // A flexible-benefit reimbursement is carved out of the CTC but paid
    // only when claimed (as a component claim), never as a monthly line.
    const isClaimOnly = c.type === "REIMBURSEMENT" && c.isPartOfFbp;

    if (!isStatutoryEmployerRow && !isClaimOnly) {
      lines.push({
        code: c.code,
        name: c.name,
        type: c.type,
        fullAmount: c.monthly,
        amount,
        showOnPayslip: c.showOnPayslip,
        sequence: c.sequence,
      });
    }
  }

  // Unit-based staff are paid on units, not on the structure's earnings.
  if (isUnitBased) {
    const units = money(input.attendance!.payableUnits);
    const rate = money(input.attendance!.unitRate);
    const unitPay = roundRupees(units.times(rate));
    // Drop structure earnings and replace them with the unit total.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].type === "EARNING") lines.splice(i, 1);
    }
    lines.push({
      code: "UNIT_PAY",
      name: "Payable Units",
      type: "EARNING",
      fullAmount: unitPay,
      amount: unitPay,
      showOnPayslip: true,
      sequence: 1,
    });
    notes.push(`${units.toFixed(2)} unit(s) at ${rate.toFixed(2)}`);
  }

  // --- 4. Variable pay ---------------------------------------------------
  const vp = input.variablePay ?? {};
  const pushEarning = (code: string, name: string, amount: Numeric, seq: number, type: PayslipLineResult["type"] = "EARNING") => {
    const value = roundRupees(money(amount));
    if (value.isZero()) return;
    lines.push({ code, name, type, fullAmount: value, amount: value, showOnPayslip: true, sequence: seq });
  };

  pushEarning("ARREARS", "Arrears", vp.arrears ?? 0, 900);
  pushEarning("BONUS", "Bonus", vp.bonus ?? 0, 901);
  pushEarning("OVERTIME", "Overtime", vp.overtimeAmount ?? 0, 902);
  pushEarning("SHIFT_ALLOWANCE", "Shift Allowance", vp.shiftAllowance ?? 0, 903);

  for (const [i, p] of (vp.adhocPayments ?? []).entries()) {
    pushEarning(`ADHOC_PAY_${i + 1}`, p.name, p.amount, 910 + i);
  }
  // Reimbursement claims are paid but are not taxable income.
  for (const [i, c] of (vp.componentClaims ?? []).entries()) {
    const value = roundRupees(money(c.amount));
    if (value.isZero()) continue;
    lines.push({
      code: c.code || `CLAIM_${i + 1}`,
      name: c.name,
      type: c.isTaxable ? "EARNING" : "REIMBURSEMENT",
      fullAmount: value,
      amount: value,
      showOnPayslip: true,
      sequence: 930 + i,
    });
  }

  // Perquisites: shown, taxed, never paid in cash.
  let taxablePerquisites = new Decimal(0);
  if (vp.perquisites?.length) {
    const values: Record<string, Decimal> = { CTC: structure.annualCtc, CTC_ANNUAL: structure.annualCtc, CTC_MONTHLY: structure.annualCtc.dividedBy(12) };
    for (const c of structure.components) { values[c.code] = c.monthly; values[`${c.code}_ANNUAL`] = c.annual; }
    for (const [i, p] of vp.perquisites.entries()) {
      const value = roundRupees(nonNegative(p.formula ? evaluateFormula(p.formula, { values }) : money(p.amount ?? 0)));
      if (value.isZero()) continue;
      lines.push({ code: p.code || `PERK_${i + 1}`, name: p.name, type: "PERK", fullAmount: value, amount: value, showOnPayslip: true, sequence: 950 + i });
      if (p.isTaxable === false) continue;
      if (p.employerBearsTax) notes.push(`${p.name}: tax on the perquisite is borne by the employer`);
      else taxablePerquisites = taxablePerquisites.plus(value);
    }
  }

  // --- 5. Statutory ------------------------------------------------------
  const earningLines = () => lines.filter((l) => l.type === "EARNING");

  // PF wage: the structure components flagged as PF-qualifying, prorated.
  const pfWageBase = structure.components
    .filter((c) => c.affectsPfWage)
    .reduce((s, c) => s.plus(proratedByCode.get(c.code) ?? ZERO), new Decimal(0));

  const pf = calculatePf({
    pfWageBase,
    enabled: input.statutory.pfEnabled,
    capAtCeiling: input.statutory.pfCapAtCeiling,
    epsApplicable: input.statutory.epsApplicable,
    vpfAmount: input.statutory.vpfAmount,
    vpfPercent: input.statutory.vpfPercent,
    // The base is already prorated, so the ceiling must prorate to match.
    prorationFactor,
    config: input.statutory.pfConfig,
  });

  // ESI gross: all earnings flagged as ESI-qualifying.
  const esiQualifyingCodes = new Set(
    structure.components.filter((c) => c.affectsEsiGross).map((c) => c.code),
  );
  const esiGross = earningLines().reduce((s, l) => {
    // Variable pay counts toward ESI unless the structure says otherwise.
    const counts = esiQualifyingCodes.has(l.code) || !structure.byCode.has(l.code);
    return counts ? s.plus(l.amount) : s;
  }, new Decimal(0));

  const fullMonthlyEsiGross = structure.components
    .filter((c) => c.affectsEsiGross)
    .reduce((s, c) => s.plus(c.monthly), new Decimal(0));

  const periodEnd = new Date(Date.UTC(input.year, input.month, 0));
  const esi = calculateEsi({
    esiGross,
    fullMonthlyGross: fullMonthlyEsiGross,
    enabled: input.statutory.esiEnabled,
    arrears: vp.arrears ?? 0,
    cycleEndDate: input.statutory.esiCycleEndDate,
    periodEnd,
    config: input.statutory.esiConfig,
  });

  const monthlyGrossForPt = earningLines().reduce((s, l) => s.plus(l.amount), new Decimal(0));

  const pt = calculatePt({
    enabled: input.statutory.ptEnabled,
    monthlyGross: monthlyGrossForPt,
    month: input.month,
    slabs: input.statutory.ptSlabs ?? [],
    frequency: input.statutory.ptFrequency,
    gender: input.statutory.gender,
    ytdDeducted: input.statutory.ptYtdDeducted,
    collectionMonths: input.statutory.ptCollectionMonths,
    spreadAcrossPeriod: input.statutory.ptSpreadAcrossPeriod,
  });

  const lwf = calculateLwf({
    enabled: input.statutory.lwfEnabled,
    rule: input.statutory.lwfRule ?? null,
    month: input.month,
    monthlyGross: monthlyGrossForPt,
    prorateNewJoiners: input.statutory.lwfProrateNewJoiners,
    prorationFactor,
  });

  notes.push(...pf.notes, ...esi.notes, ...pt.notes, ...lwf.notes);

  // Apply step-6 overrides.
  const ov = input.overrides ?? {};
  const ptAmount = ov.pt != null ? money(ov.pt) : pt.amount;
  const esiEmployee = ov.esi != null ? money(ov.esi) : esi.employeeContribution;
  const lwfEmployee = ov.lwf != null ? money(ov.lwf) : lwf.employeeContribution;
  if (ov.pt != null) notes.push("Professional tax overridden");
  if (ov.esi != null) notes.push("ESI overridden");
  if (ov.lwf != null) notes.push("LWF overridden");

  // --- 6. Income tax -----------------------------------------------------
  const taxableThisMonth = lines
    .filter((l) => l.type === "EARNING")
    .reduce((s, l) => s.plus(l.amount), new Decimal(0))
    .plus(taxablePerquisites);

  let annualTax: AnnualTaxResult | null = null;
  let tdsAmount = ZERO;
  let tdsComputed = ZERO;

  if (input.tax.enabled) {
    const fyStart = input.fyStartMonth ?? 4;
    const remaining = monthsRemainingInFy(input.year, input.month, fyStart);
    const monthsElapsed = 12 - remaining;

    // Project the full-year figure: what has actually been drawn, plus this
    // month, plus the regular monthly gross for every month still to come.
    const ytdTaxable = nonNegative(input.tax.ytdTaxableIncome);
    // Perquisites recur, so they are projected forward like salary.
    const regularMonthlyGross = structure.components
      .filter((c) => c.type === "EARNING")
      .reduce((s, c) => s.plus(c.monthly), new Decimal(0))
      .plus(taxablePerquisites);
    const projectedRemaining = regularMonthlyGross.times(Math.max(0, remaining - 1));
    const projectedAnnualGross = ytdTaxable.plus(taxableThisMonth).plus(projectedRemaining);

    // HRA exemption, old regime only.
    let exemptAllowances = ZERO;
    if (input.tax.regime === "OLD" && input.tax.rentPaidAnnual) {
      const hraComponent = structure.byCode.get("HRA");
      const basicComponent = structure.byCode.get("BASIC");
      const daComponent = structure.byCode.get("DA");
      const salaryForHra = (basicComponent?.annual ?? ZERO).plus(daComponent?.annual ?? ZERO);
      const hra = calculateHraExemption({
        hraReceived: hraComponent?.annual ?? 0,
        rentPaid: input.tax.rentPaidAnnual,
        salaryForHra,
        isMetro: input.tax.isMetro ?? false,
      });
      exemptAllowances = hra.exemption;
      notes.push(`HRA exemption of ${hra.exemption.toFixed(2)} applied`);
    }

    // Reimbursements are outside taxable income entirely.
    const exemptReimbursements = lines
      .filter((l) => l.type === "REIMBURSEMENT")
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));

    annualTax = calculateAnnualTax({
      regime: input.tax.regime,
      grossSalary: projectedAnnualGross,
      exemptAllowances,
      exemptReimbursements,
      previousEmployerIncome: input.tax.previousEmployerIncome,
      housePropertyIncome: input.tax.housePropertyIncome,
      otherIncome: input.tax.otherIncome,
      chapterViaDeductions: input.tax.chapterViaDeductions,
      professionalTax: input.tax.annualProfessionalTax ?? ptAmount.times(12),
      employerNpsDeduction: input.tax.employerNpsDeduction,
      slabs: input.tax.slabs,
      config: input.tax.config,
    });
    notes.push(...annualTax.notes);

    const alreadyDeducted = nonNegative(input.tax.ytdTdsDeducted)
      .plus(nonNegative(input.tax.previousEmployerTds));

    const monthly = calculateMonthlyTds({
      annualTaxLiability: annualTax.totalTaxLiability,
      tdsAlreadyDeducted: alreadyDeducted,
      monthsRemaining: remaining,
      flatAmount: input.tax.flatTdsAmount,
      override: ov.tds ?? input.tax.tdsOverride,
      disabled: input.tax.tdsDisabled,
    });
    tdsAmount = monthly.tds;
    tdsComputed = monthly.computed;
    notes.push(...monthly.notes);

    if (monthsElapsed === 0 && remaining === 12) {
      notes.push("First month of the financial year — TDS spread across all 12 periods");
    }
  }

  // --- 7. Assemble deductions and net pay --------------------------------
  const pushDeduction = (code: string, name: string, amount: Decimal, seq: number) => {
    if (amount.isZero()) return;
    lines.push({ code, name, type: "DEDUCTION", fullAmount: amount, amount, showOnPayslip: true, sequence: seq });
  };

  pushDeduction("PF_EMPLOYEE", "Provident Fund", pf.employeeContribution, 1000);
  pushDeduction("VPF", "Voluntary Provident Fund", pf.vpf, 1001);
  pushDeduction("ESI_EMPLOYEE", "ESI", esiEmployee, 1002);
  pushDeduction("PT", "Professional Tax", ptAmount, 1003);
  pushDeduction("LWF_EMPLOYEE", "Labour Welfare Fund", lwfEmployee, 1004);
  pushDeduction("TDS", "Income Tax (TDS)", tdsAmount, 1005);

  for (const [i, d] of (vp.adhocDeductions ?? []).entries()) {
    pushDeduction(`ADHOC_DED_${i + 1}`, d.name, roundRupees(money(d.amount)), 1010 + i);
  }
  for (const [i, l] of (vp.loanEmis ?? []).entries()) {
    pushDeduction(`LOAN_EMI_${i + 1}`, l.name, roundRupees(money(l.amount)), 1020 + i);
  }

  // Employer-side rows. Shown on the payslip when the settings allow, but
  // never part of net pay.
  const pushEmployer = (code: string, name: string, amount: Decimal, seq: number) => {
    if (amount.isZero()) return;
    lines.push({ code, name, type: "EMPLOYER_CONTRIBUTION", fullAmount: amount, amount, showOnPayslip: true, sequence: seq });
  };
  pushEmployer("PF_EMPLOYER", "Employer PF", pf.employerEpf, 1100);
  pushEmployer("EPS", "Employee Pension Scheme", pf.employerEps, 1101);
  pushEmployer("EDLI", "EDLI", pf.edli, 1102);
  pushEmployer("PF_ADMIN", "PF Admin Charges", pf.adminCharges, 1103);
  pushEmployer("ESI_EMPLOYER", "Employer ESI", esi.employerContribution, 1104);
  pushEmployer("LWF_EMPLOYER", "Employer LWF", lwf.employerContribution, 1105);

  lines.sort((a, b) => a.sequence - b.sequence);

  const grossEarnings = lines
    .filter((l) => l.type === "EARNING" || l.type === "REIMBURSEMENT")
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));

  const totalDeductions = lines
    .filter((l) => l.type === "DEDUCTION")
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));

  const employerCost = lines
    .filter((l) => l.type === "EMPLOYER_CONTRIBUTION")
    .reduce((s, l) => s.plus(l.amount), new Decimal(0));

  const netPay = grossEarnings.minus(totalDeductions);

  // A negative net is legitimate — a recovery can exceed the month's pay —
  // but it must be surfaced, not silently clamped.
  if (netPay.isNegative()) {
    warnings.push(
      `Net pay is negative (${netPay.toFixed(2)}). Deductions exceed earnings this period.`,
    );
  }

  return {
    employeeId: input.employeeId,
    year: input.year,
    month: input.month,
    totalDays,
    payableDays,
    lopDays,
    prorationFactor,
    lines,
    grossEarnings,
    totalDeductions,
    employerCost,
    netPay,
    pf,
    esi,
    pt,
    lwf,
    tds: tdsAmount,
    tdsComputed,
    annualTax,
    pfWage: pf.pfWage,
    esiGross: esi.esiWage,
    taxableGrossThisMonth: taxableThisMonth,
    warnings,
    notes,
    structure,
  };
}
