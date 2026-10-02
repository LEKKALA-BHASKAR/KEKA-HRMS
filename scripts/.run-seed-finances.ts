import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seedFinances } from "../packages/db/prisma/seed/finances";
const prisma = new PrismaClient();
(async () => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  console.log(await seedFinances(prisma, { tenantId: t.id }));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
