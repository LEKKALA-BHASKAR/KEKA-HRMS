import { PrismaClient } from "@prisma/client";

// A single client per process. Next.js dev reloads modules on every edit, so
// without this the connection pool is exhausted within a few saves.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// The cast keeps the client typed as plain PrismaClient. Without it TypeScript
// structurally compares PrismaClient<{ log }> with PrismaClient for the `??`,
// which on a schema this size costs minutes and gigabytes of heap per typecheck.
function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
export { Prisma } from "@prisma/client";
