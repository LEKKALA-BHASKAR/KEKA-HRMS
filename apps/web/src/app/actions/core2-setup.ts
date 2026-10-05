"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  takeConfigSnapshot, restoreConfig, captureConfig, validateConfigPayload, diffConfigPayloads, CONFIG_SECTIONS, CONFIG_ENVIRONMENTS,
  APPROVAL_POLICY_LIBRARY, saveWorkflowDefinition, REFERENCE_IMPORT_KINDS, validateReferenceRows, parseCsv, hierarchyCycle,
  COMPLETENESS_FIELDS, HR_TRANSACTION_TYPES, type ConfigPayload, type ConfigSection, type ReferenceImportKind,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { isHrFor } from "@/lib/core-hr";
import {
  z, parseForm, writeAudit, actionDone as done, formList, zName, zOptional, zOptionalId, zId, zBool, zNumber, zRequiredNumber, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Company setup, second pass: configuration snapshots (checkpoints,
 * environment sets, export / import, rollback), branding profiles,
 * country availability, the employee status catalog, master dictionaries,
 * the approval policy library, reference-data import, HR transaction SLAs
 * and master-data completeness rules.
 */

const SETUP = "/admin/setup";
const MAX_FILE = 2 * 1024 * 1024;

async function fileOrText(formData: FormData, fileKey: string, textKey: string): Promise<string | { error: string }> {
  const file = formData.get(fileKey);
  if (file && typeof file === "object" && "text" in file && file.size > 0) {
    if (file.size > MAX_FILE) return { error: "The file is larger than 2 MB." };
    return file.text();
  }
  return String(formData.get(textKey) ?? "");
}

// ---------------------------------------------------------------------------
//  Configuration snapshots
// ---------------------------------------------------------------------------

const snapshotSchema = z.object({ name: zName(120), environment: z.enum(CONFIG_ENVIRONMENTS).default("PRODUCTION"), note: zOptional(500) });

/** Save a named checkpoint of the configuration, to compare against or roll back to. */
export async function takeConfigSnapshotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(snapshotSchema, formData);
  if (parsed.state) return parsed.state;
  const snap = await takeConfigSnapshot({ tenantId: viewer.tenantId, ...parsed.data, kind: "CHECKPOINT", actorUserId: viewer.user.id });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ConfigSnapshot", entityId: snap.id, summary: `Saved configuration checkpoint "${snap.name}" (${snap.environment.toLowerCase()})` });
  return done([`${SETUP}?tab=config`], `Saved checkpoint "${snap.name}".`);
}

/** Roll the configuration back to a checkpoint (a copy of the current one is kept first). */
export async function restoreConfigSnapshotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const snap = await prisma.configSnapshot.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!snap) return { ok: false, message: "Checkpoint not found." };
  const check = validateConfigPayload(snap.payload);
  if (!check.ok) return { ok: false, message: check.issues.join(" ") };
  const sections = formList(formData, "sections").filter((s): s is ConfigSection => s in CONFIG_SECTIONS);
  const res = await restoreConfig({ tenantId: viewer.tenantId, payload: check.payload, actorUserId: viewer.user.id, sections: sections.length ? sections : undefined, label: `rolling back to "${snap.name}"` });
  if (!res.ok) return { ok: false, message: res.message };
  await prisma.configSnapshot.update({ where: { id: snap.id }, data: { restoredAt: new Date(), restoredBy: viewer.user.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ConfigSnapshot", entityId: snap.id, summary: `Rolled the configuration back to "${snap.name}"`, newValue: res.applied });
  return done([SETUP, "/admin/company", "/admin/settings"], res.message);
}

export async function deleteConfigSnapshotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const snap = await prisma.configSnapshot.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!snap) return { ok: false, message: "Checkpoint not found." };
  await prisma.configSnapshot.delete({ where: { id: snap.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "ConfigSnapshot", entityId: snap.id, summary: `Deleted configuration copy "${snap.name}"` });
  return done([`${SETUP}?tab=config`], "Deleted.");
}

/**
 * Import a configuration exported from another environment (or company).
 * "check" lists what would change; "apply" applies it, keeping a copy of
 * what was there first and the imported file itself.
 */
export async function importConfigAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const text = await fileOrText(formData, "file", "json");
  if (typeof text !== "string") return { ok: false, message: text.error };
  if (!text.trim()) return { ok: false, message: "Choose an exported configuration file or paste it." };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, message: "The file is not valid JSON." }; }
  const check = validateConfigPayload(raw);
  if (!check.ok) return { ok: false, message: check.issues.join(" ") };
  const sections = formList(formData, "sections").filter((s): s is ConfigSection => s in CONFIG_SECTIONS);
  const wanted = sections.length ? sections : (Object.keys(check.payload.sections) as ConfigSection[]);
  const current = await captureConfig(viewer.tenantId);
  const only = (p: ConfigPayload): ConfigPayload => ({ ...p, sections: Object.fromEntries(Object.entries(p.sections).filter(([k]) => wanted.includes(k as ConfigSection))) });
  const diff = diffConfigPayloads(only(current), only(check.payload));
  if (String(formData.get("intent") ?? "check") !== "apply") {
    const by = new Map<string, number>();
    for (const d of diff) by.set(d.section, (by.get(d.section) ?? 0) + 1);
    return { ok: true, message: diff.length ? `The file would change ${diff.length} setting(s): ${[...by].map(([s, n]) => `${CONFIG_SECTIONS[s as ConfigSection] ?? s} (${n})`).join(", ")}. Choose "Apply" to import it.` : "The file matches the current configuration; nothing would change.", values: { json: text.slice(0, 200_000) } };
  }
  const res = await restoreConfig({ tenantId: viewer.tenantId, payload: check.payload, actorUserId: viewer.user.id, sections: wanted, label: "an import" });
  if (!res.ok) return { ok: false, message: res.message };
  const env = CONFIG_ENVIRONMENTS.includes(String(formData.get("environment")) as never) ? String(formData.get("environment")) : "PRODUCTION";
  const snap = await takeConfigSnapshot({ tenantId: viewer.tenantId, name: `Imported ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, environment: env, kind: "IMPORT", actorUserId: viewer.user.id, payload: check.payload, note: `${diff.length} setting(s) changed` });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ConfigSnapshot", entityId: snap.id, summary: `Imported a configuration file: ${diff.length} setting(s) changed`, newValue: res.applied });
  return done([SETUP, "/admin/company", "/admin/settings"], `${res.message} ${diff.length} setting(s) differed.`);
}

// ---------------------------------------------------------------------------
//  Branding profiles and country availability
// ---------------------------------------------------------------------------

const color = () => z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1266a8");
const brandSchema = z.object({
  id: zOptionalId(), name: zName(80), portalTitle: zName(80), primaryColor: color(), accentColor: color(), logoText: zOptional(40),
  welcomeMessage: zOptional(300), legalEntityId: zOptionalId(), businessUnitId: zOptionalId(), isDefault: zBool(), isActive: zBool(),
});

export async function saveBrandingProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(brandSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const t = viewer.tenantId;
  if (id && !(await prisma.brandingProfile.findFirst({ where: { id, tenantId: t } }))) return { ok: false, message: "Branding profile not found." };
  if (d.legalEntityId && !(await prisma.legalEntity.findFirst({ where: { id: d.legalEntityId, tenantId: t } }))) return { ok: false, message: "That legal entity was not found." };
  if (d.businessUnitId && !(await prisma.businessUnit.findFirst({ where: { id: d.businessUnitId, tenantId: t } }))) return { ok: false, message: "That business unit was not found." };
  const clash = await prisma.brandingProfile.findFirst({ where: { tenantId: t, name: d.name, NOT: id ? { id } : undefined } });
  if (clash) return { ok: false, message: "Another profile has that name.", errors: { name: "Already used" } };
  const row = await prisma.$transaction(async (tx) => {
    if (d.isDefault) await tx.brandingProfile.updateMany({ where: { tenantId: t }, data: { isDefault: false } });
    return id ? tx.brandingProfile.update({ where: { id }, data: d }) : tx.brandingProfile.create({ data: { tenantId: t, ...d } });
  });
  await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "BrandingProfile", entityId: row.id, summary: `${id ? "Updated" : "Added"} branding profile ${d.name}${d.businessUnitId || d.legalEntityId ? " for a unit" : d.isDefault ? " (default)" : ""}`, newValue: d });
  return done([`${SETUP}?tab=branding`, "/"], `Saved ${d.name}.`);
}

export async function deleteBrandingProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const row = await prisma.brandingProfile.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Branding profile not found." };
  await prisma.brandingProfile.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "BrandingProfile", entityId: row.id, summary: `Deleted branding profile ${row.name}` });
  return done([`${SETUP}?tab=branding`], "Deleted.");
}

const countrySchema = z.object({ countryCode: z.string().regex(/^[A-Za-z]{2}$/, "Two letters, like IN").transform((v) => v.toUpperCase()), countryName: zName(80), currency: zOptional(3), isActive: zBool(), note: zOptional(300) });

export async function saveCountryAvailabilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(countrySchema, formData);
  if (parsed.state) return parsed.state;
  const modules = formList(formData, "modules");
  const d = { ...parsed.data, currency: parsed.data.currency?.toUpperCase() ?? null, modules };
  const row = await prisma.countryAvailability.upsert({ where: { tenantId_countryCode: { tenantId: viewer.tenantId, countryCode: d.countryCode } }, create: { tenantId: viewer.tenantId, ...d }, update: d });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "CountryAvailability", entityId: row.id, summary: `${d.countryName}: ${modules.length ? modules.join(", ") : "no modules"}${d.isActive ? "" : " (inactive)"}`, newValue: d });
  return done([`${SETUP}?tab=catalogs`], `Saved ${d.countryName}.`);
}

export async function deleteCountryAvailabilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const row = await prisma.countryAvailability.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Not found." };
  await prisma.countryAvailability.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "CountryAvailability", entityId: row.id, summary: `Removed ${row.countryName} from the country matrix` });
  return done([`${SETUP}?tab=catalogs`], "Removed.");
}

// ---------------------------------------------------------------------------
//  Employee status catalog and master dictionaries
// ---------------------------------------------------------------------------

const BASE_STATUSES = ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD", "ON_LEAVE", "SUSPENDED", "EXITED"] as const;
const code = () => z.string().trim().regex(/^[A-Z0-9_]{2,30}$/, "Capital letters, digits and _ (2–30)");
const statusSchema = z.object({ id: zOptionalId(), code: code(), label: zName(60), baseStatus: z.enum(BASE_STATUSES), description: zOptional(300), color: color().default("#6b7280"), isActive: zBool() });

export async function saveStatusCatalogAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(statusSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (id && !(await prisma.employeeStatusCatalog.findFirst({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Status not found." };
  if (await prisma.employeeStatusCatalog.findFirst({ where: { tenantId: viewer.tenantId, code: d.code, NOT: id ? { id } : undefined } })) return { ok: false, message: "That code is used.", errors: { code: "Already used" } };
  const row = id ? await prisma.employeeStatusCatalog.update({ where: { id }, data: d }) : await prisma.employeeStatusCatalog.create({ data: { tenantId: viewer.tenantId, ...d } });
  await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "EmployeeStatusCatalog", entityId: row.id, summary: `${id ? "Updated" : "Added"} employee status ${d.label} (under ${d.baseStatus.toLowerCase()})` });
  return done([`${SETUP}?tab=catalogs`], `Saved ${d.label}.`);
}

/** Give an employee one of the company's own statuses (it must sit under their system status). */
export async function setEmployeeStatusTagAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!(await isHrFor(viewer, employeeId))) return { ok: false, message: "This employee is outside the people you look after." };
  const catalogId = String(formData.get("catalogId") ?? "");
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { status: true, displayName: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (!catalogId) {
    await prisma.employeeStatusTag.deleteMany({ where: { employeeId, tenantId: viewer.tenantId } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeStatusTag", entityId: employeeId, summary: `Cleared ${emp.displayName}'s catalog status` });
    return done([`/employees/${employeeId}/master`], "Cleared.");
  }
  const entry = await prisma.employeeStatusCatalog.findFirst({ where: { id: catalogId, tenantId: viewer.tenantId, isActive: true } });
  if (!entry) return { ok: false, message: "That status is not in the catalog." };
  if (entry.baseStatus !== emp.status) return { ok: false, message: `${entry.label} sits under ${entry.baseStatus.toLowerCase().replace("_", " ")}; ${emp.displayName} is ${emp.status.toLowerCase().replace("_", " ")}.` };
  const note = String(formData.get("note") ?? "").trim() || null;
  await prisma.employeeStatusTag.upsert({ where: { employeeId }, create: { tenantId: viewer.tenantId, employeeId, catalogId, note, setBy: viewer.user.id }, update: { catalogId, note, since: new Date(), setBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeStatusTag", entityId: employeeId, summary: `Set ${emp.displayName}'s status to ${entry.label}` });
  return done([`/employees/${employeeId}/master`], `Status set to ${entry.label}.`);
}

const dictSchema = z.object({ id: zOptionalId(), key: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, "Lower-case letters, digits and _"), name: zName(80), description: zOptional(300), isActive: zBool() });

export async function saveDictionaryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(dictSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (id && !(await prisma.masterDictionary.findFirst({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Dictionary not found." };
  if (await prisma.masterDictionary.findFirst({ where: { tenantId: viewer.tenantId, key: d.key, NOT: id ? { id } : undefined } })) return { ok: false, message: "That key is used.", errors: { key: "Already used" } };
  const row = id ? await prisma.masterDictionary.update({ where: { id }, data: d }) : await prisma.masterDictionary.create({ data: { tenantId: viewer.tenantId, ...d } });
  await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "MasterDictionary", entityId: row.id, summary: `${id ? "Updated" : "Added"} master dictionary ${d.name}` });
  return done([`${SETUP}?tab=catalogs`], `Saved ${d.name}.`);
}

const entrySchema = z.object({ dictionaryId: zId(), code: z.string().trim().min(1).max(40), label: zName(120), sortOrder: zNumber({ min: 0, max: 9999 }).transform((v) => v ?? 0), isActive: zBool() });

export async function saveDictionaryEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(entrySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const dict = await prisma.masterDictionary.findFirst({ where: { id: d.dictionaryId, tenantId: viewer.tenantId } });
  if (!dict) return { ok: false, message: "Dictionary not found." };
  await prisma.masterDictionaryEntry.upsert({ where: { dictionaryId_code: { dictionaryId: dict.id, code: d.code } }, create: d, update: { label: d.label, sortOrder: d.sortOrder, isActive: d.isActive } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "MasterDictionary", entityId: dict.id, summary: `${dict.name}: ${d.code} = ${d.label}${d.isActive ? "" : " (inactive)"}` });
  return done([`${SETUP}?tab=catalogs`], `Saved ${d.label}.`);
}

export async function deleteDictionaryEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const e = await prisma.masterDictionaryEntry.findFirst({ where: { id: String(formData.get("id") ?? ""), dictionary: { tenantId: viewer.tenantId } }, include: { dictionary: true } });
  if (!e) return { ok: false, message: "Entry not found." };
  await prisma.masterDictionaryEntry.delete({ where: { id: e.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "MasterDictionary", entityId: e.dictionaryId, summary: `${e.dictionary.name}: removed ${e.code}` });
  return done([`${SETUP}?tab=catalogs`], "Removed.");
}

// ---------------------------------------------------------------------------
//  Approval policy library
// ---------------------------------------------------------------------------

/** Install a ready-made approval policy as a workflow definition, to adjust under Workflows. */
export async function installApprovalPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const item = APPROVAL_POLICY_LIBRARY.find((p) => p.key === String(formData.get("key") ?? ""));
  if (!item) return { ok: false, message: "That policy is not in the library." };
  const existing = await prisma.workflowDefinition.findFirst({ where: { tenantId: viewer.tenantId, name: item.name, isCurrent: true } });
  if (existing) return { ok: false, message: `"${item.name}" is already installed. Edit it under Workflows.` };
  const res = await saveWorkflowDefinition({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, entityType: item.entityType, name: item.name, description: item.description, isActive: true, steps: item.steps });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "WorkflowDefinition", entityId: res.id ?? null, summary: `Installed "${item.name}" from the approval policy library` });
  return done([`${SETUP}?tab=policies`, "/admin/workflows"], `Installed "${item.name}". It now routes ${item.entityType.toLowerCase().replace(/_/g, " ")}s.`);
}

// ---------------------------------------------------------------------------
//  Reference data import (with a check before anything is written)
// ---------------------------------------------------------------------------

export async function importReferenceDataAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const kind = String(formData.get("kind") ?? "") as ReferenceImportKind;
  if (!(kind in REFERENCE_IMPORT_KINDS)) return { ok: false, message: "Pick what to import." };
  const text = await fileOrText(formData, "file", "csv");
  if (typeof text !== "string") return { ok: false, message: text.error };
  if (!text.trim()) return { ok: false, message: "Choose a CSV file or paste the rows." };
  const t = viewer.tenantId;
  const lower = (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const [depts, locs, ccs, units, entities, titles, bands] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true } }),
    prisma.costCenter.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true } }),
    prisma.businessUnit.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true } }),
    prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    prisma.jobTitle.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    prisma.band.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
  ]);
  const own = { DEPARTMENT: depts, LOCATION: locs, COST_CENTRE: ccs, BUSINESS_UNIT: units, JOB_TITLE: titles.map((x) => ({ ...x, parentId: null })) }[kind];
  const ownMap = lower(own);
  const keys = (m: Map<string, string>) => new Set(m.keys());
  const { rows, headerError } = validateReferenceRows(kind, parseCsv(text), {
    existing: keys(ownMap),
    refs: { parent: keys(ownMap), business_unit: keys(lower(units)), legal_entity: keys(lower(entities)), band: keys(lower(bands)) },
  });
  if (headerError) return { ok: false, message: headerError, values: { csv: text.slice(0, 50_000) } };
  if (!rows.length) return { ok: false, message: "There are no rows under the header.", values: { csv: text.slice(0, 50_000) } };
  if (kind === "BUSINESS_UNIT") for (const r of rows) if (!r.values.legal_entity && r.action === "CREATE") r.errors.push("A new business unit needs its legal entity.");
  const bad = rows.filter((r) => r.errors.length);
  const creates = rows.filter((r) => r.action === "CREATE").length;
  if (String(formData.get("intent") ?? "check") !== "apply" || bad.length) {
    const detail = bad.slice(0, 5).map((r) => `line ${r.line}: ${r.errors.join(" ")}`).join("; ");
    return {
      ok: bad.length === 0,
      message: bad.length ? `${bad.length} of ${rows.length} row(s) have problems — nothing was imported. ${detail}${bad.length > 5 ? " …" : ""}` : `All ${rows.length} row(s) are valid: ${creates} new, ${rows.length - creates} update(s). Choose "Import" to write them.`,
      values: { csv: text.slice(0, 50_000), kind },
    };
  }
  // Write in file order, so a parent defined earlier in the file exists for its children.
  const entityId = lower(entities), unitId = lower(units), bandId = lower(bands);
  const parentOf = new Map(own.map((o) => [o.id, (o as { parentId?: string | null }).parentId ?? null]));
  let written = 0;
  const failed = await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const v = r.values;
      const existingId = ownMap.get(r.name.toLowerCase());
      const parentId = v.parent ? ownMap.get(v.parent.toLowerCase()) ?? null : undefined;
      if (existingId && parentId && hierarchyCycle(existingId, parentId, parentOf)) throw new Error(`Line ${r.line}: ${r.name} cannot sit under ${v.parent} (that makes a loop).`);
      let id: string;
      if (kind === "DEPARTMENT") {
        const data = { code: v.code || null, description: v.description || null, ...(parentId !== undefined ? { parentId } : {}), ...(v.business_unit ? { businessUnitId: unitId.get(v.business_unit.toLowerCase()) ?? null } : {}) };
        id = existingId ? (await tx.department.update({ where: { id: existingId }, data })).id : (await tx.department.create({ data: { tenantId: t, name: r.name, ...data } })).id;
      } else if (kind === "LOCATION") {
        const data = { code: v.code || null, city: v.city || null, stateCode: v.state_code ? v.state_code.toUpperCase() : null, state: v.state || null, postalCode: v.postal_code || null, ...(v.timezone ? { timezone: v.timezone } : {}), ...(parentId !== undefined ? { parentId } : {}) };
        id = existingId ? (await tx.location.update({ where: { id: existingId }, data })).id : (await tx.location.create({ data: { tenantId: t, name: r.name, ...data } })).id;
      } else if (kind === "COST_CENTRE") {
        const data = { code: v.code || null, ...(parentId !== undefined ? { parentId } : {}), ...(v.legal_entity ? { legalEntityId: entityId.get(v.legal_entity.toLowerCase()) ?? null } : {}) };
        id = existingId ? (await tx.costCenter.update({ where: { id: existingId }, data })).id : (await tx.costCenter.create({ data: { tenantId: t, name: r.name, ...data } })).id;
      } else if (kind === "BUSINESS_UNIT") {
        const data = { code: v.code || null, plCode: v.pl_code || null, ...(parentId !== undefined ? { parentId } : {}) };
        const le = v.legal_entity ? entityId.get(v.legal_entity.toLowerCase()) : undefined;
        id = existingId ? (await tx.businessUnit.update({ where: { id: existingId }, data: { ...data, ...(le ? { legalEntityId: le } : {}) } })).id : (await tx.businessUnit.create({ data: { tenantId: t, name: r.name, legalEntityId: le!, ...data } })).id;
      } else {
        const data = { bandId: v.band ? bandId.get(v.band.toLowerCase()) ?? null : null };
        id = existingId ? (await tx.jobTitle.update({ where: { id: existingId }, data })).id : (await tx.jobTitle.create({ data: { tenantId: t, name: r.name, ...data } })).id;
      }
      ownMap.set(r.name.toLowerCase(), id);
      if (parentId !== undefined) parentOf.set(id, parentId);
      written++;
    }
    return null;
  }).catch((err: unknown) => (err instanceof Error ? err.message : "The import failed."));
  if (failed) return { ok: false, message: `${failed} Nothing was imported.`, values: { csv: text.slice(0, 50_000), kind } };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ReferenceImport", entityId: kind, summary: `Imported ${written} ${REFERENCE_IMPORT_KINDS[kind].label.toLowerCase()} (${creates} new, ${written - creates} updated)` });
  return done(["/org", `${SETUP}?tab=reference`], `Imported ${written} row(s): ${creates} new, ${written - creates} updated.`);
}

// ---------------------------------------------------------------------------
//  HR transaction SLAs and completeness rules
// ---------------------------------------------------------------------------

export async function saveSlaPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ transactionType: z.enum(Object.keys(HR_TRANSACTION_TYPES) as [string, ...string[]]), targetHours: zRequiredNumber({ min: 1, max: 2000 }) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  await prisma.hrSlaPolicy.upsert({ where: { tenantId_transactionType: { tenantId: viewer.tenantId, transactionType: d.transactionType } }, create: { tenantId: viewer.tenantId, ...d }, update: { targetHours: d.targetHours } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HrSlaPolicy", entityId: d.transactionType, summary: `${HR_TRANSACTION_TYPES[d.transactionType as keyof typeof HR_TRANSACTION_TYPES].label}: ${d.targetHours}h target` });
  return done(["/hr-ops/desk"], "Saved.");
}

export async function saveCompletenessRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ field: z.enum(Object.keys(COMPLETENESS_FIELDS) as [string, ...string[]]), workerTypeId: zOptionalId(), severity: z.enum(["ERROR", "WARNING"]).default("ERROR") }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.workerTypeId && !(await prisma.workerType.findFirst({ where: { id: d.workerTypeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Employment type not found." };
  const existing = await prisma.fieldCompletenessRule.findFirst({ where: { tenantId: viewer.tenantId, field: d.field, workerTypeId: d.workerTypeId ?? null } });
  const row = existing ? await prisma.fieldCompletenessRule.update({ where: { id: existing.id }, data: { severity: d.severity, isActive: true } }) : await prisma.fieldCompletenessRule.create({ data: { tenantId: viewer.tenantId, field: d.field, workerTypeId: d.workerTypeId ?? null, severity: d.severity } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "FieldCompletenessRule", entityId: row.id, summary: `${COMPLETENESS_FIELDS[d.field as keyof typeof COMPLETENESS_FIELDS]} is ${d.severity === "ERROR" ? "required" : "recommended"}${d.workerTypeId ? " for one employment type" : ""}` });
  return done(["/hr-ops/quality"], "Saved the rule.");
}

export async function deleteCompletenessRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const row = await prisma.fieldCompletenessRule.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Rule not found." };
  await prisma.fieldCompletenessRule.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "FieldCompletenessRule", entityId: row.id, summary: `Removed the completeness rule for ${row.field}` });
  return done(["/hr-ops/quality"], "Removed.");
}

/** Whether employees may issue their own ID card, or must request one for HR to approve. */
export async function saveIdCardPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const requireApproval = formData.get("requireApproval") === "on";
  await prisma.changeApprovalSetting.upsert({ where: { tenantId_targetType: { tenantId: viewer.tenantId, targetType: "ID_CARD" } }, create: { tenantId: viewer.tenantId, targetType: "ID_CARD", requireApproval, updatedBy: viewer.user.id }, update: { requireApproval, updatedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ChangeApprovalSetting", entityId: "ID_CARD", summary: requireApproval ? "ID cards now need HR approval" : "Employees may issue their own ID card" });
  return done([SETUP, "/me/id-card"], "Saved.");
}
