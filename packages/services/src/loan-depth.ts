import { prisma, Prisma } from "@keka/db";
import { buildLoanSchedule } from "@keka/payroll";
import { notify, usersWithPermission } from "./lifecycle";
import { startWorkflow } from "./workflow-engine";
import { moneyAudit } from "./money-audit";
import { checkLoanEligibility, forecloseLoan, skipInstallment, syncLoanBalance, openPayrollMonthFor } from "./loans";
import { compareMonths } from "./finances-math";
import { loanAging, moneyMonthIndex, overdueInstallments, trancheSchedule } from "./money-math";

/**
 * Loan depth: product changes through approval, editing a pending request,
 * tranches, employee requests to reschedule, skip, part-prepay or settle
 * (approved through the workflow engine), admin balance adjustments, overdue
 * alerts, statements, the portfolio and approval delegation.
 */

type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const OPEN = ["ACTIVE", "DISBURSED"];

// ---------------------------------------------------------------------------
//  Loan products
// ---------------------------------------------------------------------------

export interface LoanRulePayload {
  interestType: "NONE" | "FLAT" | "REDUCING"; interestRate: number | null; maxInstallments: number; commencementMonths: number;
  maxAmount: number | null; maxPercentOfSalary: number | null; requiresDocuments: boolean; processingFeePct: number | null; processingFeeFlat: number | null;
}

async function writeRule(policyId: string, categoryId: string, d: LoanRulePayload) {
  await prisma.loanPolicyRule.upsert({ where: { policyId_categoryId: { policyId, categoryId } }, create: { policyId, categoryId, ...d }, update: d });
}

/**
 * Save a policy's rule for a category. When the policy requires approval for
 * changes, the change waits in the workflow and applies once approved.
 */
export async function proposeLoanRule(input: { tenantId: string; policyId: string; categoryId: string; rule: LoanRulePayload; actorUserId: string; employeeId: string | null }): Promise<R & { pending?: boolean }> {
  const policy = await prisma.loanPolicy.findFirst({ where: { id: input.policyId, tenantId: input.tenantId } });
  const cat = await prisma.loanCategory.findFirst({ where: { id: input.categoryId, tenantId: input.tenantId } });
  if (!policy || !cat) return { ok: false, message: "Policy or category not found." };
  if (input.rule.interestType !== "NONE" && !input.rule.interestRate) return { ok: false, message: "An interest-bearing loan needs a rate." };
  if (!policy.requireChangeApproval) {
    await writeRule(policy.id, cat.id, input.rule);
    return { ok: true, message: `Saved the ${cat.name} rule.` };
  }
  if (await prisma.loanProductChange.findFirst({ where: { tenantId: input.tenantId, policyId: policy.id, categoryId: cat.id, status: "PENDING" } })) return { ok: false, message: `A change to the ${cat.name} rule is already waiting for approval.` };
  const r = input.rule;
  const summary = `${cat.name} in ${policy.name}: ${r.interestType === "NONE" ? "interest-free" : `${r.interestRate}% ${r.interestType.toLowerCase()}`}, up to ${r.maxInstallments} EMIs${r.maxAmount ? `, max ₹${r.maxAmount.toLocaleString("en-IN")}` : ""}${r.processingFeePct || r.processingFeeFlat ? `, fee ${r.processingFeePct ?? 0}% + ₹${r.processingFeeFlat ?? 0}` : ""}`;
  const ch = await prisma.loanProductChange.create({ data: { tenantId: input.tenantId, policyId: policy.id, categoryId: cat.id, payload: r as unknown as Prisma.InputJsonValue, summary, requestedBy: input.actorUserId } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "LOAN_PRODUCT", entityId: ch.id, title: `Loan product change — ${summary}`, amount: r.maxAmount, requesterUserId: input.actorUserId, subjectEmployeeId: input.employeeId });
  if (!wf.ok) { await prisma.loanProductChange.delete({ where: { id: ch.id } }); return wf; }
  await prisma.loanProductChange.updateMany({ where: { id: ch.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  const after = await prisma.loanProductChange.findUniqueOrThrow({ where: { id: ch.id } });
  return { ok: true, pending: after.status === "PENDING", message: after.status === "APPLIED" ? `Saved the ${cat.name} rule.` : "Sent for approval; the rule changes once approved." };
}

export async function applyLoanProductDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const ch = await prisma.loanProductChange.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!ch) return;
  if (outcome === "APPROVED") {
    await writeRule(ch.policyId, ch.categoryId, ch.payload as unknown as LoanRulePayload);
    await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "LoanPolicyRule", entityId: ch.policyId, summary: `Loan product change applied: ${ch.summary}`, newValue: ch.payload });
  }
  await prisma.loanProductChange.update({ where: { id }, data: { status: outcome === "APPROVED" ? "APPLIED" : outcome, decidedAt: new Date() } });
}

// ---------------------------------------------------------------------------
//  Requests
// ---------------------------------------------------------------------------

/** Change a request nobody has decided yet; eligibility is checked again. */
export async function updateLoanRequest(input: { loanId: string; employeeId: string; amount: number; installments: number; purpose?: string | null; documentUrl?: string | null; expected?: { year: number; month: number } | null; start?: { year: number; month: number } | null }): Promise<R> {
  const loan = await prisma.loan.findFirst({ where: { id: input.loanId, employeeId: input.employeeId } });
  if (!loan) return { ok: false, message: "Loan request not found." };
  if (!["REQUESTED", "PENDING_APPROVAL"].includes(loan.status)) return { ok: false, message: "Only a request nobody has decided can be changed." };
  const e = await checkLoanEligibility(input.employeeId, loan.categoryId, input.amount, input.installments, { excludeLoanId: loan.id });
  if (!e.eligible) return { ok: false, message: e.reasons.join(" ") };
  const open = await openPayrollMonthFor(input.employeeId);
  if (input.expected && compareMonths(input.expected, open) < 0) return { ok: false, message: `The expected month must be ${open.month}/${open.year} or later.` };
  if (input.start && compareMonths(input.start, input.expected ?? open) < 0) return { ok: false, message: "EMIs cannot start before the month the loan is paid out." };
  const start = input.start ?? open;
  const s = buildLoanSchedule({ principal: input.amount, installments: input.installments, interestType: e.interestType, annualRate: e.interestRate, startYear: start.year, startMonth: start.month });
  await prisma.loan.update({
    where: { id: loan.id },
    data: {
      principal: input.amount, installments: input.installments, emiAmount: s.emi.toNumber(), outstanding: input.amount, interestType: e.interestType, interestRate: e.interestRate,
      purpose: input.purpose ?? loan.purpose, documentUrl: input.documentUrl ?? loan.documentUrl,
      expectedYear: input.expected?.year ?? null, expectedMonth: input.expected?.month ?? null, startYear: input.start?.year ?? null, startMonth: input.start?.month ?? null,
    },
  });
  return { ok: true, message: `Request updated: ₹${input.amount.toLocaleString("en-IN")} over ${input.installments} months, EMI ₹${s.emi.toNumber().toLocaleString("en-IN")}.` };
}

/** Whether the category's rule needs a supporting document. */
export async function loanNeedsDocument(employeeId: string, categoryId: string): Promise<boolean> {
  const e = await checkLoanEligibility(employeeId, categoryId);
  if (!e.policyId) return false;
  const rule = await prisma.loanPolicyRule.findUnique({ where: { policyId_categoryId: { policyId: e.policyId, categoryId } }, select: { requiresDocuments: true } });
  return !!rule?.requiresDocuments;
}

// ---------------------------------------------------------------------------
//  Tranches
// ---------------------------------------------------------------------------

export async function planTranches(tenantId: string, loanId: string, count: number, gapMonths: number, firstOn: Date): Promise<R> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, employee: { tenantId } } });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (loan.status !== "APPROVED") return { ok: false, message: "Plan tranches after approval and before disbursal." };
  if (!(count >= 2 && count <= 12)) return { ok: false, message: "Use 2–12 tranches." };
  const plan = trancheSchedule(Number(loan.principal), count, firstOn, gapMonths);
  await prisma.$transaction([
    prisma.loanTranche.deleteMany({ where: { loanId } }),
    prisma.loanTranche.createMany({ data: plan.map((p) => ({ tenantId, loanId, sequence: p.sequence, amount: p.amount, plannedOn: p.plannedOn })) }),
    prisma.loan.update({ where: { id: loanId }, data: { hasTranches: true } }),
  ]);
  return { ok: true, message: `${count} tranches of about ₹${plan[0]!.amount.toLocaleString("en-IN")} planned; the first is released on disbursal.` };
}

export async function releaseTranche(tenantId: string, trancheId: string, byUserId: string): Promise<R> {
  const t = await prisma.loanTranche.findFirst({ where: { id: trancheId, tenantId } });
  if (!t || t.status !== "PLANNED") return { ok: false, message: "That tranche is not waiting to be released." };
  const loan = await prisma.loan.findUniqueOrThrow({ where: { id: t.loanId } });
  if (!OPEN.includes(loan.status)) return { ok: false, message: "Disburse the loan first; that releases tranche 1." };
  const earlier = await prisma.loanTranche.count({ where: { loanId: t.loanId, sequence: { lt: t.sequence }, status: "PLANNED" } });
  if (earlier) return { ok: false, message: "Release the earlier tranches first." };
  await prisma.loanTranche.update({ where: { id: t.id }, data: { status: "PAID", paidAt: new Date(), paidBy: byUserId } });
  return { ok: true, message: `Tranche ${t.sequence} of ₹${Number(t.amount).toLocaleString("en-IN")} released.` };
}

// ---------------------------------------------------------------------------
//  Adjustments: reschedule, skip, prepayment, settlement, balance
// ---------------------------------------------------------------------------

/**
 * Rebuild the unpaid part of the schedule. `paidNow` records a part payment
 * (PREPAID) or a write-down (WAIVED) first; the rest is spread over
 * `installments` months (default: as many as were left) from the first
 * month still to be deducted.
 */
async function rebuildRemaining(loanId: string, opts: { paidNow?: { amount: number; status: "PREPAID" | "WAIVED" }; installments?: number }): Promise<{ remaining: number; emi: number; count: number }> {
  const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId }, include: { schedule: { orderBy: { sequence: "asc" } } } });
  const pending = loan.schedule.filter((i) => i.status === "SCHEDULED");
  const settled = loan.schedule.filter((i) => ["DEDUCTED", "PREPAID", "WAIVED"].includes(i.status)).reduce((s, i) => s + Number(i.principalPart), 0);
  const remainingBefore = r2(Number(loan.principal) - settled);
  const paid = opts.paidNow ? Math.min(opts.paidNow.amount, remainingBefore) : 0;
  const remaining = r2(remainingBefore - paid);
  const first = pending[0] ?? (await openPayrollMonthFor(loan.employeeId));
  const count = Math.max(1, opts.installments ?? (pending.length || 1));
  let seq = loan.schedule.reduce((m, i) => Math.max(m, i.sequence), 0);
  const ops: Prisma.PrismaPromise<unknown>[] = [prisma.loanInstallment.deleteMany({ where: { loanId, status: "SCHEDULED" } })];
  if (paid > 0) {
    const m = await openPayrollMonthFor(loan.employeeId);
    ops.push(prisma.loanInstallment.create({ data: { loanId, sequence: ++seq, year: m.year, month: m.month, principalPart: paid, interestPart: 0, totalAmount: paid, balanceAfter: remaining, status: opts.paidNow!.status, deductedAt: new Date() } }));
  }
  let emi = 0;
  if (remaining > 0) {
    const s = buildLoanSchedule({ principal: remaining, installments: count, interestType: loan.interestType, annualRate: Number(loan.interestRate), startYear: first.year, startMonth: first.month });
    emi = s.emi.toNumber();
    ops.push(prisma.loanInstallment.createMany({ data: s.installments.map((i) => ({ loanId, sequence: ++seq, year: i.year, month: i.month, principalPart: i.principalPart.toNumber(), interestPart: i.interestPart.toNumber(), totalAmount: i.totalAmount.toNumber(), balanceAfter: i.balanceAfter.toNumber() })) }));
    ops.push(prisma.loan.update({ where: { id: loanId }, data: { emiAmount: emi } }));
  }
  await prisma.$transaction(ops);
  await syncLoanBalance(loanId);
  return { remaining, emi, count: remaining > 0 ? count : 0 };
}

export type LoanAdjustmentKind = "PREPAYMENT" | "SETTLEMENT" | "RESCHEDULE" | "SKIP" | "BALANCE";

/** Carry out an adjustment now. */
export async function executeLoanAdjustment(loanId: string, kind: LoanAdjustmentKind, amount: number | null, details: Record<string, unknown>): Promise<R> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan || !OPEN.includes(loan.status)) return { ok: false, message: "Only an active loan can be adjusted." };
  switch (kind) {
    case "SETTLEMENT": return forecloseLoan(loanId);
    case "SKIP": return skipInstallment(loanId, Number(details.year), Number(details.month));
    case "RESCHEDULE": {
      const n = Number(details.installments);
      if (!(n >= 1 && n <= 120)) return { ok: false, message: "Reschedule over 1–120 months." };
      const r = await rebuildRemaining(loanId, { installments: n });
      return { ok: true, message: `Rescheduled ₹${r.remaining.toLocaleString("en-IN")} over ${r.count} month(s): EMI ₹${r.emi.toLocaleString("en-IN")}.` };
    }
    case "PREPAYMENT": {
      if (!(amount && amount > 0)) return { ok: false, message: "Enter the amount paid." };
      const keepTenure = details.keep === "TENURE";
      const before = await prisma.loanInstallment.count({ where: { loanId, status: "SCHEDULED" } });
      // Default: keep the EMI and finish sooner; or keep the tenure and lower the EMI.
      const shorter = Math.max(1, Math.ceil((Number(loan.outstanding) - amount) / Math.max(1, Number(loan.emiAmount))));
      const r = await rebuildRemaining(loanId, { paidNow: { amount, status: "PREPAID" }, installments: keepTenure ? before : Math.min(before || 1, shorter) });
      return { ok: true, message: r.remaining > 0 ? `₹${amount.toLocaleString("en-IN")} prepaid; ₹${r.remaining.toLocaleString("en-IN")} left over ${r.count} EMI(s) of ₹${r.emi.toLocaleString("en-IN")}.` : "Prepaid in full; the loan is closed." };
    }
    case "BALANCE": {
      if (!(amount && amount > 0)) return { ok: false, message: "Enter the amount to write down." };
      const r = await rebuildRemaining(loanId, { paidNow: { amount, status: "WAIVED" } });
      return { ok: true, message: `Balance reduced by ₹${amount.toLocaleString("en-IN")}; ₹${r.remaining.toLocaleString("en-IN")} left${r.count ? `, EMI ₹${r.emi.toLocaleString("en-IN")}` : ""}.` };
    }
  }
}

/** An administrator's adjustment, applied at once and recorded. */
export async function adminLoanAdjustment(input: { tenantId: string; loanId: string; kind: LoanAdjustmentKind; amount: number | null; details: Record<string, unknown>; reason: string; actorUserId: string }): Promise<R> {
  if (!input.reason.trim()) return { ok: false, message: "Give a reason for the adjustment." };
  const loan = await prisma.loan.findFirst({ where: { id: input.loanId, employee: { tenantId: input.tenantId } } });
  if (!loan) return { ok: false, message: "Loan not found." };
  const res = await executeLoanAdjustment(loan.id, input.kind, input.amount, input.details);
  await prisma.loanAdjustment.create({ data: { tenantId: input.tenantId, loanId: loan.id, kind: input.kind, amount: input.amount, details: input.details as Prisma.InputJsonValue, reason: input.reason, status: res.ok ? "APPLIED" : "REJECTED", requestedBy: input.actorUserId, result: res.message, appliedAt: res.ok ? new Date() : null } });
  return res;
}

/** The employee asks; a loan approver decides through the workflow. */
export async function requestLoanAdjustment(input: { loanId: string; employeeId: string; requesterUserId: string; kind: Exclude<LoanAdjustmentKind, "BALANCE">; amount: number | null; details: Record<string, unknown>; reason: string }): Promise<R & { id?: string }> {
  const loan = await prisma.loan.findFirst({ where: { id: input.loanId, employeeId: input.employeeId }, include: { employee: { select: { tenantId: true, displayName: true } }, category: { select: { name: true } } } });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (!OPEN.includes(loan.status)) return { ok: false, message: "Only an active loan can be changed." };
  if (!input.reason.trim()) return { ok: false, message: "Say why." };
  if (input.kind === "PREPAYMENT" && !(input.amount && input.amount > 0 && input.amount < Number(loan.outstanding))) return { ok: false, message: `Prepay between ₹1 and less than the ₹${Number(loan.outstanding).toLocaleString("en-IN")} outstanding (or ask to settle in full).` };
  if (input.kind === "RESCHEDULE" && !(Number(input.details.installments) >= 1 && Number(input.details.installments) <= 120)) return { ok: false, message: "Reschedule over 1–120 months." };
  if (input.kind === "SKIP" && !(Number(input.details.year) > 2000 && Number(input.details.month) >= 1 && Number(input.details.month) <= 12)) return { ok: false, message: "Pick the month to skip." };
  const t = loan.employee.tenantId;
  if (await prisma.loanAdjustment.findFirst({ where: { tenantId: t, loanId: loan.id, status: "PENDING" } })) return { ok: false, message: "A request on this loan is already waiting for a decision." };
  const label = { PREPAYMENT: `Prepay ₹${(input.amount ?? 0).toLocaleString("en-IN")}`, SETTLEMENT: `Settle in full (₹${Number(loan.outstanding).toLocaleString("en-IN")})`, RESCHEDULE: `Reschedule over ${input.details.installments} month(s)`, SKIP: `Skip the ${input.details.month}/${input.details.year} EMI` }[input.kind];
  const adj = await prisma.loanAdjustment.create({ data: { tenantId: t, loanId: loan.id, kind: input.kind, amount: input.kind === "SETTLEMENT" ? Number(loan.outstanding) : input.amount, details: input.details as Prisma.InputJsonValue, reason: input.reason.trim(), requestedBy: input.requesterUserId } });
  const wf = await startWorkflow({ tenantId: t, entityType: "LOAN_ADJUSTMENT", entityId: adj.id, title: `${loan.employee.displayName}: ${label} — ${loan.category.name}`, details: input.reason, amount: input.kind === "SETTLEMENT" ? Number(loan.outstanding) : input.amount, category: input.kind, requesterUserId: input.requesterUserId, subjectEmployeeId: input.employeeId });
  if (!wf.ok) { await prisma.loanAdjustment.delete({ where: { id: adj.id } }); return wf; }
  await prisma.loanAdjustment.updateMany({ where: { id: adj.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: adj.id, message: `${label}: ${wf.message}` };
}

export async function applyLoanAdjustmentDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const adj = await prisma.loanAdjustment.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!adj) return;
  if (outcome !== "APPROVED") { await prisma.loanAdjustment.update({ where: { id }, data: { status: outcome } }); return; }
  const res = await executeLoanAdjustment(adj.loanId, adj.kind as LoanAdjustmentKind, adj.amount === null ? null : Number(adj.amount), (adj.details ?? {}) as Record<string, unknown>);
  if (!res.ok) throw new Error(res.message);
  await prisma.loanAdjustment.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date(), result: res.message } });
  await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "Loan", entityId: adj.loanId, summary: `${adj.kind.toLowerCase()} approved: ${res.message}` });
}

// ---------------------------------------------------------------------------
//  Overdue alerts, statements, portfolio
// ---------------------------------------------------------------------------

/** The last payroll month closed for each pay group. */
async function closedThroughByGroup(tenantId: string): Promise<Map<string, { year: number; month: number }>> {
  const runs = await prisma.payrollRun.findMany({ where: { payGroup: { tenantId }, type: "REGULAR", status: { in: ["FINALIZED", "LOCKED"] }, rolledBackAt: null }, select: { payGroupId: true, year: true, month: true } });
  const m = new Map<string, { year: number; month: number }>();
  for (const r of runs) { const c = m.get(r.payGroupId); if (!c || moneyMonthIndex(r.year, r.month) > moneyMonthIndex(c.year, c.month)) m.set(r.payGroupId, { year: r.year, month: r.month }); }
  return m;
}

/** Alert employees and loan administrators about EMIs whose payroll month closed without a deduction. Once per instalment. */
export async function runLoanOverdueAlerts(tenantId: string): Promise<{ alerted: number; loans: number }> {
  const closed = await closedThroughByGroup(tenantId);
  const loans = await prisma.loan.findMany({ where: { employee: { tenantId }, status: { in: ["ACTIVE", "DISBURSED"] } }, include: { schedule: true, employee: { select: { userId: true, displayName: true, payGroupId: true } }, category: { select: { name: true } } } });
  const admins = await usersWithPermission(tenantId, "payroll.loan.manage");
  let alerted = 0, touched = 0;
  for (const l of loans) {
    const due = overdueInstallments(l.schedule, l.employee.payGroupId ? closed.get(l.employee.payGroupId) ?? null : null).filter((i) => !i.overdueAlertedAt);
    if (!due.length) continue;
    touched++;
    const amount = r2(due.reduce((s, i) => s + Number(i.totalAmount), 0));
    await notify({ tenantId, userIds: [l.employee.userId, ...admins], kind: "LOAN", title: `${l.employee.displayName}: ${due.length} ${l.category.name} EMI(s) overdue`, body: `₹${amount.toLocaleString("en-IN")} not recovered for ${due.map((i) => `${i.month}/${i.year}`).join(", ")}.`, link: `/payroll/loans/${l.id}` });
    await prisma.loanInstallment.updateMany({ where: { id: { in: due.map((i) => i.id) } }, data: { overdueAlertedAt: new Date() } });
    alerted += due.length;
  }
  return { alerted, loans: touched };
}

/** A loan statement: every movement with the running balance. */
export async function loanStatement(tenantId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, employee: { tenantId } }, include: { schedule: { orderBy: [{ year: "asc" }, { month: "asc" }, { sequence: "asc" }] }, employee: { select: { displayName: true, employeeNumber: true } }, category: { select: { name: true, code: true } } } });
  if (!loan) return null;
  const tranches = await prisma.loanTranche.findMany({ where: { loanId }, orderBy: { sequence: "asc" } });
  const adjustments = await prisma.loanAdjustment.findMany({ where: { loanId, tenantId }, orderBy: { createdAt: "asc" } });
  let balance = Number(loan.principal);
  const lines = loan.schedule.map((i) => {
    const moved = ["DEDUCTED", "PREPAID", "WAIVED"].includes(i.status) ? Number(i.principalPart) : 0;
    balance = r2(balance - moved);
    return { period: `${String(i.month).padStart(2, "0")}/${i.year}`, sequence: i.sequence, status: i.status, principal: Number(i.principalPart), interest: Number(i.interestPart), total: Number(i.totalAmount), balance: moved ? balance : null, when: i.deductedAt };
  });
  return {
    loan, tranches, adjustments, lines,
    totals: { principal: Number(loan.principal), repaid: Number(loan.totalRepaid), outstanding: Number(loan.outstanding), interestPaid: r2(loan.schedule.filter((i) => i.status === "DEDUCTED").reduce((s, i) => s + Number(i.interestPart), 0)), fee: Number(loan.processingFee) },
    head: ["Period", "#", "Status", "Principal", "Interest", "Instalment", "Balance after", "Recovered on"],
    rows: lines.map((l) => [l.period, l.sequence, l.status, l.principal, l.interest, l.total, l.balance ?? "", l.when]),
  };
}

/** The loan book: outstanding by category and status, aging of overdue amounts. */
export async function loanPortfolio(tenantId: string) {
  const closed = await closedThroughByGroup(tenantId);
  const loans = await prisma.loan.findMany({ where: { employee: { tenantId } }, include: { schedule: true, category: { select: { name: true } }, employee: { select: { payGroupId: true } } } });
  const live = loans.filter((l) => OPEN.includes(l.status));
  const byCategory = new Map<string, { count: number; principal: number; outstanding: number }>();
  for (const l of live) { const b = byCategory.get(l.category.name) ?? { count: 0, principal: 0, outstanding: 0 }; b.count++; b.principal += Number(l.principal); b.outstanding += Number(l.outstanding); byCategory.set(l.category.name, b); }
  const byStatus: Record<string, number> = {};
  for (const l of loans) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  const aging = loanAging(live.map((l) => ({ outstanding: Number(l.outstanding), overdueMonths: overdueInstallments(l.schedule, l.employee.payGroupId ? closed.get(l.employee.payGroupId) ?? null : null).length })));
  const now = new Date();
  const thisMonth = moneyMonthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const next12 = Array.from({ length: 12 }, (_, k) => { const idx = thisMonth + k; const y = Math.floor(idx / 12), m = (idx % 12) + 1; return { label: `${String(m).padStart(2, "0")}/${y}`, amount: r2(live.flatMap((l) => l.schedule).filter((i) => i.status === "SCHEDULED" && i.year === y && i.month === m).reduce((s, i) => s + Number(i.totalAmount), 0)) }; });
  return {
    active: live.length, outstanding: r2(live.reduce((s, l) => s + Number(l.outstanding), 0)), disbursedYtd: r2(loans.filter((l) => l.disbursedAt && l.disbursedAt.getUTCFullYear() === now.getUTCFullYear()).reduce((s, l) => s + Number(l.principal), 0)),
    pending: loans.filter((l) => ["REQUESTED", "PENDING_APPROVAL"].includes(l.status)).length, fees: r2(loans.reduce((s, l) => s + Number(l.processingFee), 0)),
    byCategory: [...byCategory.entries()].map(([name, b]) => ({ name, ...b, principal: r2(b.principal), outstanding: r2(b.outstanding) })), byStatus, aging, next12,
  };
}

/** Rows for the cash-advance, loan-settlement and adjustment reports. */
export async function moneyLoanReport(tenantId: string, kind: "advances" | "settlements" | "adjustments") {
  if (kind === "advances") {
    const rows = await prisma.cashAdvance.findMany({ where: { tenantId }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } });
    return { title: "Cash advances", head: ["Employee", "Number", "Purpose", "Amount", "Status", "Requested", "Approved", "Disbursed", "Settled", "Outstanding"], rows: rows.map((a) => [a.employee.displayName, a.employee.employeeNumber, a.purpose, Number(a.amount), a.status, a.createdAt, a.approvedAt, a.disbursedAt, Number(a.settledAmount), Number(a.outstanding)]) };
  }
  const adj = await prisma.loanAdjustment.findMany({ where: { tenantId, ...(kind === "settlements" ? { kind: { in: ["SETTLEMENT", "PREPAYMENT"] } } : {}) }, orderBy: { createdAt: "desc" } });
  const loans = new Map((await prisma.loan.findMany({ where: { id: { in: adj.map((a) => a.loanId) } }, include: { employee: { select: { displayName: true } }, category: { select: { name: true } } } })).map((l) => [l.id, l]));
  const fore = kind === "settlements" ? await prisma.loan.findMany({ where: { employee: { tenantId }, status: "FORECLOSED", id: { notIn: adj.map((a) => a.loanId) } }, include: { employee: { select: { displayName: true } }, category: { select: { name: true } } } }) : [];
  return {
    title: kind === "settlements" ? "Loan settlements and prepayments" : "Loan adjustments",
    head: ["Employee", "Loan", "Kind", "Amount", "Reason", "Status", "Requested", "Applied", "Result"],
    rows: [
      ...adj.map((a) => [loans.get(a.loanId)?.employee.displayName, loans.get(a.loanId)?.category.name, a.kind, a.amount === null ? "" : Number(a.amount), a.reason, a.status, a.createdAt, a.appliedAt, a.result ?? ""]),
      ...fore.map((l) => [l.employee.displayName, l.category.name, "FORECLOSURE", Number(l.principal) - Number(l.totalRepaid), "Foreclosed by the loan desk", "APPLIED", l.closedAt, l.closedAt, ""]),
    ],
  };
}

// ---------------------------------------------------------------------------
//  Approval delegation for expense claims and loans
// ---------------------------------------------------------------------------

export const MONEY_DELEGATION_TYPES = { EXPENSE_CLAIM: "Expense claim approvals", LOAN_REQUEST: "Loan approvals" } as const;

/** Hand my expense-claim or loan approvals to a colleague while I am away. */
export async function delegateMoneyApprovals(input: { tenantId: string; delegatorUserId: string; delegateUserId: string; type: keyof typeof MONEY_DELEGATION_TYPES; startsOn: Date; endsOn: Date; reason: string | null; actorUserId: string }): Promise<R> {
  if (input.delegatorUserId === input.delegateUserId) return { ok: false, message: "Pick someone else." };
  if (input.endsOn < input.startsOn) return { ok: false, message: "The end date is before the start." };
  if ((input.endsOn.getTime() - input.startsOn.getTime()) / 86_400_000 > 180) return { ok: false, message: "Delegate for up to 180 days at a time." };
  const delegate = await prisma.user.findFirst({ where: { id: input.delegateUserId, tenantId: input.tenantId, loginDisabled: false }, select: { id: true, email: true } });
  if (!delegate) return { ok: false, message: "That person was not found." };
  const d = await prisma.approverDelegation.create({ data: { tenantId: input.tenantId, delegatorUserId: input.delegatorUserId, delegateUserId: delegate.id, startsOn: input.startsOn, endsOn: input.endsOn, entityTypes: [input.type], reason: input.reason } });
  await moneyAudit(input.tenantId, input.actorUserId, { module: input.type === "LOAN_REQUEST" ? "PAYROLL" : "FINANCE", action: "CREATE", entityType: "ApproverDelegation", entityId: d.id, summary: `${MONEY_DELEGATION_TYPES[input.type]} delegated to ${delegate.email} until ${input.endsOn.toISOString().slice(0, 10)}` });
  await notify({ tenantId: input.tenantId, userIds: [delegate.id], kind: input.type === "LOAN_REQUEST" ? "LOAN" : "EXPENSE", title: `${MONEY_DELEGATION_TYPES[input.type]} delegated to you`, link: input.type === "LOAN_REQUEST" ? "/payroll/loans" : "/expenses?tab=approvals" });
  return { ok: true, message: `${MONEY_DELEGATION_TYPES[input.type]} go to ${delegate.email} until ${input.endsOn.toISOString().slice(0, 10)}.` };
}

/** Who has delegated this kind of approval to the user, today. */
export async function delegatorsOf(tenantId: string, delegateUserId: string, type: keyof typeof MONEY_DELEGATION_TYPES, at = new Date()): Promise<string[]> {
  const rows = await prisma.approverDelegation.findMany({ where: { tenantId, delegateUserId, revokedAt: null, startsOn: { lte: at }, endsOn: { gte: at } } });
  return rows.filter((r) => r.entityTypes.length === 0 || r.entityTypes.includes(type)).map((r) => r.delegatorUserId);
}
