/**
 * Time and leave depth: hourly leave, advance leave, encashment on behalf
 * with its policy, comp-off minimum hours and overtime-to-comp-off, remote
 * work rules, regularisation limits, AWOL / new-joiner grace / gross hours,
 * weekly-off patterns, per-day shift timings and auto clock-out, bulk
 * marking, roster CSV import, the web kiosk and the weekly work log. Pages
 * render; permissions and tenant boundaries hold.
 *
 * Works on a throwaway employee (SMK-TLD1) with its own attendance policy,
 * shift (SMKTLD), weekly-off pattern, leave plan and leave types, plus a
 * throwaway rival tenant. Meera's hourly leave, kiosk PIN and work log are
 * removed at the end; the comp-off type's settings are restored.
 */
import { signInAs, setTestHeaders, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient, Prisma } from "@prisma/client";

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
  const { classifyDay, weekStartOf } = await import("@keka/time");
  const timeAct = await import("../apps/web/src/app/actions/time");
  const act = await import("../apps/web/src/app/actions/time-leave-depth");
  const kioskAct = await import("../apps/web/src/app/kiosk/actions");
  const { renderToReadableStream } = await import("react-dom/server");
  const html = async (node: unknown) => {
    const stream = await renderToReadableStream(node as never);
    await stream.allReady;
    return new Response(stream).text();
  };
  const sp = <T,>(v: T) => ({ searchParams: Promise.resolve(v) });
  setTestHeaders({ "x-forwarded-for": "203.0.113.77" });

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "meera.krishnan@acme.test" } });
  const vikram = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "vikram.menon@acme.test" } });
  const priya = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "priya.sharma@acme.test" } });
  const manager = await prisma.employee.findUniqueOrThrow({ where: { id: meera.reportingManagerId! }, include: { user: { select: { email: true } } } });
  const managerEmail = manager.user!.email;
  const comp = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } });
  const compBefore = {
    compOffRequestWindowDays: comp.compOffRequestWindowDays, expiryDaysAfterCredit: comp.expiryDaysAfterCredit,
    compOffHalfDayMinHours: comp.compOffHalfDayMinHours, compOffFullDayMinHours: comp.compOffFullDayMinHours,
  };
  const started = new Date();
  const today = utcToday();

  // Leftovers from an interrupted run.
  await prisma.employee.deleteMany({ where: { tenantId: tenant.id, employeeNumber: "SMK-TLD1" } });
  await prisma.tenant.deleteMany({ where: { subdomain: "rival-tld-smoke" } });
  const cleanupTypes = async () => {
    const types = await prisma.leaveType.findMany({ where: { tenantId: tenant.id, code: { in: ["SMKHR", "SMKAV", "SMKEN"] } }, select: { id: true } });
    const ids = types.map((t) => t.id);
    await prisma.leaveEncashmentRequest.deleteMany({ where: { leaveTypeId: { in: ids } } });
    await prisma.leaveRequest.deleteMany({ where: { leaveTypeId: { in: ids } } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { leaveTypeId: { in: ids } } });
    await prisma.leaveBalance.deleteMany({ where: { leaveTypeId: { in: ids } } });
    await prisma.leaveType.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanupTypes();
  await prisma.leavePlan.deleteMany({ where: { tenantId: tenant.id, name: "Smoke TLD plan" } });
  await prisma.attendanceKiosk.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke kiosk" } } });
  await prisma.shift.deleteMany({ where: { tenantId: tenant.id, code: "SMKTLD" } });
  await prisma.attendancePolicy.deleteMany({ where: { tenantId: tenant.id, name: "Smoke TLD policy" } });
  await prisma.weeklyOffPolicy.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke TLD pattern" } } });

  // --- Fixtures ----------------------------------------------------------------
  const shift = await prisma.shift.create({
    data: { tenantId: tenant.id, name: "Smoke TLD shift", code: "SMKTLD", startTime: "09:00", endTime: "18:00", breakMinutes: 60, maxSlotMinutes: 600 },
  });
  const policy = await prisma.attendancePolicy.create({ data: { tenantId: tenant.id, name: "Smoke TLD policy", noAttendanceIsLop: false, penaltyBufferDays: 0 } });
  const t1 = await prisma.employee.create({
    data: {
      tenantId: tenant.id, employeeNumber: "SMK-TLD1", firstName: "Smoke", lastName: "Depth", displayName: "Smoke Depth",
      dateOfJoining: new Date("2025-01-01T00:00:00Z"), status: "CONFIRMED", reportingManagerId: meera.id,
    },
  });
  const mk = (code: string, extra: Record<string, unknown> = {}) => prisma.leaveType.create({
    data: { tenantId: tenant.id, name: `Smoke ${code}`, code, annualQuota: 0, allowBackdated: true, ...extra },
  });
  const tHR = await mk("SMKHR");
  const tAV = await mk("SMKAV", { annualQuota: 12 });
  const tEN = await mk("SMKEN");
  const plan = await prisma.leavePlan.create({
    data: { tenantId: tenant.id, name: "Smoke TLD plan", types: { create: [tHR, tAV, tEN].map((t) => ({ leaveTypeId: t.id })) } },
  });
  await prisma.leavePlanAssignment.create({ data: { planId: plan.id, employeeId: t1.id, effectiveFrom: new Date("2025-01-01T00:00:00Z") } });
  let weeklyOffId = "";
  let workLogWeekId = "";
  const rival = await prisma.tenant.create({ data: { subdomain: "rival-tld-smoke", name: "Rival TLD" } });

  console.log("\nTime and leave depth\n" + "=".repeat(72));
  try {
    // -------------------------------------------------------------------------
    section("Weekly-off pattern (create/edit, alternate Saturdays)");
    await signInAs("meera.krishnan@acme.test");
    const wNo = await act.saveWeeklyOffPolicy({}, fd({ name: "Smoke TLD pattern", rule_SUN: "ALL" }));
    check("An employee cannot save weekly-off patterns", wNo.ok === false, wNo.message);
    await signInAs("vikram.menon@acme.test");
    const wEmpty = await act.saveWeeklyOffPolicy({}, fd({ name: "Smoke TLD pattern" }));
    check("A pattern with no day off is refused", wEmpty.ok === false, wEmpty.message);
    const wOk = await act.saveWeeklyOffPolicy({}, fd({ name: "Smoke TLD pattern", rule_SUN: "ALL", rule_SAT: "ALT_2_4" }));
    const wRow = await prisma.weeklyOffPolicy.findFirst({ where: { tenantId: tenant.id, name: "Smoke TLD pattern" } });
    weeklyOffId = wRow?.id ?? "";
    const cfg = wRow?.config as Record<string, unknown> | undefined;
    check("An admin creates Sundays off plus 2nd/4th Saturdays", wOk.ok === true && !!cfg?.SUN && !!cfg?.SAT, `${wOk.message} ${JSON.stringify(cfg)}`);
    const wEdit = await act.saveWeeklyOffPolicy({}, fd({ id: weeklyOffId, name: "Smoke TLD pattern", rule_SUN: "ALL", rule_SAT: "ALT_2_4", rule_FRI: "CUSTOM" }));
    check("A custom rule without weeks ticked is refused", wEdit.ok === false, wEdit.message);
    await prisma.employeeTimePolicy.create({
      data: { employeeId: t1.id, attendancePolicyId: policy.id, shiftId: shift.id, weeklyOffPolicyId: weeklyOffId, effectiveFrom: new Date("2025-01-01T00:00:00Z") },
    });
    const ret = await act.retireWeeklyOffPolicy({}, fd({ id: weeklyOffId }));
    check("A pattern someone is on cannot be retired", ret.ok === false && /employee/.test(ret.message ?? ""), ret.message);

    // Working days for the throwaway employee, past and future.
    const t1Policy = await svc.resolveTimePolicy(t1.id, today);
    const kind = (d: Date) => classifyDay(d, t1Policy.calendar);
    const W: Date[] = [];
    for (let i = 45; i >= 1; i--) { const d = addDays(today, -i); if (kind(d) === "WORKING") W.push(d); }
    const F: Date[] = [];
    for (let i = 1; i <= 50; i++) { const d = addDays(today, i); if (kind(d) === "WORKING") F.push(d); }
    const pastSunday = [...Array(20).keys()].map((i) => addDays(today, -i - 1)).find((d) => d.getUTCDay() === 0 && kind(d) === "WEEKLY_OFF")!;
    const saturdays = [...Array(35).keys()].map((i) => addDays(today, -i - 1)).filter((d) => d.getUTCDay() === 6);
    check("The pattern makes some Saturdays working and some off", saturdays.some((d) => kind(d) === "WORKING") && saturdays.some((d) => kind(d) === "WEEKLY_OFF"));
    if (W.length < 14 || F.length < 12) throw new Error("Not enough working days around today for this test.");

    // -------------------------------------------------------------------------
    section("General attendance settings");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change attendance rules", await denied(() => act.saveAttendanceRules({}, fd({ id: policy.id, hoursBasis: "GROSS", awolAfterDays: 3, newJoinerGraceDays: 0, overtimeCompOffHoursPerDay: 8 }))));
    await signInAs("vikram.menon@acme.test");
    const rules = (o: Record<string, string | number | boolean>) => act.saveAttendanceRules({}, fd({
      id: policy.id, hoursBasis: "EFFECTIVE", awolAfterDays: 3, newJoinerGraceDays: 0, overtimeCompOffHoursPerDay: 8, ...o,
    }));
    const r1 = await rules({ awolEnabled: true });
    check("An admin saves the rules", r1.ok === true && (await prisma.attendancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).awolEnabled, r1.message);
    const rRival = await act.saveAttendanceRules({}, fd({ id: (await prisma.attendancePolicy.create({ data: { tenantId: rival.id, name: "Rival policy" } })).id, hoursBasis: "GROSS", awolAfterDays: 3, newJoinerGraceDays: 0, overtimeCompOffHoursPerDay: 8 }));
    check("Another tenant's policy is not found", rRival.ok === false, rRival.message);

    // -------------------------------------------------------------------------
    section("AWOL: a run of no-shows is absent without leave");
    await svc.processAttendance({ employeeIds: [t1.id], from: W[0], to: W[2] });
    let recs = await prisma.attendanceRecord.findMany({ where: { employeeId: t1.id, date: { in: [W[0], W[1], W[2]] } } });
    check("Three working days with no attendance are each ABSENT and full LOP",
      recs.length === 3 && recs.every((r) => r.status === "ABSENT" && Number(r.lopValue) === 1 && /Absent without leave/.test(r.penaltyReason ?? "")),
      recs.map((r) => `${key(r.date)} ${r.status} ${r.lopValue} ${r.penaltyReason}`).join(" | "));
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[3], "09:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[3], "18:00"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[3], to: W[3] });
    check("…a day worked after it is present", (await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: W[3] } } })).status === "PRESENT");
    await rules({ awolEnabled: false });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[0], to: W[2] });
    recs = await prisma.attendanceRecord.findMany({ where: { employeeId: t1.id, date: { in: [W[0], W[1], W[2]] } } });
    check("With AWOL off (and no LOP for no attendance) those days are no attendance again", recs.every((r) => r.status === "NO_ATTENDANCE" && Number(r.lopValue) === 0), recs.map((r) => r.status).join(","));

    // -------------------------------------------------------------------------
    section("Gross vs effective hours");
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[4], "09:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[4], "11:00"), direction: 1, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[4], "14:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[4], "18:00"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[4], to: W[4] });
    const rec4 = () => prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: W[4] } } });
    check("On effective hours, 6h in a 9h span of an 8h shift is a half day", (await rec4()).status === "HALF_DAY", (await rec4()).status);
    await rules({ hoursBasis: "GROSS" });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[4], to: W[4] });
    check("On gross hours the same day is present", (await rec4()).status === "PRESENT", (await rec4()).status);
    await rules({});

    // -------------------------------------------------------------------------
    section("Shift per-day timings");
    const wd = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][W[6].getUTCDay()];
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[6], "09:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[6], "13:00"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[6], to: W[6] });
    const rec6 = () => prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: W[6] } } });
    check("Four hours on a normal day is a half day", (await rec6()).status === "HALF_DAY", (await rec6()).status);
    await prisma.shift.update({ where: { id: shift.id }, data: { daySchedule: { [wd]: { startTime: "09:00", endTime: "13:00", breakMinutes: 0 } } } });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[6], to: W[6] });
    check(`With ${wd} set to 09:00–13:00, the same four hours are a full day`, (await rec6()).status === "PRESENT", (await rec6()).status);
    await prisma.shift.update({ where: { id: shift.id }, data: { daySchedule: Prisma.DbNull } });

    // -------------------------------------------------------------------------
    section("Hourly leave");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change leave type rules", await denied(() => act.saveLeaveTypeRules({}, fd({ id: tHR.id, unit: "HOURS" }))));
    await signInAs("vikram.menon@acme.test");
    const hr = await act.saveLeaveTypeRules({}, fd({ id: tHR.id, unit: "HOURS", hoursPerDay: 8, minHoursPerRequest: 1, maxHoursPerDay: 4, hourIncrementMinutes: 30 }));
    const tHRrow = await prisma.leaveType.findUniqueOrThrow({ where: { id: tHR.id } });
    check("An admin makes a leave type hourly (1–4 h, 30-minute steps)", hr.ok === true && tHRrow.unit === "HOURS" && Number(tHRrow.maxHoursPerDay) === 4, hr.message);
    const hrBad = await act.saveLeaveTypeRules({}, fd({ id: tHR.id, unit: "HOURS", hoursPerDay: 8, minHoursPerRequest: 5, maxHoursPerDay: 4, hourIncrementMinutes: 30 }));
    check("A minimum above the maximum is refused", hrBad.ok === false, hrBad.message);
    await svc.adjustBalance({ employeeId: t1.id, leaveTypeId: tHR.id, days: 16, note: "Smoke opening hours" });
    const big = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tHR.id, from: W[5], to: W[5], hours: 5, startTime: "10:00", reason: "Smoke" });
    check("More than the daily maximum of hours is refused", big.ok === false, JSON.stringify(big.issues));
    const step = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tHR.id, from: W[5], to: W[5], hours: 1.25, startTime: "10:00", reason: "Smoke" });
    check("Hours off the 30-minute step are refused", step.ok === false, JSON.stringify(step.issues));
    const span = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tHR.id, from: W[5], to: W[6], hours: 2, startTime: "10:00", reason: "Smoke" });
    check("Hourly leave over more than one date is refused", span.ok === false);
    const hOk = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tHR.id, from: W[5], to: W[5], hours: 2, startTime: "16:00", reason: "Smoke hourly" });
    const hReq = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: t1.id, leaveTypeId: tHR.id }, include: { days: true } });
    check("Two hours are applied on one date and stored in hours", hOk.ok === true && Number(hReq.hours) === 2 && hReq.startTime === "16:00" && Number(hReq.totalDays) === 2, JSON.stringify(hOk));
    check("…the day carries a quarter-day value", hReq.days.length === 1 && Number(hReq.days[0].dayValue) === 0.25, String(hReq.days[0]?.dayValue));
    const hDec = await svc.decideLeave({ requestId: hReq.id, decision: "APPROVE", approverEmployeeId: meera.id });
    const used = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: hReq.id, kind: "USED" } });
    check("Approval debits two hours from the balance", hDec.ok === true && Number(used?.days) === -2, hDec.message);
    const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: t1.id, leaveTypeId: tHR.id } });
    check("…leaving 14 hours", Number(bal?.available) === 14, JSON.stringify(bal));
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[5], "09:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(W[5], "15:00"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: W[5], to: W[5] });
    const rec5 = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: W[5] } } });
    check("Six hours worked plus two hours of leave is a full day", rec5.status === "PRESENT", `${rec5.status} ${rec5.remark}`);
    const unit = await act.saveLeaveTypeRules({}, fd({ id: tHR.id, unit: "DAYS" }));
    check("A type with history cannot switch back to days", unit.ok === false && /history|already/.test(unit.message ?? ""), unit.message);

    // Through the form, as an employee.
    const mDay = F.find((d) => d.getTime() > addDays(today, 3).getTime())!;
    await svc.adjustBalance({ employeeId: meera.id, leaveTypeId: tHR.id, days: 8, note: "Smoke opening hours" });
    await signInAs("meera.krishnan@acme.test");
    const fa = await timeAct.applyLeaveAction({}, fd({ leaveTypeId: tHR.id, fromDate: key(mDay), hours: "3", startTime: "14:00", reason: "Smoke hourly form", intent: "apply" }));
    check("An employee applies hourly leave through the form (no end date)", fa.ok === true && /hour/.test(fa.message ?? ""), fa.message);
    let mReq = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: meera.id, leaveTypeId: tHR.id } });
    await signInAs(managerEmail);
    await timeAct.decideLeaveAction({}, fd({ requestId: mReq.id, decision: "approve" }));
    mReq = await prisma.leaveRequest.findFirstOrThrow({ where: { id: mReq.id } });
    if (mReq.status === "PENDING") { await signInAs("priya.sharma@acme.test"); await timeAct.decideLeaveAction({}, fd({ requestId: mReq.id, decision: "approve" })); }
    mReq = await prisma.leaveRequest.findFirstOrThrow({ where: { id: mReq.id } });
    const mUsed = await prisma.leaveLedgerEntry.findFirst({ where: { requestId: mReq.id, kind: "USED" } });
    check("…approved, three hours are used", mReq.status === "APPROVED" && Number(mUsed?.days) === -3, `${mReq.status} ${mUsed?.days}`);

    // -------------------------------------------------------------------------
    section("Advance leave");
    await signInAs("vikram.menon@acme.test");
    const adBad = await act.saveLeaveTypeRules({}, fd({ id: tAV.id, unit: "DAYS", allowAdvanceLeave: true }));
    check("Advance leave without a limit is refused", adBad.ok === false, adBad.message);
    const ad = await act.saveLeaveTypeRules({}, fd({ id: tAV.id, unit: "DAYS", allowAdvanceLeave: true, advanceLeaveMaxDays: 3 }));
    check("An admin allows up to 3 days in advance", ad.ok === true && (await prisma.leaveType.findUniqueOrThrow({ where: { id: tAV.id } })).allowAdvanceLeave, ad.message);
    await svc.adjustBalance({ employeeId: t1.id, leaveTypeId: tAV.id, days: 1, note: "Smoke opening" });
    const i3 = F.findIndex((d, i) => i + 2 < F.length && F[i + 2].getTime() - d.getTime() === 2 * DAY && d.getTime() > addDays(today, 5).getTime());
    const av1 = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tAV.id, from: F[i3], to: F[i3 + 2], reason: "Smoke advance" });
    check("Three days on a balance of one is allowed, two of them in advance", av1.ok === true && Number(av1.advanceDays) === 2, JSON.stringify(av1));
    const avReq = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: t1.id, leaveTypeId: tAV.id } });
    check("…the request records the advance", Number(avReq.advanceDays) === 2, String(avReq.advanceDays));
    await svc.decideLeave({ requestId: avReq.id, decision: "APPROVE", approverEmployeeId: meera.id });
    const nextFree = F.find((d) => d.getTime() > F[i3 + 2].getTime())!;
    const av2 = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tAV.id, from: nextFree, to: nextFree, reason: "Smoke advance 2" });
    const av2b = await svc.applyLeave({ employeeId: t1.id, leaveTypeId: tAV.id, from: F[F.length - 2], to: F[F.length - 1], reason: "Smoke advance 3" });
    check("Going past the advance limit is refused", av2.ok === true && av2b.ok === false, `${JSON.stringify(av2.issues)} / ${JSON.stringify(av2b.issues)}`);

    // -------------------------------------------------------------------------
    section("Encashment on behalf and the encashment policy");
    const otherMonth = ((today.getUTCMonth() + 6) % 12) + 1;
    const thisMonth = today.getUTCMonth() + 1;
    const enc = (months: number) => act.saveLeaveTypeRules({}, fd({ id: tEN.id, unit: "DAYS", encashmentEnabled: true, encashmentMinBalance: 2, encashmentMaxDaysPerYear: 5, encashmentMonths: months }));
    const e1 = await enc(otherMonth);
    const tENrow = await prisma.leaveType.findUniqueOrThrow({ where: { id: tEN.id } });
    check("An admin sets the window, minimum balance and yearly cap", e1.ok === true && tENrow.encashmentMonths.join() === String(otherMonth) && Number(tENrow.encashmentMinBalance) === 2, e1.message);
    await svc.adjustBalance({ employeeId: t1.id, leaveTypeId: tEN.id, days: 6, note: "Smoke opening" });
    await signInAs("priya.sharma@acme.test");
    const eWin = await act.encashOnBehalfAction({}, fd({ employeeId: t1.id, leaveTypeId: tEN.id, days: 2 }));
    check("Outside the encashment months it is refused", eWin.ok === false, eWin.message);
    await signInAs("vikram.menon@acme.test");
    await enc(thisMonth);
    await signInAs("priya.sharma@acme.test");
    const eBig = await act.encashOnBehalfAction({}, fd({ employeeId: t1.id, leaveTypeId: tEN.id, days: 5 }));
    check("Encashing into the 2-day minimum balance is refused", eBig.ok === false, eBig.message);
    const eOk = await act.encashOnBehalfAction({}, fd({ employeeId: t1.id, leaveTypeId: tEN.id, days: 3, note: "Smoke on behalf" }));
    const eReq = await prisma.leaveEncashmentRequest.findFirst({ where: { employeeId: t1.id, leaveTypeId: tEN.id } });
    check("HR encashes 3 days on the employee's behalf", eOk.ok === true && Number(eReq?.days) === 3 && eReq?.requestedBy === priya.id, `${eOk.message} ${eReq?.requestedBy}`);
    const self = await svc.raiseEncashmentRequest({ employeeId: t1.id, leaveTypeId: tEN.id, days: 1 });
    check("The employee cannot raise it themselves when only on-behalf is allowed", self.ok === false, self.message);
    await signInAs("deepak.chauhan@acme.test");
    const eNo = await act.encashOnBehalfAction({}, fd({ employeeId: t1.id, leaveTypeId: tEN.id, days: 1 }));
    check("Someone without leave rights cannot", eNo.ok === false, eNo.message);

    // -------------------------------------------------------------------------
    section("Comp-off settings and overtime to comp-off");
    await signInAs("vikram.menon@acme.test");
    const cBad = await act.saveCompOffSettings({}, fd({ id: comp.id, compOffRequestWindowDays: 30, expiryDaysAfterCredit: 60, compOffHalfDayMinHours: 6, compOffFullDayMinHours: 3 }));
    check("Half-day hours at or above full-day hours are refused", cBad.ok === false, cBad.message);
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(pastSunday, "09:00"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(pastSunday, "15:30"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: pastSunday, to: pastSunday });
    const before = (await svc.compOffEligibleDays(t1.id)).find((d) => d.key === key(pastSunday));
    const cOk = await act.saveCompOffSettings({}, fd({ id: comp.id, compOffRequestWindowDays: 30, expiryDaysAfterCredit: 60, compOffHalfDayMinHours: 3, compOffFullDayMinHours: 6 }));
    const after = (await svc.compOffEligibleDays(t1.id)).find((d) => d.key === key(pastSunday));
    check("An admin sets comp-off window, expiry and minimum hours", cOk.ok === true, cOk.message);
    check("6.5h on a weekly off earns a half day by percentage, a full day with a 6h minimum", before?.credit === 0.5 && after?.credit === 1, `${before?.credit} → ${after?.credit}`);

    await rules({ overtimeToCompOff: true, overtimeCompOffHoursPerDay: 8 });
    const otSmall = await prisma.overtimeRequest.create({ data: { tenantId: tenant.id, employeeId: t1.id, fromDate: W[3], toDate: W[3], requestedMinutes: 120 } });
    const ot = await prisma.overtimeRequest.create({ data: { tenantId: tenant.id, employeeId: t1.id, fromDate: W[3], toDate: W[3], requestedMinutes: 480 } });
    const os = await svc.decideOvertimeRequest({ requestId: otSmall.id, decision: "APPROVE", deciderEmployeeId: vikram.id });
    check("Two hours of overtime is too little for a comp-off half day", os.ok === false, os.message);
    const oo = await svc.decideOvertimeRequest({ requestId: ot.id, decision: "APPROVE", deciderEmployeeId: vikram.id });
    const credit = await prisma.leaveLedgerEntry.findFirst({ where: { employeeId: t1.id, periodKey: `COMPOFF-OT:${ot.id}` } });
    check("Eight hours of overtime become one comp-off day instead of pay", oo.ok === true && Number(credit?.days) === 1 && credit?.leaveTypeId === comp.id, oo.message);
    check("…and no overtime pay entry is made", (await prisma.overtimeEntry.count({ where: { employeeId: t1.id } })) === 0);
    await rules({});

    // -------------------------------------------------------------------------
    section("Remote work rules");
    const notice = Math.round((F[0].getTime() - today.getTime()) / DAY) + 1;
    await rules({ wfhMonthlyLimit: 1, remoteNoticeDays: notice, remoteAttachmentRequired: true });
    const raise = (from: Date, type: "WORK_FROM_HOME" | "ON_DUTY" = "WORK_FROM_HOME") => svc.raiseAttendanceRequest({ employeeId: t1.id, type, from, to: from, reason: "Smoke remote", today });
    const rn = await raise(F[0]);
    check("Too little notice is refused", rn.ok === false && /notice/.test(rn.message), rn.message);
    const later = F.filter((d) => (d.getTime() - today.getTime()) / DAY >= notice);
    const pair = later.findIndex((d, i) => i + 1 < later.length && key(later[i + 1]).slice(0, 7) === key(d).slice(0, 7));
    const ra = await raise(later[pair]);
    check("A missing supporting document is refused", ra.ok === false && /document/.test(ra.message), ra.message);
    await rules({ wfhMonthlyLimit: 1, remoteNoticeDays: notice });
    const ok1 = await raise(later[pair]);
    check("Within the rules it is accepted", ok1.ok === true, ok1.message);
    const lim = await raise(later[pair + 1]);
    check("A second day in the month passes the monthly limit of one", lim.ok === false && /limited to 1/.test(lim.message), lim.message);
    const odOk = await raise(later[pair + 1], "ON_DUTY");
    check("…on duty has its own allowance", odOk.ok === true, odOk.message);
    const futureSunday = [...Array(30).keys()].map((i) => addDays(today, notice + i)).find((d) => kind(d) === "WEEKLY_OFF")!;
    const wo = await raise(futureSunday, "ON_DUTY");
    check("Remote work on a weekly off is refused", wo.ok === false && /weekly off/.test(wo.message), wo.message);
    await rules({});

    // -------------------------------------------------------------------------
    section("Regularisation limit and cut-off");
    const reg = (d: Date) => svc.raiseAttendanceRequest({ employeeId: t1.id, type: "REGULARISATION", from: d, to: d, reason: "Smoke regularise", today });
    const prevMonthDay = [...W].reverse().find((d) => d.getUTCMonth() !== today.getUTCMonth());
    if (prevMonthDay && today.getUTCDate() > 1) {
      await rules({ regularisationCutoffDay: 1 });
      const rc = await reg(prevMonthDay);
      check("After the cut-off day, last month's days cannot be corrected", rc.ok === false && /closed on/.test(rc.message), rc.message);
    }
    await rules({ regularisationMonthlyLimit: 1 });
    const recent = [...W].reverse();
    const j = recent.findIndex((d, i) => i + 1 < recent.length && recent[i + 1].getUTCMonth() === d.getUTCMonth() && (today.getTime() - recent[i + 1].getTime()) / DAY < 28);
    const g1 = await reg(recent[j]);
    const g2 = await reg(recent[j + 1]);
    check("One correction a month is allowed, the second refused", g1.ok === true && g2.ok === false && /used all 1/.test(g2.message), `${g1.message} / ${g2.message}`);
    await rules({});

    // -------------------------------------------------------------------------
    section("Bulk marking");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot bulk mark attendance", await denied(() => act.bulkMarkAttendanceAction({}, fd({ employeeIds: t1.id, fromDate: key(W[7]), toDate: key(W[8]), status: "PRESENT", reason: "Smoke" }))));
    await signInAs("vikram.menon@acme.test");
    const bm = await act.bulkMarkAttendanceAction({}, fd({ employeeIds: t1.id, fromDate: key(W[7]), toDate: key(W[8]), status: "ON_DUTY", reason: "Smoke bulk", workingDaysOnly: true }));
    const marked = await prisma.attendanceRecord.findMany({ where: { employeeId: t1.id, date: { gte: W[7], lte: W[8] }, manualStatus: { not: null } } });
    check("An admin marks a range on duty, working days only", bm.ok === true && marked.length === 2 && marked.every((m) => m.manualStatus === "ON_DUTY"), `${bm.message} (${marked.length})`);
    const bmFuture = await act.bulkMarkAttendanceAction({}, fd({ employeeIds: t1.id, fromDate: key(F[0]), toDate: key(F[0]), status: "PRESENT", reason: "Smoke" }));
    check("Future days cannot be marked", bmFuture.ok === false, bmFuture.message);

    // -------------------------------------------------------------------------
    section("Roster CSV import");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot import a roster", await denied(() => act.importRosterAction({}, fd({ csv: "x", intent: "check" }))));
    await prisma.employee.create({ data: { tenantId: rival.id, employeeNumber: "SMK-RIV1", firstName: "Rival", lastName: "Person", dateOfJoining: new Date("2025-01-01T00:00:00Z"), status: "CONFIRMED" } });
    await signInAs("vikram.menon@acme.test");
    const csvBad = `employee_number,date,shift_code\nSMK-TLD1,${key(W[9])},SMKTLD\nSMK-RIV1,${key(W[9])},SMKTLD\nSMK-TLD1,31-02-2026,SMKTLD\nSMK-TLD1,${key(W[10])},NOPE`;
    const ck = await act.importRosterAction({}, fd({ csv: csvBad, intent: "apply" }));
    check("Bad rows (another tenant's employee, bad date, unknown shift) stop the import", ck.ok === false && /SMK-RIV1/.test(ck.message ?? "") && /NOPE/.test(ck.message ?? ""), ck.message);
    check("…and nothing is written", (await prisma.shiftAssignment.count({ where: { employeeId: t1.id } })) === 0);
    const csvOk = `employee_number,date,shift_code\nSMK-TLD1,${key(W[9])},SMKTLD\nSMK-TLD1,${key(W[10])},WO`;
    const chk = await act.importRosterAction({}, fd({ csv: csvOk, intent: "check" }));
    check("A clean file checks out without writing", chk.ok === true && (await prisma.shiftAssignment.count({ where: { employeeId: t1.id } })) === 0, chk.message);
    const ap = await act.importRosterAction({}, fd({ csv: csvOk, intent: "apply" }));
    const sa = await prisma.shiftAssignment.findMany({ where: { employeeId: t1.id }, orderBy: { date: "asc" } });
    check("Applying it rosters the shift and a weekly off", ap.ok === true && sa.length === 2 && sa[0].shiftId === shift.id && sa[1].weeklyOffCode === "WO", ap.message);
    check("…the rostered weekly off is reprocessed as one", (await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: t1.id, date: W[10] } } }))?.status === "WEEKLY_OFF");

    // -------------------------------------------------------------------------
    section("Auto clock-out");
    const openIn = new Date(Date.now() - 20 * 3_600_000);
    // Earlier sections punch at fixed local times; depending on the hour this runs, one of
    // them can fall after openIn and become the last punch. Clear those so the open IN is last.
    await prisma.attendanceLog.deleteMany({ where: { tenantId: tenant.id, employeeId: t1.id, timestamp: { gt: openIn, lte: new Date() } } });
    await prisma.attendanceLog.create({ data: { tenantId: tenant.id, employeeId: t1.id, timestamp: openIn, direction: 0, source: "MANUAL" } });
    const ac = await svc.runAutoClockOut(tenant.id);
    const out = await prisma.attendanceLog.findFirst({ where: { employeeId: t1.id, direction: 1, timestamp: { gt: openIn } } });
    check("A punch left open past the shift's 600 minutes is closed at IN + 10h", ac.closed >= 1 && out?.timestamp.getTime() === openIn.getTime() + 600 * 60_000, JSON.stringify(ac));
    const ac2 = await svc.runAutoClockOut(tenant.id);
    check("…and running it again changes nothing for them", (await prisma.attendanceLog.count({ where: { employeeId: t1.id, direction: 1, timestamp: { gt: openIn } } })) === 1, JSON.stringify(ac2));

    // -------------------------------------------------------------------------
    section("Web kiosk");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a kiosk", await denied(() => act.createKioskAction({}, fd({ name: "Smoke kiosk", pin: "4826" }))));
    await signInAs("vikram.menon@acme.test");
    const kWeak = await act.createKioskAction({}, fd({ name: "Smoke kiosk", pin: "1111" }));
    check("A weak kiosk PIN is refused", kWeak.ok === false, kWeak.message);
    const kOk = await act.createKioskAction({}, fd({ name: "Smoke kiosk", pin: "4826" }));
    const kiosk = await prisma.attendanceKiosk.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke kiosk" } });
    check("An admin creates a kiosk with a PIN (stored hashed)", kOk.ok === true && kiosk.pinHash !== "4826" && kiosk.token.length >= 24, kOk.message);
    const rivalKiosk = await prisma.attendanceKiosk.create({ data: { tenantId: rival.id, name: "Rival kiosk", token: `rival-${Date.now()}-tld-smoke-token`, pinHash: svc.hashPin("4826") } });
    const kRival = await act.updateKioskAction({}, fd({ id: rivalKiosk.id, op: "toggle" }));
    check("Another tenant's kiosk cannot be changed", kRival.ok === false, kRival.message);

    const u1 = await kioskAct.unlockKioskAction({}, fd({ token: kiosk.token, pin: "0000" }));
    check("The device does not unlock with a wrong kiosk PIN", u1.ok === false, u1.message);
    const p0 = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "2468" }));
    check("A locked device cannot take punches", p0.ok === false && /locked/.test(p0.message ?? ""), p0.message);
    const u2 = await kioskAct.unlockKioskAction({}, fd({ token: kiosk.token, pin: "4826" }));
    check("…and unlocks with the right one", u2.ok === true, u2.message);
    const noPin = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "2468" }));
    check("An employee without a kiosk PIN is told to set one", noPin.ok === false && /not set a kiosk PIN/.test(noPin.message ?? ""), noPin.message);
    await svc.setKioskPin(t1.id, "2468");
    const pIn = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "smk-tld1", pin: "2468" }));
    const pOut = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "2468" }));
    const kLogs = await prisma.attendanceLog.findMany({ where: { employeeId: t1.id, source: "KIOSK" }, orderBy: { timestamp: "asc" } });
    check("Employee number and PIN clock in, then out", pIn.ok === true && /Clocked in/.test(pIn.message ?? "") && pOut.ok === true && /Clocked out/.test(pOut.message ?? ""), `${pIn.message} / ${pOut.message}`);
    check("…recorded as kiosk punches from that kiosk", kLogs.length === 2 && kLogs.every((l) => l.deviceId === kiosk.id));
    await prisma.kioskPin.create({ data: { tenantId: rival.id, employeeId: (await prisma.employee.findFirstOrThrow({ where: { tenantId: rival.id } })).id, pinHash: svc.hashPin("2468") } });
    const pRival = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-RIV1", pin: "2468" }));
    check("Another tenant's employee cannot punch at this kiosk", pRival.ok === false, pRival.message);
    for (let i = 0; i < 5; i++) await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "9753" }));
    const locked = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "2468" }));
    check("Five wrong PINs lock the employee's kiosk PIN", locked.ok === false && /Too many wrong PINs/.test(locked.message ?? ""), locked.message);
    const off = await act.updateKioskAction({}, fd({ id: kiosk.id, op: "toggle" }));
    const pOff = await kioskAct.kioskPunchAction({}, fd({ token: kiosk.token, employeeNumber: "SMK-TLD1", pin: "2468" }));
    check("A switched-off kiosk takes no punches", off.ok === true && pOff.ok === false, pOff.message);
    await act.updateKioskAction({}, fd({ id: kiosk.id, op: "toggle" }));
    await act.updateKioskAction({}, fd({ id: kiosk.id, op: "rotate" }));
    check("A new link retires the old one", (await svc.kioskByToken(kiosk.token)) === null);
    const newToken = (await prisma.attendanceKiosk.findUniqueOrThrow({ where: { id: kiosk.id } })).token;

    // Meera sets her own PIN; an admin clears it.
    await signInAs("meera.krishnan@acme.test");
    const mp1 = await act.setMyKioskPinAction({}, fd({ pin: "1234", confirm: "1234" }));
    const mp2 = await act.setMyKioskPinAction({}, fd({ pin: "5829", confirm: "5830" }));
    const mp3 = await act.setMyKioskPinAction({}, fd({ pin: "5829", confirm: "5829" }));
    check("An employee sets a kiosk PIN (running sequences and mismatches refused)", mp1.ok === false && mp2.ok === false && mp3.ok === true && !!(await prisma.kioskPin.findUnique({ where: { employeeId: meera.id } })), `${mp1.message} / ${mp3.message}`);
    check("An employee cannot clear someone's PIN", await denied(() => act.resetKioskPinAction({}, fd({ employeeId: t1.id }))));
    await signInAs("vikram.menon@acme.test");
    const rs = await act.resetKioskPinAction({}, fd({ employeeId: meera.id }));
    check("An admin clears it", rs.ok === true && !(await prisma.kioskPin.findUnique({ where: { employeeId: meera.id } })), rs.message);

    // -------------------------------------------------------------------------
    section("Work log");
    const wk = weekStartOf(addDays(today, -7));
    const days = [...Array(7).keys()].map((i) => addDays(wk, i));
    const logForm = (hours: string[], intent: "save" | "submit") => {
      const f = new FormData();
      f.set("weekStart", key(wk)); f.set("intent", intent);
      days.forEach((d, i) => { f.append("date", key(d)); f.append("hours", hours[i]); f.append("notes", i < 5 ? `Smoke day ${i + 1}` : ""); });
      return f;
    };
    await signInAs("meera.krishnan@acme.test");
    const wBad = await act.saveWorkLogAction({}, logForm(["25", "8", "8", "8", "8", "0", "0"], "save"));
    check("More than 24 hours in a day is refused", wBad.ok === false, wBad.message);
    const wq = await act.saveWorkLogAction({}, logForm(["7.3", "8", "8", "8", "8", "0", "0"], "save"));
    check("Hours must be in quarter hours", wq.ok === false, wq.message);
    const wDraft = await act.saveWorkLogAction({}, logForm(["8", "8", "7.5", "8", "8", "0", "0"], "save"));
    let week = await prisma.workLogWeek.findUnique({ where: { employeeId_weekStart: { employeeId: meera.id, weekStart: wk } }, include: { days: true } });
    workLogWeekId = week?.id ?? "";
    check("An employee saves a week as a draft", wDraft.ok === true && week?.status === "DRAFT" && Number(week.totalHours) === 39.5 && week.days.length === 5, wDraft.message);
    const wSub = await act.saveWorkLogAction({}, logForm(["8", "8", "8", "8", "8", "0", "0"], "submit"));
    week = await prisma.workLogWeek.findUnique({ where: { id: workLogWeekId }, include: { days: true } });
    check("…and submits it", wSub.ok === true && week?.status === "SUBMITTED" && Number(week.totalHours) === 40, wSub.message);
    const wEditAfter = await act.saveWorkLogAction({}, logForm(["1", "8", "8", "8", "8", "0", "0"], "save"));
    check("A submitted week cannot be edited", wEditAfter.ok === false, wEditAfter.message);
    const wSelf = await act.decideWorkLogAction({}, fd({ weekId: workLogWeekId, decision: "approve" }));
    check("An employee cannot approve their own week", wSelf.ok === false, wSelf.message);
    await signInAs("deepak.chauhan@acme.test");
    const wOther = await act.decideWorkLogAction({}, fd({ weekId: workLogWeekId, decision: "approve" }));
    const deepak = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "deepak.chauhan@acme.test" } });
    if (deepak.id !== meera.reportingManagerId) check("Someone who is not their manager cannot approve it", wOther.ok === false, wOther.message);
    await signInAs(managerEmail);
    const wRej = await act.decideWorkLogAction({}, fd({ weekId: workLogWeekId, decision: "reject" }));
    check("Sending back needs a reason", wRej.ok === false, wRej.message);
    const wApp = await act.decideWorkLogAction({}, fd({ weekId: workLogWeekId, decision: "approve", note: "Fine" }));
    week = await prisma.workLogWeek.findUnique({ where: { id: workLogWeekId }, include: { days: true } });
    check("The manager approves it", wApp.ok === true && week?.status === "APPROVED" && week.decidedBy === manager.id, wApp.message);
    const wFuture = await svc.saveWorkLog({ employeeId: meera.id, weekStart: addDays(today, 8), days: [] });
    check("A week that has not started cannot be logged", wFuture.ok === false, wFuture.message);

    // -------------------------------------------------------------------------
    section("New-joiner grace (last: moves the joining date)");
    const gDay = W[W.length - 1];
    await prisma.attendanceLog.createMany({ data: [
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(gDay, "10:30"), direction: 0, source: "MANUAL" },
      { tenantId: tenant.id, employeeId: t1.id, timestamp: ist(gDay, "19:30"), direction: 1, source: "MANUAL" },
    ] });
    await svc.processAttendance({ employeeIds: [t1.id], from: gDay, to: gDay });
    const g0 = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: gDay } } });
    check("Arriving 90 minutes late is noted as late", /Late by/.test(g0.remark ?? ""), g0.remark ?? "");
    await prisma.employee.update({ where: { id: t1.id }, data: { dateOfJoining: gDay } });
    await signInAs("vikram.menon@acme.test");
    await rules({ newJoinerGraceDays: 5 });
    await svc.processAttendance({ employeeIds: [t1.id], from: gDay, to: gDay });
    const g1r = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: t1.id, date: gDay } } });
    check("In a new joiner's first days the late arrival carries no penalty", /New-joiner grace/.test(g1r.remark ?? ""), g1r.remark ?? "");

    // -------------------------------------------------------------------------
    section("Pages render");
    const settings = (await import("../apps/web/src/app/(app)/time/settings/page")).default;
    await signInAs("vikram.menon@acme.test");
    const tabs: Array<[string, RegExp]> = [
      ["leave", /Smoke SMKHR/], ["compoff", /half day/i], ["encash", /behalf/i], ["rules", /Smoke TLD policy/],
      ["weekly-offs", /Smoke TLD pattern/], ["bulk", /reason/i], ["roster", /shift code/i], ["kiosks", /Smoke kiosk/],
    ];
    for (const [tab, re] of tabs) {
      const page = await html(await settings(sp({ tab, policy: policy.id })));
      check(`Time settings › ${tab} renders for an admin`, re.test(page) && !/Keka/.test(page), tab);
    }
    const wlPage = (await import("../apps/web/src/app/(app)/me/work-log/page")).default;
    await signInAs("meera.krishnan@acme.test");
    const wl = await html(await wlPage(sp({ week: key(wk) })));
    check("Work log renders the employee's week", /Week of/.test(wl) && /approved/i.test(wl));
    await signInAs(managerEmail);
    const wlTeam = await html(await wlPage(sp({ view: "team" })));
    check("…and the manager's approval list", /Submitted work logs/.test(wlTeam));
    const meAtt = (await import("../apps/web/src/app/(app)/me/attendance/page")).default;
    await signInAs("meera.krishnan@acme.test");
    const ma = await html(await meAtt(sp({})));
    check("Me › Attendance links the kiosk PIN and the work log", /Kiosk PIN/.test(ma) && /href="\/me\/work-log"/.test(ma));
    const { KioskPinForm } = await import("../apps/web/src/app/(app)/_time/depth-forms");
    const React = await import("react");
    const pf = await html(React.createElement(KioskPinForm, { hasPin: false }));
    check("…and the PIN form renders", /name="pin"/.test(pf) && /name="confirm"/.test(pf));
    check("An employee cannot open time settings", await denied(() => settings(sp({ tab: "kiosks" }))) || !/Smoke kiosk/.test(await html(await settings(sp({ tab: "kiosks" })))));
    const kPage = (await import("../apps/web/src/app/kiosk/[token]/page")).default;
    const kp = await html(await kPage({ params: Promise.resolve({ token: newToken }) }));
    check("The kiosk page renders for a valid link", /Smoke kiosk/.test(kp) && /BooS-HR/.test(kp));
    const kBad = await html(await kPage({ params: Promise.resolve({ token: "not-a-real-token" }) }));
    check("…and says so for an invalid one", /not valid/.test(kBad));
  } finally {
    // --- Cleanup -------------------------------------------------------------
    if (workLogWeekId) await prisma.workLogWeek.deleteMany({ where: { id: workLogWeekId } });
    await prisma.kioskPin.deleteMany({ where: { employeeId: meera.id } });
    await prisma.employee.deleteMany({ where: { id: t1.id } });
    await cleanupTypes();
    await prisma.leavePlan.deleteMany({ where: { id: plan.id } });
    await prisma.attendanceKiosk.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke kiosk" } } });
    await prisma.shift.deleteMany({ where: { id: shift.id } });
    await prisma.attendancePolicy.deleteMany({ where: { id: policy.id } });
    if (weeklyOffId) await prisma.weeklyOffPolicy.deleteMany({ where: { id: weeklyOffId } });
    await prisma.leaveType.update({ where: { id: comp.id }, data: compBefore });
    await prisma.tenant.deleteMany({ where: { id: rival.id } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, OR: [{ link: { startsWith: "/me/work-log" } }, { title: { contains: "Smoke" } }] } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, entityType: { in: ["AttendanceKiosk", "KioskPin", "WorkLogWeek", "WeeklyOffPolicy", "AttendancePolicy", "LeaveEncashmentRequest"] } } });
  }
  report("Time and leave depth");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
