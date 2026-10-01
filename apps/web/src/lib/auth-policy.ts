import "server-only";
import { createHash, randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@keka/db";

/**
 * Authentication policy: password rules, lockout, rate limiting and one-time
 * codes. Kept apart from the sign-in action so the same rules apply to
 * sign-in, password change, reset and administrator resets alike.
 */

export interface SecurityPolicy {
  minPasswordLength: number;
  requireMixedCase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  passwordExpiryDays: number | null;
  passwordHistoryCount: number;
  maxFailedAttempts: number;
  lockoutMinutes: number;
  sessionHours: number;
  twoFactorPolicy: "OFF" | "ADMINS" | "EVERYONE";
}

export const DEFAULT_POLICY: SecurityPolicy = {
  minPasswordLength: 8, requireMixedCase: true, requireNumber: true, requireSymbol: true,
  passwordExpiryDays: null, passwordHistoryCount: 3, maxFailedAttempts: 5, lockoutMinutes: 15,
  sessionHours: 8, twoFactorPolicy: "OFF",
};

export async function securityPolicy(tenantId: string): Promise<SecurityPolicy> {
  const s = await prisma.tenantSecuritySetting.findUnique({ where: { tenantId } });
  return s ? { ...DEFAULT_POLICY, ...s, twoFactorPolicy: s.twoFactorPolicy } : DEFAULT_POLICY;
}

/** A short list of passwords that satisfy naive rules and are still guessed first. */
const COMMON = new Set([
  "password1!", "Password1!", "Password@1", "Password@123", "Welcome@123", "Welcome1!", "Admin@123", "Qwerty@123",
  "P@ssw0rd", "P@ssword1", "India@123", "Test@1234", "Abcd@1234", "Summer2026!", "Keka@123",
]);

export function passwordIssues(password: string, policy: SecurityPolicy, ctx: { email?: string; names?: string[] } = {}): string[] {
  const issues: string[] = [];
  if (password.length < policy.minPasswordLength) issues.push(`at least ${policy.minPasswordLength} characters`);
  if (password.length > 128) issues.push("no more than 128 characters");
  if (policy.requireMixedCase && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) issues.push("upper- and lower-case letters");
  if (policy.requireNumber && !/\d/.test(password)) issues.push("a number");
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) issues.push("a symbol");
  const lower = password.toLowerCase();
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) issues.push("not your email address");
  for (const n of ctx.names ?? []) if (n.length >= 3 && lower.includes(n.toLowerCase())) { issues.push("not your name"); break; }
  if (COMMON.has(password)) issues.push("not a commonly used password");
  return issues;
}

/** Was this password among the user's recent ones? */
export async function isRecentlyUsed(password: string, user: { passwordHash: string | null; passwordHistory: unknown }, keep: number): Promise<boolean> {
  const hashes = [user.passwordHash, ...((user.passwordHistory as string[] | null) ?? [])].filter((h): h is string => !!h).slice(0, Math.max(1, keep));
  for (const h of hashes) if (await bcrypt.compare(password, h)) return true;
  return false;
}

/** The fields to write when a password is set, rotating the history. */
export async function newPasswordFields(password: string, user: { passwordHash: string | null; passwordHistory: unknown }, keep: number) {
  const history = [user.passwordHash, ...((user.passwordHistory as string[] | null) ?? [])].filter((h): h is string => !!h).slice(0, keep);
  return {
    passwordHash: await bcrypt.hash(password, 10),
    passwordHistory: history,
    passwordChangedAt: new Date(),
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
  };
}

export function passwordExpired(user: { passwordChangedAt: Date | null; createdAt: Date }, policy: SecurityPolicy): boolean {
  if (!policy.passwordExpiryDays) return false;
  const since = user.passwordChangedAt ?? user.createdAt;
  return Date.now() - since.getTime() > policy.passwordExpiryDays * 86_400_000;
}

// ---------------------------------------------------------------------------
//  Throttling
// ---------------------------------------------------------------------------

const IP_WINDOW_MIN = 15;
const IP_MAX_FAILURES = 30;

/**
 * Failures from one address across all accounts. Stops password spraying,
 * which per-account lockout cannot see.
 */
export async function ipLimited(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const n = await prisma.loginEvent.count({
    where: { ipAddress: ip, success: false, createdAt: { gte: new Date(Date.now() - IP_WINDOW_MIN * 60_000) } },
  });
  return n >= IP_MAX_FAILURES;
}

/**
 * Consecutive failures for an email since its last success, inside the
 * lockout window. Counted from events rather than the user row so a guessed
 * address that does not exist locks exactly like one that does — lockout
 * must not become an account-existence oracle.
 */
export async function emailLocked(tenantId: string, email: string, policy: SecurityPolicy): Promise<{ locked: boolean; minutesLeft: number }> {
  const since = new Date(Date.now() - policy.lockoutMinutes * 60_000);
  const recent = await prisma.loginEvent.findMany({
    // Only wrong passwords and successes decide a lock: attempts refused while
    // locked must not push the failures out of the window and reopen it.
    where: { tenantId, email, createdAt: { gte: since }, OR: [{ success: true }, { outcome: "BAD_CREDENTIALS" }] },
    orderBy: { createdAt: "desc" }, take: policy.maxFailedAttempts,
    select: { success: true, outcome: true, createdAt: true },
  });
  const failures = recent.filter((e) => !e.success && e.outcome === "BAD_CREDENTIALS");
  if (failures.length < policy.maxFailedAttempts || recent.some((e) => e.success)) return { locked: false, minutesLeft: 0 };
  const oldest = failures[failures.length - 1].createdAt;
  return { locked: true, minutesLeft: Math.max(1, Math.ceil((oldest.getTime() + policy.lockoutMinutes * 60_000 - Date.now()) / 60_000)) };
}

export async function logLogin(e: { tenantId?: string | null; userId?: string | null; email: string; ip: string | null; userAgent: string | null; success: boolean; outcome: string }) {
  await prisma.loginEvent.create({
    data: { tenantId: e.tenantId ?? null, userId: e.userId ?? null, email: e.email, ipAddress: e.ip, userAgent: e.userAgent?.slice(0, 300) ?? null, success: e.success, outcome: e.outcome },
  });
}

// ---------------------------------------------------------------------------
//  One-time codes
// ---------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A six-digit code for two-factor sign-in. Only its hash is stored. */
export async function issueOtp(tenantId: string, identifier: string, purpose: "TWO_FACTOR" | "RESET"): Promise<{ challengeId: string; code: string }> {
  // One live challenge per identifier and purpose.
  await prisma.otpChallenge.updateMany({ where: { tenantId, identifier, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
  const code = purpose === "RESET" ? randomBytes(24).toString("base64url") : String(randomInt(0, 1_000_000)).padStart(6, "0");
  const c = await prisma.otpChallenge.create({
    data: { tenantId, identifier, purpose, codeHash: sha(code), expiresAt: new Date(Date.now() + (purpose === "RESET" ? 60 : 10) * 60_000) },
  });
  return { challengeId: c.id, code };
}

/** Check a code. Five wrong tries burn the challenge. */
export async function verifyOtp(challengeId: string, code: string): Promise<{ ok: boolean; reason?: string; identifier?: string; tenantId?: string }> {
  const c = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
  if (!c || c.consumedAt) return { ok: false, reason: "This code has already been used. Request a new one." };
  if (c.expiresAt < new Date()) return { ok: false, reason: "This code has expired. Request a new one." };
  if (c.attempts >= 5) return { ok: false, reason: "Too many wrong codes. Request a new one." };
  const a = Buffer.from(sha(code.trim())), b = Buffer.from(c.codeHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await prisma.otpChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: `That code is not right. ${4 - c.attempts} attempt(s) left.` };
  }
  await prisma.otpChallenge.update({ where: { id: c.id }, data: { consumedAt: new Date() } });
  return { ok: true, identifier: c.identifier, tenantId: c.tenantId };
}

/** Find a reset challenge by its token, without consuming it. */
export async function findResetChallenge(token: string) {
  const c = await prisma.otpChallenge.findFirst({ where: { codeHash: sha(token), purpose: "RESET", consumedAt: null, expiresAt: { gt: new Date() } } });
  return c;
}

/** Who must pass a second factor under this policy. */
export async function needsSecondFactor(userId: string, policy: SecurityPolicy): Promise<boolean> {
  if (policy.twoFactorPolicy === "OFF") return false;
  if (policy.twoFactorPolicy === "EVERYONE") return true;
  return (await prisma.userRoleAssignment.count({ where: { userId } })) > 0;
}

/** The policy in one sentence, for the forms that enforce it. */
export function describePolicy(p: SecurityPolicy): string {
  const parts = [`at least ${p.minPasswordLength} characters`];
  if (p.requireMixedCase) parts.push("upper- and lower-case letters");
  if (p.requireNumber) parts.push("a number");
  if (p.requireSymbol) parts.push("a symbol");
  return `Use ${parts.join(", ")}.${p.passwordHistoryCount ? ` You cannot reuse your last ${p.passwordHistoryCount}.` : ""}`;
}
