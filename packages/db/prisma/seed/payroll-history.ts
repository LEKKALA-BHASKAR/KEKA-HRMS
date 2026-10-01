import type { PrismaClient } from "@prisma/client";

/**
 * Payroll history: April to August processed, locked, finalised and
 * released through the same services the product uses, one month at a time
 * so each month's year-to-date tax builds on the last. September is
 * calculated and left open, as the current month would be.
 */
export async function seedPayrollHistory(prisma: PrismaClient, ctx: { tenantId: string }) {
  const svc = await import("@keka/services");
  const actor = await prisma.user.findFirstOrThrow({ where: { tenantId: ctx.tenantId, email: "ramesh.iyer@acme.test" } });
  const groups = await prisma.payGroup.findMany({ where: { tenantId: ctx.tenantId } });
  let finalised = 0, payslips = 0;
  for (const g of groups) {
    for (const month of [4, 5, 6, 7, 8]) {
      const runId = await svc.createRun({ tenantId: ctx.tenantId, payGroupId: g.id, year: 2026, month });
      await svc.calculateRun(runId);
      await prisma.payrollRun.update({ where: { id: runId }, data: { status: "LOCKED", lockedAt: new Date(Date.UTC(2026, month, 1)), lockedBy: actor.id, currentStep: 6 } });
      const fin = await svc.finalizePayrollRun(runId, actor.id);
      if (!fin.ok) throw new Error(`Finalising ${month}/2026: ${fin.message}`);
      await svc.releasePayslipsForRun(runId, actor.id);
      finalised++;
      payslips += fin.payslips ?? 0;
    }
    const sep = await svc.createRun({ tenantId: ctx.tenantId, payGroupId: g.id, year: 2026, month: 9 });
    await svc.calculateRun(sep);
  }
  return { finalised, payslips };
}
