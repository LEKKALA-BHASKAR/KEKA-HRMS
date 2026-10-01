import { fyMonths, fyStartYear } from "@keka/shared";

/**
 * Pure rules behind My Finances: reimbursement entitlements, previous-employer
 * income, the ITR calendar, payroll-month pickers and the labels the loan
 * screens show. No database here, so every rule is unit-tested.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const monthIndex = (y: number, m: number) => y * 12 + (m - 1);

/**
 * Previous-employer income belongs to exactly one financial year: the one
 * the employee joined in. Before that they did not work here; after it, the
 * figures describe a year that is over. The profile does not record the year,
 * so the joining date decides.
 */
export function previousIncomeApplies(dateOfJoining: Date, fy: number, fyStartMonth = 4): boolean {
  return fyStartYear(dateOfJoining, fyStartMonth) === fy;
}

export interface Entitlement {
  /** Monthly accrual: the annual limit over twelve. */
  monthly: number;
  /** Months employed in the FY, and what they add up to. */
  monthsInFy: number;
  annual: number;
  /** Months up to and including the current one, and what has accrued. */
  monthsAccrued: number;
  accrued: number;
}

/**
 * A flexible-benefit reimbursement accrues a twelfth of its annual limit for
 * every month the employee is employed in the year, from the joining month to
 * the last working month. Claims are allowed against what has accrued.
 */
export function claimEntitlement(o: {
  annualLimit: number; joinedOn: Date; lastWorkingDay?: Date | null; fy: number; fyStartMonth?: number; today: Date;
}): Entitlement {
  const monthly = r2(o.annualLimit / 12);
  const months = fyMonths(o.fy, o.fyStartMonth ?? 4);
  const now = monthIndex(o.today.getUTCFullYear(), o.today.getUTCMonth() + 1);
  let monthsInFy = 0, monthsAccrued = 0;
  for (const { year, month } of months) {
    const start = new Date(Date.UTC(year, month - 1, 1)), end = new Date(Date.UTC(year, month, 0));
    const employed = o.joinedOn <= end && (!o.lastWorkingDay || o.lastWorkingDay >= start);
    if (!employed) continue;
    monthsInFy++;
    if (monthIndex(year, month) <= now) monthsAccrued++;
  }
  return { monthly, monthsInFy, annual: r2(monthly * monthsInFy), monthsAccrued, accrued: r2(monthly * monthsAccrued) };
}

/** What may still be claimed: accrued, less what is approved or paid, less what is waiting. */
export function claimRemaining(accrued: number, claimed: number, pending: number): number {
  return Math.max(0, r2(accrued - claimed - pending));
}

/** The return due for the last completed FY, and the belated-return window under s.139(4). */
export function itrCalendar(today: Date, fyStartMonth = 4) {
  const fy = fyStartYear(today, fyStartMonth) - 1;
  const due = new Date(Date.UTC(fy + 1, 6, 31));
  const belatedTill = new Date(Date.UTC(fy + 1, 11, 31));
  return {
    fy,
    label: `FY ${fy} - ${fy + 1} (AY ${fy + 1} - ${fy + 2})`,
    due,
    belatedTill,
    passed: today > new Date(Date.UTC(fy + 1, 6, 31, 23, 59, 59)),
  };
}

/**
 * The first payroll month still open for a new request: this month, or the
 * month after the last one locked or finalised, whichever is later.
 */
export function firstOpenPayrollMonth(today: Date, closed: Array<{ year: number; month: number }>): { year: number; month: number } {
  let idx = monthIndex(today.getUTCFullYear(), today.getUTCMonth() + 1);
  for (const c of closed) idx = Math.max(idx, monthIndex(c.year, c.month) + 1);
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** N consecutive payroll months from a starting month. */
export function payrollMonths(from: { year: number; month: number }, count = 12): Array<{ year: number; month: number }> {
  const base = monthIndex(from.year, from.month);
  return Array.from({ length: count }, (_, k) => ({ year: Math.floor((base + k) / 12), month: ((base + k) % 12) + 1 }));
}

export function compareMonths(a: { year: number; month: number }, b: { year: number; month: number }): number {
  return monthIndex(a.year, a.month) - monthIndex(b.year, b.month);
}

/** "Paid", "Pending", "On Hold" or "Void" for one bonus on the salary timeline. */
export function bonusStatus(b: { isProcessed: boolean; payAction: string }): "Paid" | "Pending" | "On Hold" | "Void" {
  if (b.isProcessed) return "Paid";
  if (b.payAction === "ON_HOLD") return "On Hold";
  if (b.payAction === "VOID") return "Void";
  return "Pending";
}

/** "8 %" over "Flat Rate", as Keka's loan category table shows a rule's interest. */
export function interestLabel(type: string, rate: number): { rate: string; kind: string } {
  const pct = `${Number.isInteger(rate) ? rate : rate.toFixed(2)} %`;
  if (type === "REDUCING" && rate > 0) return { rate: pct, kind: "Reducing Balance" };
  return { rate: type === "NONE" ? "0 %" : pct, kind: "Flat Rate" };
}

/** The eligibility rules of a loan policy, in plain sentences. */
export function loanEligibilityLines(p: {
  minDaysFromJoining: number | null; minAnnualSalary: number | null; maxAnnualSalary: number | null;
  blockOnNoticePeriod: boolean; requireProbationComplete: boolean; approvalRequired: boolean;
}, fmt: (n: number) => string = (n) => String(n)): string[] {
  const lines: string[] = [];
  if (p.minDaysFromJoining) lines.push(`Employees are eligible for loans after ${p.minDaysFromJoining} days after joining.`);
  if (p.minAnnualSalary && p.maxAnnualSalary) lines.push(`Annual salary in between ${fmt(p.minAnnualSalary)} - ${fmt(p.maxAnnualSalary)}.`);
  else if (p.minAnnualSalary) lines.push(`Annual salary of at least ${fmt(p.minAnnualSalary)}.`);
  else if (p.maxAnnualSalary) lines.push(`Annual salary of at most ${fmt(p.maxAnnualSalary)}.`);
  lines.push(p.blockOnNoticePeriod ? "Employees in notice period are not eligible for loan." : "Employees in notice period are eligible for loan.");
  if (p.requireProbationComplete) lines.push("Employees on probation are not eligible for loan.");
  lines.push(p.approvalRequired ? "Approval is required." : "Approval is not required.");
  return lines;
}

/** Totals over a repayment schedule: what is paid, what is left, principal against interest. */
export function scheduleTotals(rows: Array<{ principalPart: number; interestPart: number; totalAmount: number; status: string }>) {
  const paidStatuses = new Set(["DEDUCTED", "PREPAID", "WAIVED"]);
  const total = r2(rows.reduce((s, r) => s + r.totalAmount, 0));
  const paid = r2(rows.filter((r) => paidStatuses.has(r.status)).reduce((s, r) => s + r.totalAmount, 0));
  return {
    total,
    paid,
    left: r2(total - paid),
    principal: r2(rows.reduce((s, r) => s + r.principalPart, 0)),
    interest: r2(rows.reduce((s, r) => s + r.interestPart, 0)),
  };
}

/** Tax saved by a deduction: the marginal slab rate plus 4% cess. */
export function marginalSaving(amount: number, marginalRatePercent: number, cessPercent = 4): number {
  return Math.round(amount * (marginalRatePercent / 100) * (1 + cessPercent / 100));
}
