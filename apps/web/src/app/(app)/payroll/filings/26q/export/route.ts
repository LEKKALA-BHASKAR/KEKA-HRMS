import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { buildForm26q } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/**
 * The quarter's 26Q data (contractor TDS) as a structured CSV (?fy=2026&q=2).
 * Like the 24Q export, it is keyed into the Return Preparation Utility and the
 * prepared return validated with the official FVU.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.STATUTORY_MANAGE)) return new NextResponse("Not found.", { status: 404 });
  const fy = Number(req.nextUrl.searchParams.get("fy")), q = Number(req.nextUrl.searchParams.get("q"));
  if (!(fy > 2000 && q >= 1 && q <= 4)) return new NextResponse("Choose a financial year and quarter.", { status: 400 });
  const file = await buildForm26q(viewer.tenantId, fy, q);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "StatutoryFiling", summary: `Exported Form 26Q data Q${q} FY${fy}: ${file.count} payment(s), TDS ₹${file.tds}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(file.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
