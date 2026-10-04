import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { mobilityReport, MOBILITY_REPORTS, type MobilityReportKind } from "@/lib/growth-reports";

/** Career and internal mobility reports as CSV. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const k = req.nextUrl.searchParams.get("kind") ?? "applications";
  if (!(k in MOBILITY_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as MobilityReportKind;
  const perm = kind === "aspirations" || kind === "development" ? PERMISSIONS.CAREER_PATH_MANAGE : PERMISSIONS.MOBILITY_MANAGE;
  if (!can(viewer, perm)) return new NextResponse("Forbidden.", { status: 403 });
  const r = await mobilityReport(viewer, kind);
  return csvDownload(viewer, { filename: `mobility-${kind}.csv`, head: r.head, rows: r.rows, entityType: "MobilityReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
