import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { safeCsv, REQUEST_KINDS, fiscalYearOf, fiscalYearLabel, fiscalMonthLabel, compareCosts, headcountCalendar } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { orgNames, costOf, headcountVsPlan, budgetActuals, capacitySupply, requestsOf, csvResponse } from "@/lib/workforce";

const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");

/** CSV exports of workforce planning: plans, one plan, the plan export package, scenarios, budgets, capacity, approvals. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.WORKFORCE_PLAN_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const t = viewer.tenantId;
  const fy = Number(sp.fy) || fiscalYearOf(new Date());
  const names = await orgNames(t);
  const dept = (id: string | null) => (id ? names.dept.get(id) ?? "" : "Organisation");
  switch (sp.report) {
    case "plans": {
      const plans = await prisma.workforcePlan.findMany({ where: { tenantId: t, fiscalYear: fy }, include: { lines: true }, orderBy: { createdAt: "asc" } });
      return csvResponse(viewer, `workforce-plans-${fy}`, safeCsv(["Plan", "Fiscal year", "Scope", "Status", "In force", "Scenario", "Headcount", "Hires", "Salary cost", "Benefits", "Overtime", "Contractors", "Total cost", "Expected attrition"],
        plans.map((p) => { const c = costOf(p); return [p.name, fiscalYearLabel(p.fiscalYear), dept(p.departmentId), p.status, p.isActive ? "Yes" : "No", p.isScenario ? "Yes" : "No", c.headcount, c.hires, c.salary, c.benefits, c.overtime, c.contractor, c.total, c.expectedAttrition]; })), plans.length, "WorkforcePlan");
    }
    case "plan":
    case "package": {
      // One plan, or every plan of the year: lines, live headcount and the month calendar in one file.
      const plans = await prisma.workforcePlan.findMany({ where: sp.report === "plan" ? { tenantId: t, id: sp.id ?? "" } : { tenantId: t, fiscalYear: fy }, include: { lines: true } });
      if (sp.report === "plan" && plans.length === 0) return new NextResponse("Plan not found.", { status: 404 });
      const rows: unknown[][] = [];
      for (const p of plans) {
        const c = costOf(p);
        rows.push([p.name, "Summary", dept(p.departmentId), "", "", c.headcount, c.hires, c.total, p.status]);
        for (const l of p.lines) rows.push([p.name, "Line", names.dept.get(l.departmentId) ?? "", names.loc.get(l.locationId ?? "") ?? "", names.job.get(l.jobId ?? "") ?? "", l.plannedHeadcount, l.newHires + l.replacementHires, Number(l.avgAnnualSalary), fiscalMonthLabel(p.fiscalYear, l.hireMonth)]);
        const hc = await headcountVsPlan(t, p);
        for (const h of hc) rows.push([p.name, "Live headcount", names.dept.get(h.departmentId) ?? "", `active ${h.active}`, `pre-joining ${h.preJoining}, exiting ${h.exiting}, open reqs ${h.openRequisitions}`, h.planned, h.projected, h.gap, h.status]);
        headcountCalendar(hc.reduce((s, h) => s + h.active + h.preJoining, 0), p.lines).forEach((v, i) => rows.push([p.name, "Calendar", fiscalMonthLabel(p.fiscalYear, i + 1), "", "", v, "", "", ""]));
      }
      return csvResponse(viewer, sp.report === "plan" ? `workforce-plan-${plans[0].name.replace(/\W+/g, "-").toLowerCase()}` : `workforce-plan-package-${fy}`,
        safeCsv(["Plan", "Row", "Department / month", "Location / detail", "Job / detail", "Headcount", "Hires / projected", "Cost / gap", "Status / month"], rows), rows.length, "WorkforcePlan");
    }
    case "scenarios": {
      const base = await prisma.workforcePlan.findFirst({ where: { tenantId: t, id: sp.base ?? "" }, include: { lines: true, scenarios: { include: { lines: true } } } });
      if (!base) return new NextResponse("Plan not found.", { status: 404 });
      const bc = costOf(base);
      return csvResponse(viewer, "scenario-comparison", safeCsv(["Plan", "Headcount", "Hires", "Increase %", "Attrition %", "Total cost", "Cost delta", "Cost delta %", "Headcount delta"],
        [[`${base.name} (base)`, bc.headcount, bc.hires, Number(base.salaryIncreasePct), Number(base.attritionPct), bc.total, 0, 0, 0],
          ...base.scenarios.map((s) => { const c = costOf(s); const x = compareCosts(bc, c); return [s.name, c.headcount, c.hires, Number(s.salaryIncreasePct), Number(s.attritionPct), c.total, x.costDelta, x.costDeltaPct, x.headcountDelta]; })]), base.scenarios.length + 1, "WorkforcePlan");
    }
    case "budgets": {
      const budgets = await prisma.workforceBudget.findMany({ where: { tenantId: t, fiscalYear: fy }, orderBy: [{ name: "asc" }, { version: "asc" }] });
      const rows = await Promise.all(budgets.map(async (b) => { const a = await budgetActuals(t, b); return [b.name, b.version, b.isCurrent ? "Yes" : "No", b.status, dept(b.departmentId), Number(b.salaryBudget), a.actual.salary, Number(b.benefitsBudget), a.actual.employer, Number(b.contractorBudget), a.contractor, Number(b.hiringBudget), a.budgetTotal, a.actual.total + a.contractor, a.total.variance, a.total.utilisationPct]; }));
      return csvResponse(viewer, `workforce-budgets-${fy}`, safeCsv(["Budget", "Version", "Current", "Status", "Scope", "Salary budget", "Salary actual", "Benefits budget", "Benefits actual", "Contractor budget", "Contractor actual", "Hiring budget", "Total budget", "Total actual", "Variance", "Used %"], rows), rows.length, "WorkforceBudget");
    }
    case "capacity": {
      const plans = await prisma.capacityPlan.findMany({ where: { tenantId: t }, include: { lines: true } });
      const rows: unknown[][] = [];
      for (const p of plans) for (const r of await capacitySupply(t, p)) rows.push([p.name, p.status, d(p.periodStart), d(p.periodEnd), r.role, dept(r.departmentId), r.demand, r.supply, r.gap.gap, r.gap.coveragePct, r.gap.status]);
      return csvResponse(viewer, "capacity-plans", safeCsv(["Plan", "Status", "From", "To", "Role", "Department", "Demand FTE", "Supply FTE", "Gap", "Coverage %", "Status"], rows), rows.length, "CapacityPlan");
    }
    case "approvals": {
      const rows = await requestsOf(t, "planning");
      return csvResponse(viewer, "planning-approvals", safeCsv(["Requested", "Request", "Record", "Status", "Requested by", "Decided by", "Decided", "Note"],
        rows.map((r) => [d(r.requestedAt), REQUEST_KINDS[r.kind]?.label ?? r.kind, r.label, r.status, names.user.get(r.requestedBy) ?? "", names.user.get(r.decidedBy ?? "") ?? "", d(r.decidedAt), r.decisionNote ?? ""])), rows.length, "WorkforceRequest");
    }
    default:
      return new NextResponse("Unknown report.", { status: 400 });
  }
}
