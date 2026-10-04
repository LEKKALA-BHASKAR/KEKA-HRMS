import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { erVisibleWhere, erRef, ER_KINDS, ER_CATEGORIES, ER_OUTCOMES } from "@keka/services";
import { getViewer, can, canAny } from "@/lib/context";
import { csv, csvResponse, ymd } from "@/lib/cases-docs";

/** CSV of the employee relations cases the viewer may see (case register). No descriptions: those stay in the app. */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer || !canAny(viewer, [PERMISSIONS.ER_CASE_MANAGE, PERMISSIONS.ER_CASE_APPROVE])) return new Response("Not found.", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const where = await erVisibleWhere({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null, canManage: can(viewer, PERMISSIONS.ER_CASE_MANAGE), canApprove: can(viewer, PERMISSIONS.ER_CASE_APPROVE) });
  const rows = await prisma.erCase.findMany({
    where: { AND: [where, sp.get("kind") ? { kind: sp.get("kind")! } : {}, sp.get("status") ? { status: sp.get("status")! } : {}, sp.get("severity") ? { severity: sp.get("severity")! } : {}] },
    orderBy: { number: "asc" }, include: { actions: { select: { actionType: true, status: true } } },
  });
  const people = new Map((await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: rows.map((r) => r.subjectEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, employeeNumber: true } })).map((e) => [e.id, e.employeeNumber]));
  const body = csv(
    ["Case", "Kind", "Category", "Severity", "Status", "Confidential", "Anonymous", "Subject employee no.", "Opened", "Resolved", "Closed", "Outcome", "Actions issued", "Retain until"],
    rows.map((r) => [
      erRef(r.number), ER_KINDS[r.kind as keyof typeof ER_KINDS] ?? r.kind, ER_CATEGORIES[r.category as keyof typeof ER_CATEGORIES] ?? r.category, r.severity, r.status,
      r.isConfidential ? "Yes" : "No", r.isAnonymous ? "Yes" : "No", r.subjectEmployeeId ? people.get(r.subjectEmployeeId) ?? "" : "", ymd(r.createdAt), ymd(r.resolvedAt), ymd(r.closedAt),
      r.outcome ? ER_OUTCOMES[r.outcome as keyof typeof ER_OUTCOMES] : "", r.actions.filter((a) => a.status === "ISSUED").map((a) => a.actionType).join(" "), ymd(r.retainUntil),
    ]),
  );
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "LIFECYCLE", action: "EXPORT", entityType: "ErCase", summary: `Exported the case register (${rows.length} cases)`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return csvResponse(`employee-relations-${ymd(new Date())}.csv`, body);
}
