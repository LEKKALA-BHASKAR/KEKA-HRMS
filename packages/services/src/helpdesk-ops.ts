import { prisma, type Prisma, type TicketPriority } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { raiseTicket, isTicketClosed, TICKET_OPEN_STATUSES, TICKET_PRIORITY_LABEL } from "./helpdesk";
import { suggestArticles, dueEscalation, agingBucket, cdAddMonths, AGING_BUCKETS, ESCALATION_TRIGGERS, type EscalationTicket } from "./cases-docs-math";

/**
 * Helpdesk case operations on top of tickets: a knowledge base (categories,
 * articles with revisions, publication through the workflow engine, search,
 * suggestions while raising a ticket, helpful votes), SLA targets by
 * priority, escalation rules and manual escalation, triage rules, case task
 * checklists, case templates and logging on someone's behalf, merging and
 * splitting cases, and a decision a case needs (a policy exception) routed
 * for approval.
 */

type R = { ok: boolean; message: string };
const SETTINGS = "helpdesk.settings.manage";

async function systemLine(ticketId: string, userId: string, label: string, body: string, opts: { internal?: boolean } = {}, tx: Prisma.TransactionClient = prisma) {
  await tx.helpdeskComment.create({ data: { ticketId, authorUserId: userId, authorLabel: label, body, isSystem: !opts.internal, isInternal: !!opts.internal } });
}

// ---------------------------------------------------------------------------
//  Knowledge base
// ---------------------------------------------------------------------------

export const KB_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", PENDING_APPROVAL: "Awaiting approval", PUBLISHED: "Published", ARCHIVED: "Archived" };

export async function saveKbCategory(input: { tenantId: string; id?: string | null; name: string; description?: string | null; sortOrder?: number }): Promise<R & { id?: string }> {
  const name = input.name.trim();
  if (!name || name.length > 80) return { ok: false, message: "Name the category (up to 80 characters)." };
  const clash = await prisma.kbCategory.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: "Another category already has that name." };
  if (input.id) {
    const row = await prisma.kbCategory.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Category not found." };
    await prisma.kbCategory.update({ where: { id: row.id }, data: { name, description: input.description ?? null, sortOrder: input.sortOrder ?? row.sortOrder } });
    return { ok: true, id: row.id, message: `Saved "${name}".` };
  }
  const row = await prisma.kbCategory.create({ data: { tenantId: input.tenantId, name, description: input.description ?? null, sortOrder: input.sortOrder ?? 0 } });
  return { ok: true, id: row.id, message: `Added "${name}".` };
}

export async function saveKbArticle(input: {
  tenantId: string; userId: string; id?: string | null; title: string; body: string; keywords?: string | null;
  categoryId?: string | null; helpdeskCategoryId?: string | null; policyDocumentId?: string | null; ownerUserId?: string | null; note?: string | null;
}): Promise<R & { id?: string }> {
  const title = input.title.trim(), body = input.body.trim();
  if (title.length < 5 || title.length > 160) return { ok: false, message: "Give the article a title of 5 to 160 characters." };
  if (body.length < 20) return { ok: false, message: "Write at least a couple of sentences." };
  if (body.length > 20000) return { ok: false, message: "Keep articles under 20,000 characters." };
  if (/<\s*(script|iframe|object|embed)\b|\son\w+\s*=|javascript:/i.test(body)) return { ok: false, message: "Articles cannot contain scripts or embedded frames." };
  const t = input.tenantId;
  if (input.categoryId && !(await prisma.kbCategory.count({ where: { id: input.categoryId, tenantId: t } }))) return { ok: false, message: "Category not found." };
  if (input.helpdeskCategoryId && !(await prisma.helpdeskCategory.count({ where: { id: input.helpdeskCategoryId, tenantId: t } }))) return { ok: false, message: "Ticket category not found." };
  if (input.policyDocumentId && !(await prisma.orgDocument.count({ where: { id: input.policyDocumentId, tenantId: t } }))) return { ok: false, message: "Policy not found." };
  if (input.ownerUserId && !(await prisma.user.count({ where: { id: input.ownerUserId, tenantId: t } }))) return { ok: false, message: "Owner not found." };
  const data = {
    title, body, keywords: input.keywords?.trim() || null, categoryId: input.categoryId || null, helpdeskCategoryId: input.helpdeskCategoryId || null,
    policyDocumentId: input.policyDocumentId || null, ownerUserId: input.ownerUserId || input.userId,
  };
  if (input.id) {
    const a = await prisma.kbArticle.findFirst({ where: { id: input.id, tenantId: t } });
    if (!a) return { ok: false, message: "Article not found." };
    if (a.status === "PENDING_APPROVAL") return { ok: false, message: "This article is awaiting approval. Wait for the decision before editing it." };
    const version = a.version + 1;
    await prisma.$transaction([
      prisma.kbArticle.update({ where: { id: a.id }, data: { ...data, version, status: a.status === "ARCHIVED" ? "ARCHIVED" : "DRAFT" } }),
      prisma.kbArticleRevision.create({ data: { tenantId: t, articleId: a.id, version, title, body, editedByUserId: input.userId, note: input.note?.trim() || null } }),
    ]);
    return { ok: true, id: a.id, message: a.status === "PUBLISHED" ? `Saved version ${version} as a draft. Submit it to publish the change.` : `Saved version ${version}.` };
  }
  const a = await prisma.kbArticle.create({ data: { tenantId: t, ...data, authorUserId: input.userId } });
  await prisma.kbArticleRevision.create({ data: { tenantId: t, articleId: a.id, version: 1, title, body, editedByUserId: input.userId, note: "First draft" } });
  return { ok: true, id: a.id, message: `Draft "${title}" saved.` };
}

/** Send a draft for publication approval through the workflow engine. */
export async function submitKbArticle(input: { tenantId: string; userId: string; employeeId: string | null; id: string }): Promise<R & { requestId?: string }> {
  const a = await prisma.kbArticle.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!a) return { ok: false, message: "Article not found." };
  if (a.status !== "DRAFT") return { ok: false, message: "Only a draft can be submitted." };
  const { startWorkflow } = await import("./workflow-engine");
  await prisma.kbArticle.update({ where: { id: a.id }, data: { status: "PENDING_APPROVAL" } });
  const res = await startWorkflow({
    tenantId: input.tenantId, entityType: "KB_ARTICLE", entityId: a.id, title: `Publish article: ${a.title}`, details: a.body.slice(0, 400),
    requesterUserId: input.userId, subjectEmployeeId: input.employeeId, data: { link: `/helpdesk/knowledge/${a.id}`, version: a.version },
  });
  if (!res.ok) { await prisma.kbArticle.update({ where: { id: a.id }, data: { status: "DRAFT" } }); return res; }
  await prisma.kbArticle.update({ where: { id: a.id }, data: { workflowRequestId: res.requestId } });
  const after = await prisma.kbArticle.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } });
  return { ok: true, requestId: res.requestId, message: after.status === "PUBLISHED" ? "Published." : "Sent for approval." };
}

/** Workflow effect: publish or return to draft. */
export async function applyKbDecision(tenantId: string, id: string, outcome: string, actorUserId: string | null): Promise<void> {
  const a = await prisma.kbArticle.findFirst({ where: { id, tenantId } });
  if (!a || a.status !== "PENDING_APPROVAL") return;
  if (outcome === "APPROVED") {
    const now = new Date();
    const settings = await prisma.letterSettings.findUnique({ where: { tenantId }, select: { reviewEveryMonths: true } });
    await prisma.kbArticle.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: now, publishedByUserId: actorUserId, reviewDueOn: cdAddMonths(now, settings?.reviewEveryMonths ?? 12), reviewRemindedAt: null } });
  } else await prisma.kbArticle.update({ where: { id }, data: { status: "DRAFT" } });
  await notify({ tenantId, userIds: [a.authorUserId, a.ownerUserId], kind: "HELPDESK", title: `Article "${a.title}" was ${outcome === "APPROVED" ? "published" : outcome.toLowerCase()}`, link: `/helpdesk/knowledge/${a.id}` });
}

export async function archiveKbArticle(input: { tenantId: string; id: string; archive: boolean }): Promise<R> {
  const a = await prisma.kbArticle.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!a) return { ok: false, message: "Article not found." };
  if (input.archive) {
    if (a.status === "ARCHIVED") return { ok: false, message: "Already archived." };
    if (a.status === "PENDING_APPROVAL") return { ok: false, message: "Wait for the approval decision first." };
    await prisma.kbArticle.update({ where: { id: a.id }, data: { status: "ARCHIVED" } });
    return { ok: true, message: `Archived "${a.title}".` };
  }
  if (a.status !== "ARCHIVED") return { ok: false, message: "Only an archived article can be restored." };
  await prisma.kbArticle.update({ where: { id: a.id }, data: { status: "DRAFT" } });
  return { ok: true, message: `Restored "${a.title}" as a draft.` };
}

/** Mark an article reviewed by its owner: it stays live and the next review is booked. */
export async function reviewKbArticle(input: { tenantId: string; id: string; userId: string }): Promise<R> {
  const a = await prisma.kbArticle.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!a || a.status !== "PUBLISHED") return { ok: false, message: "Only a published article is reviewed." };
  const settings = await prisma.letterSettings.findUnique({ where: { tenantId: input.tenantId }, select: { reviewEveryMonths: true } });
  await prisma.kbArticle.update({ where: { id: a.id }, data: { reviewDueOn: cdAddMonths(new Date(), settings?.reviewEveryMonths ?? 12), reviewRemindedAt: null } });
  return { ok: true, message: "Marked as reviewed." };
}

export async function searchKb(tenantId: string, q: string, opts: { categoryId?: string | null; statuses?: string[]; limit?: number } = {}) {
  const rows = await prisma.kbArticle.findMany({
    where: { tenantId, status: { in: opts.statuses ?? ["PUBLISHED"] }, ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) },
    include: { category: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: 500,
  });
  if (!q.trim()) return rows.slice(0, opts.limit ?? 100);
  // Score on words; fall back to a plain substring match for one-word or partial queries.
  const scored = suggestArticles(rows, q, null, opts.limit ?? 100);
  if (scored.length) return scored;
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => `${r.title} ${r.keywords ?? ""} ${r.body}`.toLowerCase().includes(needle)).slice(0, opts.limit ?? 100);
}

/** Articles that may answer a ticket before it is raised. */
export async function suggestKb(tenantId: string, text: string, helpdeskCategoryId?: string | null) {
  if (text.trim().length < 4) return [];
  const rows = await prisma.kbArticle.findMany({ where: { tenantId, status: "PUBLISHED" }, select: { id: true, title: true, body: true, keywords: true, helpdeskCategoryId: true, helpfulYes: true, helpfulNo: true } });
  return suggestArticles(rows, text, helpdeskCategoryId, 5).map((a) => ({ id: a.id, title: a.title, excerpt: a.body.slice(0, 160) }));
}

export async function kbFeedback(input: { tenantId: string; articleId: string; userId: string; helpful: boolean; comment?: string | null }): Promise<R> {
  const a = await prisma.kbArticle.findFirst({ where: { id: input.articleId, tenantId: input.tenantId, status: "PUBLISHED" } });
  if (!a) return { ok: false, message: "Article not found." };
  const prior = await prisma.kbArticleFeedback.findUnique({ where: { articleId_userId: { articleId: a.id, userId: input.userId } } });
  await prisma.$transaction(async (tx) => {
    if (prior) {
      if (prior.helpful === input.helpful) return;
      await tx.kbArticleFeedback.update({ where: { id: prior.id }, data: { helpful: input.helpful, comment: input.comment ?? prior.comment } });
      await tx.kbArticle.update({ where: { id: a.id }, data: input.helpful ? { helpfulYes: { increment: 1 }, helpfulNo: { decrement: 1 } } : { helpfulNo: { increment: 1 }, helpfulYes: { decrement: 1 } } });
    } else {
      await tx.kbArticleFeedback.create({ data: { tenantId: input.tenantId, articleId: a.id, userId: input.userId, helpful: input.helpful, comment: input.comment ?? null } });
      await tx.kbArticle.update({ where: { id: a.id }, data: input.helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } } });
    }
  });
  return { ok: true, message: "Thanks for the feedback." };
}

/** Share a published article on a ticket: linked, and posted to the raiser. */
export async function linkArticleToTicket(input: { tenantId: string; ticketId: string; articleId: string; userId: string; label: string }): Promise<R> {
  const [t, a] = await Promise.all([
    prisma.helpdeskTicket.findFirst({ where: { id: input.ticketId, tenantId: input.tenantId } }),
    prisma.kbArticle.findFirst({ where: { id: input.articleId, tenantId: input.tenantId, status: "PUBLISHED" } }),
  ]);
  if (!t) return { ok: false, message: "Ticket not found." };
  if (!a) return { ok: false, message: "Only a published article can be shared." };
  const exists = await prisma.helpdeskTicketArticle.findUnique({ where: { ticketId_articleId: { ticketId: t.id, articleId: a.id } } });
  if (exists) return { ok: false, message: "That article is already linked." };
  await prisma.$transaction(async (tx) => {
    await tx.helpdeskTicketArticle.create({ data: { tenantId: input.tenantId, ticketId: t.id, articleId: a.id, linkedByUserId: input.userId } });
    await tx.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: input.userId, authorLabel: input.label, body: `Knowledge article shared: ${a.title} — /help/${a.id}` } });
  });
  return { ok: true, message: `Shared "${a.title}".` };
}

// ---------------------------------------------------------------------------
//  SLA by priority, triage rules, escalation rules
// ---------------------------------------------------------------------------

const PRIORITIES = ["NA", "LOW", "MEDIUM", "HIGH"] as const;

export async function saveSlaPolicy(input: { tenantId: string; id?: string | null; categoryId?: string | null; priority: string; firstResponseHours: number; resolutionHours: number }): Promise<R & { id?: string }> {
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false, message: "Pick a priority." };
  const fr = input.firstResponseHours, res = input.resolutionHours;
  if (!Number.isInteger(fr) || !Number.isInteger(res) || fr < 1 || res < 1 || fr > 2000 || res > 2000) return { ok: false, message: "Targets are whole hours between 1 and 2000." };
  if (fr > res) return { ok: false, message: "The first response target cannot be later than the resolution target." };
  const categoryId = input.categoryId || null;
  if (categoryId && !(await prisma.helpdeskCategory.count({ where: { id: categoryId, tenantId: input.tenantId } }))) return { ok: false, message: "Category not found." };
  const dup = await prisma.helpdeskSlaPolicy.findFirst({ where: { tenantId: input.tenantId, categoryId, priority: input.priority as TicketPriority, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (dup) return { ok: false, message: "There is already a policy for that category and priority." };
  const data = { categoryId, priority: input.priority as TicketPriority, firstResponseHours: fr, resolutionHours: res };
  if (input.id) {
    const row = await prisma.helpdeskSlaPolicy.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Policy not found." };
    await prisma.helpdeskSlaPolicy.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, message: "SLA policy saved. New tickets use it; open tickets re-target when their priority changes." };
  }
  const row = await prisma.helpdeskSlaPolicy.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: `SLA for ${TICKET_PRIORITY_LABEL[input.priority]} priority added.` };
}

export async function saveTriageRule(input: { tenantId: string; id?: string | null; name: string; keywords: string; categoryId?: string | null; setPriority?: string | null; setSeverity?: string | null; isActive?: boolean }): Promise<R & { id?: string }> {
  const name = input.name.trim();
  const keywords = input.keywords.split(",").map((k) => k.trim()).filter(Boolean).join(", ");
  if (!name) return { ok: false, message: "Name the rule." };
  if (!keywords) return { ok: false, message: "Give at least one keyword." };
  if (!input.setPriority && !input.setSeverity) return { ok: false, message: "Set a priority, a severity or both." };
  if (input.setPriority && !(PRIORITIES as readonly string[]).includes(input.setPriority)) return { ok: false, message: "Pick a priority." };
  if (input.setSeverity && !["S1", "S2", "S3", "S4"].includes(input.setSeverity)) return { ok: false, message: "Pick a severity." };
  const clash = await prisma.helpdeskTriageRule.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: "Another rule has that name." };
  const data = { name, keywords, categoryId: input.categoryId || null, setPriority: (input.setPriority || null) as TicketPriority | null, setSeverity: input.setSeverity || null, isActive: input.isActive ?? true };
  if (input.id) {
    const row = await prisma.helpdeskTriageRule.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Rule not found." };
    await prisma.helpdeskTriageRule.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, message: "Rule saved." };
  }
  const row = await prisma.helpdeskTriageRule.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: "Rule added." };
}

export async function saveEscalationRule(input: {
  tenantId: string; id?: string | null; name: string; categoryId?: string | null; priority?: string | null; trigger: string; afterHours: number;
  level: number; escalateTo: string; escalateUserId?: string | null; reassign?: boolean; raisePriority?: string | null; isActive?: boolean;
}): Promise<R & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Name the rule." };
  if (!(input.trigger in ESCALATION_TRIGGERS)) return { ok: false, message: "Pick a trigger." };
  if (!Number.isInteger(input.afterHours) || input.afterHours < 0 || input.afterHours > 720) return { ok: false, message: "Wait between 0 and 720 hours." };
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 5) return { ok: false, message: "Levels run from 1 to 5." };
  if (!["CATEGORY_HEAD", "ASSIGNEE_MANAGER", "USER"].includes(input.escalateTo)) return { ok: false, message: "Pick who it escalates to." };
  if (input.escalateTo === "USER") {
    if (!input.escalateUserId || !(await prisma.user.count({ where: { id: input.escalateUserId, tenantId: input.tenantId } }))) return { ok: false, message: "Pick the person to escalate to." };
  }
  if (input.priority && !(PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false, message: "Pick a priority." };
  if (input.raisePriority && !(PRIORITIES as readonly string[]).includes(input.raisePriority)) return { ok: false, message: "Pick a priority to raise to." };
  if (input.categoryId && !(await prisma.helpdeskCategory.count({ where: { id: input.categoryId, tenantId: input.tenantId } }))) return { ok: false, message: "Category not found." };
  const clash = await prisma.helpdeskEscalationRule.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: "Another rule has that name." };
  const data = {
    name, categoryId: input.categoryId || null, priority: (input.priority || null) as TicketPriority | null, trigger: input.trigger, afterHours: input.afterHours, level: input.level,
    escalateTo: input.escalateTo, escalateUserId: input.escalateTo === "USER" ? input.escalateUserId! : null, reassign: !!input.reassign,
    raisePriority: (input.raisePriority || null) as TicketPriority | null, isActive: input.isActive ?? true,
  };
  if (input.id) {
    const row = await prisma.helpdeskEscalationRule.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Rule not found." };
    await prisma.helpdeskEscalationRule.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, message: "Escalation rule saved." };
  }
  const row = await prisma.helpdeskEscalationRule.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: "Escalation rule added." };
}

async function escalationTarget(tenantId: string, kind: string, userId: string | null, t: { assigneeUserId: string | null; category: { defaultAssigneeUserId: string | null; parent: { defaultAssigneeUserId: string | null } | null } }): Promise<string | null> {
  if (kind === "USER") return userId;
  if (kind === "ASSIGNEE_MANAGER" && t.assigneeUserId) {
    const e = await prisma.employee.findFirst({ where: { tenantId, userId: t.assigneeUserId }, select: { reportingManager: { select: { userId: true } } } });
    if (e?.reportingManager?.userId) return e.reportingManager.userId;
  }
  return t.category.defaultAssigneeUserId ?? t.category.parent?.defaultAssigneeUserId ?? null;
}

async function escalate(tenantId: string, ticketId: string, opts: { level: number; reason: string; targetUserId: string | null; reassign: boolean; raisePriority: TicketPriority | null; ruleId: string | null; byUserId: string | null; byLabel: string }) {
  const t = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
  const target = opts.targetUserId ?? (await usersWithPermission(tenantId, SETTINGS))[0] ?? null;
  const data: Prisma.HelpdeskTicketUncheckedUpdateInput = { escalationLevel: opts.level, lastEscalatedAt: new Date() };
  const lines = [`Escalated to level ${opts.level}: ${opts.reason}`];
  if (opts.reassign && target && target !== t.assigneeUserId) { data.assigneeUserId = target; lines.push("Reassigned to the escalation owner"); }
  if (opts.raisePriority && ["NA", "LOW", "MEDIUM", "HIGH"].indexOf(opts.raisePriority) > ["NA", "LOW", "MEDIUM", "HIGH"].indexOf(t.priority === "URGENT" ? "HIGH" : t.priority)) {
    data.priority = opts.raisePriority; lines.push(`Priority raised to ${TICKET_PRIORITY_LABEL[opts.raisePriority]}`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.helpdeskTicket.update({ where: { id: t.id }, data });
    await tx.helpdeskTicketEscalation.create({ data: { tenantId, ticketId: t.id, ruleId: opts.ruleId, level: opts.level, escalatedToUserId: target, reason: opts.reason, byUserId: opts.byUserId } });
    for (const l of lines) await systemLine(t.id, opts.byUserId ?? target ?? "system", opts.byLabel, l, { internal: true }, tx);
  });
  await notify({ tenantId, userIds: [target, t.assigneeUserId], kind: "HELPDESK", title: `#${t.number} escalated (level ${opts.level})`, body: `${t.subject} — ${opts.reason}`, link: `/helpdesk/tickets/${t.id}`, email: true });
}

/** Apply escalation rules to every open ticket (the cases-docs job and before agent views). */
export async function runHelpdeskEscalations(tenantId: string, now = new Date()): Promise<{ escalated: number }> {
  const rules = await prisma.helpdeskEscalationRule.findMany({ where: { tenantId, isActive: true } });
  if (!rules.length) return { escalated: 0 };
  const tickets = await prisma.helpdeskTicket.findMany({
    where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, mergedIntoId: null },
    include: { category: { select: { parentId: true, defaultAssigneeUserId: true, parent: { select: { defaultAssigneeUserId: true } } } } },
  });
  let escalated = 0;
  for (const t of tickets) {
    const view: EscalationTicket = { ...t, parentCategoryId: t.category.parentId, priority: t.priority };
    const rule = dueEscalation(rules, view, now);
    if (!rule) continue;
    const target = await escalationTarget(tenantId, rule.escalateTo, rule.escalateUserId, t);
    await escalate(tenantId, t.id, { level: rule.level, reason: `${rule.name} (${ESCALATION_TRIGGERS[rule.trigger as keyof typeof ESCALATION_TRIGGERS]})`, targetUserId: target, reassign: rule.reassign, raisePriority: rule.raisePriority, ruleId: rule.id, byUserId: null, byLabel: "Escalation rules" });
    escalated++;
  }
  return { escalated };
}

export async function escalateTicketManually(input: { tenantId: string; ticketId: string; userId: string; label: string; reason: string; toUserId?: string | null }): Promise<R> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: input.ticketId, tenantId: input.tenantId }, include: { category: { select: { defaultAssigneeUserId: true, parent: { select: { defaultAssigneeUserId: true } } } } } });
  if (!t) return { ok: false, message: "Ticket not found." };
  if (isTicketClosed(t.status)) return { ok: false, message: "A closed ticket cannot be escalated." };
  if (!input.reason.trim()) return { ok: false, message: "Say why it is being escalated." };
  if (input.toUserId && !(await prisma.user.count({ where: { id: input.toUserId, tenantId: input.tenantId } }))) return { ok: false, message: "That person does not exist." };
  const target = input.toUserId || (await escalationTarget(input.tenantId, "CATEGORY_HEAD", null, t));
  await escalate(input.tenantId, t.id, { level: t.escalationLevel + 1, reason: input.reason.trim(), targetUserId: target, reassign: !!input.toUserId, raisePriority: null, ruleId: null, byUserId: input.userId, byLabel: input.label });
  return { ok: true, message: `Escalated to level ${t.escalationLevel + 1}.` };
}

export async function acknowledgeEscalation(input: { tenantId: string; escalationId: string; userId: string }): Promise<R> {
  const e = await prisma.helpdeskTicketEscalation.findFirst({ where: { id: input.escalationId, tenantId: input.tenantId } });
  if (!e) return { ok: false, message: "Escalation not found." };
  if (e.acknowledgedAt) return { ok: false, message: "Already acknowledged." };
  await prisma.helpdeskTicketEscalation.update({ where: { id: e.id }, data: { acknowledgedAt: new Date() } });
  return { ok: true, message: "Escalation acknowledged." };
}

// ---------------------------------------------------------------------------
//  Tasks, templates, logging on behalf, merge and split
// ---------------------------------------------------------------------------

export async function addTicketTask(input: { tenantId: string; ticketId: string; title: string; assigneeUserId?: string | null; dueOn?: Date | null; userId: string; label: string }): Promise<R> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: input.ticketId, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Ticket not found." };
  if (isTicketClosed(t.status)) return { ok: false, message: "Reopen the ticket to add tasks." };
  const title = input.title.trim();
  if (!title || title.length > 200) return { ok: false, message: "Describe the task (up to 200 characters)." };
  if (input.assigneeUserId && !(await prisma.user.count({ where: { id: input.assigneeUserId, tenantId: input.tenantId } }))) return { ok: false, message: "That person does not exist." };
  const n = await prisma.helpdeskTicketTask.count({ where: { ticketId: t.id } });
  if (n >= 30) return { ok: false, message: "A case can hold up to 30 tasks." };
  await prisma.helpdeskTicketTask.create({ data: { tenantId: input.tenantId, ticketId: t.id, title, assigneeUserId: input.assigneeUserId || null, dueOn: input.dueOn ?? null, sortOrder: n } });
  await systemLine(t.id, input.userId, input.label, `Task added: ${title}`, { internal: true });
  if (input.assigneeUserId && input.assigneeUserId !== input.userId) await notify({ tenantId: input.tenantId, userIds: [input.assigneeUserId], kind: "HELPDESK", title: `Task on #${t.number}: ${title}`, link: `/helpdesk/tickets/${t.id}` });
  return { ok: true, message: "Task added." };
}

export async function toggleTicketTask(input: { tenantId: string; taskId: string; userId: string; label: string }): Promise<R> {
  const k = await prisma.helpdeskTicketTask.findFirst({ where: { id: input.taskId, tenantId: input.tenantId }, include: { ticket: { select: { status: true } } } });
  if (!k) return { ok: false, message: "Task not found." };
  if (isTicketClosed(k.ticket.status)) return { ok: false, message: "The ticket is closed." };
  const done = !k.doneAt;
  await prisma.helpdeskTicketTask.update({ where: { id: k.id }, data: done ? { doneAt: new Date(), doneByUserId: input.userId } : { doneAt: null, doneByUserId: null } });
  await systemLine(k.ticketId, input.userId, input.label, `Task ${done ? "completed" : "reopened"}: ${k.title}`, { internal: true });
  return { ok: true, message: done ? "Task done." : "Task reopened." };
}

export async function deleteTicketTask(input: { tenantId: string; taskId: string }): Promise<R> {
  const k = await prisma.helpdeskTicketTask.findFirst({ where: { id: input.taskId, tenantId: input.tenantId } });
  if (!k) return { ok: false, message: "Task not found." };
  await prisma.helpdeskTicketTask.delete({ where: { id: k.id } });
  return { ok: true, message: "Task removed." };
}

export async function saveCaseTemplate(input: { tenantId: string; id?: string | null; name: string; categoryId: string; subject: string; description: string; priority?: string | null; tasks: string[]; isActive?: boolean }): Promise<R & { id?: string }> {
  const name = input.name.trim(), subject = input.subject.trim(), description = input.description.trim();
  if (!name || !subject || description.length < 5) return { ok: false, message: "Give the template a name, a subject and a description." };
  const cat = await prisma.helpdeskCategory.findFirst({ where: { id: input.categoryId, tenantId: input.tenantId }, include: { _count: { select: { children: true } } } });
  if (!cat) return { ok: false, message: "Pick a category." };
  if (cat._count.children > 0) return { ok: false, message: `Pick a subcategory of ${cat.name}.` };
  if (input.priority && !(PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false, message: "Pick a priority." };
  const tasks = input.tasks.map((x) => x.trim()).filter(Boolean).slice(0, 30);
  const clash = await prisma.helpdeskCaseTemplate.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: "Another template has that name." };
  const data = { name, categoryId: cat.id, subject, description, priority: (input.priority || null) as TicketPriority | null, tasks, isActive: input.isActive ?? true };
  if (input.id) {
    const row = await prisma.helpdeskCaseTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Template not found." };
    await prisma.helpdeskCaseTemplate.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, message: "Template saved." };
  }
  const row = await prisma.helpdeskCaseTemplate.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: "Template added." };
}

export const CASE_CHANNELS = { WEB: "Self-service portal", EMAIL: "Email", PHONE: "Phone call", WALK_IN: "Walk-in", CHAT: "Chat" } as const;

/** An agent logs a case for an employee (phone, walk-in, email), optionally from a template. */
export async function logCaseOnBehalf(input: {
  tenantId: string; userId: string; label: string; employeeId: string; channel: string; templateId?: string | null;
  categoryId?: string | null; subject?: string | null; description?: string | null; priority?: string | null;
}): Promise<R & { ticketId?: string; number?: number }> {
  if (!(input.channel in CASE_CHANNELS)) return { ok: false, message: "Pick how the case reached you." };
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, status: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  const tpl = input.templateId ? await prisma.helpdeskCaseTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId, isActive: true } }) : null;
  if (input.templateId && !tpl) return { ok: false, message: "Template not found." };
  const categoryId = input.categoryId || tpl?.categoryId;
  const subject = (input.subject || tpl?.subject || "").trim();
  const description = (input.description || tpl?.description || "").trim();
  if (!categoryId || !subject || !description) return { ok: false, message: "Pick a category and describe the case." };
  const priority = (input.priority || tpl?.priority || null) as TicketPriority | null;
  const res = await raiseTicket({ employeeId: emp.id, categoryId, subject, description, priority, channel: input.channel, loggedByUserId: input.userId });
  if (!res.ok || !res.ticketId) return res;
  const tasks = Array.isArray(tpl?.tasks) ? (tpl!.tasks as unknown[]).map(String) : [];
  if (tasks.length) await prisma.helpdeskTicketTask.createMany({ data: tasks.map((title, i) => ({ tenantId: input.tenantId, ticketId: res.ticketId!, title, sortOrder: i })) });
  await systemLine(res.ticketId, input.userId, input.label, `Logged by ${input.label} via ${CASE_CHANNELS[input.channel as keyof typeof CASE_CHANNELS]}${tpl ? ` from template "${tpl.name}"` : ""}`);
  return { ok: true, ticketId: res.ticketId, number: res.number, message: `Case #${res.number} logged.` };
}

/** Merge a duplicate into another open case of the same employee. */
export async function mergeTickets(input: { tenantId: string; sourceId: string; targetNumber: number; userId: string; label: string }): Promise<R> {
  const src = await prisma.helpdeskTicket.findFirst({ where: { id: input.sourceId, tenantId: input.tenantId } });
  const dst = await prisma.helpdeskTicket.findFirst({ where: { tenantId: input.tenantId, number: input.targetNumber } });
  if (!src || !dst) return { ok: false, message: "Ticket not found." };
  if (src.id === dst.id) return { ok: false, message: "A ticket cannot be merged into itself." };
  if (isTicketClosed(src.status) || isTicketClosed(dst.status)) return { ok: false, message: "Both tickets must be open." };
  if (dst.mergedIntoId) return { ok: false, message: "That ticket was itself merged away." };
  if (src.employeeId !== dst.employeeId) return { ok: false, message: "Only cases raised by the same employee can be merged." };
  const comments = await prisma.helpdeskComment.findMany({ where: { ticketId: src.id, isSystem: false }, orderBy: { createdAt: "asc" } });
  const followers = await prisma.helpdeskTicketFollower.findMany({ where: { ticketId: src.id } });
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.helpdeskComment.create({ data: { ticketId: dst.id, authorUserId: input.userId, authorLabel: input.label, isSystem: true, body: `#${src.number} "${src.subject}" was merged into this ticket by ${input.label}` } });
    await tx.helpdeskComment.create({ data: { ticketId: dst.id, authorUserId: input.userId, authorLabel: input.label, body: `From #${src.number}: ${src.description}` } });
    for (const c of comments) await tx.helpdeskComment.create({ data: { ticketId: dst.id, authorUserId: c.authorUserId, authorLabel: c.authorLabel, body: `(from #${src.number}) ${c.body}`, isInternal: c.isInternal, createdAt: c.createdAt } });
    for (const f of followers) {
      const has = await tx.helpdeskTicketFollower.findFirst({ where: { ticketId: dst.id, userId: f.userId } });
      if (!has) await tx.helpdeskTicketFollower.create({ data: { ticketId: dst.id, userId: f.userId, viaRole: f.viaRole, addedByUserId: input.userId } });
    }
    await tx.helpdeskTicketTask.updateMany({ where: { ticketId: src.id }, data: { ticketId: dst.id } });
    await tx.helpdeskTicket.update({ where: { id: src.id }, data: { status: "CLOSED", closedAt: now, resolvedAt: now, closedByUserId: input.userId, mergedIntoId: dst.id, onHoldSince: null } });
    await tx.helpdeskComment.create({ data: { ticketId: src.id, authorUserId: input.userId, authorLabel: input.label, isSystem: true, body: `Merged into #${dst.number} by ${input.label}. Follow that ticket for updates.` } });
  });
  const raiser = await prisma.employee.findUnique({ where: { id: src.employeeId }, select: { userId: true } });
  await notify({ tenantId: input.tenantId, userIds: [raiser?.userId], kind: "HELPDESK", title: `#${src.number} was merged into #${dst.number}`, link: `/me/helpdesk/${dst.id}` });
  return { ok: true, message: `Merged #${src.number} into #${dst.number}.` };
}

/** Split part of a case into a new case for the same employee. */
export async function splitTicket(input: { tenantId: string; sourceId: string; subject: string; description: string; categoryId?: string | null; userId: string; label: string }): Promise<R & { ticketId?: string }> {
  const src = await prisma.helpdeskTicket.findFirst({ where: { id: input.sourceId, tenantId: input.tenantId } });
  if (!src) return { ok: false, message: "Ticket not found." };
  if (isTicketClosed(src.status)) return { ok: false, message: "Reopen the ticket to split it." };
  if (input.subject.trim().length < 3 || input.description.trim().length < 5) return { ok: false, message: "Give the new case a subject and a description." };
  const res = await raiseTicket({ employeeId: src.employeeId, categoryId: input.categoryId || src.categoryId, subject: input.subject.trim(), description: input.description.trim(), priority: src.priority, channel: src.channel, loggedByUserId: input.userId });
  if (!res.ok || !res.ticketId) return res;
  await prisma.helpdeskTicket.update({ where: { id: res.ticketId }, data: { splitFromId: src.id } });
  await systemLine(src.id, input.userId, input.label, `Split into #${res.number} "${input.subject.trim()}" by ${input.label}`);
  await systemLine(res.ticketId, input.userId, input.label, `Split from #${src.number} by ${input.label}`);
  return { ok: true, ticketId: res.ticketId, message: `Split into #${res.number}.` };
}

// ---------------------------------------------------------------------------
//  A decision the case needs, routed for approval
// ---------------------------------------------------------------------------

export async function requestCaseApproval(input: { tenantId: string; ticketId: string; userId: string; label: string; summary: string; amount?: number | null }): Promise<R & { requestId?: string }> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: input.ticketId, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Ticket not found." };
  if (isTicketClosed(t.status)) return { ok: false, message: "Reopen the ticket first." };
  if (t.approvalStatus === "PENDING") return { ok: false, message: "A decision is already awaiting approval." };
  const summary = input.summary.trim();
  if (summary.length < 10) return { ok: false, message: "Describe what needs approving (at least 10 characters)." };
  const { startWorkflow } = await import("./workflow-engine");
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { approvalStatus: "PENDING" } });
  const res = await startWorkflow({
    tenantId: input.tenantId, entityType: "HELPDESK_CASE", entityId: t.id, title: `Case #${t.number}: ${t.subject}`, details: summary, amount: input.amount ?? null,
    requesterUserId: input.userId, subjectEmployeeId: t.employeeId, data: { link: `/helpdesk/tickets/${t.id}` },
  });
  if (!res.ok) { await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { approvalStatus: t.approvalStatus } }); return res; }
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { approvalRequestId: res.requestId } });
  await systemLine(t.id, input.userId, input.label, `Approval requested by ${input.label}: ${summary}`, { internal: true });
  return { ok: true, requestId: res.requestId, message: res.message };
}

export async function applyCaseDecision(tenantId: string, ticketId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: ticketId, tenantId } });
  if (!t || t.approvalStatus !== "PENDING") return;
  const status = outcome === "APPROVED" ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "NONE";
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { approvalStatus: status } });
  if (status !== "NONE") await systemLine(t.id, actorUserId ?? "system", "Approvals", `The requested decision was ${status.toLowerCase()}`);
  await notify({ tenantId, userIds: [t.assigneeUserId], kind: "HELPDESK", title: `#${t.number}: decision ${outcome.toLowerCase()}`, link: `/helpdesk/tickets/${t.id}` });
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export async function helpdeskAgingReport(tenantId: string, where: Prisma.HelpdeskTicketWhereInput, now = new Date()) {
  const open = await prisma.helpdeskTicket.findMany({ where: { ...where, tenantId, status: { in: TICKET_OPEN_STATUSES } }, select: { createdAt: true, category: { select: { name: true, parent: { select: { name: true } } } } } });
  const rows = new Map<string, Record<string, number>>();
  for (const t of open) {
    const key = t.category.parent ? `${t.category.parent.name} > ${t.category.name}` : t.category.name;
    const r = rows.get(key) ?? Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
    r[agingBucket(t.createdAt, now)]! += 1;
    rows.set(key, r);
  }
  return { buckets: AGING_BUCKETS, rows: [...rows.entries()].map(([category, counts]) => ({ category, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total) };
}
