import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fnfReport, fnfReportCsv } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";

/** The settlements report as CSV, with the same scope and filters as the page. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const perm = can(viewer, PERMISSIONS.FNF_MANAGE) ? PERMISSIONS.FNF_MANAGE : can(viewer, PERMISSIONS.FNF_APPROVE) ? PERMISSIONS.FNF_APPROVE : null;
  if (!perm) return new NextResponse("Not found.", { status: 404 });
  const q = new URL(req.url).searchParams;
  const status = ["IN_REVIEW", "APPROVED", "FINALIZED", "PAID", "VOIDED"].includes(q.get("status") ?? "") ? q.get("status") : null;
  const fy = q.get("fy") === "all" ? null : Number(q.get("fy")) || null;
  const rows = await fnfReport(viewer.tenantId, { employeeWhere: scopedEmployeeWhere(viewer, perm) as never, status, fy });
  const filename = `FnF-Settlements${fy ? `-FY${fy}` : ""}${status ? `-${status}` : ""}.csv`;
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "FnfSettlement", summary: `Exported the settlements report (${rows.length} rows)`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(fnfReportCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
}
