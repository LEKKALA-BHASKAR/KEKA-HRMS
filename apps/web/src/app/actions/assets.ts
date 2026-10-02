"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, type Prisma, type AssetCondition, type AssetStatus } from "@keka/db";
import { PERMISSIONS, canAccessEmployee, type Permission } from "@keka/rbac";
import {
  notify, usersWithPermission, nextAssetTag, recordAssetEvent, planRequestApprovals, getAssetSettings,
  assetBookValue, assetInitialAckStatus, decideAssetLevels, parseAssetCsv, autoMapAssetHeaders, validateAssetImport,
  ASSET_ICON_KEYS, ASSET_CONDITIONS, ASSET_IMPORT_FIELDS, ASSET_REQUEST_TYPE_LABEL,
  type AssetLevelState, type AssetImportRefs, type AssetApproverKind,
} from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, parseForm, toErrorState, formList, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { aiForViewer, aiJson } from "@/lib/ai";
import { ASSET_REPORTS } from "@/app/(app)/assets/_reports";

/**
 * Asset management: categories and types, the inventory, assignment and
 * recovery, acknowledgement, requests through their approval chain, bulk
 * import, settings and scheduled reports.
 *
 * Every action re-reads what it acts on inside the viewer's tenant, checks
 * the permission (and, for a person, the scope) on the server, writes an
 * AssetEvent for the asset's own history and an audit row.
 */

const P = PERMISSIONS;
const NO = (message: string): ActionState => ({ ok: false, message });
const DENIED = NO("You do not have permission to do that.");

function refresh(): void {
  for (const [p, t] of [["/assets", "layout"], ["/me/assets", "page"], ["/employees/[id]", "page"], ["/inbox", "layout"]] as const) {
    try { revalidatePath(p, t); } catch { /* outside a request: nothing to revalidate */ }
  }
}
const actorLabel = (v: Viewer) => v.employee?.displayName ?? v.user.email;
const actorEmployee = (v: Viewer) => v.employee?.id ?? null;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optDate = z.string().trim().optional().transform((s, ctx) => {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Enter a valid date." }); return z.NEVER; }
  return d;
});
const optMoney = z.string().trim().optional().transform((s, ctx) => {
  if (!s) return null;
  const n = Number(s.replace(/[,₹\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) { ctx.addIssue({ code: "custom", message: "Enter an amount of zero or more." }); return z.NEVER; }
  return Math.round(n * 100) / 100;
});
const conditionEnum = z.enum(ASSET_CONDITIONS as [AssetCondition, ...AssetCondition[]], { message: "Choose a condition." });
const today = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };

async function scopedEmployee(viewer: Viewer, employeeId: string, permission: Permission) {
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, userId: true, status: true, displayName: true, firstName: true, lastName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  if (!e || !canAccessEmployee(viewer, e, permission)) return null;
  return e;
}

// ===========================================================================
//  Categories and types
// ===========================================================================

const categorySchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Enter a name for the asset category.").max(80),
  description: z.string().trim().max(500).optional(),
  usefulLifeMonths: z.string().trim().optional().transform((s, ctx) => {
    if (!s) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 600) { ctx.addIssue({ code: "custom", message: "Between 1 and 600 months." }); return z.NEVER; }
    return n;
  }),
});

export async function saveAssetCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const parsed = parseForm(categorySchema, fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const clash = await prisma.assetCategory.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: d.name, mode: "insensitive" }, ...(d.id ? { NOT: { id: d.id } } : {}) } });
  if (clash) return { ok: false, message: "An asset category with that name already exists.", errors: { name: "Already in use." } };
  if (d.id) {
    const before = await prisma.assetCategory.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
    if (!before) return NO("Asset category not found.");
    await prisma.assetCategory.update({ where: { id: before.id }, data: { name: d.name, description: d.description || null, usefulLifeMonths: d.usefulLifeMonths } });
    await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetCategory", entityId: before.id, summary: `Updated asset category ${d.name}`, oldValue: { name: before.name, usefulLifeMonths: before.usefulLifeMonths }, newValue: { name: d.name, usefulLifeMonths: d.usefulLifeMonths } });
    refresh();
    return { ok: true, message: "Asset category saved.", values: { id: before.id } };
  }
  const c = await prisma.assetCategory.create({ data: { tenantId: viewer.tenantId, name: d.name, description: d.description || null, usefulLifeMonths: d.usefulLifeMonths } });
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "AssetCategory", entityId: c.id, summary: `Added asset category ${c.name}` });
  refresh();
  return { ok: true, message: "Asset category added.", values: { id: c.id } };
}

export async function deleteAssetCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const c = await prisma.assetCategory.findFirst({ where: { id: str(fd, "id"), tenantId: viewer.tenantId }, include: { types: { select: { _count: { select: { assets: true } } } } } });
  if (!c) return NO("Asset category not found.");
  const assets = c.types.reduce((s, t) => s + t._count.assets, 0);
  if (assets > 0) return NO(`${c.name} still holds ${assets} asset${assets === 1 ? "" : "s"}. Move or delete them first.`);
  await prisma.assetCategory.delete({ where: { id: c.id } });
  await writeAudit(viewer, { module: "ASSET", action: "DELETE", entityType: "AssetCategory", entityId: c.id, summary: `Deleted asset category ${c.name}` });
  refresh();
  return { ok: true, message: "Asset category deleted." };
}

const typeSchema = z.object({
  id: z.string().optional(),
  categoryId: z.string().min(1, "Choose an asset category."),
  name: z.string().trim().min(1, "Enter a name for the asset type.").max(80),
  description: z.string().trim().max(500).optional(),
  icon: z.enum(ASSET_ICON_KEYS).default("other"),
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  requireAck: z.string().optional().transform((v) => v === "on"),
});

export async function saveAssetTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const parsed = parseForm(typeSchema, fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const cat = await prisma.assetCategory.findFirst({ where: { id: d.categoryId, tenantId: viewer.tenantId } });
  if (!cat) return { ok: false, message: "Choose an asset category.", errors: { categoryId: "Not found." } };
  const clash = await prisma.assetType.findFirst({ where: { categoryId: cat.id, name: { equals: d.name, mode: "insensitive" }, ...(d.id ? { NOT: { id: d.id } } : {}) } });
  if (clash) return { ok: false, message: `${cat.name} already has a type called ${d.name}.`, errors: { name: "Already in use." } };
  const data = { categoryId: cat.id, name: d.name, description: d.description || null, icon: d.icon, make: d.make || null, model: d.model || null, requireAck: d.requireAck };
  if (d.id) {
    const before = await prisma.assetType.findFirst({ where: { id: d.id, category: { tenantId: viewer.tenantId } } });
    if (!before) return NO("Asset type not found.");
    await prisma.assetType.update({ where: { id: before.id }, data });
    await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetType", entityId: before.id, summary: `Updated asset type ${d.name}`, oldValue: { name: before.name, requireAck: before.requireAck }, newValue: { name: d.name, requireAck: d.requireAck } });
    refresh();
    return { ok: true, message: "Asset type saved.", values: { id: before.id } };
  }
  const t = await prisma.assetType.create({ data });
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "AssetType", entityId: t.id, summary: `Added asset type ${t.name} to ${cat.name}` });
  refresh();
  return { ok: true, message: "Asset type added.", values: { id: t.id } };
}

export async function deleteAssetTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const t = await prisma.assetType.findFirst({ where: { id: str(fd, "id"), category: { tenantId: viewer.tenantId } }, include: { _count: { select: { assets: true } } } });
  if (!t) return NO("Asset type not found.");
  if (t._count.assets > 0) return NO(`${t.name} still has ${t._count.assets} asset${t._count.assets === 1 ? "" : "s"}. Move or delete them first.`);
  await prisma.assetType.delete({ where: { id: t.id } });
  await writeAudit(viewer, { module: "ASSET", action: "DELETE", entityType: "AssetType", entityId: t.id, summary: `Deleted asset type ${t.name}` });
  refresh();
  return { ok: true, message: "Asset type deleted." };
}

// ===========================================================================
//  Inventory
// ===========================================================================

const CREATE_STATUSES = ["AVAILABLE", "IN_REPAIR", "LOST", "UNAVAILABLE", "RETIRED"] as const;
const assetSchema = z.object({
  id: z.string().optional(),
  assetTypeId: z.string().min(1, "Choose an asset type."),
  seriesId: z.string().optional(),
  assetTag: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1, "Enter the asset name.").max(120),
  description: z.string().trim().max(1000).optional(),
  locationId: z.string().min(1, "Choose a location."),
  purchaseDate: optDate,
  warrantyExpiry: optDate,
  condition: conditionEnum,
  status: z.enum(CREATE_STATUSES).optional(),
  unavailableReason: z.string().trim().max(300).optional(),
  serialNumber: z.string().trim().max(80).optional(),
  purchaseCost: optMoney,
  vendor: z.string().trim().max(120).optional(),
  invoiceNumber: z.string().trim().max(60).optional(),
});

async function storeAssetFiles(viewer: Viewer, assetId: string, fd: FormData): Promise<{ imageFileId?: string; error?: string; docs: number }> {
  const image = fd.get("image");
  const docs = fd.getAll("documents").filter((f): f is File => f instanceof File && f.size > 0);
  let imageFileId: string | undefined;
  if (image instanceof File && image.size > 0) {
    if (image.size > MAX_UPLOAD_BYTES) return { error: "Images are limited to 10 MB.", docs: 0 };
    const data = Buffer.from(await image.arrayBuffer());
    const sniff = sniffUpload(data, image.type);
    if (!sniff.ok || sniff.mimeType === "application/pdf") return { error: "The asset image must be a PNG or JPEG.", docs: 0 };
    const f = await saveFile({ tenantId: viewer.tenantId, filename: image.name || "asset-image", mimeType: sniff.mimeType, data, relatedType: "Asset", relatedId: assetId, uploadedBy: viewer.user.id });
    imageFileId = f.id;
  }
  let saved = 0;
  for (const doc of docs.slice(0, 5)) {
    if (doc.size > MAX_UPLOAD_BYTES) return { error: "Documents are limited to 10 MB each.", imageFileId, docs: saved };
    const data = Buffer.from(await doc.arrayBuffer());
    const sniff = sniffUpload(data, doc.type);
    if (!sniff.ok) return { error: `${doc.name}: ${sniff.reason}`, imageFileId, docs: saved };
    await saveFile({ tenantId: viewer.tenantId, filename: doc.name || "asset-document", mimeType: sniff.mimeType, data, relatedType: "Asset", relatedId: assetId, uploadedBy: viewer.user.id });
    saved++;
  }
  return { imageFileId, docs: saved };
}

export async function saveAssetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const parsed = parseForm(assetSchema, fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const type = await prisma.assetType.findFirst({ where: { id: d.assetTypeId, category: { tenantId: viewer.tenantId } }, include: { category: true } });
  if (!type) return { ok: false, message: "Choose an asset type.", errors: { assetTypeId: "Not found." }, values };
  const loc = await prisma.location.findFirst({ where: { id: d.locationId, tenantId: viewer.tenantId } });
  if (!loc) return { ok: false, message: "Choose a location.", errors: { locationId: "Not found." }, values };
  if (d.purchaseDate && d.purchaseDate > today()) return { ok: false, message: "The purchase date cannot be in the future.", errors: { purchaseDate: "In the future." }, values };
  if (d.purchaseDate && d.warrantyExpiry && d.warrantyExpiry < d.purchaseDate) return { ok: false, message: "The warranty cannot end before the purchase.", errors: { warrantyExpiry: "Before the purchase date." }, values };
  const currentValue = assetBookValue(d.purchaseCost, d.purchaseDate, type.category.usefulLifeMonths, today());
  const common = {
    assetTypeId: type.id, name: d.name, description: d.description || null, locationId: loc.id,
    purchaseDate: d.purchaseDate, warrantyExpiry: d.warrantyExpiry, condition: d.condition,
    serialNumber: d.serialNumber || null, purchaseCost: d.purchaseCost, vendor: d.vendor || null, invoiceNumber: d.invoiceNumber || null, currentValue,
  };

  try {
    if (d.id) {
      const before = await prisma.asset.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
      if (!before) return NO("Asset not found.");
      const tag = d.assetTag || before.assetTag;
      if (tag !== before.assetTag && await prisma.asset.findFirst({ where: { tenantId: viewer.tenantId, assetTag: tag } })) {
        return { ok: false, message: `Asset ID ${tag} is already in use.`, errors: { assetTag: "Already in use." }, values };
      }
      const changed: Record<string, [unknown, unknown]> = {};
      const cmp = (k: string, a: unknown, b: unknown) => {
        const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v));
        if (norm(a) !== norm(b)) changed[k] = [norm(a), norm(b)];
      };
      cmp("assetTag", before.assetTag, tag); cmp("name", before.name, d.name); cmp("assetTypeId", before.assetTypeId, type.id);
      cmp("locationId", before.locationId, loc.id); cmp("purchaseDate", before.purchaseDate, d.purchaseDate); cmp("warrantyExpiry", before.warrantyExpiry, d.warrantyExpiry);
      cmp("serialNumber", before.serialNumber, d.serialNumber || null); cmp("purchaseCost", before.purchaseCost, d.purchaseCost); cmp("vendor", before.vendor, d.vendor || null);
      cmp("description", before.description, d.description || null);
      await prisma.$transaction(async (tx) => {
        await tx.asset.update({ where: { id: before.id }, data: { ...common, assetTag: tag } });
        if (Object.keys(changed).length) {
          await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: before.id, kind: "UPDATED", actorId: viewer.user.id, actorLabel: actorLabel(viewer),
            fromValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v[0]])), toValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v[1]])) });
        }
        if (before.condition !== d.condition) {
          await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: before.id, kind: "CONDITION_CHANGED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), fromValue: { condition: before.condition }, toValue: { condition: d.condition } });
        }
      });
      const files = await storeAssetFiles(viewer, before.id, fd);
      if (files.imageFileId) await prisma.asset.update({ where: { id: before.id }, data: { imageFileId: files.imageFileId } });
      await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "Asset", entityId: before.id, summary: `Edited asset ${tag}`, oldValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v[0]])), newValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v[1]])) });
      refresh();
      if (files.error) return { ok: false, message: `Saved, but a file was not: ${files.error}`, values: { id: before.id } };
      return { ok: true, message: "Asset saved.", values: { id: before.id } };
    }

    const status = d.status ?? "AVAILABLE";
    if (status !== "AVAILABLE" && !d.unavailableReason) return { ok: false, message: "Say why the asset is not available.", errors: { unavailableReason: "Required for this status." }, values };
    const manual = !d.seriesId || d.seriesId === "MANUAL";
    if (manual && !d.assetTag) return { ok: false, message: "Enter the asset ID, or pick an ID series.", errors: { assetTag: "Required." }, values };
    if (manual && await prisma.asset.findFirst({ where: { tenantId: viewer.tenantId, assetTag: d.assetTag! } })) {
      return { ok: false, message: `Asset ID ${d.assetTag} is already in use.`, errors: { assetTag: "Already in use." }, values };
    }
    const created = await prisma.$transaction(async (tx) => {
      const tag = manual ? d.assetTag! : await nextAssetTag(tx, viewer.tenantId, d.seriesId!);
      const a = await tx.asset.create({ data: { ...common, tenantId: viewer.tenantId, assetTag: tag, status, unavailableReason: status === "AVAILABLE" ? null : d.unavailableReason! } });
      await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "CREATED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), toValue: { status, condition: d.condition, location: loc.name } });
      return a;
    });
    const files = await storeAssetFiles(viewer, created.id, fd);
    if (files.imageFileId) await prisma.asset.update({ where: { id: created.id }, data: { imageFileId: files.imageFileId } });
    await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "Asset", entityId: created.id, summary: `Added ${d.name} (${created.assetTag}) to ${type.name}` });
    refresh();
    if (files.error) return { ok: false, message: `Added ${created.assetTag}, but a file was not saved: ${files.error}`, values: { id: created.id } };
    return { ok: true, message: `Added ${created.assetTag}.`, values: { id: created.id } };
  } catch (err) {
    return toErrorState(err, values);
  }
}

export async function updateAssetConditionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const parsed = parseForm(z.object({ assetId: z.string().min(1), condition: conditionEnum, note: z.string().trim().max(300).optional() }), fd);
  if (parsed.state) return parsed.state;
  const a = await prisma.asset.findFirst({ where: { id: parsed.data.assetId, tenantId: viewer.tenantId } });
  if (!a) return NO("Asset not found.");
  if (a.condition === parsed.data.condition) return NO(`It is already recorded as ${parsed.data.condition.toLowerCase()}.`);
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({ where: { id: a.id }, data: { condition: parsed.data.condition } });
    await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "CONDITION_CHANGED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), fromValue: { condition: a.condition }, toValue: { condition: parsed.data.condition }, note: parsed.data.note || null });
  });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "Asset", entityId: a.id, summary: `Condition of ${a.assetTag}: ${a.condition} → ${parsed.data.condition}` });
  refresh();
  return { ok: true, message: "Asset condition updated." };
}

export async function markAssetNotAvailableAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const parsed = parseForm(z.object({
    assetId: z.string().min(1),
    status: z.enum(["IN_REPAIR", "LOST", "UNAVAILABLE", "RETIRED"], { message: "Choose a status." }),
    reason: z.string().trim().min(3, "Say why it is not available.").max(300),
  }), fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.status === "RETIRED" && !can(viewer, P.ASSET_MANAGE)) return NO("Only an asset manager can retire an asset.");
  const a = await prisma.asset.findFirst({ where: { id: d.assetId, tenantId: viewer.tenantId }, include: { assignments: { where: { returnedOn: null }, take: 1 } } });
  if (!a) return NO("Asset not found.");
  if (a.status === d.status) return NO("The asset already has that status.");
  const open = a.assignments[0];
  if (open && !(await scopedEmployee(viewer, open.employeeId, P.ASSET_ASSIGN))) return DENIED;
  await prisma.$transaction(async (tx) => {
    if (open) {
      // Taking an asset out of use ends the holder's assignment.
      await tx.assetAssignment.update({ where: { id: open.id }, data: { returnedOn: today(), conditionIn: a.condition, returnedBy: actorEmployee(viewer), notes: d.reason } });
      await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "RETURNED", employeeId: open.employeeId, actorId: viewer.user.id, actorLabel: actorLabel(viewer), toValue: { condition: a.condition }, note: d.reason });
    }
    await tx.asset.update({ where: { id: a.id }, data: { status: d.status as AssetStatus, unavailableReason: d.reason } });
    await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "STATUS_CHANGED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), fromValue: { status: a.status }, toValue: { status: d.status }, note: d.reason });
  });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "Asset", entityId: a.id, summary: `Marked ${a.assetTag} ${d.status.toLowerCase().replace("_", " ")}: ${d.reason}` });
  refresh();
  return { ok: true, message: "Asset marked as not available." };
}

export async function markAssetAvailableAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const a = await prisma.asset.findFirst({ where: { id: str(fd, "assetId"), tenantId: viewer.tenantId } });
  if (!a) return NO("Asset not found.");
  if (a.status === "AVAILABLE" || a.status === "ASSIGNED") return NO("The asset is already in use or available.");
  if (a.status === "RETIRED" && !can(viewer, P.ASSET_MANAGE)) return NO("Only an asset manager can bring back a retired asset.");
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({ where: { id: a.id }, data: { status: "AVAILABLE", unavailableReason: null } });
    await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "STATUS_CHANGED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), fromValue: { status: a.status }, toValue: { status: "AVAILABLE" } });
  });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "Asset", entityId: a.id, summary: `Marked ${a.assetTag} available` });
  refresh();
  return { ok: true, message: "Asset marked as available." };
}

// ===========================================================================
//  Assignment, recovery and acknowledgement
// ===========================================================================

export async function assignAssetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const assetId = str(fd, "assetId"), requestId = str(fd, "requestId") || null;
  let employeeId = str(fd, "employeeId");
  const notes = str(fd, "notes").slice(0, 500) || null;
  const condRaw = str(fd, "conditionOut");
  if (condRaw && !(ASSET_CONDITIONS as string[]).includes(condRaw)) return NO("Choose a condition.");

  const asset = await prisma.asset.findFirst({ where: { id: assetId, tenantId: viewer.tenantId }, include: { assetType: true } });
  if (!asset) return NO("Asset not found.");
  if (asset.status !== "AVAILABLE") return NO(asset.status === "ASSIGNED" ? "This asset is already assigned. Recover it first." : "Only an available asset can be assigned.");

  const request = requestId ? await prisma.assetRequest.findFirst({ where: { id: requestId, tenantId: viewer.tenantId } }) : null;
  if (requestId && !request) return NO("Asset request not found.");
  if (request) {
    if (request.status !== "APPROVED") return NO("Only an approved request can be fulfilled.");
    if (employeeId && employeeId !== request.employeeId) return NO("This request was raised by someone else.");
    employeeId = request.employeeId;
  }
  if (!employeeId) return { ok: false, message: "Choose the employee.", errors: { employeeId: "Required." } };
  const emp = await scopedEmployee(viewer, employeeId, P.ASSET_ASSIGN);
  if (!emp) return NO("Employee not found.");
  if (emp.status === "EXITED") return NO("An employee who has left cannot be assigned an asset.");

  const ackStatus = assetInitialAckStatus(asset.assetType.requireAck);
  const name = asset.name ?? asset.assetType.name;
  try {
    await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction so two assigners cannot both win.
      const claimed = await tx.asset.updateMany({ where: { id: asset.id, status: "AVAILABLE" }, data: { status: "ASSIGNED", ...(condRaw ? { condition: condRaw as AssetCondition } : {}) } });
      if (claimed.count === 0) throw new Error("This asset was just assigned by someone else.");
      await tx.assetAssignment.create({
        data: {
          assetId: asset.id, employeeId: emp.id, assignedOn: new Date(), assignedBy: actorEmployee(viewer),
          conditionOut: (condRaw || asset.condition) as AssetCondition, notes, ackStatus, requestId: request?.id ?? null,
        },
      });
      await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: asset.id, kind: "ASSIGNED", employeeId: emp.id, actorId: viewer.user.id, actorLabel: actorLabel(viewer), toValue: { employee: emp.displayName, ackStatus }, note: notes });
      if (request) {
        await tx.assetRequest.update({ where: { id: request.id }, data: { status: "FULFILLED", assetId: asset.id, closedAt: new Date(), closedBy: actorEmployee(viewer) } });
        await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: asset.id, kind: "REQUEST_FULFILLED", employeeId: emp.id, actorId: viewer.user.id, actorLabel: actorLabel(viewer), note: request.title ?? request.reason });
      }
      await notify({
        tenantId: viewer.tenantId, userIds: [emp.userId], kind: "ASSET",
        title: `${name} (${asset.assetTag}) has been assigned to you`,
        body: ackStatus === "PENDING" ? "Please acknowledge that you have received it." : null, link: "/me/assets",
      }, tx);
    });
  } catch (err) {
    return toErrorState(err);
  }
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "AssetAssignment", entityId: asset.id, summary: `Assigned ${asset.assetTag} to ${emp.displayName}${request ? " against a request" : ""}` });
  refresh();
  return { ok: true, message: `${name} assigned to ${emp.displayName}.` };
}

export async function recoverAssetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const parsed = parseForm(z.object({
    assignmentId: z.string().min(1),
    returnedOn: optDate,
    conditionIn: conditionEnum,
    damageCharge: optMoney,
    damageNote: z.string().trim().max(500).optional(),
  }), fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const a = await prisma.assetAssignment.findFirst({ where: { id: d.assignmentId, asset: { tenantId: viewer.tenantId } }, include: { asset: { include: { assetType: true } } } });
  if (!a) return NO("Assignment not found.");
  if (a.returnedOn) return NO("This asset has already been recovered.");
  const emp = await scopedEmployee(viewer, a.employeeId, P.ASSET_ASSIGN);
  if (!emp) return DENIED;
  const returnedOn = d.returnedOn ?? today();
  if (returnedOn > today()) return { ok: false, message: "The return date cannot be in the future.", errors: { returnedOn: "In the future." } };
  if (returnedOn < new Date(Date.UTC(a.assignedOn.getUTCFullYear(), a.assignedOn.getUTCMonth(), a.assignedOn.getUTCDate()))) return { ok: false, message: "The return date is before it was assigned.", errors: { returnedOn: "Before the assignment." } };
  if (d.damageCharge && d.damageCharge > 0 && !d.damageNote) return { ok: false, message: "Describe the damage you are charging for.", errors: { damageNote: "Required with a charge." } };
  const broken = d.conditionIn === "DAMAGED" || d.conditionIn === "UNUSABLE";
  await prisma.$transaction(async (tx) => {
    await tx.assetAssignment.update({ where: { id: a.id }, data: { returnedOn, conditionIn: d.conditionIn, damageCharge: d.damageCharge && d.damageCharge > 0 ? d.damageCharge : null, damageNote: d.damageNote || null, returnedBy: actorEmployee(viewer) } });
    await tx.asset.update({ where: { id: a.assetId }, data: { status: broken ? "IN_REPAIR" : "AVAILABLE", condition: d.conditionIn, unavailableReason: broken ? (d.damageNote || "Returned damaged") : null } });
    await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.assetId, kind: "RETURNED", employeeId: a.employeeId, actorId: viewer.user.id, actorLabel: actorLabel(viewer), fromValue: { condition: a.conditionOut }, toValue: { condition: d.conditionIn, damageCharge: d.damageCharge ?? null }, note: d.damageNote || null, at: returnedOn.getTime() === today().getTime() ? undefined : returnedOn });
    // An approved request to return this very asset is fulfilled by recovering it.
    await tx.assetRequest.updateMany({
      where: { tenantId: viewer.tenantId, employeeId: a.employeeId, requestType: "RETURN", heldAssetId: a.assetId, status: "APPROVED" },
      data: { status: "FULFILLED", assetId: a.assetId, closedAt: new Date(), closedBy: actorEmployee(viewer) },
    });
  });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetAssignment", entityId: a.id, summary: `Recovered ${a.asset.assetTag} from ${emp.displayName} (${d.conditionIn.toLowerCase()})${d.damageCharge ? `, damage ₹${d.damageCharge}` : ""}` });
  refresh();
  return { ok: true, message: `${a.asset.name ?? a.asset.assetType.name} recovered.` };
}

export async function acknowledgeAssetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record is linked to this login.");
  const id = str(fd, "assignmentId");
  const a = await prisma.assetAssignment.findFirst({ where: { id, employeeId: viewer.employee.id, returnedOn: null, asset: { tenantId: viewer.tenantId } }, include: { asset: true } });
  if (!a) return NO("Nothing to acknowledge — it is not assigned to you.");
  if (a.ackStatus !== "PENDING") return NO(a.ackStatus === "ACKNOWLEDGED" ? "You have already acknowledged this asset." : "This asset does not need an acknowledgement.");
  await prisma.$transaction(async (tx) => {
    await tx.assetAssignment.update({ where: { id: a.id }, data: { ackStatus: "ACKNOWLEDGED", acknowledgedAt: new Date() } });
    await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.assetId, kind: "ACKNOWLEDGED", employeeId: viewer.employee!.id, actorId: viewer.user.id, actorLabel: actorLabel(viewer) });
  });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetAssignment", entityId: a.id, summary: `Acknowledged receipt of ${a.asset.assetTag}` });
  refresh();
  return { ok: true, message: "Thanks — the asset is acknowledged." };
}

export async function remindAcknowledgementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_ASSIGN)) return DENIED;
  const ids = [...new Set(formList(fd, "ids"))].slice(0, 200);
  if (ids.length === 0) return NO("Select at least one asset to remind about.");
  const rows = await prisma.assetAssignment.findMany({
    where: { id: { in: ids }, ackStatus: "PENDING", returnedOn: null, asset: { tenantId: viewer.tenantId } },
    include: { asset: { include: { assetType: true } }, employee: { select: { id: true, userId: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  let sent = 0;
  for (const r of rows) {
    if (!canAccessEmployee(viewer, r.employee, P.ASSET_ASSIGN)) continue;
    await prisma.$transaction(async (tx) => {
      await tx.assetAssignment.update({ where: { id: r.id }, data: { ackRemindedAt: new Date(), ackRemindCount: { increment: 1 } } });
      await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: r.assetId, kind: "ACK_REMINDED", employeeId: r.employeeId, actorId: viewer.user.id, actorLabel: actorLabel(viewer) });
      await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "ASSET", title: `Please acknowledge ${r.asset.name ?? r.asset.assetType.name} (${r.asset.assetTag})`, body: "Confirm that you have received the asset assigned to you.", link: "/me/assets", email: true, relatedType: "AssetAssignment", relatedId: r.id, event: "ASSET_ACK_REMINDER", employeeIds: [r.employeeId] }, tx);
    });
    sent++;
  }
  if (sent === 0) return NO("None of the selected assets is waiting on an acknowledgement you can chase.");
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetAssignment", summary: `Sent ${sent} acknowledgement reminder${sent === 1 ? "" : "s"}` });
  refresh();
  return { ok: true, message: `Reminder sent for ${sent} asset${sent === 1 ? "" : "s"}.` };
}

// ===========================================================================
//  Requests
// ===========================================================================

const requestSchema = z.object({
  requestType: z.enum(["NEW_ASSET", "REPLACEMENT", "RETURN"]).default("NEW_ASSET"),
  title: z.string().trim().min(2, "Say which asset you need.").max(120),
  categoryId: z.string().optional(),
  assetTypeId: z.string().optional(),
  heldAssetId: z.string().optional(),
  reason: z.string().trim().min(3, "Give a reason for the request.").max(1000),
  neededBy: optDate,
});

export async function requestAssetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record is linked to this login.");
  const parsed = parseForm(requestSchema, fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const settings = await getAssetSettings(viewer.tenantId);
  if (!settings.allowEmployeeRequests) return NO("Asset requests are switched off for your organisation.");

  let categoryId = d.categoryId || null;
  const assetTypeId = d.assetTypeId || null;
  if (assetTypeId) {
    const t = await prisma.assetType.findFirst({ where: { id: assetTypeId, category: { tenantId: viewer.tenantId } } });
    if (!t) return { ok: false, message: "Asset type not found.", errors: { assetTypeId: "Not found." } };
    if (categoryId && t.categoryId !== categoryId) return { ok: false, message: "That type is not in the chosen category.", errors: { assetTypeId: "Not in this category." } };
    categoryId = t.categoryId;
  } else if (categoryId && !(await prisma.assetCategory.findFirst({ where: { id: categoryId, tenantId: viewer.tenantId } }))) {
    return { ok: false, message: "Asset category not found.", errors: { categoryId: "Not found." } };
  }
  let heldAssetId: string | null = null;
  if (d.requestType !== "NEW_ASSET") {
    const held = d.heldAssetId ? await prisma.assetAssignment.findFirst({ where: { assetId: d.heldAssetId, employeeId: viewer.employee.id, returnedOn: null, asset: { tenantId: viewer.tenantId } } }) : null;
    if (!held) return { ok: false, message: "Choose the asset you hold that this is about.", errors: { heldAssetId: "Choose one of your assets." } };
    heldAssetId = held.assetId;
    const dup = await prisma.assetRequest.findFirst({ where: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, heldAssetId, status: { in: ["PENDING", "APPROVED"] } } });
    if (dup) return NO("You already have an open request about that asset.");
  }
  if (d.neededBy && d.neededBy < today()) return { ok: false, message: "The needed-by date has passed.", errors: { neededBy: "In the past." } };

  const levels = await planRequestApprovals(viewer.tenantId, viewer.employee.id);
  const req = await prisma.$transaction(async (tx) => {
    const r = await tx.assetRequest.create({
      data: {
        tenantId: viewer.tenantId, employeeId: viewer.employee!.id, requestType: d.requestType, title: d.title,
        categoryId, assetTypeId, heldAssetId, reason: d.reason, neededBy: d.neededBy,
        status: levels.length ? "PENDING" : "APPROVED", currentLevel: 1, ...(levels.length ? {} : { approvedAt: new Date() }),
      },
    });
    if (levels.length) await tx.assetRequestApproval.createMany({ data: levels.map((l) => ({ tenantId: viewer.tenantId, requestId: r.id, level: l.level, approverKind: l.approverKind, approverId: l.approverId })) });
    return r;
  });
  const first = levels[0];
  const approverUsers = !first ? await usersWithPermission(viewer.tenantId, P.ASSET_ASSIGN)
    : first.approverId ? [(await prisma.employee.findUnique({ where: { id: first.approverId }, select: { userId: true } }))?.userId]
      : await usersWithPermission(viewer.tenantId, P.ASSET_MANAGE);
  await notify({ tenantId: viewer.tenantId, userIds: approverUsers.filter((u) => u !== viewer.user.id), kind: "ASSET", title: `${viewer.employee.displayName} requested an asset: ${d.title}`, body: d.reason, link: first ? "/inbox" : "/assets/requests" });
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "AssetRequest", entityId: req.id, summary: `Raised ${ASSET_REQUEST_TYPE_LABEL[d.requestType].toLowerCase()}: ${d.title}` });
  refresh();
  return { ok: true, message: "Your request has been raised.", values: { id: req.id } };
}

export async function cancelAssetRequestAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.assetRequest.findFirst({ where: { id: str(fd, "requestId"), tenantId: viewer.tenantId } });
  if (!r) return NO("Asset request not found.");
  const own = viewer.employee?.id === r.employeeId;
  if (!own && !can(viewer, P.ASSET_MANAGE)) return DENIED;
  if (r.status !== "PENDING" && r.status !== "APPROVED") return NO("Only an open request can be cancelled.");
  await prisma.assetRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", closedAt: new Date(), closedBy: actorEmployee(viewer) } });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetRequest", entityId: r.id, summary: `Cancelled asset request: ${r.title ?? r.reason}` });
  refresh();
  return { ok: true, message: "Request cancelled." };
}

export async function decideAssetRequestAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const decision = str(fd, "decision") === "reject" ? "reject" : "approve";
  const note = str(fd, "note").slice(0, 500) || null;
  if (decision === "reject" && !note) return { ok: false, message: "Give a reason for rejecting.", errors: { note: "Required." } };
  const r = await prisma.assetRequest.findFirst({
    where: { id: str(fd, "requestId"), tenantId: viewer.tenantId },
    include: { approvals: true, employee: { select: { id: true, userId: true, displayName: true } } },
  });
  if (!r) return NO("Asset request not found.");
  if (r.status !== "PENDING") return NO("This request has already been decided.");
  if (viewer.employee?.id === r.employeeId) return NO("You cannot decide your own request.");
  const result = decideAssetLevels(r.approvals as AssetLevelState[], { employeeId: viewer.employee?.id ?? null, canManage: can(viewer, P.ASSET_MANAGE) }, decision, (await getAssetSettings(viewer.tenantId)).skipDuplicateApprover);
  if (!result.ok) return NO(result.reason);
  const actedById = viewer.employee?.id ?? viewer.user.id;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const u of result.updates) {
      await tx.assetRequestApproval.update({
        where: { requestId_level: { requestId: r.id, level: u.level } },
        data: { status: u.status, actedById, actedAt: now, note: u.status === "SKIPPED" ? "Skipped due to already approved" : note },
      });
    }
    await tx.assetRequest.update({
      where: { id: r.id },
      data: result.outcome === "PENDING" ? { currentLevel: result.nextLevel! }
        : result.outcome === "APPROVED" ? { status: "APPROVED", approvedBy: actedById, approvedAt: now, currentLevel: Math.max(...r.approvals.map((a) => a.level)) }
          : { status: "REJECTED", rejectReason: note, closedAt: now, closedBy: actedById },
    });
  });
  if (result.outcome === "PENDING") {
    const next = r.approvals.find((a) => a.level === result.nextLevel)!;
    const users = next.approverId ? [(await prisma.employee.findUnique({ where: { id: next.approverId }, select: { userId: true } }))?.userId] : await usersWithPermission(viewer.tenantId, P.ASSET_MANAGE);
    await notify({ tenantId: viewer.tenantId, userIds: users, kind: "ASSET", title: `${r.employee.displayName}'s asset request is waiting on you`, body: r.title ?? r.reason, link: "/inbox" });
  } else {
    await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "ASSET", title: result.outcome === "APPROVED" ? `Your asset request was approved: ${r.title ?? ""}` : `Your asset request was rejected: ${r.title ?? ""}`, body: result.outcome === "REJECTED" ? note : "It will be assigned to you shortly.", link: "/me/assets?view=requests" });
    if (result.outcome === "APPROVED") await notify({ tenantId: viewer.tenantId, userIds: (await usersWithPermission(viewer.tenantId, P.ASSET_ASSIGN)).filter((u) => u !== viewer.user.id), kind: "ASSET", title: `Assign an asset to ${r.employee.displayName}`, body: r.title, link: "/assets/requests" });
  }
  await writeAudit(viewer, { module: "ASSET", action: decision === "approve" ? "APPROVE" : "REJECT", entityType: "AssetRequest", entityId: r.id, summary: `${decision === "approve" ? "Approved" : "Rejected"} ${r.employee.displayName}'s asset request: ${r.title ?? r.reason}` });
  refresh();
  return { ok: true, message: result.outcome === "REJECTED" ? "Request rejected." : result.outcome === "APPROVED" ? "Request approved — ready to assign." : "Approved — sent to the next approver." };
}

/** The same decision from a plain form (the inbox), which throws on refusal. */
export async function decideAssetRequestForm(fd: FormData): Promise<void> {
  const r = await decideAssetRequestAction({}, fd);
  if (!r.ok) throw new Error(r.message);
}

// ===========================================================================
//  Settings, ID series and scheduled reports
// ===========================================================================

export async function saveAssetSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const chain: AssetApproverKind[] = [];
  for (const k of ["level1", "level2", "level3"]) {
    const v = str(fd, k);
    if ((v === "REPORTING_MANAGER" || v === "ASSET_MANAGER") && !chain.includes(v)) chain.push(v);
  }
  const reminder = str(fd, "ackReminderDays");
  const reminderDays = reminder === "" ? null : Number(reminder);
  if (reminderDays !== null && (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 30)) return { ok: false, message: "Reminders run every 1 to 30 days, or leave it blank.", errors: { ackReminderDays: "1–30." } };
  const alert = Number(str(fd, "warrantyAlertDays") || "30");
  if (!Number.isInteger(alert) || alert < 1 || alert > 365) return { ok: false, message: "Warranty alerts are 1 to 365 days ahead.", errors: { warrantyAlertDays: "1–365." } };
  const data = { requestApprovalChain: chain, skipDuplicateApprover: fd.get("skipDuplicateApprover") === "on", allowEmployeeRequests: fd.get("allowEmployeeRequests") === "on", ackReminderDays: reminderDays, warrantyAlertDays: alert };
  const before = await prisma.assetSettings.findUnique({ where: { tenantId: viewer.tenantId } });
  await prisma.assetSettings.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetSettings", summary: "Updated asset settings", oldValue: before, newValue: data });
  refresh();
  return { ok: true, message: "Asset settings saved." };
}

const seriesSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name the series.").max(60),
  prefix: z.string().trim().max(16).regex(/^[A-Za-z0-9\-_/]*$/, "Letters, digits, - _ / only."),
  digits: z.coerce.number().int().min(1).max(8),
  suffix: z.string().trim().max(16).regex(/^[A-Za-z0-9\-_/]*$/, "Letters, digits, - _ / only.").optional(),
  nextNumber: z.coerce.number().int().min(1, "Start at 1 or more.").max(99_999_999),
  isDefault: z.string().optional().transform((v) => v === "on"),
});

export async function saveAssetIdSeriesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const parsed = parseForm(seriesSchema, fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const clash = await prisma.assetIdSeries.findFirst({ where: { tenantId: viewer.tenantId, name: d.name, ...(d.id ? { NOT: { id: d.id } } : {}) } });
  if (clash) return { ok: false, message: "A series with that name exists.", errors: { name: "Already in use." } };
  const data = { name: d.name, prefix: d.prefix, digits: d.digits, suffix: d.suffix ?? "", nextNumber: d.nextNumber, isDefault: d.isDefault };
  const saved = await prisma.$transaction(async (tx) => {
    if (d.isDefault) await tx.assetIdSeries.updateMany({ where: { tenantId: viewer.tenantId }, data: { isDefault: false } });
    if (d.id) {
      const before = await tx.assetIdSeries.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
      if (!before) return null;
      return tx.assetIdSeries.update({ where: { id: before.id }, data });
    }
    return tx.assetIdSeries.create({ data: { tenantId: viewer.tenantId, ...data } });
  });
  if (!saved) return NO("ID series not found.");
  await writeAudit(viewer, { module: "ASSET", action: d.id ? "UPDATE" : "CREATE", entityType: "AssetIdSeries", entityId: saved.id, summary: `${d.id ? "Updated" : "Added"} asset ID series ${saved.name}` });
  refresh();
  return { ok: true, message: "ID series saved." };
}

export async function toggleAssetIdSeriesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const s = await prisma.assetIdSeries.findFirst({ where: { id: str(fd, "id"), tenantId: viewer.tenantId } });
  if (!s) return NO("ID series not found.");
  await prisma.assetIdSeries.update({ where: { id: s.id }, data: { isActive: !s.isActive, ...(s.isActive ? { isDefault: false } : {}) } });
  await writeAudit(viewer, { module: "ASSET", action: "UPDATE", entityType: "AssetIdSeries", entityId: s.id, summary: `${s.isActive ? "Deactivated" : "Activated"} asset ID series ${s.name}` });
  refresh();
  return { ok: true, message: s.isActive ? "Series deactivated." : "Series activated." };
}

function nextRun(frequency: "DAILY" | "WEEKLY" | "MONTHLY", dayOfWeek: number | null, dayOfMonth: number | null, from = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 3, 30)); // 09:00 IST
  if (frequency === "DAILY") { d.setUTCDate(d.getUTCDate() + 1); return d; }
  if (frequency === "WEEKLY") {
    const want = (dayOfWeek ?? 1) % 7;
    do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== want);
    return d;
  }
  const dom = Math.min(28, Math.max(1, dayOfMonth ?? 1));
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() >= dom ? 1 : 0), dom, 3, 30));
  return m;
}

export async function scheduleAssetReportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const parsed = parseForm(z.object({
    reportKey: z.string().refine((k) => ASSET_REPORTS.some((r) => r.key === k), "Choose a report."),
    name: z.string().trim().min(2, "Name the schedule.").max(80),
    recipients: z.string().trim().min(3, "Add at least one recipient."),
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
    dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
    dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
  }), fd);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const emails = [...new Set(d.recipients.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((e) => !z.string().email().safeParse(e).success);
  if (bad.length) return { ok: false, message: `Not an email address: ${bad.join(", ")}`, errors: { recipients: "Check the addresses." } };
  if (emails.length > 10) return { ok: false, message: "Up to 10 recipients.", errors: { recipients: "Too many." } };
  const s = await prisma.scheduledReport.create({
    data: {
      tenantId: viewer.tenantId, reportKey: d.reportKey, name: d.name, recipients: emails, frequency: d.frequency,
      dayOfWeek: d.frequency === "WEEKLY" ? (d.dayOfWeek ?? 1) : null, dayOfMonth: d.frequency === "MONTHLY" ? (d.dayOfMonth ?? 1) : null,
      nextRunAt: nextRun(d.frequency, d.dayOfWeek ?? 1, d.dayOfMonth ?? 1), createdBy: viewer.user.id,
    },
  });
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "ScheduledReport", entityId: s.id, summary: `Scheduled ${d.name} (${d.frequency.toLowerCase()}) to ${emails.length} recipient(s)` });
  refresh();
  return { ok: true, message: "Report scheduled." };
}

export async function deleteScheduledAssetReportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const s = await prisma.scheduledReport.findFirst({ where: { id: str(fd, "id"), tenantId: viewer.tenantId, reportKey: { startsWith: "asset-" } } });
  if (!s) return NO("Schedule not found.");
  await prisma.scheduledReport.delete({ where: { id: s.id } });
  await writeAudit(viewer, { module: "ASSET", action: "DELETE", entityType: "ScheduledReport", entityId: s.id, summary: `Deleted the schedule ${s.name}` });
  refresh();
  return { ok: true, message: "Schedule deleted." };
}

// ===========================================================================
//  Bulk import: upload → map columns → review & import
// ===========================================================================

const MAX_IMPORT_ROWS = 2000;

async function importRefs(tenantId: string): Promise<AssetImportRefs> {
  const [locs, cats, tags] = await Promise.all([
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.assetCategory.findMany({ where: { tenantId }, select: { id: true, name: true, types: { select: { id: true, name: true } } } }),
    prisma.asset.findMany({ where: { tenantId }, select: { assetTag: true } }),
  ]);
  return {
    locations: new Map(locs.map((l) => [l.name.toLowerCase(), l.id])),
    categories: new Map(cats.map((c) => [c.name.toLowerCase(), { id: c.id, types: new Map(c.types.map((t) => [t.name.toLowerCase(), t.id])) }])),
    existingTags: new Set(tags.map((t) => t.assetTag.toLowerCase())),
  };
}

export async function startAssetImportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const mode = str(fd, "mode") === "UPDATE" ? "UPDATE" : "ADD";
  const typeId = str(fd, "assetTypeId") || null;
  if (typeId && !(await prisma.assetType.findFirst({ where: { id: typeId, category: { tenantId: viewer.tenantId } } }))) return NO("Asset type not found.");
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the filled-in template to upload.", errors: { file: "Required." } };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: "The file is larger than 2 MB.", errors: { file: "Too large." } };
  const data = Buffer.from(await file.arrayBuffer());
  if (data.includes(0)) return { ok: false, message: "Upload the template saved as CSV (comma separated).", errors: { file: "Not a CSV file." } };
  const rows = parseAssetCsv(data.toString("utf8"));
  if (rows.length < 2) return { ok: false, message: "The file has no rows under the header.", errors: { file: "Empty." } };
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { ok: false, message: `Up to ${MAX_IMPORT_ROWS} assets per file.`, errors: { file: "Too many rows." } };
  const headers = rows[0].map((h, i) => h || `Column ${i + 1}`);
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name || "assets.csv", mimeType: "text/csv", data, relatedType: "AssetImport", uploadedBy: viewer.user.id });
  const imp = await prisma.assetImport.create({
    data: { tenantId: viewer.tenantId, mode, assetTypeId: typeId, fileId: stored.id, headers, rows: rows.slice(1), mapping: autoMapAssetHeaders(headers), totalRows: rows.length - 1, createdBy: viewer.user.id },
  });
  await writeAudit(viewer, { module: "ASSET", action: "CREATE", entityType: "AssetImport", entityId: imp.id, summary: `Uploaded ${file.name} for a bulk ${mode === "ADD" ? "add" : "update"} (${rows.length - 1} rows)` });
  return { ok: true, message: "File uploaded.", values: { id: imp.id } };
}

export async function mapAssetImportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const imp = await prisma.assetImport.findFirst({ where: { id: str(fd, "id"), tenantId: viewer.tenantId } });
  if (!imp || imp.status === "IMPORTED") return NO("Import not found, or already imported.");
  const headers = imp.headers as string[];
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (let i = 0; i < headers.length; i++) {
    const f = str(fd, `map_${i}`);
    if (!f) continue;
    if (!ASSET_IMPORT_FIELDS.some((x) => x.key === f)) return NO("Unknown field in the mapping.");
    if (used.has(f)) return NO(`Two columns are mapped to ${ASSET_IMPORT_FIELDS.find((x) => x.key === f)!.label}.`);
    used.add(f); mapping[headers[i]] = f;
  }
  const { valid, issues } = validateAssetImport(imp.rows as string[][], headers, mapping, await importRefs(viewer.tenantId), imp.mode, imp.assetTypeId);
  await prisma.assetImport.update({ where: { id: imp.id }, data: { mapping, errors: issues as unknown as Prisma.InputJsonValue, okRows: valid.length, status: "VALIDATED" } });
  return { ok: true, message: issues.length ? `${valid.length} row(s) ready; ${issues.length} problem(s) to review.` : `All ${valid.length} row(s) are ready to import.`, values: { id: imp.id } };
}

export async function commitAssetImportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) return DENIED;
  const imp = await prisma.assetImport.findFirst({ where: { id: str(fd, "id"), tenantId: viewer.tenantId } });
  if (!imp || imp.status !== "VALIDATED") return NO("Map the columns and review the file first.");
  const { valid, issues } = validateAssetImport(imp.rows as string[][], imp.headers as string[], (imp.mapping ?? {}) as Record<string, string>, await importRefs(viewer.tenantId), imp.mode, imp.assetTypeId);
  if (valid.length === 0) return NO("There are no valid rows to import.");
  const lives = new Map((await prisma.assetType.findMany({ where: { category: { tenantId: viewer.tenantId } }, select: { id: true, category: { select: { usefulLifeMonths: true } } } })).map((t) => [t.id, t.category.usefulLifeMonths]));
  let done = 0;
  const skipped: Array<{ row: number; field: string; message: string }> = [];
  await prisma.$transaction(async (tx) => {
    for (const r of valid) {
      const data = {
        name: r.name, locationId: r.locationId, assetTypeId: r.assetTypeId, condition: r.condition,
        serialNumber: r.serialNumber, purchaseDate: r.purchaseDate, warrantyExpiry: r.warrantyExpiry, purchaseCost: r.purchaseCost, vendor: r.vendor, description: r.description,
        currentValue: assetBookValue(r.purchaseCost, r.purchaseDate, lives.get(r.assetTypeId) ?? null, today()),
      };
      if (imp.mode === "ADD") {
        const a = await tx.asset.create({ data: { ...data, tenantId: viewer.tenantId, assetTag: r.assetTag, status: r.status, unavailableReason: r.status === "AVAILABLE" ? null : "Imported as not available" } });
        await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "IMPORTED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), toValue: { status: r.status, condition: r.condition }, note: `Bulk add, row ${r.row}` });
      } else {
        const a = await tx.asset.findFirst({ where: { tenantId: viewer.tenantId, assetTag: { equals: r.assetTag, mode: "insensitive" } } });
        if (!a) { skipped.push({ row: r.row, field: "Asset ID", message: "No longer exists." }); continue; }
        if (a.status === "ASSIGNED" && r.status !== "AVAILABLE" && r.status !== a.status) { skipped.push({ row: r.row, field: "Asset Status", message: "Recover the asset before changing its status." }); continue; }
        const status = a.status === "ASSIGNED" ? "ASSIGNED" : r.status;
        await tx.asset.update({ where: { id: a.id }, data: { ...data, status, unavailableReason: status === "AVAILABLE" || status === "ASSIGNED" ? null : (a.unavailableReason ?? "Updated by import") } });
        await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: a.id, kind: "UPDATED", actorId: viewer.user.id, actorLabel: actorLabel(viewer), toValue: { status, condition: r.condition, location: r.locationId }, note: `Bulk update, row ${r.row}` });
      }
      done++;
    }
    await tx.assetImport.update({ where: { id: imp.id }, data: { status: "IMPORTED", committedAt: new Date(), okRows: done, errors: [...issues, ...skipped] as unknown as Prisma.InputJsonValue } });
  });
  await writeAudit(viewer, { module: "ASSET", action: imp.mode === "ADD" ? "CREATE" : "UPDATE", entityType: "AssetImport", entityId: imp.id, summary: `Bulk ${imp.mode === "ADD" ? "added" : "updated"} ${done} asset(s)${issues.length + skipped.length ? `, ${issues.length + skipped.length} row(s) skipped` : ""}` });
  refresh();
  return { ok: true, message: `${imp.mode === "ADD" ? "Added" : "Updated"} ${done} asset${done === 1 ? "" : "s"}${issues.length + skipped.length ? `; ${issues.length + skipped.length} row(s) skipped` : ""}.`, values: { id: imp.id } };
}

// ===========================================================================
//  AI: suggest the category and type for a request
// ===========================================================================

export async function suggestAssetTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record is linked to this login.");
  const title = str(fd, "title").slice(0, 200), reason = str(fd, "reason").slice(0, 600);
  if (title.length < 2) return NO("Say what you need first, then ask for a suggestion.");
  const types = await prisma.assetType.findMany({ where: { isActive: true, category: { tenantId: viewer.tenantId, isActive: true } }, select: { id: true, name: true, category: { select: { id: true, name: true } } } });
  if (!types.length) return NO("No asset types are set up yet.");
  const list = types.map((t, i) => `${i + 1}. ${t.category.name} › ${t.name}`).join("\n");
  const prompt = `Asset types:\n${list}\n\nRequest: ${title}\nReason: ${reason || "(none)"}`;
  const r = await aiForViewer(viewer, { feature: "ASSET_TRIAGE", inputChars: prompt.length }, () => aiJson<number>({
    system: "You route an employee's equipment request to one of the company's asset types. Reply with JSON {\"type\": n} where n is the number of the best matching type from the list, or {\"type\": 0} if none fits.",
    prompt, maxTokens: 50,
    validate: (v) => { const n = (v as { type?: unknown })?.type; return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= types.length ? n : null; },
  }));
  if (!r.ok) return NO(r.reason);
  if (r.value === 0) return NO("No asset type clearly fits — pick one yourself or leave it blank.");
  const t = types[r.value - 1];
  return { ok: true, message: `Suggested: ${t.category.name} › ${t.name}`, values: { categoryId: t.category.id, assetTypeId: t.id } };
}
