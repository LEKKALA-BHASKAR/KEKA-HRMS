import { Decimal, money, nonNegative, type Numeric } from "@keka/shared";

/**
 * Labour Welfare Fund.
 *
 * Flat amounts rather than percentages, collected on a state-specific
 * schedule. The employer share can sit inside the CTC (deducted from annual
 * salary) or over and above it, and can be hidden from the payslip.
 */

export type LwfFrequency = "MONTHLY" | "HALF_YEARLY" | "ANNUAL";

export interface LwfRule {
  frequency: LwfFrequency;
  /** Months in which the contribution falls, 1-12. */
  deductionMonths: number[];
  employeeAmount: Numeric;
  employerAmount: Numeric;
  wageLimit?: Numeric | null;
}

export interface LwfInput {
  enabled: boolean;
  rule: LwfRule | null;
  /** Calendar month being processed, 1-12. */
  month: number;
  monthlyGross: Numeric;
  /** Prorate the contribution for someone who joined part-way through. */
  prorateNewJoiners?: boolean;
  prorationFactor?: Numeric;
}

export interface LwfResult {
  employeeContribution: Decimal;
  employerContribution: Decimal;
  total: Decimal;
  applied: boolean;
  notes: string[];
}

export function calculateLwf(input: LwfInput): LwfResult {
  const notes: string[] = [];
  const zero = (): LwfResult => ({
    employeeContribution: new Decimal(0),
    employerContribution: new Decimal(0),
    total: new Decimal(0),
    applied: false,
    notes,
  });

  if (!input.enabled) {
    notes.push("LWF not applicable");
    return zero();
  }
  if (!input.rule) {
    notes.push("No LWF rule configured for this state");
    return zero();
  }

  const rule = input.rule;

  if (!rule.deductionMonths.includes(input.month)) {
    notes.push(`Month ${input.month} is not an LWF deduction month for this state`);
    return zero();
  }

  if (rule.wageLimit != null) {
    const limit = money(rule.wageLimit);
    if (nonNegative(input.monthlyGross).greaterThan(limit)) {
      notes.push(`Monthly gross exceeds the LWF wage limit of ${limit.toFixed(2)}`);
      return zero();
    }
  }

  let employeeContribution = money(rule.employeeAmount);
  let employerContribution = money(rule.employerAmount);

  if (input.prorateNewJoiners && input.prorationFactor != null) {
    const factor = money(input.prorationFactor);
    employeeContribution = employeeContribution.times(factor);
    employerContribution = employerContribution.times(factor);
    notes.push("Prorated for a part-period joiner");
  }

  employeeContribution = employeeContribution.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  employerContribution = employerContribution.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    employeeContribution,
    employerContribution,
    total: employeeContribution.plus(employerContribution),
    applied: true,
    notes,
  };
}
