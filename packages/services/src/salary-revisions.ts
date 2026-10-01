import { prisma, type Prisma } from "@keka/db";

/**
 * Applying a salary revision: mark it applied and, when it is dated before
 * the last finalised payroll, owe the difference as arrears for every closed
 * month since. Used straight away when no approval is needed, and on final
 * approval otherwise, so the arrears reflect the payroll as it stands then.
 */
export async function applySalaryRevision(revisionId: string, tx: Prisma.TransactionClient = prisma as unknown as Prisma.TransactionClient):
  Promise<{ backdated: boolean; arrears: number }> {
  const rev = await tx.salaryRevision.findUniqueOrThrow({ where: { id: revisionId }, include: { employee: { select: { payGroupId: true } } } });
  const payGroupId = rev.employee.payGroupId;
  const lastFinalised = payGroupId
    ? await tx.payrollRun.findFirst({ where: { payGroupId, status: "FINALIZED", type: "REGULAR" }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { periodEnd: true } })
    : null;
  const backdated = !!lastFinalised && rev.effectiveFrom <= lastFinalised.periodEnd;
  await tx.salaryRevision.update({ where: { id: rev.id }, data: { status: "APPLIED", arrearsProcessed: !backdated } });
  let arrears = 0;
  const prev = rev.previousCtc === null ? null : Number(rev.previousCtc);
  if (backdated && payGroupId && prev !== null && Number(rev.annualCtc) > prev) {
    const monthlyDelta = (Number(rev.annualCtc) - prev) / 12;
    const closed = await tx.payrollRun.findMany({ where: { payGroupId, status: "FINALIZED", type: "REGULAR", periodEnd: { gte: rev.effectiveFrom } }, select: { year: true, month: true } });
    for (const r of closed) {
      await tx.arrear.create({
        data: {
          employeeId: rev.employeeId, source: "BACKDATED_REVISION", forYear: r.year, forMonth: r.month, amount: Math.round(monthlyDelta),
          note: `Back-dated revision effective ${rev.effectiveFrom.toISOString().slice(0, 10)}`,
        },
      });
      arrears++;
    }
  }
  return { backdated, arrears };
}
