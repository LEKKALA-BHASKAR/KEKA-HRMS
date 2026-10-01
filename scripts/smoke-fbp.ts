/**
 * Flexible benefit plan, through the actions: who can declare (only people on
 * a plan structure); caps per component; the declaration locking on submit
 * and payroll reopening it; claims then limited to what was declared; the
 * declared amount carved out of Special Allowance in every payroll run; and
 * whatever is unclaimed paid as taxable salary in March.
 *
 * Ramesh (on Class A) declares; his structure is marked part of the plan for
 * the test and restored after. Uses payroll runs for December 2026 and March
 * 2027 (refusing to run if either exists), removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PERIODS = [{ year: 2026, month: 12 }, { year: 2027, month: 3 }];

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/fbp");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const byEmail = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } } });
  const ramesh = await byEmail("ramesh.iyer@acme.test");
  const meera = await byEmail("meera.krishnan@acme.test");
  const rev = await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: ramesh.id, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, include: { structure: true } });
  const structure = rev.structure!;
  const wasFbp = structure.isPartOfFbp;
  const [fuel, phone] = await Promise.all(["FUEL_REIMB", "TELEPHONE_REIMB"].map((code) => prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code } })));
  const fy = 2026;
  const since = new Date();
  const runWhere = { tenantId: tenant.id, payGroupId: ramesh.payGroupId!, OR: PERIODS };
  if (await prisma.payrollRun.count({ where: runWhere })) throw new Error("A payroll run already exists for December 2026 or March 2027.");
  if (await prisma.fbpDeclaration.count({ where: { employeeId: ramesh.id, fyStartYear: fy } })) throw new Error("Ramesh already has a declaration for FY 2026.");
  const save = (amounts: Record<string, string>) => act.saveFbpDeclarationAction({}, fd(Object.fromEntries(Object.entries(amounts).map(([k, v]) => [`amount:${k}`, v]))));
  const decl = () => prisma.fbpDeclaration.findUnique({ where: { employeeId_fyStartYear: { employeeId: ramesh.id, fyStartYear: fy } }, include: { lines: true } });

  console.log("\nFlexible benefit plan\n" + "=".repeat(72));
  try {
    await prisma.salaryStructure.update({ where: { id: structure.id }, data: { isPartOfFbp: true } });

    section("Who can declare");
    await signInAs("meera.krishnan@acme.test");
    const meeraPlan = await svc.fbpPlan(meera.id);
    const mine = await save({ [fuel.id]: "1000" });
    check("Someone not on a plan structure cannot declare", meeraPlan.eligible === false && mine.ok === false, `${meeraPlan.reason} / ${mine.message}`);
    check("An employee cannot reopen declarations", await denied(() => act.reopenFbpDeclarationAction({}, fd({ id: "x" }))));
    await signInAs("ramesh.iyer@acme.test");
    const plan = await svc.fbpPlan(ramesh.id);
    check("Someone on a plan structure sees their flexible amount and components", plan.eligible && plan.pool > 0 && plan.components.some((c) => c.id === fuel.id), `${plan.reason ?? ""} pool ${plan.pool}`);

    section("Declaring");
    const over = await save({ [fuel.id]: "30000" });
    check("A component above its cap is refused", over.ok === false && !!over.errors?.[`amount:${fuel.id}`], over.message);
    const none = await save({});
    check("An empty declaration is refused", none.ok === false, none.message);
    const ok = await save({ [fuel.id]: "24000", [phone.id]: "12000" });
    let d = await decl();
    check("A declaration within the caps is saved and locked", ok.ok === true && Number(d?.totalAmount) === 36000 && d?.isLocked === true && d.lines.length === 2, ok.message);
    const summary = await svc.componentClaimSummary(ramesh.id, fy, new Date("2026-10-15T00:00:00Z"));
    check("Claims are now limited to the declared components and amounts", summary.underFbp && summary.rows.length === 2 && summary.rows.find((r) => r.componentId === fuel.id)?.annual === 24000, JSON.stringify(summary.rows.map((r) => [r.name, r.annual])));
    const again = await save({ [fuel.id]: "18000" });
    check("A locked declaration cannot be changed", again.ok === false && /locked/i.test(again.message ?? ""), again.message);

    section("Reopening");
    await signInAs("vikram.menon@acme.test");
    const reopened = await act.reopenFbpDeclarationAction({}, fd({ id: d!.id }));
    check("Payroll can reopen it", reopened.ok === true && (await decl())?.isLocked === false, reopened.message);
    await signInAs("ramesh.iyer@acme.test");
    const changed = await save({ [fuel.id]: "18000" });
    d = await decl();
    check("…and the employee can then change it, locking it again", changed.ok === true && Number(d?.totalAmount) === 18000 && d?.lines.length === 1 && d.isLocked, changed.message);

    section("Payroll");
    const gross = async (year: number, month: number) => {
      const id = await svc.createRun({ tenantId: tenant.id, payGroupId: ramesh.payGroupId!, year, month });
      await svc.calculateRun(id);
      return Number((await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: id, employeeId: ramesh.id } } })).grossEarnings);
    };
    const decWith = await gross(2026, 12), marWith = await gross(2027, 3);
    const saved = d!;
    await prisma.fbpDeclaration.delete({ where: { id: saved.id } });
    await prisma.payrollRun.deleteMany({ where: runWhere });
    const decWithout = await gross(2026, 12), marWithout = await gross(2027, 3);
    check("The declared amount is set aside from each month's salary", Math.abs(decWithout - decWith - 1500) < 1, `${decWithout} → ${decWith}`);
    check("In March what is unclaimed is paid out as salary", Math.abs(marWith - marWithout - (18000 - 1500)) < 1, `${marWithout} → ${marWith}`);
  } finally {
    await prisma.payrollRun.deleteMany({ where: runWhere });
    await prisma.fbpDeclaration.deleteMany({ where: { employeeId: ramesh.id, fyStartYear: fy } });
    await prisma.salaryStructure.update({ where: { id: structure.id }, data: { isPartOfFbp: wasFbp } });
    await prisma.notification.deleteMany({ where: { userId: ramesh.userId!, createdAt: { gte: since } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, entityType: "FbpDeclaration", createdAt: { gte: since } } });
  }
  report("Flexible benefit plan");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
