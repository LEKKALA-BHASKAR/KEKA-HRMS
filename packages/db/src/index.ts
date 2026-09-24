import { PrismaClient } from "@prisma/client";

// A single client per process. Next.js dev reloads modules on every edit, so
// without this the connection pool is exhausted within a few saves.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
export { Prisma } from "@prisma/client";
