import "server-only";
import { prisma } from "@keka/db";
import { canAccessEmployee, type Permission } from "@keka/rbac";
import type { Viewer } from "./context";
import { scopedEmployeeWhere } from "./scope";

/** Lookups shared by the joining & time depth actions and pages. */

export const jstr = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export const jnum = (f: FormData, k: string): number | null => { const v = jstr(f, k); if (v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
export const jday = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? new Date(`${v}T00:00:00Z`) : null);
export const jlist = (f: FormData, k: string) => [...new Set(f.getAll(k).map((v) => String(v).trim()).filter(Boolean))];
export const todayUtc = () => new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");

const EMP_SELECT = { id: true, tenantId: true, displayName: true, userId: true, status: true, dateOfJoining: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, jobTitleName: true } as const;

/** An employee in the viewer's tenant and within their scope for a permission, or null. */
export async function scopedEmployee(viewer: Viewer, employeeId: string, perm: Permission) {
  if (!employeeId) return null;
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: EMP_SELECT });
  return e && canAccessEmployee(viewer, e, perm) ? e : null;
}

/** An employee of the tenant (no scope check — for self-service peers such as swap partners). */
export async function tenantEmployee(viewer: Viewer, employeeId: string) {
  if (!employeeId) return null;
  return prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: EMP_SELECT });
}

/** Select options for employees in scope. */
export async function employeeOptions(viewer: Viewer, perm: Permission, statuses?: string[]) {
  const rows = await prisma.employee.findMany({
    where: { AND: [scopedEmployeeWhere(viewer, perm), statuses ? { status: { in: statuses as never } } : { status: { notIn: ["EXITED"] } }] },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
  });
  return rows.map((e) => ({ value: e.id, label: `${e.employeeNumber} · ${e.displayName}` }));
}

/** employee id → name / number / department, tenant-bound. */
export async function peopleIndex(tenantId: string, ids?: Array<string | null | undefined>) {
  const list = ids ? [...new Set(ids.filter((i): i is string => !!i))] : null;
  const rows = await prisma.employee.findMany({ where: { tenantId, ...(list ? { id: { in: list } } : {}) }, select: { id: true, displayName: true, employeeNumber: true, userId: true, departmentId: true, locationId: true, department: { select: { name: true } }, location: { select: { name: true } } } });
  const m = new Map(rows.map((r) => [r.id, r]));
  return {
    rows, get: (id: string | null | undefined) => (id ? m.get(id) : undefined),
    name: (id: string | null | undefined) => (id ? m.get(id)?.displayName ?? "—" : "—"),
    number: (id: string | null | undefined) => (id ? m.get(id)?.employeeNumber ?? "" : ""),
    dept: (id: string | null | undefined) => (id ? m.get(id)?.department?.name ?? "" : ""),
    loc: (id: string | null | undefined) => (id ? m.get(id)?.location?.name ?? "" : ""),
  };
}

/** Whether the viewer is the employee's reporting manager. */
export async function managesEmployee(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (!viewer.employee) return false;
  return (await prisma.employee.count({ where: { id: employeeId, tenantId: viewer.tenantId, reportingManagerId: viewer.employee.id } })) > 0;
}
