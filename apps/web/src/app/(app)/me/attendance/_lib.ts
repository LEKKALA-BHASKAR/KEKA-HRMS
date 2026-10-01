import "server-only";
import { prisma } from "@keka/db";
import { localDateKey, type ResolvedTimePolicy } from "@keka/services";

/**
 * Data for /me/attendance: one employee's days, assembled from the processed
 * AttendanceRecord, the raw AttendanceLog punches, leave days, attendance
 * requests, holidays, weekly offs and shift overrides. Every query is scoped
 * to the viewer's own employee id and tenant.
 */

export const DAY = 86_400_000;
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const fromKey = (k: string) => new Date(`${k}T00:00:00Z`);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
export const num = (v: unknown) => Number(v ?? 0);
export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** "8h 20m" */
export function hm(minutes: number): string {
  const t = Math.max(0, Math.round(minutes));
  return `${Math.floor(t / 60)}h ${t % 60}m`;
}

/** "9:30 AM" — for server-rendered labels outside the 24-hour scope. */
export function clock12(m: number): string {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(t % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Thu, 01 Oct" */
export const dayLabel = (d: Date) =>
  `${DOW[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]}`;
/** "01 Oct 2026" */
export const dateLabel = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
export const monthShort = (m0: number) => MON[m0];

export type DayKind = "WORKING" | "WEEKLY_OFF" | "HALF_WEEKLY_OFF" | "HOLIDAY";

/** The same classification the attendance engine applies. */
export function dayKind(d: Date, cal: ResolvedTimePolicy["calendar"]): DayKind {
  if (cal.holidays.has(keyOf(d))) return "HOLIDAY";
  const rule = cal.weeklyOff[WD[d.getUTCDay()]];
  if (!rule) return "WORKING";
  const instance = Math.floor((d.getUTCDate() - 1) / 7) + 1;
  const hit = rule.instances === "ALL" || rule.instances.includes(instance);
  if (!hit) return "WORKING";
  return (rule.portion ?? "FULL_DAY") === "FULL_DAY" ? "WEEKLY_OFF" : "HALF_WEEKLY_OFF";
}

export const REQUEST_LABEL: Record<string, string> = {
  ADJUSTMENT: "Attendance Adjustment",
  REGULARISATION: "Regularisation",
  PARTIAL_DAY: "Partial Day",
  WORK_FROM_HOME: "Work From Home",
  ON_DUTY: "On Duty",
};

export interface ShiftWindow { name: string; start: number; end: number; required: number; breakMinutes: number; flexible: boolean }

export type Chip = "woff" | "hldy" | "leave" | "wfh" | "od";

export interface Day {
  key: string;
  date: Date;
  isToday: boolean;
  isFuture: boolean;
  kind: DayKind;
  holidayName: string | null;
  shift: ShiftWindow;
  status: string | null;
  punches: Array<{ m: number; dir: 0 | 1; source: string }>;
  segments: Array<[number, number]>;
  open: [number, number] | null;
  effectiveMin: number;
  grossMin: number;
  breakMin: number;
  lop: number;
  chips: Chip[];
  tint: "woff" | "hldy" | "leave" | null;
  message: { text: string; tone: "normal" | "muted" | "danger" | "pending" } | null;
  /** ok = a clean day; warn = something on it needs a look. */
  flag: "ok" | "warn" | null;
  note: string | null;
  pendingTypes: string[];
  leaveName: string | null;
}

/**
 * Load and assemble every day from `from` to `to` (inclusive, UTC-midnight
 * keys in the employee's local calendar). Records and punches stop at today;
 * leave, requests and holidays run to `to` so future days in a calendar month
 * still show what is planned.
 */
export async function loadDays(opts: {
  employeeId: string; tenantId: string; policy: ResolvedTimePolicy;
  defaultShiftName: string; from: Date; to: Date; today: Date; now: Date;
}): Promise<Map<string, Day>> {
  const { employeeId, tenantId, policy, from, to, today, now } = opts;
  const tz = policy.tzOffset;
  const recTo = new Date(Math.min(to.getTime(), today.getTime()));

  const [records, logs, leaveDays, requests, holidays, overrides] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { tenantId, employeeId, date: { gte: from, lte: recTo } },
      select: {
        date: true, status: true, grossHours: true, effectiveHours: true, lopValue: true,
        penaltyReason: true, remark: true, isRegularised: true,
      },
    }),
    prisma.attendanceLog.findMany({
      where: {
        tenantId, employeeId,
        timestamp: { gte: new Date(from.getTime() - tz * 60_000), lt: new Date(recTo.getTime() + DAY - tz * 60_000) },
      },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, direction: true, source: true },
    }),
    prisma.leaveRequestDay.findMany({
      where: {
        date: { gte: from, lte: to },
        request: { tenantId, employeeId, status: { in: ["PENDING", "APPROVED"] } },
      },
      select: {
        date: true, portion: true, isSandwich: true,
        request: { select: { status: true, leaveType: { select: { name: true } } } },
      },
    }),
    prisma.attendanceRequest.findMany({
      where: { tenantId, employeeId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { type: true, status: true, fromDate: true, toDate: true },
    }),
    prisma.holiday.findMany({
      where: { calendar: { tenantId }, date: { gte: from, lte: to }, isOptional: false },
      select: { date: true, name: true },
    }),
    prisma.shiftAssignment.findMany({
      where: { employeeId, date: { gte: from, lte: to }, shift: { tenantId } },
      include: { shift: true },
    }),
  ]);

  const recByKey = new Map(records.map((r) => [keyOf(r.date), r]));
  const logsByKey = new Map<string, typeof logs>();
  for (const l of logs) {
    const k = localDateKey(l.timestamp, tz);
    logsByKey.set(k, [...(logsByKey.get(k) ?? []), l]);
  }
  const leaveByKey = new Map<string, typeof leaveDays>();
  for (const l of leaveDays) {
    const k = keyOf(l.date);
    leaveByKey.set(k, [...(leaveByKey.get(k) ?? []), l]);
  }
  // Only holidays on the employee's own calendar count.
  const holidayName = new Map(holidays.filter((h) => policy.calendar.holidays.has(keyOf(h.date))).map((h) => [keyOf(h.date), h.name]));
  const overrideByKey = new Map(overrides.map((o) => [keyOf(o.date), o]));

  const def = policy.defaultShift;
  const windowOf = (sh: { startTime: string; endTime: string; breakMinutes: number; isFlexible: boolean; requiredHours?: unknown; crossesMidnight?: boolean | null }, name: string): ShiftWindow => {
    const start = toMin(sh.startTime);
    let end = toMin(sh.endTime);
    if (end <= start || sh.crossesMidnight) end += 1440;
    const required = sh.isFlexible && sh.requiredHours ? num(sh.requiredHours) * 60 : Math.max(0, end - start - sh.breakMinutes);
    return { name, start, end, required, breakMinutes: sh.breakMinutes, flexible: sh.isFlexible };
  };
  const defaultWindow = windowOf(def, opts.defaultShiftName);
  const nowMin = (key: string) => (now.getTime() - (fromKey(key).getTime() - tz * 60_000)) / 60_000;
  const todayKey = keyOf(today);

  const out = new Map<string, Day>();
  for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) {
    const key = keyOf(d);
    const isToday = key === todayKey;
    const isFuture = d.getTime() > today.getTime();
    const rec = recByKey.get(key) ?? null;
    const ov = overrideByKey.get(key);
    const shift = ov ? windowOf(ov.shift, ov.shift.name) : defaultWindow;

    let kind = dayKind(d, policy.calendar);
    if (ov?.weeklyOffCode === "WO") kind = "WEEKLY_OFF";
    if (rec?.status === "WEEKLY_OFF" && kind === "WORKING") kind = "WEEKLY_OFF";
    if (rec?.status === "HOLIDAY") kind = "HOLIDAY";

    // Punches as minutes after this day's local midnight.
    const base = fromKey(key).getTime() - tz * 60_000;
    const punches = (logsByKey.get(key) ?? []).map((l) => ({
      m: (l.timestamp.getTime() - base) / 60_000, dir: (l.direction === 1 ? 1 : 0) as 0 | 1, source: l.source,
    }));
    const segments: Array<[number, number]> = [];
    let openAt: number | null = null;
    let missing = false;
    for (const p of punches) {
      if (p.dir === 0) { if (openAt !== null) missing = true; openAt = p.m; } else if (openAt !== null) { segments.push([openAt, p.m]); openAt = null; } else missing = true;
    }
    let open: [number, number] | null = null;
    if (openAt !== null) {
      if (isToday) open = [openAt, Math.max(openAt, nowMin(key))];
      else missing = true;
    }
    const closedMin = segments.reduce((sum, [a, b]) => sum + (b - a), 0);
    const effectiveMin = rec && num(rec.effectiveHours) > 0 ? num(rec.effectiveHours) * 60 : closedMin;
    const grossMin = rec && num(rec.grossHours) > 0 ? num(rec.grossHours) * 60
      : segments.length ? segments[segments.length - 1][1] - segments[0][0] : 0;
    const breakMin = Math.max(0, grossMin - effectiveMin);

    const leaves = leaveByKey.get(key) ?? [];
    const approvedLeave = leaves.find((l) => l.request.status === "APPROVED" && !l.isSandwich);
    const sandwichLeave = leaves.find((l) => l.request.status === "APPROVED" && l.isSandwich);
    const pendingLeave = leaves.find((l) => l.request.status === "PENDING" && !l.isSandwich);
    const covering = requests.filter((r) => r.fromDate.getTime() <= d.getTime() && r.toDate.getTime() >= d.getTime());
    const remote = covering.find((r) => r.status === "APPROVED" && (r.type === "WORK_FROM_HOME" || r.type === "ON_DUTY"));
    const pendingReq = covering.find((r) => r.status === "PENDING");

    const chips: Chip[] = [];
    if (kind === "WEEKLY_OFF" || kind === "HALF_WEEKLY_OFF") chips.push("woff");
    if (kind === "HOLIDAY") chips.push("hldy");
    if (approvedLeave || sandwichLeave) chips.push("leave");
    if (remote) chips.push(remote.type === "WORK_FROM_HOME" ? "wfh" : "od");

    const portion = (p: string) => (p === "FIRST_HALF" ? " · First half" : p === "SECOND_HALF" ? " · Second half" : p === "QUARTER" ? " · Quarter day" : "");
    let message: Day["message"] = null;
    let tint: Day["tint"] = null;
    let flag: Day["flag"] = null;
    let note: string | null = rec?.penaltyReason ?? rec?.remark ?? null;

    if (punches.length === 0) {
      if (approvedLeave) {
        message = { text: `${approvedLeave.request.leaveType.name}${portion(approvedLeave.portion)}`, tone: "normal" };
        tint = "leave";
      } else if (kind === "HOLIDAY") {
        message = { text: holidayName.get(key) ? `Holiday · ${holidayName.get(key)}` : "Holiday", tone: "normal" };
        tint = "hldy";
      } else if ((kind === "WEEKLY_OFF" || kind === "HALF_WEEKLY_OFF") && pendingReq) {
        message = { text: `${REQUEST_LABEL[pendingReq.type]} Pending approval`, tone: "pending" };
        tint = "woff";
      } else if (kind === "WEEKLY_OFF") {
        message = { text: sandwichLeave ? "Weekly-off · counted as leave (sandwich rule)" : "Full day Weekly-off", tone: "normal" };
        tint = sandwichLeave ? "leave" : "woff";
      } else if (pendingLeave) {
        message = { text: `${pendingLeave.request.leaveType.name}${portion(pendingLeave.portion)} Pending approval`, tone: "pending" };
      } else if (pendingReq) {
        message = { text: `${REQUEST_LABEL[pendingReq.type]} Pending approval`, tone: "pending" };
      } else if (remote) {
        message = { text: `${REQUEST_LABEL[remote.type]} · approved`, tone: "normal" };
        flag = "ok";
      } else if (isFuture) {
        message = null;
      } else if (isToday) {
        message = { text: kind === "HALF_WEEKLY_OFF" ? "Half day Weekly-off · not clocked in yet" : "Not clocked in yet", tone: "muted" };
        note = null;
      } else if (rec && (rec.status === "NO_ATTENDANCE" || rec.status === "ABSENT")) {
        const lop = num(rec.lopValue);
        message = { text: `No attendance recorded${lop > 0 ? ` · ${lop} day LOP` : ""}`, tone: "danger" };
      } else if (rec?.isRegularised) {
        message = { text: "Regularised", tone: "normal" };
        flag = "ok";
      } else if (rec) {
        message = { text: rec.status.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), tone: "normal" };
      } else {
        message = { text: "Not processed yet", tone: "muted" };
      }
    } else {
      const late = !!rec?.remark?.includes("Late by");
      const bad = rec && (rec.status === "ABSENT" || (rec.status === "HALF_DAY" && !approvedLeave));
      flag = missing || late || !!rec?.penaltyReason || bad ? "warn" : "ok";
      if (open && !missing && !late && !rec?.penaltyReason) flag = "ok";
      if (missing && !note) note = "Missing punch";
    }

    out.set(key, {
      key, date: d, isToday, isFuture, kind, holidayName: holidayName.get(key) ?? null, shift,
      status: rec?.status ?? null, punches, segments, open,
      effectiveMin, grossMin, breakMin, lop: num(rec?.lopValue),
      chips, tint, message, flag, note,
      pendingTypes: covering.filter((r) => r.status === "PENDING").map((r) => r.type),
      leaveName: (approvedLeave ?? sandwichLeave)?.request.leaveType.name ?? null,
    });
  }
  return out;
}

export interface Figures { avgHours: number | null; onTimePct: number | null; days: number }

/**
 * Average effective hours over days worked, and on-time arrival: the share of
 * working days with a first punch that the engine did not flag as late (so the
 * shift, its overrides and the policy's grace period all apply).
 */
export function figures(rows: Array<{ date: Date; status: string; firstIn: Date | null; effectiveHours: unknown; remark: string | null }>, from: Date, to: Date): Figures {
  const inRange = rows.filter((r) => r.date.getTime() >= from.getTime() && r.date.getTime() <= to.getTime());
  const worked = inRange.filter((r) => num(r.effectiveHours) > 0);
  const arrivals = inRange.filter((r) => r.firstIn && r.status !== "WEEKLY_OFF" && r.status !== "HOLIDAY");
  return {
    avgHours: worked.length ? worked.reduce((sum, r) => sum + num(r.effectiveHours), 0) / worked.length : null,
    onTimePct: arrivals.length ? (arrivals.filter((r) => !r.remark?.includes("Late by")).length / arrivals.length) * 100 : null,
    days: worked.length,
  };
}
