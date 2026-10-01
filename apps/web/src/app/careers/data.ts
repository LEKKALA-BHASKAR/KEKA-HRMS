import type { Prisma } from "@keka/db";

/** A job anyone may see: open, published, and not past its closing date. */
export function publicJobWhere(tenantId: string): Prisma.JobWhereInput {
  return { tenantId, status: "OPEN", isPublished: true, OR: [{ closesAt: null }, { closesAt: { gte: new Date() } }] };
}
