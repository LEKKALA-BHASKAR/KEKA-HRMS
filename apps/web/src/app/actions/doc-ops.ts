"use server";

import { headers } from "next/headers";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  snapshotEmployeeDocument, newOrgDocumentVersion, requestRenewal, requestFolderAccess, revokeFolderAccess, shareDocument, revokeShare, matchBulkFiles,
  createEnvelope, sendEnvelope, signEnvelope, declineEnvelope, delegateSignature, voidEnvelope, remindRecipients, myRecipient,
  saveLetterSettings, saveLetterSeries, generateLettersInBulk, saveLetterTrigger, resendLetter, submitTemplateForApproval, markTemplateReviewed,
  esRef,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload } from "@/lib/storage";
import { str, optStr, bool, int, day, DENIED, no, result, readUpload, readUploads } from "@/lib/cases-docs";

/**
 * Document operations: versions and renewals, confidential folder access
 * (approved through the workflow engine), time-limited shares, bulk upload;
 * multi-signer e-signature envelopes; HR letter operations (numbering,
 * bulk generation, automatic letters, resend, template approval and review).
 * Every id is re-read inside the viewer's tenant and every write audited.
 */

const P = PERMISSIONS;
const DOC_PATHS = ["/documents", "/documents/library"];
const ES_PATHS = ["/documents/esign", "/me/sign"];
const LT_PATHS = ["/documents", "/documents/letters-admin"];
const EMP = { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } as const;

async function docInScope(v: Viewer, documentId: string) {
  const d = await prisma.employeeDocument.findFirst({ where: { id: documentId, tenantId: v.tenantId }, include: { employee: { select: EMP } } });
  if (!d || !can(v, P.DOCUMENT_MANAGE) || !canAccessEmployee(v, d.employee, P.DOCUMENT_MANAGE)) return null;
  return d;
}
async function clientInfo() {
  const h = await headers();
  return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

export async function requestRenewalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const d = await docInScope(v, str(fd, "documentId"));
  if (!d) return DENIED;
  const r = await requestRenewal({ tenantId: v.tenantId, documentId: d.id, userId: v.user.id, note: optStr(fd, "note") });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeDocument", entityId: d.id, summary: `Renewal requested for ${d.name}` });
  return result(r, DOC_PATHS);
}

export async function requestFolderAccessAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_VIEW)) return DENIED;
  const r = await requestFolderAccess({ tenantId: v.tenantId, folderId: str(fd, "folderId"), userId: v.user.id, employeeId: v.employee?.id ?? null, reason: str(fd, "reason"), canEdit: bool(fd, "canEdit"), days: int(fd, "days") ?? 30 });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "CREATE", entityType: "DocumentFolderAccess", entityId: str(fd, "folderId"), summary: "Requested access to a confidential folder" });
  return result(r, [...DOC_PATHS, "/inbox"]);
}

export async function revokeFolderAccessAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_MANAGE)) return DENIED;
  const r = await revokeFolderAccess({ tenantId: v.tenantId, accessId: str(fd, "accessId") });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "DELETE", entityType: "DocumentFolderAccess", entityId: str(fd, "accessId"), summary: "Revoked a confidential folder grant" });
  return result(r, DOC_PATHS);
}

export async function shareDocumentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const d = await docInScope(v, str(fd, "documentId"));
  if (!d) return DENIED;
  const r = await shareDocument({ tenantId: v.tenantId, documentId: d.id, withUserId: str(fd, "userId"), days: int(fd, "days") ?? 7, allowDownload: fd.has("allowDownload") ? bool(fd, "allowDownload") : true, note: optStr(fd, "note"), byUserId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "CREATE", entityType: "DocumentShare", entityId: d.id, summary: `Shared ${d.name} for ${int(fd, "days") ?? 7} days` });
  return result(r, DOC_PATHS);
}

export async function revokeShareAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const s = await prisma.documentShare.findFirst({ where: { id: str(fd, "shareId"), tenantId: v.tenantId } });
  if (!s || (s.sharedByUserId !== v.user.id && !can(v, P.DOCUMENT_MANAGE))) return DENIED;
  const r = await revokeShare({ tenantId: v.tenantId, shareId: s.id });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "DELETE", entityType: "DocumentShare", entityId: s.id, summary: "Document share revoked" });
  return result(r, DOC_PATHS);
}

/**
 * Bulk upload: files named by employee number ("ACM0009_passport.pdf") go
 * into that employee's slot for one document type. Earlier files are kept as
 * versions. Unmatched or out-of-scope files are reported, not stored.
 */
export async function bulkUploadAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_MANAGE)) return DENIED;
  const type = await prisma.documentType.findFirst({ where: { id: str(fd, "documentTypeId"), folder: { tenantId: v.tenantId } } });
  if (!type) return no("Pick the document type.");
  const up = await readUploads(fd, "files", 50);
  if ("error" in up) return no(up.error);
  if (!up.files.length) return no("Choose the files to upload.");
  const expiresOn = day(fd, "expiresOn");
  const matches = await matchBulkFiles(v.tenantId, up.files.map((f) => f.name));
  const results: Array<{ file: string; employeeNumber: string | null; ok: boolean; message: string }> = [];
  for (let i = 0; i < up.files.length; i++) {
    const f = up.files[i]!, m = matches[i]!;
    if (!m.employee) { results.push({ file: f.name, employeeNumber: m.employeeNumber, ok: false, message: m.employeeNumber ? `No employee ${m.employeeNumber}` : "Name does not start with an employee number" }); continue; }
    if (!canAccessEmployee(v, m.employee, P.DOCUMENT_MANAGE)) { results.push({ file: f.name, employeeNumber: m.employeeNumber, ok: false, message: "Outside your scope" }); continue; }
    const stored = await saveFile({ tenantId: v.tenantId, filename: f.name, mimeType: f.type, data: f.data, relatedType: "EmployeeDocument", employeeId: m.employee.id, uploadedBy: v.user.id });
    const existing = type.allowMultiple ? null : await prisma.employeeDocument.findFirst({ where: { tenantId: v.tenantId, employeeId: m.employee.id, documentTypeId: type.id }, orderBy: { createdAt: "desc" } });
    const data = {
      fileUrl: `/files/${stored.id}`, fileSize: f.data.length, mimeType: f.type, uploadedBy: v.user.id, uploadedAt: new Date(),
      status: type.requireVerification ? "PENDING_VERIFICATION" as const : "VERIFIED" as const, ...(type.requireVerification ? { verifiedAt: null, verifiedBy: null } : { verifiedAt: new Date(), verifiedBy: v.user.id }),
      rejectReason: null, expiryNoticeStage: 0, ...(expiresOn ? { expiresOn } : {}),
    };
    const doc = await prisma.$transaction(async (tx) => {
      if (existing) {
        if (existing.fileUrl) await snapshotEmployeeDocument(existing.id, "Replaced by bulk upload", tx);
        return tx.employeeDocument.update({ where: { id: existing.id }, data });
      }
      return tx.employeeDocument.create({ data: { tenantId: v.tenantId, employeeId: m.employee!.id, folderId: type.folderId, documentTypeId: type.id, name: type.name, ...data } });
    });
    await prisma.storedFile.update({ where: { id: stored.id }, data: { relatedId: doc.id } });
    results.push({ file: f.name, employeeNumber: m.employeeNumber, ok: true, message: existing ? "Replaced (earlier file kept as a version)" : "Added" });
  }
  const matched = results.filter((r) => r.ok).length;
  const batch = await prisma.documentBulkUpload.create({ data: { tenantId: v.tenantId, documentTypeId: type.id, total: results.length, matched, failed: results.length - matched, results: results as unknown as Prisma.InputJsonValue, createdByUserId: v.user.id } });
  await writeAudit(v, { module: "EMPLOYEE", action: "CREATE", entityType: "DocumentBulkUpload", entityId: batch.id, summary: `Bulk upload of ${type.name}: ${matched} of ${results.length} files filed` });
  return result({ ok: matched > 0, message: `Filed ${matched} of ${results.length} file${results.length === 1 ? "" : "s"}.${results.length - matched ? " See the upload log for the rest." : ""}` }, DOC_PATHS);
}

// ---------------------------------------------------------------------------
//  E-signature
// ---------------------------------------------------------------------------

const canSend = (v: Viewer) => canAny(v, [P.DOCUMENT_MANAGE, P.LETTER_GENERATE]);

export async function createEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canSend(v)) return DENIED;
  const letterId = optStr(fd, "letterId");
  if (letterId) {
    const l = await prisma.generatedDocument.findFirst({ where: { id: letterId, employee: { tenantId: v.tenantId } }, include: { employee: { select: EMP } } });
    if (!l || !canAccessEmployee(v, l.employee, P.LETTER_GENERATE)) return no("Letter not found.");
  }
  const up = letterId ? null : await readUpload(fd, "file");
  if (up && "error" in up) return no(up.error);
  if (!letterId && !up) return no("Attach the PDF to sign or pick a letter.");
  if (up && up.type !== "application/pdf") return no("Upload the document as a PDF.");
  const stored = up ? await saveFile({ tenantId: v.tenantId, filename: up.name, mimeType: up.type, data: up.data, relatedType: "SignatureEnvelope", uploadedBy: v.user.id }) : null;
  const users = formList(fd, "recipientUserId"), roles = formList(fd, "recipientRole"), orders = formList(fd, "recipientOrder");
  const recipients = users.map((userId, i) => ({ userId, role: roles[i] || "SIGNER", order: Number(orders[i]) || i + 1 })).filter((r) => r.userId);
  const remind = int(fd, "reminderEveryDays");
  const r = await createEnvelope({
    tenantId: v.tenantId, userId: v.user.id, title: str(fd, "title"), message: optStr(fd, "message"), fileId: stored?.id ?? null, letterId,
    sequential: str(fd, "sequential") !== "false", recipients, reminderEveryDays: remind === null ? null : remind, expiresOn: day(fd, "expiresOn"),
  });
  if (!r.ok) { if (stored) await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined); return no(r.message); }
  if (stored) await prisma.storedFile.update({ where: { id: stored.id }, data: { relatedId: r.id } });
  await writeAudit(v, { module: "EMPLOYEE", action: "CREATE", entityType: "SignatureEnvelope", entityId: r.id, summary: `Envelope ${esRef(r.number!)} "${str(fd, "title")}" created with ${recipients.length} recipients` });
  if (bool(fd, "sendNow")) {
    const s = await sendEnvelope({ tenantId: v.tenantId, id: r.id!, userId: v.user.id });
    if (s.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "SignatureEnvelope", entityId: r.id, summary: `Envelope ${esRef(r.number!)} sent for signature` });
    return { ...result(s, ES_PATHS), values: { id: r.id! } };
  }
  return { ...result(r, ES_PATHS), values: { id: r.id! } };
}

async function myEnvelope(v: Viewer, id: string) {
  return prisma.signatureEnvelope.findFirst({ where: { id, tenantId: v.tenantId } });
}

export async function sendEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e || (e.createdByUserId !== v.user.id && !can(v, P.DOCUMENT_MANAGE))) return DENIED;
  const r = await sendEnvelope({ tenantId: v.tenantId, id: e.id, userId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "SignatureEnvelope", entityId: e.id, summary: `Envelope ${esRef(e.number)} sent for signature` });
  return result(r, [...ES_PATHS, `/documents/esign/${e.id}`]);
}

export async function remindEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e || (e.createdByUserId !== v.user.id && !can(v, P.DOCUMENT_MANAGE))) return DENIED;
  const r = await remindRecipients({ tenantId: v.tenantId, envelopeId: e.id, userId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "SignatureEnvelope", entityId: e.id, summary: `Reminded pending signers of ${esRef(e.number)}` });
  return result(r, [`/documents/esign/${e.id}`]);
}

export async function voidEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e || (e.createdByUserId !== v.user.id && !can(v, P.DOCUMENT_MANAGE))) return DENIED;
  const r = await voidEnvelope({ tenantId: v.tenantId, envelopeId: e.id, userId: v.user.id, reason: str(fd, "reason") });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "SignatureEnvelope", entityId: e.id, summary: `Envelope ${esRef(e.number)} voided: ${str(fd, "reason")}` });
  return result(r, [...ES_PATHS, `/documents/esign/${e.id}`]);
}

const MAX_SIGNATURE_BYTES = 300 * 1024;

export async function signEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e) return no("Envelope not found.");
  const me = await myRecipient(v.tenantId, e.id, v.user.id);
  if (!me) return DENIED;
  let signatureFileId: string | null = null;
  if (me.role === "SIGNER") {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(str(fd, "signature"));
    if (!m) return no("Draw your signature in the box.");
    const data = Buffer.from(m[1]!, "base64");
    if (data.length > MAX_SIGNATURE_BYTES) return no("That signature image is too large. Clear it and sign again.");
    const sniff = sniffUpload(data, "image/png");
    if (!sniff.ok || sniff.mimeType !== "image/png") return no("Draw your signature in the box.");
    signatureFileId = (await saveFile({ tenantId: v.tenantId, filename: `signature-${esRef(e.number)}.png`, mimeType: "image/png", data, relatedType: "SignatureEnvelope", relatedId: e.id, uploadedBy: v.user.id })).id;
  }
  const info = await clientInfo();
  const r = await signEnvelope({ tenantId: v.tenantId, envelopeId: e.id, userId: v.user.id, typedName: str(fd, "typedName"), signatureFileId, consent: bool(fd, "consent"), ...info });
  if (!r.ok) { if (signatureFileId) await prisma.storedFile.delete({ where: { id: signatureFileId } }).catch(() => undefined); return no(r.message); }
  await writeAudit(v, { module: "EMPLOYEE", action: "APPROVE", entityType: "SignatureEnvelope", entityId: e.id, summary: `${me.role === "APPROVER" ? "Approved" : "Signed"} ${esRef(e.number)}${r.completed ? " (envelope completed)" : ""}` });
  return result(r, [...ES_PATHS, `/documents/esign/${e.id}`]);
}

export async function declineEnvelopeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e) return no("Envelope not found.");
  const r = await declineEnvelope({ tenantId: v.tenantId, envelopeId: e.id, userId: v.user.id, reason: str(fd, "reason"), ip: (await clientInfo()).ip });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "REJECT", entityType: "SignatureEnvelope", entityId: e.id, summary: `Declined to sign ${esRef(e.number)}: ${str(fd, "reason")}` });
  return result(r, [...ES_PATHS, `/documents/esign/${e.id}`]);
}

export async function delegateSignatureAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await myEnvelope(v, str(fd, "id"));
  if (!e) return no("Envelope not found.");
  const r = await delegateSignature({ tenantId: v.tenantId, envelopeId: e.id, userId: v.user.id, toUserId: str(fd, "toUserId"), reason: str(fd, "reason") });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "SignatureEnvelope", entityId: e.id, summary: `Delegated signing of ${esRef(e.number)}` });
  return result(r, [...ES_PATHS, `/documents/esign/${e.id}`]);
}

// ---------------------------------------------------------------------------
//  HR letters
// ---------------------------------------------------------------------------

export async function saveLetterSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_TEMPLATE_MANAGE)) return DENIED;
  const r = await saveLetterSettings({ tenantId: v.tenantId, requireTemplateApproval: bool(fd, "requireTemplateApproval"), reviewEveryMonths: int(fd, "reviewEveryMonths") ?? 12, maxBackdateDays: int(fd, "maxBackdateDays") ?? 30 });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "LetterSettings", summary: `Letter settings: approval ${bool(fd, "requireTemplateApproval") ? "required" : "not required"}, review every ${int(fd, "reviewEveryMonths") ?? 12} months` });
  return result(r, LT_PATHS);
}

export async function saveLetterSeriesAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_TEMPLATE_MANAGE)) return DENIED;
  const r = await saveLetterSeries({
    tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), category: optStr(fd, "category"), prefix: str(fd, "prefix"), digits: int(fd, "digits") ?? 4,
    nextNumber: int(fd, "nextNumber") ?? 1, yearlyReset: bool(fd, "yearlyReset"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true,
  });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "LetterNumberSeries", entityId: r.id, summary: `Letter number series "${str(fd, "name")}" saved${r.preview ? ` (next ${r.preview})` : ""}` });
  return result(r, LT_PATHS);
}

export async function bulkLettersAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LETTER_GENERATE)) return DENIED;
  const ids = formList(fd, "employeeIds");
  const emps = await prisma.employee.findMany({ where: { tenantId: v.tenantId, id: { in: ids } }, select: EMP });
  const allowed = emps.filter((e) => canAccessEmployee(v, e, P.LETTER_GENERATE)).map((e) => e.id);
  if (allowed.length < ids.length) return no(`${ids.length - allowed.length} of the people you picked are outside your scope.`);
  const r = await generateLettersInBulk({ tenantId: v.tenantId, templateId: str(fd, "templateId"), employeeIds: allowed, issuedByEmployeeId: v.employee?.id ?? null, issuedByUserId: v.user.id, issuedOn: day(fd, "issuedOn"), validUntil: day(fd, "validUntil") });
  if (r.batchId) await writeAudit(v, { module: "EMPLOYEE", action: "CREATE", entityType: "LetterBatch", entityId: r.batchId, summary: r.message });
  return result(r, LT_PATHS);
}

export async function saveLetterTriggerAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_TEMPLATE_MANAGE)) return DENIED;
  const r = await saveLetterTrigger({ tenantId: v.tenantId, event: str(fd, "event"), templateId: str(fd, "templateId"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "LetterTrigger", summary: `Automatic letter on ${str(fd, "event")} ${fd.has("isActive") && !bool(fd, "isActive") ? "paused" : "set"}` });
  return result(r, LT_PATHS);
}

export async function resendLetterAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.LETTER_GENERATE)) return DENIED;
  const l = await prisma.generatedDocument.findFirst({ where: { id: str(fd, "id"), employee: { tenantId: v.tenantId } }, include: { employee: { select: EMP } } });
  if (!l || !canAccessEmployee(v, l.employee, P.LETTER_GENERATE)) return no("Letter not found.");
  const r = await resendLetter({ tenantId: v.tenantId, id: l.id });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "GeneratedDocument", entityId: l.id, summary: `Letter ${l.letterNumber ?? l.id} resent to the employee` });
  return result(r, [...LT_PATHS, `/documents/letters/${l.id}`]);
}

export async function submitTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_TEMPLATE_MANAGE)) return DENIED;
  const r = await submitTemplateForApproval({ tenantId: v.tenantId, id: str(fd, "id"), userId: v.user.id, employeeId: v.employee?.id ?? null });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "DocumentTemplate", entityId: str(fd, "id"), summary: "Letter template submitted for approval" });
  return result(r, [...LT_PATHS, `/documents/templates/${str(fd, "id")}`, "/inbox"]);
}

export async function reviewTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await prisma.documentTemplate.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!t || (t.ownerUserId !== v.user.id && !can(v, P.DOCUMENT_TEMPLATE_MANAGE))) return DENIED;
  const r = await markTemplateReviewed({ tenantId: v.tenantId, id: t.id, userId: v.user.id, canManage: can(v, P.DOCUMENT_TEMPLATE_MANAGE) });
  if (r.ok) await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "DocumentTemplate", entityId: t.id, summary: `Template "${t.name}" reviewed by its owner` });
  return result(r, [...LT_PATHS, `/documents/templates/${t.id}`]);
}

/** A template's owner (who reviews it) and the departments allowed to use it (none = everyone). */
export async function templateGovernanceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_TEMPLATE_MANAGE)) return DENIED;
  const t = await prisma.documentTemplate.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!t) return no("Template not found.");
  const owner = optStr(fd, "ownerUserId");
  if (owner && !(await prisma.user.count({ where: { id: owner, tenantId: v.tenantId } }))) return no("Owner not found.");
  const departmentIds = formList(fd, "departmentIds");
  if (departmentIds.length && (await prisma.department.count({ where: { id: { in: departmentIds }, tenantId: v.tenantId } })) !== departmentIds.length) return no("Department not found.");
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { ownerUserId: owner, departmentIds } });
  await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "DocumentTemplate", entityId: t.id, summary: `Template "${t.name}": owner and department scope set${departmentIds.length ? ` (${departmentIds.length} departments)` : " (all departments)"}` });
  return result({ ok: true, message: "Saved." }, [...LT_PATHS, `/documents/templates/${t.id}`]);
}

/** Publish a new version of a company policy; the old file stays in its history. */
export async function newPolicyVersionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.DOCUMENT_MANAGE)) return DENIED;
  const d = await prisma.orgDocument.findFirst({ where: { id: str(fd, "documentId"), tenantId: v.tenantId } });
  if (!d) return no("Policy not found.");
  const up = await readUpload(fd, "file");
  if (!up) return no("Attach the new file.");
  if ("error" in up) return no(up.error);
  const stored = await saveFile({ tenantId: v.tenantId, filename: up.name, mimeType: up.type, data: up.data, relatedType: "PolicyDocument", relatedId: d.id, uploadedBy: v.user.id });
  const r = await newOrgDocumentVersion({ tenantId: v.tenantId, documentId: d.id, fileUrl: `/files/${stored.id}`, fileSize: up.data.length, mimeType: up.type, versionLabel: str(fd, "versionLabel"), effectiveFrom: day(fd, "effectiveFrom"), userId: v.user.id, resetAcks: bool(fd, "resetAcks"), note: optStr(fd, "note") });
  if (!r.ok) { await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined); return no(r.message); }
  await writeAudit(v, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgDocument", entityId: d.id, summary: `Policy "${d.title}" moved to version ${str(fd, "versionLabel")}` });
  return result(r, DOC_PATHS);
}
