import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import {
  safeCsv, captureConfig, orgAsOf, referenceTemplateCsv, REFERENCE_IMPORT_KINDS, findDuplicatePeople, completenessGaps, HR_TRANSACTION_TYPES, slaState, hrAgingBucket,
  PRIVACY_REQUEST_KINDS, flattenTree, rosterGrid, rosterDate, type ReferenceImportKind,
} from "@keka/services";
import { getViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { managedTeam } from "@/lib/core-hr";
import { peopleQualityFacts, hrPendingItems, hrCalendarEvents } from "@/lib/core2";

const P = PERMISSIONS;
const MAX = 20_000;
const DAY = 86_400_000;
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "");
type Cell = string | number | boolean | null | undefined;
type Table = { header: string[]; rows: Cell[][] };

/** Flatten a nested value into "path = value" rows. */
function flatten(prefix: string, v: unknown, out: Array<[string, string]>) {
  if (v === null || v === undefined) out.push([prefix, ""]);
  else if (Array.isArray(v)) { if (!v.length) out.push([prefix, ""]); v.forEach((x, i) => flatten(`${prefix}[${i}]`, x, out)); }
  else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(prefix ? `${prefix}.${k}` : k, x, out);
  else out.push([prefix, String(v)]);
}

async function teamIds(v: Viewer, directOnly = false): Promise<string[]> {
  const team = await managedTeam(v);
  return [...team].filter(([, l]) => !directOnly || l === "DIRECT" || l === "ACTING").map(([id]) => id);
}

/**
 * CSV downloads for company setup, the org hierarchy, legal entities, HR
 * operations, data quality and the manager's team views. Each checks its
 * own permission (team exports are limited to the manager's own team),
 * stays inside the tenant, and is itself written to the audit log.
 */
const EXPORTS: Record<string, { perm?: Permission; label: string; build: (v: Viewer, q: URLSearchParams) => Promise<Table> }> = {
  configuration: {
    perm: P.ORG_SETTINGS_MANAGE, label: "configuration settings",
    build: async (v) => {
      const payload = await captureConfig(v.tenantId);
      const rows: Array<[string, string]> = [];
      for (const [section, value] of Object.entries(payload.sections)) flatten(section, value, rows);
      return { header: ["Setting", "Value"], rows };
    },
  },
  "company-profile": {
    perm: P.ORG_SETTINGS_MANAGE, label: "company profile fields",
    build: async (v) => {
      const [tenant, c] = await Promise.all([prisma.tenant.findUniqueOrThrow({ where: { id: v.tenantId }, select: { name: true, subdomain: true, timezone: true, fyStartMonth: true } }), prisma.companyProfile.findUnique({ where: { tenantId: v.tenantId } })]);
      const rows: Array<[string, string]> = [];
      flatten("organisation", tenant, rows);
      if (c) { const { id: _i, tenantId: _t, ...rest } = c; flatten("profile", { ...rest, updatedAt: d(c.updatedAt) }, rows); }
      return { header: ["Field", "Value"], rows };
    },
  },
  "working-rules": {
    perm: P.ORG_SETTINGS_MANAGE, label: "working rules",
    build: async (v) => {
      const r = await prisma.workingRules.findUnique({ where: { tenantId: v.tenantId } });
      if (!r) return { header: ["Rule", "Value"], rows: [["(defaults)", "Not set yet"]] };
      return { header: ["Rule", "Value"], rows: [["Work days", r.workDays.join(" ")], ["Week starts on", r.weekStartsOn], ["Standard hours a day", Number(r.standardHoursPerDay)], ["Standard hours a week", Number(r.standardHoursPerWeek)], ["Half day at least (hours)", Number(r.halfDayMinHours)], ["Most consecutive work days", r.maxConsecutiveWorkDays], ["Overtime after (hours)", Number(r.overtimeAfterHours)], ["Span of control limit", r.maxSpanOfControl], ["Last changed", d(r.updatedAt)]] };
    },
  },
  settings: {
    perm: P.ORG_SETTINGS_MANAGE, label: "global settings",
    build: async (v) => {
      const [vis, approvals, sec] = await Promise.all([
        prisma.tenantVisibilitySetting.findUnique({ where: { tenantId: v.tenantId } }),
        prisma.changeApprovalSetting.findMany({ where: { tenantId: v.tenantId }, orderBy: { targetType: "asc" } }),
        prisma.tenantSecuritySetting.findUnique({ where: { tenantId: v.tenantId } }),
      ]);
      const rows: Cell[][] = [];
      if (vis) rows.push(["Visibility", "Restrict by legal entity", vis.restrictByLegalEntity, d(vis.updatedAt)], ["Visibility", "Restrict by business unit", vis.restrictByBusinessUnit, d(vis.updatedAt)], ["Visibility", "Managers always see reportees", vis.managerReporteeOverride, d(vis.updatedAt)]);
      for (const a of approvals) rows.push(["Change approval", a.targetType, a.requireApproval, d(a.updatedAt)]);
      if (sec) { const { id: _i, tenantId: _t, ...rest } = sec as Record<string, unknown>; for (const [k, x] of Object.entries(rest)) if (k !== "updatedAt" && k !== "createdAt") rows.push(["Security", k, typeof x === "object" && x !== null && !(x instanceof Date) ? JSON.stringify(x) : (x as Cell), ""]); }
      return { header: ["Area", "Setting", "Value", "Changed"], rows };
    },
  },
  countries: {
    perm: P.ORG_SETTINGS_MANAGE, label: "countries",
    build: async (v) => {
      const rows = await prisma.countryAvailability.findMany({ where: { tenantId: v.tenantId }, orderBy: { countryCode: "asc" } });
      return { header: ["Country code", "Country", "Modules", "Currency", "Active", "Note"], rows: rows.map((c) => [c.countryCode, c.countryName, c.modules.join(" "), c.currency, c.isActive, c.note]) };
    },
  },
  locations: {
    perm: P.ORG_VIEW, label: "locations",
    build: async (v) => {
      const [locs, counts] = await Promise.all([
        prisma.location.findMany({ where: { tenantId: v.tenantId }, orderBy: { name: "asc" } }),
        prisma.employee.groupBy({ by: ["locationId"], where: { tenantId: v.tenantId, status: { not: "EXITED" } }, _count: { _all: true } }),
      ]);
      const name = new Map(locs.map((l) => [l.id, l.name]));
      const n = new Map(counts.map((c) => [c.locationId, c._count._all]));
      return { header: ["Location", "Code", "Parent", "Address", "City", "State", "Postal code", "Country", "Timezone", "Geofence (m)", "People", "Active"], rows: locs.map((l) => [l.name, l.code, l.parentId ? name.get(l.parentId) ?? "" : "", [l.addressLine1, l.addressLine2].filter(Boolean).join(", "), l.city, l.state ?? l.stateCode, l.postalCode, l.countryCode, l.timezone, l.geofenceRadiusM, n.get(l.id) ?? 0, l.isActive]) };
    },
  },
  establishments: {
    perm: P.STATUTORY_MANAGE, label: "state establishments",
    build: async (v) => {
      const where = { payGroup: { tenantId: v.tenantId } };
      const [pt, lwf] = await Promise.all([
        prisma.ptStateRegistration.findMany({ where, include: { payGroup: { select: { name: true } } }, orderBy: { stateCode: "asc" } }),
        prisma.lwfStateRegistration.findMany({ where, include: { payGroup: { select: { name: true } } }, orderBy: { stateCode: "asc" } }),
      ]);
      return {
        header: ["Kind", "Pay group", "State", "State name", "Establishment ID", "Registered", "Signatory", "Frequency / local body"],
        rows: [...pt.map((r) => ["Professional tax", r.payGroup.name, r.stateCode, r.stateName, r.establishmentId, d(r.registrationDate), r.signatoryName, `${r.frequency}${r.localBodyType ? ` · ${r.localBodyType}` : ""}`]), ...lwf.map((r) => ["Labour welfare fund", r.payGroup.name, r.stateCode, r.stateName, r.establishmentId, d(r.registrationDate), r.signatoryName, ""])],
      };
    },
  },
  registrations: {
    perm: P.STATUTORY_MANAGE, label: "statutory registration profiles",
    build: async (v) => {
      const groups = await prisma.payGroup.findMany({ where: { tenantId: v.tenantId }, select: { name: true, legalEntity: { select: { name: true } }, filingDetail: true }, orderBy: { name: "asc" } });
      return {
        header: ["Pay group", "Legal entity", "PAN", "TAN", "PF registration", "PF registered", "PF signatory", "ESI registration", "ESI registered", "ESI signatory", "Responsible person", "Updated"],
        rows: groups.map((g) => { const f = g.filingDetail; return [g.name, g.legalEntity.name, f?.pan, f?.tan, f?.pfRegistrationNumber, d(f?.pfRegistrationDate), f?.pfSignatoryName, f?.esiRegistrationNumber, d(f?.esiRegistrationDate), f?.esiSignatoryName, f?.responsiblePersonName, d(f?.updatedAt)]; }),
      };
    },
  },
  "org-as-of": {
    perm: P.ORG_VIEW, label: "people in the organisation as of a date",
    build: async (v, q) => {
      const asOf = rosterDate(q.get("asOf") ?? "") ?? new Date();
      const snap = await orgAsOf(v.tenantId, asOf);
      const unit = new Map(snap.units.map((u) => [u.id, u.name]));
      const person = new Map(snap.people.map((p) => [p.id, p.name]));
      return { header: ["As of", "Employee number", "Name", "Title", "Department", "Manager", "Location", "Legal entity", "Business unit"], rows: snap.people.map((p) => [snap.asOf, p.number, p.name, p.title, unit.get(p.departmentId ?? "") ?? "", person.get(p.managerId ?? "") ?? "", unit.get(p.locationId ?? "") ?? "", unit.get(p.legalEntityId ?? "") ?? "", unit.get(p.businessUnitId ?? "") ?? ""]) };
    },
  },
  hierarchy: {
    perm: P.ORG_VIEW, label: "units in the hierarchy",
    build: async (v, q) => {
      const t = v.tenantId; const type = q.get("type") ?? "DEPARTMENT";
      const nodes: Array<{ id: string; name: string; parentId: string | null; code?: string | null; isActive: boolean }> =
        type === "COST_CENTRE" ? await prisma.costCenter.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true, code: true, isActive: true } })
          : type === "LOCATION" ? await prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true, code: true, isActive: true } })
            : type === "BUSINESS_UNIT" ? await prisma.businessUnit.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true, code: true, isActive: true } })
              : await prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true, code: true, isActive: true } });
      return { header: ["Type", "Path", "Unit", "Code", "Level", "Active"], rows: flattenTree(nodes).map((r) => [type, r.path, r.node.name, r.node.code, r.depth + 1, r.node.isActive]) };
    },
  },
  entities: {
    perm: P.ORG_ENTITY_MANAGE, label: "legal entity compliance items",
    build: async (v) => {
      const t = v.tenantId; const now = new Date();
      const [entities, regs, deadlines, docs, cals] = await Promise.all([
        prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
        prisma.entityTaxRegistration.findMany({ where: { tenantId: t } }),
        prisma.entityComplianceDeadline.findMany({ where: { tenantId: t }, orderBy: { dueDate: "asc" } }),
        prisma.entityDocument.findMany({ where: { tenantId: t } }),
        prisma.entityPayrollCalendar.findMany({ where: { tenantId: t, payDate: { gte: now } } }),
      ]);
      const name = new Map(entities.map((e) => [e.id, e.name]));
      return {
        header: ["Legal entity", "Item", "Detail", "Date", "Status"],
        rows: [
          ...regs.map((r) => [name.get(r.legalEntityId), `Registration · ${r.type}`, r.number, d(r.validTo), r.validTo && r.validTo < now ? "EXPIRED" : "ACTIVE"]),
          ...deadlines.map((x) => [name.get(x.legalEntityId), "Compliance deadline", x.title, d(x.dueDate), x.status === "OPEN" && x.dueDate < now ? "OVERDUE" : x.status]),
          ...docs.map((x) => [name.get(x.legalEntityId), `Document · ${x.category}`, x.title, d(x.validUntil), x.validUntil && x.validUntil < now ? "EXPIRED" : "CURRENT"]),
          ...cals.map((x) => [name.get(x.legalEntityId), "Payroll month", `${x.month}/${x.year}`, d(x.payDate), x.status]),
        ],
      };
    },
  },
  intercompany: {
    perm: P.ORG_ENTITY_MANAGE, label: "intercompany assignments",
    build: async (v) => {
      const [rows, entities, people] = await Promise.all([
        prisma.intercompanyAssignment.findMany({ where: { tenantId: v.tenantId }, orderBy: { startDate: "desc" } }),
        prisma.legalEntity.findMany({ where: { tenantId: v.tenantId }, select: { id: true, name: true } }),
        prisma.employee.findMany({ where: { tenantId: v.tenantId }, select: { id: true, displayName: true, employeeNumber: true } }),
      ]);
      const n = new Map<string, string>([...entities.map((e) => [e.id, e.name] as [string, string]), ...people.map((p) => [p.id, `${p.displayName} (${p.employeeNumber})`] as [string, string])]);
      return { header: ["Employee", "Home entity", "Host entity", "From", "Until", "Allocation %", "Purpose", "Status"], rows: rows.map((r) => [n.get(r.employeeId), n.get(r.homeEntityId), n.get(r.hostEntityId), d(r.startDate), d(r.endDate), r.allocationPct, r.purpose, r.status]) };
    },
  },
  "cost-centre-reconciliation": {
    perm: P.ORG_ENTITY_MANAGE, label: "cost centre mismatches",
    build: async (v) => {
      const t = v.tenantId;
      const [emps, ccs, entities] = await Promise.all([
        prisma.employee.findMany({ where: { tenantId: t, status: { not: "EXITED" }, costCenterId: { not: null } }, select: { displayName: true, employeeNumber: true, legalEntityId: true, costCenterId: true } }),
        prisma.costCenter.findMany({ where: { tenantId: t }, select: { id: true, name: true, legalEntityId: true } }),
        prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
      ]);
      const cc = new Map(ccs.map((c) => [c.id, c])); const le = new Map(entities.map((e) => [e.id, e.name]));
      const bad = emps.filter((e) => { const c = cc.get(e.costCenterId!); return c?.legalEntityId && c.legalEntityId !== e.legalEntityId; });
      return {
        header: ["Issue", "Employee number", "Name", "Employee's entity", "Cost centre", "Cost centre's entity"],
        rows: [...bad.map((e) => { const c = cc.get(e.costCenterId!)!; return ["Books to another entity", e.employeeNumber, e.displayName, le.get(e.legalEntityId ?? "") ?? "", c.name, le.get(c.legalEntityId!) ?? ""]; }), ...ccs.filter((c) => !c.legalEntityId).map((c) => ["Cost centre without an entity", "", "", "", c.name, ""])],
      };
    },
  },
  "hr-desk": {
    perm: P.EMPLOYEE_UPDATE, label: "open HR items",
    build: async (v) => {
      const now = new Date();
      const [items, policies] = await Promise.all([hrPendingItems(v.tenantId), prisma.hrSlaPolicy.findMany({ where: { tenantId: v.tenantId } })]);
      const target = (t: keyof typeof HR_TRANSACTION_TYPES) => policies.find((p) => p.transactionType === t)?.targetHours ?? HR_TRANSACTION_TYPES[t].defaultHours;
      return { header: ["Type", "Item", "Raised", "Age", "SLA (hours)", "Due", "Breached", "Hours left"], rows: items.map((i) => { const s = slaState(i.createdAt, target(i.type), now); return [HR_TRANSACTION_TYPES[i.type].label, i.title, d(i.createdAt), hrAgingBucket(i.createdAt, now), target(i.type), d(s.dueAt), s.breached, s.hoursLeft]; }) };
    },
  },
  "hr-calendar": {
    perm: P.EMPLOYEE_UPDATE, label: "HR calendar events",
    build: async (v) => ({ header: ["Date", "What", "Detail"], rows: (await hrCalendarEvents(v.tenantId)).map((e) => [d(e.date), e.kind, e.text]) }),
  },
  duplicates: {
    perm: P.EMPLOYEE_UPDATE, label: "probable duplicates",
    build: async (v) => {
      const people = await peopleQualityFacts({ AND: [{ tenantId: v.tenantId }, scopedEmployeeWhere(v, P.EMPLOYEE_UPDATE)] });
      const by = new Map(people.map((p) => [p.id, p]));
      return { header: ["Employee number", "Name", "Employee number", "Name", "Why", "Likelihood %"], rows: findDuplicatePeople(people).map((x) => { const a = by.get(x.a)!, b = by.get(x.b)!; return [a.employeeNumber, a.displayName, b.employeeNumber, b.displayName, x.reasons.join("; "), x.score]; }) };
    },
  },
  completeness: {
    perm: P.EMPLOYEE_UPDATE, label: "records with missing data",
    build: async (v) => {
      const [people, rules] = await Promise.all([peopleQualityFacts({ AND: [{ tenantId: v.tenantId }, scopedEmployeeWhere(v, P.EMPLOYEE_UPDATE)] }), prisma.fieldCompletenessRule.findMany({ where: { tenantId: v.tenantId } })]);
      return { header: ["Employee number", "Name", "Missing", "Severity"], rows: people.flatMap((p) => completenessGaps(p, rules).map((g) => [p.employeeNumber, p.displayName, g.label, g.severity])) };
    },
  },
  reconciliation: {
    perm: P.EMPLOYEE_UPDATE, label: "record and job history mismatches",
    build: async (v) => {
      const emps = await prisma.employee.findMany({ where: { tenantId: v.tenantId, status: { not: "EXITED" } }, select: { employeeNumber: true, displayName: true, departmentId: true, locationId: true, reportingManagerId: true, legalEntityId: true, jobHistory: { where: { effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { departmentId: true, locationId: true, reportingManagerId: true, legalEntityId: true } } } });
      const fields = ["departmentId", "locationId", "reportingManagerId", "legalEntityId"] as const;
      return {
        header: ["Employee number", "Name", "Differs in"],
        rows: emps.flatMap((e) => { const r = e.jobHistory[0]; if (!r) return [[e.employeeNumber, e.displayName, "no job record"]]; const f = fields.filter((k) => (r[k] ?? null) !== (e[k] ?? null)); return f.length ? [[e.employeeNumber, e.displayName, f.map((k) => k.replace("Id", "")).join("; ")]] : []; }),
      };
    },
  },
  qc: {
    perm: P.EMPLOYEE_UPDATE, label: "QC samples",
    build: async (v) => {
      const rows = await prisma.hrQcSample.findMany({ where: { tenantId: v.tenantId }, orderBy: { createdAt: "desc" }, take: MAX });
      return { header: ["Sampled", "Change", "Result", "Note", "Reviewed"], rows: rows.map((s) => [d(s.createdAt), s.summary, s.result, s.note, d(s.reviewedAt)]) };
    },
  },
  privacy: {
    perm: P.COMPLIANCE_MANAGE, label: "privacy requests",
    build: async (v) => {
      const rows = await prisma.privacyRequest.findMany({ where: { tenantId: v.tenantId }, orderBy: { createdAt: "desc" }, take: MAX });
      const people = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } });
      const n = new Map(people.map((p) => [p.id, p]));
      return { header: ["Raised", "Employee number", "Name", "Request", "Status", "Due", "Closed", "On time"], rows: rows.map((r) => [d(r.createdAt), n.get(r.employeeId)?.employeeNumber, n.get(r.employeeId)?.displayName, PRIVACY_REQUEST_KINDS[r.kind as keyof typeof PRIVACY_REQUEST_KINDS] ?? r.kind, r.status, d(r.dueDate), d(r.closedAt), r.closedAt ? r.closedAt <= r.dueDate : r.dueDate >= new Date()]) };
    },
  },
  movements: {
    perm: P.EMPLOYEE_UPDATE, label: "employee movements",
    build: async (v, q) => {
      const now = new Date();
      const from = rosterDate(q.get("from") ?? "") ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
      const to = rosterDate(q.get("to") ?? "") ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0));
      const reason = q.get("reason"); const status = q.get("status");
      // JobChange has no employee relation: scope by the employees this viewer may update.
      const people = await prisma.employee.findMany({ where: { AND: [{ tenantId: v.tenantId }, scopedEmployeeWhere(v, P.EMPLOYEE_UPDATE)] }, select: { id: true, displayName: true, employeeNumber: true } });
      const who = new Map(people.map((p) => [p.id, p]));
      const changes = await prisma.jobChange.findMany({
        where: { tenantId: v.tenantId, effectiveFrom: { gte: from, lte: to }, employeeId: { in: [...who.keys()] }, ...(reason ? { reason: reason as never } : {}), ...(status ? { status: status as never } : { status: { in: ["APPLIED", "SCHEDULED", "PENDING_APPROVAL"] } }) },
        orderBy: { effectiveFrom: "desc" }, take: MAX,
      });
      const rows = changes.map((c) => ({ ...c, employee: who.get(c.employeeId)! }));
      const ids = [...new Set(rows.flatMap((r) => [r.departmentId, r.locationId, r.reportingManagerId, r.legalEntityId, r.jobTitleId]).filter((x): x is string => !!x))];
      const [depts, locs, mgrs, les, titles] = await Promise.all([
        prisma.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), prisma.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
        prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }), prisma.legalEntity.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
        prisma.jobTitle.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      ]);
      const n = new Map<string, string>([...depts, ...locs, ...les, ...titles].map((x) => [x.id, x.name]));
      for (const m of mgrs) n.set(m.id, m.displayName ?? "");
      const name = (id: string | null) => (id ? n.get(id) ?? "" : "");
      return { header: ["Effective", "Employee number", "Name", "Kind", "Status", "Title", "Department", "Location", "Manager", "Legal entity", "Note"], rows: rows.map((r) => [d(r.effectiveFrom), r.employee.employeeNumber, r.employee.displayName, r.reason, r.status, name(r.jobTitleId), name(r.departmentId), name(r.locationId), name(r.reportingManagerId), name(r.legalEntityId), r.note]) };
    },
  },
  "personal-info": {
    perm: P.EMPLOYEE_UPDATE, label: "personal information records",
    build: async (v) => {
      const people = await prisma.employee.findMany({ where: { AND: [{ tenantId: v.tenantId }, scopedEmployeeWhere(v, P.EMPLOYEE_UPDATE)] }, select: { id: true, employeeNumber: true, displayName: true, gender: true, dateOfBirth: true, maritalStatus: true, bloodGroup: true, nationality: true, personalEmail: true, mobile: true, updatedAt: true }, orderBy: { employeeNumber: "asc" }, take: MAX });
      const extras = await prisma.employeeProfileExtra.findMany({ where: { employeeId: { in: people.map((p) => p.id) } } });
      const x = new Map(extras.map((e) => [e.employeeId, e]));
      return { header: ["Employee number", "Name", "Salutation", "Pronouns", "Gender", "Date of birth", "Marital status", "Blood group", "Nationality", "Languages", "Personal email", "Personal email verified", "Mobile", "Last updated"], rows: people.map((p) => { const e = x.get(p.id); return [p.employeeNumber, p.displayName, e?.salutation, e?.pronouns, p.gender, d(p.dateOfBirth), p.maritalStatus, p.bloodGroup, p.nationality, e?.languages.join("; "), p.personalEmail, !!e?.personalEmailVerifiedAt && e.verifiedEmail === p.personalEmail, p.mobile, d(p.updatedAt)]; }) };
    },
  },
  "attendance-requests": {
    label: "attendance requests",
    build: async (v, q) => {
      const ids = can(v, P.ATTENDANCE_MANAGE) ? null : [...(await teamIds(v)), ...(v.employee ? [v.employee.id] : [])];
      const from = rosterDate(q.get("from") ?? "") ?? new Date(Date.now() - 90 * DAY);
      const rows = await prisma.attendanceRequest.findMany({ where: { tenantId: v.tenantId, fromDate: { gte: from }, ...(ids ? { employeeId: { in: ids } } : {}) }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { fromDate: "desc" }, take: MAX });
      return { header: ["Employee number", "Name", "Type", "From", "To", "Reason", "Status", "Decided"], rows: rows.map((r) => [r.employee.employeeNumber, r.employee.displayName, r.type, d(r.fromDate), d(r.toDate), r.reason, r.status, d(r.decidedAt)]) };
    },
  },
  roster: {
    label: "roster days",
    build: async (v, q) => {
      const ids = await teamIds(v, true);
      const from = rosterDate(q.get("from") ?? "") ?? new Date(new Date().setUTCHours(0, 0, 0, 0));
      if (!ids.length) return { header: ["Employee number", "Name", "Date", "Shift", "Off", "Set on roster"], rows: [] };
      const [grid, people, shifts] = await Promise.all([rosterGrid(ids, from, 14), prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, employeeNumber: true } }), prisma.shift.findMany({ where: { tenantId: v.tenantId }, select: { id: true, code: true } })]);
      const code = new Map(shifts.map((s) => [s.id, s.code]));
      return { header: ["Employee number", "Name", "Date", "Shift", "Off", "Set on roster"], rows: people.flatMap((p) => (grid.get(p.id) ?? []).map((c) => [p.employeeNumber, p.displayName, c.date, c.off ? "" : code.get(c.shiftId ?? "") ?? "", c.off, c.explicit])) };
    },
  },
  "manager-dashboard": {
    label: "team members",
    build: async (v) => {
      const team = await managedTeam(v);
      const ids = [...team.keys()];
      const today = new Date(new Date().setUTCHours(0, 0, 0, 0));
      const [people, leave, owed] = await Promise.all([
        prisma.employee.findMany({ where: { tenantId: v.tenantId, id: { in: ids } }, select: { id: true, employeeNumber: true, displayName: true, jobTitleName: true, status: true, dateOfJoining: true, profileCompletion: true, probation: { select: { endDate: true } } }, orderBy: { firstName: "asc" } }),
        prisma.leaveRequest.findMany({ where: { tenantId: v.tenantId, employeeId: { in: ids }, status: { in: ["APPROVED", "PENDING"] }, fromDate: { lte: today }, toDate: { gte: today } }, select: { employeeId: true, status: true } }),
        prisma.employeeDocument.groupBy({ by: ["employeeId"], where: { tenantId: v.tenantId, employeeId: { in: ids }, status: "PENDING_ON_EMPLOYEE" }, _count: { _all: true } }),
      ]);
      return { header: ["Employee number", "Name", "Role", "Link to you", "Status", "Joined", "Probation ends", "Profile %", "Today", "Documents owed"], rows: people.map((p) => [p.employeeNumber, p.displayName, p.jobTitleName, team.get(p.id), p.status, d(p.dateOfJoining), d(p.probation?.endDate), p.profileCompletion ?? 0, leave.find((l) => l.employeeId === p.id && l.status === "APPROVED") ? "On leave" : "", owed.find((o) => o.employeeId === p.id)?._count._all ?? 0]) };
    },
  },
  "id-cards": {
    perm: P.EMPLOYEE_UPDATE, label: "ID cards",
    build: async (v) => {
      const [cards, requests] = await Promise.all([
        prisma.employeeIdCard.findMany({ where: { tenantId: v.tenantId }, orderBy: { issuedAt: "desc" }, take: MAX }),
        prisma.idCardRequest.findMany({ where: { tenantId: v.tenantId, status: "PENDING" } }),
      ]);
      const people = await prisma.employee.findMany({ where: { id: { in: [...cards.map((c) => c.employeeId), ...requests.map((r) => r.employeeId)] } }, select: { id: true, displayName: true, employeeNumber: true } });
      const n = new Map(people.map((p) => [p.id, p]));
      return { header: ["Employee number", "Name", "Card number", "Issued", "Valid until", "Status", "Revoked"], rows: [...cards.map((c) => [n.get(c.employeeId)?.employeeNumber, n.get(c.employeeId)?.displayName, c.cardNumber, d(c.issuedAt), d(c.validUntil), c.status, d(c.revokedAt)]), ...requests.map((r) => [n.get(r.employeeId)?.employeeNumber, n.get(r.employeeId)?.displayName, "", "", "", `REQUESTED (${r.reason})`, ""])] };
    },
  },
};

async function audit(viewer: Viewer, kind: string, summary: string) {
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "Core2Export", entityId: kind, summary, actorId: viewer.user.id, actorLabel: viewer.user.email } });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { kind } = await params;
  const stamp = new Date().toISOString().slice(0, 10);
  // The whole configuration as a file another environment can import.
  if (kind === "configuration-json") {
    if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
    const payload = await captureConfig(viewer.tenantId);
    await audit(viewer, kind, "Exported the configuration (JSON)");
    return new NextResponse(JSON.stringify(payload, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="boos-hr-configuration-${stamp}.json"`, "Cache-Control": "no-store" } });
  }
  // A blank import template for one kind of reference data.
  if (kind === "reference-template") {
    if (!can(viewer, P.ORG_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
    const k = req.nextUrl.searchParams.get("kind") ?? "";
    if (!(k in REFERENCE_IMPORT_KINDS)) return new NextResponse("Unknown template.", { status: 404 });
    return new NextResponse("﻿" + referenceTemplateCsv(k as ReferenceImportKind), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${k.toLowerCase()}-template.csv"`, "Cache-Control": "no-store" } });
  }
  const spec = EXPORTS[kind];
  if (!spec) return new NextResponse("Unknown export.", { status: 404 });
  if (spec.perm && !can(viewer, spec.perm)) return new NextResponse("Forbidden.", { status: 403 });
  const t = await spec.build(viewer, req.nextUrl.searchParams);
  const csv = safeCsv(t.header, t.rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : typeof c === "boolean" ? (c ? "Yes" : "No") : c))));
  await audit(viewer, kind, `Exported ${t.rows.length} ${spec.label}`);
  return new NextResponse("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}-${stamp}.csv"`, "Cache-Control": "no-store" } });
}
