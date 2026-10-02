import { prisma, Prisma } from "@keka/db";
import { classifyDay, dayKey, eachDayUtc } from "@keka/time";
import { resolveTimePolicy, reprocessRange } from "./time";

/**
 * Shift rostering. A roster cell is one employee's day: the shift they work,
 * or a weekly off. With no ShiftAssignment row the day follows the
 * employee's time policy (default shift and weekly-off pattern); a row
 * overrides it. WO marks an off day, ON a working day the pattern would
 * have had off. Changing past days reprocesses their attendance.
 */

export type RosterValue = { kind: "DEFAULT" } | { kind: "OFF" } | { kind: "SHIFT"; shiftId: string };
export interface RosterCell { date: string; shiftId: string | null; off: boolean; explicit: boolean }
export interface PatternStep { shiftId: string | null; off: boolean }

const MAX_DAYS = 92;
const DAY = 86_400_000;

/** Parse "YYYY-MM-DD" to a UTC midnight date, or null. */
export function rosterDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || dayKey(d) !== s ? null : d;
}

/** The grid for a set of employees across a range, explicit or by policy. */
export async function rosterGrid(employeeIds: string[], from: Date, days: number): Promise<Map<string, RosterCell[]>> {
  const to = new Date(from.getTime() + (days - 1) * DAY);
  const rows = await prisma.shiftAssignment.findMany({ where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } } });
  const byKey = new Map(rows.map((r) => [`${r.employeeId}|${dayKey(r.date)}`, r]));
  const out = new Map<string, RosterCell[]>();
  for (const id of employeeIds) {
    const policy = await resolveTimePolicy(id, from);
    out.set(id, [...eachDayUtc(from, to)].map((date) => {
      const key = dayKey(date);
      const row = byKey.get(`${id}|${key}`);
      if (row) return { date: key, shiftId: row.shiftId, off: row.weeklyOffCode === "WO", explicit: true };
      return { date: key, shiftId: policy.defaultShiftId, off: classifyDay(date, policy.calendar) === "WEEKLY_OFF", explicit: false };
    }));
  }
  return out;
}

type Write = { employeeId: string; date: Date; value: RosterValue };

/**
 * Write roster cells. Every employee and shift must belong to the tenant.
 * Returns how many cells changed; past days touched are reprocessed.
 */
export async function setRoster(tenantId: string, writes: Write[]): Promise<{ ok: boolean; message: string; changed: number }> {
  if (writes.length === 0) return { ok: true, message: "Nothing to change.", changed: 0 };
  const empIds = [...new Set(writes.map((w) => w.employeeId))];
  const shiftIds = [...new Set(writes.flatMap((w) => (w.value.kind === "SHIFT" ? [w.value.shiftId] : [])))];
  const [emps, shifts] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: empIds }, tenantId }, select: { id: true } }),
    prisma.shift.findMany({ where: { id: { in: shiftIds }, tenantId, isActive: true }, select: { id: true } }),
  ]);
  if (emps.length !== empIds.length) return { ok: false, message: "One of those employees was not found.", changed: 0 };
  if (shifts.length !== shiftIds.length) return { ok: false, message: "One of those shifts was not found or is inactive.", changed: 0 };
  const dates = writes.map((w) => w.date.getTime());
  const min = new Date(Math.min(...dates)), max = new Date(Math.max(...dates));
  if ((max.getTime() - min.getTime()) / DAY >= MAX_DAYS * 2) return { ok: false, message: "Roster at most six months at a time.", changed: 0 };

  const policies = new Map<string, Awaited<ReturnType<typeof resolveTimePolicy>>>();
  for (const id of empIds) policies.set(id, await resolveTimePolicy(id, min));
  const existing = await prisma.shiftAssignment.findMany({ where: { employeeId: { in: empIds }, date: { gte: min, lte: max } } });
  const prior = new Map(existing.map((r) => [`${r.employeeId}|${dayKey(r.date)}`, r]));

  let changed = 0;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const w of writes) {
    const key = `${w.employeeId}|${dayKey(w.date)}`;
    const was = prior.get(key);
    const policy = policies.get(w.employeeId)!;
    if (w.value.kind === "DEFAULT") {
      if (was) { ops.push(prisma.shiftAssignment.delete({ where: { id: was.id } })); changed++; }
      continue;
    }
    const patternOff = classifyDay(w.date, policy.calendar) === "WEEKLY_OFF";
    const shiftId = w.value.kind === "SHIFT" ? w.value.shiftId : (was?.shiftId ?? policy.defaultShiftId);
    if (!shiftId) return { ok: false, message: "There is no default shift to hang a weekly off on. Create a shift first.", changed: 0 };
    const code = w.value.kind === "OFF" ? "WO" : patternOff ? "ON" : null;
    if (was && was.shiftId === shiftId && was.weeklyOffCode === code) continue;
    ops.push(prisma.shiftAssignment.upsert({
      where: { employeeId_date: { employeeId: w.employeeId, date: w.date } },
      create: { employeeId: w.employeeId, date: w.date, shiftId, weeklyOffCode: code },
      update: { shiftId, weeklyOffCode: code },
    }));
    changed++;
  }
  await prisma.$transaction(ops);

  const today = new Date(dayKey(new Date()) + "T00:00:00.000Z");
  if (changed && min.getTime() <= today.getTime()) {
    const until = max.getTime() < today.getTime() ? max : today;
    for (const id of empIds) await reprocessRange(id, min, until);
  }
  return { ok: true, message: changed ? `Roster updated: ${changed} day${changed === 1 ? "" : "s"} changed.` : "Nothing changed.", changed };
}

/** Steps from a stored pattern's JSON, dropping anything malformed. */
export function patternSteps(json: unknown): PatternStep[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((s) => (s && typeof s === "object" ? [{ shiftId: typeof s.shiftId === "string" ? s.shiftId : null, off: !!s.off }] : []))
    .filter((s) => s.off || s.shiftId);
}

/**
 * Lay a pattern over a date range for each employee, starting at a step
 * (so a team can be staggered). Days run from `from` to `to` inclusive.
 */
export async function applyRosterPattern(input: { tenantId: string; patternId: string; employeeIds: string[]; from: Date; to: Date; startStep?: number; staggerBy?: number }) {
  const pattern = await prisma.rosterPattern.findFirst({ where: { id: input.patternId, tenantId: input.tenantId, isActive: true } });
  if (!pattern) return { ok: false, message: "That pattern was not found.", changed: 0 };
  const steps = patternSteps(pattern.steps);
  if (steps.length === 0) return { ok: false, message: "That pattern has no days.", changed: 0 };
  if (input.to < input.from) return { ok: false, message: "The end date is before the start.", changed: 0 };
  const days = [...eachDayUtc(input.from, input.to)];
  if (days.length > MAX_DAYS) return { ok: false, message: `Apply a pattern to at most ${MAX_DAYS} days at a time.`, changed: 0 };
  const writes: Write[] = input.employeeIds.flatMap((employeeId, e) => days.map((date, i) => {
    const step = steps[(((input.startStep ?? 0) + e * (input.staggerBy ?? 0) + i) % steps.length + steps.length) % steps.length];
    return { employeeId, date, value: step.off ? { kind: "OFF" as const } : { kind: "SHIFT" as const, shiftId: step.shiftId! } };
  }));
  const res = await setRoster(input.tenantId, writes);
  return res.ok ? { ...res, message: `Applied ${pattern.name} to ${input.employeeIds.length} employee${input.employeeIds.length === 1 ? "" : "s"}. ${res.message}` } : res;
}

/** Copy one week's explicit roster rows onto the following week. */
export async function copyRosterWeek(tenantId: string, employeeIds: string[], weekStart: Date) {
  const end = new Date(weekStart.getTime() + 6 * DAY);
  const rows = await prisma.shiftAssignment.findMany({ where: { employeeId: { in: employeeIds }, date: { gte: weekStart, lte: end } } });
  if (rows.length === 0) return { ok: false, message: "That week has no rostered days to copy.", changed: 0 };
  return setRoster(tenantId, rows.map((r) => ({
    employeeId: r.employeeId, date: new Date(r.date.getTime() + 7 * DAY),
    value: r.weeklyOffCode === "WO" ? { kind: "OFF" as const } : { kind: "SHIFT" as const, shiftId: r.shiftId },
  })));
}
