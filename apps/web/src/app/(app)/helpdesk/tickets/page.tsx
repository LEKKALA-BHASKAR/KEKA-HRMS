import { prisma } from "@keka/db";
import { ticketWhere, helpdeskScopeWhere, helpdeskCategoryPath, helpdeskUserNames, type HelpdeskTicketFilters } from "@keka/services";
import { requireHelpdeskAgent } from "../_ui/access";
import { HelpdeskTabs, Segments } from "../_ui/tabs";
import { categoryOptions, leafCategories } from "../_ui/data";
import { Pager, pageOf } from "../_ui/bits";
import { TicketQueue, type QueueRow } from "../_ui/queue";
import s from "../_ui/hd.module.css";

/**
 * Org › Helpdesk › Tickets: the agent queue. Open and Closed segments, the
 * filter bar (category, priority, status or closing reason, assignee,
 * escalation), search, paging, and bulk close / re-categorise. Agents see
 * the categories they work; HELPDESK_MANAGE sees every ticket.
 */

const SIZE = 20;
type SP = Record<string, string | string[] | undefined>;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function TicketsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { viewer, scope, canSettings } = await requireHelpdeskAgent();
  const sp = await searchParams;
  const tab = one(sp.tab) === "closed" ? "closed" : "open";
  const escalations = list(sp.esc);
  if (one(sp.overdue) === "1" && !escalations.includes("RESOLUTION")) escalations.push("RESOLUTION");
  const mineOnly = one(sp.assignee) === "me";
  const filters: Omit<HelpdeskTicketFilters, "tab"> = {
    categoryIds: list(sp.cat), priorities: list(sp.priority), statuses: list(sp.status),
    assignees: mineOnly ? [viewer.user.id] : list(sp.assignee), escalations, closingReasonIds: list(sp.reason), q: one(sp.q).slice(0, 100) || null,
  };
  const where = await ticketWhere(viewer.tenantId, scope, { ...filters, tab });
  const [total, openCount, closedCount] = await Promise.all([
    prisma.helpdeskTicket.count({ where }),
    prisma.helpdeskTicket.count({ where: await ticketWhere(viewer.tenantId, scope, { ...filters, tab: "open" }) }),
    prisma.helpdeskTicket.count({ where: await ticketWhere(viewer.tenantId, scope, { ...filters, tab: "closed" }) }),
  ]);
  const page = pageOf(one(sp.page), total, SIZE);
  const tickets = await prisma.helpdeskTicket.findMany({
    where, skip: (page - 1) * SIZE, take: SIZE,
    orderBy: tab === "closed" ? [{ closedAt: "desc" }, { number: "desc" }] : [{ dueAt: "asc" }, { number: "asc" }],
    include: {
      employee: { select: { displayName: true, firstName: true, lastName: true, employeeNumber: true, photoUrl: true } },
      category: { select: { name: true, parent: { select: { name: true } } } },
      closingReason: { select: { name: true } },
    },
  });

  // Filter options, limited to what this agent works.
  const inScope = { tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope) };
  const [cats, leaves, assigneeRows, reasons] = await Promise.all([
    categoryOptions(viewer.tenantId, { only: scope.all ? undefined : scope.categoryIds, includeInactive: true }),
    leafCategories(viewer.tenantId),
    prisma.helpdeskTicket.findMany({ where: { ...inScope, assigneeUserId: { not: null } }, distinct: ["assigneeUserId"], select: { assigneeUserId: true } }),
    prisma.helpdeskClosingReason.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
  ]);
  const names = await helpdeskUserNames(viewer.tenantId, [...assigneeRows.map((r) => r.assigneeUserId), ...tickets.map((t) => t.assigneeUserId), viewer.user.id]);
  const assignees = [
    { value: "none", label: "Not assigned" },
    ...[...new Set([viewer.user.id, ...assigneeRows.map((r) => r.assigneeUserId!)])].map((id) => ({ value: id, label: `${names.get(id) ?? "—"}${id === viewer.user.id ? " (me)" : ""}` })).sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const now = Date.now();
  const rows: QueueRow[] = tickets.map((t) => ({
    id: t.id, number: t.number, subject: t.subject, category: helpdeskCategoryPath(t.category),
    raisedBy: t.employee.displayName ?? `${t.employee.firstName} ${t.employee.lastName}`, employeeNumber: t.employee.employeeNumber, photoUrl: t.employee.photoUrl,
    createdAt: t.createdAt.toISOString(), closedAt: (t.closedAt ?? t.resolvedAt)?.toISOString() ?? null,
    priority: t.priority, status: t.status, assignee: t.assigneeUserId ? names.get(t.assigneeUserId) ?? "—" : null,
    missedFirstResponse: t.missedFirstResponse, missedResolution: t.missedResolution,
    overdue: tab === "open" && !["ON_HOLD", "WAITING_ON_EMPLOYEE"].includes(t.status) && t.dueAt.getTime() < now,
    dueAt: t.dueAt.toISOString(), closingReason: t.closingReason?.name ?? null,
  }));

  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "page" && k !== "tab") for (const x of list(v)) keep.append(k, x);
  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams(keep);
    if (tab === "closed") q.set("tab", "closed");
    for (const [k, v] of Object.entries(patch)) { q.delete(k); if (v !== null && !(k === "page" && v === 1)) q.set(k, String(v)); }
    const qs = q.toString();
    return qs ? `/helpdesk/tickets?${qs}` : "/helpdesk/tickets";
  };

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings={canSettings} active="/helpdesk/tickets" />
      <Segments active={tab} items={[
        { key: "open", label: `Open Tickets (${openCount})`, href: href({ tab: null, page: null }) },
        { key: "closed", label: `Closed Tickets (${closedCount})`, href: href({ tab: "closed", page: null }) },
      ]} />
      <TicketQueue
        tab={tab} rows={rows} total={total}
        filters={{
          cat: list(sp.cat), priority: list(sp.priority), status: list(sp.status), assignee: mineOnly ? [viewer.user.id] : list(sp.assignee),
          esc: escalations, reason: list(sp.reason), q: one(sp.q),
        }}
        options={{
          categories: cats, assignees,
          reasons: [{ value: "none", label: "No reason" }, ...reasons.map((r) => ({ value: r.id, label: r.isActive ? r.name : `${r.name} (inactive)` }))],
        }}
        bulk={{ categories: leaves, reasons: reasons.filter((r) => r.isActive).map((r) => ({ value: r.id, label: r.name })) }}
        pager={<Pager total={total} page={page} size={SIZE} link={(p) => href({ page: p })} />}
      />
    </div>
  );
}
