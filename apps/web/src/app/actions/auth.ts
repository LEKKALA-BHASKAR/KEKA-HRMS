"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@keka/db";
import { createSession, destroySession, readSession } from "@/lib/session";

/**
 * Credential sign-in.
 *
 * Failures return one generic message. Distinguishing "no such user" from
 * "wrong password" hands an attacker a free account-enumeration oracle.
 */

export interface SignInState {
  error?: string;
}

const GENERIC_ERROR = "That email and password combination is not recognised.";

export async function signIn(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const subdomain = String(formData.get("subdomain") ?? "acme").trim().toLowerCase();

  if (!email || !password) {
    return { error: "Enter both your email address and password." };
  }

  const tenant = await prisma.tenant.findUnique({ where: { subdomain } });
  if (!tenant || !tenant.isActive) {
    return { error: GENERIC_ERROR };
  }

  const user = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email } },
  });

  // Hash a dummy value when the user is missing so the response time does not
  // reveal whether the account exists.
  const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    return { error: GENERIC_ERROR };
  }

  if (user.loginDisabled) {
    return { error: "Login for this account has been disabled. Contact your administrator." };
  }
  if (user.isDeactivated) {
    return { error: "This account is deactivated. Contact your administrator." };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: tenant.id,
      module: "AUTH",
      action: "LOGIN",
      entityType: "User",
      entityId: user.id,
      actorId: user.id,
      actorLabel: user.email,
      summary: `${user.email} signed in`,
    },
  });

  await createSession({ userId: user.id, tenantId: tenant.id, email: user.email });
  redirect("/");
}

export async function signOut(): Promise<void> {
  const session = await readSession();
  if (session) {
    await prisma.auditLog.create({
      data: {
        tenantId: session.tenantId,
        module: "AUTH",
        action: "LOGOUT",
        entityType: "User",
        entityId: session.userId,
        actorId: session.userId,
        actorLabel: session.email,
        summary: `${session.email} signed out`,
      },
    });
  }
  await destroySession();
  redirect("/signin");
}
