import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { form12bbPdf } from "@keka/services";
import { getViewer } from "@/lib/context";

/** Form 12BB for one of the signed-in employee's own declarations, protected by their PAN. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!viewer.employee) return new NextResponse("Not found.", { status: 404 });
  const fy = Number(req.nextUrl.searchParams.get("fy"));
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return new NextResponse("Choose a financial year.", { status: 400 });
  let file;
  try {
    file = await form12bbPdf(viewer.employee.id, fy);
  } catch {
    return new NextResponse("No investment declaration for that financial year.", { status: 404 });
  }
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "InvestmentDeclaration", entityId: viewer.employee.id, summary: `Downloaded ${file.summary}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
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
