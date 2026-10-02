import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { fnfStatementPdf } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/** The full-and-final statement for an exit, as a PDF. Settlement rights over the employee only. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const exit = await prisma.exitRecord.findFirst({
    where: { id, employee: { tenantId: viewer.tenantId } },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!exit) return new NextResponse("Not found.", { status: 404 });
  const allowed = [PERMISSIONS.FNF_MANAGE, PERMISSIONS.FNF_APPROVE].some((p) => can(viewer, p) && canAccessEmployee(viewer, exit.employee, p));
  // Not-found rather than forbidden, so ids cannot be probed.
  if (!allowed) return new NextResponse("Not found.", { status: 404 });
  let st;
  try {
    st = await fnfStatementPdf(exit.employeeId, viewer.tenantId);
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "No settlement.", { status: 404 });
  }
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "FnfSettlement", entityId: st.settlementId, summary: `Downloaded ${st.filename}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(st.content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${st.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
