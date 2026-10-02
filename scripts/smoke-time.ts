/**
 * Leave and attendance, end to end, into payroll.
 *
 * The seams checked here are the ones that cost money when wrong:
 *   - unpaid leave reaching payroll as LOP, exactly once
 *   - an unexplained absence reaching payroll as LOP
 *   - a regularisation removing the penalty it was raised for
 *   - the accrual job never double-crediting on a re-run
 *   - a cancelled leave returning its days
 */
import "./_test-bootstrap";
import { check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const TODAY = utc(2026, 9, 28);

async function main() {
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const payGroup = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const byNumber = async (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const type = async (code: string) => prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, code } });
  const yearStart = utc(2026, 4, 1);
  const bal = async (employeeId: string, leaveTypeId: string) =>
    Number((await prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_yearStart: { employeeId, leaveTypeId, yearStart } },
    }))?.available ?? 0);

  console.log("\nLeave & attendance into payroll\n" + "=".repeat(72));

  // -----------------------------------------------------------------
  section("Balances are ledger-backed");

  const meera = await byNumber("ACM0009");
  const el = await type("EL");
  const ledger = await prisma.leaveLedgerEntry.findMany({ where: { employeeId: meera.id, leaveTypeId: el.id } });
  const sum = ledger.reduce((s, e) => s + Number(e.days), 0);
  check("Meera's EL balance equals the sum of her ledger", Math.abs(sum - await bal(meera.id, el.id)) < 0.001,
    `ledger ${sum}, balance ${await bal(meera.id, el.id)}`);
  check("Six monthly accruals of 1.5 were credited", ledger.filter((e) => e.kind === "ACCRUAL").length === 6,
    `${ledger.filter((e) => e.kind === "ACCRUAL").length} accrual entries`);
  check("Her approved 5-day August leave was debited", ledger.some((e) => e.kind === "USED" && Number(e.days) === -5));
  check("Net: 9 accrued − 5 used = 4 available", await bal(meera.id, el.id) === 4, String(await bal(meera.id, el.id)));

  // -----------------------------------------------------------------
  section("The accrual job is idempotent");

  const before = await prisma.leaveLedgerEntry.count({ where: { tenantId: tenant.id, kind: "ACCRUAL" } });
  const rerun = await svc.runAccrual({ tenantId: tenant.id, year: 2026, month: 9 });
  const after = await prisma.leaveLedgerEntry.count({ where: { tenantId: tenant.id, kind: "ACCRUAL" } });
  check("Re-running September credits nothing new", after === before, `${before} → ${after}`);
  check("It reports the skipped duplicates", rerun.skippedAlreadyCredited > 0, `${rerun.skippedAlreadyCredited} skipped`);
  check("Balance unchanged after the re-run", await bal(meera.id, el.id) === 4);

  // -----------------------------------------------------------------
  section("Applying leave: validation through the service");

  const over = await svc.applyLeave({
    employeeId: meera.id, leaveTypeId: el.id,
    from: utc(2026, 10, 19), to: utc(2026, 10, 30), reason: "Too long", today: TODAY,
  });
  check("Asking for more than the balance is refused", !over.ok && over.issues.some((i) => /Not enough/.test(i.message)),
    over.issues.map((i) => i.message).join("; "));

  const overlap = await svc.applyLeave({
    employeeId: (await byNumber("ACM0007")).id, leaveTypeId: el.id,
    from: utc(2026, 10, 14), to: utc(2026, 10, 14), reason: "Overlap", today: TODAY,
  });
  check("Overlapping an existing pending request is refused",
    !overlap.ok && overlap.issues.some((i) => /already have leave/.test(i.message)),
    overlap.issues.map((i) => i.message).join("; "));

  const ok = await svc.applyLeave({
    employeeId: meera.id, leaveTypeId: el.id,
    from: utc(2026, 10, 7), to: utc(2026, 10, 8), reason: "Short break", today: TODAY,
  });
  check("A valid request is created as pending", ok.ok && !!ok.requestId, `${ok.totalDays} days`);

  const pendingBlocks = await svc.applyLeave({
    employeeId: meera.id, leaveTypeId: el.id,
    from: utc(2026, 10, 26), to: utc(2026, 10, 28), reason: "Would overdraw once the first is counted", today: TODAY,
  });
  check("Pending days count against the balance for the next request",
    !pendingBlocks.ok && pendingBlocks.issues.some((i) => /Available: 2/.test(i.message)),
    pendingBlocks.issues.map((i) => i.message).join("; "));

  const approve = await svc.decideLeave({ requestId: ok.requestId!, decision: "APPROVE" });
  check("Approved", approve.ok, approve.message);
  check("Balance debited on approval", await bal(meera.id, el.id) === 2, String(await bal(meera.id, el.id)));

  const cancel = await svc.cancelLeave({ requestId: ok.requestId! });
  check("Cancelling after approval succeeds", cancel.ok, cancel.message);
  check("…and returns the days", await bal(meera.id, el.id) === 4, String(await bal(meera.id, el.id)));
  const rev = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: ok.requestId!, kind: "REVERSAL" } });
  check("A REVERSAL entry explains the return", !!rev && Number(rev.days) === 2);

  // -----------------------------------------------------------------
  section("The sandwich rule via the service");

  const cl = await type("CL");
  const sneha = await byNumber("ACM0005");
  // Friday 9 Oct → Monday 12 Oct, with the seeded 'between' sandwich.
  const sw = await svc.previewLeave({
    employeeId: sneha.id, leaveTypeId: cl.id,
    from: utc(2026, 10, 9), to: utc(2026, 10, 12), reason: "Long weekend", today: TODAY,
  });
  check("Fri→Mon charges the weekend in between", sw.count.totalDays === 4 && sw.count.sandwichDays === 2,
    `${sw.count.leaveDays} leave + ${sw.count.sandwichDays} sandwich`);

  // -----------------------------------------------------------------
  section("Incident leave is a per-event entitlement");

  const ml = await type("ML");
  const aarti = await byNumber("ACM0011");
  const mlPreview = await svc.previewLeave({
    employeeId: aarti.id, leaveTypeId: ml.id,
    from: utc(2026, 11, 2), to: utc(2026, 11, 27), reason: "Maternity", today: TODAY,
  });
  check("Maternity leave is not blocked by an accrued balance of zero",
    !mlPreview.issues.some((i) => /Not enough/.test(i.message)),
    mlPreview.issues.map((i) => i.message).join("; ") || "no issues");
  const mlAccruals = await prisma.leaveLedgerEntry.count({ where: { leaveTypeId: ml.id, kind: "ACCRUAL" } });
  check("…and was never accrued to anyone", mlAccruals === 0, `${mlAccruals} accruals`);

  // -----------------------------------------------------------------
  section("Attendance: penalties and regularisation");

  const gaurav = await byNumber("ACM0027"); // seeded as habitually late
  const sepRecords = await prisma.attendanceRecord.findMany({
    where: { employeeId: gaurav.id, date: { gte: utc(2026, 9, 1), lte: utc(2026, 9, 25) } },
    orderBy: { date: "asc" },
  });
  const penalised = sepRecords.filter((r) => r.penaltyReason);
  check("A habitually late employee picked up penalties", penalised.length > 0,
    `${penalised.length} penalised day(s): ${penalised.map((r) => r.penaltyReason).slice(0, 1).join("")}`);
  check("Penalties began only after the monthly exemption",
    penalised.every((r) => /Late arrival [4-9]|Late arrival \d\d|Missing punch [3-9]/.test(r.penaltyReason ?? "")),
    penalised.map((r) => r.penaltyReason).join(" | ").slice(0, 120));

  // Regularise one penalised day and confirm the penalty is removed.
  if (penalised.length > 0) {
    const target = penalised[penalised.length - 1];
    const lopBefore = Number(target.lopValue);
    const reg = await svc.raiseAttendanceRequest({
      employeeId: gaurav.id, type: "REGULARISATION",
      from: target.date, to: target.date, reason: "Client call ran from home", today: TODAY,
    });
    check("Regularisation raised", reg.ok, reg.message);
    const dec = await svc.decideAttendanceRequest({ requestId: reg.requestId!, decision: "APPROVE" });
    check("…and approved", dec.ok, dec.message);
    const fixed = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: gaurav.id, date: target.date } },
    });
    check("The regularised day now carries no LOP", Number(fixed.lopValue) === 0,
      `${lopBefore} → ${Number(fixed.lopValue)}`);
    check("…and is marked as regularised", fixed.isRegularised === true);

    // Leave the data as the seed made it, so the suite is re-runnable.
    await prisma.attendanceRequest.delete({ where: { id: reg.requestId! } });
    await svc.reprocessRange(gaurav.id, target.date, target.date);
  }

  const future = await svc.raiseAttendanceRequest({
    employeeId: gaurav.id, type: "REGULARISATION",
    from: utc(2026, 10, 30), to: utc(2026, 10, 30), reason: "Pre-emptive", today: TODAY,
  });
  check("A regularisation for a future day is refused", !future.ok, future.message);

  // -----------------------------------------------------------------
  section("Clock-in and clock-out");

  const ananya = await byNumber("ACM0007");
  await prisma.attendanceLog.deleteMany({
    where: { employeeId: ananya.id, timestamp: { gte: new Date(Date.UTC(2026, 8, 27, 18, 30)), lt: new Date(Date.UTC(2026, 8, 28, 18, 30)) } },
  });
  const inRes = await svc.recordPunch({ employeeId: ananya.id, direction: 0, at: new Date(Date.UTC(2026, 8, 28, 3, 55)) });
  check("Clock in", inRes.ok, inRes.message);
  const dup = await svc.recordPunch({ employeeId: ananya.id, direction: 0, at: new Date(Date.UTC(2026, 8, 28, 3, 55, 20)) });
  check("A double-click is not a second punch", !dup.ok, dup.message);
  const outRes = await svc.recordPunch({ employeeId: ananya.id, direction: 1, at: new Date(Date.UTC(2026, 8, 28, 13, 10)) });
  check("Clock out", outRes.ok, outRes.message);
  const todayRec = await prisma.attendanceRecord.findUnique({
    where: { employeeId_date: { employeeId: ananya.id, date: TODAY } },
  });
  check("Today's record was computed from the punches", todayRec?.status === "PRESENT",
    `${todayRec?.status}, ${todayRec?.effectiveHours}h`);

  // An out-of-order device upload of the same punch is still de-duplicated.
  const replay = await svc.recordPunch({
    employeeId: ananya.id, direction: 0, at: new Date(Date.UTC(2026, 8, 28, 3, 55, 30)), source: "BIOMETRIC",
  });
  check("A replayed device punch, uploaded after later punches, is still a duplicate", !replay.ok, replay.message);

  // -----------------------------------------------------------------
  section("August payroll: LOP arrives exactly once");

  const deepak = await byNumber("ACM0019"); // 3 days unpaid leave in August
  const augLeaveRecords = await prisma.attendanceRecord.findMany({
    where: { employeeId: deepak.id, date: { gte: utc(2026, 8, 24), lte: utc(2026, 8, 26) } },
  });
  check("His unpaid-leave days carry no attendance LOP",
    augLeaveRecords.length === 3 && augLeaveRecords.every((r) => Number(r.lopValue) === 0 && r.status === "ON_LEAVE"),
    augLeaveRecords.map((r) => `${r.status}:${r.lopValue}`).join(", "));


  // The seed finalises August; check that run as it stands. Only when it is
  // missing do we stand up (and later remove) a run of our own.
  const seededAug = await prisma.payrollRun.findFirst({
    where: { payGroupId: payGroup.id, year: 2026, month: 8, status: "FINALIZED", rolledBackAt: null },
  });
  const runId = seededAug?.id ?? await svc.createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2026, month: 8 });
  if (!seededAug) await svc.calculateRun(runId);
  const line = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: deepak.id } },
  });
  // The run counts LOP inside its attendance window, which ends on the pay
  // group's cut-off day; leave after the cut-off belongs to the next run.
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId }, select: { attendanceFrom: true, attendanceTo: true } });
  const from = run.attendanceFrom ?? utc(2026, 8, 1), to = run.attendanceTo ?? utc(2026, 8, 31);
  const leaveInWindow = augLeaveRecords.filter((r) => r.date >= from && r.date <= to).length;
  const attendanceLop = Number((await prisma.attendanceRecord.aggregate({
    where: { employeeId: deepak.id, date: { gte: from, lte: to } },
    _sum: { lopValue: true },
  }))._sum.lopValue ?? 0);
  check("Payroll LOP = his unpaid-leave days in the window + his attendance LOP, no more",
    Number(line.lopDays) === leaveInWindow + attendanceLop,
    `payroll ${line.lopDays} = ${leaveInWindow} leave + ${attendanceLop} attendance (window ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)})`);
  check("Payable days fell accordingly", Number(line.payableDays) === 31 - Number(line.lopDays),
    `${line.payableDays} of 31`);

  const full = await prisma.payrollRunEmployee.findFirstOrThrow({
    where: { runId, lopDays: 0, employee: { employeeNumber: { in: ["ACM0001", "ACM0002"] } } },
  });
  check("An untracked leader carries no attendance LOP at all", Number(full.lopDays) === 0);

  const lines = await prisma.payrollRunEmployee.findMany({ where: { runId } });
  const g = lines.reduce((s, l) => s + Number(l.grossEarnings), 0);
  const dd = lines.reduce((s, l) => s + Number(l.totalDeductions), 0);
  const n = lines.reduce((s, l) => s + Number(l.netPay), 0);
  check("The August run still reconciles", Math.abs(g - dd - n) < 0.01);

  if (!seededAug) await prisma.payrollRun.delete({ where: { id: runId } });

  report("Leave & attendance");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
