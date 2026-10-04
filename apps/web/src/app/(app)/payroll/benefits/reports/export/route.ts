import { NextResponse } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { benefitReport } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";

const KINDS = ["enrollments", "plans", "dependents", "deductions", "eligibility"] as const;

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.BENEFIT_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const kind = new URL(req.url).searchParams.get("report") as (typeof KINDS)[number] | null;
  if (!kind || !KINDS.includes(kind)) return new NextResponse("Unknown report.", { status: 400 });
  const r = await benefitReport(viewer.tenantId, kind);
  return moneyCsv(viewer, { module: "PAYROLL", filename: `benefits-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, head: r.head, rows: r.rows, entityType: "BenefitReport", summary: `${r.title} report exported (${r.rows.length} rows)` });
}
