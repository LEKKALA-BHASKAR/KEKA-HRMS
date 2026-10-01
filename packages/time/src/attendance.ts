import type { DayKind, DayPortion } from "./calendar";

/**
 * Attendance evaluation: one day, judged against a shift and a policy.
 *
 * The one rule that must never be broken: a day on approved leave carries
 * lopValue 0 here even when the leave is unpaid, because unpaid leave already
 * reaches payroll as loss of pay through the leave request. Counting it in
 * both places would deduct the same day twice.
 */

export interface ShiftSpec {
  /** Local wall-clock times, "HH:MM". */
  startTime: string;
  endTime: string;
  breakMinutes: number;
  isFlexible: boolean;
  /** Required hours for a flexible shift. */
  requiredHours?: number | null;
  crossesMidnight?: boolean;
}

export interface AttendanceRules {
  fullDayThresholdPct: number;
  halfDayThresholdPct: number;
  graceMinutes: number;
  lateExemptPerMonth: number;
  latePenaltyDays: number;
  missingPunchExemptPerMonth: number;
  missingPunchPenaltyDays: number;
  noAttendanceIsLop: boolean;
  overtimeEnabled: boolean;
  overtimeMinMinutes: number;
}

export const DEFAULT_RULES: AttendanceRules = {
  fullDayThresholdPct: 90,
  halfDayThresholdPct: 50,
  graceMinutes: 15,
  lateExemptPerMonth: 3,
  latePenaltyDays: 0.5,
  missingPunchExemptPerMonth: 2,
  missingPunchPenaltyDays: 0.5,
  noAttendanceIsLop: true,
  overtimeEnabled: false,
  overtimeMinMinutes: 30,
};

export interface PunchLog {
  timestamp: Date;
  /** 0 = IN, 1 = OUT. */
  direction: 0 | 1;
}

export type AttendanceStatusLiteral =
  | "PRESENT" | "ABSENT" | "HALF_DAY" | "ON_LEAVE" | "WEEKLY_OFF"
  | "HOLIDAY" | "ON_DUTY" | "WORK_FROM_HOME" | "NO_ATTENDANCE";

export interface DayInput {
  date: Date;
  kind: DayKind;
  shift: ShiftSpec;
  rules: AttendanceRules;
  logs: PunchLog[];
  /** Approved leave on this day, if any. */
  leave?: { portion: DayPortion; isPaid: boolean } | null;
  /** Approved WFH / on-duty covering this day. */
  remote?: "WORK_FROM_HOME" | "ON_DUTY" | null;
  /**
   * The part of the day the remote work covers. FIRST_HALF / SECOND_HALF
   * leave the other half to be accounted for by punches; absent or FULL_DAY
   * covers the whole day.
   */
  remotePortion?: DayPortion | null;
  /** An approved regularisation waives this day's penalties. */
  regularised?: boolean;
  /** Minutes of approved partial-day absence. */
  partialMinutes?: number;
  /** Minutes east of UTC for the employee's location. India is +330. */
  tzOffsetMinutes?: number;
  /** Attendance is not tracked for this person at all. */
  trackAttendance?: boolean;
}

export interface DayResult {
  status: AttendanceStatusLiteral;
  firstIn: Date | null;
  lastOut: Date | null;
  grossHours: number;
  effectiveHours: number;
  requiredHours: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeHours: number;
  isLate: boolean;
  isMissingPunch: boolean;
  /** Share of the day that is payable, 0..1. */
  payableValue: number;
  /** Share of the day that is loss of pay, before monthly penalties. */
  lopValue: number;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Minutes after local midnight for a UTC instant. */
function localMinutes(d: Date, tz: number): number {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes() + tz;
  return ((m % 1440) + 1440) % 1440;
}

export function requiredHoursFor(shift: ShiftSpec): number {
  if (shift.isFlexible && shift.requiredHours) return shift.requiredHours;
  let span = hhmmToMinutes(shift.endTime) - hhmmToMinutes(shift.startTime);
  if (span <= 0 || shift.crossesMidnight) span += 1440;
  return Math.max(0, (span - shift.breakMinutes) / 60);
}

/**
 * Pair punches into worked intervals. Unpaired punches are reported as a
 * missing punch rather than guessed at.
 */
export function pairPunches(logs: PunchLog[]): {
  intervals: Array<[Date, Date]>; missing: boolean; first: Date | null; last: Date | null;
} {
  const sorted = [...logs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const intervals: Array<[Date, Date]> = [];
  let open: Date | null = null;
  let missing = false;

  for (const log of sorted) {
    if (log.direction === 0) {
      if (open) missing = true; // two INs in a row
      open = log.timestamp;
    } else {
      if (!open) { missing = true; continue; } // OUT without IN
      intervals.push([open, log.timestamp]);
      open = null;
    }
  }
  if (open) missing = true; // IN never closed

  const ins = sorted.filter((l) => l.direction === 0);
  const outs = sorted.filter((l) => l.direction === 1);
  return {
    intervals,
    missing,
    first: ins[0]?.timestamp ?? null,
    last: outs[outs.length - 1]?.timestamp ?? null,
  };
}

export function evaluateDay(input: DayInput): DayResult {
  const tz = input.tzOffsetMinutes ?? 330;
  const rules = input.rules;
  const notes: string[] = [];
  const required = requiredHoursFor(input.shift);
  const { intervals, missing, first, last } = pairPunches(input.logs);

  const effectiveHours = r2(intervals.reduce(
    (s, [a, b]) => s + Math.max(0, b.getTime() - a.getTime()) / 3_600_000, 0));
  const grossHours = first && last && last > first
    ? r2((last.getTime() - first.getTime()) / 3_600_000) : 0;

  const base: DayResult = {
    status: "NO_ATTENDANCE", firstIn: first, lastOut: last,
    grossHours, effectiveHours, requiredHours: r2(required),
    lateMinutes: 0, earlyExitMinutes: 0, overtimeHours: 0,
    isLate: false, isMissingPunch: missing,
    payableValue: 1, lopValue: 0, notes,
  };

  // --- Off days: always payable; work done is overtime --------------------
  if (input.kind === "WEEKLY_OFF" || input.kind === "HOLIDAY") {
    const status = input.kind === "HOLIDAY" ? "HOLIDAY" : "WEEKLY_OFF";
    let overtimeHours = 0;
    if (rules.overtimeEnabled && effectiveHours * 60 >= rules.overtimeMinMinutes) {
      overtimeHours = effectiveHours;
      notes.push(`Worked ${effectiveHours}h on a ${status === "HOLIDAY" ? "holiday" : "weekly off"}`);
    }
    return { ...base, status, isMissingPunch: false, overtimeHours, payableValue: 1, lopValue: 0 };
  }

  // --- Untracked: payable, no judgement ------------------------------------
  if (input.trackAttendance === false) {
    return { ...base, status: "PRESENT", isMissingPunch: false, payableValue: 1, lopValue: 0 };
  }

  const leaveShare = input.leave
    ? input.leave.portion === "FULL_DAY" ? 1 : input.leave.portion === "QUARTER" ? 0.25 : 0.5
    : 0;

  // --- Full-day leave ------------------------------------------------------
  if (leaveShare >= 1) {
    notes.push(input.leave!.isPaid ? "On paid leave" : "On unpaid leave — LOP is charged through the leave request");
    return {
      ...base, status: "ON_LEAVE", isMissingPunch: false,
      payableValue: input.leave!.isPaid ? 1 : 0,
      lopValue: 0,
    };
  }

  // --- Remote work counts as attended --------------------------------------
  const halfRemote = !!input.remote && (input.remotePortion === "FIRST_HALF" || input.remotePortion === "SECOND_HALF");
  const remoteShare = input.remote ? (halfRemote ? 0.5 : 1) : 0;
  if (input.remote && (!halfRemote || leaveShare + remoteShare >= 1)) {
    return {
      ...base, status: input.remote, isMissingPunch: false,
      payableValue: 1, lopValue: 0,
    };
  }
  if (halfRemote) notes.push(`${input.remote === "ON_DUTY" ? "On duty" : "Work from home"} for the ${input.remotePortion === "FIRST_HALF" ? "first" : "second"} half`);

  // The part of the day that has to be accounted for by attendance.
  const workShare = 1 - leaveShare - remoteShare;
  // Half the day already accounted for (leave or remote work) makes a
  // fully-worked remainder a half day of attendance rather than absence.
  const partShare = leaveShare + remoteShare;
  const workRequired = required * workShare - (input.partialMinutes ?? 0) / 60;

  // --- Nothing punched -----------------------------------------------------
  if (input.logs.length === 0) {
    if (input.regularised) {
      notes.push("Regularised — no punches, penalty waived");
      return { ...base, status: "PRESENT", payableValue: 1, lopValue: 0 };
    }
    const lop = rules.noAttendanceIsLop ? workShare : 0;
    notes.push(rules.noAttendanceIsLop ? "No attendance recorded" : "No attendance recorded (not treated as LOP)");
    return {
      ...base, status: partShare > 0 ? "HALF_DAY" : "NO_ATTENDANCE",
      payableValue: r2(1 - lop), lopValue: r2(lop),
    };
  }

  // --- Late arrival and early exit -----------------------------------------
  let lateMinutes = 0;
  let earlyExitMinutes = 0;
  if (!input.shift.isFlexible && first) {
    const start = hhmmToMinutes(input.shift.startTime);
    const arrived = localMinutes(first, tz);
    // A first-half leave (or first-half remote work) means the shift
    // effectively starts at mid-day in the office.
    const firstHalfOff = input.leave?.portion === "FIRST_HALF" || (halfRemote && input.remotePortion === "FIRST_HALF");
    const secondHalfOff = input.leave?.portion === "SECOND_HALF" || (halfRemote && input.remotePortion === "SECOND_HALF");
    const expected = firstHalfOff
      ? start + (required * 60 + input.shift.breakMinutes) / 2
      : start;
    lateMinutes = Math.max(0, arrived - expected);
    if (last && !secondHalfOff) {
      const end = hhmmToMinutes(input.shift.endTime);
      const left = localMinutes(last, tz);
      if (!input.shift.crossesMidnight) earlyExitMinutes = Math.max(0, end - left);
    }
  }
  const isLate = lateMinutes > rules.graceMinutes && !input.regularised;
  if (isLate) notes.push(`Late by ${lateMinutes} minutes`);

  // --- Classify on effective hours -----------------------------------------
  let status: AttendanceStatusLiteral;
  let worked: number; // share of the working portion earned

  if (input.regularised) {
    status = leaveShare > 0 ? "HALF_DAY" : "PRESENT";
    worked = 1;
    notes.push("Regularised — hours and penalties waived");
  } else if (missing && effectiveHours === 0) {
    // Only an IN or only an OUT: presence is evident, duration is not.
    status = leaveShare > 0 ? "HALF_DAY" : "PRESENT";
    worked = 1;
    notes.push("Missing punch — presence counted, subject to the monthly missing-punch rule");
  } else {
    const pct = workRequired <= 0 ? 100 : (effectiveHours / workRequired) * 100;
    if (pct >= rules.fullDayThresholdPct) {
      worked = 1;
      status = leaveShare > 0 ? "HALF_DAY" : "PRESENT";
    } else if (pct >= rules.halfDayThresholdPct) {
      worked = 0.5;
      status = "HALF_DAY";
      notes.push(`Worked ${effectiveHours}h of ${r2(workRequired)}h required — half day`);
    } else {
      worked = 0;
      status = partShare > 0 ? "HALF_DAY" : "ABSENT";
      notes.push(`Worked ${effectiveHours}h of ${r2(workRequired)}h required — below the half-day threshold`);
    }
  }

  const lopValue = r2(workShare * (1 - worked));
  const leavePaid = input.leave ? (input.leave.isPaid ? leaveShare : 0) : 0;
  const payableValue = r2(workShare * worked + leavePaid + remoteShare);

  // --- Overtime ------------------------------------------------------------
  let overtimeHours = 0;
  if (rules.overtimeEnabled && !input.regularised) {
    const extraMin = (effectiveHours - required) * 60;
    if (extraMin >= rules.overtimeMinMinutes) overtimeHours = r2(extraMin / 60);
  }

  return {
    ...base, status, lateMinutes, earlyExitMinutes, isLate,
    isMissingPunch: missing && !input.regularised,
    overtimeHours, payableValue, lopValue, notes,
  };
}

/**
 * Monthly penalties. Late arrivals and missing punches are forgiven up to the
 * policy's exemption count; each one beyond it adds a penalty to that day's
 * LOP, in date order, capped so a day never exceeds one full day of LOP.
 */
export function applyMonthlyPenalties(
  days: Array<DayResult & { date: Date }>,
  rules: AttendanceRules,
): Array<DayResult & { date: Date; penaltyReason: string | null }> {
  const sorted = [...days].sort((a, b) => a.date.getTime() - b.date.getTime());
  let late = 0;
  let missing = 0;

  return sorted.map((d) => {
    let lop = d.lopValue;
    const reasons: string[] = [];

    if (d.isLate) {
      late++;
      if (late > rules.lateExemptPerMonth && rules.latePenaltyDays > 0) {
        lop += rules.latePenaltyDays;
        reasons.push(`Late arrival ${late} this month (${rules.lateExemptPerMonth} exempt)`);
      }
    }
    if (d.isMissingPunch) {
      missing++;
      if (missing > rules.missingPunchExemptPerMonth && rules.missingPunchPenaltyDays > 0) {
        lop += rules.missingPunchPenaltyDays;
        reasons.push(`Missing punch ${missing} this month (${rules.missingPunchExemptPerMonth} exempt)`);
      }
    }

    // A penalty can only take away what the day was paying.
    lop = Math.min(lop, d.lopValue + d.payableValue);
    const added = r2(lop - d.lopValue);
    return {
      ...d,
      lopValue: r2(lop),
      payableValue: r2(Math.max(0, d.payableValue - added)),
      penaltyReason: reasons.length > 0 ? reasons.join("; ") : null,
    };
  });
}
