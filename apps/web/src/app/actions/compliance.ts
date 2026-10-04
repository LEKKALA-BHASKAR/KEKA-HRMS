"use server";

import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  runRetention, requestRetentionPurge, recordConsent, submitComplianceItem, launchPolicyCampaign, sealAuditLog, verifyAuditLog, startWorkflow, govAudit,
  RETENTION_DATA_TYPES, isRetentionDataType,
} from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { formList, actionDone as done, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const PATHS = ["/admin/compliance", "/me/policies"];
const CATEGORIES = ["STATUTORY", "LABOUR", "TAX", "DATA_PROTECTION", "INTERNAL"];
const FREQUENCIES = ["ONE_TIME", "MONTHLY", "QUARTERLY", "ANNUAL"];

async function userInTenant(tenantId: string, id: string) {
  return id ? prisma.user.findFirst({ where: { id, tenantId }, select: { id: true } }) : null;
}

async function upload(f: FormData, key: string, tenantId: string, relatedType: string, relatedId: string | undefined, by: string) {
  const file = f.get(key);
  if (!(file instanceof File) || file.size === 0) return { error: null, id: null };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Files are limited to 10 MB.", id: null };
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok) return { error: sniff.reason, id: null };
  const stored = await saveFile({ tenantId, filename: file.name || "file", mimeType: sniff.mimeType, data, relatedType, relatedId, uploadedBy: by });
  return { error: null, id: stored.id };
}

// ---------------------------------------------------------------------------
//  Retention rules and legal holds
// ---------------------------------------------------------------------------

export async function saveRetentionRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const dataType = str(f, "dataType");
  if (!isRetentionDataType(dataType)) return { ok: false, message: "Pick a data type.", errors: { dataType: "Required" } };
  const spec = RETENTION_DATA_TYPES[dataType];
  const retentionDays = Number(str(f, "retentionDays"));
  if (!Number.isInteger(retentionDays) || retentionDays < spec.min || retentionDays > 3650 * 3) return { ok: false, message: `Keep ${spec.label.toLowerCase()} for at least ${spec.min} days.`, errors: { retentionDays: `Minimum ${spec.min}` } };
  const data = { retentionDays, action: spec.actions[0], autoApply: f.get("autoApply") === "on", isActive: f.get("isActive") !== "off", description: str(f, "description") || null };
  const before = await prisma.retentionRule.findUnique({ where: { tenantId_dataType: { tenantId: viewer.tenantId, dataType } } });
  const rule = await prisma.retentionRule.upsert({ where: { tenantId_dataType: { tenantId: viewer.tenantId, dataType } }, create: { tenantId: viewer.tenantId, dataType, ...data, createdBy: viewer.user.id }, update: data });
  await govAudit(viewer.tenantId, viewer.user.id, { action: before ? "UPDATE" : "CREATE", entityType: "RetentionRule", entityId: rule.id, summary: `Retention for ${spec.label}: ${retentionDays} days, ${data.action.toLowerCase()}${data.autoApply ? ", applied nightly" : ", purge on approval"}`, oldValue: before ? { retentionDays: before.retentionDays, autoApply: before.autoApply } : undefined, newValue: data });
  return done(PATHS, "Saved. Run a dry run to see what it would remove.");
}

export async function retentionOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const rule = await prisma.retentionRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!rule) return { ok: false, message: "Rule not found." };
  const op = str(f, "op");
  if (op === "dry-run") {
    const r = await runRetention(viewer.tenantId, rule.id, { dryRun: true, actorUserId: viewer.user.id });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "EXPORT", entityType: "RetentionRule", entityId: rule.id, summary: `Dry run of ${rule.dataType}: ${r.eligible} would be removed, ${r.heldBack} held` });
    return done(PATHS, `Dry run: ${r.eligible} record(s) would be ${rule.action === "ANONYMISE" ? "anonymised" : "removed"}${r.heldBack ? `; ${r.heldBack} kept for legal hold` : ""}. Nothing was changed.`);
  }
  if (op === "purge") {
    const r = await requestRetentionPurge({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, ruleId: rule.id });
    return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
  }
  if (op === "toggle") {
    await prisma.retentionRule.update({ where: { id: rule.id }, data: { isActive: !rule.isActive } });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "RetentionRule", entityId: rule.id, summary: `${rule.isActive ? "Paused" : "Resumed"} retention for ${rule.dataType}` });
    return done(PATHS, rule.isActive ? "Paused." : "Resumed.");
  }
  return { ok: false, message: "Unknown action." };
}

export async function createLegalHoldAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const name = str(f, "name"), reason = str(f, "reason");
  if (name.length < 3) return { ok: false, message: "Name the hold.", errors: { name: "Required" } };
  if (reason.length < 5) return { ok: false, message: "Give the reason.", errors: { reason: "Required" } };
  const employeeId = str(f, "employeeId") || null;
  if (employeeId && !(await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { id: true } }))) return { ok: false, message: "Employee not found." };
  const dataType = str(f, "dataType") || null;
  if (dataType && !isRetentionDataType(dataType)) return { ok: false, message: "Unknown data type." };
  if (!employeeId && !dataType) return { ok: false, message: "Hold an employee's records, a data type, or both." };
  const h = await prisma.legalHold.create({ data: { tenantId: viewer.tenantId, name, reason, employeeId, dataType, matterRef: str(f, "matterRef") || null, createdBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "LegalHold", entityId: h.id, summary: `Placed legal hold "${name}"${employeeId ? " on an employee's records" : ""}${dataType ? ` on ${dataType}` : ""}` });
  return done(PATHS, "Legal hold placed. Purges and deletions skip the held records.");
}

export async function releaseLegalHoldAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const h = await prisma.legalHold.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, releasedAt: null } });
  if (!h) return { ok: false, message: "Hold not found." };
  await prisma.legalHold.update({ where: { id: h.id }, data: { releasedAt: new Date(), releasedBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "LegalHold", entityId: h.id, summary: `Released legal hold "${h.name}"` });
  return done(PATHS, "Released.");
}

// ---------------------------------------------------------------------------
//  Consent
// ---------------------------------------------------------------------------

export async function saveConsentPurposeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const title = str(f, "title"), description = str(f, "description");
  if (title.length < 3) return { ok: false, message: "Name the purpose.", errors: { title: "Required" } };
  if (description.length < 10) return { ok: false, message: "Describe what the data is used for.", errors: { description: "Required" } };
  const fromId = str(f, "fromId");
  if (fromId) {
    // A new version of a published purpose: everyone is asked again once it is published.
    const prev = await prisma.consentPurpose.findFirst({ where: { id: fromId, tenantId: viewer.tenantId } });
    if (!prev) return { ok: false, message: "Purpose not found." };
    const top = await prisma.consentPurpose.findFirst({ where: { tenantId: viewer.tenantId, key: prev.key }, orderBy: { version: "desc" } });
    if (top && top.status !== "PUBLISHED" && top.status !== "RETIRED") return { ok: false, message: `Version ${top.version} is still a draft; edit or publish it first.` };
    const p = await prisma.consentPurpose.create({ data: { tenantId: viewer.tenantId, key: prev.key, title, description, mandatory: f.get("mandatory") === "on", version: (top?.version ?? prev.version) + 1, createdBy: viewer.user.id } });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "ConsentPurpose", entityId: p.id, summary: `Drafted "${title}" v${p.version}` });
    return done(PATHS, `Drafted version ${p.version}. Submit it for publication.`);
  }
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "purpose";
  if (await prisma.consentPurpose.findFirst({ where: { tenantId: viewer.tenantId, key } })) return { ok: false, message: "A purpose with that name exists; make a new version of it instead.", errors: { title: "Exists" } };
  const p = await prisma.consentPurpose.create({ data: { tenantId: viewer.tenantId, key, title, description, mandatory: f.get("mandatory") === "on", createdBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "ConsentPurpose", entityId: p.id, summary: `Drafted consent purpose "${title}"` });
  return done(PATHS, "Drafted. Submit it for publication.");
}

export async function submitConsentPurposeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const p = await prisma.consentPurpose.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "DRAFT" } });
  if (!p) return { ok: false, message: "Only a draft can be submitted." };
  await prisma.consentPurpose.update({ where: { id: p.id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "CONSENT_PURPOSE", entityId: p.id, title: `Publish consent purpose "${p.title}" v${p.version}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.consentPurpose.update({ where: { id: p.id }, data: { status: "DRAFT" } }); return { ok: false, message: wf.message }; }
  const after = await prisma.consentPurpose.findUniqueOrThrow({ where: { id: p.id }, select: { status: true } });
  return done(PATHS, after.status === "PUBLISHED" ? "Published." : "Sent for approval; employees are asked once it is published.");
}

/** Employees grant, decline or withdraw consent on /me/policies. */
export async function recordConsentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees record consent." };
  const decision = str(f, "decision");
  if (!["GRANTED", "DECLINED", "WITHDRAWN"].includes(decision)) return { ok: false, message: "Pick a choice." };
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null;
  const res = await recordConsent({ tenantId: viewer.tenantId, employeeId: viewer.employee.id, purposeId: str(f, "purposeId"), decision: decision as "GRANTED", ip, actorUserId: viewer.user.id });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// ---------------------------------------------------------------------------
//  Compliance checklist
// ---------------------------------------------------------------------------

export async function saveComplianceItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const title = str(f, "title");
  if (title.length < 3) return { ok: false, message: "Name the obligation.", errors: { title: "Required" } };
  const dueOn = day(str(f, "dueOn"));
  if (!dueOn) return { ok: false, message: "Pick a due date.", errors: { dueOn: "Required" } };
  const category = str(f, "category") || "STATUTORY", frequency = str(f, "frequency") || "ONE_TIME";
  if (!CATEGORIES.includes(category) || !FREQUENCIES.includes(frequency)) return { ok: false, message: "Pick a category and frequency." };
  const owner = await userInTenant(viewer.tenantId, str(f, "ownerUserId"));
  if (!owner) return { ok: false, message: "Pick an owner.", errors: { ownerUserId: "Required" } };
  const reviewerId = str(f, "reviewerUserId");
  if (reviewerId && !(await userInTenant(viewer.tenantId, reviewerId))) return { ok: false, message: "Reviewer not found." };
  if (reviewerId && reviewerId === owner.id) return { ok: false, message: "The reviewer must be someone other than the owner.", errors: { reviewerUserId: "Same as owner" } };
  const data = { title, description: str(f, "description") || null, category, frequency, dueOn, ownerUserId: owner.id, reviewerUserId: reviewerId || null, regulation: str(f, "regulation") || null, authority: str(f, "authority") || null };
  const id = str(f, "id");
  if (id) {
    const item = await prisma.complianceItem.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!item) return { ok: false, message: "Item not found." };
    if (item.status === "COMPLETED") return { ok: false, message: "A completed item cannot be changed." };
    await prisma.complianceItem.update({ where: { id }, data });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "ComplianceItem", entityId: id, summary: `Updated compliance item "${title}"`, oldValue: { dueOn: item.dueOn, ownerUserId: item.ownerUserId }, newValue: data });
    return done(PATHS, "Saved.");
  }
  const item = await prisma.complianceItem.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "ComplianceItem", entityId: item.id, summary: `Added compliance item "${title}" due ${dueOn.toISOString().slice(0, 10)}` });
  return done(PATHS, "Added to the compliance calendar.");
}

function canWorkItem(viewer: { user: { id: string }; permissions: Set<string> }, item: { ownerUserId: string }) {
  return item.ownerUserId === viewer.user.id || viewer.permissions.has(P.COMPLIANCE_MANAGE);
}

export async function uploadEvidenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const item = await prisma.complianceItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!item || !canWorkItem(viewer, item)) return { ok: false, message: "Item not found." };
  if (!["OPEN", "IN_PROGRESS"].includes(item.status)) return { ok: false, message: "Evidence can be added while the item is open." };
  const up = await upload(f, "file", viewer.tenantId, "ComplianceEvidence", item.id, viewer.user.id);
  if (up.error) return { ok: false, message: up.error, errors: { file: up.error } };
  if (!up.id) return { ok: false, message: "Choose a file.", errors: { file: "Required" } };
  await prisma.complianceItem.update({ where: { id: item.id }, data: { evidenceFileIds: { push: up.id }, status: "IN_PROGRESS" } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "ComplianceItem", entityId: item.id, summary: `Attached evidence to "${item.title}"` });
  return done(PATHS, "Evidence attached.");
}

export async function complianceItemOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const item = await prisma.complianceItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!item || !canWorkItem(viewer, item)) return { ok: false, message: "Item not found." };
  const op = str(f, "op");
  if (op === "submit") {
    const r = await submitComplianceItem({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, itemId: item.id, notes: str(f, "notes") || null });
    return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
  }
  if (op === "exception") {
    if (!viewer.permissions.has(P.COMPLIANCE_MANAGE)) return { ok: false, message: "Only compliance managers can record an exception." };
    const reason = str(f, "reason");
    if (reason.length < 5) return { ok: false, message: "Give the reason for the exception." };
    await prisma.complianceItem.update({ where: { id: item.id }, data: { status: "EXCEPTION", exceptionReason: reason } });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "ComplianceItem", entityId: item.id, summary: `Exception recorded for "${item.title}": ${reason}` });
    return done(PATHS, "Exception recorded.");
  }
  return { ok: false, message: "Unknown action." };
}

// ---------------------------------------------------------------------------
//  Policy documents and acknowledgement campaigns
// ---------------------------------------------------------------------------

export async function createPolicyDocumentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const title = str(f, "title");
  if (title.length < 3) return { ok: false, message: "Name the policy.", errors: { title: "Required" } };
  const fromId = str(f, "fromId");
  const prev = fromId ? await prisma.orgDocument.findFirst({ where: { id: fromId, tenantId: viewer.tenantId } }) : null;
  if (fromId && !prev) return { ok: false, message: "Policy not found." };
  const up = await upload(f, "file", viewer.tenantId, "PolicyDocument", undefined, viewer.user.id);
  if (up.error) return { ok: false, message: up.error, errors: { file: up.error } };
  const nextVersion = prev ? `v${(parseInt((prev.version ?? "v1").replace(/\D/g, ""), 10) || 1) + 1}` : str(f, "version") || "v1";
  const doc = await prisma.orgDocument.create({
    data: {
      tenantId: viewer.tenantId, title, description: str(f, "description") || prev?.description || null, version: nextVersion, folderId: prev?.folderId ?? null,
      fileUrl: up.id ? `/files/${up.id}` : prev?.fileUrl ?? null, effectiveFrom: day(str(f, "effectiveFrom")) ?? new Date(), requireAck: true, isPublished: false,
    },
  });
  if (up.id) await prisma.storedFile.update({ where: { id: up.id }, data: { relatedId: doc.id } });
  // The previous version stays on record but is no longer shown.
  if (prev) await prisma.orgDocument.update({ where: { id: prev.id }, data: { isPublished: false } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "OrgDocument", entityId: doc.id, summary: `${prev ? "New version" : "New policy"} "${title}" ${nextVersion}` });
  return done(PATHS, `Saved "${title}" ${nextVersion}. Launch an acknowledgement campaign to publish it.`);
}

export async function launchPolicyCampaignAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const dueOn = day(str(f, "dueOn"));
  if (!dueOn) return { ok: false, message: "Pick a due date.", errors: { dueOn: "Required" } };
  const departmentIds = formList(f, "departmentIds");
  if (departmentIds.length && (await prisma.department.count({ where: { tenantId: viewer.tenantId, id: { in: departmentIds } } })) !== departmentIds.length) return { ok: false, message: "A department was not found." };
  const res = await launchPolicyCampaign({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, documentId: str(f, "documentId"), name: str(f, "name"), dueOn, departmentIds });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function closePolicyCampaignAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const c = await prisma.policyCampaign.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "ACTIVE" } });
  if (!c) return { ok: false, message: "Campaign not found." };
  await prisma.policyCampaign.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: new Date() } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "PolicyCampaign", entityId: c.id, summary: `Closed campaign "${c.name}"` });
  return done(PATHS, "Closed.");
}

/** An employee acknowledges a published policy. */
export async function acknowledgePolicyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees acknowledge policies." };
  const doc = await prisma.orgDocument.findFirst({ where: { id: str(f, "documentId"), tenantId: viewer.tenantId, isPublished: true } });
  if (!doc) return { ok: false, message: "Policy not found." };
  if (f.get("confirm") !== "on") return { ok: false, message: "Tick the box to confirm you have read it." };
  await prisma.orgDocumentAck.upsert({ where: { documentId_employeeId: { documentId: doc.id, employeeId: viewer.employee.id } }, create: { documentId: doc.id, employeeId: viewer.employee.id }, update: {} });
  await govAudit(viewer.tenantId, viewer.user.id, { module: "EMPLOYEE", action: "APPROVE", entityType: "OrgDocumentAck", entityId: doc.id, summary: `${viewer.employee.employeeNumber} acknowledged "${doc.title}" ${doc.version ?? ""}`.trim() });
  return done([...PATHS, "/documents"], "Acknowledged. Thank you.");
}

// ---------------------------------------------------------------------------
//  Findings and audit integrity
// ---------------------------------------------------------------------------

export async function saveFindingAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const title = str(f, "title");
  if (title.length < 3) return { ok: false, message: "Describe the finding.", errors: { title: "Required" } };
  const dueOn = day(str(f, "dueOn"));
  if (!dueOn) return { ok: false, message: "Pick a remediation due date.", errors: { dueOn: "Required" } };
  const severity = str(f, "severity") || "MEDIUM", source = str(f, "source") || "INTERNAL_AUDIT";
  if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity) || !["INTERNAL_AUDIT", "EXTERNAL_AUDIT", "ACCESS_REVIEW", "SELF_ASSESSMENT"].includes(source)) return { ok: false, message: "Pick a severity and source." };
  const owner = await userInTenant(viewer.tenantId, str(f, "ownerUserId"));
  if (!owner) return { ok: false, message: "Pick an owner.", errors: { ownerUserId: "Required" } };
  const itemId = str(f, "complianceItemId") || null;
  if (itemId && !(await prisma.complianceItem.findFirst({ where: { id: itemId, tenantId: viewer.tenantId }, select: { id: true } }))) return { ok: false, message: "Compliance item not found." };
  const fd = await prisma.auditFinding.create({ data: { tenantId: viewer.tenantId, title, detail: str(f, "detail") || null, severity, source, ownerUserId: owner.id, dueOn, complianceItemId: itemId, correctiveAction: str(f, "correctiveAction") || null, createdBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "AuditFinding", entityId: fd.id, summary: `Logged ${severity.toLowerCase()} finding "${title}"` });
  return done(PATHS, "Finding logged.");
}

export async function findingOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const fd = await prisma.auditFinding.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!fd || (fd.ownerUserId !== viewer.user.id && !viewer.permissions.has(P.COMPLIANCE_MANAGE))) return { ok: false, message: "Finding not found." };
  const op = str(f, "op"), note = str(f, "note");
  if (op === "remediate") {
    if (fd.status !== "OPEN") return { ok: false, message: "Already in remediation or closed." };
    if (note.length < 5) return { ok: false, message: "Describe the corrective action." };
    await prisma.auditFinding.update({ where: { id: fd.id }, data: { status: "IN_REMEDIATION", correctiveAction: note } });
  } else if (op === "close") {
    if (!viewer.permissions.has(P.COMPLIANCE_MANAGE)) return { ok: false, message: "A compliance manager closes findings." };
    if (fd.status === "CLOSED") return { ok: false, message: "Already closed." };
    if (note.length < 5) return { ok: false, message: "Say how it was verified." };
    await prisma.auditFinding.update({ where: { id: fd.id }, data: { status: "CLOSED", closedAt: new Date(), closureNote: note } });
  } else return { ok: false, message: "Unknown action." };
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AuditFinding", entityId: fd.id, summary: `Finding "${fd.title}": ${op === "close" ? "closed" : "corrective action recorded"}` });
  return done(PATHS, op === "close" ? "Closed." : "Moved to remediation.");
}

export async function sealAuditLogAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const r = await sealAuditLog(viewer.tenantId);
  const v = await verifyAuditLog(viewer.tenantId);
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AuditSeal", summary: `Sealed ${r.sealed} audit entr${r.sealed === 1 ? "y" : "ies"}; verification found ${v.problems.length} problem(s)` });
  return done(PATHS, `Sealed ${r.sealed} new entr${r.sealed === 1 ? "y" : "ies"}. Chain verified over ${v.checked}: ${v.problems.length ? `${v.problems.length} problem(s)` : "intact"}.`);
}
