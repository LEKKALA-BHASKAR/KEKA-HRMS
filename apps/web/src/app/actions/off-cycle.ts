"use server";

import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import {
  addOffCycleItem, finalizeOffCycleRun, releasePayslipsForRun, removeOffCycleItem, rollbackOffCycleRun, startOffCycleRun, toggleOffCycleBonus,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { actionDone as done, parseForm, writeAudit, z, zId, zName, zRequiredNumber, zBool, zOptional, type ActionState } from "@/lib/forms";

/** Off-cycle payroll: start, add to, finalise, release and roll back. */

const audit = (viewer: Viewer, action: "CREATE" | "UPDATE" | "LOCK" | "UNLOCK" | "DELETE", runId: string, summary: string) =>
  writeAudit(viewer, { module: "PAYROLL", action, entityType: "PayrollRun", entityId: runId, summary });

const startSchema = z.object({ baseRunId: zId(), reason: zName(200), payDate: zOptional(10) });

export async function startOffCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(startSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const employeeIds = formData.getAll("employeeIds").map(String).filter(Boolean);
  const res = await startOffCycleRun({ tenantId: viewer.tenantId, baseRunId: d.baseRunId, employeeIds, reason: d.reason, payDate: d.payDate ? new Date(`${d.payDate}T00:00:00Z`) : null });
  if (!res.ok) return { ok: false, message: res.message };
  await audit(viewer, "CREATE", res.runId!, res.message);
  redirect(`/payroll/runs/${res.runId}`);
}

const itemSchema = z.object({ runId: zId(), employeeId: zId(), type: z.enum(["PAYMENT", "DEDUCTION"]), name: zName(80), amount: zRequiredNumber({ min: 1, max: 100_000_000 }), taxable: zBool() });

export async function addOffCycleItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(itemSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const res = await addOffCycleItem({ ...d, tenantId: viewer.tenantId, byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", d.runId, res.message);
  return done([`/payroll/runs/${d.runId}`], res.message);
}

export async function removeOffCycleItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId") ?? ""), itemId = String(formData.get("itemId") ?? "");
  const res = await removeOffCycleItem({ runId, tenantId: viewer.tenantId, itemId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", runId, "Removed an off-cycle item");
  return done([`/payroll/runs/${runId}`], res.message);
}

export async function toggleOffCycleBonusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = String(formData.get("runId") ?? ""), bonusId = String(formData.get("bonusId") ?? "");
  const res = await toggleOffCycleBonus({ runId, tenantId: viewer.tenantId, bonusId, include: formData.get("include") === "1" });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", runId, res.message);
  return done([`/payroll/runs/${runId}`, "/payroll/bonuses"], res.message);
}

export async function finalizeOffCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId") ?? "");
  const res = await finalizeOffCycleRun(runId, viewer.tenantId, viewer.userId);
  if (!res.ok) return res;
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  await audit(viewer, "LOCK", runId, `Finalised off-cycle payroll ${run.sequence} for ${formatPeriod(run.year, run.month)}`);
  return done([`/payroll/runs/${runId}`, "/payroll/runs"], res.message);
}

export async function releaseOffCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYSLIP_RELEASE);
  const runId = String(formData.get("runId") ?? "");
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId, type: "OFF_CYCLE", status: "FINALIZED" } });
  if (!run) return { ok: false, message: "Finalise the off-cycle payroll first." };
  const res = await releasePayslipsForRun(runId, viewer.userId);
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", runId, res.message);
  return done([`/payroll/runs/${runId}`, "/finances/pay/payslips"], res.message);
}

export async function rollbackOffCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_ROLLBACK);
  const runId = String(formData.get("runId") ?? "");
  const res = await rollbackOffCycleRun(runId, viewer.tenantId, String(formData.get("reason") ?? ""));
  if (!res.ok) return res;
  await audit(viewer, "UNLOCK", runId, `Rolled back off-cycle payroll: ${res.message}`);
  return done([`/payroll/runs/${runId}`, "/payroll/runs"], res.message);
}
