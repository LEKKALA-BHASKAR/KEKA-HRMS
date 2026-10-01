import "server-only";
import { prisma } from "@keka/db";
import { helpdeskAudienceAllows, helpdeskUserNames } from "@keka/services";
import type { PickerCategory } from "./category-picker";

/** Active categories this employee may raise in, as a tree (parents with their active subcategories). */
export async function raisableCategories(tenantId: string, employeeId: string | null | undefined): Promise<PickerCategory[]> {
  if (!employeeId) return [];
  const me = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, departmentId: true, locationId: true, businessUnitId: true } });
  if (!me) return [];
  const cats = await prisma.helpdeskCategory.findMany({
    where: { tenantId, isActive: true, parentId: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true, name: true, description: true, audience: true,
      children: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, description: true, audience: true } },
    },
  });
  return cats
    .filter((c) => helpdeskAudienceAllows(c.audience, me))
    .map((c) => ({ id: c.id, name: c.name, description: c.description, children: c.children.filter((k) => helpdeskAudienceAllows(k.audience ?? c.audience, me)).map(({ id, name, description }) => ({ id, name, description })) }));
}

/** Category options for filters: parents, then their subcategories indented. */
export async function categoryOptions(tenantId: string, opts: { only?: string[]; includeInactive?: boolean } = {}) {
  const cats = await prisma.helpdeskCategory.findMany({
    where: { tenantId, parentId: null, ...(opts.includeInactive ? {} : { isActive: true }) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, children: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, isActive: true } } },
  });
  const allow = opts.only ? new Set(opts.only) : null;
  const out: Array<{ value: string; label: string; depth?: number }> = [];
  for (const c of cats) {
    const kids = c.children.filter((k) => (opts.includeInactive || k.isActive) && (!allow || allow.has(k.id)));
    if (allow && !allow.has(c.id) && !kids.length) continue;
    out.push({ value: c.id, label: c.name });
    for (const k of kids) out.push({ value: k.id, label: k.name, depth: 1 });
  }
  return out;
}

/** Leaf categories (for "Change Category" and the ticket details panel). */
export async function leafCategories(tenantId: string) {
  const cats = await prisma.helpdeskCategory.findMany({
    where: { tenantId, isActive: true, children: { none: { isActive: true } } },
    select: { id: true, name: true, parent: { select: { name: true, isActive: true } } },
  });
  return cats.filter((c) => !c.parent || c.parent.isActive)
    .map((c) => ({ value: c.id, label: c.parent ? `${c.parent.name} > ${c.name}` : c.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function names(tenantId: string, ids: Array<string | null | undefined>) {
  return helpdeskUserNames(tenantId, ids);
}

/** Attachments for a set of tickets/comments, keyed by relatedId. */
export async function attachmentsFor(tenantId: string, relatedIds: string[]) {
  if (!relatedIds.length) return new Map<string, Array<{ id: string; filename: string }>>();
  const rows = await prisma.storedFile.findMany({
    where: { tenantId, relatedType: { in: ["HelpdeskTicket", "HelpdeskComment"] }, relatedId: { in: relatedIds } },
    select: { id: true, filename: true, relatedId: true }, orderBy: { createdAt: "asc" },
  });
  const m = new Map<string, Array<{ id: string; filename: string }>>();
  for (const r of rows) m.set(r.relatedId!, [...(m.get(r.relatedId!) ?? []), { id: r.id, filename: r.filename }]);
  return m;
}
