import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { prisma } from "@keka/db";

/**
 * Single sign-on with OpenID Connect: discovery, the authorization request
 * (code flow with PKCE, state and nonce), the code exchange and ID token
 * checks (signature against the issuer's keys, issuer, audience, expiry,
 * nonce, verified email). Every network call goes through `fetch`, so tests
 * can stand up an identity provider in memory.
 */

export interface OidcMetadata { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
type R = { ok: boolean; message: string };

const DISCOVERY_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; meta: OidcMetadata; jwks: JSONWebKeySet }>();

function key(): Buffer {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(`${s}:sso-client-secret`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function openSecret(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("Unreadable secret");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

const b64url = (b: Buffer) => b.toString("base64url");
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export const randomToken = () => b64url(randomBytes(24));

function httpsOnly(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
}

export function normaliseIssuer(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The issuer's endpoints and signing keys, cached briefly. */
export async function discover(issuer: string, opts: { fresh?: boolean } = {}): Promise<{ ok: true; meta: OidcMetadata; jwks: JSONWebKeySet } | { ok: false; message: string }> {
  const iss = normaliseIssuer(issuer);
  if (!httpsOnly(iss)) return { ok: false, message: "The issuer must be an https:// address." };
  const hit = cache.get(iss);
  if (hit && !opts.fresh && Date.now() - hit.at < DISCOVERY_TTL) return { ok: true, meta: hit.meta, jwks: hit.jwks };
  try {
    const res = await fetch(`${iss}/.well-known/openid-configuration`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `The issuer answered ${res.status} for its OpenID configuration.` };
    const meta = (await res.json()) as Partial<OidcMetadata>;
    if (normaliseIssuer(meta.issuer ?? "") !== iss) return { ok: false, message: "The issuer's configuration names a different issuer." };
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) if (!meta[k] || !httpsOnly(meta[k]!)) return { ok: false, message: `The issuer's ${k.replace(/_/g, " ")} is missing or not https.` };
    const kr = await fetch(meta.jwks_uri!, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!kr.ok) return { ok: false, message: `The issuer's signing keys could not be read (${kr.status}).` };
    const jwks = (await kr.json()) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) return { ok: false, message: "The issuer publishes no signing keys." };
    cache.set(iss, { at: Date.now(), meta: meta as OidcMetadata, jwks });
    return { ok: true, meta: meta as OidcMetadata, jwks };
  } catch (e) {
    return { ok: false, message: `The issuer could not be reached: ${e instanceof Error ? e.message : "request failed"}.` };
  }
}

export function authorizationUrl(meta: OidcMetadata, p: { clientId: string; redirectUri: string; scopes: string; state: string; nonce: string; challenge: string; loginHint?: string | null }): string {
  const u = new URL(meta.authorization_endpoint);
  const q = { response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, scope: p.scopes, state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: "S256", ...(p.loginHint ? { login_hint: p.loginHint } : {}) };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

export interface SsoIdentity { email: string; subject: string; name: string | null }

/** Swap the code for tokens and check the ID token. */
export async function completeSso(p: {
  meta: OidcMetadata; jwks: JSONWebKeySet; clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string; nonce: string;
}): Promise<{ ok: true; identity: SsoIdentity } | { ok: false; message: string }> {
  let body: { id_token?: string; error?: string; error_description?: string };
  try {
    const res = await fetch(p.meta.token_endpoint, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, client_id: p.clientId }).toString(),
    });
    body = await res.json();
    if (!res.ok || !body.id_token) return { ok: false, message: `The identity provider refused the sign-in${body.error ? ` (${body.error})` : ""}.` };
  } catch {
    return { ok: false, message: "The identity provider could not be reached." };
  }
  try {
    const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(p.jwks), { issuer: p.meta.issuer, audience: p.clientId, clockTolerance: 60 });
    if (payload.nonce !== p.nonce) return { ok: false, message: "The sign-in response did not match this attempt." };
    const email = String(payload.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return { ok: false, message: "The identity provider did not share an email address." };
    if (payload.email_verified === false) return { ok: false, message: "Your email address is not verified with the identity provider." };
    return { ok: true, identity: { email, subject: String(payload.sub ?? ""), name: typeof payload.name === "string" ? payload.name : null } };
  } catch {
    return { ok: false, message: "The sign-in response could not be verified." };
  }
}

export function emailAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const d = email.split("@")[1]?.toLowerCase() ?? "";
  return domains.includes(d);
}

export async function saveSsoConnection(input: {
  tenantId: string; providerName: string; issuer: string; clientId: string; clientSecret: string | null; scopes?: string | null; allowedDomains: string; enabled: boolean; enforced: boolean;
}): Promise<R> {
  const issuer = normaliseIssuer(input.issuer);
  if (!input.providerName.trim()) return { ok: false, message: "Name the identity provider." };
  if (!httpsOnly(issuer)) return { ok: false, message: "The issuer must be an https:// address." };
  if (!input.clientId.trim()) return { ok: false, message: "Enter the client ID." };
  const existing = await prisma.ssoConnection.findUnique({ where: { tenantId: input.tenantId } });
  if (!existing && !input.clientSecret?.trim()) return { ok: false, message: "Enter the client secret." };
  const domains = [...new Set(input.allowedDomains.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  if (domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return { ok: false, message: "Allowed domains look like example.com." };
  const scopes = (input.scopes?.trim() || "openid email profile").split(/\s+/);
  if (!scopes.includes("openid") || !scopes.includes("email")) return { ok: false, message: "Scopes must include openid and email." };
  if (input.enforced && !input.enabled) return { ok: false, message: "Turn SSO on before requiring it." };
  if (input.enabled) {
    const d = await discover(issuer, { fresh: true });
    if (!d.ok) return { ok: false, message: `Not turned on: ${d.message}` };
  }
  const data = {
    providerName: input.providerName.trim().slice(0, 60), issuer, clientId: input.clientId.trim(), scopes: scopes.join(" "), allowedDomains: domains,
    enabled: input.enabled, enforced: input.enforced, ...(input.clientSecret?.trim() ? { clientSecretEnc: sealSecret(input.clientSecret.trim()) } : {}),
  };
  if (existing) await prisma.ssoConnection.update({ where: { id: existing.id }, data });
  else await prisma.ssoConnection.create({ data: { ...data, tenantId: input.tenantId, clientSecretEnc: sealSecret(input.clientSecret!.trim()) } });
  return { ok: true, message: input.enforced ? "SSO saved and required. Password sign-in now works only for people who manage authentication." : input.enabled ? "SSO saved and turned on." : "SSO saved; it is off." };
}

/** Check the issuer now and record the outcome. */
export async function testSsoConnection(tenantId: string): Promise<R> {
  const c = await prisma.ssoConnection.findUnique({ where: { tenantId } });
  if (!c) return { ok: false, message: "Set up SSO first." };
  const d = await discover(c.issuer, { fresh: true });
  let message = d.ok ? `Reached ${c.issuer}: ${d.jwks.keys.length} signing key${d.jwks.keys.length === 1 ? "" : "s"}.` : d.message;
  if (d.ok) { try { openSecret(c.clientSecretEnc); } catch { message = "The stored client secret cannot be read; enter it again."; } }
  await prisma.ssoConnection.update({ where: { id: c.id }, data: { lastTestedAt: new Date(), lastTestResult: message } });
  return { ok: d.ok && !message.startsWith("The stored"), message };
}

/** Whether a user may still use a password: always, unless SSO is required and they do not manage authentication. */
export async function passwordAllowed(tenantId: string, userId: string): Promise<boolean> {
  const c = await prisma.ssoConnection.findUnique({ where: { tenantId }, select: { enabled: true, enforced: true } });
  if (!c?.enabled || !c.enforced) return true;
  return (await prisma.userRoleAssignment.count({ where: { userId, role: { permissions: { some: { permission: "admin.auth.manage" } } } } })) > 0;
}
