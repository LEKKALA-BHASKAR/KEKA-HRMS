import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { successionReport, SUCCESSION_REPORTS, type SuccessionReportKind } from "@/lib/growth-reports";

/** Succession and 9-box reports as CSV. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.SUCCESSION_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const k = req.nextUrl.searchParams.get("kind") ?? "plans";
  if (!(k in SUCCESSION_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as SuccessionReportKind;
  const r = await successionReport(viewer, kind);
  return csvDownload(viewer, { filename: `succession-${kind}.csv`, head: r.head, rows: r.rows, entityType: "SuccessionReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
