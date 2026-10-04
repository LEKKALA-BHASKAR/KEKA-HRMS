import { Decimal, money, nonNegative, roundRupees, type Numeric } from "@keka/shared";

/**
 * Gratuity under the Payment of Gratuity Act, 1972.
 *
 * Employer-funded only — the employee contributes nothing. Eligibility is
 * five years of continuous service, waived on death or disablement.
 *
 * Two regimes:
 *   covered by the Act (10+ employees) — 15 days' wages per completed year,
 *     on a 26-day month, using last-drawn basic + DA
 *   not covered — half a month's average wages per completed year, on a
 *     30-day month, using the average of the last 10 months
 */

export const GRATUITY_TAX_EXEMPTION_CEILING = 2000000;
export const GRATUITY_MIN_YEARS = 5;

export interface GratuityInput {
  /** Last drawn basic + DA, monthly. Used when covered by the Act. */
  lastDrawnBasicDa: Numeric;
  /** Average monthly wages over the last 10 months. Used when not covered. */
  averageMonthlyWages?: Numeric;

  dateOfJoining: Date;
  lastWorkingDay: Date;

  /** 10 or more employees brings the establishment under the Act. */
  actCovered: boolean;
  /** Five-day weeks use a 26-day divisor by default; some employers use 30. */
  workingDaysPerWeek?: 5 | 6;
  /** Explicit override of the monthly divisor. */
  divisorOverride?: Numeric | null;

  /** Eligibility is waived on death or permanent disablement. */
  waiveMinimumService?: boolean;
  /** Gratuity already received from previous employers, against the lifetime cap. */
  priorExemptionUsed?: Numeric;

  /** Employer policy: years of service for eligibility (default 5; 4.8 = 4 years 240 days). */
  minServiceYears?: number;
  /** Employer policy: days' wages per completed year (default 15). */
  daysPerYear?: number;
  /** Employer policy: the most that is paid. */
  payoutCap?: Numeric | null;
}

export interface GratuityResult {
  eligible: boolean;
  /** Completed years, with a final part-year over six months rounded up. */
  serviceYears: number;
  serviceMonths: number;
  rawServiceYears: number;
  wageBase: Decimal;
  divisor: Decimal;
  grossGratuity: Decimal;
  exemptAmount: Decimal;
  taxableAmount: Decimal;
  notes: string[];
}

/**
 * Completed years of service. A final part-year of more than six months
 * counts as a full year under s.4(2); six months or less is dropped.
 */
export function gratuityServiceYears(
  joining: Date,
  lastDay: Date,
): { years: number; months: number; rounded: number } {
  let years = lastDay.getUTCFullYear() - joining.getUTCFullYear();
  let months = lastDay.getUTCMonth() - joining.getUTCMonth();
  const days = lastDay.getUTCDate() - joining.getUTCDate();

  if (days < 0) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  years = Math.max(0, years);
  months = Math.max(0, months);

  const rounded = months > 6 ? years + 1 : years;
  return { years, months, rounded };
}

export function calculateGratuity(input: GratuityInput): GratuityResult {
  const notes: string[] = [];
  const { years, months, rounded } = gratuityServiceYears(
    input.dateOfJoining,
    input.lastWorkingDay,
  );

  const minYears = input.minServiceYears ?? GRATUITY_MIN_YEARS;
  const meetsService = years + months / 12 + 1e-9 >= minYears;
  const eligible = meetsService || input.waiveMinimumService === true;

  if (!eligible) {
    notes.push(
      `Not eligible — ${years} year(s) ${months} month(s) of service, against a minimum of ${minYears} years`,
    );
    return {
      eligible: false,
      serviceYears: rounded,
      serviceMonths: months,
      rawServiceYears: years,
      wageBase: new Decimal(0),
      divisor: new Decimal(0),
      grossGratuity: new Decimal(0),
      exemptAmount: new Decimal(0),
      taxableAmount: new Decimal(0),
      notes,
    };
  }

  if (!meetsService) {
    notes.push("Minimum-service requirement waived (death or permanent disablement)");
  }

  // Wage base and divisor differ by regime.
  let wageBase: Decimal;
  let divisor: Decimal;
  let daysFactor: Decimal;

  if (input.actCovered) {
    wageBase = nonNegative(input.lastDrawnBasicDa);
    divisor = new Decimal(26);
    daysFactor = new Decimal(15);
    notes.push("Covered by the Payment of Gratuity Act — 15 days' wages per year on a 26-day month");
  } else {
    wageBase = nonNegative(input.averageMonthlyWages ?? input.lastDrawnBasicDa);
    divisor = new Decimal(30);
    daysFactor = new Decimal(15);
    notes.push("Not covered by the Act — half a month's average wages per year on a 30-day month");
  }

  if (input.workingDaysPerWeek === 5 && input.actCovered) {
    notes.push("Five-day working week — verify the divisor against your own gratuity policy");
  }
  if (input.daysPerYear != null && input.daysPerYear !== 15) {
    daysFactor = new Decimal(input.daysPerYear);
    notes.push(`${input.daysPerYear} days' wages per year under the employer's policy`);
  }
  if (input.divisorOverride != null) {
    divisor = money(input.divisorOverride);
    notes.push(`Divisor overridden to ${divisor.toFixed(0)}`);
  }

  // (15 x wages x completed years) / divisor
  let grossGratuity = roundRupees(
    wageBase.times(daysFactor).times(rounded).dividedBy(divisor),
  );
  if (input.payoutCap != null && grossGratuity.greaterThan(money(input.payoutCap))) {
    grossGratuity = roundRupees(money(input.payoutCap));
    notes.push(`Capped at ${grossGratuity.toFixed(2)} under the gratuity settings`);
  }

  // --- Tax exemption under s.10(10) --------------------------------------
  // Least of: actual received, the lifetime ceiling, and the formula amount.
  const priorUsed = nonNegative(input.priorExemptionUsed);
  const ceilingHeadroom = nonNegative(
    new Decimal(GRATUITY_TAX_EXEMPTION_CEILING).minus(priorUsed),
  );
  const formulaAmount = wageBase.times(daysFactor).times(rounded).dividedBy(divisor);

  const exemptAmount = roundRupees(
    Decimal.min(grossGratuity, ceilingHeadroom, formulaAmount),
  );
  const taxableAmount = nonNegative(grossGratuity.minus(exemptAmount));

  if (taxableAmount.greaterThan(0)) {
    notes.push(`${taxableAmount.toFixed(2)} of the gratuity is taxable`);
  }

  return {
    eligible: true,
    serviceYears: rounded,
    serviceMonths: months,
    rawServiceYears: years,
    wageBase,
    divisor,
    grossGratuity,
    exemptAmount,
    taxableAmount,
    notes,
  };
}

// --- Leave encashment -------------------------------------------------------

export interface LeaveEncashmentInput {
  /** Days being encashed. */
  days: Numeric;
  /** Monthly basis — basic + DA, or gross, per the encashment policy. */
  monthlyWage: Numeric;
  /** Days in a month for the per-day rate. Usually 26 or 30. */
  divisor?: Numeric;
  /** Encashment on exit carries an exemption; in-service encashment is taxable. */
  isOnExit?: boolean;
  /** Lifetime exemption ceiling for non-government employees under s.10(10AA). */
  exemptionCeiling?: Numeric;
  priorExemptionUsed?: Numeric;
}

export interface LeaveEncashmentResult {
  perDayRate: Decimal;
  grossAmount: Decimal;
  exemptAmount: Decimal;
  taxableAmount: Decimal;
  notes: string[];
}

export function calculateLeaveEncashment(
  input: LeaveEncashmentInput,
): LeaveEncashmentResult {
  const notes: string[] = [];
  const divisor = money(input.divisor ?? 30);
  const wage = nonNegative(input.monthlyWage);
  const days = nonNegative(input.days);

  const perDayRate = divisor.isZero()
    ? new Decimal(0)
    : wage.dividedBy(divisor);
  const grossAmount = roundRupees(perDayRate.times(days));

  // Encashment while in service is fully taxable. Only encashment on
  // retirement or resignation attracts the s.10(10AA) exemption.
  if (!input.isOnExit) {
    notes.push("Encashment during service is fully taxable");
    return {
      perDayRate,
      grossAmount,
      exemptAmount: new Decimal(0),
      taxableAmount: grossAmount,
      notes,
    };
  }

  const ceiling = money(input.exemptionCeiling ?? 2500000);
  const headroom = nonNegative(ceiling.minus(nonNegative(input.priorExemptionUsed)));
  const exemptAmount = roundRupees(Decimal.min(grossAmount, headroom));
  const taxableAmount = nonNegative(grossAmount.minus(exemptAmount));

  if (taxableAmount.greaterThan(0)) {
    notes.push(`${taxableAmount.toFixed(2)} exceeds the s.10(10AA) exemption ceiling and is taxable`);
  }

  return { perDayRate, grossAmount, exemptAmount, taxableAmount, notes };
}

// --- Notice period buyout / recovery ----------------------------------------

export interface NoticeBuyoutInput {
  /** Days of notice required by policy. */
  requiredDays: number;
  /** Days actually served. */
  servedDays: number;
  /** Monthly basis for the per-day rate — basic or gross, per policy. */
  monthlyWage: Numeric;
  divisor?: Numeric;
  /** The employer is buying out the shortfall rather than recovering it. */
  employerBuyout?: boolean;
}

export interface NoticeBuyoutResult {
  shortfallDays: number;
  perDayRate: Decimal;
  amount: Decimal;
  /** True when the amount is recovered FROM the employee. */
  isRecovery: boolean;
  notes: string[];
}

export function calculateNoticeBuyout(input: NoticeBuyoutInput): NoticeBuyoutResult {
  const notes: string[] = [];
  const shortfallDays = Math.max(0, input.requiredDays - input.servedDays);
  const divisor = money(input.divisor ?? 30);
  const perDayRate = divisor.isZero()
    ? new Decimal(0)
    : nonNegative(input.monthlyWage).dividedBy(divisor);

  if (shortfallDays === 0) {
    notes.push("Full notice served — no buyout or recovery");
    return { shortfallDays: 0, perDayRate, amount: new Decimal(0), isRecovery: false, notes };
  }

  const amount = roundRupees(perDayRate.times(shortfallDays));
  const isRecovery = !input.employerBuyout;
  notes.push(
    isRecovery
      ? `${shortfallDays} day(s) short of notice — recovered from the settlement`
      : `${shortfallDays} day(s) of notice waived and paid out by the employer`,
  );

  return { shortfallDays, perDayRate, amount, isRecovery, notes };
}
