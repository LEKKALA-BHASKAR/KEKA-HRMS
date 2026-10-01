/**
 * Pure arithmetic for time requests — overtime hours and pay, encashment,
 * comp-off credit. No database access, so it is unit-tested directly.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** "05:30" → 330 minutes. Hours up to 24, minutes 00–59. */
export function parseHhmm(raw: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(raw ?? "");
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

/** 330 → "05:30". */
export function formatHhmm(minutes: number): string {
  const t = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Hourly overtime rate: annual basic over 2,920 hours (8 hours × 365 days). */
export function overtimeRate(annualBasic: number): number {
  return annualBasic > 0 ? Math.round((annualBasic / 2920) * 10_000) / 10_000 : 0;
}

export function overtimeAmount(minutes: number, rate: number): number {
  return r2((minutes / 60) * rate);
}

/** "[BASIC] / 30" → { code: "BASIC", divisor: 30 }, defaulting to basic over 30. */
export function encashmentFormulaParts(formula: string | null | undefined): { code: string; divisor: number } {
  const m = /^\s*\[(\w+)\]\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(formula ?? "");
  return m && Number(m[2]) > 0 ? { code: m[1], divisor: Number(m[2]) } : { code: "BASIC", divisor: 30 };
}

/** Rupees for days of leave at a monthly wage over a divisor, to the rupee. */
export function encashmentEstimate(daysToEncash: number, monthlyWage: number, divisor: number): number {
  if (daysToEncash <= 0 || monthlyWage <= 0 || divisor <= 0) return 0;
  return Math.round((monthlyWage / divisor) * daysToEncash);
}

/**
 * How many days may still be encashed this leave year: the free balance,
 * capped by what is left of the yearly encashment limit.
 */
export function encashableDays(opts: { freeBalance: number; maxPerYear: number | null; encashedThisYear: number }): number {
  const free = Math.max(0, opts.freeBalance);
  const cap = opts.maxPerYear === null ? Infinity : Math.max(0, opts.maxPerYear - opts.encashedThisYear);
  return Math.floor(Math.min(free, cap) * 2) / 2;
}

/**
 * Comp-off earned by working an off day: a full day when the hours reach the
 * policy's full-day threshold of the shift, half when they reach the half-day
 * threshold, otherwise none.
 */
export function compOffCreditFor(effectiveHours: number, requiredHours: number, fullPct: number, halfPct: number): number {
  if (effectiveHours <= 0 || requiredHours <= 0) return 0;
  const pct = (effectiveHours / requiredHours) * 100;
  return pct >= fullPct ? 1 : pct >= halfPct ? 0.5 : 0;
}

