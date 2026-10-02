"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { fieldKeyFor, parseOptions, checkCustomValue, type CustomFieldKind } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone as done, zName, zOptional, zNumber, zBool, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const TYPES = ["TEXT", "NUMBER", "DATE", "DROPDOWN", "CHECKBOX", "MULTILINE", "EMAIL", "PHONE"] as const;

const definitionSchema = z.object({
  id: zOptional(40),
  label: zName(80),
  section: zOptional(60),
  type: z.enum(TYPES),
  options: zOptional(2000),
  isMandatory: zBool(),
  isActive: zBool(),
  displayOrder: zNumber({ min: 0, max: 999 }),
});

/** Add or edit an employee custom field. The key is fixed once created, so stored values keep their meaning. */
export async function saveCustomFieldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(definitionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const options = d.type === "DROPDOWN" ? parseOptions(d.options ?? "") : null;
  if (d.type === "DROPDOWN" && options!.length < 2) return { ok: false, message: "A dropdown needs at least two options.", errors: { options: "Give two or more options" } };
  const data = {
    label: d.label, section: d.section || null, type: d.type, options: options ?? Prisma.DbNull,
    isMandatory: d.isMandatory, isActive: d.isActive, displayOrder: d.displayOrder ?? 0,
  };

  if (d.id) {
    const before = await prisma.customFieldDefinition.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
    if (!before) return { ok: false, message: "That field no longer exists." };
    // Changing the type would leave stored values that the new type cannot read.
    if (before.type !== d.type && await prisma.customFieldValue.count({ where: { definitionId: before.id, value: { not: null } } }) > 0) {
      return { ok: false, message: "The type cannot change once employees have values for this field. Add a new field instead.", errors: { type: "Values already recorded" } };
    }
    await prisma.customFieldDefinition.update({ where: { id: before.id }, data });
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "CustomFieldDefinition", entityId: before.id, summary: `Updated custom field “${d.label}”`, oldValue: before, newValue: { ...data, options } });
    return done(["/admin/settings"], "Field saved.");
  }

  let fieldKey = fieldKeyFor(d.label);
  const taken = new Set((await prisma.customFieldDefinition.findMany({ where: { tenantId: viewer.tenantId, entity: "EMPLOYEE", fieldKey: { startsWith: fieldKey } }, select: { fieldKey: true } })).map((r) => r.fieldKey));
  for (let n = 2; taken.has(fieldKey); n++) fieldKey = `${fieldKeyFor(d.label)}_${n}`;
  const created = await prisma.customFieldDefinition.create({ data: { tenantId: viewer.tenantId, entity: "EMPLOYEE", fieldKey, ...data } });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "CustomFieldDefinition", entityId: created.id, summary: `Added custom field “${d.label}” (${d.type.toLowerCase()})`, newValue: { fieldKey, ...data, options } });
  return done(["/admin/settings"], `Added “${d.label}”.`);
}

/** Delete a field nobody has filled in; one with values is switched off instead, so history is kept. */
export async function deleteCustomFieldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const def = await prisma.customFieldDefinition.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!def) return { ok: false, message: "That field no longer exists." };
  const used = await prisma.customFieldValue.count({ where: { definitionId: def.id, value: { not: null } } });
  if (used > 0) {
    await prisma.customFieldDefinition.update({ where: { id: def.id }, data: { isActive: false } });
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "CustomFieldDefinition", entityId: def.id, summary: `Switched off custom field “${def.label}” (${used} values kept)` });
    return done(["/admin/settings"], `“${def.label}” has ${used} recorded value(s), so it was switched off rather than deleted.`);
  }
  await prisma.customFieldDefinition.delete({ where: { id: def.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "CustomFieldDefinition", entityId: def.id, summary: `Deleted custom field “${def.label}”`, oldValue: def });
  return done(["/admin/settings"], `Deleted “${def.label}”.`);
}

/** Save an employee's values for every active field at once; inputs are named f_<definition id>. */
export async function saveEmployeeCustomFieldsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const employeeId = String(formData.get("employeeId") ?? "");
  const target = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, displayName: true, employeeNumber: true },
  });
  if (!target) return { ok: false, message: "Employee not found" };
  if (!canAccessEmployee(viewer, target, P.EMPLOYEE_UPDATE)) return { ok: false, message: "Your roles do not reach this employee record." };

  const defs = await prisma.customFieldDefinition.findMany({ where: { tenantId: viewer.tenantId, entity: "EMPLOYEE", isActive: true } });
  const existing = new Map((await prisma.customFieldValue.findMany({ where: { ownerId: target.id, definitionId: { in: defs.map((d) => d.id) } } })).map((v) => [v.definitionId, v.value]));
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  const next: Array<{ id: string; label: string; value: string | null }> = [];
  for (const def of defs) {
    const raw = formData.get(`f_${def.id}`);
    values[`f_${def.id}`] = typeof raw === "string" ? raw : "";
    const r = checkCustomValue({ label: def.label, type: def.type as CustomFieldKind, options: (def.options as string[] | null) ?? null, isMandatory: def.isMandatory }, typeof raw === "string" ? raw : null);
    if ("error" in r) errors[`f_${def.id}`] = r.error;
    else next.push({ id: def.id, label: def.label, value: r.value });
  }
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors, values };

  const changed = next.filter((n) => (existing.get(n.id) ?? null) !== n.value);
  if (!changed.length) return { ok: true, message: "No changes." };
  await prisma.$transaction(changed.map((n) => prisma.customFieldValue.upsert({
    where: { definitionId_ownerId: { definitionId: n.id, ownerId: target.id } },
    create: { definitionId: n.id, ownerId: target.id, value: n.value },
    update: { value: n.value },
  })));
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: target.id,
    summary: `Updated ${changed.map((c) => c.label).join(", ")} for ${target.displayName} (${target.employeeNumber})`,
    oldValue: Object.fromEntries(changed.map((c) => [c.label, existing.get(c.id) ?? null])),
    newValue: Object.fromEntries(changed.map((c) => [c.label, c.value])),
  });
  return done([`/employees/${target.id}`], "Saved.");
}
