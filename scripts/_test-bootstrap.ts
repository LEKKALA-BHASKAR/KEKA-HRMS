/**
 * Test bootstrap. Must be the first import in any script that calls a server
 * action directly.
 *
 * Rather than stubbing out the authorization layer, this stubs the two Next
 * runtime pieces an action depends on — the cookie jar and the request store —
 * so the genuine `getViewer` chain runs: session verification, the database
 * read, implicit-role derivation and permission assembly. That makes these
 * tests exercise real authorization instead of bypassing it.
 */
import path from "node:path";
import Module from "node:module";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../.env") });

const WEB_SRC = path.resolve(__dirname, "../apps/web/src");

/** The session cookie value the stubbed jar hands back. */
let currentToken: string | null = null;

export function setTestSession(token: string | null): void {
  currentToken = token;
}

const cookieJar = {
  get(name: string) {
    if (name === "keka_session" && currentToken) return { name, value: currentToken };
    return undefined;
  },
  set() { /* the action layer never needs to read this back in a test */ },
  delete() { currentToken = null; },
  getAll() { return currentToken ? [{ name: "keka_session", value: currentToken }] : []; },
  has(name: string) { return name === "keka_session" && !!currentToken; },
};

const headersStub = {
  cookies: async () => cookieJar,
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internal = Module as unknown as { _load: Loader };
const original = internal._load;

internal._load = function patched(request: string, parent: unknown, isMain: boolean) {
  // `server-only` throws when Node resolves it: outside a bundler there is no
  // react-server condition to select the empty variant. Correct for the app,
  // wrong for a test runner.
  if (request === "server-only" || request === "client-only") return {};

  if (request === "next/headers") return headersStub;

  // The web app uses the "@/*" alias, which only a bundler resolves.
  if (request.startsWith("@/")) {
    return original.call(this, path.join(WEB_SRC, request.slice(2)), parent, isMain);
  }

  return original.call(this, request, parent, isMain);
} as Loader;

/** Mint a session for a seeded user and install it as the current session. */
export async function signInAs(email: string): Promise<{ userId: string; tenantId: string }> {
  const { PrismaClient } = await import("@prisma/client");
  const { SignJWT } = await import("jose");
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) throw new Error(`no seeded user with email ${email}`);
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error("AUTH_SECRET is not set");

    const token = await new SignJWT({
      userId: user.id, tenantId: user.tenantId, email: user.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    setTestSession(token);
    return { userId: user.id, tenantId: user.tenantId };
  } finally {
    await prisma.$disconnect();
  }
}

/** Build a FormData the way a browser would submit one. */
export function formData(values: Record<string, string | number | boolean | undefined | null>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    // An unchecked checkbox is absent; a checked one submits "on".
    if (typeof v === "boolean") { if (v) f.set(k, "on"); continue; }
    f.set(k, String(v));
  }
  return f;
}

let failures = 0;
export function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
export function section(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(72));
}
export function report(suite: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(failures === 0 ? `  ${suite}: all checks passed.\n` : `  ${suite}: ${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exitCode = 1;
}
export function failureCount(): number { return failures; }
