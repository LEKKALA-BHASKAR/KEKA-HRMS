import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { completenessByEmployee } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { csv, csvResponse, ymd } from "@/lib/cases-docs";

/** CSV: mandatory-document completeness per employee in the viewer's scope. */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer || !can(viewer, PERMISSIONS.DOCUMENT_MANAGE)) return new Response("Not found.", { status: 404 });
  const scope = employeeScopeFilter(viewer, PERMISSIONS.DOCUMENT_VIEW) as Prisma.EmployeeWhereInput | null;
  const rows = await completenessByEmployee(viewer.tenantId, scope ?? {});
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType: "EmployeeDocument", summary: `Exported document completeness (${rows.length} employees)`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return csvResponse(`document-completeness-${ymd(new Date())}.csv`, csv(["Employee no.", "Name", "Department", "Mandatory", "Done", "Percent"], rows.map((r) => [r.number, r.name, r.department ?? "", r.required, r.done, r.percent])));
}
