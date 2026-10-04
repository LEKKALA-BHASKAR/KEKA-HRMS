"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  raiseEncashmentRequest, notifyTimeRequest, createKiosk, setKioskPin, hashPin, pinIssue,
  bulkMarkAttendance, importRosterCsv, saveWorkLog, decideWorkLog, EDITABLE_STATUSES,
} from "@keka/services";
import { weeklyOffConfigFrom, WEEKDAYS, type WeekdayRule, type Weekday, type OffPortion } from "@keka/time";
import { requireAuth, requireViewer, canAny, can } from "@/lib/context";
import { reachesEmployee } from "@/lib/time-decide";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zBool, zId, zOptionalId, zRequiredDate, type ActionState,
} from "@/lib/forms";

/**
 * Time and leave depth: leave-type rules for hourly leave, encashment and
 * advance leave; comp-off settings; attendance policy rules (hours basis,
 * AWOL, new-joiner grace, regularisation and remote-work limits, overtime to
 * comp-off); weekly-off patterns; encashment on behalf; bulk marking; the
 * roster import; kiosks and PINs; and the weekly work log.
 */

const P = PERMISSIONS;
const SETTINGS = "/time/settings";
const intOrNull = (v: number | null) => (v == null ? null : Math.round(v));

// ---------------------------------------------------------------------------
//  Leave type rules: hourly leave, encashment policy, advance leave
// ---------------------------------------------------------------------------

const leaveRulesSchema = z.object({
  id: zId(),
  unit: z.enum(["DAYS", "HOURS"]),
  hoursPerDay: zNumber({ min: 1, max: 24 }),
  minHoursPerRequest: zNumber({ min: 0.25, max: 24 }),
  maxHoursPerDay: zNumber({ min: 0.25, max: 24 }),
  hourIncrementMinutes: zNumber({ min: 5, max: 240 }),
  allowEncashmentRequest: zBool(),
  encashmentEnabled: zBool(),
  encashmentMaxDaysPerYear: zNumber({ min: 0, max: 366 }),
  encashmentMinBalance: zNumber({ min: 0, max: 366 }),
  encashmentFormula: zOptional(200),
  allowAdvanceLeave: zBool(),
  advanceLeaveMaxDays: zNumber({ min: 0, max: 366 }),
});

export async function saveLeaveTypeRules(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(leaveRulesSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const type = await prisma.leaveType.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { requests: true } } },
  });
  if (!type) return { ok: false, message: "Leave type not found." };
  if (d.unit !== type.unit) {
    const ledger = await prisma.leaveLedgerEntry.count({ where: { leaveTypeId: id } });
    if (type._count.requests > 0 || ledger > 0) {
      return { ok: false, message: `${type.name} already has requests or balances in ${type.unit.toLowerCase()}; create a new type to count in ${d.unit.toLowerCase()}.`, errors: { unit: "Has history" } };
    }
  }
  if (d.unit === "HOURS" && d.minHoursPerRequest && d.maxHoursPerDay && d.minHoursPerRequest > d.maxHoursPerDay) {
    return { ok: false, message: "The minimum hours are above the maximum.", errors: { minHoursPerRequest: "Above the maximum" } };
  }
  if (d.allowAdvanceLeave && !d.advanceLeaveMaxDays) {
    return { ok: false, message: "Say how much may be taken in advance.", errors: { advanceLeaveMaxDays: "Required" } };
  }
  if (d.encashmentFormula && !/^\s*\[(\w+)\]\s*\/\s*(\d+(?:\.\d+)?)\s*$/.test(d.encashmentFormula)) {
    return { ok: false, message: "Write the rate as [COMPONENT] / divisor, e.g. [BASIC] / 30.", errors: { encashmentFormula: "Use [BASIC] / 30" } };
  }
  const months = [...new Set(formList(formData, "encashmentMonths").map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
  try {
    await prisma.leaveType.update({
      where: { id },
      data: {
        unit: d.unit,
        hoursPerDay: d.unit === "HOURS" ? d.hoursPerDay ?? 8 : null,
        minHoursPerRequest: d.unit === "HOURS" ? d.minHoursPerRequest : null,
        maxHoursPerDay: d.unit === "HOURS" ? d.maxHoursPerDay : null,
        hourIncrementMinutes: d.unit === "HOURS" ? intOrNull(d.hourIncrementMinutes) : null,
        allowEncashmentRequest: d.allowEncashmentRequest,
        encashmentEnabled: d.encashmentEnabled || d.allowEncashmentRequest,
        encashmentMaxDaysPerYear: d.encashmentMaxDaysPerYear,
        encashmentMinBalance: d.encashmentMinBalance,
        encashmentMonths: months,
        ...(d.encashmentFormula ? { encashmentFormula: d.encashmentFormula } : {}),
        allowAdvanceLeave: d.allowAdvanceLeave,
        advanceLeaveMaxDays: d.allowAdvanceLeave ? d.advanceLeaveMaxDays : null,
      },
    });
    await writeAudit(viewer, {
      module: "LEAVE", action: "UPDATE", entityType: "LeaveType", entityId: id,
      summary: `Updated hourly, encashment and advance rules for ${type.name}`,
      newValue: { ...d, encashmentMonths: months },
    });
    return done([SETTINGS, "/leave", "/me/leave"], `Saved the rules for ${type.name}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  Comp-off settings
// ---------------------------------------------------------------------------

const compOffSchema = z.object({
  id: zId(),
  compOffRequestWindowDays: zNumber({ min: 1, max: 365 }),
  expiryDaysAfterCredit: zNumber({ min: 1, max: 730 }),
  compOffHalfDayMinHours: zNumber({ min: 0.5, max: 24 }),
  compOffFullDayMinHours: zNumber({ min: 0.5, max: 24 }),
});

export async function saveCompOffSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(compOffSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.compOffHalfDayMinHours && d.compOffFullDayMinHours && d.compOffHalfDayMinHours >= d.compOffFullDayMinHours) {
    return { ok: false, message: "The half-day hours must be below the full-day hours.", errors: { compOffHalfDayMinHours: "Below full day" } };
  }
  const u = await prisma.leaveType.updateMany({
    where: { id, tenantId: viewer.tenantId, category: "COMP_OFF" },
    data: {
      compOffRequestWindowDays: intOrNull(d.compOffRequestWindowDays),
      expiryDaysAfterCredit: intOrNull(d.expiryDaysAfterCredit),
      compOffHalfDayMinHours: d.compOffHalfDayMinHours, compOffFullDayMinHours: d.compOffFullDayMinHours,
    },
  });
  if (u.count === 0) return { ok: false, message: "Comp-off leave type not found." };
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "LeaveType", entityId: id, summary: "Updated comp-off settings", newValue: d });
  return done([SETTINGS, "/me/leave"], "Saved the comp-off settings.");
}

// ---------------------------------------------------------------------------
//  Attendance policy rules
// ---------------------------------------------------------------------------

const rulesSchema = z.object({
  id: zId(),
  hoursBasis: z.enum(["EFFECTIVE", "GROSS"]),
  awolEnabled: zBool(),
  awolAfterDays: zRequiredNumber({ min: 1, max: 30 }),
  newJoinerGraceDays: zRequiredNumber({ min: 0, max: 90 }),
  regularisationMonthlyLimit: zNumber({ min: 0, max: 31 }),
  regularisationCutoffDay: zNumber({ min: 1, max: 28 }),
  wfhMonthlyLimit: zNumber({ min: 0, max: 31 }),
  odMonthlyLimit: zNumber({ min: 0, max: 31 }),
  remoteNoticeDays: zNumber({ min: 0, max: 90 }),
  remoteAllowedOnHolidays: zBool(),
  remoteAllowedOnWeeklyOffs: zBool(),
  remoteAttachmentRequired: zBool(),
  allowHalfDayRemoteWork: zBool(),
  allowHourlyRemoteWork: zBool(),
  overtimeToCompOff: zBool(),
  overtimeCompOffHoursPerDay: zRequiredNumber({ min: 1, max: 24 }),
});

export async function saveAttendanceRules(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(rulesSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const policy = await prisma.attendancePolicy.findFirst({ where: { id, tenantId: viewer.tenantId }, select: { name: true } });
  if (!policy) return { ok: false, message: "Attendance policy not found." };
  await prisma.attendancePolicy.update({
    where: { id },
    data: {
      ...d,
      awolAfterDays: Math.round(d.awolAfterDays), newJoinerGraceDays: Math.round(d.newJoinerGraceDays),
      regularisationMonthlyLimit: intOrNull(d.regularisationMonthlyLimit), regularisationCutoffDay: intOrNull(d.regularisationCutoffDay),
      wfhMonthlyLimit: intOrNull(d.wfhMonthlyLimit), odMonthlyLimit: intOrNull(d.odMonthlyLimit), remoteNoticeDays: intOrNull(d.remoteNoticeDays),
    },
  });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendancePolicy", entityId: id, summary: `Updated the rules of ${policy.name}`, newValue: d });
  return done([SETTINGS, "/attendance", "/me/attendance"], `Saved ${policy.name}. Reprocess attendance to apply the new rules to past days.`);
}

// ---------------------------------------------------------------------------
//  Weekly-off patterns
// ---------------------------------------------------------------------------

const RULES: WeekdayRule[] = ["WORKING", "ALL", "ALT_2_4", "ALT_1_3_5", "CUSTOM"];
const PORTIONS: OffPortion[] = ["FULL_DAY", "FIRST_HALF", "SECOND_HALF"];

export async function saveWeeklyOffPolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE])) return { ok: false, message: "You cannot manage weekly-off patterns." };
  const parsed = parseForm(z.object({ id: zOptionalId(), name: zName(80), isDefault: zBool() }), formData);
  if (parsed.state) return parsed.state;
  const { id, name, isDefault } = parsed.data;
  const rows: Partial<Record<Weekday, { rule: WeekdayRule; instances?: number[]; portion?: OffPortion }>> = {};
  for (const d of WEEKDAYS) {
    const rule = String(formData.get(`rule_${d}`) ?? "WORKING") as WeekdayRule;
    const portion = String(formData.get(`portion_${d}`) ?? "FULL_DAY") as OffPortion;
    if (!RULES.includes(rule) || !PORTIONS.includes(portion)) return { ok: false, message: `Check ${d}.` };
    rows[d] = { rule, portion, instances: formList(formData, `inst_${d}`).map(Number) };
    if (rule === "CUSTOM" && rows[d]!.instances!.length === 0) {
      return { ok: false, message: `Tick which ${d.charAt(0)}${d.slice(1).toLowerCase()}s of the month are off.`, errors: { [`rule_${d}`]: "Pick weeks" } };
    }
  }
  const config = weeklyOffConfigFrom(rows);
  if (Object.keys(config).length === 0) return { ok: false, message: "Mark at least one day off." };
  try {
    await prisma.$transaction(async (tx) => {
      if (isDefault) await tx.weeklyOffPolicy.updateMany({ where: { tenantId: viewer.tenantId }, data: { isDefault: false } });
      if (id) {
        const u = await tx.weeklyOffPolicy.updateMany({ where: { id, tenantId: viewer.tenantId }, data: { name, config: config as never, isDefault } });
        if (u.count === 0) throw new Error("Weekly-off pattern not found.");
      } else {
        await tx.weeklyOffPolicy.create({ data: { tenantId: viewer.tenantId, name, config: config as never, isDefault } });
      }
    });
    await writeAudit(viewer, {
      module: "ATTENDANCE", action: id ? "UPDATE" : "CREATE", entityType: "WeeklyOffPolicy", entityId: id,
      summary: `${id ? "Updated" : "Created"} weekly-off pattern ${name}`, newValue: config,
    });
    return done([SETTINGS, "/attendance"], `Saved ${name}. Reprocess attendance to apply it to past days.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function retireWeeklyOffPolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE])) return { ok: false, message: "You cannot manage weekly-off patterns." };
  const id = String(formData.get("id") ?? "");
  const w = await prisma.weeklyOffPolicy.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Weekly-off pattern not found." };
  if (w.isDefault) return { ok: false, message: "Make another pattern the default first." };
  const inUse = await prisma.employeeTimePolicy.count({ where: { weeklyOffPolicyId: id, effectiveTo: null } });
  if (inUse > 0) return { ok: false, message: `${inUse} employee(s) are on ${w.name}. Assign them another pattern first.` };
  await prisma.weeklyOffPolicy.update({ where: { id }, data: { isActive: false } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "DELETE", entityType: "WeeklyOffPolicy", entityId: id, summary: `Retired weekly-off pattern ${w.name}` });
  return done([SETTINGS, "/attendance"], `Retired ${w.name}.`);
}

// ---------------------------------------------------------------------------
//  Encashment on behalf
// ---------------------------------------------------------------------------

const encashSchema = z.object({
  employeeId: zId(), leaveTypeId: zId(),
  days: zNumber({ min: 0.5, max: 366 }), all: zBool(), note: zOptional(500),
});

export async function encashOnBehalfAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(encashSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.employeeId === viewer.employee?.id) return { ok: false, message: "Use Me → Leave to encash your own leave." };
  const allowed = (can(viewer, P.LEAVE_MANAGE) && await reachesEmployee(viewer, d.employeeId, P.LEAVE_MANAGE))
    || (can(viewer, P.LEAVE_APPROVE) && await reachesEmployee(viewer, d.employeeId, P.LEAVE_APPROVE));
  if (!allowed) return { ok: false, message: "You cannot raise encashment for this employee." };
  if (!d.all && !d.days) return { ok: false, message: "Enter how many days to encash.", errors: { days: "Required" } };
  const type = await prisma.leaveType.findFirst({ where: { id: d.leaveTypeId, tenantId: viewer.tenantId }, select: { name: true } });
  if (!type) return { ok: false, message: "Leave type not found." };
  const res = await raiseEncashmentRequest({
    employeeId: d.employeeId, leaveTypeId: d.leaveTypeId, days: d.days, all: d.all,
    note: d.note, requestedByEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, {
    module: "LEAVE", action: "CREATE", entityType: "LeaveEncashmentRequest", entityId: res.requestId,
    summary: `Raised ${type.name} encashment on behalf of an employee: ${d.all ? "all encashable days" : `${d.days} day(s)`}`,
  });
  await notifyTimeRequest({
    tenantId: viewer.tenantId, employeeId: d.employeeId, kind: "LEAVE", event: "RAISED",
    what: `encashment of ${type.name} (raised on their behalf)`, note: d.note,
  });
  return done([SETTINGS, "/time/approvals", "/inbox", "/me/leave"], `${res.message} It now waits for approval like any encashment request.`);
}

// ---------------------------------------------------------------------------
//  Bulk regularisation and roster import
// ---------------------------------------------------------------------------

const bulkSchema = z.object({
  fromDate: zRequiredDate(), toDate: zRequiredDate(),
  status: z.enum([...EDITABLE_STATUSES, "AUTO"] as [string, ...string[]]),
  reason: zName(300), workingDaysOnly: zBool(),
});

export async function bulkMarkAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(bulkSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const employeeIds = formList(formData, "employeeIds");
  for (const id of employeeIds) {
    if (!(await reachesEmployee(viewer, id, P.ATTENDANCE_MANAGE))) return { ok: false, message: "One of those employees is outside the people you manage attendance for." };
  }
  const res = await bulkMarkAttendance({
    tenantId: viewer.tenantId, employeeIds, from: d.fromDate, to: d.toDate,
    status: d.status as never, reason: d.reason, actorUserId: viewer.user.id, workingDaysOnly: d.workingDaysOnly,
  });
  if (res.changed > 0) {
    await writeAudit(viewer, {
      module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceRecord",
      summary: `Bulk marked ${res.changed} day(s) for ${employeeIds.length} employee(s) as ${d.status} (${d.fromDate.toISOString().slice(0, 10)} to ${d.toDate.toISOString().slice(0, 10)}): ${d.reason}`,
    });
  }
  return res.ok ? done([SETTINGS, "/attendance", "/me/attendance"], res.message) : { ok: false, message: res.message };
}

export async function importRosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const file = formData.get("file");
  let csv = String(formData.get("csv") ?? "");
  if (file && typeof file === "object" && "text" in file && file.size > 0) {
    if (file.size > 1024 * 1024) return { ok: false, message: "The file is larger than 1 MB." };
    csv = await file.text();
  }
  if (!csv.trim()) return { ok: false, message: "Choose a CSV file or paste the rows." };
  const apply = String(formData.get("intent")) === "apply";
  const res = await importRosterCsv({ tenantId: viewer.tenantId, csv, apply });
  const detail = res.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`).join("; ");
  if (apply && res.ok) {
    await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftAssignment", summary: `Imported a roster CSV: ${res.rows} row(s), ${res.applied} day(s) changed` });
    return done([SETTINGS, "/attendance/roster"], res.message);
  }
  return { ok: res.ok, message: `${res.message}${detail ? ` ${detail}${res.errors.length > 5 ? ` and ${res.errors.length - 5} more` : ""}.` : ""}`, values: { csv: csv.slice(0, 20_000) } };
}

// ---------------------------------------------------------------------------
//  Kiosks and PINs
// ---------------------------------------------------------------------------

export async function createKioskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(z.object({ name: zName(60), locationId: zOptionalId(), pin: z.string() }), formData);
  if (parsed.state) return parsed.state;
  const res = await createKiosk({ tenantId: viewer.tenantId, ...parsed.data, createdBy: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message, errors: /PIN/.test(res.message) ? { pin: res.message } : undefined };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "AttendanceKiosk", entityId: res.id, summary: `Created kiosk ${parsed.data.name}` });
  return done([`${SETTINGS}`], `${res.message} Open its link on the kiosk device and unlock it with the PIN.`);
}

export async function updateKioskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const k = await prisma.attendanceKiosk.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!k) return { ok: false, message: "Kiosk not found." };
  if (op === "toggle") {
    await prisma.attendanceKiosk.update({ where: { id }, data: { isActive: !k.isActive } });
  } else if (op === "pin") {
    const pin = String(formData.get("pin") ?? "");
    const issue = pinIssue(pin);
    if (issue) return { ok: false, message: issue };
    await prisma.attendanceKiosk.update({ where: { id }, data: { pinHash: hashPin(pin) } });
  } else if (op === "rotate") {
    const { randomBytes } = await import("node:crypto");
    await prisma.attendanceKiosk.update({ where: { id }, data: { token: randomBytes(24).toString("base64url") } });
  } else {
    return { ok: false, message: "Unknown change." };
  }
  const what = op === "toggle" ? (k.isActive ? "Switched off" : "Switched on") : op === "pin" ? "Changed the PIN of" : "Issued a new link for";
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceKiosk", entityId: id, summary: `${what} kiosk ${k.name}` });
  return done([SETTINGS], `${what} ${k.name}.`);
}

export async function setMyKioskPinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const pin = String(formData.get("pin") ?? "");
  if (pin !== String(formData.get("confirm") ?? "")) return { ok: false, message: "The two PINs do not match.", errors: { confirm: "Does not match" } };
  const res = await setKioskPin(viewer.employee.id, pin);
  if (!res.ok) return { ok: false, message: res.message, errors: { pin: res.message } };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "KioskPin", summary: "Set their kiosk PIN" });
  return done(["/me/attendance"], res.message);
}

export async function resetKioskPinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!(await reachesEmployee(viewer, employeeId, P.ATTENDANCE_MANAGE))) return { ok: false, message: "Employee not found." };
  const n = await prisma.kioskPin.deleteMany({ where: { employeeId, tenantId: viewer.tenantId } });
  if (n.count === 0) return { ok: false, message: "That employee has no kiosk PIN." };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "DELETE", entityType: "KioskPin", entityId: employeeId, summary: "Cleared an employee's kiosk PIN" });
  return done([SETTINGS], "Cleared. They can set a new PIN under Me → Attendance.");
}

// ---------------------------------------------------------------------------
//  Work log
// ---------------------------------------------------------------------------

export async function saveWorkLogAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const week = String(formData.get("weekStart") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return { ok: false, message: "Pick a week." };
  const dates = formData.getAll("date").map(String);
  const hours = formData.getAll("hours").map(String);
  const notes = formData.getAll("notes").map(String);
  if (dates.length !== hours.length || dates.length > 7 || dates.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x))) return { ok: false, message: "Reload the page and try again." };
  const res = await saveWorkLog({
    employeeId: viewer.employee.id, weekStart: new Date(`${week}T00:00:00Z`),
    days: dates.map((dt, i) => ({ date: new Date(`${dt}T00:00:00Z`), hours: hours[i] ? Number(hours[i]) : 0, notes: notes[i] ?? null })),
    submit: String(formData.get("intent")) === "submit",
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "WorkLogWeek", entityId: res.weekId, summary: res.message });
  return done(["/me/work-log"], res.message);
}

export async function decideWorkLogAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const weekId = String(formData.get("weekId") ?? "");
  const decision = String(formData.get("decision")) === "approve" ? "APPROVE" : "REJECT";
  const note = String(formData.get("note") ?? "").trim() || null;
  const w = await prisma.workLogWeek.findFirst({ where: { id: weekId, tenantId: viewer.tenantId }, include: { employee: { select: { reportingManagerId: true } } } });
  if (!w) return { ok: false, message: "Work log not found." };
  if (w.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot approve your own work log." };
  const isManager = !!viewer.employee && w.employee.reportingManagerId === viewer.employee.id;
  if (!isManager && !(can(viewer, P.ATTENDANCE_APPROVE) && await reachesEmployee(viewer, w.employeeId, P.ATTENDANCE_APPROVE))) {
    return { ok: false, message: "Only the employee's manager or an attendance approver can decide this." };
  }
  const res = await decideWorkLog({ weekId, decision, deciderEmployeeId: viewer.employee?.id ?? null, note });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "ATTENDANCE", action: decision === "APPROVE" ? "APPROVE" : "REJECT", entityType: "WorkLogWeek", entityId: weekId, summary: `${decision === "APPROVE" ? "Approved" : "Sent back"} a work log (${Number(w.totalHours)} h)` });
  return done(["/me/work-log"], res.message);
}
