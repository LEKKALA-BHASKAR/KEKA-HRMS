import Decimal from "decimal.js";

// Payroll must never use binary floating point. Every rupee figure in this
// system is a Decimal until the moment it is rendered or persisted.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;
export type Numeric = Decimal | number | string | null | undefined;

/** Coerce anything numeric-ish to a Decimal. Null and undefined become zero. */
export function money(value: Numeric): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

export const ZERO = new Decimal(0);

export function add(...values: Numeric[]): Decimal {
  return values.reduce<Decimal>((sum, v) => sum.plus(money(v)), new Decimal(0));
}

export function subtract(a: Numeric, b: Numeric): Decimal {
  return money(a).minus(money(b));
}

export function multiply(a: Numeric, b: Numeric): Decimal {
  return money(a).times(money(b));
}

export function divide(a: Numeric, b: Numeric): Decimal {
  const divisor = money(b);
  if (divisor.isZero()) return new Decimal(0);
  return money(a).dividedBy(divisor);
}

/** Percentage of a base: pct(100000, 12) === 12000. */
export function pct(base: Numeric, percent: Numeric): Decimal {
  return money(base).times(money(percent)).dividedBy(100);
}

/** Round to whole rupees, half-up. Salary components round this way. */
export function roundRupees(value: Numeric): Decimal {
  return money(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** Round to paise. Used for statutory figures that carry decimals. */
export function roundPaise(value: Numeric): Decimal {
  return money(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * TDS is deducted in whole rupees, rounded up — the Income Tax convention.
 */
export function roundTax(value: Numeric): Decimal {
  return money(value).toDecimalPlaces(0, Decimal.ROUND_CEIL);
}

/** Never let a computed figure go below zero. */
export function nonNegative(value: Numeric): Decimal {
  const d = money(value);
  return d.isNegative() ? new Decimal(0) : d;
}

/** Clamp between optional bounds. */
export function clamp(value: Numeric, min?: Numeric, max?: Numeric): Decimal {
  let d = money(value);
  if (min !== null && min !== undefined) {
    const lo = money(min);
    if (d.lessThan(lo)) d = lo;
  }
  if (max !== null && max !== undefined) {
    const hi = money(max);
    if (d.greaterThan(hi)) d = hi;
  }
  return d;
}

export function isZero(value: Numeric): boolean {
  return money(value).isZero();
}

/** Plain number, for JSON boundaries and Prisma writes. */
export function toNumber(value: Numeric): number {
  return money(value).toNumber();
}

/** Indian numbering with the rupee sign: 12,34,567.00 */
export function formatINR(value: Numeric, withSymbol = true): string {
  const n = money(value).toDecimalPlaces(2).toNumber();
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return withSymbol ? `₹${formatted}` : formatted;
}

/** Compact Indian format for dashboards: 1.2 Cr, 3.4 L, 56.7 K */
export function formatINRCompact(value: Numeric): string {
  const n = money(value).toNumber();
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)} L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

export { Decimal };
