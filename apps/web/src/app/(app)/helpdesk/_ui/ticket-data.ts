import "server-only";
import { prisma } from "@keka/db";
import {
  helpdeskCategoryPath, helpdeskUserNames, helpdeskAssignableUsers, resolveFollowerRoles,
  ticketStatusOf, ticketPriorityOf, isTicketClosed, HELPDESK_FOLLOWER_ROLES, REOPEN_DAYS, type HelpdeskFollowerRole,
} from "@keka/services";
import type { Viewer } from "@/lib/context";
import { attachmentsFor, leafCategories } from "./data";
import { userOptions } from "./ticket-access";
import type { ThreadItem } from "./thread";

/** Everything the ticket page shows, for either side. Agent-only data is loaded only for agents. */
export async function loadTicket(viewer: Viewer, id: string, agent: boolean) {
  const t = await prisma.helpdeskTicket.findFirstOrThrow({
    where: { id, tenantId: viewer.tenantId },
    include: {
      employee: { select: { id: true, userId: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, jobTitleName: true, photoUrl: true, department: { select: { name: true } }, location: { select: { name: true } } } },
      category: { select: { id: true, name: true, enableOnHold: true, parent: { select: { name: true } } } },
      closingReason: { select: { name: true } },
      comments: { where: agent ? {} : { isInternal: false }, orderBy: { createdAt: "asc" } },
      followers: { orderBy: { createdAt: "asc" } },
    },
  });
  const files = await attachmentsFor(viewer.tenantId, [t.id, ...t.comments.map((c) => c.id)]);
  const names = await helpdeskUserNames(viewer.tenantId, [t.assigneeUserId, t.closedByUserId, ...t.followers.map((f) => f.userId)]);
  const raiser = t.employee.displayName ?? `${t.employee.firstName} ${t.employee.lastName}`;
  const items: ThreadItem[] = t.comments.filter((c) => !c.isInternal).map((c) => ({
    id: c.id, authorLabel: c.authorLabel, authorUserId: c.authorUserId, body: c.body, isSystem: c.isSystem, createdAt: c.createdAt, files: files.get(c.id) ?? [],
  }));
  const closedAt = t.closedAt ?? t.resolvedAt;
  const base = {
    id: t.id, number: t.number, subject: t.subject, description: t.description, createdAt: t.createdAt,
    status: ticketStatusOf(t.status), priority: ticketPriorityOf(t.priority), closed: isTicketClosed(t.status),
    categoryId: t.categoryId, category: helpdeskCategoryPath(t.category), onHold: t.category.enableOnHold,
    dueAt: t.dueAt, firstResponseDueAt: t.firstResponseDueAt, firstResponseAt: t.firstResponseAt, closedAt,
    missedFirstResponse: t.missedFirstResponse, missedResolution: t.missedResolution,
    closingReason: t.closingReason?.name ?? null, satisfaction: t.satisfaction,
    canReopen: isTicketClosed(t.status) && !!closedAt && Date.now() - closedAt.getTime() <= REOPEN_DAYS * 86_400_000,
    assigneeUserId: t.assigneeUserId, assignee: t.assigneeUserId ? names.get(t.assigneeUserId) ?? "—" : null,
    closedBy: t.closedByUserId ? names.get(t.closedByUserId) ?? null : null,
    raiser: {
      userId: t.employee.userId, name: raiser, number: t.employee.employeeNumber, title: t.employee.jobTitleName,
      department: t.employee.department?.name ?? null, location: t.employee.location?.name ?? null, photoUrl: t.employee.photoUrl,
    },
    openingFiles: files.get(t.id) ?? [],
    items,
    followers: t.followers.map((f) => ({
      id: f.id, userId: f.userId, name: names.get(f.userId) ?? "—",
      via: f.viaRole && f.viaRole in HELPDESK_FOLLOWER_ROLES ? HELPDESK_FOLLOWER_ROLES[f.viaRole as HelpdeskFollowerRole] : null,
    })),
  };
  if (!agent) return { ...base, agentData: null };

  const [categories, assignable, people, roles, reasons, canned] = await Promise.all([
    leafCategories(viewer.tenantId),
    helpdeskAssignableUsers(viewer.tenantId, t.categoryId),
    userOptions(viewer.tenantId),
    resolveFollowerRoles(t.employeeId),
    prisma.helpdeskClosingReason.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.helpdeskCannedResponse.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { title: "asc" }, select: { id: true, title: true, body: true } }),
  ]);
  const assigneeNames = await helpdeskUserNames(viewer.tenantId, assignable);
  const followerIds = new Set([t.employee.userId, ...t.followers.map((f) => f.userId)]);
  return {
    ...base,
    agentData: {
      categories,
      assignees: assignable.map((u) => ({ value: u, label: assigneeNames.get(u) ?? "—" })).sort((a, b) => a.label.localeCompare(b.label)),
      reasons: reasons.map((r) => ({ value: r.id, label: r.name })),
      canned,
      people: people.filter((p) => !followerIds.has(p.value)).map((p) => ({ value: p.employeeId, label: `${p.label} (${p.meta})` })),
      roles: (Object.keys(HELPDESK_FOLLOWER_ROLES) as HelpdeskFollowerRole[])
        .filter((k) => roles[k] && !followerIds.has(roles[k]!.userId))
        .map((k) => ({ value: k, label: `${HELPDESK_FOLLOWER_ROLES[k]} (${roles[k]!.name})` })),
      notes: t.comments.filter((c) => c.isInternal).reverse().map((c) => ({ id: c.id, author: c.authorLabel, body: c.body, createdAt: c.createdAt.toISOString() })),
      mine: t.assigneeUserId === viewer.user.id,
    },
  };
}

export type TicketData = Awaited<ReturnType<typeof loadTicket>>;
