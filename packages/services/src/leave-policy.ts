import { prisma, Prisma } from "@keka/db";
import { type WorkCalendar, type CountLeaveResult, dayKey, classifyDay } from "@keka/time";
import {
  planFor, leaveYearStart, recomputeBalance, reprocessRange, resolveTimePolicy, employeeHolidayCalendarIds,
} from "./time";
import { notify } from "./lifecycle";
import { compOffCreditFor } from "./time-math";
import {
  type ApprovalChainConfig, type ApprovalStep, type LeaveApprovalActor, type EditableStatus, type LopImportRow,
  effectiveChain, resolveApprovalSteps, parseSteps, usageLimitIssues, optionalHolidayPickIssue,
  parseLopCsv, shiftAllowanceLines, APPROVAL_ROLE_LABEL, EDITABLE_STATUSES,
} from "./leave-policy-math";

export * from "./leave-policy-math";

/**
 * Leave and attendance policy depth against the database: approval chains,
 * usage limits, optional holidays, comp-off grants and auto-credit, admin
 * day edits, the LOP import and shift allowance generation.
 *
 * The rules are pure functions in leave-policy-math; this layer gathers their
 * inputs and persists what they decide. Callers (server actions) check who
 * may act; these functions keep the side effects consistent.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

type Result = { ok: boolean; message: string };

async function leaveYearFor(employeeId: string, at: Date): Promise<Date> {
  const [emp, plan] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { dateOfJoining: true } }),
    planFor(employeeId, at),
  ]);
  return leaveYearStart(at, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
}

/** Has a finalised payroll for this employee already covered the date? */
async function payrollLocked(employeeId: string, date: Date): Promise<{ year: number; month: number } | null> {
  return prisma.payrollRun.findFirst({
    where: { status: "FINALIZED", periodStart: { lte: date }, periodEnd: { gte: date }, lines: { some: { employeeId } } },
    select: { year: true, month: true },
  });
}

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

/** The chain a new request of this type follows, or null for a single decision. */
export async function approvalChainFor(employeeId: string, leaveTypeId: string, at: Date): Promise<ApprovalChainConfig | null> {
  const [type, plan] = await Promise.all([
    prisma.leaveType.findUniqueOrThrow({ where: { id: leaveTypeId }, select: { approvalChain: true } }),
    planFor(employeeId, at),
  ]);
  return effectiveChain(type.approvalChain, plan?.plan.approvalChain ?? null);
}

/** The steps to store on a new request; null keeps today's single decision. */
export async function stepsForNewRequest(employeeId: string, leaveTypeId: string, at: Date): Promise<ApprovalStep[] | null> {
  const cfg = await approvalChainFor(employeeId, leaveTypeId, at);
  if (!cfg) return null;
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { id: true, reportingManagerId: true, reportingManager: { select: { reportingManagerId: true } }, department: { select: { headId: true } } },
  });
  return resolveApprovalSteps(cfg, {
    employeeId: emp.id,
    managerId: emp.reportingManagerId,
    skipManagerId: emp.reportingManager?.reportingManagerId ?? null,
    departmentHeadId: emp.department?.headId ?? null,
  });
}

/** "Priya Sharma", "HR", or the default "Reporting manager / HR" wording. */
export async function stepLabel(step: ApprovalStep | null | undefined): Promise<string> {
  if (!step) return "HR";
  if (step.approverId) {
    const e = await prisma.employee.findUnique({ where: { id: step.approverId }, select: { displayName: true, firstName: true, lastName: true } });
    if (e) return e.displayName ?? `${e.firstName} ${e.lastName}`;
  }
  return APPROVAL_ROLE_LABEL[step.role];
}

export interface ChainState {
  steps: ApprovalStep[];
  level: number;
  current: ApprovalStep | null;
}

export function chainState(request: { approvalSteps: unknown; approvalLevel: number }): ChainState | null {
  const steps = parseSteps(request.approvalSteps);
  if (!steps) return null;
  return { steps, level: request.approvalLevel, current: steps[request.approvalLevel] ?? null };
}

/** Tell the person who holds the next level that a request is waiting for them. */
export async function notifyNextApprover(tenantId: string, employeeId: string, step: ApprovalStep, what: string): Promise<number> {
  if (!step.approverId) return 0;
  const [approver, emp] = await Promise.all([
    prisma.employee.findFirst({ where: { id: step.approverId, tenantId }, select: { userId: true } }),
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { displayName: true, firstName: true, lastName: true } }),
  ]);
  if (!approver?.userId || !emp) return 0;
  return notify({
    tenantId, userIds: [approver.userId], kind: "LEAVE",
    title: `${emp.displayName ?? `${emp.firstName} ${emp.lastName}`}'s ${what} is waiting for your approval`, body: null, link: "/inbox",
  });
}

/**
 * Approve every pending request whose current level has waited out its
 * chain's auto-approve window. Idempotent: an approved request is skipped.
 */
export async function autoApproveStaleLeave(tenantId: string, today: Date = new Date()): Promise<{ checked: number; approved: number }> {
  const { decideLeave } = await import("./time");
  const pending = await prisma.leaveRequest.findMany({
    where: { tenantId, status: "PENDING", approvalSteps: { not: Prisma.DbNull } },
    select: { id: true, employeeId: true, leaveTypeId: true, fromDate: true, levelSince: true, createdAt: true },
  });
  const { autoApproveDue } = await import("./leave-policy-math");
  let approved = 0;
  for (const r of pending) {
    const cfg = await approvalChainFor(r.employeeId, r.leaveTypeId, r.fromDate);
    if (!cfg?.autoApproveAfterDays) continue;
    if (!autoApproveDue(r.levelSince ?? r.createdAt, cfg.autoApproveAfterDays, today)) continue;
    const res = await decideLeave({ requestId: r.id, decision: "APPROVE", auto: true });
    if (res.ok) approved++;
  }
  return { checked: pending.length, approved };
}

// ---------------------------------------------------------------------------
//  Usage limits
// ---------------------------------------------------------------------------

/** The type's usage limits checked against the employee's other requests of it. */
export async function usageIssuesFor(input: {
  employeeId: string;
  type: { id: string; name: string; maxDaysPerMonth: unknown; minGapBetweenLeavesDays: number | null; maxConsecutiveDays: unknown };
  count: CountLeaveResult;
  from: Date;
  to: Date;
  calendar: WorkCalendar;
  exceptRequestId?: string;
}): Promise<Array<{ field: string; message: string }>> {
  const t = input.type;
  const maxDaysPerMonth = t.maxDaysPerMonth == null ? null : Number(t.maxDaysPerMonth);
  const maxConsecutiveDays = t.maxConsecutiveDays == null ? null : Number(t.maxConsecutiveDays);
  if (!maxDaysPerMonth && !t.minGapBetweenLeavesDays && !maxConsecutiveDays) return [];
  // Wide enough for the month bounds, the gap and an adjoining run.
  const pad = Math.max(62, (t.minGapBetweenLeavesDays ?? 0) + 1) * DAY;
  const others = await prisma.leaveRequest.findMany({
    where: {
      employeeId: input.employeeId, leaveTypeId: t.id, status: { in: ["PENDING", "APPROVED"] },
      fromDate: { lte: new Date(input.to.getTime() + pad) }, toDate: { gte: new Date(input.from.getTime() - pad) },
      ...(input.exceptRequestId ? { id: { not: input.exceptRequestId } } : {}),
    },
    select: { fromDate: true, toDate: true, days: { select: { date: true, dayValue: true } } },
  });
  return usageLimitIssues({
    limits: { name: t.name, maxDaysPerMonth, minGapDays: t.minGapBetweenLeavesDays, maxConsecutiveDays },
    request: { from: input.from, to: input.to, days: input.count.days.map((d) => ({ key: d.key, value: d.value })) },
    others: others.map((o) => ({ from: o.fromDate, to: o.toDate, days: o.days.map((d) => ({ key: dayKey(d.date), value: Number(d.dayValue) })) })),
    isOffDay: (k) => {
      const kind = classifyDay(new Date(`${k}T00:00:00Z`), input.calendar);
      return kind === "WEEKLY_OFF" || kind === "HOLIDAY";
    },
  });
}

// ---------------------------------------------------------------------------
//  Optional holidays
// ---------------------------------------------------------------------------

export interface OptionalHolidayView {
  calendars: Array<{ id: string; name: string; year: number; quota: number; picked: number }>;
  holidays: Array<{ id: string; calendarId: string; name: string; date: Date; picked: boolean; past: boolean }>;
}

/** The optional holidays an employee may pick in a year, and which they have. */
export async function optionalHolidaysFor(employeeId: string, year: number, today: Date = new Date()): Promise<OptionalHolidayView> {
  const at = new Date(Date.UTC(year, 6, 1));
  const calendarIds = await employeeHolidayCalendarIds(employeeId, at);
  const calendars = calendarIds.length
    ? await prisma.holidayCalendar.findMany({ where: { id: { in: calendarIds } }, select: { id: true, name: true, year: true, optionalHolidayQuota: true } })
    : [];
  const holidays = await prisma.holiday.findMany({
    where: { calendarId: { in: calendars.map((c) => c.id) }, isOptional: true, date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
    orderBy: { date: "asc" },
    include: { selections: { where: { employeeId }, select: { id: true } } },
  });
  const t = utcMidnight(today).getTime();
  return {
    calendars: calendars.map((c) => ({
      id: c.id, name: c.name, year: c.year, quota: c.optionalHolidayQuota,
      picked: holidays.filter((h) => h.calendarId === c.id && h.selections.length > 0).length,
    })),
    holidays: holidays.map((h) => ({ id: h.id, calendarId: h.calendarId, name: h.name, date: h.date, picked: h.selections.length > 0, past: h.date.getTime() < t })),
  };
}

export async function pickOptionalHoliday(input: { employeeId: string; holidayId: string; byUserId?: string | null; today?: Date }): Promise<Result> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  const h = await prisma.holiday.findFirst({ where: { id: input.holidayId, calendar: { tenantId: emp.tenantId } }, include: { calendar: true } });
  if (!h) return { ok: false, message: "Holiday not found." };
  const mine = await employeeHolidayCalendarIds(input.employeeId, h.date);
  if (!mine.includes(h.calendarId)) return { ok: false, message: "That holiday is not on your holiday calendar." };
  const today = utcMidnight(input.today ?? new Date());
  const [picked, already, leave] = await Promise.all([
    prisma.optionalHolidaySelection.count({ where: { employeeId: input.employeeId, holiday: { calendarId: h.calendarId } } }),
    prisma.optionalHolidaySelection.findUnique({ where: { employeeId_holidayId: { employeeId: input.employeeId, holidayId: h.id } } }),
    prisma.leaveRequestDay.count({ where: { date: h.date, isSandwich: false, request: { employeeId: input.employeeId, status: { in: ["PENDING", "APPROVED"] } } } }),
  ]);
  const issue = optionalHolidayPickIssue({
    isOptional: h.isOptional, quota: h.calendar.optionalHolidayQuota, pickedThisCalendar: picked,
    alreadyPicked: !!already, date: h.date, today, hasLeaveThatDay: leave > 0,
  });
  if (issue) return { ok: false, message: issue };
  await prisma.optionalHolidaySelection.create({
    data: { tenantId: emp.tenantId, employeeId: input.employeeId, holidayId: h.id, createdBy: input.byUserId ?? null },
  });
  if (h.date.getTime() <= today.getTime()) await reprocessRange(input.employeeId, h.date, h.date);
  return { ok: true, message: `${h.name} is now a holiday for you (${picked + 1} of ${h.calendar.optionalHolidayQuota} picked).` };
}

export async function unpickOptionalHoliday(input: { employeeId: string; holidayId: string; today?: Date; force?: boolean }): Promise<Result> {
  const sel = await prisma.optionalHolidaySelection.findUnique({
    where: { employeeId_holidayId: { employeeId: input.employeeId, holidayId: input.holidayId } }, include: { holiday: true },
  });
  if (!sel) return { ok: false, message: "You have not picked that holiday." };
  const today = utcMidnight(input.today ?? new Date());
  if (sel.holiday.date.getTime() < today.getTime() && !input.force) {
    return { ok: false, message: "That holiday has passed; ask HR to change it." };
  }
  await prisma.optionalHolidaySelection.delete({ where: { id: sel.id } });
  if (sel.holiday.date.getTime() <= today.getTime()) await reprocessRange(input.employeeId, sel.holiday.date, sel.holiday.date);
  return { ok: true, message: `Removed ${sel.holiday.name}.` };
}

// ---------------------------------------------------------------------------
//  Comp-off: grants and auto-credit
// ---------------------------------------------------------------------------

async function compOffType(tenantId: string) {
  return prisma.leaveType.findFirst({ where: { tenantId, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } });
}

/**
 * HR or a manager grants comp-off directly: a COMP_OFF_CREDIT on the ledger
 * that lapses on its expiry date, usable like any other leave balance.
 */
export async function grantCompOff(input: {
  employeeId: string; days: number; note: string; workedOn?: Date | null; expiresOn?: Date | null;
  grantedByEmployeeId?: string | null; today?: Date;
}): Promise<Result & { ledgerEntryId?: string; expiresOn?: Date | null }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true } });
  if (!(input.days > 0) || input.days > 10 || Math.round(input.days * 2) !== input.days * 2) {
    return { ok: false, message: "Grant between 0.5 and 10 days, in half days." };
  }
  if (!input.note.trim()) return { ok: false, message: "Say why the comp-off is granted." };
  const type = await compOffType(emp.tenantId);
  if (!type) return { ok: false, message: "Your organisation has no compensatory-off leave type. Create one first." };
  const today = utcMidnight(input.today ?? new Date());
  const expiresOn = input.expiresOn ? utcMidnight(input.expiresOn)
    : type.expiryDaysAfterCredit ? new Date(today.getTime() + type.expiryDaysAfterCredit * DAY) : null;
  if (expiresOn && expiresOn.getTime() <= today.getTime()) return { ok: false, message: "The expiry date must be in the future." };
  const yearStart = await leaveYearFor(input.employeeId, today);
  const entry = await prisma.$transaction(async (tx) => {
    const e = await tx.leaveLedgerEntry.create({
      data: {
        tenantId: emp.tenantId, employeeId: input.employeeId, leaveTypeId: type.id, yearStart,
        kind: "COMP_OFF_CREDIT", days: input.days,
        periodKey: `COMPOFF-GRANT:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        note: `${input.note.trim()}${input.workedOn ? ` (worked ${dayKey(input.workedOn)})` : ""}`,
        expiresOn, createdBy: input.grantedByEmployeeId ?? null,
      },
    });
    await recomputeBalance(input.employeeId, type.id, yearStart, tx);
    return e;
  });
  return {
    ok: true, ledgerEntryId: entry.id, expiresOn,
    message: `Granted ${input.days} day(s) of ${type.name}${expiresOn ? `, expiring ${dayKey(expiresOn)}` : ""}.`,
  };
}

/**
 * Credit comp-off for worked weekly offs and holidays when the attendance
 * policy says so. Called by attendance processing with the evaluated days;
 * one credit per day (the ledger's period key), never for a day already
 * claimed through a comp-off request.
 */
export async function autoCreditCompOffDays(input: {
  tenantId: string; employeeId: string;
  days: Array<{ date: Date; status: string; effectiveHours: number; requiredHours: number }>;
  fullPct: number; halfPct: number;
}, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const worked = input.days.filter((d) => (d.status === "WEEKLY_OFF" || d.status === "HOLIDAY") && d.effectiveHours > 0);
  if (worked.length === 0) return 0;
  const type = await compOffType(input.tenantId);
  if (!type) return 0;
  const keys = worked.map((d) => `COMPOFF-AUTO:${dayKey(d.date)}`);
  const [done, claimed] = await Promise.all([
    tx.leaveLedgerEntry.findMany({ where: { employeeId: input.employeeId, leaveTypeId: type.id, kind: "COMP_OFF_CREDIT", periodKey: { in: keys } }, select: { periodKey: true } }),
    tx.compOffRequest.findMany({
      where: { employeeId: input.employeeId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: worked[worked.length - 1].date }, toDate: { gte: worked[0].date } },
      select: { fromDate: true, toDate: true },
    }),
  ]);
  const doneKeys = new Set(done.map((d) => d.periodKey));
  let credited = 0;
  for (const d of worked) {
    const periodKey = `COMPOFF-AUTO:${dayKey(d.date)}`;
    if (doneKeys.has(periodKey)) continue;
    if (claimed.some((c) => c.fromDate.getTime() <= d.date.getTime() && c.toDate.getTime() >= d.date.getTime())) continue;
    const credit = compOffCreditFor(d.effectiveHours, d.requiredHours, input.fullPct, input.halfPct);
    if (credit <= 0) continue;
    const yearStart = await leaveYearFor(input.employeeId, d.date);
    await tx.leaveLedgerEntry.create({
      data: {
        tenantId: input.tenantId, employeeId: input.employeeId, leaveTypeId: type.id, yearStart,
        kind: "COMP_OFF_CREDIT", days: credit, periodKey,
        note: `Worked ${d.effectiveHours}h on a ${d.status === "HOLIDAY" ? "holiday" : "weekly off"} (${dayKey(d.date)})`,
        expiresOn: type.expiryDaysAfterCredit ? new Date(utcMidnight(d.date).getTime() + type.expiryDaysAfterCredit * DAY) : null,
      },
    });
    await recomputeBalance(input.employeeId, type.id, yearStart, tx);
    credited++;
  }
  return credited;
}

// ---------------------------------------------------------------------------
//  Admin attendance edit
// ---------------------------------------------------------------------------

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export interface DaySnapshot { status: string; firstIn: string | null; lastOut: string | null; payableValue: number; lopValue: number; manualStatus: string | null }

async function snapshot(employeeId: string, date: Date): Promise<DaySnapshot | null> {
  const r = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date } } });
  return r && {
    status: r.status, firstIn: r.firstIn?.toISOString() ?? null, lastOut: r.lastOut?.toISOString() ?? null,
    payableValue: Number(r.payableValue), lopValue: Number(r.lopValue), manualStatus: r.manualStatus,
  };
}

/**
 * Correct one day for an employee: replace its punches with an in and an out
 * time, and/or pin its status. Replaced punches are kept as REJECTED for the
 * audit trail; a pinned status survives every later reprocess until cleared
 * ("AUTO"). The reason is stored on the day.
 */
export async function editAttendanceDay(input: {
  employeeId: string; date: Date;
  /** A status to pin, "AUTO" to clear a pin, or null/undefined to leave it. */
  status?: EditableStatus | "AUTO" | null;
  /** Local wall-clock "HH:MM"; both or neither. */
  firstIn?: string | null; lastOut?: string | null;
  reason: string; actorUserId?: string | null; today?: Date;
}): Promise<Result & { before?: DaySnapshot | null; after?: DaySnapshot | null }> {
  const date = utcMidnight(input.date);
  const today = utcMidnight(input.today ?? new Date());
  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: "Give a reason for the change; it is kept with the day." };
  if (date.getTime() > today.getTime()) return { ok: false, message: "Only days up to today can be edited." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, dateOfJoining: true } });
  if (date.getTime() < utcMidnight(emp.dateOfJoining).getTime()) return { ok: false, message: "That day is before the employee joined." };
  const locked = await payrollLocked(input.employeeId, date);
  if (locked) return { ok: false, message: `Payroll for ${locked.month}/${locked.year} is finalised. Correct it with an LOP adjustment in the next run.` };
  const status = input.status ?? null;
  if (status && status !== "AUTO" && !(EDITABLE_STATUSES as readonly string[]).includes(status)) return { ok: false, message: "Unknown status." };
  const inT = input.firstIn?.trim() || null, outT = input.lastOut?.trim() || null;
  if ((inT && !outT) || (!inT && outT)) return { ok: false, message: "Give both the in and the out time, or neither." };
  if ((inT && !HHMM.test(inT)) || (outT && !HHMM.test(outT))) return { ok: false, message: "Times are HH:MM, 24-hour." };
  if (!status && !inT) return { ok: false, message: "Change the status, the punches, or both." };

  const before = await snapshot(input.employeeId, date);
  const policy = await resolveTimePolicy(input.employeeId, date);
  const tz = policy.tzOffset;

  await prisma.$transaction(async (tx) => {
    if (inT && outT) {
      const at = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number);
        return new Date(date.getTime() + (h * 60 + m - tz) * 60_000);
      };
      const inAt = at(inT);
      let outAt = at(outT);
      if (outAt.getTime() <= inAt.getTime()) outAt = new Date(outAt.getTime() + DAY);
      const dayStart = new Date(date.getTime() - tz * 60_000);
      await tx.attendanceLog.updateMany({
        where: { employeeId: input.employeeId, status: "VALID", timestamp: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) } },
        data: { status: "REJECTED", comment: `Replaced by an admin edit: ${reason}`.slice(0, 500) },
      });
      await tx.attendanceLog.createMany({
        data: [
          { tenantId: emp.tenantId, employeeId: input.employeeId, timestamp: inAt, direction: 0, source: "MANUAL", comment: reason.slice(0, 500) },
          { tenantId: emp.tenantId, employeeId: input.employeeId, timestamp: outAt, direction: 1, source: "MANUAL", comment: reason.slice(0, 500) },
        ],
      });
    }
    const pinned = status === "AUTO" ? null : status ?? undefined;
    await tx.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: input.employeeId, date } },
      create: {
        tenantId: emp.tenantId, employeeId: input.employeeId, date,
        manualStatus: pinned ?? null, editedBy: input.actorUserId ?? null, editedAt: new Date(), editReason: reason,
      },
      update: {
        ...(pinned !== undefined ? { manualStatus: pinned } : {}),
        editedBy: input.actorUserId ?? null, editedAt: new Date(), editReason: reason,
      },
    });
  });
  await reprocessRange(input.employeeId, date, date);
  const after = await snapshot(input.employeeId, date);
  return { ok: true, before, after, message: `Saved. ${dayKey(date)} now counts as ${after?.status.replace(/_/g, " ").toLowerCase() ?? "updated"}.` };
}

// ---------------------------------------------------------------------------
//  LOP import
// ---------------------------------------------------------------------------

export interface LopImportSummary {
  ok: boolean;
  message: string;
  rows: Array<LopImportRow & { employeeId: string; name: string }>;
  errors: Array<{ line: number; message: string }>;
  created: number;
  cleared: number;
}

/**
 * Import LOP days per employee per month. Each row replaces that employee's
 * manual LOP for the month (as the run screen does) — reversals are kept.
 * Nothing is written while any row has an error, or when apply is false.
 * Payroll reads these rows for the month like any other manual LOP.
 */
export async function importLopDays(input: {
  tenantId: string; csv: string; apply: boolean; actorUserId?: string | null;
  /** Employees the importer may touch; null means everyone in the tenant. */
  allowedEmployeeIds?: string[] | null;
}): Promise<LopImportSummary> {
  const parsed = parseLopCsv(input.csv);
  const errors = [...parsed.errors];
  const numbers = [...new Set(parsed.rows.map((r) => r.employeeNumber))];
  const emps = numbers.length
    ? await prisma.employee.findMany({
        where: { tenantId: input.tenantId, employeeNumber: { in: numbers, mode: "insensitive" } },
        select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true },
      })
    : [];
  const byNumber = new Map(emps.map((e) => [e.employeeNumber.toUpperCase(), e]));
  const allowed = input.allowedEmployeeIds ? new Set(input.allowedEmployeeIds) : null;
  const rows: LopImportSummary["rows"] = [];
  for (const r of parsed.rows) {
    const e = byNumber.get(r.employeeNumber.toUpperCase());
    if (!e || (allowed && !allowed.has(e.id))) { errors.push({ line: r.line, message: `No employee ${r.employeeNumber} in your scope.` }); continue; }
    const closed = await prisma.payrollRun.findFirst({
      where: { tenantId: input.tenantId, year: r.year, month: r.month, status: "FINALIZED", lines: { some: { employeeId: e.id } } },
      select: { id: true },
    });
    if (closed) { errors.push({ line: r.line, message: `Payroll for ${r.month}/${r.year} is finalised for ${r.employeeNumber}.` }); continue; }
    rows.push({ ...r, employeeId: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}` });
  }
  errors.sort((a, b) => a.line - b.line);
  const base = { rows, errors, created: 0, cleared: 0 };
  if (errors.length > 0) return { ...base, ok: false, message: `${errors.length} row(s) need fixing; nothing was imported.` };
  if (rows.length === 0) return { ...base, ok: false, message: "No rows to import." };
  if (!input.apply) return { ...base, ok: true, message: `${rows.length} row(s) ready to import.` };

  let created = 0, cleared = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      // One manual LOP figure per employee per month, as on the run screen;
      // reversals of earlier months are a separate thing and stay.
      const del = await tx.lopAdjustment.deleteMany({
        where: { tenantId: input.tenantId, employeeId: r.employeeId, year: r.year, month: r.month, reversalForYear: null },
      });
      cleared += del.count;
      if (r.days > 0) {
        await tx.lopAdjustment.create({
          data: {
            tenantId: input.tenantId, employeeId: r.employeeId, year: r.year, month: r.month, days: r.days,
            note: r.note ?? "Imported", source: "IMPORT", createdBy: input.actorUserId ?? null,
          },
        });
        created++;
      }
    }
  });
  return { ...base, ok: true, created, cleared, message: `Imported LOP for ${rows.length} employee-month(s): ${created} set, ${rows.length - created} cleared. Recalculate open payroll runs to pick them up.` };
}

// ---------------------------------------------------------------------------
//  Shift allowance
// ---------------------------------------------------------------------------

export interface ShiftAllowanceSummary { employees: number; entries: number; days: number; amount: number; skippedPaid: number }

/**
 * Build the month's shift allowance from processed attendance: one entry per
 * employee per allowance-bearing shift, days worked × the shift's rate.
 * Re-running replaces the generated entries not yet paid; entries a
 * finalised payroll has processed are left alone and not duplicated.
 */
export async function generateShiftAllowances(input: { tenantId: string; year: number; month: number; employeeIds?: string[] }): Promise<ShiftAllowanceSummary> {
  const start = new Date(Date.UTC(input.year, input.month - 1, 1));
  const end = new Date(Date.UTC(input.year, input.month, 0));
  const shifts = await prisma.shift.findMany({
    where: { tenantId: input.tenantId, allowanceCode: { not: null }, allowancePerDay: { gt: 0 } },
    select: { id: true, code: true, allowanceCode: true, allowancePerDay: true },
  });
  const summary: ShiftAllowanceSummary = { employees: 0, entries: 0, days: 0, amount: 0, skippedPaid: 0 };
  const scope = input.employeeIds ? { employeeId: { in: input.employeeIds } } : {};
  const records = shifts.length
    ? await prisma.attendanceRecord.findMany({
        where: { tenantId: input.tenantId, date: { gte: start, lte: end }, shiftId: { in: shifts.map((s) => s.id) }, ...scope },
        select: { employeeId: true, shiftId: true, status: true, payableValue: true },
      })
    : [];
  const lines = shiftAllowanceLines(
    records.map((r) => ({ employeeId: r.employeeId, shiftId: r.shiftId, status: r.status, payableValue: Number(r.payableValue) })),
    new Map(shifts.map((s) => [s.id, { code: s.code, allowanceCode: s.allowanceCode, perDay: Number(s.allowancePerDay) }])),
  );
  await prisma.$transaction(async (tx) => {
    await tx.shiftAllowanceEntry.deleteMany({
      where: { tenantId: input.tenantId, year: input.year, month: input.month, isGenerated: true, isProcessed: false, runId: null, ...scope },
    });
    const paid = await tx.shiftAllowanceEntry.findMany({
      where: { tenantId: input.tenantId, year: input.year, month: input.month, isGenerated: true, OR: [{ isProcessed: true }, { runId: { not: null } }], ...scope },
      select: { employeeId: true, shiftCode: true },
    });
    const paidKeys = new Set(paid.map((p) => `${p.employeeId}:${p.shiftCode}`));
    const people = new Set<string>();
    for (const l of lines) {
      if (paidKeys.has(`${l.employeeId}:${l.shiftCode}`)) { summary.skippedPaid++; continue; }
      await tx.shiftAllowanceEntry.create({
        data: {
          tenantId: input.tenantId, employeeId: l.employeeId, year: input.year, month: input.month,
          shiftCode: l.shiftCode, allowanceCode: l.allowanceCode, days: l.days, amount: l.amount, isGenerated: true,
        },
      });
      people.add(l.employeeId);
      summary.entries++;
      summary.days = r2(summary.days + l.days);
      summary.amount = r2(summary.amount + l.amount);
    }
    summary.employees = people.size;
  });
  return summary;
}
