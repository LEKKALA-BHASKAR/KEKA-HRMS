/**
 * Perks, through the actions: setting one up (fixed, per employee, formula),
 * code clashes and bad formulas refused; giving one to an employee from a
 * date and refusing a second open one; the perk's value reaching the payslip
 * as a non-cash line that raises TDS but not gross pay; the employer bearing
 * the tax; and a perk in use being switched off rather than deleted.
 *
 * Perks use codes starting SMKPERK, and runs December 2026 for Meera's pay
 * group (refusing to start if one exists); all removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/perks");
  const { createRun, calculateRun } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const ramesh = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "ramesh.iyer@acme.test" } } });
  const runWhere = { tenantId: tenant.id, payGroupId: ramesh.payGroupId!, year: 2026, month: 12 };
  if (await prisma.payrollRun.count({ where: runWhere })) throw new Error("A payroll run already exists for December 2026.");
  const since = new Date();
  const perkByCode = (code: string) => prisma.perk.findFirst({ where: { component: { tenantId: tenant.id, code } }, include: { component: true } });
  const line = async () => {
    await prisma.payrollRun.deleteMany({ where: runWhere });
    const id = await createRun({ tenantId: tenant.id, payGroupId: ramesh.payGroupId!, year: 2026, month: 12 });
    await calculateRun(id);
    const re = await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: id, employeeId: ramesh.id } }, include: { lines: true } });
    return { gross: Number(re.grossEarnings), tds: Number(re.tds), perk: re.lines.find((l) => l.code.startsWith("SMKPERK")) };
  };

  console.log("\nPerks\n" + "=".repeat(72));
  try {
    section("Setting up");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot set up perks", await denied(() => act.savePerkAction({}, fd({}))));
    await signInAs("ramesh.iyer@acme.test");
    const save = (f: Record<string, string>) => act.savePerkAction({}, fd({ category: "Vehicle", isTaxable: "on", ...f }));
    const car = await save({ name: "Smoke car", code: "SMKPERK_CAR", valuationMethod: "FIXED_FOR_ALL", fixedAmount: "2400" });
    check("A fixed-value perk is set up as a PERK component", car.ok === true && (await perkByCode("SMKPERK_CAR"))?.component.type === "PERK", car.message);
    const noValue = await save({ name: "Smoke x", code: "SMKPERK_X", valuationMethod: "FIXED_FOR_ALL" });
    check("A fixed perk needs its value", noValue.ok === false && !!noValue.errors?.fixedAmount);
    const badFormula = await save({ name: "Smoke club", code: "SMKPERK_CLUB", valuationMethod: "FORMULA", formula: "[BASIC] * (" });
    check("A formula that cannot be read is refused", badFormula.ok === false && !!badFormula.errors?.formula, badFormula.message);
    const clash = await save({ name: "Smoke basic", code: "BASIC", valuationMethod: "FIXED_FOR_ALL", fixedAmount: "1" });
    check("A code already used by another component is refused", clash.ok === false && !!clash.errors?.code, clash.message);
    const per = await save({ name: "Smoke house", code: "SMKPERK_HOUSE", category: "Housing", valuationMethod: "PER_EMPLOYEE" });
    check("A per-employee perk needs no value up front", per.ok === true, per.message);

    section("Giving a perk");
    const carPerk = (await perkByCode("SMKPERK_CAR"))!, house = (await perkByCode("SMKPERK_HOUSE"))!;
    const before = await line();
    const give = await act.assignPerkAction({}, fd({ employeeId: ramesh.id, perkId: carPerk.id, startDate: "2026-11-01" }));
    check("A perk is given from a date", give.ok === true, give.message);
    const twice = await act.assignPerkAction({}, fd({ employeeId: ramesh.id, perkId: carPerk.id, startDate: "2026-12-01" }));
    check("A second open one of the same perk is refused", twice.ok === false && /already has/.test(twice.message ?? ""), twice.message);
    const noAmt = await act.assignPerkAction({}, fd({ employeeId: ramesh.id, perkId: house.id, startDate: "2026-11-01" }));
    check("A per-employee perk needs a monthly value", noAmt.ok === false && !!noAmt.errors?.monthlyValue, noAmt.message);

    section("Payroll");
    const after = await line();
    check("The perk shows on the payslip as a non-cash line", after.perk?.type === "PERK" && Number(after.perk.amount) === 2400, JSON.stringify(after.perk));
    check("…without changing gross pay", Math.abs(after.gross - before.gross) < 1, `${before.gross} → ${after.gross}`);
    check("…but raising TDS", after.tds > before.tds, `${before.tds} → ${after.tds}`);
    await save({ id: carPerk.id, name: "Smoke car", code: "SMKPERK_CAR", valuationMethod: "FIXED_FOR_ALL", fixedAmount: "2400", taxBorneByEmployer: "on" });
    const borne = await line();
    check("When the employer bears the tax, TDS is as before", Math.abs(borne.tds - before.tds) < 1 && !!borne.perk, `${before.tds} → ${borne.tds}`);
    const a = await prisma.employeePerk.findFirstOrThrow({ where: { employeeId: ramesh.id, perkId: carPerk.id } });
    const ended = await act.endPerkAction({}, fd({ id: a.id, endDate: "2026-11-30" }));
    const gone = await line();
    check("An ended perk drops out of later months", ended.ok === true && !gone.perk, ended.message);

    section("Removing");
    const del = await act.deletePerkAction({}, fd({ id: carPerk.id }));
    check("A perk that was given is switched off, not deleted", del.ok === true && (await perkByCode("SMKPERK_CAR"))?.component.isActive === false, del.message);
    const del2 = await act.deletePerkAction({}, fd({ id: house.id }));
    check("An unused perk is deleted", del2.ok === true && !(await perkByCode("SMKPERK_HOUSE")), del2.message);
  } finally {
    await prisma.payrollRun.deleteMany({ where: runWhere });
    await prisma.salaryComponent.deleteMany({ where: { tenantId: tenant.id, code: { startsWith: "SMKPERK" } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: { in: ["Perk", "EmployeePerk"] } } });
  }
  report("Perks");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
