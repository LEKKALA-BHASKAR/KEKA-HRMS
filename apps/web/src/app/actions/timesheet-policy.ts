"use server";

import { PERMISSIONS as P } from "@keka/rbac";
import { saveTimesheetPolicy, getTimesheetPolicy, opsChangeGate, snapshotOpsPolicy } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone as done, zNumber, zRequiredNumber, zBool, type ActionState } from "@/lib/forms";

/** Projects › Settings › Timesheets: limits, rounding, approval chain, auto-approval and reminders. */

const schema = z.object({
  minHoursPerDay: zNumber({ min: 0, max: 24 }), maxHoursPerDay: zRequiredNumber({ min: 0.25, max: 24 }),
  minHoursPerWeek: zNumber({ min: 0, max: 168 }), maxHoursPerWeek: zNumber({ min: 0, max: 168 }),
  incrementMinutes: zRequiredNumber({ min: 1, max: 60 }), rounding: z.enum(["REJECT", "NEAREST", "UP"]).default("REJECT"),
  approvalChain: z.enum(["EITHER", "LINE_MANAGER", "PROJECT_MANAGER", "LINE_THEN_PROJECT"]).default("EITHER"),
  autoApprove: zBool(), autoApproveMaxHours: zNumber({ min: 0, max: 168 }), flagWeeklyHoursAbove: zRequiredNumber({ min: 1, max: 168 }),
  remindersEnabled: zBool(), reminderAfterDays: zRequiredNumber({ min: 0, max: 30 }), escalationEnabled: zBool(), escalateAfterDays: zRequiredNumber({ min: 0, max: 60 }),
});

export async function saveTimesheetPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const parsed = parseForm(schema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  // A zero floor is no floor.
  const policy = { ...d, minHoursPerDay: d.minHoursPerDay || null, minHoursPerWeek: d.minHoursPerWeek || null, maxHoursPerWeek: d.maxHoursPerWeek || null, autoApproveMaxHours: d.autoApproveMaxHours || null };
  const gate = await opsChangeGate(viewer.tenantId, "WORK_HOUR_POLICY");
  if (gate) return { ok: false, message: gate };
  const before = await getTimesheetPolicy(viewer.tenantId);
  const res = await saveTimesheetPolicy(viewer.tenantId, policy);
  if (!res.ok) return { ok: false, message: res.message };
  await snapshotOpsPolicy(viewer.tenantId, "WORK_HOUR_POLICY", viewer.tenantId, res.message, viewer.user.id);
  await writeAudit(viewer, { module: "PROJECTS", action: "UPDATE", entityType: "TimesheetPolicy", entityId: viewer.tenantId, summary: res.message, oldValue: before, newValue: policy });
  return done(["/projects/settings/timesheets", "/projects"], res.message);
}
