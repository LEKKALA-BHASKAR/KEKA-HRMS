import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { buildBatchBankFile } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/** One payment batch as a bank upload CSV (?batch=…). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.PAYROLL_LOCK)) return new NextResponse("Not found.", { status: 404 });
  const { id } = await params;
  const batchId = req.nextUrl.searchParams.get("batch") ?? "";
  const batch = await prisma.paymentBatch.findFirst({ where: { id: batchId, runId: id, tenantId: viewer.tenantId } });
  if (!batch) return new NextResponse("Not found.", { status: 404 });
  const file = await buildBatchBankFile(batch.id, viewer.tenantId);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "PaymentBatch", entityId: batch.id, summary: `Downloaded bank file for batch ${batch.number}: ${file.summary}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
