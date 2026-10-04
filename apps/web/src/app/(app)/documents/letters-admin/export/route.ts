import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { letterSearchWhere } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { csv, csvResponse, ymd } from "@/lib/cases-docs";

const d = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null);

/** CSV of the letter register matching the search, within the viewer's letter scope. */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer || !can(viewer, PERMISSIONS.LETTER_GENERATE)) return new Response("Not found.", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const scope = employeeScopeFilter(viewer, PERMISSIONS.LETTER_GENERATE) as Prisma.EmployeeWhereInput | null;
  const where = letterSearchWhere(viewer.tenantId, scope, { q: sp.get("q") ?? undefined, category: sp.get("category") ?? undefined, status: sp.get("status") ?? undefined, templateId: sp.get("templateId") ?? undefined, from: d(sp.get("from")), to: d(sp.get("to")) });
  const rows = await prisma.generatedDocument.findMany({ where, include: { template: { select: { name: true, category: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { issuedOn: "asc" }, take: 20000 });
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType: "GeneratedDocument", summary: `Exported the letter register (${rows.length} letters)`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return csvResponse(`letters-${ymd(new Date())}.csv`, csv(
    ["Letter number", "Template", "Category", "Employee no.", "Employee", "Issued", "Valid until", "Status", "Automatic", "Times sent", "Acknowledged", "Signed"],
    rows.map((l) => [l.letterNumber ?? "", l.template.name, l.template.category, l.employee.employeeNumber, l.employee.displayName, ymd(l.issuedOn), ymd(l.validUntil), l.status, l.triggerEvent ?? "", l.sentCount, ymd(l.acknowledgedAt), ymd(l.signedAt)]),
  ));
}
