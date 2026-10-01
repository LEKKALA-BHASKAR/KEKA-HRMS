"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { deliverOutbox } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { fileTransport } from "@/lib/mail";
import { z, parseForm, toErrorState, writeAudit, actionDone as done, zName, zRequiredNumber, zNumber, zBool, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"] as const;

const profileSchema = z.object({
  name: zName(120),
  timezone: z.enum(TIMEZONES),
  fyStartMonth: zRequiredNumber({ min: 1, max: 12 }),
});

export async function saveTenantProfile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(profileSchema, formData);
  if (parsed.state) return parsed.state;
  const before = await prisma.tenant.findUniqueOrThrow({ where: { id: viewer.tenantId } });
  // Moving the financial year under finalised payroll would split a tax year.
  if (parsed.data.fyStartMonth !== before.fyStartMonth && await prisma.payrollRun.count({ where: { tenantId: viewer.tenantId, status: "FINALIZED" } }) > 0) {
    return { ok: false, message: "The financial year cannot move once payroll has been finalised in it.", errors: { fyStartMonth: "Payroll already finalised" } };
  }
  await prisma.tenant.update({ where: { id: viewer.tenantId }, data: parsed.data });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "Tenant", entityId: viewer.tenantId, summary: "Updated organisation settings", oldValue: { name: before.name, timezone: before.timezone, fyStartMonth: before.fyStartMonth }, newValue: parsed.data });
  return done(["/admin/settings", "/"], "Saved.");
}

const visibilitySchema = z.object({ restrictByLegalEntity: zBool(), restrictByBusinessUnit: zBool(), managerReporteeOverride: zBool() });

export async function saveVisibility(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(visibilitySchema, formData);
  if (parsed.state) return parsed.state;
  await prisma.tenantVisibilitySetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...parsed.data }, update: parsed.data });
  await writeAudit(viewer, { module: "ROLE", action: "UPDATE", entityType: "TenantVisibilitySetting", entityId: viewer.tenantId, summary: "Changed directory visibility", newValue: parsed.data });
  return done(["/admin/settings"], "Saved. Visibility applies on everyone's next page load.");
}

const securitySchema = z.object({
  minPasswordLength: zRequiredNumber({ min: 8, max: 64 }),
  requireMixedCase: zBool(), requireNumber: zBool(), requireSymbol: zBool(),
  passwordExpiryDays: zNumber({ min: 30, max: 730 }),
  passwordHistoryCount: zRequiredNumber({ min: 0, max: 24 }),
  maxFailedAttempts: zRequiredNumber({ min: 3, max: 20 }),
  lockoutMinutes: zRequiredNumber({ min: 1, max: 1440 }),
  sessionHours: zRequiredNumber({ min: 1, max: 24 }),
  twoFactorPolicy: z.enum(["OFF", "ADMINS", "EVERYONE"]),
});

export async function saveSecurityPolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const parsed = parseForm(securitySchema, formData);
  if (parsed.state) return parsed.state;
  const data = { ...parsed.data, passwordExpiryDays: parsed.data.passwordExpiryDays ?? null };
  const before = await prisma.tenantSecuritySetting.findUnique({ where: { tenantId: viewer.tenantId } });
  await prisma.tenantSecuritySetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "AUTH", action: "UPDATE", entityType: "TenantSecuritySetting", entityId: viewer.tenantId, summary: `Security policy: 2FA ${data.twoFactorPolicy.toLowerCase()}, ${data.minPasswordLength}+ chars, lockout after ${data.maxFailedAttempts}`, oldValue: before ?? undefined, newValue: data });
  return done(["/admin/settings"], "Saved. New rules apply at each person's next sign-in or password change.");
}

export async function userSecurityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const op = String(formData.get("op"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (op === "reset-all") {
    // Everyone but the administrator doing it, so they are not locked out mid-task.
    const r = await prisma.user.updateMany({ where: { tenantId: viewer.tenantId, id: { not: viewer.user.id } }, data: { mustChangePassword: true, sessionVersion: { increment: 1 } } });
    await writeAudit(viewer, { module: "AUTH", action: "UPDATE", entityType: "User", summary: `Forced a password change for ${r.count} users and signed them out` });
    return done(["/admin/settings"], `${r.count} user(s) signed out; each must set a new password at next sign-in.`);
  }
  const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: viewer.tenantId, email } } });
  if (!user) return { ok: false, message: "No user with that email.", errors: { email: "Not found" } };
  if (op === "unlock") {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    // A success marker resets the per-email failure count lockout reads.
    await prisma.loginEvent.create({ data: { tenantId: viewer.tenantId, userId: user.id, email: user.email, success: true, outcome: "UNLOCKED" } });
  } else if (op === "force-reset") {
    if (user.id === viewer.user.id) return { ok: false, message: "Change your own password from the user menu." };
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true, sessionVersion: { increment: 1 } } });
  } else if (op === "sign-out") {
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
  } else return { ok: false, message: "Unknown action." };
  await writeAudit(viewer, { module: "AUTH", action: "UPDATE", entityType: "User", entityId: user.id, summary: `${op.replace("-", " ")}: ${user.email}` });
  return done(["/admin/settings"], op === "unlock" ? `Unlocked ${user.email}.` : op === "force-reset" ? `${user.email} is signed out and must set a new password.` : `${user.email} is signed out everywhere.`);
}

export async function deliverMailNow(_prev: ActionState): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  try {
    const r = await deliverOutbox(fileTransport, { limit: 200 });
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EmailOutbox", summary: `Delivered ${r.sent} email(s), ${r.failed} failed` });
    return done(["/admin/settings"], r.examined === 0 ? "Nothing waiting to send." : `Delivered ${r.sent}${r.failed ? `, ${r.failed} failed and will be retried` : ""}.`);
  } catch (err) {
    return toErrorState(err);
  }
}
