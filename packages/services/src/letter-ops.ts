import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { generateLetter, LETTER_STATUS_LABEL, EMPLOYEE_VISIBLE } from "./letters";
import { cdAddMonths, formatLetterNumber } from "./cases-docs-math";

/**
 * HR letter operations: numbering series, bulk generation, letters generated
 * automatically when an employee exits, has a salary revision applied or is
 * confirmed, resending, template approval (through the workflow engine),
 * template owners and periodic review, letter search and template usage.
 */

type R = { ok: boolean; message: string };
const TEMPLATE_MANAGE = "document.template.manage";

export const LETTER_TRIGGER_EVENTS = {
  EXIT_COMPLETED: "Employee exit completed (relieving / experience letter)",
  SALARY_REVISION_APPLIED: "Salary revision applied (salary letter)",
  CONFIRMED: "Probation confirmed (confirmation letter)",
} as const;
export type LetterTriggerEvent = keyof typeof LETTER_TRIGGER_EVENTS;

// ---------------------------------------------------------------------------
//  Settings and numbering series
// ---------------------------------------------------------------------------

export async function getLetterSettings(tenantId: string) {
  return (await prisma.letterSettings.findUnique({ where: { tenantId } })) ?? { tenantId, requireTemplateApproval: false, reviewEveryMonths: 12, maxBackdateDays: 30 };
}

export async function saveLetterSettings(input: { tenantId: string; requireTemplateApproval: boolean; reviewEveryMonths: number; maxBackdateDays: number }): Promise<R> {
  if (!Number.isInteger(input.reviewEveryMonths) || input.reviewEveryMonths < 1 || input.reviewEveryMonths > 60) return { ok: false, message: "Review every 1 to 60 months." };
  if (!Number.isInteger(input.maxBackdateDays) || input.maxBackdateDays < 0 || input.maxBackdateDays > 365) return { ok: false, message: "Backdating is limited to 0–365 days." };
  const data = { requireTemplateApproval: input.requireTemplateApproval, reviewEveryMonths: input.reviewEveryMonths, maxBackdateDays: input.maxBackdateDays };
  await prisma.letterSettings.upsert({ where: { tenantId: input.tenantId }, create: { tenantId: input.tenantId, ...data }, update: data });
  return { ok: true, message: "Letter settings saved." };
}

export async function saveLetterSeries(input: { tenantId: string; id?: string | null; name: string; category?: string | null; prefix: string; digits: number; nextNumber: number; yearlyReset: boolean; isActive: boolean }): Promise<R & { id?: string; preview?: string }> {
  const name = input.name.trim(), prefix = input.prefix.trim();
  if (!name) return { ok: false, message: "Name the series." };
  if (!prefix || prefix.length > 40 || /[<>"]/.test(prefix)) return { ok: false, message: "Give a prefix of up to 40 characters." };
  if (!Number.isInteger(input.digits) || input.digits < 1 || input.digits > 10) return { ok: false, message: "Use 1 to 10 digits." };
  if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) return { ok: false, message: "The next number must be 1 or more." };
  const category = input.category || null;
  const clash = await prisma.letterNumberSeries.findFirst({ where: { tenantId: input.tenantId, OR: [{ name }, ...(input.isActive ? [{ category, isActive: true }] : [])], ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: clash.name === name ? "Another series has that name." : `"${clash.name}" already numbers ${category ? category.toLowerCase().replace(/_/g, " ") : "every other"} letters.` };
  const data = { name, category, prefix, digits: input.digits, nextNumber: input.nextNumber, yearlyReset: input.yearlyReset, isActive: input.isActive };
  const preview = formatLetterNumber(prefix, input.digits, input.nextNumber, new Date(), category);
  if (input.id) {
    const row = await prisma.letterNumberSeries.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Series not found." };
    await prisma.letterNumberSeries.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, preview, message: `Saved; the next letter will be ${preview}.` };
  }
  const row = await prisma.letterNumberSeries.create({ data: { tenantId: input.tenantId, ...data, lastYear: new Date().getUTCFullYear() } });
  return { ok: true, id: row.id, preview, message: `Series added; the next letter will be ${preview}.` };
}

// ---------------------------------------------------------------------------
//  Bulk generation, triggers, resend
// ---------------------------------------------------------------------------

export async function generateLettersInBulk(input: {
  tenantId: string; templateId: string; employeeIds: string[]; issuedByEmployeeId: string | null; issuedByUserId: string; issuedOn?: Date | null; validUntil?: Date | null;
}): Promise<R & { batchId?: string; generated?: number; failed?: number }> {
  const ids = [...new Set(input.employeeIds)];
  if (!ids.length) return { ok: false, message: "Pick at least one employee." };
  if (ids.length > 500) return { ok: false, message: "Generate up to 500 letters at a time." };
  const template = await prisma.documentTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId, isArchived: false } });
  if (!template) return { ok: false, message: "Template not found." };
  if (template.approvalStatus !== "APPROVED") return { ok: false, message: `"${template.name}" has not been approved for use yet.` };
  const batch = await prisma.letterBatch.create({ data: { tenantId: input.tenantId, templateId: template.id, total: ids.length, createdByUserId: input.issuedByUserId } });
  const approvers = await usersWithPermission(input.tenantId, TEMPLATE_MANAGE);
  const results: Array<{ employeeId: string; ok: boolean; letterId?: string; message: string }> = [];
  for (const employeeId of ids) {
    const r = await generateLetter({ tenantId: input.tenantId, templateId: template.id, employeeId, issuedByEmployeeId: input.issuedByEmployeeId, issuedByUserId: input.issuedByUserId, approverUserIds: approvers, batchId: batch.id, issuedOn: input.issuedOn, validUntil: input.validUntil });
    results.push({ employeeId, ok: r.ok, letterId: r.id, message: r.message });
  }
  const generated = results.filter((r) => r.ok).length;
  await prisma.letterBatch.update({ where: { id: batch.id }, data: { generated, failed: ids.length - generated, results: results as unknown as Prisma.InputJsonValue } });
  return { ok: generated > 0, batchId: batch.id, generated, failed: ids.length - generated, message: `Generated ${generated} of ${ids.length} ${template.name} letter${ids.length === 1 ? "" : "s"}.` };
}

export async function saveLetterTrigger(input: { tenantId: string; event: string; templateId: string; isActive: boolean }): Promise<R> {
  if (!(input.event in LETTER_TRIGGER_EVENTS)) return { ok: false, message: "Pick an event." };
  const t = await prisma.documentTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  await prisma.letterTrigger.upsert({
    where: { tenantId_event_templateId: { tenantId: input.tenantId, event: input.event, templateId: t.id } },
    create: { tenantId: input.tenantId, event: input.event, templateId: t.id, isActive: input.isActive }, update: { isActive: input.isActive },
  });
  return { ok: true, message: `${t.name} will ${input.isActive ? "now" : "no longer"} be generated automatically.` };
}

/**
 * Generate the letters configured for an event. Called from the exit,
 * salary-revision and confirmation flows; failures never block those flows.
 * A letter is generated once per (employee, template, event).
 */
export async function fireLetterTriggers(tenantId: string, event: LetterTriggerEvent, employeeId: string, actorUserId: string | null): Promise<{ generated: number; failed: string[] }> {
  const triggers = await prisma.letterTrigger.findMany({ where: { tenantId, event, isActive: true } });
  const names = new Map((await prisma.documentTemplate.findMany({ where: { tenantId, id: { in: triggers.map((t) => t.templateId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  let generated = 0;
  const failed: string[] = [];
  for (const t of triggers) {
    const dup = await prisma.generatedDocument.findFirst({ where: { templateId: t.templateId, employeeId, triggerEvent: event, status: { notIn: ["VOID", "REJECTED"] } } });
    if (dup) continue;
    const approvers = await usersWithPermission(tenantId, TEMPLATE_MANAGE);
    const issuer = actorUserId ?? approvers[0] ?? null;
    if (!issuer) { failed.push(`${names.get(t.templateId) ?? "Letter"}: nobody can issue letters`); continue; }
    const r = await generateLetter({ tenantId, templateId: t.templateId, employeeId, issuedByEmployeeId: null, issuedByUserId: issuer, approverUserIds: approvers, triggerEvent: event });
    if (r.ok) generated++; else failed.push(`${names.get(t.templateId) ?? "Letter"}: ${r.message}`);
  }
  if (failed.length) await notify({ tenantId, userIds: await usersWithPermission(tenantId, TEMPLATE_MANAGE), kind: "LETTER", title: `Automatic letters could not be generated (${LETTER_TRIGGER_EVENTS[event]})`, body: failed.join("; "), link: "/documents/letters-admin" });
  return { generated, failed };
}

/** Send the letter again (in-app and email) and count it. */
export async function resendLetter(input: { tenantId: string; id: string }): Promise<R> {
  const doc = await prisma.generatedDocument.findFirst({ where: { id: input.id, employee: { tenantId: input.tenantId } }, include: { template: { select: { name: true } }, employee: { select: { userId: true, displayName: true } } } });
  if (!doc) return { ok: false, message: "Letter not found." };
  if (!EMPLOYEE_VISIBLE.includes(doc.status) || doc.status === "VOID") return { ok: false, message: `A letter ${LETTER_STATUS_LABEL[doc.status] ?? doc.status.toLowerCase()} cannot be resent.` };
  if (!doc.employee.userId) return { ok: false, message: "The employee has no login to send it to." };
  await prisma.generatedDocument.update({ where: { id: doc.id }, data: { sentCount: { increment: 1 }, lastSentAt: new Date() } });
  await notify({ tenantId: input.tenantId, userIds: [doc.employee.userId], kind: "LETTER", title: `Your ${doc.template.name}${doc.letterNumber ? ` (${doc.letterNumber})` : ""}`, body: doc.status.startsWith("PENDING") ? "It is waiting for you." : "Sent again at your HR team's request.", link: `/documents/letters/${doc.id}`, email: true });
  return { ok: true, message: `Resent ${doc.template.name} to ${doc.employee.displayName}.` };
}

// ---------------------------------------------------------------------------
//  Template approval, owners and review
// ---------------------------------------------------------------------------

export async function submitTemplateForApproval(input: { tenantId: string; id: string; userId: string; employeeId: string | null }): Promise<R & { requestId?: string }> {
  const t = await prisma.documentTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  if (t.approvalStatus === "APPROVED") return { ok: false, message: "This version is already approved." };
  if (t.approvalStatus === "PENDING_APPROVAL") return { ok: false, message: "It is already awaiting approval." };
  const { startWorkflow } = await import("./workflow-engine");
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { approvalStatus: "PENDING_APPROVAL" } });
  const res = await startWorkflow({
    tenantId: input.tenantId, entityType: "LETTER_TEMPLATE", entityId: t.id, title: `Approve letter template: ${t.name} v${t.version}`, details: `${t.category.toLowerCase().replace(/_/g, " ")} template`,
    requesterUserId: input.userId, subjectEmployeeId: input.employeeId, data: { link: `/documents/templates/${t.id}`, version: t.version },
  });
  if (!res.ok) { await prisma.documentTemplate.update({ where: { id: t.id }, data: { approvalStatus: t.approvalStatus } }); return res; }
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { workflowRequestId: res.requestId } });
  return { ok: true, requestId: res.requestId, message: res.message };
}

export async function applyTemplateDecision(tenantId: string, id: string, outcome: string, actorUserId: string | null): Promise<void> {
  const t = await prisma.documentTemplate.findFirst({ where: { id, tenantId } });
  if (!t || t.approvalStatus !== "PENDING_APPROVAL") return;
  if (outcome === "APPROVED") {
    const s = await getLetterSettings(tenantId);
    await prisma.documentTemplate.update({ where: { id }, data: { approvalStatus: "APPROVED", approvedByUserId: actorUserId, approvedAt: new Date(), nextReviewOn: cdAddMonths(new Date(), s.reviewEveryMonths), reviewRemindedAt: null } });
  } else await prisma.documentTemplate.update({ where: { id }, data: { approvalStatus: outcome === "REJECTED" ? "REJECTED" : "DRAFT" } });
  await notify({ tenantId, userIds: [t.ownerUserId], kind: "LETTER", title: `Template "${t.name}" ${outcome === "APPROVED" ? "approved" : outcome.toLowerCase()}`, link: `/documents/templates/${t.id}` });
}

export async function markTemplateReviewed(input: { tenantId: string; id: string; userId: string; canManage: boolean }): Promise<R> {
  const t = await prisma.documentTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  if (t.ownerUserId && t.ownerUserId !== input.userId && !input.canManage) return { ok: false, message: "Only the template's owner can review it." };
  const s = await getLetterSettings(input.tenantId);
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { lastReviewedAt: new Date(), nextReviewOn: cdAddMonths(new Date(), s.reviewEveryMonths), reviewRemindedAt: null } });
  return { ok: true, message: `Reviewed; next review due in ${s.reviewEveryMonths} months.` };
}

/** Owners of templates (and knowledge articles) whose review date has come are reminded once. */
export async function runTemplateReviewReminders(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.documentTemplate.findMany({ where: { tenantId, isArchived: false, nextReviewOn: { lte: now }, reviewRemindedAt: null } });
  for (const t of due) {
    const to = t.ownerUserId ? [t.ownerUserId] : await usersWithPermission(tenantId, TEMPLATE_MANAGE);
    await notify({ tenantId, userIds: to, kind: "LETTER", title: `Review due: letter template "${t.name}"`, body: "Check the wording is still current, then mark it reviewed.", link: `/documents/templates/${t.id}`, email: true });
    await prisma.documentTemplate.update({ where: { id: t.id }, data: { reviewRemindedAt: now } });
  }
  const kb = await prisma.kbArticle.findMany({ where: { tenantId, status: "PUBLISHED", reviewDueOn: { lte: now }, reviewRemindedAt: null } });
  for (const a of kb) {
    await notify({ tenantId, userIds: [a.ownerUserId ?? a.authorUserId], kind: "HELPDESK", title: `Review due: article "${a.title}"`, link: `/helpdesk/knowledge/${a.id}` });
    await prisma.kbArticle.update({ where: { id: a.id }, data: { reviewRemindedAt: now } });
  }
  return due.length + kb.length;
}

// ---------------------------------------------------------------------------
//  Search, usage
// ---------------------------------------------------------------------------

export interface LetterSearch { q?: string; category?: string; status?: string; templateId?: string; from?: Date | null; to?: Date | null }

export function letterSearchWhere(tenantId: string, scope: Prisma.EmployeeWhereInput | null, f: LetterSearch): Prisma.GeneratedDocumentWhereInput {
  const q = f.q?.trim();
  return {
    employee: { tenantId, ...(scope ?? {}) },
    ...(f.category ? { template: { category: f.category } } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.templateId ? { templateId: f.templateId } : {}),
    ...(f.from || f.to ? { issuedOn: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(q ? {
      OR: [
        { letterNumber: { contains: q, mode: "insensitive" } },
        { template: { name: { contains: q, mode: "insensitive" } } },
        { employee: { displayName: { contains: q, mode: "insensitive" } } },
        { employee: { employeeNumber: { contains: q, mode: "insensitive" } } },
      ],
    } : {}),
  };
}

export async function templateUsage(tenantId: string, since: Date) {
  const rows = await prisma.generatedDocument.groupBy({ by: ["templateId", "status"], where: { employee: { tenantId }, issuedOn: { gte: since } }, _count: true });
  const templates = await prisma.documentTemplate.findMany({ where: { tenantId }, select: { id: true, name: true, category: true, version: true, approvalStatus: true, ownerUserId: true, isArchived: true, nextReviewOn: true } });
  return templates.map((t) => {
    const mine = rows.filter((r) => r.templateId === t.id);
    const by = (st: string[]) => mine.filter((r) => st.includes(r.status)).reduce((a, r) => a + r._count, 0);
    return { ...t, total: mine.reduce((a, r) => a + r._count, 0), signed: by(["SIGNED", "ACKNOWLEDGED"]), pending: by(["PENDING_APPROVAL", "PENDING_SIGNATURE", "PENDING_ACKNOWLEDGEMENT"]), voided: by(["VOID", "REJECTED"]) };
  }).sort((a, b) => b.total - a.total);
}
