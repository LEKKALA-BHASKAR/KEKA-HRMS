import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@keka/db";

/**
 * API keys for /api/v1. A key reads "kk_<prefix>_<secret>": the prefix finds
 * the row, the secret is checked against a SHA-256 hash, and only the hash is
 * stored. The full key is returned once, at creation.
 */

export const API_SCOPES = {
  "attendance:write": "Push attendance punches",
  "employees:read": "Read the employee directory",
  "payroll:read": "Read finalised payroll summaries",
  "leave:read": "Read approved and pending leave",
} as const;
export type ApiScope = keyof typeof API_SCOPES;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createApiKey(input: { tenantId: string; name: string; scopes: ApiScope[]; createdBy: string | null; expiresAt?: Date | null }) {
  const scopes = [...new Set(input.scopes)].filter((s) => s in API_SCOPES);
  if (scopes.length === 0) return { ok: false as const, message: "Pick at least one permission for the key." };
  const prefix = `kk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  const key = `${prefix}_${secret}`;
  const row = await prisma.apiKey.create({
    data: { tenantId: input.tenantId, name: input.name, prefix, keyHash: sha256(secret), scopes, createdBy: input.createdBy, expiresAt: input.expiresAt ?? null },
  });
  return { ok: true as const, id: row.id, key, prefix, message: "Copy this key now. It will not be shown again." };
}

export async function revokeApiKey(tenantId: string, id: string) {
  const r = await prisma.apiKey.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count ? { ok: true, message: "Key revoked. Clients using it will be refused from now on." } : { ok: false, message: "That key was not found or is already revoked." };
}

export type ApiCaller = { tenantId: string; keyId: string; scopes: string[] };

/** The caller behind an Authorization header, or why not. */
export async function authenticateApiKey(header: string | null, scope: ApiScope): Promise<{ ok: true; caller: ApiCaller } | { ok: false; status: 401 | 403; message: string }> {
  const m = /^Bearer\s+(kk_[0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/.exec(header?.trim() ?? "");
  if (!m) return { ok: false, status: 401, message: "Send an API key as: Authorization: Bearer <key>." };
  const row = await prisma.apiKey.findUnique({ where: { prefix: m[1] } });
  const a = Buffer.from(sha256(m[2]), "hex");
  const b = Buffer.from(row?.keyHash ?? "0".repeat(64), "hex");
  if (!row || a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, message: "That API key is not valid." };
  if (row.revokedAt) return { ok: false, status: 401, message: "That API key has been revoked." };
  if (row.expiresAt && row.expiresAt < new Date()) return { ok: false, status: 401, message: "That API key has expired." };
  if (!row.scopes.includes(scope)) return { ok: false, status: 403, message: `This key is not allowed to ${API_SCOPES[scope].toLowerCase()}.` };
  // Coarse last-used tracking: at most one write a minute per key.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  }
  return { ok: true, caller: { tenantId: row.tenantId, keyId: row.id, scopes: row.scopes } };
}
