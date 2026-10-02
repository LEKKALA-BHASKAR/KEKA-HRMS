"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  holdSalary, releaseHold, undoRelease, createPaymentBatch, markPaymentItems, deletePaymentBatch,
  setBankAccountVerified, setPayslipRelease, recordTdsChallan, deleteTdsChallan,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { scopedEmployeeIds } from "@/lib/scope";
import { actionDone as done, parseForm, writeAudit, z, zId, zOptional, zRequiredNumber, zNumber, zRequiredDate, type ActionState } from "@/lib/forms";

/**
 * Payouts of a finalised run (holds, payment batches, bank verification,
 * payslip release) and salary TDS challans.
 */

const runPaths = (runId: string) => [`/payroll/runs/${runId}`, `/payroll/runs/${runId}/payouts`];
const audit = (viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, entityId: string, summary: string) =>
  writeAudit(viewer, { module: "PAYROLL", action, entityType, entityId, summary });

/** A scoped payroll admin acts only on the people they reach. */
async function reaches(viewer: Viewer, employeeId: string): Promise<boolean> {
  const ids = await scopedEmployeeIds(viewer, P.PAYROLL_RUN);
  return ids === null || ids.includes(employeeId);
}

const holdSchema = z.object({ runId: zId(), employeeId: zId(), reason: zOptional(200) });

export async function holdSalaryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(holdSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await reaches(viewer, d.employeeId))) return { ok: false, message: "That employee is outside your scope." };
  const res = await holdSalary({ tenantId: viewer.tenantId, runId: d.runId, employeeId: d.employeeId, reason: d.reason ?? "", byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "PayrollRun", d.runId, `Held salary payout: ${res.message}`);
  return done(runPaths(d.runId), res.message);
}

const releaseSchema = z.object({ holdId: zId(), targetRunId: zId(), note: zOptional(200) });

export async function releaseHoldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(releaseSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const hold = await prisma.salaryHold.findFirst({ where: { id: d.holdId, tenantId: viewer.tenantId } });
  if (!hold || !(await reaches(viewer, hold.employeeId))) return { ok: false, message: "Hold not found." };
  const res = await releaseHold({ tenantId: viewer.tenantId, holdId: d.holdId, targetRunId: d.targetRunId, note: d.note, byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "SalaryHold", d.holdId, res.message);
  return done([...runPaths(hold.runId), ...runPaths(d.targetRunId)], res.message);
}

export async function undoReleaseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const holdId = String(formData.get("holdId") ?? "");
  const hold = await prisma.salaryHold.findFirst({ where: { id: holdId, tenantId: viewer.tenantId } });
  if (!hold || !(await reaches(viewer, hold.employeeId))) return { ok: false, message: "Hold not found." };
  const res = await undoRelease({ tenantId: viewer.tenantId, holdId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "SalaryHold", holdId, "Put a released salary back on hold");
  return done([...runPaths(hold.runId), ...(hold.releaseRunId ? runPaths(hold.releaseRunId) : [])], res.message);
}

// --- Payment batches -------------------------------------------------------

export async function createBatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const runId = String(formData.get("runId") ?? "");
  const mode = formData.get("mode") === "FAILED" ? "FAILED" : "UNBATCHED";
  const picked = formData.getAll("employeeIds").map(String).filter(Boolean);
  const scope = await scopedEmployeeIds(viewer, P.PAYROLL_RUN);
  // A scoped admin batches only their own people.
  const employeeIds = scope === null ? (picked.length ? picked : undefined) : (picked.length ? picked : scope).filter((id) => scope.includes(id));
  if (employeeIds && employeeIds.length === 0) return { ok: false, message: "Nobody in your scope to batch." };
  const res = await createPaymentBatch({ tenantId: viewer.tenantId, runId, mode, employeeIds, note: String(formData.get("note") ?? "") || null, byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "CREATE", "PaymentBatch", res.batchId!, res.message);
  return done(runPaths(runId), res.message);
}

export async function markItemsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const batchId = String(formData.get("batchId") ?? "");
  const status = formData.get("status") === "FAILED" ? "FAILED" : "PAID";
  const itemIds = formData.getAll("itemIds").map(String).filter(Boolean);
  if (itemIds.length === 0) return { ok: false, message: "Tick the transfers to mark." };
  const batch = await prisma.paymentBatch.findFirst({ where: { id: batchId, tenantId: viewer.tenantId } });
  if (!batch) return { ok: false, message: "Batch not found." };
  const res = await markPaymentItems({
    tenantId: viewer.tenantId, batchId, itemIds, status, byUserId: viewer.userId,
    reference: String(formData.get("reference") ?? "") || null, failureReason: String(formData.get("failureReason") ?? "") || null,
  });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "PaymentBatch", batchId, `Batch ${batch.number}: ${res.message}`);
  return done(runPaths(batch.runId), res.message);
}

export async function deleteBatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const batchId = String(formData.get("batchId") ?? "");
  const batch = await prisma.paymentBatch.findFirst({ where: { id: batchId, tenantId: viewer.tenantId } });
  if (!batch) return { ok: false, message: "Batch not found." };
  const res = await deletePaymentBatch({ tenantId: viewer.tenantId, batchId });
  if (!res.ok) return res;
  await audit(viewer, "DELETE", "PaymentBatch", batchId, res.message);
  return done(runPaths(batch.runId), res.message);
}

export async function verifyBankAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_LOCK);
  const accountId = String(formData.get("accountId") ?? "");
  const verified = formData.get("verified") !== "0";
  const acct = await prisma.employeeBankAccount.findFirst({ where: { id: accountId, employee: { tenantId: viewer.tenantId } } });
  if (!acct || !(await reaches(viewer, acct.employeeId))) return { ok: false, message: "Bank account not found." };
  const res = await setBankAccountVerified({ tenantId: viewer.tenantId, accountId, verified, byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "EmployeeBankAccount", accountId, res.message);
  const runId = String(formData.get("runId") ?? "");
  return done([...(runId ? runPaths(runId) : []), `/employees/${acct.employeeId}`], res.message);
}

// --- Payslips ----------------------------------------------------------------

export async function payslipReleaseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYSLIP_RELEASE);
  const runId = String(formData.get("runId") ?? ""), employeeId = String(formData.get("employeeId") ?? "");
  const release = formData.get("release") !== "0";
  if (!(await reaches(viewer, employeeId))) return { ok: false, message: "That employee is outside your scope." };
  const res = await setPayslipRelease({ tenantId: viewer.tenantId, runId, employeeId, release, byUserId: viewer.userId });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "Payslip", `${runId}:${employeeId}`, res.message);
  return done([...runPaths(runId), "/finances/pay/payslips"], res.message);
}

// --- TDS challans --------------------------------------------------------------

const challanSchema = z.object({
  payGroupId: zOptional(40),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Choose the salary month"),
  bsrCode: z.string().trim().regex(/^\d{7}$/, "7 digits"),
  challanNumber: z.string().trim().regex(/^\d{1,5}$/, "Up to 5 digits"),
  paymentDate: zRequiredDate(),
  tdsAmount: zRequiredNumber({ min: 1, max: 1_000_000_000 }),
  surcharge: zNumber({ min: 0 }), cess: zNumber({ min: 0 }), interest: zNumber({ min: 0 }), fee: zNumber({ min: 0 }),
});

export async function recordChallanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const parsed = parseForm(challanSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const [year, month] = d.period.split("-").map(Number);
  const res = await recordTdsChallan({
    tenantId: viewer.tenantId, payGroupId: d.payGroupId || null, year, month, bsrCode: d.bsrCode, challanNumber: d.challanNumber, paymentDate: d.paymentDate,
    tdsAmount: d.tdsAmount, surcharge: d.surcharge ?? 0, cess: d.cess ?? 0, interest: d.interest ?? 0, fee: d.fee ?? 0, byUserId: viewer.userId,
  });
  if (!res.ok) return res;
  await audit(viewer, "CREATE", "TdsChallan", res.id!, `Recorded TDS challan ${d.challanNumber} (BSR ${d.bsrCode}) for ${month}/${year}: ₹${d.tdsAmount}`);
  return done(["/payroll/filings", "/payroll/filings/24q"], res.message);
}

export async function deleteChallanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const id = String(formData.get("id") ?? "");
  const res = await deleteTdsChallan(viewer.tenantId, id);
  if (!res.ok) return res;
  await audit(viewer, "DELETE", "TdsChallan", id, "Removed a TDS challan");
  return done(["/payroll/filings", "/payroll/filings/24q"], res.message);
}
