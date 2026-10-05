import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { leaveCalendarFor, leaveLiabilityForecast, OPS_ABSENCE_KINDS } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { opsCsv, d10, monthParam } from "@/lib/ops-export";

/** CSV downloads for Leave controls (leave administrators). */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(v, P.LEAVE_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  switch (sp.get("tab") ?? "blackouts") {
    case "absences": {
      const rows = await prisma.opsAbsenceCase.findMany({ where: { tenantId: t }, orderBy: { startDate: "desc" } });
      const en = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
      return opsCsv(v, "LEAVE", "OpsAbsenceCase", "long-absences", ["Employee no.", "Employee", "Kind", "Reason", "From", "Expected return", "Returned", "Status", "Fit for work", "RTW certified"],
        rows.map((r) => [en.get(r.employeeId)?.employeeNumber ?? "", en.get(r.employeeId)?.displayName ?? "", OPS_ABSENCE_KINDS[r.kind] ?? r.kind, r.reasonCode ?? "", d10(r.startDate), d10(r.expectedReturn), d10(r.actualReturn), r.status, r.fitForWork === null ? "" : r.fitForWork ? "Yes" : "No", d10(r.rtwCertifiedAt)]));
    }
    case "adjustments": {
      const rows = await prisma.opsApprovalRequest.findMany({ where: { tenantId: t, kind: "OPS_LEAVE_ADJUSTMENT" }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "LEAVE", "LeaveBalance", "balance-adjustments", ["Raised", "Request", "Status", "Reason", "Applied", "Error"], rows.map((r) => [d10(r.createdAt), r.targetLabel, r.status, r.reason ?? "", d10(r.appliedAt), r.error ?? ""]));
    }
    case "calendar": {
      const [y, m] = monthParam(sp.get("month"));
      const me = v.employee?.id ?? (await prisma.employee.findFirst({ where: { tenantId: t }, select: { id: true } }))?.id ?? "";
      const cal = await leaveCalendarFor(t, me, y, m, { seeAll: true });
      return opsCsv(v, "LEAVE", "LeaveRequest", `leave-calendar-${y}-${m}`, ["Employee", "Type", "From", "To", "Days", "Status"], cal.entries.map((e) => [e.employee, e.type, d10(e.from), d10(e.to), e.days, e.status]));
    }
    case "liability": {
      const f = await leaveLiabilityForecast(t, 12);
      return opsCsv(v, "LEAVE", "LeaveBalance", "leave-liability", ["Section", "Name", "Value"], [["Total", "Today", f.today], ...f.forecast.map((x) => ["Forecast", x.month, x.value]), ...f.byType.map((x) => ["Leave type", x.leaveType, x.today]), ...f.byDepartment.map((x) => ["Department", x.department, x.value])]);
    }
    case "escalation": {
      const rows = await prisma.opsAlertLog.findMany({ where: { tenantId: t, kind: "LEAVE_ESCALATION" }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "LEAVE", "OpsAlertLog", "leave-escalations", ["When", "What", "People"], rows.map((a) => [a.createdAt.toISOString(), a.title, a.userIds.length]));
    }
    default: {
      const rows = await prisma.opsLeaveBlackout.findMany({ where: { tenantId: t }, orderBy: { startDate: "desc" } });
      return opsCsv(v, "LEAVE", "OpsLeaveBlackout", "leave-blackouts", ["Name", "Kind", "From", "To", "Department", "Location", "Max away", "Max share %", "Leave types", "Active", "Reason"], rows.map((r) => [r.name, r.kind, d10(r.startDate), d10(r.endDate), r.departmentId ?? "", r.locationId ?? "", r.maxConcurrent ?? "", r.maxConcurrentPct ?? "", r.leaveTypeIds.join(" "), r.isActive ? "Yes" : "No", r.reason ?? ""]));
    }
  }
}
