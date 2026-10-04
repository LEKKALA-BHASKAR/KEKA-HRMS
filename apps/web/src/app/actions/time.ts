"use server";

import { headers } from "next/headers";
import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  applyLeave, previewLeave, decideLeave, cancelLeave, adjustBalance, runAccrual,
  recordPunch, raiseAttendanceRequest, decideAttendanceRequest, processAttendance,
  notifyTimeRequest, lapseExpiredCompOffs, runLeaveYearEnd, parseSteps, actingForIds,
} from "@keka/services";
import { formatDate } from "@keka/shared";
import { foreignReference } from "@/lib/ownership";
import { saveFile, sniffUpload } from "@/lib/storage";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { leaveActor } from "@/lib/time-decide";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zDate, zRequiredDate, zBool, zId, zOptionalId,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const PORTIONS = ["FULL_DAY", "FIRST_HALF", "SECOND_HALF", "QUARTER"] as const;

/** Can the viewer act on this employee's time records with this permission? */
async function reaches(viewer: Viewer, employeeId: string, permission: (typeof P)[keyof typeof P]) {
  if (viewer.employee?.id === employeeId) return true;
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

// ---------------------------------------------------------------------------
//  LEAVE — apply, preview, decide, cancel
// ---------------------------------------------------------------------------

const applySchema = z.object({
  employeeId: zOptionalId(),
  leaveTypeId: zId(),
  fromDate: zRequiredDate(),
  toDate: zDate(),
  fromPortion: z.enum(PORTIONS).default("FULL_DAY"),
  toPortion: z.enum(PORTIONS).default("FULL_DAY"),
  reason: zOptional(500),
  intent: z.enum(["preview", "apply"]).default("apply"),
  /** Hourly leave types: hours on the date and when they start. */
  hours: zNumber({ min: 0.25, max: 24 }),
  startTime: z.string().max(5).optional().transform((v) => (v ? v : null)),
});

/** Colleagues copied on a request ("Notify"), kept to real people in the tenant. */
async function copiedIds(viewer: Viewer, formData: FormData, self: string | undefined): Promise<string[]> {
  const raw = [...new Set(formList(formData, "notify"))].filter((id) => id !== self).slice(0, 20);
  if (raw.length === 0) return [];
  const rows = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: raw } }, select: { id: true } });
  return rows.map((r) => r.id);
}
const between = (a: Date, b: Date) => (a.getTime() === b.getTime() ? `on ${formatDate(a)}` : `from ${formatDate(a)} to ${formatDate(b)}`);

export async function applyLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(applySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const toDate = d.toDate ?? d.fromDate;

  // Applying for yourself needs nothing; applying for someone else needs
  // leave management over them.
  const employeeId = d.employeeId ?? viewer.employee?.id;
  if (!employeeId) return { ok: false, message: "No employee record linked to this login." };
  const onBehalf = employeeId !== viewer.employee?.id;
  if (onBehalf && !(await reaches(viewer, employeeId, P.LEAVE_MANAGE))) {
    return { ok: false, message: "You cannot apply leave on behalf of this employee." };
  }

  const type = await prisma.leaveType.findFirst({ where: { id: d.leaveTypeId, tenantId: viewer.tenantId } });
  if (!type) return { ok: false, message: "Leave type not found." };

  const input = {
    employeeId, leaveTypeId: d.leaveTypeId, from: d.fromDate, to: toDate,
    fromPortion: d.fromPortion, toPortion: toDate.getTime() === d.fromDate.getTime() ? d.fromPortion : d.toPortion,
    reason: d.reason, onBehalf, requestedByEmployeeId: onBehalf ? viewer.employee?.id ?? null : null,
    hours: type.unit === "HOURS" ? d.hours : null, startTime: type.unit === "HOURS" ? d.startTime : null,
  };
  const unitWord = type.unit === "HOURS" ? "hour(s)" : "day(s)";
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));

  try {
    if (d.intent === "preview") {
      const p = await previewLeave(input);
      const summary =
        `${p.count.totalDays} ${unitWord}` +
        (p.count.sandwichDays > 0 ? `, including ${p.count.sandwichDays} sandwiched weekly-off/holiday day(s)` : "") +
        (type.isPaid && !type.isUnlimited && type.category !== "INCIDENT"
          ? `. Available ${p.available}, leaving ${Math.round((p.available - p.count.totalDays) * 100) / 100}.`
          : type.isPaid ? "." : ". Unpaid — these days will be loss of pay.") +
        (p.advanceDays > 0 ? ` ${p.advanceDays} ${unitWord} of this are taken in advance and recovered from your next accruals.` : "");
      if (p.issues.length > 0) {
        return {
          ok: false, message: `${summary} ${p.issues.map((i) => i.message).join(" ")}`,
          errors: Object.fromEntries(p.issues.map((i) => [i.field, i.message])), values,
        };
      }
      return { ok: true, message: `${summary} Ready to submit.`, values };
    }

    const res = await applyLeave(input);
    if (!res.ok) {
      return {
        ok: false, message: res.issues.map((i) => i.message).join(" "),
        errors: Object.fromEntries(res.issues.map((i) => [i.field, i.message])), values,
      };
    }
    await writeAudit(viewer, {
      module: "LEAVE", action: "CREATE", entityType: "LeaveRequest", entityId: res.requestId,
      summary: `${onBehalf ? "Applied on behalf" : "Applied"}: ${type.name}, ${res.totalDays} ${unitWord}${res.advanceDays ? ` (${res.advanceDays} in advance)` : ""}`,
    });
    const copied = await copiedIds(viewer, formData, employeeId);
    if (copied.length) await prisma.leaveRequest.update({ where: { id: res.requestId! }, data: { notifyEmployeeIds: copied } });
    if (!onBehalf) {
      await notifyTimeRequest({
        tenantId: viewer.tenantId, employeeId, kind: "LEAVE", event: "RAISED",
        what: `${type.name} ${between(d.fromDate, toDate)}`, notifyEmployeeIds: copied, note: d.reason,
      });
    }
    return done(["/me/leave", "/leave", "/inbox"],
      `Submitted ${res.totalDays} ${unitWord} of ${type.name}${res.sandwichDays ? ` (${res.sandwichDays} sandwiched)` : ""}${res.advanceDays ? `, ${res.advanceDays} of them in advance of accrual` : ""}. It is now awaiting approval.`);
  } catch (err) {
    return toErrorState(err, values);
  }
}

export async function decideLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_APPROVE);
  const requestId = String(formData.get("requestId"));
  const decision = String(formData.get("decision")) === "approve" ? "APPROVE" : "REJECT";
  const note = String(formData.get("note") ?? "") || null;

  const request = await prisma.leaveRequest.findFirst({
    where: { id: requestId, tenantId: viewer.tenantId }, include: { leaveType: { select: { name: true } } },
  });
  if (!request) return { ok: false, message: "Request not found." };
  if (request.employeeId === viewer.employee?.id) {
    return { ok: false, message: "You cannot approve your own leave." };
  }
  // A chain level can name someone outside the reporting line (a dotted-line
  // manager); while it is their level they may decide it — as may anyone
  // they have delegated their approvals to for today.
  const steps = parseSteps(request.approvalSteps);
  const current = steps?.[request.approvalLevel];
  const namedApprover = !!viewer.employee && !!current && current.status === "PENDING" && !!current.approverId
    && (current.approverId === viewer.employee.id || (await actingForIds(viewer.tenantId, viewer.employee.id)).includes(current.approverId));
  if (!namedApprover && !(await reaches(viewer, request.employeeId, P.LEAVE_APPROVE))) {
    return { ok: false, message: "This request is outside the employees your roles reach." };
  }
  if (decision === "REJECT" && !note) {
    return { ok: false, message: "Give a reason when rejecting.", errors: { note: "Required" } };
  }

  try {
    const actor = await leaveActor(viewer, request.employeeId);
    // A delegate decides the level in the name of the manager who delegated it.
    if (namedApprover && current?.approverId && current.approverId !== viewer.employee?.id) actor.employeeId = current.approverId;
    const res = await decideLeave({ requestId, decision, approverEmployeeId: viewer.employee?.id, note, actor });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, {
      module: "LEAVE", action: decision === "APPROVE" ? "APPROVE" : "REJECT",
      entityType: "LeaveRequest", entityId: requestId,
      summary: `${decision === "APPROVE" ? "Approved" : "Rejected"} ${request.leaveType.name}, ${request.totalDays} day(s)`,
    });
    if (!res.pendingLevel) {
      await notifyTimeRequest({
        tenantId: viewer.tenantId, employeeId: request.employeeId, kind: "LEAVE",
        event: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        what: `${request.leaveType.name} ${between(request.fromDate, request.toDate)}`, note,
      });
    }
    return done(["/leave", "/inbox", "/me/leave"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function cancelLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId"));
  const request = await prisma.leaveRequest.findFirst({ where: { id: requestId, tenantId: viewer.tenantId } });
  if (!request) return { ok: false, message: "Request not found." };

  const own = request.employeeId === viewer.employee?.id;
  if (!own && !(await reaches(viewer, request.employeeId, P.LEAVE_MANAGE))) {
    return { ok: false, message: "You can only cancel your own leave." };
  }
  // Employees may withdraw pending leave freely, but cancelling leave that has
  // already started needs an administrator.
  if (own && request.status === "APPROVED" && request.fromDate.getTime() <= Date.now() &&
      !can(viewer, P.LEAVE_MANAGE)) {
    return { ok: false, message: "This leave has already started. Ask HR to cancel it." };
  }

  try {
    const res = await cancelLeave({ requestId, byEmployeeId: viewer.employee?.id });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, {
      module: "LEAVE", action: "UPDATE", entityType: "LeaveRequest", entityId: requestId,
      summary: `Cancelled leave request (${request.totalDays} day(s))`,
    });
    return done(["/me/leave", "/leave", "/inbox"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

const adjustSchema = z.object({
  employeeId: zId(), leaveTypeId: zId(),
  days: zRequiredNumber({ min: -365, max: 365 }),
  note: zName(300),
});

export async function adjustBalanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(adjustSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.days === 0) return { ok: false, message: "An adjustment of zero changes nothing.", errors: { days: "Non-zero" } };
  if (!(await reaches(viewer, d.employeeId, P.LEAVE_MANAGE))) {
    return { ok: false, message: "This employee is outside your scope." };
  }
  if (await foreignReference(viewer.tenantId, { leaveType: d.leaveTypeId })) return { ok: false, message: "Leave type not found." };
  try {
    const after = await adjustBalance({ ...d, actorUserId: viewer.user.id });
    await writeAudit(viewer, {
      module: "LEAVE", action: "UPDATE", entityType: "LeaveBalance", entityId: d.employeeId,
      summary: `Adjusted a leave balance by ${d.days > 0 ? "+" : ""}${d.days} day(s): ${d.note}`,
    });
    return done(["/leave", "/me/leave"], `Adjusted. New balance: ${after} day(s).`);
  } catch (err) {
    return toErrorState(err);
  }
}

const accrualSchema = z.object({
  year: zRequiredNumber({ min: 2000, max: 2100 }),
  month: zRequiredNumber({ min: 1, max: 12 }),
});

export async function runAccrualAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(accrualSchema, formData);
  if (parsed.state) return parsed.state;
  const s = await runAccrual({ tenantId: viewer.tenantId, year: parsed.data.year, month: parsed.data.month });
  // Comp-off credits past their expiry lapse on the same run.
  await lapseExpiredCompOffs(viewer.tenantId);
  await writeAudit(viewer, {
    module: "LEAVE", action: "CREATE", entityType: "LeaveAccrual",
    summary: `Ran accrual for ${parsed.data.month}/${parsed.data.year}: ${s.credits} credits, ${s.totalDays} days`,
  });
  return done(["/leave", "/me/leave"],
    s.credits === 0 && s.skippedAlreadyCredited > 0
      ? `Nothing to do — ${parsed.data.month}/${parsed.data.year} was already credited for all ${s.skippedAlreadyCredited} balances. Re-running is always safe.`
      : `Credited ${s.totalDays} day(s) across ${s.credits} balance(s) for ${s.employees} employee(s).` +
        (s.skippedAlreadyCredited > 0 ? ` ${s.skippedAlreadyCredited} were already credited and skipped.` : ""));
}

// ---------------------------------------------------------------------------
//  LEAVE TYPES, PLANS, HOLIDAYS
// ---------------------------------------------------------------------------

const leaveTypeSchema = z.object({
  id: zOptionalId(),
  name: zName(60),
  code: z.string().min(1).max(10).regex(/^[A-Z][A-Z0-9_]*$/i, "Letters and digits").transform((v) => v.toUpperCase()),
  category: z.enum(["REGULAR", "INCIDENT", "COMP_OFF", "UNPAID", "FLOATER"]),
  isPaid: zBool(),
  accrualFrequency: z.enum(["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "UPFRONT"]),
  annualQuota: zNumber({ min: 0, max: 366 }),
  isUnlimited: zBool(),
  prorateOnJoining: zBool(),
  noAwardIfJoinAfterDay: zNumber({ min: 1, max: 31 }),
  accrueDuringProbation: zBool(),
  maxDaysDuringProbation: zNumber({ min: 0, max: 366 }),
  maxAccumulation: zNumber({ min: 0, max: 999 }),
  allowNegativeBalance: zBool(),
  maxNegativeDays: zNumber({ min: 0, max: 60 }),
  allowHalfDay: zBool(),
  allowQuarterDay: zBool(),
  allowBackdated: zBool(),
  priorNoticeDays: zNumber({ min: 0, max: 365 }),
  requireComment: zBool(),
  attachmentAboveDays: zNumber({ min: 0, max: 365 }),
  isHiddenFromEmployee: zBool(),
  maxConsecutiveDays: zNumber({ min: 0, max: 366 }),
  maxDaysPerMonth: zNumber({ min: 0, max: 31 }),
  minGapBetweenLeavesDays: zNumber({ min: 0, max: 365 }).transform((v) => (v == null ? null : Math.round(v))),
  yearEndAction: z.enum(["RESET", "PAY_ALL", "CARRY_FORWARD_ALL", "PAY_THEN_CARRY_FORWARD", "CARRY_FORWARD_THEN_PAY"]),
  carryForwardMax: zNumber({ min: 0, max: 999 }),
  encashmentEnabled: zBool(),
  encashmentFormula: zOptional(200),
  sandwichWeeklyOff: zBool(),
  sandwichHoliday: zBool(),
  sandwichEdges: zBool(),
  sandwichClub: zBool(),
  sandwichExcludeHalf: zBool(),
  color: zOptional(9),
});

export async function saveLeaveType(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(leaveTypeSchema, formData);
  if (parsed.state) return parsed.state;
  const {
    id, sandwichWeeklyOff, sandwichHoliday, sandwichEdges, sandwichClub, sandwichExcludeHalf, ...d
  } = parsed.data;

  if (d.category === "UNPAID" && d.isPaid) {
    return { ok: false, message: "An unpaid category cannot be marked paid.", errors: { isPaid: "Conflicts with category" } };
  }
  const triggers = { between: true, before: sandwichEdges, after: sandwichEdges, dayBetweenLeaves: sandwichEdges };
  const sandwichConfig = sandwichWeeklyOff || sandwichHoliday ? {
    weeklyOff: sandwichWeeklyOff ? triggers : {},
    holiday: sandwichHoliday ? triggers : {},
    clubAcrossLeaveTypes: sandwichClub,
    excludeHalfDay: sandwichExcludeHalf,
  } : undefined;

  const data: Record<string, unknown> = {
    ...d,
    annualQuota: d.annualQuota ?? 0,
    sandwichConfig: sandwichConfig ?? Prisma.DbNull,
  };

  try {
    if (id) {
      const u = await prisma.leaveType.updateMany({ where: { id, tenantId: viewer.tenantId }, data: data as never });
      if (u.count === 0) return { ok: false, message: "Leave type not found." };
    } else {
      await prisma.leaveType.create({ data: { ...data, tenantId: viewer.tenantId } as never });
    }
    await writeAudit(viewer, {
      module: "LEAVE", action: id ? "UPDATE" : "CREATE", entityType: "LeaveType", entityId: id,
      summary: `${id ? "Updated" : "Created"} leave type ${d.code}`,
    });
    return done(["/leave"], id ? `Saved ${d.name}.` : `Created ${d.name}. Add it to a leave plan so it accrues.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteLeaveType(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const id = String(formData.get("id"));
  const t = await prisma.leaveType.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { requests: true, balances: true } } },
  });
  if (!t) return { ok: false, message: "Leave type not found." };
  if (t._count.requests > 0 || t._count.balances > 0) {
    await prisma.leaveType.update({ where: { id }, data: { isActive: false } });
    return done(["/leave"], `${t.name} has history, so it was deactivated rather than deleted.`);
  }
  await prisma.leaveType.delete({ where: { id } });
  return done(["/leave"], `Deleted ${t.name}.`);
}

const planSchema = z.object({
  id: zOptionalId(), name: zName(80), description: zOptional(300),
  yearBasis: z.enum(["CALENDAR_JAN", "FINANCIAL_APR", "JOINING_DATE"]),
  isDefault: zBool(),
});

export async function saveLeavePlan(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(planSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const typeIds = formList(formData, "leaveTypeIds");
  // Ownership before any write: a plan id from another tenant must not resolve.
  if (id && !(await prisma.leavePlan.count({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Plan not found." };
  if (typeIds.length && (await prisma.leaveType.count({ where: { id: { in: typeIds }, tenantId: viewer.tenantId } })) !== typeIds.length) {
    return { ok: false, message: "Some leave types were not found." };
  }
  try {
    await prisma.$transaction(async (tx) => {
      if (d.isDefault) await tx.leavePlan.updateMany({ where: { tenantId: viewer.tenantId }, data: { isDefault: false } });
      const plan = id
        ? await tx.leavePlan.update({ where: { id }, data: d })
        : await tx.leavePlan.create({ data: { ...d, tenantId: viewer.tenantId } });
      if (typeIds.length > 0 || !id) {
        await tx.leavePlanType.deleteMany({ where: { planId: plan.id, leaveTypeId: { notIn: typeIds } } });
        for (const leaveTypeId of typeIds) {
          await tx.leavePlanType.upsert({
            where: { planId_leaveTypeId: { planId: plan.id, leaveTypeId } },
            create: { planId: plan.id, leaveTypeId }, update: {},
          });
        }
      }
    });
    return done(["/leave"], `Saved ${d.name} with ${typeIds.length} leave type(s).`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function assignLeavePlan(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const planId = String(formData.get("planId"));
  const effectiveRaw = String(formData.get("effectiveFrom") ?? "");
  const employeeIds = formList(formData, "employeeIds");
  if (employeeIds.length === 0) return { ok: false, message: "Select at least one employee." };
  const foreign = await foreignReference(viewer.tenantId, { employee: employeeIds });
  if (foreign) return { ok: false, message: foreign };
  const plan = await prisma.leavePlan.findFirst({ where: { id: planId, tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Plan not found." };
  const effectiveFrom = effectiveRaw ? new Date(`${effectiveRaw}T00:00:00Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  let moved = 0;
  for (const employeeId of employeeIds) {
    // Close the current assignment the day before the new one starts.
    await prisma.leavePlanAssignment.updateMany({
      where: { employeeId, effectiveTo: null, effectiveFrom: { lt: effectiveFrom } },
      data: { effectiveTo: new Date(effectiveFrom.getTime() - 86_400_000) },
    });
    await prisma.leavePlanAssignment.upsert({
      where: { planId_employeeId_effectiveFrom: { planId, employeeId, effectiveFrom } },
      create: { planId, employeeId, effectiveFrom }, update: {},
    });
    moved++;
  }
  await writeAudit(viewer, {
    module: "LEAVE", action: "UPDATE", entityType: "LeavePlanAssignment",
    summary: `Assigned ${moved} employee(s) to ${plan.name} from ${effectiveFrom.toISOString().slice(0, 10)}`,
  });
  return done(["/leave"], `Assigned ${moved} employee(s) to ${plan.name}. Their next accrual follows the new plan.`);
}

const holidaySchema = z.object({
  calendarId: zId(), name: zName(80), date: zRequiredDate(),
  isOptional: zBool(), description: zOptional(200),
});

export async function addHoliday(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const parsed = parseForm(holidaySchema, formData);
  if (parsed.state) return parsed.state;
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: parsed.data.calendarId, tenantId: viewer.tenantId } });
  if (!cal) return { ok: false, message: "Calendar not found." };
  if (parsed.data.date.getUTCFullYear() !== cal.year) {
    return { ok: false, message: `That date is outside the ${cal.year} calendar.`, errors: { date: `Must be in ${cal.year}` } };
  }
  // Leave already approved over this date was counted as a working day.
  const affected = await prisma.leaveRequestDay.count({
    where: { date: parsed.data.date, request: { tenantId: viewer.tenantId, status: { in: ["PENDING", "APPROVED"] } } },
  });
  try {
    const h = await prisma.holiday.create({ data: parsed.data });
    await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "Holiday", entityId: h.id, summary: `Added holiday ${h.name} (${h.date.toISOString().slice(0, 10)}) to ${cal.name}` });
    return done(["/leave", "/me/leave", "/time/holidays"],
      `Added ${parsed.data.name}.` + (affected > 0
        ? ` ${affected} existing leave day(s) fall on it and were counted as working days — review them.`
        : ""));
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteHoliday(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const id = String(formData.get("id"));
  const h = await prisma.holiday.findUnique({ where: { id }, include: { calendar: { select: { tenantId: true, name: true } } } });
  if (!h || h.calendar.tenantId !== viewer.tenantId) return { ok: false, message: "Holiday not found." };
  await prisma.holiday.delete({ where: { id } });
  await writeAudit(viewer, { module: "LEAVE", action: "DELETE", entityType: "Holiday", entityId: id, summary: `Removed holiday ${h.name} (${h.date.toISOString().slice(0, 10)}) from ${h.calendar.name}` });
  return done(["/leave", "/me/leave", "/time/holidays"], `Removed ${h.name}.`);
}

export async function addHolidayCalendar(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const name = String(formData.get("name") ?? "").trim();
  const year = Number(formData.get("year"));
  const copyFromId = String(formData.get("copyFromId") ?? "") || null;
  if (!name || !year) return { ok: false, message: "Name and year are required." };
  try {
    const cal = await prisma.holidayCalendar.create({ data: { tenantId: viewer.tenantId, name, year } });
    let copied = 0;
    if (copyFromId) {
      const src = await prisma.holiday.findMany({ where: { calendarId: copyFromId, calendar: { tenantId: viewer.tenantId } } });
      // Fixed-date holidays roll forward; lunar ones need checking by hand.
      for (const h of src) {
        const moved = new Date(Date.UTC(year, h.date.getUTCMonth(), h.date.getUTCDate()));
        await prisma.holiday.create({ data: { calendarId: cal.id, name: h.name, date: moved, isOptional: h.isOptional } });
        copied++;
      }
    }
    await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "HolidayCalendar", entityId: cal.id, summary: `Created holiday calendar ${name} ${year}${copied ? ` with ${copied} holiday(s) copied` : ""}` });
    return done(["/leave", "/time/holidays"], copied > 0
      ? `Created ${name} with ${copied} holiday(s) copied to the same dates. Festivals that follow the lunar calendar will need their dates corrected.`
      : `Created ${name}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  ATTENDANCE — punch, requests, processing
// ---------------------------------------------------------------------------

export async function clockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const direction = String(formData.get("direction")) === "out" ? 1 : 0;
  const comment = String(formData.get("comment") ?? "").trim().slice(0, 1024) || null;
  const mode = String(formData.get("mode") ?? "");
  const source = mode === "remote" ? "REMOTE" : mode === "mobile" ? "MOBILE" : "WEB";
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null;
  // A location is only kept when it is a real coordinate.
  const lat = Number(formData.get("latitude")), lng = Number(formData.get("longitude"));
  const located = !!formData.get("latitude") && !!formData.get("longitude") && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const accuracy = Number(formData.get("accuracy"));

  // A selfie, when one was taken: an image, checked by its bytes, kept with
  // the employee's files so attendance reviewers can open it.
  let selfie: { id: string } | null = null;
  const file = formData.get("selfie");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) return { ok: false, message: "The selfie is larger than 5 MB. Retake it at a lower resolution." };
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok || sniff.mimeType === "application/pdf") return { ok: false, message: "The selfie must be a JPEG or PNG photo." };
    selfie = await saveFile({
      tenantId: viewer.tenantId, filename: `selfie-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${sniff.mimeType === "image/png" ? "png" : "jpg"}`,
      mimeType: sniff.mimeType, data, relatedType: "AttendanceSelfie", employeeId: viewer.employee.id, uploadedBy: viewer.user.id,
    });
  }

  const res = await recordPunch({
    employeeId: viewer.employee.id, direction: direction as 0 | 1, source,
    ipAddress: ip, comment,
    latitude: located ? lat : null, longitude: located ? lng : null,
    accuracyM: Number.isFinite(accuracy) ? accuracy : null,
    selfieUrl: selfie ? `/files/${selfie.id}` : null,
  });
  if (!res.ok) {
    if (selfie) await prisma.storedFile.delete({ where: { id: selfie.id } }).catch(() => undefined);
    return { ok: false, message: res.message };
  }
  if (res.pendingApproval && res.requestId) {
    await writeAudit(viewer, {
      module: "ATTENDANCE", action: "CREATE", entityType: "AttendanceRequest", entityId: res.requestId,
      summary: `Remote clock-${direction === 0 ? "in" : "out"}${comment ? `: ${comment}` : ""}`,
    });
    // The approver hears once per day, on the first remote punch.
    const punches = await prisma.attendanceLog.count({ where: { attendanceRequestId: res.requestId } });
    if (punches === 1) {
      const req = await prisma.attendanceRequest.findUniqueOrThrow({ where: { id: res.requestId }, select: { fromDate: true } });
      await notifyTimeRequest({
        tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "ATTENDANCE", event: "RAISED",
        what: `a remote clock-in on ${formatDate(req.fromDate)}`, note: comment,
      });
    }
  }
  return done(["/me/attendance", "/attendance", "/", "/inbox"], res.message);
}

const requestSchema = z.object({
  type: z.enum(["ADJUSTMENT", "REGULARISATION", "PARTIAL_DAY", "WORK_FROM_HOME", "ON_DUTY"]),
  fromDate: zRequiredDate(),
  toDate: zDate(),
  inTime: z.string().optional(),
  outTime: z.string().optional(),
  partialMinutes: zNumber({ min: 1, max: 480 }),
  portion: z.enum(["FULL_DAY", "FIRST_HALF", "SECOND_HALF"]).optional(),
  hourly: zBool(),
  reason: zName(500),
});

/** "HH:MM" on a date, in IST, to a UTC instant. */
function istInstant(date: Date, hhmm?: string): Date | null {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m) - 330 * 60_000);
}

export async function raiseAttendanceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(requestSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const to = d.toDate ?? d.fromDate;

  // "+Add Log": alternate IN/OUT time rows, `logTime` with `logDir`.
  const times = formData.getAll("logTime").map(String);
  const dirs = formData.getAll("logDir").map(String);
  const proposedLogs = d.type === "ADJUSTMENT" && times.some((t) => t)
    ? times.flatMap((t, i) => {
        const at = istInstant(d.fromDate, t);
        return at ? [{ at, direction: (dirs[i] === "out" ? 1 : 0) as 0 | 1 }] : [];
      })
    : null;
  if (proposedLogs && proposedLogs.length !== times.filter((t) => t).length) {
    return { ok: false, message: "Enter every time entry as HH:MM." };
  }
  const remoteWork = d.type === "WORK_FROM_HOME" || d.type === "ON_DUTY";
  const hourly = remoteWork && d.hourly;
  const copied = await copiedIds(viewer, formData, viewer.employee.id);

  // A supporting document (the policy may require one for WFH / on duty).
  let attachment: { id: string } | null = null;
  const file = formData.get("attachment");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) return { ok: false, message: "The document is larger than 5 MB." };
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok) return { ok: false, message: "Attach a PDF, JPEG or PNG." };
    attachment = await saveFile({
      tenantId: viewer.tenantId, filename: file.name || "attachment", mimeType: sniff.mimeType, data,
      relatedType: "AttendanceRequest", employeeId: viewer.employee.id, uploadedBy: viewer.user.id,
    });
  }

  const res = await raiseAttendanceRequest({
    employeeId: viewer.employee.id, type: d.type,
    from: d.fromDate, to,
    proposedIn: d.type === "ADJUSTMENT" || hourly ? istInstant(d.fromDate, d.inTime) : null,
    proposedOut: d.type === "ADJUSTMENT" || hourly ? istInstant(d.fromDate, d.outTime) : null,
    proposedLogs,
    partialMinutes: d.type === "PARTIAL_DAY" ? d.partialMinutes : null,
    portion: remoteWork && !hourly ? d.portion ?? "FULL_DAY" : null,
    isHourly: hourly,
    notifyEmployeeIds: copied,
    attachmentFileId: attachment?.id ?? null,
    reason: d.reason,
  });
  if (!res.ok) {
    if (attachment) await prisma.storedFile.delete({ where: { id: attachment.id } }).catch(() => undefined);
    return { ok: false, message: res.message };
  }
  const label = { ADJUSTMENT: "an attendance adjustment", REGULARISATION: "regularization", PARTIAL_DAY: "a partial day", WORK_FROM_HOME: "work from home", ON_DUTY: "on duty" }[d.type];
  await writeAudit(viewer, {
    module: "ATTENDANCE", action: "CREATE", entityType: "AttendanceRequest", entityId: res.requestId,
    summary: `Requested ${label} ${between(d.fromDate, to)}`,
  });
  await notifyTimeRequest({
    tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "ATTENDANCE", event: "RAISED",
    what: `${label} ${between(d.fromDate, to)}`, notifyEmployeeIds: copied, note: d.reason,
  });
  return done(["/me/attendance", "/attendance", "/inbox", "/team/attendance", "/time/approvals"], `${res.message} It is now awaiting approval.`);
}

export async function decideAttendanceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_APPROVE);
  const requestId = String(formData.get("requestId"));
  const decision = String(formData.get("decision")) === "approve" ? "APPROVE" : "REJECT";
  const note = String(formData.get("note") ?? "") || null;

  const req = await prisma.attendanceRequest.findFirst({ where: { id: requestId, tenantId: viewer.tenantId } });
  if (!req) return { ok: false, message: "Request not found." };
  if (req.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot approve your own request." };
  if (!(await reaches(viewer, req.employeeId, P.ATTENDANCE_APPROVE))) {
    return { ok: false, message: "This request is outside the employees your roles reach." };
  }
  const res = await decideAttendanceRequest({ requestId, decision, deciderEmployeeId: viewer.employee?.id, note });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, {
    module: "ATTENDANCE", action: decision === "APPROVE" ? "APPROVE" : "REJECT",
    entityType: "AttendanceRequest", entityId: requestId,
    summary: `${decision === "APPROVE" ? "Approved" : "Rejected"} a ${req.type.replace(/_/g, " ").toLowerCase()} request`,
  });
  await notifyTimeRequest({
    tenantId: viewer.tenantId, employeeId: req.employeeId, kind: "ATTENDANCE",
    event: decision === "APPROVE" ? "APPROVED" : "REJECTED",
    what: `${req.type.replace(/_/g, " ").toLowerCase()} ${between(req.fromDate, req.toDate)}`, note,
  });
  return done(["/attendance", "/inbox", "/me/attendance"], res.message);
}

export async function cancelAttendanceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const requestId = String(formData.get("requestId"));
  const u = await prisma.attendanceRequest.updateMany({
    where: { id: requestId, employeeId: viewer.employee?.id ?? "__none__", status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (u.count === 0) return { ok: false, message: "Only your own pending requests can be withdrawn." };
  // Withdrawn remote punches never count.
  await prisma.attendanceLog.updateMany({ where: { attendanceRequestId: requestId, status: "PENDING" }, data: { status: "REJECTED" } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceRequest", entityId: requestId, summary: "Withdrew a pending attendance request" });
  return done(["/me/attendance", "/inbox"], "Withdrawn.");
}

const processSchema = z.object({ fromDate: zRequiredDate(), toDate: zRequiredDate() });

export async function processAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(processSchema, formData);
  if (parsed.state) return parsed.state;
  if (parsed.data.toDate < parsed.data.fromDate) return { ok: false, message: "The end is before the start." };
  if ((parsed.data.toDate.getTime() - parsed.data.fromDate.getTime()) / 86_400_000 > 62) {
    return { ok: false, message: "Process at most two months at a time." };
  }
  const s = await processAttendance({ tenantId: viewer.tenantId, from: parsed.data.fromDate, to: parsed.data.toDate });
  await writeAudit(viewer, {
    module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceRecord",
    summary: `Processed attendance ${parsed.data.fromDate.toISOString().slice(0, 10)} to ${parsed.data.toDate.toISOString().slice(0, 10)}: ${s.days} days, ${s.lopDays} LOP`,
  });
  return done(["/attendance", "/payroll/runs"],
    `Processed ${s.days} day(s) for ${s.employees} employee(s): ${s.lopDays} LOP day(s), ${s.lateDays} late arrival(s), ${s.penalisedDays} penalised. Recalculate any open payroll run to pick this up.`);
}

// ---------------------------------------------------------------------------
//  SHIFTS, POLICIES, ASSIGNMENTS
// ---------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const shiftSchema = z.object({
  id: zOptionalId(), name: zName(60),
  code: z.string().min(1).max(12).transform((v) => v.toUpperCase()),
  startTime: hhmm, endTime: hhmm,
  breakMinutes: zRequiredNumber({ min: 0, max: 240 }),
  isFlexible: zBool(),
  requiredHours: zNumber({ min: 1, max: 16 }),
  crossesMidnight: zBool(),
  color: zOptional(9),
  /** Auto clock-out: a slot left open this long is closed by the nightly job. */
  maxSlotMinutes: zNumber({ min: 60, max: 1440 }),
});

const SHIFT_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
/** Per-weekday timings from day_<DAY>_start / _end / _break, only where both times are given. */
function dayScheduleFrom(formData: FormData): { schedule: Record<string, { startTime: string; endTime: string; breakMinutes?: number }> | null; error?: string } {
  const out: Record<string, { startTime: string; endTime: string; breakMinutes?: number }> = {};
  for (const d of SHIFT_DAYS) {
    const s = String(formData.get(`day_${d}_start`) ?? "").trim();
    const e = String(formData.get(`day_${d}_end`) ?? "").trim();
    const b = String(formData.get(`day_${d}_break`) ?? "").trim();
    if (!s && !e) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e)) return { schedule: null, error: `${d}: give both times as HH:MM.` };
    const br = b ? Number(b) : undefined;
    if (br !== undefined && (!Number.isFinite(br) || br < 0 || br > 240)) return { schedule: null, error: `${d}: the break is 0 to 240 minutes.` };
    out[d] = { startTime: s, endTime: e, ...(br !== undefined ? { breakMinutes: Math.round(br) } : {}) };
  }
  return { schedule: Object.keys(out).length ? out : null };
}

export async function saveShift(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const parsed = parseForm(shiftSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const span = toMin(d.endTime) - toMin(d.startTime);
  if (span <= 0 && !d.crossesMidnight) {
    return { ok: false, message: "The shift ends before it starts. Tick 'crosses midnight' for a night shift.", errors: { endTime: "Before start" } };
  }
  if (d.isFlexible && !d.requiredHours) {
    return { ok: false, message: "A flexible shift needs its required hours.", errors: { requiredHours: "Required" } };
  }
  const spanMin = span <= 0 ? span + 1440 : span;
  if (d.breakMinutes >= spanMin) {
    return { ok: false, message: "The break is as long as the shift.", errors: { breakMinutes: "Too long" } };
  }
  const days = dayScheduleFrom(formData);
  if (days.error) return { ok: false, message: days.error };
  if (d.maxSlotMinutes && d.maxSlotMinutes < spanMin) {
    return { ok: false, message: "Auto clock-out must come after the shift's length.", errors: { maxSlotMinutes: "Shorter than the shift" } };
  }
  const data = { ...d, maxSlotMinutes: d.maxSlotMinutes == null ? null : Math.round(d.maxSlotMinutes), daySchedule: days.schedule ?? Prisma.DbNull };
  try {
    let shiftId = id;
    if (id) {
      const u = await prisma.shift.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Shift not found." };
    } else {
      shiftId = (await prisma.shift.create({ data: { ...data, tenantId: viewer.tenantId } })).id;
    }
    await writeAudit(viewer, { module: "ATTENDANCE", action: id ? "UPDATE" : "CREATE", entityType: "Shift", entityId: shiftId, summary: `${id ? "Updated" : "Created"} shift ${d.name} (${d.startTime}–${d.endTime})` });
    return done(["/attendance", "/time/shifts"], `Saved ${d.name}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

const policySchema = z.object({
  id: zOptionalId(), name: zName(80), description: zOptional(300),
  allowWebClockIn: zBool(), requireClockInComment: zBool(),
  requireGeofence: zBool(), requireSelfie: zBool(),
  ipAllowList: zOptional(1000),
  fullDayThresholdPct: zRequiredNumber({ min: 1, max: 100 }),
  halfDayThresholdPct: zRequiredNumber({ min: 1, max: 100 }),
  graceMinutes: zRequiredNumber({ min: 0, max: 240 }),
  lateExemptPerMonth: zRequiredNumber({ min: 0, max: 31 }),
  latePenaltyDays: zRequiredNumber({ min: 0, max: 1 }),
  missingPunchExemptPerMonth: zRequiredNumber({ min: 0, max: 31 }),
  missingPunchPenaltyDays: zRequiredNumber({ min: 0, max: 1 }),
  noAttendanceIsLop: zBool(),
  overtimeEnabled: zBool(),
  overtimeMinMinutes: zRequiredNumber({ min: 0, max: 480 }),
  regularisationWindowDays: zRequiredNumber({ min: 0, max: 365 }),
  isDefault: zBool(),
}).refine((v) => v.halfDayThresholdPct < v.fullDayThresholdPct, {
  message: "The half-day threshold must be below the full-day threshold", path: ["halfDayThresholdPct"],
});

export async function saveAttendancePolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(policySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ipAllowList, ...d } = parsed.data;
  const ips = (ipAllowList ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const bad = ips.filter((ip) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip));
  if (bad.length > 0) {
    return { ok: false, message: `Not IP addresses: ${bad.join(", ")}`, errors: { ipAllowList: "Invalid entries" } };
  }
  try {
    await prisma.$transaction(async (tx) => {
      if (d.isDefault) await tx.attendancePolicy.updateMany({ where: { tenantId: viewer.tenantId }, data: { isDefault: false } });
      const data = { ...d, ipAllowList: ips };
      if (id) await tx.attendancePolicy.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      else await tx.attendancePolicy.create({ data: { ...data, tenantId: viewer.tenantId } });
    });
    await writeAudit(viewer, {
      module: "ATTENDANCE", action: id ? "UPDATE" : "CREATE", entityType: "AttendancePolicy", entityId: id,
      summary: `${id ? "Updated" : "Created"} attendance policy ${d.name}`,
    });
    return done(["/attendance"], `Saved ${d.name}. Reprocess attendance for the period to apply the new rules to past days.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function assignTimePolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const employeeIds = formList(formData, "employeeIds");
  const attendancePolicyId = String(formData.get("attendancePolicyId") ?? "") || null;
  const shiftId = String(formData.get("shiftId") ?? "") || null;
  const weeklyOffPolicyId = String(formData.get("weeklyOffPolicyId") ?? "") || null;
  // Holiday calendar: blank keeps each employee's current assignment; NONE clears it (location/default resolution).
  const calRaw = String(formData.get("holidayCalendarId") ?? "");
  if (calRaw && calRaw !== "NONE" && !(await prisma.holidayCalendar.count({ where: { id: calRaw, tenantId: viewer.tenantId } }))) return { ok: false, message: "Holiday calendar not found." };
  const trackAttendance = formData.get("trackAttendance") === "on";
  const effRaw = String(formData.get("effectiveFrom") ?? "");
  if (employeeIds.length === 0) return { ok: false, message: "Select at least one employee." };
  const effectiveFrom = effRaw ? new Date(`${effRaw}T00:00:00Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));

  const valid = await prisma.employee.count({ where: { id: { in: employeeIds }, tenantId: viewer.tenantId } });
  if (valid !== employeeIds.length) return { ok: false, message: "Some selected employees were not found." };
  const foreign = await foreignReference(viewer.tenantId, { attendancePolicy: attendancePolicyId, shift: shiftId, weeklyOffPolicy: weeklyOffPolicyId });
  if (foreign) return { ok: false, message: foreign };

  for (const employeeId of employeeIds) {
    const current = await prisma.employeeTimePolicy.findFirst({ where: { employeeId, effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, select: { holidayCalendarId: true } });
    const holidayCalendarId = calRaw === "NONE" ? null : calRaw || current?.holidayCalendarId || null;
    await prisma.employeeTimePolicy.updateMany({
      where: { employeeId, effectiveTo: null, effectiveFrom: { lt: effectiveFrom } },
      data: { effectiveTo: new Date(effectiveFrom.getTime() - 86_400_000) },
    });
    await prisma.employeeTimePolicy.create({
      data: { employeeId, attendancePolicyId, shiftId, weeklyOffPolicyId, holidayCalendarId, trackAttendance, effectiveFrom },
    });
  }
  await writeAudit(viewer, {
    module: "ATTENDANCE", action: "UPDATE", entityType: "EmployeeTimePolicy",
    summary: `Assigned a time policy to ${employeeIds.length} employee(s) from ${effectiveFrom.toISOString().slice(0, 10)}${calRaw ? `; holiday calendar ${calRaw === "NONE" ? "cleared" : calRaw}` : ""}`,
  });
  return done(["/attendance"], `Assigned to ${employeeIds.length} employee(s) from ${effectiveFrom.toISOString().slice(0, 10)}.`);
}

/** Close every ended leave year now: carry forward, pay out or lapse, per each type's year-end rule. */
export async function runLeaveYearEndAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const r = await runLeaveYearEnd({ tenantId: viewer.tenantId, apply: true, byUserId: viewer.user.id });
  const carried = r.rows.reduce((s, x) => s + Math.max(0, x.carry), 0);
  const paid = r.rows.reduce((s, x) => s + x.pay, 0);
  const lapsed = r.rows.reduce((s, x) => s + x.lapse, 0) + r.expiredDays;
  if (r.closed === 0 && r.expired === 0) return { ok: true, message: "Nothing to close — every ended leave year is already settled." };
  await writeAudit(viewer, {
    module: "LEAVE", action: "UPDATE", entityType: "LeaveYearEnd",
    summary: `Closed ${r.closed} leave balance(s): ${carried} day(s) carried forward, ${paid} paid out, ${Math.round(lapsed * 100) / 100} lapsed`,
  });
  return done(["/leave", "/me/leave"], `Closed ${r.closed} balance(s): ${carried} day(s) carried forward, ${paid} paid out (${r.paid} payment(s) added to payroll), ${Math.round(lapsed * 100) / 100} lapsed.`);
}
