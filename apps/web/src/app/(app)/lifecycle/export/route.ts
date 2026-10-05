import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { MOVEMENT_KINDS, movementReport, statusChangeReport, rehireEligibilityList, fteReport, contractRenewalBoard } from "@keka/services";
import { getViewer, canAny } from "@/lib/context";
import { opsCsv, d10, dayParam } from "@/lib/ops-export";

/** CSV downloads for Lifecycle. */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(v, [P.EMPLOYEE_UPDATE, P.EXIT_MANAGE, P.PROBATION_MANAGE, P.CONTRACT_MANAGE, P.SALARY_REVISE])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  const now = new Date();
  const from = dayParam(sp.get("from"), new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)));
  const to = dayParam(sp.get("to"), now);
  switch (sp.get("tab") ?? "movements") {
    case "assignments": {
      const rows = await prisma.opsAssignment.findMany({ where: { tenantId: t }, orderBy: { startDate: "desc" } });
      const en = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
      return opsCsv(v, "LIFECYCLE", "OpsAssignment", "assignments", ["Employee no.", "Employee", "Kind", "Role", "Host organisation", "From", "To", "Original end", "Extensions", "Host pays %", "Status"],
        rows.map((a) => [en.get(a.employeeId)?.employeeNumber ?? "", en.get(a.employeeId)?.displayName ?? "", a.kind, a.role ?? "", a.hostOrganisation ?? "", d10(a.startDate), d10(a.endDate), d10(a.originalEndDate), a.extensions, a.costSharePct ?? "", a.status]));
    }
    case "status": {
      const r = await statusChangeReport(t, from, to);
      return opsCsv(v, "LIFECYCLE", "OpsStatusChange", "status-changes", ["Effective", "Employee", "From", "To", "Reason code", "Reason", "Note"], r.rows.map((x) => [d10(x.effectiveOn), x.employee, x.fromStatus, x.toStatus, x.reasonCode, x.reasonLabel, x.note ?? ""]));
    }
    case "rehire": {
      const rows = await rehireEligibilityList(t, null);
      return opsCsv(v, "LIFECYCLE", "Employee", "rehire-eligibility", ["Employee no.", "Employee", "Last working day", "Exit type", "Rehire"], rows.map((r) => [r.employeeNumber, r.name, d10(r.lastWorkingDay), r.exitType ?? "", r.eligibility]));
    }
    case "fte": {
      const rows = await fteReport(t);
      return opsCsv(v, "LIFECYCLE", "OpsFteConversion", "fte-changes", ["Employee", "Direction", "From FTE", "To FTE", "From hours", "To hours", "From CTC", "To CTC", "Effective", "Status", "Reason"], rows.map((r) => [r.employee, r.direction, Number(r.fromFte), Number(r.toFte), Number(r.fromWeeklyHours), Number(r.toWeeklyHours), Number(r.fromCtc), Number(r.toCtc), d10(r.effectiveFrom), r.status, r.reason ?? ""]));
    }
    case "confirmation": {
      const rows = await prisma.opsConfirmationRule.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } });
      return opsCsv(v, "LIFECYCLE", "OpsConfirmationRule", "confirmation-rules", ["Rule", "Policy", "Min service days", "Max LOP", "Max late", "No warnings months", "Evaluation", "Min rating", "Active"], rows.map((r) => [r.name, r.probationPolicyId ?? "All", r.minServiceDays, r.maxLopDays === null ? "" : Number(r.maxLopDays), r.maxLateMarks ?? "", r.noWarningsMonths ?? "", r.requireEvaluation ? "Yes" : "No", r.minRating === null ? "" : Number(r.minRating), r.isActive ? "Yes" : "No"]));
    }
    case "contracts": {
      const rows = await contractRenewalBoard(t, 120);
      return opsCsv(v, "LIFECYCLE", "EmployeeContract", "contract-renewals", ["Employee", "Contract", "Ends", "Days left", "Renewed", "Reminders"], rows.map((r) => [r.employee, r.contractNumber ?? "", d10(r.endDate), r.daysLeft, r.renewed ? "Yes" : "No", r.alertsSent.join(" ")]));
    }
    default: {
      const k = (sp.get("kind") ?? "PROMOTION") in MOVEMENT_KINDS ? (sp.get("kind") as keyof typeof MOVEMENT_KINDS) : "PROMOTION";
      const r = await movementReport(t, k, from, to);
      return opsCsv(v, "LIFECYCLE", "EmployeeJobRecord", `movements-${k.toLowerCase()}`, ["Employee", "Effective", "Reason", "From title", "To title", "From department", "To department", "From location", "To location", "Note"], r.rows.map((x) => [x.employee, d10(x.effectiveFrom), x.reason, x.fromTitle, x.toTitle, x.fromDepartment, x.toDepartment, x.fromLocation, x.toLocation, x.note]));
    }
  }
}
