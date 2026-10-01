/**
 * Off-cycle payroll, through the actions: it can only follow a finalised
 * regular month and only for people paid in it; it pays only what is added
 * (payments, deductions, bonuses pulled off the schedule) with income tax as
 * the extra tax for the year and no PF/ESI/PT/LWF; finalising produces
 * payslips and marks the items paid; rolling back releases them.
 *
 * Runs against August 2026 for Meera and Ramesh; everything it creates
 * (runs, items, payslips, ledger postings) is removed at the end, and the
 * seeded bonus it borrows is put back.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
async function redirected(fn: () => Promise<unknown>): Promise<string | null> {
  try { const r = await fn(); return (r as { message?: string })?.message ? `!${(r as { message: string }).message}` : null; }
  catch (e) { const d = (e as { digest?: string }).digest ?? ""; return d.startsWith("NEXT_REDIRECT") ? d.split(";")[2] : (() => { throw e; })(); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/off-cycle");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const byEmail = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } } });
  const meera = await byEmail("meera.krishnan@acme.test"), ramesh = await byEmail("ramesh.iyer@acme.test");
  const aug = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId: tenant.id, payGroupId: meera.payGroupId!, year: 2026, month: 8, type: "REGULAR" } });
  const sep = await prisma.payrollRun.findFirst({ where: { tenantId: tenant.id, payGroupId: meera.payGroupId!, year: 2026, month: 9, type: "REGULAR" } });
  const pli = await prisma.employeeBonus.findFirst({ where: { employeeId: meera.id, isProcessed: false, payAction: "PAY" } });
  const since = new Date();
  const created = () => prisma.payrollRun.findMany({ where: { tenantId: tenant.id, type: "OFF_CYCLE", createdAt: { gte: since } } });
  const start = (f: Record<string, string>, ids: string[]) => { const form = fd(f); for (const id of ids) form.append("employeeIds", id); return redirected(() => act.startOffCycleAction({}, form)); };

  console.log("\nOff-cycle payroll\n" + "=".repeat(72));
  try {
    section("Starting");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot start one", await denied(() => act.startOffCycleAction({}, fd({}))));
    await signInAs("ramesh.iyer@acme.test");
    if (sep) {
      const open = await start({ baseRunId: sep.id, reason: "Smoke" }, [meera.id]);
      check("It cannot follow a month that is not finalised", !!open?.startsWith("!") && /Finalise/.test(open), open ?? "");
    }
    const stranger = await start({ baseRunId: aug.id, reason: "Smoke" }, ["nope"]);
    check("Only people paid in that month can be included", !!stranger?.startsWith("!"), stranger ?? "");
    const to = await start({ baseRunId: aug.id, reason: "Smoke off-cycle" }, [meera.id, ramesh.id]);
    const [run] = await created();
    check("It starts against a finalised month", !!run && to === `/payroll/runs/${run.id}` && run.sequence >= 1 && run.baseRunId === aug.id, to ?? "");
    const runId = run.id;
    const line = (employeeId: string) => prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId } }, include: { lines: true } });

    section("What it pays");
    const add = (f: Record<string, string>) => act.addOffCycleItemAction({}, fd({ runId, ...f }));
    // Ramesh earns well into the top slab; Meera stays inside the new-regime rebate.
    const a1 = await add({ employeeId: ramesh.id, type: "PAYMENT", name: "Smoke retention bonus", amount: "100000", taxable: "on" });
    await add({ employeeId: ramesh.id, type: "DEDUCTION", name: "Smoke recovery", amount: "1000" });
    await add({ employeeId: meera.id, type: "PAYMENT", name: "Smoke relocation", amount: "50000" });
    const r = await line(ramesh.id), m = await line(meera.id);
    check("Payments are added and the run recalculated", a1.ok === true && Number(r.grossEarnings) === 100000, `${a1.message} ${r.grossEarnings}`);
    check("Taxable payments carry the extra income tax for the year", Number(r.tds) >= 30000 && Math.abs(Number(r.netPay) - (100000 - Number(r.tds) - 1000)) < 1, `tds ${r.tds} net ${r.netPay}`);
    check("No PF, ESI or PT is taken", Number(r.pfEmployee) === 0 && Number(r.esiEmployee) === 0 && Number(r.professionalTax) === 0);
    check("A non-taxable payment carries no tax", Number(m.tds) === 0 && Number(m.netPay) === 50000, `${m.tds} ${m.netPay}`);
    if (pli) {
      const inc = await act.toggleOffCycleBonusAction({}, fd({ runId, bonusId: pli.id, include: "1" }));
      check("A scheduled bonus can be paid in it", inc.ok === true && Number((await line(meera.id)).grossEarnings) === 50000 + Number(pli.amount), inc.message);
      const out = await act.toggleOffCycleBonusAction({}, fd({ runId, bonusId: pli.id, include: "0" }));
      check("…and sent back to the schedule", out.ok === true && Number((await line(meera.id)).grossEarnings) === 50000 && (await prisma.employeeBonus.findUniqueOrThrow({ where: { id: pli.id } })).runId === null, out.message);
    }

    section("Finalising");
    const fin = await act.finalizeOffCycleAction({}, fd({ runId }));
    const done = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    const slips = await prisma.payslip.count({ where: { runId } });
    check("Finalising generates a payslip per person", fin.ok === true && done.status === "FINALIZED" && slips === 2, fin.message);
    check("…and marks the items paid", (await prisma.adhocTransaction.count({ where: { runId, isProcessed: false } })) === 0);
    const again = await act.addOffCycleItemAction({}, fd({ runId, employeeId: meera.id, type: "PAYMENT", name: "Late", amount: "1", taxable: "on" }));
    check("A finalised off-cycle payroll cannot be changed", again.ok === false, again.message);
    const rel = await act.releaseOffCycleAction({}, fd({ runId }));
    check("Payslips can be released", rel.ok === true && (await prisma.payslip.count({ where: { runId, status: "RELEASED" } })) === 2, rel.message);

    section("Rolling back");
    const rb = await act.rollbackOffCycleAction({}, fd({ runId, reason: "Smoke test" }));
    check("Rolling back removes payslips and releases the items", rb.ok === true && (await prisma.payslip.count({ where: { runId } })) === 0 && (await prisma.adhocTransaction.count({ where: { runId, isProcessed: true } })) === 0, rb.message);
  } finally {
    const runs = await created();
    const ids = runs.map((r) => r.id);
    if (pli) await prisma.employeeBonus.update({ where: { id: pli.id }, data: { runId: null, isProcessed: false, payAction: "PAY" } });
    await prisma.adhocTransaction.deleteMany({ where: { runId: { in: ids } } });
    // Postings and their reversals, so the books are as they were.
    const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefId: { in: ids } }, select: { id: true, reversedById: true } });
    const entryIds = [...entries.map((e) => e.id), ...entries.map((e) => e.reversedById).filter((x): x is string => !!x)];
    await prisma.ledgerEntry.updateMany({ where: { id: { in: entryIds } }, data: { reversedById: null } });
    await prisma.ledgerEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, entityType: "PayrollRun", entityId: { in: ids } } });
  }
  report("Off-cycle payroll");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
