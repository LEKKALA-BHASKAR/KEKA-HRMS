import { createHash, randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { generateLetter } from "./letters";
import {
  ER_KINDS, ER_CATEGORIES, ER_SEVERITIES, ER_OUTCOMES, ER_ACTION_TYPES, ER_STATUSES, INVESTIGATION_CONCLUSIONS, WARNING_TYPES,
  erCanMove, erCanView, disciplinaryLadder, appealOpen, cdAddMonths, cdAddDays, cdUtcDay, suspensionDays,
} from "./cases-docs-math";

/**
 * Employee relations: grievances, complaints and disciplinary cases, kept
 * apart from the helpdesk because they are confidential by default.
 *
 * A case has an owner and an access list; a confidential case is visible
 * only to them and to holders of the approval permission, and never to the
 * employee it is about. Grievances and complaints can be raised anonymously:
 * the reporter gets a tracking code, only its hash is kept, and nothing ties
 * the case to their login. Investigations have an investigator, a task
 * list, witnesses and evidence, and end in findings that are signed off
 * through the workflow engine. Hearings are scheduled with a panel.
 * Disciplinary actions (show-cause, warnings, suspension, termination)
 * follow the progressive ladder unless a reason is recorded for skipping a
 * step, are approved through the workflow engine, issue a notice letter and
 * put warnings on the employee's HR timeline. The employee can respond,
 * acknowledge and appeal within the window; an appeal is reviewed by someone
 * other than whoever approved the action. Grievance and complaint
 * resolutions are approved before the case can close; a closed case is kept
 * for the retention period and then purged by the retention engine.
 */

type R = { ok: boolean; message: string };
export const ER_MANAGE = "lifecycle.er_case.manage";
export const ER_APPROVE = "lifecycle.er_case.approve";
const DAY = 86_400_000;

export const erRef = (n: number) => `ER-${n}`;
const hashCode = (code: string) => createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");

export async function getErSettings(tenantId: string) {
  return (await prisma.erSettings.findUnique({ where: { tenantId } })) ?? { tenantId, allowAnonymous: true, appealWindowDays: 15, showCauseDays: 7, warningValidityMonths: 12, retentionMonths: 84 };
}

export async function saveErSettings(input: { tenantId: string; allowAnonymous: boolean; appealWindowDays: number; showCauseDays: number; warningValidityMonths: number; retentionMonths: number }): Promise<R> {
  const bad = (v: number, lo: number, hi: number) => !Number.isInteger(v) || v < lo || v > hi;
  if (bad(input.appealWindowDays, 1, 90)) return { ok: false, message: "Appeal window: 1 to 90 days." };
  if (bad(input.showCauseDays, 1, 60)) return { ok: false, message: "Show-cause reply time: 1 to 60 days." };
  if (bad(input.warningValidityMonths, 1, 60)) return { ok: false, message: "Warnings stay active 1 to 60 months." };
  if (bad(input.retentionMonths, 12, 240)) return { ok: false, message: "Keep closed cases 12 to 240 months." };
  const { tenantId, ...data } = input;
  await prisma.erSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  return { ok: true, message: "Employee relations settings saved." };
}

// ---------------------------------------------------------------------------
//  Access
// ---------------------------------------------------------------------------

export interface ErViewer { tenantId: string; userId: string; employeeId: string | null; canManage: boolean; canApprove: boolean }

/** The case if the viewer may work it, else null. */
export async function erCaseFor(v: ErViewer, caseId: string) {
  const c = await prisma.erCase.findFirst({ where: { id: caseId, tenantId: v.tenantId }, include: { access: true } });
  if (!c) return null;
  const onAccessList = c.access.some((a) => a.userId === v.userId);
  return erCanView(c, { ...v, onAccessList }) ? c : null;
}

/** Prisma filter for the cases a viewer may list. */
export async function erVisibleWhere(v: ErViewer): Promise<Prisma.ErCaseWhereInput> {
  const listed = (await prisma.erCaseAccess.findMany({ where: { tenantId: v.tenantId, userId: v.userId }, select: { caseId: true } })).map((a) => a.caseId);
  const notSubject: Prisma.ErCaseWhereInput = v.employeeId ? { OR: [{ subjectEmployeeId: null }, { NOT: { subjectEmployeeId: v.employeeId } }] } : {};
  const visible: Prisma.ErCaseWhereInput[] = [{ ownerUserId: v.userId }, { id: { in: listed } }];
  if (v.canApprove) visible.push({});
  else if (v.canManage) visible.push({ isConfidential: false });
  return { tenantId: v.tenantId, AND: [notSubject, { OR: visible }] };
}

async function note(tx: Prisma.TransactionClient, tenantId: string, caseId: string, kind: string, body: string, userId: string | null, label: string) {
  await tx.erCaseNote.create({ data: { tenantId, caseId, kind, body, authorUserId: userId, authorLabel: label } });
}

async function grant(tx: Prisma.TransactionClient, tenantId: string, caseId: string, userId: string, role: string, by: string | null) {
  await tx.erCaseAccess.upsert({ where: { caseId_userId: { caseId, userId } }, create: { tenantId, caseId, userId, role, grantedByUserId: by }, update: { role } });
}

async function employeeUser(tenantId: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null;
  return (await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { userId: true } }))?.userId ?? null;
}

// ---------------------------------------------------------------------------
//  Intake
// ---------------------------------------------------------------------------

export async function saveErTemplate(input: { tenantId: string; id?: string | null; name: string; kind: string; category: string; severity: string; description?: string | null; checklist: string[]; letterTemplateId?: string | null; isActive?: boolean }): Promise<R & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Name the template." };
  if (!(input.kind in ER_KINDS) || !(input.category in ER_CATEGORIES) || !(input.severity in ER_SEVERITIES)) return { ok: false, message: "Pick a kind, category and severity." };
  if (input.letterTemplateId && !(await prisma.documentTemplate.count({ where: { id: input.letterTemplateId, tenantId: input.tenantId } }))) return { ok: false, message: "Letter template not found." };
  const clash = await prisma.erCaseTemplate.findFirst({ where: { tenantId: input.tenantId, name, ...(input.id ? { NOT: { id: input.id } } : {}) } });
  if (clash) return { ok: false, message: "Another template has that name." };
  const data = { name, kind: input.kind, category: input.category, severity: input.severity, description: input.description?.trim() || null, checklist: input.checklist.map((x) => x.trim()).filter(Boolean).slice(0, 30), letterTemplateId: input.letterTemplateId || null, isActive: input.isActive ?? true };
  if (input.id) {
    const row = await prisma.erCaseTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) return { ok: false, message: "Template not found." };
    await prisma.erCaseTemplate.update({ where: { id: row.id }, data });
    return { ok: true, id: row.id, message: "Template saved." };
  }
  const row = await prisma.erCaseTemplate.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: row.id, message: "Template added." };
}

export interface NewErCase {
  tenantId: string; kind: string; category: string; severity?: string | null; title: string; description: string;
  incidentDate?: Date | null; incidentLocation?: string | null; subjectEmployeeId?: string | null;
  /** The reporter's employee id; ignored when anonymous. */
  reporterEmployeeId?: string | null; anonymous?: boolean;
  /** HR logging the case (null for employee self-service). */
  createdByUserId?: string | null; ownerUserId?: string | null; templateId?: string | null; policyDocumentId?: string | null;
  source?: string; confidential?: boolean;
}

export async function createErCase(input: NewErCase): Promise<R & { id?: string; number?: number; trackingCode?: string }> {
  const t = input.tenantId;
  if (!(input.kind in ER_KINDS)) return { ok: false, message: "Pick what kind of case this is." };
  if (!(input.category in ER_CATEGORIES)) return { ok: false, message: "Pick a category." };
  const severity = input.severity || "MEDIUM";
  if (!(severity in ER_SEVERITIES)) return { ok: false, message: "Pick a severity." };
  const title = input.title.trim(), description = input.description.trim();
  if (title.length < 5 || title.length > 160) return { ok: false, message: "Give the case a title of 5 to 160 characters." };
  if (description.length < 20) return { ok: false, message: "Describe what happened in at least 20 characters." };
  if (input.incidentDate && input.incidentDate.getTime() > Date.now() + DAY) return { ok: false, message: "The incident date cannot be in the future." };
  const settings = await getErSettings(t);
  const anonymous = !!input.anonymous;
  if (anonymous && input.kind === "DISCIPLINARY") return { ok: false, message: "Disciplinary cases cannot be anonymous." };
  if (anonymous && !settings.allowAnonymous) return { ok: false, message: "Anonymous reporting is switched off for your organisation." };
  if (input.kind === "DISCIPLINARY" && !input.subjectEmployeeId) return { ok: false, message: "Pick the employee the disciplinary case is about." };
  if (input.subjectEmployeeId && !(await prisma.employee.count({ where: { id: input.subjectEmployeeId, tenantId: t } }))) return { ok: false, message: "Employee not found." };
  if (input.subjectEmployeeId && input.subjectEmployeeId === input.reporterEmployeeId) return { ok: false, message: "A case cannot be about the person raising it." };
  if (input.ownerUserId && !(await prisma.user.count({ where: { id: input.ownerUserId, tenantId: t } }))) return { ok: false, message: "Owner not found." };
  if (input.templateId && !(await prisma.erCaseTemplate.count({ where: { id: input.templateId, tenantId: t } }))) return { ok: false, message: "Template not found." };
  if (input.policyDocumentId && !(await prisma.orgDocument.count({ where: { id: input.policyDocumentId, tenantId: t } }))) return { ok: false, message: "Policy not found." };
  const trackingCode = anonymous ? randomBytes(6).toString("hex").toUpperCase() : undefined;
  const owner = input.ownerUserId || (input.createdByUserId && input.source !== "WEB" ? input.createdByUserId : null);

  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${t} FOR UPDATE`;
    const last = await tx.erCase.aggregate({ where: { tenantId: t }, _max: { number: true } });
    const c = await tx.erCase.create({
      data: {
        tenantId: t, number: (last._max.number ?? 1000) + 1, kind: input.kind, category: input.category, severity, title, description,
        incidentDate: input.incidentDate ?? null, incidentLocation: input.incidentLocation?.trim() || null, subjectEmployeeId: input.subjectEmployeeId || null,
        reporterEmployeeId: anonymous ? null : input.reporterEmployeeId || null, isAnonymous: anonymous, trackingCodeHash: trackingCode ? hashCode(trackingCode) : null,
        source: input.source ?? "WEB", isConfidential: input.confidential ?? true, ownerUserId: owner, templateId: input.templateId || null,
        policyDocumentId: input.policyDocumentId || null, createdByUserId: anonymous ? null : input.createdByUserId ?? null,
      },
    });
    if (owner) await grant(tx, t, c.id, owner, "OWNER", input.createdByUserId ?? null);
    await note(tx, t, c.id, "SYSTEM", `${ER_KINDS[input.kind as keyof typeof ER_KINDS]} ${anonymous ? "reported anonymously" : input.source === "WEB" ? "raised by the employee" : "logged by HR"}`, anonymous ? null : input.createdByUserId ?? null, anonymous ? "Anonymous" : "BooS-HR");
    return c;
  });
  const managers = await usersWithPermission(t, ER_MANAGE);
  await notify({ tenantId: t, userIds: owner ? [owner] : managers, kind: "ER_CASE", title: `New ${ER_KINDS[input.kind as keyof typeof ER_KINDS].toLowerCase()} ${erRef(row.number)} (${ER_SEVERITIES[severity as keyof typeof ER_SEVERITIES].toLowerCase()} severity)`, link: `/relations/${row.id}` });
  return { ok: true, id: row.id, number: row.number, trackingCode, message: anonymous ? `Reported anonymously as ${erRef(row.number)}. Keep your tracking code — it is the only way to follow up.` : `${erRef(row.number)} created.` };
}

/** What an anonymous reporter can see with their code: status and the replies HR addressed to them. */
export async function anonymousCaseView(tenantId: string, code: string) {
  if (!/^[0-9A-F]{12}$/i.test(code.trim())) return null;
  const c = await prisma.erCase.findFirst({ where: { tenantId, trackingCodeHash: hashCode(code) }, include: { notes: { where: { kind: { in: ["REPORTER", "SYSTEM"] } }, orderBy: { createdAt: "asc" } } } });
  if (!c) return null;
  return { id: c.id, number: c.number, title: c.title, kind: c.kind, status: c.status, outcome: c.outcome, createdAt: c.createdAt, notes: c.notes.map((n) => ({ body: n.body, by: n.authorLabel, at: n.createdAt })) };
}

export async function addAnonymousInfo(tenantId: string, code: string, body: string): Promise<R> {
  const text = body.trim();
  if (text.length < 5) return { ok: false, message: "Write a little more." };
  const c = await prisma.erCase.findFirst({ where: { tenantId, trackingCodeHash: hashCode(code) } });
  if (!c) return { ok: false, message: "No case matches that code." };
  if (c.status === "CLOSED") return { ok: false, message: "This case is closed." };
  await prisma.erCaseNote.create({ data: { tenantId, caseId: c.id, kind: "REPORTER", body: text, authorUserId: null, authorLabel: "Anonymous reporter" } });
  await notify({ tenantId, userIds: c.ownerUserId ? [c.ownerUserId] : await usersWithPermission(tenantId, ER_MANAGE), kind: "ER_CASE", title: `${erRef(c.number)}: the anonymous reporter added information`, link: `/relations/${c.id}` });
  return { ok: true, message: "Added to your report." };
}

// ---------------------------------------------------------------------------
//  Working a case
// ---------------------------------------------------------------------------

type Actor = { tenantId: string; userId: string; label: string };

export async function updateErAccess(a: Actor & { caseId: string; userId2: string; role: string; remove?: boolean }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  const u = await prisma.user.findFirst({ where: { id: a.userId2, tenantId: a.tenantId }, select: { id: true, employee: { select: { id: true } } } });
  if (!u) return { ok: false, message: "That person does not exist." };
  if (c.subjectEmployeeId && u.employee?.id === c.subjectEmployeeId) return { ok: false, message: "The employee the case is about cannot be given access." };
  if (a.remove) {
    if (c.ownerUserId === u.id) return { ok: false, message: "Change the owner before removing them." };
    await prisma.erCaseAccess.deleteMany({ where: { caseId: c.id, userId: u.id } });
  } else {
    if (!["VIEWER", "INVESTIGATOR", "PANEL", "OWNER"].includes(a.role)) return { ok: false, message: "Pick a role." };
    await prisma.$transaction(async (tx) => {
      if (a.role === "OWNER") await tx.erCase.update({ where: { id: c.id }, data: { ownerUserId: u.id } });
      await grant(tx, a.tenantId, c.id, u.id, a.role, a.userId);
    });
  }
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: c.id, kind: "SYSTEM", body: `Access ${a.remove ? "removed" : `granted (${a.role.toLowerCase()})`} by ${a.label}`, authorUserId: a.userId, authorLabel: a.label } });
  if (!a.remove) await notify({ tenantId: a.tenantId, userIds: [u.id], kind: "ER_CASE", title: `You were given access to ${erRef(c.number)}`, link: `/relations/${c.id}` });
  return { ok: true, message: a.remove ? "Access removed." : "Access granted." };
}

export async function addErNote(a: Actor & { caseId: string; body: string; toReporter?: boolean }): Promise<R> {
  const body = a.body.trim();
  if (!body) return { ok: false, message: "Write the note." };
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: c.id, kind: a.toReporter ? "REPORTER" : "NOTE", body, authorUserId: a.userId, authorLabel: a.toReporter ? "HR" : a.label } });
  if (a.toReporter && c.reporterEmployeeId) await notify({ tenantId: a.tenantId, userIds: [await employeeUser(a.tenantId, c.reporterEmployeeId)], kind: "ER_CASE", title: `Update on your case ${erRef(c.number)}`, link: "/me/cases" });
  return { ok: true, message: a.toReporter ? "Message sent to the reporter." : "Note added." };
}

export async function moveErCase(a: Actor & { caseId: string; to: string; note?: string | null }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  if (!["UNDER_REVIEW", "INVESTIGATION", "HEARING", "PENDING_DECISION"].includes(a.to)) return { ok: false, message: "That status is set by its own step (resolution, action or closure)." };
  if (!erCanMove(c.status, a.to)) return { ok: false, message: `A case ${ER_STATUSES[c.status as keyof typeof ER_STATUSES]?.toLowerCase() ?? c.status} cannot move to ${ER_STATUSES[a.to as keyof typeof ER_STATUSES].toLowerCase()}.` };
  await prisma.$transaction(async (tx) => {
    await tx.erCase.update({ where: { id: c.id }, data: { status: a.to } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Status changed to ${ER_STATUSES[a.to as keyof typeof ER_STATUSES]} by ${a.label}${a.note?.trim() ? `: ${a.note.trim()}` : ""}`, a.userId, a.label);
  });
  return { ok: true, message: `Moved to ${ER_STATUSES[a.to as keyof typeof ER_STATUSES]}.` };
}

// ---------------------------------------------------------------------------
//  Investigation
// ---------------------------------------------------------------------------

export async function startInvestigation(a: Actor & { caseId: string; investigatorUserId: string; scope?: string | null; dueOn?: Date | null }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId }, include: { investigation: true } });
  if (!c) return { ok: false, message: "Case not found." };
  if (c.investigation && c.investigation.status !== "RETURNED") return { ok: false, message: "This case already has an investigation." };
  if (["RESOLVED", "CLOSED", "ACTION_TAKEN"].includes(c.status)) return { ok: false, message: "The case has moved past investigation." };
  const inv = await prisma.user.findFirst({ where: { id: a.investigatorUserId, tenantId: a.tenantId }, select: { id: true, employee: { select: { id: true } } } });
  if (!inv) return { ok: false, message: "Investigator not found." };
  if (inv.employee && (inv.employee.id === c.subjectEmployeeId || inv.employee.id === c.reporterEmployeeId)) return { ok: false, message: "The investigator cannot be a party to the case." };
  if (a.dueOn && a.dueOn < cdUtcDay(new Date())) return { ok: false, message: "The due date has passed." };
  const tpl = c.templateId ? await prisma.erCaseTemplate.findUnique({ where: { id: c.templateId } }) : null;
  const checklist = Array.isArray(tpl?.checklist) ? (tpl!.checklist as unknown[]).map(String) : ["Interview the complainant", "Interview the respondent", "Collect documents and evidence", "Interview witnesses", "Write up findings"];
  await prisma.$transaction(async (tx) => {
    const row = c.investigation
      ? await tx.erInvestigation.update({ where: { id: c.investigation.id }, data: { investigatorUserId: inv.id, scope: a.scope?.trim() || null, dueOn: a.dueOn ?? null, status: "OPEN" } })
      : await tx.erInvestigation.create({ data: { tenantId: a.tenantId, caseId: c.id, investigatorUserId: inv.id, scope: a.scope?.trim() || null, startedOn: new Date(), dueOn: a.dueOn ?? null } });
    if (!c.investigation) await tx.erInvestigationTask.createMany({ data: checklist.map((title, i) => ({ tenantId: a.tenantId, investigationId: row.id, title, sortOrder: i })) });
    await grant(tx, a.tenantId, c.id, inv.id, "INVESTIGATOR", a.userId);
    await tx.erCase.update({ where: { id: c.id }, data: { status: "INVESTIGATION" } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Investigation ${c.investigation ? "reassigned" : "opened"} by ${a.label}`, a.userId, a.label);
  });
  await notify({ tenantId: a.tenantId, userIds: [inv.id], kind: "ER_CASE", title: `You are investigating ${erRef(c.number)}`, link: `/relations/${c.id}`, email: true });
  return { ok: true, message: "Investigation opened." };
}

export async function addInvestigationTask(a: Actor & { caseId: string; title: string; dueOn?: Date | null }): Promise<R> {
  const inv = await prisma.erInvestigation.findFirst({ where: { caseId: a.caseId, tenantId: a.tenantId } });
  if (!inv) return { ok: false, message: "Open an investigation first." };
  if (!a.title.trim()) return { ok: false, message: "Describe the task." };
  const n = await prisma.erInvestigationTask.count({ where: { investigationId: inv.id } });
  await prisma.erInvestigationTask.create({ data: { tenantId: a.tenantId, investigationId: inv.id, title: a.title.trim().slice(0, 200), dueOn: a.dueOn ?? null, sortOrder: n } });
  return { ok: true, message: "Task added." };
}

export async function toggleInvestigationTask(a: Actor & { taskId: string }): Promise<R> {
  const k = await prisma.erInvestigationTask.findFirst({ where: { id: a.taskId, tenantId: a.tenantId } });
  if (!k) return { ok: false, message: "Task not found." };
  await prisma.erInvestigationTask.update({ where: { id: k.id }, data: k.doneAt ? { doneAt: null, doneByUserId: null } : { doneAt: new Date(), doneByUserId: a.userId } });
  return { ok: true, message: k.doneAt ? "Task reopened." : "Task done." };
}

export async function addWitness(a: Actor & { caseId: string; employeeId?: string | null; name?: string | null; contact?: string | null; statement?: string | null; interviewedOn?: Date | null }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  let name = a.name?.trim() || "";
  if (a.employeeId) {
    const e = await prisma.employee.findFirst({ where: { id: a.employeeId, tenantId: a.tenantId }, select: { displayName: true } });
    if (!e) return { ok: false, message: "Employee not found." };
    if (a.employeeId === c.subjectEmployeeId) return { ok: false, message: "The respondent is not a witness; record their statement at a hearing or as a response." };
    name = e.displayName ?? name;
  }
  if (!name) return { ok: false, message: "Name the witness." };
  await prisma.$transaction(async (tx) => {
    await tx.erWitness.create({ data: { tenantId: a.tenantId, caseId: c.id, employeeId: a.employeeId || null, name, contact: a.contact?.trim() || null, statement: a.statement?.trim() || null, interviewedOn: a.interviewedOn ?? null, addedByUserId: a.userId } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Witness added: ${name}${a.statement?.trim() ? " (statement recorded)" : ""}`, a.userId, a.label);
  });
  return { ok: true, message: "Witness added." };
}

export async function recordWitnessStatement(a: Actor & { witnessId: string; statement: string; interviewedOn?: Date | null }): Promise<R> {
  const w = await prisma.erWitness.findFirst({ where: { id: a.witnessId, tenantId: a.tenantId } });
  if (!w) return { ok: false, message: "Witness not found." };
  if (a.statement.trim().length < 5) return { ok: false, message: "Record the statement." };
  await prisma.erWitness.update({ where: { id: w.id }, data: { statement: a.statement.trim(), interviewedOn: a.interviewedOn ?? w.interviewedOn ?? new Date() } });
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: w.caseId, kind: "SYSTEM", body: `Statement recorded from ${w.name}`, authorUserId: a.userId, authorLabel: a.label } });
  return { ok: true, message: "Statement recorded." };
}

/** The file is stored by the caller first (StoredFile, relatedType "ErEvidence"). */
export async function addEvidence(a: Actor & { caseId: string; title: string; description?: string | null; fileId?: string | null; sha256?: string | null; collectedOn?: Date | null }): Promise<R & { id?: string }> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  if (!a.title.trim()) return { ok: false, message: "Name the evidence." };
  if (!a.fileId && !a.description?.trim()) return { ok: false, message: "Attach a file or describe the evidence." };
  const row = await prisma.$transaction(async (tx) => {
    const e = await tx.erEvidence.create({ data: { tenantId: a.tenantId, caseId: c.id, title: a.title.trim(), description: a.description?.trim() || null, fileId: a.fileId ?? null, sha256: a.sha256 ?? null, collectedOn: a.collectedOn ?? null, addedByUserId: a.userId } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Evidence added: ${a.title.trim()}${a.sha256 ? ` (SHA-256 ${a.sha256.slice(0, 12)}…)` : ""}`, a.userId, a.label);
    return e;
  });
  return { ok: true, id: row.id, message: "Evidence added." };
}

export async function submitFindings(a: Actor & { caseId: string; employeeId: string | null; findings: string; conclusion: string; recommendation?: string | null }): Promise<R & { requestId?: string }> {
  const inv = await prisma.erInvestigation.findFirst({ where: { caseId: a.caseId, tenantId: a.tenantId }, include: { case: true, tasks: true } });
  if (!inv) return { ok: false, message: "There is no investigation." };
  if (inv.investigatorUserId !== a.userId) return { ok: false, message: "Only the investigator submits the findings." };
  if (inv.status === "FINDINGS_SUBMITTED" || inv.status === "ACCEPTED") return { ok: false, message: "Findings are already submitted." };
  if (!(a.conclusion in INVESTIGATION_CONCLUSIONS)) return { ok: false, message: "Pick a conclusion." };
  if (a.findings.trim().length < 30) return { ok: false, message: "Write up the findings (at least 30 characters)." };
  const open = inv.tasks.filter((k) => !k.doneAt).length;
  if (open) return { ok: false, message: `Finish the ${open} open investigation task${open === 1 ? "" : "s"} first.` };
  const { startWorkflow } = await import("./workflow-engine");
  await prisma.erInvestigation.update({ where: { id: inv.id }, data: { findings: a.findings.trim(), conclusion: a.conclusion, recommendation: a.recommendation?.trim() || null, status: "FINDINGS_SUBMITTED", submittedAt: new Date() } });
  const res = await startWorkflow({ tenantId: a.tenantId, entityType: "ER_FINDINGS", entityId: inv.id, title: `Investigation findings: ${erRef(inv.case.number)}`, details: `Conclusion: ${INVESTIGATION_CONCLUSIONS[a.conclusion as keyof typeof INVESTIGATION_CONCLUSIONS]}`, requesterUserId: a.userId, subjectEmployeeId: a.employeeId, data: { link: `/relations/${inv.caseId}` } });
  if (!res.ok) { await prisma.erInvestigation.update({ where: { id: inv.id }, data: { status: "OPEN" } }); return res; }
  await prisma.erInvestigation.update({ where: { id: inv.id }, data: { workflowRequestId: res.requestId } });
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: inv.caseId, kind: "SYSTEM", body: `Findings submitted for sign-off by ${a.label}`, authorUserId: a.userId, authorLabel: a.label } });
  return { ok: true, requestId: res.requestId, message: "Findings submitted for sign-off." };
}

export async function applyFindingsDecision(tenantId: string, investigationId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const inv = await prisma.erInvestigation.findFirst({ where: { id: investigationId, tenantId }, include: { case: true } });
  if (!inv || inv.status !== "FINDINGS_SUBMITTED") return;
  const accepted = outcome === "APPROVED";
  await prisma.$transaction(async (tx) => {
    await tx.erInvestigation.update({ where: { id: inv.id }, data: accepted ? { status: "ACCEPTED", acceptedAt: new Date() } : { status: "RETURNED" } });
    if (accepted && ["INVESTIGATION", "HEARING", "UNDER_REVIEW"].includes(inv.case.status)) await tx.erCase.update({ where: { id: inv.caseId }, data: { status: "PENDING_DECISION" } });
    await note(tx, tenantId, inv.caseId, "SYSTEM", accepted ? "Investigation findings accepted" : `Investigation findings ${outcome === "REJECTED" ? "returned for more work" : "withdrawn"}`, actorUserId, "Approvals");
  });
  await notify({ tenantId, userIds: [inv.investigatorUserId, inv.case.ownerUserId], kind: "ER_CASE", title: `${erRef(inv.case.number)}: findings ${accepted ? "accepted" : "returned"}`, link: `/relations/${inv.caseId}` });
}

// ---------------------------------------------------------------------------
//  Hearings
// ---------------------------------------------------------------------------

export async function scheduleHearing(a: Actor & { caseId: string; scheduledAt: Date; location?: string | null; panelUserIds: string[] }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  if (["CLOSED", "RESOLVED"].includes(c.status)) return { ok: false, message: "The case is resolved." };
  if (a.scheduledAt.getTime() < Date.now() - 3_600_000) return { ok: false, message: "Schedule the hearing in the future." };
  const panel = [...new Set(a.panelUserIds.filter(Boolean))];
  if (!panel.length) return { ok: false, message: "Name at least one panel member." };
  const users = await prisma.user.findMany({ where: { id: { in: panel }, tenantId: a.tenantId }, select: { id: true, employee: { select: { id: true } } } });
  if (users.length !== panel.length) return { ok: false, message: "A panel member was not found." };
  if (users.some((u) => u.employee && (u.employee.id === c.subjectEmployeeId || u.employee.id === c.reporterEmployeeId))) return { ok: false, message: "A party to the case cannot sit on the panel." };
  const when = a.scheduledAt.toISOString().slice(0, 16).replace("T", " ");
  await prisma.$transaction(async (tx) => {
    await tx.erHearing.create({ data: { tenantId: a.tenantId, caseId: c.id, scheduledAt: a.scheduledAt, location: a.location?.trim() || null, panelUserIds: panel, createdByUserId: a.userId } });
    for (const u of panel) await grant(tx, a.tenantId, c.id, u, "PANEL", a.userId);
    if (erCanMove(c.status, "HEARING")) await tx.erCase.update({ where: { id: c.id }, data: { status: "HEARING" } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Hearing scheduled for ${when} UTC${a.location ? ` at ${a.location}` : ""}`, a.userId, a.label);
  });
  const subjectUser = await employeeUser(a.tenantId, c.subjectEmployeeId);
  await notify({ tenantId: a.tenantId, userIds: panel, kind: "ER_CASE", title: `Hearing for ${erRef(c.number)} on ${when} UTC`, link: `/relations/${c.id}`, email: true });
  if (subjectUser) await notify({ tenantId: a.tenantId, userIds: [subjectUser], kind: "ER_CASE", title: `You are asked to attend a hearing on ${when} UTC`, body: a.location ? `Location: ${a.location}` : null, link: "/me/cases", email: true });
  return { ok: true, message: "Hearing scheduled; the panel and the employee have been told." };
}

export async function recordHearing(a: Actor & { hearingId: string; status: string; minutes?: string | null; employeeStatement?: string | null; attendees?: string | null }): Promise<R> {
  const h = await prisma.erHearing.findFirst({ where: { id: a.hearingId, tenantId: a.tenantId } });
  if (!h) return { ok: false, message: "Hearing not found." };
  if (!["HELD", "ADJOURNED", "CANCELLED"].includes(a.status)) return { ok: false, message: "Pick what happened." };
  if (a.status === "HELD" && (a.minutes ?? "").trim().length < 10) return { ok: false, message: "Record the minutes of the hearing." };
  await prisma.$transaction(async (tx) => {
    await tx.erHearing.update({ where: { id: h.id }, data: { status: a.status, minutes: a.minutes?.trim() || null, employeeStatement: a.employeeStatement?.trim() || null, attendees: a.attendees?.trim() || null } });
    if (a.employeeStatement?.trim()) await note(tx, a.tenantId, h.caseId, "RESPONSE", `Statement at hearing: ${a.employeeStatement.trim()}`, a.userId, a.label);
    await note(tx, a.tenantId, h.caseId, "SYSTEM", `Hearing ${a.status.toLowerCase()}`, a.userId, a.label);
  });
  return { ok: true, message: `Hearing marked ${a.status.toLowerCase()}.` };
}

// ---------------------------------------------------------------------------
//  Disciplinary actions
// ---------------------------------------------------------------------------

export async function proposeAction(a: Actor & {
  caseId: string; requesterEmployeeId: string | null; actionType: string; summary: string; effectiveOn: Date;
  suspensionFrom?: Date | null; suspensionTo?: Date | null; suspensionPaid?: boolean; responseDueOn?: Date | null; letterTemplateId?: string | null; ladderOverride?: string | null;
}): Promise<R & { id?: string; requestId?: string; ladderWarning?: string }> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  if (!c.subjectEmployeeId) return { ok: false, message: "Name the employee the case is about before proposing an action." };
  if (c.status === "CLOSED") return { ok: false, message: "The case is closed." };
  if (!(a.actionType in ER_ACTION_TYPES)) return { ok: false, message: "Pick an action." };
  if (a.summary.trim().length < 10) return { ok: false, message: "Say what the action is for." };
  if (a.actionType === "SUSPENSION") {
    if (!a.suspensionFrom || !a.suspensionTo) return { ok: false, message: "Give the suspension's first and last day." };
    if (a.suspensionTo < a.suspensionFrom) return { ok: false, message: "The suspension ends before it starts." };
    if (suspensionDays(a.suspensionFrom, a.suspensionTo) > 90) return { ok: false, message: "A suspension longer than 90 days needs a new case review." };
  }
  if (a.letterTemplateId && !(await prisma.documentTemplate.count({ where: { id: a.letterTemplateId, tenantId: a.tenantId, isArchived: false } }))) return { ok: false, message: "Letter template not found." };
  const pendingSame = await prisma.erAction.count({ where: { caseId: c.id, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } });
  if (pendingSame) return { ok: false, message: "An action on this case is already awaiting approval." };
  const history = await prisma.erAction.findMany({ where: { tenantId: a.tenantId, employeeId: c.subjectEmployeeId }, select: { actionType: true, status: true, effectiveOn: true, expiresOn: true } });
  const ladder = disciplinaryLadder(history, a.actionType, new Date());
  if (ladder.skipped && !a.ladderOverride?.trim()) return { ok: false, message: `${ladder.reason} Record why the step is being skipped (e.g. gross misconduct).`, ladderWarning: ladder.reason };
  const settings = await getErSettings(a.tenantId);
  const responseDueOn = a.actionType === "SHOW_CAUSE" ? (a.responseDueOn ?? cdAddDays(cdUtcDay(a.effectiveOn), settings.showCauseDays)) : null;
  const expiresOn = (WARNING_TYPES as string[]).includes(a.actionType) ? cdAddMonths(a.effectiveOn, settings.warningValidityMonths) : null;
  const tpl = !a.letterTemplateId && c.templateId ? await prisma.erCaseTemplate.findUnique({ where: { id: c.templateId }, select: { letterTemplateId: true } }) : null;
  const action = await prisma.erAction.create({
    data: {
      tenantId: a.tenantId, caseId: c.id, employeeId: c.subjectEmployeeId, actionType: a.actionType, summary: a.summary.trim(), effectiveOn: a.effectiveOn, expiresOn,
      suspensionFrom: a.actionType === "SUSPENSION" ? a.suspensionFrom : null, suspensionTo: a.actionType === "SUSPENSION" ? a.suspensionTo : null, suspensionPaid: !!a.suspensionPaid,
      responseDueOn, ladderOverride: ladder.skipped ? a.ladderOverride!.trim() : null, letterTemplateId: a.letterTemplateId || tpl?.letterTemplateId || null,
      status: "PENDING_APPROVAL", createdByUserId: a.userId,
    },
  });
  const { startWorkflow } = await import("./workflow-engine");
  const res = await startWorkflow({
    tenantId: a.tenantId, entityType: "ER_ACTION", entityId: action.id, title: `${ER_ACTION_TYPES[a.actionType as keyof typeof ER_ACTION_TYPES]}: ${erRef(c.number)}`,
    details: `${a.summary.trim()}${ladder.skipped ? ` — ladder step skipped: ${a.ladderOverride!.trim()}` : ""}`, requesterUserId: a.userId, subjectEmployeeId: a.requesterEmployeeId,
    category: a.actionType, data: { link: `/relations/${c.id}` },
  });
  if (!res.ok) { await prisma.erAction.delete({ where: { id: action.id } }); return res; }
  await prisma.erAction.update({ where: { id: action.id }, data: { workflowRequestId: res.requestId } });
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: c.id, kind: "SYSTEM", body: `${ER_ACTION_TYPES[a.actionType as keyof typeof ER_ACTION_TYPES]} proposed by ${a.label} and sent for approval${ladder.skipped ? " (ladder step skipped with a reason)" : ""}`, authorUserId: a.userId, authorLabel: a.label } });
  const after = await prisma.erAction.findUniqueOrThrow({ where: { id: action.id }, select: { status: true } });
  return { ok: true, id: action.id, requestId: res.requestId, message: after.status === "ISSUED" ? "Approved and issued." : "Sent for approval." };
}

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "");

/** Workflow effect: issue (letter, timeline, notice to the employee) or reject. */
export async function applyActionDecision(tenantId: string, actionId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const act = await prisma.erAction.findFirst({ where: { id: actionId, tenantId }, include: { case: true } });
  if (!act || act.status !== "PENDING_APPROVAL") return;
  if (outcome !== "APPROVED") {
    await prisma.$transaction(async (tx) => {
      await tx.erAction.update({ where: { id: act.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "DRAFT" } });
      await note(tx, tenantId, act.caseId, "SYSTEM", `${ER_ACTION_TYPES[act.actionType as keyof typeof ER_ACTION_TYPES]} ${outcome.toLowerCase()}`, actorUserId, "Approvals");
    });
    if (outcome === "WITHDRAWN") await prisma.erAction.delete({ where: { id: act.id } });
    await notify({ tenantId, userIds: [act.createdByUserId], kind: "ER_CASE", title: `${erRef(act.case.number)}: proposed action ${outcome.toLowerCase()}`, link: `/relations/${act.caseId}` });
    return;
  }
  const label = ER_ACTION_TYPES[act.actionType as keyof typeof ER_ACTION_TYPES];
  let letterId: string | null = null;
  if (act.letterTemplateId) {
    const r = await generateLetter({
      tenantId, templateId: act.letterTemplateId, employeeId: act.employeeId, issuedByEmployeeId: null, issuedByUserId: actorUserId ?? act.createdByUserId,
      approverUserIds: [], issuedOn: act.effectiveOn,
      extraValues: {
        case_number: erRef(act.case.number), case_title: act.case.title, action_type: label, action_summary: act.summary, effective_date: fmt(act.effectiveOn),
        response_due_date: fmt(act.responseDueOn), suspension_from: fmt(act.suspensionFrom), suspension_to: fmt(act.suspensionTo),
      },
    });
    if (!r.ok) throw new Error(`The notice letter could not be generated: ${r.message}`);
    letterId = r.id ?? null;
  }
  const severity = act.actionType === "VERBAL_WARNING" ? "MINOR" : act.actionType === "WRITTEN_WARNING" ? "MAJOR" : act.actionType === "FINAL_WARNING" ? "FINAL" : null;
  await prisma.$transaction(async (tx) => {
    let hrActivityId: string | null = null;
    if (severity || act.actionType === "TERMINATION") {
      const h = await tx.hrActivity.create({
        data: {
          tenantId, employeeId: act.employeeId, type: severity ? "WARNING" : "TERMINATION", title: `${label} (${erRef(act.case.number)})`, description: act.summary,
          occurredOn: act.effectiveOn, severity, recordedBy: actorUserId,
        },
      });
      hrActivityId = h.id;
    }
    await tx.erAction.update({ where: { id: act.id }, data: { status: "ISSUED", issuedAt: new Date(), letterId, hrActivityId } });
    if (act.actionType !== "SHOW_CAUSE" && ["PENDING_DECISION", "HEARING", "INVESTIGATION", "UNDER_REVIEW", "NEW", "APPEALED"].includes(act.case.status)) await tx.erCase.update({ where: { id: act.caseId }, data: { status: "ACTION_TAKEN" } });
    await note(tx, tenantId, act.caseId, "SYSTEM", `${label} approved and issued${letterId ? " with a notice letter" : ""}`, actorUserId, "Approvals");
  });
  const user = await employeeUser(tenantId, act.employeeId);
  await notify({ tenantId, userIds: [user], kind: "ER_CASE", title: act.actionType === "SHOW_CAUSE" ? `Show-cause notice: please respond by ${fmt(act.responseDueOn)}` : `A ${label.toLowerCase()} has been issued to you`, link: "/me/cases", email: true });
  await notify({ tenantId, userIds: [act.createdByUserId, act.case.ownerUserId], kind: "ER_CASE", title: `${erRef(act.case.number)}: ${label.toLowerCase()} issued`, link: `/relations/${act.caseId}` });
}

/** The employee's reply to a show-cause notice or a warning. */
export async function respondToAction(input: { tenantId: string; actionId: string; employeeId: string; userId: string; label: string; response: string }): Promise<R> {
  const act = await prisma.erAction.findFirst({ where: { id: input.actionId, tenantId: input.tenantId, employeeId: input.employeeId }, include: { case: true } });
  if (!act || act.status !== "ISSUED") return { ok: false, message: "Nothing to respond to." };
  if (act.respondedAt) return { ok: false, message: "You have already responded." };
  if (input.response.trim().length < 10) return { ok: false, message: "Write your response (at least 10 characters)." };
  await prisma.$transaction(async (tx) => {
    await tx.erAction.update({ where: { id: act.id }, data: { employeeResponse: input.response.trim(), respondedAt: new Date() } });
    await note(tx, input.tenantId, act.caseId, "RESPONSE", input.response.trim(), input.userId, input.label);
  });
  await notify({ tenantId: input.tenantId, userIds: [act.case.ownerUserId, act.createdByUserId], kind: "ER_CASE", title: `${erRef(act.case.number)}: the employee responded${act.responseDueOn && new Date() > cdAddDays(act.responseDueOn, 1) ? " (after the due date)" : ""}`, link: `/relations/${act.caseId}` });
  return { ok: true, message: "Your response has been recorded." };
}

export async function acknowledgeAction(input: { tenantId: string; actionId: string; employeeId: string }): Promise<R> {
  const act = await prisma.erAction.findFirst({ where: { id: input.actionId, tenantId: input.tenantId, employeeId: input.employeeId, status: "ISSUED" } });
  if (!act) return { ok: false, message: "Nothing to acknowledge." };
  if (act.acknowledgedAt) return { ok: false, message: "Already acknowledged." };
  await prisma.erAction.update({ where: { id: act.id }, data: { acknowledgedAt: new Date() } });
  await prisma.erCaseNote.create({ data: { tenantId: input.tenantId, caseId: act.caseId, kind: "SYSTEM", body: "The employee acknowledged receipt", authorUserId: null, authorLabel: "Employee" } });
  return { ok: true, message: "Acknowledged. This does not mean you agree; you can still respond or appeal." };
}

export async function revokeAction(a: Actor & { actionId: string; reason: string }): Promise<R> {
  const act = await prisma.erAction.findFirst({ where: { id: a.actionId, tenantId: a.tenantId } });
  if (!act || act.status !== "ISSUED") return { ok: false, message: "Only an issued action can be revoked." };
  if (a.reason.trim().length < 5) return { ok: false, message: "Say why it is revoked." };
  await prisma.$transaction(async (tx) => {
    await tx.erAction.update({ where: { id: act.id }, data: { status: "REVOKED", revokedAt: new Date(), revokeReason: a.reason.trim() } });
    if (act.hrActivityId) await tx.hrActivity.deleteMany({ where: { id: act.hrActivityId, tenantId: a.tenantId } });
    if (act.letterId) await tx.generatedDocument.updateMany({ where: { id: act.letterId }, data: { status: "VOID", voidedAt: new Date(), voidReason: `Action revoked: ${a.reason.trim()}` } });
    await note(tx, a.tenantId, act.caseId, "SYSTEM", `${ER_ACTION_TYPES[act.actionType as keyof typeof ER_ACTION_TYPES]} revoked by ${a.label}: ${a.reason.trim()}`, a.userId, a.label);
  });
  return { ok: true, message: "Action revoked; its warning and letter were withdrawn." };
}

// ---------------------------------------------------------------------------
//  Appeals
// ---------------------------------------------------------------------------

export async function fileAppeal(input: { tenantId: string; actionId: string; employeeId: string; userId: string; label: string; grounds: string }): Promise<R> {
  const act = await prisma.erAction.findFirst({ where: { id: input.actionId, tenantId: input.tenantId, employeeId: input.employeeId }, include: { case: true } });
  if (!act) return { ok: false, message: "Action not found." };
  const settings = await getErSettings(input.tenantId);
  if (!appealOpen(act, settings.appealWindowDays, new Date())) return { ok: false, message: `Appeals must be filed within ${settings.appealWindowDays} days of an issued action.` };
  if (await prisma.erAppeal.count({ where: { actionId: act.id, status: { in: ["FILED", "UNDER_REVIEW"] } } })) return { ok: false, message: "An appeal against this action is already open." };
  if (input.grounds.trim().length < 20) return { ok: false, message: "Explain the grounds of your appeal (at least 20 characters)." };
  await prisma.$transaction(async (tx) => {
    await tx.erAppeal.create({ data: { tenantId: input.tenantId, caseId: act.caseId, actionId: act.id, filedByEmployeeId: input.employeeId, grounds: input.grounds.trim() } });
    await tx.erCase.update({ where: { id: act.caseId }, data: { status: "APPEALED" } });
    await note(tx, input.tenantId, act.caseId, "RESPONSE", `Appeal filed: ${input.grounds.trim()}`, input.userId, input.label);
  });
  await notify({ tenantId: input.tenantId, userIds: await usersWithPermission(input.tenantId, ER_APPROVE), kind: "ER_CASE", title: `Appeal filed on ${erRef(act.case.number)}`, link: `/relations/${act.caseId}` });
  return { ok: true, message: "Your appeal has been filed. Someone not involved in the original decision will review it." };
}

/** Who approved the action through the engine: they may not review the appeal. */
async function actionDeciders(requestId: string | null): Promise<string[]> {
  if (!requestId) return [];
  return (await prisma.workflowTask.findMany({ where: { requestId, status: "APPROVED" }, select: { approverUserId: true } })).map((t) => t.approverUserId);
}

export async function takeUpAppeal(a: Actor & { appealId: string }): Promise<R> {
  const ap = await prisma.erAppeal.findFirst({ where: { id: a.appealId, tenantId: a.tenantId }, include: { action: true } });
  if (!ap || ap.status !== "FILED") return { ok: false, message: "This appeal is not waiting for a reviewer." };
  const conflicted = [ap.action?.createdByUserId, ...(await actionDeciders(ap.action?.workflowRequestId ?? null))];
  if (conflicted.includes(a.userId)) return { ok: false, message: "You took part in the original decision, so someone else must review the appeal." };
  await prisma.$transaction(async (tx) => {
    await tx.erAppeal.update({ where: { id: ap.id }, data: { status: "UNDER_REVIEW", reviewerUserId: a.userId } });
    await grant(tx, a.tenantId, ap.caseId, a.userId, "VIEWER", a.userId);
    await note(tx, a.tenantId, ap.caseId, "SYSTEM", `Appeal taken up for review by ${a.label}`, a.userId, a.label);
  });
  return { ok: true, message: "You are reviewing this appeal." };
}

export async function decideAppeal(a: Actor & { appealId: string; decision: string; note: string }): Promise<R> {
  const ap = await prisma.erAppeal.findFirst({ where: { id: a.appealId, tenantId: a.tenantId }, include: { action: true, case: true } });
  if (!ap || ap.status !== "UNDER_REVIEW") return { ok: false, message: "Take the appeal up for review first." };
  if (ap.reviewerUserId !== a.userId) return { ok: false, message: "Only the assigned reviewer decides this appeal." };
  if (!["UPHELD", "OVERTURNED", "MODIFIED"].includes(a.decision)) return { ok: false, message: "Pick a decision." };
  if (a.note.trim().length < 10) return { ok: false, message: "Explain the decision." };
  await prisma.$transaction(async (tx) => {
    await tx.erAppeal.update({ where: { id: ap.id }, data: { status: a.decision, decision: a.note.trim(), decidedAt: new Date() } });
    await tx.erCase.update({ where: { id: ap.caseId }, data: { status: a.decision === "OVERTURNED" ? "PENDING_DECISION" : "ACTION_TAKEN" } });
    if (a.decision === "OVERTURNED" && ap.action && ap.action.status === "ISSUED") {
      await tx.erAction.update({ where: { id: ap.action.id }, data: { status: "REVOKED", revokedAt: new Date(), revokeReason: `Overturned on appeal: ${a.note.trim()}` } });
      if (ap.action.hrActivityId) await tx.hrActivity.deleteMany({ where: { id: ap.action.hrActivityId, tenantId: a.tenantId } });
      if (ap.action.letterId) await tx.generatedDocument.updateMany({ where: { id: ap.action.letterId }, data: { status: "VOID", voidedAt: new Date(), voidReason: "Overturned on appeal" } });
    }
    await note(tx, a.tenantId, ap.caseId, "SYSTEM", `Appeal ${a.decision.toLowerCase()}: ${a.note.trim()}`, a.userId, a.label);
  });
  await notify({ tenantId: a.tenantId, userIds: [await employeeUser(a.tenantId, ap.filedByEmployeeId)], kind: "ER_CASE", title: `Your appeal on ${erRef(ap.case.number)} was ${a.decision.toLowerCase()}`, link: "/me/cases", email: true });
  return { ok: true, message: `Appeal ${a.decision.toLowerCase()}.` };
}

// ---------------------------------------------------------------------------
//  Resolution and closure
// ---------------------------------------------------------------------------

export async function proposeResolution(a: Actor & { caseId: string; employeeId: string | null; outcome: string; resolution: string }): Promise<R & { requestId?: string }> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId }, include: { actions: true, appeals: true, investigation: true } });
  if (!c) return { ok: false, message: "Case not found." };
  if (["RESOLVED", "CLOSED"].includes(c.status)) return { ok: false, message: "The case is already resolved." };
  if (c.resolutionStatus === "PENDING") return { ok: false, message: "A resolution is already awaiting approval." };
  if (!(a.outcome in ER_OUTCOMES)) return { ok: false, message: "Pick an outcome." };
  if (a.resolution.trim().length < 20) return { ok: false, message: "Describe the resolution (at least 20 characters)." };
  if (c.actions.some((x) => x.status === "PENDING_APPROVAL")) return { ok: false, message: "An action is still awaiting approval." };
  if (c.appeals.some((x) => x.status === "FILED" || x.status === "UNDER_REVIEW")) return { ok: false, message: "An appeal is still open." };
  if (c.investigation && c.investigation.status === "FINDINGS_SUBMITTED") return { ok: false, message: "The investigation findings are still awaiting sign-off." };
  if (a.outcome === "ACTION_TAKEN" && !c.actions.some((x) => x.status === "ISSUED")) return { ok: false, message: "No action has been issued on this case." };
  const { startWorkflow } = await import("./workflow-engine");
  await prisma.erCase.update({ where: { id: c.id }, data: { resolutionStatus: "PENDING", outcome: a.outcome, resolution: a.resolution.trim() } });
  const res = await startWorkflow({ tenantId: a.tenantId, entityType: "ER_RESOLUTION", entityId: c.id, title: `Resolve ${erRef(c.number)}: ${ER_OUTCOMES[a.outcome as keyof typeof ER_OUTCOMES]}`, details: a.resolution.trim().slice(0, 500), requesterUserId: a.userId, subjectEmployeeId: a.employeeId, category: c.kind, data: { link: `/relations/${c.id}` } });
  if (!res.ok) { await prisma.erCase.update({ where: { id: c.id }, data: { resolutionStatus: c.resolutionStatus, outcome: c.outcome, resolution: c.resolution } }); return res; }
  await prisma.erCase.update({ where: { id: c.id }, data: { resolutionRequestId: res.requestId } });
  await prisma.erCaseNote.create({ data: { tenantId: a.tenantId, caseId: c.id, kind: "SYSTEM", body: `Resolution proposed by ${a.label}: ${ER_OUTCOMES[a.outcome as keyof typeof ER_OUTCOMES]}`, authorUserId: a.userId, authorLabel: a.label } });
  return { ok: true, requestId: res.requestId, message: "Resolution sent for approval." };
}

export async function applyResolutionDecision(tenantId: string, caseId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const c = await prisma.erCase.findFirst({ where: { id: caseId, tenantId } });
  if (!c || c.resolutionStatus !== "PENDING") return;
  const approved = outcome === "APPROVED";
  await prisma.$transaction(async (tx) => {
    await tx.erCase.update({ where: { id: c.id }, data: approved ? { resolutionStatus: "APPROVED", status: "RESOLVED", resolvedAt: new Date() } : { resolutionStatus: outcome === "REJECTED" ? "REJECTED" : "NONE" } });
    await note(tx, tenantId, c.id, "SYSTEM", approved ? `Resolution approved: ${ER_OUTCOMES[c.outcome as keyof typeof ER_OUTCOMES] ?? c.outcome}` : `Resolution ${outcome.toLowerCase()}`, actorUserId, "Approvals");
    if (approved && (c.reporterEmployeeId || c.isAnonymous)) await note(tx, tenantId, c.id, "REPORTER", `Your case has been resolved: ${ER_OUTCOMES[c.outcome as keyof typeof ER_OUTCOMES] ?? c.outcome}.`, actorUserId, "HR");
  });
  await notify({ tenantId, userIds: [c.ownerUserId, approved ? await employeeUser(tenantId, c.reporterEmployeeId) : null], kind: "ER_CASE", title: `${erRef(c.number)} ${approved ? "resolved" : `resolution ${outcome.toLowerCase()}`}`, link: approved && c.reporterEmployeeId ? "/me/cases" : `/relations/${c.id}` });
}

export async function closeErCase(a: Actor & { caseId: string }): Promise<R> {
  const c = await prisma.erCase.findFirst({ where: { id: a.caseId, tenantId: a.tenantId } });
  if (!c) return { ok: false, message: "Case not found." };
  if (c.status !== "RESOLVED") return { ok: false, message: "Only a resolved case can be closed." };
  const settings = await getErSettings(a.tenantId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.erCase.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: now, retainUntil: cdAddMonths(now, settings.retentionMonths) } });
    await note(tx, a.tenantId, c.id, "SYSTEM", `Closed by ${a.label}; kept until ${cdAddMonths(now, settings.retentionMonths).toISOString().slice(0, 10)}`, a.userId, a.label);
  });
  return { ok: true, message: "Case closed." };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export async function erDashboard(where: Prisma.ErCaseWhereInput, now = new Date()) {
  const cases = await prisma.erCase.findMany({ where, select: { id: true, kind: true, category: true, status: true, severity: true, createdAt: true, resolvedAt: true, outcome: true } });
  const open = cases.filter((c) => !["RESOLVED", "CLOSED"].includes(c.status));
  const resolved = cases.filter((c) => c.resolvedAt);
  const avgDays = resolved.length ? Math.round(resolved.reduce((a, c) => a + (c.resolvedAt!.getTime() - c.createdAt.getTime()) / DAY, 0) / resolved.length) : null;
  const count = <K extends string>(rows: typeof cases, key: (c: (typeof cases)[number]) => K) => rows.reduce((m, c) => m.set(key(c), (m.get(key(c)) ?? 0) + 1), new Map<K, number>());
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
  const trend = months.map((m) => ({ month: m, GRIEVANCE: 0, COMPLAINT: 0, DISCIPLINARY: 0, ...Object.fromEntries([...count(cases.filter((c) => c.createdAt.toISOString().slice(0, 7) === m), (c) => c.kind)]) }));
  return {
    total: cases.length, open: open.length, critical: open.filter((c) => c.severity === "CRITICAL" || c.severity === "HIGH").length, avgDaysToResolve: avgDays,
    byKind: count(cases, (c) => c.kind), byCategory: count(cases, (c) => c.category), byStatus: count(cases, (c) => c.status), byOutcome: count(resolved, (c) => c.outcome ?? "—"), trend,
  };
}

export async function activeSuspensions(tenantId: string, on = new Date()) {
  return prisma.erAction.findMany({ where: { tenantId, actionType: "SUSPENSION", status: "ISSUED", suspensionFrom: { lte: on }, suspensionTo: { gte: cdUtcDay(on) } }, include: { case: { select: { number: true, id: true } } } });
}
