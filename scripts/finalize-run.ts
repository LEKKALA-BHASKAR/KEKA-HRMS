/** Lock, finalise and release a run so downstream screens have real data. */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../.env") });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const run = await prisma.payrollRun.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
    include: { lines: true },
  });
  const actor = await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } });

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: { status: "LOCKED", lockedAt: new Date(), lockedBy: actor.id, currentStep: 6 },
  });

  for (const line of run.lines) {
    if (line.payAction === "VOID_SALARY_PROCESSING" || line.payAction === "HOLD_SALARY_PROCESSING") continue;
    await prisma.payslip.upsert({
      where: { runId_employeeId_isSegregated: { runId: run.id, employeeId: line.employeeId, isSegregated: false } },
      create: {
        runId: run.id, employeeId: line.employeeId,
        year: run.year, month: run.month,
        status: "RELEASED", netPay: line.netPay,
        releasedAt: new Date(), releasedBy: actor.id,
      },
      update: { status: "RELEASED", netPay: line.netPay, releasedAt: new Date() },
    });
  }

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: { status: "FINALIZED", finalizedAt: new Date(), finalizedBy: actor.id },
  });

  const count = await prisma.payslip.count({ where: { runId: run.id } });
  console.log(`Finalised run ${run.year}-${run.month}: ${count} payslips released`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
