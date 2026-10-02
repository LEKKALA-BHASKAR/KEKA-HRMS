/**
 * Leave and attendance policy depth: approval chains (manager then HR, HR
 * skipping its own level, auto-approval, the inbox's next approver), usage
 * limits on apply, optional holidays, comp-off grants and auto-credit, the
 * admin day edit, the LOP import, shift allowance generation and overtime
 * multipliers. Pages render for the people who use them.
 *
 * Uses its own leave types (SMKAD, SMKAA, SMKDF, SMKUL), shift (SMKNS),
 * attendance policy and holidays; everything is removed at the end and the
 * touched attendance is reprocessed back.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const key = (d: Date) => d.toISOString().slice(0, 10);
const utcToday = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** A local IST wall-clock time on a date, as the instant a punch carries. */
const ist = (d: Date, hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return new Date(d.getTime() + (h * 60 + m - 330) * 60_000); };

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${(e as { digest?: string }).digest ?? ""}`); }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const svc = await import("@keka/services");
  const timeAct = await import("../apps/web/src/app/actions/time");
  const act = await import("../apps/web/src/app/actions/leave-policy");
  const { requireViewer } = await import("../apps/web/src/lib/context");
  const { listApprovals } = await import("../apps/web/src/lib/time-approvals");
  const { renderToReadableStream } = await import("react-dom/server");
  const html = async (node: unknown) => {
    const stream = await renderToReadableStream(node as never);
    await stream.allReady;
    return new Response(stream).text();
  };

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "meera.krishnan@acme.test" } });
  const deepak = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "deepak.chauhan@acme.test" } });
  const vikram = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "vikram.menon@acme.test" } });
  const manager = await prisma.employee.findUniqueOrThrow({ where: { id: meera.reportingManagerId! }, include: { user: { select: { email: true } } } });
  const managerEmail = manager.user!.email;
  const comp = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } });
  const calendar = await prisma.holidayCalendar.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true }, orderBy: { year: "desc" } });
  const quotaBefore = calendar.optionalHolidayQuota;

  // --- Dates ------------------------------------------------------------------
  const today = utcToday();
  const holidays = new Set((await prisma.holiday.findMany({ where: { calendar: { tenantId: tenant.id } }, select: { date: true } })).map((h) => key(h.date)));
  const leaveDays = new Set((await prisma.leaveRequestDay.findMany({
    where: { request: { employeeId: meera.id, status: { in: ["PENDING", "APPROVED"] } } }, select: { date: true },
  })).map((d) => key(d.date)));
  const weekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const clean = (d: Date) => weekday(d) && !holidays.has(key(d)) && !leaveDays.has(key(d));
  /** The first Monday on/after `from` whose working week is clean, optionally `weeks` weeks long. */
  const cleanWeek = (from: Date, weeks = 1, sameMonth = false): Date => {
    let d = from;
    while (d.getUTCDay() !== 1) d = addDays(d, 1);
    for (;;) {
      const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(d, i)).filter(weekday);
      if (days.every(clean) && (!sameMonth || days.every((x) => x.getUTCMonth() === d.getUTCMonth()))) return d;
      d = addDays(d, 7);
    }
  };
  const w1 = cleanWeek(addDays(today, 21));
  const w2 = cleanWeek(addDays(w1, 7));
  const w3 = cleanWeek(addDays(w2, 7), 2, true);
  const w5 = cleanWeek(addDays(w3, 14));
  // Past working days with no punches yet, for the day edit, optional holiday and shift allowance.
  const punched = new Set((await prisma.attendanceLog.findMany({
    where: { employeeId: meera.id, timestamp: { gte: addDays(today, -60) } }, select: { timestamp: true },
  })).map((l) => key(new Date(l.timestamp.getTime() + 330 * 60_000))));
  const past: Date[] = [];
  for (let d = addDays(today, -3); past.length < 30 && d > addDays(today, -60); d = addDays(d, -1)) {
    if (clean(d) && d.getUTCFullYear() === calendar.year) past.push(d);
  }
  // Shift allowance wants days with no punches of their own; the rest can be any working day.
  const unpunched = past.filter((d) => !punched.has(key(d)));
  const saDays = unpunched.filter((d) => d.getUTCMonth() === unpunched[0].getUTCMonth()).slice(0, 2);
  const others = past.filter((d) => !saDays.includes(d));
  const dEdit = others.find((d) => !punched.has(key(d))) ?? others[0];
  const dOpt = others.find((d) => d !== dEdit)!;
  let sunday = addDays(today, -3);
  while (sunday.getUTCDay() !== 0 || punched.has(key(sunday)) || holidays.has(key(sunday))) sunday = addDays(sunday, -1);

  // --- Fixtures -----------------------------------------------------------------
  const codes = ["SMKAD", "SMKAA", "SMKDF", "SMKUL"];
  const created = { overtimeEntry: null as null | { id: string; existed: boolean; hours: unknown; amount: unknown; rate: unknown } };
  const replacedLogs: Array<{ id: string; comment: string | null }> = [];

  /** Remove everything this script creates; safe to run before a run too. */
  async function cleanup(reprocess: boolean) {
    const typeIds = (await prisma.leaveType.findMany({ where: { tenantId: tenant.id, code: { in: codes } }, select: { id: true } })).map((t) => t.id);
    await prisma.leaveLedgerEntry.deleteMany({ where: { leaveTypeId: { in: typeIds } } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId: meera.id, OR: [{ note: { startsWith: "Smoke grant" } }, { periodKey: { startsWith: "COMPOFF-AUTO:" }, note: { contains: key(sunday) } }] } });
    await prisma.leaveType.deleteMany({ where: { id: { in: typeIds } } });
    await prisma.leavePlan.deleteMany({ where: { tenantId: tenant.id, name: "Smoke depth plan" } });
    const yearStart = svc.leaveYearStart(today, (await svc.planFor(meera.id, today))?.plan.yearBasis ?? "FINANCIAL_APR", meera.dateOfJoining);
    await svc.recomputeBalance(meera.id, comp.id, yearStart);
    await prisma.holiday.deleteMany({ where: { calendar: { tenantId: tenant.id }, name: { startsWith: "Smoke Optional" } } });
    await prisma.holidayCalendar.update({ where: { id: calendar.id }, data: { optionalHolidayQuota: quotaBefore } });
    const ots = await prisma.overtimeRequest.findMany({ where: { employeeId: meera.id, fromDate: sunday, toDate: sunday } });
    await prisma.overtimeRequest.deleteMany({ where: { id: { in: ots.map((o) => o.id) } } });
    if (created.overtimeEntry) {
      const o = created.overtimeEntry;
      if (o.existed) await prisma.overtimeEntry.update({ where: { id: o.id }, data: { hours: o.hours as never, amount: o.amount as never, rate: o.rate as never } });
      else await prisma.overtimeEntry.delete({ where: { id: o.id } });
      created.overtimeEntry = null;
    }
    const pol = await prisma.attendancePolicy.findMany({ where: { tenantId: tenant.id, name: "Smoke depth policy" }, select: { id: true } });
    await prisma.employeeTimePolicy.deleteMany({
      where: { employeeId: meera.id, OR: [{ attendancePolicyId: { in: pol.map((x) => x.id) } }, { effectiveFrom: sunday, effectiveTo: sunday }] },
    });
    await prisma.attendancePolicy.deleteMany({ where: { id: { in: pol.map((x) => x.id) } } });
    await prisma.attendanceLog.deleteMany({ where: { employeeId: meera.id, source: "MANUAL", comment: { startsWith: "Smoke" } } });
    // Punches the day edit replaced come back as they were.
    for (const l of replacedLogs) await prisma.attendanceLog.update({ where: { id: l.id }, data: { status: "VALID", comment: l.comment } });
    await prisma.attendanceLog.updateMany({ where: { employeeId: meera.id, status: "REJECTED", comment: { startsWith: "Replaced by an admin edit: Smoke" } }, data: { status: "VALID", comment: null } });
    await prisma.shiftAllowanceEntry.deleteMany({ where: { tenantId: tenant.id, shiftCode: "SMKNS" } });
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: meera.id, shift: { code: "SMKNS" } } });
    await prisma.shift.deleteMany({ where: { tenantId: tenant.id, code: "SMKNS" } });
    await prisma.lopAdjustment.deleteMany({ where: { tenantId: tenant.id, note: "Smoke import" } });
    const edited = await prisma.attendanceRecord.findMany({ where: { employeeId: meera.id, editReason: { startsWith: "Smoke" } }, select: { date: true } });
    await prisma.attendanceRecord.updateMany({ where: { employeeId: meera.id, editReason: { startsWith: "Smoke" } }, data: { manualStatus: null, editedAt: null, editedBy: null, editReason: null } });
    if (reprocess) for (const d of [dEdit, dOpt, sunday, ...saDays, ...edited.map((e) => e.date)].filter(Boolean)) await svc.reprocessRange(meera.id, d, d);
  }
  await cleanup(true);

  const mk = (code: string, extra: Record<string, unknown> = {}) => prisma.leaveType.create({
    data: { tenantId: tenant.id, name: `Smoke ${code}`, code, annualQuota: 0, allowBackdated: true, ...extra },
  });
  const tAD = await mk("SMKAD", { approvalChain: { levels: ["REPORTING_MANAGER", "HR"], skipSamePerson: true } });
  const tAA = await mk("SMKAA");
  const tDF = await mk("SMKDF");
  const tUL = await mk("SMKUL", { maxDaysPerMonth: 2, minGapBetweenLeavesDays: 5, maxConsecutiveDays: 3, priorNoticeDays: 3 });
  for (const t of [tAD, tAA, tDF, tUL]) await svc.adjustBalance({ employeeId: meera.id, leaveTypeId: t.id, days: 20, note: "Smoke opening" });
  const plan = await prisma.leavePlan.create({ data: { tenantId: tenant.id, name: "Smoke depth plan" } });
  const policy = await prisma.attendancePolicy.create({
    data: { tenantId: tenant.id, name: "Smoke depth policy", autoCreditCompOff: true, overtimeEnabled: true, overtimeMultiplier: 1.5, overtimeOffDayMultiplier: 2, overtimeRoundingMinutes: 30 },
  });
  const gen = await prisma.shift.findFirstOrThrow({ where: { tenantId: tenant.id, code: "GEN" } });

  const apply = (o: Record<string, string>) => timeAct.applyLeaveAction({}, fd({ fromPortion: "FULL_DAY", toPortion: "FULL_DAY", intent: "apply", ...o }));
  const decide = (requestId: string, decision: "approve" | "reject", note?: string) => timeAct.decideLeaveAction({}, fd({ requestId, decision, note }));
  const latest = (leaveTypeId: string) => prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: meera.id, leaveTypeId }, orderBy: { createdAt: "desc" } });

  console.log("\nLeave and attendance policy depth\n" + "=".repeat(72));
  try {
    section("Approval chain: reporting manager, then HR");
    await signInAs("meera.krishnan@acme.test");
    const a1 = await apply({ leaveTypeId: tAD.id, fromDate: key(w1), toDate: key(addDays(w1, 1)), reason: "Smoke chain" });
    check("An employee applies leave on a chained type", a1.ok === true, a1.message);
    let req = await latest(tAD.id);
    const steps = req.approvalSteps as Array<{ role: string; approverId: string | null }>;
    check("The request carries the resolved chain: her manager, then HR", steps?.length === 2 && steps[0].approverId === manager.id && steps[1].role === "HR", JSON.stringify(steps));

    await signInAs(managerEmail);
    let rows = await listApprovals(await requireViewer(), "leave", { scope: "admin" });
    let row = rows.find((r) => r.id === req.id);
    check("The manager's inbox shows it, theirs to decide, at level 1 of 2", !!row?.canDecide && /level 1 of 2/.test(row?.nextApprover ?? ""), row?.nextApprover ?? "missing");
    const m1 = await decide(req.id, "approve");
    req = await latest(tAD.id);
    check("The manager's approval moves it on to HR, still pending", m1.ok === true && req.status === "PENDING" && req.approvalLevel === 1, m1.message);
    rows = await listApprovals(await requireViewer(), "leave", { scope: "admin" });
    row = rows.find((r) => r.id === req.id);
    check("…the inbox now names HR as next and the manager can no longer decide", !!row && !row.canDecide && /^HR \(level 2 of 2\)/.test(row.nextApprover ?? ""), row?.nextApprover ?? "missing");
    const m2 = await decide(req.id, "approve");
    check("…and a second approval from the manager is refused", m2.ok === false && /waiting for HR/.test(m2.message ?? ""), m2.message);
    check("No balance is used until the last level", (await prisma.leaveLedgerEntry.count({ where: { requestId: req.id, kind: "USED" } })) === 0);

    await signInAs("priya.sharma@acme.test");
    const h1 = await decide(req.id, "approve");
    req = await latest(tAD.id);
    const used = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: req.id, kind: "USED" } });
    check("HR's approval completes the chain and debits the balance", h1.ok === true && req.status === "APPROVED" && Number(used?.days) === -2, h1.message);
    check("Each level records who cleared it", (req.approvalSteps as Array<{ status: string; by: string | null }>).every((s) => s.status === "APPROVED" && !!s.by));

    section("Approval chain: HR acting first skips its own level");
    await signInAs("meera.krishnan@acme.test");
    await apply({ leaveTypeId: tAD.id, fromDate: key(addDays(w1, 3)), toDate: key(addDays(w1, 3)), reason: "Smoke skip" });
    req = await latest(tAD.id);
    await signInAs("priya.sharma@acme.test");
    const h2 = await decide(req.id, "approve");
    req = await latest(tAD.id);
    const st = req.approvalSteps as Array<{ status: string }>;
    check("One HR approval at the manager level approves it outright", h2.ok === true && req.status === "APPROVED" && st[1].status === "SKIPPED", JSON.stringify(st));

    section("Approval chain: auto-approval and the default");
    await signInAs("vikram.menon@acme.test");
    const ch = await act.saveApprovalChainAction({}, fd({ target: "type", id: tAA.id, levels: "REPORTING_MANAGER", autoApproveAfterDays: 2, skipSamePerson: true }));
    check("An admin sets a chain with auto-approval on a leave type", ch.ok === true && (await prisma.leaveType.findUniqueOrThrow({ where: { id: tAA.id } })).approvalChain !== null, ch.message);
    const pc = await act.saveApprovalChainAction({}, fd({ target: "plan", id: plan.id, levels: "HR", skipSamePerson: true }));
    const planChain = (await prisma.leavePlan.findUniqueOrThrow({ where: { id: plan.id } })).approvalChain as { levels: string[] } | null;
    check("…and a chain on a leave plan", pc.ok === true && planChain?.levels[0] === "HR", JSON.stringify(planChain));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change approval chains", await denied(() => act.saveApprovalChainAction({}, fd({ target: "type", id: tAA.id, levels: "HR" }))));
    await apply({ leaveTypeId: tAA.id, fromDate: key(w2), toDate: key(w2), reason: "Smoke auto" });
    req = await latest(tAA.id);
    let auto = await svc.autoApproveStaleLeave(tenant.id);
    check("Within the window nothing is auto-approved", (await latest(tAA.id)).status === "PENDING", JSON.stringify(auto));
    await prisma.leaveRequest.update({ where: { id: req.id }, data: { levelSince: addDays(new Date(), -3) } });
    auto = await svc.autoApproveStaleLeave(tenant.id);
    req = await latest(tAA.id);
    check("After the window it approves itself, marked as automatic", req.status === "APPROVED" && req.approvedBy === null && (req.approvalSteps as Array<{ status: string }>)[0].status === "AUTO", JSON.stringify(auto));
    check("…and the balance is debited", (await prisma.leaveLedgerEntry.count({ where: { requestId: req.id, kind: "USED" } })) === 1);
    await apply({ leaveTypeId: tDF.id, fromDate: key(addDays(w2, 2)), toDate: key(addDays(w2, 2)), reason: "Smoke default" });
    req = await latest(tDF.id);
    await signInAs(managerEmail);
    const d1 = await decide(req.id, "approve");
    req = await latest(tDF.id);
    check("With no chain, a single approval decides it as before", d1.ok === true && req.status === "APPROVED" && req.approvalSteps === null, d1.message);

    section("Usage limits on apply");
    await signInAs("meera.krishnan@acme.test");
    const preview = (from: Date, to: Date) => timeAct.applyLeaveAction({}, fd({ leaveTypeId: tUL.id, fromDate: key(from), toDate: key(to), fromPortion: "FULL_DAY", toPortion: "FULL_DAY", intent: "preview" }));
    const notice = await preview(addDays(today, 1), addDays(today, 1));
    check("Notice period: applying too close is refused with the days needed", notice.ok === false && /needs 3 day\(s\) notice/.test(notice.message ?? ""), notice.message);
    const first = await apply({ leaveTypeId: tUL.id, fromDate: key(w3), toDate: key(addDays(w3, 1)) });
    check("Two days inside every limit are accepted", first.ok === true, first.message);
    const monthly = await preview(addDays(w3, 7), addDays(w3, 7));
    check("Max per month: a third day that month is refused, naming the month", monthly.ok === false && /At most 2 day\(s\) of Smoke SMKUL can be taken in a month; \w+ \d{4} would have 3 \(2 already taken or pending\)/.test(monthly.message ?? ""), monthly.message);
    const gap = await preview(addDays(w3, 3), addDays(w3, 3));
    check("Minimum gap: a request one day after another is refused", gap.ok === false && /gap of at least 5 day\(s\) between two Smoke SMKUL requests; this is 1 day\(s\)/.test(gap.message ?? ""), gap.message);
    const longRun = await preview(w5, addDays(w5, 3));
    check("Max consecutive days: four in a row is refused", longRun.ok === false && /At most 3 consecutive day\(s\)/.test(longRun.message ?? ""), longRun.message);
    await signInAs("vikram.menon@acme.test");
    const onBehalf = await timeAct.applyLeaveAction({}, fd({ employeeId: meera.id, leaveTypeId: tUL.id, fromDate: key(addDays(w3, 7)), toDate: key(addDays(w3, 7)), intent: "preview" }));
    check("The monthly limit applies to an admin applying on someone's behalf too", onBehalf.ok === false && /in a month/.test(onBehalf.message ?? ""), onBehalf.message);

    section("Optional holidays");
    const opt1 = await prisma.holiday.create({ data: { calendarId: calendar.id, name: "Smoke Optional One", date: addDays(w5, 2), isOptional: true } });
    const opt2 = await prisma.holiday.create({ data: { calendarId: calendar.id, name: "Smoke Optional Two", date: addDays(w5, 3), isOptional: true } });
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot set the optional holiday quota", await denied(() => act.setOptionalQuotaAction({}, fd({ calendarId: calendar.id, quota: 5 }))));
    await signInAs("vikram.menon@acme.test");
    const q = await act.setOptionalQuotaAction({}, fd({ calendarId: calendar.id, quota: 1 }));
    check("HR sets the quota on the calendar", q.ok === true && (await prisma.holidayCalendar.findUniqueOrThrow({ where: { id: calendar.id } })).optionalHolidayQuota === 1, q.message);
    await signInAs("meera.krishnan@acme.test");
    const p1 = await act.optionalHolidayAction({}, fd({ holidayId: opt1.id }));
    check("The employee picks one", p1.ok === true && /1 of 1 picked/.test(p1.message ?? ""), p1.message);
    const p2 = await act.optionalHolidayAction({}, fd({ holidayId: opt2.id }));
    check("…a second is refused at the quota", p2.ok === false && /already picked 1 of 1/.test(p2.message ?? ""), p2.message);
    const resolved = await svc.resolveTimePolicy(meera.id, opt1.date);
    check("The picked day is a holiday for her, the other is not", resolved.calendar.holidays.has(key(opt1.date)) && !resolved.calendar.holidays.has(key(opt2.date)));
    const deepakCal = await svc.resolveTimePolicy(deepak.id, opt1.date);
    check("…and not for a colleague who did not pick it", !deepakCal.calendar.holidays.has(key(opt1.date)));
    const onPicked = await svc.previewLeave({ employeeId: meera.id, leaveTypeId: tDF.id, from: opt1.date, to: opt1.date });
    check("Leave cannot be taken on a picked optional holiday", onPicked.count.empty);
    check("Picking for someone else needs leave management", (await act.optionalHolidayAction({}, fd({ holidayId: opt2.id, employeeId: deepak.id }))).ok === false);
    const r1 = await act.optionalHolidayAction({}, fd({ holidayId: opt1.id, intent: "remove" }));
    const p3 = await act.optionalHolidayAction({}, fd({ holidayId: opt2.id }));
    check("Removing one frees the quota for another", r1.ok === true && p3.ok === true, `${r1.message} / ${p3.message}`);
    // A picked day in the past counts as a holiday when attendance is processed.
    const optPast = await prisma.holiday.create({ data: { calendarId: calendar.id, name: "Smoke Optional Past", date: dOpt, isOptional: true } });
    await prisma.holidayCalendar.update({ where: { id: calendar.id }, data: { optionalHolidayQuota: 3 } });
    const pp = await svc.pickOptionalHoliday({ employeeId: meera.id, holidayId: optPast.id, today: addDays(dOpt, -1) });
    await svc.processAttendance({ employeeIds: [meera.id], from: dOpt, to: dOpt });
    const optRec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: dOpt } } });
    check("A picked optional holiday is processed as HOLIDAY in her attendance, with no LOP", pp.ok && optRec?.status === "HOLIDAY" && Number(optRec.lopValue) === 0, `${key(dOpt)} ${optRec?.status}`);

    section("Comp-off: grants");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot grant comp-off", (await act.grantCompOffAction({}, fd({ employeeId: vikram.id, days: 1, note: "Smoke" }))).ok === false);
    await signInAs(managerEmail);
    check("Nobody grants comp-off to themselves", (await act.grantCompOffAction({}, fd({ employeeId: manager.id, days: 1, note: "Smoke" }))).ok === false);
    check("Grants are in half days", (await act.grantCompOffAction({}, fd({ employeeId: meera.id, days: 0.3, note: "Smoke" }))).ok === false);
    const expiry = key(addDays(today, 45));
    const g = await act.grantCompOffAction({}, fd({ employeeId: meera.id, days: 1.5, note: "Smoke grant", expiresOn: expiry, workedOn: key(sunday) }));
    const grant = await prisma.leaveLedgerEntry.findFirst({ where: { employeeId: meera.id, kind: "COMP_OFF_CREDIT", note: { startsWith: "Smoke grant" } } });
    check("Her manager grants 1.5 days with an expiry", g.ok === true && Number(grant?.days) === 1.5 && key(grant!.expiresOn!) === expiry, g.message);
    const compPreview = await svc.previewLeave({ employeeId: meera.id, leaveTypeId: comp.id, from: w5, to: w5 });
    check("…and the comp-off balance is usable like any leave type", compPreview.available >= 1.5 && !compPreview.issues.some((i) => /Not enough/.test(i.message)), `available ${compPreview.available}`);

    section("Comp-off: earned automatically from a worked weekly off");
    await prisma.employeeTimePolicy.create({ data: { employeeId: meera.id, attendancePolicyId: policy.id, shiftId: gen.id, effectiveFrom: sunday, effectiveTo: sunday } });
    const logs = await prisma.attendanceLog.createManyAndReturn({
      data: [
        { tenantId: tenant.id, employeeId: meera.id, timestamp: ist(sunday, "10:00"), direction: 0, source: "MANUAL", comment: "Smoke" },
        { tenantId: tenant.id, employeeId: meera.id, timestamp: ist(sunday, "18:00"), direction: 1, source: "MANUAL", comment: "Smoke" },
      ],
    });
    await svc.processAttendance({ employeeIds: [meera.id], from: sunday, to: sunday });
    await svc.processAttendance({ employeeIds: [meera.id], from: sunday, to: sunday });
    const autoCredits = await prisma.leaveLedgerEntry.findMany({ where: { employeeId: meera.id, periodKey: `COMPOFF-AUTO:${key(sunday)}` } });
    check("With the policy flag on, 8 hours on a weekly off credits one day of comp-off, once", autoCredits.length === 1 && Number(autoCredits[0].days) === 1, `${key(sunday)}: ${autoCredits.length}`);
    const eligible = await svc.compOffEligibleDays(meera.id, { today });
    check("…and the day is no longer offered for a comp-off request", !eligible.some((d) => d.key === key(sunday)));

    section("Overtime multipliers and rounding");
    const otBefore = await prisma.overtimeEntry.findFirst({ where: { employeeId: meera.id, year: sunday.getUTCFullYear(), month: sunday.getUTCMonth() + 1, payAction: "PAY", isProcessed: false } });
    const ot = await svc.raiseOvertimeRequest({ employeeId: meera.id, from: sunday, to: sunday, minutes: 100 });
    const otd = ot.requestId ? await svc.decideOvertimeRequest({ requestId: ot.requestId, decision: "APPROVE" }) : { ok: false, message: ot.message, requestId: undefined };
    const otAfter = otd.requestId ? await prisma.overtimeEntry.findUnique({ where: { id: otd.requestId } }) : null;
    if (otAfter) created.overtimeEntry = { id: otAfter.id, existed: !!otBefore, hours: otBefore?.hours, amount: otBefore?.amount, rate: otBefore?.rate };
    const addedHours = Number(otAfter?.hours ?? 0) - Number(otBefore?.hours ?? 0);
    check("1h40m of overtime on a weekly off rounds down to 1.5 hours and pays 2× the hourly rate", otd.ok && Math.abs(addedHours - 1.5) < 1e-9 && /2× the hourly rate/.test(otd.message), otd.message);

    section("Admin attendance edit");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot edit attendance", await denied(() => act.editAttendanceDayAction({}, fd({ employeeId: meera.id, date: key(dEdit), status: "PRESENT", reason: "Smoke" }))));
    await signInAs("vikram.menon@acme.test");
    check("A reason is required", (await act.editAttendanceDayAction({}, fd({ employeeId: meera.id, date: key(dEdit), status: "ABSENT", reason: "" }))).ok === false);
    check("Future days cannot be edited", (await act.editAttendanceDayAction({}, fd({ employeeId: meera.id, date: key(addDays(today, 2)), status: "ABSENT", reason: "Smoke" }))).ok === false);
    const e1 = await act.editAttendanceDayAction({}, fd({ employeeId: meera.id, date: key(dEdit), status: "ABSENT", reason: "Smoke: unapproved absence" }));
    let rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: dEdit } } });
    check("Pinning a day ABSENT makes it a full day of LOP, with the reason kept", e1.ok === true && rec?.status === "ABSENT" && Number(rec.lopValue) === 1 && rec.manualStatus === "ABSENT" && rec.editReason === "Smoke: unapproved absence", e1.message);
    await svc.reprocessRange(meera.id, dEdit, dEdit);
    rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: dEdit } } });
    check("…and the pin survives reprocessing", rec?.status === "ABSENT");
    replacedLogs.push(...await prisma.attendanceLog.findMany({
      where: { employeeId: meera.id, status: "VALID", timestamp: { gte: ist(dEdit, "00:00"), lt: ist(addDays(dEdit, 1), "00:00") } }, select: { id: true, comment: true },
    }));
    const e2 = await act.editAttendanceDayAction({}, fd({ employeeId: meera.id, date: key(dEdit), status: "AUTO", firstIn: "09:25", lastOut: "18:40", reason: "Smoke: device was down" }));
    rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: dEdit } } });
    const manual = await prisma.attendanceLog.findMany({ where: { employeeId: meera.id, source: "MANUAL", comment: "Smoke: device was down" } });
    check("Entering punches and clearing the pin recalculates the day as present", e2.ok === true && rec?.status === "PRESENT" && rec.manualStatus === null && manual.length === 2, `${e2.message} ${rec?.status}`);
    const audit = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, entityType: "AttendanceRecord", entityId: meera.id, summary: { contains: key(dEdit) } } });
    check("Both edits are in the audit log with before and after", audit.length >= 2 && audit.every((a) => a.newValue !== null), `${audit.length}`);

    section("LOP import");
    const csv = (rows: string) => `Employee Number,Month,LOP Days,Note\n${rows}`;
    const ym = "2026-11";
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot import LOP", await denied(() => act.importLopAction({}, fd({ csv: csv(`${meera.employeeNumber},${ym},1,Smoke import`) }))));
    await signInAs("vikram.menon@acme.test");
    const lopBefore = await prisma.lopAdjustment.count({ where: { tenantId: tenant.id, year: 2026, month: 11, employeeId: { in: [meera.id, deepak.id] } } });
    const good = csv(`${meera.employeeNumber},${ym},1.5,Smoke import\n${deepak.employeeNumber},${ym},0.5,Smoke import`);
    const chk = await act.importLopAction({}, fd({ csv: good, intent: "check" }));
    check("Checking a file writes nothing", chk.ok === true && /2 row\(s\) ready/.test(chk.message ?? "") && (await prisma.lopAdjustment.count({ where: { note: "Smoke import" } })) === 0, chk.message);
    const bad = await act.importLopAction({}, fd({ csv: csv(`${meera.employeeNumber},${ym},1,Smoke import\nNOPE999,${ym},1,Smoke import`), intent: "import" }));
    check("A file with an unknown employee is refused whole, naming the line", bad.ok === false && /Line 3: No employee NOPE999/.test(bad.message ?? "") && (await prisma.lopAdjustment.count({ where: { note: "Smoke import" } })) === 0, bad.message);
    const closed = await prisma.payrollRun.findFirst({ where: { tenantId: tenant.id, status: "FINALIZED", lines: { some: { employeeId: meera.id } } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    if (closed) {
      const lock = await act.importLopAction({}, fd({ csv: csv(`${meera.employeeNumber},${closed.year}-${String(closed.month).padStart(2, "0")},1,Smoke import`), intent: "import" }));
      check("A month whose payroll is finalised is refused", lock.ok === false && /finalised/.test(lock.message ?? ""), lock.message);
    }
    const imp = await act.importLopAction({}, fd({ csv: good, intent: "import" }));
    const lop = await prisma.lopAdjustment.findMany({ where: { tenantId: tenant.id, year: 2026, month: 11, employeeId: { in: [meera.id, deepak.id] } } });
    check("Importing writes one LOP row per employee for the month", imp.ok === true && lop.length === 2 && lop.every((l) => l.source === "IMPORT"), imp.message);
    // The rows payroll reads for the month: the same query the run makes.
    const payrollSees = (await prisma.lopAdjustment.findMany({ where: { employeeId: { in: [meera.id] }, year: 2026, month: 11 } })).reduce((s, a) => s + Number(a.days), 0);
    check("…which payroll for that month reads as 1.5 manual LOP days", payrollSees === 1.5, String(payrollSees));
    await act.importLopAction({}, fd({ csv: csv(`${meera.employeeNumber},${ym},0,Smoke import`), intent: "import" }));
    check("Re-importing 0 clears the month instead of stacking", (await prisma.lopAdjustment.count({ where: { employeeId: meera.id, year: 2026, month: 11 } })) === 0 && lopBefore === 0);

    section("Shift allowance from processed attendance");
    await signInAs("vikram.menon@acme.test");
    const ns = await prisma.shift.create({ data: { tenantId: tenant.id, name: "Smoke Night", code: "SMKNS", startTime: "09:30", endTime: "18:30" } });
    const sr = await act.saveShiftAllowanceAction({}, fd({ shiftId: ns.id, allowanceCode: "sna", allowancePerDay: 300 }));
    check("An admin gives a shift an allowance code and a daily rate", sr.ok === true && (await prisma.shift.findUniqueOrThrow({ where: { id: ns.id } })).allowanceCode === "SNA", sr.message);
    check("A code without a rate is refused", (await act.saveShiftAllowanceAction({}, fd({ shiftId: ns.id, allowanceCode: "SNA" }))).ok === false);
    for (const d of saDays) await prisma.shiftAssignment.upsert({ where: { employeeId_date: { employeeId: meera.id, date: d } }, create: { employeeId: meera.id, shiftId: ns.id, date: d }, update: { shiftId: ns.id } });
    const saLogs = await prisma.attendanceLog.createManyAndReturn({
      data: saDays.flatMap((d) => [
        { tenantId: tenant.id, employeeId: meera.id, timestamp: ist(d, "09:30"), direction: 0, source: "MANUAL" as const, comment: "Smoke" },
        { tenantId: tenant.id, employeeId: meera.id, timestamp: ist(d, "18:35"), direction: 1, source: "MANUAL" as const, comment: "Smoke" },
      ]),
    });
    await svc.reprocessRange(meera.id, saDays[0], saDays[saDays.length - 1]);
    const saRecs = await prisma.attendanceRecord.findMany({ where: { employeeId: meera.id, date: { in: saDays } } });
    check("Processed days on the rostered shift carry that shift", saRecs.length === saDays.length && saRecs.every((r) => r.shiftId === ns.id && r.status === "PRESENT"), saRecs.map((r) => r.status).join(","));
    const y = saDays[0].getUTCFullYear(), m = saDays[0].getUTCMonth() + 1;
    const gen1 = await act.generateShiftAllowanceAction({}, fd({ year: y, month: m }));
    let entries = await prisma.shiftAllowanceEntry.findMany({ where: { employeeId: meera.id, year: y, month: m, shiftCode: "SMKNS" } });
    check(`The step creates one payroll entry: ${saDays.length} day(s) × ₹300`, gen1.ok === true && entries.length === 1 && Number(entries[0].days) === saDays.length && Number(entries[0].amount) === saDays.length * 300 && entries[0].allowanceCode === "SNA" && entries[0].payAction === "PAY", gen1.message);
    await act.generateShiftAllowanceAction({}, fd({ year: y, month: m }));
    entries = await prisma.shiftAllowanceEntry.findMany({ where: { employeeId: meera.id, year: y, month: m, shiftCode: "SMKNS" } });
    check("Re-running replaces the unpaid entry rather than adding another", entries.length === 1);
    await prisma.shiftAllowanceEntry.update({ where: { id: entries[0].id }, data: { isProcessed: true } });
    const s3 = await svc.generateShiftAllowances({ tenantId: tenant.id, year: y, month: m, employeeIds: [meera.id] });
    entries = await prisma.shiftAllowanceEntry.findMany({ where: { employeeId: meera.id, year: y, month: m, shiftCode: "SMKNS" } });
    check("Once paid, a re-run leaves it alone and pays nothing twice", entries.length === 1 && s3.skippedPaid === 1, JSON.stringify(s3));

    section("Screens");
    await signInAs("vikram.menon@acme.test");
    const leavePage = (await import("../apps/web/src/app/(app)/leave/page")).default;
    const attPage = (await import("../apps/web/src/app/(app)/attendance/page")).default;
    const sp = (o: Record<string, string>) => ({ searchParams: Promise.resolve(o) }) as never;
    const ap = await html(await leavePage(sp({ tab: "approvals" })));
    check("Leave › Approval chains renders the per-type chain", ap.includes("How approval works") && ap.includes("Smoke SMKAD") && ap.includes("Reporting manager → HR"));
    const cp = await html(await leavePage(sp({ tab: "compoff" })));
    check("Leave › Comp off renders the grant form and the recent grant", cp.includes("Grant comp-off") && cp.includes("Smoke grant"));
    const hp = await html(await leavePage(sp({ tab: "holidays", cal: calendar.id })));
    check("Leave › Holidays shows the optional quota and picks", /may pick 3 optional holiday/.test(hp) && hp.includes("picked"));
    const tp = await html(await leavePage(sp({ tab: "types" })));
    check("Leave › Types lists the usage limits", tp.includes("max 2/month") && tp.includes("5d gap"));
    const adj = await html(await attPage(sp({ tab: "adjust" })));
    check("Attendance › Adjustments renders the edit, import, allowance and policy tools", adj.includes("Edit a day") && adj.includes("Import LOP days") && adj.includes("SNA") && adj.includes("Smoke depth policy"));
    await signInAs("meera.krishnan@acme.test");
    // My Leave uses CSS modules, which this runner cannot load; check the data its optional-holidays modal shows.
    const mine = await svc.optionalHolidaysFor(meera.id, w5.getUTCFullYear(), today);
    check("My Leave › Optional holidays lists them with what she picked and her quota", mine.holidays.some((h) => h.name === "Smoke Optional Two" && h.picked) &&
      mine.holidays.some((h) => h.name === "Smoke Optional One" && !h.picked) && mine.calendars[0]?.quota === 3, JSON.stringify(mine.calendars));
    check("An employee cannot open Attendance › Adjustments", await denied(() => attPage(sp({ tab: "adjust" }))) || !(await html(await attPage(sp({ tab: "adjust" })))).includes("Edit a day"));
  } finally {
    await cleanup(true);
    await prisma.$disconnect();
  }
  report("Leave and attendance policy depth");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
