import { Decimal, money, roundRupees, type Numeric } from "@keka/shared";

/**
 * Loan repayment schedules and the perquisite on concessional loans.
 *
 * Every schedule repays exactly the principal: rounding is carried, and the
 * last instalment absorbs what is left, so the ledger never ends a rupee out.
 */

export type InterestTypeLiteral = "NONE" | "FLAT" | "REDUCING";

export interface ScheduleInput {
  principal: Numeric;
  installments: number;
  interestType: InterestTypeLiteral;
  /** Annual rate in percent, e.g. 8.5. */
  annualRate?: Numeric;
  startYear: number;
  startMonth: number;
}

export interface ScheduledInstallment {
  sequence: number;
  year: number;
  month: number;
  principalPart: Decimal;
  interestPart: Decimal;
  totalAmount: Decimal;
  balanceAfter: Decimal;
}

export interface Schedule {
  emi: Decimal;
  totalInterest: Decimal;
  totalRepayable: Decimal;
  installments: ScheduledInstallment[];
}

function monthAt(startYear: number, startMonth: number, offset: number) {
  const idx = startYear * 12 + (startMonth - 1) + offset;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function buildLoanSchedule(input: ScheduleInput): Schedule {
  const n = Math.floor(input.installments);
  if (n < 1) throw new Error("A loan needs at least one instalment.");
  const P = roundRupees(input.principal);
  if (P.lte(0)) throw new Error("The principal must be positive.");
  const rate = money(input.annualRate);
  const type: InterestTypeLiteral = rate.isZero() ? "NONE" : input.interestType;

  const rows: ScheduledInstallment[] = [];
  let balance = P;

  if (type === "REDUCING") {
    // EMI = P·i·(1+i)^n / ((1+i)^n − 1), on a monthly rate.
    const i = rate.dividedBy(1200);
    const f = i.plus(1).pow(n);
    const emi = roundRupees(P.times(i).times(f).dividedBy(f.minus(1)));
    for (let k = 0; k < n; k++) {
      const interest = roundRupees(balance.times(i));
      const last = k === n - 1;
      const principalPart = last ? balance : Decimal.min(balance, emi.minus(interest));
      balance = balance.minus(principalPart);
      rows.push({ sequence: k + 1, ...monthAt(input.startYear, input.startMonth, k), principalPart, interestPart: interest, totalAmount: principalPart.plus(interest), balanceAfter: balance });
    }
  } else {
    // Equal principal; flat interest is charged on the original principal.
    const totalInterest = type === "FLAT" ? roundRupees(P.times(rate).dividedBy(100).times(n).dividedBy(12)) : new Decimal(0);
    const basePrincipal = P.dividedBy(n).floor();
    const baseInterest = totalInterest.dividedBy(n).floor();
    let interestLeft = totalInterest;
    for (let k = 0; k < n; k++) {
      const last = k === n - 1;
      const principalPart = last ? balance : basePrincipal;
      const interestPart = last ? interestLeft : baseInterest;
      balance = balance.minus(principalPart);
      interestLeft = interestLeft.minus(interestPart);
      rows.push({ sequence: k + 1, ...monthAt(input.startYear, input.startMonth, k), principalPart, interestPart, totalAmount: principalPart.plus(interestPart), balanceAfter: balance });
    }
  }

  const totalInterest = rows.reduce((s, r) => s.plus(r.interestPart), new Decimal(0));
  return {
    emi: rows[0].totalAmount,
    totalInterest,
    totalRepayable: P.plus(totalInterest),
    installments: rows,
  };
}

/**
 * Taxable perquisite on an interest-free or concessional loan, under Rule
 * 3(7)(i): the benchmark rate less the rate charged, on the outstanding
 * balance, for the month. Nothing is taxable when the employee's loans total
 * ₹20,000 or less, or for medical loans covered by Rule 3A.
 */
export function concessionalLoanPerquisite(opts: {
  outstanding: Numeric;
  benchmarkRate: Numeric;
  chargedRate: Numeric;
  aggregateOutstanding: Numeric;
  isMedical?: boolean;
}): { monthly: Decimal; reason: string } {
  if (opts.isMedical) return { monthly: new Decimal(0), reason: "Medical loans are exempt" };
  if (money(opts.aggregateOutstanding).lte(20000)) return { monthly: new Decimal(0), reason: "Total loans are ₹20,000 or less" };
  const gap = money(opts.benchmarkRate).minus(money(opts.chargedRate));
  if (gap.lte(0)) return { monthly: new Decimal(0), reason: "Charged at or above the benchmark rate" };
  return {
    monthly: roundRupees(money(opts.outstanding).times(gap).dividedBy(1200)),
    reason: `${gap.toFixed(2)}% below the SBI benchmark on the outstanding balance`,
  };
}
