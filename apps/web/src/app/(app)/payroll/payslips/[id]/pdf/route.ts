import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { payslipPdf } from "@keka/services";
import { getViewer } from "@/lib/context";

/** A payslip as a PDF, protected by the employee's PAN in upper case. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const slip = await prisma.payslip.findFirst({
    where: { id, employee: { tenantId: viewer.tenantId } },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!slip) return new NextResponse("Not found.", { status: 404 });
  // An employee sees their own payslip once it is released; payroll staff
  // see payslips of people in their scope.
  const own = slip.employeeId === viewer.employee?.id && slip.status === "RELEASED";
  const staff = canAccessEmployee(viewer, slip.employee, PERMISSIONS.PAY_REGISTER_VIEW);
  if (!own && !staff) return new NextResponse("Not found.", { status: 404 });

  const { file } = await payslipPdf(id);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "Payslip", entityId: id, summary: `Downloaded payslip PDF ${file.filename}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
