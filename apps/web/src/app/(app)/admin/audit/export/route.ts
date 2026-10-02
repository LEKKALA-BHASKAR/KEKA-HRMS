import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { safeCsv } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { auditWhere } from "../filters";

/** Up to this many rows per download; narrow the dates for more. */
const MAX_ROWS = 50_000;

/** CSV of the audit log with the page's filters — every page, not just the one on screen. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.AUDIT_LOG_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const f = Object.fromEntries(req.nextUrl.searchParams.entries());
  const where = auditWhere(viewer.tenantId, f);
  const logs = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: MAX_ROWS });
  const json = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v));
  const csv = safeCsv(
    ["When (UTC)", "Module", "Action", "Entity type", "Entity id", "Summary", "Actor", "Actor id", "IP address", "Old value", "New value"],
    logs.map((l) => [
      l.createdAt.toISOString().replace("T", " ").slice(0, 19), l.module, l.action, l.entityType, l.entityId ?? "", l.summary ?? "",
      l.actorLabel ?? "system", l.actorId ?? "", l.ipAddress ?? "", json(l.oldValue), json(l.newValue),
    ]),
  );
  // Exporting the audit log is itself audited.
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module: "SYSTEM", action: "EXPORT", entityType: "AuditLog",
      summary: `Exported ${logs.length} audit log entr${logs.length === 1 ? "y" : "ies"}${logs.length === MAX_ROWS ? " (limit reached)" : ""}`,
      actorId: viewer.user.id, actorLabel: viewer.user.email, newValue: f,
    },
  });
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
