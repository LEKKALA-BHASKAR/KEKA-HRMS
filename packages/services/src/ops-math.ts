/**
 * Ops depth — pure helpers for the time, attendance, leave, payroll and
 * lifecycle controls (39-ops-depth). Nothing here touches the database, so
 * the unit tests cover the rules directly. Every export is prefixed or named
 * distinctly so the services barrel (export *) stays free of clashes.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
export const opsDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const opsYmd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
export const opsAddDays = (d: Date, n: number) => new Date(opsDay(d).getTime() + n * DAY);

// ---------------------------------------------------------------------------
//  Configuration changes under approval
// ---------------------------------------------------------------------------

export type OpsFieldType = "int" | "decimal" | "bool" | "text" | "enum";
export interface OpsFieldSpec { key: string; label: string; type: OpsFieldType; min?: number; max?: number; options?: string[] }
export interface OpsConfigKind { label: string; area: "ATTENDANCE" | "TIME" | "LEAVE" | "PAYROLL"; permission: string; fields: OpsFieldSpec[] }

const int = (key: string, label: string, min = 0, max = 100_000): OpsFieldSpec => ({ key, label, type: "int", min, max });
const dec = (key: string, label: string, min = 0, max = 100_000_000): OpsFieldSpec => ({ key, label, type: "decimal", min, max });
const flag = (key: string, label: string): OpsFieldSpec => ({ key, label, type: "bool" });

/** The configuration a change request can touch, and who governs it. */
export const OPS_CONFIG_KINDS = {
  ATTENDANCE_POLICY: {
    label: "Attendance policy", area: "ATTENDANCE", permission: "time.attendance.manage",
    fields: [
      int("graceMinutes", "Late grace (minutes)", 0, 240), int("lateExemptPerMonth", "Late marks forgiven a month", 0, 31), dec("latePenaltyDays", "LOP days per late mark", 0, 1),
      int("missingPunchExemptPerMonth", "Missing punches forgiven a month", 0, 31), dec("missingPunchPenaltyDays", "LOP days per missing punch", 0, 1),
      int("fullDayThresholdPct", "Full day at (% of shift)", 1, 100), int("halfDayThresholdPct", "Half day at (% of shift)", 1, 100),
      int("regularisationWindowDays", "Regularisation window (days)", 0, 365), flag("overtimeEnabled", "Overtime counted"), int("overtimeMinMinutes", "Overtime starts after (minutes)", 0, 480),
      flag("noAttendanceIsLop", "No attendance is loss of pay"), flag("isActive", "Active"),
    ],
  },
  WORK_HOUR_POLICY: {
    label: "Work-hour (timesheet) policy", area: "TIME", permission: "psa.project.manage",
    fields: [
      dec("maxHoursPerDay", "Most hours in a day", 1, 24), dec("minHoursPerDay", "Fewest hours in a day (0 = none)", 0, 24),
      dec("minHoursPerWeek", "Fewest hours in a week (0 = none)", 0, 168), dec("maxHoursPerWeek", "Most hours in a week (0 = none)", 0, 168),
      dec("flagWeeklyHoursAbove", "Flag weeks above (hours)", 1, 168), flag("autoApprove", "Approve automatically"),
    ],
  },
  LEAVE_TYPE: {
    label: "Leave type", area: "LEAVE", permission: "time.leave.manage",
    fields: [
      dec("annualQuota", "Annual quota (days)", 0, 365), dec("maxAccumulation", "Most that can accumulate (days)", 0, 999), dec("carryForwardMax", "Most carried forward (days)", 0, 999),
      int("priorNoticeDays", "Notice needed (days)", 0, 365), dec("maxConsecutiveDays", "Most consecutive days", 0, 365), flag("allowHalfDay", "Half days allowed"),
      flag("allowNegativeBalance", "Negative balance allowed"), dec("maxNegativeDays", "Most negative (days)", 0, 365), flag("requireComment", "Reason required"),
      flag("allowBackdated", "Backdated requests allowed"), flag("encashmentEnabled", "Encashable"), flag("isActive", "Active"),
    ],
  },
  LEAVE_POLICY: {
    label: "Leave plan (policy)", area: "LEAVE", permission: "time.leave.manage",
    fields: [{ key: "description", label: "Description", type: "text" }, { key: "yearBasis", label: "Leave year", type: "enum", options: ["CALENDAR_JAN", "FINANCIAL_APR", "JOINING_DATE"] }, flag("isActive", "Active")],
  },
  SALARY_STRUCTURE: {
    label: "Salary structure", area: "PAYROLL", permission: "payroll.structure.manage",
    fields: [
      dec("minAnnualCtc", "Lowest annual CTC"), dec("maxAnnualCtc", "Highest annual CTC"), flag("pfEnabled", "PF applies"), flag("esiEnabled", "ESI applies"),
      { key: "tdsMethod", label: "TDS method", type: "enum", options: ["AVERAGE", "FLAT", "NONE"] }, flag("roundComponents", "Round components"), flag("isActive", "Active"),
    ],
  },
  PAY_CYCLE: {
    label: "Pay cycle (pay group)", area: "PAYROLL", permission: "payroll.paygroup.manage",
    fields: [
      int("payPeriodStartDay", "Period starts on day", 1, 28), int("payPeriodEndDay", "Period ends on day (0 = month end)", 0, 28), int("attendanceCutoffDay", "Attendance cut-off day", 1, 31),
      int("payDay", "Pay day", 1, 31), int("declarationOpenDay", "Declarations open on day", 1, 31), int("declarationCloseDay", "Declarations close on day", 1, 31),
      flag("pfEnabled", "PF"), flag("esiEnabled", "ESI"), flag("ptEnabled", "Professional tax"), flag("lwfEnabled", "LWF"),
    ],
  },
  PAY_COMPONENT: {
    label: "Earning / deduction component", area: "PAYROLL", permission: "payroll.settings.manage",
    fields: [
      { key: "displayName", label: "Name on payslip", type: "text" }, { key: "taxTreatment", label: "Tax treatment", type: "enum", options: ["FULLY_TAXABLE", "PARTIALLY_EXEMPT", "FULLY_EXEMPT"] },
      flag("isLopApplicable", "Reduced for LOP"), flag("affectsPfWage", "Part of PF wage"), flag("affectsEsiGross", "Part of ESI gross"), flag("showOnPayslip", "Shown on payslip"),
      int("displayOrder", "Order", 0, 999), flag("isActive", "Active"),
    ],
  },
} satisfies Record<string, OpsConfigKind>;
export type OpsConfigKindKey = keyof typeof OPS_CONFIG_KINDS;
export const isOpsConfigKind = (v: string): v is OpsConfigKindKey => v in OPS_CONFIG_KINDS;

/** Coerce a form value to a field's type; null when blank, an error string when invalid. */
export function opsParseField(spec: OpsFieldSpec, raw: string | null | undefined): { value: unknown } | { error: string } {
  const s = (raw ?? "").trim();
  switch (spec.type) {
    case "bool": return { value: ["on", "true", "1", "yes"].includes(s.toLowerCase()) };
    case "text": return { value: s || null };
    case "enum": return !s ? { value: null } : spec.options?.includes(s) ? { value: s } : { error: `${spec.label}: choose one of ${spec.options?.join(", ")}.` };
    default: {
      if (!s) return { value: null };
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: `${spec.label} must be a number.` };
      if (spec.type === "int" && !Number.isInteger(n)) return { error: `${spec.label} must be a whole number.` };
      if (spec.min !== undefined && n < spec.min) return { error: `${spec.label} must be at least ${spec.min}.` };
      if (spec.max !== undefined && n > spec.max) return { error: `${spec.label} must be at most ${spec.max}.` };
      return { value: n };
    }
  }
}

const norm = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" && "toString" in (v as object) && !(v instanceof Date) ? Number(String(v)) : v);

/** The fields a proposal actually changes, with their before and after values. */
export function opsConfigDiff(fields: OpsFieldSpec[], before: Record<string, unknown>, proposed: Record<string, unknown>): Array<{ key: string; label: string; from: unknown; to: unknown }> {
  const out: Array<{ key: string; label: string; from: unknown; to: unknown }> = [];
  for (const f of fields) {
    if (!(f.key in proposed)) continue;
    const a = norm(before[f.key]);
    const b = norm(proposed[f.key]);
    const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;
    if (!same) out.push({ key: f.key, label: f.label, from: a, to: b });
  }
  return out;
}

/** "Field: a → b" lines for a change. */
export function opsDescribeDiff(diff: Array<{ label: string; from: unknown; to: unknown }>): string {
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : v === true ? "yes" : v === false ? "no" : String(v));
  return diff.map((d) => `${d.label}: ${show(d.from)} → ${show(d.to)}`).join("; ");
}

/** The version in force on a date, from a list sorted any way. */
export function opsVersionAt<T extends { version: number; effectiveFrom: Date }>(versions: T[], at: Date): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom.getTime() === best.effectiveFrom.getTime() && v.version > best.version)) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Attendance
// ---------------------------------------------------------------------------

/** The payroll attendance cut-off for a month (the 25th by default, clamped to the month's end). */
export function opsCutoffDate(year: number, month: number, cutoffDay = 25): Date {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(Math.max(cutoffDay, 1), last)));
}

/** The next cut-off on or after a day, and how many days away it is. */
export function opsNextCutoff(now: Date, cutoffDay = 25): { date: Date; daysLeft: number } {
  const today = opsDay(now);
  let c = opsCutoffDate(today.getUTCFullYear(), today.getUTCMonth() + 1, cutoffDay);
  if (c < today) {
    const m = today.getUTCMonth() + 2;
    c = opsCutoffDate(today.getUTCFullYear() + (m > 12 ? 1 : 0), ((m - 1) % 12) + 1, cutoffDay);
  }
  return { date: c, daysLeft: Math.round((c.getTime() - today.getTime()) / DAY) };
}

/** Whether a cut-off reminder goes out today. */
export function opsCutoffAlertDue(now: Date, cutoffDay = 25, daysBefore = 3): boolean {
  const { daysLeft } = opsNextCutoff(now, cutoffDay);
  return daysLeft >= 0 && daysLeft <= daysBefore;
}

/** Is a date inside a locked period? Returns the lock when it is. */
export function opsLockFor<T extends { periodStart: Date; periodEnd: Date; status: string }>(locks: T[], date: Date): T | null {
  const d = opsDay(date).getTime();
  return locks.find((l) => l.status === "LOCKED" && opsDay(l.periodStart).getTime() <= d && opsDay(l.periodEnd).getTime() >= d) ?? null;
}

export function opsLockIssue(periodStart: Date, periodEnd: Date, existing: Array<{ periodStart: Date; periodEnd: Date; status: string }>): string | null {
  if (periodEnd < periodStart) return "The period ends before it starts.";
  if ((periodEnd.getTime() - periodStart.getTime()) / DAY > 92) return "Lock at most three months at a time.";
  const clash = existing.find((l) => l.status === "LOCKED" && l.periodStart <= periodEnd && l.periodEnd >= periodStart);
  return clash ? `That overlaps the locked period ${opsYmd(clash.periodStart)} to ${opsYmd(clash.periodEnd)}.` : null;
}

export interface OpsAnomalyDay {
  status: string;
  isWorkingDay: boolean;
  onLeave: boolean;
  firstIn: Date | null;
  lastOut: Date | null;
  shiftStart: Date | null;
  shiftEnd: Date | null;
  effectiveHours: number;
  shiftHours: number;
  validPunches: number;
  graceMinutes: number;
  earlyGraceMinutes: number;
}
export interface OpsAnomaly { kind: string; severity: "LOW" | "MEDIUM" | "HIGH"; detail: string }

export const OPS_ANOMALY_KINDS: Record<string, string> = {
  ABSENT_NO_LEAVE: "Absent without leave",
  MISSING_PUNCH: "Missing punch",
  ODD_PUNCHES: "Unpaired punches",
  LATE_ARRIVAL: "Late arrival",
  EARLY_DEPARTURE: "Early departure",
  SHORT_HOURS: "Short hours",
  EXCESS_HOURS: "Excess hours",
  OFF_DAY_WORK: "Worked on an off day",
};

const mins = (ms: number) => Math.round(ms / 60_000);

/** Classify the exceptions on one employee-day. */
export function opsClassifyDay(d: OpsAnomalyDay): OpsAnomaly[] {
  const out: OpsAnomaly[] = [];
  if (d.onLeave) return out;
  if (!d.isWorkingDay) {
    if (d.validPunches > 0) out.push({ kind: "OFF_DAY_WORK", severity: "LOW", detail: `Punched on a weekly off or holiday (${r2(d.effectiveHours)} h).` });
    return out;
  }
  if (d.validPunches === 0) {
    out.push({ kind: "ABSENT_NO_LEAVE", severity: "HIGH", detail: "No punches and no leave on a working day." });
    return out;
  }
  if (!d.firstIn || !d.lastOut) out.push({ kind: "MISSING_PUNCH", severity: "MEDIUM", detail: d.firstIn ? "No clock-out." : "No clock-in." });
  else if (d.validPunches % 2 === 1) out.push({ kind: "ODD_PUNCHES", severity: "LOW", detail: `${d.validPunches} punches — one is unpaired.` });
  if (d.firstIn && d.shiftStart) {
    const late = mins(d.firstIn.getTime() - d.shiftStart.getTime());
    if (late > d.graceMinutes) out.push({ kind: "LATE_ARRIVAL", severity: late > 120 ? "HIGH" : late > 30 ? "MEDIUM" : "LOW", detail: `${late} min late (grace ${d.graceMinutes}).` });
  }
  if (d.lastOut && d.shiftEnd) {
    const early = mins(d.shiftEnd.getTime() - d.lastOut.getTime());
    if (early > d.earlyGraceMinutes) out.push({ kind: "EARLY_DEPARTURE", severity: early > 120 ? "HIGH" : early > 30 ? "MEDIUM" : "LOW", detail: `Left ${early} min early (grace ${d.earlyGraceMinutes}).` });
  }
  if (d.shiftHours > 0 && d.firstIn && d.lastOut) {
    if (d.effectiveHours < d.shiftHours * 0.5) out.push({ kind: "SHORT_HOURS", severity: "MEDIUM", detail: `${r2(d.effectiveHours)} h against a ${r2(d.shiftHours)} h shift.` });
    else if (d.effectiveHours > d.shiftHours + 4) out.push({ kind: "EXCESS_HOURS", severity: "LOW", detail: `${r2(d.effectiveHours)} h against a ${r2(d.shiftHours)} h shift.` });
  }
  return out;
}

/** Early departures past the grace, then the penalty once the monthly exemptions run out. */
export function opsEarlyDeparturePenalties(earlyMinutesByDate: Array<{ date: Date; minutes: number }>, rule: { graceMinutes: number; exemptPerMonth: number; penaltyDays: number }): Array<{ date: Date; minutes: number; penalty: number }> {
  const incidents = earlyMinutesByDate.filter((x) => x.minutes > rule.graceMinutes).sort((a, b) => a.date.getTime() - b.date.getTime());
  const seen = new Map<string, number>();
  return incidents.map((x) => {
    const k = `${x.date.getUTCFullYear()}-${x.date.getUTCMonth()}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { date: x.date, minutes: x.minutes, penalty: n > rule.exemptPerMonth ? rule.penaltyDays : 0 };
  });
}

/** A device's or kiosk's health from its last punch. */
export function opsDeviceHealth(input: { isActive: boolean; lastPunchAt: Date | null; createdAt: Date }, now: Date, staleMinutes = 240, offlineMinutes = 1440): "HEALTHY" | "STALE" | "OFFLINE" | "INACTIVE" | "NEVER_USED" {
  if (!input.isActive) return "INACTIVE";
  if (!input.lastPunchAt) return now.getTime() - input.createdAt.getTime() > offlineMinutes * 60_000 ? "NEVER_USED" : "HEALTHY";
  const idle = (now.getTime() - input.lastPunchAt.getTime()) / 60_000;
  return idle >= offlineMinutes ? "OFFLINE" : idle >= staleMinutes ? "STALE" : "HEALTHY";
}

/** First-in per capture source on one day; flags sources that disagree by more than the threshold. */
export function opsSourceComparison(punches: Array<{ source: string; timestamp: Date; direction: number }>, thresholdMinutes = 15): { firstIn: Record<string, Date>; lastOut: Record<string, Date>; mismatch: boolean; spreadMinutes: number } {
  const firstIn: Record<string, Date> = {}, lastOut: Record<string, Date> = {};
  for (const p of punches) {
    if (p.direction === 0 && (!firstIn[p.source] || p.timestamp < firstIn[p.source]!)) firstIn[p.source] = p.timestamp;
    if (p.direction === 1 && (!lastOut[p.source] || p.timestamp > lastOut[p.source]!)) lastOut[p.source] = p.timestamp;
  }
  const ins = Object.values(firstIn).map((d) => d.getTime());
  const outs = Object.values(lastOut).map((d) => d.getTime());
  const spread = Math.max(ins.length > 1 ? Math.max(...ins) - Math.min(...ins) : 0, outs.length > 1 ? Math.max(...outs) - Math.min(...outs) : 0);
  return { firstIn, lastOut, mismatch: spread > thresholdMinutes * 60_000, spreadMinutes: mins(spread) };
}

/** Heatmap shade (0–4) for the share of a team present on a day. */
export function opsHeatLevel(present: number, expected: number): number {
  if (expected <= 0) return 0;
  const p = present / expected;
  return p >= 0.95 ? 4 : p >= 0.8 ? 3 : p >= 0.6 ? 2 : p > 0 ? 1 : 0;
}

export interface OpsReconRow { employeeId: string; days: number; present: number; leave: number; absent: number; lop: number; payable: number; unresolved: number; regularisationsPending: number }
/** One employee's month, reconciled: every day accounted for, and what still blocks payroll. */
export function opsReconcileMonth(employeeId: string, days: Array<{ status: string; payableValue: number; lopValue: number; onLeave: boolean; anomalies: number }>, pendingRequests: number): OpsReconRow & { balanced: boolean } {
  const present = days.filter((d) => ["PRESENT", "HALF_DAY", "REMOTE", "ON_DUTY", "WFH"].includes(d.status) && !d.onLeave).length;
  const leave = days.filter((d) => d.onLeave || d.status === "ON_LEAVE").length;
  const absent = days.filter((d) => ["ABSENT", "NO_ATTENDANCE"].includes(d.status) && !d.onLeave).length;
  const payable = r2(days.reduce((s, d) => s + d.payableValue, 0));
  const lop = r2(days.reduce((s, d) => s + d.lopValue, 0));
  const unresolved = days.reduce((s, d) => s + d.anomalies, 0);
  return { employeeId, days: days.length, present, leave, absent, lop, payable, unresolved, regularisationsPending: pendingRequests, balanced: unresolved === 0 && pendingRequests === 0 };
}

/** An iCalendar file of attendance days (all-day events). */
export function opsAttendanceIcs(name: string, days: Array<{ date: Date; summary: string; description?: string }>, now = new Date()): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const d8 = (d: Date) => opsYmd(d).replace(/-/g, "");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BooS-HR//Attendance//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(name)}`];
  for (const d of days) {
    lines.push("BEGIN:VEVENT", `UID:${d8(d.date)}-${esc(name).replace(/\s+/g, "")}@boos-hr`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(d.date)}`, `DTEND;VALUE=DATE:${d8(opsAddDays(d.date, 1))}`, `SUMMARY:${esc(d.summary)}`);
    if (d.description) lines.push(`DESCRIPTION:${esc(d.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
//  Breaks
// ---------------------------------------------------------------------------

/** The status a finished break takes under its rule. */
export function opsBreakOutcome(minutes: number, rule: { maxMinutes: number }): "OK" | "EXCEEDED" {
  return minutes > rule.maxMinutes ? "EXCEEDED" : "OK";
}

/** Can another break of this kind start today? */
export function opsBreakStartIssue(today: Array<{ ruleId: string; endAt: Date | null }>, rule: { id: string; maxPerDay: number; name: string }): string | null {
  if (today.some((b) => !b.endAt)) return "End the break you are on first.";
  const taken = today.filter((b) => b.ruleId === rule.id).length;
  return taken >= rule.maxPerDay ? `You have taken ${rule.name} ${taken} time(s) today, the most allowed.` : null;
}

// ---------------------------------------------------------------------------
//  Time entry rules
// ---------------------------------------------------------------------------

export interface OpsEntryRuleInput { projectId: string; taskId?: string | null; hours: number; description?: string | null; timeCode?: string | null; workPackageId?: string | null; isBillable?: boolean }
export interface OpsTimeCodeRule { code: string; label: string; billable: boolean | null; requiresTask: boolean; requiresComment: boolean; isActive: boolean }

/** Comment and time-code standards on a sheet's entries. */
export function opsEntryRuleIssues(entries: OpsEntryRuleInput[], rules: { requireComment: boolean; minLength: number; requireTimeCode: boolean; codes: OpsTimeCodeRule[] }): string[] {
  const issues = new Set<string>();
  const codes = new Map(rules.codes.map((c) => [c.code, c]));
  for (const e of entries) {
    const note = (e.description ?? "").trim();
    if (rules.requireComment && note.length < Math.max(1, rules.minLength)) issues.add(rules.minLength > 1 ? `Every entry needs a comment of at least ${rules.minLength} characters.` : "Every entry needs a comment.");
    if (!e.timeCode) { if (rules.requireTimeCode) issues.add("Every entry needs an activity code."); continue; }
    const c = codes.get(e.timeCode);
    if (!c || !c.isActive) { issues.add(`"${e.timeCode}" is not an active activity code.`); continue; }
    if (c.requiresTask && !e.taskId) issues.add(`${c.code} (${c.label}) must be logged against a task.`);
    if (c.requiresComment && !note) issues.add(`${c.code} (${c.label}) needs a comment.`);
    if (c.billable !== null && e.isBillable !== undefined && c.billable !== e.isBillable) issues.add(`${c.code} is only for ${c.billable ? "billable" : "non-billable"} work.`);
  }
  return [...issues];
}

/** Hours on a task beyond its estimate: OFF ignores, WARN reports, BLOCK refuses. */
export function opsTaskBudgetCheck(input: { title: string; estimated: number | null; loggedElsewhere: number; adding: number }, mode: string, tolerancePct: number): { block: boolean; warning: string | null } {
  if (mode === "OFF" || !input.estimated || input.estimated <= 0) return { block: false, warning: null };
  const limit = input.estimated * (1 + Math.max(0, tolerancePct) / 100);
  const total = r2(input.loggedElsewhere + input.adding);
  if (total <= limit + 1e-9) return { block: false, warning: null };
  const msg = `${input.title}: ${total} h would exceed its ${input.estimated} h budget${tolerancePct ? ` (+${tolerancePct}% tolerance)` : ""}.`;
  return { block: mode === "BLOCK", warning: msg };
}

/** Has the edit window for a week closed? */
export function opsTimesheetCutoffPassed(weekStart: Date, cutoffDays: number | null, today: Date): boolean {
  if (cutoffDays === null || cutoffDays === undefined) return false;
  const closes = opsAddDays(weekStart, 6 + cutoffDays);
  return opsDay(today).getTime() > closes.getTime();
}

/** Share approved overtime among the projects worked that day, in proportion to hours; amounts sum exactly. */
export function opsAllocateOvertime(otHours: number, otAmount: number, projectHours: Array<{ projectId: string; hours: number }>): Array<{ projectId: string; hours: number; amount: number }> {
  const rows = projectHours.filter((p) => p.hours > 0);
  const total = rows.reduce((s, p) => s + p.hours, 0);
  if (total <= 0 || otHours <= 0) return [];
  const out = rows.map((p) => ({ projectId: p.projectId, hours: r2((otHours * p.hours) / total), amount: r2((otAmount * p.hours) / total) }));
  const dh = r2(otHours - out.reduce((s, x) => s + x.hours, 0));
  const da = r2(otAmount - out.reduce((s, x) => s + x.amount, 0));
  const big = out.reduce((m, x, i) => (x.hours > out[m]!.hours ? i : m), 0);
  out[big] = { ...out[big]!, hours: r2(out[big]!.hours + dh), amount: r2(out[big]!.amount + da) };
  return out;
}

/** Budget burn against schedule: actual share of the budget vs the share of time elapsed. */
export function opsProjectVariance(input: { budgetHours: number | null; actualHours: number; start: Date | null; end: Date | null }, today: Date, alertPct = 10): { burnPct: number | null; elapsedPct: number | null; variancePct: number | null; alert: boolean } {
  if (!input.budgetHours || input.budgetHours <= 0) return { burnPct: null, elapsedPct: null, variancePct: null, alert: false };
  const burn = (input.actualHours / input.budgetHours) * 100;
  let elapsed: number | null = null;
  if (input.start && input.end && input.end > input.start) elapsed = Math.min(100, Math.max(0, ((today.getTime() - input.start.getTime()) / (input.end.getTime() - input.start.getTime())) * 100));
  const variance = elapsed === null ? burn - 100 : burn - elapsed;
  return { burnPct: r2(burn), elapsedPct: elapsed === null ? null : r2(elapsed), variancePct: r2(variance), alert: burn > 100 || variance > alertPct };
}

/** Utilisation against a target: billable hours over capacity. */
export function opsUtilisation(billable: number, logged: number, capacity: number, targetPct: number | null): { billablePct: number; loggedPct: number; gap: number | null; onTarget: boolean | null } {
  const b = capacity > 0 ? r2((billable / capacity) * 100) : 0;
  const l = capacity > 0 ? r2((logged / capacity) * 100) : 0;
  return { billablePct: b, loggedPct: l, gap: targetPct === null ? null : r2(b - targetPct), onTarget: targetPct === null ? null : b >= targetPct };
}

/** Tracked vs scheduled vs logged hours, and the leakage between attendance and timesheets. */
export function opsTimeLeakage(input: { scheduled: number; attended: number; logged: number; idle: number }): { attendancePct: number | null; leakageHours: number; leakagePct: number | null; unexplained: number } {
  const leak = r2(Math.max(0, input.attended - input.logged));
  return {
    attendancePct: input.scheduled > 0 ? r2((input.attended / input.scheduled) * 100) : null,
    leakageHours: leak,
    leakagePct: input.attended > 0 ? r2((leak / input.attended) * 100) : null,
    unexplained: r2(Math.max(0, leak - input.idle)),
  };
}

export const OPS_EXPORT_COLUMNS: Record<string, string> = {
  date: "Date", employeeNumber: "Employee no.", employee: "Employee", client: "Client", project: "Project", task: "Task",
  workPackage: "Work package", milestone: "Milestone", timeCode: "Activity code", hours: "Hours", billable: "Billable",
  billRate: "Bill rate", billAmount: "Bill amount", costRate: "Cost rate", costAmount: "Cost", note: "Note", status: "Timesheet status",
};
export function opsExportColumns(selected: string[]): string[] {
  const valid = selected.filter((c) => c in OPS_EXPORT_COLUMNS);
  return valid.length ? [...new Set(valid)] : ["date", "employee", "project", "hours", "billable"];
}

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

export interface OpsBlackout { id: string; name: string; kind: string; startDate: Date; endDate: Date; departmentId: string | null; locationId: string | null; leaveTypeIds: string[]; maxConcurrent: number | null; maxConcurrentPct: number | null; isActive: boolean }

/** Why a leave request falls foul of a blackout or a peak-period cap. */
export function opsBlackoutIssues(req: { from: Date; to: Date; leaveTypeId: string; departmentId: string | null; locationId: string | null }, windows: OpsBlackout[], awayOn: (day: Date, w: OpsBlackout) => { away: number; group: number }): string[] {
  const issues: string[] = [];
  const from = opsDay(req.from).getTime(), to = opsDay(req.to).getTime();
  for (const w of windows) {
    if (!w.isActive) continue;
    if (w.leaveTypeIds.length && !w.leaveTypeIds.includes(req.leaveTypeId)) continue;
    if (w.departmentId && w.departmentId !== req.departmentId) continue;
    if (w.locationId && w.locationId !== req.locationId) continue;
    const ws = opsDay(w.startDate).getTime(), we = opsDay(w.endDate).getTime();
    if (ws > to || we < from) continue;
    if (w.kind === "BLACKOUT") { issues.push(`Leave is closed from ${opsYmd(w.startDate)} to ${opsYmd(w.endDate)} (${w.name}).`); continue; }
    for (let t = Math.max(ws, from); t <= Math.min(we, to); t += DAY) {
      const day = new Date(t);
      const { away, group } = awayOn(day, w);
      const capN = w.maxConcurrent ?? Infinity;
      const capP = w.maxConcurrentPct !== null && group > 0 ? Math.floor((w.maxConcurrentPct / 100) * group) : Infinity;
      const cap = Math.min(capN, capP);
      if (away + 1 > cap) { issues.push(`${w.name}: at most ${cap} people may be away on ${opsYmd(day)}, and ${away} already are.`); break; }
    }
  }
  return issues;
}

/** Can approved leave still be withdrawn by the employee? */
export function opsWithdrawalOpen(fromDate: Date, now: Date, windowDays: number | null): boolean {
  if (windowDays === null || windowDays === undefined) return opsDay(fromDate).getTime() > now.getTime();
  return opsDay(now).getTime() <= opsAddDays(fromDate, -windowDays).getTime();
}

/** Has a pending request waited past the escalation window? */
export function opsEscalationDue(since: Date, now: Date, hours: number | null): boolean {
  return !!hours && hours > 0 && now.getTime() - since.getTime() >= hours * 3_600_000;
}

/** Whose leave a viewer sees on the calendar, and whether they see its type. */
export function opsLeaveVisible(rule: string, viewer: { employeeId: string; managerId: string | null; departmentId: string | null; isManager: boolean }, subject: { employeeId: string; managerId: string | null; departmentId: string | null }): boolean {
  if (viewer.employeeId === subject.employeeId) return true;
  switch (rule) {
    case "ORGANISATION": return true;
    case "DEPARTMENT": return !!viewer.departmentId && viewer.departmentId === subject.departmentId;
    case "MANAGERS": return viewer.isManager && subject.managerId === viewer.employeeId;
    default: return (!!viewer.managerId && viewer.managerId === subject.managerId) || subject.managerId === viewer.employeeId || subject.employeeId === viewer.managerId;
  }
}

/** Leave liability today and month by month: balances growing by accrual, valued at per-day pay. */
export function opsLiabilityForecast(rows: Array<{ balance: number; monthlyAccrual: number; perDay: number; cap: number | null; encashable: boolean }>, months: number): { today: number; forecast: number[] } {
  const value = (bal: number, r: { perDay: number; encashable: boolean }) => (r.encashable ? bal * r.perDay : 0);
  const today = r2(rows.reduce((s, r) => s + value(Math.max(0, r.balance), r), 0));
  const forecast: number[] = [];
  for (let m = 1; m <= months; m++) {
    forecast.push(r2(rows.reduce((s, r) => {
      const bal = Math.max(0, r.balance + r.monthlyAccrual * m);
      return s + value(r.cap !== null ? Math.min(bal, r.cap) : bal, r);
    }, 0)));
  }
  return { today, forecast };
}

// ---------------------------------------------------------------------------
//  Long absences and return to work
// ---------------------------------------------------------------------------

export const OPS_ABSENCE_KINDS: Record<string, string> = { SABBATICAL: "Sabbatical", MEDICAL: "Medical leave", PARENTAL: "Parental leave", PERSONAL: "Personal leave of absence", OTHER: "Other" };
export const OPS_RETURN_CHECKLIST = ["Return date confirmed with the manager", "Fitness-to-work note received", "System access restored", "Payroll status set back to active", "Return meeting held"];

const ABSENCE_MOVES: Record<string, string[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ON_LEAVE", "CANCELLED"],
  ON_LEAVE: ["RETURNED"],
};
export function opsAbsenceCanMove(from: string, to: string): boolean {
  return (ABSENCE_MOVES[from] ?? []).includes(to);
}
/** What still blocks a return: an uncertified fitness note, or open checklist items. */
export function opsReturnBlockers(c: { rtwRequired: boolean; rtwCertifiedAt: Date | null; fitForWork: boolean | null; checklist: Array<{ item: string; done: boolean }> }): string[] {
  const out: string[] = [];
  if (c.rtwRequired && !c.rtwCertifiedAt) out.push("Certify the return to work first.");
  if (c.rtwRequired && c.rtwCertifiedAt && c.fitForWork === false) out.push("The certificate says the employee is not yet fit for work.");
  const open = c.checklist.filter((i) => !i.done).map((i) => i.item);
  if (open.length) out.push(`Finish the return checklist: ${open.join(", ")}.`);
  return out;
}

// ---------------------------------------------------------------------------
//  Lifecycle
// ---------------------------------------------------------------------------

const ASSIGNMENT_MOVES: Record<string, string[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED"],
};
export function opsAssignmentCanMove(from: string, to: string): boolean {
  return (ASSIGNMENT_MOVES[from] ?? []).includes(to);
}
export function opsAssignmentIssues(a: { kind: string; startDate: Date; endDate: Date; hostDepartmentId: string | null; hostOrganisation: string | null; costSharePct: number | null }): string[] {
  const out: string[] = [];
  if (a.endDate <= a.startDate) out.push("The end date must be after the start.");
  if ((a.endDate.getTime() - a.startDate.getTime()) / DAY > 3 * 366) out.push("Assignments run for at most three years; extend one later if needed.");
  if (a.kind === "SECONDMENT" && !a.hostOrganisation && !a.hostDepartmentId) out.push("Name the host organisation or team.");
  if (a.kind === "TEMPORARY" && !a.hostDepartmentId) out.push("Choose the team the employee is assigned to.");
  if (a.costSharePct !== null && (a.costSharePct < 0 || a.costSharePct > 100)) out.push("The host's cost share is a percentage from 0 to 100.");
  return out;
}

export interface OpsConfirmationInput { serviceDays: number; lopDays: number; lateMarks: number; warningsInWindow: number; evaluationDone: boolean; rating: number | null }
export interface OpsConfirmationRuleSpec { minServiceDays: number; maxLopDays: number | null; maxLateMarks: number | null; noWarningsMonths: number | null; requireEvaluation: boolean; minRating: number | null }
/** Whether an employee meets a confirmation rule, and why not. */
export function opsConfirmationEligibility(e: OpsConfirmationInput, rule: OpsConfirmationRuleSpec): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (e.serviceDays < rule.minServiceDays) reasons.push(`${e.serviceDays} days of service; ${rule.minServiceDays} needed.`);
  if (rule.maxLopDays !== null && e.lopDays > rule.maxLopDays) reasons.push(`${e.lopDays} LOP day(s); at most ${rule.maxLopDays} allowed.`);
  if (rule.maxLateMarks !== null && e.lateMarks > rule.maxLateMarks) reasons.push(`${e.lateMarks} late mark(s); at most ${rule.maxLateMarks} allowed.`);
  if (rule.noWarningsMonths !== null && e.warningsInWindow > 0) reasons.push(`${e.warningsInWindow} warning(s) in the last ${rule.noWarningsMonths} months.`);
  if (rule.requireEvaluation && !e.evaluationDone) reasons.push("The probation evaluation is not done.");
  if (rule.minRating !== null && (e.rating === null || e.rating < rule.minRating)) reasons.push(`Rating ${e.rating ?? "—"}; at least ${rule.minRating} needed.`);
  return { eligible: reasons.length === 0, reasons };
}

/** Full-time ↔ part-time: hours and CTC pro-rated by FTE. */
export function opsFteConversion(from: { fte: number; weeklyHours: number; ctc: number }, toFte: number): { toWeeklyHours: number; toCtc: number; direction: "FT_TO_PT" | "PT_TO_FT" } | { error: string } {
  if (!(toFte > 0 && toFte <= 1)) return { error: "FTE is a fraction above 0 and at most 1 (e.g. 0.6)." };
  if (!(from.fte > 0)) return { error: "The current FTE is unknown." };
  if (Math.abs(toFte - from.fte) < 1e-9) return { error: "That is the FTE the employee already has." };
  const fullHours = from.weeklyHours / from.fte;
  const fullCtc = from.ctc / from.fte;
  return { toWeeklyHours: r2(fullHours * toFte), toCtc: Math.round(fullCtc * toFte), direction: toFte < from.fte ? "FT_TO_PT" : "PT_TO_FT" };
}

/** Contract milestones (days before the end) reached today and not yet alerted. */
export function opsContractMilestonesDue(endDate: Date, milestones: number[], today: Date, alreadySent: Set<number>): number[] {
  const left = Math.round((opsDay(endDate).getTime() - opsDay(today).getTime()) / DAY);
  if (left < 0) return [];
  // Only the nearest milestone reached: a contract found late gets one alert, not three.
  const reached = [...new Set(milestones)].filter((m) => m >= left).sort((a, b) => a - b);
  const m = reached[0];
  return m !== undefined && !alreadySent.has(m) ? [m] : [];
}

/** Lifecycle actions that cannot happen together. */
export function opsLifecycleConflicts(state: { status: string; onLongAbsence: boolean; activeAssignment: string | null; pendingJobChange: boolean; pendingFte: boolean; openExit: boolean }, action: "JOB_CHANGE" | "PROMOTION" | "ASSIGNMENT" | "ABSENCE" | "FTE_CONVERSION" | "EXIT" | "CONFIRMATION"): string[] {
  const out: string[] = [];
  if (state.status === "EXITED") out.push("The employee has exited.");
  if (state.openExit && action !== "EXIT" && action !== "ABSENCE") out.push("An exit is in progress for this employee.");
  if (state.status === "NOTICE_PERIOD" && ["PROMOTION", "ASSIGNMENT", "FTE_CONVERSION", "CONFIRMATION"].includes(action)) out.push("The employee is serving notice.");
  if (state.onLongAbsence && ["PROMOTION", "ASSIGNMENT", "FTE_CONVERSION", "CONFIRMATION"].includes(action)) out.push("The employee is on a leave of absence; record the return first.");
  if (state.activeAssignment && (action === "ASSIGNMENT" || action === "EXIT")) out.push(`The employee is on a ${state.activeAssignment.toLowerCase()} assignment; complete or cancel it first.`);
  if (state.pendingJobChange && ["JOB_CHANGE", "PROMOTION", "FTE_CONVERSION"].includes(action)) out.push("A job change is already waiting for approval.");
  if (state.pendingFte && ["JOB_CHANGE", "PROMOTION", "FTE_CONVERSION"].includes(action)) out.push("A full-time/part-time conversion is waiting for approval.");
  if (action === "CONFIRMATION" && state.status !== "PROBATION") out.push("Only an employee on probation can be confirmed.");
  return out;
}

// ---------------------------------------------------------------------------
//  Payroll
// ---------------------------------------------------------------------------

/** Round net pay to a multiple, nearest/up/down. */
export function opsRoundNet(net: number, roundTo: number, mode: string): { rounded: number; adjustment: number } {
  const step = roundTo > 0 ? roundTo : 1;
  const q = net / step;
  const n = mode === "UP" ? Math.ceil(q - 1e-9) : mode === "DOWN" ? Math.floor(q + 1e-9) : Math.round(q);
  const rounded = r2(n * step);
  return { rounded, adjustment: r2(rounded - net) };
}

/** Is a recurring rule due in a month? */
export function opsRecurringDue(rule: { frequency: string; months: number[]; startDate: Date; endDate: Date | null; isActive: boolean }, year: number, month: number): boolean {
  if (!rule.isActive) return false;
  const first = new Date(Date.UTC(year, month - 1, 1)), last = new Date(Date.UTC(year, month, 0));
  if (rule.startDate > last) return false;
  if (rule.endDate && rule.endDate < first) return false;
  if (rule.frequency === "MONTHLY") return true;
  if (rule.months.length) return rule.months.includes(month);
  const startM = rule.startDate.getUTCMonth() + 1;
  const step = rule.frequency === "QUARTERLY" ? 3 : rule.frequency === "HALF_YEARLY" ? 6 : 12;
  return (((month - startM) % step) + step) % step === 0;
}

/** Groups ordered as a tree (depth-first), with each group's depth; a group naming a missing or circular parent is placed at the top. */
export function opsComponentTree<T extends { id: string; parentId: string | null; sortOrder: number; name: string }>(groups: T[]): Array<T & { depth: number; path: string }> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    const p = g.parentId && ids.has(g.parentId) && g.parentId !== g.id ? g.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), g]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const out: Array<T & { depth: number; path: string }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, path: string) => {
    for (const g of byParent.get(parent) ?? []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const p = path ? `${path} › ${g.name}` : g.name;
      out.push({ ...g, depth, path: p });
      walk(g.id, depth + 1, p);
    }
  };
  walk(null, 0, "");
  for (const g of groups) if (!seen.has(g.id)) out.push({ ...g, depth: 0, path: g.name });
  return out;
}

/** Would setting this parent make a loop? */
export function opsTreeCycle(groups: Array<{ id: string; parentId: string | null }>, id: string, parentId: string | null): boolean {
  const parent = new Map(groups.map((g) => [g.id, g.parentId]));
  let cur = parentId;
  for (let i = 0; cur && i < 100; i++) {
    if (cur === id) return true;
    cur = parent.get(cur) ?? null;
  }
  return false;
}

export interface OpsVarianceRuleSpec { id: string; name: string; metric: string; componentCode: string | null; thresholdPct: number | null; thresholdAmount: number | null; severity: string; isActive: boolean }
/** Month-on-month breaches of the tolerance rules for one employee. */
export function opsVarianceBreaches(rules: OpsVarianceRuleSpec[], prev: { net: number; gross: number; deductions: number; components: Record<string, number> } | null, curr: { net: number; gross: number; deductions: number; components: Record<string, number> }): Array<{ ruleId: string; rule: string; severity: string; prev: number; curr: number; change: number; pct: number | null }> {
  if (!prev) return [];
  const out: Array<{ ruleId: string; rule: string; severity: string; prev: number; curr: number; change: number; pct: number | null }> = [];
  for (const r of rules) {
    if (!r.isActive) continue;
    const pick = (x: typeof curr) => (r.metric === "NET" ? x.net : r.metric === "GROSS" ? x.gross : r.metric === "DEDUCTIONS" ? x.deductions : x.components[r.componentCode ?? ""] ?? 0);
    const a = pick(prev), b = pick(curr);
    const change = r2(b - a);
    const pct = a !== 0 ? r2((change / Math.abs(a)) * 100) : null;
    const byPct = r.thresholdPct !== null && (pct === null ? b !== 0 : Math.abs(pct) > r.thresholdPct);
    const byAmt = r.thresholdAmount !== null && Math.abs(change) > r.thresholdAmount;
    if ((r.thresholdPct !== null && r.thresholdAmount !== null) ? byPct && byAmt : byPct || byAmt) out.push({ ruleId: r.id, rule: r.name, severity: r.severity, prev: a, curr: b, change, pct });
  }
  return out;
}

export interface OpsValidationRow {
  employeeId: string; employee: string; status: string; hasBank: boolean; hasPan: boolean; ctc: number; hasStructure: boolean;
  pfEnabled: boolean; hasUan: boolean; esiApplies: boolean; hasEsiIp: boolean; lopDays: number; periodDays: number;
  net: number | null; onHold: boolean; exitedBeforePeriod: boolean; stateCode: string | null;
}
export interface OpsIssue { severity: "ERROR" | "WARNING"; code: string; employeeId: string; employee: string; message: string }
/** Pre-run checks on the inputs: anything that makes a payslip wrong or a payment fail. */
export function opsValidatePayrollInputs(rows: OpsValidationRow[], opts: { negativeNetAction: string }): OpsIssue[] {
  const out: OpsIssue[] = [];
  const add = (r: OpsValidationRow, severity: OpsIssue["severity"], code: string, message: string) => out.push({ severity, code, employeeId: r.employeeId, employee: r.employee, message });
  for (const r of rows) {
    if (!r.hasStructure || r.ctc <= 0) add(r, "ERROR", "NO_SALARY", "No salary structure or CTC.");
    if (!r.hasBank && !r.onHold) add(r, "ERROR", "NO_BANK", "No bank account for the transfer.");
    if (!r.hasPan) add(r, "WARNING", "NO_PAN", "No PAN: TDS at 20%.");
    if (r.pfEnabled && !r.hasUan) add(r, "WARNING", "NO_UAN", "PF applies but there is no UAN.");
    if (r.esiApplies && !r.hasEsiIp) add(r, "WARNING", "NO_ESI_IP", "ESI applies but there is no IP number.");
    if (!r.stateCode) add(r, "WARNING", "NO_STATE", "No work location state: PT and LWF cannot be worked out.");
    if (r.lopDays > r.periodDays) add(r, "ERROR", "LOP_EXCEEDS", `${r.lopDays} LOP days in a ${r.periodDays}-day period.`);
    if (r.exitedBeforePeriod) add(r, "ERROR", "EXITED", "Exited before this period but still in the run.");
    if (r.net !== null && r.net < 0) add(r, opts.negativeNetAction === "BLOCK" ? "ERROR" : "WARNING", "NEGATIVE_NET", `Net pay is ${r.net}.`);
  }
  return out;
}

export const OPS_CLOSE_CHECKLIST: Array<{ key: string; label: string }> = [
  { key: "INPUTS_VALIDATED", label: "Inputs validated with no errors" },
  { key: "ATTENDANCE_CERTIFIED", label: "Attendance for the period certified" },
  { key: "VARIANCES_REVIEWED", label: "Variances reviewed" },
  { key: "REGISTER_RECONCILED", label: "Pay register reconciled with the bank file" },
  { key: "STATUTORY_FILES", label: "PF, ESI and PT files generated" },
  { key: "JOURNAL_POSTED", label: "Journal voucher exported to accounts" },
  { key: "PAYSLIPS_RELEASED", label: "Payslips released" },
];

/** LWF deducted vs what the state rule expected, per employee. */
export function opsLwfReconcile(rows: Array<{ employeeId: string; employee: string; stateCode: string | null; expectedEmployee: number; expectedEmployer: number; deductedEmployee: number; deductedEmployer: number }>): Array<{ employeeId: string; employee: string; stateCode: string | null; expectedEmployee: number; deductedEmployee: number; expectedEmployer: number; deductedEmployer: number; difference: number; status: "MATCHED" | "SHORT" | "EXCESS" }> {
  return rows.map((r) => {
    const diff = r2(r.deductedEmployee + r.deductedEmployer - r.expectedEmployee - r.expectedEmployer);
    return { ...r, difference: diff, status: Math.abs(diff) < 0.01 ? "MATCHED" : diff < 0 ? "SHORT" : "EXCESS" };
  });
}

/** Statutory sanity checks on a salary structure at a sample CTC. */
export function opsStructureStatutoryIssues(input: { annualCtc: number; monthlyBasic: number; monthlyGross: number; pfEnabled: boolean; esiEnabled: boolean; minimumWage: number | null }): Array<{ severity: "ERROR" | "WARNING"; message: string }> {
  const out: Array<{ severity: "ERROR" | "WARNING"; message: string }> = [];
  const monthlyCtc = input.annualCtc / 12;
  if (input.monthlyBasic <= 0) out.push({ severity: "ERROR", message: "There is no basic pay." });
  else if (monthlyCtc > 0 && input.monthlyBasic < monthlyCtc * 0.5) out.push({ severity: "WARNING", message: `Basic is ${r2((input.monthlyBasic / monthlyCtc) * 100)}% of CTC; under the Code on Wages, allowances above 50% count as wages for PF and gratuity.` });
  if (input.esiEnabled && input.monthlyGross > 21000) out.push({ severity: "WARNING", message: `Gross ${r2(input.monthlyGross)} is above the ESI ceiling of 21,000; ESI will not apply.` });
  if (!input.esiEnabled && input.monthlyGross > 0 && input.monthlyGross <= 21000) out.push({ severity: "ERROR", message: `Gross ${r2(input.monthlyGross)} is within the ESI ceiling, but ESI is switched off for this structure.` });
  if (!input.pfEnabled && input.monthlyBasic > 0 && input.monthlyBasic <= 15000) out.push({ severity: "ERROR", message: `Basic ${r2(input.monthlyBasic)} is within the PF wage ceiling of 15,000, but PF is switched off.` });
  if (input.minimumWage !== null && input.monthlyGross < input.minimumWage) out.push({ severity: "ERROR", message: `Gross ${r2(input.monthlyGross)} is below the minimum wage of ${input.minimumWage}.` });
  return out;
}

// ---------------------------------------------------------------------------
//  Workflow types (run on the generic engine; ops-effects applies them)
// ---------------------------------------------------------------------------

export const OPS_WORKFLOW_TYPES = {
  OPS_CONFIG_CHANGE: "Time, leave and payroll configuration changes",
  OPS_LEAVE_ADJUSTMENT: "Leave balance adjustments",
  OPS_LEAVE_CANCELLATION: "Cancellation of approved leave",
  OPS_ABSENCE: "Long absences (sabbatical, medical, parental)",
  OPS_ATTENDANCE_CERT: "Monthly attendance certification",
  OPS_BREAK_EXCEPTION: "Break exceptions",
  OPS_TIME_CORRECTION: "Corrections to approved timesheets",
  OPS_TIME_CERT: "Project timesheet certification",
  OPS_TASK_SIGNOFF: "Project task sign-off",
  OPS_PAYSLIP_RELEASE: "Payslip release",
  OPS_STATUTORY_SIGNOFF: "Statutory return sign-off",
  OPS_HR_EVENT: "HR activity events",
  OPS_ASSIGNMENT: "Temporary assignments and secondments",
  OPS_FTE_CHANGE: "Full-time / part-time conversions",
} as const;
export type OpsWorkflowType = keyof typeof OPS_WORKFLOW_TYPES;
export const isOpsWorkflowType = (v: string): v is OpsWorkflowType => v in OPS_WORKFLOW_TYPES;
