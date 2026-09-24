import { Decimal, money, pct, nonNegative, type Numeric } from "@keka/shared";

/**
 * Employees' State Insurance.
 *
 * Two rules make ESI awkward and both are implemented here:
 *
 *  1. Contribution periods are fixed six-month blocks — April to September
 *     and October to March. An employee whose wage crosses the limit mid
 *     period keeps contributing until that period ends.
 *  2. Contributions round UP to the next rupee, not half-up. That is the
 *     ESIC rule and it is why a naive implementation under-reports.
 */

export interface EsiConfig {
  /** Coverage threshold on monthly gross. */
  wageLimit: Numeric;
  employeeRate: Numeric;
  employerRate: Numeric;
  /** Cap the contribution base at the wage limit. */
  capAtLimit: boolean;
}

export const DEFAULT_ESI_CONFIG: EsiConfig = {
  wageLimit: 21000,
  employeeRate: 0.75,
  employerRate: 3.25,
  capAtLimit: true,
};

export interface EsiInput {
  /** Monthly ESI gross for the period, after LOP. */
  esiGross: Numeric;
  /** Full monthly gross before proration — this is what the limit tests against. */
  fullMonthlyGross?: Numeric;
  enabled: boolean;
  /** Arrears are included in the ESI wage base. */
  arrears?: Numeric;
  /**
   * Set when the employee crossed the wage limit inside a contribution
   * period and must keep contributing until it ends.
   */
  cycleEndDate?: Date | null;
  /** The period being processed, used against cycleEndDate. */
  periodEnd?: Date;
  config?: Partial<EsiConfig>;
}

export interface EsiResult {
  esiWage: Decimal;
  employeeContribution: Decimal;
  employerContribution: Decimal;
  totalContribution: Decimal;
  applied: boolean;
  /** True when the employee is only covered because a cycle is still running. */
  continuedForCycle: boolean;
  notes: string[];
}

/** ESIC rounds every contribution up to the next whole rupee. */
function roundUpRupee(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_CEIL);
}

/**
 * The contribution period a date falls in.
 * April-September, then October-March.
 */
export function esiContributionPeriod(date: Date): { start: Date; end: Date; label: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (month >= 4 && month <= 9) {
    return {
      start: new Date(Date.UTC(year, 3, 1)),
      end: new Date(Date.UTC(year, 8, 30)),
      label: `Apr-Sep ${year}`,
    };
  }
  const startYear = month >= 10 ? year : year - 1;
  return {
    start: new Date(Date.UTC(startYear, 9, 1)),
    end: new Date(Date.UTC(startYear + 1, 2, 31)),
    label: `Oct ${startYear} - Mar ${startYear + 1}`,
  };
}

export function calculateEsi(input: EsiInput): EsiResult {
  const cfg: EsiConfig = { ...DEFAULT_ESI_CONFIG, ...input.config };
  const notes: string[] = [];

  const zero = (continued = false): EsiResult => ({
    esiWage: new Decimal(0),
    employeeContribution: new Decimal(0),
    employerContribution: new Decimal(0),
    totalContribution: new Decimal(0),
    applied: false,
    continuedForCycle: continued,
    notes,
  });

  if (!input.enabled) {
    notes.push("ESI not applicable");
    return zero();
  }

  const gross = nonNegative(input.esiGross).plus(nonNegative(input.arrears));
  // Eligibility tests the full monthly wage, not the LOP-reduced figure —
  // otherwise a month of unpaid leave would wrongly pull someone into ESI.
  const eligibilityWage = input.fullMonthlyGross !== undefined
    ? nonNegative(input.fullMonthlyGross)
    : gross;
  const limit = money(cfg.wageLimit);

  let covered = eligibilityWage.lessThanOrEqualTo(limit);
  let continuedForCycle = false;

  if (!covered && input.cycleEndDate && input.periodEnd) {
    if (input.periodEnd.getTime() <= input.cycleEndDate.getTime()) {
      covered = true;
      continuedForCycle = true;
      notes.push(
        "Wage exceeds the ESI limit, but the contribution period is still running — contributions continue until it ends",
      );
    }
  }

  if (!covered) {
    notes.push(`Monthly gross exceeds the ESI wage limit (${limit.toFixed(0)})`);
    return zero(false);
  }

  if (gross.isZero()) {
    notes.push("ESI gross is zero");
    return zero(continuedForCycle);
  }

  // Contributions are computed on the actual wage, capped at the limit.
  const esiWage = cfg.capAtLimit ? Decimal.min(gross, limit) : gross;

  const employeeContribution = roundUpRupee(pct(esiWage, cfg.employeeRate));
  const employerContribution = roundUpRupee(pct(esiWage, cfg.employerRate));

  return {
    esiWage,
    employeeContribution,
    employerContribution,
    totalContribution: employeeContribution.plus(employerContribution),
    applied: true,
    continuedForCycle,
    notes,
  };
}

/**
 * When an employee's wage rises above the limit, they stay covered until the
 * end of the current contribution period. Returns the date coverage ends.
 */
export function esiCycleEndFor(crossingDate: Date): Date {
  return esiContributionPeriod(crossingDate).end;
}
