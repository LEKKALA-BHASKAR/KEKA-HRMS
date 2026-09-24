import { Decimal, money, nonNegative, type Numeric } from "@keka/shared";

/**
 * Professional Tax.
 *
 * PT is driven by the employee's office LOCATION, which maps to a registered
 * state under the pay group. States levy monthly, half-yearly or annually,
 * and several charge a different amount in one month of the year so the
 * annual total lands on a round figure.
 *
 * The statutory annual ceiling is 2,500 across all states (Article 276 of the
 * Constitution), and the engine enforces it.
 */

export const PT_ANNUAL_CEILING = 2500;

export type PtFrequency = "MONTHLY" | "HALF_YEARLY" | "ANNUAL";

export interface PtSlab {
  fromAmount: Numeric;
  toAmount: Numeric | null;
  amount: Numeric;
  specialMonth?: number | null;
  specialAmount?: Numeric | null;
  gender?: "MALE" | "FEMALE" | null;
  frequency?: PtFrequency;
}

export interface PtInput {
  enabled: boolean;
  /** Monthly gross for the period being processed. */
  monthlyGross: Numeric;
  /** Calendar month, 1-12. */
  month: number;
  /** Slabs for the employee's state, already filtered by effective date. */
  slabs: PtSlab[];
  frequency?: PtFrequency;
  gender?: "MALE" | "FEMALE" | null;
  /** PT already deducted this financial year, for the 2,500 ceiling. */
  ytdDeducted?: Numeric;
  /**
   * Half-yearly and annual states still need a monthly figure to show on the
   * payslip. When true the liability is spread evenly across the period;
   * when false it is deducted in full in the collection month.
   */
  spreadAcrossPeriod?: boolean;
  /** Collection months for half-yearly / annual states, 1-12. */
  collectionMonths?: number[];
}

export interface PtResult {
  amount: Decimal;
  /** The full period liability before spreading. */
  periodLiability: Decimal;
  slabMatched: boolean;
  applied: boolean;
  notes: string[];
}

function matchSlab(
  slabs: PtSlab[],
  gross: Decimal,
  gender: "MALE" | "FEMALE" | null | undefined,
): PtSlab | undefined {
  // Prefer a gender-specific row where the state has one, then fall back.
  const genderMatched = slabs.filter(
    (s) => !s.gender || (gender && s.gender === gender),
  );
  const pool = genderMatched.length > 0 ? genderMatched : slabs;

  return pool.find((s) => {
    const from = money(s.fromAmount);
    if (gross.lessThan(from)) return false;
    if (s.toAmount === null || s.toAmount === undefined) return true;
    return gross.lessThanOrEqualTo(money(s.toAmount));
  });
}

export function calculatePt(input: PtInput): PtResult {
  const notes: string[] = [];
  const zero = (applied = false): PtResult => ({
    amount: new Decimal(0),
    periodLiability: new Decimal(0),
    slabMatched: false,
    applied,
    notes,
  });

  if (!input.enabled) {
    notes.push("Professional tax not applicable");
    return zero();
  }
  if (!input.slabs || input.slabs.length === 0) {
    notes.push("No professional tax slabs configured for this state");
    return zero();
  }

  const frequency: PtFrequency = input.frequency ?? input.slabs[0]?.frequency ?? "MONTHLY";
  const monthlyGross = nonNegative(input.monthlyGross);

  // Half-yearly and annual states test the slab against the aggregated wage
  // for that period, not the monthly figure.
  const testGross =
    frequency === "HALF_YEARLY" ? monthlyGross.times(6)
    : frequency === "ANNUAL" ? monthlyGross.times(12)
    : monthlyGross;

  const slab = matchSlab(input.slabs, testGross, input.gender);
  if (!slab) {
    notes.push(`No slab matched a gross of ${testGross.toFixed(2)}`);
    return zero(true);
  }

  // Some states levy a higher amount in one month to round off the year.
  let periodLiability = money(slab.amount);
  if (slab.specialMonth && slab.specialMonth === input.month && slab.specialAmount != null) {
    periodLiability = money(slab.specialAmount);
    notes.push(`Special-month rate applied for month ${input.month}`);
  }

  let amount = periodLiability;

  if (frequency !== "MONTHLY") {
    const collectionMonths = input.collectionMonths ??
      (frequency === "HALF_YEARLY" ? [9, 3] : [3]);
    if (input.spreadAcrossPeriod) {
      const divisor = frequency === "HALF_YEARLY" ? 6 : 12;
      amount = periodLiability.dividedBy(divisor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      notes.push(`${frequency} liability spread across ${divisor} months`);
    } else if (!collectionMonths.includes(input.month)) {
      amount = new Decimal(0);
      notes.push(`Not a collection month for this ${frequency} state`);
    } else {
      notes.push(`Full ${frequency} liability collected in month ${input.month}`);
    }
  }

  // Article 276 caps professional tax at 2,500 per person per year across
  // every state they might have worked in.
  const ytd = nonNegative(input.ytdDeducted);
  const headroom = new Decimal(PT_ANNUAL_CEILING).minus(ytd);
  if (headroom.lessThanOrEqualTo(0)) {
    notes.push(`Annual PT ceiling of ${PT_ANNUAL_CEILING} already reached`);
    amount = new Decimal(0);
  } else if (amount.greaterThan(headroom)) {
    notes.push(`Restricted to the remaining annual headroom of ${headroom.toFixed(2)}`);
    amount = headroom;
  }

  return {
    amount: amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    periodLiability,
    slabMatched: true,
    applied: true,
    notes,
  };
}
