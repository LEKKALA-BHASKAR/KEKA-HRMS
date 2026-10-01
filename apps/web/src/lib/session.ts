import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * Session handling.
 *
 * A signed JWT in an httpOnly cookie. It carries only identity — never
 * permissions — because roles change while a session is live and a stale
 * permission claim is a security bug. Permissions are resolved from the
 * database on every request in lib/context.ts.
 */

const COOKIE_NAME = "keka_session";
const MAX_AGE_SECONDS = 60 * 60 * 8; // an 8-hour working day

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(value);
}

export interface SessionPayload {
  userId: string;
  tenantId: string;
  email: string;
  /** The user's session version when this was issued; a bump revokes it. */
  sv?: number;
}

export async function createSession(payload: SessionPayload, hours?: number): Promise<void> {
  const maxAge = hours ? Math.round(hours * 3600) : MAX_AGE_SECONDS;
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

// --- A sign-in waiting on its second factor --------------------------------

const PENDING_COOKIE = "keka_2fa";

export interface PendingSignIn { userId: string; tenantId: string; email: string; challengeId: string; next?: string }

export async function setPendingSignIn(p: PendingSignIn): Promise<void> {
  const token = await new SignJWT({ ...p, purpose: "2fa" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(secret());
  const store = await cookies();
  store.set(PENDING_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/signin", maxAge: 600 });
}

export async function readPendingSignIn(): Promise<PendingSignIn | null> {
  const store = await cookies();
  const token = store.get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "2fa") return null;
    return { userId: String(payload.userId), tenantId: String(payload.tenantId), email: String(payload.email), challengeId: String(payload.challengeId) };
  } catch {
    return null;
  }
}

export async function clearPendingSignIn(): Promise<void> {
  const store = await cookies();
  store.delete({ name: PENDING_COOKIE, path: "/signin" });
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.userId || !payload.tenantId) return null;
    return {
      userId: String(payload.userId),
      tenantId: String(payload.tenantId),
      email: String(payload.email ?? ""),
      sv: typeof payload.sv === "number" ? payload.sv : 0,
    };
  } catch {
    // Expired or tampered. Treat as signed out rather than erroring.
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
