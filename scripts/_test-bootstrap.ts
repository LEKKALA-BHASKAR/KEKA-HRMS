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
import { interceptModule } from "./_runtime";
// next.config.ts turns on authInterrupts at build time; outside a build, set
// the flag it compiles to so forbidden() throws its real 403 interrupt.
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "true";


/** Cookies the stubbed jar holds; the session lives under keka_session. */
const jar = new Map<string, string>();
let requestHeaders = new Headers();

export function setTestSession(token: string | null): void {
  if (token) jar.set("keka_session", token); else jar.delete("keka_session");
}

/** Headers the next server action sees — e.g. a client IP for rate limiting. */
export function setTestHeaders(h: Record<string, string>): void {
  requestHeaders = new Headers(h);
}

/** Read back a cookie the code under test set. */
export function testCookie(name: string): string | undefined {
  return jar.get(name);
}

const cookieJar = {
  get(name: string) {
    const value = jar.get(name);
    return value === undefined ? undefined : { name, value };
  },
  // Accepts set(name, value, opts) and set({ name, value, ... }), as Next does.
  set(a: string | { name: string; value: string }, b?: string) {
    if (typeof a === "string") jar.set(a, b ?? ""); else jar.set(a.name, a.value);
  },
  delete(a: string | { name: string }) { jar.delete(typeof a === "string" ? a : a.name); },
  getAll() { return [...jar.entries()].map(([name, value]) => ({ name, value })); },
  has(name: string) { return jar.has(name); },
};

const headersStub = {
  cookies: async () => cookieJar,
  headers: async () => requestHeaders,
  draftMode: async () => ({ isEnabled: false }),
};

interceptModule((request) => (request === "next/headers" ? headersStub : undefined));

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
      userId: user.id, tenantId: user.tenantId, email: user.email, sv: user.sessionVersion,
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
