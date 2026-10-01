/**
 * What happens to an unused leave balance when the leave year closes, per
 * the leave type's year-end action. Pure: the job prices and posts it.
 */

export type YearEndActionKind = "RESET" | "PAY_ALL" | "CARRY_FORWARD_ALL" | "PAY_THEN_CARRY_FORWARD" | "CARRY_FORWARD_THEN_PAY";

export interface YearEndSplit { carry: number; pay: number; lapse: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split a closing balance into days carried forward, paid out and lapsed.
 * `carryMax`/`payMax` null means no cap; payment needs encashment enabled
 * (otherwise the paid share falls through to the next step, then lapses).
 * A negative balance is carried as a deficit whatever the action, so leave
 * taken in advance is recovered from next year's credit rather than written off.
 */
export function yearEndSplit(available: number, action: YearEndActionKind, opts: { carryMax: number | null; payMax: number | null; payEnabled: boolean }): YearEndSplit {
  const avail = r2(available);
  if (avail < 0) return { carry: avail, pay: 0, lapse: 0 };
  let left = avail;
  const take = (cap: number | null) => { const n = r2(Math.min(left, cap ?? left)); left = r2(left - n); return n; };
  const payCap = opts.payEnabled ? opts.payMax : 0;
  let carry = 0, pay = 0;
  switch (action) {
    case "RESET": break;
    case "PAY_ALL": pay = take(payCap); break;
    case "CARRY_FORWARD_ALL": carry = take(opts.carryMax); break;
    case "PAY_THEN_CARRY_FORWARD": pay = take(payCap); carry = take(opts.carryMax); break;
    case "CARRY_FORWARD_THEN_PAY": carry = take(opts.carryMax); pay = take(payCap); break;
  }
  return { carry, pay, lapse: left };
}

/**
 * Days of a carried-forward credit to lapse when it expires: whatever of it
 * this year's leave has not already used (carried days are used first), and
 * never more than the balance left.
 */
export function expiredCarryLapse(carried: number, usedThisYear: number, available: number): number {
  return r2(Math.max(0, Math.min(available, carried - Math.max(0, usedThisYear))));
}

/** The first day of the leave year after one starting on `yearStart`. */
export function nextLeaveYear(yearStart: Date): Date {
  return new Date(Date.UTC(yearStart.getUTCFullYear() + 1, yearStart.getUTCMonth(), yearStart.getUTCDate()));
}
