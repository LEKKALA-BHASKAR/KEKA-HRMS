/**
 * Single sign-on against an identity provider that lives in this process:
 * discovery, the redirect (state, nonce, PKCE), the code exchange and ID token
 * checks, matching to an existing login, and the refusals: wrong state, a
 * token for another client or with the wrong nonce, an unverified email, a
 * disallowed domain, an unknown person. When SSO is required, password
 * sign-in stops working except for people who manage authentication. The
 * connection is removed at the end.
 */
import { createHash } from "node:crypto";
import { signInAs, setTestSession, testCookie, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ISSUER = "https://idp.example.test";
const CLIENT = "keka-client";
const SECRET = "s3cret-value";

async function main() {
  const jose = await import("jose");
  const { NextRequest } = await import("next/server");
  const svc = await import("../packages/services/src/index");
  const start = await import("../apps/web/src/app/auth/sso/start/route");
  const callback = await import("../apps/web/src/app/auth/sso/callback/route");
  const actSso = await import("../apps/web/src/app/actions/sso");
  const actAuth = await import("../apps/web/src/app/actions/auth");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });

  // --- The identity provider -------------------------------------------------
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let claims: Record<string, unknown> = {};
  let aud = CLIENT, tokenStatus = 200;
  const seen: { verifier?: string; auth?: string } = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      seen.verifier = form.get("code_verifier") ?? undefined;
      seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
      if (tokenStatus !== 200) return json({ error: "invalid_grant" }, tokenStatus);
      const idToken = await new jose.SignJWT({ ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return json({ id_token: idToken, access_token: "x", token_type: "Bearer" });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const req = (path: string) => new NextRequest(`http://acme.localhost:3100${path}`, { headers: { host: "acme.localhost:3100" } });
  /** Run start, return the authorize URL's params. */
  const begin = async (next?: string) => {
    const res = await start.GET(req(`/auth/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`));
    return { res, loc: new URL(res.headers.get("location") ?? "http://x/") };
  };
  const finish = async (state: string, code = "abc") => {
    setTestSession(null);
    const res = await callback.GET(req(`/auth/sso/callback?code=${code}&state=${state}`));
    return res.headers.get("location") ?? "";
  };
  const cleanup = () => prisma.ssoConnection.deleteMany({ where: { tenantId: tenant.id } });
  await cleanup();
  try {
    section("Setup");
    const off = await begin();
    check("With no connection, start sends people back to sign-in", off.loc.pathname === "/signin" && off.loc.searchParams.get("sso") === "off");
    await signInAs("meera.krishnan@acme.test");
    let threw = false;
    try { await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, enabled: "on" })); } catch { threw = true; }
    check("An employee cannot set up SSO", threw);
    await signInAs("vikram.menon@acme.test");
    const httpIssuer = await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: "http://idp.example.test", clientId: CLIENT, clientSecret: SECRET }));
    check("A plain http issuer is refused", httpIssuer.ok === false);
    const enforceOff = await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, enforced: "on" }));
    check("SSO cannot be required while it is off", enforceOff.ok === false);
    const saved = await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: `${ISSUER}/`, clientId: CLIENT, clientSecret: SECRET, allowedDomains: "acme.test", enabled: "on" }));
    check("SSO is saved and turned on after discovery", saved.ok === true, saved.message);
    const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    check("The client secret is stored sealed, not in plain text", !row.clientSecretEnc.includes(SECRET) && svc.openSecret(row.clientSecretEnc) === SECRET);
    check("The issuer is stored without a trailing slash", row.issuer === ISSUER);
    const keep = await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: ISSUER, clientId: CLIENT, clientSecret: "", allowedDomains: "acme.test", enabled: "on" }));
    check("Saving with a blank secret keeps the stored one", keep.ok === true && svc.openSecret((await prisma.ssoConnection.findUniqueOrThrow({ where: { tenantId: tenant.id } })).clientSecretEnc) === SECRET);
    const test = await actSso.testSsoAction({});
    check("Testing the connection reaches the issuer", test.ok === true && /1 signing key/.test(test.message ?? ""), test.message);

    section("A good sign-in");
    const a = await begin("/payroll");
    const p = a.loc.searchParams;
    check("Start redirects to the provider's authorize endpoint", a.loc.origin + a.loc.pathname === `${ISSUER}/authorize`);
    check("…with the client, redirect URI, PKCE S256, state and nonce", p.get("client_id") === CLIENT && p.get("redirect_uri") === "http://acme.localhost:3100/auth/sso/callback" && p.get("code_challenge_method") === "S256" && !!p.get("state") && !!p.get("nonce") && p.get("scope") === "openid email profile");
    check("The attempt is held in a short-lived cookie", !!testCookie("keka_sso"));
    claims = { sub: "u-1", email: "Priya.Sharma@acme.test", email_verified: true, nonce: p.get("nonce") };
    const loc = await finish(p.get("state")!);
    check("The callback signs the person in and goes where they were headed", loc === "http://acme.localhost:3100/payroll" && !!testCookie("keka_session"), loc);
    check("The code verifier matches the challenge", !!seen.verifier && createHash("sha256").update(seen.verifier).digest("base64url") === p.get("code_challenge"));
    check("The client authenticates with its secret", seen.auth === `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`);
    const session = await jose.jwtVerify(testCookie("keka_session")!, new TextEncoder().encode(process.env.AUTH_SECRET!));
    const priya = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: tenant.id, email: "priya.sharma@acme.test" } } });
    check("…as the matching login", session.payload.userId === priya.id);
    check("The sign-in is logged", !!(await prisma.loginEvent.findFirst({ where: { tenantId: tenant.id, userId: priya.id, outcome: "SSO_OK" } })));
    check("The same state cannot be used twice", (await finish(p.get("state")!)).endsWith("/signin?sso=expired"));

    section("Refusals");
    const attempt = async (c: Record<string, unknown>, opts: { aud?: string; state?: string; status?: number } = {}) => {
      const { loc } = await begin();
      claims = { sub: "x", email_verified: true, nonce: loc.searchParams.get("nonce"), ...c };
      aud = opts.aud ?? CLIENT; tokenStatus = opts.status ?? 200;
      const out = await finish(opts.state ?? loc.searchParams.get("state")!);
      aud = CLIENT; tokenStatus = 200;
      return new URL(out).searchParams.get("sso");
    };
    check("A forged state is refused", (await attempt({ email: "priya.sharma@acme.test" }, { state: "forged" })) === "expired");
    check("A token for another client is refused", (await attempt({ email: "priya.sharma@acme.test" }, { aud: "someone-else" })) === "invalid");
    check("A token with the wrong nonce is refused", (await attempt({ email: "priya.sharma@acme.test", nonce: "replayed" })) === "invalid");
    check("An unverified email is refused", (await attempt({ email: "priya.sharma@acme.test", email_verified: false })) === "invalid");
    check("A refused code exchange is reported", (await attempt({ email: "priya.sharma@acme.test" }, { status: 400 })) === "invalid");
    check("Another email domain is refused", (await attempt({ email: "priya@gmail.com" })) === "domain");
    check("An email with no login is refused; SSO creates no accounts", (await attempt({ email: "nobody.here@acme.test" })) === "nouser" && !(await prisma.user.findFirst({ where: { email: "nobody.here@acme.test" } })));

    section("Requiring SSO");
    await signInAs("vikram.menon@acme.test");
    const req1 = await actSso.saveSsoAction({}, fd({ providerName: "Test IdP", issuer: ISSUER, clientId: CLIENT, allowedDomains: "acme.test", enabled: "on", enforced: "on" }));
    check("SSO can be required", req1.ok === true, req1.message);
    setTestSession(null);
    let pw = await actAuth.signIn({}, fd({ email: "meera.krishnan@acme.test", password: "Keka@2026", subdomain: "acme" })).catch((e) => ({ redirected: String((e as { digest?: string }).digest ?? e) }));
    check("An employee's correct password is now refused", "error" in pw && /single sign-on/.test(pw.error ?? ""), JSON.stringify(pw));
    pw = await actAuth.signIn({}, fd({ email: "vikram.menon@acme.test", password: "Keka@2026", subdomain: "acme" })).catch((e) => ({ redirected: String((e as { digest?: string }).digest ?? e) }));
    check("An administrator can still use a password, so a broken provider can be fixed", "redirected" in pw && /NEXT_REDIRECT/.test(pw.redirected), JSON.stringify(pw));
    const wrong = await actAuth.signIn({}, fd({ email: "meera.krishnan@acme.test", password: "wrong", subdomain: "acme" }));
    check("A wrong password still gets the generic answer", /not recognised/.test(wrong.error ?? ""));
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
    await prisma.$disconnect();
  }
  report("Single sign-on");
}

main().catch((e) => { console.error(e); process.exit(1); });
