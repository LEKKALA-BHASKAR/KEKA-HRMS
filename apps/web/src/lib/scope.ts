import "server-only";
import { prisma } from "@keka/db";
import { employeeScopeFilter, PERMISSIONS, type Permission } from "@keka/rbac";
import { can, type Viewer } from "./context";

/**
 * The employees a viewer reaches through one permission, as a Prisma `where`
 * on Employee. Always tenant-bound.
 */
export function scopedEmployeeWhere(viewer: Viewer, permission: Permission): Record<string, unknown> {
  const filter = employeeScopeFilter(viewer, permission);
  return filter ? { tenantId: viewer.tenantId, ...filter } : { tenantId: viewer.tenantId };
}

/**
 * The same, resolved to ids — for tables that carry an employeeId column but
 * no relation to filter through. `null` means every employee in the tenant.
 */
export async function scopedEmployeeIds(viewer: Viewer, permission: Permission): Promise<string[] | null> {
  const filter = employeeScopeFilter(viewer, permission);
  if (!filter) return null;
  const rows = await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, ...filter }, select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** A where-fragment for an `employeeId` column. */
export function inScope(ids: string[] | null): Record<string, unknown> {
  return ids === null ? {} : { employeeId: { in: ids } };
}

/** "2026-09" from a search param, falling back to the current month. */
export function parseMonth(raw: string | undefined, fallback = new Date()): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/**
 * Submitted timesheets waiting on this viewer: people in their approval line,
 * or sheets whose every project they manage. Never their own.
 */
export function timesheetsToApproveWhere(viewer: Viewer): Record<string, unknown> {
  const me = viewer.employee?.id ?? "__none__";
  const inLine = can(viewer, PERMISSIONS.TIMESHEET_APPROVE) ? scopedEmployeeWhere(viewer, PERMISSIONS.TIMESHEET_APPROVE) : { id: "__no_access__" };
  return {
    tenantId: viewer.tenantId, status: "SUBMITTED", NOT: { employeeId: me },
    OR: [{ employee: inLine }, { entries: { some: {}, every: { project: { projectManagerId: me } } } }],
  };
}
