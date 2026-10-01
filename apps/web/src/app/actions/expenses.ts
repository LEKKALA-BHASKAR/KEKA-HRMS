"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { createClaim, decideClaim, markClaimPaid, cancelClaim, submitDraftClaim, requestAdvance, advanceOp, requestTrip, tripOp } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zBool, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

async function reaches(viewer: Viewer, employeeId: string, permission: (typeof P)[keyof typeof P]) {
  const t = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  return !!t && canAccessEmployee(viewer, t, permission);
}

/** Lines arrive as categoryId_0, amount_0, receipt_0 …; receipts are stored first. */
export async function submitClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, message: "Give the claim a title.", errors: { title: "Required" } };
  const indexes = [...new Set([...formData.keys()].map((k) => /_(\d+)$/.exec(k)?.[1]).filter((x): x is string => !!x))].sort();
  const lines = [];
  for (const i of indexes) {
    const categoryId = String(formData.get(`categoryId_${i}`) ?? "");
    const amount = Number(formData.get(`amount_${i}`));
    const date = String(formData.get(`expenseDate_${i}`) ?? "");
    if (!categoryId && !amount) continue; // an empty row the user left behind
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: `Line ${Number(i) + 1}: enter the date.` };
    let receiptUrl: string | null = null;
    const file = formData.get(`receipt_${i}`);
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: `Line ${Number(i) + 1}: receipts are limited to 10 MB.` };
      const data = Buffer.from(await file.arrayBuffer());
      const sniff = sniffUpload(data, file.type);
      if (!sniff.ok) return { ok: false, message: `Line ${Number(i) + 1}: ${sniff.reason}` };
      const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name, mimeType: sniff.mimeType, data, relatedType: "ExpenseReceipt", employeeId: viewer.employee.id, uploadedBy: viewer.user.id });
      receiptUrl = `/files/${stored.id}`;
    }
    lines.push({ categoryId, amount, expenseDate: new Date(`${date}T00:00:00Z`), merchant: String(formData.get(`merchant_${i}`) ?? "") || null, description: String(formData.get(`description_${i}`) ?? "") || null, receiptUrl });
  }
  try {
    const res = await createClaim({
      employeeId: viewer.employee.id, title, lines, advanceId: String(formData.get("advanceId") ?? "") || null,
      payViaPayroll: true, submit: formData.get("intent") !== "draft",
    });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "ExpenseClaim", entityId: res.claimId, summary: res.message });
    return done(["/expenses", "/me/expenses", "/inbox"], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function decideClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const claimId = String(formData.get("claimId"));
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, tenantId: viewer.tenantId } });
  if (!claim) return { ok: false, message: "Claim not found." };
  if (claim.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot approve your own claim." };
  const level = claim.stage === "PARTIALLY_APPROVED" ? "FINANCE" : "MANAGER";
  const allowed = level === "FINANCE"
    ? can(viewer, P.EXPENSE_MANAGE) && (await reaches(viewer, claim.employeeId, P.EXPENSE_MANAGE))
    : can(viewer, P.EXPENSE_APPROVE) && (await reaches(viewer, claim.employeeId, P.EXPENSE_APPROVE));
  if (!allowed) return { ok: false, message: level === "FINANCE" ? "This claim is waiting for finance." : "This claim is outside the people you approve for." };
  const lineAmounts: Record<string, number> = {};
  for (const [k, v] of formData.entries()) if (k.startsWith("approved_") && String(v) !== "") lineAmounts[k.slice("approved_".length)] = Number(v);
  const res = await decideClaim({ claimId, level, approve: formData.get("decision") === "approve", byUserId: viewer.user.id, lineAmounts, reason: String(formData.get("reason") ?? "") || null });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: formData.get("decision") === "approve" ? "APPROVE" : "REJECT", entityType: "ExpenseClaim", entityId: claimId, summary: `${claim.claimNumber}: ${res.message}` });
  return res.ok ? done(["/expenses", "/me/expenses", `/expenses/${claimId}`, "/inbox"], res.message) : { ok: false, message: res.message };
}

export async function claimOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const claimId = String(formData.get("claimId"));
  const op = String(formData.get("op"));
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, tenantId: viewer.tenantId } });
  if (!claim) return { ok: false, message: "Claim not found." };
  let res: { ok: boolean; message: string };
  if (op === "cancel") res = await cancelClaim(claimId, viewer.employee?.id ?? "");
  else if (op === "submit") res = await submitDraftClaim(claimId, viewer.employee?.id ?? "");
  else if (op === "paid") {
    if (!can(viewer, P.EXPENSE_MANAGE)) return { ok: false, message: "Only finance can mark claims paid." };
    res = await markClaimPaid(claimId);
  } else return { ok: false, message: "Unknown action." };
  return res.ok ? done(["/expenses", "/me/expenses", `/expenses/${claimId}`], res.message) : { ok: false, message: res.message };
}

const advanceSchema = z.object({ amount: zRequiredNumber({ min: 100, max: 1000000 }), purpose: zName(300), neededBy: zDate() });

export async function requestAdvanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(advanceSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await requestAdvance({ employeeId: viewer.employee.id, ...parsed.data });
  return res.ok ? done(["/expenses", "/me/expenses"], res.message) : { ok: false, message: res.message };
}

export async function advanceOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("advanceId"));
  const op = String(formData.get("op")) as "approve" | "reject" | "disburse" | "recover";
  const adv = await prisma.cashAdvance.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!adv) return { ok: false, message: "Advance not found." };
  if (adv.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot act on your own advance." };
  const perm = op === "approve" || op === "reject" ? P.ADVANCE_APPROVE : P.EXPENSE_MANAGE;
  if (!can(viewer, perm) || !(await reaches(viewer, adv.employeeId, perm))) return { ok: false, message: "You cannot do that." };
  const res = await advanceOp(id, op, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: op === "approve" ? "APPROVE" : "UPDATE", entityType: "CashAdvance", entityId: id, summary: `${op}: ${res.message}` });
  return res.ok ? done(["/expenses", "/me/expenses"], res.message) : { ok: false, message: res.message };
}

const tripSchema = z.object({
  purpose: zName(300), fromCity: zName(60), toCity: zName(60), departDate: zRequiredDate(), returnDate: zDate(),
  travelType: z.enum(["DOMESTIC", "INTERNATIONAL"]), needsAccommodation: zBool(), estimatedCost: zNumber({ min: 0 }),
});

export async function requestTripAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(tripSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await requestTrip({ employeeId: viewer.employee.id, ...parsed.data });
  return res.ok ? done(["/expenses", "/me/expenses"], res.message) : { ok: false, message: res.message };
}

export async function tripOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("tripId"));
  const op = String(formData.get("op")) as "approve" | "reject" | "book" | "complete" | "cancel";
  const trip = await prisma.travelRequest.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!trip) return { ok: false, message: "Trip not found." };
  const own = trip.employeeId === viewer.employee?.id;
  if (op === "approve" || op === "reject") {
    if (own) return { ok: false, message: "You cannot approve your own trip." };
    if (!(await reaches(viewer, trip.employeeId, P.EXPENSE_APPROVE))) return { ok: false, message: "This trip is outside the people you approve for." };
  } else if (op === "book") {
    if (!can(viewer, P.TRAVEL_MANAGE)) return { ok: false, message: "Only the travel desk books trips." };
  } else if (!own && !can(viewer, P.TRAVEL_MANAGE)) return { ok: false, message: "You cannot change this trip." };
  const cost = Number(formData.get("actualCost"));
  const res = await tripOp(id, op, viewer.user.id, { reason: String(formData.get("reason") ?? "") || null, bookingRef: String(formData.get("bookingRef") ?? "") || null, actualCost: Number.isFinite(cost) && cost > 0 ? cost : null });
  return res.ok ? done(["/expenses", "/me/expenses"], res.message) : { ok: false, message: res.message };
}

const categorySchema = z.object({ id: zOptionalId(), name: zName(60), maxAmount: zNumber({ min: 0 }), receiptRequiredAbove: zNumber({ min: 0 }), description: zOptional(200) });

export async function saveExpenseCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const parsed = parseForm(categorySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    if (id) await prisma.expenseCategory.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
    else await prisma.expenseCategory.create({ data: { ...d, tenantId: viewer.tenantId } });
    return done(["/expenses", "/me/expenses"], `Saved ${d.name}.`);
  } catch (err) { return toErrorState(err); }
}
