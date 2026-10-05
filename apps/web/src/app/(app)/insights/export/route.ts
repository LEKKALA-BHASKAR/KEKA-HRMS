import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { pickColumns } from "@keka/services";
import { getViewer } from "@/lib/context";
import { runDataset } from "@/lib/insight/datasets";
import { downloadTable, isExportFormat, recordReportRun } from "@/lib/insight/export";

/**
 * Download any insight table as CSV, Excel or PDF: `?ds=<dataset>&format=…`
 * plus the dataset's own filters. `profile=<id>` applies a saved export
 * profile (its columns and format); a sensitive profile needs an approved,
 * unexpired export request by the person downloading.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const startedAt = Date.now();
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  let ds = sp.ds ?? "";
  let format = (sp.format ?? "csv").toLowerCase();
  let keep: string[] | null = null;
  if (sp.profile) {
    const p = await prisma.insightExportProfile.findFirst({ where: { id: sp.profile, tenantId: viewer.tenantId, isActive: true } });
    if (!p) return new NextResponse("Unknown export profile.", { status: 404 });
    if (p.sensitive) {
      const ok = await prisma.insightExportRequest.findFirst({ where: { tenantId: viewer.tenantId, profileId: p.id, requesterUserId: viewer.user.id, status: "APPROVED", expiresAt: { gt: new Date() } } });
      if (!ok) return new NextResponse("This export holds sensitive data: request it and wait for approval first.", { status: 403 });
      await prisma.insightExportRequest.update({ where: { id: ok.id }, data: { downloadedAt: new Date() } });
    }
    ds = p.reportKey;
    format = p.format.toLowerCase();
    keep = p.columns.length ? p.columns : null;
  }
  if (!isExportFormat(format)) return new NextResponse("Format must be csv, xlsx or pdf.", { status: 400 });
  const table = await runDataset(viewer, ds, sp);
  if (!table) {
    await recordReportRun(viewer, viewer.tenantId, { reportKey: ds || "unknown", title: ds || "unknown", trigger: "EXPORT", format, rows: 0, startedAt, error: "Not allowed or not found" });
    return new NextResponse("Not found, or you do not have access.", { status: 403 });
  }
  if (keep) table.columns = pickColumns(table.columns, keep);
  return downloadTable(viewer, ds, table, format, startedAt, ds.startsWith("people:") || ds.startsWith("cohort:") || ds === "metrics" || ds === "kpis" ? "ANALYTICS" : "REPORT");
}
