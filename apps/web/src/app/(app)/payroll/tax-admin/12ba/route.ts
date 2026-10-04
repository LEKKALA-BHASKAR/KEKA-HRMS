import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { form12baPdf } from "@keka/services";
import { getViewer } from "@/lib/context";

/** Form 12BA for one employee and year (?employee=&fy=), for the payroll team. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const employeeId = req.nextUrl.searchParams.get("employee") ?? "";
  const fy = Number(req.nextUrl.searchParams.get("fy"));
  if (!(fy > 2000 && fy < 2100)) return new NextResponse("Choose a financial year.", { status: 400 });
  const t = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  if (!t || !canAccessEmployee(viewer, t, PERMISSIONS.TAX_DECLARATION_APPROVE)) return new NextResponse("Not found.", { status: 404 });
  try {
    const f = await form12baPdf(viewer.tenantId, employeeId, fy);
    await prisma.auditLog.create({
      data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "Form12BA", entityId: employeeId, summary: `Generated Form 12BA for FY${fy}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
    });
    return new NextResponse(new Uint8Array(f.content), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${f.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not build Form 12BA.", { status: 409 });
  }
}
