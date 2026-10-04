import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { registerData, registerCsv } from "@keka/services";
import { getViewer } from "@/lib/context";

const P = PERMISSIONS;

/**
 * Pay register as CSV, in the pay group's saved column layout (the same
 * columns as the page). Every cell is escaped; totals row included.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });
  if (!viewer.permissions.has(P.PAY_REGISTER_VIEW)) {
    return new Response("Forbidden", { status: 403 });
  }

  const runId = new URL(request.url).searchParams.get("run");
  if (!runId) return new Response("Missing run parameter", { status: 400 });

  const data = await registerData(viewer.tenantId, runId);
  if (!data) return new Response("Not found", { status: 404 });

  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "PayrollRun", entityId: runId, summary: `Exported the pay register for ${data.run.year}-${String(data.run.month).padStart(2, "0")}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  const filename = `pay-register-${data.run.year}-${String(data.run.month).padStart(2, "0")}.csv`;
  return new Response(registerCsv(data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
