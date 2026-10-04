import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { statutoryBonusReport, statutoryBonusCsv } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/** The statutory bonus computation for an accounting year as CSV (?fy=2025). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.STATUTORY_MANAGE)) return new NextResponse("Not found.", { status: 404 });
  const fy = Number(req.nextUrl.searchParams.get("fy"));
  if (!(fy > 2000 && fy < 2100)) return new NextResponse("Choose a year.", { status: 400 });
  const rep = await statutoryBonusReport(viewer.tenantId, fy);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "StatutoryBonus", summary: `Exported the statutory bonus computation for FY${fy}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(statutoryBonusCsv(rep, fy), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="statutory-bonus-FY${fy}.csv"`, "Cache-Control": "private, no-store" },
  });
}
