import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { formatCell } from "@/lib/reports";
import { savedReportFor, resolveSpec, runCustomReport } from "@/lib/report-builder";

/** CSV of a custom report: a saved one by id, or an unsaved spec (builders only). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, P.REPORT_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  const raw = req.nextUrl.searchParams.get("spec");
  const saved = id ? await savedReportFor(viewer, id) : null;
  if (id && !saved) return new NextResponse("Report not found.", { status: 404 });
  if (!id && !can(viewer, P.REPORT_BUILD)) return new NextResponse("Forbidden.", { status: 403 });
  const result = await runCustomReport(viewer, resolveSpec(raw ?? undefined, saved, undefined));
  if (!result.ok) return new NextResponse(result.errors.join(" "), { status: 400 });

  // Spreadsheet apps execute cells that start with = + - @; neutralise them.
  const esc = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const cell = (v: unknown, f?: Parameters<typeof formatCell>[1]) => esc(typeof v === "boolean" ? (v ? "Yes" : "No") : formatCell(v, f));
  const lines = [
    result.columns.map((c) => esc(c.label)).join(","),
    ...result.rows.map((row) => result.columns.map((c) => cell(row[c.key], c.format)).join(",")),
    ...(result.totals ? [result.columns.map((c, j) => (result.totals![c.key] !== undefined ? cell(result.totals![c.key], c.format) : j === 0 ? "Total" : "")).join(",")] : []),
  ];
  const name = saved?.name ?? `custom-${result.dataset.key}`;
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType: saved ? "SavedReport" : "Report", entityId: saved?.id ?? `custom:${result.dataset.key}`,
      summary: `Exported custom report ${name} (${result.rows.length} rows)`, actorId: viewer.user.id, actorLabel: viewer.user.email,
    },
  });
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.csv"`, "Cache-Control": "no-store" },
  });
}
