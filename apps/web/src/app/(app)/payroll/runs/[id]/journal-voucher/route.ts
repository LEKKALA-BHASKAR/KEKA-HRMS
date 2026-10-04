import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { exportJournalVoucher } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/**
 * The run's journal voucher as a spreadsheet-ready CSV (opens in Excel),
 * optionally split by department as cost centre (?by=department). Each
 * export is kept as a new voucher version; earlier versions are archived.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.PAYROLL_RUN)) return new NextResponse("Not found.", { status: 404 });
  const { id } = await params;
  const res = await exportJournalVoucher(viewer.tenantId, id, { byDepartment: req.nextUrl.searchParams.get("by") === "department" });
  if (!res.ok) return new NextResponse(res.message, { status: res.message.includes("not found") ? 404 : 409 });
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "JournalVoucher", entityId: id, summary: `Exported journal voucher v${res.version}${res.balanced ? "" : " (not balanced)"}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(res.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${res.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
