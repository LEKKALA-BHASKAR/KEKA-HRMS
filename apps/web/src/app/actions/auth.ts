"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { safeNext } from "@/lib/safe-next";
import bcrypt from "bcryptjs";
import { prisma } from "@keka/db";
import {
  createSession, destroySession, readSession, setPendingSignIn, readPendingSignIn, clearPendingSignIn,
} from "@/lib/session";
import {
  securityPolicy, ipLimited, emailLocked, logLogin, issueOtp, verifyOtp, needsSecondFactor,
  passwordIssues, isRecentlyUsed, newPasswordFields, passwordExpired, findResetChallenge,
} from "@/lib/auth-policy";
import { requireViewer } from "@/lib/context";

/**
 * Sign-in, second factor, password change and reset.
 *
 * Every failure a stranger can trigger returns a message that is the same
 * whether or not the account exists — including lockout, which is counted per
 * email address rather than per account for exactly that reason.
 */

export interface SignInState {
  error?: string;
  info?: string;
}

const GENERIC_ERROR = "That email and password combination is not recognised.";
const DUMMY_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";

async function client() {
  const h = await headers();
  return {
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent"),
  };
}

async function completeSignIn(user: { id: string; email: string; tenantId: string; sessionVersion: number; mustChangePassword: boolean; passwordChangedAt: Date | null; createdAt: Date }, next?: string) {
  const policy = await securityPolicy(user.tenantId);
  const expired = passwordExpired(user, policy);
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null, ...(expired ? { mustChangePassword: true } : {}) },
  });
  await prisma.auditLog.create({
    data: { tenantId: user.tenantId, module: "AUTH", action: "LOGIN", entityType: "User", entityId: user.id, actorId: user.id, actorLabel: user.email, summary: `${user.email} signed in` },
  });
  await createSession({ userId: user.id, tenantId: user.tenantId, email: user.email, sv: user.sessionVersion }, policy.sessionHours);
  redirect(user.mustChangePassword || expired ? "/account/password?required=1" : next ?? "/");
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const subdomain = String(formData.get("subdomain") ?? "acme").trim().toLowerCase();
  // Where to land afterwards — validated here, never trusted from the page.
  const next = safeNext(formData.get("next"));
  const { ip, userAgent } = await client();

  if (!email || !password) return { error: "Enter both your email address and password." };

  if (await ipLimited(ip)) {
    await logLogin({ email, ip, userAgent, success: false, outcome: "RATE_LIMITED" });
    return { error: "Too many sign-in attempts from your network. Wait a few minutes and try again." };
  }

  const tenant = await prisma.tenant.findUnique({ where: { subdomain } });
  if (!tenant || !tenant.isActive) {
    await logLogin({ email, ip, userAgent, success: false, outcome: "BAD_CREDENTIALS" });
    return { error: GENERIC_ERROR };
  }
  const policy = await securityPolicy(tenant.id);

  const lock = await emailLocked(tenant.id, email, policy);
  if (lock.locked) {
    await logLogin({ tenantId: tenant.id, email, ip, userAgent, success: false, outcome: "LOCKED" });
    return { error: `Too many failed attempts. Try again in ${lock.minutesLeft} minute${lock.minutesLeft === 1 ? "" : "s"}, or reset your password.` };
  }

  const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
  // Compare against a dummy hash when there is no user so timing reveals nothing.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) {
    await logLogin({ tenantId: tenant.id, userId: user?.id, email, ip, userAgent, success: false, outcome: "BAD_CREDENTIALS" });
    if (user) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: failed, ...(failed >= policy.maxFailedAttempts ? { lockedUntil: new Date(Date.now() + policy.lockoutMinutes * 60_000) } : {}) },
      });
    }
    return { error: GENERIC_ERROR };
  }

  if (user.loginDisabled || user.isDeactivated) {
    await logLogin({ tenantId: tenant.id, userId: user.id, email, ip, userAgent, success: false, outcome: "DISABLED" });
    return { error: user.loginDisabled ? "Login for this account has been disabled. Contact your administrator." : "This account is deactivated. Contact your administrator." };
  }

  if (await needsSecondFactor(user.id, policy)) {
    const { challengeId, code } = await issueOtp(tenant.id, email, "TWO_FACTOR");
    await prisma.emailOutbox.create({
      data: {
        tenantId: tenant.id, toAddress: email, subject: `${code} is your ${tenant.name} sign-in code`,
        textBody: `Your sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, change your password now.`,
        relatedType: "OtpChallenge", relatedId: challengeId,
      },
    });
    await logLogin({ tenantId: tenant.id, userId: user.id, email, ip, userAgent, success: false, outcome: "OTP_SENT" });
    await setPendingSignIn({ userId: user.id, tenantId: tenant.id, email, challengeId, next });
    redirect("/signin/verify");
  }

  await logLogin({ tenantId: tenant.id, userId: user.id, email, ip, userAgent, success: true, outcome: "OK" });
  await completeSignIn(user, next);
  return {};
}

export async function verifySecondFactor(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const pending = await readPendingSignIn();
  if (!pending) return { error: "Your sign-in timed out. Start again." };
  const { ip, userAgent } = await client();
  const res = await verifyOtp(pending.challengeId, String(formData.get("code") ?? ""));
  if (!res.ok) {
    await logLogin({ tenantId: pending.tenantId, userId: pending.userId, email: pending.email, ip, userAgent, success: false, outcome: "OTP_FAILED" });
    return { error: res.reason };
  }
  const user = await prisma.user.findUnique({ where: { id: pending.userId } });
  if (!user || user.loginDisabled || user.isDeactivated) return { error: "This account cannot sign in." };
  await clearPendingSignIn();
  await logLogin({ tenantId: pending.tenantId, userId: user.id, email: user.email, ip, userAgent, success: true, outcome: "OK" });
  await completeSignIn(user, safeNext(pending.next));
  return {};
}

export async function signOut(): Promise<void> {
  const session = await readSession();
  if (session) {
    await prisma.auditLog.create({
      data: { tenantId: session.tenantId, module: "AUTH", action: "LOGOUT", entityType: "User", entityId: session.userId, actorId: session.userId, actorLabel: session.email, summary: `${session.email} signed out` },
    });
  }
  await destroySession();
  redirect("/signin");
}

/** Revoke every session this user has, everywhere, then sign in again here. */
export async function signOutEverywhere(): Promise<void> {
  const viewer = await requireViewer();
  await prisma.user.update({ where: { id: viewer.user.id }, data: { sessionVersion: { increment: 1 } } });
  await destroySession();
  redirect("/signin");
}

export interface PasswordState { ok?: boolean; error?: string; issues?: string[] }

export async function changePassword(_prev: PasswordState, formData: FormData): Promise<PasswordState> {
  const viewer = await requireViewer();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: viewer.user.id }, include: { employee: { select: { firstName: true, lastName: true } } } });
  if (!(await bcrypt.compare(current, user.passwordHash ?? DUMMY_HASH))) return { error: "Your current password is not right." };
  if (next !== confirm) return { error: "The new passwords do not match." };
  const policy = await securityPolicy(user.tenantId);
  const issues = passwordIssues(next, policy, { email: user.email, names: [user.employee?.firstName ?? "", user.employee?.lastName ?? ""] });
  if (issues.length) return { error: "Choose a stronger password.", issues };
  if (await isRecentlyUsed(next, user, policy.passwordHistoryCount)) return { error: `You used that password recently. Pick one you have not used in your last ${policy.passwordHistoryCount}.` };
  const fields = await newPasswordFields(next, user, policy.passwordHistoryCount);
  // A new password ends every other session.
  const updated = await prisma.user.update({ where: { id: user.id }, data: { ...fields, sessionVersion: { increment: 1 } } });
  await prisma.auditLog.create({ data: { tenantId: user.tenantId, module: "AUTH", action: "UPDATE", entityType: "User", entityId: user.id, actorId: user.id, actorLabel: user.email, summary: "Changed password" } });
  await createSession({ userId: user.id, tenantId: user.tenantId, email: user.email, sv: updated.sessionVersion }, policy.sessionHours);
  return { ok: true };
}

export async function requestPasswordReset(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const subdomain = String(formData.get("subdomain") ?? "acme").trim().toLowerCase();
  const { ip, userAgent } = await client();
  const done = { info: "If that address has an account, a reset link is on its way. It works for an hour." };
  if (!email) return { error: "Enter your work email." };
  if (await ipLimited(ip)) return { error: "Too many attempts from your network. Wait a few minutes." };
  const tenant = await prisma.tenant.findUnique({ where: { subdomain } });
  const user = tenant ? await prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } }) : null;
  // Same answer either way.
  await logLogin({ tenantId: tenant?.id, userId: user?.id, email, ip, userAgent, success: false, outcome: "RESET_REQUESTED" });
  if (!tenant || !user || user.isDeactivated) return done;
  const { code } = await issueOtp(tenant.id, email, "RESET");
  const base = process.env.APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3100";
  await prisma.emailOutbox.create({
    data: {
      tenantId: tenant.id, toAddress: email, subject: `Reset your ${tenant.name} password`,
      textBody: `Use this link within an hour to choose a new password:\n\n${base}/signin/reset?token=${code}\n\nIf you did not ask for this, ignore this email — your password is unchanged.`,
      relatedType: "User", relatedId: user.id,
    },
  });
  return done;
}

export async function resetPassword(_prev: PasswordState, formData: FormData): Promise<PasswordState> {
  const token = String(formData.get("token") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const challenge = await findResetChallenge(token);
  if (!challenge) return { error: "This link has expired or was already used. Request a new one." };
  if (next !== confirm) return { error: "The new passwords do not match." };
  const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: challenge.tenantId, email: challenge.identifier } }, include: { employee: { select: { firstName: true, lastName: true } } } });
  if (!user) return { error: "This link has expired or was already used. Request a new one." };
  const policy = await securityPolicy(user.tenantId);
  const issues = passwordIssues(next, policy, { email: user.email, names: [user.employee?.firstName ?? "", user.employee?.lastName ?? ""] });
  if (issues.length) return { error: "Choose a stronger password.", issues };
  if (await isRecentlyUsed(next, user, policy.passwordHistoryCount)) return { error: "You used that password recently. Pick a different one." };
  const used = await verifyOtp(challenge.id, token);
  if (!used.ok) return { error: used.reason };
  await prisma.user.update({ where: { id: user.id }, data: { ...(await newPasswordFields(next, user, policy.passwordHistoryCount)), sessionVersion: { increment: 1 } } });
  await prisma.auditLog.create({ data: { tenantId: user.tenantId, module: "AUTH", action: "UPDATE", entityType: "User", entityId: user.id, actorId: user.id, actorLabel: user.email, summary: "Reset password by email link" } });
  return { ok: true };
}
