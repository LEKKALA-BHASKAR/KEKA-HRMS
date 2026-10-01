import "server-only";

/**
 * Helpers for /me/leave: leave-year arithmetic, balance figures from the
 * ledger, and plain-language descriptions of a leave type's rules.
 */

export const DAY = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const num = (v: unknown) => Number(v ?? 0);
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const monthName = (m0: number) => MON[m0];

/** "17 Sep 2026" */
export const dateLabel = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** "1 Day", "2.5 Days" */
export const daysLabel = (v: number, unit = "DAYS") => {
  const u = unit === "HOURS" ? "Hour" : "Day";
  return `${r2(v)} ${u}${v === 1 ? "" : "s"}`;
};
/** "3 days", "0 day" — the balance-cell style. */
export const daysLower = (v: number, unit = "DAYS") => {
  const u = unit === "HOURS" ? "hour" : "day";
  return `${r2(v)} ${u}${Math.abs(v) > 1 ? "s" : ""}`;
};

/** The leave year that starts on `start`: the day before the same date next year. */
export const yearEnd = (start: Date) =>
  new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()) - DAY);
export const shiftYears = (start: Date, n: number) =>
  new Date(Date.UTC(start.getUTCFullYear() + n, start.getUTCMonth(), start.getUTCDate()));
/** "Apr 2026 - Mar 2027" */
export const yearLabel = (start: Date) => {
  const end = yearEnd(start);
  return `${MON[start.getUTCMonth()]} ${start.getUTCFullYear()} - ${MON[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
};

/**
 * The categorical palette (fixed order, never cycled past eight). A type's
 * own colour wins; otherwise its position in the plan picks the slot.
 */
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const colourFor = (index: number, own?: string | null) =>
  own && /^#[0-9a-f]{6}$/i.test(own) ? own : PALETTE[index % PALETTE.length];

export interface LedgerLike { kind: string; days: unknown }

/** Balance figures from the ledger — the record that explains every balance. */
export function fromLedger(entries: LedgerLike[]) {
  const sum = (kinds: string[]) => entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + num(e.days), 0);
  return {
    credited: r2(sum(["OPENING", "ACCRUAL", "COMP_OFF_CREDIT", "ADJUSTMENT", "CARRY_FORWARD"])),
    consumed: r2(-sum(["USED", "REVERSAL"])),
    encashed: r2(-sum(["ENCASHMENT"])),
    lapsed: r2(-sum(["LAPSE"])),
    available: r2(entries.reduce((s, e) => s + num(e.days), 0)),
  };
}

export const KIND_LABEL: Record<string, string> = {
  OPENING: "Opening balance", ACCRUAL: "Accrual", USED: "Leave taken", REVERSAL: "Returned (cancelled leave)",
  ADJUSTMENT: "Adjustment by HR", CARRY_FORWARD: "Carried forward", LAPSE: "Lapsed", ENCASHMENT: "Encashed",
  COMP_OFF_CREDIT: "Comp-off credit",
};

const FREQ: Record<string, string> = {
  MONTHLY: "monthly", QUARTERLY: "quarterly", SEMI_ANNUAL: "every six months", ANNUAL: "once a year", UPFRONT: "upfront at the start of the year",
};
const PERIODS: Record<string, number> = { MONTHLY: 12, QUARTERLY: 4, SEMI_ANNUAL: 2, ANNUAL: 1, UPFRONT: 1 };
const YEAR_END: Record<string, string> = {
  RESET: "Unused balance lapses",
  PAY_ALL: "Unused balance is paid out",
  CARRY_FORWARD_ALL: "Unused balance carries forward",
  PAY_THEN_CARRY_FORWARD: "Paid out first, the rest carries forward",
  CARRY_FORWARD_THEN_PAY: "Carries forward first, the rest is paid out",
};

export interface TypeRules {
  name: string; code: string; category: string; isPaid: boolean; isUnlimited: boolean; unit: string;
  accrualFrequency: string; annualQuota: unknown; prorateOnJoining: boolean; noAwardIfJoinAfterDay: number | null;
  accrueDuringProbation: boolean; probationWaitDays: number | null; maxDaysDuringProbation: unknown;
  maxAccumulation: unknown; allowNegativeBalance: boolean; maxNegativeDays: unknown;
  allowHalfDay: boolean; allowQuarterDay: boolean; allowBackdated: boolean; priorNoticeDays: number | null;
  requireComment: boolean; attachmentAboveDays: unknown; maxConsecutiveDays: unknown; maxDaysPerMonth: unknown;
  minGapBetweenLeavesDays: number | null; sandwichConfig: unknown; yearEndAction: string;
  carryForwardMax: unknown; carryForwardExpiryDays: number | null; encashmentEnabled: boolean; expiryDaysAfterCredit: number | null;
}

/** Every rule of a leave type as a short sentence, in the order people ask about them. */
export function describeRules(t: TypeRules, quota: number): string[] {
  const out: string[] = [];
  const unit = t.unit === "HOURS" ? "hours" : "days";
  if (t.isUnlimited || t.category === "UNPAID") {
    out.push(t.isPaid ? "No limit on the number of days." : "No limit on the number of days. Every day taken is loss of pay in payroll.");
  } else if (t.category === "INCIDENT") {
    out.push(`Granted per event — up to ${quota} ${unit} each time.`);
  } else if (t.category === "COMP_OFF") {
    out.push("Earned by working on a weekly off or holiday; credited by HR once approved.");
  } else {
    const per = PERIODS[t.accrualFrequency] ?? 12;
    out.push(`${quota} ${unit} a year, credited ${FREQ[t.accrualFrequency] ?? t.accrualFrequency.toLowerCase()}${per > 1 ? ` (${r2(quota / per)} each time)` : ""}.`);
  }
  if (!t.isPaid && t.category !== "UNPAID") out.push("Unpaid — days taken are loss of pay.");
  if (t.category !== "UNPAID" && !t.isUnlimited) {
    if (t.prorateOnJoining && t.category !== "COMP_OFF" && t.category !== "INCIDENT") out.push(`Prorated in the year you join${t.noAwardIfJoinAfterDay ? `; nothing for a month if you join after day ${t.noAwardIfJoinAfterDay}` : ""}.`);
    if (!t.accrueDuringProbation) out.push("Does not accrue during probation.");
    if (t.probationWaitDays) out.push(`Accrual starts ${t.probationWaitDays} days after joining.`);
    if (t.maxDaysDuringProbation !== null && t.maxDaysDuringProbation !== undefined) out.push(`At most ${num(t.maxDaysDuringProbation)} ${unit} may be used during probation.`);
    if (t.maxAccumulation) out.push(`The balance stops growing at ${num(t.maxAccumulation)} ${unit}.`);
    if (t.expiryDaysAfterCredit) out.push(`Each credit expires ${t.expiryDaysAfterCredit} days after it lands.`);
    out.push(t.allowNegativeBalance ? `May go negative${t.maxNegativeDays ? ` by up to ${num(t.maxNegativeDays)} ${unit}` : ""}.` : "Cannot be taken beyond the available balance.");
  }
  const portions = ["full days", t.allowHalfDay ? "half days" : null, t.allowQuarterDay ? "quarter days" : null].filter(Boolean);
  out.push(`Can be taken as ${portions.join(", ")}.`);
  out.push(t.allowBackdated ? "Can be applied after the fact." : "Must be applied before the leave starts.");
  if (t.priorNoticeDays) out.push(`Apply at least ${t.priorNoticeDays} days in advance.`);
  if (t.requireComment) out.push("A reason is required.");
  if (t.attachmentAboveDays) out.push(`A document is needed for more than ${num(t.attachmentAboveDays)} ${unit}.`);
  if (t.maxConsecutiveDays) out.push(`At most ${num(t.maxConsecutiveDays)} ${unit} in a row.`);
  if (t.maxDaysPerMonth) out.push(`At most ${num(t.maxDaysPerMonth)} ${unit} in a month.`);
  if (t.minGapBetweenLeavesDays) out.push(`Leave a gap of ${t.minGapBetweenLeavesDays} days between two requests.`);

  const sw = (t.sandwichConfig ?? null) as {
    weeklyOff?: { between?: boolean; before?: boolean }; holiday?: { between?: boolean; before?: boolean };
    clubAcrossLeaveTypes?: boolean; excludeHalfDay?: boolean;
  } | null;
  const swOff = !!(sw?.weeklyOff?.between || sw?.weeklyOff?.before);
  const swHol = !!(sw?.holiday?.between || sw?.holiday?.before);
  if (swOff || swHol) {
    const what = [swOff ? "weekly offs" : null, swHol ? "holidays" : null].filter(Boolean).join(" and ");
    const edges = sw?.weeklyOff?.before || sw?.holiday?.before;
    out.push(`Sandwich rule: ${what} between leave days${edges ? " (and next to them)" : ""} count as leave${sw?.clubAcrossLeaveTypes ? ", across leave types" : ""}${sw?.excludeHalfDay ? "; not when a half day touches them" : ""}.`);
  } else if (t.category !== "UNPAID") {
    out.push("Weekly offs and holidays inside the leave are not counted.");
  }
  if (t.category !== "UNPAID" && !t.isUnlimited && t.category !== "INCIDENT") {
    const cap = t.carryForwardMax ? ` (up to ${num(t.carryForwardMax)} ${unit})` : "";
    out.push(`At year end: ${(YEAR_END[t.yearEndAction] ?? t.yearEndAction).toLowerCase()}${t.yearEndAction.includes("CARRY") ? cap : ""}${t.carryForwardExpiryDays ? `; carried days expire after ${t.carryForwardExpiryDays} days` : ""}.`);
  }
  if (t.encashmentEnabled) out.push("Encashable — the balance is paid out in your full & final settlement.");
  return out;
}
