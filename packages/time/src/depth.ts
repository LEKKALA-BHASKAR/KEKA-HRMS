import {
  type DayKind, type WeeklyOffConfig, type OffPortion, type Weekday, WEEKDAYS, dayKey,
} from "./calendar";
import type { ShiftSpec } from "./attendance";

/**
 * Time and leave depth: hourly leave, advance leave, encashment windows,
 * comp-off by hours, remote-work rules, regularisation limits, absent without
 * leave, auto clock-out, per-day shift timings, weekly-off patterns and the
 * roster import. Pure functions — the services layer gathers their inputs.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function hhmmToMinutes(t: string): number | null {
  const m = HHMM.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ---------------------------------------------------------------------------
//  Hourly leave
// ---------------------------------------------------------------------------

export interface HourlyLeaveRules {
  name: string;
  /** Hours that make one working day. */
  hoursPerDay?: number | null;
  minHoursPerRequest?: number | null;
  maxHoursPerDay?: number | null;
  /** Requests move in steps of this many minutes (30 = half hours). */
  hourIncrementMinutes?: number | null;
}

export const DEFAULT_HOURS_PER_DAY = 8;

export function hourlyLeaveIssues(rules: HourlyLeaveRules, hours: number | null | undefined, startTime?: string | null): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (hours == null || !Number.isFinite(hours) || hours <= 0) {
    issues.push({ field: "hours", message: `Enter how many hours of ${rules.name} you need.` });
    return issues;
  }
  const perDay = rules.hoursPerDay && rules.hoursPerDay > 0 ? rules.hoursPerDay : DEFAULT_HOURS_PER_DAY;
  const max = rules.maxHoursPerDay && rules.maxHoursPerDay > 0 ? Math.min(rules.maxHoursPerDay, perDay) : perDay;
  if (hours > max + 1e-9) issues.push({ field: "hours", message: `At most ${max} hour(s) of ${rules.name} on one day.` });
  if (rules.minHoursPerRequest && hours < rules.minHoursPerRequest - 1e-9) {
    issues.push({ field: "hours", message: `${rules.name} is taken in at least ${rules.minHoursPerRequest} hour(s).` });
  }
  const step = rules.hourIncrementMinutes && rules.hourIncrementMinutes > 0 ? rules.hourIncrementMinutes : 15;
  const minutes = Math.round(hours * 60);
  if (Math.abs(hours * 60 - minutes) > 1e-6 || minutes % step !== 0) {
    issues.push({ field: "hours", message: `${rules.name} is taken in steps of ${step} minutes.` });
  }
  if (startTime && hhmmToMinutes(startTime) === null) issues.push({ field: "startTime", message: "Give the start time as HH:MM." });
  if (startTime && hhmmToMinutes(startTime) !== null && hhmmToMinutes(startTime)! + minutes > 24 * 60) {
    issues.push({ field: "startTime", message: "The hours run past midnight." });
  }
  return issues;
}

/** The share of a working day that some hours of leave cover, 0..1. */
export function hoursToDayValue(hours: number, hoursPerDay?: number | null): number {
  const perDay = hoursPerDay && hoursPerDay > 0 ? hoursPerDay : DEFAULT_HOURS_PER_DAY;
  return r2(Math.min(1, Math.max(0, hours / perDay)));
}

/** The day portion an hourly leave is shown as on calendars. */
export function portionForDayValue(value: number): "FULL_DAY" | "FIRST_HALF" | "QUARTER" {
  return value >= 1 ? "FULL_DAY" : value >= 0.5 ? "FIRST_HALF" : "QUARTER";
}

// ---------------------------------------------------------------------------
//  Advance leave — taken against accrual still to come, recovered from it
// ---------------------------------------------------------------------------

/**
 * How far below zero a balance may go because of accrual still due this
 * leave year: the smaller of the policy's cap and what is left to accrue.
 */
export function advanceAllowance(opts: { allow: boolean; maxDays: number | null; annualQuota: number; creditedThisYear: number }): number {
  if (!opts.allow || !opts.maxDays || opts.maxDays <= 0) return 0;
  const toCome = Math.max(0, opts.annualQuota - Math.max(0, opts.creditedThisYear));
  return r2(Math.min(opts.maxDays, toCome));
}

/** The part of a request that goes beyond the balance actually held. */
export function advancePortion(available: number, requested: number, allowance: number): number {
  if (allowance <= 0 || requested <= 0) return 0;
  const beyond = requested - Math.max(0, available);
  return r2(Math.min(allowance, Math.max(0, beyond)));
}

/** Of an accrual credit, the part that pays back advance leave (a negative balance). */
export function advanceRecovered(balanceBefore: number, credit: number): number {
  if (balanceBefore >= 0 || credit <= 0) return 0;
  return r2(Math.min(credit, -balanceBefore));
}

// ---------------------------------------------------------------------------
//  Encashment policy
// ---------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Null when encashment is open this month; otherwise why not. */
export function encashmentWindowIssue(months: number[] | null | undefined, month: number): string | null {
  const open = (months ?? []).filter((m) => m >= 1 && m <= 12);
  if (open.length === 0 || open.includes(month)) return null;
  return `Encashment is open only in ${[...new Set(open)].sort((a, b) => a - b).map((m) => MONTHS[m - 1]).join(", ")}.`;
}

/**
 * Days that may be encashed: the free balance less the minimum to keep,
 * capped by what is left of the yearly limit, in half days.
 */
export function encashableUnderPolicy(opts: { freeBalance: number; minBalance: number | null; maxPerYear: number | null; encashedThisYear: number }): number {
  const free = Math.max(0, opts.freeBalance - Math.max(0, opts.minBalance ?? 0));
  const cap = opts.maxPerYear === null ? Infinity : Math.max(0, opts.maxPerYear - opts.encashedThisYear);
  return Math.floor(Math.min(free, cap) * 2) / 2;
}

// ---------------------------------------------------------------------------
//  Comp-off by hours, and from overtime
// ---------------------------------------------------------------------------

/**
 * Comp-off earned on an off day. With minimum hours configured the hours
 * decide; otherwise the share of the shift against the policy thresholds.
 */
export function compOffCreditFromHours(opts: {
  hours: number; requiredHours: number; fullPct: number; halfPct: number;
  halfDayMinHours?: number | null; fullDayMinHours?: number | null;
}): number {
  if (opts.hours <= 0) return 0;
  if (opts.fullDayMinHours || opts.halfDayMinHours) {
    if (opts.fullDayMinHours && opts.hours >= opts.fullDayMinHours) return 1;
    if (opts.halfDayMinHours && opts.hours >= opts.halfDayMinHours) return 0.5;
    return 0;
  }
  if (opts.requiredHours <= 0) return 0;
  const pct = (opts.hours / opts.requiredHours) * 100;
  return pct >= opts.fullPct ? 1 : pct >= opts.halfPct ? 0.5 : 0;
}

/** Overtime minutes converted to comp-off days, rounded down to half days. */
export function overtimeToCompOffDays(minutes: number, hoursPerDay: number): number {
  if (minutes <= 0 || hoursPerDay <= 0) return 0;
  return Math.floor((minutes / 60 / hoursPerDay) * 2) / 2;
}

// ---------------------------------------------------------------------------
//  Remote work rules
// ---------------------------------------------------------------------------

export interface RemoteWorkRules {
  monthlyLimit: number | null;
  noticeDays: number | null;
  allowedOnHolidays: boolean;
  allowedOnWeeklyOffs: boolean;
  attachmentRequired: boolean;
}

export interface RemoteWorkCheck {
  label: string;
  rules: RemoteWorkRules;
  from: Date;
  to: Date;
  today: Date;
  /** Each requested date with how the calendar treats it. */
  days: Array<{ date: Date; kind: DayKind }>;
  /** Days of this kind already pending or approved, per "yyyy-mm". */
  usedByMonth: Map<string, number>;
  /** 1 for a full day, 0.5 for a half day; hourly requests count 0. */
  unit: number;
  hasAttachment: boolean;
}

/** The working-day value each month gets from this request, and every rule it breaks. */
export function remoteWorkIssues(c: RemoteWorkCheck): string[] {
  const out: string[] = [];
  const r = c.rules;
  if (r.noticeDays && r.noticeDays > 0) {
    const notice = Math.floor((c.from.getTime() - c.today.getTime()) / 86_400_000);
    if (notice < r.noticeDays) out.push(`${c.label} needs ${r.noticeDays} day(s) notice; this gives ${Math.max(0, notice)}.`);
  }
  const holidays = c.days.filter((d) => d.kind === "HOLIDAY");
  const offs = c.days.filter((d) => d.kind === "WEEKLY_OFF");
  if (holidays.length && !r.allowedOnHolidays) out.push(`${c.label} cannot be requested on a holiday (${holidays.map((d) => dayKey(d.date)).join(", ")}).`);
  if (offs.length && !r.allowedOnWeeklyOffs) out.push(`${c.label} cannot be requested on a weekly off (${offs.map((d) => dayKey(d.date)).join(", ")}).`);
  if (r.attachmentRequired && !c.hasAttachment) out.push(`${c.label} needs a supporting document.`);
  if (r.monthlyLimit != null && c.unit > 0) {
    const add = new Map<string, number>();
    for (const d of c.days) {
      const counts = d.kind === "WORKING" || d.kind === "HALF_WEEKLY_OFF"
        || (d.kind === "HOLIDAY" && r.allowedOnHolidays) || (d.kind === "WEEKLY_OFF" && r.allowedOnWeeklyOffs);
      if (!counts) continue;
      const m = dayKey(d.date).slice(0, 7);
      add.set(m, (add.get(m) ?? 0) + c.unit);
    }
    for (const [m, n] of add) {
      const total = (c.usedByMonth.get(m) ?? 0) + n;
      if (total > r.monthlyLimit + 1e-9) {
        out.push(`${c.label} is limited to ${r.monthlyLimit} day(s) a month; ${m} would reach ${r2(total)}.`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Regularisation limits
// ---------------------------------------------------------------------------

/**
 * A correction for `date` is closed once the cut-off day of the following
 * month has passed, and a month allows only so many corrections.
 */
export function regularisationIssue(opts: { date: Date; today: Date; cutoffDay: number | null; monthlyLimit: number | null; usedInMonth: number }): string | null {
  if (opts.cutoffDay && opts.cutoffDay > 0) {
    const y = opts.date.getUTCFullYear(), m = opts.date.getUTCMonth();
    const dim = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    const cutoff = new Date(Date.UTC(y, m + 1, Math.min(opts.cutoffDay, dim)));
    if (opts.today.getTime() > cutoff.getTime()) {
      return `Corrections for ${MONTHS[m]} ${y} closed on ${dayKey(cutoff)}.`;
    }
  }
  if (opts.monthlyLimit != null && opts.usedInMonth >= opts.monthlyLimit) {
    return `You have used all ${opts.monthlyLimit} attendance correction(s) allowed for ${MONTHS[opts.date.getUTCMonth()]}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Absent without leave
// ---------------------------------------------------------------------------

/**
 * Days to mark absent without leave: every day of a run of at least
 * `afterDays` consecutive no-shows. Weekly offs and holidays neither count
 * toward nor break a run; any other day ends it.
 */
export function awolKeys(days: Array<{ key: string; status: string }>, afterDays: number): Set<string> {
  const out = new Set<string>();
  if (afterDays <= 0) return out;
  const sorted = [...days].sort((a, b) => a.key.localeCompare(b.key));
  let run: string[] = [];
  const flush = () => { if (run.length >= afterDays) run.forEach((k) => out.add(k)); run = []; };
  for (const d of sorted) {
    if (d.status === "WEEKLY_OFF" || d.status === "HOLIDAY") continue;
    if (d.status === "NO_ATTENDANCE") run.push(d.key);
    else flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
//  Auto clock-out
// ---------------------------------------------------------------------------

/** When an open IN should be closed, or null if it may stay open. */
export function autoClockOutAt(openIn: Date, maxSlotMinutes: number | null | undefined, now: Date): Date | null {
  if (!maxSlotMinutes || maxSlotMinutes <= 0) return null;
  const due = new Date(openIn.getTime() + maxSlotMinutes * 60_000);
  return due.getTime() <= now.getTime() ? due : null;
}

// ---------------------------------------------------------------------------
//  Shift timings per weekday
// ---------------------------------------------------------------------------

export type DaySchedule = Partial<Record<Weekday, { startTime: string; endTime: string; breakMinutes?: number }>>;

export function parseDaySchedule(raw: unknown): DaySchedule {
  const out: DaySchedule = {};
  if (!raw || typeof raw !== "object") return out;
  for (const d of WEEKDAYS) {
    const v = (raw as Record<string, unknown>)[d] as { startTime?: unknown; endTime?: unknown; breakMinutes?: unknown } | undefined;
    if (!v || typeof v.startTime !== "string" || typeof v.endTime !== "string") continue;
    if (hhmmToMinutes(v.startTime) === null || hhmmToMinutes(v.endTime) === null) continue;
    out[d] = {
      startTime: v.startTime, endTime: v.endTime,
      ...(typeof v.breakMinutes === "number" && v.breakMinutes >= 0 ? { breakMinutes: v.breakMinutes } : {}),
    };
  }
  return out;
}

/** The shift as it runs on a date: the weekday's own timings when it has them. */
export function shiftForDate(base: ShiftSpec, schedule: unknown, date: Date): ShiftSpec {
  const day = parseDaySchedule(schedule)[WEEKDAYS[date.getUTCDay()]];
  if (!day || base.isFlexible) return base;
  return { ...base, startTime: day.startTime, endTime: day.endTime, breakMinutes: day.breakMinutes ?? base.breakMinutes };
}

// ---------------------------------------------------------------------------
//  Weekly-off patterns
// ---------------------------------------------------------------------------

/** How a weekday is set in the weekly-off editor. */
export type WeekdayRule = "WORKING" | "ALL" | "ALT_2_4" | "ALT_1_3_5" | "CUSTOM";

export function weeklyOffConfigFrom(rows: Partial<Record<Weekday, { rule: WeekdayRule; instances?: number[]; portion?: OffPortion }>>): WeeklyOffConfig {
  const out: WeeklyOffConfig = {};
  for (const d of WEEKDAYS) {
    const row = rows[d];
    if (!row || row.rule === "WORKING") continue;
    const instances: "ALL" | number[] = row.rule === "ALL" ? "ALL"
      : row.rule === "ALT_2_4" ? [2, 4]
      : row.rule === "ALT_1_3_5" ? [1, 3, 5]
      : [...new Set((row.instances ?? []).filter((n) => n >= 1 && n <= 5))].sort();
    if (Array.isArray(instances) && instances.length === 0) continue;
    out[d] = { instances, ...(row.portion && row.portion !== "FULL_DAY" ? { portion: row.portion } : {}) };
  }
  return out;
}

/** The editor's view of a stored pattern. */
export function weekdayRuleOf(config: WeeklyOffConfig, d: Weekday): { rule: WeekdayRule; instances: number[]; portion: OffPortion } {
  const v = config[d];
  if (!v) return { rule: "WORKING", instances: [], portion: "FULL_DAY" };
  const portion = v.portion ?? "FULL_DAY";
  if (v.instances === "ALL") return { rule: "ALL", instances: [1, 2, 3, 4, 5], portion };
  const s = [...v.instances].sort().join(",");
  if (s === "2,4") return { rule: "ALT_2_4", instances: [2, 4], portion };
  if (s === "1,3,5") return { rule: "ALT_1_3_5", instances: [1, 3, 5], portion };
  return { rule: "CUSTOM", instances: [...v.instances], portion };
}

// ---------------------------------------------------------------------------
//  Roster CSV import
// ---------------------------------------------------------------------------

export interface RosterImportRow { line: number; employeeNumber: string; date: string; shiftCode: string }

/**
 * employee number, date (yyyy-mm-dd or dd-mm-yyyy / dd/mm/yyyy), shift code.
 * A shift code of WO or OFF marks a weekly off. A header row is optional.
 */
export function parseRosterCsv(text: string): { rows: RosterImportRow[]; errors: Array<{ line: number; message: string }> } {
  const rows: RosterImportRow[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const cells = raw.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    if (i === 0 && /employee|emp/i.test(cells[0] ?? "") && /date/i.test(cells[1] ?? "")) return;
    if (cells.length < 3 || !cells[0] || !cells[1] || !cells[2]) {
      errors.push({ line, message: "Expected employee number, date and shift code." });
      return;
    }
    let date: string | null = null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cells[1]);
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(cells[1]);
    if (iso) date = cells[1];
    else if (dmy) date = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    const valid = date && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    if (!valid) {
      errors.push({ line, message: `"${cells[1]}" is not a date (use yyyy-mm-dd).` });
      return;
    }
    rows.push({ line, employeeNumber: cells[0], date: date!, shiftCode: cells[2].toUpperCase() });
  });
  return { rows, errors };
}

// ---------------------------------------------------------------------------
//  Non-project timesheet
// ---------------------------------------------------------------------------

/** Monday of the week a date falls in. */
export function weekStartOf(d: Date): Date {
  const day = d.getUTCDay();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7)));
}

export function workLogIssues(days: Array<{ key: string; hours: number }>): string[] {
  const out: string[] = [];
  for (const d of days) {
    if (!Number.isFinite(d.hours) || d.hours < 0) out.push(`${d.key}: hours cannot be negative.`);
    else if (d.hours > 24) out.push(`${d.key}: at most 24 hours in a day.`);
    else if (Math.round(d.hours * 4) !== d.hours * 4) out.push(`${d.key}: log hours in quarter hours.`);
  }
  return out;
}
