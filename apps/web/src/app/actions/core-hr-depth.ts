"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  raiseChangeRequest, decideChangeRequest, withdrawChangeRequest, approvalRequired, fiscalYearIssues, canDecideChange,
  isChangeTarget, CHANGE_TARGETS, CALENDAR_SETS, wouldCreateCycle, typedChanges,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { isHrForRequest, isManagerOf } from "@/lib/core-hr";
import {
  z, parseForm, formList, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zOptionalId, zId, zDate, zRequiredDate, zBool, zNumber, zRequiredNumber, zEmail,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Core HR depth for administrators: company profile, fiscal years and
 * working rules (each optionally approved by a second administrator),
 * divisions and teams, dotted-line managers, effective-dated org changes,
 * and deciding any change request.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const plain = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Date ? iso(v) : v && typeof v === "object" && "toString" in v && !Array.isArray(v) ? String(v) : v]));

/**
 * Apply a configuration change now, or — when the company asked for these
 * to be approved, or the person chose "send for approval" — raise a change
 * request for someone else to decide.
 */
async function applyOrPropose(viewer: Viewer, formData: FormData, input: {
  targetType: string; targetId?: string | null; operation?: "CREATE" | "UPDATE" | "DELETE"; title: string;
  changes: Record<string, unknown>; previous?: Record<string, unknown> | null; effectiveDate?: Date | null;
  apply: () => Promise<ActionState>; paths: string[];
}): Promise<ActionState> {
  const future = !!input.effectiveDate && input.effectiveDate > new Date();
  const propose = formData.get("propose") === "on" || future || await approvalRequired(viewer.tenantId, input.targetType);
  if (!propose) return input.apply();
  const res = await raiseChangeRequest({
    tenantId: viewer.tenantId, targetType: input.targetType, targetId: input.targetId ?? null, operation: input.operation ?? "UPDATE",
    title: input.title, changes: plain(input.changes), previous: input.previous ? plain(input.previous) : null,
    reason: String(formData.get("reason") ?? "").trim() || null, effectiveDate: input.effectiveDate ?? null,
    requestedBy: viewer.user.id, requestedByEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ChangeRequest", entityId: res.id, summary: `Asked for approval: ${input.title}` });
  return done([...input.paths, "/admin/change-requests"], `${res.message} It takes effect once another administrator approves it${future ? ` (on ${iso(input.effectiveDate)})` : ""}.`);
}

// ---------------------------------------------------------------------------
//  Company profile
// ---------------------------------------------------------------------------

const companySchema = z.object({
  legalName: zOptional(200), brandName: zOptional(120), industry: zOptional(80), website: zOptional(200), email: zEmail(), phone: zOptional(30),
  addressLine1: zOptional(200), addressLine2: zOptional(200), city: zOptional(80), state: zOptional(80), postalCode: zOptional(12),
  foundedYear: zNumber({ min: 1800, max: 2100 }), about: zOptional(2000),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1266a8").default("#1266a8"),
  locale: z.enum(["en-IN", "en-US", "en-GB"]).default("en-IN"),
  dateFormat: z.enum(["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD MMM YYYY"]).default("DD/MM/YYYY"),
});

export async function saveCompanyProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(companySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.website && !/^https?:\/\/[^\s]+\.[^\s]+$/.test(d.website)) return { ok: false, message: "The website must start with http:// or https://", errors: { website: "Not a web address" } };
  const before = await prisma.companyProfile.findUnique({ where: { tenantId: viewer.tenantId } });
  const previous = before ? Object.fromEntries(Object.keys(d).map((k) => [k, (before as Record<string, unknown>)[k] ?? null])) : null;
  return applyOrPropose(viewer, formData, {
    targetType: "COMPANY_PROFILE", targetId: viewer.tenantId, title: "Update the company profile", changes: d, previous, paths: ["/admin/company"],
    apply: async () => {
      await prisma.companyProfile.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...d, updatedBy: viewer.user.id }, update: { ...d, updatedBy: viewer.user.id } });
      await writeAudit(viewer, { module: "SYSTEM", action: before ? "UPDATE" : "CREATE", entityType: "CompanyProfile", entityId: viewer.tenantId, summary: "Updated the company profile", oldValue: previous, newValue: d });
      return done(["/admin/company"], "Saved the company profile.");
    },
  });
}

// ---------------------------------------------------------------------------
//  Fiscal years
// ---------------------------------------------------------------------------

const fySchema = z.object({
  id: zOptionalId(), name: zName(40), calendarSet: z.enum(CALENDAR_SETS).default("STATUTORY"),
  startDate: zRequiredDate(), endDate: zRequiredDate(), status: z.enum(["OPEN", "CLOSED"]).default("OPEN"),
  isCurrent: zBool(), note: zOptional(300),
});

export async function saveFiscalYearAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(fySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const existing = await prisma.fiscalYear.findMany({ where: { tenantId: viewer.tenantId } });
  const cur = id ? existing.find((y) => y.id === id) : null;
  if (id && !cur) return { ok: false, message: "Fiscal year not found." };
  const issues = fiscalYearIssues({ id, calendarSet: d.calendarSet, startDate: d.startDate, endDate: d.endDate }, existing);
  if (issues.length) return { ok: false, message: issues.join(" "), errors: { endDate: issues[0] } };
  if (existing.some((y) => y.id !== id && y.calendarSet === d.calendarSet && y.name.toLowerCase() === d.name.toLowerCase())) return { ok: false, message: "Another year in this calendar set has that name.", errors: { name: "Already used" } };
  const previous = cur ? { name: cur.name, calendarSet: cur.calendarSet, startDate: cur.startDate, endDate: cur.endDate, status: cur.status, isCurrent: cur.isCurrent, note: cur.note } : null;
  return applyOrPropose(viewer, formData, {
    targetType: "FISCAL_YEAR", targetId: id, operation: id ? "UPDATE" : "CREATE", title: `${id ? "Update" : "Add"} fiscal year ${d.name}`,
    changes: d, previous, paths: ["/admin/company"],
    apply: async () => {
      const row = await prisma.$transaction(async (tx) => {
        if (d.isCurrent) await tx.fiscalYear.updateMany({ where: { tenantId: viewer.tenantId, calendarSet: d.calendarSet }, data: { isCurrent: false } });
        return id ? tx.fiscalYear.update({ where: { id }, data: d }) : tx.fiscalYear.create({ data: { tenantId: viewer.tenantId, ...d, createdBy: viewer.user.id } });
      });
      await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "FiscalYear", entityId: row.id, summary: `${id ? "Updated" : "Added"} fiscal year ${d.name} (${iso(d.startDate)} to ${iso(d.endDate)})`, oldValue: previous ? plain(previous) : null, newValue: plain(d) });
      return done(["/admin/company"], `${id ? "Saved" : "Added"} ${d.name}.`);
    },
  });
}

export async function deleteFiscalYearAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const fy = await prisma.fiscalYear.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!fy) return { ok: false, message: "Fiscal year not found." };
  if (fy.isCurrent) return { ok: false, message: "Make another year current before deleting this one." };
  if (fy.status === "CLOSED") return { ok: false, message: "A closed year is kept for the record." };
  return applyOrPropose(viewer, formData, {
    targetType: "FISCAL_YEAR", targetId: fy.id, operation: "DELETE", title: `Delete fiscal year ${fy.name}`, changes: {}, paths: ["/admin/company"],
    apply: async () => {
      await prisma.fiscalYear.delete({ where: { id: fy.id } });
      await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "FiscalYear", entityId: fy.id, summary: `Deleted fiscal year ${fy.name}` });
      return done(["/admin/company"], `Deleted ${fy.name}.`);
    },
  });
}

// ---------------------------------------------------------------------------
//  Working rules
// ---------------------------------------------------------------------------

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const rulesSchema = z.object({
  weekStartsOn: z.enum(DAYS).default("MON"),
  standardHoursPerDay: zRequiredNumber({ min: 1, max: 16 }),
  standardHoursPerWeek: zRequiredNumber({ min: 1, max: 96 }),
  halfDayMinHours: zRequiredNumber({ min: 0.5, max: 12 }),
  maxConsecutiveWorkDays: zRequiredNumber({ min: 1, max: 14 }),
  overtimeAfterHours: zRequiredNumber({ min: 1, max: 24 }),
  maxSpanOfControl: zRequiredNumber({ min: 1, max: 100 }),
});

export async function saveWorkingRulesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(rulesSchema, formData);
  if (parsed.state) return parsed.state;
  const workDays = DAYS.filter((dd) => formList(formData, "workDays").includes(dd));
  if (workDays.length === 0) return { ok: false, message: "Pick at least one working day.", errors: { workDays: "Required" } };
  const d = { ...parsed.data, workDays };
  if (d.halfDayMinHours > d.standardHoursPerDay) return { ok: false, message: "A half day cannot need more hours than a full day.", errors: { halfDayMinHours: "Too high" } };
  if (d.standardHoursPerWeek > d.standardHoursPerDay * workDays.length + 0.001) return { ok: false, message: `Weekly hours are more than ${workDays.length} standard day(s) add up to.`, errors: { standardHoursPerWeek: "Too high" } };
  if (d.overtimeAfterHours < d.standardHoursPerDay) return { ok: false, message: "Overtime should start at or after the standard day.", errors: { overtimeAfterHours: "Too low" } };
  const before = await prisma.workingRules.findUnique({ where: { tenantId: viewer.tenantId } });
  const previous = before ? plain({ workDays: before.workDays, weekStartsOn: before.weekStartsOn, standardHoursPerDay: before.standardHoursPerDay, standardHoursPerWeek: before.standardHoursPerWeek, halfDayMinHours: before.halfDayMinHours, maxConsecutiveWorkDays: before.maxConsecutiveWorkDays, overtimeAfterHours: before.overtimeAfterHours, maxSpanOfControl: before.maxSpanOfControl }) : null;
  return applyOrPropose(viewer, formData, {
    targetType: "WORKING_RULES", targetId: viewer.tenantId, title: "Update the working rules", changes: d, previous, paths: ["/admin/company"],
    apply: async () => {
      await prisma.workingRules.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...d, updatedBy: viewer.user.id }, update: { ...d, updatedBy: viewer.user.id } });
      await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "WorkingRules", entityId: viewer.tenantId, summary: `Working rules: ${workDays.join(", ")}, ${d.standardHoursPerDay}h a day`, oldValue: previous, newValue: d });
      return done(["/admin/company", "/team/dashboard"], "Saved the working rules.");
    },
  });
}

// ---------------------------------------------------------------------------
//  Which changes need approval
// ---------------------------------------------------------------------------

export async function saveChangeApprovalSettingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const targetType = String(formData.get("targetType") ?? "");
  if (!isChangeTarget(targetType) || CHANGE_TARGETS[targetType].category === "PROFILE" || CHANGE_TARGETS[targetType].category === "CORRECTION") return { ok: false, message: "Unknown kind of change." };
  const requireApproval = formData.get("requireApproval") === "on";
  await prisma.changeApprovalSetting.upsert({
    where: { tenantId_targetType: { tenantId: viewer.tenantId, targetType } },
    create: { tenantId: viewer.tenantId, targetType, requireApproval, updatedBy: viewer.user.id },
    update: { requireApproval, updatedBy: viewer.user.id },
  });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ChangeApprovalSetting", entityId: targetType, summary: `${CHANGE_TARGETS[targetType].label} changes ${requireApproval ? "now need a second administrator's approval" : "apply directly"}` });
  return done(["/admin/company"], `${CHANGE_TARGETS[targetType].label}: ${requireApproval ? "approval required" : "applies directly"}.`);
}

// ---------------------------------------------------------------------------
//  Deciding and withdrawing change requests
// ---------------------------------------------------------------------------

export async function decideChangeRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const approve = String(formData.get("decision")) === "approve";
  const note = String(formData.get("note") ?? "").trim() || null;
  const r = await prisma.changeRequest.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Change request not found." };
  const isHr = await isHrForRequest(viewer, r);
  const managesThem = r.employeeId ? await isManagerOf(viewer, r.employeeId) : false;
  const allowed = canDecideChange(r, { userId: viewer.user.id, isHr, managerOf: () => managesThem });
  if (!allowed.ok) return { ok: false, message: allowed.reason! };
  try {
    const res = await decideChangeRequest({ tenantId: viewer.tenantId, id, userId: viewer.user.id, approve, note });
    if (!res.ok && !res.status) return { ok: false, message: res.message };
    await writeAudit(viewer, {
      module: r.category === "PROFILE" || r.category === "CORRECTION" ? "EMPLOYEE" : "SYSTEM", action: approve ? "APPROVE" : "REJECT",
      entityType: "ChangeRequest", entityId: id, summary: `${approve ? "Approved" : "Rejected"}: ${r.title}${note ? ` — ${note}` : ""}`,
    });
    return { ...done(["/admin/change-requests", "/inbox", "/me/requests", "/org", "/org/units", "/admin/company", r.employeeId ? `/employees/${r.employeeId}` : "/employees"], res.message), ok: res.ok };
  } catch (err) {
    return toErrorState(err);
  }
}

export async function withdrawChangeRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const res = await withdrawChangeRequest({ tenantId: viewer.tenantId, id, userId: viewer.user.id });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ChangeRequest", entityId: id, summary: res.message });
  return done(["/admin/change-requests", "/me/requests"], res.message);
}

// ---------------------------------------------------------------------------
//  Divisions and teams
// ---------------------------------------------------------------------------

async function inTenant(viewer: Viewer, refs: { employee?: string | null; businessUnit?: string | null; department?: string | null; division?: string | null }): Promise<string | null> {
  const t = viewer.tenantId;
  if (refs.employee && !(await prisma.employee.findFirst({ where: { id: refs.employee, tenantId: t }, select: { id: true } }))) return "That person is not in this company.";
  if (refs.businessUnit && !(await prisma.businessUnit.findFirst({ where: { id: refs.businessUnit, tenantId: t }, select: { id: true } }))) return "Business unit not found.";
  if (refs.department && !(await prisma.department.findFirst({ where: { id: refs.department, tenantId: t }, select: { id: true } }))) return "Department not found.";
  if (refs.division && !(await prisma.division.findFirst({ where: { id: refs.division, tenantId: t }, select: { id: true } }))) return "Division not found.";
  return null;
}

const divisionSchema = z.object({
  id: zOptionalId(), name: zName(80), code: zOptional(20), description: zOptional(300),
  businessUnitId: zOptionalId(), headId: zOptionalId(), effectiveFrom: zDate(), isActive: zBool(),
});

export async function saveDivisionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(divisionSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const data = { ...d, isActive: id ? d.isActive : true };
  const bad = await inTenant(viewer, { employee: d.headId, businessUnit: d.businessUnitId });
  if (bad) return { ok: false, message: bad };
  try {
    if (id) {
      const before = await prisma.division.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Division not found." };
      await prisma.division.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Division", entityId: id, summary: `Updated division ${d.name}`, oldValue: { name: before.name, headId: before.headId, businessUnitId: before.businessUnitId, isActive: before.isActive }, newValue: { name: d.name, headId: d.headId, businessUnitId: d.businessUnitId, isActive: data.isActive } });
      return done(["/org/units"], `Saved ${d.name}.`);
    }
    const row = await prisma.division.create({ data: { tenantId: viewer.tenantId, ...data } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Division", entityId: row.id, summary: `Created division ${d.name}` });
    return done(["/org/units"], `Created ${d.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

export async function deleteDivisionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const div = await prisma.division.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!div) return { ok: false, message: "Division not found." };
  const [depts, teams] = await Promise.all([
    prisma.department.count({ where: { tenantId: viewer.tenantId, divisionId: div.id } }),
    prisma.orgTeam.count({ where: { tenantId: viewer.tenantId, divisionId: div.id } }),
  ]);
  if (depts + teams > 0) return { ok: false, message: `${depts} department(s) and ${teams} team(s) sit in ${div.name}. Move them first, or mark it inactive.` };
  await prisma.division.delete({ where: { id: div.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "Division", entityId: div.id, summary: `Deleted division ${div.name}` });
  return done(["/org/units"], `Deleted ${div.name}.`);
}

/** Put a department in a division (or take it out). */
export async function setDepartmentDivisionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const departmentId = String(formData.get("departmentId") ?? "");
  const divisionId = String(formData.get("divisionId") ?? "") || null;
  const bad = await inTenant(viewer, { department: departmentId, division: divisionId });
  if (bad) return { ok: false, message: bad };
  const dept = await prisma.department.findFirstOrThrow({ where: { id: departmentId, tenantId: viewer.tenantId } });
  await prisma.department.update({ where: { id: departmentId }, data: { divisionId } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Department", entityId: departmentId, summary: `${divisionId ? "Moved" : "Took"} department ${dept.name} ${divisionId ? "into a division" : "out of its division"}`, oldValue: { divisionId: dept.divisionId }, newValue: { divisionId } });
  return done(["/org/units", "/org"], "Saved.");
}

const teamSchema = z.object({
  id: zOptionalId(), name: zName(80), code: zOptional(20), description: zOptional(300),
  departmentId: zOptionalId(), divisionId: zOptionalId(), leadId: zOptionalId(), effectiveFrom: zDate(),
  isCrossFunctional: zBool(), isActive: zBool(),
});

export async function saveTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(teamSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const data = { ...d, isActive: id ? d.isActive : true };
  const bad = await inTenant(viewer, { employee: d.leadId, department: d.departmentId, division: d.divisionId });
  if (bad) return { ok: false, message: bad };
  try {
    if (id) {
      const before = await prisma.orgTeam.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Team not found." };
      await prisma.orgTeam.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgTeam", entityId: id, summary: `Updated team ${d.name}`, oldValue: { name: before.name, leadId: before.leadId, isActive: before.isActive }, newValue: { name: d.name, leadId: d.leadId, isActive: data.isActive } });
      return done(["/org/units"], `Saved ${d.name}.`);
    }
    const row = await prisma.orgTeam.create({ data: { tenantId: viewer.tenantId, ...data, members: d.leadId ? { create: [{ employeeId: d.leadId, role: "Lead" }] } : undefined } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "OrgTeam", entityId: row.id, summary: `Created team ${d.name}` });
    return done(["/org/units"], `Created ${d.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

export async function deleteTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const team = await prisma.orgTeam.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { members: true } } } });
  if (!team) return { ok: false, message: "Team not found." };
  await prisma.orgTeam.delete({ where: { id: team.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "OrgTeam", entityId: team.id, summary: `Deleted team ${team.name} (${team._count.members} member(s))` });
  return done(["/org/units"], `Deleted ${team.name}.`);
}

export async function addTeamMembersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const team = await prisma.orgTeam.findFirst({ where: { id: String(formData.get("teamId") ?? ""), tenantId: viewer.tenantId } });
  if (!team) return { ok: false, message: "Team not found." };
  const ids = [...new Set(formList(formData, "employeeId"))];
  if (ids.length === 0) return { ok: false, message: "Choose who to add." };
  const emps = await prisma.employee.findMany({ where: { id: { in: ids }, tenantId: viewer.tenantId, status: { not: "EXITED" } }, select: { id: true } });
  if (emps.length !== ids.length) return { ok: false, message: "Someone chosen is not an active employee here." };
  const role = String(formData.get("role") ?? "").trim().slice(0, 60) || null;
  const res = await prisma.orgTeamMember.createMany({ data: emps.map((e) => ({ teamId: team.id, employeeId: e.id, role })), skipDuplicates: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgTeam", entityId: team.id, summary: `Added ${res.count} member(s) to ${team.name}` });
  return done(["/org/units", "/team"], res.count ? `Added ${res.count} to ${team.name}.` : "They are already in the team.");
}

export async function removeTeamMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const m = await prisma.orgTeamMember.findFirst({ where: { id: String(formData.get("id") ?? ""), team: { tenantId: viewer.tenantId } }, include: { team: true } });
  if (!m) return { ok: false, message: "Member not found." };
  await prisma.orgTeamMember.delete({ where: { id: m.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgTeam", entityId: m.teamId, summary: `Removed a member from ${m.team.name}`, oldValue: { employeeId: m.employeeId } });
  return done(["/org/units", "/team"], "Removed.");
}

// ---------------------------------------------------------------------------
//  Dotted-line and L2 managers
// ---------------------------------------------------------------------------

const secondarySchema = z.object({
  managerId: zId(), kind: z.enum(["DOTTED_LINE", "L2"]).default("DOTTED_LINE"),
  effectiveFrom: zDate(), effectiveTo: zDate(), note: zOptional(200),
});

/** Name one or many people's dotted-line (or L2) manager. */
export async function setSecondaryManagersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(secondarySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.effectiveFrom && d.effectiveTo && d.effectiveTo < d.effectiveFrom) return { ok: false, message: "The end date is before the start.", errors: { effectiveTo: "Before the start" } };
  let ids = [...new Set(formList(formData, "employeeId"))];
  const dept = String(formData.get("departmentId") ?? "");
  if (dept) ids = [...ids, ...(await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, departmentId: dept, status: { not: "EXITED" } }, select: { id: true } })).map((e) => e.id)];
  ids = [...new Set(ids)];
  if (ids.length === 0) return { ok: false, message: "Choose the employees, or a department." };
  const all = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, reportingManagerId: true, status: true } });
  const known = new Map(all.map((e) => [e.id, e]));
  if (!known.has(d.managerId) || known.get(d.managerId)!.status === "EXITED") return { ok: false, message: "Choose an active manager from this company." };
  if (ids.some((id) => !known.has(id))) return { ok: false, message: "Someone chosen is not in this company." };
  const managerOf = new Map(all.map((e) => [e.id, e.reportingManagerId]));
  const skipped = ids.filter((id) => wouldCreateCycle(id, d.managerId, managerOf));
  const targets = ids.filter((id) => !skipped.includes(id) && known.get(id)!.reportingManagerId !== d.managerId);
  let saved = 0;
  for (const employeeId of targets) {
    await prisma.secondaryManager.upsert({
      where: { employeeId_managerId_kind: { employeeId, managerId: d.managerId, kind: d.kind } },
      create: { tenantId: viewer.tenantId, employeeId, managerId: d.managerId, kind: d.kind, effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo, note: d.note, createdBy: viewer.user.id },
      update: { effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo, note: d.note },
    });
    saved++;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SecondaryManager", entityId: d.managerId, summary: `Set a ${d.kind === "L2" ? "L2" : "dotted-line"} manager for ${saved} employee(s)${skipped.length ? `; skipped ${skipped.length} (would loop the reporting line)` : ""}`, newValue: { employeeIds: targets } });
  const skippedSame = ids.length - targets.length - skipped.length;
  return done(["/org/units", "/team", "/directory"], `Saved for ${saved} employee(s).${skipped.length ? ` ${skipped.length} skipped: it would loop the reporting line.` : ""}${skippedSame ? ` ${skippedSame} already report to them directly.` : ""}`);
}

export async function removeSecondaryManagerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const row = await prisma.secondaryManager.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Not found." };
  await prisma.secondaryManager.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "SecondaryManager", entityId: row.id, summary: `Removed a ${row.kind === "L2" ? "L2" : "dotted-line"} manager`, oldValue: { employeeId: row.employeeId, managerId: row.managerId } });
  return done(["/org/units", "/team"], "Removed.");
}

// ---------------------------------------------------------------------------
//  Effective-dated org changes
// ---------------------------------------------------------------------------

const ORG_TARGETS = ["DEPARTMENT", "DIVISION", "TEAM", "COST_CENTRE", "LEGAL_ENTITY", "BUSINESS_UNIT", "LOCATION"] as const;
const orgChangeSchema = z.object({
  targetType: z.enum(ORG_TARGETS), targetId: zId(), operation: z.enum(["UPDATE", "DELETE"]).default("UPDATE"),
  name: zOptional(120), code: zOptional(20), headId: zOptionalId(), businessUnitId: zOptionalId(), divisionId: zOptionalId(),
  effectiveDate: zDate(), reason: zOptional(400),
});

const ORG_LOADERS = {
  DEPARTMENT: (id: string, t: string) => prisma.department.findFirst({ where: { id, tenantId: t } }),
  DIVISION: (id: string, t: string) => prisma.division.findFirst({ where: { id, tenantId: t } }),
  TEAM: (id: string, t: string) => prisma.orgTeam.findFirst({ where: { id, tenantId: t } }),
  COST_CENTRE: (id: string, t: string) => prisma.costCenter.findFirst({ where: { id, tenantId: t } }),
  LEGAL_ENTITY: (id: string, t: string) => prisma.legalEntity.findFirst({ where: { id, tenantId: t } }),
  BUSINESS_UNIT: (id: string, t: string) => prisma.businessUnit.findFirst({ where: { id, tenantId: t } }),
  LOCATION: (id: string, t: string) => prisma.location.findFirst({ where: { id, tenantId: t } }),
} as const;

/**
 * Propose a change to an org unit — rename, new head, move under another
 * business unit or division, or retire it — effective on a date, for a
 * second administrator to approve. The nightly job applies it on its date.
 */
export async function proposeOrgChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // The page's picker sends one "TYPE:id" value; split it into the two fields.
  const target = String(formData.get("target") ?? "");
  if (target.includes(":") && !formData.get("targetType")) {
    const [type, id] = target.split(":");
    formData.set("targetType", type ?? "");
    formData.set("targetId", id ?? "");
  }
  const parsed = parseForm(orgChangeSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const viewer = await requireAuth(d.targetType === "LEGAL_ENTITY" ? P.ORG_ENTITY_MANAGE : P.ORG_MANAGE);
  const unit = await ORG_LOADERS[d.targetType](d.targetId, viewer.tenantId) as Record<string, unknown> | null;
  if (!unit) return { ok: false, message: "That unit was not found." };
  const bad = await inTenant(viewer, { employee: d.headId, businessUnit: d.businessUnitId, division: d.divisionId });
  if (bad) return { ok: false, message: bad };
  const allowed = new Set<string>(CHANGE_TARGETS[d.targetType].fields);
  const headKey = d.targetType === "TEAM" ? "leadId" : "headId";
  const candidate: Record<string, unknown> = { name: d.name, code: d.code, [headKey]: d.headId, businessUnitId: d.businessUnitId, divisionId: d.divisionId };
  const changes = Object.fromEntries(Object.entries(candidate).filter(([k, v]) => v !== null && v !== undefined && allowed.has(k) && v !== unit[k]));
  if (d.operation === "UPDATE" && Object.keys(changes).length === 0) return { ok: false, message: "Nothing would change. Fill in what should be different." };
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, unit[k] ?? null]));
  const label = CHANGE_TARGETS[d.targetType].label;
  const res = await raiseChangeRequest({
    tenantId: viewer.tenantId, targetType: d.targetType, targetId: d.targetId, operation: d.operation,
    title: d.operation === "DELETE" ? `Retire ${label.toLowerCase()} ${unit.name}` : `Change ${label.toLowerCase()} ${unit.name}`,
    changes, previous, reason: d.reason, effectiveDate: d.effectiveDate, requestedBy: viewer.user.id, requestedByEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ChangeRequest", entityId: res.id, summary: `Proposed an org change: ${label} ${unit.name}${d.effectiveDate ? ` effective ${iso(d.effectiveDate)}` : ""}`, newValue: typedChanges(changes) });
  return done(["/org/units", "/admin/change-requests"], `${res.message} It applies ${d.effectiveDate ? `on ${iso(d.effectiveDate)}` : "as soon as it is approved"}.`);
}
