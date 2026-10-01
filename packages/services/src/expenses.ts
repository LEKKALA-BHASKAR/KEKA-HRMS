import { prisma, Prisma } from "@keka/db";
import { checkLine, defaultApproved, settleAgainstAdvance, type LineIssue } from "./expense-math";
import { notify, usersWithPermission } from "./lifecycle";
import { postEntry } from "./accounting";

/**
 * Expense claims, cash advances and travel requests. A claim is checked
 * against policy when it is made, approved by the manager (and by finance
 * above an escalation amount), settles any open advance first, and is paid
 * through payroll as a non-taxable reimbursement — marked paid only when that
 * payroll month is finalised.
 */

type Result = { ok: boolean; message: string };
const MAX_AGE_DAYS = 60;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Next human number for a tenant — EXP-1001, TRV-1001 — under a row lock. */
async function nextNumber(tx: Prisma.TransactionClient, tenantId: string, prefix: string, existing: () => Promise<string[]>): Promise<string> {
  await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
  const max = (await existing()).map((n) => Number(n.split("-")[1]) || 0).reduce((a, b) => Math.max(a, b), 1000);
  return `${prefix}-${max + 1}`;
}

async function rulesFor(employeeId: string, categoryIds: string[]) {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  const policy = await prisma.expensePolicy.findFirst({ where: { tenantId: emp.tenantId, isActive: true }, orderBy: { isDefault: "desc" }, include: { categories: true } });
  const cats = await prisma.expenseCategory.findMany({ where: { id: { in: categoryIds }, tenantId: emp.tenantId, isActive: true } });
  return {
    policy,
    rule: (categoryId: string) => {
      const c = cats.find((x) => x.id === categoryId);
      if (!c) return null;
      const policyCap = policy?.categories.find((pc) => pc.categoryId === categoryId)?.maxAmount;
      const caps = [c.maxAmount, policyCap].filter((v) => v !== null && v !== undefined).map(Number);
      return {
        category: c,
        rules: { cap: caps.length ? Math.min(...caps) : null, receiptRequiredAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove), allowFutureDated: policy?.allowFutureDated ?? false, maxAgeDays: MAX_AGE_DAYS },
      };
    },
  };
}

export interface ClaimLineInput { categoryId: string; expenseDate: Date; amount: number; merchant?: string | null; description?: string | null; receiptUrl?: string | null }

export async function createClaim(input: { employeeId: string; title: string; lines: ClaimLineInput[]; advanceId?: string | null; payViaPayroll?: boolean; submit: boolean }): Promise<Result & { claimId?: string; warnings?: string[] }> {
  if (input.lines.length === 0) return { ok: false, message: "Add at least one expense." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, displayName: true, reportingManagerId: true } });
  const { policy, rule } = await rulesFor(input.employeeId, input.lines.map((l) => l.categoryId));
  const errors: string[] = [], warnings: string[] = [];
  input.lines.forEach((l, i) => {
    const r = rule(l.categoryId);
    if (!r) { errors.push(`Line ${i + 1}: choose a category.`); return; }
    for (const issue of checkLine({ amount: l.amount, expenseDate: l.expenseDate, hasReceipt: !!l.receiptUrl }, r.rules) as LineIssue[]) {
      (issue.level === "error" ? errors : warnings).push(`Line ${i + 1} (${r.category.name}): ${issue.message}`);
    }
  });
  if (errors.length) return { ok: false, message: errors.join(" "), warnings };
  if (input.advanceId) {
    const adv = await prisma.cashAdvance.findFirst({ where: { id: input.advanceId, employeeId: input.employeeId, status: { in: ["DISBURSED", "PARTIALLY_SETTLED"] } } });
    if (!adv) return { ok: false, message: "That advance is not open against your name." };
  }
  const total = r2(input.lines.reduce((s, l) => s + l.amount, 0));
  const claim = await prisma.$transaction(async (tx) => {
    const claimNumber = await nextNumber(tx, emp.tenantId, "EXP", async () => (await tx.expenseClaim.findMany({ where: { tenantId: emp.tenantId }, select: { claimNumber: true } })).map((c) => c.claimNumber));
    return tx.expenseClaim.create({
      data: {
        tenantId: emp.tenantId, employeeId: input.employeeId, policyId: policy?.id ?? null, claimNumber, title: input.title,
        stage: input.submit ? "SUBMITTED" : "DRAFT", submittedAt: input.submit ? new Date() : null,
        claimedTotal: total, advanceId: input.advanceId ?? null, payViaPayroll: input.payViaPayroll ?? true,
        lines: { create: input.lines.map((l) => ({ categoryId: l.categoryId, expenseDate: l.expenseDate, amount: l.amount, baseAmount: l.amount, merchant: l.merchant ?? null, description: l.description ?? null, receiptUrl: l.receiptUrl ?? null })) },
      },
    });
  });
  if (input.submit) {
    const mgr = emp.reportingManagerId ? await prisma.employee.findUnique({ where: { id: emp.reportingManagerId }, select: { userId: true } }) : null;
    await notify({ tenantId: emp.tenantId, userIds: [mgr?.userId], kind: "EXPENSE", title: `${emp.displayName} claimed ₹${total.toLocaleString("en-IN")}`, body: input.title, link: `/expenses/${claim.id}` });
  }
  return { ok: true, message: `${claim.claimNumber} ${input.submit ? "submitted" : "saved as a draft"} — ₹${total.toLocaleString("en-IN")}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`, claimId: claim.id, warnings };
}

/**
 * Submit a saved draft. The policy is checked again as it stands now: a
 * draft older than the claim window, or over a limit changed since, is
 * refused exactly as a fresh claim would be.
 */
export async function submitDraftClaim(claimId: string, employeeId: string): Promise<Result> {
  const claim = await prisma.expenseClaim.findFirst({ where: { id: claimId, employeeId }, include: { lines: true, employee: { select: { tenantId: true, displayName: true, reportingManagerId: true } } } });
  if (!claim) return { ok: false, message: "Claim not found." };
  if (claim.stage !== "DRAFT") return { ok: false, message: `This claim is already ${claim.stage.toLowerCase().replace(/_/g, " ")}.` };
  if (claim.lines.length === 0) return { ok: false, message: "Add at least one expense." };
  const { rule } = await rulesFor(employeeId, claim.lines.map((l) => l.categoryId));
  const errors: string[] = [];
  claim.lines.forEach((l, i) => {
    const r = rule(l.categoryId);
    if (!r) { errors.push(`Line ${i + 1}: the category is no longer available.`); return; }
    for (const issue of checkLine({ amount: Number(l.amount), expenseDate: l.expenseDate, hasReceipt: !!l.receiptUrl }, r.rules) as LineIssue[]) {
      if (issue.level === "error") errors.push(`Line ${i + 1} (${r.category.name}): ${issue.message}`);
    }
  });
  if (errors.length) return { ok: false, message: errors.join(" ") };
  const u = await prisma.expenseClaim.updateMany({ where: { id: claim.id, stage: "DRAFT" }, data: { stage: "SUBMITTED", submittedAt: new Date() } });
  if (u.count === 0) return { ok: false, message: "This claim changed while you were submitting it." };
  const mgr = claim.employee.reportingManagerId ? await prisma.employee.findUnique({ where: { id: claim.employee.reportingManagerId }, select: { userId: true } }) : null;
  await notify({ tenantId: claim.employee.tenantId, userIds: [mgr?.userId], kind: "EXPENSE", title: `${claim.employee.displayName} claimed ₹${Number(claim.claimedTotal).toLocaleString("en-IN")}`, body: claim.title, link: `/expenses/${claim.id}` });
  return { ok: true, message: `${claim.claimNumber} submitted for approval.` };
}

/** The payroll month a reimbursement will ride in: the earliest not yet finalised. */
async function payrollMonthFor(employeeId: string): Promise<{ year: number; month: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { payGroupId: true } });
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  for (let i = 0; i < 3; i++) {
    const done = emp.payGroupId ? await prisma.payrollRun.findFirst({ where: { payGroupId: emp.payGroupId, year: y, month: m, status: { in: ["FINALIZED", "LOCKED"] }, rolledBackAt: null } }) : null;
    if (!done) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return { year: y, month: m };
}

/**
 * Approve or reject. `level` is MANAGER for the first approval and FINANCE
 * for the escalation step; `lineAmounts` lets an approver reduce lines.
 */
export async function decideClaim(opts: {
  claimId: string; level: "MANAGER" | "FINANCE"; approve: boolean; byUserId: string;
  lineAmounts?: Record<string, number>; reason?: string | null;
}): Promise<Result> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id: opts.claimId }, include: { lines: { include: { category: true } }, policy: { include: { categories: true } }, employee: { select: { userId: true, tenantId: true } } } });
  if (!claim) return { ok: false, message: "Claim not found." };
  const expected = opts.level === "MANAGER" ? "SUBMITTED" : "PARTIALLY_APPROVED";
  if (claim.stage !== expected) return { ok: false, message: opts.level === "FINANCE" && claim.stage === "SUBMITTED" ? "The manager has not approved it yet." : `This claim is ${claim.stage.toLowerCase().replace(/_/g, " ")}.` };
  if (!opts.approve) {
    if (!opts.reason?.trim()) return { ok: false, message: "Give a reason when rejecting." };
    await prisma.expenseClaim.update({ where: { id: claim.id }, data: { stage: "REJECTED", rejectReason: opts.reason, rejectedBy: opts.byUserId, rejectedAt: new Date() } });
    await notify({ tenantId: claim.tenantId, userIds: [claim.employee.userId], kind: "EXPENSE", title: `${claim.claimNumber} was rejected`, body: opts.reason, link: `/expenses/${claim.id}` });
    return { ok: true, message: "Rejected." };
  }
  // Amounts: the approver's, else what was already approved, else the capped claim.
  const { rule } = await rulesFor(claim.employeeId, claim.lines.map((l) => l.categoryId));
  const amounts = claim.lines.map((l) => {
    const cap = rule(l.categoryId)?.rules.cap ?? null;
    const set = opts.lineAmounts?.[l.id];
    const base = l.approvedAmount !== null ? Number(l.approvedAmount) : defaultApproved(Number(l.amount), cap);
    const v = set !== undefined ? Math.max(0, Math.min(set, Number(l.amount))) : base;
    return { id: l.id, approved: r2(v) };
  });
  const approvedTotal = r2(amounts.reduce((s, a) => s + a.approved, 0));
  await prisma.$transaction(amounts.map((a) => prisma.expenseClaimLine.update({ where: { id: a.id }, data: { approvedAmount: a.approved, isApproved: a.approved > 0 } })));
  const escalate = opts.level === "MANAGER" && claim.policy?.escalationAboveAmount && approvedTotal > Number(claim.policy.escalationAboveAmount);
  if (escalate) {
    await prisma.expenseClaim.update({ where: { id: claim.id }, data: { stage: "PARTIALLY_APPROVED", approvedTotal, approvedBy: opts.byUserId, approvedAt: new Date() } });
    await notify({ tenantId: claim.tenantId, userIds: await usersWithPermission(claim.tenantId, "expense.policy.manage"), kind: "EXPENSE", title: `${claim.claimNumber} needs finance approval`, body: `₹${approvedTotal.toLocaleString("en-IN")} is above the escalation limit.`, link: `/expenses/${claim.id}` });
    return { ok: true, message: `Approved ₹${approvedTotal.toLocaleString("en-IN")}; above the escalation limit, so finance approves next.` };
  }
  return finaliseClaim(claim.id, approvedTotal, opts.byUserId);
}

async function finaliseClaim(claimId: string, approvedTotal: number, byUserId: string): Promise<Result> {
  const claim = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claimId }, include: { employee: { select: { userId: true } } } });
  let payable = approvedTotal;
  let settledNote = "";
  if (claim.advanceId) {
    const adv = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: claim.advanceId } });
    const s = settleAgainstAdvance(approvedTotal, Number(adv.outstanding));
    payable = s.payable;
    await prisma.cashAdvance.update({
      where: { id: adv.id },
      data: { settledAmount: { increment: s.settles }, outstanding: s.stillOutstanding, status: s.stillOutstanding > 0 ? "PARTIALLY_SETTLED" : "SETTLED" },
    });
    settledNote = ` ₹${s.settles.toLocaleString("en-IN")} settled the advance${s.stillOutstanding > 0 ? `, ₹${s.stillOutstanding.toLocaleString("en-IN")} of it still open` : ""}.`;
    // The spend is the company's expense; the advance that funded it is used up.
    if (s.settles > 0) {
      await postEntry({
        tenantId: claim.tenantId, date: new Date(), source: "EXPENSE", ref: { type: "ClaimAdvanceSettlement", id: claim.id }, postedBy: byUserId,
        narration: `${claim.claimNumber} settled against advance`,
        lines: [{ accountCode: "5200", debit: s.settles, credit: 0, employeeId: claim.employeeId }, { accountCode: "1300", debit: 0, credit: s.settles, employeeId: claim.employeeId }],
      });
    }
  }
  let stage: "APPROVED" | "PAYMENT_PENDING" | "PAID" = "APPROVED";
  let when = "";
  if (payable > 0 && claim.payViaPayroll) {
    const { year, month } = await payrollMonthFor(claim.employeeId);
    await prisma.adhocTransaction.create({
      data: {
        employeeId: claim.employeeId, type: "PAYMENT", name: `Expense reimbursement ${claim.claimNumber}`, amount: payable, taxTreatment: "NON_TAXABLE",
        year, month, comment: claim.title, sourceType: "ExpenseClaim", sourceId: claim.id, createdBy: byUserId,
      },
    });
    stage = "PAYMENT_PENDING";
    when = ` ₹${payable.toLocaleString("en-IN")} will be paid with the ${month}/${year} salary.`;
  } else if (payable <= 0) {
    stage = "PAID";
  }
  await prisma.expenseClaim.update({ where: { id: claimId }, data: { stage, approvedTotal, approvedBy: byUserId, approvedAt: new Date(), ...(stage === "PAID" ? { paidAt: new Date() } : {}) } });
  await notify({ tenantId: claim.tenantId, userIds: [claim.employee.userId], kind: "EXPENSE", title: `${claim.claimNumber} approved`, body: `₹${approvedTotal.toLocaleString("en-IN")} approved.${settledNote}${when}`, link: `/expenses/${claim.id}` });
  return { ok: true, message: `Approved ₹${approvedTotal.toLocaleString("en-IN")}.${settledNote}${when}` };
}

/** A claim to be paid outside payroll — by finance, by bank transfer. */
export async function markClaimPaid(claimId: string): Promise<Result> {
  const c = await prisma.expenseClaim.findUnique({ where: { id: claimId } });
  if (!c || c.stage !== "APPROVED") return { ok: false, message: "Only an approved claim paid outside payroll can be marked paid here." };
  await prisma.expenseClaim.update({ where: { id: claimId }, data: { stage: "PAID", paidAt: new Date() } });
  // What the bank paid is the approved total less any part an advance covered.
  const settled = await prisma.ledgerEntry.findFirst({ where: { tenantId: c.tenantId, sourceRefType: "ClaimAdvanceSettlement", sourceRefId: c.id, status: "POSTED" } });
  const paid = r2(Number(c.approvedTotal) - Number(settled?.totalDebit ?? 0));
  if (paid > 0) {
    await postEntry({
      tenantId: c.tenantId, date: new Date(), source: "EXPENSE", ref: { type: "ClaimPayment", id: c.id },
      narration: `${c.claimNumber} reimbursed by bank transfer`,
      lines: [{ accountCode: "5200", debit: paid, credit: 0, employeeId: c.employeeId }, { accountCode: "1100", debit: 0, credit: paid }],
    });
  }
  return { ok: true, message: "Marked paid." };
}

export async function cancelClaim(claimId: string, employeeId: string): Promise<Result> {
  const u = await prisma.expenseClaim.updateMany({ where: { id: claimId, employeeId, stage: { in: ["DRAFT", "SUBMITTED"] } }, data: { stage: "CANCELLED" } });
  return u.count ? { ok: true, message: "Withdrawn." } : { ok: false, message: "Only your own unapproved claims can be withdrawn." };
}

/** Called when a payroll month is finalised or rolled back. */
export async function settlePayrollSources(runId: string, finalised: boolean): Promise<void> {
  const adhocs = await prisma.adhocTransaction.findMany({ where: { runId, sourceType: { in: ["ExpenseClaim", "CashAdvanceRecovery"] } } });
  for (const a of adhocs) {
    if (a.sourceType === "ExpenseClaim" && a.sourceId) {
      await prisma.expenseClaim.updateMany({
        where: { id: a.sourceId },
        data: finalised ? { stage: "PAID", paidAt: new Date(), paidInRunId: runId } : { stage: "PAYMENT_PENDING", paidAt: null, paidInRunId: null },
      });
    }
    if (a.sourceType === "CashAdvanceRecovery" && a.sourceId) {
      const adv = await prisma.cashAdvance.findUnique({ where: { id: a.sourceId } });
      if (!adv) continue;
      await prisma.cashAdvance.update({
        where: { id: adv.id },
        data: finalised
          ? { status: "RECOVERED", outstanding: 0, settledAmount: { increment: Number(a.amount) }, recoveredInRunId: runId }
          : { status: "PARTIALLY_SETTLED", outstanding: Number(a.amount), settledAmount: { decrement: Number(a.amount) }, recoveredInRunId: null },
      });
    }
  }
}

// ---------------------------------------------------------------------------
//  Cash advances
// ---------------------------------------------------------------------------

export async function requestAdvance(input: { employeeId: string; amount: number; purpose: string; neededBy?: Date | null }): Promise<Result> {
  if (!(input.amount > 0)) return { ok: false, message: "Enter an amount." };
  const open = await prisma.cashAdvance.count({ where: { employeeId: input.employeeId, status: { in: ["REQUESTED", "APPROVED", "DISBURSED", "PARTIALLY_SETTLED"] } } });
  if (open) return { ok: false, message: "Settle your open advance before asking for another." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, displayName: true } });
  await prisma.cashAdvance.create({ data: { tenantId: emp.tenantId, employeeId: input.employeeId, amount: input.amount, purpose: input.purpose, neededBy: input.neededBy ?? null } });
  await notify({ tenantId: emp.tenantId, userIds: await usersWithPermission(emp.tenantId, "expense.advance.approve"), kind: "EXPENSE", title: `${emp.displayName} requested a ₹${input.amount.toLocaleString("en-IN")} advance`, body: input.purpose, link: "/expenses?tab=advances" });
  return { ok: true, message: "Requested." };
}

export async function advanceOp(advanceId: string, op: "approve" | "reject" | "disburse" | "recover", byUserId: string): Promise<Result> {
  const adv = await prisma.cashAdvance.findUnique({ where: { id: advanceId } });
  if (!adv) return { ok: false, message: "Advance not found." };
  if (op === "approve" || op === "reject") {
    if (adv.status !== "REQUESTED") return { ok: false, message: "Already decided." };
    await prisma.cashAdvance.update({ where: { id: advanceId }, data: op === "approve" ? { status: "APPROVED", approvedBy: byUserId, approvedAt: new Date() } : { status: "REJECTED" } });
    return { ok: true, message: op === "approve" ? "Approved; disburse it when paid." : "Rejected." };
  }
  if (op === "disburse") {
    if (adv.status !== "APPROVED") return { ok: false, message: "Only an approved advance can be disbursed." };
    await prisma.cashAdvance.update({ where: { id: advanceId }, data: { status: "DISBURSED", disbursedAt: new Date(), outstanding: adv.amount } });
    await postEntry({
      tenantId: adv.tenantId, date: new Date(), source: "EXPENSE", ref: { type: "CashAdvance", id: adv.id }, postedBy: byUserId,
      narration: `Cash advance: ${adv.purpose}`,
      lines: [{ accountCode: "1300", debit: r2(Number(adv.amount)), credit: 0, employeeId: adv.employeeId }, { accountCode: "1100", debit: 0, credit: r2(Number(adv.amount)) }],
    });
    return { ok: true, message: `Disbursed. ₹${Number(adv.amount).toLocaleString("en-IN")} is outstanding until claims settle it.` };
  }
  // Recover what claims did not settle, through payroll.
  if (!["DISBURSED", "PARTIALLY_SETTLED"].includes(adv.status) || Number(adv.outstanding) <= 0) return { ok: false, message: "Nothing outstanding to recover." };
  const pending = await prisma.adhocTransaction.count({ where: { sourceType: "CashAdvanceRecovery", sourceId: advanceId, isProcessed: false } });
  if (pending) return { ok: false, message: "A recovery is already scheduled." };
  const { year, month } = await payrollMonthFor(adv.employeeId);
  await prisma.adhocTransaction.create({ data: { employeeId: adv.employeeId, type: "DEDUCTION", name: "Cash advance recovery", amount: adv.outstanding, taxTreatment: "NON_TAXABLE", year, month, sourceType: "CashAdvanceRecovery", sourceId: advanceId, createdBy: byUserId } });
  return { ok: true, message: `₹${Number(adv.outstanding).toLocaleString("en-IN")} will be recovered from the ${month}/${year} salary.` };
}

// ---------------------------------------------------------------------------
//  Travel
// ---------------------------------------------------------------------------

export async function requestTrip(input: { employeeId: string; purpose: string; fromCity: string; toCity: string; departDate: Date; returnDate?: Date | null; travelType: "DOMESTIC" | "INTERNATIONAL"; needsAccommodation: boolean; estimatedCost?: number | null }): Promise<Result> {
  if (input.returnDate && input.returnDate < input.departDate) return { ok: false, message: "The return is before the departure." };
  if (input.departDate.getTime() < Date.now() - 86_400_000) return { ok: false, message: "Trips are requested before they start." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, displayName: true, reportingManagerId: true } });
  const trip = await prisma.$transaction(async (tx) => {
    const requestNumber = await nextNumber(tx, emp.tenantId, "TRV", async () => (await tx.travelRequest.findMany({ where: { tenantId: emp.tenantId }, select: { requestNumber: true } })).map((t) => t.requestNumber));
    return tx.travelRequest.create({ data: { ...input, tenantId: emp.tenantId, requestNumber, needsVisa: input.travelType === "INTERNATIONAL" } });
  });
  const mgr = emp.reportingManagerId ? await prisma.employee.findUnique({ where: { id: emp.reportingManagerId }, select: { userId: true } }) : null;
  await notify({ tenantId: emp.tenantId, userIds: [mgr?.userId], kind: "TRAVEL", title: `${emp.displayName}: ${input.fromCity} → ${input.toCity}`, body: input.purpose, link: "/expenses?tab=travel" });
  return { ok: true, message: `${trip.requestNumber} requested.` };
}

export async function tripOp(tripId: string, op: "approve" | "reject" | "book" | "complete" | "cancel", byUserId: string, extra: { reason?: string | null; bookingRef?: string | null; actualCost?: number | null } = {}): Promise<Result> {
  const t = await prisma.travelRequest.findUnique({ where: { id: tripId } });
  if (!t) return { ok: false, message: "Trip not found." };
  const flow: Record<string, string[]> = { approve: ["REQUESTED"], reject: ["REQUESTED"], book: ["APPROVED"], complete: ["BOOKED", "IN_PROGRESS"], cancel: ["REQUESTED", "APPROVED", "BOOKED"] };
  if (!flow[op].includes(t.status)) return { ok: false, message: `A ${t.status.toLowerCase()} trip cannot be ${op === "book" ? "booked" : `${op}d`}.` };
  if (op === "reject" && !extra.reason) return { ok: false, message: "Give a reason." };
  if (op === "book" && !extra.bookingRef) return { ok: false, message: "Enter the booking reference." };
  const data: Prisma.TravelRequestUpdateInput =
    op === "approve" ? { status: "APPROVED", approvedBy: byUserId, approvedAt: new Date() }
    : op === "reject" ? { status: "REJECTED", rejectReason: extra.reason }
    : op === "book" ? { status: "BOOKED", bookingRef: extra.bookingRef, bookedBy: byUserId, bookedAt: new Date(), actualCost: extra.actualCost ?? undefined }
    : op === "complete" ? { status: "COMPLETED" } : { status: "CANCELLED" };
  await prisma.travelRequest.update({ where: { id: tripId }, data });
  return { ok: true, message: { approve: "Approved; the travel desk will book it.", reject: "Rejected.", book: "Booked.", complete: "Completed.", cancel: "Cancelled." }[op] };
}
