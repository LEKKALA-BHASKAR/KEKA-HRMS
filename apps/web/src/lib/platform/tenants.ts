import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma, type PlanTier } from "@keka/db";
import { SYSTEM_ROLES, MODULE_KEYS, isModuleKey, type ModuleKey } from "@keka/rbac";

/**
 * Company (tenant) lifecycle for the platform admin panel: onboarding a new
 * company from its subdomain, changing its plan and modules, suspending it,
 * and managing its administrators.
 *
 * Every company lives in the shared database and is fenced off by tenantId on
 * every row; nothing here relaxes that. No server-only imports, so the smoke
 * tests can drive it directly.
 */

export type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Subdomains that are routes or infrastructure, never companies. */
export const RESERVED_SUBDOMAINS = new Set([
  "www", "app", "api", "admin", "platform", "mail", "smtp", "imap", "ftp", "static", "assets", "cdn",
  "status", "help", "support", "docs", "blog", "auth", "login", "signin", "sso", "dev", "staging", "test", "demo-admin",
]);

/**
 * Accepts "bluecloud", "BlueCloud", or a full host such as
 * "bluecloud.boss-hr.com" / "https://bluecloud.boss-hr.com/" and returns the
 * bare subdomain, lower-cased.
 */
export function normaliseSubdomain(input: string, baseDomain = process.env.APP_BASE_DOMAIN ?? ""): string {
  let v = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const base = baseDomain.trim().toLowerCase();
  if (base && v.endsWith(`.${base}`)) v = v.slice(0, -(base.length + 1));
  else if (v.includes(".")) v = v.split(".")[0];
  return v;
}

export function subdomainProblem(sub: string): string | null {
  if (!sub) return "Enter the company's subdomain.";
  if (sub.length < 3 || sub.length > 40) return "Use 3 to 40 characters.";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(sub)) return "Use lower-case letters, digits and hyphens, starting and ending with a letter or digit.";
  if (RESERVED_SUBDOMAINS.has(sub)) return `"${sub}" is reserved. Pick another.`;
  return null;
}

/** A temporary password that satisfies the default policy (mixed case, digit, symbol, 12+ chars). */
export function temporaryPassword(): string {
  const pick = (s: string) => s[randomInt(s.length)];
  const lower = "abcdefghjkmnpqrstuvwxyz", upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", digits = "23456789";
  const word = () => pick(upper) + Array.from({ length: 4 }, () => pick(lower)).join("");
  return `${word()}-${word()}-${pick(digits)}${pick(digits)}${pick("!@#$%")}`;
}

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export interface OnboardInput {
  name: string;
  subdomain: string;
  legalName?: string;
  plan?: PlanTier;
  /** Modules to leave on; the rest are switched off. Defaults to all. */
  modules?: string[];
  countryCode?: string;
  currency?: string;
  timezone?: string;
  fyStartMonth?: number;
  employeeLimit?: number | null;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  admin: { firstName: string; lastName: string; email: string };
}

export interface Actor { id: string | null; email: string }

async function audit(actor: Actor, action: string, summary: string, tenantId?: string | null) {
  await prisma.platformAuditLog.create({ data: { adminId: actor.id, adminEmail: actor.email, action, summary, tenantId: tenantId ?? null } });
}

function disabledFrom(modules: string[] | undefined): ModuleKey[] {
  if (!modules) return [];
  const on = new Set(modules.filter(isModuleKey));
  return MODULE_KEYS.filter((k) => !on.has(k));
}

/** The add-on flags older screens read, kept in step with the module switches. */
function addOnFlags(disabled: ModuleKey[]) {
  return { hasHire: !disabled.includes("hire"), hasPsa: !disabled.includes("projects"), hasLearn: !disabled.includes("learn") };
}

/**
 * Creates a ready-to-use company: the tenant, its eleven system roles, a legal
 * entity, a default employee number series, and its first administrator (an
 * employee with the Global Admin role and a temporary password they must
 * change on first sign-in).
 */
export async function onboardCompany(input: OnboardInput, actor: Actor): Promise<Result<{ tenantId: string; subdomain: string; adminEmail: string; tempPassword: string }>> {
  const name = input.name.trim();
  const subdomain = normaliseSubdomain(input.subdomain);
  const adminEmail = input.admin.email.trim().toLowerCase();
  const firstName = input.admin.firstName.trim();
  const lastName = input.admin.lastName.trim();
  if (!name) return { ok: false, message: "Enter the company name." };
  const subIssue = subdomainProblem(subdomain);
  if (subIssue) return { ok: false, message: subIssue };
  if (!firstName || !lastName) return { ok: false, message: "Enter the admin's first and last name." };
  if (!emailOk(adminEmail)) return { ok: false, message: "Enter a valid email for the company admin." };
  if (input.contactEmail && !emailOk(input.contactEmail.trim())) return { ok: false, message: "The contact email is not valid." };
  const fy = input.fyStartMonth ?? 4;
  if (fy < 1 || fy > 12) return { ok: false, message: "Financial year start must be a month from 1 to 12." };
  if (await prisma.tenant.findUnique({ where: { subdomain }, select: { id: true } })) {
    return { ok: false, message: `${subdomain} is already taken by another company.` };
  }

  const disabled = disabledFrom(input.modules);
  const tempPassword = temporaryPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const countryCode = (input.countryCode || "IN").toUpperCase();
  const currency = (input.currency || "INR").toUpperCase();
  const prefix = subdomain.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase() || "EMP";

  const tenant = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        subdomain, name,
        plan: input.plan ?? "GROWTH",
        ...addOnFlags(disabled),
        disabledModules: disabled,
        countryCode, currency,
        timezone: input.timezone || "Asia/Kolkata",
        fyStartMonth: fy,
        employeeLimit: input.employeeLimit ?? null,
        contactName: input.contactName?.trim() || `${firstName} ${lastName}`,
        contactEmail: input.contactEmail?.trim().toLowerCase() || adminEmail,
        contactPhone: input.contactPhone?.trim() || null,
        visibilitySetting: { create: { restrictByLegalEntity: false, restrictByBusinessUnit: false, managerReporteeOverride: true } },
      },
    });

    let globalAdminRoleId = "";
    for (const def of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId: t.id, key: def.key, name: def.name, description: def.description, isSystem: true,
          permissions: { create: def.permissions.map((permission) => ({ permission })) },
        },
      });
      if (def.key === "GLOBAL_ADMIN") globalAdminRoleId = role.id;
    }

    const entity = await tx.legalEntity.create({
      data: { tenantId: t.id, name, legalName: input.legalName?.trim() || name, countryCode, currency },
    });
    await tx.employeeNumberSeries.create({
      data: { tenantId: t.id, name: "Default", description: "Standard employee numbering", prefix, digits: 4, nextNumber: 2, isActive: true, isDefault: true },
    });

    const user = await tx.user.create({
      data: { tenantId: t.id, email: adminEmail, passwordHash, mustChangePassword: true, passwordChangedAt: new Date() },
    });
    await tx.employee.create({
      data: {
        tenantId: t.id, userId: user.id, legalEntityId: entity.id,
        employeeNumber: `${prefix}0001`, firstName, lastName, displayName: `${firstName} ${lastName}`,
        workEmail: adminEmail, status: "CONFIRMED", dateOfJoining: new Date(),
      },
    });
    await tx.userRoleAssignment.create({ data: { userId: user.id, roleId: globalAdminRoleId, grantedBy: `platform:${actor.email}` } });
    return t;
  });

  await audit(actor, "COMPANY_CREATED", `Onboarded ${name} at ${subdomain} with admin ${adminEmail}`, tenant.id);
  return { ok: true, tenantId: tenant.id, subdomain, adminEmail, tempPassword };
}

export interface CompanyUpdate {
  name?: string;
  plan?: PlanTier;
  modules?: string[];
  countryCode?: string;
  currency?: string;
  timezone?: string;
  fyStartMonth?: number;
  employeeLimit?: number | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  platformNotes?: string | null;
}

export async function updateCompany(tenantId: string, u: CompanyUpdate, actor: Actor): Promise<Result> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!t) return { ok: false, message: "That company no longer exists." };
  if (u.name !== undefined && !u.name.trim()) return { ok: false, message: "The company needs a name." };
  if (u.fyStartMonth !== undefined && (u.fyStartMonth < 1 || u.fyStartMonth > 12)) return { ok: false, message: "Financial year start must be a month from 1 to 12." };
  if (u.employeeLimit != null && (!Number.isInteger(u.employeeLimit) || u.employeeLimit < 1)) return { ok: false, message: "The employee limit must be a whole number above zero, or empty for no limit." };
  if (u.contactEmail && !emailOk(u.contactEmail)) return { ok: false, message: "The contact email is not valid." };
  const disabled = u.modules ? disabledFrom(u.modules) : undefined;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...(u.name !== undefined ? { name: u.name.trim() } : {}),
      ...(u.plan ? { plan: u.plan } : {}),
      ...(disabled ? { disabledModules: disabled, ...addOnFlags(disabled) } : {}),
      ...(u.countryCode ? { countryCode: u.countryCode.toUpperCase() } : {}),
      ...(u.currency ? { currency: u.currency.toUpperCase() } : {}),
      ...(u.timezone ? { timezone: u.timezone } : {}),
      ...(u.fyStartMonth !== undefined ? { fyStartMonth: u.fyStartMonth } : {}),
      ...(u.employeeLimit !== undefined ? { employeeLimit: u.employeeLimit } : {}),
      ...(u.contactName !== undefined ? { contactName: u.contactName?.trim() || null } : {}),
      ...(u.contactEmail !== undefined ? { contactEmail: u.contactEmail?.trim().toLowerCase() || null } : {}),
      ...(u.contactPhone !== undefined ? { contactPhone: u.contactPhone?.trim() || null } : {}),
      ...(u.platformNotes !== undefined ? { platformNotes: u.platformNotes?.trim() || null } : {}),
    },
  });
  const changes: string[] = [];
  if (u.plan && u.plan !== t.plan) changes.push(`plan ${t.plan} → ${u.plan}`);
  if (disabled) {
    const before = new Set(t.disabledModules);
    const off = disabled.filter((m) => !before.has(m));
    const on = t.disabledModules.filter((m) => !disabled.includes(m as ModuleKey));
    if (off.length) changes.push(`switched off ${off.join(", ")}`);
    if (on.length) changes.push(`switched on ${on.join(", ")}`);
  }
  await audit(actor, "COMPANY_UPDATED", `Updated ${t.name}${changes.length ? `: ${changes.join("; ")}` : ""}`, tenantId);
  return { ok: true };
}

/**
 * Suspending signs everyone in the company out on their next request and
 * blocks sign-in until it is reactivated. Nothing is deleted.
 */
export async function setCompanyActive(tenantId: string, active: boolean, reason: string | null, actor: Actor): Promise<Result> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!t) return { ok: false, message: "That company no longer exists." };
  if (!active && !reason?.trim()) return { ok: false, message: "Give a reason for suspending; the company's users see it." };
  await prisma.tenant.update({
    where: { id: tenantId },
    data: active ? { isActive: true, suspendedAt: null, suspendedReason: null } : { isActive: false, suspendedAt: new Date(), suspendedReason: reason!.trim() },
  });
  await audit(actor, active ? "COMPANY_REACTIVATED" : "COMPANY_SUSPENDED", active ? `Reactivated ${t.name}` : `Suspended ${t.name}: ${reason!.trim()}`, tenantId);
  return { ok: true };
}

/** Adds another Global Admin to a company (e.g. when the first one leaves). */
export async function addCompanyAdmin(tenantId: string, a: { firstName: string; lastName: string; email: string }, actor: Actor): Promise<Result<{ email: string; tempPassword: string }>> {
  const email = a.email.trim().toLowerCase();
  if (!a.firstName.trim() || !a.lastName.trim()) return { ok: false, message: "Enter the admin's first and last name." };
  if (!emailOk(email)) return { ok: false, message: "Enter a valid email." };
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!t) return { ok: false, message: "That company no longer exists." };
  const role = await prisma.role.findFirst({ where: { tenantId, key: "GLOBAL_ADMIN" } });
  if (!role) return { ok: false, message: "This company has no Global Admin role." };
  const tempPassword = temporaryPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const existing = await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
  if (existing) {
    // An existing person becomes an admin and gets a fresh temporary password.
    await prisma.$transaction([
      prisma.user.update({ where: { id: existing.id }, data: { passwordHash, mustChangePassword: true, loginDisabled: false, isDeactivated: false, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 } } }),
      prisma.userRoleAssignment.upsert({ where: { userId_roleId: { userId: existing.id, roleId: role.id } }, create: { userId: existing.id, roleId: role.id, grantedBy: `platform:${actor.email}` }, update: {} }),
    ]);
  } else {
    const series = await prisma.employeeNumberSeries.findFirst({ where: { tenantId, isDefault: true } });
    const entity = await prisma.legalEntity.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { tenantId, email, passwordHash, mustChangePassword: true, passwordChangedAt: new Date() } });
      let employeeNumber = `ADM-${Date.now().toString(36).toUpperCase()}`;
      if (series) {
        employeeNumber = `${series.prefix}${String(series.nextNumber).padStart(series.digits, "0")}${series.suffix}`;
        await tx.employeeNumberSeries.update({ where: { id: series.id }, data: { nextNumber: { increment: 1 } } });
      }
      await tx.employee.create({
        data: {
          tenantId, userId: user.id, legalEntityId: entity?.id ?? null, employeeNumber,
          firstName: a.firstName.trim(), lastName: a.lastName.trim(), displayName: `${a.firstName.trim()} ${a.lastName.trim()}`,
          workEmail: email, status: "CONFIRMED", dateOfJoining: new Date(),
        },
      });
      await tx.userRoleAssignment.create({ data: { userId: user.id, roleId: role.id, grantedBy: `platform:${actor.email}` } });
    });
  }
  await audit(actor, "COMPANY_ADMIN_ADDED", `Made ${email} a Global Admin of ${t.name}`, tenantId);
  return { ok: true, email, tempPassword };
}

/** A new temporary password for one of the company's users; their sessions end. */
export async function resetCompanyUserPassword(tenantId: string, userId: string, actor: Actor): Promise<Result<{ email: string; tempPassword: string }>> {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, include: { tenant: { select: { name: true } } } });
  if (!user) return { ok: false, message: "That user is not in this company." };
  const tempPassword = temporaryPassword();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(tempPassword, 10), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, loginDisabled: false, sessionVersion: { increment: 1 } },
  });
  await audit(actor, "COMPANY_PASSWORD_RESET", `Reset the password of ${user.email} at ${user.tenant.name}`, tenantId);
  return { ok: true, email: user.email, tempPassword };
}

/** One row per company for the platform dashboard. */
export async function companySummaries() {
  const [tenants, employees, users, lastLogins] = await Promise.all([
    prisma.tenant.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.employee.groupBy({ by: ["tenantId"], where: { status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] } }, _count: { _all: true } }).catch(() => [] as { tenantId: string; _count: { _all: number } }[]),
    prisma.user.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["tenantId"], _max: { lastLoginAt: true } }),
  ]);
  const emp = new Map(employees.map((e) => [e.tenantId, e._count._all]));
  const usr = new Map(users.map((u) => [u.tenantId, u._count._all]));
  const last = new Map(lastLogins.map((u) => [u.tenantId, u._max.lastLoginAt]));
  return tenants.map((t) => ({ ...t, activeEmployees: emp.get(t.id) ?? 0, users: usr.get(t.id) ?? 0, lastLoginAt: last.get(t.id) ?? null }));
}

export async function companyAdmins(tenantId: string) {
  return prisma.user.findMany({
    where: { tenantId, roleAssignments: { some: { role: { key: "GLOBAL_ADMIN" } } } },
    select: { id: true, email: true, lastLoginAt: true, mustChangePassword: true, loginDisabled: true, isDeactivated: true, lockedUntil: true, employee: { select: { firstName: true, lastName: true } } },
    orderBy: { email: "asc" },
  });
}
