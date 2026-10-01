import type { PrismaClient } from "@prisma/client";

/**
 * Time-domain seed: shifts, weekly-off patterns, attendance policies,
 * per-employee assignments, two months of punches, leave accrual and leave
 * requests.
 *
 * Accrual, leave requests and attendance processing all go through the real
 * service layer rather than writing rows directly, so the seeded data is
 * exactly what the product would have produced — and the seed doubles as an
 * integration test of it.
 *
 * Everything is deterministic: a seeded PRNG, never Math.random, so two seeds
 * produce identical data and identical payroll.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const ist = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60_000);

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chennai delivery staff work alternate Saturdays; leadership is not tracked. */
export const DELIVERED = new Set(["ACM0011", "ACM0017", "ACM0023", "ACM0030"]);
export const UNTRACKED = new Set(["ACM0001", "ACM0002"]);

export type SeedPunch = { tenantId: string; employeeId: string; timestamp: Date; direction: number; source: "BIOMETRIC" | "WEB" | "MOBILE" };

/**
 * Biometric punches for working days in a window: mostly on time, a few late
 * (two people habitually), the odd unexplained absence and forgotten
 * clock-out; nothing on weekly offs, holidays or full-day leave.
 */
export function generatePunches(p: {
  tenantId: string; employees: Array<{ id: string; number: string; doj: Date }>; from: Date; to: Date;
  holidays: Set<string>; onLeave: Map<string, string>; salt?: number;
}): SeedPunch[] {
  const logs: SeedPunch[] = [];
  for (const e of p.employees) {
    if (UNTRACKED.has(e.number)) continue;
    const rand = prng(parseInt(e.number.replace(/\D/g, ""), 10) * 7919 + (p.salt ?? 0));
    // A couple of people are chronically late, to exercise the penalty rule.
    const habituallyLate = e.number === "ACM0027" || e.number === "ACM0012";

    for (let cur = p.from; cur <= p.to; cur = new Date(cur.getTime() + 86_400_000)) {
      if (cur < e.doj) continue;
      const key = cur.toISOString().slice(0, 10);
      const dow = cur.getUTCDay();
      const altSatOff = DELIVERED.has(e.number) && dow === 6 &&
        [2, 4].includes(Math.floor((cur.getUTCDate() - 1) / 7) + 1);
      const weekend = DELIVERED.has(e.number) ? (dow === 0 || altSatOff) : (dow === 0 || dow === 6);
      if (weekend || p.holidays.has(key)) continue;

      const leave = p.onLeave.get(`${e.id}:${key}`);
      if (leave === "FULL_DAY") continue;

      const roll = rand();
      if (roll < 0.025) continue; // absent without leave
      const y = cur.getUTCFullYear(), m = cur.getUTCMonth() + 1, d = cur.getUTCDate();

      let inH = 9, inM = 10 + Math.floor(rand() * 32);     // 09:10–09:41
      if (habituallyLate ? rand() < 0.35 : rand() < 0.06) { inH = 9; inM = 50 + Math.floor(rand() * 25); }
      if (inM >= 60) { inH += 1; inM -= 60; }
      let outH = 18, outM = 30 + Math.floor(rand() * 50);   // 18:30–19:19
      if (outM >= 60) { outH += 1; outM -= 60; }

      // A first-half leave means the afternoon only.
      if (leave === "FIRST_HALF") { inH = 14; inM = 5 + Math.floor(rand() * 20); }
      if (leave === "SECOND_HALF") { outH = 14; outM = Math.floor(rand() * 20); }

      logs.push({ tenantId: p.tenantId, employeeId: e.id, timestamp: ist(y, m, d, inH, inM), direction: 0, source: "BIOMETRIC" });
      // An occasional forgotten clock-out.
      if (rand() < 0.02) continue;
      logs.push({ tenantId: p.tenantId, employeeId: e.id, timestamp: ist(y, m, d, outH, outM), direction: 1, source: "BIOMETRIC" });
    }
  }
  return logs;
}

export async function seedTime(
  prisma: PrismaClient,
  ctx: {
    tenantId: string;
    employees: Array<{ id: string; number: string; doj: Date; ctc: number }>;
    empIdByNumber: Map<string, string>;
  },
) {
  const { tenantId, employees, empIdByNumber } = ctx;
  const emp = (n: string) => empIdByNumber.get(n)!;
  const svc = await import("@keka/services");

  // ---------------------------------------------------------------------
  //  Shifts, patterns, policies
  // ---------------------------------------------------------------------
  const general = await prisma.shift.create({
    data: { tenantId, name: "General", code: "GEN", startTime: "09:30", endTime: "18:30", breakMinutes: 60, color: "#3b66f6" },
  });
  await prisma.shift.create({
    data: { tenantId, name: "Early", code: "EARLY", startTime: "07:00", endTime: "16:00", breakMinutes: 60, color: "#0f8a55" },
  });
  await prisma.shift.create({
    data: {
      tenantId, name: "Night Support", code: "NIGHT", startTime: "22:00", endTime: "06:00",
      breakMinutes: 30, crossesMidnight: true, color: "#6b21a8",
    },
  });
  await prisma.shift.create({
    data: {
      tenantId, name: "Flexible 8h", code: "FLEX", startTime: "08:00", endTime: "20:00",
      breakMinutes: 60, isFlexible: true, requiredHours: 8, color: "#b26a00",
    },
  });

  await prisma.weeklyOffPolicy.create({
    data: {
      tenantId, name: "Saturday & Sunday", isDefault: true,
      config: { SAT: { instances: "ALL" }, SUN: { instances: "ALL" } },
    },
  });
  const alternate = await prisma.weeklyOffPolicy.create({
    data: {
      tenantId, name: "Alternate Saturdays",
      config: { SUN: { instances: "ALL" }, SAT: { instances: [2, 4] } },
    },
  });

  const standard = await prisma.attendancePolicy.create({
    data: {
      tenantId, name: "Standard", isDefault: true,
      description: "Office staff. 15-minute grace, three late arrivals forgiven a month.",
      graceMinutes: 15, lateExemptPerMonth: 3, latePenaltyDays: 0.5,
      missingPunchExemptPerMonth: 2, missingPunchPenaltyDays: 0.5,
      noAttendanceIsLop: true, overtimeEnabled: false,
    },
  });
  const delivery = await prisma.attendancePolicy.create({
    data: {
      tenantId, name: "Service Delivery",
      description: "Shift-based staff. Overtime tracked after 30 minutes beyond the shift.",
      graceMinutes: 10, lateExemptPerMonth: 2, latePenaltyDays: 0.5,
      noAttendanceIsLop: true, overtimeEnabled: true, overtimeMinMinutes: 30,
    },
  });

  // ---------------------------------------------------------------------
  //  Assignments
  // ---------------------------------------------------------------------
  const delivered = DELIVERED, untracked = UNTRACKED;
  for (const e of employees) {
    await prisma.employeeTimePolicy.create({
      data: {
        employeeId: e.id,
        attendancePolicyId: delivered.has(e.number) ? delivery.id : standard.id,
        shiftId: general.id,
        weeklyOffPolicyId: delivered.has(e.number) ? alternate.id : null,
        trackAttendance: !untracked.has(e.number),
        effectiveFrom: e.doj,
      },
    });
  }

  // ---------------------------------------------------------------------
  //  Leave accrual Apr–Sep, through the real job
  // ---------------------------------------------------------------------
  let accrualCredits = 0;
  let accruedDays = 0;
  for (let m = 4; m <= 9; m++) {
    const s = await svc.runAccrual({ tenantId, year: 2026, month: m });
    accrualCredits += s.credits;
    accruedDays += s.totalDays;
  }

  // ---------------------------------------------------------------------
  //  Leave requests, through apply/decide
  // ---------------------------------------------------------------------
  const types = await prisma.leaveType.findMany({ where: { tenantId } });
  const t = (code: string) => types.find((x) => x.code === code)!.id;
  const today = utc(2026, 9, 28);

  const plan: Array<{
    who: string; type: string; from: Date; to: Date; reason: string;
    approve: boolean | null; fromPortion?: "FULL_DAY" | "FIRST_HALF" | "SECOND_HALF";
  }> = [
    { who: "ACM0009", type: "EL", from: utc(2026, 8, 17), to: utc(2026, 8, 21), reason: "Family trip to Coorg", approve: true },
    { who: "ACM0010", type: "SL", from: utc(2026, 9, 8), to: utc(2026, 9, 9), reason: "Viral fever", approve: true },
    { who: "ACM0012", type: "CL", from: utc(2026, 9, 15), to: utc(2026, 9, 15), reason: "Personal work", approve: true, fromPortion: "FIRST_HALF" },
    // Unpaid: this is what reaches August payroll as loss of pay.
    { who: "ACM0019", type: "LWP", from: utc(2026, 8, 24), to: utc(2026, 8, 26), reason: "Extended travel, balance exhausted", approve: true },
    { who: "ACM0016", type: "EL", from: utc(2026, 9, 3), to: utc(2026, 9, 4), reason: "Wedding in the family", approve: true },
    { who: "ACM0029", type: "SL", from: utc(2026, 9, 21), to: utc(2026, 9, 21), reason: "Dental procedure", approve: true },
    // Awaiting decisions, so the inbox has work in it.
    { who: "ACM0007", type: "EL", from: utc(2026, 10, 12), to: utc(2026, 10, 16), reason: "Diwali travel home", approve: null },
    { who: "ACM0024", type: "CL", from: utc(2026, 10, 5), to: utc(2026, 10, 5), reason: "Bank appointment", approve: null },
    { who: "ACM0013", type: "SL", from: utc(2026, 9, 24), to: utc(2026, 9, 25), reason: "Migraine", approve: null },
  ];

  let leaveApproved = 0;
  let leavePending = 0;
  for (const p of plan) {
    const res = await svc.applyLeave({
      employeeId: emp(p.who), leaveTypeId: t(p.type),
      from: p.from, to: p.to, fromPortion: p.fromPortion ?? "FULL_DAY", toPortion: p.fromPortion ?? "FULL_DAY",
      reason: p.reason, onBehalf: true, today,
    });
    if (!res.ok || !res.requestId) {
      throw new Error(`Seed leave for ${p.who} rejected by validation: ${res.issues.map((i) => i.message).join("; ")}`);
    }
    if (p.approve) {
      const manager = await prisma.employee.findUnique({ where: { id: emp(p.who) }, select: { reportingManagerId: true } });
      const d = await svc.decideLeave({ requestId: res.requestId, decision: "APPROVE", approverEmployeeId: manager?.reportingManagerId });
      if (!d.ok) throw new Error(`Seed approval failed: ${d.message}`);
      leaveApproved++;
    } else {
      leavePending++;
    }
  }

  // ---------------------------------------------------------------------
  //  Punches, 1 Aug – 25 Sep, deterministic
  // ---------------------------------------------------------------------
  const leaveDays = await prisma.leaveRequestDay.findMany({
    where: { request: { tenantId, status: "APPROVED" }, isSandwich: false },
    select: { date: true, portion: true, request: { select: { employeeId: true } } },
  });
  const onLeave = new Map<string, string>(
    leaveDays.map((l) => [`${l.request.employeeId}:${l.date.toISOString().slice(0, 10)}`, l.portion]),
  );
  const holidays = new Set((await prisma.holiday.findMany({
    where: { calendar: { tenantId }, isOptional: false }, select: { date: true },
  })).map((h) => h.date.toISOString().slice(0, 10)));

  const logs = generatePunches({ tenantId, employees, from: utc(2026, 8, 1), to: utc(2026, 9, 25), holidays, onLeave });
  for (let i = 0; i < logs.length; i += 1000) {
    await prisma.attendanceLog.createMany({ data: logs.slice(i, i + 1000) });
  }

  // Attendance requests.
  const wfh = await svc.raiseAttendanceRequest({
    employeeId: emp("ACM0008"), type: "WORK_FROM_HOME",
    from: utc(2026, 9, 10), to: utc(2026, 9, 11), reason: "Plumbing work at home", today,
  });
  if (wfh.requestId) await svc.decideAttendanceRequest({ requestId: wfh.requestId, decision: "APPROVE" });
  await svc.raiseAttendanceRequest({
    employeeId: emp("ACM0027"), type: "REGULARISATION",
    from: utc(2026, 9, 22), to: utc(2026, 9, 22), reason: "Metro breakdown — was stuck for an hour", today,
  });
  await svc.raiseAttendanceRequest({
    employeeId: emp("ACM0020"), type: "ADJUSTMENT",
    from: utc(2026, 9, 18), to: utc(2026, 9, 18),
    proposedIn: ist(2026, 9, 18, 9, 20), proposedOut: ist(2026, 9, 18, 18, 45),
    reason: "Biometric reader was down in the morning", today,
  });

  // Process everything through the real engine.
  const processed = await svc.processAttendance({
    tenantId, from: utc(2026, 8, 1), to: utc(2026, 9, 25), today,
  });

  return {
    shifts: 4, weeklyOffPolicies: 2, attendancePolicies: 2,
    accrualCredits, accruedDays: Math.round(accruedDays * 100) / 100,
    leaveApproved, leavePending,
    punches: logs.length, attendanceDays: processed.days, lopDays: processed.lopDays,
  };
}
