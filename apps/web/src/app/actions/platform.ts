"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PlanTier } from "@keka/db";
import { createPlatformSession, destroyPlatformSession, requirePlatformAdmin } from "@/lib/platform/session";
import { verifyPlatformLogin, changePlatformPassword, upsertPlatformAdmin, setPlatformAdminActive } from "@/lib/platform/admins";
import {
  onboardCompany, updateCompany, setCompanyActive, addCompanyAdmin, resetCompanyUserPassword,
} from "@/lib/platform/tenants";
import { companyUrl } from "@/lib/tenant-host-shared";

/** What a platform form shows after it runs. A temporary password appears once, here, and nowhere else. */
export interface PlatformState {
  ok?: boolean;
  error?: string;
  info?: string;
  credentials?: { url?: string; email: string; password: string };
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const PLANS: PlanTier[] = ["FOUNDATION", "STRENGTH", "GROWTH"];
const plan = (v: string): PlanTier | undefined => (PLANS as string[]).includes(v) ? (v as PlanTier) : undefined;
const intOrNull = (v: string) => (v === "" ? null : Number(v));

async function actor() {
  const a = await requirePlatformAdmin();
  return { id: a.id, email: a.email };
}

// ---- Session ---------------------------------------------------------------

export async function platformSignIn(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const res = await verifyPlatformLogin(s(fd, "email"), String(fd.get("password") ?? ""));
  if (!res.ok) return { error: res.message };
  await createPlatformSession(res.admin);
  redirect(res.admin.mustChangePassword ? "/platform/account?required=1" : "/platform");
}

export async function platformSignOut(): Promise<void> {
  await destroyPlatformSession();
  redirect("/platform/signin");
}

export async function platformChangePassword(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const me = await requirePlatformAdmin({ allowPasswordChange: true });
  const next = String(fd.get("next") ?? "");
  if (next !== String(fd.get("confirm") ?? "")) return { error: "The new passwords do not match." };
  const res = await changePlatformPassword(me.id, String(fd.get("current") ?? ""), next);
  if (!res.ok) return { error: res.message };
  // The change revoked every session, this one included; sign in again.
  await destroyPlatformSession();
  redirect("/platform/signin?changed=1");
}

// ---- Companies -------------------------------------------------------------

export async function createCompany(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const res = await onboardCompany({
    name: s(fd, "name"),
    legalName: s(fd, "legalName"),
    subdomain: s(fd, "subdomain"),
    plan: plan(s(fd, "plan")),
    modules: fd.getAll("modules").map(String),
    countryCode: s(fd, "countryCode"),
    currency: s(fd, "currency"),
    timezone: s(fd, "timezone"),
    fyStartMonth: Number(s(fd, "fyStartMonth") || 4),
    employeeLimit: intOrNull(s(fd, "employeeLimit")),
    contactPhone: s(fd, "contactPhone"),
    admin: { firstName: s(fd, "adminFirstName"), lastName: s(fd, "adminLastName"), email: s(fd, "adminEmail") },
  }, who);
  if (!res.ok) return { error: res.message };
  revalidatePath("/platform");
  return {
    ok: true,
    info: `${s(fd, "name")} is ready. Send these sign-in details to the company admin; the password is shown only once and must be changed at first sign-in.`,
    credentials: { url: companyUrl(res.subdomain), email: res.adminEmail, password: res.tempPassword },
  };
}

export async function saveCompany(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const id = s(fd, "tenantId");
  const res = await updateCompany(id, {
    name: s(fd, "name"),
    plan: plan(s(fd, "plan")),
    countryCode: s(fd, "countryCode") || undefined,
    currency: s(fd, "currency") || undefined,
    timezone: s(fd, "timezone") || undefined,
    fyStartMonth: s(fd, "fyStartMonth") ? Number(s(fd, "fyStartMonth")) : undefined,
    employeeLimit: intOrNull(s(fd, "employeeLimit")),
    contactName: s(fd, "contactName"),
    contactEmail: s(fd, "contactEmail"),
    contactPhone: s(fd, "contactPhone"),
    platformNotes: s(fd, "platformNotes"),
  }, who);
  if (!res.ok) return { error: res.message };
  revalidatePath(`/platform/companies/${id}`);
  return { ok: true, info: "Saved." };
}

export async function saveModules(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const id = s(fd, "tenantId");
  const res = await updateCompany(id, { modules: fd.getAll("modules").map(String) }, who);
  if (!res.ok) return { error: res.message };
  revalidatePath(`/platform/companies/${id}`);
  return { ok: true, info: "Modules saved. People in the company see the change on their next page load." };
}

export async function changeCompanyStatus(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const id = s(fd, "tenantId");
  const active = s(fd, "active") === "1";
  const res = await setCompanyActive(id, active, s(fd, "reason") || null, who);
  if (!res.ok) return { error: res.message };
  revalidatePath(`/platform/companies/${id}`);
  revalidatePath("/platform");
  return { ok: true, info: active ? "The company is active again." : "Suspended. Everyone in the company is signed out and cannot sign in." };
}

export async function addAdmin(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const id = s(fd, "tenantId");
  const res = await addCompanyAdmin(id, { firstName: s(fd, "firstName"), lastName: s(fd, "lastName"), email: s(fd, "email") }, who);
  if (!res.ok) return { error: res.message };
  revalidatePath(`/platform/companies/${id}`);
  return { ok: true, info: "Admin added. The password is shown only once.", credentials: { url: s(fd, "url") || undefined, email: res.email, password: res.tempPassword } };
}

export async function resetAdminPassword(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const id = s(fd, "tenantId");
  const res = await resetCompanyUserPassword(id, s(fd, "userId"), who);
  if (!res.ok) return { error: res.message };
  revalidatePath(`/platform/companies/${id}`);
  return { ok: true, info: "Password reset. Their old sessions are signed out.", credentials: { url: s(fd, "url") || undefined, email: res.email, password: res.tempPassword } };
}

// ---- Platform team ---------------------------------------------------------

export async function addPlatformAdmin(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const res = await upsertPlatformAdmin(s(fd, "email"), s(fd, "name"), who);
  if (!res.ok) return { error: res.message };
  revalidatePath("/platform/team");
  return { ok: true, info: res.created ? "Platform admin added." : "Password reset.", credentials: { email: res.email, password: res.tempPassword } };
}

export async function togglePlatformAdmin(_prev: PlatformState, fd: FormData): Promise<PlatformState> {
  const who = await actor();
  const res = await setPlatformAdminActive(s(fd, "id"), s(fd, "active") === "1", who);
  if (!res.ok) return { error: res.message };
  revalidatePath("/platform/team");
  return { ok: true };
}
