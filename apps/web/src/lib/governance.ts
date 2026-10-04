import "server-only";
import { prisma } from "@keka/db";

/** Lookups shared by the workflow, security and compliance pages. */

export async function userOptions(tenantId: string) {
  const users = await prisma.user.findMany({ where: { tenantId, loginDisabled: false }, select: { id: true, email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } }, orderBy: { email: "asc" } });
  return users.map((u) => ({ value: u.id, label: u.employee ? `${u.employee.displayName ?? `${u.employee.firstName} ${u.employee.lastName}`} (${u.email})` : u.email }));
}

export async function roleOptions(tenantId: string) {
  return (await prisma.role.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } })).map((r) => ({ value: r.id, label: r.name }));
}

export async function departmentOptions(tenantId: string) {
  return (await prisma.department.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } })).map((d) => ({ value: d.id, label: d.name }));
}

export async function locationOptions(tenantId: string) {
  return (await prisma.location.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } })).map((d) => ({ value: d.id, label: d.name }));
}

export async function employeeOptions(tenantId: string) {
  return (await prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, orderBy: { firstName: "asc" }, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true } }))
    .map((e) => ({ value: e.id, label: `${e.displayName ?? `${e.firstName} ${e.lastName}`} (${e.employeeNumber})` }));
}

/** user id → display name (or email). */
export async function userNames(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((i): i is string => !!i))];
  if (list.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? u.employee.displayName ?? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}

export const fmtDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
export const fmtWhen = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  PENDING: "warning", PENDING_APPROVAL: "warning", APPROVED: "success", REJECTED: "danger", WITHDRAWN: "neutral", ERROR: "danger",
  ACTIVE: "success", DRAFT: "neutral", PAUSED: "neutral", COMPLETED: "success", OPEN: "warning", IN_PROGRESS: "info", SUBMITTED: "info",
  EXCEPTION: "neutral", OVERDUE: "danger", DUE_SOON: "warning", CLOSED: "neutral", IN_REMEDIATION: "info", EXPIRED: "neutral", REVOKED: "neutral",
  CONFIRMED: "success", APPLIED: "success", FAILED: "danger", SUCCESS: "success", PARTIAL: "warning", RUNNING: "info", DRY_RUN: "info",
  PUBLISHED: "success", RETIRED: "neutral", GRANTED: "success", DECLINED: "danger", ACKNOWLEDGED: "neutral", HIGH: "danger", CRITICAL: "danger", MEDIUM: "warning", LOW: "info", DONE: "success",
};
export const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
