import { NextResponse, type NextRequest } from "next/server";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { OPS_ANOMALY_KINDS, reconciliationDashboard, punchSourceAudit, timeLeakageReport, teamHeatmap } from "@keka/services";
import { getViewer, can, canAny } from "@/lib/context";
import { opsCsv, d10, dayParam, monthParam } from "@/lib/ops-export";

/** CSV downloads for Time insights, scoped like the page (direct reports unless an attendance administrator). */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(v, [P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE, P.ATTENDANCE_VIEW])) return new NextResponse("Forbidden.", { status: 403 });
  const all = can(v, P.ATTENDANCE_MANAGE);
  if (!all && !v.employee) return new NextResponse("Forbidden.", { status: 403 });
  const scope: Prisma.EmployeeWhereInput = all ? {} : { reportingManagerId: v.employee!.id };
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  const now = new Date();
  const from = dayParam(sp.get("from"), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const to = dayParam(sp.get("to"), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const [y, m] = monthParam(sp.get("month"));
  const ids = (await prisma.employee.findMany({ where: { ...scope, tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true } })).map((e) => e.id);
  const names = async (list: string[]) => new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: list } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
  switch (sp.get("tab") ?? "anomalies") {
    case "reconciliation": {
      const r = await reconciliationDashboard(t, y, m, scope);
      return opsCsv(v, "ATTENDANCE", "AttendanceRecord", `attendance-reconciliation-${y}-${m}`, ["Employee no.", "Employee", "Department", "Days", "Present", "Leave", "Absent", "LOP", "Payable", "Open exceptions", "Pending requests", "Missing days", "Ready"],
        r.rows.map((x) => [x.employeeNumber, x.employee, x.department, x.days, x.present, x.leave, x.absent, x.lop, x.payable, x.unresolved, x.regularisationsPending, x.missingDays, x.balanced ? "Yes" : "No"]));
    }
    case "devices": {
      if (!all) return new NextResponse("Forbidden.", { status: 403 });
      const rows = await prisma.opsDeviceStatus.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } });
      return opsCsv(v, "ATTENDANCE", "OpsDeviceStatus", "device-health", ["Device", "Status", "Last punch", "Punches (24h)", "Since", "Checked"], rows.map((d) => [d.name, d.status, d.lastPunchAt?.toISOString() ?? "", d.punches24h, d.since.toISOString(), d.checkedAt.toISOString()]));
    }
    case "sources": {
      const r = await punchSourceAudit(t, from, to, { source: sp.get("source") || null });
      const mine = new Set(ids);
      const rows = r.rows.filter((x) => all || mine.has(x.employeeId));
      return opsCsv(v, "ATTENDANCE", "AttendanceLog", "punch-source-audit", ["When", "Employee no.", "Employee", "Source", "Device", "Direction", "Status"], rows.map((x) => [x.timestamp.toISOString(), x.employeeNumber, x.employee, x.source, x.device ?? "", x.direction, x.status]));
    }
    case "heatmap": {
      const scoped = sp.get("dept") && all ? (await prisma.employee.findMany({ where: { tenantId: t, departmentId: sp.get("dept")!, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true } })).map((e) => e.id) : ids;
      const h = await teamHeatmap(t, scoped, y, m);
      return opsCsv(v, "ATTENDANCE", "AttendanceRecord", `attendance-heatmap-${y}-${m}`, ["Date", "Expected", "Present", "On leave", "Absent", "Level"], h.days.map((d) => [d.date, d.expected, d.present, d.leave, d.absent, d.level]));
    }
    case "leakage": {
      const rows = await timeLeakageReport(t, from, to, ids);
      return opsCsv(v, "ATTENDANCE", "TimeEntry", "tracked-vs-scheduled", ["Employee no.", "Employee", "Scheduled", "Attended", "Attendance %", "Logged", "Idle", "Leakage h", "Leakage %", "Unexplained"], rows.map((r) => [r.employeeNumber, r.employee, r.scheduled, r.attended, r.attendancePct ?? "", r.logged, r.idle, r.leakageHours, r.leakagePct ?? "", r.unexplained]));
    }
    case "idle": {
      const rows = await prisma.opsIdleLog.findMany({ where: { tenantId: t, employeeId: { in: ids }, date: { gte: from, lte: to } }, orderBy: { date: "desc" } });
      const n = await names(rows.map((r) => r.employeeId));
      return opsCsv(v, "ATTENDANCE", "OpsIdleLog", "idle-time", ["Day", "Employee no.", "Employee", "Minutes", "Category", "Source", "Note"], rows.map((r) => [d10(r.date), n.get(r.employeeId)?.employeeNumber ?? "", n.get(r.employeeId)?.displayName ?? "", r.minutes, r.category, r.source, r.note ?? ""]));
    }
    case "cutoff": {
      const rows = await prisma.opsAlertLog.findMany({ where: { tenantId: t, kind: { in: ["ATTENDANCE_CUTOFF", "ATTENDANCE_CUTOFF_MANAGER", "PAYROLL_INPUT_CUTOFF"] } }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "ATTENDANCE", "OpsAlertLog", "cutoff-reminders", ["When", "Kind", "Reminder", "People"], rows.map((a) => [a.createdAt.toISOString(), a.kind, a.title, a.userIds.length]));
    }
    default: {
      const rows = await prisma.opsAttendanceAnomaly.findMany({ where: { tenantId: t, employeeId: { in: ids }, date: { gte: from, lte: to } }, orderBy: { date: "desc" } });
      const n = await names(rows.map((r) => r.employeeId));
      return opsCsv(v, "ATTENDANCE", "OpsAttendanceAnomaly", "attendance-exceptions", ["Day", "Employee no.", "Employee", "Exception", "Severity", "Detail", "Status", "Resolution"], rows.map((r) => [d10(r.date), n.get(r.employeeId)?.employeeNumber ?? "", n.get(r.employeeId)?.displayName ?? "", OPS_ANOMALY_KINDS[r.kind] ?? r.kind, r.severity, r.detail, r.status, r.resolution ?? ""]));
    }
  }
}
