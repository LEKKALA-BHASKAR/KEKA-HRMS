import { NextResponse, type NextRequest } from "next/server";
import { getViewer, can } from "@/lib/context";
import { REPORTS, defaultParams, formatCell } from "@/lib/reports";
import { prisma } from "@keka/db";

/** CSV of any report the viewer may run — the same rows the screen shows. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const report = REPORTS.find((r) => r.key === sp.r);
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  if (!can(viewer, report.permission)) return new NextResponse("Forbidden.", { status: 403 });

  const result = await report.run(viewer, defaultParams(viewer, sp));
  // Spreadsheet apps execute cells that start with = + - @; neutralise them.
  const esc = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    result.columns.map((c) => esc(c.label)).join(","),
    ...result.rows.map((row) => result.columns.map((c) => esc(formatCell(row[c.key], c.format))).join(",")),
    ...(result.totals ? [result.columns.map((c) => esc(formatCell(result.totals![c.key], c.format))).join(",")] : []),
  ];
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType: "Report", entityId: report.key,
      summary: `Exported ${report.title} (${result.rows.length} rows)`, actorId: viewer.user.id, actorLabel: viewer.user.email,
    },
  });
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.key}-${sp.fy ?? "current"}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
