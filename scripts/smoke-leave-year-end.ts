/**
 * Leave year-end: a dry run changes nothing; closing carries forward up to
 * the cap, pays the next share through payroll and lapses the rest; a
 * deficit is carried, not written off; a second run closes nothing; carried
 * days expire after the type's window, net of leave already taken from them.
 *
 * Uses its own leave type (code SMKYE), removed at the end with everything on it.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const svc = await import("@keka/services");
  const act = await import("../apps/web/src/app/actions/time");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "meera.krishnan@acme.test" } });
  const other = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, status: { in: ["CONFIRMED", "PROBATION"] }, id: { not: meera.id } } });
  await prisma.leaveType.deleteMany({ where: { tenantId: tenant.id, code: { in: ["SMKYE", "SMKRS"] } } });
  const type = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id, name: "Smoke Earned", code: "SMKYE", yearEndAction: "CARRY_FORWARD_THEN_PAY",
      carryForwardMax: 5, encashmentEnabled: true, encashmentMaxDaysPerYear: 3, encashmentFormula: "[BASIC] / 30", carryForwardExpiryDays: 200,
    },
  });
  const reset = await prisma.leaveType.create({ data: { tenantId: tenant.id, name: "Smoke Casual", code: "SMKRS", yearEndAction: "RESET" } });
  const old = utc(2025, 4, 1), ny = utc(2026, 4, 1);
  const entry = (employeeId: string, leaveTypeId: string, yearStart: Date, kind: "OPENING" | "USED", days: number, key: string) =>
    prisma.leaveLedgerEntry.create({ data: { tenantId: tenant.id, employeeId, leaveTypeId, yearStart, kind, days, periodKey: key } });
  const ledger = (employeeId: string, leaveTypeId: string, yearStart: Date) => prisma.leaveLedgerEntry.findMany({ where: { employeeId, leaveTypeId, yearStart } });
  const total = async (employeeId: string, leaveTypeId: string, yearStart: Date) => Math.round((await ledger(employeeId, leaveTypeId, yearStart)).reduce((s, e) => s + Number(e.days), 0) * 100) / 100;

  console.log("\nLeave year-end\n" + "=".repeat(72));
  try {
    await entry(meera.id, type.id, old, "OPENING", 10, "SMK:OPEN");
    await entry(meera.id, type.id, old, "USED", -1.5, "SMK:USED");
    await entry(other.id, reset.id, old, "OPENING", 2, "SMK:OPEN");
    await entry(other.id, reset.id, old, "USED", -4, "SMK:USED");

    section("Preview");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot run year-end", await denied(() => act.runLeaveYearEndAction({}, fd({}))));
    const preview = await svc.runLeaveYearEnd({ tenantId: tenant.id, today: utc(2026, 10, 1), apply: false });
    const row = preview.rows.find((r) => r.employeeId === meera.id && r.leaveTypeId === type.id);
    check("The preview splits unused days by the type's rule: carry 5, pay 3, lapse 0.5", row?.available === 8.5 && row.carry === 5 && row.pay === 3 && row.lapse === 0.5, JSON.stringify(row));
    check("…prices the payout from salary", (row?.amount ?? 0) > 0, `${row?.amount}`);
    check("…and changes nothing", (await total(meera.id, type.id, old)) === 8.5 && (await ledger(meera.id, type.id, ny)).length === 0);

    section("Closing the year");
    const runAt = utc(2026, 10, 1);
    const r = await svc.runLeaveYearEnd({ tenantId: tenant.id, today: runAt, apply: true });
    check("The ended year is closed to zero", r.closed >= 2 && (await total(meera.id, type.id, old)) === 0);
    const inNew = (await ledger(meera.id, type.id, ny)).find((e) => e.kind === "CARRY_FORWARD");
    check("Carried days land in the new year, expiring after the window", Number(inNew?.days) === 5 && inNew?.expiresOn?.toISOString().slice(0, 10) === "2026-10-18", JSON.stringify(inNew));
    const pay = await prisma.adhocTransaction.findFirst({ where: { employeeId: meera.id, sourceType: "LeaveYearEnd" } });
    check("The paid share becomes a taxable payroll payment", !!pay && Number(pay.amount) === row?.amount && pay.taxTreatment === "TAXABLE" && pay.componentCode === "LEAVE_ENCASH", JSON.stringify(pay));
    const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_yearStart: { employeeId: meera.id, leaveTypeId: type.id, yearStart: ny } } });
    check("The new year's balance shows the carried days", Number(bal?.available) === 5 && Number(bal?.carriedForward) === 5);
    check("A deficit is carried into the next year, not written off", (await total(other.id, reset.id, old)) === 0 && (await total(other.id, reset.id, ny)) === -2);
    const again = await svc.runLeaveYearEnd({ tenantId: tenant.id, today: runAt, apply: true });
    check("Running again closes nothing and pays nothing twice", !again.rows.some((x) => x.leaveTypeId === type.id || x.leaveTypeId === reset.id) && (await prisma.adhocTransaction.count({ where: { employeeId: meera.id, sourceType: "LeaveYearEnd" } })) === 1);

    section("Expiring carried days");
    await entry(meera.id, type.id, ny, "USED", -2, "SMK:USED-NEW");
    const early = await svc.runLeaveYearEnd({ tenantId: tenant.id, today: utc(2026, 10, 17), apply: true });
    check("Nothing expires before the window ends", (await total(meera.id, type.id, ny)) === 3 && early.expired === 0);
    await svc.runLeaveYearEnd({ tenantId: tenant.id, today: utc(2026, 10, 18), apply: true });
    const lapse = (await ledger(meera.id, type.id, ny)).find((e) => e.kind === "LAPSE");
    check("On expiry, only the carried days not yet taken lapse (5 − 2 = 3)", Number(lapse?.days) === -3 && (await total(meera.id, type.id, ny)) === 0, JSON.stringify(lapse));
    await svc.runLeaveYearEnd({ tenantId: tenant.id, today: utc(2026, 10, 19), apply: true });
    check("An expired carry-forward lapses once", (await ledger(meera.id, type.id, ny)).filter((e) => e.kind === "LAPSE").length === 1);

    section("From the screen");
    await signInAs("vikram.menon@acme.test");
    const screen = await act.runLeaveYearEndAction({}, fd({}));
    check("HR can run it on demand; with nothing left it says so", screen.ok === true, screen.message);
  } finally {
    await prisma.adhocTransaction.deleteMany({ where: { sourceType: "LeaveYearEnd", employeeId: { in: [meera.id, other.id] }, name: { startsWith: "Smoke " } } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { leaveTypeId: { in: [type.id, reset.id] } } });
    await prisma.leaveBalance.deleteMany({ where: { leaveTypeId: { in: [type.id, reset.id] } } });
    await prisma.leaveType.deleteMany({ where: { id: { in: [type.id, reset.id] } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, entityType: "LeaveYearEnd", createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
  }
  report("Leave year-end");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
