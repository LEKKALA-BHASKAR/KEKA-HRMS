/**
 * Create a BooS-HR platform admin, or reset one's password, from the server.
 * This is how the first person gets into /platform; after that, admins add
 * each other from the panel's "Platform team" page.
 *
 *   npm run platform:admin -- you@example.com "Your Name"
 *
 * Prints a temporary password once; it must be changed at first sign-in.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../.env") });

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email) {
    console.error('usage: npm run platform:admin -- <email> ["Full Name"]');
    process.exit(2);
  }
  const { upsertPlatformAdmin } = await import("../apps/web/src/lib/platform/admins");
  const res = await upsertPlatformAdmin(email, nameParts.join(" "), { id: null, email: "command line" });
  if (!res.ok) { console.error(res.message); process.exit(1); }
  console.log(res.created ? "Platform admin created." : "Platform admin password reset.");
  console.log(`  Email:              ${res.email}`);
  console.log(`  Temporary password: ${res.tempPassword}`);
  console.log("  Sign in at <your site>/platform and choose a new password.");
  const { prisma } = await import("@keka/db");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
