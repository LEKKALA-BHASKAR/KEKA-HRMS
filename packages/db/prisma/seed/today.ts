import type { PrismaClient } from "@prisma/client";
import { generatePunches, UNTRACKED, type SeedPunch } from "./time";

/**
 * "Today" in the demo. The rest of the seed is pinned to fixed dates; this
 * brings the data up to the day it runs, so the dashboards that ask "who is
 * in today?" have an answer: attendance through yesterday, this morning's
 * clock-ins (a couple late, one from the mobile app), someone working from
 * home, someone on duty at a client, someone on leave, and a birthday.
 *
 * It only runs inside the demo year (27 Sep 2026 – 31 Mar 2027); outside it
 * the rest of the seed stands as it is.
 */
const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const ist = (y: number, m: number, d: number, h: number, min: number) => new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60_000);

export async function seedToday(prisma: PrismaClient, ctx: { tenantId: string; now?: Date }) {
  const svc = await import("@keka/services");
  const t = ctx.tenantId;
  const now = ctx.now ?? new Date();
  const inIst = new Date(now.getTime() + 330 * 60_000);
  const y = inIst.getUTCFullYear(), m = inIst.getUTCMonth() + 1, dd = inIst.getUTCDate();
  const today = utc(y, m, dd), yesterday = new Date(today.getTime() - DAY);
  if (today < utc(2026, 9, 27) || today > utc(2027, 3, 31)) return { skipped: true as const };

  const emps = await prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, employeeNumber: true, dateOfJoining: true, userId: true } });
  const byNum = new Map(emps.map((e) => [e.employeeNumber, e]));
  const id = (n: string) => byNum.get(n)!.id;
  const holidays = new Set((await prisma.holiday.findMany({ where: { calendar: { tenantId: t }, isOptional: false }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)));

  // Someone is on approved leave today, and someone works from home and on duty.
  const leaveType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: t, code: "CL" } });
  const leave = await svc.applyLeave({ employeeId: id("ACM0013"), leaveTypeId: leaveType.id, from: today, to: today, reason: "Family function", onBehalf: true, today });
  if (leave.requestId) await svc.decideLeave({ requestId: leave.requestId, decision: "APPROVE", approverEmployeeId: id("ACM0004") });
  const wfh = await svc.raiseAttendanceRequest({ employeeId: id("ACM0029"), type: "WORK_FROM_HOME", from: today, to: today, reason: "Internet technician visit", today });
  if (wfh.requestId) await svc.decideAttendanceRequest({ requestId: wfh.requestId, decision: "APPROVE" });
  const od = await svc.raiseAttendanceRequest({ employeeId: id("ACM0017"), type: "ON_DUTY", from: today, to: today, reason: "On site at Helix for the quarterly review", today });
  if (od.requestId) await svc.decideAttendanceRequest({ requestId: od.requestId, decision: "APPROVE" });

  const onLeave = new Map((await prisma.leaveRequestDay.findMany({
    where: { request: { tenantId: t, status: "APPROVED" }, isSandwich: false, date: { gte: utc(2026, 9, 26) } },
    select: { date: true, portion: true, request: { select: { employeeId: true } } },
  })).map((l) => [`${l.request.employeeId}:${l.date.toISOString().slice(0, 10)}`, l.portion]));

  // The days since the fixed seed ended, through yesterday.
  const from = utc(2026, 9, 26);
  const already = await prisma.attendanceLog.count({ where: { tenantId: t, timestamp: { gte: ist(2026, 9, 26, 0, 0) } } });
  let punches: SeedPunch[] = [];
  if (already === 0 && yesterday >= from) {
    punches = generatePunches({
      tenantId: t, employees: emps.map((e) => ({ id: e.id, number: e.employeeNumber, doj: e.dateOfJoining })),
      from, to: yesterday, holidays, onLeave, salt: 1,
    });
  }

  // This morning: clock-ins up to now, not after it.
  const workday = today.getUTCDay() !== 0 && today.getUTCDay() !== 6 && !holidays.has(today.toISOString().slice(0, 10));
  if (workday && already === 0) {
    const away = new Set(["ACM0013", "ACM0029", "ACM0017", "ACM0016", "ACM0010"]); // leave, WFH, on duty, and two not in yet
    const late = new Set(["ACM0027", "ACM0012"]);
    for (const e of emps) {
      if (UNTRACKED.has(e.employeeNumber) || away.has(e.employeeNumber) || e.dateOfJoining > today) continue;
      const n = parseInt(e.employeeNumber.replace(/\D/g, ""), 10);
      const at = late.has(e.employeeNumber) ? ist(y, m, dd, 10, 5 + (n % 20)) : ist(y, m, dd, 9, 8 + ((n * 7) % 30));
      if (at > now) continue;
      punches.push({ tenantId: t, employeeId: e.id, timestamp: at, direction: 0, source: e.employeeNumber === "ACM0028" ? "MOBILE" : e.employeeNumber === "ACM0024" ? "WEB" : "BIOMETRIC" });
    }
  }
  for (let i = 0; i < punches.length; i += 1000) await prisma.attendanceLog.createMany({ data: punches.slice(i, i + 1000) });
  const processed = await svc.processAttendance({ tenantId: t, from, to: today, today });

  // A birthday today (day and month only — the year stays theirs).
  const birthday = await prisma.employee.findUniqueOrThrow({ where: { id: id("ACM0018") }, select: { dateOfBirth: true } });
  if (birthday.dateOfBirth) await prisma.employee.update({ where: { id: id("ACM0018") }, data: { dateOfBirth: utc(birthday.dateOfBirth.getUTCFullYear(), m, dd) } });

  // The open payroll month now sees the new attendance.
  const open = await prisma.payrollRun.findFirst({ where: { tenantId: t, status: { in: ["DRAFT", "IN_PROGRESS"] } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
  if (open) await svc.calculateRun(open.id);

  return { skipped: false as const, punches: punches.length, days: processed.days, today: today.toISOString().slice(0, 10) };
}
