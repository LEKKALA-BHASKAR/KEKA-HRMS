"use server";

import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee, type Permission } from "@keka/rbac";
import { generateLetter, decideLetter, acknowledgeLetter, signLetter, voidLetter, saveLetterTemplate, usersWithPermission } from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { saveFile, sniffUpload } from "@/lib/storage";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/** HR letters: templates, generation, approval, acknowledgement and e-signature. */

const EMP_SELECT = { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } as const;

async function inScope(viewer: Awaited<ReturnType<typeof requireAuth>>, employeeId: string, perm: Permission) {
  const t = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: EMP_SELECT });
  return !!t && canAccessEmployee(viewer, t, perm);
}

async function letterInScope(viewer: Awaited<ReturnType<typeof requireAuth>>, id: string, perm: Permission) {
  const doc = await prisma.generatedDocument.findFirst({ where: { id, employee: { tenantId: viewer.tenantId } }, select: { id: true, employeeId: true } });
  return doc && (await inScope(viewer, doc.employeeId, perm)) ? doc : null;
}

function dateField(fd: FormData, k: string): Date | null {
  const s = String(fd.get(k) ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
}

export async function saveLetterTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_TEMPLATE_MANAGE);
  const res = await saveLetterTemplate({
    tenantId: viewer.tenantId, id: String(formData.get("id") ?? "") || null, name: String(formData.get("name") ?? ""),
    category: String(formData.get("category") ?? "CUSTOM"), body: String(formData.get("body") ?? ""), workflow: String(formData.get("workflow") ?? ""),
    archived: formData.get("archived") === "on",
    userId: viewer.user.id, ownerUserId: String(formData.get("ownerUserId") ?? "") || undefined,
    departmentIds: formData.has("departmentScope") ? formData.getAll("departmentIds").map(String).filter(Boolean) : undefined,
    archivedReason: String(formData.get("archivedReason") ?? "") || null,
  });
  if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string> };
  await writeAudit(viewer, { module: "EMPLOYEE", action: formData.get("id") ? "UPDATE" : "CREATE", entityType: "DocumentTemplate", entityId: res.id, summary: res.message });
  return done(["/documents", `/documents/templates/${res.id}`], res.message);
}

export async function generateLetterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LETTER_GENERATE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!employeeId) return { ok: false, message: "Pick an employee." };
  if (!(await inScope(viewer, employeeId, P.LETTER_GENERATE))) return { ok: false, message: "That employee is outside your scope." };
  const res = await generateLetter({
    tenantId: viewer.tenantId, templateId: String(formData.get("templateId") ?? ""), employeeId,
    issuedByEmployeeId: viewer.employee?.id ?? null, issuedByUserId: viewer.user.id,
    approverUserIds: await usersWithPermission(viewer.tenantId, P.DOCUMENT_TEMPLATE_MANAGE),
    issuedOn: dateField(formData, "issuedOn"), validUntil: dateField(formData, "validUntil"),
  });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "GeneratedDocument", entityId: res.id, summary: res.message });
  return done(["/documents", `/employees/${employeeId}`], res.message);
}

export async function decideLetterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_TEMPLATE_MANAGE);
  const doc = await letterInScope(viewer, String(formData.get("id") ?? ""), P.LETTER_GENERATE);
  if (!doc) return { ok: false, message: "Letter not found." };
  const approve = formData.get("decision") === "approve";
  const res = await decideLetter({ tenantId: viewer.tenantId, id: doc.id, userId: viewer.user.id, approve, note: String(formData.get("note") ?? "") || null });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: approve ? "APPROVE" : "REJECT", entityType: "GeneratedDocument", entityId: doc.id, summary: res.message });
  return done(["/documents", `/documents/letters/${doc.id}`], res.message);
}

export async function voidLetterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LETTER_GENERATE);
  const doc = await letterInScope(viewer, String(formData.get("id") ?? ""), P.LETTER_GENERATE);
  if (!doc) return { ok: false, message: "Letter not found." };
  const res = await voidLetter({ tenantId: viewer.tenantId, id: doc.id, reason: String(formData.get("reason") ?? "") });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "GeneratedDocument", entityId: doc.id, summary: res.message });
  return done(["/documents", `/documents/letters/${doc.id}`], res.message);
}

export async function acknowledgeLetterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can acknowledge letters." };
  const id = String(formData.get("id") ?? "");
  const res = await acknowledgeLetter({ tenantId: viewer.tenantId, id, employeeId: viewer.employee.id });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "GeneratedDocument", entityId: id, summary: res.message });
  return done(["/documents", `/documents/letters/${id}`], res.message);
}

const MAX_SIGNATURE_BYTES = 300 * 1024;

export async function signLetterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can sign letters." };
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("signature") ?? "");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!m) return { ok: false, message: "Draw your signature in the box." };
  const data = Buffer.from(m[1]!, "base64");
  if (data.length > MAX_SIGNATURE_BYTES) return { ok: false, message: "That signature image is too large. Clear it and sign again." };
  const sniff = sniffUpload(data, "image/png");
  if (!sniff.ok || sniff.mimeType !== "image/png") return { ok: false, message: "Draw your signature in the box." };
  // Make sure the letter is theirs before keeping anything.
  const mine = await prisma.generatedDocument.findFirst({ where: { id, employeeId: viewer.employee.id, status: "PENDING_SIGNATURE" }, select: { id: true } });
  if (!mine) return { ok: false, message: "This letter is not awaiting your signature." };
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: `signature-${id}.png`, mimeType: "image/png", data, relatedType: "LetterSignature", relatedId: id, employeeId: viewer.employee.id, uploadedBy: viewer.user.id });
  const h = await headers();
  const res = await signLetter({
    tenantId: viewer.tenantId, id, employeeId: viewer.employee.id, typedName: String(formData.get("typedName") ?? ""), signatureFileId: stored.id,
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null, userAgent: h.get("user-agent"), consent: formData.get("consent") === "on",
  });
  if (!res.ok) {
    await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined);
    return res;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "GeneratedDocument", entityId: id, summary: res.message });
  return done(["/documents", `/documents/letters/${id}`], res.message);
}
