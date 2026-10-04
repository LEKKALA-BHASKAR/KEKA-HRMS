import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee, hasUnscopedPermission, type Permission } from "@keka/rbac";
import { managersOf, teamOf, tenureRange, MASS_STATUSES, type ChangeTarget, type MassUpdateKind } from "@keka/services";
import { can, type Viewer } from "./context";
import { directoryWhere } from "./directory";
import { scopedEmployeeWhere, scopedEmployeeIds } from "./scope";

/**
 * Shared checks for Core HR depth: who is HR for an employee, who counts as
 * their manager (reporting, dotted-line, or acting for either), who may
 * decide a change request, and the directory's filters and visibility.
 */

const P = PERMISSIONS;

export const TARGET_SELECT = { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } as const;

export async function employeeTarget(viewer: Viewer, employeeId: string) {
  return prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { ...TARGET_SELECT, displayName: true, firstName: true, lastName: true, employeeNumber: true, userId: true, status: true } });
}

/** HR for this employee: an explicit (not implicit-manager) right to edit their record. */
export async function isHrFor(viewer: Viewer, employeeId: string, permission: Permission = P.EMPLOYEE_UPDATE): Promise<boolean> {
  if (!can(viewer, permission)) return false;
  const t = await employeeTarget(viewer, employeeId);
  return !!t && canAccessEmployee(viewer, t, permission);
}

/** Is the viewer one of this employee's managers today (reporting, dotted-line, acting)? */
export async function isManagerOf(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (!viewer.employee) return false;
  if (viewer.allReportIds.has(employeeId)) return true;
  return (await managersOf(viewer.tenantId, employeeId)).includes(viewer.employee.id);
}

/** The permission that makes someone "HR" for a change request's category. */
export function hrPermissionFor(category: string, targetType: string): Permission {
  if (category === "CONFIG") return P.ORG_SETTINGS_MANAGE;
  if (category === "ORG") return targetType === "LEGAL_ENTITY" ? P.ORG_ENTITY_MANAGE : P.ORG_MANAGE;
  if (targetType === "BANK") return P.EMPLOYEE_MANAGE_FINANCIALS;
  return P.EMPLOYEE_UPDATE;
}

/** May the viewer act as HR on this request? */
export async function isHrForRequest(viewer: Viewer, r: { category: string; targetType: string; employeeId: string | null }): Promise<boolean> {
  const perm = hrPermissionFor(r.category, r.targetType);
  if (r.employeeId) return isHrFor(viewer, r.employeeId, perm);
  return can(viewer, perm);
}

/** Profile changes an employee may ask for, and who decides each. */
export const SELF_SERVICE_TARGETS: Partial<Record<ChangeTarget, "HR" | "MANAGER">> = {
  PERSONAL: "HR", BANK: "HR", CONTACT: "MANAGER", ADDRESS: "MANAGER", DEPENDENT: "MANAGER",
  EMERGENCY_CONTACT: "MANAGER", EDUCATION: "MANAGER", EXPERIENCE: "MANAGER", DATA_CORRECTION: "HR",
};

/**
 * The change requests a viewer could decide right now: HR ones for their
 * permissions (and scope), manager ones for the people they manage. Never
 * their own.
 */
export async function decidableChangeRequests(viewer: Viewer, opts: { take?: number; id?: string } = {}) {
  const pending = await prisma.recordChangeRequest.findMany({
    where: { tenantId: viewer.tenantId, status: "PENDING", NOT: { requestedBy: viewer.user.id }, ...(opts.id ? { id: opts.id } : {}) },
    orderBy: { createdAt: "asc" }, take: 500,
  });
  const out: typeof pending = [];
  for (const r of pending) {
    if (await isHrForRequest(viewer, r)) out.push(r);
    else if (r.approverType === "MANAGER" && r.employeeId && await isManagerOf(viewer, r.employeeId)) out.push(r);
    if (opts.take && out.length >= opts.take) break;
  }
  return out;
}

/**
 * The change requests a viewer may see in the queue's history and export:
 * their own, configuration ones with the settings right, org ones with the
 * structure right, and profile / correction ones for employees in their
 * scope.
 */
export async function visibleChangeRequestWhere(viewer: Viewer): Promise<Prisma.RecordChangeRequestWhereInput> {
  const or: Prisma.RecordChangeRequestWhereInput[] = [{ requestedBy: viewer.user.id }];
  if (viewer.employee) or.push({ employeeId: viewer.employee.id });
  if (can(viewer, P.ORG_SETTINGS_MANAGE)) or.push({ category: "CONFIG" });
  if (can(viewer, P.ORG_MANAGE)) or.push({ category: "ORG", NOT: { targetType: "LEGAL_ENTITY" } });
  if (can(viewer, P.ORG_ENTITY_MANAGE)) or.push({ category: "ORG", targetType: "LEGAL_ENTITY" });
  if (can(viewer, P.EMPLOYEE_UPDATE)) {
    const ids = await scopedEmployeeIds(viewer, P.EMPLOYEE_UPDATE);
    or.push({ category: { in: ["PROFILE", "CORRECTION"] }, ...(ids === null ? {} : { employeeId: { in: ids } }) });
  }
  if (viewer.employee && viewer.allReportIds.size) or.push({ approverType: "MANAGER", employeeId: { in: [...viewer.allReportIds] } });
  return { tenantId: viewer.tenantId, OR: or };
}

/** Show a value safely: bank account numbers masked to their last four digits. */
export function displayChangeValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "accountNumber") return `•••• ${String(v).slice(-4)}`;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  return String(v);
}

// ---------------------------------------------------------------------------
//  Directory
// ---------------------------------------------------------------------------

/**
 * The org-wide visibility settings, applied to the directory: with a
 * restriction on, people without an unscoped right to view everyone find
 * only colleagues in their own legal entity / business unit — plus, when the
 * override is on, their own reports and their manager.
 */
export async function directoryVisibilityWhere(viewer: Viewer): Promise<Prisma.EmployeeWhereInput> {
  const v = viewer.visibility;
  if (!v.restrictByLegalEntity && !v.restrictByBusinessUnit) return {};
  if (hasUnscopedPermission(viewer, P.EMPLOYEE_VIEW_ALL) || hasUnscopedPermission(viewer, P.EMPLOYEE_VIEW)) return {};
  const same: Prisma.EmployeeWhereInput = {
    ...(v.restrictByLegalEntity && viewer.legalEntityId ? { OR: [{ legalEntityId: viewer.legalEntityId }, { legalEntityId: null }] } : {}),
    ...(v.restrictByBusinessUnit && viewer.businessUnitId ? { AND: [{ OR: [{ businessUnitId: viewer.businessUnitId }, { businessUnitId: null }] }] } : {}),
  };
  if (!v.managerReporteeOverride || !viewer.employee) return same;
  const me = await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { reportingManagerId: true } });
  const keep = [...viewer.allReportIds, viewer.employee.id, me?.reportingManagerId].filter((x): x is string => !!x);
  return { OR: [same, { id: { in: keep } }] };
}

export interface DirectoryParams {
  q: string; bu: string; dept: string; loc: string; cc: string; le: string;
  mgr: string; wt: string; tenure: string; skill: string; team: string; div: string; shift: string;
}

export const DIRECTORY_PARAM_KEYS: Array<keyof DirectoryParams> = ["q", "bu", "dept", "loc", "cc", "le", "mgr", "wt", "tenure", "skill", "team", "div", "shift"];

export function directoryParams(sp: Record<string, string | string[] | undefined>): DirectoryParams {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");
  return Object.fromEntries(DIRECTORY_PARAM_KEYS.map((k) => [k, one(sp[k]).slice(0, k === "q" ? 100 : 64)])) as unknown as DirectoryParams;
}

/** The directory query for a set of filters, visibility applied. */
export async function directorySearchWhere(viewer: Viewer, p: DirectoryParams, today: Date = new Date()): Promise<Prisma.EmployeeWhereInput> {
  const tenantId = viewer.tenantId;
  const words = p.q.split(/\s+/).filter(Boolean).slice(0, 5);
  const text = (w: string) => ({ contains: w, mode: "insensitive" as const });
  const and: Prisma.EmployeeWhereInput[] = [directoryWhere(tenantId), await directoryVisibilityWhere(viewer)];
  if (p.bu) and.push({ businessUnitId: p.bu });
  if (p.dept) and.push({ departmentId: p.dept });
  if (p.loc) and.push({ locationId: p.loc });
  if (p.cc) and.push({ costCenterId: p.cc });
  if (p.le) and.push({ legalEntityId: p.le });
  if (p.wt) and.push({ workerTypeId: p.wt });
  if (p.mgr) {
    const dotted = await prisma.secondaryManager.findMany({ where: { tenantId, managerId: p.mgr }, select: { employeeId: true } });
    and.push({ OR: [{ reportingManagerId: p.mgr }, { id: { in: dotted.map((d) => d.employeeId) } }] });
  }
  if (p.tenure) {
    const r = tenureRange(p.tenure, today);
    if (r) and.push({ dateOfJoining: { ...(r.gt ? { gt: r.gt } : {}), ...(r.lte ? { lte: r.lte } : {}) } });
  }
  if (p.skill) and.push({ employeeSkills: { some: { skillId: p.skill } } });
  if (p.team) {
    const members = await prisma.orgTeamMember.findMany({ where: { teamId: p.team, team: { tenantId } }, select: { employeeId: true } });
    and.push({ id: { in: members.map((m) => m.employeeId) } });
  }
  if (p.div) {
    const depts = await prisma.department.findMany({ where: { tenantId, divisionId: p.div }, select: { id: true } });
    and.push({ departmentId: { in: depts.map((d) => d.id) } });
  }
  if (p.shift) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const on = await prisma.shiftAssignment.findMany({ where: { shiftId: p.shift, date: day, shift: { tenantId } }, select: { employeeId: true } });
    and.push({ id: { in: on.map((s) => s.employeeId) } });
  }
  for (const w of words) {
    and.push({
      OR: [
        { firstName: text(w) }, { lastName: text(w) }, { displayName: text(w) }, { workEmail: text(w) }, { jobTitleName: text(w) }, { employeeNumber: text(w) },
        { employeeSkills: { some: { skill: { name: text(w) } } } },
      ],
    });
  }
  return { AND: and };
}

// ---------------------------------------------------------------------------
//  Mass updates
// ---------------------------------------------------------------------------

/** The current value of the field a mass update sets. */
export function massCurrentOf(kind: MassUpdateKind, e: { status: string; reportingManagerId: string | null; locationId: string | null; departmentId: string | null; workerTypeId: string | null }): string | null {
  return kind === "STATUS" ? e.status : kind === "MANAGER" ? e.reportingManagerId : kind === "LOCATION" ? e.locationId : kind === "DEPARTMENT" ? e.departmentId : e.workerTypeId;
}

/** Who a selection reaches: picked people, or everyone in a department / location, within the viewer's scope. */
export async function massUpdateCandidates(viewer: Viewer, f: { employeeIds: string[]; departmentId?: string; locationId?: string; status?: string; numbers?: string }) {
  const numbers = (f.numbers ?? "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 2000);
  const or = [
    ...(f.employeeIds.length ? [{ id: { in: f.employeeIds } }] : []),
    ...(numbers.length ? [{ employeeNumber: { in: numbers } }] : []),
    ...(f.departmentId ? [{ departmentId: f.departmentId }] : []),
    ...(f.locationId ? [{ locationId: f.locationId }] : []),
  ];
  if (or.length === 0) return [];
  return prisma.employee.findMany({
    where: { AND: [scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE), { OR: or }, ...(f.status ? [{ status: f.status as never }] : [])] },
    select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, status: true, reportingManagerId: true, locationId: true, departmentId: true, workerTypeId: true },
    orderBy: { employeeNumber: "asc" }, take: 2000,
  });
}

/** Check the value a mass update sets belongs to this company, and name it. */
export async function massValueLabel(tenantId: string, kind: MassUpdateKind, value: string): Promise<string | null> {
  if (kind === "STATUS") return (MASS_STATUSES as readonly string[]).includes(value) ? value : null;
  const row = kind === "MANAGER" ? await prisma.employee.findFirst({ where: { id: value, tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { displayName: true } }).then((e) => e && { name: e.displayName ?? "" })
    : kind === "LOCATION" ? await prisma.location.findFirst({ where: { id: value, tenantId }, select: { name: true } })
    : kind === "DEPARTMENT" ? await prisma.department.findFirst({ where: { id: value, tenantId }, select: { name: true } })
    : await prisma.workerType.findFirst({ where: { id: value, tenantId }, select: { name: true } });
  return row?.name ?? null;
}


// ---------------------------------------------------------------------------
//  Digital ID card
// ---------------------------------------------------------------------------

/** Everything an ID card shows: the person, their latest card and the company's branding. */
export async function idCardView(tenantId: string, employeeId: string) {
  const [employee, card, profile, tenant] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId },
      select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true, bloodGroup: true, workEmail: true, status: true, dateOfJoining: true, department: { select: { name: true } }, location: { select: { name: true } }, legalEntity: { select: { name: true } } },
    }),
    prisma.employeeIdCard.findFirst({ where: { tenantId, employeeId }, orderBy: { issuedAt: "desc" } }),
    prisma.companyProfile.findUnique({ where: { tenantId } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, subdomain: true } }),
  ]);
  return { employee, card, company: { name: profile?.brandName ?? profile?.legalName ?? tenant.name, color: profile?.brandColor ?? "#1266a8", address: [profile?.addressLine1, profile?.city].filter(Boolean).join(", "), phone: profile?.phone ?? null }, subdomain: tenant.subdomain };
}

// ---------------------------------------------------------------------------
//  Manager self-service
// ---------------------------------------------------------------------------

export type TeamLink = "DIRECT" | "INDIRECT" | "DOTTED" | "ACTING";

/**
 * The people a manager looks after today: everyone below them in the
 * reporting line, plus dotted-line reports and the team of anyone they are
 * acting for. Each id says how they are connected.
 */
export async function managedTeam(viewer: Viewer, on: Date = new Date()): Promise<Map<string, TeamLink>> {
  const out = new Map<string, TeamLink>();
  if (!viewer.employee) return out;
  const t = await teamOf(viewer.tenantId, viewer.employee.id, on);
  for (const id of viewer.allReportIds) out.set(id, "INDIRECT");
  for (const id of t.direct) out.set(id, "DIRECT");
  for (const id of t.dotted) if (!out.has(id)) out.set(id, "DOTTED");
  for (const id of t.acting) if (!out.has(id)) out.set(id, "ACTING");
  out.delete(viewer.employee.id);
  return out;
}

/** Leave and attendance for a set of people over a window, for the manager's views. */
export async function teamTime(tenantId: string, ids: string[], from: Date, to: Date) {
  const [leave, attendance, pendingLeave, pendingAttendance] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { tenantId, employeeId: { in: ids }, status: { in: ["APPROVED", "PENDING"] }, fromDate: { lte: to }, toDate: { gte: from } }, include: { leaveType: { select: { name: true } } }, orderBy: { fromDate: "asc" } }),
    prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.count({ where: { tenantId, employeeId: { in: ids }, status: "PENDING" } }),
    prisma.attendanceRequest.count({ where: { tenantId, employeeId: { in: ids }, status: "PENDING" } }),
  ]);
  return { leave, attendance, pendingLeave, pendingAttendance };
}
