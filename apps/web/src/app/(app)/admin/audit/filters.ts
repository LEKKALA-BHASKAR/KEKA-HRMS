import type { Prisma } from "@keka/db";

/**
 * The audit log's filters, shared by the page and its CSV export so the
 * download is exactly the rows on screen (all pages of them).
 */

export const AUDIT_MODULES = ["EMPLOYEE", "PAYROLL", "LEAVE", "ATTENDANCE", "ROLE", "AUTH", "FINANCE", "REPORT", "LIFECYCLE", "HELPDESK", "SYSTEM", "ANALYTICS", "ASSET", "PROJECTS"] as const;
export const AUDIT_ACTIONS = ["CREATE", "UPDATE", "DELETE", "APPROVE", "REJECT", "LOCK", "UNLOCK", "EXPORT", "LOGIN", "LOGOUT", "VIEW"] as const;

export interface AuditFilters { module?: string; action?: string; from?: string; to?: string; q?: string }

const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null);

export function auditWhere(tenantId: string, f: AuditFilters): Prisma.AuditLogWhereInput {
  const from = day(f.from), to = day(f.to);
  return {
    tenantId,
    ...((AUDIT_MODULES as readonly string[]).includes(f.module ?? "") ? { module: f.module as never } : {}),
    ...((AUDIT_ACTIONS as readonly string[]).includes(f.action ?? "") ? { action: f.action as never } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) } } : {}),
    ...(f.q?.trim() ? { OR: [{ summary: { contains: f.q.trim(), mode: "insensitive" as const } }, { actorLabel: { contains: f.q.trim(), mode: "insensitive" as const } }] } : {}),
  };
}

/** The filters as a query string, for pagination links and the download. */
export function auditQuery(f: AuditFilters, extra: Record<string, string | number> = {}): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== undefined && v !== "") u.set(k, String(v));
  return u.toString();
}
