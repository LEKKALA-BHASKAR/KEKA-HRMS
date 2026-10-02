import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { buildForm24qStatement } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/**
 * The quarter's 24Q data as a structured CSV (?fy=2026&q=2). This is not an
 * NSDL FVU file: it is keyed into the Return Preparation Utility, and the
 * prepared return must be validated with the official FVU.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.STATUTORY_MANAGE)) return new NextResponse("Not found.", { status: 404 });
  const fy = Number(req.nextUrl.searchParams.get("fy")), q = Number(req.nextUrl.searchParams.get("q"));
  if (!(fy > 2000 && q >= 1 && q <= 4)) return new NextResponse("Choose a financial year and quarter.", { status: 400 });
  try {
    const file = await buildForm24qStatement(viewer.tenantId, fy, q);
    await prisma.auditLog.create({
      data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "StatutoryFiling", summary: `Exported Form 24Q statement Q${q} FY${fy}: ${file.summary}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
    });
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not build the statement.", { status: 409 });
  }
}
