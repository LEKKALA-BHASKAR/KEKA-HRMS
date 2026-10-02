import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { helpdeskScope, inHelpdeskScope } from "@keka/services";
import { can, type Viewer } from "@/lib/context";

/**
 * How the viewer relates to one ticket — the same rules the actions apply:
 * the raiser owns it, agents work it when its category is in their scope
 * (never their own ticket), and followers may read it.
 */
export async function ticketAccess(viewer: Viewer, ticketId: string) {
  const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: ticketId, tenantId: viewer.tenantId }, select: { id: true, employeeId: true, categoryId: true } });
  if (!ticket) return null;
  const scope = await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, PERMISSIONS.HELPDESK_MANAGE));
  const own = ticket.employeeId === viewer.employee?.id;
  const agent = !own && inHelpdeskScope(scope, ticket.categoryId);
  const follower = !own && !agent && (await prisma.helpdeskTicketFollower.count({ where: { ticketId, userId: viewer.user.id } })) > 0;
  return { own, agent, follower, scope };
}

/** Users who can sign in, for heads, agents and followers. */
export async function userOptions(tenantId: string) {
  const users = await prisma.user.findMany({
    where: { tenantId, loginDisabled: false, employee: { isNot: null } },
    select: { id: true, email: true, employee: { select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true } } },
  });
  return users
    .map((u) => ({ value: u.id, employeeId: u.employee!.id, label: u.employee!.displayName ?? `${u.employee!.firstName} ${u.employee!.lastName}`, meta: u.employee!.employeeNumber }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
