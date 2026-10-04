import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { complianceTable, complianceCsv, type ComplianceKind } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/** A compliance report as CSV (?tab=min-wage|coverage|pt-lwf&period=YYYY-MM&category=). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.STATUTORY_MANAGE)) return new NextResponse("Not found.", { status: 404 });
  const sp = req.nextUrl.searchParams;
  const t = sp.get("tab");
  const kind: ComplianceKind = t === "coverage" || t === "pt-lwf" ? t : "min-wage";
  const m = /^(\d{4})-(\d{2})$/.exec(sp.get("period") ?? "");
  if (!m) return new NextResponse("Choose a month.", { status: 400 });
  const table = await complianceTable(viewer.tenantId, kind, Number(m[1]), Number(m[2]), sp.get("category") ?? "UNSKILLED");
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "ComplianceReport", summary: `Exported the ${kind} compliance report for ${m[0]}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(complianceCsv(table), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="compliance-${kind}-${m[0]}.csv"`, "Cache-Control": "private, no-store" },
  });
}
