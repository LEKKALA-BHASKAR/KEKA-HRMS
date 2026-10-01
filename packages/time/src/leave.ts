import {
  type DayPortion, type WorkCalendar, dayKey, addDaysUtc, eachDayUtc, classifyDay, isNonWorking,
} from "./calendar";

/**
 * Leave day-counting, the sandwich rule, and request validation.
 *
 * The sandwich rule is where leave policies get contentious, so it is modelled
 * explicitly rather than as a single on/off switch. Weekly offs and holidays
 * each carry independent triggers:
 *
 *   between          off-days inside the requested range, bounded by leave
 *   before           off-days immediately preceding the first leave day
 *   after            off-days immediately following the last leave day
 *   dayBetweenLeaves off-days separating this request from another leave
 *
 * clubAcrossLeaveTypes makes dayBetweenLeaves look at leave of any type, so
 * sick leave on Friday plus casual leave on Monday still sandwiches the weekend.
 */

export interface SandwichTriggers {
  between?: boolean;
  before?: boolean;
  after?: boolean;
  dayBetweenLeaves?: boolean;
}

export interface SandwichConfig {
  weeklyOff?: SandwichTriggers;
  holiday?: SandwichTriggers;
  /** Apply only when the leave itself spans at least this many days. */
  threshold?: number;
  /** A half-day at the boundary does not trigger the sandwich. */
  excludeHalfDay?: boolean;
  clubAcrossLeaveTypes?: boolean;
}

export function portionValue(p: DayPortion): number {
  return p === "FULL_DAY" ? 1 : p === "QUARTER" ? 0.25 : 0.5;
}

export interface LeaveDay {
  date: Date;
  key: string;
  portion: DayPortion;
  value: number;
  isSandwich: boolean;
}

export interface CountLeaveInput {
  from: Date;
  to: Date;
  fromPortion?: DayPortion;
  toPortion?: DayPortion;
  calendar: WorkCalendar;
  sandwich?: SandwichConfig | null;
  /**
   * Dates (yyyy-mm-dd) already covered by other approved or pending leave,
   * mapped to their portion. Used for dayBetweenLeaves and for overlap checks.
   */
  otherLeave?: Map<string, DayPortion>;
}

export interface CountLeaveResult {
  days: LeaveDay[];
  /** Days charged as leave, excluding sandwiched off-days. */
  leaveDays: number;
  sandwichDays: number;
  totalDays: number;
  /** Requested dates that are already covered by other leave. */
  overlaps: string[];
  /** The request covers no working time at all. */
  empty: boolean;
}

function triggersFor(kind: string, cfg: SandwichConfig): SandwichTriggers {
  return kind === "HOLIDAY" ? cfg.holiday ?? {} : cfg.weeklyOff ?? {};
}

export function countLeave(input: CountLeaveInput): CountLeaveResult {
  const { calendar } = input;
  const fromPortion = input.fromPortion ?? "FULL_DAY";
  const toPortion = input.toPortion ?? "FULL_DAY";
  const single = dayKey(input.from) === dayKey(input.to);
  const sw = input.sandwich ?? null;
  const other = input.otherLeave ?? new Map<string, DayPortion>();

  const range = eachDayUtc(input.from, input.to);
  const days: LeaveDay[] = [];
  const overlaps: string[] = [];

  // 1. The working days themselves.
  for (const d of range) {
    const key = dayKey(d);
    const kind = classifyDay(d, calendar);
    if (kind === "WEEKLY_OFF" || kind === "HOLIDAY") continue;

    let portion: DayPortion = "FULL_DAY";
    if (single) portion = fromPortion;
    else if (key === dayKey(input.from)) portion = fromPortion;
    else if (key === dayKey(input.to)) portion = toPortion;

    let value = portionValue(portion);
    // A half weekly-off leaves only half a working day to take.
    if (kind === "HALF_WEEKLY_OFF") value = Math.min(value, 0.5);

    if (other.has(key)) overlaps.push(key);
    days.push({ date: d, key, portion, value, isSandwich: false });
  }

  const leaveDays = days.reduce((s, x) => s + x.value, 0);

  // 2. The sandwich.
  const sandwiched = new Map<string, LeaveDay>();
  const firstLeave = days[0];
  const lastLeave = days[days.length - 1];
  const thresholdMet = !sw?.threshold || leaveDays >= sw.threshold;

  if (sw && days.length > 0 && thresholdMet) {
    const boundaryIsHalf = (ld: LeaveDay | undefined) =>
      !!ld && !!sw.excludeHalfDay && ld.portion !== "FULL_DAY";

    // between: off-days inside the range with leave on both sides.
    for (const d of range) {
      const kind = classifyDay(d, calendar);
      if (kind !== "WEEKLY_OFF" && kind !== "HOLIDAY") continue;
      if (!triggersFor(kind, sw).between) continue;
      if (d.getTime() > firstLeave.date.getTime() && d.getTime() < lastLeave.date.getTime()) {
        sandwiched.set(dayKey(d), { date: d, key: dayKey(d), portion: "FULL_DAY", value: 1, isSandwich: true });
      }
    }

    // Walk outward from the range over contiguous off-days.
    const walk = (start: Date, step: 1 | -1): Date[] => {
      const run: Date[] = [];
      let c = addDaysUtc(start, step);
      while (isNonWorking(c, calendar)) {
        run.push(c);
        c = addDaysUtc(c, step);
        if (run.length > 31) break;
      }
      return run;
    };

    const applyEdge = (edge: LeaveDay, step: 1 | -1, trigger: "before" | "after") => {
      if (boundaryIsHalf(edge)) return;
      const run = walk(edge.date, step);
      if (run.length === 0) return;
      const beyond = addDaysUtc(run[run.length - 1], step);
      const beyondIsLeave = other.has(dayKey(beyond)) &&
        !(sw.excludeHalfDay && other.get(dayKey(beyond)) !== "FULL_DAY");
      for (const d of run) {
        const t = triggersFor(classifyDay(d, calendar), sw);
        const byEdge = t[trigger] === true;
        const byNeighbour = t.dayBetweenLeaves === true && beyondIsLeave;
        if (byEdge || byNeighbour) {
          sandwiched.set(dayKey(d), { date: d, key: dayKey(d), portion: "FULL_DAY", value: 1, isSandwich: true });
        }
      }
    };

    applyEdge(firstLeave, -1, "before");
    applyEdge(lastLeave, 1, "after");
  }

  const sandwichDays = [...sandwiched.values()].reduce((s, x) => s + x.value, 0);
  const all = [...days, ...sandwiched.values()].sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    days: all,
    leaveDays,
    sandwichDays,
    totalDays: leaveDays + sandwichDays,
    overlaps,
    empty: days.length === 0,
  };
}

// ---------------------------------------------------------------------------
//  Validation against the leave type's rules
// ---------------------------------------------------------------------------

export interface LeaveTypeRules {
  name: string;
  isPaid: boolean;
  allowHalfDay: boolean;
  allowQuarterDay: boolean;
  allowBackdated: boolean;
  priorNoticeDays?: number | null;
  requireComment: boolean;
  attachmentAboveDays?: number | null;
  maxConsecutiveDays?: number | null;
  allowNegativeBalance: boolean;
  maxNegativeDays?: number | null;
  isUnlimited: boolean;
  accrueDuringProbation: boolean;
  maxDaysDuringProbation?: number | null;
}

export interface ValidateLeaveInput {
  rules: LeaveTypeRules;
  count: CountLeaveResult;
  from: Date;
  to: Date;
  fromPortion: DayPortion;
  toPortion: DayPortion;
  today: Date;
  /** Balance available right now, net of other pending requests. */
  available: number;
  reason?: string | null;
  hasAttachment?: boolean;
  onProbation?: boolean;
  /** Leave of this type already taken during probation. */
  usedDuringProbation?: number;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateLeave(input: ValidateLeaveInput): ValidationIssue[] {
  const r = input.rules;
  const issues: ValidationIssue[] = [];
  const total = input.count.totalDays;

  if (input.to.getTime() < input.from.getTime()) {
    issues.push({ field: "toDate", message: "The leave ends before it starts." });
    return issues;
  }
  if (input.count.empty) {
    issues.push({ field: "fromDate", message: "Those dates are all weekly offs or holidays — there is nothing to take leave from." });
  }
  if (input.count.overlaps.length > 0) {
    issues.push({
      field: "fromDate",
      message: `You already have leave on ${input.count.overlaps.join(", ")}.`,
    });
  }

  const portions = [input.fromPortion, input.toPortion];
  if (!r.allowHalfDay && portions.some((p) => p === "FIRST_HALF" || p === "SECOND_HALF")) {
    issues.push({ field: "fromPortion", message: `${r.name} cannot be taken as a half day.` });
  }
  if (!r.allowQuarterDay && portions.includes("QUARTER")) {
    issues.push({ field: "fromPortion", message: `${r.name} cannot be taken as a quarter day.` });
  }

  if (!r.allowBackdated && input.from.getTime() < input.today.getTime()) {
    issues.push({ field: "fromDate", message: `${r.name} cannot be applied for past dates.` });
  }
  if (r.priorNoticeDays && input.from.getTime() >= input.today.getTime()) {
    const noticeGiven = Math.floor((input.from.getTime() - input.today.getTime()) / 86_400_000);
    if (noticeGiven < r.priorNoticeDays) {
      issues.push({
        field: "fromDate",
        message: `${r.name} needs ${r.priorNoticeDays} day(s) notice; this gives ${noticeGiven}.`,
      });
    }
  }
  if (r.requireComment && !(input.reason && input.reason.trim().length > 0)) {
    issues.push({ field: "reason", message: "A reason is required for this leave type." });
  }
  if (r.attachmentAboveDays && total > r.attachmentAboveDays && !input.hasAttachment) {
    issues.push({
      field: "attachment",
      message: `Leave longer than ${r.attachmentAboveDays} day(s) needs a supporting document.`,
    });
  }
  if (r.maxConsecutiveDays && total > r.maxConsecutiveDays) {
    issues.push({
      field: "toDate",
      message: `At most ${r.maxConsecutiveDays} consecutive day(s) of ${r.name}; this is ${total}.`,
    });
  }

  if (input.onProbation) {
    if (!r.accrueDuringProbation && r.isPaid && !r.isUnlimited && input.available <= 0) {
      issues.push({ field: "leaveTypeId", message: `${r.name} is not available during probation.` });
    }
    if (r.maxDaysDuringProbation != null) {
      const after = (input.usedDuringProbation ?? 0) + total;
      if (after > r.maxDaysDuringProbation) {
        issues.push({
          field: "toDate",
          message: `Only ${r.maxDaysDuringProbation} day(s) of ${r.name} can be taken during probation.`,
        });
      }
    }
  }

  // Balance. Unpaid leave and unlimited types have no balance to check.
  if (r.isPaid && !r.isUnlimited) {
    const floor = r.allowNegativeBalance ? -(r.maxNegativeDays ?? 0) : 0;
    if (input.available - total < floor - 1e-9) {
      issues.push({
        field: "leaveTypeId",
        message: r.allowNegativeBalance
          ? `This would take ${r.name} below the permitted overdraft of ${r.maxNegativeDays ?? 0} day(s). Available: ${input.available}, requested: ${total}.`
          : `Not enough ${r.name}. Available: ${input.available}, requested: ${total}.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
//  Accrual
// ---------------------------------------------------------------------------

export type AccrualFrequency = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "UPFRONT";

export interface AccrualRules {
  frequency: AccrualFrequency;
  annualQuota: number;
  isUnlimited: boolean;
  prorateOnJoining: boolean;
  /** Joining after this day of the month earns nothing for that month. */
  noAwardIfJoinAfterDay?: number | null;
  accrueDuringProbation: boolean;
  maxAccumulation?: number | null;
}

export interface AccrualInput {
  rules: AccrualRules;
  /** The period being credited: month 1-12 of a calendar year. */
  year: number;
  month: number;
  /** First month of the leave year, 1-12. */
  leaveYearStartMonth: number;
  joinDate: Date;
  exitDate?: Date | null;
  /** Probation ends on this date; null means confirmed. */
  probationEndDate?: Date | null;
  /** Balance before this credit, for the accumulation cap. */
  currentBalance: number;
}

export interface AccrualResult {
  credit: number;
  /** Idempotency key for the ledger. */
  periodKey: string | null;
  reason: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Months between the leave-year start and this month, 0-based. */
function monthIndexInYear(month: number, startMonth: number): number {
  return (month - startMonth + 12) % 12;
}

/**
 * The k-th of n equal slices of a quota, rounded so the slices sum to the
 * quota exactly. 8 days monthly is 0.67, 0.66, 0.67… rather than twelve 0.67s
 * that drift to 8.04 by year end.
 */
export function slice(quota: number, periods: number, k: number): number {
  return round2(round2((quota * (k + 1)) / periods) - round2((quota * k) / periods));
}

export function accrueFor(input: AccrualInput): AccrualResult {
  const r = input.rules;
  const mm = String(input.month).padStart(2, "0");
  const periodEnd = new Date(Date.UTC(input.year, input.month, 0));
  const periodStart = new Date(Date.UTC(input.year, input.month - 1, 1));
  const dim = periodEnd.getUTCDate();

  if (r.isUnlimited || r.annualQuota <= 0) {
    return { credit: 0, periodKey: null, reason: "No accrual for this type" };
  }
  if (input.joinDate.getTime() > periodEnd.getTime()) {
    return { credit: 0, periodKey: null, reason: "Not yet joined" };
  }
  if (input.exitDate && input.exitDate.getTime() < periodStart.getTime()) {
    return { credit: 0, periodKey: null, reason: "Already exited" };
  }
  if (!r.accrueDuringProbation && input.probationEndDate &&
      input.probationEndDate.getTime() > periodEnd.getTime()) {
    return { credit: 0, periodKey: `${input.year}-${mm}`, reason: "On probation — accrual deferred" };
  }

  const idx = monthIndexInYear(input.month, input.leaveYearStartMonth);
  let credit = 0;
  let periodKey: string | null = `${input.year}-${mm}`;

  switch (r.frequency) {
    case "MONTHLY":
      credit = slice(r.annualQuota, 12, idx);
      break;
    case "QUARTERLY":
      if (idx % 3 !== 0) return { credit: 0, periodKey: null, reason: "Not a quarter start" };
      credit = slice(r.annualQuota, 4, idx / 3);
      periodKey = `${input.year}-Q${Math.floor(idx / 3) + 1}`;
      break;
    case "SEMI_ANNUAL":
      if (idx % 6 !== 0) return { credit: 0, periodKey: null, reason: "Not a half-year start" };
      credit = slice(r.annualQuota, 2, idx / 6);
      periodKey = `${input.year}-H${idx < 6 ? 1 : 2}`;
      break;
    case "ANNUAL":
    case "UPFRONT": {
      const joinedThisPeriod = input.joinDate.getTime() >= periodStart.getTime();
      if (idx !== 0 && !joinedThisPeriod) {
        return { credit: 0, periodKey: null, reason: "Credited once a year" };
      }
      credit = r.annualQuota;
      // A mid-year joiner gets the remaining share of the year.
      if (joinedThisPeriod && idx !== 0 && r.prorateOnJoining) {
        credit = r.annualQuota * ((12 - idx) / 12);
      }
      periodKey = `${input.year}-Y`;
      break;
    }
  }

  // Joining part-way through this month.
  const joinedThisMonth = input.joinDate.getUTCFullYear() === input.year &&
    input.joinDate.getUTCMonth() + 1 === input.month;
  if (joinedThisMonth && r.frequency === "MONTHLY") {
    const joinDay = input.joinDate.getUTCDate();
    if (r.noAwardIfJoinAfterDay && joinDay > r.noAwardIfJoinAfterDay) {
      return { credit: 0, periodKey, reason: `Joined after day ${r.noAwardIfJoinAfterDay}` };
    }
    if (r.prorateOnJoining) credit = credit * ((dim - joinDay + 1) / dim);
  }

  // Leaving part-way through this month.
  if (input.exitDate && input.exitDate.getTime() <= periodEnd.getTime() && r.frequency === "MONTHLY") {
    credit = credit * (input.exitDate.getUTCDate() / dim);
  }

  credit = round2(credit);

  if (r.maxAccumulation != null) {
    const headroom = Math.max(0, r.maxAccumulation - input.currentBalance);
    if (credit > headroom) {
      return {
        credit: round2(headroom), periodKey,
        reason: headroom === 0 ? "At the accumulation cap" : "Capped at the accumulation limit",
      };
    }
  }

  return { credit, periodKey, reason: "Accrued" };
}
