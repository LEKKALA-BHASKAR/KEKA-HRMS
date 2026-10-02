import { prisma, type Prisma } from "@keka/db";
import {
  type WorkCalendar, type WeeklyOffConfig, type DayPortion, type SandwichConfig,
  type AttendanceRules, type ShiftSpec, type DayResult,
  DEFAULT_WEEKLY_OFF, DEFAULT_RULES, dayKey, eachDayUtc, classifyDay,
  countLeave, validateLeave, accrueFor, evaluateDay, applyMonthlyPenalties,
} from "@keka/time";
import { type LeaveApprovalActor, manualDayValues } from "./leave-policy-math";

/**
 * Leave and attendance operations against the database.
 *
 * The rules live in @keka/time as pure functions; this layer only gathers
 * their inputs and persists their outputs. Every balance change goes through
 * the leave ledger, so a balance is always the sum of entries that explain it.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ---------------------------------------------------------------------------
//  Time zone
// ---------------------------------------------------------------------------

/** Minutes east of UTC for an IANA zone at an instant. */
export function tzOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 330;
  }
}

/** The local calendar date a punch belongs to. */
export function localDateKey(instant: Date, offsetMinutes: number): string {
  return dayKey(new Date(instant.getTime() + offsetMinutes * 60_000));
}

// ---------------------------------------------------------------------------
//  Policy resolution
// ---------------------------------------------------------------------------

export interface ResolvedTimePolicy {
  calendar: WorkCalendar;
  rules: AttendanceRules;
  attendancePolicyId: string | null;
  defaultShift: ShiftSpec;
  defaultShiftId: string | null;
  trackAttendance: boolean;
  tzOffset: number;
  allowWebClockIn: boolean;
  ipAllowList: string[];
  requireClockInComment: boolean;
  regularisationWindowDays: number;
  allowRemoteClockIn: boolean;
  remoteClockInNeedsApproval: boolean;
  requireGeofence: boolean;
  requireSelfie: boolean;
  allowMobileClockIn: boolean;
  allowHalfDayRemoteWork: boolean;
  allowHourlyRemoteWork: boolean;
  overtimeNeedsRequest: boolean;
  overtimeRequestWindowDays: number;
  allowShiftChangeRequests: boolean;
  allowWeeklyOffRequests: boolean;
  /** Days a penalty waits before applying, so the employee can regularise. */
  penaltyBufferDays: number;
  /** Worked weekly offs and holidays credit comp-off on processing. */
  autoCreditCompOff: boolean;
  overtimeMultiplier: number;
  overtimeOffDayMultiplier: number;
  overtimeRoundingMinutes: number;
}

/**
 * Holiday calendar: the assigned one, else any calendar covering the
 * employee's location, else the default.
 */
async function calendarIdsFor(tenantId: string, locationId: string | null, assignedId: string | null): Promise<string[]> {
  if (assignedId) return [assignedId];
  const cals = await prisma.holidayCalendar.findMany({
    where: { tenantId }, select: { id: true, isDefault: true, locationIds: true },
  });
  const byLocation = cals.filter((c) => Array.isArray(c.locationIds) &&
    (c.locationIds as string[]).includes(locationId ?? ""));
  return (byLocation.length > 0 ? byLocation : cals.filter((c) => c.isDefault)).map((c) => c.id);
}

/** The holiday calendars an employee is on at a date. */
export async function employeeHolidayCalendarIds(employeeId: string, at: Date): Promise<string[]> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true, locationId: true } });
  const assignment = await prisma.employeeTimePolicy.findFirst({
    where: { employeeId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
    orderBy: { effectiveFrom: "desc" }, select: { holidayCalendarId: true },
  });
  return calendarIdsFor(emp.tenantId, emp.locationId, assignment?.holidayCalendarId ?? null);
}

const GENERAL_SHIFT: ShiftSpec = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, isFlexible: false };

/**
 * The policy an employee is on for a date: their effective-dated assignment,
 * falling back to the tenant defaults. Resolved once per employee per range.
 */
export async function resolveTimePolicy(employeeId: string, at: Date): Promise<ResolvedTimePolicy> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true, location: { select: { timezone: true, id: true } } },
  });
  const assignment = await prisma.employeeTimePolicy.findFirst({
    where: {
      employeeId, effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { attendancePolicy: true },
  });

  const policy = assignment?.attendancePolicy
    ?? await prisma.attendancePolicy.findFirst({ where: { tenantId: emp.tenantId, isDefault: true, isActive: true } });

  const weeklyOffRow = assignment?.weeklyOffPolicyId
    ? await prisma.weeklyOffPolicy.findUnique({ where: { id: assignment.weeklyOffPolicyId } })
    : await prisma.weeklyOffPolicy.findFirst({ where: { tenantId: emp.tenantId, isDefault: true, isActive: true } });

  const calendarIds = await calendarIdsFor(emp.tenantId, emp.location?.id ?? null, assignment?.holidayCalendarId ?? null);
  // Public holidays, plus the optional holidays this employee has picked.
  const holidays = calendarIds.length > 0
    ? await prisma.holiday.findMany({
        where: { calendarId: { in: calendarIds }, OR: [{ isOptional: false }, { selections: { some: { employeeId } } }] },
        select: { date: true },
      })
    : [];

  const shiftRow = assignment?.shiftId
    ? await prisma.shift.findUnique({ where: { id: assignment.shiftId } })
    : await prisma.shift.findFirst({ where: { tenantId: emp.tenantId, isActive: true }, orderBy: { createdAt: "asc" } });

  const rules: AttendanceRules = policy ? {
    fullDayThresholdPct: policy.fullDayThresholdPct,
    halfDayThresholdPct: policy.halfDayThresholdPct,
    graceMinutes: policy.graceMinutes,
    lateExemptPerMonth: policy.lateExemptPerMonth,
    latePenaltyDays: Number(policy.latePenaltyDays),
    missingPunchExemptPerMonth: policy.missingPunchExemptPerMonth,
    missingPunchPenaltyDays: Number(policy.missingPunchPenaltyDays),
    noAttendanceIsLop: policy.noAttendanceIsLop,
    overtimeEnabled: policy.overtimeEnabled,
    overtimeMinMinutes: policy.overtimeMinMinutes,
  } : DEFAULT_RULES;

  return {
    calendar: {
      weeklyOff: (weeklyOffRow?.config as WeeklyOffConfig | undefined) ?? DEFAULT_WEEKLY_OFF,
      holidays: new Set(holidays.map((h) => dayKey(h.date))),
    },
    rules,
    attendancePolicyId: policy?.id ?? null,
    defaultShift: shiftRow ? {
      startTime: shiftRow.startTime, endTime: shiftRow.endTime,
      breakMinutes: shiftRow.breakMinutes, isFlexible: shiftRow.isFlexible,
      requiredHours: shiftRow.requiredHours ? Number(shiftRow.requiredHours) : null,
      crossesMidnight: shiftRow.crossesMidnight,
    } : GENERAL_SHIFT,
    defaultShiftId: shiftRow?.id ?? null,
    trackAttendance: assignment?.trackAttendance ?? true,
    tzOffset: tzOffsetMinutes(emp.location?.timezone ?? "Asia/Kolkata", at),
    allowWebClockIn: policy?.allowWebClockIn ?? true,
    ipAllowList: Array.isArray(policy?.ipAllowList) ? (policy!.ipAllowList as string[]) : [],
    requireClockInComment: policy?.requireClockInComment ?? false,
    regularisationWindowDays: policy?.regularisationWindowDays ?? 30,
    allowRemoteClockIn: policy?.allowRemoteClockIn ?? false,
    remoteClockInNeedsApproval: policy?.remoteClockInNeedsApproval ?? true,
    requireGeofence: policy?.requireGeofence ?? false,
    allowMobileClockIn: policy?.allowMobileClockIn ?? true,
    requireSelfie: policy?.requireSelfie ?? false,
    allowHalfDayRemoteWork: policy?.allowHalfDayRemoteWork ?? true,
    allowHourlyRemoteWork: policy?.allowHourlyRemoteWork ?? false,
    overtimeNeedsRequest: policy?.overtimeNeedsRequest ?? true,
    overtimeRequestWindowDays: policy?.overtimeRequestWindowDays ?? 30,
    allowShiftChangeRequests: policy?.allowShiftChangeRequests ?? true,
    allowWeeklyOffRequests: policy?.allowWeeklyOffRequests ?? true,
    penaltyBufferDays: policy?.penaltyBufferDays ?? 0,
    autoCreditCompOff: policy?.autoCreditCompOff ?? false,
    overtimeMultiplier: policy ? Number(policy.overtimeMultiplier) : 1,
    overtimeOffDayMultiplier: policy ? Number(policy.overtimeOffDayMultiplier) : 1,
    overtimeRoundingMinutes: policy?.overtimeRoundingMinutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
//  Leave year and balances
// ---------------------------------------------------------------------------

export function leaveYearStart(at: Date, basis: string, joinDate?: Date | null): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() + 1;
  if (basis === "CALENDAR_JAN") return new Date(Date.UTC(y, 0, 1));
  if (basis === "JOINING_DATE" && joinDate) {
    const anniversary = new Date(Date.UTC(y, joinDate.getUTCMonth(), joinDate.getUTCDate()));
    return anniversary.getTime() <= at.getTime()
      ? anniversary
      : new Date(Date.UTC(y - 1, joinDate.getUTCMonth(), joinDate.getUTCDate()));
  }
  // FINANCIAL_APR
  return new Date(Date.UTC(m >= 4 ? y : y - 1, 3, 1));
}

export async function planFor(employeeId: string, at: Date) {
  return prisma.leavePlanAssignment.findFirst({
    where: {
      employeeId, effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { plan: { include: { types: { include: { leaveType: true } } } } },
  }) ?? prisma.leavePlanAssignment.findFirst({
    where: { employeeId },
    orderBy: { effectiveFrom: "desc" },
    include: { plan: { include: { types: { include: { leaveType: true } } } } },
  });
}

/**
 * Rebuild a balance from its ledger. A legacy balance with no ledger is
 * adopted first — its figures become OPENING and USED entries — so moving to
 * the ledger never silently zeroes someone's leave.
 */
export async function recomputeBalance(
  employeeId: string, leaveTypeId: string, yearStart: Date,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  const emp = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  let entries = await tx.leaveLedgerEntry.findMany({ where: { employeeId, leaveTypeId, yearStart } });

  if (entries.length === 0) {
    const legacy = await tx.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_yearStart: { employeeId, leaveTypeId, yearStart } },
    });
    if (legacy && (Number(legacy.accrued) !== 0 || Number(legacy.used) !== 0 || Number(legacy.opening) !== 0)) {
      const seed = [
        { kind: "OPENING" as const, days: Number(legacy.opening) + Number(legacy.accrued) + Number(legacy.carriedForward), periodKey: "ADOPTED-OPENING" },
        { kind: "USED" as const, days: -Number(legacy.used), periodKey: "ADOPTED-USED" },
      ].filter((e) => e.days !== 0);
      for (const e of seed) {
        await tx.leaveLedgerEntry.create({
          data: { tenantId: emp.tenantId, employeeId, leaveTypeId, yearStart, ...e, note: "Adopted from pre-ledger balance" },
        });
      }
      entries = await tx.leaveLedgerEntry.findMany({ where: { employeeId, leaveTypeId, yearStart } });
    }
  }

  const sum = (kinds: string[]) => entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + Number(e.days), 0);
  const opening = sum(["OPENING"]);
  const accrued = sum(["ACCRUAL", "COMP_OFF_CREDIT", "ADJUSTMENT"]);
  const used = -(sum(["USED", "REVERSAL"]));
  const encashed = -sum(["ENCASHMENT"]);
  const lapsed = -sum(["LAPSE"]);
  const carriedForward = sum(["CARRY_FORWARD"]);
  const available = r2(entries.reduce((s, e) => s + Number(e.days), 0));

  await tx.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_yearStart: { employeeId, leaveTypeId, yearStart } },
    create: {
      employeeId, leaveTypeId, yearStart,
      opening: r2(opening), accrued: r2(accrued), used: r2(used),
      encashed: r2(encashed), lapsed: r2(lapsed), carriedForward: r2(carriedForward), available,
    },
    update: {
      opening: r2(opening), accrued: r2(accrued), used: r2(used),
      encashed: r2(encashed), lapsed: r2(lapsed), carriedForward: r2(carriedForward), available,
    },
  });
  return available;
}

/** Days tied up in requests still awaiting a decision. */
async function pendingDays(employeeId: string, leaveTypeId: string, exceptRequestId?: string) {
  const agg = await prisma.leaveRequest.aggregate({
    where: {
      employeeId, leaveTypeId, status: "PENDING",
      ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}),
    },
    _sum: { totalDays: true },
  });
  return Number(agg._sum.totalDays ?? 0);
}

/** Leave dates already covered by pending or approved requests. */
async function otherLeaveMap(employeeId: string, from: Date, to: Date, sameTypeOnly?: string) {
  const days = await prisma.leaveRequestDay.findMany({
    where: {
      date: { gte: new Date(from.getTime() - 31 * DAY), lte: new Date(to.getTime() + 31 * DAY) },
      isSandwich: false,
      request: {
        employeeId, status: { in: ["PENDING", "APPROVED"] },
        ...(sameTypeOnly ? { leaveTypeId: sameTypeOnly } : {}),
      },
    },
    select: { date: true, portion: true },
  });
  return new Map(days.map((d) => [dayKey(d.date), d.portion as DayPortion]));
}

// ---------------------------------------------------------------------------
//  Apply, decide, cancel
// ---------------------------------------------------------------------------

export interface ApplyLeaveInput {
  employeeId: string;
  leaveTypeId: string;
  from: Date;
  to: Date;
  fromPortion?: DayPortion;
  toPortion?: DayPortion;
  reason?: string | null;
  attachmentUrl?: string | null;
  /** Admin entry on someone's behalf may skip notice and back-dating rules. */
  onBehalf?: boolean;
  /** The employee who raised it, when not the employee themselves. */
  requestedByEmployeeId?: string | null;
  today?: Date;
}

export interface ApplyLeaveResult {
  ok: boolean;
  requestId?: string;
  issues: Array<{ field: string; message: string }>;
  totalDays?: number;
  sandwichDays?: number;
}

export async function previewLeave(input: ApplyLeaveInput) {
  const from = utcMidnight(input.from);
  const to = utcMidnight(input.to);
  const [emp, type, policy] = await Promise.all([
    prisma.employee.findUniqueOrThrow({
      where: { id: input.employeeId },
      select: { id: true, tenantId: true, status: true, dateOfJoining: true, confirmationDate: true },
    }),
    prisma.leaveType.findUniqueOrThrow({ where: { id: input.leaveTypeId } }),
    resolveTimePolicy(input.employeeId, from),
  ]);

  const sandwich = (type.sandwichConfig ?? null) as SandwichConfig | null;
  const other = await otherLeaveMap(
    input.employeeId, from, to,
    sandwich?.clubAcrossLeaveTypes ? undefined : input.leaveTypeId,
  );
  // Overlap is checked against leave of any type, whatever the sandwich scope.
  const anyOther = sandwich?.clubAcrossLeaveTypes ? other : await otherLeaveMap(input.employeeId, from, to);

  const count = countLeave({
    from, to, fromPortion: input.fromPortion, toPortion: input.toPortion,
    calendar: policy.calendar, sandwich, otherLeave: other,
  });
  count.overlaps = [...new Set([
    ...count.overlaps,
    ...count.days.filter((d) => !d.isSandwich && anyOther.has(d.key)).map((d) => d.key),
  ])];

  const plan = await planFor(input.employeeId, from);
  const yearStart = leaveYearStart(from, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
  // Incident leave is an entitlement per event: no running balance, but no
  // single request may exceed the per-event quota.
  const isIncident = type.category === "INCIDENT";
  const balance = type.isPaid && !type.isUnlimited && !isIncident
    ? await recomputeBalance(input.employeeId, input.leaveTypeId, yearStart)
    : 0;
  const available = r2(balance - await pendingDays(input.employeeId, input.leaveTypeId));

  const onProbation = emp.status === "PROBATION";
  const usedDuringProbation = onProbation
    ? Number((await prisma.leaveRequest.aggregate({
        where: { employeeId: emp.id, leaveTypeId: type.id, status: { in: ["APPROVED", "PENDING"] } },
        _sum: { totalDays: true },
      }))._sum.totalDays ?? 0)
    : 0;

  const today = utcMidnight(input.today ?? new Date());
  const issues = validateLeave({
    rules: {
      name: type.name, isPaid: type.isPaid, allowHalfDay: type.allowHalfDay,
      allowQuarterDay: type.allowQuarterDay,
      allowBackdated: input.onBehalf ? true : type.allowBackdated,
      priorNoticeDays: input.onBehalf ? null : type.priorNoticeDays,
      requireComment: type.requireComment,
      attachmentAboveDays: type.attachmentAboveDays ? Number(type.attachmentAboveDays) : null,
      maxConsecutiveDays: type.maxConsecutiveDays
        ? Number(type.maxConsecutiveDays)
        : isIncident ? Number(type.annualQuota) : null,
      allowNegativeBalance: type.allowNegativeBalance,
      maxNegativeDays: type.maxNegativeDays ? Number(type.maxNegativeDays) : null,
      isUnlimited: type.isUnlimited || isIncident,
      accrueDuringProbation: type.accrueDuringProbation,
      maxDaysDuringProbation: type.maxDaysDuringProbation ? Number(type.maxDaysDuringProbation) : null,
    },
    count, from, to,
    fromPortion: input.fromPortion ?? "FULL_DAY", toPortion: input.toPortion ?? "FULL_DAY",
    today, available, reason: input.reason, hasAttachment: !!input.attachmentUrl,
    onProbation, usedDuringProbation,
  });

  // Usage limits: days per month, the gap between requests, and a
  // consecutive run that an adjoining request would make too long.
  if (!count.empty && to.getTime() >= from.getTime()) {
    const { usageIssuesFor } = await import("./leave-policy");
    issues.push(...await usageIssuesFor({ employeeId: input.employeeId, type, count, from, to, calendar: policy.calendar }));
  }

  // Hidden types are admin-only.
  if (type.isHiddenFromEmployee && !input.onBehalf) {
    issues.push({ field: "leaveTypeId", message: `${type.name} can only be applied by an administrator.` });
  }

  return { emp, type, count, issues, available, yearStart, from, to };
}

export async function applyLeave(input: ApplyLeaveInput): Promise<ApplyLeaveResult> {
  const p = await previewLeave(input);
  if (p.issues.length > 0) return { ok: false, issues: p.issues, totalDays: p.count.totalDays };

  // The approval chain is fixed when the request is raised, so a later policy
  // change never reroutes a request already in flight.
  const { stepsForNewRequest } = await import("./leave-policy");
  const steps = await stepsForNewRequest(p.emp.id, p.type.id, p.from);

  const request = await prisma.leaveRequest.create({
    data: {
      tenantId: p.emp.tenantId,
      employeeId: p.emp.id,
      leaveTypeId: p.type.id,
      fromDate: p.from, toDate: p.to,
      fromPortion: input.fromPortion ?? "FULL_DAY",
      toPortion: input.toPortion ?? "FULL_DAY",
      totalDays: p.count.totalDays,
      sandwichDays: p.count.sandwichDays,
      reason: input.reason ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      requestedBy: input.requestedByEmployeeId ?? null,
      status: "PENDING",
      ...(steps ? { approvalSteps: steps as never, approvalLevel: 0, levelSince: new Date() } : {}),
      days: {
        create: p.count.days.map((d) => ({
          date: d.date, portion: d.portion, dayValue: d.value,
          isSandwich: d.isSandwich,
          // Unpaid leave reaches payroll as LOP through exactly this flag.
          isPaid: p.type.isPaid,
        })),
      },
    },
  });

  return {
    ok: true, requestId: request.id, issues: [],
    totalDays: p.count.totalDays, sandwichDays: p.count.sandwichDays,
  };
}

export async function decideLeave(opts: {
  requestId: string;
  decision: "APPROVE" | "REJECT";
  approverEmployeeId?: string | null;
  note?: string | null;
  /**
   * Who is deciding, for a request on an approval chain: they must hold the
   * level waiting. Omitted, the decision is taken as authorised (jobs, scripts).
   */
  actor?: LeaveApprovalActor | null;
  /** The system clearing every remaining level after the auto-approve window. */
  auto?: boolean;
}): Promise<{ ok: boolean; message: string; pendingLevel?: boolean }> {
  const request = await prisma.leaveRequest.findUniqueOrThrow({
    where: { id: opts.requestId },
    include: { leaveType: true, days: true },
  });
  if (request.status !== "PENDING") {
    return { ok: false, message: `This request is already ${request.status.toLowerCase()}.` };
  }

  // Approval chain: only the holder of the waiting level (or HR) decides it,
  // and an approval short of the last level moves the request along.
  const policy = await import("./leave-policy");
  const chain = policy.chainState(request);
  let finalSteps: unknown = undefined;
  if (chain && chain.current) {
    const now = new Date();
    if (opts.auto) {
      finalSteps = policy.autoApproveSteps(chain.steps, chain.level, now);
    } else {
      if (opts.actor && !policy.canActOnStep(chain.current, opts.actor)) {
        return { ok: false, message: `This request is waiting for ${await policy.stepLabel(chain.current)} (level ${chain.level + 1} of ${chain.steps.length}).` };
      }
      const actor = opts.actor ?? { employeeId: opts.approverEmployeeId ?? null, isHr: true, canApprove: true };
      if (opts.decision === "REJECT") {
        finalSteps = chain.steps.map((st, i) => (i === chain.level
          ? { ...st, status: "REJECTED", by: actor.employeeId, at: now.toISOString(), note: opts.note ?? null } : st));
      } else {
        const cfg = await policy.approvalChainFor(request.employeeId, request.leaveTypeId, request.fromDate);
        const next = policy.approveStep(chain.steps, chain.level, actor, now, opts.note ?? null, cfg?.skipSamePerson ?? true);
        finalSteps = next.steps;
        if (next.nextLevel !== null) {
          await prisma.leaveRequest.update({
            where: { id: request.id },
            data: { approvalSteps: next.steps as never, approvalLevel: next.nextLevel, levelSince: now },
          });
          const step = next.steps[next.nextLevel];
          await policy.notifyNextApprover(request.tenantId, request.employeeId, step, `${request.leaveType.name} request`);
          return {
            ok: true, pendingLevel: true,
            message: `Approved at level ${chain.level + 1} of ${chain.steps.length}. It now goes to ${await policy.stepLabel(step)}.`,
          };
        }
      }
    }
  }
  const stepsData = finalSteps === undefined ? {} : { approvalSteps: finalSteps as never };

  if (opts.decision === "REJECT") {
    await prisma.leaveRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", approvedBy: opts.approverEmployeeId ?? null, approvedAt: new Date(), rejectReason: opts.note ?? null, ...stepsData },
    });
    await reprocessRange(request.employeeId, request.fromDate, request.toDate);
    return { ok: true, message: "Rejected." };
  }

  const plan = await planFor(request.employeeId, request.fromDate);
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: request.employeeId }, select: { dateOfJoining: true, employeeNumber: true } });
  const yearStart = leaveYearStart(request.fromDate, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);

  // Re-check the balance at approval time: another request may have been
  // approved since this one was raised.
  const tracksBalance = request.leaveType.isPaid && !request.leaveType.isUnlimited &&
    request.leaveType.category !== "INCIDENT";
  if (tracksBalance) {
    const available = await recomputeBalance(request.employeeId, request.leaveTypeId, yearStart);
    const floor = request.leaveType.allowNegativeBalance ? -Number(request.leaveType.maxNegativeDays ?? 0) : 0;
    if (available - Number(request.totalDays) < floor - 1e-9) {
      return {
        ok: false,
        message: `Approving would take ${request.leaveType.name} to ${r2(available - Number(request.totalDays))} days, below the permitted floor of ${floor}.`,
      };
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", approvedBy: opts.auto ? null : opts.approverEmployeeId ?? null, approvedAt: new Date(), ...stepsData },
    });
    if (tracksBalance) {
      await tx.leaveLedgerEntry.create({
        data: {
          tenantId: request.tenantId, employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId, yearStart,
          kind: "USED", days: -Number(request.totalDays),
          periodKey: `REQ:${request.id}`, requestId: request.id,
          note: `${dayKey(request.fromDate)} to ${dayKey(request.toDate)}`,
        },
      });
      await recomputeBalance(request.employeeId, request.leaveTypeId, yearStart, tx);
    }
  });

  await reprocessRange(request.employeeId, request.fromDate, request.toDate);
  const { emitEvent } = await import("./webhooks");
  await emitEvent(request.tenantId, "leave.approved", {
    requestId: request.id, employeeId: request.employeeId, employeeNumber: emp.employeeNumber, leaveType: request.leaveType.name,
    fromDate: dayKey(request.fromDate), toDate: dayKey(request.toDate), days: Number(request.totalDays),
  });
  return { ok: true, message: opts.auto ? "Auto-approved." : "Approved." };
}

export async function cancelLeave(opts: {
  requestId: string;
  byEmployeeId?: string | null;
  reason?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const request = await prisma.leaveRequest.findUniqueOrThrow({
    where: { id: opts.requestId }, include: { leaveType: true },
  });
  if (request.status === "CANCELLED" || request.status === "REJECTED" || request.status === "WITHDRAWN") {
    return { ok: false, message: `This request is already ${request.status.toLowerCase()}.` };
  }

  // Leave inside a finalised payroll period has already been paid or docked.
  const locked = await prisma.payrollRun.findFirst({
    where: {
      status: "FINALIZED",
      periodStart: { lte: request.toDate }, periodEnd: { gte: request.fromDate },
      lines: { some: { employeeId: request.employeeId } },
    },
    select: { year: true, month: true },
  });
  if (locked && request.status === "APPROVED") {
    return {
      ok: false,
      message: `Payroll for ${locked.month}/${locked.year} is finalised and already reflects this leave. Raise an LOP reversal in the next run instead.`,
    };
  }

  const wasApproved = request.status === "APPROVED";
  await prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id: request.id },
      data: { status: wasApproved ? "CANCELLED" : "WITHDRAWN", rejectReason: opts.reason ?? null, cancelledBy: opts.byEmployeeId ?? null, cancelledAt: new Date() },
    });
    if (wasApproved && request.leaveType.isPaid && !request.leaveType.isUnlimited) {
      const used = await tx.leaveLedgerEntry.findFirst({ where: { requestId: request.id, kind: "USED" } });
      if (used) {
        await tx.leaveLedgerEntry.create({
          data: {
            tenantId: request.tenantId, employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId, yearStart: used.yearStart,
            kind: "REVERSAL", days: -Number(used.days),
            periodKey: `REV:${request.id}`, requestId: request.id,
            note: "Cancelled after approval",
          },
        });
        await recomputeBalance(request.employeeId, request.leaveTypeId, used.yearStart, tx);
      }
    }
  });

  if (wasApproved) await reprocessRange(request.employeeId, request.fromDate, request.toDate);
  return { ok: true, message: wasApproved ? "Cancelled — the days were returned to the balance." : "Withdrawn." };
}

export async function adjustBalance(opts: {
  employeeId: string; leaveTypeId: string; days: number; note: string; actorUserId?: string;
}): Promise<number> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: opts.employeeId }, select: { tenantId: true, dateOfJoining: true },
  });
  const plan = await planFor(opts.employeeId, new Date());
  const yearStart = leaveYearStart(new Date(), plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
  await prisma.leaveLedgerEntry.create({
    data: {
      tenantId: emp.tenantId, employeeId: opts.employeeId, leaveTypeId: opts.leaveTypeId,
      yearStart, kind: "ADJUSTMENT", days: opts.days,
      // Adjustments are deliberately not idempotent — each is its own act.
      periodKey: `ADJ:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      note: opts.note, createdBy: opts.actorUserId ?? null,
    },
  });
  return recomputeBalance(opts.employeeId, opts.leaveTypeId, yearStart);
}

// ---------------------------------------------------------------------------
//  Accrual job
// ---------------------------------------------------------------------------

export interface AccrualSummary {
  employees: number;
  credits: number;
  totalDays: number;
  skippedAlreadyCredited: number;
}

/**
 * Credit one month of accrual for every employee on a leave plan.
 *
 * Idempotent by construction: each credit carries a period key, and the ledger
 * has a unique constraint on it, so re-running a month is a no-op rather than
 * a double credit.
 */
export async function runAccrual(opts: { tenantId: string; year: number; month: number }): Promise<AccrualSummary> {
  const periodEnd = new Date(Date.UTC(opts.year, opts.month, 0));
  const assignments = await prisma.leavePlanAssignment.findMany({
    where: {
      plan: { tenantId: opts.tenantId, isActive: true },
      effectiveFrom: { lte: periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(Date.UTC(opts.year, opts.month - 1, 1)) } }],
    },
    include: { plan: { include: { types: { include: { leaveType: true } } } } },
  });

  const summary: AccrualSummary = { employees: 0, credits: 0, totalDays: 0, skippedAlreadyCredited: 0 };
  const seen = new Set<string>();

  for (const a of assignments) {
    if (seen.has(a.employeeId)) continue;
    seen.add(a.employeeId);
    const emp = await prisma.employee.findUnique({
      where: { id: a.employeeId },
      select: {
        id: true, tenantId: true, dateOfJoining: true, lastWorkingDay: true,
        status: true, confirmationDate: true,
      },
    });
    if (!emp || emp.status === "EXITED") continue;
    summary.employees++;

    const yearStart = leaveYearStart(periodEnd, a.plan.yearBasis, emp.dateOfJoining);
    const startMonth = yearStart.getUTCMonth() + 1;
    const probationEnd = emp.status === "PROBATION"
      ? new Date(emp.dateOfJoining.getTime() + 180 * DAY)
      : null;

    for (const link of a.plan.types) {
      const t = link.leaveType;
      // Unpaid has no balance; comp-off is earned by working an off day; incident
      // leave (maternity, paternity) is an entitlement per event, not an accrual.
      if (!t.isActive || !t.isPaid || ["UNPAID", "COMP_OFF", "INCIDENT"].includes(t.category)) continue;
      const current = await recomputeBalance(emp.id, t.id, yearStart);
      const res = accrueFor({
        rules: {
          frequency: t.accrualFrequency, annualQuota: Number(link.quotaOverride ?? t.annualQuota),
          isUnlimited: t.isUnlimited, prorateOnJoining: t.prorateOnJoining,
          noAwardIfJoinAfterDay: t.noAwardIfJoinAfterDay,
          accrueDuringProbation: t.accrueDuringProbation,
          maxAccumulation: t.maxAccumulation ? Number(t.maxAccumulation) : null,
        },
        year: opts.year, month: opts.month, leaveYearStartMonth: startMonth,
        joinDate: emp.dateOfJoining, exitDate: emp.lastWorkingDay, probationEndDate: probationEnd,
        currentBalance: current,
      });
      if (res.credit <= 0 || !res.periodKey) continue;

      // skipDuplicates makes a re-run a silent no-op against the unique key,
      // rather than a thrown (and logged) constraint violation per employee.
      const written = await prisma.leaveLedgerEntry.createMany({
        data: [{
          tenantId: emp.tenantId, employeeId: emp.id, leaveTypeId: t.id, yearStart,
          kind: "ACCRUAL", days: res.credit, periodKey: `ACCRUAL:${res.periodKey}`,
          note: res.reason,
        }],
        skipDuplicates: true,
      });
      if (written.count === 0) {
        summary.skippedAlreadyCredited++;
        continue;
      }
      summary.credits++;
      summary.totalDays = r2(summary.totalDays + res.credit);
      await recomputeBalance(emp.id, t.id, yearStart);
    }
  }
  return summary;
}

/**
 * Bring accrual in line with a last working day. Accrual for the exit month
 * was usually credited before anyone knew about the exit; this trims it to
 * the days actually served, reverses anything credited for later months, and
 * prorates upfront or periodic credits when the leave type prorates on exit.
 *
 * Idempotent: previous true-ups are replaced, so a changed last working day
 * simply produces the right answer again. With no last working day it only
 * removes earlier true-ups — which is how a withdrawn exit is undone.
 */
export async function trueUpExitAccrual(employeeId: string): Promise<{ adjustments: number; days: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true, dateOfJoining: true, lastWorkingDay: true, status: true },
  });
  const previous = await prisma.leaveLedgerEntry.findMany({
    where: { employeeId, periodKey: { startsWith: "EXIT-TRUEUP:" } },
    select: { leaveTypeId: true, yearStart: true },
  });
  await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId, periodKey: { startsWith: "EXIT-TRUEUP:" } } });
  const touched = new Map(previous.map((p) => [`${p.leaveTypeId}:${p.yearStart.toISOString()}`, p]));

  const lwd = emp.lastWorkingDay;
  let adjustments = 0, days = 0;
  if (lwd) {
    const lwdKey = `${lwd.getUTCFullYear()}-${String(lwd.getUTCMonth() + 1).padStart(2, "0")}`;
    const credits = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId, kind: "ACCRUAL", periodKey: { startsWith: "ACCRUAL:" } },
    });
    const types = new Map((await prisma.leaveType.findMany({
      where: { id: { in: [...new Set(credits.map((c) => c.leaveTypeId))] } },
    })).map((t) => [t.id, t]));

    for (const c of credits) {
      const t = types.get(c.leaveTypeId);
      if (!t) continue;
      const key = c.periodKey!.slice("ACCRUAL:".length);
      const credited = Number(c.days);
      let entitled = credited;

      const monthly = /^(\d{4})-(\d{2})$/.exec(key);
      if (monthly) {
        if (key > lwdKey) entitled = 0;
        else if (key === lwdKey) {
          const dim = new Date(Date.UTC(lwd.getUTCFullYear(), lwd.getUTCMonth() + 1, 0)).getUTCDate();
          entitled = r2(credited * (lwd.getUTCDate() / dim));
        }
      } else if (t.prorateOnExit) {
        // A credit covering a quarter, half-year or year: keep the share of
        // that period actually served.
        const periodStart = c.yearStart;
        const span = /-Q(\d)$/.test(key) ? 3 : /-H(\d)$/.test(key) ? 6 : 12;
        const offset = /-Q(\d)$/.test(key) ? (Number(key.slice(-1)) - 1) * 3 : /-H(\d)$/.test(key) ? (Number(key.slice(-1)) - 1) * 6 : 0;
        const from = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + offset, 1));
        const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + span, 0));
        const effFrom = emp.dateOfJoining > from ? emp.dateOfJoining : from;
        if (lwd < to) {
          const total = (to.getTime() - effFrom.getTime()) / DAY + 1;
          const served = Math.max(0, (lwd.getTime() - effFrom.getTime()) / DAY + 1);
          entitled = Math.round(credited * (served / total) * 2) / 2; // to the half day
        }
      }
      const delta = r2(entitled - credited);
      if (delta === 0) continue;
      await prisma.leaveLedgerEntry.create({
        data: {
          tenantId: emp.tenantId, employeeId, leaveTypeId: c.leaveTypeId, yearStart: c.yearStart,
          kind: "ADJUSTMENT", days: delta,
          periodKey: `EXIT-TRUEUP:${lwd.toISOString().slice(0, 10)}:${key}`,
          note: `Exit true-up for ${key}: ${credited} credited, ${entitled} earned to ${lwd.toISOString().slice(0, 10)}`,
        },
      });
      touched.set(`${c.leaveTypeId}:${c.yearStart.toISOString()}`, { leaveTypeId: c.leaveTypeId, yearStart: c.yearStart });
      adjustments++;
      days = r2(days + delta);
    }
  }
  for (const t of touched.values()) await recomputeBalance(employeeId, t.leaveTypeId, t.yearStart);
  return { adjustments, days };
}

// ---------------------------------------------------------------------------
//  Attendance
// ---------------------------------------------------------------------------

export interface PunchInput {
  employeeId: string;
  direction: 0 | 1;
  at?: Date;
  source?: "WEB" | "MOBILE" | "BIOMETRIC" | "KIOSK" | "API" | "MANUAL" | "REMOTE";
  ipAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  comment?: string | null;
  deviceId?: string | null;
  /** /files/<id> of a selfie taken at the punch. */
  selfieUrl?: string | null;
  /** Reported GPS accuracy in metres, used as tolerance at the fence edge. */
  accuracyM?: number | null;
}

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The largest GPS error we will give the benefit of the doubt for. */
const MAX_ACCURACY_TOLERANCE_M = 100;

export async function recordPunch(input: PunchInput): Promise<{ ok: boolean; message: string; pendingApproval?: boolean; requestId?: string }> {
  const at = input.at ?? new Date();
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId }, select: { tenantId: true, status: true },
  });
  if (emp.status === "EXITED") return { ok: false, message: "This employee has exited." };

  const policy = await resolveTimePolicy(input.employeeId, at);
  const source = input.source ?? "WEB";
  if (source === "WEB") {
    if (!policy.allowWebClockIn) return { ok: false, message: "Web clock-in is not enabled for your attendance policy." };
    if (policy.ipAllowList.length > 0 && (!input.ipAddress || !policy.ipAllowList.includes(input.ipAddress))) {
      return { ok: false, message: "Web clock-in is only allowed from an approved office network." };
    }
    if (policy.requireClockInComment && !input.comment) {
      return { ok: false, message: "A comment is required to clock in." };
    }
  }
  if (source === "MOBILE" && !policy.allowMobileClockIn) return { ok: false, message: "Mobile clock-in is not enabled for your attendance policy." };
  // Geo-fence: web and mobile punches from inside the work location's radius,
  // when the location has one set. A fix's own accuracy, up to a limit, is
  // given as tolerance so someone at the door is not turned away.
  if ((source === "WEB" || source === "MOBILE") && policy.requireGeofence) {
    const office = await prisma.employee.findUnique({
      where: { id: input.employeeId },
      select: { location: { select: { name: true, latitude: true, longitude: true, geofenceRadiusM: true } } },
    }).then((e) => e?.location);
    if (office?.latitude != null && office.longitude != null && office.geofenceRadiusM) {
      if (input.latitude == null || input.longitude == null) {
        return { ok: false, message: "Your attendance policy needs your location to clock in. Allow location access and try again." };
      }
      const d = distanceMetres({ lat: input.latitude, lng: input.longitude }, { lat: Number(office.latitude), lng: Number(office.longitude) });
      const slack = Math.min(Math.max(input.accuracyM ?? 0, 0), MAX_ACCURACY_TOLERANCE_M);
      if (d - slack > office.geofenceRadiusM) {
        return { ok: false, message: `You are about ${d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`} from ${office.name}. Clock in within ${office.geofenceRadiusM} m of the office, or use remote clock-in.` };
      }
    }
  }
  if ((source === "WEB" || source === "MOBILE" || source === "REMOTE") && policy.requireSelfie && !input.selfieUrl) {
    return { ok: false, message: "Your attendance policy needs a selfie with each clock-in. Take one and try again." };
  }
  // Remote Clock-In: from anywhere, but held for approval when the policy says so.
  if (source === "REMOTE") {
    if (!policy.allowRemoteClockIn) return { ok: false, message: "Remote clock-in is not enabled for your attendance policy." };
    if (policy.requireClockInComment && !input.comment) {
      return { ok: false, message: "A comment is required to clock in." };
    }
  }

  // A same-direction punch within a minute of this one is the same punch — a
  // double-click, or a device re-sending its buffer. Compare against punches
  // near *this* instant, not the latest one: devices upload out of order.
  const near = await prisma.attendanceLog.findFirst({
    where: {
      employeeId: input.employeeId,
      direction: input.direction,
      timestamp: { gte: new Date(at.getTime() - 60_000), lte: new Date(at.getTime() + 60_000) },
    },
  });
  if (near) {
    return { ok: false, message: "Already recorded a moment ago." };
  }

  const local = new Date(`${localDateKey(at, policy.tzOffset)}T00:00:00Z`);
  const held = source === "REMOTE" && policy.remoteClockInNeedsApproval;

  // A day's remote punches travel together as one REMOTE_CLOCK_IN request,
  // so the approver decides the day, not each punch.
  let requestId: string | null = null;
  if (held) {
    const open = await prisma.attendanceRequest.findFirst({
      where: { employeeId: input.employeeId, type: "REMOTE_CLOCK_IN", status: "PENDING", fromDate: local },
      select: { id: true },
    });
    requestId = open?.id ?? (await prisma.attendanceRequest.create({
      data: {
        tenantId: emp.tenantId, employeeId: input.employeeId, type: "REMOTE_CLOCK_IN",
        fromDate: local, toDate: local, reason: input.comment?.trim() || "Remote clock-in",
      },
      select: { id: true },
    })).id;
  }

  await prisma.attendanceLog.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId,
      timestamp: at, direction: input.direction, source,
      ipAddress: input.ipAddress ?? null, deviceId: input.deviceId ?? null,
      latitude: input.latitude ?? null, longitude: input.longitude ?? null,
      selfieUrl: input.selfieUrl ?? null,
      comment: input.comment ?? null,
      status: held ? "PENDING" : "VALID",
      attendanceRequestId: requestId,
    },
  });

  if (held) {
    return {
      ok: true, pendingApproval: true, requestId: requestId!,
      message: `${input.direction === 0 ? "Clocked in" : "Clocked out"} remotely — awaiting your manager's approval.`,
    };
  }
  await reprocessRange(input.employeeId, local, local);
  return { ok: true, message: input.direction === 0 ? "Clocked in." : "Clocked out." };
}

/** Reprocess an employee's attendance across the months a range touches. */
export async function reprocessRange(employeeId: string, from: Date, to: Date): Promise<void> {
  // Monthly penalties depend on the whole month, so widen to month bounds.
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0));
  await processAttendance({ employeeIds: [employeeId], from: start, to: end });
}

export interface ProcessSummary {
  employees: number;
  days: number;
  lopDays: number;
  lateDays: number;
  penalisedDays: number;
}

/**
 * Evaluate every day in a range for the given employees and persist the
 * results. Days after today are never materialised — an unrecorded future
 * day is not an absence.
 */
export async function processAttendance(opts: {
  tenantId?: string;
  employeeIds?: string[];
  from: Date;
  to: Date;
  today?: Date;
}): Promise<ProcessSummary> {
  const today = utcMidnight(opts.today ?? new Date());
  const to = new Date(Math.min(utcMidnight(opts.to).getTime(), today.getTime()));
  const from = utcMidnight(opts.from);
  const summary: ProcessSummary = { employees: 0, days: 0, lopDays: 0, lateDays: 0, penalisedDays: 0 };
  if (to.getTime() < from.getTime()) return summary;

  const employees = await prisma.employee.findMany({
    where: {
      ...(opts.employeeIds ? { id: { in: opts.employeeIds } } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      status: { notIn: ["EXITED", "PREBOARDING"] },
    },
    select: { id: true, tenantId: true, dateOfJoining: true, lastWorkingDay: true },
  });

  for (const emp of employees) {
    const policy = await resolveTimePolicy(emp.id, to);
    const empFrom = new Date(Math.max(from.getTime(), utcMidnight(emp.dateOfJoining).getTime()));
    const empTo = emp.lastWorkingDay
      ? new Date(Math.min(to.getTime(), utcMidnight(emp.lastWorkingDay).getTime()))
      : to;
    if (empTo.getTime() < empFrom.getTime()) continue;
    summary.employees++;

    const tz = policy.tzOffset;
    const [logs, leaveDays, requests, shiftOverrides, pinned] = await Promise.all([
      prisma.attendanceLog.findMany({
        where: {
          employeeId: emp.id, status: "VALID",
          timestamp: { gte: new Date(empFrom.getTime() - tz * 60_000), lt: new Date(empTo.getTime() + DAY - tz * 60_000) },
        },
        orderBy: { timestamp: "asc" },
      }),
      prisma.leaveRequestDay.findMany({
        where: {
          date: { gte: empFrom, lte: empTo },
          request: { employeeId: emp.id, status: "APPROVED" },
        },
        select: { date: true, portion: true, isPaid: true, isSandwich: true },
      }),
      prisma.attendanceRequest.findMany({
        where: {
          employeeId: emp.id, status: "APPROVED",
          fromDate: { lte: empTo }, toDate: { gte: empFrom },
        },
      }),
      prisma.shiftAssignment.findMany({
        where: { employeeId: emp.id, date: { gte: empFrom, lte: empTo } },
        include: { shift: true },
      }),
      // Days an administrator has pinned to a status.
      prisma.attendanceRecord.findMany({
        where: { employeeId: emp.id, date: { gte: empFrom, lte: empTo }, manualStatus: { not: null } },
        select: { date: true, manualStatus: true, editReason: true },
      }),
    ]);
    const pinnedByDay = new Map(pinned.map((p) => [dayKey(p.date), p]));

    const logsByDay = new Map<string, typeof logs>();
    for (const l of logs) {
      const k = localDateKey(l.timestamp, tz);
      logsByDay.set(k, [...(logsByDay.get(k) ?? []), l]);
    }
    const leaveByDay = new Map(leaveDays.filter((d) => !d.isSandwich).map((d) => [dayKey(d.date), d]));
    const shiftByDay = new Map(shiftOverrides.map((s) => [dayKey(s.date), s]));

    const results: Array<DayResult & { date: Date; key: string }> = [];
    for (const date of eachDayUtc(empFrom, empTo)) {
      const key = dayKey(date);
      const leave = leaveByDay.get(key);
      const covering = requests.filter((r) => r.fromDate.getTime() <= date.getTime() && r.toDate.getTime() >= date.getTime());
      // A full or half-day WFH/OD covers the day (or half of it); an hourly one
      // credits its window like a permitted partial absence.
      const remotes = covering.filter((r) => r.type === "WORK_FROM_HOME" || r.type === "ON_DUTY");
      const remote = remotes.find((r) => !r.isHourly && (!r.portion || r.portion === "FULL_DAY"))
        ?? remotes.find((r) => !r.isHourly);
      const hourlyRemoteMinutes = remotes.filter((r) => r.isHourly && r.proposedIn && r.proposedOut)
        .reduce((s, r) => s + Math.max(0, (r.proposedOut!.getTime() - r.proposedIn!.getTime()) / 60_000), 0);
      const override = shiftByDay.get(key);

      let kind = classifyDay(date, policy.calendar);
      // A roster weekly-off overrides the pattern for that day.
      if (override?.weeklyOffCode === "WO") kind = "WEEKLY_OFF";
      // ...and a rostered working day overrides a pattern weekly-off.
      else if (override?.weeklyOffCode === "ON" && (kind === "WEEKLY_OFF" || kind === "HALF_WEEKLY_OFF")) kind = "WORKING";

      const shift: ShiftSpec = override ? {
        startTime: override.shift.startTime, endTime: override.shift.endTime,
        breakMinutes: override.shift.breakMinutes, isFlexible: override.shift.isFlexible,
        requiredHours: override.shift.requiredHours ? Number(override.shift.requiredHours) : null,
        crossesMidnight: override.shift.crossesMidnight,
      } : policy.defaultShift;

      const r = evaluateDay({
        date, kind, shift, rules: policy.rules,
        logs: (logsByDay.get(key) ?? []).map((l) => ({ timestamp: l.timestamp, direction: l.direction === 1 ? 1 : 0 })),
        leave: leave ? { portion: leave.portion as DayPortion, isPaid: leave.isPaid } : null,
        remote: remote ? (remote.type as "WORK_FROM_HOME" | "ON_DUTY") : null,
        remotePortion: remote?.portion ?? null,
        regularised: covering.some((r) => r.type === "REGULARISATION" || r.type === "ADJUSTMENT"),
        partialMinutes: covering.filter((r) => r.type === "PARTIAL_DAY").reduce((s, r) => s + (r.partialMinutes ?? 0), 0) + hourlyRemoteMinutes,
        tzOffsetMinutes: tz,
        trackAttendance: policy.trackAttendance,
      });
      const pin = pinnedByDay.get(key);
      if (pin?.manualStatus) {
        // A pinned day pays what its status pays and is out of the monthly
        // late and missing-punch counts.
        const v = manualDayValues(pin.manualStatus, policy.rules.noAttendanceIsLop);
        results.push({
          ...r, date, key, status: pin.manualStatus as DayResult["status"], ...v, isLate: false, isMissingPunch: false,
          notes: [`Set by an administrator: ${pin.editReason ?? "no reason given"}`],
        });
        continue;
      }
      results.push({ ...r, date, key });
    }

    // Penalties per calendar month.
    const byMonth = new Map<string, typeof results>();
    for (const r of results) {
      const m = r.key.slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
    }

    // Penalties wait out the policy's buffer, so a day the employee can still
    // regularise is not docked yet; it is penalised on a later reprocess.
    const bufferEdge = today.getTime() - policy.penaltyBufferDays * DAY;
    for (const monthDays of byMonth.values()) {
      const penalised = applyMonthlyPenalties(monthDays, policy.rules).map((r) => {
        if (!r.penaltyReason || r.date.getTime() <= bufferEdge) return r;
        const before = monthDays.find((x) => x.key === dayKey(r.date))!;
        return { ...r, lopValue: before.lopValue, payableValue: before.payableValue, penaltyReason: null };
      });
      for (const r of penalised) {
        const key = dayKey(r.date);
        const status = r.status;
        const record = await prisma.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId: emp.id, date: r.date } },
          create: {
            tenantId: emp.tenantId, employeeId: emp.id, date: r.date, status,
            shiftId: shiftByDay.get(key)?.shiftId ?? policy.defaultShiftId,
            firstIn: r.firstIn, lastOut: r.lastOut,
            grossHours: r.grossHours, effectiveHours: r.effectiveHours, overtimeHours: r.overtimeHours,
            payableValue: r.payableValue, lopValue: r.lopValue,
            penaltyReason: r.penaltyReason,
            isRegularised: requests.some((q) => (q.type === "REGULARISATION" || q.type === "ADJUSTMENT") &&
              q.fromDate.getTime() <= r.date.getTime() && q.toDate.getTime() >= r.date.getTime()),
            remark: r.notes.join("; ") || null,
          },
          update: {
            status, firstIn: r.firstIn, lastOut: r.lastOut,
            shiftId: shiftByDay.get(key)?.shiftId ?? policy.defaultShiftId,
            grossHours: r.grossHours, effectiveHours: r.effectiveHours, overtimeHours: r.overtimeHours,
            payableValue: r.payableValue, lopValue: r.lopValue, penaltyReason: r.penaltyReason,
            isRegularised: requests.some((q) => (q.type === "REGULARISATION" || q.type === "ADJUSTMENT") &&
              q.fromDate.getTime() <= r.date.getTime() && q.toDate.getTime() >= r.date.getTime()),
            remark: r.notes.join("; ") || null,
          },
        });
        const dayLogs = logsByDay.get(key);
        if (dayLogs && dayLogs.length > 0) {
          await prisma.attendanceLog.updateMany({
            where: { id: { in: dayLogs.map((l) => l.id) } }, data: { recordId: record.id },
          });
        }
        summary.days++;
        summary.lopDays = r2(summary.lopDays + r.lopValue);
        if (r.isLate) summary.lateDays++;
        if (r.penaltyReason) summary.penalisedDays++;
      }
    }

    if (policy.autoCreditCompOff) {
      const { autoCreditCompOffDays } = await import("./leave-policy");
      await autoCreditCompOffDays({
        tenantId: emp.tenantId, employeeId: emp.id, fullPct: policy.rules.fullDayThresholdPct, halfPct: policy.rules.halfDayThresholdPct,
        days: results.map((r) => ({ date: r.date, status: r.status, effectiveHours: r.effectiveHours, requiredHours: r.requiredHours })),
      });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
//  Attendance requests
// ---------------------------------------------------------------------------

export interface ProposedPunch { at: Date; direction: 0 | 1 }

export async function raiseAttendanceRequest(input: {
  employeeId: string;
  type: "ADJUSTMENT" | "REGULARISATION" | "PARTIAL_DAY" | "WORK_FROM_HOME" | "ON_DUTY";
  from: Date; to: Date;
  proposedIn?: Date | null; proposedOut?: Date | null;
  /** ADJUSTMENT with several punches ("+Add Log"). */
  proposedLogs?: ProposedPunch[] | null;
  partialMinutes?: number | null;
  /** WFH / OD: part of the day. */
  portion?: "FULL_DAY" | "FIRST_HALF" | "SECOND_HALF" | null;
  /** WFH / OD by the hour: proposedIn/proposedOut carry the window. */
  isHourly?: boolean;
  notifyEmployeeIds?: string[] | null;
  attachmentFileId?: string | null;
  reason: string;
  today?: Date;
}): Promise<{ ok: boolean; message: string; requestId?: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const from = utcMidnight(input.from);
  const to = utcMidnight(input.to);
  const today = utcMidnight(input.today ?? new Date());
  if (to.getTime() < from.getTime()) return { ok: false, message: "The end date is before the start date." };
  if (!input.reason.trim()) return { ok: false, message: "Give a reason." };

  const policy = await resolveTimePolicy(input.employeeId, from);
  const pastOnly = input.type === "ADJUSTMENT" || input.type === "REGULARISATION";
  if (pastOnly && from.getTime() > today.getTime()) {
    return { ok: false, message: "Corrections can only be requested for days that have happened." };
  }
  if (pastOnly && (today.getTime() - from.getTime()) / DAY > policy.regularisationWindowDays) {
    return { ok: false, message: `Corrections can only go back ${policy.regularisationWindowDays} days.` };
  }
  // An adjustment carries either one in/out pair or a list of punches.
  let proposedLogs: ProposedPunch[] | null = null;
  if (input.type === "ADJUSTMENT") {
    if (input.proposedLogs && input.proposedLogs.length > 0) {
      proposedLogs = [...input.proposedLogs].sort((a, b) => a.at.getTime() - b.at.getTime());
      if (proposedLogs.length > 12) return { ok: false, message: "Add at most 12 time entries for a day." };
      for (let i = 0; i < proposedLogs.length; i++) {
        if (proposedLogs[i].direction !== (i % 2 === 0 ? 0 : 1)) {
          return { ok: false, message: "Time entries must alternate IN and OUT, starting with an IN." };
        }
      }
      if (proposedLogs.length % 2 === 1) return { ok: false, message: "The last IN needs a matching OUT." };
    } else {
      if (!input.proposedIn || !input.proposedOut) {
        return { ok: false, message: "An adjustment needs both a clock-in and a clock-out time." };
      }
      if (input.proposedOut.getTime() <= input.proposedIn.getTime()) {
        return { ok: false, message: "Clock-out must be after clock-in." };
      }
    }
  }

  const remoteWork = input.type === "WORK_FROM_HOME" || input.type === "ON_DUTY";
  const half = input.portion === "FIRST_HALF" || input.portion === "SECOND_HALF";
  if (half && !remoteWork) return { ok: false, message: "Only work from home and on duty can be requested by the half day." };
  if (half && !policy.allowHalfDayRemoteWork) {
    return { ok: false, message: "Your attendance policy allows only full-day work from home and on duty." };
  }
  if (half && to.getTime() !== from.getTime()) return { ok: false, message: "A half-day request covers a single date." };
  if (input.isHourly) {
    if (!remoteWork) return { ok: false, message: "Only work from home and on duty can be requested by the hour." };
    if (!policy.allowHourlyRemoteWork) return { ok: false, message: "Your attendance policy does not allow hourly requests." };
    if (to.getTime() !== from.getTime()) return { ok: false, message: "An hourly request covers a single date." };
    if (!input.proposedIn || !input.proposedOut || input.proposedOut.getTime() <= input.proposedIn.getTime()) {
      return { ok: false, message: "Give the start and end time of the hourly request, end after start." };
    }
  }

  const clash = await prisma.attendanceRequest.findFirst({
    where: {
      employeeId: input.employeeId, type: input.type, status: { in: ["PENDING", "APPROVED"] },
      fromDate: { lte: to }, toDate: { gte: from },
    },
  });
  if (clash) return { ok: false, message: "A request of this type already covers those dates." };

  const req = await prisma.attendanceRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, type: input.type,
      fromDate: from, toDate: to,
      proposedIn: proposedLogs ? proposedLogs[0].at : input.proposedIn ?? null,
      proposedOut: proposedLogs ? proposedLogs[proposedLogs.length - 1].at : input.proposedOut ?? null,
      proposedLogs: proposedLogs ? proposedLogs.map((l) => ({ at: l.at.toISOString(), direction: l.direction })) : undefined,
      partialMinutes: input.partialMinutes ?? null, reason: input.reason,
      portion: remoteWork && !input.isHourly ? (input.portion ?? "FULL_DAY") : null,
      isHourly: !!input.isHourly,
      notifyEmployeeIds: input.notifyEmployeeIds?.length ? input.notifyEmployeeIds : undefined,
      attachmentFileId: input.attachmentFileId ?? null,
    },
  });
  return { ok: true, message: "Request raised.", requestId: req.id };
}

export async function decideAttendanceRequest(opts: {
  requestId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const req = await prisma.attendanceRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `Already ${req.status.toLowerCase()}.` };

  await prisma.$transaction(async (tx) => {
    await tx.attendanceRequest.update({
      where: { id: req.id },
      data: {
        status: opts.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null,
      },
    });
    // An approved adjustment writes the corrected punches as manual logs.
    const listed = Array.isArray(req.proposedLogs) ? (req.proposedLogs as Array<{ at: string; direction: number }>) : null;
    if (opts.decision === "APPROVE" && req.type === "ADJUSTMENT" && listed && listed.length > 0) {
      await tx.attendanceLog.createMany({
        data: listed.map((l) => ({
          tenantId: req.tenantId, employeeId: req.employeeId, timestamp: new Date(l.at),
          direction: l.direction === 1 ? 1 : 0, source: "MANUAL" as const, comment: `Adjustment ${req.id}`,
        })),
      });
    } else if (opts.decision === "APPROVE" && req.type === "ADJUSTMENT" && req.proposedIn && req.proposedOut) {
      await tx.attendanceLog.createMany({
        data: [
          { tenantId: req.tenantId, employeeId: req.employeeId, timestamp: req.proposedIn, direction: 0, source: "MANUAL", comment: `Adjustment ${req.id}` },
          { tenantId: req.tenantId, employeeId: req.employeeId, timestamp: req.proposedOut, direction: 1, source: "MANUAL", comment: `Adjustment ${req.id}` },
        ],
      });
    }
    // A remote clock-in day: its held punches count, or never will.
    if (req.type === "REMOTE_CLOCK_IN") {
      await tx.attendanceLog.updateMany({
        where: { attendanceRequestId: req.id, status: "PENDING" },
        data: { status: opts.decision === "APPROVE" ? "VALID" : "REJECTED" },
      });
    }
  });

  if (opts.decision === "APPROVE") await reprocessRange(req.employeeId, req.fromDate, req.toDate);
  return { ok: true, message: opts.decision === "APPROVE" ? "Approved — attendance recalculated." : "Rejected." };
}
