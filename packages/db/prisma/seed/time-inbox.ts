import type { PrismaClient } from "@prisma/client";

/**
 * Time Attend and Inbox demo data: shift and weekly-off changes, overtime,
 * comp-off credit, leave encashment, remote clock-ins, WFH/OD by the half day
 * and the hour, a comment thread — everything raised and decided through the
 * real services, so balances, rosters and payroll entries are what the
 * product itself would produce.
 *
 * Idempotent: it clears the rows it owns first, then recreates them. Safe to
 * run on its own against a seeded database.
 */

const SEED = "seed:time-inbox";
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
/** An IST wall-clock time on a date, as a UTC instant. */
const ist = (y: number, m: number, d: number, h: number, min: number) => new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60_000);

const DESCRIPTIONS: Record<string, string> = {
  EL: "This leave is earned by the employee for days worked. It can be carried forward and encashed.",
  CL: "Short, planned time off for personal work. Lapses at the end of the leave year.",
  SL: "This is when an employee falls sick and cannot work.",
  ML: "Up to 26 weeks of paid leave for the birth of a child, as the Maternity Benefit Act provides.",
  PL: "Male employees get 5 working days of paternity leave, to be used within three weeks of the baby's birth.",
  LWP: "Loss of pay: time off without salary, recorded as LOP in payroll.",
  COMP: "Extra leave earned for working on a weekly off, a holiday or beyond regular hours.",
  FLOAT: "Optional holidays from the floating list, up to the yearly quota.",
};

export async function seedTimeInbox(prisma: PrismaClient, ctx: { tenantId: string; today?: Date }) {
  const { tenantId } = ctx;
  const today = ctx.today ?? utc(2026, 10, 1);
  const svc = await import("@keka/services");
  const emps = await prisma.employee.findMany({ where: { tenantId }, select: { id: true, employeeNumber: true, userId: true } });
  const emp = (n: string) => {
    const e = emps.find((x) => x.employeeNumber === n);
    if (!e) throw new Error(`seedTimeInbox: no employee ${n}`);
    return e.id;
  };

  // ---------------------------------------------------------------------
  //  Clear what this module owns
  // ---------------------------------------------------------------------
  const empIds = emps.map((e) => e.id);
  const encash = await prisma.leaveEncashmentRequest.findMany({ where: { tenantId }, select: { id: true } });
  await prisma.adhocTransaction.deleteMany({ where: { employeeId: { in: empIds }, sourceType: "LeaveEncashmentRequest", isProcessed: false } });
  const ownedLedger = await prisma.leaveLedgerEntry.findMany({
    where: { tenantId, OR: [{ periodKey: { startsWith: "COMPOFF:" } }, { periodKey: { startsWith: "ENCASH:" } }, { periodKey: { startsWith: "LAPSE:" } }] },
    select: { employeeId: true, leaveTypeId: true, yearStart: true },
  });
  await prisma.leaveLedgerEntry.deleteMany({
    where: { tenantId, OR: [{ periodKey: { startsWith: "COMPOFF:" } }, { periodKey: { startsWith: "ENCASH:" } }, { periodKey: { startsWith: "LAPSE:" } }] },
  });
  const otEntries = (await prisma.overtimeRequest.findMany({ where: { tenantId, overtimeEntryId: { not: null } }, select: { overtimeEntryId: true } }))
    .map((r) => r.overtimeEntryId!).filter(Boolean);
  if (otEntries.length) await prisma.overtimeEntry.deleteMany({ where: { id: { in: otEntries }, isProcessed: false } });
  const shiftReqs = await prisma.shiftRequest.findMany({ where: { tenantId, status: "APPROVED" }, select: { employeeId: true, fromDate: true, toDate: true } });
  for (const r of shiftReqs) {
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: r.employeeId, date: { gte: r.fromDate, lte: r.toDate } } });
  }
  await prisma.requestComment.deleteMany({ where: { tenantId } });
  await prisma.shiftRequest.deleteMany({ where: { tenantId } });
  await prisma.overtimeRequest.deleteMany({ where: { tenantId } });
  await prisma.compOffRequest.deleteMany({ where: { tenantId } });
  await prisma.leaveEncashmentRequest.deleteMany({ where: { id: { in: encash.map((e) => e.id) } } });
  await prisma.attendanceLog.deleteMany({ where: { tenantId, OR: [{ source: "REMOTE" }, { comment: SEED }] } });
  await prisma.attendanceRequest.deleteMany({ where: { tenantId, OR: [{ type: "REMOTE_CLOCK_IN" }, { reason: { endsWith: " " } }] } });
  await prisma.notification.deleteMany({ where: { tenantId, kind: { in: ["LEAVE", "ATTENDANCE"] }, body: { endsWith: " " } } });
  for (const k of new Map(ownedLedger.map((l) => [`${l.employeeId}|${l.leaveTypeId}|${l.yearStart.toISOString()}`, l])).values()) {
    await svc.recomputeBalance(k.employeeId, k.leaveTypeId, k.yearStart);
  }

  // ---------------------------------------------------------------------
  //  Configuration Keka's screens show
  // ---------------------------------------------------------------------
  await prisma.attendancePolicy.updateMany({
    where: { tenantId },
    data: { allowRemoteClockIn: true, remoteClockInNeedsApproval: true, allowHalfDayRemoteWork: true, allowHourlyRemoteWork: true, penaltyBufferDays: 2 },
  });
  const afternoon = await prisma.shift.findFirst({ where: { tenantId, code: "AFT" } });
  if (!afternoon) {
    await prisma.shift.create({ data: { tenantId, name: "Afternoon", code: "AFT", startTime: "13:00", endTime: "22:00", breakMinutes: 60, color: "#b7791f" } });
  }
  for (const [code, description] of Object.entries(DESCRIPTIONS)) {
    await prisma.leaveType.updateMany({ where: { tenantId, code }, data: { description } });
  }
  await prisma.leaveType.updateMany({ where: { tenantId, category: "COMP_OFF" }, data: { expiryDaysAfterCredit: 60, compOffRequestWindowDays: 30 } });
  await prisma.leaveType.updateMany({ where: { tenantId, code: "EL" }, data: { allowEncashmentRequest: true, encashmentMaxDaysPerYear: 10 } });

  // Requests raised by the seed carry a trailing space in their reason, so a
  // re-run finds exactly its own rows.
  const mark = (s: string) => `${s} `;
  const counts = { attendance: 0, shift: 0, overtime: 0, compoff: 0, encash: 0, remote: 0, notifications: 0 };
  const ok = <T extends { ok: boolean; message: string }>(r: T, what: string): T => {
    if (!r.ok) throw new Error(`seedTimeInbox: ${what} — ${r.message}`);
    return r;
  };

  const meera = emp("ACM0009"), ananya = emp("ACM0007"), sneha = emp("ACM0005");
  const flex = await prisma.shift.findFirstOrThrow({ where: { tenantId, code: "FLEX" } });
  const aft = await prisma.shift.findFirstOrThrow({ where: { tenantId, code: "AFT" } });

  // ---------------------------------------------------------------------
  //  Meera: WFH (half day, pending), OD (approved), comment thread
  // ---------------------------------------------------------------------
  const wfh = ok(await svc.raiseAttendanceRequest({
    employeeId: meera, type: "WORK_FROM_HOME", from: utc(2026, 10, 7), to: utc(2026, 10, 7), portion: "FIRST_HALF",
    reason: mark("Electrician visiting in the morning"), notifyEmployeeIds: [emp("ACM0010")], today,
  }), "Meera WFH");
  const od = ok(await svc.raiseAttendanceRequest({
    employeeId: meera, type: "ON_DUTY", from: utc(2026, 9, 23), to: utc(2026, 9, 23),
    reason: mark("Client workshop at the Whitefield office"), today,
  }), "Meera OD");
  ok(await svc.decideAttendanceRequest({ requestId: od.requestId!, decision: "APPROVE", deciderEmployeeId: ananya }), "approve OD");
  counts.attendance += 2;
  await prisma.requestComment.createMany({
    data: [
      { tenantId, entityType: "AttendanceRequest", entityId: wfh.requestId!, authorEmployeeId: meera, body: "Back online by 2 pm; standup moved to the afternoon." },
      { tenantId, entityType: "AttendanceRequest", entityId: wfh.requestId!, authorEmployeeId: ananya, body: "Fine by me — keep Slack on during the morning." },
    ],
  });

  // Overtime (pending), shift change (approved), weekly off (pending).
  ok(await svc.raiseOvertimeRequest({ employeeId: meera, from: utc(2026, 9, 18), to: utc(2026, 9, 18), minutes: 240, note: mark("Release night for the checkout service"), today }), "Meera OT");
  const shiftChange = ok(await svc.raiseShiftRequest({
    employeeId: meera, kind: "SHIFT_CHANGE", from: utc(2026, 10, 12), to: utc(2026, 10, 16), shiftId: flex.id,
    reason: mark("Course classes in the evenings that week"), today,
  }), "Meera shift change");
  ok(await svc.decideShiftRequest({ requestId: shiftChange.requestId!, decision: "APPROVE", deciderEmployeeId: ananya }), "approve shift");
  ok(await svc.raiseShiftRequest({
    employeeId: meera, kind: "WEEKLY_OFF", from: utc(2026, 10, 22), to: utc(2026, 10, 23),
    reason: mark("Swapping the weekend for my sister's wedding"), today,
  }), "Meera weekly off");
  counts.overtime++; counts.shift += 2;

  // Comp-off: Meera worked Saturday 26 September.
  await prisma.attendanceLog.createMany({
    data: [
      { tenantId, employeeId: meera, timestamp: ist(2026, 9, 26, 10, 2), direction: 0, source: "BIOMETRIC", comment: SEED },
      { tenantId, employeeId: meera, timestamp: ist(2026, 9, 26, 17, 48), direction: 1, source: "BIOMETRIC", comment: SEED },
    ],
  });
  await svc.reprocessRange(meera, utc(2026, 9, 26), utc(2026, 9, 26));
  ok(await svc.raiseCompOffRequest({ employeeId: meera, from: utc(2026, 9, 26), to: utc(2026, 9, 26), note: mark("Production cut-over on the weekend"), today }), "Meera comp off");
  counts.compoff++;

  // Encashment of Earned Leave (pending).
  const elId = (await prisma.leaveType.findFirstOrThrow({ where: { tenantId, code: "EL" } })).id;
  const options = await svc.encashableTypes(meera, today);
  const el = options.find((o) => o.leaveTypeId === elId);
  if (el && el.encashable >= 1) {
    ok(await svc.raiseEncashmentRequest({ employeeId: meera, leaveTypeId: elId, days: Math.min(2, el.encashable), note: mark("For a medical expense"), today }), "Meera encash");
    counts.encash++;
  }

  // ---------------------------------------------------------------------
  //  The rest of the organisation: a populated approvals queue
  // ---------------------------------------------------------------------
  // Aditya: hourly WFH (pending); a worked Sunday credited as comp-off (approved).
  ok(await svc.raiseAttendanceRequest({
    employeeId: emp("ACM0010"), type: "WORK_FROM_HOME", from: utc(2026, 10, 5), to: utc(2026, 10, 5), isHourly: true,
    proposedIn: ist(2026, 10, 5, 14, 0), proposedOut: ist(2026, 10, 5, 17, 0), reason: mark("Bank visit near home in the morning"), today,
  }), "Aditya hourly WFH");
  await prisma.attendanceLog.createMany({
    data: [
      { tenantId, employeeId: emp("ACM0010"), timestamp: ist(2026, 9, 20, 9, 55), direction: 0, source: "BIOMETRIC", comment: SEED },
      { tenantId, employeeId: emp("ACM0010"), timestamp: ist(2026, 9, 20, 18, 5), direction: 1, source: "BIOMETRIC", comment: SEED },
    ],
  });
  await svc.reprocessRange(emp("ACM0010"), utc(2026, 9, 20), utc(2026, 9, 20));
  const adityaComp = ok(await svc.raiseCompOffRequest({ employeeId: emp("ACM0010"), from: utc(2026, 9, 20), to: utc(2026, 9, 20), note: mark("Data migration over the weekend"), today }), "Aditya comp off");
  ok(await svc.decideCompOffRequest({ requestId: adityaComp.requestId!, decision: "APPROVE", deciderEmployeeId: ananya, today }), "approve Aditya comp off");
  counts.attendance++; counts.compoff++;

  // Sanjay: half-day on duty (pending). Rohit: shift change to Afternoon (pending).
  ok(await svc.raiseAttendanceRequest({
    employeeId: emp("ACM0012"), type: "ON_DUTY", from: utc(2026, 10, 6), to: utc(2026, 10, 6), portion: "SECOND_HALF",
    reason: mark("Vendor demo at the client site"), today,
  }), "Sanjay OD");
  ok(await svc.raiseShiftRequest({
    employeeId: emp("ACM0008"), kind: "SHIFT_CHANGE", from: utc(2026, 10, 5), to: utc(2026, 10, 9), shiftId: aft.id,
    reason: mark("Covering the US release window"), today,
  }), "Rohit shift change");
  counts.attendance++; counts.shift++;

  // Divya (Service Delivery, overtime tracked): overtime on 24 September (pending).
  const divyaLogged = await svc.loggedOvertimeMinutes(emp("ACM0011"), utc(2026, 9, 24), utc(2026, 9, 24));
  ok(await svc.raiseOvertimeRequest({
    employeeId: emp("ACM0011"), from: utc(2026, 9, 24), to: utc(2026, 9, 24), minutes: Math.max(90, divyaLogged),
    note: mark("Stayed back for the P1 incident"), today,
  }), "Divya OT");
  counts.overtime++;

  // Rohit: approved encashment that becomes an October payroll payment.
  const rohitEl = (await svc.encashableTypes(emp("ACM0008"), today)).find((o) => o.leaveTypeId === elId);
  if (rohitEl && rohitEl.encashable >= 1) {
    const r = ok(await svc.raiseEncashmentRequest({ employeeId: emp("ACM0008"), leaveTypeId: elId, days: Math.min(3, rohitEl.encashable), note: mark("Encashing before year end"), today }), "Rohit encash");
    ok(await svc.decideEncashmentRequest({ requestId: r.requestId!, decision: "APPROVE", deciderEmployeeId: emp("ACM0003"), today }), "approve Rohit encash");
    counts.encash++;
  }

  // Remote clock-ins awaiting Sneha: three of her direct reports, 29–30 September.
  const remote: Array<[string, number, number, number, number, number, number]> = [
    ["ACM0006", 29, 9, 41, 18, 52, 0], ["ACM0008", 30, 10, 5, 19, 12, 1], ["ACM0011", 30, 9, 12, 18, 3, 2],
  ];
  const spots = [[17.4401, 78.3489], [17.4239, 78.4738], [12.9716, 77.5946]];
  for (const [n, day, ih, im, oh, om, spot] of remote) {
    const [lat, lng] = spots[spot];
    for (const [direction, at] of [[0, ist(2026, 9, day, ih, im)], [1, ist(2026, 9, day, oh, om)]] as const) {
      ok(await svc.recordPunch({
        employeeId: emp(n), direction, at, source: "REMOTE", latitude: lat, longitude: lng,
        comment: direction === 0 ? "Working from the client office today" : "Signing off",
      }), `remote punch ${n}`);
    }
    counts.remote++;
  }

  // Notifications the approvers would have received.
  const notes: Array<[string, "LEAVE" | "ATTENDANCE", string]> = [
    [meera, "ATTENDANCE", "work from home on 07 Oct 2026"],
    [meera, "ATTENDANCE", "04:00 hrs of overtime on 18 Sep 2026"],
    [meera, "LEAVE", "1 day(s) of comp off for work on 26 Sep 2026"],
    [emp("ACM0006"), "ATTENDANCE", "a remote clock-in on 29 Sep 2026"],
  ];
  for (const [who, kind, what] of notes) {
    counts.notifications += await svc.notifyTimeRequest({ tenantId, employeeId: who, kind, event: "RAISED", what, note: mark("Raised from the demo data") });
  }
  void sneha;
  return counts;
}
