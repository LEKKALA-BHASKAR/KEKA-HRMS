"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Upload a file into a document slot. Employees upload their own; HR with
 * document management can upload for people in their scope. The file is
 * judged by its bytes, not its name, and stored outside the web root.
 */
export async function uploadDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const documentId = String(formData.get("documentId") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a file to upload.", errors: { file: "Required" } };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB.", errors: { file: "Too large" } };

  const doc = await prisma.employeeDocument.findFirst({
    where: { id: documentId, tenantId: viewer.tenantId },
    include: {
      documentType: { select: { requireVerification: true } },
      employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } },
    },
  });
  if (!doc) return { ok: false, message: "Document not found." };
  const own = doc.employeeId === viewer.employee?.id;
  if (!own && !(can(viewer, P.DOCUMENT_MANAGE) && canAccessEmployee(viewer, doc.employee, P.DOCUMENT_MANAGE))) {
    return { ok: false, message: "You cannot upload to someone else's record." };
  }
  if (doc.status === "VERIFIED" && own) return { ok: false, message: "This document is already verified. Ask HR if it needs replacing." };

  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok) return { ok: false, message: sniff.reason, errors: { file: sniff.reason } };

  const stored = await saveFile({
    tenantId: viewer.tenantId, filename: file.name || `${doc.name}.pdf`, mimeType: sniff.mimeType, data,
    relatedType: "EmployeeDocument", relatedId: doc.id, employeeId: doc.employeeId, uploadedBy: viewer.user.id,
  });
  const expiresRaw = String(formData.get("expiresOn") ?? "");
  const needsCheck = doc.documentType?.requireVerification ?? true;
  await prisma.employeeDocument.update({
    where: { id: doc.id },
    data: {
      fileUrl: `/files/${stored.id}`, fileSize: data.length, mimeType: sniff.mimeType,
      status: needsCheck ? "PENDING_VERIFICATION" : "VERIFIED",
      uploadedBy: viewer.user.id, uploadedAt: new Date(), rejectReason: null,
      ...(needsCheck ? { verifiedAt: null, verifiedBy: null } : { verifiedAt: new Date() }),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? { expiresOn: new Date(`${expiresRaw}T00:00:00Z`) } : {}),
    },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeDocument", entityId: doc.id, summary: `Uploaded ${doc.name} (${Math.round(data.length / 1024)} KB)` });
  return done(["/documents", `/employees/${doc.employeeId}`], needsCheck ? "Uploaded. HR will verify it." : "Uploaded.");
}
