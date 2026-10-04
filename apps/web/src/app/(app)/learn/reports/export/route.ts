import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, canAny } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { learningReport, LEARNING_REPORTS, type LearningReportKind } from "@/lib/growth-reports";

/** A learning report as CSV — the same rows the Learning Reports page shows. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(viewer, [PERMISSIONS.COURSE_ASSIGN, PERMISSIONS.COURSE_MANAGE])) return new NextResponse("Forbidden.", { status: 403 });
  const k = req.nextUrl.searchParams.get("kind") ?? "records";
  if (!(k in LEARNING_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as LearningReportKind;
  const r = await learningReport(viewer, kind, (req.nextUrl.searchParams.get("q") ?? "").slice(0, 80));
  return csvDownload(viewer, { filename: `learning-${kind}.csv`, head: r.head, rows: r.rows, entityType: "LearningReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
