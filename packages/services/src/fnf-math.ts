/**
 * Pure rules for the full-and-final settlement beyond its computation: which
 * month it settles in, whether it can be voided, what a void must put back,
 * adjustments made after it, and the totals the settlements report shows.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const periodLabel = (year: number, month: number) => `${MONTHS[month]} ${year}`;
const idx = (year: number, month: number) => year * 12 + (month - 1);

/** How far after the last working day a settlement may still be booked. */
export const SETTLEMENT_MONTH_WINDOW = 6;

/**
 * A settlement is booked in the month of the last working day or a later
 * one, within the window — never a month before the person left.
 */
export function validateSettlementMonth(lastWorkingDay: Date, year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return "Choose a settlement month.";
  const lwd = idx(lastWorkingDay.getUTCFullYear(), lastWorkingDay.getUTCMonth() + 1);
  const chosen = idx(year, month);
  if (chosen < lwd) return `The settlement cannot be booked before the last working day's month (${periodLabel(lastWorkingDay.getUTCFullYear(), lastWorkingDay.getUTCMonth() + 1)}).`;
  if (chosen > lwd + SETTLEMENT_MONTH_WINDOW) return `Book the settlement within ${SETTLEMENT_MONTH_WINDOW} months of the last working day.`;
  return null;
}

/** The months a settlement may be booked in, the last working day's first. */
export function settlementMonthOptions(lastWorkingDay: Date): Array<{ year: number; month: number; value: string; label: string }> {
  const start = idx(lastWorkingDay.getUTCFullYear(), lastWorkingDay.getUTCMonth() + 1);
  return Array.from({ length: SETTLEMENT_MONTH_WINDOW + 1 }, (_, i) => {
    const year = Math.floor((start + i) / 12), month = ((start + i) % 12) + 1;
    return { year, month, value: `${year}-${String(month).padStart(2, "0")}`, label: periodLabel(year, month) };
  });
}

/** Parse "2026-09" into a year and month, or null. */
export function parsePeriod(v: string | null | undefined): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec((v ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year: Number(m[1]), month } : null;
}

/**
 * What finalising changed, recorded on the settlement so a void can put
 * exactly those records back and nothing else.
 */
export interface FnfEffects {
  installments: Array<{ id: string; interestPart: number; totalAmount: number }>;
  loans: Array<{ id: string; status: string }>;
  assetAssignmentIds: string[];
  bonusIds: string[];
  claimIds: string[];
  employeeStatus: string;
  exitStatus: string;
}

export const SETTLED_STATUSES = ["FINALIZED", "PAID", "ALREADY_PAID"] as const;
export const isSettled = (status: string) => (SETTLED_STATUSES as readonly string[]).includes(status);

/** Why a settlement cannot be voided, or null when it can. */
export function voidBlocker(input: { status: string; reason: string; processedAdjustments: number }): string | null {
  if (!isSettled(input.status)) return input.status === "VOIDED" ? "The settlement is already voided." : "Only a finalised settlement can be voided; a draft can simply be recomputed.";
  if (input.reason.trim().length < 5) return "Say why the settlement is being voided.";
  if (input.processedAdjustments > 0) return `${input.processedAdjustments} adjustment(s) on this settlement have been paid in a payroll. Roll that payroll back first.`;
  return null;
}

/**
 * What a void restores, from the recorded effects. A settlement finalised
 * before effects were recorded can still be voided, but its loans and
 * recoveries are left as they are and the caller says so.
 */
export function voidPlan(effects: FnfEffects | null | undefined): {
  installments: FnfEffects["installments"]; loans: FnfEffects["loans"]; assetAssignmentIds: string[]; bonusIds: string[]; claimIds: string[];
  employeeStatus: string; exitStatus: string; partial: boolean;
} {
  if (!effects) return { installments: [], loans: [], assetAssignmentIds: [], bonusIds: [], claimIds: [], employeeStatus: "NOTICE_PERIOD", exitStatus: "IN_CLEARANCE", partial: true };
  return {
    installments: effects.installments, loans: effects.loans, assetAssignmentIds: effects.assetAssignmentIds,
    bonusIds: effects.bonusIds, claimIds: effects.claimIds,
    // The employee goes back to how they were, but never to EXITED: that is what we are undoing.
    employeeStatus: effects.employeeStatus && effects.employeeStatus !== "EXITED" ? effects.employeeStatus : "NOTICE_PERIOD",
    // The exit reopens for clearance so a fresh settlement can be drafted.
    exitStatus: "IN_CLEARANCE", partial: false,
  };
}

export interface AdjustmentLike { type: "PAYMENT" | "DEDUCTION"; amount: number; isProcessed: boolean }

/** Paid out (+) or recovered (−) by adjustments after the settlement. */
export function adjustmentsNet(list: AdjustmentLike[], opts: { processedOnly?: boolean } = {}): number {
  return r2(list.filter((a) => !opts.processedOnly || a.isProcessed).reduce((s, a) => s + (a.type === "PAYMENT" ? a.amount : -a.amount), 0));
}

/** Where an adjustment stands, in words. */
export function adjustmentStatus(a: { isProcessed: boolean; run?: { type: string; status: string; year: number; month: number } | null; year: number; month: number }): string {
  if (a.isProcessed && a.run) return `Paid in the ${a.run.type === "OFF_CYCLE" ? "off-cycle" : "regular"} payroll for ${periodLabel(a.run.year, a.run.month)}`;
  if (a.run) return `On the ${a.run.type === "OFF_CYCLE" ? "off-cycle" : "regular"} payroll for ${periodLabel(a.run.year, a.run.month)}, not finalised`;
  return `Pending — picked up by the ${periodLabel(a.year, a.month)} payroll if the employee is in it, or add it to an off-cycle payroll`;
}

/** Validate a new adjustment's figures; returns the error or null. */
export function validateAdjustment(input: { name: string; amount: number; type: string }): string | null {
  if (input.type !== "PAYMENT" && input.type !== "DEDUCTION") return "Choose whether this pays or recovers.";
  if (!input.name.trim()) return "Describe the adjustment.";
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) return "Enter an amount above zero.";
  if (input.amount > 1e8) return "That amount is too large for an adjustment.";
  return null;
}

export interface FnfReportRow {
  status: string;
  totalPayable: number;
  totalRecovery: number;
  net: number;
  adjustmentsNet: number;
}

/** Totals for the settlements report, overall and by status. */
export function fnfReportTotals(rows: FnfReportRow[]): { count: number; payable: number; recovery: number; net: number; adjustments: number; byStatus: Record<string, { count: number; net: number }> } {
  const byStatus: Record<string, { count: number; net: number }> = {};
  let payable = 0, recovery = 0, net = 0, adjustments = 0;
  for (const r of rows) {
    const b = (byStatus[r.status] ??= { count: 0, net: 0 });
    b.count++;
    // A voided settlement no longer pays anything; it is counted, not summed.
    if (r.status === "VOIDED") continue;
    b.net = r2(b.net + r.net);
    payable += r.totalPayable; recovery += r.totalRecovery; net += r.net; adjustments += r.adjustmentsNet;
  }
  return { count: rows.length, payable: r2(payable), recovery: r2(recovery), net: r2(net), adjustments: r2(adjustments), byStatus };
}
