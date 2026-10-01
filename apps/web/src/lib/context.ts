import "server-only";
import { safeNext } from "./safe-next";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect, forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import {
  type ViewerContext, type RoleGrant, type Permission,
  effectivePermissions, hasPermission,
} from "@keka/rbac";
import { readSession } from "./session";

/**
 * Builds the authorisation context for the current request.
 *
 * Permissions are read from the database every time rather than cached in the
 * session token: a role revoked at 10:00 must not still work at 10:05.
 * React's `cache` dedupes it within a single render pass.
 */

export interface Viewer extends ViewerContext {
  user: {
    id: string;
    email: string;
    loginDisabled: boolean;
    mustChangePassword: boolean;
  };
  employee: {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    displayName: string;
    jobTitleName: string | null;
    photoUrl: string | null;
    departmentName: string | null;
    status: string;
  } | null;
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    plan: string;
    currency: string;
    fyStartMonth: number;
    hasHire: boolean;
    hasPsa: boolean;
  };
  roleNames: string[];
  permissions: Set<Permission>;
}

/**
 * Walk the reporting tree downward from an employee to find every indirect
 * report. Iterative and depth-capped so a cycle in the data cannot hang a
 * page render.
 */
async function collectAllReports(rootId: string, tenantId: string): Promise<Set<string>> {
  const all = new Set<string>();
  let frontier = [rootId];
  let depth = 0;

  while (frontier.length > 0 && depth < 12) {
    const rows = await prisma.employee.findMany({
      where: { tenantId, reportingManagerId: { in: frontier } },
      select: { id: true },
    });
    const next: string[] = [];
    for (const row of rows) {
      if (!all.has(row.id)) {
        all.add(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
    depth++;
  }
  return all;
}

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await readSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      tenant: { include: { visibilitySetting: true } },
      employee: {
        include: {
          department: { select: { name: true } },
        },
      },
      roleAssignments: {
        include: {
          role: { include: { permissions: true } },
          scopes: true,
        },
      },
    },
  });

  if (!user || user.tenantId !== session.tenantId) return null;
  // A disabled login takes effect immediately, with no grace period.
  if (user.loginDisabled || user.isDeactivated) return null;
  // "Sign out everywhere" and password changes bump the version; older
  // sessions stop working on their next request.
  if ((session.sv ?? 0) !== user.sessionVersion) return null;

  const grants: RoleGrant[] = user.roleAssignments.map((a) => ({
    roleId: a.roleId,
    roleKey: a.role.key,
    roleName: a.role.name,
    permissions: new Set(a.role.permissions.map((p) => p.permission as Permission)),
    scopes: a.scopes.map((s) => ({
      departmentId: s.departmentId,
      locationId: s.locationId,
    })),
  }));

  const employeeId = user.employee?.id ?? null;

  let directReportIds = new Set<string>();
  let allReportIds = new Set<string>();
  let headedDepartmentIds = new Set<string>();
  let headedBusinessUnitIds = new Set<string>();

  if (employeeId) {
    const [directReports, headedDepts, headedBus] = await Promise.all([
      prisma.employee.findMany({
        where: { tenantId: user.tenantId, reportingManagerId: employeeId },
        select: { id: true },
      }),
      prisma.department.findMany({
        where: { tenantId: user.tenantId, headId: employeeId },
        select: { id: true },
      }),
      prisma.businessUnit.findMany({
        where: { tenantId: user.tenantId, headId: employeeId },
        select: { id: true },
      }),
    ]);
    directReportIds = new Set(directReports.map((e) => e.id));
    headedDepartmentIds = new Set(headedDepts.map((d) => d.id));
    headedBusinessUnitIds = new Set(headedBus.map((b) => b.id));
    allReportIds = await collectAllReports(employeeId, user.tenantId);
  }

  const base: ViewerContext = {
    userId: user.id,
    tenantId: user.tenantId,
    employeeId,
    grants,
    directReportIds,
    allReportIds,
    headedDepartmentIds,
    headedBusinessUnitIds,
    legalEntityId: user.employee?.legalEntityId ?? null,
    businessUnitId: user.employee?.businessUnitId ?? null,
    visibility: {
      restrictByLegalEntity: user.tenant.visibilitySetting?.restrictByLegalEntity ?? false,
      restrictByBusinessUnit: user.tenant.visibilitySetting?.restrictByBusinessUnit ?? false,
      managerReporteeOverride: user.tenant.visibilitySetting?.managerReporteeOverride ?? true,
    },
  };

  const implicitNames: string[] = [];
  if (directReportIds.size > 0) implicitNames.push("Reporting Manager");
  if (headedDepartmentIds.size > 0) implicitNames.push("Department Head");
  if (headedBusinessUnitIds.size > 0) implicitNames.push("Business Head");

  return {
    ...base,
    user: { id: user.id, email: user.email, loginDisabled: user.loginDisabled, mustChangePassword: user.mustChangePassword },
    employee: user.employee
      ? {
          id: user.employee.id,
          employeeNumber: user.employee.employeeNumber,
          firstName: user.employee.firstName,
          lastName: user.employee.lastName,
          displayName: user.employee.displayName ?? `${user.employee.firstName} ${user.employee.lastName}`,
          jobTitleName: user.employee.jobTitleName,
          photoUrl: user.employee.photoUrl,
          departmentName: user.employee.department?.name ?? null,
          status: user.employee.status,
        }
      : null,
    tenant: {
      id: user.tenant.id,
      name: user.tenant.name,
      subdomain: user.tenant.subdomain,
      plan: user.tenant.plan,
      currency: user.tenant.currency,
      fyStartMonth: user.tenant.fyStartMonth,
      hasHire: user.tenant.hasHire,
      hasPsa: user.tenant.hasPsa,
    },
    roleNames: [...grants.map((g) => g.roleName), ...implicitNames],
    permissions: effectivePermissions(base),
  };
});

/** Redirects to sign-in when there is no valid session. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) {
    // Come back here after signing in (the middleware supplies the path).
    const back = safeNext((await headers()).get("x-pathname"));
    redirect(back && back !== "/" ? `/signin?next=${encodeURIComponent(back)}` : "/signin");
  }
  return viewer;
}

/**
 * Redirects to sign-in, then interrupts with a 403 when the permission is
 * missing. Missing authorisation is an expected outcome, so it renders
 * forbidden.tsx with the right status code rather than a server error.
 */
export async function requireAuth(permission: Permission): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!hasPermission(viewer, permission)) {
    forbidden();
  }
  return viewer;
}

export function can(viewer: Viewer, permission: Permission): boolean {
  return viewer.permissions.has(permission);
}

export function canAny(viewer: Viewer, permissions: Permission[]): boolean {
  return permissions.some((p) => viewer.permissions.has(p));
}
