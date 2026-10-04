"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveExpensePolicy, createPolicyFromTemplate, reviseExpensePolicy, submitExpensePolicy, retireExpensePolicy,
  requestPreApproval, proposeExpenseRate, updateDraftClaim, replaceReceipt, receiptQuality,
  drawAuditSample, reviewAuditItem, closeAuditSample, delegateMoneyApprovals, EXPENSE_POLICY_TEMPLATES, MONEY_DELEGATION_TYPES,
  type DraftLineEdit,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { storeUpload } from "@/lib/money";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zBool, zId, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/expenses", "/expenses/policies", "/expenses/rates", "/expenses/audit", "/me/expenses", "/inbox", "/admin/workflows"];

// --- Policies ---------------------------------------------------------------

const policySchema = z.object({
  id: zOptionalId(), name: zName(80), description: zOptional(300),
  escalationAboveAmount: zNumber({ min: 0 }), allowFutureDated: zBool(), payrollCutoffDay: zNumber({ min: 1, max: 28 }),
  departmentId: zOptionalId(), locationId: zOptionalId(), bandId: zOptionalId(), isDefault: zBool(),
});

export async function saveExpensePolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const parsed = parseForm(policySchema, formData);
  if (parsed.state) return parsed.state;
  const caps: Record<string, number | null> = {};
  for (const [k, v] of formData.entries()) if (k.startsWith("cap_")) caps[k.slice(4)] = String(v).trim() === "" ? null : Number(v);
  if (Object.values(caps).some((c) => c !== null && !(c >= 0))) return { ok: false, message: "Caps are amounts of zero or more." };
  const cats = await prisma.expenseCategory.count({ where: { tenantId: viewer.tenantId, id: { in: Object.keys(caps) } } });
  if (cats !== Object.keys(caps).length) return { ok: false, message: "Unknown category." };
  try {
    const res = await saveExpensePolicy({ tenantId: viewer.tenantId, ...parsed.data, caps, actorUserId: viewer.user.id });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "FINANCE", action: parsed.data.id ? "UPDATE" : "CREATE", entityType: "ExpensePolicy", entityId: res.id, summary: `Saved expense policy ${parsed.data.name}`, newValue: { ...parsed.data, caps } });
    return done(PATHS, res.message);
  } catch (err) { return toErrorState(err); }
}

export async function expensePolicyTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const key = String(formData.get("templateKey") ?? "");
  if (!(key in EXPENSE_POLICY_TEMPLATES)) return { ok: false, message: "Pick a template." };
  const res = await createPolicyFromTemplate(viewer.tenantId, key, String(formData.get("name") ?? "").trim() || null, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "ExpensePolicy", entityId: res.id, summary: `Expense policy drafted from the ${key} template` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function expensePolicyOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const policy = await prisma.expensePolicy.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!policy) return { ok: false, message: "Policy not found." };
  const res = op === "submit" ? await submitExpensePolicy(viewer.tenantId, id, viewer.user.id, viewer.employee?.id ?? null)
    : op === "revise" ? await reviseExpensePolicy(viewer.tenantId, id, viewer.user.id)
    : op === "retire" ? await retireExpensePolicy(viewer.tenantId, id)
    : { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: op === "retire" ? "DELETE" : "UPDATE", entityType: "ExpensePolicy", entityId: id, summary: `${policy.name}: ${op} — ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Pre-approvals and rates ------------------------------------------------

const preSchema = z.object({ purpose: zName(300), categoryId: zOptionalId(), estimatedAmount: zRequiredNumber({ min: 1, max: 10_000_000 }), expectedDate: zDate() });

export async function requestPreApprovalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(preSchema, formData);
  if (parsed.state) return parsed.state;
  if (parsed.data.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: parsed.data.categoryId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Category not found." };
  const res = await requestPreApproval({ employeeId: viewer.employee.id, requesterUserId: viewer.user.id, ...parsed.data });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "ExpensePreApproval", entityId: res.id, summary: `Pre-approval requested: ${parsed.data.purpose} (₹${parsed.data.estimatedAmount})` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

const rateSchema = z.object({ kind: z.enum(["MILEAGE", "PER_DIEM"]), key: zName(30), amount: zRequiredNumber({ min: 0.01, max: 1_000_000 }), effectiveFrom: zRequiredDate(), note: zOptional(300) });

export async function proposeExpenseRateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const parsed = parseForm(rateSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await proposeExpenseRate({ tenantId: viewer.tenantId, ...parsed.data, actorUserId: viewer.user.id, employeeId: viewer.employee?.id ?? null });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "ExpenseRate", entityId: res.id, summary: `${parsed.data.kind === "MILEAGE" ? "Mileage" : "Per-diem"} rate ${parsed.data.key} ₹${parsed.data.amount} from ${parsed.data.effectiveFrom.toISOString().slice(0, 10)} proposed` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Claims and receipts ----------------------------------------------------

/** Edit a draft or returned claim: lines arrive as id_N, categoryId_N, expenseDate_N, amount_N, merchant_N, description_N, delete_N. */
export async function updateDraftClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const claimId = String(formData.get("claimId") ?? "");
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
  if (!claim) return { ok: false, message: "Claim not found." };
  const idx = [...new Set([...formData.keys()].map((k) => /^(?:id|categoryId|amount)_(\d+)$/.exec(k)?.[1]).filter((x): x is string => !!x))].sort();
  const lines: DraftLineEdit[] = [];
  for (const i of idx) {
    const categoryId = String(formData.get(`categoryId_${i}`) ?? "");
    const amount = Number(formData.get(`amount_${i}`));
    const date = String(formData.get(`expenseDate_${i}`) ?? "");
    const id = String(formData.get(`id_${i}`) ?? "") || null;
    if (!id && !categoryId && !amount) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: `Line ${Number(i) + 1}: enter the date.` };
    lines.push({ id, categoryId, amount, expenseDate: new Date(`${date}T00:00:00Z`), merchant: String(formData.get(`merchant_${i}`) ?? "") || null, description: String(formData.get(`description_${i}`) ?? "") || null, delete: formData.get(`delete_${i}`) === "on" });
  }
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, message: "Give the claim a title." };
  const res = await updateDraftClaim(claimId, viewer.employee.id, title, lines);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "ExpenseClaim", entityId: claimId, summary: `${claim.claimNumber} edited: ${res.message}`, newValue: { title, lines: lines.length } });
  return res.ok ? done([...PATHS, `/expenses/${claimId}`], res.message) : { ok: false, message: res.message };
}

export async function replaceReceiptAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const claimId = String(formData.get("claimId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
  if (!claim) return { ok: false, message: "Claim not found." };
  try {
    const up = await storeUpload(viewer, formData.get("receipt"), "ExpenseReceipt", viewer.employee.id);
    if (!up) return { ok: false, message: "Choose the receipt file." };
    const q = receiptQuality(up.data, up.mimeType);
    if (q.blocking) return { ok: false, message: q.issues.join(" ") };
    const res = await replaceReceipt(claimId, lineId, viewer.employee.id, up.url, q.issues.length ? q.issues.join(" ") : "OK");
    if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "ExpenseClaimLine", entityId: lineId, summary: `${claim.claimNumber}: receipt ${res.previous ? "replaced" : "added"}${q.issues.length ? ` (${q.issues.join(" ")})` : ""}`, oldValue: { receiptUrl: res.previous ?? null }, newValue: { receiptUrl: up.url } });
    return res.ok ? done([...PATHS, `/expenses/${claimId}`], q.issues.length ? `${res.message} Flagged: ${q.issues.join(" ")}` : res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

// --- Audit sampling ---------------------------------------------------------

const sampleSchema = z.object({ name: zName(80), from: zRequiredDate(), to: zRequiredDate(), ratePct: zRequiredNumber({ min: 1, max: 100 }), alwaysAbove: zNumber({ min: 0 }), seed: zNumber({ min: 0 }) });

export async function drawAuditSampleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const parsed = parseForm(sampleSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await drawAuditSample({ tenantId: viewer.tenantId, ...parsed.data, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "ExpenseAuditSample", entityId: res.id, summary: `Audit sample ${parsed.data.name}: ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

const reviewSchema = z.object({ itemId: zId(), outcome: z.enum(["OK", "ISSUE"]), finding: zOptional(500), recoverAmount: zNumber({ min: 0 }) });

export async function reviewAuditItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const parsed = parseForm(reviewSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await reviewAuditItem({ tenantId: viewer.tenantId, ...parsed.data, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "ExpenseAuditSampleItem", entityId: parsed.data.itemId, summary: `Audit review: ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function closeAuditSampleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXPENSE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const res = await closeAuditSample(viewer.tenantId, id);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "ExpenseAuditSample", entityId: id, summary: res.message });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Delegation -------------------------------------------------------------

const delegateSchema = z.object({ type: z.enum(["EXPENSE_CLAIM", "LOAN_REQUEST"]), delegateEmployeeId: zId(), startsOn: zRequiredDate(), endsOn: zRequiredDate(), reason: zOptional(300) });

/** An approver hands their expense-claim or loan approvals to a colleague for a period. */
export async function delegateMoneyApprovalsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(delegateSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.type === "EXPENSE_CLAIM" ? !can(viewer, P.EXPENSE_APPROVE) && !can(viewer, P.EXPENSE_MANAGE) && viewer.allReportIds.size === 0 : !can(viewer, P.LOAN_APPROVE)) return { ok: false, message: "You do not approve these, so there is nothing to delegate." };
  const delegate = await prisma.employee.findFirst({ where: { id: d.delegateEmployeeId, tenantId: viewer.tenantId, status: { not: "EXITED" } }, select: { userId: true, displayName: true } });
  if (!delegate?.userId) return { ok: false, message: "Pick a colleague with a login." };
  const res = await delegateMoneyApprovals({ tenantId: viewer.tenantId, delegatorUserId: viewer.user.id, delegateUserId: delegate.userId, type: d.type, startsOn: d.startsOn, endsOn: d.endsOn, reason: d.reason, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: d.type === "LOAN_REQUEST" ? "PAYROLL" : "FINANCE", action: "CREATE", entityType: "ApproverDelegation", summary: `${MONEY_DELEGATION_TYPES[d.type]} delegated to ${delegate.displayName} ${d.startsOn.toISOString().slice(0, 10)} – ${d.endsOn.toISOString().slice(0, 10)}` });
  return res.ok ? done([...PATHS, "/me/requests", "/payroll/loans"], res.message) : { ok: false, message: res.message };
}
