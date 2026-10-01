/**
 * Test cleanup for the general ledger. Suites run one at a time, so the
 * entries a suite posted are exactly those created since it started; removing
 * them and rebuilding the stored balances leaves the books as the seed made
 * them. The app never deletes a posted entry — only tests do.
 */
import type { PrismaClient } from "@prisma/client";

export async function purgeLedgerSince(prisma: PrismaClient, tenantId: string, since: Date): Promise<void> {
  const svc = await import("@keka/services");
  const ids = (await prisma.ledgerEntry.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { id: true } })).map((e) => e.id);
  await svc.purgeEntriesForTests(tenantId, ids);
}
