import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@keka/db";

/**
 * Platform admin sessions: a separate cookie and a separate audience from a
 * company user's session, so neither can be replayed as the other.
 */

export const PLATFORM_COOKIE = "boss_platform";
const AUDIENCE = "boss-platform";
const MAX_AGE_SECONDS = 60 * 60 * 8;

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(value);
}

export async function createPlatformSession(admin: { id: string; email: string; sessionVersion: number }): Promise<void> {
  const token = await new SignJWT({ adminId: admin.id, email: admin.email, sv: admin.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
  (await cookies()).set(PLATFORM_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/platform", maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroyPlatformSession(): Promise<void> {
  (await cookies()).delete({ name: PLATFORM_COOKIE, path: "/platform" });
}

export interface PlatformViewer { id: string; email: string; name: string; mustChangePassword: boolean }

export const getPlatformAdmin = cache(async (): Promise<PlatformViewer | null> => {
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE });
    if (!payload.adminId) return null;
    const admin = await prisma.platformAdmin.findUnique({ where: { id: String(payload.adminId) } });
    if (!admin || !admin.isActive || admin.sessionVersion !== (typeof payload.sv === "number" ? payload.sv : -1)) return null;
    return { id: admin.id, email: admin.email, name: admin.name, mustChangePassword: admin.mustChangePassword };
  } catch {
    return null;
  }
});

/** Sends anyone without a platform session to the platform sign-in. */
export async function requirePlatformAdmin(opts: { allowPasswordChange?: boolean } = {}): Promise<PlatformViewer> {
  const admin = await getPlatformAdmin();
  if (!admin) redirect("/platform/signin");
  if (admin.mustChangePassword && !opts.allowPasswordChange) redirect("/platform/account?required=1");
  return admin;
}
