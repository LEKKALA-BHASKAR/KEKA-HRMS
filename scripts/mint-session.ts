/**
 * Mint a session cookie for a seeded user, for local smoke testing.
 *   npx tsx scripts/mint-session.ts priya.sharma@acme.test
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: mint-session.ts <email>");

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) throw new Error(`no user with email ${email}`);

  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");

  const token = await new SignJWT({
    userId: user.id, tenantId: user.tenantId, email: user.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(secret));

  process.stdout.write(token);
}

main()
  .catch((e) => { console.error(e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
