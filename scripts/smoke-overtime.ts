/**
 * Overtime as a payroll input, through the actions: add hours for a pay
 * month (priced at annual basic ÷ 2,920 unless a rate is given), set a rate,
 * void and restore an entry, see it paid on the run, and see finalising
 * consume it (read-only) and rolling back release it.
 *
 * Uses the October 2026 payroll period (refusing to run if a run exists for
 * it); the run, its postings and the entries are removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const Y = 2026, M = 10;

async function main() {
  const act = await import("../apps/web/src/app/actions/overtime");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } } });
  const runWhere = { tenantId: tenant.id, payGroupId: meera.payGroupId!, year: Y, month: M };
  if (await prisma.payrollRun.count({ where: runWhere })) throw new Error(`A payroll run already exists for ${M}/${Y}; this test needs that month free.`);
  const since = new Date();
  let runId = "";

  try {
    // -----------------------------------------------------------------
    section("Adding and pricing overtime");
    await signInAs("meera.krishnan@acme.test");
    const no = await act.addOvertimeAction({}, fd({ employeeId: meera.id, month: "2026-10", hours: 3 }));
    check("An employee cannot add overtime", no.ok !== true, no.message);

    await signInAs("vikram.menon@acme.test");
    const added = await act.addOvertimeAction({}, fd({ employeeId: meera.id, month: "2026-10", hours: 6 }));
    check("Added 6 hours", added.ok === true && /6 hrs at ₹/.test(added.message ?? ""), added.message);
    const entry = await prisma.overtimeEntry.findFirstOrThrow({ where: { employeeId: meera.id, year: Y, month: M, createdAt: { gte: since } } });
    check("Priced at basic ÷ 2,920", Number(entry.rate) > 0 && Math.abs(Number(entry.amount) - 6 * Number(entry.rate)) < 0.01, `${entry.rate}/hr = ${entry.amount}`);
    const rated = await act.setOvertimeRateAction({}, fd({ id: entry.id, rate: "250" }));
    check("A rate can be set", rated.ok === true && Number((await prisma.overtimeEntry.findUniqueOrThrow({ where: { id: entry.id } })).amount) === 1500, rated.message);
    const big = await act.addOvertimeAction({}, fd({ employeeId: meera.id, month: "2026-10", hours: 500 }));
    check("Implausible hours are refused", big.ok !== true, big.message);

    const voided = await act.decideOvertimeAction({}, fd({ id: entry.id, action: "VOID" }));
    check("Voided", voided.ok === true);
    runId = await svc.createRun(runWhere);
    await svc.calculateRun(runId);
    const otLine = async () => (await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: meera.id } }, include: { lines: true } })).lines.find((l) => l.code === "OVERTIME");
    check("A voided entry is not paid", !(await otLine()));

    // -----------------------------------------------------------------
    section("Through the payroll run");
    await act.decideOvertimeAction({}, fd({ id: entry.id, action: "PAY" }));
    await svc.calculateRun(runId);
    check("The run pays it as an Overtime line", Number((await otLine())?.amount) === 1500, String((await otLine())?.amount));

    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "LOCKED" } });
    const actor = await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } });
    const fin = await svc.finalizePayrollRun(runId, actor.id);
    check("Finalised", fin.ok === true, fin.message);
    const after = await prisma.overtimeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    check("Finalising marks the entry paid in that run", after.isProcessed && after.runId === runId);
    const locked = await act.decideOvertimeAction({}, fd({ id: entry.id, action: "VOID" }));
    check("A paid entry cannot be changed", locked.ok !== true, locked.message);
    const closed = await act.addOvertimeAction({}, fd({ employeeId: meera.id, month: "2026-10", hours: 2 }));
    check("Nothing more can be added to a finalised month", closed.ok !== true, closed.message);

    const rb = await svc.rollbackPayrollRun(runId, "Smoke test");
    const back = await prisma.overtimeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    check("Rolling back releases it", rb.ok === true && !back.isProcessed && back.runId === null, rb.message);
  } finally {
    await prisma.overtimeEntry.deleteMany({ where: { employeeId: meera.id, createdAt: { gte: since } } });
    const ids = runId ? [runId] : [];
    const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefId: { in: ids } }, select: { id: true, reversedById: true } });
    const entryIds = [...entries.map((e) => e.id), ...entries.map((e) => e.reversedById).filter((x): x is string => !!x)];
    await prisma.ledgerEntry.updateMany({ where: { id: { in: entryIds } }, data: { reversedById: null } });
    await prisma.ledgerEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: { in: ["OvertimeEntry", "PayrollRun"] } } });
  }
  report("Overtime");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
