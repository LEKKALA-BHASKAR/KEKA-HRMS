import {
  Decimal, money, nonNegative, roundTax, type Numeric,
} from "@keka/shared";

/**
 * Income tax and TDS.
 *
 * The monthly TDS figure on a payslip is not a monthly calculation. It is
 * the ANNUAL liability, projected from what the employee will earn over the
 * whole financial year, less tax already deducted, divided by the months
 * still to run. That is why TDS moves when a declaration changes, when a
 * bonus lands, or when someone joins mid-year.
 */

export type TaxRegime = "OLD" | "NEW";

export interface TaxSlab {
  fromAmount: Numeric;
  toAmount: Numeric | null;
  ratePercent: Numeric;
}

export interface SurchargeBand {
  from: number;
  to: number | null;
  percent: number;
}

export interface TaxConfig {
  standardDeduction: Numeric;
  rebateLimit: Numeric;
  rebateMaxAmount: Numeric;
  cessPercent: Numeric;
  surchargeBands: SurchargeBand[];
  marginalReliefEnabled: boolean;
}

// --- HRA --------------------------------------------------------------------

export interface HraInput {
  /** HRA actually received over the period. */
  hraReceived: Numeric;
  /** Rent actually paid over the period. */
  rentPaid: Numeric;
  /** Basic + DA for the same period. */
  salaryForHra: Numeric;
  /** Metro cities attract 50% rather than 40%. */
  isMetro: boolean;
}

export interface HraResult {
  exemption: Decimal;
  /** The three candidate figures, for the tax-computation statement. */
  actualHra: Decimal;
  rentLessTenPercent: Decimal;
  percentOfSalary: Decimal;
  taxableHra: Decimal;
}

/**
 * HRA exemption under s.10(13A) — the least of three figures.
 */
export function calculateHraExemption(input: HraInput): HraResult {
  const actualHra = nonNegative(input.hraReceived);
  const salary = nonNegative(input.salaryForHra);
  const rent = nonNegative(input.rentPaid);

  const rentLessTenPercent = nonNegative(rent.minus(salary.times(0.1)));
  const percentOfSalary = salary.times(input.isMetro ? 0.5 : 0.4);

  const exemption = Decimal.min(actualHra, rentLessTenPercent, percentOfSalary);

  return {
    exemption: exemption.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    actualHra,
    rentLessTenPercent,
    percentOfSalary,
    taxableHra: nonNegative(actualHra.minus(exemption)),
  };
}

// --- Slab tax ---------------------------------------------------------------

export interface SlabBreakdownRow {
  from: Decimal;
  to: Decimal | null;
  rate: Decimal;
  taxableInBand: Decimal;
  tax: Decimal;
}

/** Apply a progressive slab table to a taxable income. */
export function applySlabs(
  taxableIncome: Numeric,
  slabs: TaxSlab[],
): { tax: Decimal; breakdown: SlabBreakdownRow[] } {
  const income = nonNegative(taxableIncome);
  const sorted = [...slabs].sort(
    (a, b) => money(a.fromAmount).comparedTo(money(b.fromAmount)),
  );

  let tax = new Decimal(0);
  const breakdown: SlabBreakdownRow[] = [];

  for (const slab of sorted) {
    const from = money(slab.fromAmount);
    if (income.lessThanOrEqualTo(from)) break;

    const to = slab.toAmount === null || slab.toAmount === undefined
      ? null
      : money(slab.toAmount);
    const bandTop = to === null ? income : Decimal.min(income, to);
    const taxableInBand = nonNegative(bandTop.minus(from));
    if (taxableInBand.isZero()) continue;

    const rate = money(slab.ratePercent);
    const bandTax = taxableInBand.times(rate).dividedBy(100);
    tax = tax.plus(bandTax);

    breakdown.push({ from, to, rate, taxableInBand, tax: bandTax });
  }

  return { tax, breakdown };
}

// --- Surcharge --------------------------------------------------------------

function surchargeRateFor(income: Decimal, bands: SurchargeBand[]): SurchargeBand | null {
  for (const band of bands) {
    const from = new Decimal(band.from);
    if (income.lessThanOrEqualTo(from)) continue;
    if (band.to === null || income.lessThanOrEqualTo(new Decimal(band.to))) {
      return band;
    }
  }
  // Above every band's upper bound: the last band applies.
  const last = bands[bands.length - 1];
  return last && income.greaterThan(new Decimal(last.from)) ? last : null;
}

/**
 * Surcharge with marginal relief.
 *
 * Without relief, earning one rupee over a surcharge threshold can cost
 * tens of thousands in extra tax. Relief caps the combined tax-plus-surcharge
 * so the increase never exceeds the income increase over the threshold.
 */
export function calculateSurcharge(
  taxableIncome: Numeric,
  baseTax: Numeric,
  bands: SurchargeBand[],
  slabs: TaxSlab[],
  marginalReliefEnabled = true,
): { surcharge: Decimal; rate: Decimal; marginalRelief: Decimal } {
  const income = nonNegative(taxableIncome);
  const tax = nonNegative(baseTax);

  const band = surchargeRateFor(income, bands);
  if (!band) {
    return { surcharge: new Decimal(0), rate: new Decimal(0), marginalRelief: new Decimal(0) };
  }

  const rate = new Decimal(band.percent);
  let surcharge = tax.times(rate).dividedBy(100);
  let marginalRelief = new Decimal(0);

  if (marginalReliefEnabled) {
    const threshold = new Decimal(band.from);
    const taxAtThreshold = applySlabs(threshold, slabs).tax;

    // Surcharge at the threshold is whatever the previous band charged.
    const previousBand = bands
      .filter((b) => new Decimal(b.from).lessThan(threshold))
      .sort((a, b) => b.from - a.from)[0];
    const surchargeAtThreshold = previousBand
      ? taxAtThreshold.times(previousBand.percent).dividedBy(100)
      : new Decimal(0);

    const ceiling = taxAtThreshold
      .plus(surchargeAtThreshold)
      .plus(income.minus(threshold));

    if (tax.plus(surcharge).greaterThan(ceiling)) {
      const relieved = nonNegative(ceiling.minus(tax));
      marginalRelief = surcharge.minus(relieved);
      surcharge = relieved;
    }
  }

  return { surcharge, rate, marginalRelief };
}

// --- Full annual computation ------------------------------------------------

export interface AnnualTaxInput {
  regime: TaxRegime;
  /** Gross salary for the full financial year, including projected months. */
  grossSalary: Numeric;
  /** Exempt allowances — HRA exemption, LTA. Old regime only. */
  exemptAllowances?: Numeric;
  /** Tax-exempt reimbursements actually claimed. */
  exemptReimbursements?: Numeric;
  /** Income from previous employment in the same FY. */
  previousEmployerIncome?: Numeric;
  /** Income from house property (usually negative — a home loan interest set-off). */
  housePropertyIncome?: Numeric;
  /** Interest income and other declared sources. */
  otherIncome?: Numeric;

  /** Approved Chapter VI-A total. Old regime only. */
  chapterViaDeductions?: Numeric;
  /** Professional tax paid during the year — deductible under s.16(iii). */
  professionalTax?: Numeric;
  /** Employer NPS contribution under 80CCD(2) — allowed in both regimes. */
  employerNpsDeduction?: Numeric;

  slabs: TaxSlab[];
  config: TaxConfig;
}

export interface AnnualTaxResult {
  grossTotalIncome: Decimal;
  exemptions: Decimal;
  standardDeduction: Decimal;
  professionalTaxDeduction: Decimal;
  chapterViaDeductions: Decimal;
  taxableIncome: Decimal;

  taxBeforeRebate: Decimal;
  rebate87A: Decimal;
  rebateMarginalRelief: Decimal;
  taxAfterRebate: Decimal;
  surcharge: Decimal;
  surchargeRate: Decimal;
  surchargeMarginalRelief: Decimal;
  cess: Decimal;
  totalTaxLiability: Decimal;

  slabBreakdown: SlabBreakdownRow[];
  notes: string[];
}

export function calculateAnnualTax(input: AnnualTaxInput): AnnualTaxResult {
  const notes: string[] = [];
  const cfg = input.config;
  const isNew = input.regime === "NEW";

  const gross = nonNegative(input.grossSalary)
    .plus(nonNegative(input.previousEmployerIncome));

  // The new regime disallows almost every exemption and Chapter VI-A
  // deduction. Zeroing them here rather than at the caller means a badly
  // configured declaration cannot leak a deduction into the new regime.
  let exemptions = new Decimal(0);
  if (!isNew) {
    exemptions = nonNegative(input.exemptAllowances);
  } else if (input.exemptAllowances && !nonNegative(input.exemptAllowances).isZero()) {
    notes.push("Exempt allowances such as HRA and LTA are not available under the new regime");
  }
  // Tax-free reimbursements are outside taxable income in both regimes.
  exemptions = exemptions.plus(nonNegative(input.exemptReimbursements));

  const salaryAfterExemptions = nonNegative(gross.minus(exemptions));

  const standardDeduction = Decimal.min(
    money(cfg.standardDeduction),
    salaryAfterExemptions,
  );

  // Professional tax is deductible from salary income under s.16(iii) —
  // old regime only.
  const professionalTaxDeduction = isNew
    ? new Decimal(0)
    : nonNegative(input.professionalTax);
  if (isNew && input.professionalTax && !nonNegative(input.professionalTax).isZero()) {
    notes.push("Professional tax is not deductible under the new regime");
  }

  const incomeFromSalary = nonNegative(
    salaryAfterExemptions.minus(standardDeduction).minus(professionalTaxDeduction),
  );

  // House property income is usually a negative figure — a home-loan interest
  // set-off, which the Act caps at 2,00,000 for a self-occupied property.
  const houseProperty = isNew ? new Decimal(0) : money(input.housePropertyIncome ?? 0);
  const otherIncome = nonNegative(input.otherIncome);

  const grossTotalIncome = incomeFromSalary.plus(houseProperty).plus(otherIncome);

  let chapterVia = isNew ? new Decimal(0) : nonNegative(input.chapterViaDeductions);
  // 80CCD(2) survives into the new regime.
  chapterVia = chapterVia.plus(nonNegative(input.employerNpsDeduction));
  if (isNew && input.chapterViaDeductions && !nonNegative(input.chapterViaDeductions).isZero()) {
    notes.push("Chapter VI-A deductions other than 80CCD(2) are not available under the new regime");
  }

  // Total income is rounded to the nearest multiple of ten rupees under
  // s.288A. Decimal.js will not take a negative decimal-places argument, so
  // scale down, round, and scale back up.
  const taxableIncome = nonNegative(grossTotalIncome.minus(chapterVia))
    .dividedBy(10)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .times(10);

  const { tax: taxBeforeRebate, breakdown } = applySlabs(taxableIncome, input.slabs);

  // --- Section 87A rebate, with marginal relief -------------------------
  let rebate = new Decimal(0);
  let rebateMarginalRelief = new Decimal(0);
  const rebateLimit = money(cfg.rebateLimit);
  const rebateMax = money(cfg.rebateMaxAmount);

  if (taxableIncome.lessThanOrEqualTo(rebateLimit)) {
    rebate = Decimal.min(taxBeforeRebate, rebateMax);
  } else if (isNew && cfg.marginalReliefEnabled) {
    // Just over the limit, the tax may exceed the income increase. Relief
    // caps the liability at the excess over the threshold.
    const excessIncome = taxableIncome.minus(rebateLimit);
    if (taxBeforeRebate.greaterThan(excessIncome)) {
      rebateMarginalRelief = taxBeforeRebate.minus(excessIncome);
      rebate = rebateMarginalRelief;
      notes.push("Marginal relief applied — the tax would otherwise exceed the income above the rebate threshold");
    }
  }

  const taxAfterRebate = nonNegative(taxBeforeRebate.minus(rebate));

  const { surcharge, rate: surchargeRate, marginalRelief: surchargeMarginalRelief } =
    calculateSurcharge(
      taxableIncome,
      taxAfterRebate,
      cfg.surchargeBands,
      input.slabs,
      cfg.marginalReliefEnabled,
    );

  const cess = taxAfterRebate.plus(surcharge).times(money(cfg.cessPercent)).dividedBy(100);

  const totalTaxLiability = roundTax(taxAfterRebate.plus(surcharge).plus(cess));

  return {
    grossTotalIncome,
    exemptions,
    standardDeduction,
    professionalTaxDeduction,
    chapterViaDeductions: chapterVia,
    taxableIncome,
    taxBeforeRebate: taxBeforeRebate.toDecimalPlaces(2),
    rebate87A: rebate.toDecimalPlaces(2),
    rebateMarginalRelief: rebateMarginalRelief.toDecimalPlaces(2),
    taxAfterRebate: taxAfterRebate.toDecimalPlaces(2),
    surcharge: surcharge.toDecimalPlaces(2),
    surchargeRate,
    surchargeMarginalRelief: surchargeMarginalRelief.toDecimalPlaces(2),
    cess: cess.toDecimalPlaces(2),
    totalTaxLiability,
    slabBreakdown: breakdown,
    notes,
  };
}

// --- Monthly TDS ------------------------------------------------------------

export interface MonthlyTdsInput {
  annualTaxLiability: Numeric;
  /** TDS already deducted in this FY, including by a previous employer. */
  tdsAlreadyDeducted?: Numeric;
  /** Pay periods still to run, including the one being processed. */
  monthsRemaining: number;
  /** A flat monthly figure, used for contractual employees. */
  flatAmount?: Numeric | null;
  /** Admin override for this month. */
  override?: Numeric | null;
  disabled?: boolean;
}

export interface MonthlyTdsResult {
  tds: Decimal;
  /** What the spread would have produced before any override. */
  computed: Decimal;
  isOverridden: boolean;
  notes: string[];
}

export function calculateMonthlyTds(input: MonthlyTdsInput): MonthlyTdsResult {
  const notes: string[] = [];

  if (input.disabled) {
    notes.push("TDS disabled for this employee");
    return { tds: new Decimal(0), computed: new Decimal(0), isOverridden: false, notes };
  }

  if (input.flatAmount != null) {
    const flat = nonNegative(input.flatAmount);
    notes.push("Flat monthly TDS applied");
    return { tds: flat, computed: flat, isOverridden: false, notes };
  }

  const annual = nonNegative(input.annualTaxLiability);
  const alreadyDeducted = nonNegative(input.tdsAlreadyDeducted);
  const remaining = Math.max(1, input.monthsRemaining);

  const outstanding = nonNegative(annual.minus(alreadyDeducted));
  const computed = roundTax(outstanding.dividedBy(remaining));

  if (annual.lessThan(alreadyDeducted)) {
    notes.push("Tax already deducted exceeds the annual liability — no further TDS this month");
  }

  if (input.override != null) {
    notes.push("Monthly TDS overridden by payroll admin");
    return { tds: nonNegative(input.override), computed, isOverridden: true, notes };
  }

  return { tds: computed, computed, isOverridden: false, notes };
}

/**
 * Which regime leaves the employee better off, given the same inputs.
 * Used by the regime-comparison screen.
 */
export function compareRegimes(
  base: Omit<AnnualTaxInput, "regime" | "slabs" | "config">,
  oldSlabs: TaxSlab[],
  oldConfig: TaxConfig,
  newSlabs: TaxSlab[],
  newConfig: TaxConfig,
): { old: AnnualTaxResult; new: AnnualTaxResult; better: TaxRegime; saving: Decimal } {
  const oldResult = calculateAnnualTax({ ...base, regime: "OLD", slabs: oldSlabs, config: oldConfig });
  const newResult = calculateAnnualTax({ ...base, regime: "NEW", slabs: newSlabs, config: newConfig });

  const better: TaxRegime = newResult.totalTaxLiability.lessThanOrEqualTo(oldResult.totalTaxLiability)
    ? "NEW"
    : "OLD";
  const saving = oldResult.totalTaxLiability.minus(newResult.totalTaxLiability).abs();

  return { old: oldResult, new: newResult, better, saving };
}
