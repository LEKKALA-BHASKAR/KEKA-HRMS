"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { safeLinkUrl } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone, type ActionState } from "@/lib/forms";
import { WIDGET_BY_TYPE, WIDGETS, isWidgetColor, isWidgetType, linksOf, QUICK_LINKS_MAX, type WidgetType } from "@/app/(app)/home/_lib/widgets";
import { dashboardLayout } from "@/app/(app)/home/_lib/wall";

/**
 * Quick Access configuration. The layout belongs to the organisation ("Any
 * changes made are applied to all employees in the organization"), so every
 * action here needs the organisation-settings permission. The first edit
 * writes the default layout down, then changes it.
 */

const P = PERMISSIONS;

function denied(): ActionState { return { ok: false, message: "Only administrators who manage organisation settings can change Quick Access." }; }

/** Make sure the layout is stored as rows, so it can be edited. */
async function materialise(viewer: Viewer) {
  const count = await prisma.dashboardWidget.count({ where: { tenantId: viewer.tenantId } });
  if (count > 0) return;
  const slots = await dashboardLayout(viewer.tenantId);
  await prisma.dashboardWidget.createMany({
    data: slots.map((s, i) => ({
      tenantId: viewer.tenantId, type: s.type, position: i, color: s.color,
      config: s.type === "QUICK_LINKS" ? { links: s.links } : undefined, updatedBy: viewer.user.id,
    })),
    skipDuplicates: true,
  });
}

async function renumber(tenantId: string, order: WidgetType[]) {
  await prisma.$transaction(order.map((type, position) =>
    prisma.dashboardWidget.update({ where: { tenantId_type: { tenantId, type } }, data: { position } })));
}

export async function addWidgetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return denied();
  const type = String(formData.get("type") ?? "");
  if (!isWidgetType(type)) return { ok: false, message: "That widget does not exist." };
  await materialise(viewer);
  const exists = await prisma.dashboardWidget.findUnique({ where: { tenantId_type: { tenantId: viewer.tenantId, type } } });
  if (exists) return { ok: false, message: `${WIDGET_BY_TYPE.get(type)!.title} is already on Quick Access.` };
  const last = await prisma.dashboardWidget.aggregate({ where: { tenantId: viewer.tenantId }, _max: { position: true } });
  const meta = WIDGET_BY_TYPE.get(type)!;
  await prisma.dashboardWidget.create({
    data: { tenantId: viewer.tenantId, type, position: (last._max.position ?? -1) + 1, color: meta.color, updatedBy: viewer.user.id, config: type === "QUICK_LINKS" ? { links: [] } : undefined },
  });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "DashboardWidget", entityId: type, summary: `Added the ${meta.title} widget to Quick Access` });
  return actionDone(["/"], `${meta.title} widget added successfully.`);
}

export async function removeWidgetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return denied();
  const type = String(formData.get("type") ?? "");
  if (!isWidgetType(type)) return { ok: false, message: "That widget does not exist." };
  await materialise(viewer);
  const row = await prisma.dashboardWidget.findUnique({ where: { tenantId_type: { tenantId: viewer.tenantId, type } } });
  if (!row) return { ok: false, message: "That widget is not on Quick Access." };
  await prisma.dashboardWidget.delete({ where: { id: row.id } });
  const rest = await prisma.dashboardWidget.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { position: "asc" }, select: { type: true } });
  await renumber(viewer.tenantId, rest.map((r) => r.type as WidgetType));
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "DashboardWidget", entityId: type, summary: `Removed the ${WIDGET_BY_TYPE.get(type)!.title} widget from Quick Access` });
  return actionDone(["/"], `${WIDGET_BY_TYPE.get(type)!.title} widget removed.`);
}

/** Move a widget to a new index (0-based) — drag and drop, or the Move up / down buttons. */
export async function moveWidgetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return denied();
  const type = String(formData.get("type") ?? "");
  const to = Number(formData.get("to"));
  if (!isWidgetType(type) || !Number.isInteger(to)) return { ok: false, message: "That move is not possible." };
  await materialise(viewer);
  const rows = await prisma.dashboardWidget.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { position: "asc" }, select: { type: true } });
  const order = rows.map((r) => r.type as WidgetType);
  const from = order.indexOf(type);
  if (from < 0) return { ok: false, message: "That widget is not on Quick Access." };
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (target === from) return { ok: true, message: "" };
  order.splice(from, 1);
  order.splice(target, 0, type);
  await renumber(viewer.tenantId, order);
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "DashboardWidget", entityId: type, summary: `Moved the ${WIDGET_BY_TYPE.get(type)!.title} widget to position ${target + 1}` });
  return actionDone(["/"], "Quick Access re-arranged.");
}

/** A widget's colour, and for Quick Links its list of links. */
export async function saveWidgetSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return denied();
  const type = String(formData.get("type") ?? "");
  const color = String(formData.get("color") ?? "");
  if (!isWidgetType(type)) return { ok: false, message: "That widget does not exist." };
  if (!isWidgetColor(color)) return { ok: false, message: "Pick one of the colours.", errors: { color: "Required" } };
  await materialise(viewer);
  const row = await prisma.dashboardWidget.findUnique({ where: { tenantId_type: { tenantId: viewer.tenantId, type } } });
  if (!row) return { ok: false, message: "That widget is not on Quick Access." };

  let config = row.config ?? undefined;
  if (type === "QUICK_LINKS") {
    const labels = formData.getAll("linkLabel").map((v) => String(v).trim());
    const urls = formData.getAll("linkUrl").map((v) => String(v).trim());
    const links: Array<{ label: string; url: string }> = [];
    const errors: Record<string, string> = {};
    labels.forEach((label, i) => {
      const raw = urls[i] ?? "";
      if (!label && !raw) return;
      if (!label || label.length > 60) { errors[`linkLabel.${i}`] = "Give the link a name under 60 characters"; return; }
      const url = safeLinkUrl(raw);
      if (!url) { errors[`linkUrl.${i}`] = "Use an https:// address or a page in this app, like /documents"; return; }
      links.push({ label, url });
    });
    if (Object.keys(errors).length) return { ok: false, message: Object.values(errors)[0], errors };
    if (links.length > QUICK_LINKS_MAX) return { ok: false, message: `Quick Links holds up to ${QUICK_LINKS_MAX} links.` };
    config = { links };
  }
  await prisma.dashboardWidget.update({ where: { id: row.id }, data: { color, config: config as never, updatedBy: viewer.user.id } });
  await writeAudit(viewer, {
    module: "SYSTEM", action: "UPDATE", entityType: "DashboardWidget", entityId: type,
    summary: `Changed the ${WIDGET_BY_TYPE.get(type)!.title} widget's settings`,
    oldValue: { color: row.color, links: linksOf(row.config) }, newValue: { color, links: type === "QUICK_LINKS" ? linksOf(config) : undefined },
  });
  return actionDone(["/"], "Widget settings saved.");
}

/** Put Quick Access back to the standard layout. */
export async function resetWidgetsAction(_prev: ActionState): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ORG_SETTINGS_MANAGE)) return denied();
  await prisma.dashboardWidget.deleteMany({ where: { tenantId: viewer.tenantId } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "DashboardWidget", entityId: null, summary: `Reset Quick Access to the standard ${WIDGETS.filter((w) => w.standard).length} widgets` });
  return actionDone(["/"], "Quick Access reset to the standard layout.");
}
