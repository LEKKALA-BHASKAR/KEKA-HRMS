import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { expiryStage, documentCompleteness, employeeNumberFromFilename, cdAddDays } from "./cases-docs-math";

/**
 * Document operations: version history for employee and policy documents,
 * expiry notices and renewal requests, named access to confidential folders
 * (requested and approved through the workflow engine), time-limited shares
 * of a single document, matching files to employees for bulk upload, and
 * completeness of each employee's mandatory documents.
 */

type R = { ok: boolean; message: string };
const VERIFY = "document.employee.verify";

// ---------------------------------------------------------------------------
//  Versions
// ---------------------------------------------------------------------------

async function nextVersion(tx: Prisma.TransactionClient, kind: string, documentId: string): Promise<number> {
  const last = await tx.documentVersion.aggregate({ where: { documentKind: kind, documentId }, _max: { version: true } });
  return (last._max.version ?? 0) + 1;
}

/** Keep the current file of an employee document before it is replaced. */
export async function snapshotEmployeeDocument(documentId: string, note: string | null, tx: Prisma.TransactionClient = prisma): Promise<number | null> {
  const d = await tx.employeeDocument.findUnique({ where: { id: documentId } });
  if (!d || !d.fileUrl) return null;
  const version = await nextVersion(tx, "EMPLOYEE", d.id);
  await tx.documentVersion.create({
    data: {
      tenantId: d.tenantId, documentKind: "EMPLOYEE", documentId: d.id, version, fileUrl: d.fileUrl, fileSize: d.fileSize, mimeType: d.mimeType,
      issuedOn: d.issuedOn, expiresOn: d.expiresOn, status: d.status, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt, note,
    },
  });
  return version;
}

/** Publish a new version of a policy document; acknowledgements start again when it must be re-acknowledged. */
export async function newOrgDocumentVersion(input: { tenantId: string; documentId: string; fileUrl: string; fileSize: number; mimeType: string; versionLabel: string; effectiveFrom: Date | null; userId: string; resetAcks: boolean; note?: string | null }): Promise<R> {
  const d = await prisma.orgDocument.findFirst({ where: { id: input.documentId, tenantId: input.tenantId }, include: { _count: { select: { acknowledgements: true } } } });
  if (!d) return { ok: false, message: "Document not found." };
  const label = input.versionLabel.trim();
  if (!label) return { ok: false, message: "Label the new version (e.g. 2.0)." };
  if (label === d.version) return { ok: false, message: `This is already version ${label}.` };
  await prisma.$transaction(async (tx) => {
    const version = await nextVersion(tx, "ORG", d.id);
    await tx.documentVersion.create({
      data: { tenantId: input.tenantId, documentKind: "ORG", documentId: d.id, version, fileUrl: d.fileUrl, label: d.version, issuedOn: d.effectiveFrom, uploadedAt: d.updatedAt, note: `${d._count.acknowledgements} acknowledgement(s) on this version${input.note ? ` · ${input.note}` : ""}` },
    });
    await tx.orgDocument.update({ where: { id: d.id }, data: { fileUrl: input.fileUrl, version: label, effectiveFrom: input.effectiveFrom ?? new Date() } });
    if (input.resetAcks && d.requireAck) await tx.orgDocumentAck.deleteMany({ where: { documentId: d.id } });
  });
  if (input.resetAcks && d.requireAck) {
    const users = (await prisma.employee.findMany({ where: { tenantId: input.tenantId, status: { not: "EXITED" }, userId: { not: null } }, select: { userId: true } })).map((e) => e.userId);
    await notify({ tenantId: input.tenantId, userIds: users, kind: "DOCUMENT", title: `Updated policy: ${d.title} v${label} — please acknowledge`, link: "/documents?tab=policies" });
  }
  return { ok: true, message: `Published version ${label}.${input.resetAcks && d.requireAck ? " Everyone has been asked to acknowledge it again." : ""}` };
}

export async function documentVersions(tenantId: string, kind: "EMPLOYEE" | "ORG", documentId: string) {
  return prisma.documentVersion.findMany({ where: { tenantId, documentKind: kind, documentId }, orderBy: { version: "desc" } });
}

// ---------------------------------------------------------------------------
//  Expiry and renewal
// ---------------------------------------------------------------------------

export async function requestRenewal(input: { tenantId: string; documentId: string; userId: string; note?: string | null }): Promise<R> {
  const d = await prisma.employeeDocument.findFirst({ where: { id: input.documentId, tenantId: input.tenantId }, include: { employee: { select: { userId: true } } } });
  if (!d) return { ok: false, message: "Document not found." };
  if (!d.expiresOn) return { ok: false, message: "This document does not expire." };
  if (d.status === "PENDING_ON_EMPLOYEE") return { ok: false, message: "A renewal has already been requested." };
  await prisma.$transaction(async (tx) => {
    await snapshotEmployeeDocument(d.id, `Superseded by a renewal request${input.note ? `: ${input.note}` : ""}`, tx);
    await tx.employeeDocument.update({ where: { id: d.id }, data: { status: "PENDING_ON_EMPLOYEE", renewalRequestedAt: new Date(), rejectReason: input.note?.trim() || "Please upload the renewed document", verifiedAt: null, verifiedBy: null } });
  });
  await notify({ tenantId: input.tenantId, userIds: [d.employee.userId], kind: "DOCUMENT", title: `Please upload your renewed ${d.name}`, body: `It expires on ${d.expiresOn.toISOString().slice(0, 10)}.`, link: "/documents?tab=mine", email: true });
  return { ok: true, message: `Renewal requested for ${d.name}; the current file is kept in its history.` };
}

/**
 * Nightly: tell the employee and the verifiers at 30 days, 7 days and on
 * expiry (once each), and mark expired documents EXPIRED.
 */
export async function runDocumentExpiry(tenantId: string, now = new Date()): Promise<{ notices: number; expired: number }> {
  const docs = await prisma.employeeDocument.findMany({
    where: { tenantId, expiresOn: { not: null, lte: cdAddDays(now, 31) }, status: { notIn: ["NOT_APPLICABLE", "REJECTED"] }, employee: { status: { not: "EXITED" } } },
    include: { employee: { select: { userId: true, displayName: true } } },
  });
  const verifiers = await usersWithPermission(tenantId, VERIFY);
  let notices = 0, expired = 0;
  for (const d of docs) {
    const stage = expiryStage(d.expiresOn, now);
    if (stage <= d.expiryNoticeStage) continue;
    const days = Math.ceil((d.expiresOn!.getTime() - now.getTime()) / 86_400_000);
    const title = stage === 3 ? `${d.name} has expired` : `${d.name} expires in ${days} day${days === 1 ? "" : "s"}`;
    await prisma.employeeDocument.update({ where: { id: d.id }, data: { expiryNoticeStage: stage, ...(stage === 3 && d.status !== "PENDING_ON_EMPLOYEE" ? { status: "EXPIRED" } : {}) } });
    if (stage === 3 && d.status !== "PENDING_ON_EMPLOYEE") expired++;
    await notify({ tenantId, userIds: [d.employee.userId], kind: "DOCUMENT", title: `Your ${title.charAt(0).toLowerCase()}${title.slice(1)}`, body: "Upload the renewed document from Documents › My documents.", link: "/documents?tab=mine", email: true });
    await notify({ tenantId, userIds: verifiers, kind: "DOCUMENT", title: `${d.employee.displayName}: ${title}`, link: "/documents?tab=expiring" });
    notices++;
  }
  return { notices, expired };
}

// ---------------------------------------------------------------------------
//  Folder access and shares
// ---------------------------------------------------------------------------

export async function requestFolderAccess(input: { tenantId: string; folderId: string; userId: string; employeeId: string | null; reason: string; canEdit: boolean; days: number }): Promise<R & { requestId?: string }> {
  const f = await prisma.documentFolder.findFirst({ where: { id: input.folderId, tenantId: input.tenantId } });
  if (!f) return { ok: false, message: "Folder not found." };
  if (!f.isConfidential) return { ok: false, message: "This folder is not confidential; document permissions already cover it." };
  if (input.reason.trim().length < 10) return { ok: false, message: "Say why you need access (at least 10 characters)." };
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) return { ok: false, message: "Ask for 1 to 365 days." };
  const existing = await prisma.documentFolderAccess.findUnique({ where: { folderId_userId: { folderId: f.id, userId: input.userId } } });
  if (existing?.status === "PENDING") return { ok: false, message: "Your request is already awaiting approval." };
  if (existing?.status === "ACTIVE" && (!existing.expiresAt || existing.expiresAt > new Date())) return { ok: false, message: "You already have access." };
  const row = await prisma.documentFolderAccess.upsert({
    where: { folderId_userId: { folderId: f.id, userId: input.userId } },
    create: { tenantId: input.tenantId, folderId: f.id, userId: input.userId, canEdit: input.canEdit, status: "PENDING", reason: input.reason.trim(), expiresAt: cdAddDays(new Date(), input.days) },
    update: { canEdit: input.canEdit, status: "PENDING", reason: input.reason.trim(), expiresAt: cdAddDays(new Date(), input.days), grantedByUserId: null },
  });
  const { startWorkflow } = await import("./workflow-engine");
  const res = await startWorkflow({ tenantId: input.tenantId, entityType: "DOCUMENT_FOLDER_ACCESS", entityId: row.id, title: `Access to confidential folder "${f.name}"`, details: `${input.canEdit ? "View and edit" : "View"} for ${input.days} days: ${input.reason.trim()}`, requesterUserId: input.userId, subjectEmployeeId: input.employeeId, data: { link: "/documents/library" } });
  if (!res.ok) { await prisma.documentFolderAccess.update({ where: { id: row.id }, data: { status: "REJECTED" } }); return res; }
  await prisma.documentFolderAccess.update({ where: { id: row.id }, data: { workflowRequestId: res.requestId } });
  return { ok: true, requestId: res.requestId, message: res.message };
}

export async function applyFolderAccessDecision(tenantId: string, accessId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const a = await prisma.documentFolderAccess.findFirst({ where: { id: accessId, tenantId } });
  if (!a || a.status !== "PENDING") return;
  await prisma.documentFolderAccess.update({ where: { id: a.id }, data: outcome === "APPROVED" ? { status: "ACTIVE", grantedByUserId: actorUserId } : { status: "REJECTED" } });
  await notify({ tenantId, userIds: [a.userId], kind: "DOCUMENT", title: `Folder access ${outcome === "APPROVED" ? "granted" : outcome.toLowerCase()}`, link: "/documents/library" });
}

export async function revokeFolderAccess(input: { tenantId: string; accessId: string }): Promise<R> {
  const a = await prisma.documentFolderAccess.findFirst({ where: { id: input.accessId, tenantId: input.tenantId } });
  if (!a || a.status !== "ACTIVE") return { ok: false, message: "No active access to revoke." };
  await prisma.documentFolderAccess.update({ where: { id: a.id }, data: { status: "REVOKED" } });
  return { ok: true, message: "Access revoked." };
}

/** Folder ids a user holds an active, unexpired grant on, with edit rights. */
export async function folderGrants(tenantId: string, userId: string, now = new Date()): Promise<Map<string, { canEdit: boolean }>> {
  const rows = await prisma.documentFolderAccess.findMany({ where: { tenantId, userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  return new Map(rows.map((r) => [r.folderId, { canEdit: r.canEdit }]));
}

export async function shareDocument(input: { tenantId: string; documentId: string; withUserId: string; days: number; allowDownload: boolean; note?: string | null; byUserId: string }): Promise<R> {
  const d = await prisma.employeeDocument.findFirst({ where: { id: input.documentId, tenantId: input.tenantId } });
  if (!d || !d.fileUrl) return { ok: false, message: "Only an uploaded document can be shared." };
  const u = await prisma.user.findFirst({ where: { id: input.withUserId, tenantId: input.tenantId, loginDisabled: false } });
  if (!u) return { ok: false, message: "That person does not exist." };
  if (u.id === input.byUserId) return { ok: false, message: "Share it with someone else." };
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 30) return { ok: false, message: "Shares last 1 to 30 days." };
  await prisma.documentShare.create({ data: { tenantId: input.tenantId, documentId: d.id, sharedWithUserId: u.id, expiresAt: cdAddDays(new Date(), input.days), allowDownload: input.allowDownload, note: input.note?.trim() || null, sharedByUserId: input.byUserId } });
  await notify({ tenantId: input.tenantId, userIds: [u.id], kind: "DOCUMENT", title: `A document was shared with you: ${d.name}`, body: `Available for ${input.days} day${input.days === 1 ? "" : "s"}.`, link: "/documents/library?tab=shared" });
  return { ok: true, message: `Shared for ${input.days} day${input.days === 1 ? "" : "s"}.` };
}

export async function revokeShare(input: { tenantId: string; shareId: string }): Promise<R> {
  const s = await prisma.documentShare.findFirst({ where: { id: input.shareId, tenantId: input.tenantId, revokedAt: null } });
  if (!s) return { ok: false, message: "Share not found." };
  await prisma.documentShare.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  return { ok: true, message: "Share revoked." };
}

/** Does an active share let this user open this employee document's file? */
export async function sharedFileAllowed(tenantId: string, userId: string, documentId: string, now = new Date()): Promise<boolean> {
  return (await prisma.documentShare.count({ where: { tenantId, documentId, sharedWithUserId: userId, revokedAt: null, allowDownload: true, expiresAt: { gt: now } } })) > 0;
}

// ---------------------------------------------------------------------------
//  Bulk upload and completeness
// ---------------------------------------------------------------------------

/** Match uploaded file names to employees by the employee number they start with. */
export async function matchBulkFiles(tenantId: string, names: string[]) {
  const numbers = [...new Set(names.map(employeeNumberFromFilename).filter((n): n is string => !!n))];
  const emps = await prisma.employee.findMany({ where: { tenantId, employeeNumber: { in: numbers, mode: "insensitive" } }, select: { id: true, employeeNumber: true, displayName: true, status: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  const byNumber = new Map(emps.map((e) => [e.employeeNumber.toUpperCase(), e]));
  return names.map((name) => {
    const n = employeeNumberFromFilename(name);
    return { name, employeeNumber: n, employee: n ? byNumber.get(n) ?? null : null };
  });
}

export async function completenessByEmployee(tenantId: string, employeeWhere: Prisma.EmployeeWhereInput) {
  const emps = await prisma.employee.findMany({
    where: { tenantId, status: { not: "EXITED" }, ...employeeWhere },
    select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } }, documents: { select: { status: true, documentType: { select: { isMandatory: true } } } } },
    orderBy: { firstName: "asc" }, take: 1000,
  });
  return emps.map((e) => ({ id: e.id, name: e.displayName, number: e.employeeNumber, department: e.department?.name ?? null, ...documentCompleteness(e.documents.map((d) => ({ mandatory: !!d.documentType?.isMandatory, status: d.status }))) }));
}
