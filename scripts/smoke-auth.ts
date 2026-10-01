/**
 * Authentication through the real actions: lockout that does not reveal
 * whether an account exists, address-level rate limiting, email two-factor,
 * session revocation, password policy, change and reset.
 *
 * Restores every password, flag and policy it touches.
 */
import { signInAs, setTestSession, setTestHeaders, testCookie, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const PASSWORD = "Keka@2026";

/** Run an action that ends in redirect(); return where it went. */
async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (err) {
    const d = (err as { digest?: string }).digest ?? "";
    if (!d.startsWith("NEXT_REDIRECT")) throw err;
    return d.split(";")[2] ?? "";
  }
}

async function main() {
  const auth = await import("../apps/web/src/app/actions/auth");
  const settings = await import("../apps/web/src/app/actions/settings");
  const { getViewer } = await import("../apps/web/src/lib/context");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const started = new Date();
  const meera = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "meera.krishnan@acme.test" } });
  const priya = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "priya.sharma@acme.test" } });
  const signIn = (email: string, password: string) => auth.signIn({}, fd({ email, password, subdomain: "acme" }));

  console.log("\nAuthentication\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------
    section("Lockout without account enumeration");
    setTestHeaders({ "x-forwarded-for": "198.51.100.7" });
    for (let i = 0; i < 5; i++) await signIn("meera.krishnan@acme.test", "wrong-password");
    const lockedReal = await signIn("meera.krishnan@acme.test", PASSWORD);
    check("Five wrong passwords lock the account, even against the right one", /Too many failed attempts/.test(lockedReal.error ?? ""), lockedReal.error);
    for (let i = 0; i < 5; i++) await signIn("ghost.user@acme.test", "wrong-password");
    const lockedGhost = await signIn("ghost.user@acme.test", "anything");
    check("An address with no account locks identically — lockout reveals nothing", /Too many failed attempts/.test(lockedGhost.error ?? ""), lockedGhost.error);
    const genericReal = await signIn("priya.sharma@acme.test", "nope"), genericGhost = await signIn("nobody@acme.test", "nope");
    check("Wrong password and unknown user get the same message", !!genericReal.error && genericReal.error === genericGhost.error);

    await signInAs("vikram.menon@acme.test");
    const unlock = await settings.userSecurityAction({}, fd({ op: "unlock", email: "meera.krishnan@acme.test" }));
    check("An administrator can unlock it", unlock.ok === true, unlock.message);
    setTestSession(null);
    const after = await redirectOf(() => signIn("meera.krishnan@acme.test", PASSWORD));
    check("…and the right password then signs in", after === "/", String(after));
    check("The session cookie was issued", !!testCookie("keka_session"));

    // -----------------------------------------------------------------
    section("Rate limiting by address");
    setTestHeaders({ "x-forwarded-for": "203.0.113.99" });
    for (let i = 0; i < 30; i++) await signIn(`spray${i}@acme.test`, "Spring2026!");
    const sprayed = await signIn("priya.sharma@acme.test", PASSWORD);
    check("Thirty failures from one address block it, whichever account it tries", /Too many sign-in attempts from your network/.test(sprayed.error ?? ""), sprayed.error);
    setTestHeaders({ "x-forwarded-for": "198.51.100.8" });
    const elsewhere = await redirectOf(() => signIn("priya.sharma@acme.test", PASSWORD));
    check("Another address is unaffected", elsewhere === "/", String(elsewhere));

    // -----------------------------------------------------------------
    section("Returning to where you were going");
    const withNext = (next: string) => redirectOf(() => auth.signIn({}, fd({ email: "priya.sharma@acme.test", password: PASSWORD, subdomain: "acme", next })));
    check("Signing in returns to the page asked for", (await withNext("/me/leave?apply=1")) === "/me/leave?apply=1");
    check("…but never to another site", (await withNext("//evil.example/x")) === "/" && (await withNext("https://evil.example")) === "/" && (await withNext("/\\evil.example")) === "/");

    // -----------------------------------------------------------------
    section("Two-factor by email");
    await signInAs("vikram.menon@acme.test");
    const weak = await settings.saveSecurityPolicy({}, fd({ minPasswordLength: 6, requireMixedCase: true, requireNumber: true, requireSymbol: true, passwordHistoryCount: 3, maxFailedAttempts: 5, lockoutMinutes: 15, sessionHours: 8, twoFactorPolicy: "ADMINS" }));
    check("A policy below eight characters is refused", weak.ok === false && !!weak.errors?.minPasswordLength);
    const on = await settings.saveSecurityPolicy({}, fd({ minPasswordLength: 10, requireMixedCase: true, requireNumber: true, requireSymbol: true, passwordHistoryCount: 3, maxFailedAttempts: 5, lockoutMinutes: 15, sessionHours: 8, twoFactorPolicy: "ADMINS" }));
    check("Two-factor is switched on for anyone with a role", on.ok === true, on.message);

    setTestSession(null);
    const toVerify = await redirectOf(() => signIn("priya.sharma@acme.test", PASSWORD));
    const mail = await prisma.emailOutbox.findFirst({ where: { toAddress: "priya.sharma@acme.test", relatedType: "OtpChallenge" }, orderBy: { createdAt: "desc" } });
    const code = /^(\d{6}) /.exec(mail?.subject ?? "")?.[1];
    check("An HR manager is sent to the code step, not signed in", toVerify === "/signin/verify" && !testCookie("keka_session"), String(toVerify));
    check("The code went out by email and only its hash is stored", !!code && !(await prisma.otpChallenge.findFirst({ where: { codeHash: code! } })));
    const bad = await auth.verifySecondFactor({}, fd({ code: code === "000000" ? "111111" : "000000" }));
    check("A wrong code is refused with attempts left", /not right/.test(bad.error ?? ""), bad.error);
    const good = await redirectOf(() => auth.verifySecondFactor({}, fd({ code: code! })));
    check("The right code completes sign-in", good === "/" && !!testCookie("keka_session"), String(good));
    const replay = await auth.verifySecondFactor({}, fd({ code: code! }));
    check("The code cannot be used twice", !!replay.error, replay.error);

    setTestSession(null);
    const plain = await redirectOf(() => signIn("meera.krishnan@acme.test", PASSWORD));
    check("Someone without a role signs straight in", plain === "/", String(plain));

    // -----------------------------------------------------------------
    section("Sessions");
    await signInAs("meera.krishnan@acme.test");
    check("A fresh session is valid", !!(await getViewer()));
    await signInAs("vikram.menon@acme.test");
    await settings.userSecurityAction({}, fd({ op: "sign-out", email: "meera.krishnan@acme.test" }));
    const stale = await prisma.user.findUniqueOrThrow({ where: { id: meera.id } });
    // Replay her pre-revocation token: version 0 against a bumped user.
    const { SignJWT } = await import("jose");
    setTestSession(await new SignJWT({ userId: meera.id, tenantId: tenant.id, email: meera.email, sv: stale.sessionVersion - 1 }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.AUTH_SECRET!)));
    check("“Sign out everywhere” kills an existing session on its next request", (await getViewer()) === null);

    // -----------------------------------------------------------------
    section("Changing a password");
    await signInAs("meera.krishnan@acme.test");
    const wrongCur = await auth.changePassword({}, fd({ current: "nope", next: "Tr1cky-Horse-42", confirm: "Tr1cky-Horse-42" }));
    check("The current password is required", /current password/.test(wrongCur.error ?? ""), wrongCur.error);
    const short = await auth.changePassword({}, fd({ current: PASSWORD, next: "Ab1!", confirm: "Ab1!" }));
    check("A short password is refused with the reasons", (short.issues ?? []).some((i) => /at least 10/.test(i)), (short.issues ?? []).join("; "));
    const named = await auth.changePassword({}, fd({ current: PASSWORD, next: "Meera-Krishnan-2026!", confirm: "Meera-Krishnan-2026!" }));
    check("A password containing your name or email is refused", (named.issues ?? []).length > 0, (named.issues ?? []).join("; "));
    const versionBefore = (await prisma.user.findUniqueOrThrow({ where: { id: meera.id } })).sessionVersion;
    const changed = await auth.changePassword({}, fd({ current: PASSWORD, next: "Tr1cky-Horse-42", confirm: "Tr1cky-Horse-42" }));
    const mAfter = await prisma.user.findUniqueOrThrow({ where: { id: meera.id } });
    check("A good password is accepted", changed.ok === true, changed.error);
    check("…other sessions are revoked, and this one re-issued", mAfter.sessionVersion === versionBefore + 1 && !!(await getViewer()));
    const same = await auth.changePassword({}, fd({ current: "Tr1cky-Horse-42", next: "Tr1cky-Horse-42", confirm: "Tr1cky-Horse-42" }));
    check("Reusing a recent password is refused", /used that password recently/.test(same.error ?? ""), same.error);

    // -----------------------------------------------------------------
    section("Reset by email");
    setTestSession(null);
    const r1 = await auth.requestPasswordReset({}, fd({ email: "meera.krishnan@acme.test", subdomain: "acme" }));
    const r2 = await auth.requestPasswordReset({}, fd({ email: "nobody-here@acme.test", subdomain: "acme" }));
    check("The reply is identical whether or not the account exists", !!r1.info && r1.info === r2.info);
    const resetMail = await prisma.emailOutbox.findFirst({ where: { toAddress: "meera.krishnan@acme.test", subject: { startsWith: "Reset" } }, orderBy: { createdAt: "desc" } });
    const token = /token=([\w-]+)/.exec(resetMail?.textBody ?? "")?.[1];
    check("A single-use link was emailed", !!token);
    const weakReset = await auth.resetPassword({}, fd({ token, next: "password", confirm: "password" }));
    check("The reset obeys the same password policy", (weakReset.issues ?? []).length > 0);
    const reset = await auth.resetPassword({}, fd({ token, next: "Another-Good-Pass-9", confirm: "Another-Good-Pass-9" }));
    check("A valid new password is set", reset.ok === true, reset.error);
    const again = await auth.resetPassword({}, fd({ token, next: "Yet-Another-Pass-9", confirm: "Yet-Another-Pass-9" }));
    check("The link does not work twice", !!again.error, again.error);

    // -----------------------------------------------------------------
    section("Forced change");
    await signInAs("vikram.menon@acme.test");
    await settings.userSecurityAction({}, fd({ op: "force-reset", email: "meera.krishnan@acme.test" }));
    setTestSession(null);
    const forced = await redirectOf(() => signIn("meera.krishnan@acme.test", "Another-Good-Pass-9"));
    check("After an administrator reset, sign-in leads to the password change", forced === "/account/password?required=1", String(forced));
    await signInAs("vikram.menon@acme.test");
    const selfForce = await settings.userSecurityAction({}, fd({ op: "force-reset", email: "vikram.menon@acme.test" }));
    check("An administrator cannot force-reset themselves", selfForce.ok === false);
  } finally {
    // -----------------------------------------------------------------
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const id of [meera.id, priya.id]) {
      await prisma.user.update({ where: { id }, data: { passwordHash: hash, passwordHistory: [], mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, sessionVersion: 0 } });
    }
    await prisma.tenantSecuritySetting.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.loginEvent.deleteMany({ where: { createdAt: { gte: started } } });
    await prisma.otpChallenge.deleteMany({ where: { createdAt: { gte: started } } });
    await prisma.emailOutbox.deleteMany({ where: { createdAt: { gte: started }, OR: [{ relatedType: "OtpChallenge" }, { subject: { startsWith: "Reset" } }] } });
  }
  report("Authentication");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
