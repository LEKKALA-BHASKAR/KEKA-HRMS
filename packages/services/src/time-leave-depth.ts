import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { prisma } from "@keka/db";
import {
  dayKey, eachDayUtc, autoClockOutAt, parseRosterCsv, weekStartOf, workLogIssues,
} from "@keka/time";
import { resolveTimePolicy, reprocessRange, recordPunch, localDateKey } from "./time";
import { editAttendanceDay } from "./leave-policy";
import { EDITABLE_STATUSES, type EditableStatus } from "./leave-policy-math";
import { setRoster, type RosterValue } from "./roster";
import { notify } from "./lifecycle";

/**
 * Time and leave depth against the database: web kiosks and personal PINs,
 * the nightly auto clock-out, bulk attendance marking, the roster CSV import
 * and the simple weekly work log for people not on project timesheets.
 * The rules are pure functions in @keka/time; this file gathers and persists.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
type Result = { ok: boolean; message: string };

// ---------------------------------------------------------------------------
//  PINs
// ---------------------------------------------------------------------------

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(pin, salt, 32);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pinIssue(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return "A PIN is 4 to 6 digits.";
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) return "Choose a PIN that is not a repeated or running sequence.";
  return null;
}

// ---------------------------------------------------------------------------
//  Kiosks
// ---------------------------------------------------------------------------

export async function createKiosk(input: { tenantId: string; name: string; locationId?: string | null; pin: string; createdBy?: string | null }): Promise<Result & { id?: string; token?: string }> {
  const issue = pinIssue(input.pin);
  if (issue) return { ok: false, message: `Kiosk PIN: ${issue}` };
  if (input.locationId) {
    const loc = await prisma.location.findFirst({ where: { id: input.locationId, tenantId: input.tenantId }, select: { id: true } });
    if (!loc) return { ok: false, message: "That location was not found." };
  }
  const clash = await prisma.attendanceKiosk.findFirst({ where: { tenantId: input.tenantId, name: input.name }, select: { id: true } });
  if (clash) return { ok: false, message: "A kiosk with that name already exists." };
  const token = randomBytes(24).toString("base64url");
  const k = await prisma.attendanceKiosk.create({
    data: { tenantId: input.tenantId, name: input.name, locationId: input.locationId ?? null, token, pinHash: hashPin(input.pin), createdBy: input.createdBy ?? null },
  });
  return { ok: true, id: k.id, token, message: `Kiosk ${input.name} created.` };
}

/** The kiosk behind a URL token, if it is active. */
export async function kioskByToken(token: string) {
  if (!token || token.length < 16) return null;
  const k = await prisma.attendanceKiosk.findUnique({
    where: { token },
    include: { tenant: { select: { name: true, isActive: true } } },
  });
  return k && k.isActive && k.tenant.isActive ? k : null;
}

/**
 * What an unlocked device keeps in its cookie. Derived from the token and the
 * PIN hash, so a new link or a changed PIN locks every device again.
 */
export function kioskDeviceKey(kiosk: { token: string; pinHash: string }): string {
  return createHash("sha256").update(`${kiosk.token}:${kiosk.pinHash}`).digest("base64url");
}

/** Unlock a device for a kiosk with the kiosk PIN. */
export async function unlockKiosk(token: string, pin: string): Promise<Result> {
  const k = await kioskByToken(token);
  if (!k) return { ok: false, message: "This kiosk link is not valid or the kiosk is switched off." };
  if (!verifyPin(pin, k.pinHash)) return { ok: false, message: "That kiosk PIN is not right." };
  return { ok: true, message: `${k.name} is ready.` };
}

/** Set (or change) an employee's personal kiosk PIN. */
export async function setKioskPin(employeeId: string, pin: string): Promise<Result> {
  const issue = pinIssue(pin);
  if (issue) return { ok: false, message: issue };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  await prisma.kioskPin.upsert({
    where: { employeeId },
    create: { tenantId: emp.tenantId, employeeId, pinHash: hashPin(pin) },
    update: { pinHash: hashPin(pin), failedAttempts: 0, lockedUntil: null },
  });
  return { ok: true, message: "Your kiosk PIN is set." };
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * A punch at a kiosk: employee number and personal PIN. Five wrong PINs lock
 * that employee's kiosk PIN for fifteen minutes. The direction toggles from
 * the employee's last punch today unless one is given.
 */
export async function kioskPunch(input: {
  token: string; employeeNumber: string; pin: string; direction?: 0 | 1 | null; at?: Date; ipAddress?: string | null;
}): Promise<Result & { name?: string; direction?: 0 | 1 }> {
  const kiosk = await kioskByToken(input.token);
  if (!kiosk) return { ok: false, message: "This kiosk link is not valid or the kiosk is switched off." };
  const number = input.employeeNumber.trim();
  const wrong = { ok: false, message: "Employee number or PIN is not right." };
  if (!number || !/^\d{4,6}$/.test(input.pin)) return wrong;
  const emp = await prisma.employee.findFirst({
    where: { tenantId: kiosk.tenantId, employeeNumber: { equals: number, mode: "insensitive" }, status: { notIn: ["EXITED", "PREBOARDING"] } },
    select: { id: true, displayName: true, firstName: true, kioskPin: true },
  });
  if (!emp || !emp.kioskPin) return emp && !emp.kioskPin ? { ok: false, message: "You have not set a kiosk PIN yet. Set one under Me → Attendance." } : wrong;
  const now = input.at ?? new Date();
  if (emp.kioskPin.lockedUntil && emp.kioskPin.lockedUntil.getTime() > now.getTime()) {
    return { ok: false, message: "Too many wrong PINs. Try again in a few minutes or ask HR." };
  }
  if (!verifyPin(input.pin, emp.kioskPin.pinHash)) {
    const failed = emp.kioskPin.failedAttempts + 1;
    await prisma.kioskPin.update({
      where: { id: emp.kioskPin.id },
      data: failed >= MAX_FAILED
        ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
        : { failedAttempts: failed },
    });
    return wrong;
  }
  if (emp.kioskPin.failedAttempts > 0 || emp.kioskPin.lockedUntil) {
    await prisma.kioskPin.update({ where: { id: emp.kioskPin.id }, data: { failedAttempts: 0, lockedUntil: null } });
  }

  let direction = input.direction ?? null;
  if (direction === null) {
    const policy = await resolveTimePolicy(emp.id, now);
    const localKey = localDateKey(now, policy.tzOffset);
    const dayStart = new Date(new Date(`${localKey}T00:00:00Z`).getTime() - policy.tzOffset * 60_000);
    const last = await prisma.attendanceLog.findFirst({
      where: { employeeId: emp.id, status: "VALID", timestamp: { gte: dayStart, lte: now } },
      orderBy: { timestamp: "desc" }, select: { direction: true },
    });
    direction = last?.direction === 0 ? 1 : 0;
  }
  const res = await recordPunch({
    employeeId: emp.id, direction, at: now, source: "KIOSK", deviceId: kiosk.id,
    ipAddress: input.ipAddress ?? null, comment: `Kiosk: ${kiosk.name}`,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await prisma.attendanceKiosk.update({ where: { id: kiosk.id }, data: { lastUsedAt: now } });
  const name = emp.displayName ?? emp.firstName;
  return { ok: true, name, direction, message: `${direction === 0 ? "Clocked in" : "Clocked out"}: ${name}.` };
}

// ---------------------------------------------------------------------------
//  Auto clock-out (nightly)
// ---------------------------------------------------------------------------

/**
 * Close punches left open past their shift's maximum slot: an OUT is written
 * at IN + the shift's auto clock-out minutes and the day is reprocessed.
 * Idempotent — a closed slot is no longer open.
 */
export async function runAutoClockOut(tenantId: string, now: Date = new Date()): Promise<{ checked: number; closed: number }> {
  const since = new Date(now.getTime() - 3 * DAY);
  const logs = await prisma.attendanceLog.findMany({
    where: { tenantId, status: "VALID", timestamp: { gte: since, lte: now } },
    orderBy: { timestamp: "asc" },
    select: { employeeId: true, timestamp: true, direction: true },
  });
  const lastBy = new Map<string, { timestamp: Date; direction: number }>();
  for (const l of logs) lastBy.set(l.employeeId, l);
  let checked = 0, closed = 0;
  for (const [employeeId, last] of lastBy) {
    if (last.direction !== 0) continue;
    checked++;
    const policy = await resolveTimePolicy(employeeId, last.timestamp);
    const local = new Date(`${localDateKey(last.timestamp, policy.tzOffset)}T00:00:00Z`);
    const override = await prisma.shiftAssignment.findUnique({ where: { employeeId_date: { employeeId, date: local } }, include: { shift: true } });
    const shift = override?.shift ?? (policy.defaultShiftId ? await prisma.shift.findUnique({ where: { id: policy.defaultShiftId } }) : null);
    const due = autoClockOutAt(last.timestamp, shift?.maxSlotMinutes ?? null, now);
    if (!due) continue;
    await prisma.attendanceLog.create({
      data: {
        tenantId, employeeId, timestamp: due, direction: 1, source: "MANUAL",
        comment: `Auto clock-out after ${shift!.maxSlotMinutes} minutes (${shift!.name})`,
      },
    });
    await reprocessRange(employeeId, local, local);
    closed++;
  }
  return { checked, closed };
}

// ---------------------------------------------------------------------------
//  Bulk attendance marking
// ---------------------------------------------------------------------------

export interface BulkMarkSummary { ok: boolean; message: string; changed: number; skipped: Array<{ employeeId: string; date: string; reason: string }> }

/**
 * Pin a status on many employees' days at once (bulk regularisation). Each
 * day goes through the same edit as a single-day correction, so payroll
 * locks, joining dates and the audit reason apply to every one.
 */
export async function bulkMarkAttendance(input: {
  tenantId: string; employeeIds: string[]; from: Date; to: Date;
  status: EditableStatus | "AUTO"; reason: string; actorUserId?: string | null;
  workingDaysOnly?: boolean; today?: Date;
}): Promise<BulkMarkSummary> {
  const from = utcMidnight(input.from), to = utcMidnight(input.to);
  const today = utcMidnight(input.today ?? new Date());
  const none = (message: string): BulkMarkSummary => ({ ok: false, message, changed: 0, skipped: [] });
  if (!input.reason.trim()) return none("Give a reason; it is kept with every day changed.");
  if (input.status !== "AUTO" && !(EDITABLE_STATUSES as readonly string[]).includes(input.status)) return none("Unknown status.");
  if (to.getTime() < from.getTime()) return none("The end date is before the start date.");
  if (to.getTime() > today.getTime()) return none("Only days up to today can be marked.");
  if ((to.getTime() - from.getTime()) / DAY > 30) return none("Mark at most 31 days at a time.");
  const ids = [...new Set(input.employeeIds)];
  if (ids.length === 0) return none("Select at least one employee.");
  if (ids.length > 200) return none("Select at most 200 employees at a time.");
  const emps = await prisma.employee.findMany({ where: { id: { in: ids }, tenantId: input.tenantId }, select: { id: true } });
  if (emps.length !== ids.length) return none("Some selected employees were not found.");

  let changed = 0;
  const skipped: BulkMarkSummary["skipped"] = [];
  for (const employeeId of ids) {
    const policy = input.workingDaysOnly ? await resolveTimePolicy(employeeId, from) : null;
    for (const date of eachDayUtc(from, to)) {
      if (policy) {
        const { classifyDay } = await import("@keka/time");
        const kind = classifyDay(date, policy.calendar);
        if (kind === "WEEKLY_OFF" || kind === "HOLIDAY") continue;
      }
      const res = await editAttendanceDay({
        employeeId, date, status: input.status, reason: input.reason, actorUserId: input.actorUserId ?? null, today,
      });
      if (res.ok) changed++;
      else skipped.push({ employeeId, date: dayKey(date), reason: res.message });
    }
  }
  const label = input.status === "AUTO" ? "returned to automatic" : `marked ${input.status.replace(/_/g, " ").toLowerCase()}`;
  return {
    ok: changed > 0, changed, skipped,
    message: changed > 0
      ? `${changed} day(s) ${label}${skipped.length ? `; ${skipped.length} skipped (${skipped[0].reason})` : ""}.`
      : `Nothing changed${skipped.length ? `: ${skipped[0].reason}` : "."}`,
  };
}

// ---------------------------------------------------------------------------
//  Roster CSV import
// ---------------------------------------------------------------------------

export interface RosterImportSummary {
  ok: boolean; message: string; rows: number; applied: number;
  errors: Array<{ line: number; message: string }>;
}

/** Shift code "WO" or "OFF" rosters a weekly off; "DEFAULT" clears the day. */
export async function importRosterCsv(input: { tenantId: string; csv: string; apply: boolean }): Promise<RosterImportSummary> {
  const parsed = parseRosterCsv(input.csv);
  const errors = [...parsed.errors];
  if (parsed.rows.length === 0) {
    return { ok: false, message: errors.length ? "No usable rows." : "The file has no rows.", rows: 0, applied: 0, errors };
  }
  if (parsed.rows.length > 5000) return { ok: false, message: "Import at most 5,000 rows at a time.", rows: parsed.rows.length, applied: 0, errors };
  const [emps, shifts] = await Promise.all([
    prisma.employee.findMany({
      where: { tenantId: input.tenantId, employeeNumber: { in: [...new Set(parsed.rows.map((r) => r.employeeNumber))] } },
      select: { id: true, employeeNumber: true },
    }),
    prisma.shift.findMany({ where: { tenantId: input.tenantId, isActive: true }, select: { id: true, code: true } }),
  ]);
  const empBy = new Map(emps.map((e) => [e.employeeNumber.toUpperCase(), e.id]));
  const shiftBy = new Map(shifts.map((s) => [s.code.toUpperCase(), s.id]));
  const writes: Array<{ employeeId: string; date: Date; value: RosterValue }> = [];
  const seen = new Set<string>();
  for (const r of parsed.rows) {
    const employeeId = empBy.get(r.employeeNumber.toUpperCase());
    if (!employeeId) { errors.push({ line: r.line, message: `No employee ${r.employeeNumber}.` }); continue; }
    let value: RosterValue;
    if (r.shiftCode === "WO" || r.shiftCode === "OFF") value = { kind: "OFF" };
    else if (r.shiftCode === "DEFAULT") value = { kind: "DEFAULT" };
    else {
      const shiftId = shiftBy.get(r.shiftCode);
      if (!shiftId) { errors.push({ line: r.line, message: `No active shift with code ${r.shiftCode}.` }); continue; }
      value = { kind: "SHIFT", shiftId };
    }
    const k = `${employeeId}|${r.date}`;
    if (seen.has(k)) { errors.push({ line: r.line, message: `${r.employeeNumber} on ${r.date} appears twice.` }); continue; }
    seen.add(k);
    writes.push({ employeeId, date: new Date(`${r.date}T00:00:00Z`), value });
  }
  if (!input.apply || errors.length > 0) {
    return {
      ok: errors.length === 0, rows: parsed.rows.length, applied: 0, errors,
      message: errors.length ? `${errors.length} row(s) need fixing; nothing was imported.` : `${writes.length} row(s) ready to import.`,
    };
  }
  const res = await setRoster(input.tenantId, writes);
  return { ok: res.ok, message: res.ok ? `Imported ${writes.length} row(s). ${res.message}` : res.message, rows: parsed.rows.length, applied: res.ok ? res.changed : 0, errors };
}

// ---------------------------------------------------------------------------
//  Work log — daily hours for people not on project timesheets
// ---------------------------------------------------------------------------

export async function workLogWeek(employeeId: string, weekStart: Date) {
  return prisma.workLogWeek.findUnique({
    where: { employeeId_weekStart: { employeeId, weekStart: weekStartOf(weekStart) } },
    include: { days: { orderBy: { date: "asc" } } },
  });
}

export async function saveWorkLog(input: {
  employeeId: string; weekStart: Date;
  days: Array<{ date: Date; hours: number; notes?: string | null }>;
  submit?: boolean; today?: Date;
}): Promise<Result & { weekId?: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    select: { tenantId: true, displayName: true, firstName: true, reportingManager: { select: { userId: true } } },
  });
  const weekStart = weekStartOf(utcMidnight(input.weekStart));
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY);
  const today = utcMidnight(input.today ?? new Date());
  if (weekStart.getTime() > today.getTime()) return { ok: false, message: "That week has not started yet." };
  const days = input.days.map((d) => ({ ...d, date: utcMidnight(d.date), hours: r2(Number(d.hours) || 0) }));
  if (days.some((d) => d.date.getTime() < weekStart.getTime() || d.date.getTime() > weekEnd.getTime())) {
    return { ok: false, message: "Every day must fall inside the week." };
  }
  if (days.some((d) => d.date.getTime() > today.getTime() && d.hours > 0)) return { ok: false, message: "Hours can only be logged for days up to today." };
  const issues = workLogIssues(days.map((d) => ({ key: dayKey(d.date), hours: d.hours })));
  if (issues.length) return { ok: false, message: issues.join(" ") };
  const total = r2(days.reduce((s, d) => s + d.hours, 0));
  if (input.submit && total <= 0) return { ok: false, message: "Log some hours before submitting the week." };

  const existing = await prisma.workLogWeek.findUnique({ where: { employeeId_weekStart: { employeeId: input.employeeId, weekStart } } });
  if (existing && (existing.status === "SUBMITTED" || existing.status === "APPROVED")) {
    return { ok: false, message: `This week is ${existing.status.toLowerCase()} and can no longer be edited.` };
  }
  const week = await prisma.$transaction(async (tx) => {
    const w = existing
      ? await tx.workLogWeek.update({
          where: { id: existing.id },
          data: { totalHours: total, status: input.submit ? "SUBMITTED" : "DRAFT", submittedAt: input.submit ? new Date() : null, decidedBy: null, decidedAt: null, decisionNote: input.submit ? null : existing.decisionNote },
        })
      : await tx.workLogWeek.create({
          data: { tenantId: emp.tenantId, employeeId: input.employeeId, weekStart, totalHours: total, status: input.submit ? "SUBMITTED" : "DRAFT", submittedAt: input.submit ? new Date() : null },
        });
    await tx.workLogDay.deleteMany({ where: { weekId: w.id } });
    const rows = days.filter((d) => d.hours > 0 || (d.notes ?? "").trim());
    if (rows.length) {
      await tx.workLogDay.createMany({
        data: rows.map((d) => ({ weekId: w.id, date: d.date, hours: d.hours, notes: d.notes?.trim().slice(0, 500) || null })),
      });
    }
    return w;
  });
  if (input.submit && emp.reportingManager?.userId) {
    await notify({
      tenantId: emp.tenantId, userIds: [emp.reportingManager.userId], kind: "ATTENDANCE",
      title: `${emp.displayName ?? emp.firstName} submitted a work log for the week of ${dayKey(weekStart)} (${total} h)`,
      link: "/me/work-log?view=team",
    });
  }
  return { ok: true, weekId: week.id, message: input.submit ? `Submitted ${total} hour(s) for approval.` : `Saved ${total} hour(s) as a draft.` };
}

export async function decideWorkLog(input: {
  weekId: string; decision: "APPROVE" | "REJECT"; deciderEmployeeId?: string | null; note?: string | null;
}): Promise<Result> {
  const w = await prisma.workLogWeek.findUniqueOrThrow({
    where: { id: input.weekId },
    include: { employee: { select: { userId: true } } },
  });
  if (w.status !== "SUBMITTED") return { ok: false, message: `This week is ${w.status.toLowerCase()}, not awaiting approval.` };
  if (input.decision === "REJECT" && !input.note?.trim()) return { ok: false, message: "Say why it is sent back." };
  await prisma.workLogWeek.update({
    where: { id: w.id },
    data: {
      status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
      decidedBy: input.deciderEmployeeId ?? null, decidedAt: new Date(), decisionNote: input.note?.trim() || null,
    },
  });
  await notify({
    tenantId: w.tenantId, userIds: [w.employee.userId], kind: "ATTENDANCE",
    title: `Your work log for the week of ${dayKey(w.weekStart)} was ${input.decision === "APPROVE" ? "approved" : "sent back"}`,
    body: input.note ?? null, link: "/me/work-log",
  });
  return { ok: true, message: input.decision === "APPROVE" ? "Approved." : "Sent back to the employee." };
}
