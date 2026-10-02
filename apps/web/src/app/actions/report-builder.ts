"use server";

import { redirect } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { parseSpec, validateSpec } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { datasetFor } from "@/lib/report-builder";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/** Custom reports: save (new, update, or a copy of someone's shared report) and delete. */

export async function saveCustomReportAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REPORT_BUILD);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, errors: { name: "Give the report a name." } };
  if (name.length > 120) return { ok: false, errors: { name: "Keep the name under 120 characters." } };
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("spec") ?? "{}")); } catch { return { ok: false, message: "The report could not be read. Run it again and save." }; }
  const spec = parseSpec(raw);
  const ds = datasetFor(spec.dataset);
  if (!ds || !can(viewer, ds.permission)) return { ok: false, message: "You cannot read that data." };
  const errors = validateSpec(spec, ds.fields);
  if (errors.length) return { ok: false, message: errors.join(" ") };
  const { dataset, ...body } = spec;
  const data = {
    name, description: String(formData.get("description") ?? "").trim().slice(0, 500) || null, dataset,
    spec: body as unknown as Prisma.InputJsonValue, shared: formData.get("shared") === "on",
  };
  const id = String(formData.get("id") ?? "");
  const asCopy = formData.get("copy") === "1";
  if (id && !asCopy) {
    const r = await prisma.savedReport.updateMany({ where: { id, tenantId: viewer.tenantId, createdBy: viewer.user.id }, data });
    if (!r.count) return { ok: false, message: "Only the person who made this report can change it. Save a copy instead." };
    await writeAudit(viewer, { module: "REPORT", action: "UPDATE", entityType: "SavedReport", entityId: id, summary: `Updated custom report ${name}` });
    return done(["/reports/builder", `/reports/builder/${id}`], "Report saved.");
  }
  if ((await prisma.savedReport.count({ where: { tenantId: viewer.tenantId, createdBy: viewer.user.id } })) >= 100) return { ok: false, message: "You can keep up to 100 reports. Delete one first." };
  const row = await prisma.savedReport.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "REPORT", action: "CREATE", entityType: "SavedReport", entityId: row.id, summary: `Created custom report ${name}` });
  redirect(`/reports/builder/${row.id}`);
}

export async function deleteCustomReportAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REPORT_BUILD);
  const id = String(formData.get("id") ?? "");
  const r = await prisma.savedReport.deleteMany({ where: { id, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  if (!r.count) return { ok: false, message: "Only the person who made this report can delete it." };
  await writeAudit(viewer, { module: "REPORT", action: "DELETE", entityType: "SavedReport", entityId: id, summary: "Deleted a custom report" });
  redirect("/reports/builder");
}
