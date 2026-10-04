import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { OFFER_PLACEHOLDERS } from "./offers-math";
import { applyConditionals, formatLetterNumber, nextSeriesNumber, cdAddMonths, issueDateProblem } from "./cases-docs-math";

/**
 * HR letters: templates with {{placeholders}}, generated per employee with
 * the rendered body frozen, then taken through the template's workflow.
 *
 * A workflow is up to two steps: an optional HR approval (by someone other
 * than whoever generated it), then an optional employee step, either
 * acknowledging or signing. Signing records the typed name, a drawn
 * signature, the time, IP and browser, and the fingerprint of the exact text
 * signed; a letter whose text no longer matches its fingerprint cannot be
 * signed.
 */

export const LETTER_WORKFLOWS = {
  "": "Issue directly",
  ACKNOWLEDGE: "Employee acknowledges",
  SIGN: "Employee signs",
  APPROVE: "HR approves, then issue",
  "APPROVE,ACKNOWLEDGE": "HR approves, then employee acknowledges",
  "APPROVE,SIGN": "HR approves, then employee signs",
} as const;
export type LetterWorkflow = keyof typeof LETTER_WORKFLOWS;

export const LETTER_CATEGORIES = ["OFFER", "APPOINTMENT", "CONFIRMATION", "PROMOTION", "TRANSFER", "SALARY_REVISION", "WARNING", "SHOW_CAUSE", "RELIEVING", "EXPERIENCE", "CUSTOM"] as const;

/** Every placeholder a template can use, with what it resolves to. */
export const LETTER_PLACEHOLDERS: Record<string, string> = {
  employee_name: "Employee's full name",
  candidate_name: "Same as employee_name, for offer letters",
  employee_first_name: "First name",
  employee_number: "Employee number",
  job_title: "Job title",
  department: "Department",
  legal_entity_name: "Legal entity",
  location: "Work location",
  reporting_manager: "Reporting manager's name",
  annual_ctc: "Current annual CTC",
  joining_date: "Date of joining",
  date_of_joining: "Same as joining_date",
  confirmation_date: "Confirmation date",
  last_working_day: "Last working day",
  notice_days: "Notice period in days",
  signatory_name: "Legal entity's signatory",
  signatory_designation: "Signatory's designation",
  today: "Date the letter is generated",
  letter_number: "The letter's reference number (from a numbering series)",
  issue_date: "The date the letter is issued on",
  valid_until: "The date the letter is valid until",
  case_number: "Disciplinary letters: the case reference (ER-1001)",
  case_title: "Disciplinary letters: the case title",
  action_type: "Disciplinary letters: the action (written warning, suspension…)",
  action_summary: "Disciplinary letters: what the action is for",
  effective_date: "Disciplinary letters: when the action takes effect",
  response_due_date: "Show-cause letters: the date a reply is due",
  suspension_from: "Suspension letters: first day of suspension",
  suspension_to: "Suspension letters: last day of suspension",
};

export const LETTER_STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "awaiting approval", PENDING_ACKNOWLEDGEMENT: "awaiting acknowledgement", PENDING_SIGNATURE: "awaiting signature",
  ISSUED: "issued", ACKNOWLEDGED: "acknowledged", SIGNED: "signed", REJECTED: "rejected", VOID: "void",
};
/** Statuses an employee can see; anything still with HR stays hidden. */
export const EMPLOYEE_VISIBLE = ["PENDING_ACKNOWLEDGEMENT", "PENDING_SIGNATURE", "ISSUED", "ACKNOWLEDGED", "SIGNED", "VOID"];

type R = { ok: boolean; message: string };

export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function templatePlaceholders(body: string): string[] {
  // Values ({{key}}) and the keys conditional sections test ({{#if key}}, {{#unless key}}).
  const plain = [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => k !== "else");
  const cond = [...body.matchAll(/\{\{#(?:if|unless)\s+(\w+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set([...plain, ...cond])];
}

function steps(workflow: string | null | undefined): string[] {
  return (workflow ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Status after HR approval (or straight away when no approval is needed). */
function employeeStage(workflow: string | null | undefined): string {
  const s = steps(workflow);
  return s.includes("SIGN") ? "PENDING_SIGNATURE" : s.includes("ACKNOWLEDGE") ? "PENDING_ACKNOWLEDGEMENT" : "ISSUED";
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmtDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "");
const fmtMoney = (v: unknown) => (v === null || v === undefined ? "" : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

export async function letterValues(tenantId: string, employeeId: string, today = new Date()): Promise<Record<string, string> | null> {
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId },
    include: {
      legalEntity: { select: { legalName: true, signatories: { take: 1 } } },
      location: { select: { name: true } },
      department: { select: { name: true } },
      reportingManager: { select: { displayName: true } },
      salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1 },
      exitRecord: { select: { lastWorkingDay: true } },
    },
  });
  if (!e) return null;
  const name = e.displayName ?? `${e.firstName} ${e.lastName}`;
  const ctc = e.salaryRevisions[0]?.annualCtc;
  const sig = e.legalEntity?.signatories[0];
  return {
    employee_name: name, candidate_name: name, employee_first_name: e.firstName, employee_number: e.employeeNumber,
    job_title: e.jobTitleName ?? "", department: e.department?.name ?? "", legal_entity_name: e.legalEntity?.legalName ?? "",
    location: e.location?.name ?? "", reporting_manager: e.reportingManager?.displayName ?? "", annual_ctc: fmtMoney(ctc),
    joining_date: fmtDate(e.dateOfJoining), date_of_joining: fmtDate(e.dateOfJoining), confirmation_date: fmtDate(e.confirmationDate),
    last_working_day: fmtDate(e.lastWorkingDay ?? e.exitRecord?.lastWorkingDay), notice_days: String(Number(ctc ?? 0) > 3_000_000 ? 90 : 60),
    signatory_name: sig?.name ?? "", signatory_designation: sig?.designation ?? "", today: fmtDate(today),
  };
}

/**
 * Substitutes values (HTML-escaped, so a name cannot inject markup) and
 * marks anything unresolved visibly rather than leaving a silent gap.
 */
export function renderLetter(body: string, values: Record<string, string>): { html: string; missing: string[] } {
  const missing: string[] = [];
  const html = applyConditionals(body, values).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined || v === "") { missing.push(key); return `[${key.toUpperCase()} NOT AVAILABLE]`; }
    return escapeHtml(v);
  });
  return { html, missing: [...new Set(missing)] };
}

export async function saveLetterTemplate(input: {
  tenantId: string; id?: string | null; name: string; category: string; body: string; workflow: string; archived?: boolean;
  /** 33-cases-docs: who edited, the owner, department scope and an archive reason. */
  userId?: string | null; ownerUserId?: string | null; departmentIds?: string[] | null; archivedReason?: string | null;
}): Promise<R & { id?: string; unknown?: string[] }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Name the template." };
  if (!input.body.trim()) return { ok: false, message: "Write the letter body." };
  if (!(input.workflow in LETTER_WORKFLOWS)) return { ok: false, message: "Pick a workflow." };
  if (!(LETTER_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, message: "Pick a category." };
  if (/<\s*(script|iframe|object|embed)\b|\son\w+\s*=|javascript:/i.test(input.body)) return { ok: false, message: "Letters cannot contain scripts, embedded frames or event handlers." };
  const opens = (input.body.match(/\{\{#(?:if|unless)\s/g) ?? []).length, closes = (input.body.match(/\{\{\/(?:if|unless)\}\}/g) ?? []).length;
  if (opens !== closes) return { ok: false, message: "Every {{#if …}} section needs a matching {{/if}}." };
  const placeholders = templatePlaceholders(input.body);
  // Offer letters are filled from the candidate and offer, which adds a few placeholders.
  const unknown = placeholders.filter((p) => !(p in LETTER_PLACEHOLDERS) && !(input.category === "OFFER" && p in OFFER_PLACEHOLDERS));
  if (unknown.length) return { ok: false, unknown, message: `Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown.map((u) => `{{${u}}}`).join(", ")}.` };
  const clash = await prisma.documentTemplate.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
  if (clash) return { ok: false, message: "Another template already has that name." };
  if (input.ownerUserId && !(await prisma.user.count({ where: { id: input.ownerUserId, tenantId: input.tenantId } }))) return { ok: false, message: "Template owner not found." };
  const departmentIds = (input.departmentIds ?? []).filter(Boolean);
  if (departmentIds.length && (await prisma.department.count({ where: { id: { in: departmentIds }, tenantId: input.tenantId } })) !== departmentIds.length) return { ok: false, message: "Department not found." };
  const settings = await prisma.letterSettings.findUnique({ where: { tenantId: input.tenantId } });
  const needsApproval = !!settings?.requireTemplateApproval;
  const archived = !!input.archived;
  const data = {
    name, category: input.category, body: input.body, placeholders, workflow: input.workflow || null, isArchived: archived,
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId || null } : {}),
    ...(input.departmentIds !== undefined ? { departmentIds: departmentIds.length ? departmentIds : undefined } : {}),
  };
  if (input.id) {
    const found = await prisma.documentTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!found) return { ok: false, message: "Template not found." };
    if (found.approvalStatus === "PENDING_APPROVAL") return { ok: false, message: "This template is awaiting approval. Wait for the decision before editing it." };
    const changed = found.body !== input.body || found.name !== name || found.category !== input.category || (found.workflow ?? "") !== input.workflow;
    const version = changed ? found.version + 1 : found.version;
    await prisma.documentTemplate.update({
      where: { id: found.id },
      data: {
        ...data, version, ...(input.departmentIds !== undefined && !departmentIds.length ? { departmentIds: [] } : {}),
        ...(changed && needsApproval ? { approvalStatus: "DRAFT", approvedAt: null, approvedByUserId: null } : {}),
        ...(archived && !found.isArchived ? { archivedAt: new Date(), archivedReason: input.archivedReason?.trim() || null } : !archived ? { archivedAt: null, archivedReason: null } : {}),
      },
    });
    if (changed) await prisma.documentTemplateRevision.create({ data: { tenantId: input.tenantId, templateId: found.id, version, name, category: input.category, body: input.body, workflow: input.workflow || null, editedByUserId: input.userId ?? null } });
    return { ok: true, id: found.id, message: `Saved "${name}"${changed ? ` as version ${version}` : ""}.${changed && needsApproval ? " Submit it for approval before it is used again." : ""} Letters already generated keep their original text.` };
  }
  const row = await prisma.documentTemplate.create({
    data: {
      tenantId: input.tenantId, ...data, ownerUserId: input.ownerUserId || input.userId || null, approvalStatus: needsApproval ? "DRAFT" : "APPROVED",
      nextReviewOn: cdAddMonths(new Date(), settings?.reviewEveryMonths ?? 12), ...(archived ? { archivedAt: new Date(), archivedReason: input.archivedReason?.trim() || null } : {}),
    },
  });
  await prisma.documentTemplateRevision.create({ data: { tenantId: input.tenantId, templateId: row.id, version: 1, name, category: input.category, body: input.body, workflow: input.workflow || null, editedByUserId: input.userId ?? null } });
  return { ok: true, id: row.id, message: `Created "${name}".${needsApproval ? " Submit it for approval before generating letters from it." : ""}` };
}

/** Assign the next number from the tenant's series for this category, inside the caller's transaction. */
export async function allocateLetterNumber(tx: Prisma.TransactionClient, tenantId: string, category: string, at: Date): Promise<string | null> {
  const series = (await tx.letterNumberSeries.findFirst({ where: { tenantId, category, isActive: true } })) ?? (await tx.letterNumberSeries.findFirst({ where: { tenantId, category: null, isActive: true } }));
  if (!series) return null;
  await tx.$executeRaw`SELECT id FROM letter_number_series WHERE id = ${series.id} FOR UPDATE`;
  const fresh = await tx.letterNumberSeries.findUniqueOrThrow({ where: { id: series.id } });
  const n = nextSeriesNumber(fresh, at);
  await tx.letterNumberSeries.update({ where: { id: series.id }, data: { nextNumber: n.next, lastYear: n.year } });
  return formatLetterNumber(fresh.prefix, fresh.digits, n.use, at, category);
}

export async function generateLetter(input: {
  tenantId: string; templateId: string; employeeId: string; issuedByEmployeeId: string | null; issuedByUserId: string; approverUserIds?: string[];
  /** 33-cases-docs: extra placeholder values (disciplinary letters), dating, a batch or trigger it belongs to. */
  extraValues?: Record<string, string>; issuedOn?: Date | null; validUntil?: Date | null; batchId?: string | null; triggerEvent?: string | null;
}): Promise<R & { id?: string; missing?: string[]; letterNumber?: string | null }> {
  const template = await prisma.documentTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId, isArchived: false } });
  if (!template) return { ok: false, message: "Template not found." };
  if (template.approvalStatus !== "APPROVED") return { ok: false, message: `"${template.name}" has not been approved for use yet.` };
  const scope = Array.isArray(template.departmentIds) ? (template.departmentIds as string[]) : [];
  if (scope.length) {
    const e = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { departmentId: true } });
    if (!e || !e.departmentId || !scope.includes(e.departmentId)) return { ok: false, message: `"${template.name}" is limited to other departments.` };
  }
  const values = await letterValues(input.tenantId, input.employeeId, input.issuedOn ?? new Date());
  if (!values) return { ok: false, message: "Employee not found." };
  const issuedOn = input.issuedOn ?? new Date();
  if (input.issuedOn) {
    // Backdating is limited by the tenant's letter settings (Documents › Letters admin › Settings).
    const maxBackdateDays = (await prisma.letterSettings.findUnique({ where: { tenantId: input.tenantId }, select: { maxBackdateDays: true } }))?.maxBackdateDays ?? 30;
    const problem = issueDateProblem(input.issuedOn, new Date(), maxBackdateDays);
    if (problem) return { ok: false, message: problem };
  }
  if (input.validUntil && input.validUntil < issuedOn) return { ok: false, message: "A letter cannot expire before it is issued." };
  const needsApproval = steps(template.workflow).includes("APPROVE");
  const status = needsApproval ? "PENDING_APPROVAL" : employeeStage(template.workflow);
  const created = await prisma.$transaction(async (tx) => {
    const letterNumber = await allocateLetterNumber(tx, input.tenantId, template.category, issuedOn);
    const all = { ...values, ...(input.extraValues ?? {}), letter_number: letterNumber ?? "", issue_date: fmtDate(issuedOn), valid_until: fmtDate(input.validUntil ?? null) };
    const r = renderLetter(template.body, all);
    const row = await tx.generatedDocument.create({
      data: {
        templateId: template.id, employeeId: input.employeeId, renderedBody: r.html, contentHash: hashBody(r.html), workflow: template.workflow,
        status, issuedBy: input.issuedByEmployeeId, issuedByUserId: input.issuedByUserId, issuedOn, validUntil: input.validUntil ?? null,
        letterNumber, batchId: input.batchId ?? null, triggerEvent: input.triggerEvent ?? null, lastSentAt: new Date(),
      },
    });
    return { row, missing: r.missing };
  });
  const row = created.row, missing = created.missing;
  const who = values.employee_name;
  if (needsApproval) {
    await notify({ tenantId: input.tenantId, userIds: (input.approverUserIds ?? []).filter((u) => u !== input.issuedByUserId), kind: "LETTER_APPROVAL", title: `Approve ${template.name} for ${who}`, link: `/documents/letters/${row.id}` });
  } else await notifyEmployee(input.tenantId, row.id, template.name, status);
  const gap = missing.length ? ` ${missing.length} placeholder${missing.length === 1 ? " is" : "s are"} not available and marked in the letter.` : "";
  return { ok: true, id: row.id, missing, letterNumber: row.letterNumber, message: `Generated ${template.name}${row.letterNumber ? ` (${row.letterNumber})` : ""} for ${who}; ${LETTER_STATUS_LABEL[status]}.${gap}` };
}

async function notifyEmployee(tenantId: string, letterId: string, templateName: string, status: string) {
  if (status !== "PENDING_SIGNATURE" && status !== "PENDING_ACKNOWLEDGEMENT" && status !== "ISSUED") return;
  const doc = await prisma.generatedDocument.findUnique({ where: { id: letterId }, select: { employee: { select: { userId: true } } } });
  const verb = status === "PENDING_SIGNATURE" ? "sign" : status === "PENDING_ACKNOWLEDGEMENT" ? "acknowledge" : "read";
  await notify({ tenantId, userIds: [doc?.employee.userId ?? null].filter((u): u is string => !!u), kind: "LETTER", title: `Please ${verb} your ${templateName}`, link: `/documents/letters/${letterId}` });
}

async function load(tenantId: string, id: string) {
  return prisma.generatedDocument.findFirst({
    where: { id, employee: { tenantId } },
    include: { template: { select: { name: true } }, employee: { select: { id: true, userId: true, displayName: true, firstName: true, lastName: true } } },
  });
}

export async function decideLetter(input: { tenantId: string; id: string; userId: string; approve: boolean; note: string | null }): Promise<R> {
  const doc = await load(input.tenantId, input.id);
  if (!doc) return { ok: false, message: "Letter not found." };
  if (doc.status !== "PENDING_APPROVAL") return { ok: false, message: "This letter is not awaiting approval." };
  if (doc.issuedByUserId === input.userId) return { ok: false, message: "Someone other than whoever generated the letter must approve it." };
  if (!input.approve && !input.note?.trim()) return { ok: false, message: "Say why it is rejected." };
  const status = input.approve ? employeeStage(doc.workflow) : "REJECTED";
  await prisma.generatedDocument.update({ where: { id: doc.id }, data: { status, approvedBy: input.userId, approvedAt: new Date(), decisionNote: input.note?.trim() || null } });
  if (input.approve) await notifyEmployee(input.tenantId, doc.id, doc.template.name, status);
  return { ok: true, message: input.approve ? `Approved ${doc.template.name} for ${doc.employee.displayName}; ${LETTER_STATUS_LABEL[status]}.` : `Rejected ${doc.template.name} for ${doc.employee.displayName}.` };
}

export async function acknowledgeLetter(input: { tenantId: string; id: string; employeeId: string }): Promise<R> {
  const doc = await load(input.tenantId, input.id);
  if (!doc || doc.employeeId !== input.employeeId) return { ok: false, message: "Letter not found." };
  if (doc.status !== "PENDING_ACKNOWLEDGEMENT") return { ok: false, message: "This letter does not need acknowledging." };
  await prisma.generatedDocument.update({ where: { id: doc.id }, data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() } });
  return { ok: true, message: `Acknowledged your ${doc.template.name}.` };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Records the employee's signature. The drawn signature is stored first by the caller. */
export async function signLetter(input: {
  tenantId: string; id: string; employeeId: string; typedName: string; signatureFileId: string; ip: string | null; userAgent: string | null; consent: boolean;
}): Promise<R> {
  const doc = await load(input.tenantId, input.id);
  if (!doc || doc.employeeId !== input.employeeId) return { ok: false, message: "Letter not found." };
  if (doc.status !== "PENDING_SIGNATURE") return { ok: false, message: "This letter is not awaiting your signature." };
  if (!input.consent) return { ok: false, message: "Confirm that you agree to sign electronically." };
  const names = [doc.employee.displayName, `${doc.employee.firstName} ${doc.employee.lastName}`].filter((n): n is string => !!n).map(norm);
  if (!names.includes(norm(input.typedName))) return { ok: false, message: "Type your full name exactly as it appears on the letter." };
  if (doc.contentHash && doc.contentHash !== hashBody(doc.renderedBody)) return { ok: false, message: "This letter's text has changed since it was issued. Ask HR to issue it again." };
  await prisma.generatedDocument.update({
    where: { id: doc.id },
    data: { status: "SIGNED", signedAt: new Date(), signerName: input.typedName.trim(), signatureFileId: input.signatureFileId, signedIp: input.ip, signedUserAgent: input.userAgent?.slice(0, 300) ?? null },
  });
  return { ok: true, message: `Signed your ${doc.template.name}.` };
}

export async function voidLetter(input: { tenantId: string; id: string; reason: string }): Promise<R> {
  const doc = await load(input.tenantId, input.id);
  if (!doc) return { ok: false, message: "Letter not found." };
  if (doc.status === "VOID" || doc.status === "REJECTED") return { ok: false, message: "This letter is already closed." };
  if (!input.reason.trim()) return { ok: false, message: "Say why the letter is withdrawn." };
  await prisma.generatedDocument.update({ where: { id: doc.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: input.reason.trim() } });
  return { ok: true, message: `Withdrew ${doc.template.name} for ${doc.employee.displayName}.` };
}
