import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { safeCsv, CHANGE_TARGETS, checklistProgress } from "@keka/services";
import { getViewer, can, type Viewer } from "@/lib/context";
import { visibleChangeRequestWhere, directoryParams, directorySearchWhere, displayChangeValue } from "@/lib/core-hr";
import { scopedEmployeeIds, scopedEmployeeWhere } from "@/lib/scope";

const P = PERMISSIONS;
const MAX = 20_000;
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "");
type Table = { header: string[]; rows: Array<Array<string | number | boolean | null>> };

/**
 * CSV downloads for Core HR: every list on the org units, company setup,
 * change request, HR operations and directory pages. Each export checks its
 * own permission, stays inside the viewer's tenant (and scope), and is
 * itself written to the audit log.
 */
const EXPORTS: Record<string, { perm?: Permission; label: string; build: (v: Viewer, q: URLSearchParams) => Promise<Table> }> = {
  "change-requests": {
    label: "change requests",
    build: async (v, q) => {
      const cat = q.get("category"); const st = q.get("status");
      const rows = await prisma.changeRequest.findMany({ where: { AND: [await visibleChangeRequestWhere(v), cat ? { category: cat } : {}, st ? { status: st as never } : {}] }, orderBy: { createdAt: "desc" }, take: MAX });
      return {
        header: ["Raised", "Kind", "Target", "Title", "Operation", "Changes", "Reason", "Effective", "Status", "Approver", "Decided", "Decision note", "Applied", "Error"],
        rows: rows.map((r) => [d(r.createdAt), r.category, CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType, r.title, r.operation,
          Object.entries((r.changes ?? {}) as Record<string, unknown>).map(([k, x]) => `${k}=${displayChangeValue(k, x)}`).join("; "), r.reason, d(r.effectiveDate), r.status, r.approverType, d(r.decidedAt), r.decisionNote, d(r.appliedAt), r.error]),
      };
    },
  },
  divisions: {
    perm: P.ORG_VIEW, label: "divisions",
    build: async (v) => {
      const [divs, depts, units, people] = await Promise.all([
        prisma.division.findMany({ where: { tenantId: v.tenantId }, orderBy: { name: "asc" } }),
        prisma.department.findMany({ where: { tenantId: v.tenantId }, select: { name: true, divisionId: true } }),
        prisma.businessUnit.findMany({ where: { tenantId: v.tenantId }, select: { id: true, name: true } }),
        prisma.employee.findMany({ where: { tenantId: v.tenantId }, select: { id: true, displayName: true } }),
      ]);
      const unit = new Map(units.map((u) => [u.id, u.name])); const who = new Map(people.map((p) => [p.id, p.displayName ?? ""]));
      return { header: ["Division", "Code", "Business unit", "Head", "Departments", "Active", "Effective from"], rows: divs.map((x) => [x.name, x.code, unit.get(x.businessUnitId ?? "") ?? "", who.get(x.headId ?? "") ?? "", depts.filter((y) => y.divisionId === x.id).map((y) => y.name).join("; "), x.isActive, d(x.effectiveFrom)]) };
    },
  },
  teams: {
    perm: P.ORG_VIEW, label: "teams",
    build: async (v) => {
      const [teams, people] = await Promise.all([
        prisma.orgTeam.findMany({ where: { tenantId: v.tenantId }, include: { members: true }, orderBy: { name: "asc" } }),
        prisma.employee.findMany({ where: { tenantId: v.tenantId }, select: { id: true, displayName: true, employeeNumber: true } }),
      ]);
      const who = new Map(people.map((p) => [p.id, `${p.displayName ?? ""} (${p.employeeNumber})`]));
      return { header: ["Team", "Code", "Lead", "Cross-unit", "Active", "Member", "Role in team", "Added"], rows: teams.flatMap((t) => (t.members.length ? t.members : [null]).map((m) => [t.name, t.code, who.get(t.leadId ?? "") ?? "", t.isCrossFunctional, t.isActive, m ? who.get(m.employeeId) ?? "" : "", m?.role ?? "", m ? d(m.addedAt) : ""])) };
    },
  },
  "secondary-managers": {
    perm: P.ORG_VIEW, label: "dotted-line managers",
    build: async (v) => {
      const [rows, people] = await Promise.all([
        prisma.secondaryManager.findMany({ where: { tenantId: v.tenantId } }),
        prisma.employee.findMany({ where: { tenantId: v.tenantId }, select: { id: true, displayName: true, employeeNumber: true } }),
      ]);
      const who = new Map(people.map((p) => [p.id, `${p.displayName ?? ""} (${p.employeeNumber})`]));
      return { header: ["Employee", "Manager", "Kind", "From", "Until", "Note"], rows: rows.map((r) => [who.get(r.employeeId) ?? "", who.get(r.managerId) ?? "", r.kind, d(r.effectiveFrom), d(r.effectiveTo), r.note]) };
    },
  },
  "org-changes": {
    perm: P.ORG_VIEW, label: "org changes",
    build: async (v) => {
      const rows = await prisma.changeRequest.findMany({ where: { tenantId: v.tenantId, category: "ORG" }, orderBy: { createdAt: "desc" }, take: MAX });
      return { header: ["Raised", "Title", "Operation", "Changes", "Effective", "Status", "Applied", "Error"], rows: rows.map((r) => [d(r.createdAt), r.title, r.operation, JSON.stringify(r.changes), d(r.effectiveDate), r.status, d(r.appliedAt), r.error]) };
    },
  },
  "fiscal-years": {
    perm: P.ORG_SETTINGS_MANAGE, label: "fiscal years",
    build: async (v) => {
      const rows = await prisma.fiscalYear.findMany({ where: { tenantId: v.tenantId }, orderBy: [{ calendarSet: "asc" }, { startDate: "asc" }] });
      return { header: ["Name", "Calendar set", "Start", "End", "Status", "Current", "Note"], rows: rows.map((y) => [y.name, y.calendarSet, d(y.startDate), d(y.endDate), y.status, y.isCurrent, y.note]) };
    },
  },
  "legal-entities": {
    perm: P.ORG_VIEW, label: "legal entities",
    build: async (v) => {
      const rows = await prisma.legalEntity.findMany({ where: { tenantId: v.tenantId }, include: { _count: { select: { employees: true } } }, orderBy: { name: "asc" } });
      return { header: ["Name", "Legal name", "Country", "Currency", "CIN", "Business type", "City", "State", "Active", "Employees"], rows: rows.map((e) => [e.name, e.legalName, e.countryCode, e.currency, e.cin, e.businessType, e.city, e.state, e.isActive, e._count.employees]) };
    },
  },
  "business-units": {
    perm: P.ORG_VIEW, label: "business units",
    build: async (v) => {
      const rows = await prisma.businessUnit.findMany({ where: { tenantId: v.tenantId }, include: { legalEntity: { select: { name: true } }, _count: { select: { employees: true } } }, orderBy: { name: "asc" } });
      return { header: ["Name", "Code", "Legal entity", "Active", "Employees", "Description"], rows: rows.map((b) => [b.name, b.code, b.legalEntity.name, b.isActive, b._count.employees, b.description]) };
    },
  },
  "cost-centres": {
    perm: P.ORG_VIEW, label: "cost centres",
    build: async (v) => {
      const rows = await prisma.costCenter.findMany({ where: { tenantId: v.tenantId }, include: { _count: { select: { employees: true } } }, orderBy: { name: "asc" } });
      return { header: ["Name", "Code", "Active", "Employees"], rows: rows.map((c) => [c.name, c.code, c.isActive, c._count.employees]) };
    },
  },
  "org-chart": {
    perm: P.ORG_VIEW, label: "reporting lines",
    build: async (v) => {
      const [people, dotted] = await Promise.all([
        prisma.employee.findMany({ where: { tenantId: v.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, employeeNumber: true, displayName: true, jobTitleName: true, reportingManagerId: true, department: { select: { name: true } } }, orderBy: { employeeNumber: "asc" } }),
        prisma.secondaryManager.findMany({ where: { tenantId: v.tenantId, kind: "DOTTED_LINE" } }),
      ]);
      const num = new Map(people.map((p) => [p.id, p.employeeNumber]));
      return { header: ["Employee number", "Name", "Job title", "Department", "Reports to (number)", "Dotted line to (numbers)"], rows: people.map((p) => [p.employeeNumber, p.displayName, p.jobTitleName, p.department?.name ?? "", num.get(p.reportingManagerId ?? "") ?? "", dotted.filter((x) => x.employeeId === p.id).map((x) => num.get(x.managerId) ?? "").join("; ")]) };
    },
  },
  directory: {
    label: "directory",
    build: async (v, q) => {
      const where = await directorySearchWhere(v, directoryParams(Object.fromEntries(q.entries())));
      const rows = await prisma.employee.findMany({ where, select: { employeeNumber: true, displayName: true, jobTitleName: true, workEmail: true, department: { select: { name: true } }, location: { select: { name: true } }, dateOfJoining: true }, orderBy: { firstName: "asc" }, take: MAX });
      return { header: ["Employee number", "Name", "Job title", "Work email", "Department", "Location", "Joined"], rows: rows.map((e) => [e.employeeNumber, e.displayName, e.jobTitleName, e.workEmail, e.department?.name ?? "", e.location?.name ?? "", d(e.dateOfJoining)]) };
    },
  },
  "document-requests": {
    perm: P.LETTER_GENERATE, label: "document requests",
    build: async (v) => {
      const ids = await scopedEmployeeIds(v, P.EMPLOYEE_VIEW);
      const rows = await prisma.selfServiceDocumentRequest.findMany({ where: { tenantId: v.tenantId, ...(ids === null ? {} : { employeeId: { in: ids } }) }, include: { type: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: MAX });
      const people = await prisma.employee.findMany({ where: { tenantId: v.tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } });
      const who = new Map(people.map((p) => [p.id, `${p.displayName ?? ""} (${p.employeeNumber})`]));
      return { header: ["Requested", "Employee", "Document", "Purpose", "Addressed to", "Status", "Decided", "Note"], rows: rows.map((r) => [d(r.createdAt), who.get(r.employeeId) ?? "", r.type.name, r.purpose, r.addressedTo, r.status, d(r.decidedAt), r.note]) };
    },
  },
  "mass-updates": {
    perm: P.EMPLOYEE_UPDATE, label: "mass updates",
    build: async (v) => {
      const rows = await prisma.massUpdateBatch.findMany({ where: { tenantId: v.tenantId }, include: { items: true }, orderBy: { createdAt: "desc" }, take: 500 });
      const people = await prisma.employee.findMany({ where: { tenantId: v.tenantId, id: { in: rows.flatMap((b) => b.items.map((i) => i.employeeId)) } }, select: { id: true, employeeNumber: true } });
      const num = new Map(people.map((p) => [p.id, p.employeeNumber]));
      return { header: ["Batch date", "Kind", "New value", "Batch status", "Employee number", "Before", "After", "Item status", "Message"], rows: rows.flatMap((b) => b.items.map((i) => [d(b.createdAt), b.kind, b.valueLabel ?? b.value, b.status, num.get(i.employeeId) ?? "", i.before, i.after, i.status, i.message])) };
    },
  },
  checklists: {
    perm: P.EMPLOYEE_UPDATE, label: "HR checklists",
    build: async (v) => {
      const ids = await scopedEmployeeIds(v, P.EMPLOYEE_UPDATE);
      const rows = await prisma.hrChecklist.findMany({ where: { tenantId: v.tenantId, ...(ids === null ? {} : { employeeId: { in: ids } }) }, include: { items: true }, orderBy: { createdAt: "desc" }, take: MAX });
      const people = await prisma.employee.findMany({ where: { tenantId: v.tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, employeeNumber: true, displayName: true } });
      const who = new Map(people.map((p) => [p.id, `${p.displayName ?? ""} (${p.employeeNumber})`]));
      return { header: ["Checklist", "Employee", "Assigned", "Due", "Status", "Done", "Total", "Signed off", "Sign-off note"], rows: rows.map((c) => { const pr = checklistProgress(c.items); return [c.title, who.get(c.employeeId) ?? "", d(c.createdAt), d(c.dueDate), c.status, pr.done, pr.total, d(c.signedOffAt), c.signOffNote]; }) };
    },
  },
  "search-log": {
    perm: P.ORG_SETTINGS_MANAGE, label: "directory searches",
    build: async (v) => {
      const rows = await prisma.directorySearchLog.findMany({ where: { tenantId: v.tenantId }, orderBy: { createdAt: "desc" }, take: MAX });
      return { header: ["When", "Search", "Results"], rows: rows.map((r) => [r.createdAt.toISOString().slice(0, 16).replace("T", " "), r.query, r.resultCount]) };
    },
  },
  "education-experience": {
    perm: P.EMPLOYEE_VIEW, label: "education and experience",
    build: async (v) => {
      const where = scopedEmployeeWhere(v, P.EMPLOYEE_VIEW);
      const people = await prisma.employee.findMany({ where, select: { employeeNumber: true, displayName: true, educations: true, experiences: true }, orderBy: { employeeNumber: "asc" }, take: 5000 });
      return {
        header: ["Employee number", "Name", "Record", "Where", "What", "From", "To"],
        rows: people.flatMap((p) => [
          ...p.educations.map((e) => [p.employeeNumber, p.displayName, "Education", e.institution, [e.degree, e.specialization].filter(Boolean).join(", "), e.fromYear ?? "", e.toYear ?? ""] as Array<string | number | null>),
          ...p.experiences.map((e) => [p.employeeNumber, p.displayName, "Experience", e.companyName, e.jobTitle, d(e.fromDate), d(e.toDate)] as Array<string | number | null>),
        ]),
      };
    },
  },
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { kind } = await params;
  const spec = EXPORTS[kind];
  if (!spec) return new NextResponse("Unknown export.", { status: 404 });
  if (spec.perm && !can(viewer, spec.perm)) return new NextResponse("Forbidden.", { status: 403 });
  const t = await spec.build(viewer, req.nextUrl.searchParams);
  const csv = safeCsv(t.header, t.rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : typeof c === "boolean" ? (c ? "Yes" : "No") : c))));
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "CoreHrExport", entityId: kind,
      summary: `Exported ${t.rows.length} ${spec.label}`, actorId: viewer.user.id, actorLabel: viewer.user.email,
    },
  });
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
