import { NextResponse } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { carrierCensus } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";

/** The member census for one plan, to send to the insurer. */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.BENEFIT_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const planId = new URL(req.url).searchParams.get("planId") ?? "";
  const c = await carrierCensus(viewer.tenantId, planId, viewer.user.id);
  if (!c) return new NextResponse("Not found.", { status: 404 });
  return moneyCsv(viewer, { module: "PAYROLL", filename: `census-${c.plan.code}-${new Date().toISOString().slice(0, 10)}.csv`, head: c.head, rows: c.rows, entityType: "BenefitCarrierFile", summary: `Insurer census exported for ${c.plan.name} (${c.rows.length} members)` });
}
