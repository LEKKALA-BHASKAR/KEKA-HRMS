import { createHash } from "node:crypto";
import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { OFFER_PLACEHOLDERS } from "./offers-math";

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

export const LETTER_CATEGORIES = ["OFFER", "APPOINTMENT", "CONFIRMATION", "PROMOTION", "TRANSFER", "SALARY_REVISION", "WARNING", "RELIEVING", "EXPERIENCE", "CUSTOM"] as const;

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
  return [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))];
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
  const html = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined || v === "") { missing.push(key); return `[${key.toUpperCase()} NOT AVAILABLE]`; }
    return escapeHtml(v);
  });
  return { html, missing: [...new Set(missing)] };
}

export async function saveLetterTemplate(input: {
  tenantId: string; id?: string | null; name: string; category: string; body: string; workflow: string; archived?: boolean;
}): Promise<R & { id?: string; unknown?: string[] }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Name the template." };
  if (!input.body.trim()) return { ok: false, message: "Write the letter body." };
  if (!(input.workflow in LETTER_WORKFLOWS)) return { ok: false, message: "Pick a workflow." };
  if (!(LETTER_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, message: "Pick a category." };
  if (/<\s*(script|iframe|object|embed)\b|\son\w+\s*=|javascript:/i.test(input.body)) return { ok: false, message: "Letters cannot contain scripts, embedded frames or event handlers." };
  const placeholders = templatePlaceholders(input.body);
  // Offer letters are filled from the candidate and offer, which adds a few placeholders.
  const unknown = placeholders.filter((p) => !(p in LETTER_PLACEHOLDERS) && !(input.category === "OFFER" && p in OFFER_PLACEHOLDERS));
  if (unknown.length) return { ok: false, unknown, message: `Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown.map((u) => `{{${u}}}`).join(", ")}.` };
  const clash = await prisma.documentTemplate.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
  if (clash) return { ok: false, message: "Another template already has that name." };
  const data = { name, category: input.category, body: input.body, placeholders, workflow: input.workflow || null, isArchived: !!input.archived };
  if (input.id) {
    const found = await prisma.documentTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId }, select: { id: true } });
    if (!found) return { ok: false, message: "Template not found." };
    await prisma.documentTemplate.update({ where: { id: found.id }, data });
    return { ok: true, id: found.id, message: `Saved "${name}". Letters already generated keep their original text.` };
  }
  const row = await prisma.documentTemplate.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: `Created "${name}".` };
}

export async function generateLetter(input: {
  tenantId: string; templateId: string; employeeId: string; issuedByEmployeeId: string | null; issuedByUserId: string; approverUserIds?: string[];
}): Promise<R & { id?: string; missing?: string[] }> {
  const template = await prisma.documentTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId, isArchived: false } });
  if (!template) return { ok: false, message: "Template not found." };
  const values = await letterValues(input.tenantId, input.employeeId);
  if (!values) return { ok: false, message: "Employee not found." };
  const { html, missing } = renderLetter(template.body, values);
  const needsApproval = steps(template.workflow).includes("APPROVE");
  const status = needsApproval ? "PENDING_APPROVAL" : employeeStage(template.workflow);
  const row = await prisma.generatedDocument.create({
    data: {
      templateId: template.id, employeeId: input.employeeId, renderedBody: html, contentHash: hashBody(html), workflow: template.workflow,
      status, issuedBy: input.issuedByEmployeeId, issuedByUserId: input.issuedByUserId,
    },
  });
  const who = values.employee_name;
  if (needsApproval) {
    await notify({ tenantId: input.tenantId, userIds: (input.approverUserIds ?? []).filter((u) => u !== input.issuedByUserId), kind: "LETTER_APPROVAL", title: `Approve ${template.name} for ${who}`, link: `/documents/letters/${row.id}` });
  } else await notifyEmployee(input.tenantId, row.id, template.name, status);
  const gap = missing.length ? ` ${missing.length} placeholder${missing.length === 1 ? " is" : "s are"} not available and marked in the letter.` : "";
  return { ok: true, id: row.id, missing, message: `Generated ${template.name} for ${who}; ${LETTER_STATUS_LABEL[status]}.${gap}` };
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
