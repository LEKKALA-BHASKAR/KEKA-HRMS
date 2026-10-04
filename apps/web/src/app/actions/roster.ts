"use server";

import { z } from "zod";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { setRoster, applyRosterPattern, copyRosterWeek, rosterDate, notify, type RosterValue } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { actionDone as done, parseForm, writeAudit, toErrorState, zId, zName, zOptionalId, type ActionState } from "@/lib/forms";

/**
 * Shift rostering from Attendance > Roster: edit a week's grid, lay a
 * rotating pattern over a team, copy a week forward, and manage patterns.
 * Everyone touched must be inside the viewer's shift-management scope.
 */

async function inScope(viewer: Awaited<ReturnType<typeof requireAuth>>, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const n = await prisma.employee.count({ where: { AND: [scopedEmployeeWhere(viewer, P.SHIFT_MANAGE), { id: { in: ids } }] } });
  return n === new Set(ids).size;
}

/** Grid cells arrive as cell:<employeeId>:<YYYY-MM-DD> = "" (policy) | "OFF" | <shiftId>. */
export async function saveRosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const writes: { employeeId: string; date: Date; value: RosterValue }[] = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("cell:")) continue;
    const [, employeeId, d] = k.split(":");
    const date = rosterDate(d ?? "");
    if (!employeeId || !date) return { ok: false, message: "A roster cell was malformed. Reload and try again." };
    const val = String(v);
    writes.push({ employeeId, date, value: val === "" ? { kind: "DEFAULT" } : val === "OFF" ? { kind: "OFF" } : { kind: "SHIFT", shiftId: val } });
  }
  if (!(await inScope(viewer, writes.map((w) => w.employeeId)))) return { ok: false, message: "You can only roster people you manage shifts for." };
  try {
    const res = await setRoster(viewer.tenantId, writes);
    if (!res.ok) return { ok: false, message: res.message };
    if (res.changed) {
      await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftAssignment", entityId: null, summary: res.message });
      // Shift change notifications: tell people whose upcoming days changed.
      const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      const upcoming = [...new Set(writes.filter((w) => w.date >= today).map((w) => w.employeeId))];
      if (upcoming.length) {
        const users = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: upcoming } }, select: { userId: true } });
        await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "ATTENDANCE", title: "Your roster has changed", body: "Check your upcoming shifts.", link: "/me/shifts" });
      }
    }
    return done(["/attendance/roster", "/me/shifts"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

const applySchema = z.object({
  patternId: zId(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  startStep: z.coerce.number().int().min(1).max(366).default(1),
  staggerBy: z.coerce.number().int().min(0).max(366).default(0),
});

export async function applyPatternAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const parsed = parseForm(applySchema, formData);
  if (parsed.state) return parsed.state;
  const employeeIds = formData.getAll("employeeIds").map(String).filter(Boolean);
  if (employeeIds.length === 0) return { ok: false, message: "Pick at least one employee.", errors: { employeeIds: "Required" } };
  if (!(await inScope(viewer, employeeIds))) return { ok: false, message: "You can only roster people you manage shifts for." };
  const from = rosterDate(parsed.data.from), to = rosterDate(parsed.data.to);
  if (!from || !to) return { ok: false, message: "Pick valid dates." };
  const res = await applyRosterPattern({ tenantId: viewer.tenantId, patternId: parsed.data.patternId, employeeIds, from, to, startStep: parsed.data.startStep - 1, staggerBy: parsed.data.staggerBy });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "RosterPattern", entityId: parsed.data.patternId, summary: res.message });
  return done(["/attendance/roster"], res.message);
}

export async function copyWeekAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const week = rosterDate(String(formData.get("week") ?? ""));
  if (!week) return { ok: false, message: "Pick a week." };
  const employeeIds = formData.getAll("employeeIds").map(String).filter(Boolean);
  if (!(await inScope(viewer, employeeIds))) return { ok: false, message: "You can only roster people you manage shifts for." };
  const res = await copyRosterWeek(viewer.tenantId, employeeIds, week);
  if (!res.ok) return { ok: false, message: res.message };
  return done(["/attendance/roster"], `Copied to the next week. ${res.message}`);
}

const patternSchema = z.object({ id: zOptionalId(), name: zName(80) });

/** Steps arrive as step0..stepN = <shiftId> | "OFF" | "" (unused). */
export async function savePatternAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const parsed = parseForm(patternSchema, formData);
  if (parsed.state) return parsed.state;
  const raw = [...formData.entries()].filter(([k]) => /^step\d+$/.test(k)).sort((a, b) => Number(a[0].slice(4)) - Number(b[0].slice(4))).map(([, v]) => String(v));
  while (raw.length && raw[raw.length - 1] === "") raw.pop();
  if (raw.length === 0) return { ok: false, message: "A pattern needs at least one day." };
  if (raw.includes("")) return { ok: false, message: "Fill every day up to the last one, or clear the trailing days." };
  const shiftIds = [...new Set(raw.filter((v) => v !== "OFF"))];
  const n = await prisma.shift.count({ where: { id: { in: shiftIds }, tenantId: viewer.tenantId, isActive: true } });
  if (n !== shiftIds.length) return { ok: false, message: "One of those shifts was not found." };
  const steps = raw.map((v) => (v === "OFF" ? { shiftId: null, off: true } : { shiftId: v, off: false }));
  try {
    if (parsed.data.id) {
      const u = await prisma.rosterPattern.updateMany({ where: { id: parsed.data.id, tenantId: viewer.tenantId }, data: { name: parsed.data.name, steps } });
      if (u.count === 0) return { ok: false, message: "Pattern not found." };
    } else {
      await prisma.rosterPattern.create({ data: { tenantId: viewer.tenantId, name: parsed.data.name, steps } });
    }
    return done(["/attendance/roster"], `Saved ${parsed.data.name} (${steps.length}-day cycle).`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deletePatternAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const id = String(formData.get("id") ?? "");
  const d = await prisma.rosterPattern.deleteMany({ where: { id, tenantId: viewer.tenantId } });
  if (d.count === 0) return { ok: false, message: "Pattern not found." };
  return done(["/attendance/roster"], "Pattern deleted. Days it already rostered stay as they are.");
}
