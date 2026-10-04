import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, canAny } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { hireReport, HIRE_REPORTS, type HireReportKind } from "@/lib/hire-insights";

/** Hire › Insights reports as CSV (each download is audited as an export). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(viewer, [PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE])) return new NextResponse("Forbidden.", { status: 403 });
  const k = req.nextUrl.searchParams.get("kind") ?? "sources";
  if (!(k in HIRE_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as HireReportKind;
  const days = Math.min(730, Math.max(7, Number(req.nextUrl.searchParams.get("days") ?? 180) || 180));
  const r = await hireReport(viewer.tenantId, kind, new Date(Date.now() - days * 86_400_000));
  return csvDownload(viewer, { filename: `hiring-${kind}.csv`, head: r.head, rows: r.rows, entityType: "HireReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows, last ${days} days)` });
}
