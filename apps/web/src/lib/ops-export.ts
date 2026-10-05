import { prisma, type AuditModule } from "@keka/db";
import { safeCsv } from "@keka/services";

/**
 * CSV downloads for the ops control pages. Every download writes an EXPORT
 * audit entry (who, what, how many rows) before the file is returned; cells
 * are escaped against spreadsheet formula injection.
 */
export async function opsCsv(
  viewer: { tenantId: string; user: { id: string; email: string } },
  module: AuditModule, entityType: string, name: string, head: string[], rows: unknown[][],
): Promise<Response> {
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module, action: "EXPORT", entityType, summary: `Exported ${name} (${rows.length} row${rows.length === 1 ? "" : "s"})`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new Response("﻿" + safeCsv(head, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const d10 = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");
export const dayParam = (v: string | null | undefined, fallback: Date) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : fallback);
export const monthParam = (v: string | null | undefined, now = new Date()): [number, number] => (v && /^\d{4}-\d{2}$/.test(v) ? (v.split("-").map(Number) as [number, number]) : [now.getUTCFullYear(), now.getUTCMonth() + 1]);
