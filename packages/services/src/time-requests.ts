<<<<<<< HEAD
import { prisma } from "@keka/db";
import { resolveStructure, calculateLeaveEncashment } from "@keka/payroll";
import { classifyDay, dayKey, pairPunches, requiredHoursFor, addDaysUtc } from "@keka/time";
import { resolveTimePolicy, recomputeBalance, leaveYearStart, planFor } from "./time";
import { specsOf } from "./lifecycle";
import { calculateRun } from "./payroll-run";

/**
 * Comp-off and in-service leave encashment — the two balance movements an
 * employee asks for rather than the accrual job granting.
 *
 * Both go through the leave ledger, so a balance is always the sum of
 * entries that explain it, and both are idempotent by period key: approving
 * the same request twice cannot credit or debit twice.
=======
import { prisma, type Prisma } from "@keka/db";
import { resolveStructure, type StructureComponentSpec } from "@keka/payroll";
import { dayKey, eachDayUtc } from "@keka/time";
import { resolveTimePolicy, reprocessRange, recomputeBalance, leaveYearStart } from "./time";
import { notify } from "./lifecycle";
import {
  formatHhmm, overtimeRate, overtimeAmount, encashmentFormulaParts, encashmentEstimate, encashableDays, compOffCreditFor,
} from "./time-math";

export * from "./time-math";

/**
 * The time requests beyond leave and attendance corrections: shift and
 * weekly-off changes, overtime, compensatory-off credit and in-service leave
 * encashment, plus the comment thread every time request carries.
 *
 * Each request is raised by the employee for themselves and decided by
 * someone in their approval line; the callers (server actions) check who may
 * decide, and these functions keep the rules and the side effects — roster
 * rows, payroll entries, ledger credits — consistent.
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
<<<<<<< HEAD

export interface RequestIssue { field: string; message: string }

/** Comp-off credits lapse after this many days unless the leave type says otherwise. */
export const COMP_OFF_DEFAULT_EXPIRY_DAYS = 90;
/** How far back a worked day can still be claimed. */
export const COMP_OFF_CLAIM_WINDOW_DAYS = 30;

async function compOffType(tenantId: string) {
  return prisma.leaveType.findFirst({ where: { tenantId, category: "COMP_OFF", isActive: true } });
}

/** Hours worked on a date, from the processed record or, failing that, the raw punches. */
async function hoursWorkedOn(employeeId: string, date: Date, tzOffset: number): Promise<number> {
  const record = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date } } });
  const fromRecord = record ? Number(record.effectiveHours) : 0;
  // A local day runs from local midnight, which is UTC midnight minus the offset.
  const start = new Date(date.getTime() - tzOffset * 60_000);
  const logs = await prisma.attendanceLog.findMany({
    where: { employeeId, timestamp: { gte: start, lt: new Date(start.getTime() + DAY) } },
    select: { timestamp: true, direction: true },
  });
  const pairs = pairPunches(logs.map((l) => ({ timestamp: l.timestamp, direction: l.direction === 1 ? 1 : 0 })));
  const fromLogs = pairs.intervals.reduce((s, [a, b]) => s + (b.getTime() - a.getTime()) / 3_600_000, 0);
  return r2(Math.max(fromRecord, fromLogs));
}

/**
 * Check a comp-off claim without saving it: the day must be a weekly off or
 * a holiday on the employee's own calendar, already past, inside the claim
 * window, and carry enough worked hours for the days claimed — judged by the
 * same full-day and half-day thresholds as ordinary attendance.
 */
export async function checkCompOff(input: { employeeId: string; workedOn: Date; days: number; today?: Date }) {
  const issues: RequestIssue[] = [];
  const today = input.today ?? new Date();
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const type = await compOffType(emp.tenantId);
  if (!type) issues.push({ field: "_form", message: "Comp-off is not set up for your organisation." });

  if (input.days !== 0.5 && input.days !== 1) issues.push({ field: "days", message: "Claim a full day or a half day" });
  const todayKey = dayKey(today);
  if (dayKey(input.workedOn) >= todayKey) issues.push({ field: "workedOn", message: "Claim a day you have already worked" });
  if (today.getTime() - input.workedOn.getTime() > COMP_OFF_CLAIM_WINDOW_DAYS * DAY) {
    issues.push({ field: "workedOn", message: `Comp-off must be claimed within ${COMP_OFF_CLAIM_WINDOW_DAYS} days` });
  }

  const policy = await resolveTimePolicy(input.employeeId, input.workedOn);
  const kind = classifyDay(input.workedOn, policy.calendar);
  let dayType = "Working day";
  if (kind === "WORKING") issues.push({ field: "workedOn", message: "That was a working day on your calendar — comp-off is for weekly offs and holidays" });
  else if (kind === "HOLIDAY") dayType = "Holiday";
  else if (kind === "HALF_WEEKLY_OFF") {
    dayType = "Half weekly off";
    if (input.days > 0.5) issues.push({ field: "days", message: "Only half of that day was a weekly off — claim a half day" });
  } else dayType = "Weekly off";

  const required = requiredHoursFor(policy.defaultShift);
  const worked = await hoursWorkedOn(input.employeeId, input.workedOn, policy.tzOffset);
  const needed = r2(required * (input.days >= 1 ? policy.rules.fullDayThresholdPct : policy.rules.halfDayThresholdPct) / 100);
  if (kind !== "WORKING" && worked < needed) {
    issues.push({
      field: "workedOn",
      message: worked === 0
        ? "No attendance was recorded on that day"
        : `${worked}h recorded; a ${input.days === 1 ? "full" : "half"} day needs at least ${needed}h`,
    });
  }

  const dup = await prisma.compOffRequest.findUnique({ where: { employeeId_workedOn: { employeeId: input.employeeId, workedOn: input.workedOn } } });
  if (dup && dup.status !== "CANCELLED" && dup.status !== "REJECTED") issues.push({ field: "workedOn", message: "You have already claimed that day" });

  return { ok: issues.length === 0, issues, dayType, hoursWorked: worked, hoursNeeded: needed, leaveType: type };
}

export async function raiseCompOff(input: { employeeId: string; workedOn: Date; days: number; reason: string; today?: Date }) {
  const check = await checkCompOff(input);
  if (!check.ok) return { ok: false as const, issues: check.issues };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const expiryDays = check.leaveType?.expiryDaysAfterCredit ?? COMP_OFF_DEFAULT_EXPIRY_DAYS;
  const data = {
    tenantId: emp.tenantId, employeeId: input.employeeId, workedOn: input.workedOn,
    days: input.days, reason: input.reason, dayType: check.dayType, status: "PENDING" as const,
    expiresOn: addDaysUtc(input.workedOn, expiryDays), decidedAt: null, decidedBy: null, decisionNote: null,
  };
  // A rejected or cancelled claim for the same day is reopened rather than duplicated.
  const row = await prisma.compOffRequest.upsert({
    where: { employeeId_workedOn: { employeeId: input.employeeId, workedOn: input.workedOn } },
    create: data, update: data,
  });
  return { ok: true as const, id: row.id, issues: [] };
}

/**
 * Approve or reject. Approval credits the comp-off type in the leave year
 * containing the worked day, keyed so it can only land once.
 */
export async function decideCompOff(opts: { requestId: string; approve: boolean; note?: string | null; deciderEmployeeId?: string | null }) {
  const req = await prisma.compOffRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  if (!opts.approve) {
    await prisma.compOffRequest.update({
      where: { id: req.id },
      data: { status: "REJECTED", decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null },
    });
    return { ok: true, message: "Comp-off rejected." };
  }
  const type = await compOffType(req.tenantId);
  if (!type) return { ok: false, message: "Comp-off is not set up for your organisation." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: req.employeeId }, select: { dateOfJoining: true } });
  const plan = await planFor(req.employeeId, req.workedOn);
  const yearStart = leaveYearStart(req.workedOn, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);

  await prisma.$transaction(async (tx) => {
    await tx.compOffRequest.update({
      where: { id: req.id },
      data: { status: "APPROVED", decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null },
    });
    await tx.leaveLedgerEntry.upsert({
      where: { employeeId_leaveTypeId_kind_periodKey: { employeeId: req.employeeId, leaveTypeId: type.id, kind: "COMP_OFF_CREDIT", periodKey: `COMPOFF:${req.id}` } },
      create: {
        tenantId: req.tenantId, employeeId: req.employeeId, leaveTypeId: type.id, yearStart,
        kind: "COMP_OFF_CREDIT", days: req.days, periodKey: `COMPOFF:${req.id}`,
        note: `Worked on ${dayKey(req.workedOn)} (${req.dayType.toLowerCase()}); use by ${req.expiresOn ? dayKey(req.expiresOn) : "—"}`,
      },
      update: {},
    });
    await recomputeBalance(req.employeeId, type.id, yearStart, tx);
  });
  return { ok: true, message: `${Number(req.days)} day(s) of comp-off credited.` };
}

export async function cancelCompOff(requestId: string, employeeId: string) {
  const req = await prisma.compOffRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (req.employeeId !== employeeId) return { ok: false, message: "You can only withdraw your own request." };
  if (req.status !== "PENDING") return { ok: false, message: "Only a pending request can be withdrawn." };
  await prisma.compOffRequest.update({ where: { id: req.id }, data: { status: "CANCELLED" } });
  return { ok: true, message: "Withdrawn." };
=======
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const days = (from: Date, to: Date) => Math.round((utcMidnight(to).getTime() - utcMidnight(from).getTime()) / DAY) + 1;

type Result = { ok: boolean; message: string; requestId?: string };

// ---------------------------------------------------------------------------
//  Shared lookups
// ---------------------------------------------------------------------------

/** Monthly wages from the salary in force on a date, exactly as payroll reads it. */
export async function monthlyWages(employeeId: string, at: Date): Promise<{ basic: number; gross: number; byCode: (code: string) => number } | null> {
  const revisions = await prisma.salaryRevision.findMany({
    where: { employeeId, status: "APPLIED", effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: "desc" }, take: 1,
    include: { structure: { include: { components: { include: { component: true } } } } },
  });
  const revision = revisions[0];
  if (!revision) return null;
  const specs: StructureComponentSpec[] = (revision.structure?.components ?? []).filter((sc) => sc.isActive).map((sc) => ({
    code: sc.component.code, name: sc.component.name, type: sc.component.type,
    calculationType: sc.calculationType, formula: sc.formula,
    fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
    percentage: sc.percentage === null ? null : Number(sc.percentage),
    percentageOf: sc.percentageOf, sequence: sc.sequence,
    minAmount: sc.minAmount === null ? null : Number(sc.minAmount),
    maxAmount: sc.maxAmount === null ? null : Number(sc.maxAmount),
    isOutsideCtc: sc.component.isOutsideCtc, isLopApplicable: sc.component.isLopApplicable,
    affectsPfWage: sc.component.affectsPfWage, affectsEsiGross: sc.component.affectsEsiGross,
    showOnPayslip: sc.component.showOnPayslip, isPartOfFbp: sc.component.isPartOfFbp,
  }));
  const resolved = resolveStructure({ annualCtc: Number(revision.annualCtc), components: specs });
  const byCode = (code: string) => Number(resolved.byCode.get(code)?.monthly ?? 0);
  const gross = Number(resolved.monthlyGross ?? 0);
  return { basic: byCode("BASIC") || gross * 0.5, gross, byCode };
}

/**
 * The pay month a new payment should land in: the earliest open regular run
 * for this month or later, else this month or the month after the last
 * finalised run, whichever is later. Never a month already closed.
 */
export async function nextPayrollMonth(tenantId: string, today: Date = new Date()): Promise<{ year: number; month: number }> {
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1;
  const open = await prisma.payrollRun.findFirst({
    where: {
      tenantId, type: "REGULAR", status: { notIn: ["FINALIZED", "ROLLED_BACK"] },
      OR: [{ year: { gt: ty } }, { year: ty, month: { gte: tm } }],
    },
    orderBy: [{ year: "asc" }, { month: "asc" }], select: { year: true, month: true },
  });
  if (open) return open;
  const last = await prisma.payrollRun.findFirst({
    where: { tenantId, status: "FINALIZED" }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { year: true, month: true },
  });
  const after = last ? new Date(Date.UTC(last.year, last.month, 1)) : null;
  const current = new Date(Date.UTC(ty, tm - 1, 1));
  const pick = after && after.getTime() > current.getTime() ? after : current;
  return { year: pick.getUTCFullYear(), month: pick.getUTCMonth() + 1 };
}

async function leaveYearFor(employeeId: string, at: Date): Promise<Date> {
  const [emp, plan] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { dateOfJoining: true } }),
    prisma.leavePlanAssignment.findFirst({
      where: { employeeId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
      orderBy: { effectiveFrom: "desc" }, include: { plan: { select: { yearBasis: true } } },
    }),
  ]);
  return leaveYearStart(at, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
}

// ---------------------------------------------------------------------------
//  Notifications
// ---------------------------------------------------------------------------

export type TimeEvent = "RAISED" | "APPROVED" | "REJECTED";

/**
 * Tell the right people about a time request: the approver and anyone the
 * employee copied when it is raised, the employee when it is decided.
 */
export async function notifyTimeRequest(opts: {
  tenantId: string;
  employeeId: string;
  kind: "LEAVE" | "ATTENDANCE";
  event: TimeEvent;
  /** "Work From Home on 07 Oct 2026" */
  what: string;
  notifyEmployeeIds?: string[] | null;
  note?: string | null;
}): Promise<number> {
  const emp = await prisma.employee.findFirst({
    where: { id: opts.employeeId, tenantId: opts.tenantId },
    select: { displayName: true, firstName: true, lastName: true, userId: true, reportingManagerId: true },
  });
  if (!emp) return 0;
  const name = emp.displayName ?? `${emp.firstName} ${emp.lastName}`;
  if (opts.event === "RAISED") {
    const ids = [emp.reportingManagerId, ...(opts.notifyEmployeeIds ?? [])].filter((x): x is string => !!x);
    const people = ids.length
      ? await prisma.employee.findMany({ where: { tenantId: opts.tenantId, id: { in: ids } }, select: { id: true, userId: true } })
      : [];
    const manager = people.find((p) => p.id === emp.reportingManagerId)?.userId;
    const copied = people.filter((p) => p.id !== emp.reportingManagerId).map((p) => p.userId);
    let n = 0;
    if (manager) {
      n += await notify({
        tenantId: opts.tenantId, userIds: [manager], kind: opts.kind,
        title: `${name} requested ${opts.what}`, body: opts.note ?? null, link: "/inbox",
      });
    }
    if (copied.length) {
      n += await notify({
        tenantId: opts.tenantId, userIds: copied, kind: opts.kind,
        title: `${name} copied you on a request: ${opts.what}`, body: opts.note ?? null, link: null,
      });
    }
    return n;
  }
  return notify({
    tenantId: opts.tenantId, userIds: [emp.userId], kind: opts.kind,
    title: `Your request for ${opts.what} was ${opts.event === "APPROVED" ? "approved" : "rejected"}`,
    body: opts.note ?? null, link: opts.kind === "LEAVE" ? "/me/leave" : "/me/attendance?view=requests",
  });
}

// ---------------------------------------------------------------------------
//  Shift change and weekly-off requests
// ---------------------------------------------------------------------------

export async function raiseShiftRequest(input: {
  employeeId: string;
  kind: "SHIFT_CHANGE" | "WEEKLY_OFF";
  from: Date; to: Date;
  shiftId?: string | null;
  reason: string;
  notifyEmployeeIds?: string[] | null;
  today?: Date;
}): Promise<Result> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const from = utcMidnight(input.from), to = utcMidnight(input.to);
  const today = utcMidnight(input.today ?? new Date());
  if (to.getTime() < from.getTime()) return { ok: false, message: "The end date is before the start date." };
  if (!input.reason.trim()) return { ok: false, message: "Give a reason." };
  if (from.getTime() < today.getTime() - 7 * DAY) return { ok: false, message: "Shift and weekly-off changes can go back at most a week." };
  const span = days(from, to);
  const policy = await resolveTimePolicy(input.employeeId, from);

  let shiftId: string | null = null;
  if (input.kind === "SHIFT_CHANGE") {
    if (!policy.allowShiftChangeRequests) return { ok: false, message: "Your attendance policy does not allow shift change requests." };
    if (span > 31) return { ok: false, message: "A shift change can cover at most 31 days." };
    const shift = input.shiftId
      ? await prisma.shift.findFirst({ where: { id: input.shiftId, tenantId: emp.tenantId, isActive: true }, select: { id: true } })
      : null;
    if (!shift) return { ok: false, message: "Choose the shift you want." };
    shiftId = shift.id;
  } else {
    if (!policy.allowWeeklyOffRequests) return { ok: false, message: "Your attendance policy does not allow weekly-off requests." };
    if (span > 7) return { ok: false, message: "A weekly-off request can cover at most 7 days." };
  }

  const clash = await prisma.shiftRequest.findFirst({
    where: { employeeId: input.employeeId, kind: input.kind, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
    select: { id: true },
  });
  if (clash) return { ok: false, message: `A ${input.kind === "SHIFT_CHANGE" ? "shift" : "weekly-off"} request already covers those dates.` };

  const req = await prisma.shiftRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, kind: input.kind,
      fromDate: from, toDate: to, shiftId, reason: input.reason.trim(),
      notifyEmployeeIds: input.notifyEmployeeIds?.length ? input.notifyEmployeeIds : undefined,
    },
  });
  return { ok: true, message: "Request raised.", requestId: req.id };
}

export async function decideShiftRequest(opts: {
  requestId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null;
}): Promise<Result> {
  const req = await prisma.shiftRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `Already ${req.status.toLowerCase()}.` };

  if (opts.decision === "APPROVE") {
    const policy = await resolveTimePolicy(req.employeeId, req.fromDate);
    const existing = await prisma.shiftAssignment.findMany({
      where: { employeeId: req.employeeId, date: { gte: req.fromDate, lte: req.toDate } },
    });
    const byKey = new Map(existing.map((a) => [dayKey(a.date), a]));
    const fallbackShift = req.shiftId ?? policy.defaultShiftId;
    if (!fallbackShift) return { ok: false, message: "There is no shift to roster these days against. Create a shift first." };
    await prisma.$transaction(async (tx) => {
      for (const date of eachDayUtc(req.fromDate, req.toDate)) {
        const prior = byKey.get(dayKey(date));
        const data = req.kind === "SHIFT_CHANGE"
          ? { shiftId: req.shiftId!, weeklyOffCode: prior?.weeklyOffCode ?? null }
          : { shiftId: prior?.shiftId ?? fallbackShift, weeklyOffCode: "WO" };
        await tx.shiftAssignment.upsert({
          where: { employeeId_date: { employeeId: req.employeeId, date } },
          create: { employeeId: req.employeeId, date, ...data },
          update: data,
        });
      }
      await tx.shiftRequest.update({
        where: { id: req.id },
        data: { status: "APPROVED", decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null },
      });
    });
    await reprocessRange(req.employeeId, req.fromDate, req.toDate);
    return { ok: true, message: req.kind === "SHIFT_CHANGE" ? "Approved — the roster is updated." : "Approved — those days are now weekly offs." };
  }

  await prisma.shiftRequest.update({
    where: { id: req.id },
    data: { status: "REJECTED", decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null },
  });
  return { ok: true, message: "Rejected." };
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

/** Overtime the processed attendance shows for a range, in minutes. */
export async function loggedOvertimeMinutes(employeeId: string, from: Date, to: Date): Promise<number> {
  const agg = await prisma.attendanceRecord.aggregate({
    where: { employeeId, date: { gte: utcMidnight(from), lte: utcMidnight(to) } },
    _sum: { overtimeHours: true },
  });
  return Math.round(Number(agg._sum.overtimeHours ?? 0) * 60);
}

export async function raiseOvertimeRequest(input: {
  employeeId: string; from: Date; to: Date; minutes: number;
  note?: string | null; notifyEmployeeIds?: string[] | null; today?: Date;
}): Promise<Result> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const from = utcMidnight(input.from), to = utcMidnight(input.to);
  const today = utcMidnight(input.today ?? new Date());
  if (to.getTime() < from.getTime()) return { ok: false, message: "The end date is before the start date." };
  const span = days(from, to);
  if (span > 31) return { ok: false, message: "An overtime request can cover at most 31 days." };
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) return { ok: false, message: "Enter the overtime hours as hh:mm, more than zero." };
  if (input.minutes > span * 16 * 60) return { ok: false, message: "That is more overtime than the days allow (16 hours a day at most)." };
  const policy = await resolveTimePolicy(input.employeeId, from);
  if (from.getTime() < today.getTime() - policy.overtimeRequestWindowDays * DAY) {
    return { ok: false, message: `Overtime can be claimed up to ${policy.overtimeRequestWindowDays} days back.` };
  }
  if (from.getTime() > today.getTime() + 31 * DAY) return { ok: false, message: "Overtime can be requested at most a month ahead." };
  const clash = await prisma.overtimeRequest.findFirst({
    where: { employeeId: input.employeeId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
    select: { id: true },
  });
  if (clash) return { ok: false, message: "An overtime request already covers those dates." };

  const logged = from.getTime() <= today.getTime() ? await loggedOvertimeMinutes(input.employeeId, from, new Date(Math.min(to.getTime(), today.getTime()))) : 0;
  const req = await prisma.overtimeRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, fromDate: from, toDate: to,
      requestedMinutes: Math.round(input.minutes), loggedMinutes: logged,
      note: input.note?.trim() || null,
      notifyEmployeeIds: input.notifyEmployeeIds?.length ? input.notifyEmployeeIds : undefined,
    },
  });
  return { ok: true, message: "Request raised.", requestId: req.id };
}

/**
 * Approving overtime puts it into payroll: the month's unprocessed overtime
 * entry grows by these hours (or one is created), priced at the hourly rate.
 */
export async function decideOvertimeRequest(opts: {
  requestId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null; today?: Date;
}): Promise<Result> {
  const req = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `Already ${req.status.toLowerCase()}.` };
  const decided = { decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null };
  if (opts.decision === "REJECT") {
    await prisma.overtimeRequest.update({ where: { id: req.id }, data: { status: "REJECTED", ...decided } });
    return { ok: true, message: "Rejected." };
  }

  const wages = await monthlyWages(req.employeeId, req.toDate);
  const rate = overtimeRate((wages?.basic ?? 0) * 12);
  const hours = r2(req.requestedMinutes / 60);
  const amount = overtimeAmount(req.requestedMinutes, rate);

  // The month the overtime was worked, unless its payroll is already closed.
  let year = req.toDate.getUTCFullYear(), month = req.toDate.getUTCMonth() + 1;
  const closed = await prisma.payrollRun.findFirst({ where: { tenantId: req.tenantId, year, month, status: "FINALIZED" }, select: { id: true } });
  if (closed) ({ year, month } = await nextPayrollMonth(req.tenantId, opts.today));

  const entryId = await prisma.$transaction(async (tx) => {
    const open = await tx.overtimeEntry.findFirst({
      where: { tenantId: req.tenantId, employeeId: req.employeeId, year, month, payAction: "PAY", isProcessed: false },
    });
    const entry = open
      ? await tx.overtimeEntry.update({
          where: { id: open.id },
          data: { hours: r2(Number(open.hours) + hours), amount: r2(Number(open.amount) + amount), rate },
        })
      : await tx.overtimeEntry.create({
          data: { tenantId: req.tenantId, employeeId: req.employeeId, year, month, hours, rate, amount, payAction: "PAY" },
        });
    await tx.overtimeRequest.update({ where: { id: req.id }, data: { status: "APPROVED", overtimeEntryId: entry.id, ...decided } });
    return entry.id;
  });
  return {
    ok: true, requestId: entryId,
    message: rate > 0
      ? `Approved — ${formatHhmm(req.requestedMinutes)} hrs go to ${month}/${year} payroll at ₹${rate.toFixed(2)}/hr.`
      : `Approved — ${formatHhmm(req.requestedMinutes)} hrs recorded for ${month}/${year}. There is no salary on record to price them; HR will set the rate.`,
  };
}

// ---------------------------------------------------------------------------
//  Compensatory off
// ---------------------------------------------------------------------------

async function compOffType(tenantId: string) {
  return prisma.leaveType.findFirst({ where: { tenantId, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } });
}

export interface CompOffDay { key: string; date: Date; credit: number; why: string }

/**
 * Days in the request window that earned comp-off: weekly offs and holidays
 * worked long enough for a half or full day, not already claimed.
 */
export async function compOffEligibleDays(employeeId: string, opts: { today?: Date; from?: Date; to?: Date } = {}): Promise<CompOffDay[]> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  const type = await compOffType(emp.tenantId);
  const today = utcMidnight(opts.today ?? new Date());
  const window = type?.compOffRequestWindowDays ?? 30;
  const earliest = new Date(today.getTime() - window * DAY);
  const from = new Date(Math.max(earliest.getTime(), (opts.from ? utcMidnight(opts.from) : earliest).getTime()));
  const to = new Date(Math.min(today.getTime(), (opts.to ? utcMidnight(opts.to) : today).getTime()));
  if (to.getTime() < from.getTime()) return [];

  const [policy, records, claimed] = await Promise.all([
    resolveTimePolicy(employeeId, to),
    prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: from, lte: to }, status: { in: ["WEEKLY_OFF", "HOLIDAY"] }, effectiveHours: { gt: 0 } },
      select: { date: true, status: true, effectiveHours: true },
      orderBy: { date: "asc" },
    }),
    prisma.compOffRequest.findMany({
      where: { employeeId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
      select: { fromDate: true, toDate: true },
    }),
  ]);
  const required = policy.defaultShift.isFlexible && policy.defaultShift.requiredHours
    ? policy.defaultShift.requiredHours
    : Math.max(1, (() => {
        const [sh, sm] = policy.defaultShift.startTime.split(":").map(Number);
        const [eh, em] = policy.defaultShift.endTime.split(":").map(Number);
        let span = eh * 60 + em - (sh * 60 + sm);
        if (span <= 0) span += 1440;
        return (span - policy.defaultShift.breakMinutes) / 60;
      })());
  const isClaimed = (d: Date) => claimed.some((c) => c.fromDate.getTime() <= d.getTime() && c.toDate.getTime() >= d.getTime());
  return records.flatMap((r) => {
    if (isClaimed(r.date)) return [];
    const credit = compOffCreditFor(Number(r.effectiveHours), required, policy.rules.fullDayThresholdPct, policy.rules.halfDayThresholdPct);
    if (credit === 0) return [];
    return [{
      key: dayKey(r.date), date: r.date, credit,
      why: `Worked ${Number(r.effectiveHours)}h on a ${r.status === "HOLIDAY" ? "holiday" : "weekly off"}`,
    }];
  });
}

export async function raiseCompOffRequest(input: {
  employeeId: string; from: Date; to: Date; note?: string | null; attachmentFileId?: string | null; today?: Date;
}): Promise<Result & { days?: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const from = utcMidnight(input.from), to = utcMidnight(input.to);
  const today = utcMidnight(input.today ?? new Date());
  if (to.getTime() < from.getTime()) return { ok: false, message: "The end date is before the start date." };
  if (to.getTime() > today.getTime()) return { ok: false, message: "Comp-off is credited for days you have already worked." };
  const type = await compOffType(emp.tenantId);
  if (!type) return { ok: false, message: "Your organisation has no compensatory-off leave type." };
  const window = type.compOffRequestWindowDays ?? 30;
  if (from.getTime() < today.getTime() - window * DAY) {
    return { ok: false, message: `Comp-off must be requested within ${window} days of the day worked.` };
  }
  const eligible = await compOffEligibleDays(input.employeeId, { today, from, to });
  const total = r2(eligible.reduce((s, d) => s + d.credit, 0));
  if (total === 0) {
    return { ok: false, message: "None of these dates shows work on a weekly off or holiday that has not been claimed already." };
  }
  const req = await prisma.compOffRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, fromDate: from, toDate: to, days: total,
      note: input.note?.trim() || null, attachmentFileId: input.attachmentFileId ?? null,
    },
  });
  return { ok: true, message: `Compensatory off request for ${total} day${total === 1 ? "" : "s"} raised.`, requestId: req.id, days: total };
}

export async function decideCompOffRequest(opts: {
  requestId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null; today?: Date;
}): Promise<Result> {
  const req = await prisma.compOffRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `Already ${req.status.toLowerCase()}.` };
  const decided = { decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null };
  if (opts.decision === "REJECT") {
    await prisma.compOffRequest.update({ where: { id: req.id }, data: { status: "REJECTED", ...decided } });
    return { ok: true, message: "Rejected." };
  }
  const type = await compOffType(req.tenantId);
  if (!type) return { ok: false, message: "There is no compensatory-off leave type to credit." };
  const today = utcMidnight(opts.today ?? new Date());
  const yearStart = await leaveYearFor(req.employeeId, today);
  const expiresOn = type.expiryDaysAfterCredit ? new Date(today.getTime() + type.expiryDaysAfterCredit * DAY) : null;
  await prisma.$transaction(async (tx) => {
    const entry = await tx.leaveLedgerEntry.create({
      data: {
        tenantId: req.tenantId, employeeId: req.employeeId, leaveTypeId: type.id, yearStart,
        kind: "COMP_OFF_CREDIT", days: Number(req.days), periodKey: `COMPOFF:${req.id}`,
        note: `Worked ${dayKey(req.fromDate)}${req.toDate.getTime() !== req.fromDate.getTime() ? ` to ${dayKey(req.toDate)}` : ""}`,
        expiresOn, createdBy: opts.deciderEmployeeId ?? null,
      },
    });
    await tx.compOffRequest.update({ where: { id: req.id }, data: { status: "APPROVED", ledgerEntryId: entry.id, ...decided } });
    await recomputeBalance(req.employeeId, type.id, yearStart, tx);
  });
  return { ok: true, message: `Approved — ${Number(req.days)} day(s) of ${type.name} credited${expiresOn ? `, expiring ${dayKey(expiresOn)}` : ""}.` };
}

/**
 * Lapse comp-off credits past their expiry: each expired credit takes back
 * what is left of it, never more than the balance holds. Idempotent per credit.
 */
export async function lapseExpiredCompOffs(tenantId: string, today: Date = new Date()): Promise<number> {
  const now = utcMidnight(today);
  const expired = await prisma.leaveLedgerEntry.findMany({
    where: { tenantId, kind: "COMP_OFF_CREDIT", expiresOn: { lt: now } },
    orderBy: { createdAt: "asc" },
  });
  let lapsed = 0;
  for (const credit of expired) {
    const key = `LAPSE:${credit.id}`;
    const done = await prisma.leaveLedgerEntry.findFirst({ where: { employeeId: credit.employeeId, leaveTypeId: credit.leaveTypeId, kind: "LAPSE", periodKey: key }, select: { id: true } });
    if (done) continue;
    const available = await recomputeBalance(credit.employeeId, credit.leaveTypeId, credit.yearStart);
    const take = r2(Math.min(Number(credit.days), Math.max(0, available)));
    if (take <= 0) continue;
    await prisma.leaveLedgerEntry.create({
      data: {
        tenantId, employeeId: credit.employeeId, leaveTypeId: credit.leaveTypeId, yearStart: credit.yearStart,
        kind: "LAPSE", days: -take, periodKey: key, note: `Comp-off credited ${dayKey(credit.createdAt)} expired ${dayKey(credit.expiresOn!)}`,
      },
    });
    await recomputeBalance(credit.employeeId, credit.leaveTypeId, credit.yearStart);
    lapsed++;
  }
  return lapsed;
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
}

// ---------------------------------------------------------------------------
//  Leave encashment
// ---------------------------------------------------------------------------

<<<<<<< HEAD
/** Parse "[BASIC] / 30" into its component and divisor. */
export function parseEncashmentFormula(formula: string | null | undefined): { code: string; divisor: number } {
  const m = /^\s*\[(\w+)\]\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(formula ?? "");
  return { code: m?.[1] ?? "BASIC", divisor: m ? Number(m[2]) : 30 };
}

/**
 * What an employee may encash of a leave type today, and at what rate.
 * Days already tied up in pending leave or a pending encashment are not
 * available, so the same day cannot be both taken and sold.
 */
export async function encashmentQuote(employeeId: string, leaveTypeId: string, today = new Date()) {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      tenantId: true, dateOfJoining: true,
      salaryRevisions: {
        where: { status: "APPLIED", effectiveFrom: { lte: today } },
        orderBy: { effectiveFrom: "desc" }, take: 1,
        include: { structure: { include: { components: { include: { component: true } } } } },
      },
    },
  });
  const type = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, tenantId: emp.tenantId } });
  if (!type) return null;
  const plan = await planFor(employeeId, today);
  const yearStart = leaveYearStart(today, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
  const available = await recomputeBalance(employeeId, leaveTypeId, yearStart);
  const [pendingLeave, pendingEnc] = await Promise.all([
    prisma.leaveRequest.aggregate({ where: { employeeId, leaveTypeId, status: "PENDING" }, _sum: { totalDays: true } }),
    prisma.leaveEncashmentRequest.aggregate({ where: { employeeId, leaveTypeId, status: "PENDING" }, _sum: { days: true } }),
  ]);
  const held = Number(pendingLeave._sum.totalDays ?? 0) + Number(pendingEnc._sum.days ?? 0);
  const encashable = Math.max(0, r2(available - held));

  const { code, divisor } = parseEncashmentFormula(type.encashmentFormula);
  const revision = emp.salaryRevisions[0];
  const resolved = revision ? resolveStructure({ annualCtc: Number(revision.annualCtc), components: specsOf(revision) }) : null;
  const monthly = (c: string) => Number(resolved?.byCode.get(c)?.monthly ?? 0);
  const wage = code === "GROSS" ? Number(resolved?.monthlyGross ?? 0) : monthly(code) || Number(resolved?.monthlyGross ?? 0) * 0.5;
  const perDay = calculateLeaveEncashment({ days: 1, monthlyWage: wage, divisor, isOnExit: false }).perDayRate;

  return {
    type, yearStart, available, held, encashable, code, divisor, monthlyWage: wage,
    perDayRate: r2(Number(perDay)), hasSalary: !!resolved,
  };
}

export async function raiseEncashment(input: { employeeId: string; leaveTypeId: string; days: number; reason?: string | null; today?: Date }) {
  const issues: RequestIssue[] = [];
  const q = await encashmentQuote(input.employeeId, input.leaveTypeId, input.today);
  if (!q) return { ok: false as const, issues: [{ field: "leaveTypeId", message: "Leave type not found" }] };
  if (!q.type.encashmentEnabled) issues.push({ field: "leaveTypeId", message: `${q.type.name} cannot be encashed` });
  if (!q.hasSalary) issues.push({ field: "_form", message: "There is no salary on record to price the encashment" });
  if (!(input.days > 0) || Math.round(input.days * 2) !== input.days * 2) issues.push({ field: "days", message: "Encash whole or half days" });
  else if (input.days > q.encashable) issues.push({ field: "days", message: `You can encash at most ${q.encashable} day(s) of ${q.type.name} now` });
  if (issues.length) return { ok: false as const, issues };

  const enc = calculateLeaveEncashment({ days: input.days, monthlyWage: q.monthlyWage, divisor: q.divisor, isOnExit: false });
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const row = await prisma.leaveEncashmentRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, leaveTypeId: input.leaveTypeId,
      days: input.days, perDayRate: r2(Number(enc.perDayRate)), amount: Number(enc.grossAmount),
      basis: `${input.days} day(s) × ₹${Number(enc.perDayRate).toFixed(2)}/day (${q.code} ÷ ${q.divisor}); fully taxable while in service`,
      reason: input.reason ?? null,
    },
  });
  return { ok: true as const, id: row.id, amount: Number(enc.grossAmount), issues: [] };
}

/**
 * Approve or reject an encashment. Approval needs an open payroll run for the
 * employee's pay group: the days come off the balance and the amount goes on
 * the payslip in the same transaction, so neither can happen without the other.
 */
export async function decideEncashment(opts: { requestId: string; approve: boolean; note?: string | null; deciderEmployeeId?: string | null; actorUserId?: string | null }) {
  const req = await prisma.leaveEncashmentRequest.findUniqueOrThrow({ where: { id: opts.requestId } });
  if (req.status !== "PENDING") return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  const stamp = { decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null };
  if (!opts.approve) {
    await prisma.leaveEncashmentRequest.update({ where: { id: req.id }, data: { status: "REJECTED", ...stamp } });
    return { ok: true, message: "Encashment rejected." };
  }

  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: req.employeeId }, select: { payGroupId: true, dateOfJoining: true } });
  if (!emp.payGroupId) return { ok: false, message: "The employee is not on a pay group." };
  const run = await prisma.payrollRun.findFirst({
    where: { tenantId: req.tenantId, payGroupId: emp.payGroupId, status: { in: ["DRAFT", "IN_PROGRESS"] } },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  if (!run) return { ok: false, message: "There is no open payroll run to pay this in. Start the month's run first." };

  // The balance may have moved since the request was raised.
  const today = new Date();
  const plan = await planFor(req.employeeId, today);
  const yearStart = leaveYearStart(today, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
  const available = await recomputeBalance(req.employeeId, req.leaveTypeId, yearStart);
  const pendingLeave = await prisma.leaveRequest.aggregate({ where: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, status: "PENDING" }, _sum: { totalDays: true } });
  if (Number(req.days) > r2(available - Number(pendingLeave._sum.totalDays ?? 0))) {
    return { ok: false, message: `Only ${r2(available - Number(pendingLeave._sum.totalDays ?? 0))} day(s) are free to encash now.` };
  }
  const type = await prisma.leaveType.findUniqueOrThrow({ where: { id: req.leaveTypeId } });

  await prisma.$transaction(async (tx) => {
    const adhoc = await tx.adhocTransaction.create({
      data: {
        employeeId: req.employeeId, type: "PAYMENT", name: `${type.name} encashment`,
        amount: req.amount, taxTreatment: "TAXABLE", year: run.year, month: run.month, runId: run.id,
        comment: req.basis, createdBy: opts.actorUserId ?? null,
        sourceType: "LeaveEncashment", sourceId: req.id,
      },
    });
    await tx.leaveLedgerEntry.upsert({
      where: { employeeId_leaveTypeId_kind_periodKey: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, kind: "ENCASHMENT", periodKey: `ENCASH:${req.id}` } },
      create: {
        tenantId: req.tenantId, employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, yearStart,
        kind: "ENCASHMENT", days: -Number(req.days), periodKey: `ENCASH:${req.id}`,
        note: `Encashed for ₹${Number(req.amount).toFixed(2)} in the ${run.month}/${run.year} payroll`,
      },
      update: {},
    });
    await tx.leaveEncashmentRequest.update({ where: { id: req.id }, data: { status: "APPROVED", ...stamp, adhocId: adhoc.id, runId: run.id } });
    await recomputeBalance(req.employeeId, req.leaveTypeId, yearStart, tx);
  });
  await calculateRun(run.id);
  return { ok: true, message: `Approved — ₹${Number(req.amount).toFixed(0)} added to the ${run.month}/${run.year} payroll.`, runId: run.id };
}

export async function cancelEncashment(requestId: string, employeeId: string) {
  const req = await prisma.leaveEncashmentRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (req.employeeId !== employeeId) return { ok: false, message: "You can only withdraw your own request." };
  if (req.status !== "PENDING") return { ok: false, message: "Only a pending request can be withdrawn." };
  await prisma.leaveEncashmentRequest.update({ where: { id: req.id }, data: { status: "CANCELLED" } });
  return { ok: true, message: "Withdrawn." };
}

/** Re-exported for screens that label days the way the claim check does. */
export { classifyDay } from "@keka/time";
=======
export interface EncashableType {
  leaveTypeId: string;
  name: string;
  allowed: boolean;
  reason: string | null;
  balance: number;
  encashable: number;
  ratePerDay: number;
}

async function encashedThisYear(employeeId: string, leaveTypeId: string, yearStart: Date, exceptId?: string): Promise<number> {
  const agg = await prisma.leaveEncashmentRequest.aggregate({
    where: { employeeId, leaveTypeId, yearStart, status: { in: ["PENDING", "APPROVED"] }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    _sum: { days: true },
  });
  return Number(agg._sum.days ?? 0);
}

async function pendingLeaveDays(employeeId: string, leaveTypeId: string): Promise<number> {
  const agg = await prisma.leaveRequest.aggregate({ where: { employeeId, leaveTypeId, status: "PENDING" }, _sum: { totalDays: true } });
  return Number(agg._sum.totalDays ?? 0);
}

/** Every leave type in the employee's plan, with whether and how much they may encash. */
export async function encashableTypes(employeeId: string, today: Date = new Date()): Promise<EncashableType[]> {
  const at = utcMidnight(today);
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  const plan = await prisma.leavePlanAssignment.findFirst({
    where: { employeeId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
    orderBy: { effectiveFrom: "desc" }, include: { plan: { include: { types: { include: { leaveType: true } } } } },
  });
  const types = plan?.plan.types.map((t) => t.leaveType)
    ?? await prisma.leaveType.findMany({ where: { tenantId: emp.tenantId, isActive: true } });
  const yearStart = await leaveYearFor(employeeId, at);
  const wages = await monthlyWages(employeeId, at);
  const out: EncashableType[] = [];
  for (const t of types.filter((x) => x.isActive && x.isPaid && !x.isUnlimited && x.category !== "INCIDENT" && x.category !== "FLOATER")) {
    const balance = r2(await recomputeBalance(employeeId, t.id, yearStart));
    const already = await encashedThisYear(employeeId, t.id, yearStart);
    const pendingEncash = await prisma.leaveEncashmentRequest.aggregate({
      where: { employeeId, leaveTypeId: t.id, yearStart, status: "PENDING" }, _sum: { days: true },
    });
    const free = r2(balance - await pendingLeaveDays(employeeId, t.id) - Number(pendingEncash._sum.days ?? 0));
    const allowed = t.allowEncashmentRequest;
    const encashable = allowed ? encashableDays({ freeBalance: free, maxPerYear: t.encashmentMaxDaysPerYear === null ? null : Number(t.encashmentMaxDaysPerYear), encashedThisYear: already }) : 0;
    const { code, divisor } = encashmentFormulaParts(t.encashmentFormula);
    const wage = code === "GROSS" ? wages?.gross ?? 0 : (wages?.byCode(code) || wages?.basic) ?? 0;
    out.push({
      leaveTypeId: t.id, name: t.name, allowed,
      reason: allowed ? (encashable <= 0 ? "No balance left to encash this year" : null) : "You are not allowed to apply for leave encashment",
      balance, encashable, ratePerDay: divisor > 0 ? r2(wage / divisor) : 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function raiseEncashmentRequest(input: {
  employeeId: string; leaveTypeId: string; days?: number | null; all?: boolean; note?: string | null; today?: Date;
}): Promise<Result> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const options = await encashableTypes(input.employeeId, input.today);
  const t = options.find((o) => o.leaveTypeId === input.leaveTypeId);
  if (!t) return { ok: false, message: "That leave type is not in your plan." };
  if (!t.allowed) return { ok: false, message: `${t.name}: you are not allowed to apply for leave encashment.` };
  if (t.encashable <= 0) return { ok: false, message: `${t.name} has no balance left to encash this year.` };
  const want = input.all ? t.encashable : Number(input.days ?? 0);
  if (!Number.isFinite(want) || want <= 0) return { ok: false, message: "Enter how many days to encash." };
  if (Math.round(want * 2) !== want * 2) return { ok: false, message: "Encash whole or half days." };
  if (want > t.encashable) return { ok: false, message: `You can encash at most ${t.encashable} day(s) of ${t.name}.` };
  const yearStart = await leaveYearFor(input.employeeId, utcMidnight(input.today ?? new Date()));
  const req = await prisma.leaveEncashmentRequest.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, leaveTypeId: t.leaveTypeId, yearStart,
      days: want, encashAll: !!input.all, amount: Math.round(t.ratePerDay * want), note: input.note?.trim() || null,
    },
  });
  return { ok: true, message: `Requested encashment of ${want} day(s) of ${t.name}.`, requestId: req.id };
}

/**
 * Approving encashment debits the leave ledger and raises a taxable payment
 * in the next payroll month (in-service encashment is fully taxable).
 */
export async function decideEncashmentRequest(opts: {
  requestId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null; today?: Date;
}): Promise<Result> {
  const req = await prisma.leaveEncashmentRequest.findUniqueOrThrow({ where: { id: opts.requestId }, include: { leaveType: true } });
  if (req.status !== "PENDING") return { ok: false, message: `Already ${req.status.toLowerCase()}.` };
  const decided = { decidedBy: opts.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: opts.note ?? null };
  if (opts.decision === "REJECT") {
    await prisma.leaveEncashmentRequest.update({ where: { id: req.id }, data: { status: "REJECTED", ...decided } });
    return { ok: true, message: "Rejected." };
  }
  const daysToEncash = Number(req.days);
  const balance = await recomputeBalance(req.employeeId, req.leaveTypeId, req.yearStart);
  if (balance - await pendingLeaveDays(req.employeeId, req.leaveTypeId) < daysToEncash - 1e-9) {
    return { ok: false, message: `${req.leaveType.name} no longer has ${daysToEncash} day(s) free to encash (balance ${r2(balance)}).` };
  }
  const today = utcMidnight(opts.today ?? new Date());
  const wages = await monthlyWages(req.employeeId, today);
  const { code, divisor } = encashmentFormulaParts(req.leaveType.encashmentFormula);
  const wage = code === "GROSS" ? wages?.gross ?? 0 : (wages?.byCode(code) || wages?.basic) ?? 0;
  const amount = encashmentEstimate(daysToEncash, wage, divisor);
  const { year, month } = await nextPayrollMonth(req.tenantId, today);

  await prisma.$transaction(async (tx) => {
    await tx.leaveLedgerEntry.create({
      data: {
        tenantId: req.tenantId, employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, yearStart: req.yearStart,
        kind: "ENCASHMENT", days: -daysToEncash, periodKey: `ENCASH:${req.id}`,
        note: `Encashed ${daysToEncash} day(s)`, createdBy: opts.deciderEmployeeId ?? null,
      },
    });
    await recomputeBalance(req.employeeId, req.leaveTypeId, req.yearStart, tx);
    const pay = amount > 0
      ? await tx.adhocTransaction.create({
          data: {
            employeeId: req.employeeId, type: "PAYMENT", name: `${req.leaveType.name} encashment`, componentCode: "LEAVE_ENCASH",
            amount, taxTreatment: "TAXABLE", year, month,
            comment: `${daysToEncash} day(s) at ₹${divisor > 0 ? r2(wage / divisor) : 0}/day (${code} ÷ ${divisor})`,
            sourceType: "LeaveEncashmentRequest", sourceId: req.id, createdBy: opts.deciderEmployeeId ?? null,
          },
        })
      : null;
    await tx.leaveEncashmentRequest.update({
      where: { id: req.id }, data: { status: "APPROVED", amount, adhocTransactionId: pay?.id ?? null, ...decided },
    });
  });
  return {
    ok: true,
    message: amount > 0
      ? `Approved — ₹${amount.toLocaleString("en-IN")} will be paid in the ${month}/${year} payroll.`
      : "Approved — the days are debited; there is no salary on record to price them.",
  };
}

// ---------------------------------------------------------------------------
//  Withdrawing your own pending request
// ---------------------------------------------------------------------------

export type ExtraTimeEntity = "ShiftRequest" | "OvertimeRequest" | "CompOffRequest" | "LeaveEncashmentRequest";

/** Withdraw a pending request the employee raised. Decided requests stay as decided. */
export async function withdrawTimeRequest(entity: ExtraTimeEntity, requestId: string, employeeId: string): Promise<Result> {
  const where = { id: requestId, employeeId, status: "PENDING" as const };
  const n = entity === "ShiftRequest" ? await prisma.shiftRequest.updateMany({ where, data: { status: "CANCELLED" } })
    : entity === "OvertimeRequest" ? await prisma.overtimeRequest.updateMany({ where, data: { status: "CANCELLED" } })
    : entity === "CompOffRequest" ? await prisma.compOffRequest.updateMany({ where, data: { status: "WITHDRAWN" } })
    : await prisma.leaveEncashmentRequest.updateMany({ where, data: { status: "WITHDRAWN" } });
  return n.count > 0 ? { ok: true, message: "Withdrawn." } : { ok: false, message: "Only your own pending requests can be withdrawn." };
}

// ---------------------------------------------------------------------------
//  Comments
// ---------------------------------------------------------------------------

export const TIME_ENTITIES = ["LeaveRequest", "AttendanceRequest", "ShiftRequest", "OvertimeRequest", "CompOffRequest", "LeaveEncashmentRequest"] as const;
export type TimeEntity = (typeof TIME_ENTITIES)[number];

export async function addRequestComment(input: {
  tenantId: string; entityType: TimeEntity; entityId: string; body: string;
  authorEmployeeId?: string | null; authorUserId?: string | null;
}): Promise<Result> {
  const body = input.body.trim();
  if (!body) return { ok: false, message: "Write a comment first." };
  if (body.length > 1024) return { ok: false, message: "Keep comments to 1,024 characters." };
  const c = await prisma.requestComment.create({
    data: {
      tenantId: input.tenantId, entityType: input.entityType, entityId: input.entityId, body,
      authorEmployeeId: input.authorEmployeeId ?? null, authorUserId: input.authorUserId ?? null,
    },
  });
  return { ok: true, message: "Comment added.", requestId: c.id };
}

export async function listRequestComments(tenantId: string, entityType: TimeEntity, entityIds: string[]) {
  if (entityIds.length === 0) return [];
  return prisma.requestComment.findMany({
    where: { tenantId, entityType, entityId: { in: entityIds } },
    orderBy: { createdAt: "asc" },
  });
}

/** For callers that need the raw Prisma payload type of a request row. */
export type ShiftRequestRow = Prisma.ShiftRequestGetPayload<{ include: { shift: true } }>;
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
