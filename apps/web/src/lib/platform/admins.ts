import bcrypt from "bcryptjs";
import { prisma } from "@keka/db";
import { temporaryPassword, type Actor, type Result } from "./tenants";

/**
 * Platform administrators: the BooS-HR team. Kept free of server-only
 * imports so the command line (scripts/platform-admin.ts) and smoke tests
 * can use it.
 */

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";

export function platformPasswordProblem(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "Mix upper- and lower-case letters.";
  if (!/\d/.test(pw)) return "Include a digit.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Include a symbol.";
  return null;
}

/** Checks a platform sign-in; the same message whether or not the account exists. */
export async function verifyPlatformLogin(emailRaw: string, password: string): Promise<Result<{ admin: { id: string; email: string; sessionVersion: number; mustChangePassword: boolean } }>> {
  const email = emailRaw.trim().toLowerCase();
  const admin = await prisma.platformAdmin.findUnique({ where: { email } });
  const generic = { ok: false as const, message: "That email and password combination is not recognised." };
  if (admin?.lockedUntil && admin.lockedUntil > new Date()) {
    return { ok: false, message: "Too many failed attempts. Try again in a few minutes." };
  }
  const ok = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);
  if (!admin || !ok) {
    if (admin) {
      const failed = admin.failedLoginCount + 1;
      await prisma.platformAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: failed, ...(failed >= MAX_FAILED ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000), failedLoginCount: 0 } : {}) } });
    }
    return generic;
  }
  if (!admin.isActive) return { ok: false, message: "This platform account is disabled." };
  await prisma.platformAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await prisma.platformAuditLog.create({ data: { adminId: admin.id, adminEmail: admin.email, action: "SIGNED_IN", summary: `${admin.email} signed in to the platform panel` } });
  return { ok: true, admin: { id: admin.id, email: admin.email, sessionVersion: admin.sessionVersion, mustChangePassword: admin.mustChangePassword } };
}

export async function changePlatformPassword(adminId: string, current: string, next: string): Promise<Result> {
  const admin = await prisma.platformAdmin.findUnique({ where: { id: adminId } });
  if (!admin) return { ok: false, message: "Account not found." };
  if (!(await bcrypt.compare(current, admin.passwordHash))) return { ok: false, message: "Your current password is not right." };
  if (current === next) return { ok: false, message: "Choose a password different from the current one." };
  const problem = platformPasswordProblem(next);
  if (problem) return { ok: false, message: problem };
  await prisma.platformAdmin.update({ where: { id: adminId }, data: { passwordHash: await bcrypt.hash(next, 10), mustChangePassword: false, sessionVersion: { increment: 1 } } });
  await prisma.platformAuditLog.create({ data: { adminId, adminEmail: admin.email, action: "PASSWORD_CHANGED", summary: `${admin.email} changed their platform password` } });
  return { ok: true };
}

/** Creates a platform admin with a temporary password, or resets an existing one's. */
export async function upsertPlatformAdmin(emailRaw: string, name: string, actor: Actor): Promise<Result<{ email: string; tempPassword: string; created: boolean }>> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
  const tempPassword = temporaryPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const existing = await prisma.platformAdmin.findUnique({ where: { email } });
  if (existing) {
    await prisma.platformAdmin.update({ where: { id: existing.id }, data: { passwordHash, mustChangePassword: true, isActive: true, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 }, ...(name.trim() ? { name: name.trim() } : {}) } });
  } else {
    await prisma.platformAdmin.create({ data: { email, name: name.trim() || email.split("@")[0], passwordHash, mustChangePassword: true } });
  }
  await prisma.platformAuditLog.create({ data: { adminId: actor.id, adminEmail: actor.email, action: existing ? "PLATFORM_ADMIN_RESET" : "PLATFORM_ADMIN_ADDED", summary: existing ? `Reset the platform password of ${email}` : `Added platform admin ${email}` } });
  return { ok: true, email, tempPassword, created: !existing };
}

export async function setPlatformAdminActive(id: string, active: boolean, actor: Actor): Promise<Result> {
  if (id === actor.id && !active) return { ok: false, message: "You cannot disable your own account." };
  const admin = await prisma.platformAdmin.findUnique({ where: { id } });
  if (!admin) return { ok: false, message: "Not found." };
  if (!active) {
    const others = await prisma.platformAdmin.count({ where: { isActive: true, NOT: { id } } });
    if (others === 0) return { ok: false, message: "Keep at least one active platform admin." };
  }
  await prisma.platformAdmin.update({ where: { id }, data: { isActive: active, sessionVersion: { increment: 1 } } });
  await prisma.platformAuditLog.create({ data: { adminId: actor.id, adminEmail: actor.email, action: active ? "PLATFORM_ADMIN_ENABLED" : "PLATFORM_ADMIN_DISABLED", summary: `${active ? "Enabled" : "Disabled"} platform admin ${admin.email}` } });
  return { ok: true };
}
