import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { safeCsv, REQUEST_KINDS } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { orgNames, positionRows, vacancyReport, reconciliationReport, requestsOf, csvResponse } from "@/lib/workforce";

const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");
const n = (x: unknown) => (x === null || x === undefined ? "" : Number(x));

/** CSV exports of the positions area: positions, jobs, families, levels, vacancy, headcount, reconciliation, approvals. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.POSITION_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const t = viewer.tenantId;
  const names = await orgNames(t);
  switch (sp.report) {
    case "positions": {
      const rows = await positionRows(t, sp);
      return csvResponse(viewer, "positions", safeCsv(
        ["Control no.", "Title", "Job", "Department", "Location", "Cost centre", "Pay grade", "Status", "Budget status", "Budgeted salary", "FTE", "Headcount", "Criticality", "Work mode", "Incumbent", "Vacant since", "Vacancy reason", "Skills", "Competencies", "Effective from", "Effective to"],
        rows.map((p) => [p.code, p.title, p.job ? `${p.job.code} ${p.job.title}` : "", names.dept.get(p.departmentId ?? "") ?? "", names.loc.get(p.locationId ?? "") ?? "", names.cc.get(p.costCenterId ?? "") ?? "", names.grade.get(p.payGradeId ?? "") ?? "",
          p.status, p.budgetStatus, n(p.budgetedAnnualSalary), n(p.fte), p.isHeadcount ? "Yes" : "No", p.criticality, p.workMode, names.emp.get(p.incumbentEmployeeId ?? "") ?? "", d(p.vacantSince), p.vacancyReason ?? "", p.skills.join("; "), p.competencies.join("; "), d(p.effectiveFrom), d(p.effectiveTo)]),
      ), rows.length, "Position");
    }
    case "jobs": {
      const rows = await prisma.jobProfile.findMany({ where: { tenantId: t }, include: { family: true, level: true }, orderBy: { code: "asc" } });
      return csvResponse(viewer, "jobs", safeCsv(["Code", "Title", "Family", "Level", "Status", "Version", "Summary", "Responsibilities", "Competencies", "Skills"],
        rows.map((j) => [j.code, j.title, j.family?.name ?? "", j.level?.name ?? "", j.status, j.version, j.summary ?? "", j.responsibilities ?? "", j.competencies.join("; "), j.skills.join("; ")])), rows.length, "JobProfile");
    }
    case "families": {
      const rows = await prisma.jobFamily.findMany({ where: { tenantId: t }, include: { parent: true, _count: { select: { jobs: true } } }, orderBy: { name: "asc" } });
      return csvResponse(viewer, "job-families", safeCsv(["Name", "Code", "Parent", "Status", "Jobs", "Description"], rows.map((f) => [f.name, f.code ?? "", f.parent?.name ?? "", f.status, f._count.jobs, f.description ?? ""])), rows.length, "JobFamily");
    }
    case "levels": {
      const rows = await prisma.jobLevel.findMany({ where: { tenantId: t }, include: { _count: { select: { jobs: true } } }, orderBy: { rank: "asc" } });
      return csvResponse(viewer, "job-levels", safeCsv(["Rank", "Name", "Code", "Track", "Status", "Pay grade", "Jobs", "Career definition"], rows.map((l) => [l.rank, l.name, l.code ?? "", l.track, l.status, names.grade.get(l.payGradeId ?? "") ?? "", l._count.jobs, l.careerDefinition ?? ""])), rows.length, "JobLevel");
    }
    case "vacancy": {
      const v = await vacancyReport(t);
      return csvResponse(viewer, "vacancy-aging", safeCsv(["Control no.", "Title", "Department", "Status", "Vacant since", "Days vacant", "Reason", "Criticality", "Budgeted salary"],
        v.vacant.map((p) => [p.code, p.title, names.dept.get(p.departmentId ?? "") ?? "", p.status, d(p.vacantSince), p.ageDays, p.vacancyReason ?? "", p.criticality, n(p.budgetedAnnualSalary)])), v.vacant.length, "Position");
    }
    case "headcount": {
      const rows = await prisma.position.groupBy({ by: ["departmentId", "status"], where: { tenantId: t, isHeadcount: true }, _count: { _all: true }, _sum: { budgetedAnnualSalary: true } });
      return csvResponse(viewer, "headcount-positions", safeCsv(["Department", "Status", "Positions", "Budgeted salary"], rows.map((r) => [names.dept.get(r.departmentId ?? "") ?? "No department", r.status, r._count._all, n(r._sum.budgetedAnnualSalary)])), rows.length, "Position");
    }
    case "reconciliation": {
      const rows = await reconciliationReport(t);
      return csvResponse(viewer, "position-reconciliation", safeCsv(["Department", "Active employees", "Filled positions", "Vacant positions", "Difference", "Status"],
        rows.map((r) => [names.dept.get(r.departmentId ?? "") ?? "No department", r.activeEmployees, r.filledPositions, r.vacantPositions, r.unpositioned, r.status])), rows.length, "Position");
    }
    case "approvals": {
      const rows = await requestsOf(t, "positions");
      return csvResponse(viewer, "position-approvals", safeCsv(["Requested", "Request", "Record", "Status", "Requested by", "Decided by", "Decided", "Reason", "Note"],
        rows.map((r) => [d(r.requestedAt), REQUEST_KINDS[r.kind]?.label ?? r.kind, r.label, r.status, names.user.get(r.requestedBy) ?? "", names.user.get(r.decidedBy ?? "") ?? "", d(r.decidedAt), r.reason ?? "", r.decisionNote ?? ""])), rows.length, "WorkforceRequest");
    }
    default:
      return new NextResponse("Unknown report.", { status: 400 });
  }
}
