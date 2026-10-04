import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { skillsReport, SKILL_REPORTS, type SkillReportKind } from "@/lib/growth-reports";

/** Skill inventory, competency gaps, assessment history and the library as CSV. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.SKILL_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const k = req.nextUrl.searchParams.get("kind") ?? "inventory";
  if (!(k in SKILL_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as SkillReportKind;
  const r = await skillsReport(viewer, kind, req.nextUrl.searchParams.get("frameworkId") ?? undefined);
  return csvDownload(viewer, { filename: `skills-${kind}.csv`, head: r.head, rows: r.rows, entityType: "SkillReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
