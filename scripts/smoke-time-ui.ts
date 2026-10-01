/**
 * Leave and attendance through the server actions a browser calls, with the
 * real session → viewer → permission chain. Where smoke-time.ts proves the
 * engine and services, this proves who may do what: self-approval, approval
 * outside one's reports, applying on another's behalf, and the guards on
 * every admin form.
 *
 * Everything it creates it removes, so it can run against the seeded database
 * as often as you like.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

/** A Next `forbidden()` interrupt, as opposed to an ordinary error. */
async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;403/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  const t = await import("../apps/web/src/app/actions/time");
  const { recomputeBalance, processAttendance } = await import("@keka/services");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const byNo = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const meera = await byNo("ACM0009");   // reports to Ananya → Sneha
  const sneha = await byNo("ACM0005");
  const cl = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, code: "CL" } });

  // Two future working days with no holiday and no leave already on them.
  const holidays = new Set((await prisma.holiday.findMany({
    where: { calendar: { tenantId: tenant.id } }, select: { date: true },
  })).map((h) => iso(h.date)));
  const taken = new Set((await prisma.leaveRequestDay.findMany({
    where: { request: { employeeId: meera.id, status: { in: ["PENDING", "APPROVED"] } } }, select: { date: true },
  })).map((d) => iso(d.date)));
  const free: string[] = [];
  for (let d = new Date(Date.UTC(2026, 9, 12)); free.length < 2; d = new Date(d.getTime() + DAY)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(iso(d)) && !taken.has(iso(d))) free.push(iso(d));
  }
  const [dayA, dayB] = free;

  const created = { leave: [] as string[], attendance: [] as string[] };
  const yearStart = new Date(Date.UTC(2026, 3, 1));
  const balance = async () => Number((await prisma.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_yearStart: { employeeId: meera.id, leaveTypeId: cl.id, yearStart } },
  }))?.available ?? 0);

  console.log("\nLeave & attendance actions\n" + "=".repeat(72));

  try {
    // -----------------------------------------------------------------
    section("Applying");
    await signInAs("meera.krishnan@acme.test");
    const before = await balance();
    const countBefore = await prisma.leaveRequest.count({ where: { employeeId: meera.id } });

    const preview = await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayA, toDate: dayA, intent: "preview" }));
    check("Preview reports the count and the balance left", preview.ok === true && /1 day\(s\)/.test(preview.message ?? ""), preview.message);
    check("Preview creates nothing",
      (await prisma.leaveRequest.count({ where: { employeeId: meera.id } })) === countBefore);

    const onBehalf = await t.applyLeaveAction({}, fd({ employeeId: sneha.id, leaveTypeId: cl.id, fromDate: dayA, toDate: dayA }));
    check("An employee cannot apply on someone else's behalf", onBehalf.ok === false && /behalf/i.test(onBehalf.message ?? ""), onBehalf.message);

    const backwards = await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayB, toDate: dayA }));
    check("A range that ends before it starts is refused", backwards.ok === false, backwards.message);

    const applied = await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayA, toDate: dayA, reason: "Smoke test" }));
    const reqA = await prisma.leaveRequest.findFirst({ where: { employeeId: meera.id, fromDate: new Date(`${dayA}T00:00:00Z`), status: "PENDING" } });
    if (reqA) created.leave.push(reqA.id);
    check("Apply submits a pending request", applied.ok === true && !!reqA, applied.message);

    const dup = await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayA, toDate: dayA }));
    check("Overlapping an existing request is refused", dup.ok === false, dup.message);

    // -----------------------------------------------------------------
    section("Deciding");
    check("An employee without approval rights is stopped at the door",
      await denied(() => t.decideLeaveAction({}, fd({ requestId: reqA!.id, decision: "approve" }))));

    await signInAs("ramesh.iyer@acme.test");
    const outside = await t.decideLeaveAction({}, fd({ requestId: reqA!.id, decision: "approve" }));
    check("A manager cannot approve someone outside their reports", outside.ok === false && /outside/i.test(outside.message ?? ""), outside.message);

    await signInAs("sneha.reddy@acme.test");
    const noReason = await t.decideLeaveAction({}, fd({ requestId: reqA!.id, decision: "reject" }));
    check("Rejecting needs a reason", noReason.ok === false && !!noReason.errors?.note, noReason.message);

    const ok = await t.decideLeaveAction({}, fd({ requestId: reqA!.id, decision: "approve" }));
    const afterApprove = await balance();
    const used = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: reqA!.id, kind: "USED" } });
    check("The skip-level manager approves", ok.ok === true, ok.message);
    check("Approval debits the ledger by exactly one day", !!used && Number(used.days) === -1, `${used?.days}`);
    check("The balance cache follows the ledger", Math.abs(before - afterApprove - 1) < 1e-9, `${before} → ${afterApprove}`);

    const again = await t.decideLeaveAction({}, fd({ requestId: reqA!.id, decision: "approve" }));
    check("A decided request cannot be decided twice", again.ok === false, again.message);

    // Self-approval: Sneha applies, then tries to approve her own.
    const own = await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayB, toDate: dayB, reason: "Smoke test" }));
    const ownReq = await prisma.leaveRequest.findFirst({ where: { employeeId: sneha.id, fromDate: new Date(`${dayB}T00:00:00Z`), status: "PENDING" } });
    if (ownReq) created.leave.push(ownReq.id);
    const self = ownReq ? await t.decideLeaveAction({}, fd({ requestId: ownReq.id, decision: "approve" })) : { ok: true };
    check("Nobody approves their own leave", own.ok === true && self.ok === false, (self as { message?: string }).message);

    // -----------------------------------------------------------------
    section("Rejecting and cancelling");
    await signInAs("meera.krishnan@acme.test");
    await t.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: dayB, toDate: dayB, reason: "Smoke test" }));
    const reqB = await prisma.leaveRequest.findFirst({ where: { employeeId: meera.id, fromDate: new Date(`${dayB}T00:00:00Z`), status: "PENDING" } });
    if (reqB) created.leave.push(reqB.id);
    await signInAs("sneha.reddy@acme.test");
    const rej = await t.decideLeaveAction({}, fd({ requestId: reqB!.id, decision: "reject", note: "Release week" }));
    const rejLedger = await prisma.leaveLedgerEntry.count({ where: { requestId: reqB!.id } });
    check("Rejection with a reason succeeds and touches no balance", rej.ok === true && rejLedger === 0, rej.message);

    await signInAs("meera.krishnan@acme.test");
    const cancel = await t.cancelLeaveAction({}, fd({ requestId: reqA!.id }));
    const reversal = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: reqA!.id, kind: "REVERSAL" } });
    check("Cancelling future approved leave returns the day", cancel.ok === true && Number(reversal?.days) === 1, cancel.message);
    check("The balance is back where it started", Math.abs((await balance()) - before) < 1e-9);

    // -----------------------------------------------------------------
    section("Balance administration");
    check("An employee cannot adjust balances",
      await denied(() => t.adjustBalanceAction({}, fd({ employeeId: meera.id, leaveTypeId: cl.id, days: 5, note: "x" }))));
    await signInAs("priya.sharma@acme.test");
    const zero = await t.adjustBalanceAction({}, fd({ employeeId: meera.id, leaveTypeId: cl.id, days: 0, note: "nothing" }));
    check("A zero adjustment is refused", zero.ok === false, zero.message);
    const adj = await t.adjustBalanceAction({}, fd({ employeeId: meera.id, leaveTypeId: cl.id, days: 0.5, note: "Smoke test credit" }));
    check("HR can adjust with a recorded reason", adj.ok === true && Math.abs((await balance()) - before - 0.5) < 1e-9, adj.message);
    await t.adjustBalanceAction({}, fd({ employeeId: meera.id, leaveTypeId: cl.id, days: -0.5, note: "Smoke test reversal" }));

    const acc1 = await t.runAccrualAction({}, fd({ year: 2026, month: 9 }));
    const acc2 = await t.runAccrualAction({}, fd({ year: 2026, month: 9 }));
    check("Re-running an accrued month credits nothing", acc1.ok === true && /Nothing to do|already credited/i.test(acc2.message ?? ""), acc2.message);

    // -----------------------------------------------------------------
    section("Policy forms refuse what cannot work");
    const unpaidPaid = await t.saveLeaveType({}, fd({
      name: "Smoke Unpaid", code: "SMKU", category: "UNPAID", isPaid: true, accrualFrequency: "MONTHLY", yearEndAction: "RESET",
    }));
    check("An unpaid category marked paid is refused", unpaidPaid.ok === false, unpaidPaid.message);

    const newType = await t.saveLeaveType({}, fd({
      name: "Smoke Leave", code: "smk", category: "REGULAR", isPaid: true, accrualFrequency: "MONTHLY",
      annualQuota: 6, yearEndAction: "RESET", sandwichWeeklyOff: true, sandwichEdges: true, allowHalfDay: true,
    }));
    const smk = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code: "SMK" } });
    const sc = smk?.sandwichConfig as { weeklyOff?: { between?: boolean; before?: boolean } } | null;
    check("A leave type saves with its code upper-cased and sandwich rules", newType.ok === true && !!sc?.weeklyOff?.between && !!sc?.weeklyOff?.before, newType.message);
    if (smk) {
      const del = await t.deleteLeaveType({}, fd({ id: smk.id }));
      check("A leave type with no history deletes outright", del.ok === true && !(await prisma.leaveType.findUnique({ where: { id: smk.id } })), del.message);
    }

    const badShift = await t.saveShift({}, fd({ name: "Smoke", code: "SMK", startTime: "18:00", endTime: "09:00", breakMinutes: 30 }));
    check("A shift ending before it starts needs 'crosses midnight'", badShift.ok === false && !!badShift.errors?.endTime, badShift.message);
    const longBreak = await t.saveShift({}, fd({ name: "Smoke", code: "SMK", startTime: "09:00", endTime: "10:00", breakMinutes: 60 }));
    check("A break as long as the shift is refused", longBreak.ok === false, longBreak.message);

    const badPolicy = await t.saveAttendancePolicy({}, fd({
      name: "Smoke", fullDayThresholdPct: 50, halfDayThresholdPct: 60, graceMinutes: 10, lateExemptPerMonth: 2,
      latePenaltyDays: 0.5, missingPunchExemptPerMonth: 2, missingPunchPenaltyDays: 0.5, overtimeMinMinutes: 30, regularisationWindowDays: 30,
    }));
    check("A half-day threshold above the full-day one is refused", badPolicy.ok === false && !!badPolicy.errors?.halfDayThresholdPct, badPolicy.message);
    const badIp = await t.saveAttendancePolicy({}, fd({
      name: "Smoke", fullDayThresholdPct: 90, halfDayThresholdPct: 50, graceMinutes: 10, lateExemptPerMonth: 2,
      latePenaltyDays: 0.5, missingPunchExemptPerMonth: 2, missingPunchPenaltyDays: 0.5, overtimeMinMinutes: 30, regularisationWindowDays: 30,
      ipAllowList: "10.0.0.1, office-wifi",
    }));
    check("A non-IP entry in the allow-list is refused", badIp.ok === false && /office-wifi/.test(badIp.message ?? ""), badIp.message);

    const cal = await prisma.holidayCalendar.findFirstOrThrow({ where: { tenantId: tenant.id, year: 2026 } });
    const wrongYear = await t.addHoliday({}, fd({ calendarId: cal.id, name: "Smoke", date: "2027-01-05" }));
    check("A holiday outside the calendar's year is refused", wrongYear.ok === false && !!wrongYear.errors?.date, wrongYear.message);

    const tooLong = await t.processAttendanceAction({}, fd({ fromDate: "2026-06-01", toDate: "2026-09-28" }));
    check("Processing more than two months at once is refused", tooLong.ok === false, tooLong.message);

    // -----------------------------------------------------------------
    section("Clocking in");
    await signInAs("meera.krishnan@acme.test");
    const since = new Date(Date.now() - 5_000);
    const clockIn = await t.clockAction({}, fd({ direction: "in" }));
    const doubleIn = await t.clockAction({}, fd({ direction: "in" }));
    const clockOut = await t.clockAction({}, fd({ direction: "out" }));
    const punches = await prisma.attendanceLog.findMany({ where: { employeeId: meera.id, createdAt: { gte: since }, source: "WEB" } });
    check("Clock-in records a web punch", clockIn.ok === true, clockIn.message);
    check("A double-click is recorded once", doubleIn.ok === false && /already/i.test(doubleIn.message ?? ""), doubleIn.message);
    check("Clock-out records the matching punch", clockOut.ok === true && punches.length === 2, `${punches.length} punches`);
    await prisma.attendanceLog.deleteMany({ where: { id: { in: punches.map((p) => p.id) } } });

    // -----------------------------------------------------------------
    section("Attendance requests");
    // The most recent past weekday.
    let past = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - DAY);
    while ([0, 6].includes(past.getUTCDay()) || holidays.has(iso(past))) past = new Date(past.getTime() - DAY);
    await prisma.attendanceRequest.deleteMany({ where: { employeeId: meera.id, reason: "Smoke test adjustment" } });

    const future = await t.raiseAttendanceRequestAction({}, fd({ type: "ADJUSTMENT", fromDate: dayA, inTime: "09:30", outTime: "18:30", reason: "Smoke test adjustment" }));
    check("An adjustment for a future day is refused", future.ok === false, future.message);
    const raised = await t.raiseAttendanceRequestAction({}, fd({ type: "ADJUSTMENT", fromDate: iso(past), inTime: "09:25", outTime: "18:40", reason: "Smoke test adjustment" }));
    const ar = await prisma.attendanceRequest.findFirst({ where: { employeeId: meera.id, reason: "Smoke test adjustment", status: "PENDING" } });
    if (ar) created.attendance.push(ar.id);
    check("An adjustment for a past day is raised", raised.ok === true && !!ar, raised.message);
    check("The proposed times are stored as IST instants",
      ar?.proposedIn?.toISOString() === `${iso(past)}T03:55:00.000Z`, ar?.proposedIn?.toISOString());

    check("The requester cannot decide it",
      await denied(() => t.decideAttendanceRequestAction({}, fd({ requestId: ar!.id, decision: "approve" }))));
    await signInAs("ramesh.iyer@acme.test");
    const rOutside = await t.decideAttendanceRequestAction({}, fd({ requestId: ar!.id, decision: "approve" }));
    check("A manager outside the reporting line cannot decide it", rOutside.ok === false, rOutside.message);
    await signInAs("sneha.reddy@acme.test");
    const approved = await t.decideAttendanceRequestAction({}, fd({ requestId: ar!.id, decision: "approve" }));
    const manual = await prisma.attendanceLog.findMany({ where: { employeeId: meera.id, source: "MANUAL", timestamp: { gte: new Date(`${iso(past)}T00:00:00Z`), lt: new Date(new Date(`${iso(past)}T00:00:00Z`).getTime() + DAY) } } });
    const rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: new Date(`${iso(past)}T00:00:00Z`) } } });
    check("Approval writes the corrected punches", approved.ok === true && manual.length >= 2, `${manual.length} manual punches`);
    check("…and the day is reprocessed as present with no LOP",
      rec?.status === "PRESENT" && Number(rec.lopValue) === 0 && rec.isRegularised, `${rec?.status} lop=${rec?.lopValue}`);
    await prisma.attendanceLog.deleteMany({ where: { id: { in: manual.map((m) => m.id) } } });
  } finally {
    // -----------------------------------------------------------------
    // Leave the database exactly as the seed left it.
    await prisma.leaveLedgerEntry.deleteMany({ where: { requestId: { in: created.leave } } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId: meera.id, kind: "ADJUSTMENT", note: { startsWith: "Smoke test" } } });
    await prisma.leaveRequest.deleteMany({ where: { id: { in: created.leave } } });
    await prisma.attendanceRequest.deleteMany({ where: { id: { in: created.attendance } } });
    await prisma.leaveType.deleteMany({ where: { tenantId: tenant.id, code: { in: ["SMK", "SMKU"] } } });
    await prisma.shift.deleteMany({ where: { tenantId: tenant.id, code: "SMK" } });
    await prisma.attendancePolicy.deleteMany({ where: { tenantId: tenant.id, name: "Smoke" } });
    for (const id of [meera.id, sneha.id]) await recomputeBalance(id, cl.id, yearStart);
    const lastWeek = new Date(Date.now() - 10 * DAY);
    await processAttendance({ employeeIds: [meera.id], from: lastWeek, to: new Date() });
  }

  report("Leave & attendance actions");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
