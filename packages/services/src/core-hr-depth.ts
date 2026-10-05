import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { recomputeProfileCompletion } from "./profile";
import { applyStatutoryRegistrationChange } from "./core2";
import {
  CHANGE_TARGETS, cleanChanges, isChangeTarget, statusOnApproval, delegationActive, fiscalYearIssues,
  type ChangeTarget,
} from "./core-hr-depth-math";

/**
 * Core HR depth, the parts that touch the database: raising, deciding and
 * applying change requests (configuration, org units, an employee's own
 * details and data corrections), and working out who counts as someone's
 * manager today — their reporting manager, a dotted-line manager, or anyone
 * acting for either.
 *
 * A request stores only the fields its target allows (see CHANGE_TARGETS),
 * and every applier re-checks that what it points at still belongs to the
 * request's tenant, so an approved request can never write across tenants.
 */

type R = { ok: boolean; message: string };

const DATE_FIELDS = new Set(["dateOfBirth", "startDate", "endDate", "fromDate", "toDate", "effectiveFrom"]);
const INT_FIELDS = new Set(["fromYear", "toYear", "foundedYear", "maxConsecutiveWorkDays", "maxSpanOfControl", "fyStartMonth"]);
const BOOL_FIELDS = new Set(["isActive", "isNominee", "isPrimary", "isCurrent", "restrictByLegalEntity", "restrictByBusinessUnit", "managerReporteeOverride"]);

/** JSON values back to what the columns hold. */
export function typedChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "") { out[k] = null; continue; }
    if (DATE_FIELDS.has(k)) out[k] = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    else if (INT_FIELDS.has(k)) out[k] = Number.parseInt(String(v), 10);
    else if (BOOL_FIELDS.has(k)) out[k] = v === true || v === "true" || v === "on";
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Who manages whom
// ---------------------------------------------------------------------------

/**
 * Employees whose approvals `employeeId` holds today because they delegated
 * to them (or HR named them acting manager).
 */
export async function actingForIds(tenantId: string, employeeId: string, on: Date = new Date()): Promise<string[]> {
  const rows = await prisma.managerDelegation.findMany({ where: { tenantId, delegateId: employeeId, revokedAt: null, startDate: { lte: on } } });
  return [...new Set(rows.filter((d) => delegationActive(d, on)).map((d) => d.delegatorId))];
}

/**
 * Everyone who counts as `employeeId`'s manager today: the reporting
 * manager, active dotted-line / L2 managers, and anyone acting for them.
 */
export async function managersOf(tenantId: string, employeeId: string, on: Date = new Date()): Promise<string[]> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { reportingManagerId: true } });
  if (!emp) return [];
  const secondary = await prisma.secondaryManager.findMany({ where: { tenantId, employeeId } });
  const live = secondary.filter((s) => (!s.effectiveFrom || s.effectiveFrom <= on) && (!s.effectiveTo || s.effectiveTo >= on)).map((s) => s.managerId);
  const direct = [emp.reportingManagerId, ...live].filter((x): x is string => !!x);
  const delegations = direct.length
    ? await prisma.managerDelegation.findMany({ where: { tenantId, delegatorId: { in: direct }, revokedAt: null } })
    : [];
  const acting = delegations.filter((d) => delegationActive(d, on)).map((d) => d.delegateId);
  return [...new Set([...direct, ...acting])];
}

/** The people a manager looks after today: direct reports, dotted-line reports, and the teams of anyone they act for. */
export async function teamOf(tenantId: string, managerId: string, on: Date = new Date()): Promise<{ direct: string[]; dotted: string[]; acting: string[] }> {
  const [direct, dotted, actingFor] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, reportingManagerId: managerId, status: { not: "EXITED" } }, select: { id: true } }),
    prisma.secondaryManager.findMany({ where: { tenantId, managerId } }),
    actingForIds(tenantId, managerId, on),
  ]);
  const acting = actingFor.length
    ? await prisma.employee.findMany({ where: { tenantId, reportingManagerId: { in: actingFor }, status: { not: "EXITED" } }, select: { id: true } })
    : [];
  const live = dotted.filter((s) => (!s.effectiveFrom || s.effectiveFrom <= on) && (!s.effectiveTo || s.effectiveTo >= on));
  return { direct: direct.map((e) => e.id), dotted: [...new Set(live.map((s) => s.employeeId))], acting: acting.map((e) => e.id) };
}

// ---------------------------------------------------------------------------
//  Raising and deciding
// ---------------------------------------------------------------------------

/** Does this tenant want changes to this target approved first? */
export async function approvalRequired(tenantId: string, targetType: string): Promise<boolean> {
  const s = await prisma.changeApprovalSetting.findUnique({ where: { tenantId_targetType: { tenantId, targetType } } });
  return !!s?.requireApproval;
}

export async function raiseChangeRequest(input: {
  tenantId: string; targetType: string; targetId?: string | null; employeeId?: string | null; operation?: "CREATE" | "UPDATE" | "DELETE";
  title: string; changes: Record<string, unknown>; previous?: Record<string, unknown> | null; reason?: string | null;
  effectiveDate?: Date | null; approverType?: "HR" | "MANAGER"; requestedBy: string; requestedByEmployeeId?: string | null;
}): Promise<R & { id?: string }> {
  if (!isChangeTarget(input.targetType)) return { ok: false, message: "Unknown kind of change." };
  const target = CHANGE_TARGETS[input.targetType];
  const changes = cleanChanges(input.targetType, input.changes);
  if (input.operation !== "DELETE" && Object.keys(changes).length === 0) return { ok: false, message: "There is nothing to change." };
  // One open request per thing at a time, so two reviewers never race.
  // A record's own details (personal, contact, bank…) carry no targetId: one per employee.
  const sameThing = input.targetId ? { targetId: input.targetId }
    : input.employeeId && input.operation !== "CREATE" ? { employeeId: input.employeeId, targetId: null }
    : null;
  if (sameThing) {
    const open = await prisma.recordChangeRequest.findFirst({ where: { tenantId: input.tenantId, targetType: input.targetType, ...sameThing, status: { in: ["PENDING", "SCHEDULED"] } }, select: { id: true } });
    if (open) return { ok: false, message: `A change to this ${target.label.toLowerCase()} is already waiting. Decide or withdraw it first.` };
  }
  const row = await prisma.recordChangeRequest.create({
    data: {
      tenantId: input.tenantId, category: target.category, targetType: input.targetType, targetId: input.targetId ?? null,
      employeeId: input.employeeId ?? null, operation: input.operation ?? "UPDATE", title: input.title.slice(0, 200),
      changes: changes as never, previous: (input.previous ?? null) as never, reason: input.reason ?? null,
      effectiveDate: input.effectiveDate ?? null, approverType: input.approverType ?? "HR",
      requestedBy: input.requestedBy, requestedByEmployeeId: input.requestedByEmployeeId ?? null,
    },
  });
  await notifyReviewers(row.id);
  return { ok: true, id: row.id, message: `Sent for approval: ${row.title}.` };
}

/** Tell whoever decides a request that it is waiting. */
async function notifyReviewers(id: string): Promise<void> {
  const r = await prisma.recordChangeRequest.findUniqueOrThrow({ where: { id } });
  let userIds: string[] = [];
  if (r.approverType === "MANAGER" && r.employeeId) {
    const mgrs = await managersOf(r.tenantId, r.employeeId);
    userIds = (await prisma.employee.findMany({ where: { id: { in: mgrs }, tenantId: r.tenantId }, select: { userId: true } })).map((e) => e.userId).filter((u): u is string => !!u);
  }
  if (userIds.length === 0) {
    // HR: whoever holds the permission that decides this category.
    const perm = r.category === "CONFIG" ? "org.settings.manage" : r.category === "ORG" ? "org.structure.manage" : "employee.record.update";
    const holders = await prisma.userRoleAssignment.findMany({
      where: { user: { tenantId: r.tenantId }, role: { permissions: { some: { permission: perm } } } },
      select: { userId: true }, take: 25,
    });
    userIds = holders.map((h) => h.userId);
  }
  await notify({ tenantId: r.tenantId, userIds: userIds.filter((u) => u !== r.requestedBy), kind: "APPROVAL", title: `Approve: ${r.title}`, link: `/admin/change-requests?id=${r.id}` });
}

/**
 * Approve or reject. The caller has already checked the decider may decide
 * (canDecideChange); approval applies the change now or schedules it for its
 * effective date.
 */
export async function decideChangeRequest(input: { tenantId: string; id: string; userId: string; approve: boolean; note?: string | null; today?: Date }): Promise<R & { status?: string }> {
  const r = await prisma.recordChangeRequest.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!r) return { ok: false, message: "Change request not found." };
  if (r.status !== "PENDING") return { ok: false, message: `This request is already ${r.status.toLowerCase()}.` };
  if (r.requestedBy === input.userId) return { ok: false, message: "Someone other than the requester must decide it." };
  if (!input.approve && !input.note?.trim()) return { ok: false, message: "Say why it is rejected." };
  const claimed = await prisma.recordChangeRequest.updateMany({
    where: { id: r.id, status: "PENDING" },
    data: { status: input.approve ? "SCHEDULED" : "REJECTED", decidedBy: input.userId, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
  });
  if (claimed.count === 0) return { ok: false, message: "Someone else decided it first." };
  const requester = r.requestedBy;
  if (!input.approve) {
    await notify({ tenantId: r.tenantId, userIds: [requester], kind: "APPROVAL", title: `Rejected: ${r.title}`, body: input.note ?? undefined, link: "/me/changes" });
    return { ok: true, status: "REJECTED", message: `Rejected: ${r.title}.` };
  }
  if (statusOnApproval(r.effectiveDate, input.today) === "SCHEDULED") {
    await notify({ tenantId: r.tenantId, userIds: [requester], kind: "APPROVAL", title: `Approved: ${r.title}`, body: `Takes effect on ${r.effectiveDate!.toISOString().slice(0, 10)}.`, link: "/me/changes" });
    return { ok: true, status: "SCHEDULED", message: `Approved. It takes effect on ${r.effectiveDate!.toISOString().slice(0, 10)}.` };
  }
  const applied = await applyRecordChangeRequest(r.id);
  await notify({ tenantId: r.tenantId, userIds: [requester], kind: "APPROVAL", title: applied.ok ? `Approved and applied: ${r.title}` : `Approved but not applied: ${r.title}`, body: applied.ok ? undefined : applied.message, link: "/me/changes" });
  return { ok: applied.ok, status: applied.ok ? "APPLIED" : "FAILED", message: applied.ok ? `Approved and applied: ${r.title}.` : `Approved, but it could not be applied: ${applied.message}` };
}

export async function withdrawChangeRequest(input: { tenantId: string; id: string; userId: string }): Promise<R> {
  const r = await prisma.recordChangeRequest.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!r) return { ok: false, message: "Change request not found." };
  if (r.requestedBy !== input.userId) return { ok: false, message: "Only the person who asked can withdraw it." };
  const u = await prisma.recordChangeRequest.updateMany({ where: { id: r.id, status: { in: ["PENDING", "SCHEDULED"] } }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
  if (u.count === 0) return { ok: false, message: `This request is already ${r.status.toLowerCase()}.` };
  return { ok: true, message: `Withdrawn: ${r.title}.` };
}

/** Nightly: apply every approved change whose effective date has arrived. */
export async function applyDueChangeRequests(today: Date = new Date()): Promise<{ applied: number; failed: number }> {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const due = await prisma.recordChangeRequest.findMany({ where: { status: "SCHEDULED", OR: [{ effectiveDate: null }, { effectiveDate: { lt: end } }] }, select: { id: true }, orderBy: { effectiveDate: "asc" } });
  let applied = 0, failed = 0;
  for (const d of due) (await applyRecordChangeRequest(d.id)).ok ? applied++ : failed++;
  return { applied, failed };
}

// ---------------------------------------------------------------------------
//  Applying
// ---------------------------------------------------------------------------

/** Apply an approved request. Idempotent; a failure is recorded on the request. */
export async function applyRecordChangeRequest(id: string): Promise<R> {
  const r = await prisma.recordChangeRequest.findUniqueOrThrow({ where: { id } });
  if (r.status === "APPLIED") return { ok: true, message: "Already applied." };
  if (r.status !== "SCHEDULED") return { ok: false, message: `This request is ${r.status.toLowerCase()}.` };
  let res: R;
  try {
    res = await applyTarget(r.targetType as ChangeTarget, r);
  } catch (err) {
    res = { ok: false, message: err instanceof Error ? err.message.split("\n").slice(-1)[0] : String(err) };
  }
  await prisma.recordChangeRequest.update({ where: { id }, data: res.ok ? { status: "APPLIED", appliedAt: new Date(), error: null } : { status: "FAILED", error: res.message.slice(0, 500) } });
  if (res.ok) {
    await prisma.auditLog.create({
      data: {
        tenantId: r.tenantId, module: r.category === "PROFILE" || r.category === "CORRECTION" ? "EMPLOYEE" : "SYSTEM", action: "UPDATE",
        entityType: CHANGE_TARGETS[r.targetType as ChangeTarget]?.label.replace(/\s+/g, "") ?? r.targetType, entityId: r.targetId ?? r.employeeId ?? r.id,
        summary: `Applied approved change request: ${r.title}`, oldValue: (r.previous ?? undefined) as never, newValue: r.changes as never,
        actorId: r.decidedBy, actorLabel: "change request",
      },
    });
  }
  return res;
}

type Req = Awaited<ReturnType<typeof prisma.recordChangeRequest.findUniqueOrThrow>>;

async function owned(tenantId: string, refs: { employee?: unknown; businessUnit?: unknown; department?: unknown; division?: unknown; legalEntity?: unknown }): Promise<string | null> {
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (id(refs.employee) && !(await prisma.employee.findFirst({ where: { id: id(refs.employee)!, tenantId }, select: { id: true } }))) return "The person named is not in this company.";
  if (id(refs.businessUnit) && !(await prisma.businessUnit.findFirst({ where: { id: id(refs.businessUnit)!, tenantId }, select: { id: true } }))) return "That business unit no longer exists.";
  if (id(refs.department) && !(await prisma.department.findFirst({ where: { id: id(refs.department)!, tenantId }, select: { id: true } }))) return "That department no longer exists.";
  if (id(refs.division) && !(await prisma.division.findFirst({ where: { id: id(refs.division)!, tenantId }, select: { id: true } }))) return "That division no longer exists.";
  if (id(refs.legalEntity) && !(await prisma.legalEntity.findFirst({ where: { id: id(refs.legalEntity)!, tenantId }, select: { id: true } }))) return "That legal entity no longer exists.";
  return null;
}

async function applyTarget(target: ChangeTarget, r: Req): Promise<R> {
  const t = r.tenantId;
  const c = typedChanges(r.changes as Record<string, unknown>);
  const op = r.operation;
  const emp = r.employeeId;
  const ok = (message = "Applied."): R => ({ ok: true, message });

  switch (target) {
    case "COMPANY_PROFILE":
      await prisma.companyProfile.upsert({ where: { tenantId: t }, create: { tenantId: t, ...c, updatedBy: r.decidedBy }, update: { ...c, updatedBy: r.decidedBy } });
      return ok();
    case "ORGANISATION": {
      const before = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
      if (c.fyStartMonth !== undefined && c.fyStartMonth !== before.fyStartMonth && await prisma.payrollRun.count({ where: { tenantId: t, status: "FINALIZED" } }) > 0) {
        return { ok: false, message: "The financial year cannot move once payroll has been finalised in it." };
      }
      await prisma.tenant.update({ where: { id: t }, data: c as never });
      return ok();
    }
    case "WORKING_RULES":
      await prisma.workingRules.upsert({ where: { tenantId: t }, create: { tenantId: t, ...c, updatedBy: r.decidedBy } as never, update: { ...c, updatedBy: r.decidedBy } as never });
      return ok();
    case "VISIBILITY":
      await prisma.tenantVisibilitySetting.upsert({ where: { tenantId: t }, create: { tenantId: t, ...c } as never, update: c as never });
      return ok();
    case "FISCAL_YEAR": {
      if (op === "DELETE") {
        const d = await prisma.fiscalYear.deleteMany({ where: { id: r.targetId ?? "", tenantId: t } });
        return d.count ? ok() : { ok: false, message: "That fiscal year no longer exists." };
      }
      const existing = await prisma.fiscalYear.findMany({ where: { tenantId: t } });
      const cur = r.targetId ? existing.find((y) => y.id === r.targetId) : null;
      if (r.targetId && !cur) return { ok: false, message: "That fiscal year no longer exists." };
      const merged = { calendarSet: (c.calendarSet as string) ?? cur?.calendarSet ?? "STATUTORY", startDate: (c.startDate as Date) ?? cur!.startDate, endDate: (c.endDate as Date) ?? cur!.endDate };
      const issues = fiscalYearIssues({ id: r.targetId, ...merged }, existing);
      if (issues.length) return { ok: false, message: issues.join(" ") };
      await prisma.$transaction(async (tx) => {
        if (c.isCurrent) await tx.fiscalYear.updateMany({ where: { tenantId: t, calendarSet: merged.calendarSet }, data: { isCurrent: false } });
        if (cur) await tx.fiscalYear.update({ where: { id: cur.id }, data: c as never });
        else await tx.fiscalYear.create({ data: { tenantId: t, name: String(c.name ?? "Fiscal year"), ...merged, status: (c.status as string) ?? "OPEN", isCurrent: !!c.isCurrent, note: (c.note as string) ?? null, createdBy: r.requestedBy } });
      });
      return ok();
    }
    case "DEPARTMENT":
    case "DIVISION":
    case "TEAM":
    case "COST_CENTRE":
    case "LEGAL_ENTITY":
    case "BUSINESS_UNIT":
    case "LOCATION":
      return applyOrgUnit(target, r, c);
    case "PERSONAL":
    case "CONTACT": {
      if (!emp) return { ok: false, message: "No employee on this request." };
      const u = await prisma.employee.updateMany({ where: { id: emp, tenantId: t }, data: c as never });
      if (!u.count) return { ok: false, message: "Employee not found." };
      if (target === "PERSONAL" && (c.firstName || c.lastName) && !c.displayName) {
        const e = await prisma.employee.findUniqueOrThrow({ where: { id: emp }, select: { firstName: true, lastName: true } });
        await prisma.employee.update({ where: { id: emp }, data: { displayName: `${e.firstName} ${e.lastName}` } });
      }
      await recomputeProfileCompletion(emp);
      return ok();
    }
    case "ADDRESS": {
      if (!emp || !(await prisma.employee.findFirst({ where: { id: emp, tenantId: t }, select: { id: true } }))) return { ok: false, message: "Employee not found." };
      const type = String(c.type ?? "CURRENT") as "CURRENT" | "PERMANENT" | "EMERGENCY";
      const { type: _t, ...rest } = c;
      const before = await prisma.employeeAddress.findUnique({ where: { employeeId_type: { employeeId: emp, type } } });
      if (before) await prisma.employeeAddressHistory.create({ data: { tenantId: t, employeeId: emp, type, line1: before.line1, line2: before.line2, city: before.city, state: before.state, postalCode: before.postalCode, changedBy: r.decidedBy } });
      await prisma.employeeAddress.upsert({ where: { employeeId_type: { employeeId: emp, type } }, create: { employeeId: emp, type, line1: String(rest.line1 ?? ""), ...rest } as never, update: rest as never });
      await recomputeProfileCompletion(emp);
      return ok();
    }
    case "BANK": {
      if (!emp || !(await prisma.employee.findFirst({ where: { id: emp, tenantId: t }, select: { id: true } }))) return { ok: false, message: "Employee not found." };
      await prisma.$transaction([
        prisma.employeeBankAccount.updateMany({ where: { employeeId: emp }, data: { isPrimary: false } }),
        prisma.employeeBankAccount.create({ data: { employeeId: emp, isPrimary: true, bankName: String(c.bankName), accountNumber: String(c.accountNumber), ifsc: String(c.ifsc).toUpperCase(), branch: (c.branch as string) ?? null, accountHolder: (c.accountHolder as string) ?? null } }),
      ]);
      await recomputeProfileCompletion(emp);
      return ok();
    }
    case "DEPENDENT":
    case "EMERGENCY_CONTACT":
    case "EDUCATION":
    case "EXPERIENCE": {
      if (!emp || !(await prisma.employee.findFirst({ where: { id: emp, tenantId: t }, select: { id: true } }))) return { ok: false, message: "Employee not found." };
      const model = ({ DEPENDENT: prisma.dependent, EMERGENCY_CONTACT: prisma.emergencyContact, EDUCATION: prisma.employeeEducation, EXPERIENCE: prisma.employeeExperience } as const)[target] as unknown as {
        create(a: unknown): Promise<unknown>; updateMany(a: unknown): Promise<{ count: number }>; deleteMany(a: unknown): Promise<{ count: number }>;
      };
      if (op === "CREATE") await model.create({ data: { employeeId: emp, ...c } });
      else if (op === "DELETE") { if (!(await model.deleteMany({ where: { id: r.targetId ?? "", employeeId: emp } })).count) return { ok: false, message: "That record no longer exists." }; }
      else if (!(await model.updateMany({ where: { id: r.targetId ?? "", employeeId: emp }, data: c })).count) return { ok: false, message: "That record no longer exists." };
      await recomputeProfileCompletion(emp);
      return ok();
    }
    case "DATA_CORRECTION":
      return applyCorrection(r, c);
    case "ESTABLISHMENT":
    case "REGISTRATION_PROFILE":
      return applyStatutoryRegistrationChange(t, target, r.changes as Record<string, unknown>);
  }
  return { ok: false, message: "Unknown kind of change." };
}

/** Fields a data correction may set directly on the employee record. */
export const CORRECTABLE_FIELDS: Record<string, { label: string; kind: "text" | "date" | "enum"; options?: string[] }> = {
  firstName: { label: "First name", kind: "text" },
  middleName: { label: "Middle name", kind: "text" },
  lastName: { label: "Last name", kind: "text" },
  displayName: { label: "Display name", kind: "text" },
  dateOfBirth: { label: "Date of birth", kind: "date" },
  dateOfJoining: { label: "Date of joining", kind: "date" },
  gender: { label: "Gender", kind: "enum", options: ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"] },
  maritalStatus: { label: "Marital status", kind: "enum", options: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNDISCLOSED"] },
  nationality: { label: "Nationality", kind: "text" },
  personalEmail: { label: "Personal email", kind: "text" },
  mobile: { label: "Mobile", kind: "text" },
  alternatePhone: { label: "Alternate phone", kind: "text" },
  attendanceNumber: { label: "Attendance number", kind: "text" },
};

/** Validate a correction's new value for its field; returns an error or null. */
export function correctionIssue(field: string, value: string): string | null {
  const f = CORRECTABLE_FIELDS[field];
  if (!f) return "That field cannot be corrected through a request.";
  if (!value.trim()) return "Give the correct value.";
  if (f.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Use a date like 2026-04-01.";
  if (f.kind === "enum" && !f.options!.includes(value)) return `Choose one of ${f.options!.join(", ")}.`;
  if (field === "personalEmail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Not an email address.";
  if ((field === "mobile" || field === "alternatePhone") && !/^\+?[0-9 -]{7,20}$/.test(value)) return "Not a phone number.";
  return null;
}

async function applyCorrection(r: Req, c: Record<string, unknown>): Promise<R> {
  const field = String(c.field ?? "");
  const value = String(c.correctValue ?? "");
  const issue = correctionIssue(field, value);
  if (issue) return { ok: false, message: issue };
  if (!r.employeeId) return { ok: false, message: "No employee on this request." };
  const kind = CORRECTABLE_FIELDS[field].kind;
  const data = { [field]: kind === "date" ? new Date(`${value}T00:00:00Z`) : value };
  const u = await prisma.employee.updateMany({ where: { id: r.employeeId, tenantId: r.tenantId }, data: data as never });
  if (!u.count) return { ok: false, message: "Employee not found." };
  await recomputeProfileCompletion(r.employeeId);
  return { ok: true, message: "Corrected." };
}

async function applyOrgUnit(target: "DEPARTMENT" | "DIVISION" | "TEAM" | "COST_CENTRE" | "LEGAL_ENTITY" | "BUSINESS_UNIT" | "LOCATION", r: Req, c: Record<string, unknown>): Promise<R> {
  const t = r.tenantId;
  const bad = await owned(t, { employee: c.headId ?? c.leadId, businessUnit: c.businessUnitId, department: c.departmentId, division: c.divisionId });
  if (bad) return { ok: false, message: bad };
  const delegate = ({
    DEPARTMENT: prisma.department, DIVISION: prisma.division, TEAM: prisma.orgTeam, COST_CENTRE: prisma.costCenter,
    LEGAL_ENTITY: prisma.legalEntity, BUSINESS_UNIT: prisma.businessUnit, LOCATION: prisma.location,
  } as const)[target] as unknown as {
    create(a: unknown): Promise<{ id: string }>; updateMany(a: unknown): Promise<{ count: number }>;
  };
  if (r.operation === "CREATE") {
    if (target === "BUSINESS_UNIT" || target === "LEGAL_ENTITY" || target === "LOCATION") return { ok: false, message: "Create these from Org structure." };
    await delegate.create({ data: { tenantId: t, ...c } });
    return { ok: true, message: "Created." };
  }
  // DELETE retires the unit (inactive) rather than removing it, keeping its history.
  const data = r.operation === "DELETE" ? { isActive: false } : c;
  const u = await delegate.updateMany({ where: { id: r.targetId ?? "", tenantId: t }, data });
  return u.count ? { ok: true, message: "Applied." } : { ok: false, message: "That record no longer exists." };
}
