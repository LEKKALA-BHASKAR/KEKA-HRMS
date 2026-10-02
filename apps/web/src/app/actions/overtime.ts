"use server";

import { z } from "zod";
import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee } from "@keka/rbac";
import { addOvertimeEntry, decideOvertimeEntry, setOvertimeRate, type OvertimeAction } from "@keka/services";
import { requireViewer, canAny } from "@/lib/context";
import { actionDone as done, parseForm, writeAudit, zId, type ActionState } from "@/lib/forms";

/**
 * Overtime entries from Time > Overtime: add hours, set a rate, and decide
 * whether each entry is paid in the run, paid outside, or voided.
 */

const MANAGE = [P.ATTENDANCE_MANAGE, P.PAYROLL_RUN];

async function guard(entryId: string) {
  const viewer = await requireViewer();
  if (!canAny(viewer, MANAGE)) return { error: "You do not have access to overtime." } as const;
  const e = await prisma.overtimeEntry.findFirst({
    where: { id: entryId, tenantId: viewer.tenantId },
  });
  if (!e) return { error: "Overtime entry not found." } as const;
  const target = await prisma.employee.findUnique({ where: { id: e.employeeId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  if (!target || !MANAGE.some((p) => canAccessEmployee(viewer, target, p))) return { error: "That employee is outside your scope." } as const;
  return { viewer, entry: e } as const;
}

export async function decideOvertimeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const action = String(formData.get("action") ?? "") as OvertimeAction;
  if (!["PAY", "VOID", "PAID_OUTSIDE"].includes(action)) return { ok: false, message: "Pick what to do with it." };
  const g = await guard(String(formData.get("id") ?? ""));
  if ("error" in g) return { ok: false, message: g.error };
  const res = await decideOvertimeEntry(g.viewer.tenantId, g.entry.id, action);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(g.viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "OvertimeEntry", entityId: g.entry.id, summary: `Overtime ${Number(g.entry.hours)} hrs (${g.entry.month}/${g.entry.year}): ${res.message}` });
  return done(["/time/overtime"], res.message);
}

export async function setOvertimeRateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const g = await guard(String(formData.get("id") ?? ""));
  if ("error" in g) return { ok: false, message: g.error };
  const res = await setOvertimeRate(g.viewer.tenantId, g.entry.id, Number(formData.get("rate")));
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(g.viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "OvertimeEntry", entityId: g.entry.id, summary: res.message });
  return done(["/time/overtime"], res.message);
}

const addSchema = z.object({
  employeeId: zId(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Pick a month"),
  hours: z.coerce.number().positive("Enter hours").max(300),
  rate: z.string().optional().transform((v) => (v && v.trim() ? Number(v) : null)),
});

export async function addOvertimeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, MANAGE)) return { ok: false, message: "You do not have access to overtime." };
  const parsed = parseForm(addSchema, formData);
  if (parsed.state) return parsed.state;
  const target = await prisma.employee.findFirst({ where: { id: parsed.data.employeeId, tenantId: viewer.tenantId }, select: { id: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  if (!target || !MANAGE.some((p) => canAccessEmployee(viewer, target, p))) return { ok: false, message: "That employee is outside your scope." };
  const [year, month] = parsed.data.month.split("-").map(Number);
  const res = await addOvertimeEntry({ tenantId: viewer.tenantId, employeeId: target.id, year, month, hours: parsed.data.hours, rate: parsed.data.rate });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OvertimeEntry", entityId: res.id, summary: `Overtime for ${target.displayName}, ${month}/${year}: ${res.message}` });
  return done(["/time/overtime"], res.message);
}
