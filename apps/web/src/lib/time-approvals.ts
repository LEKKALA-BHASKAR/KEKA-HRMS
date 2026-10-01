import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { formatHhmm, type TimeEntity } from "@keka/services";
import { can, type Viewer } from "./context";
import { scopedEmployeeIds } from "./scope";

/**
 * Time approvals, one registry for every screen that lists them: Time Attend ›
 * Approvals (everyone the viewer's roles reach), My Team › Leave/Attendance
 * (their reporting line), the inbox's time categories and the nav counts.
 *
 * Every category is queried tenant-bound, limited to the employees the
 * viewer may approve for, and never includes the viewer's own requests.
 */

const P = PERMISSIONS;

export type TimeCat = "leave" | "compoff" | "encashment" | "wfh-od" | "regularization" | "remote" | "overtime" | "shift";
export type ApprovalScope = "admin" | "team";
export type StatusFilter = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "ALL";

export interface TimeCategory {
  key: TimeCat;
  /** Category pill and inbox label. */
  label: string;
  entity: TimeEntity;
  permission: Permission;
  family: "LEAVE" | "ATTENDANCE";
}

export const TIME_CATEGORIES: TimeCategory[] = [
  { key: "leave", label: "Leave Requests", entity: "LeaveRequest", permission: P.LEAVE_APPROVE, family: "LEAVE" },
  { key: "compoff", label: "Comp Off", entity: "CompOffRequest", permission: P.LEAVE_APPROVE, family: "LEAVE" },
  { key: "encashment", label: "Leave Encashment", entity: "LeaveEncashmentRequest", permission: P.LEAVE_APPROVE, family: "LEAVE" },
  { key: "wfh-od", label: "WFH / On Duty", entity: "AttendanceRequest", permission: P.ATTENDANCE_APPROVE, family: "ATTENDANCE" },
  { key: "regularization", label: "Regularization", entity: "AttendanceRequest", permission: P.ATTENDANCE_APPROVE, family: "ATTENDANCE" },
  { key: "remote", label: "Remote Clock In", entity: "AttendanceRequest", permission: P.ATTENDANCE_APPROVE, family: "ATTENDANCE" },
  { key: "overtime", label: "Overtime", entity: "OvertimeRequest", permission: P.ATTENDANCE_APPROVE, family: "ATTENDANCE" },
  { key: "shift", label: "Shift & Weekly Off", entity: "ShiftRequest", permission: P.ATTENDANCE_APPROVE, family: "ATTENDANCE" },
];
export const categoryOf = (key: string | undefined | null) => TIME_CATEGORIES.find((c) => c.key === key) ?? null;

/** Columns per category, between the employee and the shared status columns. */
export const CATEGORY_COLUMNS: Record<TimeCat, Array<{ key: string; label: string }>> = {
  leave: [{ key: "type", label: "Leave type" }, { key: "dates", label: "Leave dates" }, { key: "days", label: "Days" }, { key: "note", label: "Note" }],
  compoff: [{ key: "dates", label: "Worked on" }, { key: "days", label: "Credit" }, { key: "note", label: "Note" }],
  encashment: [{ key: "type", label: "Leave type" }, { key: "days", label: "No of leave" }, { key: "amount", label: "Est. amount" }, { key: "note", label: "Note" }],
  "wfh-od": [{ key: "dates", label: "Date" }, { key: "type", label: "Request type" }, { key: "portion", label: "Duration" }, { key: "note", label: "Note" }],
  regularization: [{ key: "dates", label: "Date" }, { key: "type", label: "Request type" }, { key: "detail", label: "Proposed" }, { key: "note", label: "Reason" }],
  remote: [{ key: "dates", label: "Date" }, { key: "entries", label: "Time entries" }, { key: "location", label: "Location" }, { key: "note", label: "Comment" }],
  overtime: [{ key: "dates", label: "Overtime date" }, { key: "total", label: "Total overtime" }, { key: "logged", label: "From logs" }, { key: "note", label: "Note" }],
  shift: [{ key: "type", label: "Request" }, { key: "dates", label: "Date" }, { key: "shift", label: "New shift (requested)" }, { key: "note", label: "Note" }],
};

export interface ApprovalPerson { id: string; name: string; number: string; department: string | null; photoUrl: string | null }

export interface ApprovalRow {
  id: string;
  cat: TimeCat;
  entity: TimeEntity;
  employee: ApprovalPerson;
  /** PENDING | APPROVED | REJECTED | CANCELLED | WITHDRAWN */
  status: string;
  requestedOn: Date;
  /** One line for lists: "Work From Home · 07 Oct 2026 · First half". */
  summary: string;
  cells: Record<string, string>;
  /** Present on remote clock-ins: a map link. */
  mapUrl?: string | null;
  lastActionBy: string | null;
  lastActionAt: Date | null;
  decisionNote: string | null;
  nextApprover: string | null;
  canDecide: boolean;
}

export interface ApprovalQuery {
  scope: ApprovalScope;
  status?: StatusFilter;
  from?: Date | null;
  to?: Date | null;
  departmentId?: string | null;
  locationId?: string | null;
  q?: string | null;
  take?: number;
}

const ATTENDANCE_TYPES: Record<string, string[]> = {
  "wfh-od": ["WORK_FROM_HOME", "ON_DUTY"],
  regularization: ["ADJUSTMENT", "REGULARISATION", "PARTIAL_DAY"],
  remote: ["REMOTE_CLOCK_IN"],
};
export const ATTENDANCE_TYPE_LABEL: Record<string, string> = {
  WORK_FROM_HOME: "Work From Home", ON_DUTY: "On Duty", ADJUSTMENT: "Adjust logs",
  REGULARISATION: "Exempt penalty", PARTIAL_DAY: "Partial day", REMOTE_CLOCK_IN: "Remote Clock In",
};
const PORTION_LABEL: Record<string, string> = { FULL_DAY: "Full day", FIRST_HALF: "First half", SECOND_HALF: "Second half", QUARTER: "Quarter day" };

const IST = 330 * 60_000;
/** "09:42 am", from a UTC instant, in IST. */
const clock = (d: Date) => {
  const l = new Date(d.getTime() + IST);
  const h = l.getUTCHours(), m = l.getUTCMinutes();
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};
const range = (a: Date, b: Date) => (a.getTime() === b.getTime() ? formatDate(a) : `${formatDate(a)} – ${formatDate(b)}`);
const spanDays = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The employees whose requests in this category the viewer may see and
 * decide, as an employeeId filter. `null` means nobody.
 */
async function employeeFilter(viewer: Viewer, cat: TimeCategory, q: ApprovalQuery): Promise<{ in?: string[]; not: string } | null> {
  if (!can(viewer, cat.permission)) return null;
  let ids = await scopedEmployeeIds(viewer, cat.permission);
  if (q.scope === "team") {
    const team = [...viewer.allReportIds];
    ids = ids === null ? team : ids.filter((id) => viewer.allReportIds.has(id));
  }
  if (q.departmentId || q.locationId || q.q) {
    const rows = await prisma.employee.findMany({
      where: {
        tenantId: viewer.tenantId,
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(q.locationId ? { locationId: q.locationId } : {}),
        ...(q.q ? {
          OR: [
            { displayName: { contains: q.q, mode: "insensitive" as const } },
            { firstName: { contains: q.q, mode: "insensitive" as const } },
            { lastName: { contains: q.q, mode: "insensitive" as const } },
            { employeeNumber: { contains: q.q, mode: "insensitive" as const } },
          ],
        } : {}),
      },
      select: { id: true },
    });
    const allowed = new Set(rows.map((r) => r.id));
    ids = ids === null ? [...allowed] : ids.filter((id) => allowed.has(id));
  }
  return { ...(ids === null ? {} : { in: ids }), not: viewer.employee?.id ?? "__none__" };
}

function statusWhere(cat: TimeCategory, status: StatusFilter | undefined): Record<string, unknown> {
  const s = status ?? "PENDING";
  if (s === "ALL") return {};
  if (s === "CANCELLED") {
    return cat.family === "LEAVE" ? { status: { in: ["CANCELLED", "WITHDRAWN"] } } : { status: "CANCELLED" };
  }
  return { status: s };
}

function dateWhere(q: ApprovalQuery): Record<string, unknown> {
  return {
    ...(q.to ? { fromDate: { lte: q.to } } : {}),
    ...(q.from ? { toDate: { gte: q.from } } : {}),
  };
}

/** List one category's requests for the viewer. */
export async function listApprovals(viewer: Viewer, key: TimeCat, q: ApprovalQuery): Promise<ApprovalRow[]> {
  const cat = categoryOf(key);
  if (!cat) return [];
  const emp = await employeeFilter(viewer, cat, q);
  if (!emp) return [];
  const where = { tenantId: viewer.tenantId, employeeId: { ...(emp.in ? { in: emp.in } : {}), not: emp.not }, ...statusWhere(cat, q.status), ...dateWhere(q) };
  const take = q.take ?? 200;
  const order = { createdAt: (q.status ?? "PENDING") === "PENDING" ? "asc" : "desc" } as const;

  type Raw = Omit<ApprovalRow, "employee" | "lastActionBy" | "nextApprover" | "canDecide"> & { employeeId: string; deciderId: string | null };
  let raw: Raw[] = [];

  if (key === "leave") {
    const rows = await prisma.leaveRequest.findMany({ where, include: { leaveType: { select: { name: true } } }, orderBy: order, take });
    raw = rows.map((r) => {
      const days = Number(r.totalDays);
      const portion = r.fromDate.getTime() === r.toDate.getTime() && r.fromPortion !== "FULL_DAY" ? ` (${PORTION_LABEL[r.fromPortion]})` : "";
      return {
        id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
        summary: `${r.leaveType.name} · ${dayCount(days)} · ${range(r.fromDate, r.toDate)}`,
        cells: { type: r.leaveType.name, dates: `${range(r.fromDate, r.toDate)}${portion}`, days: dayCount(days), note: r.reason ?? "" },
        deciderId: r.approvedBy ?? r.cancelledBy, lastActionAt: r.approvedAt ?? r.cancelledAt, decisionNote: r.rejectReason,
      };
    });
  } else if (key === "compoff") {
    const rows = await prisma.compOffRequest.findMany({ where, orderBy: order, take });
    raw = rows.map((r) => ({
      id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
      summary: `Comp off credit · ${dayCount(Number(r.days))} · worked ${range(r.fromDate, r.toDate)}`,
      cells: { dates: range(r.fromDate, r.toDate), days: dayCount(Number(r.days)), note: r.note ?? "" },
      deciderId: r.decidedBy, lastActionAt: r.decidedAt, decisionNote: r.decisionNote,
    }));
  } else if (key === "encashment") {
    const rows = await prisma.leaveEncashmentRequest.findMany({ where, include: { leaveType: { select: { name: true } } }, orderBy: order, take });
    raw = rows.map((r) => ({
      id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
      summary: `${r.leaveType.name} encashment · ${dayCount(Number(r.days))}`,
      cells: { type: r.leaveType.name, days: plural(Number(r.days)), amount: r.amount === null ? "—" : formatINR(Number(r.amount)), note: r.note ?? "" },
      deciderId: r.decidedBy, lastActionAt: r.decidedAt, decisionNote: r.decisionNote,
    }));
  } else if (key === "wfh-od" || key === "regularization" || key === "remote") {
    const rows = await prisma.attendanceRequest.findMany({ where: { ...where, type: { in: ATTENDANCE_TYPES[key] as never } }, orderBy: order, take });
    const logs = key === "remote" && rows.length
      ? await prisma.attendanceLog.findMany({ where: { tenantId: viewer.tenantId, attendanceRequestId: { in: rows.map((r) => r.id) } }, orderBy: { timestamp: "asc" } })
      : [];
    raw = rows.map((r) => {
      const label = ATTENDANCE_TYPE_LABEL[r.type] ?? r.type;
      const n = spanDays(r.fromDate, r.toDate);
      const cells: Record<string, string> = { dates: range(r.fromDate, r.toDate), type: label, note: r.reason };
      let summary = `${label} · ${range(r.fromDate, r.toDate)}`;
      let mapUrl: string | null = null;
      if (key === "wfh-od") {
        const dur = r.isHourly && r.proposedIn && r.proposedOut
          ? `${clock(r.proposedIn)} – ${clock(r.proposedOut)}`
          : r.portion && r.portion !== "FULL_DAY" ? `0.5 day · ${PORTION_LABEL[r.portion]}` : dayCount(n);
        cells.portion = dur;
        summary += ` · ${dur}`;
      } else if (key === "regularization") {
        const listed = Array.isArray(r.proposedLogs) ? (r.proposedLogs as Array<{ at: string; direction: number }>) : null;
        cells.detail = r.type === "PARTIAL_DAY" ? `${r.partialMinutes ?? 0} min away`
          : listed?.length ? listed.map((l) => `${l.direction === 1 ? "OUT" : "IN"} ${clock(new Date(l.at))}`).join(" · ")
          : r.proposedIn && r.proposedOut ? `IN ${clock(r.proposedIn)} · OUT ${clock(r.proposedOut)}`
          : "Waive the penalty";
      } else {
        const mine = logs.filter((l) => l.attendanceRequestId === r.id);
        cells.entries = mine.map((l) => `${l.direction === 1 ? "OUT" : "IN"} ${clock(l.timestamp)}`).join(" · ") || "—";
        const located = mine.find((l) => l.latitude !== null && l.longitude !== null);
        cells.location = located ? `${Number(located.latitude).toFixed(4)}, ${Number(located.longitude).toFixed(4)}` : "Not shared";
        mapUrl = located ? `https://www.openstreetmap.org/?mlat=${Number(located.latitude)}&mlon=${Number(located.longitude)}#map=17/${Number(located.latitude)}/${Number(located.longitude)}` : null;
        summary = `Remote clock-in on ${formatDate(r.fromDate)} · ${mine.length} time entr${mine.length === 1 ? "y" : "ies"}`;
      }
      return {
        id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
        summary, cells, mapUrl, deciderId: r.decidedBy, lastActionAt: r.decidedAt, decisionNote: r.decisionNote,
      };
    });
  } else if (key === "overtime") {
    const rows = await prisma.overtimeRequest.findMany({ where, orderBy: order, take });
    raw = rows.map((r) => ({
      id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
      summary: `Overtime · ${formatHhmm(r.requestedMinutes)} hrs · ${range(r.fromDate, r.toDate)}`,
      cells: { dates: range(r.fromDate, r.toDate), total: `${formatHhmm(r.requestedMinutes)} hrs`, logged: `${formatHhmm(r.loggedMinutes)} hrs`, note: r.note ?? "" },
      deciderId: r.decidedBy, lastActionAt: r.decidedAt, decisionNote: r.decisionNote,
    }));
  } else if (key === "shift") {
    const rows = await prisma.shiftRequest.findMany({ where, include: { shift: true }, orderBy: order, take });
    raw = rows.map((r) => {
      const label = r.kind === "SHIFT_CHANGE" ? "Shift change" : "Weekly off";
      const shift = r.shift ? `${r.shift.name} (${r.shift.startTime} – ${r.shift.endTime})` : "—";
      return {
        id: r.id, cat: key, entity: cat.entity, employeeId: r.employeeId, status: r.status, requestedOn: r.createdAt,
        summary: `${label} · ${range(r.fromDate, r.toDate)}${r.shift ? ` · ${r.shift.name}` : ""}`,
        cells: { type: label, dates: `${range(r.fromDate, r.toDate)} · ${dayCount(spanDays(r.fromDate, r.toDate))}`, shift: r.kind === "SHIFT_CHANGE" ? shift : "—", note: r.reason },
        deciderId: r.decidedBy, lastActionAt: r.decidedAt, decisionNote: r.decisionNote,
      };
    });
  }

  if (raw.length === 0) return [];
  const people = await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, id: { in: [...new Set([...raw.map((r) => r.employeeId), ...raw.map((r) => r.deciderId).filter((x): x is string => !!x)])] } },
    select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, photoUrl: true, reportingManagerId: true, department: { select: { name: true } } },
  });
  const managerIds = [...new Set(people.map((p) => p.reportingManagerId).filter((x): x is string => !!x))];
  const managers = managerIds.length
    ? await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: managerIds } }, select: { id: true, displayName: true, firstName: true, lastName: true } })
    : [];
  const name = (e: { displayName: string | null; firstName: string; lastName: string }) => e.displayName ?? `${e.firstName} ${e.lastName}`;
  const byId = new Map(people.map((p) => [p.id, p]));
  const mgrName = new Map(managers.map((m) => [m.id, name(m)]));
  const mayDecide = can(viewer, cat.permission);

  return raw.flatMap((r) => {
    const p = byId.get(r.employeeId);
    if (!p) return [];
    const decider = r.deciderId ? byId.get(r.deciderId) : null;
    const { employeeId: _e, deciderId: _d, ...rest } = r;
    return [{
      ...rest,
      employee: { id: p.id, name: name(p), number: p.employeeNumber, department: p.department?.name ?? null, photoUrl: p.photoUrl },
      lastActionBy: decider ? name(decider) : r.deciderId ? "—" : null,
      nextApprover: r.status === "PENDING" ? (p.reportingManagerId ? mgrName.get(p.reportingManagerId) ?? "Reporting manager" : "HR") : null,
      canDecide: mayDecide && r.status === "PENDING",
    }];
  });
}

/** Pending count for one category, cheaply. */
export async function countApprovals(viewer: Viewer, key: TimeCat, scope: ApprovalScope): Promise<number> {
  const cat = categoryOf(key);
  if (!cat) return 0;
  const emp = await employeeFilter(viewer, cat, { scope });
  if (!emp) return 0;
  const where = { tenantId: viewer.tenantId, status: "PENDING" as const, employeeId: { ...(emp.in ? { in: emp.in } : {}), not: emp.not } };
  switch (key) {
    case "leave": return prisma.leaveRequest.count({ where });
    case "compoff": return prisma.compOffRequest.count({ where });
    case "encashment": return prisma.leaveEncashmentRequest.count({ where });
    case "overtime": return prisma.overtimeRequest.count({ where });
    case "shift": return prisma.shiftRequest.count({ where });
    default: return prisma.attendanceRequest.count({ where: { ...where, type: { in: ATTENDANCE_TYPES[key] as never } } });
  }
}

/** Pending counts for every category, keyed by category. */
export async function approvalCounts(viewer: Viewer, scope: ApprovalScope): Promise<Record<TimeCat, number>> {
  const counts = await Promise.all(TIME_CATEGORIES.map((c) => countApprovals(viewer, c.key, scope)));
  return Object.fromEntries(TIME_CATEGORIES.map((c, i) => [c.key, counts[i]])) as Record<TimeCat, number>;
}

/**
 * Nav badges: pending leave-side and attendance-side requests the viewer can
 * decide, across their whole approval scope.
 */
export async function timeNavCounts(viewer: Viewer): Promise<{ leave: number; attendance: number; time: number }> {
  if (!can(viewer, P.LEAVE_APPROVE) && !can(viewer, P.ATTENDANCE_APPROVE)) return { leave: 0, attendance: 0, time: 0 };
  const c = await approvalCounts(viewer, "admin");
  const leave = c.leave + c.compoff + c.encashment;
  const attendance = c["wfh-od"] + c.regularization + c.remote + c.overtime + c.shift;
  return { leave, attendance, time: leave + attendance };
}
