"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  APPROVAL_ROLES, EDITABLE_STATUSES, parseApprovalChain, autoApproveStaleLeave,
  pickOptionalHoliday, unpickOptionalHoliday, grantCompOff, editAttendanceDay, importLopDays, generateShiftAllowances,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { reachesEmployee } from "@/lib/time-decide";
import { scopedEmployeeIds } from "@/lib/scope";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zDate, zRequiredDate, zBool, zId,
  type ActionState,
} from "@/lib/forms";

/**
 * Leave and attendance policy depth: approval chains, optional holidays,
 * comp-off grants, admin day edits, the LOP import, shift allowance and the
 * comp-off/overtime policy flags. Rules live in @keka/services; these check
 * who may act and record what they did.
 */

const P = PERMISSIONS;

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

const chainSchema = z.object({
  target: z.enum(["plan", "type"]),
  id: zId(),
  skipSamePerson: zBool(),
  autoApproveAfterDays: zNumber({ min: 0, max: 60 }),
});

/** Set (or clear, with no levels) the approval chain on a leave plan or type. */
export async function saveApprovalChainAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const parsed = parseForm(chainSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const levels = formList(formData, "levels").filter((l) => l && (APPROVAL_ROLES as readonly string[]).includes(l));
  const raw = { levels, skipSamePerson: d.skipSamePerson, autoApproveAfterDays: d.autoApproveAfterDays ?? null };
  const chain = parseApprovalChain(raw);
  const value = chain ? (chain as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  const u = d.target === "plan"
    ? await prisma.leavePlan.updateMany({ where: { id: d.id, tenantId: viewer.tenantId }, data: { approvalChain: value } })
    : await prisma.leaveType.updateMany({ where: { id: d.id, tenantId: viewer.tenantId }, data: { approvalChain: value } });
  if (u.count === 0) return { ok: false, message: d.target === "plan" ? "Plan not found." : "Leave type not found." };
  const summary = chain
    ? `${chain.levels.join(" → ")}${chain.autoApproveAfterDays ? `, auto-approve after ${chain.autoApproveAfterDays} day(s)` : ""}`
    : "single decision (default)";
  await writeAudit(viewer, {
    module: "LEAVE", action: "UPDATE", entityType: d.target === "plan" ? "LeavePlan" : "LeaveType", entityId: d.id,
    summary: `Approval chain set: ${summary}`, newValue: chain ?? null,
  });
  return done(["/leave"], chain
    ? `Saved. New requests go ${chain.levels.length} level(s) deep${chain.autoApproveAfterDays ? ` and approve themselves after ${chain.autoApproveAfterDays} day(s) without a decision` : ""}. Requests already raised keep their chain.`
    : d.target === "type" ? "Cleared. This type follows its plan's chain, or a single decision." : "Cleared. Requests take a single decision by any approver.");
}

export async function runAutoApproveAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEAVE_MANAGE);
  const r = await autoApproveStaleLeave(viewer.tenantId);
  await writeAudit(viewer, { module: "LEAVE", action: "APPROVE", entityType: "LeaveRequest", summary: `Ran leave auto-approval: ${r.approved} approved of ${r.checked} on a chain` });
  return done(["/leave", "/inbox"], r.approved
    ? `Auto-approved ${r.approved} request(s) that waited past their chain's window.`
    : `Nothing to approve — ${r.checked} chained request(s) are still within their window. This also runs nightly.`);
}

// ---------------------------------------------------------------------------
//  Optional holidays
// ---------------------------------------------------------------------------

export async function setOptionalQuotaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const parsed = parseForm(z.object({ calendarId: zId(), quota: zRequiredNumber({ min: 0, max: 30 }) }), formData);
  if (parsed.state) return parsed.state;
  const quota = Math.floor(parsed.data.quota);
  const u = await prisma.holidayCalendar.updateMany({ where: { id: parsed.data.calendarId, tenantId: viewer.tenantId }, data: { optionalHolidayQuota: quota } });
  if (u.count === 0) return { ok: false, message: "Calendar not found." };
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayCalendar", entityId: parsed.data.calendarId, summary: `Optional holiday quota set to ${quota}` });
  return done(["/leave", "/me/leave"], quota ? `Employees on this calendar may now pick ${quota} optional holiday(s).` : "Optional holidays are switched off for this calendar.");
}

/** Pick (or with intent=remove, drop) an optional holiday — for yourself, or as HR for someone. */
export async function optionalHolidayAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const holidayId = String(formData.get("holidayId") ?? "");
  const remove = String(formData.get("intent") ?? "") === "remove";
  const target = String(formData.get("employeeId") ?? "") || viewer.employee?.id;
  if (!target) return { ok: false, message: "No employee record linked to this login." };
  const forOther = target !== viewer.employee?.id;
  if (forOther && !(can(viewer, P.LEAVE_MANAGE) && await reachesEmployee(viewer, target, P.LEAVE_MANAGE))) {
    return { ok: false, message: "You can only pick optional holidays for yourself." };
  }
  try {
    const res = remove
      ? await unpickOptionalHoliday({ employeeId: target, holidayId, force: forOther })
      : await pickOptionalHoliday({ employeeId: target, holidayId, byUserId: viewer.user.id });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, {
      module: "LEAVE", action: remove ? "DELETE" : "CREATE", entityType: "OptionalHolidaySelection", entityId: holidayId,
      summary: `${remove ? "Removed" : "Picked"} an optional holiday${forOther ? " on someone's behalf" : ""}: ${res.message}`,
    });
    return done(["/me/leave", "/me/attendance", "/leave"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  Comp-off grants
// ---------------------------------------------------------------------------

const grantSchema = z.object({
  employeeId: zId(),
  days: zRequiredNumber({ min: 0.5, max: 10 }),
  workedOn: zDate(),
  expiresOn: zDate(),
  note: zName(300),
});

/** HR, or a manager for their people, grants comp-off directly. */
export async function grantCompOffAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(grantSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot grant comp-off to yourself." };
  const allowed = (can(viewer, P.LEAVE_MANAGE) && await reachesEmployee(viewer, d.employeeId, P.LEAVE_MANAGE))
    || (can(viewer, P.LEAVE_APPROVE) && await reachesEmployee(viewer, d.employeeId, P.LEAVE_APPROVE));
  if (!allowed) return { ok: false, message: "You can grant comp-off only to people whose leave you approve." };
  try {
    const res = await grantCompOff({
      employeeId: d.employeeId, days: d.days, note: d.note, workedOn: d.workedOn, expiresOn: d.expiresOn,
      grantedByEmployeeId: viewer.employee?.id ?? null,
    });
    if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) };
    await writeAudit(viewer, {
      module: "LEAVE", action: "CREATE", entityType: "LeaveLedgerEntry", entityId: res.ledgerEntryId,
      summary: `Granted ${d.days} day(s) comp-off: ${d.note}`, newValue: { employeeId: d.employeeId, days: d.days, expiresOn: res.expiresOn ?? null },
    });
    return done(["/leave", "/me/leave"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  Attendance: day edit, LOP import, shift allowance, policy flags
// ---------------------------------------------------------------------------

const dayEditSchema = z.object({
  employeeId: zId(),
  date: zRequiredDate(),
  status: z.enum(["", "AUTO", ...EDITABLE_STATUSES]).default(""),
  firstIn: zOptional(5),
  lastOut: zOptional(5),
  reason: zName(300),
});

export async function editAttendanceDayAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(dayEditSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await reachesEmployee(viewer, d.employeeId, P.ATTENDANCE_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  if (d.employeeId === viewer.employee?.id) return { ok: false, message: "Ask another administrator to edit your own attendance." };
  try {
    const res = await editAttendanceDay({
      employeeId: d.employeeId, date: d.date, status: d.status ? d.status : null,
      firstIn: d.firstIn, lastOut: d.lastOut, reason: d.reason, actorUserId: viewer.user.id,
    });
    if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) };
    const emp = await prisma.employee.findFirst({ where: { id: d.employeeId, tenantId: viewer.tenantId }, select: { employeeNumber: true } });
    await writeAudit(viewer, {
      module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceRecord", entityId: d.employeeId,
      summary: `Edited ${emp?.employeeNumber ?? "employee"}'s attendance for ${d.date.toISOString().slice(0, 10)}: ${res.before?.status ?? "none"} → ${res.after?.status ?? "?"} (${d.reason})`,
      oldValue: res.before ?? null, newValue: res.after ?? null,
    });
    return done(["/attendance", "/me/attendance"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

const MAX_BYTES = 1024 * 1024;

export async function importLopAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const apply = String(formData.get("intent") ?? "check") === "import";
  const file = formData.get("file");
  let csv = String(formData.get("csv") ?? "");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_BYTES) return { ok: false, message: "The file is larger than 1 MB." };
    csv = await file.text();
  }
  if (!csv.trim()) return { ok: false, message: "Choose a CSV file or paste its rows." };
  const res = await importLopDays({
    tenantId: viewer.tenantId, csv, apply, actorUserId: viewer.user.id,
    allowedEmployeeIds: await scopedEmployeeIds(viewer, P.ATTENDANCE_MANAGE),
  });
  const detail = res.errors.slice(0, 8).map((e) => `Line ${e.line}: ${e.message}`).join(" ");
  if (!res.ok) return { ok: false, message: `${res.message}${detail ? ` ${detail}` : ""}`, values: { csv } };
  if (!apply) {
    const preview = res.rows.slice(0, 6).map((r) => `${r.employeeNumber} ${r.year}-${String(r.month).padStart(2, "0")}: ${r.days}`).join(", ");
    return { ok: true, message: `${res.message} ${preview}${res.rows.length > 6 ? "…" : ""}`, values: { csv } };
  }
  await writeAudit(viewer, {
    module: "PAYROLL", action: "CREATE", entityType: "LopAdjustment",
    summary: `Imported LOP days: ${res.rows.length} row(s), ${res.created} set, ${res.cleared} replaced`,
    newValue: res.rows.map((r) => ({ employeeNumber: r.employeeNumber, year: r.year, month: r.month, days: r.days })),
  });
  return done(["/attendance", "/payroll"], res.message);
}

export async function generateShiftAllowanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(z.object({ year: zRequiredNumber({ min: 2000, max: 2100 }), month: zRequiredNumber({ min: 1, max: 12 }) }), formData);
  if (parsed.state) return parsed.state;
  const scope = await scopedEmployeeIds(viewer, P.ATTENDANCE_MANAGE);
  const s = await generateShiftAllowances({ tenantId: viewer.tenantId, year: parsed.data.year, month: parsed.data.month, ...(scope ? { employeeIds: scope } : {}) });
  await writeAudit(viewer, {
    module: "PAYROLL", action: "CREATE", entityType: "ShiftAllowanceEntry",
    summary: `Generated shift allowance for ${parsed.data.month}/${parsed.data.year}: ${s.entries} entries, ₹${s.amount}`,
  });
  return done(["/attendance", "/payroll"], s.entries
    ? `Created ${s.entries} shift allowance entr${s.entries === 1 ? "y" : "ies"} for ${s.employees} employee(s): ${s.days} day(s), ₹${s.amount.toLocaleString("en-IN")}. Payroll for ${parsed.data.month}/${parsed.data.year} picks them up.${s.skippedPaid ? ` ${s.skippedPaid} already paid were left alone.` : ""}`
    : `No allowance earned in ${parsed.data.month}/${parsed.data.year}. Give a shift an allowance code and rate, and process attendance first.${s.skippedPaid ? ` ${s.skippedPaid} already paid were left alone.` : ""}`);
}

const allowanceSchema = z.object({
  shiftId: zId(),
  allowanceCode: z.string().max(20).optional().transform((v) => (v && v.trim() ? v.trim().toUpperCase() : null)),
  allowancePerDay: zNumber({ min: 0, max: 100000 }),
});

export async function saveShiftAllowanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const parsed = parseForm(allowanceSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!!d.allowanceCode !== !!d.allowancePerDay) {
    return { ok: false, message: "Give both an allowance code and a rate per day, or clear both.", errors: { allowanceCode: "Both or neither" } };
  }
  const u = await prisma.shift.updateMany({ where: { id: d.shiftId, tenantId: viewer.tenantId }, data: { allowanceCode: d.allowanceCode, allowancePerDay: d.allowancePerDay } });
  if (u.count === 0) return { ok: false, message: "Shift not found." };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "Shift", entityId: d.shiftId, summary: d.allowanceCode ? `Shift allowance ${d.allowanceCode} at ₹${d.allowancePerDay}/day` : "Shift allowance removed" });
  return done(["/attendance"], d.allowanceCode ? `Saved: ${d.allowanceCode} at ₹${d.allowancePerDay} per day worked.` : "Shift allowance removed.");
}

const policyFlagsSchema = z.object({
  policyId: zId(),
  autoCreditCompOff: zBool(),
  overtimeMultiplier: zRequiredNumber({ min: 0.5, max: 5 }),
  overtimeOffDayMultiplier: zRequiredNumber({ min: 0.5, max: 5 }),
  overtimeRoundingMinutes: zRequiredNumber({ min: 0, max: 120 }),
});

export async function saveTimePolicyDepthAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const parsed = parseForm(policyFlagsSchema, formData);
  if (parsed.state) return parsed.state;
  const { policyId, ...d } = parsed.data;
  const u = await prisma.attendancePolicy.updateMany({
    where: { id: policyId, tenantId: viewer.tenantId },
    data: { ...d, overtimeRoundingMinutes: Math.floor(d.overtimeRoundingMinutes) },
  });
  if (u.count === 0) return { ok: false, message: "Policy not found." };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendancePolicy", entityId: policyId, summary: "Comp-off and overtime rules updated", newValue: d });
  return done(["/attendance"], `Saved. Comp-off is ${d.autoCreditCompOff ? "credited automatically" : "credited on request"}; overtime pays ${d.overtimeMultiplier}× (${d.overtimeOffDayMultiplier}× on off days)${d.overtimeRoundingMinutes ? `, rounded down to ${Math.floor(d.overtimeRoundingMinutes)} minutes` : ""}.`);
}
