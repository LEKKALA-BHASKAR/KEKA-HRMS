"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { requestDocumentType } from "@keka/services";
import { requireAuth } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zOptionalId, zRequiredNumber, zNumber, zBool, zId, type ActionState,
} from "@/lib/forms";

/**
 * Settings a company fills in before go-live: notice periods, exit reasons,
 * and the employee document folders and types it collects.
 */

const P = PERMISSIONS;
const PATHS = ["/admin/settings"];

// ---------------------------------------------------------------------------
//  Notice period policies
// ---------------------------------------------------------------------------

const noticeSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  resignationDays: zRequiredNumber({ min: 0, max: 365 }),
  terminationDays: zRequiredNumber({ min: 0, max: 365 }),
  probationDays: zRequiredNumber({ min: 0, max: 365 }),
  allowBuyout: zBool(),
  buyoutBasis: z.enum(["BASIC", "GROSS"]),
  isDefault: zBool(),
  isActive: zBool(),
});

export async function saveNoticePolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const parsed = parseForm(noticeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.isDefault && !d.isActive) return { ok: false, message: "The default policy must be active.", errors: { isActive: "Default policies stay active" } };
  try {
    const before = id ? await prisma.noticePeriodPolicy.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
    if (id && !before) return { ok: false, message: "That policy no longer exists." };
    const saved = await prisma.$transaction(async (tx) => {
      // One default per tenant: it is what anyone without their own policy follows.
      if (d.isDefault) await tx.noticePeriodPolicy.updateMany({ where: { tenantId: viewer.tenantId, isDefault: true }, data: { isDefault: false } });
      return before
        ? tx.noticePeriodPolicy.update({ where: { id: before.id }, data: d })
        : tx.noticePeriodPolicy.create({ data: { tenantId: viewer.tenantId, ...d } });
    });
    await writeAudit(viewer, {
      module: "LIFECYCLE", action: before ? "UPDATE" : "CREATE", entityType: "NoticePeriodPolicy", entityId: saved.id,
      summary: `${before ? "Updated" : "Added"} notice policy “${d.name}”: ${d.resignationDays} days on resignation, ${d.terminationDays} on termination, ${d.probationDays} in probation${d.isDefault ? " (default)" : ""}`,
      oldValue: before ?? undefined, newValue: d,
    });
    return done(PATHS, "Notice policy saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function deleteNoticePolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const policy = await prisma.noticePeriodPolicy.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { employees: true } } } });
  if (!policy) return { ok: false, message: "That policy no longer exists." };
  if (policy.isDefault) return { ok: false, message: "Make another policy the default before removing this one." };
  if (policy._count.employees > 0) return { ok: false, message: `${policy._count.employees} employee(s) follow this policy. Move them first, or switch it off.` };
  await prisma.noticePeriodPolicy.delete({ where: { id: policy.id } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "DELETE", entityType: "NoticePeriodPolicy", entityId: policy.id, summary: `Deleted notice policy “${policy.name}”`, oldValue: policy });
  return done(PATHS, `Deleted “${policy.name}”.`);
}

/** Put one employee on a notice policy, or back on the default. */
export async function setEmployeeNoticePolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const employeeId = String(formData.get("employeeId") ?? "");
  const policyId = String(formData.get("noticePeriodPolicyId") ?? "") || null;
  const target = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, displayName: true, employeeNumber: true, noticePeriodPolicyId: true },
  });
  if (!target) return { ok: false, message: "Employee not found" };
  if (!canAccessEmployee(viewer, target, P.EMPLOYEE_UPDATE)) return { ok: false, message: "Your roles do not reach this employee record." };
  const policy = policyId ? await prisma.noticePeriodPolicy.findFirst({ where: { id: policyId, tenantId: viewer.tenantId, isActive: true } }) : null;
  if (policyId && !policy) return { ok: false, message: "Choose an active notice policy." };
  if (target.noticePeriodPolicyId === (policy?.id ?? null)) return { ok: true, message: "No changes." };
  await prisma.employee.update({ where: { id: target.id }, data: { noticePeriodPolicyId: policy?.id ?? null } });
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: target.id,
    summary: `Notice policy for ${target.displayName} (${target.employeeNumber}) set to ${policy ? `“${policy.name}”` : "the default"}`,
    oldValue: { noticePeriodPolicyId: target.noticePeriodPolicyId }, newValue: { noticePeriodPolicyId: policy?.id ?? null },
  });
  return done([`/employees/${target.id}`], "Notice policy saved.");
}

// ---------------------------------------------------------------------------
//  Exit reasons
// ---------------------------------------------------------------------------

const reasonSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  kind: z.enum(["VOLUNTARY", "INVOLUNTARY", "OTHER"]),
  displayOrder: zNumber({ min: 0, max: 999 }),
  isActive: zBool(),
});

export async function saveExitReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const parsed = parseForm(reasonSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...rest } = parsed.data;
  const d = { ...rest, displayOrder: rest.displayOrder ?? 0 };
  try {
    const before = id ? await prisma.exitReason.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
    if (id && !before) return { ok: false, message: "That reason no longer exists." };
    const saved = before
      ? await prisma.exitReason.update({ where: { id: before.id }, data: d })
      : await prisma.exitReason.create({ data: { tenantId: viewer.tenantId, ...d } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: before ? "UPDATE" : "CREATE", entityType: "ExitReason", entityId: saved.id, summary: `${before ? "Updated" : "Added"} exit reason “${d.name}” (${d.kind.toLowerCase()})`, oldValue: before ?? undefined, newValue: d });
    return done(PATHS, "Exit reason saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

/** Delete a reason no exit uses; a used one is switched off so reports keep it. */
export async function deleteExitReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const reason = await prisma.exitReason.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { exits: true } } } });
  if (!reason) return { ok: false, message: "That reason no longer exists." };
  if (reason._count.exits > 0) {
    await prisma.exitReason.update({ where: { id: reason.id }, data: { isActive: false } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "ExitReason", entityId: reason.id, summary: `Switched off exit reason “${reason.name}” (${reason._count.exits} exits keep it)` });
    return done(PATHS, `“${reason.name}” is on ${reason._count.exits} exit(s), so it was switched off rather than deleted.`);
  }
  await prisma.exitReason.delete({ where: { id: reason.id } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "DELETE", entityType: "ExitReason", entityId: reason.id, summary: `Deleted exit reason “${reason.name}”` });
  return done(PATHS, `Deleted “${reason.name}”.`);
}

// ---------------------------------------------------------------------------
//  Document folders and types
// ---------------------------------------------------------------------------

const folderSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  description: zOptional(300),
  scope: z.enum(["EMPLOYEE", "ORGANISATION"]),
  isConfidential: zBool(),
});

export async function saveDocumentFolderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_MANAGE);
  const parsed = parseForm(folderSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    const before = id ? await prisma.documentFolder.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { _count: { select: { documents: true, orgDocuments: true } } } }) : null;
    if (id && !before) return { ok: false, message: "That folder no longer exists." };
    // Documents already filed under a scope cannot change sides.
    if (before && before.scope !== d.scope && before._count.documents + before._count.orgDocuments > 0) {
      return { ok: false, message: "This folder already holds documents, so its scope cannot change.", errors: { scope: "Folder in use" } };
    }
    const saved = before
      ? await prisma.documentFolder.update({ where: { id: before.id }, data: d })
      : await prisma.documentFolder.create({ data: { tenantId: viewer.tenantId, ...d } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: before ? "UPDATE" : "CREATE", entityType: "DocumentFolder", entityId: saved.id, summary: `${before ? "Updated" : "Added"} document folder “${d.name}”`, newValue: d });
    return done([...PATHS, "/documents"], "Folder saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function deleteDocumentFolderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_MANAGE);
  const folder = await prisma.documentFolder.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { documents: true, orgDocuments: true } } } });
  if (!folder) return { ok: false, message: "That folder no longer exists." };
  const held = folder._count.documents + folder._count.orgDocuments;
  if (held > 0) return { ok: false, message: `“${folder.name}” holds ${held} document(s). Move or remove them first.` };
  await prisma.documentFolder.delete({ where: { id: folder.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "DocumentFolder", entityId: folder.id, summary: `Deleted document folder “${folder.name}”` });
  return done([...PATHS, "/documents"], `Deleted “${folder.name}”.`);
}

const typeSchema = z.object({
  id: zOptionalId(),
  folderId: zId(),
  name: zName(80),
  allowMultiple: zBool(),
  isMandatory: zBool(),
  requireVerification: zBool(),
  trackExpiry: zBool(),
  allowNotApplicable: zBool(),
});

export async function saveDocumentTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_MANAGE);
  const parsed = parseForm(typeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const folder = await prisma.documentFolder.findFirst({ where: { id: d.folderId, tenantId: viewer.tenantId } });
  if (!folder) return { ok: false, message: "Choose a folder.", errors: { folderId: "Not found" } };
  if (d.isMandatory && folder.scope !== "EMPLOYEE") return { ok: false, message: "Only employee documents can be mandatory.", errors: { isMandatory: "Organisation folder" } };
  try {
    const before = id ? await prisma.documentType.findFirst({ where: { id, folder: { tenantId: viewer.tenantId } } }) : null;
    if (id && !before) return { ok: false, message: "That document type no longer exists." };
    const saved = before
      ? await prisma.documentType.update({ where: { id: before.id }, data: d })
      : await prisma.documentType.create({ data: d });
    // Newly mandatory: ask everyone who has not provided it yet.
    const asked = d.isMandatory && !before?.isMandatory ? await requestDocumentType(saved.id) : 0;
    await writeAudit(viewer, { module: "EMPLOYEE", action: before ? "UPDATE" : "CREATE", entityType: "DocumentType", entityId: saved.id, summary: `${before ? "Updated" : "Added"} document type “${d.name}” in ${folder.name}${asked ? `, requested from ${asked} employee(s)` : ""}`, newValue: d });
    return done([...PATHS, "/documents"], asked ? `Saved, and requested from ${asked} employee(s).` : "Document type saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function deleteDocumentTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_MANAGE);
  const type = await prisma.documentType.findFirst({ where: { id: String(formData.get("id") ?? ""), folder: { tenantId: viewer.tenantId } }, include: { _count: { select: { documents: { where: { status: { not: "PENDING_ON_EMPLOYEE" } } } } } } });
  if (!type) return { ok: false, message: "That document type no longer exists." };
  if (type._count.documents > 0) return { ok: false, message: `${type._count.documents} employee(s) have uploaded “${type.name}”, so it cannot be deleted.` };
  // Outstanding requests for it go with it.
  await prisma.$transaction([
    prisma.employeeDocument.deleteMany({ where: { documentTypeId: type.id, status: "PENDING_ON_EMPLOYEE" } }),
    prisma.documentType.delete({ where: { id: type.id } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "DocumentType", entityId: type.id, summary: `Deleted document type “${type.name}” and its open requests` });
  return done([...PATHS, "/documents"], `Deleted “${type.name}”.`);
}

/** Ask every current employee who has not provided it yet. */
export async function requestDocumentTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.DOCUMENT_MANAGE);
  const type = await prisma.documentType.findFirst({ where: { id: String(formData.get("id") ?? ""), folder: { tenantId: viewer.tenantId } }, include: { folder: true } });
  if (!type) return { ok: false, message: "That document type no longer exists." };
  if (type.folder.scope !== "EMPLOYEE") return { ok: false, message: "Organisation documents are published, not requested." };
  const asked = await requestDocumentType(type.id);
  if (asked) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "DocumentType", entityId: type.id, summary: `Requested “${type.name}” from ${asked} employee(s)` });
  return done([...PATHS, "/documents"], asked ? `Requested from ${asked} employee(s).` : "Everyone already has this document or a request for it.");
}
