import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { discover, completeSso, emailAllowed, openSecret, signInIpAllowed } from "@keka/services";
import { takeSsoState, createSession } from "@/lib/session";
import { securityPolicy, logLogin } from "@/lib/auth-policy";
import { originOf, type SsoError } from "../_lib";

/** The identity provider sends the browser back here with a code. */
export async function GET(req: NextRequest) {
  const origin = originOf(req);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || req.headers.get("x-real-ip") || null;
  const userAgent = req.headers.get("user-agent");
  const fail = async (code: SsoError, tenantId?: string, email = "(sso)") => {
    await logLogin({ tenantId, email, ip, userAgent, success: false, outcome: `SSO_${code.toUpperCase()}` });
    return NextResponse.redirect(new URL(`/signin?sso=${code}`, origin));
  };
  const sp = req.nextUrl.searchParams;
  const pending = await takeSsoState();
  if (!pending || !sp.get("state") || sp.get("state") !== pending.state) return fail("expired", pending?.tenantId);
  if (sp.get("error") || !sp.get("code")) return fail("denied", pending.tenantId);
  const conn = await prisma.ssoConnection.findUnique({ where: { tenantId: pending.tenantId } });
  if (!conn?.enabled) return fail("off", pending.tenantId);
  const d = await discover(conn.issuer);
  if (!d.ok) return fail("idp", pending.tenantId);
  let secret: string;
  try { secret = openSecret(conn.clientSecretEnc); } catch { return fail("idp", pending.tenantId); }
  const res = await completeSso({ meta: d.meta, jwks: d.jwks, clientId: conn.clientId, clientSecret: secret, code: sp.get("code")!, verifier: pending.verifier, redirectUri: pending.redirectUri, nonce: pending.nonce });
  if (!res.ok) return fail("invalid", pending.tenantId);
  const email = res.identity.email;
  if (!emailAllowed(email, conn.allowedDomains)) return fail("domain", pending.tenantId, email);
  const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: pending.tenantId, email } } });
  if (!user || user.loginDisabled || user.isDeactivated) return fail("nouser", pending.tenantId, email);
  if (!(await signInIpAllowed(user.tenantId, ip))) {
    await logLogin({ tenantId: user.tenantId, userId: user.id, email, ip, userAgent, success: false, outcome: "IP_BLOCKED" });
    return NextResponse.redirect(new URL("/signin?sso=ipblocked", origin));
  }

  const policy = await securityPolicy(user.tenantId);
  const now = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null } });
  await prisma.ssoConnection.update({ where: { id: conn.id }, data: { lastLoginAt: now } });
  await prisma.auditLog.create({ data: { tenantId: user.tenantId, module: "AUTH", action: "LOGIN", entityType: "User", entityId: user.id, actorId: user.id, actorLabel: user.email, summary: `${user.email} signed in with ${conn.providerName}` } });
  await logLogin({ tenantId: user.tenantId, userId: user.id, email, ip, userAgent, success: true, outcome: "SSO_OK" });
  await createSession({ userId: user.id, tenantId: user.tenantId, email: user.email, sv: user.sessionVersion }, policy.sessionHours);
  return NextResponse.redirect(new URL(pending.next ?? "/", origin));
}
