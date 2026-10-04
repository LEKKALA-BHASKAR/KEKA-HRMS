import { prisma, Prisma } from "@keka/db";
import { resolveStructure, selectStructureForCtc } from "@keka/payroll";
import { notify, specsOf } from "./lifecycle";
import { startWorkflow } from "./workflow-engine";
import { moneyAudit } from "./money-audit";
import { applySalaryRevision } from "./salary-revisions";
import {
  adjustedRange, compaRatio, compGuardrailBreaches, compIncrease, compIneligibility, marketAdjustmentPct, meritPctFor, parseMeritMatrix,
  payEquityGap, poolUsage, prorationFactor, rangePenetration, type CompEligibility, type CompGuardrails, type MeritBand,
} from "./money-math";

/**
 * Compensation planning: a round (plan) built from a template, a merit
 * matrix on review ratings, proration for joiners, promotions and market
 * adjustments to the pay range, guardrails with an exception path, budget
 * pools per manager, calibration with a decision log, approval of the whole
 * round, then salary revisions and total-rewards statements. Also pay
 * ranges (approved changes, location differentials, compa-ratios), pay
 * equity cohorts and one-off allowance changes.
 */

type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const json = (v: unknown) => (v ?? undefined) as Prisma.InputJsonValue | undefined;

// ---------------------------------------------------------------------------
//  Templates and plans
// ---------------------------------------------------------------------------

export interface CompSettings { meritMatrix: MeritBand[]; defaultPct: number; guardrails?: CompGuardrails | null; eligibility?: CompEligibility | null; budgetPct: number; prorate: boolean }

function settingsProblem(s: CompSettings): string | null {
  for (const b of s.meritMatrix) {
    if (b.minRating > b.maxRating) return `A merit band runs ${b.minRating}–${b.maxRating}.`;
    if (b.pct < 0 || b.pct > 100) return "Merit percentages run 0–100.";
  }
  const sorted = [...s.meritMatrix].sort((a, b) => a.minRating - b.minRating);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.minRating <= sorted[i - 1]!.maxRating) return "Merit bands overlap.";
  if (s.budgetPct < 0 || s.budgetPct > 100) return "The budget is 0–100% of payroll.";
  const g = s.guardrails;
  if (g?.minPct !== null && g?.minPct !== undefined && g?.maxPct !== null && g?.maxPct !== undefined && g.minPct > g.maxPct) return "The guardrail floor is above the ceiling.";
  return null;
}

export async function saveCompTemplate(input: { tenantId: string; id?: string | null; name: string; actorUserId: string } & CompSettings): Promise<R & { id?: string }> {
  const bad = settingsProblem(input);
  if (bad) return { ok: false, message: bad };
  const data = { name: input.name.trim(), meritMatrix: input.meritMatrix as unknown as Prisma.InputJsonValue, defaultPct: input.defaultPct, guardrails: json(input.guardrails), eligibility: json(input.eligibility), budgetPct: input.budgetPct, prorate: input.prorate };
  if (await prisma.compPlanTemplate.findFirst({ where: { tenantId: input.tenantId, name: data.name, ...(input.id ? { id: { not: input.id } } : {}) } })) return { ok: false, message: "A template with that name exists." };
  if (input.id) {
    const u = await prisma.compPlanTemplate.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
    return u.count ? { ok: true, id: input.id, message: "Template saved." } : { ok: false, message: "Template not found." };
  }
  const t = await prisma.compPlanTemplate.create({ data: { ...data, tenantId: input.tenantId, createdBy: input.actorUserId } });
  return { ok: true, id: t.id, message: "Template saved." };
}

export async function createCompPlan(input: { tenantId: string; name: string; templateId?: string | null; reviewCycleId?: string | null; effectiveDate: Date; periodStart: Date; actorUserId: string } & Partial<CompSettings>): Promise<R & { id?: string }> {
  if (input.periodStart >= input.effectiveDate) return { ok: false, message: "The review period must start before the effective date." };
  const t = input.templateId ? await prisma.compPlanTemplate.findFirst({ where: { id: input.templateId, tenantId: input.tenantId } }) : null;
  if (input.templateId && !t) return { ok: false, message: "Template not found." };
  if (input.reviewCycleId && !(await prisma.reviewCycle.findFirst({ where: { id: input.reviewCycleId, tenantId: input.tenantId } }))) return { ok: false, message: "Review cycle not found." };
  const s: CompSettings = {
    meritMatrix: input.meritMatrix ?? parseMeritMatrix(t?.meritMatrix), defaultPct: input.defaultPct ?? num(t?.defaultPct) ?? 0,
    guardrails: input.guardrails ?? (t?.guardrails as CompGuardrails | null) ?? null, eligibility: input.eligibility ?? (t?.eligibility as CompEligibility | null) ?? null,
    budgetPct: input.budgetPct ?? num(t?.budgetPct) ?? 0, prorate: input.prorate ?? t?.prorate ?? true,
  };
  const bad = settingsProblem(s);
  if (bad) return { ok: false, message: bad };
  const p = await prisma.compPlan.create({
    data: {
      tenantId: input.tenantId, name: input.name.trim(), templateId: t?.id ?? null, reviewCycleId: input.reviewCycleId ?? null, effectiveDate: input.effectiveDate, periodStart: input.periodStart,
      meritMatrix: s.meritMatrix as unknown as Prisma.InputJsonValue, defaultPct: s.defaultPct, guardrails: json(s.guardrails), eligibility: json(s.eligibility), budgetPct: s.budgetPct, prorate: s.prorate, createdBy: input.actorUserId,
    },
  });
  await logDecision(input.tenantId, p.id, null, null, "PLAN_CREATED", null, { name: p.name, template: t?.name ?? null }, null, input.actorUserId);
  return { ok: true, id: p.id, message: `${p.name} created. Build the worksheet to bring employees in.` };
}

export async function updateCompPlanSettings(input: { tenantId: string; planId: string; actorUserId: string } & CompSettings): Promise<R> {
  const p = await prisma.compPlan.findFirst({ where: { id: input.planId, tenantId: input.tenantId } });
  if (!p) return { ok: false, message: "Plan not found." };
  if (!["DRAFT", "PLANNING"].includes(p.status)) return { ok: false, message: "Settings are fixed once calibration starts." };
  const bad = settingsProblem(input);
  if (bad) return { ok: false, message: bad };
  await prisma.compPlan.update({ where: { id: p.id }, data: { meritMatrix: input.meritMatrix as unknown as Prisma.InputJsonValue, defaultPct: input.defaultPct, guardrails: json(input.guardrails), eligibility: json(input.eligibility), budgetPct: input.budgetPct, prorate: input.prorate } });
  await logDecision(input.tenantId, p.id, null, null, "SETTINGS", { meritMatrix: p.meritMatrix, defaultPct: Number(p.defaultPct), budgetPct: Number(p.budgetPct) }, { meritMatrix: input.meritMatrix, defaultPct: input.defaultPct, budgetPct: input.budgetPct }, null, input.actorUserId);
  return { ok: true, message: "Settings saved. Rebuild the worksheet to apply them to lines not yet edited." };
}

async function logDecision(tenantId: string, planId: string, itemId: string | null, sessionId: string | null, action: string, before: unknown, after: unknown, reason: string | null, actorUserId: string | null) {
  await prisma.compDecisionLog.create({ data: { tenantId, planId, itemId, sessionId, action, before: json(before), after: json(after), reason, actorUserId } });
}

// ---------------------------------------------------------------------------
//  Ranges
// ---------------------------------------------------------------------------

async function rangeFor(tenantId: string, payGradeId: string | null, locationId: string | null) {
  if (!payGradeId) return { min: null, mid: null, max: null };
  const g = await prisma.payGrade.findFirst({ where: { id: payGradeId, tenantId } });
  if (!g) return { min: null, mid: null, max: null };
  const diff = locationId ? await prisma.locationPayDifferential.findUnique({ where: { tenantId_locationId: { tenantId, locationId } } }) : null;
  return adjustedRange({ min: num(g.minAnnual), mid: num(g.midAnnual), max: num(g.maxAnnual) }, Number(diff?.pct ?? 0));
}

const CURRENT = { where: { status: "APPLIED" as const }, orderBy: { effectiveFrom: "desc" as const }, take: 3, select: { annualCtc: true, previousCtc: true, effectiveFrom: true } };

// ---------------------------------------------------------------------------
//  Worksheet
// ---------------------------------------------------------------------------

function computeLine(currentCtc: number, line: { meritPct: number; promotionPct: number; marketPct: number; prorationFactor: number }, range: { min: number | null; mid: number | null }) {
  const inc = compIncrease(currentCtc, line.meritPct, line.prorationFactor, line.promotionPct, line.marketPct);
  return { ...inc, compaBefore: compaRatio(currentCtc, range.mid), compaAfter: compaRatio(inc.newCtc, range.mid) };
}

/**
 * Bring every active employee into the plan: rating from the review cycle,
 * merit from the matrix, proration for joiners in the period, and a market
 * adjustment that lifts anyone below their range minimum. Lines already
 * edited by hand keep their numbers. Pools are set per manager.
 */
export async function buildCompPlanItems(tenantId: string, planId: string, actorUserId: string, employeeWhere: Prisma.EmployeeWhereInput = {}): Promise<R & { built?: number }> {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId } });
  if (!p) return { ok: false, message: "Plan not found." };
  if (!["DRAFT", "PLANNING"].includes(p.status)) return { ok: false, message: "The worksheet is fixed once calibration starts." };
  const matrix = parseMeritMatrix(p.meritMatrix);
  const emps = await prisma.employee.findMany({
    where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, ...employeeWhere },
    select: { id: true, dateOfJoining: true, status: true, payGradeId: true, locationId: true, reportingManagerId: true, salaryRevisions: CURRENT },
  });
  const ratings = p.reviewCycleId ? new Map((await prisma.employeeReview.findMany({ where: { cycleId: p.reviewCycleId }, select: { employeeId: true, finalRating: true, rawRating: true } })).map((r) => [r.employeeId, num(r.finalRating) ?? num(r.rawRating)])) : new Map<string, number | null>();
  const existing = new Map((await prisma.compPlanItem.findMany({ where: { planId } })).map((i) => [i.employeeId, i]));
  let built = 0;
  for (const e of emps) {
    const ctc = Number(e.salaryRevisions[0]?.annualCtc ?? 0);
    if (!(ctc > 0)) continue;
    const prev = existing.get(e.id);
    if (prev && (prev.status !== "DRAFT" || prev.updatedBy)) continue;
    const lastIncrease = e.salaryRevisions.find((r) => r.previousCtc !== null && Number(r.annualCtc) > Number(r.previousCtc))?.effectiveFrom ?? null;
    const why = compIneligibility(p.eligibility as CompEligibility | null, { dateOfJoining: e.dateOfJoining, status: e.status, lastIncreaseOn: lastIncrease }, p.effectiveDate);
    const rating = ratings.get(e.id) ?? null;
    const range = await rangeFor(tenantId, e.payGradeId, e.locationId);
    const merit = why ? 0 : meritPctFor(matrix, Number(p.defaultPct), rating);
    const proration = p.prorate ? prorationFactor(e.dateOfJoining, p.periodStart, p.effectiveDate) : 1;
    const afterMerit = Math.round(ctc * (1 + (merit * proration) / 100));
    const market = why ? 0 : marketAdjustmentPct(afterMerit, ctc, range.min);
    const calc = computeLine(ctc, { meritPct: merit, promotionPct: 0, marketPct: market, prorationFactor: proration }, range);
    const data = {
      ownerEmployeeId: e.reportingManagerId, currentCtc: ctc, rating, eligible: !why, ineligibleReason: why, meritPct: merit, promotionPct: 0, marketPct: market,
      prorationFactor: proration, totalPct: calc.totalPct, newCtc: calc.newCtc, compaBefore: calc.compaBefore, compaAfter: calc.compaAfter,
    };
    if (prev) await prisma.compPlanItem.update({ where: { id: prev.id }, data });
    else await prisma.compPlanItem.create({ data: { ...data, tenantId, planId, employeeId: e.id } });
    built++;
  }
  // A pool per manager: the budget % of their eligible team's payroll.
  const items = await prisma.compPlanItem.findMany({ where: { planId, eligible: true, ownerEmployeeId: { not: null } } });
  const byOwner = new Map<string, number>();
  for (const i of items) byOwner.set(i.ownerEmployeeId!, (byOwner.get(i.ownerEmployeeId!) ?? 0) + Number(i.currentCtc));
  for (const [owner, payroll] of byOwner) {
    const amount = r2((payroll * Number(p.budgetPct)) / 100);
    const pool = await prisma.compBudgetPool.findUnique({ where: { planId_ownerEmployeeId: { planId, ownerEmployeeId: owner } } });
    if (!pool) await prisma.compBudgetPool.create({ data: { tenantId, planId, ownerEmployeeId: owner, amount } });
    else if (!(await prisma.compPoolTransfer.count({ where: { OR: [{ fromPoolId: pool.id }, { toPoolId: pool.id }] } }))) await prisma.compBudgetPool.update({ where: { id: pool.id }, data: { amount } });
  }
  await prisma.compPlan.update({ where: { id: planId }, data: { status: "PLANNING" } });
  await logDecision(tenantId, planId, null, null, "WORKSHEET_BUILT", null, { lines: built, pools: byOwner.size }, null, actorUserId);
  return { ok: true, built, message: `${built} line(s) on the worksheet; ${byOwner.size} manager pool(s) at ${Number(p.budgetPct)}% of payroll.` };
}

/** Change a line. Managers edit their own team while planning; admins edit through calibration. */
export async function updateCompItem(input: {
  tenantId: string; itemId: string; meritPct: number; promotionPct: number; marketPct: number; newPayGradeId?: string | null; note?: string | null;
  actorUserId: string; actorEmployeeId: string | null; asAdmin: boolean; sessionId?: string | null;
}): Promise<R & { breaches?: string[] }> {
  const item = await prisma.compPlanItem.findFirst({ where: { id: input.itemId, tenantId: input.tenantId }, include: { plan: true, employee: { select: { payGradeId: true, locationId: true, displayName: true } } } });
  if (!item) return { ok: false, message: "Line not found." };
  const p = item.plan;
  if (input.asAdmin ? !["PLANNING", "CALIBRATION"].includes(p.status) : p.status !== "PLANNING") return { ok: false, message: input.asAdmin ? "The plan is no longer open for changes." : "Managers edit the worksheet while the plan is in planning." };
  if (!input.asAdmin && item.ownerEmployeeId !== input.actorEmployeeId) return { ok: false, message: "This employee is not on your worksheet." };
  if (!item.eligible) return { ok: false, message: `Not eligible: ${item.ineligibleReason ?? ""}`.trim() };
  if (item.status !== "DRAFT") return { ok: false, message: "This line is closed." };
  if ([input.meritPct, input.promotionPct, input.marketPct].some((x) => x < 0 || x > 100)) return { ok: false, message: "Percentages run 0–100." };
  if (input.promotionPct > 0 && !input.newPayGradeId && !input.note?.trim()) return { ok: false, message: "A promotion increase needs the new grade or a note." };
  if (input.newPayGradeId && !(await prisma.payGrade.findFirst({ where: { id: input.newPayGradeId, tenantId: input.tenantId } }))) return { ok: false, message: "Pay grade not found." };
  if (input.sessionId && !(await prisma.compCalibrationSession.findFirst({ where: { id: input.sessionId, planId: p.id, status: "OPEN" } }))) return { ok: false, message: "That calibration session is closed." };
  const range = await rangeFor(input.tenantId, input.newPayGradeId ?? item.employee.payGradeId, item.employee.locationId);
  const ctc = Number(item.currentCtc);
  const calc = computeLine(ctc, { meritPct: input.meritPct, promotionPct: input.promotionPct, marketPct: input.marketPct, prorationFactor: Number(item.prorationFactor) }, range);
  // Manager pool: the change may not take the pool over budget.
  if (!input.asAdmin && item.ownerEmployeeId) {
    const pool = await prisma.compBudgetPool.findUnique({ where: { planId_ownerEmployeeId: { planId: p.id, ownerEmployeeId: item.ownerEmployeeId } } });
    if (pool) {
      const others = await prisma.compPlanItem.findMany({ where: { planId: p.id, ownerEmployeeId: item.ownerEmployeeId, id: { not: item.id } } });
      const use = poolUsage([{ id: pool.id, ownerEmployeeId: pool.ownerEmployeeId, amount: Number(pool.amount) }], [...others.map((o) => ({ ownerEmployeeId: o.ownerEmployeeId, currentCtc: Number(o.currentCtc), newCtc: Number(o.newCtc), status: o.status })), { ownerEmployeeId: item.ownerEmployeeId, currentCtc: ctc, newCtc: calc.newCtc, status: "DRAFT" }])[0]!;
      if (use.over) return { ok: false, message: `That takes your pool over budget by ₹${Math.abs(use.left).toLocaleString("en-IN")}. Ask HR to move budget to you.` };
    }
  }
  const before = { meritPct: Number(item.meritPct), promotionPct: Number(item.promotionPct), marketPct: Number(item.marketPct), totalPct: Number(item.totalPct), newCtc: Number(item.newCtc), newPayGradeId: item.newPayGradeId };
  const after = { meritPct: input.meritPct, promotionPct: input.promotionPct, marketPct: input.marketPct, totalPct: calc.totalPct, newCtc: calc.newCtc, newPayGradeId: input.newPayGradeId ?? null };
  const breaches = compGuardrailBreaches(p.guardrails as CompGuardrails | null, { totalPct: calc.totalPct, promotionPct: input.promotionPct, note: input.note ?? null });
  const changedBreach = breaches.length && (before.totalPct !== after.totalPct || before.promotionPct !== after.promotionPct);
  await prisma.compPlanItem.update({
    where: { id: item.id },
    data: { ...after, compaBefore: calc.compaBefore, compaAfter: calc.compaAfter, note: input.note?.trim() || null, updatedBy: input.actorUserId, ...(changedBreach || !breaches.length ? { exceptionStatus: "NONE", exceptionWorkflowId: null } : {}) },
  });
  await logDecision(input.tenantId, p.id, item.id, input.sessionId ?? null, input.sessionId ? "CALIBRATED" : "LINE_EDITED", before, after, input.note ?? null, input.actorUserId);
  return { ok: true, breaches, message: `${item.employee.displayName}: ${calc.totalPct}% → ₹${calc.newCtc.toLocaleString("en-IN")}.${breaches.length ? ` Outside the guardrails: ${breaches.join(" ")} Request an exception.` : ""}` };
}

export async function skipCompItem(tenantId: string, itemId: string, skip: boolean, reason: string | null, actorUserId: string): Promise<R> {
  const item = await prisma.compPlanItem.findFirst({ where: { id: itemId, tenantId }, include: { plan: { select: { status: true } } } });
  if (!item || !["PLANNING", "CALIBRATION"].includes(item.plan.status)) return { ok: false, message: "Line not found or the plan is closed." };
  if (item.status === "APPLIED") return { ok: false, message: "Already applied." };
  await prisma.compPlanItem.update({ where: { id: itemId }, data: { status: skip ? "SKIPPED" : "DRAFT", updatedBy: actorUserId } });
  await logDecision(tenantId, item.planId, itemId, null, skip ? "SKIPPED" : "UNSKIPPED", { status: item.status }, { status: skip ? "SKIPPED" : "DRAFT" }, reason, actorUserId);
  return { ok: true, message: skip ? "Left out of this round." : "Back on the worksheet." };
}

/** A line outside the guardrails goes to approval before the plan can be submitted. */
export async function requestCompException(tenantId: string, itemId: string, reason: string, requesterUserId: string): Promise<R> {
  const item = await prisma.compPlanItem.findFirst({ where: { id: itemId, tenantId }, include: { plan: true, employee: { select: { displayName: true } } } });
  if (!item) return { ok: false, message: "Line not found." };
  const breaches = compGuardrailBreaches(item.plan.guardrails as CompGuardrails | null, { totalPct: Number(item.totalPct), promotionPct: Number(item.promotionPct), note: item.note });
  if (!breaches.length) return { ok: false, message: "This line is within the guardrails." };
  if (item.exceptionStatus === "PENDING") return { ok: false, message: "An exception is already waiting." };
  if (!reason.trim()) return { ok: false, message: "Give the business reason." };
  await prisma.compPlanItem.update({ where: { id: itemId }, data: { exceptionStatus: "PENDING" } });
  const wf = await startWorkflow({ tenantId, entityType: "COMP_EXCEPTION", entityId: itemId, title: `Compensation exception: ${item.employee.displayName}, ${Number(item.totalPct)}% (${item.plan.name})`, details: `${reason.trim()} — ${breaches.join(" ")}`, amount: Number(item.newCtc) - Number(item.currentCtc), requesterUserId, subjectEmployeeId: item.employeeId });
  if (!wf.ok) { await prisma.compPlanItem.update({ where: { id: itemId }, data: { exceptionStatus: "NONE" } }); return wf; }
  await prisma.compPlanItem.updateMany({ where: { id: itemId, exceptionStatus: "PENDING" }, data: { exceptionWorkflowId: wf.requestId } });
  await logDecision(tenantId, item.planId, itemId, null, "EXCEPTION_REQUESTED", null, { breaches }, reason, requesterUserId);
  return { ok: true, message: wf.message };
}

export async function applyCompExceptionDecision(tenantId: string, itemId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const item = await prisma.compPlanItem.findFirst({ where: { id: itemId, tenantId, exceptionStatus: "PENDING" } });
  if (!item) return;
  const status = outcome === "APPROVED" ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "NONE";
  await prisma.compPlanItem.update({ where: { id: itemId }, data: { exceptionStatus: status } });
  await logDecision(tenantId, item.planId, itemId, null, `EXCEPTION_${outcome}`, null, { exceptionStatus: status }, null, actorUserId);
}

// ---------------------------------------------------------------------------
//  Budget pools
// ---------------------------------------------------------------------------

export async function compPoolStatus(tenantId: string, planId: string) {
  const [pools, items] = await Promise.all([prisma.compBudgetPool.findMany({ where: { tenantId, planId } }), prisma.compPlanItem.findMany({ where: { tenantId, planId } })]);
  const usage = poolUsage(pools.map((p) => ({ id: p.id, ownerEmployeeId: p.ownerEmployeeId, amount: Number(p.amount) })), items.map((i) => ({ ownerEmployeeId: i.ownerEmployeeId, currentCtc: Number(i.currentCtc), newCtc: Number(i.newCtc), status: i.status })));
  const owners = new Map((await prisma.employee.findMany({ where: { id: { in: pools.map((p) => p.ownerEmployeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return usage.map((u) => ({ ...u, ownerName: owners.get(u.ownerEmployeeId) ?? "" }));
}

export async function setPoolAmount(tenantId: string, poolId: string, amount: number, actorUserId: string): Promise<R> {
  const pool = await prisma.compBudgetPool.findFirst({ where: { id: poolId, tenantId } });
  if (!pool) return { ok: false, message: "Pool not found." };
  if (amount < 0) return { ok: false, message: "The amount cannot be negative." };
  await prisma.compBudgetPool.update({ where: { id: poolId }, data: { amount } });
  await logDecision(tenantId, pool.planId, null, null, "POOL_SET", { amount: Number(pool.amount) }, { amount, poolId }, null, actorUserId);
  return { ok: true, message: "Pool updated." };
}

/** Move budget between managers' pools, never below what a pool has already committed. */
export async function transferPoolBudget(input: { tenantId: string; planId: string; fromPoolId: string; toPoolId: string; amount: number; reason: string; byUserId: string }): Promise<R> {
  if (input.fromPoolId === input.toPoolId) return { ok: false, message: "Pick two different pools." };
  if (!(input.amount > 0)) return { ok: false, message: "Enter an amount above zero." };
  if (!input.reason.trim()) return { ok: false, message: "Give a reason for the transfer." };
  const usage = await compPoolStatus(input.tenantId, input.planId);
  const from = usage.find((u) => u.poolId === input.fromPoolId), to = usage.find((u) => u.poolId === input.toPoolId);
  if (!from || !to) return { ok: false, message: "Pool not found." };
  if (input.amount > from.left + 0.001) return { ok: false, message: `${from.ownerName}'s pool has only ₹${Math.max(0, from.left).toLocaleString("en-IN")} uncommitted.` };
  await prisma.$transaction([
    prisma.compBudgetPool.update({ where: { id: from.poolId }, data: { amount: { decrement: input.amount } } }),
    prisma.compBudgetPool.update({ where: { id: to.poolId }, data: { amount: { increment: input.amount } } }),
    prisma.compPoolTransfer.create({ data: { tenantId: input.tenantId, planId: input.planId, fromPoolId: from.poolId, toPoolId: to.poolId, amount: input.amount, reason: input.reason.trim(), byUserId: input.byUserId } }),
  ]);
  await logDecision(input.tenantId, input.planId, null, null, "POOL_TRANSFER", { from: from.ownerName, to: to.ownerName }, { amount: input.amount }, input.reason.trim(), input.byUserId);
  return { ok: true, message: `Moved ₹${input.amount.toLocaleString("en-IN")} from ${from.ownerName} to ${to.ownerName}.` };
}

// ---------------------------------------------------------------------------
//  Calibration and approval
// ---------------------------------------------------------------------------

export async function startCompCalibration(tenantId: string, planId: string, actorUserId: string): Promise<R> {
  const u = await prisma.compPlan.updateMany({ where: { id: planId, tenantId, status: "PLANNING" }, data: { status: "CALIBRATION" } });
  if (!u.count) return { ok: false, message: "Only a plan in planning moves to calibration." };
  await logDecision(tenantId, planId, null, null, "CALIBRATION_STARTED", null, null, null, actorUserId);
  return { ok: true, message: "Calibration started; managers can no longer edit." };
}

export async function createCalibrationSession(input: { tenantId: string; planId: string; name: string; scheduledAt: Date; departmentId?: string | null; notes?: string | null; actorUserId: string }): Promise<R & { id?: string }> {
  const p = await prisma.compPlan.findFirst({ where: { id: input.planId, tenantId: input.tenantId } });
  if (!p || !["PLANNING", "CALIBRATION"].includes(p.status)) return { ok: false, message: "Sessions are held while the plan is open." };
  const s = await prisma.compCalibrationSession.create({ data: { tenantId: input.tenantId, planId: p.id, name: input.name.trim(), scheduledAt: input.scheduledAt, departmentId: input.departmentId ?? null, notes: input.notes ?? null, createdBy: input.actorUserId } });
  return { ok: true, id: s.id, message: `Session ${s.name} scheduled.` };
}

export async function closeCalibrationSession(tenantId: string, sessionId: string, notes: string | null, actorUserId: string): Promise<R> {
  const s = await prisma.compCalibrationSession.findFirst({ where: { id: sessionId, tenantId, status: "OPEN" } });
  if (!s) return { ok: false, message: "Session not found or already closed." };
  const changes = await prisma.compDecisionLog.count({ where: { sessionId } });
  await prisma.compCalibrationSession.update({ where: { id: sessionId }, data: { status: "CLOSED", closedAt: new Date(), notes: notes ?? s.notes } });
  await logDecision(tenantId, s.planId, null, sessionId, "SESSION_CLOSED", null, { changes }, notes, actorUserId);
  return { ok: true, message: `Session closed with ${changes} change(s) recorded.` };
}

/** Lines still blocking submission: guardrail breaches without an approved exception. */
export async function compBlockers(tenantId: string, planId: string) {
  const p = await prisma.compPlan.findFirstOrThrow({ where: { id: planId, tenantId } });
  const items = await prisma.compPlanItem.findMany({ where: { planId, status: "DRAFT", eligible: true }, include: { employee: { select: { displayName: true } } } });
  return items.map((i) => ({ item: i, breaches: compGuardrailBreaches(p.guardrails as CompGuardrails | null, { totalPct: Number(i.totalPct), promotionPct: Number(i.promotionPct), note: i.note }) })).filter((x) => x.breaches.length && x.item.exceptionStatus !== "APPROVED");
}

export async function submitCompPlan(tenantId: string, planId: string, requesterUserId: string, employeeId: string | null): Promise<R> {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId } });
  if (!p || !["PLANNING", "CALIBRATION"].includes(p.status)) return { ok: false, message: "Only a plan in planning or calibration is submitted." };
  const blockers = await compBlockers(tenantId, planId);
  if (blockers.length) return { ok: false, message: `${blockers.length} line(s) are outside the guardrails without an approved exception: ${blockers.slice(0, 3).map((b) => b.item.employee.displayName).join(", ")}${blockers.length > 3 ? "…" : ""}.` };
  const items = await prisma.compPlanItem.findMany({ where: { planId, status: "DRAFT" } });
  const cost = r2(items.reduce((s, i) => s + Number(i.newCtc) - Number(i.currentCtc), 0));
  const prior = p.status;
  await prisma.compPlan.update({ where: { id: planId }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId, entityType: "COMP_PLAN", entityId: planId, title: `Approve compensation plan ${p.name}`, details: `${items.length} line(s), ₹${cost.toLocaleString("en-IN")} a year, effective ${p.effectiveDate.toISOString().slice(0, 10)}`, amount: cost, requesterUserId, subjectEmployeeId: employeeId });
  if (!wf.ok) { await prisma.compPlan.update({ where: { id: planId }, data: { status: prior } }); return wf; }
  await prisma.compPlan.updateMany({ where: { id: planId, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId } });
  await logDecision(tenantId, planId, null, null, "SUBMITTED", null, { lines: items.length, cost }, null, requesterUserId);
  return { ok: true, message: wf.message };
}

export async function applyCompPlanDecision(tenantId: string, planId: string, approved: boolean, actorUserId: string | null): Promise<void> {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId, status: "PENDING_APPROVAL" } });
  if (!p) return;
  await prisma.compPlan.update({ where: { id: planId }, data: approved ? { status: "APPROVED", approvedAt: new Date() } : { status: "CALIBRATION" } });
  await logDecision(tenantId, planId, null, null, approved ? "APPROVED" : "SENT_BACK", null, null, null, actorUserId);
}

/** Turn the approved plan into salary revisions (and grade changes for promotions). */
export async function applyCompPlan(tenantId: string, planId: string, actorUserId: string): Promise<R & { applied?: number; problems?: string[] }> {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId } });
  if (!p || p.status !== "APPROVED") return { ok: false, message: "Only an approved plan is applied." };
  const items = await prisma.compPlanItem.findMany({ where: { planId, status: "DRAFT", eligible: true }, include: { employee: { select: { id: true, displayName: true, employeeNumber: true, payGroupId: true, salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1 } } } } });
  let applied = 0;
  const problems: string[] = [];
  for (const i of items) {
    const e = i.employee, who = `${e.displayName} (${e.employeeNumber})`;
    const newCtc = Number(i.newCtc), prev = e.salaryRevisions[0];
    let revisionId: string | null = null;
    if (newCtc !== Number(i.currentCtc)) {
      if (await prisma.salaryRevision.count({ where: { employeeId: e.id, status: "PENDING_APPROVAL" } })) { problems.push(`${who}: another salary change is waiting`); continue; }
      const structures = e.payGroupId ? await prisma.salaryStructure.findMany({ where: { payGroupId: e.payGroupId, isActive: true }, select: { id: true, minAnnualCtc: true, maxAnnualCtc: true, isDefault: true } }) : [];
      const chosen = selectStructureForCtc(structures.map((s) => ({ ...s, minAnnualCtc: num(s.minAnnualCtc), maxAnnualCtc: num(s.maxAnnualCtc) })), newCtc);
      const structureId = chosen?.id ?? prev?.structureId ?? null;
      if (!structureId) { problems.push(`${who}: no salary structure covers ${newCtc}`); continue; }
      const rev = await prisma.salaryRevision.create({ data: { employeeId: e.id, structureId, effectiveFrom: p.effectiveDate, annualCtc: newCtc, previousCtc: Number(i.currentCtc), remunerationType: prev?.remunerationType ?? "MONTHLY", status: "APPROVED", approvedBy: actorUserId, approvedAt: new Date(), reason: `${p.name}: ${Number(i.totalPct)}%`, createdBy: actorUserId } });
      await prisma.$transaction((tx) => applySalaryRevision(rev.id, tx));
      revisionId = rev.id;
    }
    if (i.newPayGradeId) await prisma.employee.update({ where: { id: e.id }, data: { payGradeId: i.newPayGradeId } });
    await prisma.compPlanItem.update({ where: { id: i.id }, data: { status: "APPLIED", salaryRevisionId: revisionId } });
    applied++;
  }
  await prisma.compPlan.update({ where: { id: planId }, data: { status: "APPLIED", appliedAt: new Date() } });
  await logDecision(tenantId, planId, null, null, "APPLIED", null, { applied, problems }, null, actorUserId);
  await generateCompStatements(tenantId, planId);
  return { ok: true, applied, problems, message: `Applied ${applied} increase(s) effective ${p.effectiveDate.toISOString().slice(0, 10)}.${problems.length ? ` Not applied: ${problems.join("; ")}.` : ""} Statements are ready to publish.` };
}

// ---------------------------------------------------------------------------
//  Total-rewards statements
// ---------------------------------------------------------------------------

export interface CompStatementContent { plan: string; effectiveDate: string; currentCtc: number; newCtc: number; totalPct: number; meritPct: number; promotionPct: number; marketPct: number; components: Array<{ name: string; annual: number }>; benefits: Array<{ plan: string; employerAnnual: number }>; totalRewards: number }

export async function generateCompStatements(tenantId: string, planId: string): Promise<number> {
  const p = await prisma.compPlan.findFirstOrThrow({ where: { id: planId, tenantId } });
  const items = await prisma.compPlanItem.findMany({ where: { planId, status: "APPLIED" } });
  let n = 0;
  for (const i of items) {
    const rev = i.salaryRevisionId ? await prisma.salaryRevision.findUnique({ where: { id: i.salaryRevisionId }, include: { structure: { include: { components: { include: { component: true } } } } } }) : null;
    const components = rev?.structure ? resolveStructure({ annualCtc: Number(rev.annualCtc), components: specsOf(rev) }).components.filter((c) => !c.isOutsideCtc).map((c) => ({ name: c.name, annual: Number(c.annual) })) : [];
    const benefits = (await prisma.benefitEnrollment.findMany({ where: { employeeId: i.employeeId, status: "ACTIVE" }, include: { plan: { select: { name: true } } } })).map((b) => ({ plan: b.plan.name, employerAnnual: r2(Number(b.employerMonthly) * 12) }));
    const content: CompStatementContent = {
      plan: p.name, effectiveDate: p.effectiveDate.toISOString().slice(0, 10), currentCtc: Number(i.currentCtc), newCtc: Number(i.newCtc), totalPct: Number(i.totalPct),
      meritPct: r2(Number(i.meritPct) * Number(i.prorationFactor)), promotionPct: Number(i.promotionPct), marketPct: Number(i.marketPct), components, benefits,
      totalRewards: r2(Number(i.newCtc) + benefits.reduce((s, b) => s + b.employerAnnual, 0)),
    };
    await prisma.compStatement.upsert({ where: { planId_employeeId: { planId, employeeId: i.employeeId } }, create: { tenantId, planId, employeeId: i.employeeId, content: content as unknown as Prisma.InputJsonValue }, update: { content: content as unknown as Prisma.InputJsonValue } });
    n++;
  }
  return n;
}

export async function publishCompStatements(tenantId: string, planId: string): Promise<R> {
  const rows = await prisma.compStatement.findMany({ where: { tenantId, planId, publishedAt: null }, include: { employee: { select: { userId: true } } } });
  if (!rows.length) return { ok: false, message: "No unpublished statements." };
  await prisma.compStatement.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: new Date() } });
  await notify({ tenantId, userIds: rows.map((r) => r.employee.userId), kind: "COMPENSATION", title: "Your compensation statement is ready", body: "See your new pay and total rewards, and acknowledge it.", link: "/finances/compensation", email: true });
  return { ok: true, message: `Published ${rows.length} statement(s).` };
}

export async function acknowledgeCompStatement(employeeId: string, statementId: string): Promise<R> {
  const u = await prisma.compStatement.updateMany({ where: { id: statementId, employeeId, publishedAt: { not: null }, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
  return u.count ? { ok: true, message: "Acknowledged." } : { ok: false, message: "Statement not found or already acknowledged." };
}

// ---------------------------------------------------------------------------
//  Pay ranges
// ---------------------------------------------------------------------------

export async function proposePayRange(input: { tenantId: string; payGradeId: string; minAnnual: number; midAnnual: number; maxAnnual: number; reason: string; requesterUserId: string; employeeId: string | null }): Promise<R> {
  const g = await prisma.payGrade.findFirst({ where: { id: input.payGradeId, tenantId: input.tenantId } });
  if (!g) return { ok: false, message: "Pay grade not found." };
  if (!(input.minAnnual > 0 && input.minAnnual <= input.midAnnual && input.midAnnual <= input.maxAnnual)) return { ok: false, message: "The range must run minimum ≤ midpoint ≤ maximum, above zero." };
  if (!input.reason.trim()) return { ok: false, message: "Give the reason (market data, restructure…)." };
  if (await prisma.payRangeChange.findFirst({ where: { payGradeId: g.id, status: "PENDING" } })) return { ok: false, message: "A change to this grade is already waiting." };
  const row = await prisma.payRangeChange.create({ data: { tenantId: input.tenantId, payGradeId: g.id, minAnnual: input.minAnnual, midAnnual: input.midAnnual, maxAnnual: input.maxAnnual, reason: input.reason.trim(), requestedBy: input.requesterUserId } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "PAY_RANGE", entityId: row.id, title: `Pay range for ${g.name}: ${input.minAnnual.toLocaleString("en-IN")} – ${input.maxAnnual.toLocaleString("en-IN")}`, details: `Was ${num(g.minAnnual)?.toLocaleString("en-IN") ?? "—"} – ${num(g.maxAnnual)?.toLocaleString("en-IN") ?? "—"}. ${input.reason.trim()}`, amount: input.midAnnual, requesterUserId: input.requesterUserId, subjectEmployeeId: input.employeeId });
  if (!wf.ok) { await prisma.payRangeChange.delete({ where: { id: row.id } }); return wf; }
  await prisma.payRangeChange.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

export async function applyPayRangeDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const c = await prisma.payRangeChange.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!c) return;
  if (outcome === "APPROVED") {
    const g = await prisma.payGrade.findUniqueOrThrow({ where: { id: c.payGradeId } });
    await prisma.payGrade.update({ where: { id: c.payGradeId }, data: { minAnnual: c.minAnnual, midAnnual: c.midAnnual, maxAnnual: c.maxAnnual } });
    await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "UPDATE", entityType: "PayGrade", entityId: c.payGradeId, summary: `Pay range for ${g.name} set to ${Number(c.minAnnual)}–${Number(c.midAnnual)}–${Number(c.maxAnnual)} (was ${num(g.minAnnual) ?? "—"}–${num(g.midAnnual) ?? "—"}–${num(g.maxAnnual) ?? "—"})` });
  }
  await prisma.payRangeChange.update({ where: { id }, data: { status: outcome === "APPROVED" ? "APPLIED" : "REJECTED", decidedAt: new Date() } });
}

export async function setLocationDifferential(tenantId: string, locationId: string, pct: number, actorUserId: string): Promise<R> {
  if (!(await prisma.location.findFirst({ where: { id: locationId, tenantId } }))) return { ok: false, message: "Location not found." };
  if (pct < -50 || pct > 100) return { ok: false, message: "Differentials run -50% to +100%." };
  if (pct === 0) { await prisma.locationPayDifferential.deleteMany({ where: { tenantId, locationId } }); return { ok: true, message: "Differential removed." }; }
  await prisma.locationPayDifferential.upsert({ where: { tenantId_locationId: { tenantId, locationId } }, create: { tenantId, locationId, pct, updatedBy: actorUserId }, update: { pct, updatedBy: actorUserId } });
  return { ok: true, message: `Ranges at this location run ${pct > 0 ? "+" : ""}${pct}%.` };
}

/** Each employee's pay against their (location-adjusted) range. */
export async function compaRatioRows(tenantId: string, employeeWhere: Prisma.EmployeeWhereInput = {}) {
  const [emps, grades, diffs] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, payGradeId: { not: null }, ...employeeWhere }, select: { id: true, displayName: true, employeeNumber: true, payGradeId: true, locationId: true, gender: true, department: { select: { name: true } }, location: { select: { name: true } }, salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } } }, orderBy: { employeeNumber: "asc" } }),
    prisma.payGrade.findMany({ where: { tenantId } }),
    prisma.locationPayDifferential.findMany({ where: { tenantId } }),
  ]);
  const g = new Map(grades.map((x) => [x.id, x])), d = new Map(diffs.map((x) => [x.locationId, Number(x.pct)]));
  return emps.map((e) => {
    const grade = g.get(e.payGradeId!)!;
    const range = adjustedRange({ min: num(grade.minAnnual), mid: num(grade.midAnnual), max: num(grade.maxAnnual) }, (e.locationId && d.get(e.locationId)) || 0);
    const ctc = Number(e.salaryRevisions[0]?.annualCtc ?? 0);
    const compa = compaRatio(ctc, range.mid);
    return { id: e.id, name: e.displayName, number: e.employeeNumber, gender: e.gender, department: e.department?.name ?? "", location: e.location?.name ?? "", grade: grade.name, ctc, ...range, compa, penetration: rangePenetration(ctc, range.min, range.max), position: range.min !== null && ctc < range.min ? "BELOW" : range.max !== null && ctc > range.max ? "ABOVE" : "IN" };
  });
}

// ---------------------------------------------------------------------------
//  Pay equity
// ---------------------------------------------------------------------------

export async function savePayEquityCohort(input: { tenantId: string; id?: string | null; name: string; departmentId?: string | null; bandId?: string | null; payGradeId?: string | null; designationId?: string | null; locationId?: string | null; thresholdPct: number; actorUserId: string }): Promise<R & { id?: string }> {
  const { tenantId, id, actorUserId, ...d } = input;
  if (!d.departmentId && !d.bandId && !d.payGradeId && !d.designationId && !d.locationId) return { ok: false, message: "Define the cohort by at least one of department, band, grade, designation or location." };
  const data = { name: d.name.trim(), departmentId: d.departmentId || null, bandId: d.bandId || null, payGradeId: d.payGradeId || null, designationId: d.designationId || null, locationId: d.locationId || null, thresholdPct: d.thresholdPct };
  if (await prisma.payEquityCohort.findFirst({ where: { tenantId, name: data.name, ...(id ? { id: { not: id } } : {}) } })) return { ok: false, message: "A cohort with that name exists." };
  if (id) {
    const u = await prisma.payEquityCohort.updateMany({ where: { id, tenantId }, data });
    return u.count ? { ok: true, id, message: "Cohort saved." } : { ok: false, message: "Cohort not found." };
  }
  const c = await prisma.payEquityCohort.create({ data: { ...data, tenantId, createdBy: actorUserId } });
  return { ok: true, id: c.id, message: "Cohort saved." };
}

/** Gender gap and compa-ratio spread in each cohort; flagged above its threshold. */
export async function payEquityAnalysis(tenantId: string) {
  const cohorts = await prisma.payEquityCohort.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  // A cohort's designation is a job title; employees carry its name.
  const titles = new Map((await prisma.jobTitle.findMany({ where: { tenantId, id: { in: cohorts.map((c) => c.designationId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((j) => [j.id, j.name]));
  const out = [];
  for (const c of cohorts) {
    const where: Prisma.EmployeeWhereInput = { ...(c.departmentId ? { departmentId: c.departmentId } : {}), ...(c.bandId ? { bandId: c.bandId } : {}), ...(c.payGradeId ? { payGradeId: c.payGradeId } : {}), ...(c.designationId ? { jobTitleName: titles.get(c.designationId) ?? "__none__" } : {}), ...(c.locationId ? { locationId: c.locationId } : {}) };
    const emps = await prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, ...where }, select: { id: true, gender: true, salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } } } });
    const rows = emps.map((e) => ({ gender: e.gender as string | null, ctc: Number(e.salaryRevisions[0]?.annualCtc ?? 0) })).filter((r) => r.ctc > 0);
    const gap = payEquityGap(rows);
    const flagged = (gap.meanGapPct !== null && Math.abs(gap.meanGapPct) > Number(c.thresholdPct)) || (gap.medianGapPct !== null && Math.abs(gap.medianGapPct) > Number(c.thresholdPct));
    out.push({ cohort: c, size: rows.length, ...gap, flagged });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Allowance changes
// ---------------------------------------------------------------------------

/** What the employee gets from this component a month today (override, else the structure). */
export async function currentComponentMonthly(employeeId: string, componentId: string): Promise<number> {
  const now = new Date();
  const o = await prisma.employeeComponentOverride.findFirst({ where: { employeeId, componentId, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }, orderBy: { effectiveFrom: "desc" } });
  if (o) return Number(o.monthlyAmount);
  const comp = await prisma.salaryComponent.findUnique({ where: { id: componentId }, select: { code: true } });
  const rev = await prisma.salaryRevision.findFirst({ where: { employeeId, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, include: { structure: { include: { components: { include: { component: true } } } } } });
  if (!rev?.structure || !comp) return 0;
  const r = resolveStructure({ annualCtc: Number(rev.annualCtc), components: specsOf(rev) });
  return Number(r.byCode.get(comp.code.toUpperCase())?.monthly ?? r.byCode.get(comp.code)?.monthly ?? 0);
}

export async function requestAllowanceChange(input: { tenantId: string; employeeId: string; componentId: string; newMonthly: number; effectiveFrom: Date; reason: string; requesterUserId: string }): Promise<R> {
  const [emp, comp] = await Promise.all([
    prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, displayName: true } }),
    prisma.salaryComponent.findFirst({ where: { id: input.componentId, tenantId: input.tenantId, type: "EARNING", isActive: true }, select: { id: true, name: true } }),
  ]);
  if (!emp) return { ok: false, message: "Employee not found." };
  if (!comp) return { ok: false, message: "Pick an active earning component." };
  if (input.newMonthly < 0) return { ok: false, message: "The amount cannot be negative." };
  if (!input.reason.trim()) return { ok: false, message: "Give a reason." };
  if (await prisma.allowanceChangeRequest.findFirst({ where: { employeeId: emp.id, componentId: comp.id, status: "PENDING" } })) return { ok: false, message: "A change to this allowance is already waiting." };
  const effectiveFrom = new Date(Date.UTC(input.effectiveFrom.getUTCFullYear(), input.effectiveFrom.getUTCMonth(), 1));
  const current = await currentComponentMonthly(emp.id, comp.id);
  const row = await prisma.allowanceChangeRequest.create({ data: { tenantId: input.tenantId, employeeId: emp.id, componentId: comp.id, currentMonthly: current, newMonthly: input.newMonthly, effectiveFrom, reason: input.reason.trim(), requestedBy: input.requesterUserId } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "ALLOWANCE_CHANGE", entityId: row.id, title: `${emp.displayName}: ${comp.name} ₹${current.toLocaleString("en-IN")} → ₹${input.newMonthly.toLocaleString("en-IN")} a month`, details: `From ${effectiveFrom.toISOString().slice(0, 7)}. ${input.reason.trim()}`, amount: Math.abs(input.newMonthly - current) * 12, requesterUserId: input.requesterUserId, subjectEmployeeId: emp.id });
  if (!wf.ok) { await prisma.allowanceChangeRequest.delete({ where: { id: row.id } }); return wf; }
  await prisma.allowanceChangeRequest.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

export async function applyAllowanceChangeDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const r = await prisma.allowanceChangeRequest.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!r) return;
  if (outcome !== "APPROVED") { await prisma.allowanceChangeRequest.update({ where: { id }, data: { status: outcome, decidedAt: new Date() } }); return; }
  // Close any open-ended override the new one replaces.
  const dayBefore = new Date(r.effectiveFrom.getTime() - 86_400_000);
  await prisma.employeeComponentOverride.updateMany({ where: { employeeId: r.employeeId, componentId: r.componentId, effectiveTo: null, effectiveFrom: { lt: r.effectiveFrom } }, data: { effectiveTo: dayBefore } });
  const o = await prisma.employeeComponentOverride.create({ data: { tenantId, employeeId: r.employeeId, componentId: r.componentId, monthlyAmount: r.newMonthly, effectiveFrom: r.effectiveFrom, note: `Allowance change: ${r.reason}`, createdBy: actorUserId } });
  await prisma.allowanceChangeRequest.update({ where: { id }, data: { status: "APPLIED", overrideId: o.id, decidedAt: new Date() } });
  await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "UPDATE", entityType: "EmployeeComponentOverride", entityId: o.id, summary: `Allowance changed from ${Number(r.currentMonthly ?? 0)} to ${Number(r.newMonthly)} a month from ${r.effectiveFrom.toISOString().slice(0, 10)}` });
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export async function compPlanReport(tenantId: string, planId: string) {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId } });
  if (!p) return null;
  const items = await prisma.compPlanItem.findMany({ where: { planId }, include: { employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } } } } }, orderBy: { employee: { employeeNumber: "asc" } } });
  const owners = new Map((await prisma.employee.findMany({ where: { id: { in: items.map((i) => i.ownerEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return {
    plan: p,
    head: ["Employee", "Number", "Department", "Manager", "Rating", "Eligible", "Current CTC", "Merit %", "Proration", "Promotion %", "Market %", "Total %", "New CTC", "Compa before", "Compa after", "Exception", "Status", "Note"],
    rows: items.map((i) => [i.employee.displayName, i.employee.employeeNumber, i.employee.department?.name ?? "", owners.get(i.ownerEmployeeId ?? "") ?? "", num(i.rating), i.eligible ? "Yes" : `No: ${i.ineligibleReason ?? ""}`, Number(i.currentCtc), Number(i.meritPct), Number(i.prorationFactor), Number(i.promotionPct), Number(i.marketPct), Number(i.totalPct), Number(i.newCtc), num(i.compaBefore), num(i.compaAfter), i.exceptionStatus, i.status, i.note ?? ""]),
  };
}

export async function compPlanSummary(tenantId: string, planId: string) {
  const p = await prisma.compPlan.findFirst({ where: { id: planId, tenantId } });
  if (!p) return null;
  const items = await prisma.compPlanItem.findMany({ where: { planId } });
  const live = items.filter((i) => i.status !== "SKIPPED" && i.eligible);
  const payroll = live.reduce((s, i) => s + Number(i.currentCtc), 0);
  const cost = live.reduce((s, i) => s + Number(i.newCtc) - Number(i.currentCtc), 0);
  const budget = (payroll * Number(p.budgetPct)) / 100;
  return { lines: items.length, eligible: live.length, payroll: r2(payroll), cost: r2(cost), budget: r2(budget), costPct: payroll ? r2((cost / payroll) * 100) : 0, overBudget: cost > budget + 0.5, avgPct: live.length ? r2(live.reduce((s, i) => s + Number(i.totalPct), 0) / live.length) : 0, exceptionsPending: items.filter((i) => i.exceptionStatus === "PENDING").length };
}
