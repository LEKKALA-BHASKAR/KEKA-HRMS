"use server";

import { randomBytes } from "node:crypto";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  raiseChangeRequest, generateLetter, idCardNumber, idCardValidity, delegationIssues, correctionIssue, CORRECTABLE_FIELDS, notify,
  type ChangeTarget,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { isHrFor, isManagerOf, employeeTarget, SELF_SERVICE_TARGETS } from "@/lib/core-hr";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zOptionalId, zId, zDate, zRequiredDate, zBool, zNumber, zEmail, zIfsc,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Employee and manager self-service: asking for a change to one's own
 * details (decided by HR or one's manager), data corrections, letters on
 * request, the digital ID card, internal notes on a profile, and handing a
 * manager's approvals to someone else for a while.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const PHONE = /^\+?[0-9 -]{7,20}$/;
const RELATIONSHIPS = ["SPOUSE", "CHILD", "FATHER", "MOTHER", "SIBLING", "PARTNER", "GUARDIAN", "OTHER"] as const;

const personal = z.object({
  firstName: zName(60), middleName: zOptional(60), lastName: zName(60), displayName: zOptional(120), dateOfBirth: zDate(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).optional(),
  maritalStatus: z.enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNDISCLOSED"]).optional(),
  bloodGroup: z.enum(["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG", "UNKNOWN"]).optional(),
  nationality: zOptional(60),
});
const contact = z.object({
  personalEmail: zEmail(),
  mobile: zOptional(20).refine((v) => !v || PHONE.test(v), "Not a phone number"),
  alternatePhone: zOptional(20).refine((v) => !v || PHONE.test(v), "Not a phone number"),
});
const address = z.object({ type: z.enum(["CURRENT", "PERMANENT", "EMERGENCY"]), line1: zName(200), line2: zOptional(200), city: zOptional(80), state: zOptional(80), postalCode: zOptional(12).refine((v) => !v || /^[0-9A-Za-z -]{3,12}$/.test(v), "Not a postal code") });
const bank = z.object({
  bankName: zName(120), accountNumber: z.string().regex(/^\d{6,20}$/, "Account numbers are 6 to 20 digits"), confirmAccountNumber: z.string(),
  ifsc: zIfsc(), branch: zOptional(120), accountHolder: zOptional(120),
}).refine((v) => v.accountNumber === v.confirmAccountNumber, { message: "The account numbers do not match", path: ["confirmAccountNumber"] })
  .refine((v) => !!v.ifsc, { message: "IFSC is required", path: ["ifsc"] });
const dependent = z.object({ name: zName(120), relationship: z.enum(RELATIONSHIPS), dateOfBirth: zDate(), isNominee: zBool() });
const emergency = z.object({ name: zName(120), relationship: zName(40), phone: z.string().regex(PHONE, "Not a phone number"), email: zEmail(), isPrimary: zBool() });
const education = z.object({ institution: zName(160), degree: zOptional(120), specialization: zOptional(120), fromYear: zNumber({ min: 1950, max: 2100 }), toYear: zNumber({ min: 1950, max: 2100 }), grade: zOptional(30) })
  .refine((v) => v.fromYear === null || v.toYear === null || v.toYear >= v.fromYear, { message: "Ends before it starts", path: ["toYear"] });
const experience = z.object({ companyName: zName(160), jobTitle: zOptional(120), fromDate: zDate(), toDate: zDate(), description: zOptional(400) })
  .refine((v) => !v.fromDate || !v.toDate || v.toDate >= v.fromDate, { message: "Ends before it starts", path: ["toDate"] })
  .refine((v) => !v.toDate || v.toDate <= new Date(), { message: "Cannot end in the future", path: ["toDate"] });

const SCHEMAS = { PERSONAL: personal, CONTACT: contact, ADDRESS: address, BANK: bank, DEPENDENT: dependent, EMERGENCY_CONTACT: emergency, EDUCATION: education, EXPERIENCE: experience } as const;
type ProfileTarget = keyof typeof SCHEMAS;
const SUB_RECORDS: Partial<Record<ProfileTarget, (id: string, employeeId: string) => Promise<Record<string, unknown> | null>>> = {
  DEPENDENT: (id, e) => prisma.dependent.findFirst({ where: { id, employeeId: e } }),
  EMERGENCY_CONTACT: (id, e) => prisma.emergencyContact.findFirst({ where: { id, employeeId: e } }),
  EDUCATION: (id, e) => prisma.employeeEducation.findFirst({ where: { id, employeeId: e } }),
  EXPERIENCE: (id, e) => prisma.employeeExperience.findFirst({ where: { id, employeeId: e } }),
};

/** Dependents must make sense together: one spouse, one of each parent, children younger than the employee. */
async function dependentIssue(employeeId: string, d: z.infer<typeof dependent>, replacing: string | null): Promise<string | null> {
  const [emp, others] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { dateOfBirth: true } }),
    prisma.dependent.findMany({ where: { employeeId, ...(replacing ? { NOT: { id: replacing } } : {}) } }),
  ]);
  const rel = (r: string) => r.toUpperCase();
  if (["SPOUSE", "FATHER", "MOTHER"].includes(d.relationship) && others.some((o) => rel(o.relationship) === d.relationship)) return `A ${d.relationship.toLowerCase()} is already recorded.`;
  if (d.dateOfBirth && d.dateOfBirth > new Date()) return "The date of birth is in the future.";
  if (d.relationship === "CHILD" && d.dateOfBirth && emp.dateOfBirth && d.dateOfBirth <= emp.dateOfBirth) return "A child must be younger than you.";
  if ((d.relationship === "FATHER" || d.relationship === "MOTHER") && d.dateOfBirth && emp.dateOfBirth && d.dateOfBirth >= emp.dateOfBirth) return "A parent must be older than you.";
  return null;
}

/** What the record holds today, for the reviewer's before/after. */
async function currentValues(target: ProfileTarget, employeeId: string, targetId: string | null, type?: string): Promise<Record<string, unknown> | null> {
  if (target === "PERSONAL" || target === "CONTACT") {
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const keys = target === "PERSONAL" ? Object.keys(personal.shape) : Object.keys(contact.shape);
    return Object.fromEntries(keys.map((k) => { const v = (e as Record<string, unknown>)[k]; return [k, v instanceof Date ? iso(v) : v ?? null]; }));
  }
  if (target === "ADDRESS") {
    const a = await prisma.employeeAddress.findUnique({ where: { employeeId_type: { employeeId, type: (type ?? "CURRENT") as never } } });
    return a ? { type: a.type, line1: a.line1, line2: a.line2, city: a.city, state: a.state, postalCode: a.postalCode } : null;
  }
  if (target === "BANK") {
    const b = await prisma.employeeBankAccount.findFirst({ where: { employeeId, isPrimary: true } });
    return b ? { bankName: b.bankName, accountNumber: `••••${b.accountNumber.slice(-4)}`, ifsc: b.ifsc, branch: b.branch, accountHolder: b.accountHolder } : null;
  }
  if (targetId && SUB_RECORDS[target]) {
    const r = await SUB_RECORDS[target]!(targetId, employeeId);
    return r ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id" && k !== "employeeId").map(([k, v]) => [k, v instanceof Date ? iso(v) : v])) : null;
  }
  return null;
}

/**
 * An employee asks to change their own details. Personal and bank details go
 * to HR; contact, address, family, education and experience to their manager
 * (HR can decide any of them).
 */
export async function requestProfileChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can ask for profile changes." };
  const employeeId = viewer.employee.id;
  const target = String(formData.get("targetType") ?? "") as ProfileTarget;
  if (!(target in SCHEMAS)) return { ok: false, message: "Unknown kind of change." };
  const operation = (String(formData.get("operation") ?? "") || (SUB_RECORDS[target] ? "CREATE" : "UPDATE")) as "CREATE" | "UPDATE" | "DELETE";
  const targetId = String(formData.get("targetId") ?? "") || null;
  if (operation !== "CREATE" && SUB_RECORDS[target]) {
    if (!targetId || !(await SUB_RECORDS[target]!(targetId, employeeId))) return { ok: false, message: "That record was not found on your profile." };
  }
  let changes: Record<string, unknown> = {};
  if (operation !== "DELETE") {
    const parsed = parseForm(SCHEMAS[target] as z.ZodTypeAny, formData);
    if (parsed.state) return parsed.state;
    const { confirmAccountNumber: _c, ...data } = parsed.data as Record<string, unknown>;
    changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? iso(v) : v ?? null]));
    if (target === "DEPENDENT") {
      const issue = await dependentIssue(employeeId, parsed.data as z.infer<typeof dependent>, operation === "UPDATE" ? targetId : null);
      if (issue) return { ok: false, message: issue, errors: { relationship: issue } };
    }
  }
  const previous = await currentValues(target, employeeId, targetId, changes.type as string | undefined);
  // Only what actually changes goes in the request (whole rows for new records).
  if (operation === "UPDATE" && previous) {
    changes = Object.fromEntries(Object.entries(changes).filter(([k, v]) => k === "type" || JSON.stringify(previous[k] ?? null) !== JSON.stringify(v ?? null)));
    if (Object.keys(changes).filter((k) => k !== "type").length === 0) return { ok: false, message: "Nothing has changed." };
  }
  const label = { PERSONAL: "personal details", CONTACT: "contact details", ADDRESS: "address", BANK: "bank account", DEPENDENT: "dependent", EMERGENCY_CONTACT: "emergency contact", EDUCATION: "education", EXPERIENCE: "experience" }[target];
  const verb = operation === "CREATE" ? "Add" : operation === "DELETE" ? "Remove" : "Update";
  const res = await raiseChangeRequest({
    tenantId: viewer.tenantId, targetType: target, targetId, employeeId, operation,
    title: `${verb} ${label} — ${viewer.employee.displayName}`, changes, previous,
    reason: String(formData.get("reason") ?? "").trim().slice(0, 400) || null,
    approverType: SELF_SERVICE_TARGETS[target as ChangeTarget] ?? "HR", requestedBy: viewer.user.id, requestedByEmployeeId: employeeId,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ChangeRequest", entityId: res.id, summary: `Asked to ${verb.toLowerCase()} their ${label}` });
  return done(["/me/requests", "/admin/change-requests", "/inbox"], `${res.message} Your ${SELF_SERVICE_TARGETS[target as ChangeTarget] === "MANAGER" ? "manager (or HR)" : "HR team"} will review it.`);
}

const correctionSchema = z.object({ employeeId: zOptionalId(), field: zId(), correctValue: z.string().trim().min(1, "Required").max(200), reason: zName(400) });

/** Report something wrong on a record — one's own, or (for HR) anyone's in scope. */
export async function requestDataCorrectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(correctionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const employeeId = d.employeeId ?? viewer.employee?.id;
  if (!employeeId) return { ok: false, message: "Choose whose record needs correcting." };
  if (employeeId !== viewer.employee?.id && !(await isHrFor(viewer, employeeId))) return { ok: false, message: "You can only raise corrections for your own record, or records you look after." };
  const issue = correctionIssue(d.field, d.correctValue);
  if (issue) return { ok: false, message: issue, errors: { correctValue: issue } };
  const emp = await prisma.employee.findFirstOrThrow({ where: { id: employeeId, tenantId: viewer.tenantId } });
  const cur = (emp as Record<string, unknown>)[d.field];
  const currentValue = cur instanceof Date ? iso(cur) : cur === null || cur === undefined ? null : String(cur);
  if (currentValue === d.correctValue) return { ok: false, message: "That is already the value on record." };
  const res = await raiseChangeRequest({
    tenantId: viewer.tenantId, targetType: "DATA_CORRECTION", targetId: `${employeeId}:${d.field}`, employeeId,
    title: `Correct ${CORRECTABLE_FIELDS[d.field].label.toLowerCase()} — ${emp.displayName ?? emp.firstName}`,
    changes: { field: d.field, currentValue, correctValue: d.correctValue }, previous: { [d.field]: currentValue }, reason: d.reason,
    approverType: "HR", requestedBy: viewer.user.id, requestedByEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ChangeRequest", entityId: res.id, summary: `Raised a data correction: ${CORRECTABLE_FIELDS[d.field].label}` });
  return done(["/me/requests", "/admin/change-requests", "/hr-ops"], `${res.message} HR will check and correct it.`);
}

// ---------------------------------------------------------------------------
//  Letters on request (salary certificate, NOC, address proof)
// ---------------------------------------------------------------------------

const docTypeSchema = z.object({ id: zOptionalId(), name: zName(80), description: zOptional(300), templateId: zId(), requiresApproval: zBool(), isActive: zBool() });

export async function saveDocumentRequestTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_TEMPLATE_MANAGE);
  const parsed = parseForm(docTypeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const tpl = await prisma.documentTemplate.findFirst({ where: { id: d.templateId, tenantId: viewer.tenantId, isArchived: false } });
  if (!tpl) return { ok: false, message: "Choose an active letter template.", errors: { templateId: "Not found" } };
  try {
    if (id) {
      const u = await prisma.documentRequestType.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
      if (!u.count) return { ok: false, message: "Not found." };
    } else {
      await prisma.documentRequestType.create({ data: { tenantId: viewer.tenantId, ...d, isActive: true } });
    }
    await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "DocumentRequestType", entityId: id ?? d.name, summary: `${id ? "Updated" : "Offered"} "${d.name}" for employees to request (${tpl.name})` });
    return done(["/hr-ops", "/me/requests"], `${id ? "Saved" : "Employees can now request"} ${d.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

async function issueLetter(viewer: { tenantId: string; userId: string; employeeId: string | null }, requestId: string): Promise<{ ok: boolean; message: string }> {
  const r = await prisma.selfServiceDocumentRequest.findFirstOrThrow({ where: { id: requestId }, include: { type: true } });
  const res = await generateLetter({ tenantId: viewer.tenantId, templateId: r.type.templateId, employeeId: r.employeeId, issuedByEmployeeId: viewer.employeeId, issuedByUserId: viewer.userId });
  if (!res.ok) return res;
  await prisma.selfServiceDocumentRequest.update({ where: { id: r.id }, data: { status: "ISSUED", letterId: res.id, decidedBy: viewer.userId, decidedAt: new Date() } });
  return { ok: true, message: res.message };
}

export async function requestDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can request letters." };
  const type = await prisma.documentRequestType.findFirst({ where: { id: String(formData.get("typeId") ?? ""), tenantId: viewer.tenantId, isActive: true } });
  if (!type) return { ok: false, message: "Choose a letter to request.", errors: { typeId: "Required" } };
  const purpose = String(formData.get("purpose") ?? "").trim();
  if (purpose.length < 3) return { ok: false, message: "Say what the letter is for.", errors: { purpose: "Required" } };
  const open = await prisma.selfServiceDocumentRequest.count({ where: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, typeId: type.id, status: "PENDING" } });
  if (open) return { ok: false, message: `You already have a ${type.name} request waiting.` };
  const row = await prisma.selfServiceDocumentRequest.create({
    data: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, typeId: type.id, purpose: purpose.slice(0, 300), addressedTo: String(formData.get("addressedTo") ?? "").trim().slice(0, 200) || null },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "DocumentRequest", entityId: row.id, summary: `Requested a ${type.name}` });
  if (!type.requiresApproval) {
    const res = await issueLetter({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee.id }, row.id);
    return done(["/me/requests", "/documents"], res.ok ? `Your ${type.name} is ready.` : res.message);
  }
  const hr = await prisma.userRoleAssignment.findMany({ where: { user: { tenantId: viewer.tenantId }, role: { permissions: { some: { permission: P.LETTER_GENERATE } } } }, select: { userId: true }, take: 25 });
  await notify({ tenantId: viewer.tenantId, userIds: hr.map((h) => h.userId).filter((u) => u !== viewer.user.id), kind: "APPROVAL", title: `${viewer.employee.displayName} asked for a ${type.name}`, link: "/hr-ops?tab=documents" });
  return done(["/me/requests", "/hr-ops"], `Requested. HR will issue your ${type.name}.`);
}

export async function withdrawDocumentRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const u = await prisma.selfServiceDocumentRequest.updateMany({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__", status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
  if (!u.count) return { ok: false, message: "Only a waiting request of your own can be withdrawn." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "DocumentRequest", entityId: String(formData.get("id")), summary: "Withdrew a letter request" });
  return done(["/me/requests", "/hr-ops"], "Withdrawn.");
}

export async function decideDocumentRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LETTER_GENERATE);
  const r = await prisma.selfServiceDocumentRequest.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { type: true } });
  if (!r) return { ok: false, message: "Request not found." };
  if (r.status !== "PENDING") return { ok: false, message: `This request is already ${r.status.toLowerCase()}.` };
  if (r.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot issue a letter you asked for yourself." };
  if (!(await isHrFor(viewer, r.employeeId, P.LETTER_GENERATE))) return { ok: false, message: "This employee is outside the people you look after." };
  const approve = String(formData.get("decision")) === "approve";
  const note = String(formData.get("note") ?? "").trim() || null;
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: r.employeeId }, select: { userId: true, displayName: true } });
  if (!approve) {
    if (!note) return { ok: false, message: "Say why it is declined.", errors: { note: "Required" } };
    await prisma.selfServiceDocumentRequest.update({ where: { id: r.id }, data: { status: "REJECTED", decidedBy: viewer.user.id, decidedAt: new Date(), note } });
    await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "APPROVAL", title: `Your ${r.type.name} request was declined`, body: note, link: "/me/requests?tab=documents" });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "REJECT", entityType: "DocumentRequest", entityId: r.id, summary: `Declined a ${r.type.name} for ${emp.displayName}: ${note}` });
    return done(["/hr-ops", "/me/requests"], "Declined.");
  }
  const res = await issueLetter({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null }, r.id);
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "APPROVE", entityType: "DocumentRequest", entityId: r.id, summary: `Issued a ${r.type.name} for ${emp.displayName}` });
  return done(["/hr-ops", "/me/requests", "/documents"], res.message);
}

// ---------------------------------------------------------------------------
//  Digital ID card
// ---------------------------------------------------------------------------

/** Issue (or reissue) an ID card: one's own, or as HR for anyone in scope. The old card stops verifying. */
export async function issueIdCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const employeeId = String(formData.get("employeeId") ?? "") || viewer.employee?.id;
  if (!employeeId) return { ok: false, message: "Choose whose card to issue." };
  const self = employeeId === viewer.employee?.id;
  if (!self && !(await isHrFor(viewer, employeeId))) return { ok: false, message: "You can issue your own card, or cards for people you look after." };
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { employeeNumber: true, status: true, displayName: true } });
  if (!emp || emp.status === "EXITED" || emp.status === "PREBOARDING") return { ok: false, message: "Cards are for current employees." };
  const now = new Date();
  const card = await prisma.$transaction(async (tx) => {
    await tx.employeeIdCard.updateMany({ where: { tenantId: viewer.tenantId, employeeId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
    return tx.employeeIdCard.create({
      data: { tenantId: viewer.tenantId, employeeId, cardNumber: idCardNumber(viewer.tenant.subdomain, emp.employeeNumber, randomBytes(3).toString("hex")), validUntil: idCardValidity(now), issuedBy: viewer.user.id },
    });
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "EmployeeIdCard", entityId: card.id, summary: `Issued ID card ${card.cardNumber} for ${emp.displayName}` });
  return done(["/me/id-card", `/employees/${employeeId}`], `Issued card ${card.cardNumber}, valid until ${iso(card.validUntil)}.`);
}

export async function revokeIdCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const card = await prisma.employeeIdCard.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!card) return { ok: false, message: "Card not found." };
  if (!(await isHrFor(viewer, card.employeeId))) return { ok: false, message: "This employee is outside the people you look after." };
  if (card.status === "REVOKED") return { ok: false, message: "Already revoked." };
  await prisma.employeeIdCard.update({ where: { id: card.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeIdCard", entityId: card.id, summary: `Revoked ID card ${card.cardNumber}` });
  return done(["/me/id-card", `/employees/${card.employeeId}`], `Revoked ${card.cardNumber}.`);
}

// ---------------------------------------------------------------------------
//  Internal notes (HR and managers only)
// ---------------------------------------------------------------------------

export async function addInternalNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const employeeId = String(formData.get("employeeId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const visibility = String(formData.get("visibility") ?? "MANAGERS_AND_HR") === "HR_ONLY" ? "HR_ONLY" : "MANAGERS_AND_HR";
  if (!(await employeeTarget(viewer, employeeId))) return { ok: false, message: "Employee not found." };
  if (employeeId === viewer.employee?.id) return { ok: false, message: "Notes are for other people's profiles." };
  const hr = await isHrFor(viewer, employeeId);
  if (!hr && !(await isManagerOf(viewer, employeeId))) return { ok: false, message: "Only HR and the employee's managers can add notes." };
  if (visibility === "HR_ONLY" && !hr) return { ok: false, message: "Only HR can add HR-only notes." };
  if (body.length < 2 || body.length > 2000) return { ok: false, message: "Write a note of up to 2,000 characters.", errors: { body: "Required" } };
  const note = await prisma.employeeInternalNote.create({ data: { tenantId: viewer.tenantId, employeeId, authorUserId: viewer.user.id, authorName: viewer.employee?.displayName ?? viewer.user.email, body, visibility } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "EmployeeInternalNote", entityId: note.id, summary: `Added an internal note (${visibility === "HR_ONLY" ? "HR only" : "managers and HR"})` });
  return done([`/employees/${employeeId}`], "Note added.");
}

export async function deleteInternalNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const note = await prisma.employeeInternalNote.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!note) return { ok: false, message: "Note not found." };
  if (note.authorUserId !== viewer.user.id && !(await isHrFor(viewer, note.employeeId))) return { ok: false, message: "Only its author or HR can delete a note." };
  await prisma.employeeInternalNote.delete({ where: { id: note.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "EmployeeInternalNote", entityId: note.id, summary: "Deleted an internal note" });
  return done([`/employees/${note.employeeId}`], "Deleted.");
}

// ---------------------------------------------------------------------------
//  Delegation and acting managers
// ---------------------------------------------------------------------------

const delegationSchema = z.object({ delegatorId: zOptionalId(), delegateId: zId(), kind: z.enum(["DELEGATE", "ACTING"]).default("DELEGATE"), startDate: zRequiredDate(), endDate: zRequiredDate(), reason: zOptional(300) });

/**
 * A manager hands their approvals (and their team view) to a colleague while
 * away; HR can name an acting manager for any manager's team.
 */
export async function createDelegationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(delegationSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const delegatorId = d.delegatorId ?? viewer.employee?.id;
  if (!delegatorId) return { ok: false, message: "Choose the manager." };
  const self = delegatorId === viewer.employee?.id;
  const hr = can(viewer, P.ORG_MANAGE) && await isHrFor(viewer, delegatorId);
  if (!self && !hr) return { ok: false, message: "You can delegate your own approvals; HR can name acting managers." };
  const [mgr, delegate] = await Promise.all([
    prisma.employee.findFirst({ where: { id: delegatorId, tenantId: viewer.tenantId }, select: { id: true, displayName: true, userId: true, _count: { select: { directReports: true } } } }),
    prisma.employee.findFirst({ where: { id: d.delegateId, tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true, userId: true } }),
  ]);
  if (!mgr) return { ok: false, message: "Manager not found." };
  if (!delegate) return { ok: false, message: "Choose an active colleague to delegate to.", errors: { delegateId: "Not found" } };
  const dotted = await prisma.secondaryManager.count({ where: { tenantId: viewer.tenantId, managerId: delegatorId } });
  if (mgr._count.directReports + dotted === 0) return { ok: false, message: `${mgr.displayName} has no team to delegate.` };
  const existing = await prisma.managerDelegation.findMany({ where: { tenantId: viewer.tenantId, OR: [{ delegatorId }, { delegatorId: d.delegateId }] } });
  const issues = delegationIssues({ delegatorId, delegateId: d.delegateId, startDate: d.startDate, endDate: d.endDate }, existing);
  if (issues.length) return { ok: false, message: issues.join(" "), errors: { endDate: issues[0] } };
  const kind = self ? d.kind : "ACTING";
  const row = await prisma.managerDelegation.create({ data: { tenantId: viewer.tenantId, delegatorId, delegateId: d.delegateId, kind, startDate: d.startDate, endDate: d.endDate, reason: d.reason, createdBy: viewer.user.id } });
  await notify({ tenantId: viewer.tenantId, userIds: [delegate.userId, self ? null : mgr.userId], kind: "EMPLOYEE", title: `${delegate.displayName} is ${kind === "ACTING" ? "acting manager" : "approving"} for ${mgr.displayName}'s team, ${iso(d.startDate)} to ${iso(d.endDate)}`, link: "/team/dashboard" });
  await writeAudit(viewer, { module: "ROLE", action: "CREATE", entityType: "ManagerDelegation", entityId: row.id, summary: `${kind === "ACTING" ? "Named an acting manager" : "Delegated approvals"}: ${mgr.displayName} → ${delegate.displayName}, ${iso(d.startDate)} to ${iso(d.endDate)}` });
  return done(["/team/delegation", "/team/dashboard", "/org/units"], `${delegate.displayName} will ${kind === "ACTING" ? "act as manager" : "handle approvals"} from ${iso(d.startDate)} to ${iso(d.endDate)}.`);
}

export async function revokeDelegationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const row = await prisma.managerDelegation.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Delegation not found." };
  const mine = row.delegatorId === viewer.employee?.id || row.createdBy === viewer.user.id;
  if (!mine && !(can(viewer, P.ORG_MANAGE) && await isHrFor(viewer, row.delegatorId))) return { ok: false, message: "Only the manager or HR can end a delegation." };
  if (row.revokedAt) return { ok: false, message: "Already ended." };
  await prisma.managerDelegation.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  await writeAudit(viewer, { module: "ROLE", action: "UPDATE", entityType: "ManagerDelegation", entityId: row.id, summary: "Ended a delegation early" });
  return done(["/team/delegation", "/team/dashboard"], "Ended.");
}
