import "server-only";
import { prisma } from "@keka/db";
import type { Viewer } from "@/lib/context";
import { DIRECTORY_SELECT, directoryWhere, nameOf, type DirectoryEntry } from "@/lib/directory";
import { parseMonth, monthKey, shiftMonth } from "@/lib/scope";

/**
 * Everything the My Team summary shows, assembled for one viewer.
 *
 * Who the team is: the viewer's direct reports (when they manage anyone),
 * then their peers — everyone sharing their reporting manager, themselves
 * included. People are read through the directory select only; of anyone's
 * time data the page uses just today's punches and whether a day is leave
 * (paid or unpaid), remote work, a holiday or a weekly off — never a leave
 * type, a reason, or anything payroll.
 */

const IST_MIN = 330;
const MIN = 60_000;
const DAY = 86_400_000;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

type WeeklyOffConfig = Partial<Record<(typeof WEEKDAYS)[number], { instances: "ALL" | number[]; portion?: string }>>;
const DEFAULT_WEEKLY_OFF: WeeklyOffConfig = { SAT: { instances: "ALL" }, SUN: { instances: "ALL" } };

/** The weekly-off portion for a date under a policy, or null on a working day. */
function weeklyOff(d: Date, config: WeeklyOffConfig): string | null {
  const rule = config[WEEKDAYS[d.getUTCDay()]];
  if (!rule) return null;
  const nth = Math.floor((d.getUTCDate() - 1) / 7) + 1;
  return rule.instances === "ALL" || rule.instances.includes(nth) ? rule.portion ?? "FULL_DAY" : null;
}

const key = (d: Date) => d.toISOString().slice(0, 10);

export type Member = DirectoryEntry & { name: string; firstName: string };

export type ChipKind = "in" | "out" | "not-in-yet" | "leave" | "on-duty" | "wfh" | "woff" | "hldy" | "current";
export interface Chip { kind: ChipKind; label: string }

export interface Today {
  chips: Chip[];
  onLeave: boolean;
  notInYet: boolean;
  firstIn: Date | null;
  lateBy: number | null;
  onTime: boolean;
  remote: "WORK_FROM_HOME" | "ON_DUTY" | null;
  remoteClockIn: { at: Date; source: string } | null;
}

export type DayMark = "paid" | "unpaid" | "noatt" | "wfh" | "od" | "woff" | "hldy";
export interface DayCell { mark: DayMark | null; half?: "first" | "second"; label: string }

export interface TeamData {
  self: Member;
  directs: Member[];
  peers: Member[];
  /** Everyone above, once each, reports first. */
  everyone: Member[];
  today: Map<string, Today>;
  todayDate: Date;
  isOffToday: boolean;
  month: {
    year: number; month: number; label: string; prev: string; next: string; days: Date[];
    cells: Map<string, DayCell[]>;
    /** Per day: how many are on leave, and how many work remotely. */
    leaveCount: number[]; remoteCount: number[];
  };
}

function asMember(e: DirectoryEntry): Member {
  return { ...e, name: nameOf(e), firstName: e.firstName };
}

export async function loadTeam(viewer: Viewer, monthParam: string | undefined, now: Date = new Date()): Promise<TeamData | null> {
  const me = viewer.employee?.id;
  if (!me) return null;
  const tenantId = viewer.tenantId;
  const visible = directoryWhere(tenantId);

  const selfRow = await prisma.employee.findFirst({ where: { tenantId, id: me }, select: DIRECTORY_SELECT });
  if (!selfRow) return null;
  const [directRows, peerRows] = await Promise.all([
    prisma.employee.findMany({ where: { ...visible, reportingManagerId: me }, select: DIRECTORY_SELECT, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    selfRow.reportingManagerId
      ? prisma.employee.findMany({ where: { ...visible, reportingManagerId: selfRow.reportingManagerId }, select: DIRECTORY_SELECT, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] })
      : Promise.resolve([selfRow]),
  ]);
  const self = asMember(selfRow);
  const directs = directRows.map(asMember);
  const peers = peerRows.some((p) => p.id === me) ? peerRows.map(asMember) : [self, ...peerRows.map(asMember)];
  const seen = new Set<string>();
  const everyone = [...directs, ...peers].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  const ids = everyone.map((m) => m.id);

  // ---- Dates (IST) ---------------------------------------------------------
  const todayKey = key(new Date(now.getTime() + IST_MIN * MIN));
  const todayDate = new Date(`${todayKey}T00:00:00Z`);
  const dayStart = new Date(todayDate.getTime() - IST_MIN * MIN);
  const { year, month } = parseMonth(monthParam, todayDate);
  const mStart = new Date(Date.UTC(year, month - 1, 1));
  const mEnd = new Date(Date.UTC(year, month, 0));
  const days: Date[] = [];
  for (let t = mStart.getTime(); t <= mEnd.getTime(); t += DAY) days.push(new Date(t));
  const from = mStart < todayDate ? mStart : todayDate;
  const to = mEnd > todayDate ? mEnd : todayDate;

  // ---- Policies --------------------------------------------------------------
  const [assignments, shifts, attPolicies, woPolicies, calendars] = await Promise.all([
    prisma.employeeTimePolicy.findMany({
      where: { employeeId: { in: ids }, effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      orderBy: { effectiveFrom: "desc" },
    }),
    prisma.shift.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    prisma.attendancePolicy.findMany({ where: { tenantId } }),
    prisma.weeklyOffPolicy.findMany({ where: { tenantId } }),
    prisma.holidayCalendar.findMany({
      where: { tenantId },
      select: { id: true, isDefault: true, locationIds: true, holidays: { where: { isOptional: false, date: { gte: from, lte: to } }, select: { date: true } } },
    }),
  ]);
  const policyAt = (id: string, d: Date) => assignments.find((a) => a.employeeId === id && a.effectiveFrom <= d && (!a.effectiveTo || a.effectiveTo >= d));
  const defaultShift = shifts.find((s) => s.isActive) ?? null;
  const defaultAtt = attPolicies.find((p) => p.isDefault && p.isActive) ?? null;
  const defaultWo = woPolicies.find((p) => p.isDefault && p.isActive);
  const holidaysOf = new Map(calendars.map((c) => [c.id, new Set(c.holidays.map((h) => key(h.date)))]));
  const calendarFor = (m: Member, assigned: string | null | undefined): Set<string> => {
    if (assigned && holidaysOf.has(assigned)) return holidaysOf.get(assigned)!;
    const byLocation = calendars.filter((c) => Array.isArray(c.locationIds) && (c.locationIds as string[]).includes(m.location?.id ?? ""));
    const chosen = byLocation.length > 0 ? byLocation : calendars.filter((c) => c.isDefault);
    return new Set(chosen.flatMap((c) => [...(holidaysOf.get(c.id) ?? [])]));
  };
  const woConfigFor = (assigned: string | null | undefined): WeeklyOffConfig =>
    ((woPolicies.find((p) => p.id === assigned) ?? defaultWo)?.config as WeeklyOffConfig | undefined) ?? DEFAULT_WEEKLY_OFF;

  // ---- Time data -------------------------------------------------------------
  const [logs, leaveDays, remoteRequests, records] = await Promise.all([
    prisma.attendanceLog.findMany({
      where: { tenantId, employeeId: { in: ids }, timestamp: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) } },
      select: { employeeId: true, timestamp: true, direction: true, source: true, ipAddress: true },
      orderBy: { timestamp: "asc" },
    }),
    prisma.leaveRequestDay.findMany({
      where: { date: { gte: from, lte: to }, request: { tenantId, employeeId: { in: ids }, status: "APPROVED" } },
      select: { date: true, portion: true, isPaid: true, request: { select: { employeeId: true } } },
    }),
    prisma.attendanceRequest.findMany({
      where: { tenantId, employeeId: { in: ids }, status: "APPROVED", type: { in: ["WORK_FROM_HOME", "ON_DUTY"] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { employeeId: true, type: true, fromDate: true, toDate: true },
    }),
    prisma.attendanceRecord.findMany({
      where: { tenantId, employeeId: { in: ids }, date: { gte: from, lte: to }, status: { in: ["WORK_FROM_HOME", "ON_DUTY", "NO_ATTENDANCE"] } },
      select: { employeeId: true, date: true, status: true, lopValue: true },
    }),
  ]);

  const leaveOn = new Map<string, { portion: string; isPaid: boolean }>();
  for (const l of leaveDays) leaveOn.set(`${l.request.employeeId}|${key(l.date)}`, { portion: l.portion, isPaid: l.isPaid });
  const recordOn = new Map(records.map((r) => [`${r.employeeId}|${key(r.date)}`, r]));
  const remoteOn = (id: string, d: Date): "WORK_FROM_HOME" | "ON_DUTY" | null => {
    const req = remoteRequests.find((r) => r.employeeId === id && r.fromDate <= d && r.toDate >= d);
    if (req) return req.type as "WORK_FROM_HOME" | "ON_DUTY";
    const rec = recordOn.get(`${id}|${key(d)}`);
    return rec?.status === "WORK_FROM_HOME" || rec?.status === "ON_DUTY" ? rec.status : null;
  };
  const logsOf = new Map<string, typeof logs>();
  for (const l of logs) logsOf.set(l.employeeId, [...(logsOf.get(l.employeeId) ?? []), l]);

  // ---- Today ---------------------------------------------------------------
  const today = new Map<string, Today>();
  let offCount = 0;
  for (const m of everyone) {
    const pol = policyAt(m.id, todayDate);
    const tracked = pol?.trackAttendance ?? true;
    const shift = shifts.find((s) => s.id === pol?.shiftId) ?? defaultShift;
    const attPolicy = attPolicies.find((p) => p.id === pol?.attendancePolicyId) ?? defaultAtt;
    const grace = attPolicy?.graceMinutes ?? 15;
    const officeIps = Array.isArray(attPolicy?.ipAllowList) ? (attPolicy.ipAllowList as string[]) : [];
    const leave = leaveOn.get(`${m.id}|${todayKey}`);
    const remote = remoteOn(m.id, todayDate);
    const holiday = calendarFor(m, pol?.holidayCalendarId).has(todayKey);
    const woff = weeklyOff(todayDate, woConfigFor(pol?.weeklyOffPolicyId)) === "FULL_DAY";
    if (holiday || woff) offCount++;
    const punches = logsOf.get(m.id) ?? [];
    const ins = punches.filter((p) => p.direction === 0);
    const firstIn = ins[0]?.timestamp ?? null;
    const last = punches[punches.length - 1];
    // Away from the office: the mobile app, or the web from an address that
    // is not on the attendance policy's office allow-list.
    const remoteIn = ins.find((p) => p.source === "MOBILE" || (p.source === "WEB" && !(p.ipAddress && officeIps.includes(p.ipAddress))));

    let lateBy: number | null = null;
    if (firstIn && shift && !shift.isFlexible) {
      const [h, mm] = shift.startTime.split(":").map(Number);
      const start = dayStart.getTime() + (h * 60 + mm) * MIN;
      const mins = Math.round((firstIn.getTime() - start) / MIN);
      if (mins > grace) lateBy = mins;
    }

    const chips: Chip[] = [];
    const fullLeave = leave?.portion === "FULL_DAY";
    if (fullLeave) chips.push({ kind: "leave", label: "Leave" });
    else if (last) chips.push(last.direction === 0 ? { kind: "in", label: "In" } : { kind: "out", label: "Out" });
    else if (remote === "ON_DUTY") chips.push({ kind: "on-duty", label: "On duty" });
    else if (holiday) chips.push({ kind: "hldy", label: "Holiday" });
    else if (woff) chips.push({ kind: "woff", label: "W-off" });
    else if (leave) chips.push({ kind: "leave", label: "Half-day leave" });
    else if (tracked) chips.push({ kind: "not-in-yet", label: "Not in yet" });
    if (!fullLeave && last && remote === "ON_DUTY") chips.push({ kind: "on-duty", label: "On duty" });
    if (!fullLeave && remote === "WORK_FROM_HOME") chips.push({ kind: "wfh", label: "WFH" });
    if (ins.some((p) => p.source === "MOBILE")) chips.push({ kind: "current", label: "Mobile app" });

    today.set(m.id, {
      chips,
      onLeave: !!leave,
      notInYet: tracked && !last && !fullLeave && !holiday && !woff && remote !== "ON_DUTY",
      firstIn,
      lateBy,
      onTime: !!firstIn && lateBy === null,
      remote,
      remoteClockIn: remoteIn ? { at: remoteIn.timestamp, source: remoteIn.source } : null,
    });
  }

  // ---- The month grid ------------------------------------------------------
  const cells = new Map<string, DayCell[]>();
  const leaveCount = days.map(() => 0);
  const remoteCount = days.map(() => 0);
  const mid = new Date(Date.UTC(year, month - 1, 15));
  for (const m of everyone) {
    const pol = policyAt(m.id, mid) ?? policyAt(m.id, todayDate);
    const hol = calendarFor(m, pol?.holidayCalendarId);
    const wo = woConfigFor(pol?.weeklyOffPolicyId);
    cells.set(m.id, days.map((d, i) => {
      const k = key(d);
      const leave = leaveOn.get(`${m.id}|${k}`);
      if (leave) {
        leaveCount[i]++;
        const half = leave.portion === "FIRST_HALF" ? "first" : leave.portion === "SECOND_HALF" ? "second" : undefined;
        return { mark: leave.isPaid ? "paid" : "unpaid", half, label: `${leave.isPaid ? "Paid" : "Unpaid"} leave${half ? ` (${half} half)` : ""}` };
      }
      const remote = remoteOn(m.id, d);
      if (remote) {
        remoteCount[i]++;
        return remote === "ON_DUTY" ? { mark: "od", label: "On duty" } : { mark: "wfh", label: "Work from home" };
      }
      if (hol.has(k)) return { mark: "hldy", label: "Holiday" };
      const off = weeklyOff(d, wo);
      if (off === "FULL_DAY") return { mark: "woff", label: "Weekly off" };
      const rec = recordOn.get(`${m.id}|${k}`);
      if (rec?.status === "NO_ATTENDANCE" && Number(rec.lopValue) > 0 && d < todayDate) return { mark: "noatt", label: "Leave due to no attendance" };
      if (off) return { mark: "woff", half: off === "FIRST_HALF" ? "first" : "second", label: "Half-day weekly off" };
      return { mark: null, label: "Working day" };
    }));
  }

  const prev = shiftMonth(year, month, -1), next = shiftMonth(year, month, 1);
  return {
    self, directs, peers, everyone, today, todayDate,
    isOffToday: everyone.length > 0 && offCount === everyone.length,
    month: {
      year, month, days, cells, leaveCount, remoteCount,
      label: mStart.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }),
      prev: monthKey(prev.year, prev.month), next: monthKey(next.year, next.month),
    },
  };
}
