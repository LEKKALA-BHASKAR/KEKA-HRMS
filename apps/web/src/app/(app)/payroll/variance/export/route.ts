import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { varianceReport, varianceCsv } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/** Variance by employee or component, or the reconciliation, as CSV (?run=&kind=). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.PAYROLL_VIEW)) return new NextResponse("Not found.", { status: 404 });
  const runId = req.nextUrl.searchParams.get("run") ?? "";
  const k = req.nextUrl.searchParams.get("kind");
  const kind = k === "components" || k === "reconciliation" ? k : "employees";
  const v = await varianceReport(viewer.tenantId, runId);
  if (!v) return new NextResponse("Not found.", { status: 404 });
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "PayrollRun", entityId: runId, summary: `Exported payroll ${kind} variance for ${v.run.year}-${String(v.run.month).padStart(2, "0")}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(varianceCsv(v, kind), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${kind}-${v.run.year}-${String(v.run.month).padStart(2, "0")}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
