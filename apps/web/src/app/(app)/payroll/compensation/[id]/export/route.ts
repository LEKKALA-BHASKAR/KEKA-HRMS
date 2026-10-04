import { NextResponse } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { compPlanReport } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.SALARY_REVISE)) return new NextResponse("Forbidden.", { status: 403 });
  const { id } = await params;
  const r = await compPlanReport(viewer.tenantId, id);
  if (!r) return new NextResponse("Not found.", { status: 404 });
  return moneyCsv(viewer, { module: "PAYROLL", filename: `comp-plan-${r.plan.name.replace(/[^A-Za-z0-9]+/g, "-")}.csv`, head: r.head, rows: r.rows, entityType: "CompPlan", summary: `Compensation worksheet exported: ${r.plan.name} (${r.rows.length} lines)` });
}
