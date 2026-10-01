import "server-only";
import { prisma } from "@keka/db";

/** Everyone a survey is addressed to: active employees in its departments. */
export async function surveyAudience(tenantId: string, departmentIds: string[]) {
  return prisma.employee.findMany({
    where: {
      tenantId, status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] },
      ...(departmentIds.length ? { departmentId: { in: departmentIds } } : {}),
    },
    select: { id: true, userId: true, departmentId: true },
  });
}
