import type { Permission } from "./permissions";
import {
  IMPLICIT_ROLE_BY_KEY,
  SELF_PERMISSIONS,
  type ImplicitRoleKey,
} from "./roles";
import { moduleOf } from "./modules";

/**
 * Access resolution.
 *
 * Two layers combine, and the combining rule is the thing that catches
 * security reviewers out. Stated verbatim in the source product's docs:
 *
 *     Scope of privilege  UNION  Scope of visibility setting
 *
 * An UNSCOPED role therefore sees across all legal entities regardless of the
 * visibility restriction. Visibility is a directory control, not a hard data
 * partition — so we implement it exactly that way rather than pretending it
 * is a tenancy boundary. Anything that genuinely must not leak across
 * entities has to be modelled as a separate tenant.
 */

/** A scope filter on a role grant. Legal entity is deliberately not available. */
export interface GrantScope {
  departmentId?: string | null;
  locationId?: string | null;
}

export interface RoleGrant {
  roleId: string;
  roleKey: string | null;
  roleName: string;
  permissions: Set<Permission>;
  /** Empty array means unscoped — the grant applies tenant-wide. */
  scopes: GrantScope[];
}

export interface VisibilitySetting {
  restrictByLegalEntity: boolean;
  restrictByBusinessUnit: boolean;
  /** Managers and their reports keep mutual visibility across boundaries. */
  managerReporteeOverride: boolean;
}

export interface ViewerContext {
  userId: string;
  tenantId: string;
  employeeId: string | null;

  /** Explicit, administratively assigned roles. */
  grants: RoleGrant[];

  /** Derived implicit position. */
  directReportIds: Set<string>;
  /** Full downward closure of the reporting tree — "indirect reportees". */
  allReportIds: Set<string>;
  headedDepartmentIds: Set<string>;
  headedBusinessUnitIds: Set<string>;

  /** The viewer's own placement, used by the visibility layer. */
  legalEntityId: string | null;
  businessUnitId: string | null;

  visibility: VisibilitySetting;

  /** Modules the platform switched off for this company; their permissions are withheld. */
  disabledModules?: ReadonlySet<string>;
}

export interface TargetEmployee {
  id: string;
  departmentId: string | null;
  locationId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
  reportingManagerId: string | null;
}

/** Implicit roles the viewer currently holds, derived from the org tree. */
export function implicitRolesOf(ctx: ViewerContext): ImplicitRoleKey[] {
  const out: ImplicitRoleKey[] = [];
  if (ctx.directReportIds.size > 0) out.push("REPORTING_MANAGER");
  if (ctx.headedDepartmentIds.size > 0) out.push("DEPARTMENT_HEAD");
  if (ctx.headedBusinessUnitIds.size > 0) out.push("BUSINESS_HEAD");
  return out;
}

/**
 * Every permission the viewer holds anywhere, ignoring scope.
 * Use this for menu rendering only — never for a data decision, because a
 * scoped grant will appear here without covering the record in question.
 */
export function effectivePermissions(ctx: ViewerContext): Set<Permission> {
  const out = new Set<Permission>();
  for (const grant of ctx.grants) {
    for (const p of grant.permissions) out.add(p);
  }
  for (const key of implicitRolesOf(ctx)) {
    const role = IMPLICIT_ROLE_BY_KEY.get(key);
    role?.permissions.forEach((p) => out.add(p));
  }
  if (ctx.employeeId) SELF_PERMISSIONS.forEach((p) => out.add(p));
  if (ctx.disabledModules?.size) {
    for (const p of out) {
      const m = moduleOf(p);
      if (m && ctx.disabledModules.has(m)) out.delete(p);
    }
  }
  return out;
}

/** Does the viewer hold this permission anywhere at all? Menu-level check. */
export function hasPermission(ctx: ViewerContext, permission: Permission): boolean {
  return effectivePermissions(ctx).has(permission);
}

export function hasAnyPermission(ctx: ViewerContext, permissions: Permission[]): boolean {
  const held = effectivePermissions(ctx);
  return permissions.some((p) => held.has(p));
}

/** Does the viewer hold this permission with no scope restriction? */
export function hasUnscopedPermission(ctx: ViewerContext, permission: Permission): boolean {
  return ctx.grants.some(
    (g) => g.permissions.has(permission) && g.scopes.length === 0,
  );
}

function scopeCovers(scope: GrantScope, target: TargetEmployee): boolean {
  // A scope with neither filter set is meaningless; treat it as no-match so a
  // malformed row can never silently widen access.
  if (!scope.departmentId && !scope.locationId) return false;
  if (scope.departmentId && scope.departmentId !== target.departmentId) return false;
  if (scope.locationId && scope.locationId !== target.locationId) return false;
  return true;
}

/** Does an explicit grant carrying `permission` reach this employee? */
function explicitGrantCovers(
  ctx: ViewerContext,
  target: TargetEmployee,
  permission: Permission,
): boolean {
  for (const grant of ctx.grants) {
    if (!grant.permissions.has(permission)) continue;
    // Unscoped grant: reaches everyone in the tenant. This is the UNION rule —
    // the visibility restriction does NOT narrow it.
    if (grant.scopes.length === 0) return true;
    if (grant.scopes.some((s) => scopeCovers(s, target))) return true;
  }
  return false;
}

/** Does an implicit role reach this employee? */
function implicitRoleCovers(
  ctx: ViewerContext,
  target: TargetEmployee,
  permission: Permission,
): boolean {
  const rm = IMPLICIT_ROLE_BY_KEY.get("REPORTING_MANAGER");
  if (rm?.permissions.includes(permission) && ctx.allReportIds.has(target.id)) {
    return true;
  }
  const dh = IMPLICIT_ROLE_BY_KEY.get("DEPARTMENT_HEAD");
  if (
    dh?.permissions.includes(permission) &&
    target.departmentId &&
    ctx.headedDepartmentIds.has(target.departmentId)
  ) {
    return true;
  }
  const bh = IMPLICIT_ROLE_BY_KEY.get("BUSINESS_HEAD");
  if (
    bh?.permissions.includes(permission) &&
    target.businessUnitId &&
    ctx.headedBusinessUnitIds.has(target.businessUnitId)
  ) {
    return true;
  }
  return false;
}

/**
 * The visibility layer. Returns true when the org-wide restriction would
 * block this pairing. Only consulted when no unscoped grant applies —
 * that is what "UNION" means in practice.
 */
function visibilityBlocks(ctx: ViewerContext, target: TargetEmployee): boolean {
  const v = ctx.visibility;
  if (!v.restrictByLegalEntity && !v.restrictByBusinessUnit) return false;

  // Manager and direct report keep mutual visibility across the boundary.
  if (v.managerReporteeOverride) {
    if (ctx.allReportIds.has(target.id)) return false;
    if (ctx.employeeId && target.reportingManagerId === ctx.employeeId) return false;
  }

  if (v.restrictByLegalEntity && ctx.legalEntityId && target.legalEntityId) {
    if (ctx.legalEntityId !== target.legalEntityId) return true;
  }
  if (v.restrictByBusinessUnit && ctx.businessUnitId && target.businessUnitId) {
    if (ctx.businessUnitId !== target.businessUnitId) return true;
  }
  return false;
}

/**
 * The real authorisation check. Use this for every employee-scoped decision.
 */
export function canAccessEmployee(
  ctx: ViewerContext,
  target: TargetEmployee,
  permission: Permission,
): boolean {
  // Self-access, for the permissions every employee holds over their own record.
  if (ctx.employeeId === target.id && SELF_PERMISSIONS.includes(permission)) {
    return true;
  }

  // An unscoped explicit grant wins outright — the documented UNION.
  if (hasUnscopedPermission(ctx, permission)) return true;

  const covered =
    explicitGrantCovers(ctx, target, permission) ||
    implicitRoleCovers(ctx, target, permission);
  if (!covered) return false;

  return !visibilityBlocks(ctx, target);
}

/**
 * A Prisma `where` fragment narrowing an employee query to what the viewer
 * may see. Returns null when the viewer may see everyone, and a never-match
 * clause when they may see no one.
 */
export function employeeScopeFilter(
  ctx: ViewerContext,
  permission: Permission,
): Record<string, unknown> | null {
  if (hasUnscopedPermission(ctx, permission)) return null;

  const or: Record<string, unknown>[] = [];

  if (ctx.employeeId && SELF_PERMISSIONS.includes(permission)) {
    or.push({ id: ctx.employeeId });
  }

  for (const grant of ctx.grants) {
    if (!grant.permissions.has(permission)) continue;
    for (const scope of grant.scopes) {
      const clause: Record<string, unknown> = {};
      if (scope.departmentId) clause.departmentId = scope.departmentId;
      if (scope.locationId) clause.locationId = scope.locationId;
      if (Object.keys(clause).length > 0) or.push(clause);
    }
  }

  const rm = IMPLICIT_ROLE_BY_KEY.get("REPORTING_MANAGER");
  if (rm?.permissions.includes(permission) && ctx.allReportIds.size > 0) {
    or.push({ id: { in: [...ctx.allReportIds] } });
  }
  const dh = IMPLICIT_ROLE_BY_KEY.get("DEPARTMENT_HEAD");
  if (dh?.permissions.includes(permission) && ctx.headedDepartmentIds.size > 0) {
    or.push({ departmentId: { in: [...ctx.headedDepartmentIds] } });
  }
  const bh = IMPLICIT_ROLE_BY_KEY.get("BUSINESS_HEAD");
  if (bh?.permissions.includes(permission) && ctx.headedBusinessUnitIds.size > 0) {
    or.push({ businessUnitId: { in: [...ctx.headedBusinessUnitIds] } });
  }

  // No route to the permission at all.
  if (or.length === 0) return { id: "__no_access__" };

  const base: Record<string, unknown> = { OR: or };

  // Apply the visibility narrowing on top of the scoped routes.
  const v = ctx.visibility;
  const restrictions: Record<string, unknown>[] = [];
  if (v.restrictByLegalEntity && ctx.legalEntityId) {
    restrictions.push({ legalEntityId: ctx.legalEntityId });
  }
  if (v.restrictByBusinessUnit && ctx.businessUnitId) {
    restrictions.push({ businessUnitId: ctx.businessUnitId });
  }
  if (restrictions.length === 0) return base;

  const visibilityClause: Record<string, unknown> =
    v.managerReporteeOverride && ctx.allReportIds.size > 0
      ? { OR: [...restrictions, { id: { in: [...ctx.allReportIds] } }] }
      : { OR: restrictions };

  return { AND: [base, visibilityClause] };
}

/** Throwable guard for server actions and route handlers. */
export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Forbidden: missing permission "${permission}"`);
    this.name = "ForbiddenError";
  }
}

export function requirePermission(ctx: ViewerContext, permission: Permission): void {
  if (!hasPermission(ctx, permission)) throw new ForbiddenError(permission);
}

export function requireEmployeeAccess(
  ctx: ViewerContext,
  target: TargetEmployee,
  permission: Permission,
): void {
  if (!canAccessEmployee(ctx, target, permission)) throw new ForbiddenError(permission);
}
