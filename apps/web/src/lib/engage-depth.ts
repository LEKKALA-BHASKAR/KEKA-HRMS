import "server-only";
import { prisma } from "@keka/db";

/** Lookups shared by the engage depth pages (rewards, wellness, services, communities, events). */

/** employee id → display name. */
export async function employeeNames(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((i): i is string => !!i))];
  if (list.length === 0) return new Map();
  const rows = await prisma.employee.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, displayName: true, firstName: true, lastName: true } });
  return new Map(rows.map((r) => [r.id, r.displayName ?? `${r.firstName} ${r.lastName}`]));
}

export const fmtDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
export const fmtTime = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
/** An instant as an IST datetime-local value. */
export const toLocalInput = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16) : "");
export const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const opts = (list: readonly string[]) => list.map((v) => ({ value: v, label: pretty(v) }));
/** Case-insensitive text match for in-memory search. */
export const matches = (q: string | undefined, ...fields: Array<string | null | undefined>) => !q || fields.some((f) => (f ?? "").toLowerCase().includes(q.toLowerCase()));
