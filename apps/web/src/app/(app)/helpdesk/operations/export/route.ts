import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { helpdeskScope, hasHelpdeskScope, helpdeskScopeWhere, helpdeskAgingReport } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { csv, csvResponse, ymd } from "@/lib/cases-docs";

/** CSV of the open-ticket aging report, limited to the agent's helpdesk scope. */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found.", { status: 404 });
  const scope = await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, PERMISSIONS.HELPDESK_MANAGE));
  if (!hasHelpdeskScope(scope) && !can(viewer, PERMISSIONS.HELPDESK_SETTINGS)) return new Response("Not found.", { status: 404 });
  const rep = await helpdeskAgingReport(viewer.tenantId, helpdeskScopeWhere(scope));
  const body = csv(["Category", ...rep.buckets, "Total"], rep.rows.map((r) => [r.category, ...rep.buckets.map((b) => r.counts[b] ?? 0), r.total]));
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "HELPDESK", action: "EXPORT", entityType: "HelpdeskTicket", summary: `Exported the helpdesk aging report (${rep.rows.length} categories)`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return csvResponse(`helpdesk-aging-${ymd(new Date())}.csv`, body);
}
