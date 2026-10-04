import { prisma, type Prisma } from "@keka/db";

/** Audit entries written by the money services (workflow effects, no viewer at hand). */
export async function moneyAudit(tenantId: string, actorUserId: string | null, opts: {
  module: "PAYROLL" | "FINANCE" | "EMPLOYEE"; action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "EXPORT"; entityType: string; entityId?: string | null; summary: string; newValue?: unknown;
}): Promise<void> {
  const actor = actorUserId ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({
    data: {
      tenantId, module: opts.module, action: opts.action, entityType: opts.entityType, entityId: opts.entityId ?? null, summary: opts.summary,
      newValue: opts.newValue === undefined ? undefined : (opts.newValue as Prisma.InputJsonValue),
      actorId: actor ? actorUserId : null, actorLabel: actor?.email ?? "system",
    },
  });
}
