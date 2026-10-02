/**
 * Bonuses and reimbursement claims as payroll inputs, through the actions:
 * bonus types; scheduling a bonus (and refusing a finalised month); deciding
 * bonuses in step 3 of a run (pay, part-pay, hold, carry a held bonus into
 * the next run); deciding claims in step 4 (approve, pay less, reject); and
 * the CSV import of bonuses. Each decision recalculates the run.
 *
 * Uses payroll periods January, February and May 2027 (refusing to run if
 * a run already exists for them) and a bonus type named "Smoke Bonus", all
 * removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const Y = 2027;
const MONTHS = [1, 2, 5];
const TYPE = "Smoke Bonus";

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/bonuses");
  const imp = await import("../apps/web/src/app/actions/import");
  const { createRun, calculateRun } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } } });
  const payGroupId = meera.payGroupId!;
  const since = new Date();
  const fuel = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "FUEL_REIMB" } });
  const cleanRuns = () => prisma.payrollRun.deleteMany({ where: { tenantId: tenant.id, payGroupId, year: Y, month: { in: MONTHS } } });
  if (await prisma.payrollRun.count({ where: { tenantId: tenant.id, payGroupId, year: Y, month: { in: MONTHS } } })) {
    throw new Error(`A payroll run already exists for ${MONTHS.join("/")}-${Y}; this test needs those months free.`);
  }
  const gross = async (runId: string) => Number((await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: meera.id } } })).grossEarnings);
  const bonusesOf = () => prisma.employeeBonus.findMany({ where: { bonusType: { tenantId: tenant.id, name: TYPE } }, orderBy: { amount: "desc" } });
  let claimId = "";

  console.log("\nBonuses and claims\n" + "=".repeat(72));
  try {
    section("Bonus types");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot add a bonus type", await denied(() => act.saveBonusTypeAction({}, fd({ name: TYPE, isTaxable: "on" }))));
    check("…or schedule a bonus", await denied(() => act.scheduleBonusAction({}, fd({}))));
    await signInAs("ramesh.iyer@acme.test");
    const made = await act.saveBonusTypeAction({}, fd({ name: TYPE, isTaxable: "on" }));
    const type = await prisma.bonusType.findFirst({ where: { tenantId: tenant.id, name: TYPE } });
    check("Payroll adds a bonus type", made.ok === true && !!type?.isActive && type.isTaxable, made.message);
    const dup = await act.saveBonusTypeAction({}, fd({ name: TYPE.toUpperCase() }));
    check("Two types cannot share a name", dup.ok === false && !!dup.errors?.name, dup.message);

    section("Scheduling");
    const sched = (amount: string, payout: string, note = "") => act.scheduleBonusAction({}, fd({ employeeId: meera.id, bonusTypeId: type!.id, amount, payout, note }));
    const r1 = await sched("10000", `${Y}-01`), r2 = await sched("8000", `${Y}-01`), r3 = await sched("6000", `${Y}-01`);
    check("Bonuses are scheduled for a month", r1.ok && r2.ok && r3.ok && (await bonusesOf()).length === 3, r1.message);
    const fin = await prisma.payrollRun.create({ data: { tenantId: tenant.id, payGroupId, year: Y, month: 5, periodStart: new Date(Date.UTC(Y, 4, 1)), periodEnd: new Date(Date.UTC(Y, 4, 31)), status: "FINALIZED" } });
    const late = await sched("5000", `${Y}-05`);
    check("A month whose payroll is finalised is refused", late.ok === false && /finalised/.test(late.message ?? ""), late.message);
    await prisma.payrollRun.delete({ where: { id: fin.id } });

    section("Step 3: deciding bonuses");
    const jan = await createRun({ tenantId: tenant.id, payGroupId, year: Y, month: 1 });
    await calculateRun(jan);
    const g0 = await gross(jan);
    const [b10, b8, b6] = await bonusesOf();
    const decide = (runId: string, bonusId: string, action: string, paidAmount = "") => act.decideBonusAction({}, fd({ runId, bonusId, action, paidAmount }));
    const hold = await decide(jan, b8.id, "ON_HOLD");
    const g1 = await gross(jan);
    check("Holding a bonus takes it out of this run", hold.ok === true && Math.abs(g0 - g1 - 8000) < 1, `${hold.message} ${g0}→${g1}`);
    const tooMuch = await decide(jan, b6.id, "PARTIALLY_PAY", "6000");
    check("A part payment must be less than the bonus", tooMuch.ok === false, tooMuch.message);
    const part = await decide(jan, b6.id, "PARTIALLY_PAY", "2000");
    const g2 = await gross(jan);
    check("Part-paying pays only that amount", part.ok === true && Math.abs(g1 - g2 - 4000) < 1, `${part.message} ${g1}→${g2}`);
    const voided = await decide(jan, b10.id, "VOID");
    check("Voiding removes it from the run", voided.ok === true && Math.abs(g2 - (await gross(jan)) - 10000) < 1);
    await decide(jan, b10.id, "PAY");
    check("…and paying again puts it back", Math.abs((await gross(jan)) - g2) < 1);

    const feb = await createRun({ tenantId: tenant.id, payGroupId, year: Y, month: 2 });
    await calculateRun(feb);
    const fg0 = await gross(feb);
    const bringIn = await decide(feb, b8.id, "PAY");
    const moved = await prisma.employeeBonus.findUniqueOrThrow({ where: { id: b8.id } });
    check("A held bonus can be paid in a later run", bringIn.ok === true && moved.payoutMonth === 2 && Math.abs((await gross(feb)) - fg0 - 8000) < 1, bringIn.message);
    const early = await decide(jan, b8.id, "PAY");
    check("…and is then no longer in the earlier one", early.ok === false, early.message);

    section("Step 4: deciding claims");
    claimId = (await prisma.componentClaim.create({ data: { employeeId: meera.id, componentId: fuel.id, fyStartYear: Y - 1, claimedAmount: 3000, status: "SUBMITTED", comment: "Smoke claim" } })).id;
    const claim = (decision: string, extra: Record<string, string> = {}) => act.decideClaimAction({}, fd({ runId: jan, claimId, decision, ...extra }));
    const noWhy = await claim("reject");
    check("Rejecting a claim needs a reason", noWhy.ok === false, noWhy.message);
    const lessNoWhy = await claim("approve", { payableAmount: "2500" });
    check("Paying less than claimed needs a reason", lessNoWhy.ok === false, lessNoWhy.message);
    const over = await claim("approve", { payableAmount: "3500" });
    check("Nothing above the claimed amount is paid", over.ok === false, over.message);
    const cg0 = await gross(jan);
    const ok = await claim("approve", { payableAmount: "2500", note: "One bill was for a family car" });
    const c = await prisma.componentClaim.findUniqueOrThrow({ where: { id: claimId } });
    check("An approved claim is paid in this run for the accepted amount", ok.ok === true && c.status === "APPROVED" && Number(c.payableAmount) === 2500 && c.payoutMonth === 1 && c.payoutYear === Y, ok.message);
    check("…and the run is recalculated", (await gross(jan)) > cg0, `${cg0}→${await gross(jan)}`);
    const n = await prisma.notification.count({ where: { userId: meera.userId!, createdAt: { gte: since }, kind: "PAYROLL" } });
    check("The employee is told", n >= 1);

    section("Import");
    const bad = await imp.runImportAction({}, fd({ kind: "bonuses", mode: "check", file: `Employee number,Bonus type,Amount,Payout month\n${meera.employeeNumber},Nope,abc,13/2031` }));
    check("Bad bonus rows are reported", bad.ok === false && /bonus type/.test(bad.rowErrors?.[0]?.message ?? "") && /Amount/.test(bad.rowErrors?.[0]?.message ?? "") && /Payout month/.test(bad.rowErrors?.[0]?.message ?? ""), JSON.stringify(bad.rowErrors));
    const good = await imp.runImportAction({}, fd({ kind: "bonuses", mode: "import", file: `Employee number,Bonus type,Amount,Payout month,Note\n${meera.employeeNumber},${TYPE},"1,500",${Y}-4,Imported` }));
    const importedB = (await bonusesOf()).find((b) => b.note === "Imported");
    check("A bonus file imports through the same rules", good.ok === true && Number(importedB?.amount) === 1500 && importedB?.payoutMonth === 4, `${good.message} ${JSON.stringify(good.rowErrors)}`);

    section("Types in use");
    const del = await act.deleteBonusTypeAction({}, fd({ id: type!.id }));
    check("A type with bonuses is switched off, not deleted", del.ok === true && (await prisma.bonusType.findUniqueOrThrow({ where: { id: type!.id } })).isActive === false, del.message);
  } finally {
    await cleanRuns();
    if (claimId) await prisma.componentClaim.deleteMany({ where: { id: claimId } });
    await prisma.employeeBonus.deleteMany({ where: { bonusType: { tenantId: tenant.id, name: TYPE } } });
    await prisma.bonusType.deleteMany({ where: { tenantId: tenant.id, name: TYPE } });
    await prisma.notification.deleteMany({ where: { userId: meera.userId!, createdAt: { gte: since }, kind: "PAYROLL" } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: { in: ["BonusType", "EmployeeBonus", "ComponentClaim", "BulkImport"] } } });
  }
  report("Bonuses and claims");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
