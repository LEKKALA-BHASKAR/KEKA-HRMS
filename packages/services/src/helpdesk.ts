import { prisma, Prisma, type TicketStatus, type TicketPriority } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import {
  addBusinessMinutes, businessMinutesBetween, formatDuration, localDate, parseSchedule, zoneOffsetMinutes,
  TWENTY_FOUR_SEVEN, type BusinessSchedule,
} from "./helpdesk-time";

import { slaTargets, triage, leastLoaded } from "./cases-docs-math";
export * as helpdeskTime from "./helpdesk-time";
export { formatDuration as formatTicketDuration, slaLabel as ticketSlaLabel } from "./helpdesk-time";

/**
 * The helpdesk: employees raise tickets against a category; the category's
 * head and agents work them against two targets — a first response and a
 * resolution — measured in the category's business hours. On Hold pauses
 * both clocks; closing records a reason. Every change leaves a line in the
 * ticket's thread, so the history reads the way Keka shows it.
 *
 * Keka's statuses are Open · In Progress · On Hold · Closed and its
 * priorities NA · Low · Medium · High. WAITING_ON_EMPLOYEE, RESOLVED and
 * URGENT remain in the enums for old rows only: they read as On Hold, Closed
 * and High, and nothing here writes them.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const MANAGE = "helpdesk.ticket.manage";

export const TICKET_OPEN_STATUSES: TicketStatus[] = ["OPEN", "IN_PROGRESS", "ON_HOLD", "WAITING_ON_EMPLOYEE"];
export const TICKET_CLOSED_STATUSES: TicketStatus[] = ["CLOSED", "RESOLVED"];
export const TICKET_ACTIVE_STATUSES: TicketStatus[] = ["OPEN", "IN_PROGRESS"];
export const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", IN_PROGRESS: "In Progress", ON_HOLD: "On Hold", CLOSED: "Closed", WAITING_ON_EMPLOYEE: "On Hold", RESOLVED: "Closed",
};
export const TICKET_PRIORITIES = ["NA", "LOW", "MEDIUM", "HIGH"] as const;
export type TicketPriorityKey = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABEL: Record<string, string> = { NA: "NA", LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "High" };
/** A closed ticket can be reopened by the person who raised it for this long. */
export const REOPEN_DAYS = 7;

/** Read legacy values the way Keka shows them. */
export const ticketStatusOf = (s: TicketStatus): "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "CLOSED" =>
  s === "WAITING_ON_EMPLOYEE" ? "ON_HOLD" : s === "RESOLVED" ? "CLOSED" : (s as "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "CLOSED");
export const ticketPriorityOf = (p: TicketPriority): TicketPriorityKey => (p === "URGENT" ? "HIGH" : (p as TicketPriorityKey));
export const isTicketClosed = (s: TicketStatus) => s === "CLOSED" || s === "RESOLVED";

type Result = { ok: boolean; message: string };

// ---------------------------------------------------------------------------
//  Categories, audience and scope
// ---------------------------------------------------------------------------

export interface HelpdeskAudience { employeeIds?: string[]; departmentIds?: string[]; locationIds?: string[]; businessUnitIds?: string[] }

export function parseHelpdeskAudience(raw: unknown): HelpdeskAudience | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const a = { employeeIds: list("employeeIds"), departmentIds: list("departmentIds"), locationIds: list("locationIds"), businessUnitIds: list("businessUnitIds") };
  return Object.values(a).some((v) => v.length) ? a : null;
}

/** Null audience = everyone. Otherwise the employee must match any listed id. */
export function helpdeskAudienceAllows(raw: unknown, emp: { id: string; departmentId: string | null; locationId: string | null; businessUnitId: string | null }): boolean {
  const a = parseHelpdeskAudience(raw);
  if (!a) return true;
  return !!(a.employeeIds?.includes(emp.id)
    || (emp.departmentId && a.departmentIds?.includes(emp.departmentId))
    || (emp.locationId && a.locationIds?.includes(emp.locationId))
    || (emp.businessUnitId && a.businessUnitIds?.includes(emp.businessUnitId)));
}

/** Category ids plus every descendant. */
async function withDescendants(tenantId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const all = await prisma.helpdeskCategory.findMany({ where: { tenantId }, select: { id: true, parentId: true } });
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
  }
  return [...out];
}

export interface HelpdeskScope { all: boolean; categoryIds: string[] }

/**
 * Whose tickets a user works: everyone's with HELPDESK_MANAGE; otherwise the
 * categories (and their subcategories) they head or are an agent of.
 */
export async function helpdeskScope(tenantId: string, userId: string, canManage: boolean): Promise<HelpdeskScope> {
  if (canManage) return { all: true, categoryIds: [] };
  const direct = await prisma.helpdeskCategory.findMany({
    where: { tenantId, OR: [{ defaultAssigneeUserId: userId }, { agents: { some: { userId } } }] },
    select: { id: true },
  });
  return { all: false, categoryIds: await withDescendants(tenantId, direct.map((c) => c.id)) };
}

export const hasHelpdeskScope = (s: HelpdeskScope) => s.all || s.categoryIds.length > 0;
export const helpdeskScopeWhere = (s: HelpdeskScope): Prisma.HelpdeskTicketWhereInput => (s.all ? {} : { categoryId: { in: s.categoryIds } });
export const inHelpdeskScope = (s: HelpdeskScope, categoryId: string) => s.all || s.categoryIds.includes(categoryId);

/** Heads and agents work tickets without the HELPDESK_MANAGE permission. */
export async function isHelpdeskAgent(tenantId: string, userId: string): Promise<boolean> {
  return (await prisma.helpdeskCategory.count({ where: { tenantId, OR: [{ defaultAssigneeUserId: userId }, { agents: { some: { userId } } }] } })) > 0;
}

/** "Parent > Child" for a leaf, or just the name. */
export const helpdeskCategoryPath = (c: { name: string; parent?: { name: string } | null }) => (c.parent ? `${c.parent.name} > ${c.name}` : c.name);

/** Users who may be assigned a ticket in this category: its head and agents (and its parent's), plus everyone with HELPDESK_MANAGE. */
export async function helpdeskAssignableUsers(tenantId: string, categoryId: string): Promise<string[]> {
  const cat = await prisma.helpdeskCategory.findFirst({
    where: { id: categoryId, tenantId },
    select: { defaultAssigneeUserId: true, agents: { select: { userId: true } }, parent: { select: { defaultAssigneeUserId: true, agents: { select: { userId: true } } } } },
  });
  if (!cat) return [];
  const ids = [
    cat.defaultAssigneeUserId, ...cat.agents.map((a) => a.userId),
    cat.parent?.defaultAssigneeUserId, ...(cat.parent?.agents.map((a) => a.userId) ?? []),
    ...(await usersWithPermission(tenantId, MANAGE)),
  ];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------------------
//  Clocks
// ---------------------------------------------------------------------------

export interface HelpdeskClock { schedule: BusinessSchedule; holidays: string[] }

/** Dates on the tenant's default holiday calendars (non-optional holidays). */
export async function helpdeskHolidayDates(tenantId: string): Promise<string[]> {
  const rows = await prisma.holiday.findMany({ where: { isOptional: false, calendar: { tenantId, isDefault: true } }, select: { date: true } });
  return [...new Set(rows.map((h) => h.date.toISOString().slice(0, 10)))];
}

/** Every category's clock, keyed by category id — one query each, for lists and reports. */
export async function helpdeskClocks(tenantId: string): Promise<(categoryId: string) => HelpdeskClock> {
  const [cats, defaults, holidays] = await Promise.all([
    prisma.helpdeskCategory.findMany({ where: { tenantId }, select: { id: true, parentId: true, businessHours: true } }),
    prisma.helpdeskBusinessHours.findFirst({ where: { tenantId, isDefault: true } }),
    helpdeskHolidayDates(tenantId),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const cache = new Map<string, HelpdeskClock>();
  return (id: string) => {
    let hit = cache.get(id);
    if (hit) return hit;
    const c = byId.get(id);
    const bh = c?.businessHours ?? (c?.parentId ? byId.get(c.parentId)?.businessHours : null) ?? defaults;
    hit = bh ? { schedule: parseSchedule(bh.schedule, bh.timezone), holidays: bh.observeHolidays ? holidays : [] } : { schedule: TWENTY_FOUR_SEVEN, holidays: [] };
    cache.set(id, hit);
    return hit;
  };
}

async function clockFor(tenantId: string, categoryId: string): Promise<HelpdeskClock> {
  return (await helpdeskClocks(tenantId))(categoryId);
}

/** First-response and resolution due dates for a ticket raised now in this category. */
export async function helpdeskDueDates(tenantId: string, categoryId: string, start: Date, priority?: TicketPriority | null): Promise<{ firstResponseDueAt: Date; dueAt: Date }> {
  const cat = await prisma.helpdeskCategory.findFirstOrThrow({ where: { id: categoryId, tenantId }, select: { id: true, parentId: true, firstResponseHours: true, slaHours: true } });
  // Per-priority targets (33-cases-docs) override the category's own hours.
  const policies = priority ? await prisma.helpdeskSlaPolicy.findMany({ where: { tenantId, priority: priority === "URGENT" ? "HIGH" : priority } }) : [];
  const target = slaTargets(policies, cat, priority ?? "NA");
  const { schedule, holidays } = await clockFor(tenantId, categoryId);
  return {
    firstResponseDueAt: addBusinessMinutes(start, target.firstResponseHours * 60, schedule, holidays),
    dueAt: addBusinessMinutes(start, target.resolutionHours * 60, schedule, holidays),
  };
}

// ---------------------------------------------------------------------------
//  Names
// ---------------------------------------------------------------------------

/** userId → display name, for agents, followers and comment authors. */
export async function helpdeskUserNames(tenantId: string, userIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, u.employee ? u.employee.displayName ?? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}

async function nameOfUser(tenantId: string, userId: string | null | undefined, fallback = "Helpdesk"): Promise<string> {
  if (!userId) return fallback;
  return (await helpdeskUserNames(tenantId, [userId])).get(userId) ?? fallback;
}

async function systemLine(ticketId: string, userId: string, label: string, body: string, tx: Prisma.TransactionClient = prisma) {
  await tx.helpdeskComment.create({ data: { ticketId, authorUserId: userId, authorLabel: label, body, isSystem: true } });
}

// ---------------------------------------------------------------------------
//  Raising
// ---------------------------------------------------------------------------

async function pickAssignee(cat: { id: string; assignMode: string; defaultAssigneeUserId: string | null; lastAssignedUserId: string | null; parentId: string | null }, tenantId: string): Promise<string | null> {
  const parent = cat.parentId ? await prisma.helpdeskCategory.findFirst({ where: { id: cat.parentId, tenantId }, select: { defaultAssigneeUserId: true } }) : null;
  const head = cat.defaultAssigneeUserId ?? parent?.defaultAssigneeUserId ?? null;
  if (cat.assignMode === "UNASSIGNED") return null;
  if (cat.assignMode === "ROUND_ROBIN") {
    const pool = (await prisma.helpdeskCategoryAgent.findMany({
      where: { categoryId: { in: [cat.id, ...(cat.parentId ? [cat.parentId] : [])] } }, select: { userId: true },
    })).map((a) => a.userId);
    const users = [...new Set(pool)].sort();
    if (!users.length) return head;
    const i = cat.lastAssignedUserId ? users.indexOf(cat.lastAssignedUserId) : -1;
    const next = users[(i + 1) % users.length];
    await prisma.helpdeskCategory.update({ where: { id: cat.id }, data: { lastAssignedUserId: next } });
    return next;
  }
  if (cat.assignMode === "LEAST_LOADED") {
    const pool = [...new Set((await prisma.helpdeskCategoryAgent.findMany({
      where: { categoryId: { in: [cat.id, ...(cat.parentId ? [cat.parentId] : [])] } }, select: { userId: true },
    })).map((a) => a.userId))].sort();
    if (!pool.length) return head;
    const open = await prisma.helpdeskTicket.groupBy({ by: ["assigneeUserId"], where: { tenantId, assigneeUserId: { in: pool }, status: { in: TICKET_OPEN_STATUSES } }, _count: true });
    const next = leastLoaded(pool, new Map(open.map((o) => [o.assigneeUserId!, o._count])), cat.lastAssignedUserId);
    if (next) await prisma.helpdeskCategory.update({ where: { id: cat.id }, data: { lastAssignedUserId: next } });
    return next ?? head;
  }
  return head;
}

export async function raiseTicket(input: {
  employeeId: string; categoryId: string; subject: string; description: string;
  /** Employees don't choose one in Keka; the category default applies. Kept for callers that do. */
  priority?: TicketPriority | null;
  /** How the case reached HR, and the agent who logged it (33-cases-docs). */
  channel?: string | null;
  loggedByUserId?: string | null;
  severity?: string | null;
}): Promise<{ ok: boolean; message: string; ticketId?: string; number?: number; triage?: string[] }> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    select: { tenantId: true, displayName: true, firstName: true, lastName: true, userId: true, departmentId: true, locationId: true, businessUnitId: true, id: true },
  });
  const cat = await prisma.helpdeskCategory.findFirst({
    where: { id: input.categoryId, tenantId: emp.tenantId, isActive: true },
    include: { _count: { select: { children: { where: { isActive: true } } } }, parent: { select: { name: true, audience: true, isActive: true } } },
  });
  if (!cat || (cat.parent && !cat.parent.isActive)) return { ok: false, message: "Pick a category." };
  if (cat._count.children > 0) return { ok: false, message: `Pick a subcategory of ${cat.name}.` };
  if (!helpdeskAudienceAllows(cat.audience ?? cat.parent?.audience, emp)) return { ok: false, message: "This category is not open to you." };

  const now = new Date();
  // Triage rules may raise the priority and set a severity (33-cases-docs).
  const rules = await prisma.helpdeskTriageRule.findMany({ where: { tenantId: emp.tenantId, isActive: true } });
  const tri = triage(rules, `${input.subject} ${input.description}`, cat.id, cat.parentId);
  const RANK = ["NA", "LOW", "MEDIUM", "HIGH"];
  let priority: TicketPriority = input.priority ? (input.priority === "URGENT" ? "HIGH" : input.priority) : cat.defaultPriority ?? "NA";
  if (tri.priority && RANK.indexOf(tri.priority) > RANK.indexOf(priority)) priority = tri.priority as TicketPriority;
  const severity = input.severity ?? tri.severity;
  const due = await helpdeskDueDates(emp.tenantId, cat.id, now, priority);
  const assigneeUserId = await pickAssignee(cat, emp.tenantId);

  // Per-tenant ticket numbers, allocated under a row lock on the tenant.
  const ticket = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${emp.tenantId} FOR UPDATE`;
    const last = await tx.helpdeskTicket.aggregate({ where: { tenantId: emp.tenantId }, _max: { number: true } });
    return tx.helpdeskTicket.create({
      data: {
        tenantId: emp.tenantId, number: (last._max.number ?? 1000) + 1, employeeId: emp.id,
        categoryId: cat.id, subject: input.subject, description: input.description,
        priority, assigneeUserId, firstResponseDueAt: due.firstResponseDueAt, dueAt: due.dueAt,
        severity, channel: input.channel ?? "WEB", loggedByUserId: input.loggedByUserId ?? null,
      },
    });
  });
  const raiser = emp.displayName ?? `${emp.firstName} ${emp.lastName}`;
  await notify({
    tenantId: emp.tenantId,
    userIds: assigneeUserId ? [assigneeUserId] : cat.defaultAssigneeUserId ? [cat.defaultAssigneeUserId] : await usersWithPermission(emp.tenantId, MANAGE),
    kind: "HELPDESK", title: `#${ticket.number}: ${input.subject}`, body: `${raiser} · ${helpdeskCategoryPath(cat)}`,
    link: `/helpdesk/tickets/${ticket.id}`,
  });
  if (tri.matched.length) await systemLine(ticket.id, input.loggedByUserId ?? emp.userId ?? "system", "Helpdesk", `Triage: ${tri.matched.join(", ")}${tri.priority ? ` · priority ${TICKET_PRIORITY_LABEL[priority]}` : ""}${severity ? ` · severity ${severity}` : ""}`);
  return { ok: true, message: `Ticket #${ticket.number} added successfully.`, ticketId: ticket.id, number: ticket.number, triage: tri.matched };
}

// ---------------------------------------------------------------------------
//  Replies and notes
// ---------------------------------------------------------------------------

async function followerUsers(ticketId: string): Promise<string[]> {
  return (await prisma.helpdeskTicketFollower.findMany({ where: { ticketId }, select: { userId: true } })).map((f) => f.userId);
}

/** Business minutes a ticket spent on hold, and the shifted due dates when it resumes. */
async function resumeDues(t: { tenantId: string; categoryId: string; onHoldSince: Date | null; firstResponseAt: Date | null; firstResponseDueAt: Date | null; dueAt: Date }, now: Date) {
  if (!t.onHoldSince) return {};
  const { schedule, holidays } = await clockFor(t.tenantId, t.categoryId);
  const held = businessMinutesBetween(t.onHoldSince, now, schedule, holidays);
  return {
    onHoldSince: null,
    dueAt: addBusinessMinutes(t.dueAt, held, schedule, holidays),
    ...(t.firstResponseDueAt && !t.firstResponseAt ? { firstResponseDueAt: addBusinessMinutes(t.firstResponseDueAt, held, schedule, holidays) } : {}),
  };
}

export async function commentOnTicket(opts: {
  ticketId: string; authorUserId: string; authorLabel: string; body: string; isInternal?: boolean; asAgent: boolean;
}): Promise<{ ok: boolean; message: string; commentId?: string }> {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: opts.ticketId }, include: { employee: { select: { userId: true } } } });
  if (!t) return { ok: false, message: "Ticket not found." };
  if (isTicketClosed(t.status)) return { ok: false, message: "This ticket is closed. Reopen it or raise a new one." };
  if (opts.isInternal && !opts.asAgent) return { ok: false, message: "Only agents can add internal notes." };
  const now = new Date();
  const comment = await prisma.helpdeskComment.create({
    data: { ticketId: t.id, authorUserId: opts.authorUserId, authorLabel: opts.authorLabel, body: opts.body, isInternal: !!opts.isInternal },
  });
  if (opts.isInternal) return { ok: true, message: "Note added.", commentId: comment.id };

  const data: Prisma.HelpdeskTicketUncheckedUpdateInput = { lastResponderUserId: opts.authorUserId, lastRespondedAt: now };
  if (opts.asAgent) {
    if (!t.firstResponseAt) {
      data.firstResponseAt = now;
      if (t.firstResponseDueAt && now > t.firstResponseDueAt) data.missedFirstResponse = true;
      await systemLine(t.id, opts.authorUserId, opts.authorLabel, `First response was added to the ticket by ${opts.authorLabel}`);
    }
    if (t.status === "OPEN") {
      data.status = "IN_PROGRESS";
      await systemLine(t.id, opts.authorUserId, opts.authorLabel, `Ticket status changed to In Progress by ${opts.authorLabel}`);
    }
  } else if (t.status === "ON_HOLD" || t.status === "WAITING_ON_EMPLOYEE") {
    // The employee answering a question puts the ticket back in the queue.
    Object.assign(data, await resumeDues(t, now), { status: "IN_PROGRESS" });
    await systemLine(t.id, opts.authorUserId, opts.authorLabel, `Ticket status changed to In Progress by ${opts.authorLabel}`);
  }
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data });
  const followers = await followerUsers(t.id);
  await notify({
    tenantId: t.tenantId,
    userIds: opts.asAgent ? [t.employee.userId] : [t.assigneeUserId],
    kind: "HELPDESK", title: `#${t.number}: new reply`, body: opts.body.slice(0, 140),
    link: opts.asAgent ? `/me/helpdesk/${t.id}` : `/helpdesk/tickets/${t.id}`,
  });
  await notify({
    tenantId: t.tenantId, userIds: followers.filter((u) => u !== opts.authorUserId),
    kind: "HELPDESK", title: `#${t.number}: new reply`, body: opts.body.slice(0, 140), link: `/me/helpdesk/${t.id}`,
  });
  return { ok: true, message: "Reply sent.", commentId: comment.id };
}

export async function addInternalNote(opts: { ticketId: string; userId: string; label: string; body: string }): Promise<Result> {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: opts.ticketId }, select: { id: true } });
  if (!t) return { ok: false, message: "Ticket not found." };
  await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: opts.userId, authorLabel: opts.label, body: opts.body, isInternal: true } });
  return { ok: true, message: "Note added." };
}

// ---------------------------------------------------------------------------
//  Updating: status, priority, category, assignee
// ---------------------------------------------------------------------------

export interface HelpdeskTicketUpdate {
  ticketId: string;
  byUserId: string;
  byLabel: string;
  status?: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "CLOSED";
  priority?: TicketPriorityKey;
  categoryId?: string;
  /** undefined = unchanged, null = unassign. */
  assigneeUserId?: string | null;
  closingReasonId?: string | null;
  /** Agents closing a ticket must give one of the tenant's active reasons, when there are any. */
  requireReason?: boolean;
  /** Legacy callers may hold a ticket in a category without On Hold. */
  allowHold?: boolean;
}

export async function updateTicket(u: HelpdeskTicketUpdate): Promise<Result> {
  const t = await prisma.helpdeskTicket.findUnique({
    where: { id: u.ticketId },
    include: { employee: { select: { userId: true } }, category: { select: { id: true, name: true, enableOnHold: true, slaHours: true } } },
  });
  if (!t) return { ok: false, message: "Ticket not found." };
  const now = new Date();
  const from = ticketStatusOf(t.status);
  const data: Prisma.HelpdeskTicketUncheckedUpdateInput = {};
  const lines: string[] = [];
  const by = u.byLabel;

  if (u.categoryId && u.categoryId !== t.categoryId) {
    const cat = await prisma.helpdeskCategory.findFirst({
      where: { id: u.categoryId, tenantId: t.tenantId, isActive: true },
      include: { _count: { select: { children: { where: { isActive: true } } } }, parent: { select: { name: true } } },
    });
    if (!cat) return { ok: false, message: "That category does not exist." };
    if (cat._count.children > 0) return { ok: false, message: `Pick a subcategory of ${cat.name}.` };
    data.categoryId = cat.id;
    lines.push(`Category changed to ${helpdeskCategoryPath(cat)} by ${by}`);
  }

  if (u.priority && u.priority !== ticketPriorityOf(t.priority)) {
    if (!TICKET_PRIORITIES.includes(u.priority)) return { ok: false, message: "Pick a priority." };
    data.priority = u.priority;
    lines.push(`Priority changed to ${TICKET_PRIORITY_LABEL[u.priority]} by ${by}`);
    // A priority with its own SLA policy re-targets the open ticket from when it was raised (33-cases-docs).
    if (!isTicketClosed(t.status) && (await prisma.helpdeskSlaPolicy.count({ where: { tenantId: t.tenantId, priority: u.priority } }))) {
      const due = await helpdeskDueDates(t.tenantId, u.categoryId ?? t.categoryId, t.createdAt, u.priority);
      data.dueAt = due.dueAt;
      if (!t.firstResponseAt) data.firstResponseDueAt = due.firstResponseDueAt;
      lines.push(`SLA targets re-calculated for ${TICKET_PRIORITY_LABEL[u.priority]} priority`);
    }
  } else if (t.priority === "URGENT") data.priority = "HIGH";

  if (u.assigneeUserId !== undefined && u.assigneeUserId !== t.assigneeUserId) {
    if (u.assigneeUserId) {
      const ok = await prisma.user.count({ where: { id: u.assigneeUserId, tenantId: t.tenantId } });
      if (!ok) return { ok: false, message: "That agent does not exist." };
    }
    data.assigneeUserId = u.assigneeUserId;
    lines.push(u.assigneeUserId ? `Ticket assigned to ${await nameOfUser(t.tenantId, u.assigneeUserId)} by ${by}` : `Ticket unassigned by ${by}`);
  }

  const to = u.status;
  if (to && to !== from) {
    if (to === "ON_HOLD" && !t.category.enableOnHold && !u.allowHold) {
      return { ok: false, message: `On Hold is not enabled for ${t.category.name}.` };
    }
    if (from === "ON_HOLD" || t.onHoldSince) Object.assign(data, await resumeDues(t, now));
    if (to === "ON_HOLD") data.onHoldSince = now;
    if (to === "CLOSED") {
      // A case's task checklist must be finished before it closes (33-cases-docs).
      const openTasks = u.requireReason ? await prisma.helpdeskTicketTask.count({ where: { ticketId: t.id, doneAt: null } }) : 0;
      if (openTasks) return { ok: false, message: `Finish the case's ${openTasks} open task${openTasks === 1 ? "" : "s"} before closing it.` };
      if (u.requireReason && t.approvalStatus === "PENDING") return { ok: false, message: "A decision on this case is still awaiting approval." };
      let reasonName: string | null = null;
      if (u.closingReasonId) {
        const r = await prisma.helpdeskClosingReason.findFirst({ where: { id: u.closingReasonId, tenantId: t.tenantId, isActive: true } });
        if (!r) return { ok: false, message: "That closing reason does not exist." };
        reasonName = r.name;
      } else if (u.requireReason && (await prisma.helpdeskClosingReason.count({ where: { tenantId: t.tenantId, isActive: true } })) > 0) {
        return { ok: false, message: "Pick a closing reason." };
      }
      Object.assign(data, {
        closedAt: now, resolvedAt: now, closedByUserId: u.byUserId, closingReasonId: u.closingReasonId ?? null,
        ...(now > ((data.dueAt as Date | undefined) ?? t.dueAt) ? { missedResolution: true } : {}),
      });
      lines.push(`Ticket status changed to Closed by ${by}${reasonName ? ` · ${reasonName}` : ""}`);
    } else {
      if (from === "CLOSED") {
        // Reopened: a fresh resolution target from now.
        const { schedule, holidays } = await clockFor(t.tenantId, t.categoryId);
        Object.assign(data, {
          closedAt: null, resolvedAt: null, closedByUserId: null, closingReasonId: null, satisfaction: null,
          reopenCount: { increment: 1 }, dueAt: addBusinessMinutes(now, t.category.slaHours * 60, schedule, holidays),
        });
        lines.push(`Ticket reopened by ${by}`);
      }
      lines.push(`Ticket status changed to ${TICKET_STATUS_LABEL[to]} by ${by}`);
    }
    data.status = to;
  } else if (to && t.status !== to) {
    data.status = to; // a legacy value read as the same Keka status
  }

  if (!Object.keys(data).length) return { ok: true, message: "Nothing to update." };
  await prisma.$transaction(async (tx) => {
    await tx.helpdeskTicket.update({ where: { id: t.id }, data });
    for (const body of lines) await systemLine(t.id, u.byUserId, by, body, tx);
  });

  if (to && to !== from) {
    const followers = await followerUsers(t.id);
    const title = to === "CLOSED" ? `#${t.number} was closed` : to === "ON_HOLD" ? `#${t.number} is on hold` : `#${t.number} is ${TICKET_STATUS_LABEL[to].toLowerCase()}`;
    await notify({ tenantId: t.tenantId, userIds: [t.employee.userId, ...followers].filter((x) => x !== u.byUserId), kind: "HELPDESK", title, link: `/me/helpdesk/${t.id}`, email: to === "CLOSED" });
  }
  if (data.assigneeUserId && data.assigneeUserId !== u.byUserId) {
    await notify({ tenantId: t.tenantId, userIds: [data.assigneeUserId as string], kind: "HELPDESK", title: `#${t.number} was assigned to you`, body: t.subject, link: `/helpdesk/tickets/${t.id}` });
  }
  return { ok: true, message: to && to !== from ? `Ticket ${to === "CLOSED" ? "closed" : `moved to ${TICKET_STATUS_LABEL[to]}`}.` : "Ticket updated." };
}

/**
 * The old status API (seed and earlier callers). RESOLVED closes and
 * WAITING_ON_EMPLOYEE puts the ticket on hold, so no legacy value is written.
 */
export async function setTicketStatus(opts: {
  ticketId: string; status: "OPEN" | "IN_PROGRESS" | "WAITING_ON_EMPLOYEE" | "RESOLVED" | "CLOSED" | "ON_HOLD"; assigneeUserId?: string | null; byUserId?: string;
}): Promise<Result> {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: opts.ticketId }, select: { tenantId: true, assigneeUserId: true } });
  if (!t) return { ok: false, message: "Ticket not found." };
  const status = opts.status === "RESOLVED" ? "CLOSED" : opts.status === "WAITING_ON_EMPLOYEE" ? "ON_HOLD" : opts.status;
  const by = opts.byUserId ?? opts.assigneeUserId ?? t.assigneeUserId ?? null;
  return updateTicket({
    ticketId: opts.ticketId, status, assigneeUserId: opts.assigneeUserId, allowHold: true,
    byUserId: by ?? "system", byLabel: await nameOfUser(t.tenantId, by),
  });
}

/** The person who raised a closed ticket may reopen it within REOPEN_DAYS. */
export async function reopenTicket(opts: { ticketId: string; employeeId: string; userId: string; label: string }): Promise<Result> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: opts.ticketId, employeeId: opts.employeeId } });
  if (!t) return { ok: false, message: "Ticket not found." };
  if (!isTicketClosed(t.status)) return { ok: false, message: "Only a closed ticket can be reopened." };
  const closedAt = t.closedAt ?? t.resolvedAt ?? t.updatedAt;
  if (Date.now() - closedAt.getTime() > REOPEN_DAYS * DAY) return { ok: false, message: `A ticket can be reopened within ${REOPEN_DAYS} days of closing. Raise a new one instead.` };
  const r = await updateTicket({ ticketId: t.id, status: "OPEN", byUserId: opts.userId, byLabel: opts.label });
  if (r.ok && t.assigneeUserId) {
    await notify({ tenantId: t.tenantId, userIds: [t.assigneeUserId], kind: "HELPDESK", title: `#${t.number} was reopened`, body: t.subject, link: `/helpdesk/tickets/${t.id}` });
  }
  return r.ok ? { ok: true, message: "Ticket reopened." } : r;
}

// ---------------------------------------------------------------------------
//  Followers
// ---------------------------------------------------------------------------

export const HELPDESK_FOLLOWER_ROLES = { REPORTING_MANAGER: "Reporting Manager", L2_MANAGER: "L2 Manager", DEPARTMENT_HEAD: "Department Head" } as const;
export type HelpdeskFollowerRole = keyof typeof HELPDESK_FOLLOWER_ROLES;

/** The users a role resolves to for this raiser (null when there is nobody in that role). */
export async function resolveFollowerRoles(employeeId: string): Promise<Record<HelpdeskFollowerRole, { userId: string; name: string } | null>> {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      reportingManager: { select: { userId: true, displayName: true, firstName: true, lastName: true, reportingManager: { select: { userId: true, displayName: true, firstName: true, lastName: true } } } },
      department: { select: { head: { select: { id: true, userId: true, displayName: true, firstName: true, lastName: true } } } },
    },
  });
  const pick = (p: { userId: string | null; displayName: string | null; firstName: string; lastName: string } | null | undefined) =>
    p?.userId ? { userId: p.userId, name: p.displayName ?? `${p.firstName} ${p.lastName}` } : null;
  const head = e?.department?.head && e.department.head.id !== employeeId ? e.department.head : null;
  return { REPORTING_MANAGER: pick(e?.reportingManager), L2_MANAGER: pick(e?.reportingManager?.reportingManager), DEPARTMENT_HEAD: pick(head) };
}

export async function addFollower(opts: { ticketId: string; tenantId: string; byUserId: string; byLabel: string; userId?: string | null; role?: HelpdeskFollowerRole | null }): Promise<Result> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: opts.ticketId, tenantId: opts.tenantId }, include: { employee: { select: { userId: true } } } });
  if (!t) return { ok: false, message: "Ticket not found." };
  let userId = opts.userId ?? null;
  if (opts.role) {
    const resolved = (await resolveFollowerRoles(t.employeeId))[opts.role];
    if (!resolved) return { ok: false, message: `This employee has no ${HELPDESK_FOLLOWER_ROLES[opts.role]}.` };
    userId = resolved.userId;
  }
  if (!userId) return { ok: false, message: "Pick a role or an employee." };
  const u = await prisma.user.findFirst({ where: { id: userId, tenantId: opts.tenantId, loginDisabled: false } });
  if (!u) return { ok: false, message: "That employee cannot sign in, so they cannot follow tickets." };
  if (userId === t.employee.userId) return { ok: false, message: "The person who raised the ticket already follows it." };
  const existing = await prisma.helpdeskTicketFollower.findUnique({ where: { ticketId_userId: { ticketId: t.id, userId } } });
  if (existing) return { ok: false, message: "They already follow this ticket." };
  const name = await nameOfUser(opts.tenantId, userId);
  await prisma.helpdeskTicketFollower.create({ data: { ticketId: t.id, userId, viaRole: opts.role ?? null, addedByUserId: opts.byUserId } });
  await systemLine(t.id, opts.byUserId, opts.byLabel, `${name} was added as a follower by ${opts.byLabel}`);
  await notify({ tenantId: opts.tenantId, userIds: [userId], kind: "HELPDESK", title: `You are following #${t.number}`, body: t.subject, link: `/me/helpdesk/${t.id}` });
  return { ok: true, message: `${name} added as a follower.` };
}

export async function removeFollower(opts: { ticketId: string; tenantId: string; followerId: string; byUserId: string; byLabel: string }): Promise<Result> {
  const f = await prisma.helpdeskTicketFollower.findFirst({ where: { id: opts.followerId, ticketId: opts.ticketId, ticket: { tenantId: opts.tenantId } } });
  if (!f) return { ok: false, message: "Follower not found." };
  await prisma.helpdeskTicketFollower.delete({ where: { id: f.id } });
  await systemLine(opts.ticketId, opts.byUserId, opts.byLabel, `${await nameOfUser(opts.tenantId, f.userId)} was removed as a follower by ${opts.byLabel}`);
  return { ok: true, message: "Follower removed." };
}

// ---------------------------------------------------------------------------
//  SLA escalations
// ---------------------------------------------------------------------------

/**
 * Flag tickets that have missed a target and tell the category head once.
 * Run by the `helpdesk-sla` job and before agent views render. On Hold and
 * closed tickets are not flagged here (closing flags a late resolution).
 */
export async function refreshSla(tenantId: string, now = new Date()): Promise<{ firstResponse: number; resolution: number }> {
  const active: Prisma.HelpdeskTicketWhereInput = { tenantId, status: { in: TICKET_ACTIVE_STATUSES } };
  const fr = await prisma.helpdeskTicket.findMany({
    where: {
      ...active, missedFirstResponse: false,
      OR: [
        { firstResponseAt: null, firstResponseDueAt: { lt: now } },
        { firstResponseAt: { gt: prisma.helpdeskTicket.fields.firstResponseDueAt } },
      ],
    },
    select: { id: true, number: true, subject: true, assigneeUserId: true, category: { select: { defaultAssigneeUserId: true, parent: { select: { defaultAssigneeUserId: true } } } } },
  });
  const res = await prisma.helpdeskTicket.findMany({
    where: { ...active, missedResolution: false, dueAt: { lt: now } },
    select: { id: true, number: true, subject: true, assigneeUserId: true, category: { select: { defaultAssigneeUserId: true, parent: { select: { defaultAssigneeUserId: true } } } } },
  });
  if (fr.length) await prisma.helpdeskTicket.updateMany({ where: { id: { in: fr.map((t) => t.id) } }, data: { missedFirstResponse: true } });
  if (res.length) await prisma.helpdeskTicket.updateMany({ where: { id: { in: res.map((t) => t.id) } }, data: { missedResolution: true } });
  for (const [list, what] of [[fr, "first response"], [res, "resolution"]] as const) {
    for (const t of list) {
      const head = t.category.defaultAssigneeUserId ?? t.category.parent?.defaultAssigneeUserId;
      await notify({
        tenantId, userIds: [head, t.assigneeUserId], kind: "HELPDESK",
        title: `#${t.number} missed its ${what} target`, body: t.subject, link: `/helpdesk/tickets/${t.id}`,
      });
    }
  }
  return { firstResponse: fr.length, resolution: res.length };
}

// ---------------------------------------------------------------------------
//  Lists, filters
// ---------------------------------------------------------------------------

export interface HelpdeskTicketFilters {
  tab: "open" | "closed";
  from?: Date | null;
  to?: Date | null;
  categoryIds?: string[];
  priorities?: string[];
  statuses?: string[];
  assignees?: string[];
  escalations?: string[];
  closingReasonIds?: string[];
  q?: string | null;
}

/** The one where-clause behind the ticket list, its pager, its export and the reports. */
export async function ticketWhere(tenantId: string, scope: HelpdeskScope, f: HelpdeskTicketFilters): Promise<Prisma.HelpdeskTicketWhereInput> {
  const and: Prisma.HelpdeskTicketWhereInput[] = [{ tenantId }, helpdeskScopeWhere(scope)];
  and.push({ status: { in: f.tab === "closed" ? TICKET_CLOSED_STATUSES : TICKET_OPEN_STATUSES } });
  if (f.from || f.to) and.push({ createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } });
  if (f.categoryIds?.length) and.push({ categoryId: { in: await withDescendants(tenantId, f.categoryIds) } });
  if (f.priorities?.length) {
    const p = f.priorities.filter((x): x is TicketPriorityKey => (TICKET_PRIORITIES as readonly string[]).includes(x));
    and.push({ priority: { in: p.includes("HIGH") ? [...p, "URGENT"] : p } });
  }
  if (f.tab === "open" && f.statuses?.length) {
    const s = f.statuses.filter((x) => ["OPEN", "IN_PROGRESS", "ON_HOLD"].includes(x)) as TicketStatus[];
    and.push({ status: { in: s.includes("ON_HOLD") ? [...s, "WAITING_ON_EMPLOYEE"] : s } });
  }
  if (f.assignees?.length) {
    const ids = f.assignees.filter((a) => a !== "none");
    and.push({ OR: [...(ids.length ? [{ assigneeUserId: { in: ids } }] : []), ...(f.assignees.includes("none") ? [{ assigneeUserId: null }] : [])] });
  }
  if (f.escalations?.length) {
    const or: Prisma.HelpdeskTicketWhereInput[] = [];
    if (f.escalations.includes("FIRST_RESPONSE")) or.push({ missedFirstResponse: true });
    if (f.escalations.includes("RESOLUTION")) or.push({ missedResolution: true });
    if (f.escalations.includes("NONE")) or.push({ missedFirstResponse: false, missedResolution: false });
    if (or.length) and.push({ OR: or });
  }
  if (f.tab === "closed" && f.closingReasonIds?.length) {
    const ids = f.closingReasonIds.filter((x) => x !== "none");
    and.push({ OR: [...(ids.length ? [{ closingReasonId: { in: ids } }] : []), ...(f.closingReasonIds.includes("none") ? [{ closingReasonId: null }] : [])] });
  }
  const q = f.q?.trim();
  if (q) {
    const n = Number(q.replace(/^#/, ""));
    and.push({
      OR: [
        ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : []),
        { subject: { contains: q, mode: "insensitive" } },
        { employee: { displayName: { contains: q, mode: "insensitive" } } },
        { employee: { employeeNumber: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  return { AND: and };
}

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

export const HELPDESK_PERIODS = { "7d": { label: "Last 7 days", days: 7 }, "30d": { label: "Last 30 days", days: 30 }, "3m": { label: "Last 3 months", days: 91 }, "6m": { label: "Last 6 months", days: 182 }, "1y": { label: "Last 1 year", days: 365 } } as const;
export type HelpdeskPeriod = keyof typeof HELPDESK_PERIODS;

const TZ = "Asia/Kolkata";
/** The instant the local (IST) day containing `at` began. */
export function helpdeskDayStart(at: Date, tz = TZ): Date {
  const d = localDate(at, tz);
  return new Date(d.getTime() - zoneOffsetMinutes(at, tz) * MIN);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export interface HelpdeskDashboard {
  today: { open: number; incomingToday: number; incomingYesterday: number; closedToday: number; closedYesterday: number; onHold: number };
  analysis: { incoming: number; closed: number; firstResponse: string; resolution: string; csat: string };
  series: Array<{ label: string; open: number; closed: number }>;
  topCategories: Array<{ label: string; value: number }>;
}

export async function helpdeskDashboard(opts: { tenantId: string; scope: HelpdeskScope; categoryIds?: string[]; period: HelpdeskPeriod; now?: Date }): Promise<HelpdeskDashboard> {
  const now = opts.now ?? new Date();
  const base: Prisma.HelpdeskTicketWhereInput = { tenantId: opts.tenantId, ...helpdeskScopeWhere(opts.scope) };
  const today = helpdeskDayStart(now), yesterday = new Date(today.getTime() - DAY);
  const [open, incomingToday, incomingYesterday, closedToday, closedYesterday, onHold] = await Promise.all([
    prisma.helpdeskTicket.count({ where: { ...base, status: { in: TICKET_OPEN_STATUSES } } }),
    prisma.helpdeskTicket.count({ where: { ...base, createdAt: { gte: today } } }),
    prisma.helpdeskTicket.count({ where: { ...base, createdAt: { gte: yesterday, lt: today } } }),
    prisma.helpdeskTicket.count({ where: { ...base, status: { in: TICKET_CLOSED_STATUSES }, closedAt: { gte: today } } }),
    prisma.helpdeskTicket.count({ where: { ...base, status: { in: TICKET_CLOSED_STATUSES }, closedAt: { gte: yesterday, lt: today } } }),
    prisma.helpdeskTicket.count({ where: { ...base, status: { in: ["ON_HOLD", "WAITING_ON_EMPLOYEE"] } } }),
  ]);

  const p = HELPDESK_PERIODS[opts.period];
  const since = new Date(helpdeskDayStart(now).getTime() - (p.days - 1) * DAY);
  const cats = opts.categoryIds?.length ? await withDescendants(opts.tenantId, opts.categoryIds) : null;
  const where: Prisma.HelpdeskTicketWhereInput = { ...base, ...(cats ? { categoryId: { in: cats } } : {}) };
  const rows = await prisma.helpdeskTicket.findMany({
    where: { ...where, OR: [{ createdAt: { gte: since } }, { closedAt: { gte: since } }, { firstResponseAt: { gte: since } }] },
    select: { categoryId: true, createdAt: true, closedAt: true, firstResponseAt: true, status: true, satisfaction: true },
  });
  const clock = await helpdeskClocks(opts.tenantId);
  const created = rows.filter((r) => r.createdAt >= since);
  const closed = rows.filter((r) => r.closedAt && r.closedAt >= since && isTicketClosed(r.status));
  const fr = avg(rows.filter((r) => r.firstResponseAt && r.firstResponseAt >= since).map((r) => {
    const c = clock(r.categoryId);
    return businessMinutesBetween(r.createdAt, r.firstResponseAt!, c.schedule, c.holidays);
  }));
  const rt = avg(closed.map((r) => {
    const c = clock(r.categoryId);
    return businessMinutesBetween(r.createdAt, r.closedAt!, c.schedule, c.holidays);
  }));
  const csat = avg(closed.filter((r) => r.satisfaction).map((r) => r.satisfaction!));

  // Buckets: days for a week, weeks for a month, months beyond.
  const buckets: Array<{ label: string; from: Date; to: Date }> = [];
  if (p.days <= 7) {
    for (let i = 0; i < 7; i++) {
      const from = new Date(since.getTime() + i * DAY);
      buckets.push({ label: localDate(from, TZ).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }), from, to: new Date(from.getTime() + DAY) });
    }
  } else if (p.days <= 31) {
    for (let i = 0, start = since.getTime(); start < now.getTime(); i++, start += 7 * DAY) {
      buckets.push({ label: `Week ${i + 1}`, from: new Date(start), to: new Date(Math.min(start + 7 * DAY, now.getTime() + 1)) });
    }
  } else {
    const first = localDate(since, TZ);
    for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); ; m++) {
      const from = new Date(Date.UTC(y, m, 1) - 330 * MIN), to = new Date(Date.UTC(y, m + 1, 1) - 330 * MIN);
      if (from > now) break;
      buckets.push({ label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }), from: from < since ? since : from, to });
    }
  }
  const series = buckets.map((b) => ({
    label: b.label,
    open: created.filter((r) => r.createdAt >= b.from && r.createdAt < b.to).length,
    closed: closed.filter((r) => r.closedAt! >= b.from && r.closedAt! < b.to).length,
  }));

  const openRows = await prisma.helpdeskTicket.groupBy({ by: ["categoryId"], where: { ...where, status: { in: TICKET_OPEN_STATUSES } }, _count: { _all: true } });
  const catNames = await prisma.helpdeskCategory.findMany({ where: { id: { in: openRows.map((r) => r.categoryId) } }, select: { id: true, name: true, parent: { select: { name: true } } } });
  const nameOf = new Map(catNames.map((c) => [c.id, helpdeskCategoryPath(c)]));
  const topCategories = openRows.map((r) => ({ label: nameOf.get(r.categoryId) ?? "—", value: r._count._all })).sort((a, b) => b.value - a.value).slice(0, 10);

  return {
    today: { open, incomingToday, incomingYesterday, closedToday, closedYesterday, onHold },
    analysis: {
      incoming: created.length, closed: closed.length,
      firstResponse: fr === null ? "N/A" : formatDuration(fr), resolution: rt === null ? "N/A" : formatDuration(rt),
      csat: csat === null ? "0" : (Math.round(csat * 10) / 10).toString(),
    },
    series, topCategories,
  };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export const HELPDESK_REPORTS = [
  { key: "all-tickets", title: "All Tickets", description: "List of tickets that have been created in the specified time period." },
  { key: "avg-first-response", title: "Average First Response Time by Category", description: "Average first response time by category in the specified time period." },
  { key: "avg-resolution", title: "Average Resolution Time by Category", description: "Average resolution time by category in the specified time period." },
  { key: "closed-tickets", title: "Closed Tickets", description: "List of tickets that have been closed in the specified time period." },
  { key: "monthly-trends", title: "Monthly Trends of Tickets Created", description: "Number of tickets that have been created on a month-on-month basis." },
  { key: "on-hold-by-category", title: "On Hold stats by Category", description: "On hold stats by category in specific time period." },
  { key: "by-assignee", title: "Ticket Aggregates by Assignee", description: "Number of open and closed tickets that are waiting on all the assignees." },
  { key: "by-category", title: "Ticket Aggregates by Category", description: "Number of open and closed tickets that are in each category." },
] as const;
export type HelpdeskReportKey = (typeof HELPDESK_REPORTS)[number]["key"];

export interface HelpdeskReportFilters { from: Date; to: Date; statuses?: string[]; categoryIds?: string[]; priorities?: string[] }
export interface HelpdeskReportTable { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number>> }

const fmtDate = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ }).replace(/ (\d{4})$/, ", $1") : "");
const escalation = (t: { missedFirstResponse: boolean; missedResolution: boolean }) =>
  [t.missedFirstResponse && "Missed First Response Time", t.missedResolution && "Missed Resolution Time"].filter(Boolean).join(", ") || "Not Escalated";

export async function helpdeskReport(key: HelpdeskReportKey, opts: { tenantId: string; scope: HelpdeskScope; filters: HelpdeskReportFilters }): Promise<HelpdeskReportTable> {
  const f = opts.filters;
  const and: Prisma.HelpdeskTicketWhereInput[] = [{ tenantId: opts.tenantId }, helpdeskScopeWhere(opts.scope)];
  if (f.categoryIds?.length) and.push({ categoryId: { in: await withDescendants(opts.tenantId, f.categoryIds) } });
  if (f.priorities?.length) and.push({ priority: { in: [...f.priorities, ...(f.priorities.includes("HIGH") ? ["URGENT"] : [])] as TicketPriority[] } });
  if (f.statuses?.length) {
    const s = f.statuses as TicketStatus[];
    and.push({ status: { in: [...s, ...(s.includes("ON_HOLD") ? ["WAITING_ON_EMPLOYEE" as const] : []), ...(s.includes("CLOSED") ? ["RESOLVED" as const] : [])] } });
  }
  const range = { gte: f.from, lt: f.to };
  const byDate = key === "closed-tickets" ? { closedAt: range } : { createdAt: range };
  const tickets = await prisma.helpdeskTicket.findMany({
    where: { AND: [...and, byDate, ...(key === "closed-tickets" ? [{ status: { in: TICKET_CLOSED_STATUSES } }] : [])] },
    include: {
      employee: { select: { employeeNumber: true, displayName: true, firstName: true, lastName: true, jobTitleName: true } },
      category: { select: { id: true, name: true, parent: { select: { name: true } } } },
      closingReason: { select: { name: true } },
    },
    orderBy: { number: "asc" },
  });
  const names = await helpdeskUserNames(opts.tenantId, tickets.flatMap((t) => [t.assigneeUserId, t.closedByUserId]));
  const clock = await helpdeskClocks(opts.tenantId);
  const minutes = (t: (typeof tickets)[number], end: Date | null) => {
    if (!end) return null;
    const c = clock(t.categoryId);
    return businessMinutesBetween(t.createdAt, end, c.schedule, c.holidays);
  };
  const who = (id: string | null) => (id ? names.get(id) ?? "—" : "Unassigned");
  const per = <K extends string>(keyOf: (t: (typeof tickets)[number]) => K, label: (k: K) => string) => {
    const m = new Map<K, typeof tickets>();
    for (const t of tickets) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t]);
    return [...m.entries()].map(([k, ts]) => ({ name: label(k), ts })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const catLabel = new Map(tickets.map((t) => [t.categoryId, helpdeskCategoryPath(t.category)]));
  const counts = (ts: typeof tickets) => {
    const s = ts.map((t) => ticketStatusOf(t.status));
    return { open: s.filter((x) => x === "OPEN").length, inProgress: s.filter((x) => x === "IN_PROGRESS").length, onHold: s.filter((x) => x === "ON_HOLD").length, closed: s.filter((x) => x === "CLOSED").length, total: ts.length };
  };
  const countCols = [{ key: "open", label: "Open" }, { key: "inProgress", label: "In Progress" }, { key: "onHold", label: "On Hold" }, { key: "closed", label: "Closed" }, { key: "total", label: "Total" }];
  const avgOf = (xs: Array<number | null>) => { const v = avg(xs.filter((x): x is number => x !== null)); return v === null ? "N/A" : formatDuration(v); };

  switch (key) {
    case "all-tickets":
    case "closed-tickets":
      return {
        columns: [
          { key: "number", label: "Ticket Number" }, { key: "title", label: "Title" }, { key: "category", label: "Ticket Category" },
          { key: "employeeNumber", label: "Employee Number" }, { key: "raisedBy", label: "Ticket Raised By" }, { key: "raisedOn", label: "Raised On" },
          { key: "priority", label: "Priority" }, { key: "assignee", label: "Assigned To" }, { key: "escalation", label: "Escalation Reason" },
          { key: "status", label: "Status" }, { key: "closedOn", label: "Closed On" }, { key: "closedBy", label: "Closed By" }, { key: "reason", label: "Closing Reason" },
        ],
        rows: tickets.map((t) => ({
          number: t.number, title: t.subject, category: helpdeskCategoryPath(t.category), employeeNumber: t.employee.employeeNumber,
          raisedBy: t.employee.displayName ?? `${t.employee.firstName} ${t.employee.lastName}`, raisedOn: fmtDate(t.createdAt),
          priority: TICKET_PRIORITY_LABEL[t.priority], assignee: who(t.assigneeUserId), escalation: escalation(t), status: TICKET_STATUS_LABEL[t.status],
          closedOn: isTicketClosed(t.status) ? fmtDate(t.closedAt ?? t.resolvedAt) : "", closedBy: t.closedByUserId ? who(t.closedByUserId) : "", reason: t.closingReason?.name ?? "",
        })),
      };
    case "avg-first-response":
      return {
        columns: [{ key: "category", label: "Category" }, { key: "tickets", label: "Tickets" }, { key: "responded", label: "Responded" }, { key: "avg", label: "Average First Response Time" }],
        rows: per((t) => t.categoryId, (k) => catLabel.get(k) ?? "—").map(({ name, ts }) => ({
          category: name, tickets: ts.length, responded: ts.filter((t) => t.firstResponseAt).length, avg: avgOf(ts.map((t) => minutes(t, t.firstResponseAt))),
        })),
      };
    case "avg-resolution":
      return {
        columns: [{ key: "category", label: "Category" }, { key: "tickets", label: "Tickets" }, { key: "closed", label: "Closed" }, { key: "avg", label: "Average Resolution Time" }],
        rows: per((t) => t.categoryId, (k) => catLabel.get(k) ?? "—").map(({ name, ts }) => {
          const done = ts.filter((t) => isTicketClosed(t.status));
          return { category: name, tickets: ts.length, closed: done.length, avg: avgOf(done.map((t) => minutes(t, t.closedAt ?? t.resolvedAt))) };
        }),
      };
    case "monthly-trends": {
      const months = new Map<string, { created: number; closed: number }>();
      for (let d = localDate(f.from, TZ); d < f.to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
        months.set(d.toISOString().slice(0, 7), { created: 0, closed: 0 });
      }
      for (const t of tickets) {
        const k = localDate(t.createdAt, TZ).toISOString().slice(0, 7);
        const m = months.get(k);
        if (m) { m.created++; if (isTicketClosed(t.status)) m.closed++; }
      }
      return {
        columns: [{ key: "month", label: "Month" }, { key: "created", label: "Tickets Created" }, { key: "closed", label: "Of Which Closed" }],
        rows: [...months.entries()].map(([k, v]) => ({ month: new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), ...v })),
      };
    }
    case "on-hold-by-category": {
      const held = await prisma.helpdeskComment.groupBy({
        by: ["ticketId"], where: { isSystem: true, body: { startsWith: "Ticket status changed to On Hold" }, ticketId: { in: tickets.map((t) => t.id) } }, _count: { _all: true },
      });
      const times = new Map(held.map((h) => [h.ticketId, h._count._all]));
      return {
        columns: [{ key: "category", label: "Category" }, { key: "tickets", label: "Tickets" }, { key: "onHold", label: "Currently On Hold" }, { key: "everHeld", label: "Put On Hold" }, { key: "times", label: "Times Put On Hold" }],
        rows: per((t) => t.categoryId, (k) => catLabel.get(k) ?? "—").map(({ name, ts }) => ({
          category: name, tickets: ts.length, onHold: ts.filter((t) => ticketStatusOf(t.status) === "ON_HOLD").length,
          everHeld: ts.filter((t) => (times.get(t.id) ?? 0) > 0 || ticketStatusOf(t.status) === "ON_HOLD").length,
          times: ts.reduce((s, t) => s + (times.get(t.id) ?? 0), 0),
        })),
      };
    }
    case "by-assignee":
      return { columns: [{ key: "name", label: "Assignee" }, ...countCols], rows: per((t) => t.assigneeUserId ?? "", (k) => who(k || null)).map(({ name, ts }) => ({ name, ...counts(ts) })) };
    case "by-category":
      return { columns: [{ key: "name", label: "Category" }, ...countCols], rows: per((t) => t.categoryId, (k) => catLabel.get(k) ?? "—").map(({ name, ts }) => ({ name, ...counts(ts) })) };
  }
}

// ---------------------------------------------------------------------------
//  Predefined categories ("Choose from predefined categories")
// ---------------------------------------------------------------------------

export const PREDEFINED_CATEGORIES: Array<{ name: string; description: string; subcategories: Array<{ name: string; description: string }> }> = [
  { name: "HR : General Employee Support", description: "General questions for the HR team: policies, letters and employee records.", subcategories: [{ name: "Employee Grievance", description: "Raise a concern about your workplace." }, { name: "Employee Records", description: "Corrections to your personal or job details." }] },
  { name: "HR : Leave & Attendance Support", description: "Dedicated to employees' attendance & leave related queries.", subcategories: [{ name: "Leave Balance Queries", description: "Balances, accruals and carry-forward." }, { name: "Attendance & Regularisation", description: "Missing punches and regularisation." }] },
  { name: "IT & Networks : Hardware Support", description: "Helps employees on their general issues for laptops, desktops & related assets.", subcategories: [] },
  { name: "IT & Networks : Software Support", description: "Resolves queries around basic system/software issues faced by employees.", subcategories: [{ name: "Login Issues", description: "Password resets and account lockouts." }, { name: "Software Installation", description: "Requests for licensed software." }] },
  { name: "Payroll & Compensation", description: "Payslips, salary credits, deductions and tax.", subcategories: [{ name: "Payslip Queries", description: "Questions about a payslip line." }, { name: "Income Tax & TDS", description: "Declarations, proofs and TDS." }] },
  { name: "For Everything related to Assets", description: "The following tickets are to be raised in cases where there are issues with your asset.", subcategories: [{ name: "Asset Replacement", description: "Replace a damaged or faulty asset." }, { name: "New Asset Request", description: "Ask for an asset you need for work." }] },
  { name: "Finance & Reimbursements", description: "Expense claims, advances and reimbursements.", subcategories: [] },
  { name: "For POSH Related Concerns", description: "Kindly raise the following ticket for all the POSH concerns.", subcategories: [] },
  { name: "Suggestion Box", description: "If you have any suggestion to the organization, kindly raise the following ticket.", subcategories: [] },
  { name: "Facilities & Admin", description: "Seating, access cards, cafeteria and office upkeep.", subcategories: [{ name: "For Stationary Requests", description: "Stationery requests and office essentials." }, { name: "For Blocking Conference Room", description: "For blocking a conference room." }] },
];
