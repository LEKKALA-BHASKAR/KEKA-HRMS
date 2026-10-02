"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  voidSettlement, setSettlementMonth, fnfStatementPdf, queueFnfStatementEmail,
  addFnfAdjustment, attachFnfAdjustment, removeFnfAdjustment, parsePeriod, FNF_ADJUSTMENT_SOURCE,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import { toErrorState, writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Full and final beyond draft and finalise: the settlement month, voiding,
 * emailing the statement, and adjustments after the settlement.
 */

const P = PERMISSIONS;
type Perm = (typeof P)[keyof typeof P];

async function reaches(viewer: Viewer, employeeId: string, permission: Perm): Promise<boolean> {
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

async function pathsFor(employeeId: string): Promise<string[]> {
  const exit = await prisma.exitRecord.findUnique({ where: { employeeId }, select: { id: true } });
  return ["/exits", "/exits/settlements", ...(exit ? [`/exits/${exit.id}`] : [])];
}

export async function setSettlementMonthAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!(await reaches(viewer, employeeId, P.FNF_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  const period = parsePeriod(String(formData.get("period") ?? ""));
  if (!period) return { ok: false, message: "Choose a settlement month.", errors: { period: "Required" } };
  const res = await setSettlementMonth({ employeeId, tenantId: viewer.tenantId, ...period });
  if (!res.ok) return { ok: false, message: res.message, errors: { period: res.message } };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "FnfSettlement", entityId: employeeId, summary: res.message });
  return done(await pathsFor(employeeId), res.message);
}

export async function voidSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_APPROVE);
  const employeeId = String(formData.get("employeeId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (employeeId === viewer.employee?.id) return { ok: false, message: "You cannot void your own settlement." };
  if (!(await reaches(viewer, employeeId, P.FNF_APPROVE))) return { ok: false, message: "This employee is outside your scope." };
  try {
    const res = await voidSettlement({ employeeId, tenantId: viewer.tenantId, byUserId: viewer.user.id, reason });
    if (!res.ok) return { ok: false, message: res.message, errors: /why/.test(res.message) ? { reason: res.message } : undefined };
    await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "FnfSettlement", entityId: employeeId, summary: `Voided settlement: ${reason.trim()}. ${res.message}` });
    return done([...(await pathsFor(employeeId)), "/employees"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

/** Generate the statement PDF, keep a copy on file, and email it to the employee. */
export async function emailFnfStatementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!(await reaches(viewer, employeeId, P.FNF_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  try {
    const st = await fnfStatementPdf(employeeId, viewer.tenantId);
    if (st.status === "VOIDED") return { ok: false, message: "A voided settlement is not sent. Draft and finalise a fresh one." };
    if (!["FINALIZED", "PAID", "ALREADY_PAID"].includes(st.status)) return { ok: false, message: "Only a finalised settlement is emailed; download the draft to review it." };
    const to = String(formData.get("to") ?? "").trim() || st.email;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, message: "There is no email address for this employee. Enter one.", errors: { to: "Required" } };
    const stored = await saveFile({ tenantId: viewer.tenantId, filename: st.filename, mimeType: st.mimeType, data: st.content, relatedType: "FnfStatement", relatedId: st.settlementId, employeeId, uploadedBy: viewer.user.id });
    await queueFnfStatementEmail({ tenantId: viewer.tenantId, settlementId: st.settlementId, to, employeeName: st.data.employee.name, period: st.data.settlementPeriod, fileId: stored.id, net: st.data.net });
    await writeAudit(viewer, { module: "PAYROLL", action: "EXPORT", entityType: "FnfSettlement", entityId: st.settlementId, summary: `Emailed the F&F statement to ${to}` });
    return done(await pathsFor(employeeId), `Statement queued to ${to}, with the PDF attached.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function addFnfAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!(await reaches(viewer, employeeId, P.FNF_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  const type = String(formData.get("type") ?? "") as "PAYMENT" | "DEDUCTION";
  const name = String(formData.get("name") ?? "");
  const amount = Number(formData.get("amount"));
  const target = String(formData.get("target") ?? "");
  const period = target.startsWith("month:") ? parsePeriod(target.slice(6)) : null;
  const runId = target.startsWith("run:") ? target.slice(4) : null;
  if (!period && !runId) return { ok: false, message: "Choose the payroll that pays it.", errors: { target: "Required" } };
  try {
    const res = await addFnfAdjustment({
      employeeId, tenantId: viewer.tenantId, byUserId: viewer.user.id, type, name, amount,
      taxable: formData.get("taxable") === "on", comment: String(formData.get("comment") ?? "") || null,
      runId, year: period?.year, month: period?.month,
    });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "AdhocTransaction", entityId: res.adjustmentId, summary: `F&F adjustment: ${res.message}` });
    return done([...(await pathsFor(employeeId)), ...(runId ? [`/payroll/runs/${runId}`] : [])], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

async function adjustmentEmployee(viewer: Viewer, adjustmentId: string): Promise<string | null> {
  const a = await prisma.adhocTransaction.findFirst({ where: { id: adjustmentId, sourceType: FNF_ADJUSTMENT_SOURCE, employee: { tenantId: viewer.tenantId } }, select: { employeeId: true } });
  return a && (await reaches(viewer, a.employeeId, P.FNF_MANAGE)) ? a.employeeId : null;
}

export async function attachFnfAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const adjustmentId = String(formData.get("adjustmentId") ?? "");
  const runId = String(formData.get("runId") ?? "");
  const employeeId = await adjustmentEmployee(viewer, adjustmentId);
  if (!employeeId) return { ok: false, message: "Adjustment not found." };
  if (!runId) return { ok: false, message: "Choose a payroll." };
  const res = await attachFnfAdjustment({ adjustmentId, tenantId: viewer.tenantId, runId });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "AdhocTransaction", entityId: adjustmentId, summary: `F&F adjustment moved to a payroll: ${res.message}` });
  return done([...(await pathsFor(employeeId)), `/payroll/runs/${runId}`], res.message);
}

export async function removeFnfAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const adjustmentId = String(formData.get("adjustmentId") ?? "");
  const employeeId = await adjustmentEmployee(viewer, adjustmentId);
  if (!employeeId) return { ok: false, message: "Adjustment not found." };
  const res = await removeFnfAdjustment({ adjustmentId, tenantId: viewer.tenantId });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "DELETE", entityType: "AdhocTransaction", entityId: adjustmentId, summary: "Removed an F&F adjustment" });
  return done(await pathsFor(employeeId), res.message);
}
