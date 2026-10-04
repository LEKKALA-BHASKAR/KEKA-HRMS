import { prisma, Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { startWorkflow } from "./workflow-engine";
import { moneyAudit } from "./money-audit";
import { EXPENSE_POLICY_TEMPLATES, rateOn, sampleForAudit, type ExpensePolicyTemplateKey } from "./money-math";

/**
 * Expense depth: policies with scope, templates and approval; pre-approvals;
 * mileage and per-diem rates; editing drafts and replacing receipts; audit
 * sampling; and the rows behind the reimbursement, receipt, project and
 * finance-export reports.
 */

type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
//  Policies
// ---------------------------------------------------------------------------

export interface ExpensePolicyInput {
  tenantId: string; id?: string | null; name: string; description?: string | null;
  escalationAboveAmount?: number | null; allowFutureDated: boolean; payrollCutoffDay?: number | null;
  departmentId?: string | null; locationId?: string | null; bandId?: string | null; isDefault: boolean;
  /** categoryId → cap (null clears the policy cap for that category). */
  caps?: Record<string, number | null>;
  actorUserId: string;
}

/** Create a draft policy, or change a draft. An active policy is changed by revising it. */
export async function saveExpensePolicy(input: ExpensePolicyInput): Promise<R & { id?: string }> {
  if (input.payrollCutoffDay !== null && input.payrollCutoffDay !== undefined && !(input.payrollCutoffDay >= 1 && input.payrollCutoffDay <= 28)) return { ok: false, message: "The cutoff day runs 1–28." };
  const data = {
    name: input.name.trim(), description: input.description ?? null, escalationAboveAmount: input.escalationAboveAmount ?? null,
    allowFutureDated: input.allowFutureDated, payrollCutoffDay: input.payrollCutoffDay ?? null,
    departmentId: input.departmentId || null, locationId: input.locationId || null, bandId: input.bandId || null, isDefault: input.isDefault,
  };
  if (await prisma.expensePolicy.findFirst({ where: { tenantId: input.tenantId, name: data.name, ...(input.id ? { id: { not: input.id } } : {}) } })) return { ok: false, message: "Another policy already has that name." };
  let id = input.id ?? null;
  if (id) {
    const p = await prisma.expensePolicy.findFirst({ where: { id, tenantId: input.tenantId } });
    if (!p) return { ok: false, message: "Policy not found." };
    if (p.status !== "DRAFT") return { ok: false, message: "Only a draft can be edited. Revise an active policy to change it." };
    await prisma.expensePolicy.update({ where: { id }, data });
  } else {
    id = (await prisma.expensePolicy.create({ data: { ...data, tenantId: input.tenantId, status: "DRAFT", isActive: false } })).id;
  }
  if (input.caps) await setPolicyCaps(input.tenantId, id, input.caps);
  return { ok: true, id, message: `Saved ${data.name} as a draft. Submit it for approval to put it in force.` };
}

async function setPolicyCaps(tenantId: string, policyId: string, caps: Record<string, number | null>) {
  const cats = await prisma.expenseCategory.findMany({ where: { tenantId, id: { in: Object.keys(caps) } }, select: { id: true } });
  for (const c of cats) {
    const v = caps[c.id];
    if (v === null || v === undefined) await prisma.expensePolicyCategory.deleteMany({ where: { policyId, categoryId: c.id } });
    else await prisma.expensePolicyCategory.upsert({ where: { policyId_categoryId: { policyId, categoryId: c.id } }, create: { policyId, categoryId: c.id, maxAmount: v }, update: { maxAmount: v } });
  }
}

/** A draft policy from a template; category caps are matched by name. */
export async function createPolicyFromTemplate(tenantId: string, key: string, name: string | null, actorUserId: string): Promise<R & { id?: string }> {
  if (!(key in EXPENSE_POLICY_TEMPLATES)) return { ok: false, message: "Unknown template." };
  const t = EXPENSE_POLICY_TEMPLATES[key as ExpensePolicyTemplateKey];
  const cats = await prisma.expenseCategory.findMany({ where: { tenantId, name: { in: Object.keys(t.caps) } }, select: { id: true, name: true } });
  const caps: Record<string, number> = {};
  for (const c of cats) caps[c.id] = (t.caps as Record<string, number>)[c.name]!;
  const res = await saveExpensePolicy({ tenantId, name: name?.trim() || t.name, description: t.description, escalationAboveAmount: t.escalationAboveAmount, allowFutureDated: t.allowFutureDated, payrollCutoffDay: t.payrollCutoffDay, isDefault: false, caps, actorUserId });
  if (res.ok && res.id) await prisma.expensePolicy.update({ where: { id: res.id }, data: { templateKey: key } });
  return res.ok ? { ...res, message: `Created ${name?.trim() || t.name} from the ${t.name} template with ${cats.length} category limit(s).` } : res;
}

/** A draft copy of an active policy; once approved it replaces the original. */
export async function reviseExpensePolicy(tenantId: string, id: string, actorUserId: string): Promise<R & { id?: string }> {
  const p = await prisma.expensePolicy.findFirst({ where: { id, tenantId }, include: { categories: true } });
  if (!p) return { ok: false, message: "Policy not found." };
  if (p.status !== "ACTIVE") return { ok: false, message: "Only an active policy is revised; edit the draft instead." };
  const open = await prisma.expensePolicy.findFirst({ where: { tenantId, supersedesId: id, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } });
  if (open) return { ok: false, message: `A revision (${open.name}) is already open.`, id: open.id };
  let name = `${p.name} (revision)`;
  for (let i = 2; await prisma.expensePolicy.findFirst({ where: { tenantId, name } }); i++) name = `${p.name} (revision ${i})`;
  const copy = await prisma.expensePolicy.create({
    data: {
      tenantId, name, description: p.description, baseCurrency: p.baseCurrency, allowFutureDated: p.allowFutureDated, advanceReceiptDays: p.advanceReceiptDays,
      approverRoleIds: p.approverRoleIds ?? undefined, escalationAboveAmount: p.escalationAboveAmount, isDefault: false, isActive: false, status: "DRAFT",
      departmentId: p.departmentId, locationId: p.locationId, bandId: p.bandId, payrollCutoffDay: p.payrollCutoffDay, templateKey: p.templateKey, supersedesId: p.id,
      categories: { create: p.categories.map((c) => ({ categoryId: c.categoryId, maxAmount: c.maxAmount })) },
    },
  });
  await moneyAudit(tenantId, actorUserId, { module: "FINANCE", action: "CREATE", entityType: "ExpensePolicy", entityId: copy.id, summary: `Opened a revision of ${p.name}` });
  return { ok: true, id: copy.id, message: `Opened ${name}. Edit it, then submit it for approval.` };
}

export async function submitExpensePolicy(tenantId: string, id: string, requesterUserId: string, employeeId: string | null): Promise<R> {
  const p = await prisma.expensePolicy.findFirst({ where: { id, tenantId } });
  if (!p) return { ok: false, message: "Policy not found." };
  if (p.status !== "DRAFT") return { ok: false, message: `This policy is ${p.status.toLowerCase().replace(/_/g, " ")}.` };
  await prisma.expensePolicy.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId, entityType: "EXPENSE_POLICY", entityId: id, title: `${p.supersedesId ? "Revise" : "Publish"} expense policy "${p.name}"`, details: p.description, amount: num(p.escalationAboveAmount), requesterUserId, subjectEmployeeId: employeeId });
  if (!wf.ok) { await prisma.expensePolicy.update({ where: { id }, data: { status: "DRAFT" } }); return wf; }
  await prisma.expensePolicy.update({ where: { id }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

export async function applyExpensePolicyDecision(tenantId: string, id: string, approved: boolean, actorUserId: string | null): Promise<void> {
  const p = await prisma.expensePolicy.findFirst({ where: { id, tenantId } });
  if (!p || p.status !== "PENDING_APPROVAL") return;
  if (!approved) { await prisma.expensePolicy.update({ where: { id }, data: { status: "DRAFT" } }); return; }
  await prisma.$transaction(async (tx) => {
    let isDefault = p.isDefault;
    if (p.supersedesId) {
      const old = await tx.expensePolicy.findFirst({ where: { id: p.supersedesId, tenantId } });
      if (old) {
        isDefault = isDefault || old.isDefault;
        await tx.expensePolicy.update({ where: { id: old.id }, data: { status: "RETIRED", isActive: false, isDefault: false } });
      }
    }
    if (isDefault) await tx.expensePolicy.updateMany({ where: { tenantId, id: { not: id } }, data: { isDefault: false } });
    await tx.expensePolicy.update({ where: { id }, data: { status: "ACTIVE", isActive: true, isDefault } });
  });
  await moneyAudit(tenantId, actorUserId, { module: "FINANCE", action: "APPROVE", entityType: "ExpensePolicy", entityId: id, summary: `Expense policy ${p.name} approved and in force` });
}

export async function retireExpensePolicy(tenantId: string, id: string): Promise<R> {
  const p = await prisma.expensePolicy.findFirst({ where: { id, tenantId } });
  if (!p || p.status !== "ACTIVE") return { ok: false, message: "Only an active policy can be retired." };
  const others = await prisma.expensePolicy.count({ where: { tenantId, status: "ACTIVE", id: { not: id } } });
  if (others === 0) return { ok: false, message: "This is the only active policy; publish another first." };
  await prisma.expensePolicy.update({ where: { id }, data: { status: "RETIRED", isActive: false, isDefault: false } });
  return { ok: true, message: `Retired ${p.name}.` };
}

// ---------------------------------------------------------------------------
//  Pre-approvals
// ---------------------------------------------------------------------------

export async function requestPreApproval(input: { employeeId: string; requesterUserId: string; purpose: string; categoryId?: string | null; estimatedAmount: number; expectedDate?: Date | null }): Promise<R & { id?: string }> {
  if (!(input.estimatedAmount > 0)) return { ok: false, message: "Enter the estimated amount." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, displayName: true } });
  if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, tenantId: emp.tenantId } }))) return { ok: false, message: "Category not found." };
  const pa = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${emp.tenantId} FOR UPDATE`;
    const n = await tx.expensePreApproval.count({ where: { tenantId: emp.tenantId } });
    return tx.expensePreApproval.create({ data: { tenantId: emp.tenantId, employeeId: input.employeeId, number: `PRE-${1001 + n}`, purpose: input.purpose, categoryId: input.categoryId || null, estimatedAmount: input.estimatedAmount, expectedDate: input.expectedDate ?? null } });
  });
  const wf = await startWorkflow({ tenantId: emp.tenantId, entityType: "EXPENSE_PREAPPROVAL", entityId: pa.id, title: `${pa.number}: ${emp.displayName} — ${input.purpose}`, amount: input.estimatedAmount, requesterUserId: input.requesterUserId, subjectEmployeeId: input.employeeId });
  if (!wf.ok) { await prisma.expensePreApproval.delete({ where: { id: pa.id } }); return wf; }
  await prisma.expensePreApproval.update({ where: { id: pa.id }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: pa.id, message: `${pa.number}: ${wf.message}` };
}

export async function applyPreApprovalDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN"): Promise<void> {
  await prisma.expensePreApproval.updateMany({ where: { id, tenantId, status: "PENDING" }, data: { status: outcome, decidedAt: new Date() } });
}

/** Check a pre-approval can back a claim, and mark it used. */
export async function usePreApproval(tenantId: string, id: string, employeeId: string, amount: number, tx: Prisma.TransactionClient = prisma): Promise<R> {
  const pa = await tx.expensePreApproval.findFirst({ where: { id, tenantId, employeeId } });
  if (!pa) return { ok: false, message: "That pre-approval is not yours." };
  if (pa.status !== "APPROVED") return { ok: false, message: `${pa.number} is ${pa.status.toLowerCase()}, not approved.` };
  await tx.expensePreApproval.update({ where: { id }, data: { status: "USED", usedAmount: amount } });
  const over = amount - Number(pa.estimatedAmount);
  return { ok: true, message: over > 0 ? `Claimed ₹${r2(over).toLocaleString("en-IN")} more than ${pa.number} approved.` : "" };
}

// ---------------------------------------------------------------------------
//  Mileage and per-diem rates
// ---------------------------------------------------------------------------

export const MILEAGE_VEHICLES = { CAR: "Car", TWO_WHEELER: "Two-wheeler", EV_CAR: "Electric car" } as const;
export const PER_DIEM_TIERS = { TIER_1: "Tier 1 city", TIER_2: "Tier 2 city", TIER_3: "Tier 3 / other", INTERNATIONAL: "International" } as const;

export async function proposeExpenseRate(input: { tenantId: string; kind: "MILEAGE" | "PER_DIEM"; key: string; amount: number; effectiveFrom: Date; note?: string | null; actorUserId: string; employeeId: string | null }): Promise<R & { id?: string }> {
  const keys = input.kind === "MILEAGE" ? MILEAGE_VEHICLES : PER_DIEM_TIERS;
  if (!(input.key in keys)) return { ok: false, message: "Pick what the rate is for." };
  if (!(input.amount > 0)) return { ok: false, message: "Enter the rate." };
  const row = await prisma.expenseRate.create({ data: { tenantId: input.tenantId, kind: input.kind, key: input.key, amount: input.amount, effectiveFrom: input.effectiveFrom, note: input.note ?? null, createdBy: input.actorUserId } });
  const label = `${input.kind === "MILEAGE" ? "Mileage" : "Per diem"} ${(keys as Record<string, string>)[input.key]}: ₹${input.amount}${input.kind === "MILEAGE" ? "/km" : "/day"} from ${input.effectiveFrom.toISOString().slice(0, 10)}`;
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "EXPENSE_RATE", entityId: row.id, title: label, details: input.note, amount: input.amount, requesterUserId: input.actorUserId, subjectEmployeeId: input.employeeId });
  if (!wf.ok) { await prisma.expenseRate.delete({ where: { id: row.id } }); return wf; }
  await prisma.expenseRate.update({ where: { id: row.id }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: row.id, message: `${label}. ${wf.message}` };
}

export async function applyExpenseRateDecision(tenantId: string, id: string, approved: boolean): Promise<void> {
  await prisma.expenseRate.updateMany({ where: { id, tenantId, status: "PENDING_APPROVAL" }, data: { status: approved ? "ACTIVE" : "REJECTED" } });
}

/** The approved rate for a key on a date. */
export async function expenseRateOn(tenantId: string, kind: "MILEAGE" | "PER_DIEM", key: string, on: Date): Promise<number | null> {
  const rows = await prisma.expenseRate.findMany({ where: { tenantId, kind, key, status: "ACTIVE" } });
  const r = rateOn(rows.map((x) => ({ ...x, amount: Number(x.amount) })), key, on);
  return r ? Number(r.amount) : null;
}

// ---------------------------------------------------------------------------
//  Drafts and receipts
// ---------------------------------------------------------------------------

/** Take a submitted claim nobody has decided back to draft, to edit it. */
export async function recallClaim(claimId: string, employeeId: string): Promise<R> {
  const u = await prisma.expenseClaim.updateMany({ where: { id: claimId, employeeId, stage: "SUBMITTED" }, data: { stage: "DRAFT", submittedAt: null } });
  return u.count ? { ok: true, message: "Back in draft — edit it and submit again." } : { ok: false, message: "Only your own submitted claim, before any approval, can be recalled." };
}

export interface DraftLineEdit { id?: string | null; categoryId: string; expenseDate: Date; amount: number; merchant?: string | null; description?: string | null; delete?: boolean }

/** Edit a draft: title and lines (change, add, remove). Receipts stay with their lines. */
export async function updateDraftClaim(claimId: string, employeeId: string, title: string, lines: DraftLineEdit[]): Promise<R> {
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, employeeId }, include: { lines: true } });
  if (!claim) return { ok: false, message: "Claim not found." };
  if (claim.stage !== "DRAFT") return { ok: false, message: "Only a draft can be edited; recall a submitted claim first." };
  if (!title.trim()) return { ok: false, message: "Give the claim a title." };
  const keep = lines.filter((l) => !l.delete);
  if (keep.length === 0) return { ok: false, message: "A claim needs at least one expense." };
  const cats = await prisma.expenseCategory.findMany({ where: { tenantId: claim.tenantId, id: { in: keep.map((l) => l.categoryId) }, isActive: true }, select: { id: true } });
  for (const [i, l] of keep.entries()) {
    if (!cats.some((c) => c.id === l.categoryId)) return { ok: false, message: `Line ${i + 1}: choose a category.` };
    if (!(l.amount > 0)) return { ok: false, message: `Line ${i + 1}: the amount must be more than zero.` };
  }
  const known = new Set(claim.lines.map((l) => l.id));
  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      if (l.id && !known.has(l.id)) continue;
      if (l.id && l.delete) await tx.expenseClaimLine.delete({ where: { id: l.id } });
      else if (l.id) await tx.expenseClaimLine.update({ where: { id: l.id }, data: { categoryId: l.categoryId, expenseDate: l.expenseDate, amount: l.amount, baseAmount: l.amount, merchant: l.merchant ?? null, description: l.description ?? null } });
      else if (!l.delete) await tx.expenseClaimLine.create({ data: { claimId, categoryId: l.categoryId, expenseDate: l.expenseDate, amount: l.amount, baseAmount: l.amount, merchant: l.merchant ?? null, description: l.description ?? null } });
    }
    const total = (await tx.expenseClaimLine.findMany({ where: { claimId }, select: { amount: true } })).reduce((s, l) => s + Number(l.amount), 0);
    await tx.expenseClaim.update({ where: { id: claimId }, data: { title: title.trim(), claimedTotal: r2(total) } });
  });
  return { ok: true, message: "Draft updated." };
}

/** Attach or replace a line's receipt while the claim is still being decided. */
export async function replaceReceipt(claimId: string, lineId: string, employeeId: string, receiptUrl: string, check: string | null): Promise<R & { previous?: string | null }> {
  const line = await prisma.expenseClaimLine.findFirst({ where: { id: lineId, claimId, claim: { employeeId } }, include: { claim: { select: { stage: true } } } });
  if (!line) return { ok: false, message: "Expense line not found." };
  if (!["DRAFT", "SUBMITTED", "PARTIALLY_APPROVED"].includes(line.claim.stage)) return { ok: false, message: "Receipts can be changed only until the claim is decided." };
  await prisma.expenseClaimLine.update({ where: { id: lineId }, data: { receiptUrl, receiptCheck: check, receiptUpdatedAt: new Date() } });
  return { ok: true, previous: line.receiptUrl, message: line.receiptUrl ? "Receipt replaced." : "Receipt added." };
}

// ---------------------------------------------------------------------------
//  Audit sampling
// ---------------------------------------------------------------------------

export async function drawAuditSample(input: { tenantId: string; name: string; from: Date; to: Date; ratePct: number; alwaysAbove?: number | null; seed?: number | null; actorUserId: string }): Promise<R & { id?: string; picked?: number }> {
  if (!(input.ratePct > 0 && input.ratePct <= 100)) return { ok: false, message: "The sample rate runs 1–100%." };
  if (input.to < input.from) return { ok: false, message: "The period ends before it starts." };
  const claims = await prisma.expenseClaim.findMany({
    where: { tenantId: input.tenantId, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] }, approvedAt: { gte: input.from, lte: new Date(input.to.getTime() + 86_399_999) } },
    select: { id: true, approvedTotal: true },
  });
  if (claims.length === 0) return { ok: false, message: "No approved claims in that period." };
  const seed = input.seed ?? Math.floor(Math.random() * 1_000_000);
  const picked = sampleForAudit(claims.map((c) => ({ id: c.id, amount: Number(c.approvedTotal) })), input.ratePct, seed, input.alwaysAbove ?? null);
  const s = await prisma.expenseAuditSample.create({
    data: { tenantId: input.tenantId, name: input.name, periodFrom: input.from, periodTo: input.to, ratePct: input.ratePct, seed, population: claims.length, createdBy: input.actorUserId, items: { create: picked.map((claimId) => ({ claimId })) } },
  });
  return { ok: true, id: s.id, picked: picked.length, message: `Picked ${picked.length} of ${claims.length} approved claim(s) for audit (seed ${seed}).` };
}

/** Record the auditor's finding; a recovery is deducted from the next salary. */
export async function reviewAuditItem(input: { tenantId: string; itemId: string; outcome: "OK" | "ISSUE"; finding?: string | null; recoverAmount?: number | null; actorUserId: string }): Promise<R> {
  const item = await prisma.expenseAuditSampleItem.findFirst({ where: { id: input.itemId, sample: { tenantId: input.tenantId } }, include: { sample: true } });
  if (!item) return { ok: false, message: "Sample item not found." };
  if (item.sample.status !== "OPEN") return { ok: false, message: "This sample is closed." };
  if (input.outcome === "ISSUE" && !input.finding?.trim()) return { ok: false, message: "Describe the issue found." };
  const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { id: item.claimId, tenantId: input.tenantId } });
  const recover = input.outcome === "ISSUE" && input.recoverAmount && input.recoverAmount > 0 ? Math.min(input.recoverAmount, Number(claim.approvedTotal)) : null;
  await prisma.expenseAuditSampleItem.update({ where: { id: item.id }, data: { outcome: input.outcome, finding: input.finding?.trim() || null, recoverAmount: recover, reviewedBy: input.actorUserId, reviewedAt: new Date() } });
  let note = "";
  if (recover && item.outcome !== "ISSUE") {
    const now = new Date();
    await prisma.adhocTransaction.create({ data: { employeeId: claim.employeeId, type: "DEDUCTION", name: `Expense audit recovery ${claim.claimNumber}`, amount: recover, taxTreatment: "NON_TAXABLE", year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, comment: input.finding ?? null, sourceType: "ExpenseAuditRecovery", sourceId: item.id, createdBy: input.actorUserId } });
    const emp = await prisma.employee.findUnique({ where: { id: claim.employeeId }, select: { userId: true } });
    await notify({ tenantId: input.tenantId, userIds: [emp?.userId], kind: "EXPENSE", title: `${claim.claimNumber}: audit recovery of ₹${recover.toLocaleString("en-IN")}`, body: input.finding ?? null, link: `/expenses/${claim.id}` });
    note = ` ₹${recover.toLocaleString("en-IN")} will be recovered from salary.`;
  }
  return { ok: true, message: `${claim.claimNumber}: ${input.outcome === "OK" ? "no issue" : "issue recorded"}.${note}` };
}

export async function closeAuditSample(tenantId: string, id: string): Promise<R> {
  const s = await prisma.expenseAuditSample.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!s) return { ok: false, message: "Sample not found." };
  const open = s.items.filter((i) => i.outcome === "PENDING").length;
  if (open) return { ok: false, message: `${open} claim(s) still to review.` };
  await prisma.expenseAuditSample.update({ where: { id }, data: { status: "CLOSED" } });
  const issues = s.items.filter((i) => i.outcome === "ISSUE").length;
  return { ok: true, message: `Closed: ${issues} issue(s) in ${s.items.length} claim(s).` };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export interface ExpenseReportFilter { from?: Date | null; to?: Date | null; stage?: string | null; employeeIds?: string[] | null; projectId?: string | null; q?: string | null }

function claimWhere(tenantId: string, f: ExpenseReportFilter): Prisma.ExpenseClaimWhereInput {
  return {
    tenantId,
    ...(f.stage ? { stage: f.stage as never } : { stage: { not: "DRAFT" } }),
    ...(f.from || f.to ? { submittedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: new Date(f.to.getTime() + 86_399_999) } : {}) } } : {}),
    ...(f.employeeIds ? { employeeId: { in: f.employeeIds } } : {}),
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.q ? { OR: [{ claimNumber: { contains: f.q, mode: "insensitive" } }, { title: { contains: f.q, mode: "insensitive" } }, { employee: { displayName: { contains: f.q, mode: "insensitive" } } }] } : {}),
  };
}

/** Reimbursements: one row per claim. */
export async function reimbursementRows(tenantId: string, f: ExpenseReportFilter) {
  const claims = await prisma.expenseClaim.findMany({ where: claimWhere(tenantId, f), include: { employee: { select: { employeeNumber: true, displayName: true } } }, orderBy: { submittedAt: "desc" }, take: 5000 });
  const head = ["Claim", "Employee", "Number", "Title", "Stage", "Submitted", "Approved on", "Claimed", "Approved", "Paid on", "Paid via", "Reject code"];
  const rows = claims.map((c) => [c.claimNumber, c.employee.displayName, c.employee.employeeNumber, c.title, c.stage, c.submittedAt, c.approvedAt, Number(c.claimedTotal), Number(c.approvedTotal), c.paidAt, c.paidInRunId ? "Payroll" : c.stage === "PAID" ? "Transfer / advance" : "", c.rejectCode ?? ""]);
  return { head, rows, claims };
}

/** Receipts: one row per line, with whether a receipt was given, checked and replaced. */
export async function receiptRows(tenantId: string, f: ExpenseReportFilter) {
  const lines = await prisma.expenseClaimLine.findMany({ where: { claim: claimWhere(tenantId, f) }, include: { category: { select: { name: true, receiptRequiredAbove: true } }, claim: { select: { claimNumber: true, employee: { select: { displayName: true } } } } }, orderBy: { expenseDate: "desc" }, take: 10000 });
  const head = ["Claim", "Employee", "Date", "Category", "Amount", "Receipt required", "Receipt", "Quality check", "Replaced on", "Duplicate of"];
  const rows = lines.map((l) => {
    const req = l.category.receiptRequiredAbove !== null && Number(l.amount) > Number(l.category.receiptRequiredAbove);
    return [l.claim.claimNumber, l.claim.employee.displayName, l.expenseDate, l.category.name, Number(l.amount), req ? "Yes" : "No", l.receiptUrl ? "Attached" : "Missing", l.receiptCheck ?? (l.receiptUrl ? "OK" : ""), l.receiptUpdatedAt, l.duplicateOfLineId ?? ""];
  });
  return { head, rows, missingRequired: rows.filter((r) => r[5] === "Yes" && r[6] === "Missing").length };
}

/** Spend by project (approved amounts), with claim counts. */
export async function projectSpendRows(tenantId: string, f: ExpenseReportFilter) {
  const claims = await prisma.expenseClaim.findMany({ where: { ...claimWhere(tenantId, f), stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } }, select: { projectId: true, approvedTotal: true, claimedTotal: true } });
  const projects = await prisma.project.findMany({ where: { tenantId, id: { in: [...new Set(claims.map((c) => c.projectId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, code: true } });
  const by = new Map<string, { claims: number; claimed: number; approved: number }>();
  for (const c of claims) {
    const k = c.projectId ?? "";
    const b = by.get(k) ?? { claims: 0, claimed: 0, approved: 0 };
    b.claims++; b.claimed += Number(c.claimedTotal); b.approved += Number(c.approvedTotal);
    by.set(k, b);
  }
  const head = ["Project", "Code", "Claims", "Claimed", "Approved"];
  const rows = [...by.entries()].map(([k, b]) => { const p = projects.find((x) => x.id === k); return [p?.name ?? "No project", p?.code ?? "", b.claims, r2(b.claimed), r2(b.approved)]; }).sort((a, b) => Number(b[4]) - Number(a[4]));
  return { head, rows };
}

/** Approved lines with GL account codes and tax treatment, for the finance system. */
export async function financeExportRows(tenantId: string, f: ExpenseReportFilter) {
  const lines = await prisma.expenseClaimLine.findMany({
    where: { claim: { ...claimWhere(tenantId, f), stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } }, approvedAmount: { gt: 0 } },
    include: { category: true, claim: { select: { claimNumber: true, approvedAt: true, paidAt: true, projectId: true, costCenterId: true, employee: { select: { employeeNumber: true, displayName: true } } } } },
    orderBy: { expenseDate: "asc" }, take: 20000,
  });
  const accounts = await prisma.account.findMany({ where: { tenantId, id: { in: [...new Set(lines.map((l) => l.category.accountId).filter((x): x is string => !!x))] } }, select: { id: true, code: true } });
  const head = ["Claim", "Employee number", "Employee", "Expense date", "Approved on", "Paid on", "Category", "GL account", "Tax treatment", "Amount", "Currency", "Project", "Cost centre", "Merchant"];
  const rows = lines.map((l) => [l.claim.claimNumber, l.claim.employee.employeeNumber, l.claim.employee.displayName, l.expenseDate, l.claim.approvedAt, l.claim.paidAt, l.category.name, accounts.find((a) => a.id === l.category.accountId)?.code ?? "5200", l.category.isTaxable ? "TAXABLE" : "NON_TAXABLE", Number(l.approvedAmount), l.currency, l.claim.projectId ?? "", l.claim.costCenterId ?? "", l.merchant ?? ""]);
  return { head, rows };
}

/** Taxable vs non-taxable reimbursements in a period. */
export async function taxClassificationSummary(tenantId: string, f: ExpenseReportFilter) {
  const lines = await prisma.expenseClaimLine.findMany({ where: { claim: { ...claimWhere(tenantId, f), stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } } }, select: { approvedAmount: true, category: { select: { isTaxable: true } } } });
  return {
    taxable: r2(lines.filter((l) => l.category.isTaxable).reduce((s, l) => s + Number(l.approvedAmount ?? 0), 0)),
    nonTaxable: r2(lines.filter((l) => !l.category.isTaxable).reduce((s, l) => s + Number(l.approvedAmount ?? 0), 0)),
  };
}
