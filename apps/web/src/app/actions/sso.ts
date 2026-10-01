"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { saveSsoConnection, testSsoConnection } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/** Single sign-on settings. The client secret is write-only: it is never sent back to the page. */

export async function saveSsoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const enforced = formData.get("enforced") === "on";
  const before = await prisma.ssoConnection.findUnique({ where: { tenantId: viewer.tenantId }, select: { enabled: true, enforced: true, issuer: true, clientId: true } });
  const res = await saveSsoConnection({
    tenantId: viewer.tenantId, providerName: String(formData.get("providerName") ?? ""), issuer: String(formData.get("issuer") ?? ""),
    clientId: String(formData.get("clientId") ?? ""), clientSecret: String(formData.get("clientSecret") ?? "") || null, scopes: String(formData.get("scopes") ?? "") || null,
    allowedDomains: String(formData.get("allowedDomains") ?? ""), enabled: formData.get("enabled") === "on", enforced,
  });
  if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].filter(([k, v]) => typeof v === "string" && k !== "clientSecret")) as Record<string, string> };
  await writeAudit(viewer, { module: "AUTH", action: before ? "UPDATE" : "CREATE", entityType: "SsoConnection", entityId: viewer.tenantId, summary: res.message, oldValue: before ?? undefined });
  return done(["/admin/settings"], res.message);
}

export async function testSsoAction(_prev: ActionState): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const res = await testSsoConnection(viewer.tenantId);
  done(["/admin/settings"], res.message);
  return { ok: res.ok, message: res.message };
}
