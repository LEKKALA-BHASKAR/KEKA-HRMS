"use server";

import { z } from "zod";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { createApiKey, revokeApiKey, API_SCOPES, type ApiScope } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { actionDone as done, parseForm, writeAudit, toErrorState, zName, zOptionalId, type ActionState } from "@/lib/forms";

/** API keys (Global Admin) and attendance devices, from Settings > Integrations. */

const keySchema = z.object({ name: zName(80), expiresInDays: z.coerce.number().int().min(0).max(3650).default(0) });

export async function createApiKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState & { key?: string }> {
  const viewer = await requireAuth(P.API_KEY_MANAGE);
  const parsed = parseForm(keySchema, formData);
  if (parsed.state) return parsed.state;
  const scopes = formData.getAll("scopes").map(String).filter((s): s is ApiScope => s in API_SCOPES);
  const expiresAt = parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000) : null;
  const res = await createApiKey({ tenantId: viewer.tenantId, name: parsed.data.name, scopes, createdBy: viewer.user.id, expiresAt });
  if (!res.ok) return { ok: false, message: res.message, errors: { scopes: "Required" } };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ApiKey", entityId: res.id, summary: `Created API key ${parsed.data.name} (${res.prefix}) for ${scopes.join(", ")}` });
  // Revalidating would re-render the form and lose the one-time key, so the
  // list refreshes on the next visit instead.
  return { ok: true, message: res.message, key: res.key };
}

export async function revokeApiKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.API_KEY_MANAGE);
  const id = String(formData.get("id") ?? "");
  const res = await revokeApiKey(viewer.tenantId, id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ApiKey", entityId: id, summary: "Revoked an API key" });
  return done(["/admin/integrations"], res.message);
}

const deviceSchema = z.object({
  id: zOptionalId(), name: zName(80),
  serialNumber: z.string().trim().min(1, "Required").max(64).regex(/^[A-Za-z0-9._:-]+$/, "Letters, digits and . _ : - only"),
  locationId: zOptionalId(),
});

export async function saveDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(deviceSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.locationId && !(await prisma.location.findFirst({ where: { id: d.locationId, tenantId: viewer.tenantId }, select: { id: true } }))) return { ok: false, message: "Location not found." };
  try {
    if (id) {
      const u = await prisma.attendanceDevice.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
      if (u.count === 0) return { ok: false, message: "Device not found." };
    } else {
      await prisma.attendanceDevice.create({ data: { ...d, tenantId: viewer.tenantId } });
    }
    await writeAudit(viewer, { module: "ATTENDANCE", action: id ? "UPDATE" : "CREATE", entityType: "AttendanceDevice", entityId: id, summary: `${id ? "Updated" : "Registered"} device ${d.name} (${d.serialNumber})` });
    return done(["/admin/integrations"], `Saved ${d.name}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function toggleDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const dev = await prisma.attendanceDevice.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!dev) return { ok: false, message: "Device not found." };
  await prisma.attendanceDevice.update({ where: { id }, data: { isActive: !dev.isActive } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceDevice", entityId: id, summary: `${dev.isActive ? "Switched off" : "Switched on"} device ${dev.name}` });
  return done(["/admin/integrations"], dev.isActive ? "Switched off; its punches will be refused." : "Switched on.");
}
