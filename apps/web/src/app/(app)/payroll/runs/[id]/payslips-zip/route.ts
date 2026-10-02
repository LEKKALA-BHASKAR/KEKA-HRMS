import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { payslipZip } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { scopedEmployeeIds } from "@/lib/scope";

/** Every payslip of a finalised run that the viewer may see, as one ZIP of PAN-protected PDFs. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.PAY_REGISTER_VIEW)) return new NextResponse("Not found.", { status: 404 });
  const { id } = await params;
  const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!run) return new NextResponse("Not found.", { status: 404 });
  const scope = await scopedEmployeeIds(viewer, PERMISSIONS.PAY_REGISTER_VIEW);
  try {
    const file = await payslipZip(run.id, viewer.tenantId, scope ?? undefined);
    await prisma.auditLog.create({
      data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "PayrollRun", entityId: run.id, summary: `Downloaded ${file.count} payslip PDF(s) as ${file.filename}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
    });
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not build the bundle.", { status: 409 });
  }
}
