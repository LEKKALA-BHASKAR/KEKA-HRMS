import { NextResponse, type NextRequest } from "next/server";
import { getViewer, can } from "@/lib/context";
import { REPORTS, defaultParams, formatCell } from "@/lib/reports";
import { prisma } from "@keka/db";
import { canOpenReport, standardReport } from "@/lib/insight/datasets";
import { downloadTable, isExportFormat } from "@/lib/insight/export";

/**
 * CSV of any report the viewer may run — the same rows the screen shows.
 * `format=xlsx|pdf` downloads Excel or PDF instead; a live access grant
 * opens a report the viewer's role does not.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const startedAt = Date.now();
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const report = REPORTS.find((r) => r.key === sp.r);
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  if (!can(viewer, report.permission) && !(await canOpenReport(viewer, report.key))) return new NextResponse("Forbidden.", { status: 403 });
  if (sp.format && sp.format !== "csv") {
    if (!isExportFormat(sp.format)) return new NextResponse("Format must be csv, xlsx or pdf.", { status: 400 });
    const table = await standardReport(viewer, report.key, sp);
    if (!table) return new NextResponse("Forbidden.", { status: 403 });
    return downloadTable(viewer, `report:${report.key}`, table, sp.format, startedAt);
  }

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
