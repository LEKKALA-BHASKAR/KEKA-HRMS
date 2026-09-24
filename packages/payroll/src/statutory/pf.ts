import { Decimal, money, pct, roundRupees, nonNegative, type Numeric } from "@keka/shared";

/**
 * Provident Fund — EPF, EPS, VPF, EDLI and administrative charges.
 *
 * Every rate and ceiling is a parameter rather than a constant, because they
 * are held per pay group on PayGroupFilingDetail and do change by statute.
 * The defaults below are the current EPF scheme values.
 */

export interface PfConfig {
  /** Statutory wage ceiling. */
  wageCeiling: Numeric;
  /** Restrict the PF wage to the ceiling rather than using actual basic. */
  capAtCeiling: boolean;
  employeeRate: Numeric;
  employerRate: Numeric;
  /** EPS share of the employer contribution. */
  epsRate: Numeric;
  epsWageCeiling: Numeric;
  edliRate: Numeric;
  adminRate: Numeric;
}

export const DEFAULT_PF_CONFIG: PfConfig = {
  wageCeiling: 15000,
  capAtCeiling: true,
  employeeRate: 12,
  employerRate: 12,
  epsRate: 8.33,
  epsWageCeiling: 15000,
  edliRate: 0.5,
  adminRate: 0.5,
};

export interface PfInput {
  /** Basic + DA + retaining allowance, already prorated for LOP. */
  pfWageBase: Numeric;
  enabled: boolean;
  /** Per-employee override of the ceiling cap. */
  capAtCeiling?: boolean | null;
  /** Employees who joined on a wage above the ceiling after Sep 2014 have no EPS. */
  epsApplicable?: boolean;
  /** Voluntary contribution, as a flat amount. */
  vpfAmount?: Numeric;
  /** Voluntary contribution, as a percentage of the PF wage. */
  vpfPercent?: Numeric;
  /** Fraction of the month the employee was payable, 0..1. */
  prorationFactor?: Numeric;
  config?: Partial<PfConfig>;
}

export interface PfResult {
  /** The wage PF was actually computed on, after ceiling and proration. */
  pfWage: Decimal;
  /** Employee's 12% share. */
  employeeContribution: Decimal;
  /** Voluntary top-up, on top of the statutory 12%. */
  vpf: Decimal;
  /** Total deducted from the employee: statutory + voluntary. */
  totalEmployeeDeduction: Decimal;
  /** Employer's 12%, split into EPS and EPF. */
  employerContribution: Decimal;
  employerEps: Decimal;
  employerEpf: Decimal;
  /** Employer-borne insurance and admin charges, outside the 12%. */
  edli: Decimal;
  adminCharges: Decimal;
  /** Everything the employer pays. */
  totalEmployerCost: Decimal;
  applied: boolean;
  notes: string[];
}

export function calculatePf(input: PfInput): PfResult {
  const cfg: PfConfig = { ...DEFAULT_PF_CONFIG, ...input.config };
  const notes: string[] = [];

  const zero = (): PfResult => ({
    pfWage: new Decimal(0),
    employeeContribution: new Decimal(0),
    vpf: new Decimal(0),
    totalEmployeeDeduction: new Decimal(0),
    employerContribution: new Decimal(0),
    employerEps: new Decimal(0),
    employerEpf: new Decimal(0),
    edli: new Decimal(0),
    adminCharges: new Decimal(0),
    totalEmployerCost: new Decimal(0),
    applied: false,
    notes,
  });

  if (!input.enabled) {
    notes.push("PF not applicable");
    return zero();
  }

  const base = nonNegative(input.pfWageBase);
  if (base.isZero()) {
    notes.push("PF wage base is zero");
    return zero();
  }

  const capAtCeiling = input.capAtCeiling ?? cfg.capAtCeiling;
  const ceiling = money(cfg.wageCeiling);
  const proration = input.prorationFactor === undefined || input.prorationFactor === null
    ? new Decimal(1)
    : money(input.prorationFactor);

  // The ceiling itself prorates for a part-month, which is why a mid-month
  // joiner on a high salary does not get a full-ceiling contribution.
  let pfWage = base;
  if (capAtCeiling) {
    const proratedCeiling = ceiling.times(proration);
    if (pfWage.greaterThan(proratedCeiling)) {
      pfWage = proratedCeiling;
      notes.push(`PF wage restricted to the statutory ceiling (${ceiling.toFixed(0)}/month)`);
    }
  }

  const employeeContribution = roundRupees(pct(pfWage, cfg.employeeRate));
  const employerContribution = roundRupees(pct(pfWage, cfg.employerRate));

  // EPS is 8.33% of the PF wage, but never on more than the EPS ceiling.
  // Whatever the employer's 12% leaves over goes to EPF.
  let employerEps = new Decimal(0);
  if (input.epsApplicable !== false) {
    const epsWage = Decimal.min(pfWage, money(cfg.epsWageCeiling).times(proration));
    employerEps = roundRupees(pct(epsWage, cfg.epsRate));
    if (employerEps.greaterThan(employerContribution)) {
      employerEps = employerContribution;
    }
  } else {
    notes.push("EPS not applicable; full employer share goes to EPF");
  }
  const employerEpf = nonNegative(employerContribution.minus(employerEps));

  // Voluntary PF: an amount or a percentage, whichever is configured.
  let vpf = new Decimal(0);
  if (input.vpfAmount) {
    vpf = roundRupees(money(input.vpfAmount).times(proration));
  } else if (input.vpfPercent) {
    vpf = roundRupees(pct(pfWage, input.vpfPercent));
  }

  // EDLI and admin charges sit outside the 12% and are always on the
  // ceiling-restricted wage, regardless of the employee's cap preference.
  const statutoryWage = Decimal.min(base, ceiling.times(proration));
  const edli = roundRupees(pct(statutoryWage, cfg.edliRate));
  const adminCharges = roundRupees(pct(statutoryWage, cfg.adminRate));

  return {
    pfWage,
    employeeContribution,
    vpf,
    totalEmployeeDeduction: employeeContribution.plus(vpf),
    employerContribution,
    employerEps,
    employerEpf,
    edli,
    adminCharges,
    totalEmployerCost: employerContribution.plus(edli).plus(adminCharges),
    applied: true,
    notes,
  };
}

/**
 * The PF wage base: basic plus dearness allowance, plus any component the
 * structure marks as PF-qualifying.
 */
export function pfWageFromComponents(
  components: Array<{ code: string; amount: Numeric; affectsPfWage: boolean }>,
): Decimal {
  return components
    .filter((c) => c.affectsPfWage)
    .reduce((sum, c) => sum.plus(money(c.amount)), new Decimal(0));
}
