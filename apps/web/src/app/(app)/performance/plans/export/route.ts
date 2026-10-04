import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { csvDownload } from "@/lib/growth";
import { plansReport, PLAN_REPORTS, type PlanReportKind } from "@/lib/growth-reports";

/** Improvement plans, check-ins, coaching and development actions as CSV. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.PIP_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const k = req.nextUrl.searchParams.get("kind") ?? "pips";
  if (!(k in PLAN_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as PlanReportKind;
  const r = await plansReport(viewer, kind);
  return csvDownload(viewer, { filename: `plans-${kind}.csv`, head: r.head, rows: r.rows, entityType: "PlanReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
