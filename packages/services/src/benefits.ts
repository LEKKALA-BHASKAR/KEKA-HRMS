import { prisma, Prisma } from "@keka/db";
import { resolveStructure } from "@keka/payroll";
import { notify, specsOf, usersWithPermission } from "./lifecycle";
import { startWorkflow } from "./workflow-engine";
import { moneyAudit } from "./money-audit";
import { parseCsv } from "./import-math";
import {
  benefitEligibilityGaps, benefitPremium, coverageStart, dependentCoverageIssues, premiumMonthsDue, reconcileCarrier, enrollmentCompletion,
  moneyMonthIndex, type BenefitEligibilityRules, type CarrierRow,
} from "./money-math";

/**
 * Benefits administration: plans (approved before they open), eligibility
 * with an exception queue, enrolment windows (open, new hire, life event),
 * enrolment with dependents checked against the plan and approved through
 * the workflow, dependent changes with proof, payroll deductions with
 * arrears, coverage end, renewals, carrier files and reconciliation.
 */

type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
//  Plans
// ---------------------------------------------------------------------------

export interface BenefitPlanInput {
  tenantId: string; id?: string | null; code: string; name: string; type: string; provider?: string | null; description?: string | null;
  coverageAmount?: number | null; monthlyPremium: number; tierFactors?: Record<string, number> | null;
  employerRule: string; employerValue: number; employerCap?: number | null;
  eligibility?: BenefitEligibilityRules | null; waitingPeriodDays: number; allowedRelations: string[]; maxDependents: number; childMaxAge?: number | null; requiresDependentProof: boolean;
  deductionName?: string | null; planYearStart?: Date | null; planYearEnd?: Date | null; renewalDate?: Date | null; actorUserId: string;
}

export async function saveBenefitPlan(input: BenefitPlanInput): Promise<R & { id?: string }> {
  const { tenantId, id, actorUserId, ...d } = input;
  const code = d.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return { ok: false, message: "Code: 2–20 letters, digits, - or _." };
  if (!["FLAT", "PERCENT_OF_PREMIUM", "MATCH_PERCENT_OF_BASIC"].includes(d.employerRule)) return { ok: false, message: "Pick how the employer contributes." };
  if (d.employerRule === "PERCENT_OF_PREMIUM" && d.employerValue > 100) return { ok: false, message: "The employer share is at most 100%." };
  if (d.planYearStart && d.planYearEnd && d.planYearEnd <= d.planYearStart) return { ok: false, message: "The plan year ends before it starts." };
  if (await prisma.benefitPlan.findFirst({ where: { tenantId, code, ...(id ? { id: { not: id } } : {}) } })) return { ok: false, message: `Another plan uses the code ${code}.` };
  const data = {
    ...d, code, name: d.name.trim(), provider: d.provider ?? null, description: d.description ?? null, coverageAmount: d.coverageAmount ?? null,
    tierFactors: (d.tierFactors ?? undefined) as Prisma.InputJsonValue | undefined, eligibility: (d.eligibility ?? undefined) as Prisma.InputJsonValue | undefined,
    employerCap: d.employerCap ?? null, childMaxAge: d.childMaxAge ?? null, deductionName: d.deductionName ?? null,
    planYearStart: d.planYearStart ?? null, planYearEnd: d.planYearEnd ?? null, renewalDate: d.renewalDate ?? null,
    allowedRelations: d.allowedRelations.map((r) => r.toUpperCase()),
  };
  if (id) {
    const p = await prisma.benefitPlan.findFirst({ where: { id, tenantId } });
    if (!p) return { ok: false, message: "Plan not found." };
    if (p.status !== "DRAFT") return { ok: false, message: "Only a draft plan can be edited; renew an active plan to change it." };
    await prisma.benefitPlan.update({ where: { id }, data });
    return { ok: true, id, message: `Saved ${data.name}.` };
  }
  const p = await prisma.benefitPlan.create({ data: { ...data, tenantId, createdBy: actorUserId } });
  return { ok: true, id: p.id, message: `Saved ${data.name} as a draft. Submit it for approval to offer it.` };
}

export async function submitBenefitPlan(tenantId: string, id: string, requesterUserId: string, employeeId: string | null): Promise<R> {
  const p = await prisma.benefitPlan.findFirst({ where: { id, tenantId } });
  if (!p) return { ok: false, message: "Plan not found." };
  if (p.status !== "DRAFT") return { ok: false, message: `This plan is ${p.status.toLowerCase().replace(/_/g, " ")}.` };
  await prisma.benefitPlan.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId, entityType: "BENEFIT_PLAN", entityId: id, title: `${p.previousPlanId ? "Renew" : "Offer"} benefit plan ${p.name} (${p.code})`, details: p.description, amount: Number(p.monthlyPremium) * 12, category: p.type, requesterUserId, subjectEmployeeId: employeeId });
  if (!wf.ok) { await prisma.benefitPlan.update({ where: { id }, data: { status: "DRAFT" } }); return wf; }
  await prisma.benefitPlan.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

/** Approved: the plan opens; a renewal retires its predecessor and carries its members over. */
export async function applyBenefitPlanDecision(tenantId: string, id: string, approved: boolean, actorUserId: string | null): Promise<void> {
  const p = await prisma.benefitPlan.findFirst({ where: { id, tenantId, status: "PENDING_APPROVAL" } });
  if (!p) return;
  if (!approved) { await prisma.benefitPlan.update({ where: { id }, data: { status: "DRAFT" } }); return; }
  await prisma.benefitPlan.update({ where: { id }, data: { status: "ACTIVE" } });
  let moved = 0;
  if (p.previousPlanId) {
    const old = await prisma.benefitPlan.findFirst({ where: { id: p.previousPlanId, tenantId } });
    if (old) {
      await prisma.benefitPlan.update({ where: { id: old.id }, data: { status: "RETIRED" } });
      const members = await prisma.benefitEnrollment.findMany({ where: { planId: old.id, status: "ACTIVE" } });
      for (const m of members) {
        const cost = await enrollmentCost(p, m.employeeId, m.tier, num(m.contributionPct));
        await prisma.benefitEnrollment.update({ where: { id: m.id }, data: { planId: p.id, employeeMonthly: cost.employee, employerMonthly: cost.employer, coverageEnd: p.planYearEnd } });
        moved++;
      }
    }
  }
  await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "BenefitPlan", entityId: id, summary: `Benefit plan ${p.name} approved${moved ? `; ${moved} member(s) renewed onto it` : ""}` });
}

/** Next year's plan as a draft: same rules, premium moved by a %. */
export async function renewBenefitPlan(tenantId: string, id: string, input: { premiumChangePct: number; planYearStart: Date; planYearEnd: Date; actorUserId: string }): Promise<R & { id?: string }> {
  const p = await prisma.benefitPlan.findFirst({ where: { id, tenantId } });
  if (!p || p.status !== "ACTIVE") return { ok: false, message: "Only an active plan is renewed." };
  if (await prisma.benefitPlan.findFirst({ where: { tenantId, previousPlanId: id, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } })) return { ok: false, message: "A renewal is already being prepared." };
  let code = `${p.code}-${input.planYearStart.getUTCFullYear()}`.slice(0, 20);
  for (let i = 2; await prisma.benefitPlan.findFirst({ where: { tenantId, code } }); i++) code = `${p.code}-R${i}`.slice(0, 20);
  const { id: _i, createdAt: _c, updatedAt: _u, workflowRequestId: _w, status: _s, code: _code, tierFactors, eligibility, ...rest } = p;
  const renewal = await prisma.benefitPlan.create({
    data: {
      ...rest, code, tierFactors: tierFactors ?? undefined, eligibility: eligibility ?? undefined, status: "DRAFT", previousPlanId: p.id, createdBy: input.actorUserId,
      monthlyPremium: r2(Number(p.monthlyPremium) * (1 + input.premiumChangePct / 100)), planYearStart: input.planYearStart, planYearEnd: input.planYearEnd,
      renewalDate: new Date(input.planYearEnd.getTime() - 30 * DAY),
    },
  });
  return { ok: true, id: renewal.id, message: `Renewal ${code} drafted at ₹${Number(renewal.monthlyPremium).toLocaleString("en-IN")}/month (${input.premiumChangePct >= 0 ? "+" : ""}${input.premiumChangePct}%). Submit it for approval.` };
}

export async function retireBenefitPlan(tenantId: string, id: string, endOn: Date): Promise<R> {
  const p = await prisma.benefitPlan.findFirst({ where: { id, tenantId, status: "ACTIVE" } });
  if (!p) return { ok: false, message: "Only an active plan can be retired." };
  const ended = await prisma.benefitEnrollment.updateMany({ where: { planId: id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, data: { status: "ENDED", coverageEnd: endOn, endReason: "Plan retired" } });
  await prisma.benefitPlan.update({ where: { id }, data: { status: "RETIRED" } });
  return { ok: true, message: `Retired ${p.name}; ${ended.count} enrolment(s) end ${endOn.toISOString().slice(0, 10)}.` };
}

// ---------------------------------------------------------------------------
//  Eligibility
// ---------------------------------------------------------------------------

const EMP = { id: true, tenantId: true, userId: true, displayName: true, employeeNumber: true, dateOfJoining: true, status: true, bandId: true, locationId: true, departmentId: true, workerTypeId: true } as const;

/** Why an employee cannot join a plan; an approved exception lifts the rules. */
export async function benefitEligibility(planId: string, employeeId: string): Promise<{ eligible: boolean; gaps: string[]; viaException: boolean }> {
  const [plan, emp] = await Promise.all([prisma.benefitPlan.findUniqueOrThrow({ where: { id: planId } }), prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: EMP })]);
  const gaps = benefitEligibilityGaps(plan.eligibility as BenefitEligibilityRules | null, emp);
  if (gaps.length === 0) return { eligible: true, gaps, viaException: false };
  const exc = await prisma.benefitEligibilityException.findFirst({ where: { planId, employeeId, status: "APPROVED" } });
  return { eligible: !!exc && !["EXITED", "INACTIVE"].includes(emp.status), gaps, viaException: !!exc };
}

export async function requestBenefitException(input: { employeeId: string; planId: string; reason: string; requesterUserId: string }): Promise<R> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: EMP });
  const plan = await prisma.benefitPlan.findFirst({ where: { id: input.planId, tenantId: emp.tenantId, status: "ACTIVE" } });
  if (!plan) return { ok: false, message: "Plan not found." };
  if (!input.reason.trim()) return { ok: false, message: "Explain why an exception is needed." };
  const e = await benefitEligibility(plan.id, emp.id);
  if (e.eligible) return { ok: false, message: "You are already eligible for this plan." };
  if (await prisma.benefitEligibilityException.findFirst({ where: { planId: plan.id, employeeId: emp.id, status: "PENDING" } })) return { ok: false, message: "An exception for this plan is already waiting." };
  const row = await prisma.benefitEligibilityException.create({ data: { tenantId: emp.tenantId, employeeId: emp.id, planId: plan.id, reason: input.reason.trim(), ruleGaps: e.gaps.join(" ") } });
  const wf = await startWorkflow({ tenantId: emp.tenantId, entityType: "BENEFIT_EXCEPTION", entityId: row.id, title: `Eligibility exception: ${emp.displayName} → ${plan.name}`, details: `${input.reason.trim()} (Rules: ${e.gaps.join(" ")})`, category: plan.type, requesterUserId: input.requesterUserId, subjectEmployeeId: emp.id });
  if (!wf.ok) { await prisma.benefitEligibilityException.delete({ where: { id: row.id } }); return wf; }
  await prisma.benefitEligibilityException.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

export async function applyBenefitExceptionDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN"): Promise<void> {
  await prisma.benefitEligibilityException.updateMany({ where: { id, tenantId, status: "PENDING" }, data: { status: outcome === "WITHDRAWN" ? "REJECTED" : outcome, decidedAt: new Date() } });
}

/** Everyone active against every active plan: eligible, waiting, or why not. */
export async function eligibilityMatrix(tenantId: string, employeeWhere: Prisma.EmployeeWhereInput = {}) {
  const [plans, emps, excs] = await Promise.all([
    prisma.benefitPlan.findMany({ where: { tenantId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, ...employeeWhere }, select: EMP, orderBy: { employeeNumber: "asc" } }),
    prisma.benefitEligibilityException.findMany({ where: { tenantId, status: "APPROVED" }, select: { planId: true, employeeId: true } }),
  ]);
  const rows = emps.map((e) => ({
    employee: e,
    cells: plans.map((p) => {
      const gaps = benefitEligibilityGaps(p.eligibility as BenefitEligibilityRules | null, e);
      const exception = excs.some((x) => x.planId === p.id && x.employeeId === e.id);
      const waitLeft = Math.max(0, Math.ceil((e.dateOfJoining.getTime() + p.waitingPeriodDays * DAY - Date.now()) / DAY));
      return { planId: p.id, eligible: gaps.length === 0 || exception, exception, gaps, waitLeft };
    }),
  }));
  return { plans, rows };
}

// ---------------------------------------------------------------------------
//  Windows
// ---------------------------------------------------------------------------

export async function createEnrollmentWindow(input: { tenantId: string; name: string; kind: "OPEN" | "NEW_HIRE" | "LIFE_EVENT"; opensOn: Date; closesOn: Date; planIds: string[]; employeeId?: string | null; actorUserId: string | null }): Promise<R & { id?: string }> {
  if (input.closesOn < input.opensOn) return { ok: false, message: "The window closes before it opens." };
  const plans = await prisma.benefitPlan.findMany({ where: { tenantId: input.tenantId, id: { in: input.planIds }, status: "ACTIVE" }, select: { id: true } });
  if (plans.length === 0) return { ok: false, message: "Choose at least one active plan." };
  const w = await prisma.benefitEnrollmentWindow.create({ data: { tenantId: input.tenantId, name: input.name.trim(), kind: input.kind, opensOn: input.opensOn, closesOn: input.closesOn, planIds: plans.map((p) => p.id), employeeId: input.employeeId ?? null, createdBy: input.actorUserId } });
  return { ok: true, id: w.id, message: `${w.name} runs ${input.opensOn.toISOString().slice(0, 10)} – ${input.closesOn.toISOString().slice(0, 10)} for ${plans.length} plan(s).` };
}

const isOpen = (w: { opensOn: Date; closesOn: Date; closedAt: Date | null }, at = new Date()) => !w.closedAt && w.opensOn.getTime() <= at.getTime() && w.closesOn.getTime() + DAY > at.getTime();

/** Windows open to this employee now; a new joiner gets a 30-day personal window. */
export async function openWindowsFor(employeeId: string) {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: EMP });
  const since = (Date.now() - emp.dateOfJoining.getTime()) / DAY;
  if (since >= 0 && since <= 30 && !(await prisma.benefitEnrollmentWindow.findFirst({ where: { tenantId: emp.tenantId, employeeId, kind: "NEW_HIRE" } }))) {
    const plans = await prisma.benefitPlan.findMany({ where: { tenantId: emp.tenantId, status: "ACTIVE" }, select: { id: true } });
    if (plans.length) await createEnrollmentWindow({ tenantId: emp.tenantId, name: `New joiner enrolment — ${emp.displayName}`, kind: "NEW_HIRE", opensOn: emp.dateOfJoining, closesOn: new Date(emp.dateOfJoining.getTime() + 30 * DAY), planIds: plans.map((p) => p.id), employeeId, actorUserId: null });
  }
  const all = await prisma.benefitEnrollmentWindow.findMany({ where: { tenantId: emp.tenantId, OR: [{ employeeId: null }, { employeeId }] }, orderBy: { closesOn: "asc" } });
  return all.filter((w) => isOpen(w));
}

/** Who a window is for: everyone eligible for at least one of its plans (or its one employee). */
async function windowAudience(windowId: string) {
  const w = await prisma.benefitEnrollmentWindow.findUniqueOrThrow({ where: { id: windowId } });
  const plans = await prisma.benefitPlan.findMany({ where: { id: { in: w.planIds } } });
  const emps = await prisma.employee.findMany({ where: { tenantId: w.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, ...(w.employeeId ? { id: w.employeeId } : {}) }, select: EMP });
  const excs = await prisma.benefitEligibilityException.findMany({ where: { tenantId: w.tenantId, status: "APPROVED", planId: { in: w.planIds } }, select: { planId: true, employeeId: true } });
  const eligible = emps.filter((e) => plans.some((p) => benefitEligibilityGaps(p.eligibility as BenefitEligibilityRules | null, e).length === 0 || excs.some((x) => x.planId === p.id && x.employeeId === e.id)));
  return { w, plans, eligible };
}

/** Tell everyone eligible that the window is open. */
export async function announceWindow(tenantId: string, windowId: string): Promise<R> {
  const w0 = await prisma.benefitEnrollmentWindow.findFirst({ where: { id: windowId, tenantId } });
  if (!w0) return { ok: false, message: "Window not found." };
  const { w, plans, eligible } = await windowAudience(windowId);
  await notify({ tenantId, userIds: eligible.map((e) => e.userId), kind: "BENEFITS", title: `${w.name} is open until ${w.closesOn.toISOString().slice(0, 10)}`, body: `Choose your cover: ${plans.map((p) => p.name).join(", ")}.`, link: "/finances/benefits", email: true });
  await prisma.benefitEnrollmentWindow.update({ where: { id: w.id }, data: { announcedAt: new Date() } });
  return { ok: true, message: `Announced to ${eligible.length} eligible employee(s).` };
}

/** Remind those who have neither enrolled nor waived. */
export async function remindWindow(tenantId: string, windowId: string): Promise<R> {
  const w0 = await prisma.benefitEnrollmentWindow.findFirst({ where: { id: windowId, tenantId } });
  if (!w0) return { ok: false, message: "Window not found." };
  const { w, eligible } = await windowAudience(windowId);
  const decided = new Set((await prisma.benefitEnrollment.findMany({ where: { windowId: w.id }, select: { employeeId: true } })).map((e) => e.employeeId));
  const pending = eligible.filter((e) => !decided.has(e.id));
  await notify({ tenantId, userIds: pending.map((e) => e.userId), kind: "BENEFITS", title: `Reminder: ${w.name} closes ${w.closesOn.toISOString().slice(0, 10)}`, body: "Enrol or waive cover before the window closes.", link: "/finances/benefits", email: true });
  await prisma.benefitEnrollmentWindow.update({ where: { id: w.id }, data: { lastReminderAt: new Date() } });
  return { ok: true, message: `Reminded ${pending.length} employee(s) who have not decided.` };
}

export async function closeWindow(tenantId: string, windowId: string): Promise<R> {
  const u = await prisma.benefitEnrollmentWindow.updateMany({ where: { id: windowId, tenantId, closedAt: null }, data: { closedAt: new Date() } });
  return u.count ? { ok: true, message: "Window closed." } : { ok: false, message: "Window not found or already closed." };
}

/** Completion for the open-enrolment dashboard. */
export async function windowCompletion(tenantId: string, windowId: string) {
  const w0 = await prisma.benefitEnrollmentWindow.findFirst({ where: { id: windowId, tenantId } });
  if (!w0) return null;
  const { w, plans, eligible } = await windowAudience(windowId);
  const rows = await prisma.benefitEnrollment.findMany({ where: { windowId: w.id } });
  const enrolledEmps = new Set(rows.filter((r) => ["ACTIVE", "PENDING_APPROVAL"].includes(r.status)).map((r) => r.employeeId));
  const waivedEmps = new Set(rows.filter((r) => r.status === "WAIVED" && !enrolledEmps.has(r.employeeId)).map((r) => r.employeeId));
  const total = enrollmentCompletion(eligible.length, enrolledEmps.size, waivedEmps.size);
  const perPlan = plans.map((p) => ({ plan: p.name, enrolled: rows.filter((r) => r.planId === p.id && ["ACTIVE", "PENDING_APPROVAL"].includes(r.status)).length, waived: rows.filter((r) => r.planId === p.id && r.status === "WAIVED").length }));
  const pendingPeople = eligible.filter((e) => !enrolledEmps.has(e.id) && !waivedEmps.has(e.id)).map((e) => ({ id: e.id, name: e.displayName, number: e.employeeNumber }));
  return { window: w, eligible: eligible.length, enrolled: enrolledEmps.size, waived: waivedEmps.size, ...total, perPlan, pendingPeople };
}

// ---------------------------------------------------------------------------
//  Enrolment
// ---------------------------------------------------------------------------

/** Monthly basic pay, for retirement contributions. */
export async function monthlyBasicOf(employeeId: string): Promise<number> {
  const rev = await prisma.salaryRevision.findFirst({ where: { employeeId, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, include: { structure: { include: { components: { include: { component: true } } } } } });
  if (!rev?.structure) return 0;
  const r = resolveStructure({ annualCtc: Number(rev.annualCtc), components: specsOf(rev) });
  const basic = r.byCode.get("BASIC") ?? r.components.find((c) => /basic/i.test(c.name));
  return basic ? Number(basic.monthly) : r2(Number(r.monthlyGross) * 0.5);
}

async function enrollmentCost(plan: { monthlyPremium: unknown; tierFactors: unknown; employerRule: string; employerValue: unknown; employerCap: unknown; type: string }, employeeId: string, tier: string, contributionPct: number | null) {
  const basic = plan.type === "RETIREMENT" || plan.employerRule === "MATCH_PERCENT_OF_BASIC" ? await monthlyBasicOf(employeeId) : 0;
  return benefitPremium({ monthlyPremium: Number(plan.monthlyPremium), tierFactors: plan.tierFactors as Record<string, number> | null, employerRule: plan.employerRule, employerValue: Number(plan.employerValue), employerCap: num(plan.employerCap), type: plan.type }, tier, { monthlyBasic: basic, contributionPct });
}

/** Enrol in a plan through an open window; a benefits administrator approves. */
export async function enrollInBenefit(input: { employeeId: string; planId: string; tier: string; dependentIds: string[]; contributionPct?: number | null; requesterUserId: string }): Promise<R & { id?: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: EMP });
  const plan = await prisma.benefitPlan.findFirst({ where: { id: input.planId, tenantId: emp.tenantId, status: "ACTIVE" } });
  if (!plan) return { ok: false, message: "That plan is not open for enrolment." };
  const window = (await openWindowsFor(emp.id)).find((w) => w.planIds.includes(plan.id));
  if (!window) return { ok: false, message: "No enrolment window is open for this plan. Report a life event to open one." };
  const e = await benefitEligibility(plan.id, emp.id);
  if (!e.eligible) return { ok: false, message: `Not eligible: ${e.gaps.join(" ")} You can ask for an exception.` };
  if (!["EMPLOYEE", "EMPLOYEE_SPOUSE", "FAMILY"].includes(input.tier)) return { ok: false, message: "Pick the cover level." };
  if (plan.type === "RETIREMENT" && !(input.contributionPct && input.contributionPct > 0 && input.contributionPct <= 50)) return { ok: false, message: "Choose your contribution: 1–50% of basic." };
  const deps = await prisma.dependent.findMany({ where: { employeeId: emp.id, id: { in: input.dependentIds } } });
  const issues = dependentCoverageIssues(plan, input.tier, deps.map((d) => ({ id: d.id, name: d.name, relationship: d.relationship, dateOfBirth: d.dateOfBirth, verified: !!d.verifiedAt })));
  if (issues.length) return { ok: false, message: issues.join(" ") };
  if (await prisma.benefitEnrollment.findFirst({ where: { employeeId: emp.id, planId: plan.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } } })) return { ok: false, message: "You are already enrolled (or waiting) in this plan." };
  const cost = await enrollmentCost(plan, emp.id, input.tier, input.contributionPct ?? null);
  await prisma.benefitEnrollment.deleteMany({ where: { employeeId: emp.id, planId: plan.id, windowId: window.id, status: "WAIVED" } });
  const row = await prisma.benefitEnrollment.create({ data: { tenantId: emp.tenantId, employeeId: emp.id, planId: plan.id, windowId: window.id, tier: input.tier, dependentIds: deps.map((d) => d.id), contributionPct: input.contributionPct ?? null, employeeMonthly: cost.employee, employerMonthly: cost.employer } });
  const wf = await startWorkflow({ tenantId: emp.tenantId, entityType: "BENEFIT_ENROLLMENT", entityId: row.id, title: `${emp.displayName}: enrol in ${plan.name} (${input.tier.toLowerCase().replace(/_/g, " + ")})`, details: deps.length ? `Dependents: ${deps.map((d) => `${d.name} (${d.relationship})`).join(", ")}` : null, amount: cost.total, category: plan.type, requesterUserId: input.requesterUserId, subjectEmployeeId: emp.id });
  if (!wf.ok) { await prisma.benefitEnrollment.delete({ where: { id: row.id } }); return wf; }
  await prisma.benefitEnrollment.updateMany({ where: { id: row.id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: row.id, message: `Enrolment requested: you pay ₹${cost.employee.toLocaleString("en-IN")}/month, the company ₹${cost.employer.toLocaleString("en-IN")}. ${wf.message}` };
}

export async function applyBenefitEnrollmentDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const row = await prisma.benefitEnrollment.findFirst({ where: { id, tenantId, status: "PENDING_APPROVAL" }, include: { plan: true, employee: { select: { dateOfJoining: true, userId: true, displayName: true } } } });
  if (!row) return;
  if (outcome !== "APPROVED") { await prisma.benefitEnrollment.update({ where: { id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "CANCELLED" } }); return; }
  const start = coverageStart(row.employee.dateOfJoining, row.plan.waitingPeriodDays, row.createdAt, row.plan.planYearStart);
  await prisma.benefitEnrollment.update({ where: { id }, data: { status: "ACTIVE", coverageStart: start, coverageEnd: row.plan.planYearEnd } });
  await notify({ tenantId, userIds: [row.employee.userId], kind: "BENEFITS", title: `${row.plan.name}: you are covered from ${start.toISOString().slice(0, 10)}`, link: "/finances/benefits" });
  await moneyAudit(tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "BenefitEnrollment", entityId: id, summary: `${row.employee.displayName} enrolled in ${row.plan.name} from ${start.toISOString().slice(0, 10)}` });
}

/** Decline cover in a window (counts as decided on the dashboard). */
export async function waiveBenefit(employeeId: string, planId: string): Promise<R> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: EMP });
  const window = (await openWindowsFor(employeeId)).find((w) => w.planIds.includes(planId));
  if (!window) return { ok: false, message: "No enrolment window is open for this plan." };
  if (await prisma.benefitEnrollment.findFirst({ where: { employeeId, planId, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } } })) return { ok: false, message: "You are enrolled in this plan; cancel that first." };
  if (await prisma.benefitEnrollment.findFirst({ where: { employeeId, planId, windowId: window.id, status: "WAIVED" } })) return { ok: true, message: "Already waived." };
  await prisma.benefitEnrollment.create({ data: { tenantId: emp.tenantId, employeeId, planId, windowId: window.id, status: "WAIVED" } });
  return { ok: true, message: "Cover waived for this window." };
}

/** End cover: the employee leaving, or an administrator's decision. */
export async function endBenefitCoverage(tenantId: string, enrollmentId: string, endOn: Date, reason: string): Promise<R> {
  const e = await prisma.benefitEnrollment.findFirst({ where: { id: enrollmentId, tenantId, status: "ACTIVE" } });
  if (!e) return { ok: false, message: "Only active cover can be ended." };
  await prisma.benefitEnrollment.update({ where: { id: e.id }, data: { status: "ENDED", coverageEnd: endOn, endReason: reason } });
  return { ok: true, message: `Cover ends ${endOn.toISOString().slice(0, 10)}.` };
}

/**
 * Coverage-end processing: leavers' cover ends on their last working day,
 * and cover past its plan year ends with it.
 */
export async function runCoverageEndProcessing(tenantId: string, today = new Date()): Promise<{ ended: number }> {
  const active = await prisma.benefitEnrollment.findMany({ where: { tenantId, status: "ACTIVE" }, include: { employee: { select: { status: true, exitRecord: { select: { lastWorkingDay: true, status: true } } } } } });
  let ended = 0;
  for (const e of active) {
    const lwd = e.employee.exitRecord?.lastWorkingDay ?? null;
    let endOn: Date | null = null, reason = "";
    if (e.employee.status === "EXITED" || (lwd && lwd.getTime() < today.getTime())) { endOn = lwd ?? today; reason = "Employee left"; }
    else if (e.coverageEnd && e.coverageEnd.getTime() < today.getTime()) { endOn = e.coverageEnd; reason = "Plan year ended"; }
    if (!endOn) continue;
    await prisma.benefitEnrollment.update({ where: { id: e.id }, data: { status: "ENDED", coverageEnd: endOn, endReason: reason } });
    ended++;
  }
  return { ended };
}

// ---------------------------------------------------------------------------
//  Dependents and life events
// ---------------------------------------------------------------------------

export async function requestDependentChange(input: { employeeId: string; requesterUserId: string; action: "ADD" | "UPDATE" | "REMOVE"; dependentId?: string | null; name: string; relationship: string; dateOfBirth?: Date | null; proofUrl?: string | null }): Promise<R & { id?: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: EMP });
  if (input.action !== "ADD") {
    const d = input.dependentId ? await prisma.dependent.findFirst({ where: { id: input.dependentId, employeeId: emp.id } }) : null;
    if (!d) return { ok: false, message: "Dependent not found." };
  }
  if (input.action !== "REMOVE" && (!input.name.trim() || !input.relationship.trim())) return { ok: false, message: "Enter the name and relationship." };
  if (input.action === "ADD" && !input.proofUrl) return { ok: false, message: "Attach proof of the relationship (certificate, ID)." };
  const row = await prisma.dependentRequest.create({ data: { tenantId: emp.tenantId, employeeId: emp.id, dependentId: input.dependentId ?? null, action: input.action, name: input.name.trim(), relationship: input.relationship.trim().toUpperCase(), dateOfBirth: input.dateOfBirth ?? null, proofUrl: input.proofUrl ?? null } });
  const wf = await startWorkflow({ tenantId: emp.tenantId, entityType: "DEPENDENT_CHANGE", entityId: row.id, title: `${emp.displayName}: ${input.action.toLowerCase()} dependent ${input.name.trim()} (${input.relationship.toLowerCase()})`, category: input.action, requesterUserId: input.requesterUserId, subjectEmployeeId: emp.id });
  if (!wf.ok) { await prisma.dependentRequest.delete({ where: { id: row.id } }); return wf; }
  await prisma.dependentRequest.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: row.id, message: wf.message };
}

export async function applyDependentDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const r = await prisma.dependentRequest.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!r) return;
  if (outcome === "APPROVED") {
    const verified = { verifiedAt: new Date(), verifiedBy: actorUserId };
    if (r.action === "ADD") await prisma.dependent.create({ data: { employeeId: r.employeeId, name: r.name, relationship: r.relationship, dateOfBirth: r.dateOfBirth, proofUrl: r.proofUrl, ...verified } });
    else if (r.action === "UPDATE" && r.dependentId) await prisma.dependent.updateMany({ where: { id: r.dependentId, employeeId: r.employeeId }, data: { name: r.name, relationship: r.relationship, dateOfBirth: r.dateOfBirth, ...(r.proofUrl ? { proofUrl: r.proofUrl, ...verified } : {}) } });
    else if (r.action === "REMOVE" && r.dependentId) {
      for (const e of await prisma.benefitEnrollment.findMany({ where: { employeeId: r.employeeId, dependentIds: { has: r.dependentId } } })) {
        await prisma.benefitEnrollment.update({ where: { id: e.id }, data: { dependentIds: e.dependentIds.filter((x) => x !== r.dependentId) } });
      }
      await prisma.dependent.deleteMany({ where: { id: r.dependentId, employeeId: r.employeeId } });
    }
    await moneyAudit(tenantId, actorUserId, { module: "EMPLOYEE", action: "APPROVE", entityType: "Dependent", entityId: r.dependentId ?? r.id, summary: `Dependent ${r.action.toLowerCase()} approved: ${r.name} (${r.relationship.toLowerCase()}), proof checked` });
  }
  await prisma.dependentRequest.update({ where: { id }, data: { status: outcome, decidedAt: new Date() } });
}

/** HR checks the proof on a dependent already on file. */
export async function verifyDependent(tenantId: string, dependentId: string, proofUrl: string | null, actorUserId: string): Promise<R> {
  const d = await prisma.dependent.findFirst({ where: { id: dependentId, employee: { tenantId } } });
  if (!d) return { ok: false, message: "Dependent not found." };
  if (!proofUrl && !d.proofUrl) return { ok: false, message: "Attach the proof first." };
  await prisma.dependent.update({ where: { id: d.id }, data: { ...(proofUrl ? { proofUrl } : {}), verifiedAt: new Date(), verifiedBy: actorUserId } });
  return { ok: true, message: `${d.name}: proof verified.` };
}

export async function reportLifeEvent(input: { employeeId: string; requesterUserId: string; kind: string; eventDate: Date; notes?: string | null; proofUrl?: string | null }): Promise<R & { id?: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: EMP });
  if (!["MARRIAGE", "BIRTH", "ADOPTION", "DIVORCE", "DEATH_OF_DEPENDENT", "OTHER"].includes(input.kind)) return { ok: false, message: "Pick the kind of event." };
  if (input.eventDate.getTime() > Date.now() + DAY) return { ok: false, message: "Report an event once it has happened." };
  if (Date.now() - input.eventDate.getTime() > 60 * DAY) return { ok: false, message: "Life events are reported within 60 days." };
  const row = await prisma.benefitLifeEvent.create({ data: { tenantId: emp.tenantId, employeeId: emp.id, kind: input.kind, eventDate: input.eventDate, notes: input.notes ?? null, proofUrl: input.proofUrl ?? null } });
  const wf = await startWorkflow({ tenantId: emp.tenantId, entityType: "LIFE_EVENT", entityId: row.id, title: `${emp.displayName}: ${input.kind.toLowerCase().replace(/_/g, " ")} on ${input.eventDate.toISOString().slice(0, 10)}`, details: input.notes, category: input.kind, requesterUserId: input.requesterUserId, subjectEmployeeId: emp.id });
  if (!wf.ok) { await prisma.benefitLifeEvent.delete({ where: { id: row.id } }); return wf; }
  await prisma.benefitLifeEvent.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: row.id, message: `${wf.message} Once approved, a 30-day window opens to change your cover.` };
}

export async function applyLifeEventDecision(tenantId: string, id: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN"): Promise<void> {
  const ev = await prisma.benefitLifeEvent.findFirst({ where: { id, tenantId, status: "PENDING" }, include: { employee: { select: { displayName: true, userId: true } } } });
  if (!ev) return;
  if (outcome !== "APPROVED") { await prisma.benefitLifeEvent.update({ where: { id }, data: { status: "REJECTED" } }); return; }
  const plans = await prisma.benefitPlan.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true } });
  const now = new Date();
  const w = plans.length ? await createEnrollmentWindow({ tenantId, name: `Life event — ${ev.employee.displayName} (${ev.kind.toLowerCase().replace(/_/g, " ")})`, kind: "LIFE_EVENT", opensOn: now, closesOn: new Date(now.getTime() + 30 * DAY), planIds: plans.map((p) => p.id), employeeId: ev.employeeId, actorUserId: null }) : null;
  await prisma.benefitLifeEvent.update({ where: { id }, data: { status: "APPROVED", windowId: w?.id ?? null } });
  await notify({ tenantId, userIds: [ev.employee.userId], kind: "BENEFITS", title: "Your life event was approved — change your cover within 30 days", link: "/finances/benefits" });
}

// ---------------------------------------------------------------------------
//  Payroll deductions
// ---------------------------------------------------------------------------

/**
 * Push employee premiums for a payroll month: one deduction per enrolment,
 * plus arrears for months of cover not yet deducted (a late approval or a
 * back-dated start).
 */
export async function pushBenefitDeductions(tenantId: string, year: number, month: number, actorUserId: string): Promise<R & { regular?: number; arrears?: number }> {
  const rows = await prisma.benefitEnrollment.findMany({ where: { tenantId, status: { in: ["ACTIVE", "ENDED"] }, employeeMonthly: { gt: 0 }, coverageStart: { not: null } }, include: { plan: { select: { name: true, deductionName: true } } } });
  let regular = 0, arrears = 0;
  for (const e of rows) {
    const due = premiumMonthsDue(e.coverageStart!, e.deductedThrough, { year, month }, e.coverageEnd);
    if (!due.length) continue;
    const amount = Number(e.employeeMonthly);
    const back = due.filter((d) => d.arrears), cur = due.filter((d) => !d.arrears);
    const label = e.plan.deductionName || e.plan.name;
    if (cur.length) {
      const a = await prisma.adhocTransaction.create({ data: { employeeId: e.employeeId, type: "DEDUCTION", name: label, amount, taxTreatment: "NON_TAXABLE", year, month, sourceType: "BenefitEnrollment", sourceId: e.id, createdBy: actorUserId } });
      await prisma.benefitDeduction.create({ data: { tenantId, enrollmentId: e.id, year, month, amount, kind: "REGULAR", adhocId: a.id } });
      regular++;
    }
    if (back.length) {
      const a = await prisma.adhocTransaction.create({ data: { employeeId: e.employeeId, type: "DEDUCTION", name: `${label} arrears (${back.length} month${back.length === 1 ? "" : "s"})`, amount: r2(amount * back.length), taxTreatment: "NON_TAXABLE", year, month, sourceType: "BenefitArrears", sourceId: e.id, createdBy: actorUserId } });
      for (const b of back) await prisma.benefitDeduction.create({ data: { tenantId, enrollmentId: e.id, year: b.year, month: b.month, amount, kind: "ARREARS", adhocId: a.id } });
      arrears += back.length;
    }
    await prisma.benefitEnrollment.update({ where: { id: e.id }, data: { deductedThrough: moneyMonthIndex(due[due.length - 1]!.year, due[due.length - 1]!.month) } });
  }
  return { ok: true, regular, arrears, message: `${regular} premium deduction(s) for ${month}/${year}${arrears ? ` and ${arrears} month(s) of arrears` : ""} sent to payroll.` };
}

// ---------------------------------------------------------------------------
//  Carrier files
// ---------------------------------------------------------------------------

/** The census we send the insurer: one row per member (employee and covered dependents). */
export async function carrierCensus(tenantId: string, planId: string, actorUserId: string | null) {
  const plan = await prisma.benefitPlan.findFirst({ where: { id: planId, tenantId } });
  if (!plan) return null;
  const rows = await prisma.benefitEnrollment.findMany({ where: { planId, status: "ACTIVE" }, include: { employee: { select: { employeeNumber: true, displayName: true, dateOfBirth: true, gender: true, dependents: true } } }, orderBy: { createdAt: "asc" } });
  const out: unknown[][] = [];
  const members: CarrierRow[] = [];
  for (const r of rows) {
    const premium = r2(Number(r.employeeMonthly) + Number(r.employerMonthly));
    out.push([r.employee.employeeNumber, r.employee.employeeNumber, r.employee.displayName, "SELF", r.employee.dateOfBirth, r.employee.gender ?? "", r.tier, premium, r.coverageStart, r.coverageEnd]);
    members.push({ memberId: r.employee.employeeNumber, name: r.employee.displayName ?? "", tier: r.tier, premium });
    r.employee.dependents.filter((d) => r.dependentIds.includes(d.id)).forEach((d, i) => out.push([`${r.employee.employeeNumber}-D${i + 1}`, r.employee.employeeNumber, d.name, d.relationship, d.dateOfBirth, "", r.tier, 0, r.coverageStart, r.coverageEnd]));
  }
  await prisma.benefitCarrierFile.create({ data: { tenantId, planId, kind: "EXPORT", rowCount: out.length, createdBy: actorUserId } });
  return { plan, head: ["Member ID", "Employee ID", "Name", "Relationship", "Date of birth", "Gender", "Tier", "Monthly premium", "Cover from", "Cover to"], rows: out, members };
}

/** Compare the insurer's member file (CSV: member id, name, tier, premium) with ours. */
export async function reconcileCarrierFile(tenantId: string, planId: string, csv: string, actorUserId: string): Promise<R & { result?: ReturnType<typeof reconcileCarrier> }> {
  const census = await carrierCensus(tenantId, planId, null);
  if (!census) return { ok: false, message: "Plan not found." };
  await prisma.benefitCarrierFile.deleteMany({ where: { tenantId, planId, kind: "EXPORT", createdBy: null, createdAt: { gte: new Date(Date.now() - 5000) } } });
  const parsed = parseCsv(csv);
  if (parsed.length < 2) return { ok: false, message: "The file has no rows." };
  const head = parsed[0]!.map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const ci = { id: col(["member id", "member", "employee id", "id"]), name: col(["name"]), tier: col(["tier", "cover"]), premium: col(["premium", "amount"]) };
  if (ci.id < 0 || ci.premium < 0) return { ok: false, message: "The file needs member id and premium columns." };
  const theirs: CarrierRow[] = parsed.slice(1).filter((r) => r[ci.id]?.trim()).map((r) => ({ memberId: r[ci.id]!.trim(), name: ci.name >= 0 ? r[ci.name] ?? "" : "", tier: ci.tier >= 0 ? (r[ci.tier] ?? "").trim() : "", premium: Number(String(r[ci.premium] ?? "0").replace(/[^0-9.-]/g, "")) || 0 }));
  const result = reconcileCarrier(census.members, theirs.map((t) => ({ ...t, tier: t.tier || census.members.find((m) => m.memberId === t.memberId)?.tier || "" })));
  await prisma.benefitCarrierFile.create({ data: { tenantId, planId, kind: "RECONCILIATION", rowCount: theirs.length, result: result as unknown as Prisma.InputJsonValue, createdBy: actorUserId } });
  return { ok: true, result, message: `${result.matched} matched; ${result.missingAtCarrier.length} missing at the insurer, ${result.extraAtCarrier.length} extra at the insurer, ${result.mismatches.length} premium/tier mismatch(es).` };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export async function benefitReport(tenantId: string, kind: "enrollments" | "plans" | "dependents" | "deductions" | "eligibility", employeeWhere: Prisma.EmployeeWhereInput = {}) {
  if (kind === "plans") {
    const plans = await prisma.benefitPlan.findMany({ where: { tenantId }, include: { _count: { select: { enrollments: { where: { status: "ACTIVE" } } } } }, orderBy: { name: "asc" } });
    return { title: "Benefit plans", head: ["Code", "Plan", "Type", "Provider", "Status", "Monthly premium", "Employer rule", "Employer value", "Waiting days", "Members", "Plan year", "Renewal"], rows: plans.map((p) => [p.code, p.name, p.type, p.provider ?? "", p.status, Number(p.monthlyPremium), p.employerRule, Number(p.employerValue), p.waitingPeriodDays, p._count.enrollments, p.planYearStart ? `${p.planYearStart.toISOString().slice(0, 10)} – ${p.planYearEnd?.toISOString().slice(0, 10) ?? ""}` : "", p.renewalDate]) };
  }
  if (kind === "dependents") {
    const deps = await prisma.dependent.findMany({ where: { employee: { tenantId, ...employeeWhere } }, include: { employee: { select: { displayName: true, employeeNumber: true } } } });
    return { title: "Dependents", head: ["Employee", "Number", "Dependent", "Relationship", "Date of birth", "Nominee", "Proof", "Verified on"], rows: deps.map((d) => [d.employee.displayName, d.employee.employeeNumber, d.name, d.relationship, d.dateOfBirth, d.isNominee ? "Yes" : "No", d.proofUrl ? "Attached" : "Missing", d.verifiedAt]) };
  }
  if (kind === "deductions") {
    const rows = await prisma.benefitDeduction.findMany({ where: { tenantId }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    const enr = new Map((await prisma.benefitEnrollment.findMany({ where: { id: { in: rows.map((r) => r.enrollmentId) } }, include: { plan: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } } })).map((e) => [e.id, e]));
    return { title: "Benefit payroll deductions", head: ["Employee", "Number", "Plan", "Month", "Kind", "Amount"], rows: rows.map((r) => [enr.get(r.enrollmentId)?.employee.displayName, enr.get(r.enrollmentId)?.employee.employeeNumber, enr.get(r.enrollmentId)?.plan.name, `${String(r.month).padStart(2, "0")}/${r.year}`, r.kind, Number(r.amount)]) };
  }
  if (kind === "eligibility") {
    const m = await eligibilityMatrix(tenantId, employeeWhere);
    return { title: "Benefit eligibility", head: ["Employee", "Number", ...m.plans.map((p) => p.name)], rows: m.rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, ...r.cells.map((c) => (c.eligible ? (c.exception ? "Eligible (exception)" : c.waitLeft ? `Eligible after ${c.waitLeft} day(s)` : "Eligible") : c.gaps.join(" ")))]) };
  }
  const rows = await prisma.benefitEnrollment.findMany({ where: { tenantId, employee: employeeWhere }, include: { plan: { select: { name: true, code: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } });
  return { title: "Benefit enrolments", head: ["Employee", "Number", "Plan", "Tier", "Dependents", "Status", "Employee / month", "Employer / month", "Cover from", "Cover to", "End reason", "Requested"], rows: rows.map((e) => [e.employee.displayName, e.employee.employeeNumber, `${e.plan.name} (${e.plan.code})`, e.tier, e.dependentIds.length, e.status, Number(e.employeeMonthly), Number(e.employerMonthly), e.coverageStart, e.coverageEnd, e.endReason ?? "", e.createdAt]) };
}

/** Benefit administrators to notify about the queue. */
export async function benefitAdmins(tenantId: string) {
  return usersWithPermission(tenantId, "payroll.benefit.manage");
}
