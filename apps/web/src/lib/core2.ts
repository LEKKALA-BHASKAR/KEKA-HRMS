import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { resolveInherited, ancestorsOf, coworkerSuggestions, type UnitRef, type HrTransactionType } from "@keka/services";
import type { Viewer } from "./context";

/**
 * Shared reads for the second core HR pass: the brand and personal
 * appearance the portal uses for a viewer, an employee's chain of org units
 * (for metadata and policy-pack inheritance), and the effective policy
 * packs and metadata of a unit.
 */

/** The branding profile for a viewer: their business unit's, else their entity's, else the default. */
export async function brandingForViewer(viewer: Viewer) {
  const profiles = await prisma.brandingProfile.findMany({ where: { tenantId: viewer.tenantId, isActive: true } });
  if (!profiles.length) return null;
  const emp = viewer.employee ? await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { businessUnitId: true, legalEntityId: true } }) : null;
  return profiles.find((p) => emp?.businessUnitId && p.businessUnitId === emp.businessUnitId)
    ?? profiles.find((p) => emp?.legalEntityId && p.legalEntityId === emp.legalEntityId && !p.businessUnitId)
    ?? profiles.find((p) => p.isDefault)
    ?? null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** CSS the shell adds for a viewer: their brand's colours and their accessibility choices. */
export function appearanceCss(brand: { primaryColor: string; accentColor: string } | null, pref: { fontScale: number; highContrast: boolean; reducedMotion: boolean; underlineLinks: boolean } | null): string {
  const rules: string[] = [];
  if (brand && HEX.test(brand.primaryColor)) rules.push(`:root{--brand-500:${brand.primaryColor};--brand-600:${brand.primaryColor};--brand-700:${brand.primaryColor};}`);
  if (pref) {
    if ([100, 115, 130].includes(pref.fontScale) && pref.fontScale !== 100) rules.push(`html{font-size:${pref.fontScale}%;}`);
    if (pref.highContrast) rules.push(":root{--text:#000000;--text-muted:#1f2430;--text-subtle:#2e3442;--border:#4a5263;}");
    if (pref.reducedMotion) rules.push("*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important;}");
    if (pref.underlineLinks) rules.push("a{text-decoration:underline;}");
  }
  return rules.join("\n");
}

/**
 * The org units an employee sits in, nearest first: their department and
 * its parents, the department's division, their business unit and its
 * parents, then their legal entity.
 */
export async function unitChainForEmployee(tenantId: string, employeeId: string): Promise<UnitRef[]> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { departmentId: true, businessUnitId: true, legalEntityId: true } });
  if (!emp) return [];
  const [depts, units] = await Promise.all([
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, divisionId: true } }),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true } }),
  ]);
  return unitChain({ departmentId: emp.departmentId, businessUnitId: emp.businessUnitId, legalEntityId: emp.legalEntityId }, depts, units);
}

export function unitChain(at: { departmentId: string | null; businessUnitId: string | null; legalEntityId: string | null }, depts: Array<{ id: string; name: string; parentId: string | null; divisionId: string | null }>, units: Array<{ id: string; name: string; parentId: string | null }>): UnitRef[] {
  const chain: UnitRef[] = [];
  const dParent = new Map(depts.map((d) => [d.id, d.parentId]));
  const dName = new Map(depts.map((d) => [d.id, d]));
  if (at.departmentId) for (const id of ancestorsOf(at.departmentId, dParent)) chain.push({ unitType: "DEPARTMENT", unitId: id, label: dName.get(id)?.name });
  const division = at.departmentId ? dName.get(at.departmentId)?.divisionId : null;
  if (division) chain.push({ unitType: "DIVISION", unitId: division });
  const uParent = new Map(units.map((u) => [u.id, u.parentId]));
  const uName = new Map(units.map((u) => [u.id, u.name]));
  if (at.businessUnitId) for (const id of ancestorsOf(at.businessUnitId, uParent)) chain.push({ unitType: "BUSINESS_UNIT", unitId: id, label: uName.get(id) });
  if (at.legalEntityId) chain.push({ unitType: "LEGAL_ENTITY", unitId: at.legalEntityId });
  return chain;
}

/** Policy packs in force for a chain of units: the nearest unit that has any wins. */
export async function policyPacksFor(tenantId: string, chain: UnitRef[]) {
  if (!chain.length) return { packs: [], from: null as UnitRef | null, inherited: false };
  const assignments = await prisma.policyPackAssignment.findMany({ where: { pack: { tenantId, isActive: true }, OR: chain.map((c) => ({ unitType: c.unitType, unitId: c.unitId })) }, include: { pack: true } });
  const hit = resolveInherited(chain, (u) => {
    const here = assignments.filter((a) => a.unitType === u.unitType && a.unitId === u.unitId);
    return here.length ? here.map((a) => a.pack) : undefined;
  });
  return hit ? { packs: hit.value, from: hit.from, inherited: hit.inherited } : { packs: [], from: null, inherited: false };
}

/**
 * The master-data facts completeness rules and duplicate detection look at,
 * for the current people matching `where` (already tenant- and scope-limited
 * by the caller).
 */
export async function peopleQualityFacts(where: Prisma.EmployeeWhereInput) {
  const rows = await prisma.employee.findMany({
    where: { AND: [where, { status: { not: "EXITED" } }] },
    select: {
      id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, mobile: true, dateOfBirth: true, gender: true,
      maritalStatus: true, bloodGroup: true, nationality: true, departmentId: true, locationId: true, reportingManagerId: true, costCenterId: true, workerTypeId: true,
      bandId: true, legalEntityId: true, jobTitleName: true, updatedAt: true,
      _count: { select: { addresses: true, emergencyContacts: true, bankAccounts: true } },
      identityDocs: { where: { type: "PAN" }, select: { number: true } },
    },
    orderBy: { employeeNumber: "asc" },
  });
  return rows.map((r) => ({
    ...r, pan: r.identityDocs[0]?.number ?? null,
    address: r._count.addresses > 0, emergencyContact: r._count.emergencyContacts > 0, bankAccount: r._count.bankAccounts > 0,
  }));
}

export interface HrPendingItem { type: HrTransactionType; id: string; title: string; createdAt: Date; link: string; owner: string | null; due: Date | null }

/**
 * Every HR transaction still open, across change requests, letter
 * requests, checklists, job changes, ID card and privacy requests — the
 * HR desk's queue, aged and measured against its SLA.
 */
/** JobChange rows carry only an employeeId; attach the employee's name and number. */
export async function withEmployeeNames<T extends { employeeId: string }>(rows: T[]): Promise<Array<T & { employee: { id: string; displayName: string; employeeNumber: string } }>> {
  const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true } });
  const by = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => { const e = by.get(r.employeeId); return { ...r, employee: { id: r.employeeId, displayName: e?.displayName ?? "(unknown)", employeeNumber: e?.employeeNumber ?? "" } }; });
}

export async function hrPendingItems(tenantId: string): Promise<HrPendingItem[]> {
  const [changes, letters, checklists, jobs, cards, privacy] = await Promise.all([
    prisma.recordChangeRequest.findMany({ where: { tenantId, status: "PENDING" }, select: { id: true, title: true, createdAt: true, effectiveDate: true } }),
    prisma.selfServiceDocumentRequest.findMany({ where: { tenantId, status: "PENDING" }, select: { id: true, purpose: true, createdAt: true, type: { select: { name: true } } } }),
    prisma.hrChecklist.findMany({ where: { tenantId, status: { in: ["OPEN", "AWAITING_SIGN_OFF", "REOPENED"] } }, select: { id: true, title: true, createdAt: true, dueDate: true, assignedBy: true } }),
    prisma.jobChange.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "SCHEDULED"] } }, select: { id: true, reason: true, createdAt: true, effectiveFrom: true, status: true, employeeId: true } }).then((rows) => withEmployeeNames(rows)),
    prisma.idCardRequest.findMany({ where: { tenantId, status: "PENDING" }, select: { id: true, reason: true, createdAt: true } }),
    prisma.privacyRequest.findMany({ where: { tenantId, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, kind: true, createdAt: true, dueDate: true } }),
  ]);
  return [
    ...changes.map((c) => ({ type: "CHANGE_REQUEST" as const, id: c.id, title: c.title, createdAt: c.createdAt, link: "/admin/change-requests", owner: null, due: c.effectiveDate })),
    ...letters.map((l) => ({ type: "LETTER_REQUEST" as const, id: l.id, title: `${l.type.name}: ${l.purpose}`, createdAt: l.createdAt, link: "/hr-ops?tab=documents", owner: null, due: null })),
    ...checklists.map((c) => ({ type: "CHECKLIST" as const, id: c.id, title: c.title, createdAt: c.createdAt, link: "/hr-ops?tab=checklists", owner: c.assignedBy, due: c.dueDate })),
    ...jobs.map((j) => ({ type: "JOB_CHANGE" as const, id: j.id, title: `${j.reason.toLowerCase().replace(/_/g, " ")} — ${j.employee.displayName} (${j.status === "SCHEDULED" ? "scheduled" : "awaiting approval"})`, createdAt: j.createdAt, link: "/hr-ops/movements", owner: null, due: j.effectiveFrom })),
    ...cards.map((c) => ({ type: "ID_CARD" as const, id: c.id, title: `ID card (${c.reason.toLowerCase()})`, createdAt: c.createdAt, link: "/inbox", owner: null, due: null })),
    ...privacy.map((p) => ({ type: "PRIVACY" as const, id: p.id, title: `Privacy request (${p.kind.toLowerCase().replace("_", " ")})`, createdAt: p.createdAt, link: "/hr-ops/quality?tab=privacy", owner: null, due: p.dueDate })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Colleagues someone may want to know, from shared manager, team, project, skills, department and office. */
export async function coworkersFor(tenantId: string, employeeId: string) {
  const now = new Date();
  const [people, skills, teams, projects, unlisted] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true, departmentId: true, locationId: true, reportingManagerId: true } }),
    prisma.employeeSkill.findMany({ where: { employee: { tenantId } }, select: { employeeId: true, skillId: true } }),
    prisma.orgTeamMember.findMany({ where: { team: { tenantId, isActive: true } }, select: { employeeId: true, teamId: true } }),
    prisma.resourceAllocation.findMany({ where: { project: { tenantId }, startDate: { lte: now }, OR: [{ endDate: null }, { endDate: { gte: now } }] }, select: { employeeId: true, projectId: true } }),
    prisma.employeeProfileExtra.findMany({ where: { tenantId, hideFromDirectory: true }, select: { employeeId: true } }),
  ]);
  const hidden = new Set(unlisted.map((u) => u.employeeId));
  const group = (rows: Array<{ employeeId: string }>, key: string) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.employeeId, [...(m.get(r.employeeId) ?? []), (r as Record<string, string>)[key]!]);
    return m;
  };
  const sk = group(skills, "skillId"), tm = group(teams, "teamId"), pj = group(projects, "projectId");
  const facts = people.filter((p) => !hidden.has(p.id)).map((p) => ({ id: p.id, departmentId: p.departmentId, locationId: p.locationId, managerId: p.reportingManagerId, skills: sk.get(p.id) ?? [], teams: tm.get(p.id) ?? [], projects: pj.get(p.id) ?? [] }));
  const me = facts.find((f) => f.id === employeeId) ?? { id: employeeId, departmentId: null, locationId: null, managerId: null, skills: [], teams: [], projects: [] };
  const byId = new Map(people.map((p) => [p.id, p]));
  return coworkerSuggestions(me, facts).map((s) => ({ person: byId.get(s.id)!, reasons: s.reasons, score: s.score }));
}

/** Metadata values for a unit, inherited from its parents where the field allows it. */
export async function effectiveMetadata(tenantId: string, chain: UnitRef[]) {
  if (!chain.length) return [];
  const [fields, values] = await Promise.all([
    prisma.orgUnitMetadataField.findMany({ where: { tenantId }, orderBy: { label: "asc" } }),
    prisma.orgUnitMetadataValue.findMany({ where: { tenantId, OR: chain.map((c) => ({ unitType: c.unitType, unitId: c.unitId })) } }),
  ]);
  const own = chain[0]!;
  const keys = [...new Set(fields.filter((f) => f.unitType === own.unitType || f.inheritable).map((f) => f.key))];
  return keys.map((key) => {
    const field = fields.find((f) => f.key === key && f.unitType === own.unitType) ?? fields.find((f) => f.key === key)!;
    const hit = resolveInherited(field.inheritable ? chain : [own], (u) => values.find((v) => v.unitType === u.unitType && v.unitId === u.unitId && v.key === key)?.value);
    return { key, label: field.label, value: hit?.value ?? null, from: hit?.from ?? null, inherited: hit?.inherited ?? false };
  });
}

/** What HR has coming up in the next 60 days, for the HR desk calendar and its export. */
export async function hrCalendarEvents(tenantId: string, now: Date = new Date()): Promise<Array<{ date: Date; kind: string; text: string }>> {
  const DAY = 86_400_000;
  const end = new Date(now.getTime() + 60 * DAY);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [joiners, probations, exits, moves, deadlines, payroll, docs] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, dateOfJoining: { gte: today, lte: end } }, select: { id: true, displayName: true, dateOfJoining: true } }),
    prisma.employeeProbation.findMany({ where: { tenantId, status: "ACTIVE", endDate: { gte: today, lte: end } }, select: { id: true, endDate: true, employee: { select: { displayName: true } } } }),
    prisma.employee.findMany({ where: { tenantId, lastWorkingDay: { gte: today, lte: end } }, select: { id: true, displayName: true, lastWorkingDay: true } }),
    prisma.jobChange.findMany({ where: { tenantId, status: "SCHEDULED", effectiveFrom: { gte: today, lte: end } }, select: { id: true, reason: true, effectiveFrom: true, employeeId: true } }).then((rows) => withEmployeeNames(rows)),
    prisma.entityComplianceDeadline.findMany({ where: { tenantId, status: "OPEN", dueDate: { lte: end } }, select: { id: true, title: true, dueDate: true } }),
    prisma.entityPayrollCalendar.findMany({ where: { tenantId, inputCutoff: { gte: today, lte: end } }, select: { id: true, inputCutoff: true, month: true, year: true } }),
    prisma.employeeIdentity.findMany({ where: { employee: { tenantId, status: { not: "EXITED" } }, expiryDate: { gte: today, lte: end } }, select: { id: true, type: true, expiryDate: true, employee: { select: { displayName: true } } } }),
  ]);
  const events = [
    ...joiners.map((e) => ({ date: e.dateOfJoining, kind: "Joining", text: e.displayName ?? "" })),
    ...probations.map((p) => ({ date: p.endDate, kind: "Probation ends", text: p.employee.displayName ?? "" })),
    ...exits.map((e) => ({ date: e.lastWorkingDay!, kind: "Last day", text: e.displayName ?? "" })),
    ...moves.map((m) => ({ date: m.effectiveFrom, kind: "Move takes effect", text: `${m.employee.displayName} · ${m.reason.toLowerCase().replace(/_/g, " ")}` })),
    ...deadlines.map((d) => ({ date: d.dueDate, kind: d.dueDate < today ? "Overdue filing" : "Compliance deadline", text: d.title })),
    ...payroll.map((p) => ({ date: p.inputCutoff, kind: "Payroll input cut-off", text: `${p.month}/${p.year}` })),
    ...docs.map((d) => ({ date: d.expiryDate!, kind: "Document expires", text: `${d.employee.displayName} · ${d.type.toLowerCase().replace(/_/g, " ")}` })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  return events;
}
