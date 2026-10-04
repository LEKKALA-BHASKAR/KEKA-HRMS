"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  helpdeskScope, hasHelpdeskScope, inHelpdeskScope, saveKbCategory, saveKbArticle, submitKbArticle, archiveKbArticle, reviewKbArticle,
  kbFeedback, linkArticleToTicket, suggestKb, saveSlaPolicy, saveTriageRule, saveEscalationRule, escalateTicketManually, acknowledgeEscalation,
  addTicketTask, toggleTicketTask, deleteTicketTask, saveCaseTemplate, logCaseOnBehalf, mergeTickets, splitTicket, requestCaseApproval,
} from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, who, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Helpdesk case operations: the knowledge base, SLA by priority, triage and
 * escalation rules, case templates, cases logged for an employee, task
 * checklists, merge and split, and approvals on a case. Agents act within
 * their categories; rules and templates need helpdesk settings. Every write
 * is audited.
 */

const P = PERMISSIONS;
const PATHS = ["/helpdesk", "/helpdesk/tickets", "/helpdesk/knowledge", "/helpdesk/operations", "/me/helpdesk", "/me/knowledge"];

async function agentScope(v: Viewer) {
  const scope = await helpdeskScope(v.tenantId, v.user.id, can(v, P.HELPDESK_MANAGE));
  return { scope, isAgent: hasHelpdeskScope(scope) || can(v, P.HELPDESK_SETTINGS) };
}

/** The ticket, when the viewer works it as an agent (never their own). */
async function agentTicket(v: Viewer, ticketId: string) {
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: ticketId, tenantId: v.tenantId } });
  if (!t || t.employeeId === v.employee?.id) return null;
  const { scope } = await agentScope(v);
  return inHelpdeskScope(scope, t.categoryId) ? t : null;
}

// ---------------------------------------------------------------------------
//  Knowledge base
// ---------------------------------------------------------------------------

export async function saveKbCategoryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const r = await saveKbCategory({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), description: optStr(fd, "description"), sortOrder: int(fd, "sortOrder") ?? 0 });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: fd.get("id") ? "UPDATE" : "CREATE", entityType: "KbCategory", entityId: r.id, summary: `Knowledge base category "${str(fd, "name")}" saved` });
  return result(r, PATHS);
}

export async function saveKbArticleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!(await agentScope(v)).isAgent) return DENIED;
  const r = await saveKbArticle({
    tenantId: v.tenantId, userId: v.user.id, id: optStr(fd, "id"), title: str(fd, "title"), body: str(fd, "body"), keywords: optStr(fd, "keywords"),
    categoryId: optStr(fd, "categoryId"), helpdeskCategoryId: optStr(fd, "helpdeskCategoryId"), policyDocumentId: optStr(fd, "policyDocumentId"), ownerUserId: optStr(fd, "ownerUserId"), note: optStr(fd, "note"),
  });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: fd.get("id") ? "UPDATE" : "CREATE", entityType: "KbArticle", entityId: r.id, summary: `Knowledge article "${str(fd, "title")}" saved` });
  return result(r, PATHS);
}

export async function submitKbArticleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!(await agentScope(v)).isAgent) return DENIED;
  const r = await submitKbArticle({ tenantId: v.tenantId, userId: v.user.id, employeeId: v.employee?.id ?? null, id: str(fd, "id") });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "KbArticle", entityId: str(fd, "id"), summary: "Knowledge article submitted for publication" });
  return result(r, [...PATHS, "/inbox"]);
}

export async function archiveKbArticleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const archive = str(fd, "archive") !== "false";
  const r = await archiveKbArticle({ tenantId: v.tenantId, id: str(fd, "id"), archive });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "KbArticle", entityId: str(fd, "id"), summary: archive ? "Knowledge article archived" : "Knowledge article restored to draft" });
  return result(r, PATHS);
}

export async function reviewKbArticleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!(await agentScope(v)).isAgent) return DENIED;
  const r = await reviewKbArticle({ tenantId: v.tenantId, id: str(fd, "id"), userId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "KbArticle", entityId: str(fd, "id"), summary: "Knowledge article reviewed and still accurate" });
  return result(r, PATHS);
}

/** Any signed-in employee rates a published article. */
export async function kbFeedbackAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const r = await kbFeedback({ tenantId: v.tenantId, articleId: str(fd, "articleId"), userId: v.user.id, helpful: str(fd, "helpful") === "yes", comment: optStr(fd, "comment") });
  return result(r, PATHS);
}

export async function linkArticleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const r = await linkArticleToTicket({ tenantId: v.tenantId, ticketId: t.id, articleId: str(fd, "articleId"), userId: v.user.id, label: who(v) });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: t.id, summary: `Linked a knowledge article to #${t.number}` });
  return result(r, [...PATHS, `/helpdesk/tickets/${t.id}`]);
}

/** Articles that may answer what the employee is typing (no write). */
export async function suggestArticlesAction(text: string, categoryId: string | null): Promise<Array<{ id: string; title: string; excerpt: string }>> {
  const v = await requireViewer();
  if (typeof text !== "string") return [];
  return suggestKb(v.tenantId, text.slice(0, 500), categoryId);
}

// ---------------------------------------------------------------------------
//  Rules: SLA by priority, triage, escalation, case templates
// ---------------------------------------------------------------------------

export async function saveSlaPolicyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  if (str(fd, "delete") === "1") {
    const n = await prisma.helpdeskSlaPolicy.deleteMany({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
    if (!n.count) return no("Policy not found.");
    await writeAudit(v, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskSlaPolicy", entityId: str(fd, "id"), summary: "SLA policy removed" });
    return result({ ok: true, message: "Policy removed." }, PATHS);
  }
  const fr = int(fd, "firstResponseHours"), rh = int(fd, "resolutionHours");
  if (fr === null || rh === null || Number.isNaN(fr) || Number.isNaN(rh)) return no("Enter both targets in hours.");
  const r = await saveSlaPolicy({ tenantId: v.tenantId, id: optStr(fd, "id"), categoryId: optStr(fd, "categoryId"), priority: str(fd, "priority"), firstResponseHours: fr, resolutionHours: rh });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskSlaPolicy", entityId: r.id, summary: `SLA for ${str(fd, "priority")} priority: respond ${fr}h, resolve ${rh}h` });
  return result(r, PATHS);
}

export async function saveTriageRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const r = await saveTriageRule({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), keywords: str(fd, "keywords"), categoryId: optStr(fd, "categoryId"), setPriority: optStr(fd, "setPriority"), setSeverity: optStr(fd, "setSeverity"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTriageRule", entityId: r.id, summary: `Triage rule "${str(fd, "name")}" saved` });
  return result(r, PATHS);
}

export async function saveEscalationRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const after = int(fd, "afterHours"), level = int(fd, "level");
  const r = await saveEscalationRule({
    tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), categoryId: optStr(fd, "categoryId"), priority: optStr(fd, "priority"), trigger: str(fd, "trigger"),
    afterHours: after ?? 0, level: level ?? 1, escalateTo: str(fd, "escalateTo"), escalateUserId: optStr(fd, "escalateUserId"), reassign: bool(fd, "reassign"), raisePriority: optStr(fd, "raisePriority"),
    isActive: fd.has("isActive") ? bool(fd, "isActive") : true,
  });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskEscalationRule", entityId: r.id, summary: `Escalation rule "${str(fd, "name")}" saved` });
  return result(r, PATHS);
}

export async function saveCaseTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const tasks = str(fd, "tasks").split("\n").map((s) => s.trim()).filter(Boolean);
  const r = await saveCaseTemplate({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), categoryId: str(fd, "categoryId"), subject: str(fd, "subject"), description: str(fd, "description"), priority: optStr(fd, "priority"), tasks, isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskCaseTemplate", entityId: r.id, summary: `Case template "${str(fd, "name")}" saved` });
  return result(r, PATHS);
}

// ---------------------------------------------------------------------------
//  Working a case
// ---------------------------------------------------------------------------

export async function logCaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const { scope, isAgent } = await agentScope(v);
  if (!isAgent) return DENIED;
  const categoryId = optStr(fd, "categoryId");
  const templateId = optStr(fd, "templateId");
  if (categoryId && !inHelpdeskScope(scope, categoryId)) return no("That category is outside your helpdesk scope.");
  if (templateId) {
    const tpl = await prisma.helpdeskCaseTemplate.findFirst({ where: { id: templateId, tenantId: v.tenantId } });
    if (tpl && !categoryId && !inHelpdeskScope(scope, tpl.categoryId)) return no("That template's category is outside your helpdesk scope.");
  }
  const r = await logCaseOnBehalf({ tenantId: v.tenantId, userId: v.user.id, label: who(v), employeeId: str(fd, "employeeId"), channel: str(fd, "channel"), templateId, categoryId, subject: optStr(fd, "subject"), description: optStr(fd, "description"), priority: optStr(fd, "priority") });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskTicket", entityId: r.ticketId, summary: `Logged case #${r.number} on behalf of an employee via ${str(fd, "channel")}` });
  return result(r, PATHS);
}

export async function addTicketTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const r = await addTicketTask({ tenantId: v.tenantId, ticketId: t.id, title: str(fd, "title"), assigneeUserId: optStr(fd, "assigneeUserId"), dueOn: day(fd, "dueOn"), userId: v.user.id, label: who(v) });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskTicketTask", entityId: t.id, summary: `Task added to #${t.number}: ${str(fd, "title")}` });
  return result(r, [`/helpdesk/tickets/${t.id}`]);
}

export async function toggleTicketTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const task = await prisma.helpdeskTicketTask.findFirst({ where: { id: str(fd, "taskId"), tenantId: v.tenantId } });
  if (!task) return no("Task not found.");
  const t = await agentTicket(v, task.ticketId);
  if (!t && task.assigneeUserId !== v.user.id) return DENIED;
  const r = await toggleTicketTask({ tenantId: v.tenantId, taskId: task.id, userId: v.user.id, label: who(v) });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicketTask", entityId: task.id, summary: `Task "${task.title}" ${task.doneAt ? "reopened" : "done"}` });
  return result(r, [`/helpdesk/tickets/${task.ticketId}`]);
}

export async function deleteTicketTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const task = await prisma.helpdeskTicketTask.findFirst({ where: { id: str(fd, "taskId"), tenantId: v.tenantId } });
  if (!task || !(await agentTicket(v, task.ticketId))) return DENIED;
  const r = await deleteTicketTask({ tenantId: v.tenantId, taskId: task.id });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskTicketTask", entityId: task.id, summary: `Task "${task.title}" removed` });
  return result(r, [`/helpdesk/tickets/${task.ticketId}`]);
}

export async function mergeTicketAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const target = int(fd, "targetNumber");
  if (!target || Number.isNaN(target)) return no("Enter the number of the case to merge into.");
  const into = await prisma.helpdeskTicket.findFirst({ where: { tenantId: v.tenantId, number: target } });
  if (!into || !(await agentTicket(v, into.id))) return no("You can only merge into a case you work.");
  const r = await mergeTickets({ tenantId: v.tenantId, sourceId: t.id, targetNumber: target, userId: v.user.id, label: who(v) });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: t.id, summary: `Merged #${t.number} into #${target}` });
  return result(r, [...PATHS, `/helpdesk/tickets/${t.id}`]);
}

export async function splitTicketAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const categoryId = optStr(fd, "categoryId");
  if (categoryId && !inHelpdeskScope((await agentScope(v)).scope, categoryId)) return no("That category is outside your helpdesk scope.");
  const r = await splitTicket({ tenantId: v.tenantId, sourceId: t.id, subject: str(fd, "subject"), description: str(fd, "description"), categoryId, userId: v.user.id, label: who(v) });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskTicket", entityId: r.ticketId, summary: `Split a new case out of #${t.number}` });
  return result(r, [...PATHS, `/helpdesk/tickets/${t.id}`]);
}

export async function escalateTicketAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const r = await escalateTicketManually({ tenantId: v.tenantId, ticketId: t.id, userId: v.user.id, label: who(v), reason: str(fd, "reason"), toUserId: optStr(fd, "toUserId") });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: t.id, summary: `Escalated #${t.number}: ${str(fd, "reason")}` });
  return result(r, [...PATHS, `/helpdesk/tickets/${t.id}`]);
}

export async function acknowledgeEscalationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await prisma.helpdeskTicketEscalation.findFirst({ where: { id: str(fd, "escalationId"), tenantId: v.tenantId } });
  if (!e) return no("Escalation not found.");
  if (e.escalatedToUserId !== v.user.id && !(await agentTicket(v, e.ticketId))) return DENIED;
  const r = await acknowledgeEscalation({ tenantId: v.tenantId, escalationId: e.id, userId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicketEscalation", entityId: e.id, summary: "Escalation acknowledged" });
  return result(r, [...PATHS, `/helpdesk/tickets/${e.ticketId}`]);
}

export async function requestCaseApprovalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await agentTicket(v, str(fd, "ticketId"));
  if (!t) return DENIED;
  const amount = money(fd, "amount");
  if (Number.isNaN(amount)) return no("Enter a valid amount.");
  const r = await requestCaseApproval({ tenantId: v.tenantId, ticketId: t.id, userId: v.user.id, label: who(v), summary: str(fd, "summary"), amount });
  if (r.ok) await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: t.id, summary: `Approval requested on #${t.number}: ${str(fd, "summary")}` });
  return result(r, [...PATHS, `/helpdesk/tickets/${t.id}`, "/inbox"]);
}

/** Bulk: tick several articles and archive them (settings holders). */
export async function bulkArchiveKbAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.HELPDESK_SETTINGS)) return DENIED;
  const ids = formList(fd, "ids");
  if (!ids.length) return no("Tick the articles to archive.");
  const n = await prisma.kbArticle.updateMany({ where: { tenantId: v.tenantId, id: { in: ids }, status: { not: "PENDING_APPROVAL" } }, data: { status: "ARCHIVED" } });
  await writeAudit(v, { module: "HELPDESK", action: "UPDATE", entityType: "KbArticle", summary: `Archived ${n.count} knowledge articles` });
  return result({ ok: true, message: `Archived ${n.count} article${n.count === 1 ? "" : "s"}.` }, PATHS);
}
