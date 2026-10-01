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
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

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
}

// ---------------------------------------------------------------------------
//  Leave encashment
// ---------------------------------------------------------------------------

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
