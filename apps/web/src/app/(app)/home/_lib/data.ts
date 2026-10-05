import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { MONTH_SHORT } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { scopedEmployeeIds, scopedEmployeeWhere, inScope, timesheetsToApproveWhere } from "@/lib/scope";

/**
 * Data for the Home screens (Dashboard and Welcome). Everything here is either
 * the viewer's own record or the directory fields every colleague may see —
 * birthdays leave this module as a day and a month, never a year.
 */

const P = PERMISSIONS;
const IST = 330 * 60_000;
const DAY = 86_400_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** The calendar day in India, as UTC midnight (how dates are stored), plus the instant it began. */
export interface Today { date: Date; start: Date; year: number; month: number; day: number }

export function istToday(now = new Date()): Today {
  const local = new Date(now.getTime() + IST);
  const year = local.getUTCFullYear(), month = local.getUTCMonth(), day = local.getUTCDate();
  const date = new Date(Date.UTC(year, month, day));
  return { date, start: new Date(date.getTime() - IST), year, month, day };
}

export const istTime = (d: Date) =>
  d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).toUpperCase();

/** "Thu, 01 Oct 2026" for a UTC-midnight date. */
export const dayLabel = (d: Date) =>
  `${WEEKDAY[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** "Fri, 02 October, 2026", as Keka writes a holiday. */
export const longDayLabel = (d: Date) =>
  `${WEEKDAY[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_LONG[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;

const dayMonth = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]}`;

/** "Tomorrow", else "26 August" — how Keka labels an upcoming celebration. */
function upcomingLabel(today: Today, days: number): string {
  if (days === 1) return "Tomorrow";
  const d = new Date(today.date.getTime() + days * DAY);
  return `${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]}`;
}

// --- People -----------------------------------------------------------------

export const PERSON_SELECT = {
  id: true, firstName: true, lastName: true, displayName: true, photoUrl: true, jobTitleName: true,
} as const;

export interface PersonLite { id: string; name: string; firstName: string; photoUrl: string | null; title: string | null }

export const toPerson = (e: { id: string; firstName: string; lastName: string; displayName: string | null; photoUrl: string | null; jobTitleName: string | null }): PersonLite =>
  ({ id: e.id, name: nameOf(e), firstName: e.firstName, photoUrl: e.photoUrl, title: e.jobTitleName });

/** The viewer's own placement — used for holiday calendars and announcement audiences. */
export async function myPlacement(viewer: Viewer) {
  if (!viewer.employee) return null;
  return prisma.employee.findFirst({
    where: { id: viewer.employee.id, tenantId: viewer.tenantId },
    select: {
      id: true, status: true, locationId: true, departmentId: true, businessUnitId: true, workerTypeId: true,
      reportingManagerId: true, dateOfJoining: true,
    },
  });
}
export type Placement = NonNullable<Awaited<ReturnType<typeof myPlacement>>>;

// --- On leave today -----------------------------------------------------------

export async function onLeaveToday(viewer: Viewer, today: Today): Promise<Array<PersonLite & { partial: boolean }>> {
  const days = await prisma.leaveRequestDay.findMany({
    where: { date: today.date, request: { tenantId: viewer.tenantId, status: "APPROVED" } },
    select: { portion: true, request: { select: { employeeId: true } } },
  });
  if (days.length === 0) return [];
  const partial = new Map<string, boolean>();
  for (const d of days) partial.set(d.request.employeeId, (partial.get(d.request.employeeId) ?? true) && d.portion !== "FULL_DAY");
  const people = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), id: { in: [...partial.keys()] } },
    select: PERSON_SELECT,
    orderBy: { firstName: "asc" },
  });
  return people.map((p) => ({ ...toPerson(p), partial: partial.get(p.id) ?? false }));
}

// --- Leave balances -----------------------------------------------------------

export interface BalanceRing { id: string; name: string; code: string; available: number; total: number; colour: string | null }

/** The viewer's balances for the current leave year, main types first. */
export async function myLeaveBalances(viewer: Viewer, today: Today): Promise<BalanceRing[]> {
  if (!viewer.employee) return [];
  const rows = await prisma.leaveBalance.findMany({
    where: { employeeId: viewer.employee.id, yearStart: { lte: today.date }, leaveType: { tenantId: viewer.tenantId } },
    include: { leaveType: { select: { name: true, code: true, category: true, isUnlimited: true, annualQuota: true, color: true } } },
    orderBy: { yearStart: "desc" },
  });
  if (rows.length === 0) return [];
  const current = rows.filter((r) => r.yearStart.getTime() === rows[0].yearStart.getTime());
  const rank = (c: string) => (c === "REGULAR" ? 0 : c === "COMP_OFF" ? 1 : 2);
  return current
    .filter((r) => !r.leaveType.isUnlimited && r.leaveType.category !== "UNPAID")
    .sort((a, b) => rank(a.leaveType.category) - rank(b.leaveType.category)
      || Number(b.leaveType.annualQuota) - Number(a.leaveType.annualQuota)
      || a.leaveType.name.localeCompare(b.leaveType.name))
    .map((r) => {
      const granted = Number(r.opening) + Number(r.accrued) + Number(r.carriedForward);
      return {
        id: r.id, name: r.leaveType.name, code: r.leaveType.code, colour: r.leaveType.color,
        available: Number(r.available),
        total: Math.max(granted, Number(r.available), 0),
      };
    });
}

// --- Holidays -------------------------------------------------------------------

export interface HolidaySlide { id: string; name: string; date: string; optional: boolean; inDays: number }

/** Upcoming holidays on the calendar that applies to the viewer's location (else the default one). */
export async function upcomingHolidays(viewer: Viewer, today: Today, locationId: string | null | undefined): Promise<HolidaySlide[]> {
  const calendars = await prisma.holidayCalendar.findMany({
    where: { tenantId: viewer.tenantId },
    select: { id: true, isDefault: true, locationIds: true },
  });
  const forMyLocation = locationId
    ? calendars.filter((c) => Array.isArray(c.locationIds) && (c.locationIds as unknown[]).includes(locationId))
    : [];
  const chosen = forMyLocation.length > 0 ? forMyLocation : calendars.filter((c) => c.isDefault);
  if (chosen.length === 0) return [];
  const rows = await prisma.holiday.findMany({
    where: { calendarId: { in: chosen.map((c) => c.id) }, date: { gte: today.date } },
    orderBy: [{ date: "asc" }, { name: "asc" }],
    take: 15,
  });
  return rows.map((h) => ({
    id: h.id, name: h.name, date: longDayLabel(h.date), optional: h.isOptional,
    inDays: Math.round((h.date.getTime() - today.date.getTime()) / DAY),
  }));
}

// --- Inbox ----------------------------------------------------------------------

export interface InboxLine { key: string; label: string; count: number; href: string }

/** What is waiting on the viewer — the same things the Inbox asks them to decide. */
export async function inboxSummary(viewer: Viewer): Promise<InboxLine[]> {
  const me = viewer.employee?.id;
  const notSelf = me ? { NOT: { employeeId: me } } : {};
  const leaveScope = can(viewer, P.LEAVE_APPROVE) ? await scopedEmployeeIds(viewer, P.LEAVE_APPROVE) : [];
  const zero = Promise.resolve(0);
  const [leave, attendance, payroll, exits, tasks, sheets, acks] = await Promise.all([
    can(viewer, P.LEAVE_APPROVE)
      ? prisma.leaveRequest.count({ where: { tenantId: viewer.tenantId, status: "PENDING", ...inScope(leaveScope), ...notSelf } })
      : zero,
    can(viewer, P.ATTENDANCE_APPROVE)
      ? prisma.attendanceRequest.count({ where: { tenantId: viewer.tenantId, status: "PENDING", ...notSelf, employee: scopedEmployeeWhere(viewer, P.ATTENDANCE_APPROVE) } })
      : zero,
    can(viewer, P.PAYROLL_APPROVE)
      ? prisma.payrollApprovalRequest.count({ where: { status: "PENDING", run: { tenantId: viewer.tenantId } } })
      : zero,
    can(viewer, P.EXIT_APPROVE)
      ? prisma.exitRecord.count({ where: { status: "PENDING_APPROVAL", employee: { ...scopedEmployeeWhere(viewer, P.EXIT_APPROVE), ...(me ? { NOT: { id: me } } : {}) } } })
      : zero,
    me
      ? prisma.journeyTask.count({ where: { assigneeEmployeeId: me, status: "PENDING", journey: { tenantId: viewer.tenantId, status: "ACTIVE" } } })
      : zero,
    me ? prisma.timesheet.count({ where: timesheetsToApproveWhere(viewer) }) : zero,
    me
      ? prisma.announcement.count({
          where: {
            tenantId: viewer.tenantId, status: "PUBLISHED", requireAck: true,
            reads: { none: { employeeId: me, acknowledgedAt: { not: null } } },
          },
        })
      : zero,
  ]);
  const lines: InboxLine[] = [
    { key: "leave", label: "Leave requests to approve", count: leave, href: "/inbox" },
    { key: "attendance", label: "Attendance requests to approve", count: attendance, href: "/inbox" },
    { key: "payroll", label: "Payroll runs awaiting approval", count: payroll, href: "/inbox" },
    { key: "exits", label: "Resignations to decide", count: exits, href: "/inbox" },
    { key: "tasks", label: "Journey tasks assigned to you", count: tasks, href: "/inbox" },
    { key: "sheets", label: "Timesheets to approve", count: sheets, href: "/inbox" },
    { key: "acks", label: "Announcements to acknowledge", count: acks, href: "/announcements" },
  ];
  return lines.filter((l) => l.count > 0);
}

/** The viewer's own requests still waiting on someone else. */
export async function myOpenRequests(viewer: Viewer): Promise<number> {
  if (!viewer.employee) return 0;
  const id = viewer.employee.id;
  const xs = await Promise.all([
    prisma.leaveRequest.count({ where: { employeeId: id, tenantId: viewer.tenantId, status: "PENDING" } }),
    prisma.attendanceRequest.count({ where: { employeeId: id, tenantId: viewer.tenantId, status: "PENDING" } }),
    prisma.helpdeskTicket.count({ where: { employeeId: id, tenantId: viewer.tenantId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"] } } }),
  ]);
  return xs.reduce((a, b) => a + b, 0);
}

// --- Attendance today -------------------------------------------------------------

export async function myPunchesToday(viewer: Viewer, today: Today) {
  if (!viewer.employee) return [];
  return prisma.attendanceLog.findMany({
    where: { employeeId: viewer.employee.id, tenantId: viewer.tenantId, timestamp: { gte: today.start } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, direction: true },
  });
}

// --- Announcements ----------------------------------------------------------------

export interface AnnouncementLite { id: string; title: string; excerpt: string; date: string; pinned: boolean; needsAck: boolean }

interface Audience { departmentIds?: string[]; locationIds?: string[]; businessUnitIds?: string[]; workerTypeIds?: string[]; excludeOnNotice?: boolean }

function inAudience(raw: unknown, me: Placement | null): boolean {
  if (!raw || typeof raw !== "object") return true;
  const a = raw as Audience;
  const match = (list: string[] | undefined, value: string | null | undefined) =>
    !Array.isArray(list) || list.length === 0 || (!!value && list.includes(value));
  if (!me) return !(a.departmentIds?.length || a.locationIds?.length || a.businessUnitIds?.length || a.workerTypeIds?.length);
  if (a.excludeOnNotice && me.status === "NOTICE_PERIOD") return false;
  return match(a.departmentIds, me.departmentId) && match(a.locationIds, me.locationId)
    && match(a.businessUnitIds, me.businessUnitId) && match(a.workerTypeIds, me.workerTypeId);
}

/** Live announcements addressed to the viewer, pinned first. */
export async function liveAnnouncements(viewer: Viewer, me: Placement | null, take = 3): Promise<AnnouncementLite[]> {
  const now = new Date();
  const rows = await prisma.announcement.findMany({
    where: {
      tenantId: viewer.tenantId, status: "PUBLISHED",
      AND: [
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: [{ isPinned: "desc" }, { publishAt: "desc" }, { createdAt: "desc" }],
    take: 20,
    select: {
      id: true, title: true, body: true, publishAt: true, createdAt: true, isPinned: true, requireAck: true, audience: true,
      reads: { where: { employeeId: me?.id ?? "__none__" }, select: { acknowledgedAt: true } },
    },
  });
  return rows.filter((r) => inAudience(r.audience, me)).slice(0, take).map((r) => {
    const text = r.body.replace(/\s+/g, " ").trim();
    return {
      id: r.id, title: r.title,
      excerpt: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
      date: dayLabel(r.publishAt ?? r.createdAt), pinned: r.isPinned,
      needsAck: r.requireAck && !r.reads.some((x) => x.acknowledgedAt),
    };
  });
}

// --- Celebrations -----------------------------------------------------------------

export interface Celebrant { id: string; name: string; photoUrl: string | null; when: string; note?: string }
export interface CelebrationGroup {
  key: "birthdays" | "anniversaries" | "joinees";
  count: number;
  today: Celebrant[];
  upcoming: Celebrant[];
}

const UPCOMING_DAYS = 30;
export const NEW_JOINEE_DAYS = 90;

/** Days from today to the next time this month/day comes round (0 = today). */
function daysUntil(today: Today, month: number, day: number): { days: number; year: number } {
  const on = (y: number) => {
    // 29 February is celebrated on 28 February in other years.
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const d = month === 1 && day === 29 && !leap ? 28 : day;
    return Date.UTC(y, month, d);
  };
  let year = today.year;
  let t = on(year);
  if (t < today.date.getTime()) { year += 1; t = on(year); }
  return { days: Math.round((t - today.date.getTime()) / DAY), year };
}

/**
 * Birthdays, work anniversaries and new joinees across the directory. The
 * date of birth is read here and reduced to "06 Oct" — the year never leaves.
 */
export async function celebrations(viewer: Viewer, today: Today): Promise<CelebrationGroup[]> {
  const people = await prisma.employee.findMany({
    where: directoryWhere(viewer.tenantId),
    select: { ...PERSON_SELECT, dateOfBirth: true, dateOfJoining: true },
  });

  const bToday: Celebrant[] = [], bSoon: Array<Celebrant & { d: number }> = [];
  const aToday: Celebrant[] = [], aSoon: Array<Celebrant & { d: number }> = [];
  const joinees: Array<Celebrant & { t: number }> = [], jToday: Celebrant[] = [];

  for (const p of people) {
    const base = { id: p.id, name: nameOf(p), photoUrl: p.photoUrl };
    if (p.dateOfBirth) {
      const { days } = daysUntil(today, p.dateOfBirth.getUTCMonth(), p.dateOfBirth.getUTCDate());
      if (days === 0) bToday.push({ ...base, when: "Today" });
      else if (days <= UPCOMING_DAYS) bSoon.push({ ...base, when: upcomingLabel(today, days), d: days });
    }
    const doj = p.dateOfJoining;
    if (doj.getTime() <= today.date.getTime()) {
      const { days, year } = daysUntil(today, doj.getUTCMonth(), doj.getUTCDate());
      const years = year - doj.getUTCFullYear();
      if (years >= 1) {
        const note = `${years} ${years === 1 ? "year" : "years"}`;
        if (days === 0) aToday.push({ ...base, when: "Today", note });
        else if (days <= UPCOMING_DAYS) aSoon.push({ ...base, when: upcomingLabel(today, days), note, d: days });
      }
      const since = Math.round((today.date.getTime() - doj.getTime()) / DAY);
      if (since === 0) jToday.push({ ...base, when: "Today", note: p.jobTitleName ?? undefined });
      else if (since <= NEW_JOINEE_DAYS) joinees.push({ ...base, when: dayMonth(doj), note: p.jobTitleName ?? undefined, t: doj.getTime() });
    }
  }

  const byName = (a: Celebrant, b: Celebrant) => a.name.localeCompare(b.name);
  const strip = <T extends Celebrant>(xs: T[]): Celebrant[] => xs.map(({ id, name, photoUrl, when, note }) => ({ id, name, photoUrl, when, note }));
  joinees.sort((a, b) => b.t - a.t || byName(a, b));

  return [
    { key: "birthdays", count: bToday.length, today: bToday.sort(byName), upcoming: strip(bSoon.sort((a, b) => a.d - b.d || byName(a, b))) },
    { key: "anniversaries", count: aToday.length, today: aToday.sort(byName), upcoming: strip(aSoon.sort((a, b) => a.d - b.d || byName(a, b))) },
    // Joined today, then everyone who joined in the last 90 days, newest first.
    { key: "joinees", count: jToday.length, today: jToday.sort(byName), upcoming: strip(joinees) },
  ];
}

// --- Praise -----------------------------------------------------------------------

export async function recentPraise(viewer: Viewer, take = 3) {
  const rows = await prisma.praise.findMany({
    where: { tenantId: viewer.tenantId, isPublic: true },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true, badge: true, message: true, createdAt: true,
      fromEmployee: { select: PERSON_SELECT },
      toEmployee: { select: PERSON_SELECT },
    },
  });
  return rows.map((r) => ({
    id: r.id, badge: r.badge, message: r.message, date: dayLabel(r.createdAt),
    from: toPerson(r.fromEmployee), to: toPerson(r.toEmployee),
  }));
}

/** Everyone the viewer may praise: the directory, minus themselves. */
export async function praiseableColleagues(viewer: Viewer): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}) },
    select: { id: true, firstName: true, lastName: true, displayName: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, name: nameOf(r) }));
}

// --- Working remotely ---------------------------------------------------------------

/** Approved work-from-home and on-duty requests that cover today, as directory people. */
export async function workingRemotelyToday(viewer: Viewer, today: Today): Promise<Array<PersonLite & { mode: "WFH" | "ON_DUTY" }>> {
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      tenantId: viewer.tenantId, status: "APPROVED", type: { in: ["WORK_FROM_HOME", "ON_DUTY"] },
      fromDate: { lte: today.date }, toDate: { gte: today.date },
    },
    select: { employeeId: true, type: true },
  });
  if (reqs.length === 0) return [];
  const mode = new Map(reqs.map((r) => [r.employeeId, r.type === "ON_DUTY" ? "ON_DUTY" as const : "WFH" as const]));
  const people = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), id: { in: [...mode.keys()] } },
    select: PERSON_SELECT, orderBy: { firstName: "asc" },
  });
  return people.map((p) => ({ ...toPerson(p), mode: mode.get(p.id)! }));
}

// --- Holidays for a year --------------------------------------------------------------

export interface HolidayRow { id: string; name: string; month: number; day: number; weekday: string; optional: boolean; past: boolean }

/** The viewer's holiday calendar for a year (their location's, else the default), and the years on offer. */
export async function holidayYear(viewer: Viewer, year: number, locationId: string | null | undefined, today: Today): Promise<{ rows: HolidayRow[]; years: number[] }> {
  const calendars = await prisma.holidayCalendar.findMany({
    where: { tenantId: viewer.tenantId },
    select: { id: true, isDefault: true, locationIds: true, year: true },
  });
  const mine = (c: { locationIds: unknown }) => !!locationId && Array.isArray(c.locationIds) && (c.locationIds as unknown[]).includes(locationId);
  const years = [...new Set(calendars.map((c) => c.year))].sort((a, b) => a - b);
  const forYear = calendars.filter((c) => c.year === year);
  const chosen = forYear.some(mine) ? forYear.filter(mine) : forYear.filter((c) => c.isDefault);
  const pool = chosen.length ? chosen : forYear;
  const rows = pool.length ? await prisma.holiday.findMany({
    where: { calendarId: { in: pool.map((c) => c.id) }, date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    orderBy: [{ date: "asc" }, { name: "asc" }],
  }) : [];
  const seen = new Set<string>();
  const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return {
    years,
    rows: rows.filter((h) => { const k = `${h.date.toISOString()}|${h.name}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((h) => ({
        id: h.id, name: h.name, month: h.date.getUTCMonth(), day: h.date.getUTCDate(), weekday: WEEKDAY_LONG[h.date.getUTCDay()],
        optional: h.isOptional, past: h.date.getTime() < today.date.getTime(),
      })),
  };
}

// --- Feedback and project time ----------------------------------------------------------

export async function feedbackReceivedCount(viewer: Viewer): Promise<number> {
  if (!viewer.employee) return 0;
  return prisma.feedback.count({ where: { tenantId: viewer.tenantId, aboutEmployeeId: viewer.employee.id, kind: "FEEDBACK", deletedAt: null } });
}

export interface ProjectTimeLine { id: string; label: string; minutes: number }

/** Today's time entries, and whether the viewer has any project to log against at all. */
export async function projectTimeToday(viewer: Viewer, today: Today): Promise<{ assigned: boolean; lines: ProjectTimeLine[]; totalMinutes: number }> {
  if (!viewer.employee) return { assigned: false, lines: [], totalMinutes: 0 };
  const id = viewer.employee.id;
  const [allocations, entries] = await Promise.all([
    prisma.resourceAllocation.count({ where: { employeeId: id, project: { tenantId: viewer.tenantId, status: { in: ["ACTIVE", "ON_HOLD", "OVERDUE"] } } } }),
    prisma.timeEntry.findMany({
      where: { tenantId: viewer.tenantId, employeeId: id, date: today.date },
      select: { id: true, hours: true, project: { select: { name: true, client: { select: { name: true } } } }, task: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const lines = entries.map((e) => ({
    id: e.id,
    label: [e.project.client?.name, e.project.name, e.task?.title].filter(Boolean).join(" - "),
    minutes: Math.round(Number(e.hours) * 60),
  }));
  return { assigned: allocations > 0 || lines.length > 0, lines, totalMinutes: lines.reduce((a, l) => a + l.minutes, 0) };
}
