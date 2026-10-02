import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { discover, authorizationUrl, pkcePair, randomToken } from "@keka/services";
import { setSsoState } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { originOf, subdomainOf } from "../_lib";

/** Send the browser to the company's identity provider. */
export async function GET(req: NextRequest) {
  const origin = originOf(req);
  const fail = (code: string) => NextResponse.redirect(new URL(`/signin?sso=${code}`, origin));
  const sub = subdomainOf(req) ?? req.nextUrl.searchParams.get("subdomain");
  const tenant = sub ? await prisma.tenant.findUnique({ where: { subdomain: sub }, select: { id: true, isActive: true, ssoConnection: true } }) : null;
  const conn = tenant?.isActive ? tenant.ssoConnection : null;
  if (!conn?.enabled) return fail("off");
  const d = await discover(conn.issuer);
  if (!d.ok) return fail("idp");
  const { verifier, challenge } = pkcePair();
  const state = randomToken(), nonce = randomToken();
  const redirectUri = `${origin}/auth/sso/callback`;
  await setSsoState({ tenantId: tenant!.id, state, nonce, verifier, redirectUri, next: safeNext(req.nextUrl.searchParams.get("next")) ?? undefined });
  const hint = req.nextUrl.searchParams.get("email");
  return NextResponse.redirect(authorizationUrl(d.meta, { clientId: conn.clientId, redirectUri, scopes: conn.scopes, state, nonce, challenge, loginHint: hint && hint.includes("@") ? hint : null }));
}
