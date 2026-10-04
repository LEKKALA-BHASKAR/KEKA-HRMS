import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { safeCsv, joinAudit, rosterGrid, patternSteps, otTierTable, otTiersText, calendarResolution, OT_DAY_TYPES } from "@keka/services";
import { getViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";

/**
 * CSV reports for shifts and rosters, holiday calendars and overtime. Every
 * query is bound to the viewer's tenant (and to their employee scope for
 * people data); every download is written to the audit log.
 */

type Sheet = { name: string; head: string[]; rows: Array<Array<string | number | null>> };
type Q = URLSearchParams;
const P = PERMISSIONS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "");
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const hrs = (m: number | null | undefined) => (m === null || m === undefined ? "" : Math.round((m / 60) * 100) / 100);

async function scoped(viewer: Viewer, perm: Permission, extra: Record<string, unknown> = {}) {
  const rows = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, perm), extra] }, select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } }, location: { select: { name: true } } }, orderBy: { employeeNumber: "asc" } });
  const m = new Map(rows.map((r) => [r.id, r]));
  return { ids: rows.map((r) => r.id), rows, name: (id: string | null | undefined) => (id ? m.get(id)?.displayName ?? "" : ""), number: (id: string | null | undefined) => (id ? m.get(id)?.employeeNumber ?? "" : ""), dept: (id: string | null | undefined) => (id ? m.get(id)?.department?.name ?? "" : "") };
}
async function shiftNames(tenantId: string) {
  const rows = await prisma.shift.findMany({ where: { tenantId }, select: { id: true, code: true, name: true } });
  const m = new Map(rows.map((s) => [s.id, s]));
  return (id: string | null | undefined) => (id ? m.get(id)?.code ?? "" : "");
}
const auditSheet = async (v: Viewer, name: string, types: string[]): Promise<Sheet> => {
  const rows = await prisma.auditLog.findMany({ where: { tenantId: v.tenantId, entityType: { in: types } }, orderBy: { createdAt: "desc" }, take: 5000 });
  return { name, head: ["When", "By", "Action", "Record", "Record id", "Change"], rows: rows.map((r) => [iso(r.createdAt), r.actorLabel ?? "", r.action, r.entityType, r.entityId ?? "", r.summary ?? ""]) };
};

const REPORTS: Record<string, { perm: Permission; build: (v: Viewer, q: Q) => Promise<Sheet> }> = {
  // ---- Shifts & roster ----
  roster: { perm: P.SHIFT_MANAGE, build: async (v, q) => {
    const locationId = q.get("locationId");
    const s = await scoped(v, P.SHIFT_MANAGE, { status: { notIn: ["EXITED", "INACTIVE"] }, ...(locationId ? { locationId } : {}) });
    const f = q.get("from") ?? "";
    const from = /^\d{4}-\d{2}-\d{2}$/.test(f) ? new Date(`${f}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const grid = await rosterGrid(s.ids, from, 14);
    const code = await shiftNames(v.tenantId);
    const dates = [...Array(14)].map((_, i) => day(new Date(from.getTime() + i * 86_400_000)));
    return { name: "roster", head: ["Employee #", "Employee", "Department", ...dates],
      rows: s.ids.map((id) => [s.number(id), s.name(id), s.dept(id), ...(grid.get(id) ?? []).map((c) => (c.off ? "OFF" : code(c.shiftId) || "—") + (c.explicit ? "" : "*"))]) };
  } },
  shifts: { perm: P.SHIFT_MANAGE, build: async (v) => {
    const rows = await prisma.shift.findMany({ where: { tenantId: v.tenantId }, orderBy: { code: "asc" } });
    return { name: "shifts", head: ["Code", "Name", "Start", "End", "Break (min)", "Crosses midnight", "Split segments", "Allowance / day", "Active"],
      rows: rows.map((s) => [s.code, s.name, s.startTime, s.endTime, s.breakMinutes, s.crossesMidnight ? "Yes" : "No", Array.isArray(s.segments) ? (s.segments as Array<{ start: string; end: string }>).map((x) => `${x.start}-${x.end}`).join(" ") : "", s.allowancePerDay ? Number(s.allowancePerDay) : "", s.isActive ? "Yes" : "No"]) };
  } },
  swaps: { perm: P.SHIFT_MANAGE, build: async (v) => {
    const s = await scoped(v, P.SHIFT_MANAGE);
    const code = await shiftNames(v.tenantId);
    const rows = await prisma.shiftSwapRequest.findMany({ where: { tenantId: v.tenantId, requesterId: { in: s.ids } }, orderBy: { createdAt: "desc" } });
    return { name: "shift-swaps", head: ["Raised", "Requester", "Date", "Shift", "With", "Their date", "Their shift", "Marketplace", "Reason", "Status", "Decided"],
      rows: rows.map((r) => [iso(r.createdAt), s.name(r.requesterId), day(r.requesterDate), code(r.requesterShiftId), s.name(r.counterpartId), day(r.counterpartDate), code(r.counterpartShiftId), r.isMarketplace ? "Yes" : "No", r.reason ?? "", r.status, iso(r.decidedAt)]) };
  } },
  "shift-requests": { perm: P.SHIFT_MANAGE, build: async (v) => {
    const s = await scoped(v, P.SHIFT_MANAGE);
    const code = await shiftNames(v.tenantId);
    const rows = await prisma.shiftRequest.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: { createdAt: "desc" } });
    return { name: "shift-requests", head: ["Raised", "Employee #", "Employee", "Type", "From", "To", "Shift", "Reason", "Status", "Decided", "Note"],
      rows: rows.map((r) => [iso(r.createdAt), s.number(r.employeeId), s.name(r.employeeId), r.kind, day(r.fromDate), day(r.toDate), code(r.shiftId), r.reason, r.status, iso(r.decidedAt), r.decisionNote ?? ""]) };
  } },
  cycles: { perm: P.SHIFT_MANAGE, build: async (v) => {
    const code = await shiftNames(v.tenantId);
    const rows = await prisma.rosterPattern.findMany({ where: { tenantId: v.tenantId }, orderBy: { name: "asc" } });
    return { name: "shift-cycles", head: ["Cycle", "Days", "Steps", "Active"], rows: rows.map((r) => { const st = patternSteps(r.steps); return [r.name, st.length, st.map((x) => (x.off ? "OFF" : code(x.shiftId))).join(" "), r.isActive ? "Yes" : "No"]; }) };
  } },
  workweeks: { perm: P.SHIFT_MANAGE, build: async (v) => {
    const rows = await prisma.weeklyOffPolicy.findMany({ where: { tenantId: v.tenantId }, orderBy: [{ name: "asc" }, { version: "desc" }] });
    return { name: "workweeks", head: ["Workweek", "Version", "Default", "Active", "Rules"], rows: rows.map((r) => [r.name, r.version, r.isDefault ? "Yes" : "No", r.isActive ? "Yes" : "No", JSON.stringify(r.config)]) };
  } },
  "time-changes": { perm: P.SHIFT_MANAGE, build: async (v) => {
    const rows = await prisma.timeConfigChange.findMany({ where: { tenantId: v.tenantId }, orderBy: { createdAt: "desc" } });
    return { name: "time-config-changes", head: ["Raised", "Type", "Change", "Status", "Applied"], rows: rows.map((r) => [iso(r.createdAt), r.kind, r.summary, r.status, iso(r.appliedAt)]) };
  } },
  "roster-audit": { perm: P.SHIFT_MANAGE, build: (v) => auditSheet(v, "roster-change-log", ["ShiftAssignment", "Roster", "Shift", "ShiftSwapRequest", "OpenShift", "OpenShiftBid", "StaffingRule", "RosterPublication", "RosterPattern", "WeeklyOffPolicy", "ShiftPreference", "TimeConfigChange"]) },
  // ---- Holidays & calendars ----
  holidays: { perm: P.HOLIDAY_MANAGE, build: async (v, q) => {
    const calendarId = q.get("calendarId");
    const rows = await prisma.holiday.findMany({ where: { calendar: { tenantId: v.tenantId, ...(calendarId ? { id: calendarId } : {}) } }, include: { calendar: { select: { name: true, year: true, country: true, state: true } } }, orderBy: [{ calendarId: "asc" }, { date: "asc" }] });
    return { name: "holidays", head: ["Calendar", "Year", "Country", "State", "Date", "Holiday", "Optional", "Day type", "Description"],
      rows: rows.map((h) => [h.calendar.name, h.calendar.year, h.calendar.country ?? "", h.calendar.state ?? "", day(h.date), h.name, h.isOptional ? "Yes" : "No", h.dayType ?? "", h.description ?? ""]) };
  } },
  calendars: { perm: P.HOLIDAY_MANAGE, build: async (v) => {
    const [cals, locs] = await Promise.all([
      prisma.holidayCalendar.findMany({ where: { tenantId: v.tenantId }, include: { _count: { select: { holidays: true } } }, orderBy: [{ year: "desc" }, { name: "asc" }] }),
      prisma.location.findMany({ where: { tenantId: v.tenantId }, select: { id: true, name: true } }),
    ]);
    const ln = new Map(locs.map((l) => [l.id, l.name]));
    return { name: "holiday-calendars", head: ["Calendar", "Year", "Country", "State", "Locations", "Default", "Holidays", "Optional quota"],
      rows: cals.map((c) => [c.name, c.year, c.country ?? "", c.state ?? "", (Array.isArray(c.locationIds) ? (c.locationIds as string[]) : []).map((x) => ln.get(x) ?? x).join("; "), c.isDefault ? "Yes" : "No", c._count.holidays, c.optionalHolidayQuota]) };
  } },
  "holiday-rules": { perm: P.HOLIDAY_MANAGE, build: async (v) => {
    const rows = await prisma.holidayRule.findMany({ where: { tenantId: v.tenantId }, orderBy: { createdAt: "desc" } });
    return { name: "holiday-rules", head: ["Rule", "Type", "Calendar id", "Settings", "Status", "Created"], rows: rows.map((r) => [r.name, r.kind, r.calendarId ?? "all", JSON.stringify(r.config), r.status, iso(r.createdAt)]) };
  } },
  "calendar-assignments": { perm: P.HOLIDAY_MANAGE, build: async (v) => {
    const s = await scoped(v, P.HOLIDAY_MANAGE);
    const ids = new Set(s.ids);
    const rows = (await calendarResolution(v.tenantId)).filter((r) => ids.has(r.employeeId));
    return { name: "calendar-assignments", head: ["Employee #", "Employee", "Location", "Resolved by", "Calendars"], rows: rows.map((r) => [r.number, r.name, r.location, r.how, r.calendars.join("; ")]) };
  } },
  "calendar-history": { perm: P.HOLIDAY_MANAGE, build: (v) => auditSheet(v, "calendar-change-history", ["Holiday", "HolidayCalendar", "HolidayCalendarRevision", "HolidayRule", "HolidayDayType", "ShutdownPeriod", "CalendarException", "OptionalHolidayQuota"]) },
  // ---- Overtime ----
  "overtime-rules": { perm: P.ATTENDANCE_MANAGE, build: async (v) => {
    const rows = await prisma.overtimeRule.findMany({ where: { tenantId: v.tenantId }, orderBy: [{ status: "asc" }, { priority: "desc" }] });
    return { name: "overtime-rules", head: ["Rule", "Priority", "Status", ...OT_DAY_TYPES.map((d) => `${d} rates`), "Weekly after (h)", "Daily cap (h)", "Weekly cap (h)", "Monthly cap (h)", "Alert above (h)", "Ignore under (min)", "Pre-approval", "Claim window (days)", "Bands", "Grades", "Shifts", "Locations"],
      rows: rows.map((r) => { const t = otTierTable(r.tiers); return [r.name, r.priority, r.status, ...OT_DAY_TYPES.map((d) => otTiersText(t[d])), hrs(r.weeklyThresholdMinutes), hrs(r.dailyCapMinutes), hrs(r.weeklyCapMinutes), hrs(r.monthlyCapMinutes), hrs(r.alertMonthlyMinutes), r.minMinutes, r.requirePreApproval ? "Yes" : "No", r.postFactoDays ?? "", r.bandIds.length, r.payGradeIds.length, r.shiftIds.length, r.locationIds.length]; }) };
  } },
  "overtime-requests": { perm: P.ATTENDANCE_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ATTENDANCE_MANAGE);
    const rows = await prisma.overtimeRequest.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: { createdAt: "desc" } });
    return { name: "overtime-requests", head: ["Raised", "Employee #", "Employee", "From", "To", "Requested (h)", "Logged (h)", "Status", "Decided", "Note"],
      rows: rows.map((r) => [iso(r.createdAt), s.number(r.employeeId), s.name(r.employeeId), day(r.fromDate), day(r.toDate), hrs(r.requestedMinutes), hrs(r.loggedMinutes), r.status, iso(r.decidedAt), r.note ?? ""]) };
  } },
  "overtime-history": { perm: P.ATTENDANCE_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ATTENDANCE_MANAGE);
    const rows = await prisma.overtimeEntry.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    return { name: "overtime-history", head: ["Month", "Employee #", "Employee", "Department", "Hours", "Rate", "Amount", "Action", "Processed"],
      rows: rows.map((r) => [`${r.year}-${String(r.month).padStart(2, "0")}`, s.number(r.employeeId), s.name(r.employeeId), s.dept(r.employeeId), Number(r.hours), Number(r.rate), Number(r.amount), r.payAction, r.isProcessed ? "Yes" : "No"]) };
  } },
  "overtime-alerts": { perm: P.ATTENDANCE_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ATTENDANCE_MANAGE);
    const rows = await prisma.overtimeAlert.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: { createdAt: "desc" } });
    return { name: "overtime-alerts", head: ["Raised", "Employee", "Type", "Period", "Detail", "Status", "Acknowledged"], rows: rows.map((a) => [iso(a.createdAt), s.name(a.employeeId), a.kind, a.periodKey, a.detail, a.status, iso(a.acknowledgedAt)]) };
  } },
};

export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const key = req.nextUrl.searchParams.get("kind") ?? "";
  const report = REPORTS[key];
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  if (!can(viewer, report.perm)) return new NextResponse("Forbidden.", { status: 403 });
  const sheet = await report.build(viewer, req.nextUrl.searchParams);
  await joinAudit(viewer.tenantId, viewer.user.id, { module: "ATTENDANCE", action: "EXPORT", entityType: "Report", entityId: key, summary: `Exported ${sheet.rows.length} row(s) of ${sheet.name}` });
  const csv = safeCsv(sheet.head, sheet.rows.map((r) => r.map((c) => (c === null ? "" : c))));
  return new NextResponse("﻿" + csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${sheet.name}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
