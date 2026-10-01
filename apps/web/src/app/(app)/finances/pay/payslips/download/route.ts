import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { payslipBundlePdf } from "@keka/services";
import { getViewer } from "@/lib/context";

/**
 * "Pay Slips - Last 3 / 6 / 12 months": the signed-in employee's own latest
 * released payslips in one PDF, which opens with their PAN.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!viewer.employee) return new NextResponse("Not found.", { status: 404 });
  const last = Number(req.nextUrl.searchParams.get("last"));
  if (last !== 3 && last !== 6 && last !== 12) return new NextResponse("Choose 3, 6 or 12 months.", { status: 400 });
  let file;
  try {
    file = await payslipBundlePdf(viewer.employee.id, last);
  } catch {
    return new NextResponse("No released payslips to download.", { status: 404 });
  }
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "Payslip", entityId: viewer.employee.id, summary: `Downloaded ${file.summary}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
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
