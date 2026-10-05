import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  budgetVsActual, clientAllocation, utilisationBySkill, utilisationTargets, profitabilityFeed, approvalDecisionsReport, taskReport, timesheetAuditTrail, exportProfileRows,
} from "@keka/services";
import { getViewer, canAny } from "@/lib/context";
import { opsCsv, d10, dayParam } from "@/lib/ops-export";

/** CSV downloads for Project time controls: the reports, the audit trail, and saved export profiles. */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(v, [P.PROJECT_MANAGE, P.TIMESHEET_APPROVE])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  const now = new Date();
  const from = dayParam(sp.get("from"), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const to = dayParam(sp.get("to"), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const tab = sp.get("tab") ?? "reports";
  if (tab === "profile") {
    const r = await exportProfileRows(t, sp.get("id") ?? "", from, to);
    if (!r) return new NextResponse("Profile not found.", { status: 404 });
    return opsCsv(v, "PROJECTS", "OpsExportProfile", `time-${r.name.replace(/\W+/g, "-").toLowerCase()}`, r.head, r.rows);
  }
  if (tab === "audit") {
    const rows = await timesheetAuditTrail(t, from, to);
    return opsCsv(v, "PROJECTS", "Timesheet", "timesheet-audit-trail", ["When", "Who", "Action", "Record", "Id", "Summary"], rows.map((r) => [r.createdAt.toISOString(), r.actorLabel ?? "", r.action, r.entityType, r.entityId ?? "", r.summary]));
  }
  if (tab === "codes") {
    const rows = await prisma.opsTimeCode.findMany({ where: { tenantId: t }, orderBy: { code: "asc" } });
    return opsCsv(v, "PROJECTS", "OpsTimeCode", "activity-codes", ["Code", "Label", "Billable", "Needs task", "Needs comment", "Active"], rows.map((c) => [c.code, c.label, c.billable === null ? "As project" : c.billable ? "Yes" : "No", c.requiresTask ? "Yes" : "No", c.requiresComment ? "Yes" : "No", c.isActive ? "Yes" : "No"]));
  }
  switch (sp.get("r") ?? "budget") {
    case "clients": {
      const rows = await clientAllocation(t, from, to);
      return opsCsv(v, "PROJECTS", "TimeEntry", "client-allocation", ["Client", "Hours", "Billable", "Share %", "People"], rows.map((r) => [r.client, r.total, r.billable, r.share, r.people.map((p) => `${p.employee} ${p.hours}`).join("; ")]));
    }
    case "skills": {
      const rows = await utilisationBySkill(t, from, to);
      return opsCsv(v, "PROJECTS", "TimeEntry", "utilisation-by-skill", ["Skill", "People", "Logged", "Billable", "Capacity", "Billable %", "Logged %"], rows.map((r) => [r.skill, r.people, r.logged, r.billable, r.capacity, r.billablePct, r.loggedPct]));
    }
    case "targets": {
      const rows = await utilisationTargets(t, from, to);
      return opsCsv(v, "PROJECTS", "TimeEntry", "utilisation-targets", ["Employee no.", "Employee", "Target %", "Capacity", "Logged", "Billable", "Billable %", "Gap", "On target"], rows.map((r) => [r.employeeNumber, r.employee, r.target ?? "", r.capacity, r.logged, r.billable, r.billablePct, r.gap ?? "", r.onTarget === null ? "" : r.onTarget ? "Yes" : "No"]));
    }
    case "profit": {
      const rows = await profitabilityFeed(t, from, to);
      return opsCsv(v, "PROJECTS", "TimeEntry", "profitability-feed", ["Code", "Project", "Client", "Hours", "Billable hours", "Revenue", "Labour cost", "Overtime cost", "Total cost", "Margin", "Margin %"], rows.map((r) => [r.code ?? "", r.project, r.client, r.hours, r.billableHours, r.revenue, r.labourCost, r.overtimeCost, r.cost, r.margin, r.marginPct ?? ""]));
    }
    case "decisions": {
      const d = await approvalDecisionsReport(t, from, to);
      return opsCsv(v, "PROJECTS", "Timesheet", "timesheet-decisions", ["Week", "Employee no.", "Employee", "Hours", "Decision", "By", "When", "Turnaround h", "Reason"], d.rows.map((r) => [d10(r.week), r.employeeNumber, r.employee, r.hours, r.decision, r.by, r.decidedAt?.toISOString() ?? "", r.turnaroundHours ?? "", r.reason ?? ""]));
    }
    case "tasks": {
      const rows = await taskReport(t);
      return opsCsv(v, "PROJECTS", "Task", "task-report", ["Project", "Task", "Assignee", "Status", "Estimate", "Logged", "Variance", "Sign-off", "Due"], rows.map((r) => [r.project, r.title, r.assignee, r.status, r.estimated ?? "", r.logged, r.variance ?? "", r.signoff ?? "", d10(r.dueDate)]));
    }
    default: {
      const rows = await budgetVsActual(t);
      return opsCsv(v, "PROJECTS", "Project", "budget-vs-actual", ["Code", "Project", "Client", "Status", "Budget h", "Actual h", "Burn %", "Elapsed %", "Variance %", "Alert"], rows.map((r) => [r.code ?? "", r.name, r.client, r.status, r.budget ?? "", r.actual, r.burnPct ?? "", r.elapsedPct ?? "", r.variancePct ?? "", r.alert ? "Yes" : "No"]));
    }
  }
}
