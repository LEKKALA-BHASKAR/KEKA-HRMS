"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  submitWorkforceRequest, headcountActuals, planCost, scaleLines, replacementHiresFor, PLAN_TEMPLATES, fiscalYearLabel,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zOptionalId, zId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/workforce-planning", "/workforce-planning/approvals", "/workforce-planning/scenarios", "/workforce-planning/budgets", "/workforce-planning/capacity"];
const EDITABLE = ["DRAFT", "REJECTED"];

// ---------------------------------------------------------------------------
//  Workforce plans and headcount lines
// ---------------------------------------------------------------------------

const pct = () => zNumber({ min: 0, max: 100 });
const planSchema = z.object({
  id: zOptionalId(),
  name: zName(120),
  fiscalYear: zRequiredNumber({ min: 2000, max: 2100 }),
  departmentId: zOptionalId(),
  template: zOptional(20),
  attritionPct: pct(),
  salaryIncreasePct: pct(),
  benefitsLoadPct: pct(),
  overtimePct: pct(),
  contractorCost: zNumber({ min: 0 }),
  notes: zOptional(2000),
  isTemplate: z.string().optional().transform((v) => v === "on"),
});

export async function savePlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(planSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId });
  if (foreign) return { ok: false, message: foreign };
  const t = d.template ? PLAN_TEMPLATES[d.template] : null;
  if (d.template && !t) return { ok: false, message: "Unknown template." };
  const pick = (v: number | null, k: keyof typeof PLAN_TEMPLATES.STEADY.assumptions) => v ?? t?.assumptions[k] ?? 0;
  const data = {
    name: d.name, fiscalYear: d.fiscalYear, departmentId: d.departmentId, notes: d.notes, isTemplate: d.isTemplate,
    attritionPct: pick(d.attritionPct, "attritionPct"), salaryIncreasePct: pick(d.salaryIncreasePct, "salaryIncreasePct"),
    benefitsLoadPct: pick(d.benefitsLoadPct, "benefitsLoadPct"), overtimePct: pick(d.overtimePct, "overtimePct"), contractorCost: pick(d.contractorCost, "contractorCost"),
  };
  try {
    if (d.id) {
      const before = await prisma.workforcePlan.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Plan not found." };
      if (!EDITABLE.includes(before.status)) return { ok: false, message: "Only a draft or rejected plan can be changed. Copy it as a scenario to rework an approved plan." };
      await prisma.workforcePlan.update({ where: { id: d.id }, data: { ...data, status: "DRAFT" } });
      await writeAudit(viewer, {
        module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: d.id, summary: `Updated workforce plan ${d.name}`,
        oldValue: { attritionPct: Number(before.attritionPct), salaryIncreasePct: Number(before.salaryIncreasePct), benefitsLoadPct: Number(before.benefitsLoadPct), overtimePct: Number(before.overtimePct), contractorCost: Number(before.contractorCost) },
        newValue: { attritionPct: data.attritionPct, salaryIncreasePct: data.salaryIncreasePct, benefitsLoadPct: data.benefitsLoadPct, overtimePct: data.overtimePct, contractorCost: data.contractorCost },
      });
      return done([...PATHS, `/workforce-planning/${d.id}`], "Plan saved.");
    }
    // Starting from a template plan copies its lines.
    const fromId = String(formData.get("copyFromId") ?? "");
    const from = fromId ? await prisma.workforcePlan.findFirst({ where: { id: fromId, tenantId: viewer.tenantId }, include: { lines: true } }) : null;
    const plan = await prisma.workforcePlan.create({
      data: {
        tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id, baseplanId: from?.id ?? null,
        lines: from ? { create: from.lines.map(({ id: _i, planId: _p, ...l }) => l) } : undefined,
      },
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Created workforce plan ${d.name} (${fiscalYearLabel(d.fiscalYear)})${from ? ` from ${from.name}` : ""}` });
    return { ...done(PATHS, `Created ${d.name}. Add headcount lines, then submit it for approval.`), values: { id: plan.id } };
  } catch (err) {
    return toErrorState(err);
  }
}

const lineSchema = z.object({
  planId: zId(),
  lineId: zOptionalId(),
  departmentId: zId(),
  locationId: zOptionalId(),
  jobId: zOptionalId(),
  plannedHeadcount: zRequiredNumber({ min: 0, max: 100000 }),
  newHires: zNumber({ min: 0, max: 100000 }),
  replacementHires: zNumber({ min: 0, max: 100000 }),
  avgAnnualSalary: zNumber({ min: 0 }),
  hireMonth: zNumber({ min: 1, max: 12 }),
  note: zOptional(500),
});

async function editablePlan(tenantId: string, id: string) {
  const plan = await prisma.workforcePlan.findFirst({ where: { id, tenantId } });
  if (!plan) return { plan: null, problem: "Plan not found." };
  if (!EDITABLE.includes(plan.status)) return { plan, problem: "Only a draft or rejected plan can be changed." };
  return { plan, problem: null };
}

export async function savePlanLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(lineSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const { plan, problem } = await editablePlan(viewer.tenantId, d.planId);
  if (problem || !plan) return { ok: false, message: problem ?? "Plan not found." };
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, location: d.locationId });
  if (foreign) return { ok: false, message: foreign };
  if (d.jobId && !(await prisma.jobProfile.findFirst({ where: { id: d.jobId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Job not found." };
  if ((d.newHires ?? 0) > d.plannedHeadcount) return { ok: false, message: "New hires cannot exceed the planned headcount.", errors: { newHires: "Too many" } };
  const data = {
    departmentId: d.departmentId, locationId: d.locationId, jobId: d.jobId, plannedHeadcount: d.plannedHeadcount,
    newHires: d.newHires ?? 0, replacementHires: d.replacementHires ?? 0, avgAnnualSalary: d.avgAnnualSalary ?? 0, hireMonth: d.hireMonth ?? 1, note: d.note,
  };
  if (d.lineId) {
    const line = await prisma.workforcePlanLine.findFirst({ where: { id: d.lineId, planId: plan.id } });
    if (!line) return { ok: false, message: "Line not found." };
    await prisma.workforcePlanLine.update({ where: { id: line.id }, data });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Changed a headcount line of ${plan.name}`, oldValue: { plannedHeadcount: line.plannedHeadcount, newHires: line.newHires, avgAnnualSalary: Number(line.avgAnnualSalary) }, newValue: { plannedHeadcount: data.plannedHeadcount, newHires: data.newHires, avgAnnualSalary: data.avgAnnualSalary } });
  } else {
    await prisma.workforcePlanLine.create({ data: { planId: plan.id, ...data } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Added a headcount line (${data.plannedHeadcount}) to ${plan.name}` });
  }
  return done([...PATHS, `/workforce-planning/${plan.id}`], "Line saved.");
}

export async function deletePlanLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const line = await prisma.workforcePlanLine.findFirst({ where: { id: String(formData.get("id") ?? ""), plan: { tenantId: viewer.tenantId } } });
  if (!line) return { ok: false, message: "Line not found." };
  const { plan, problem } = await editablePlan(viewer.tenantId, line.planId);
  if (problem || !plan) return { ok: false, message: problem ?? "Plan not found." };
  await prisma.workforcePlanLine.delete({ where: { id: line.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Removed a headcount line from ${plan.name}` });
  return done([`/workforce-planning/${plan.id}`], "Line removed.");
}

/**
 * Position demand forecast: fill a plan with one line per department from
 * live headcount (active + pre-joining + open requisitions), replacement
 * hires for the plan's attrition assumption, and the department's current
 * average CTC.
 */
export async function forecastPlanLinesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const { plan, problem } = await editablePlan(viewer.tenantId, String(formData.get("planId") ?? ""));
  if (problem || !plan) return { ok: false, message: problem ?? "Plan not found." };
  const live = await headcountActuals(viewer.tenantId);
  const depts = await prisma.department.findMany({ where: { tenantId: viewer.tenantId, isActive: true, ...(plan.departmentId ? { id: plan.departmentId } : {}) }, select: { id: true } });
  const existing = new Set((await prisma.workforcePlanLine.findMany({ where: { planId: plan.id }, select: { departmentId: true } })).map((l) => l.departmentId));
  const ctc = await averageCtcByDepartment(viewer.tenantId);
  let added = 0;
  for (const dpt of depts) {
    if (existing.has(dpt.id)) continue;
    const a = live.get(dpt.id);
    if (!a) continue;
    const current = a.active + a.preJoining;
    await prisma.workforcePlanLine.create({
      data: {
        planId: plan.id, departmentId: dpt.id, plannedHeadcount: current + a.openRequisitions, newHires: a.openRequisitions,
        replacementHires: replacementHiresFor(a.active, Number(plan.attritionPct)), avgAnnualSalary: ctc.get(dpt.id) ?? 0, hireMonth: 1,
        note: "Forecast from live headcount and open requisitions",
      },
    });
    added++;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Forecast ${added} headcount line(s) for ${plan.name}` });
  return done([`/workforce-planning/${plan.id}`], added ? `Added ${added} forecast line(s).` : "Every department already has a line.");
}

async function averageCtcByDepartment(tenantId: string): Promise<Map<string, number>> {
  const emps = await prisma.employee.findMany({
    where: { tenantId, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] }, departmentId: { not: null } },
    select: { departmentId: true, salaryRevisions: { where: { status: "APPLIED", effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } } },
  });
  const sums = new Map<string, { s: number; n: number }>();
  for (const e of emps) {
    const c = e.salaryRevisions[0];
    if (!c) continue;
    const r = sums.get(e.departmentId!) ?? { s: 0, n: 0 };
    r.s += Number(c.annualCtc); r.n++;
    sums.set(e.departmentId!, r);
  }
  return new Map([...sums.entries()].map(([k, v]) => [k, Math.round(v.s / v.n)]));
}

/** Submit a plan, budget or capacity plan for approval (kind = plan | budget | capacity). */
export async function submitPlanningAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  const where = { id, tenantId: viewer.tenantId };
  if (kind === "plan") {
    const plan = await prisma.workforcePlan.findFirst({ where, include: { _count: { select: { lines: true } } } });
    if (!plan) return { ok: false, message: "Plan not found." };
    if (!EDITABLE.includes(plan.status)) return { ok: false, message: "Only a draft or rejected plan can be submitted." };
    if (plan._count.lines === 0) return { ok: false, message: "Add at least one headcount line first." };
    const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "PLAN", entityType: "WorkforcePlan", entityId: id, label: `${plan.name} (${fiscalYearLabel(plan.fiscalYear)})${plan.isScenario ? " — scenario" : ""}`, by: viewer.user.id });
    if (!res.ok) return res;
    await prisma.workforcePlan.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedBy: viewer.user.id, submittedAt: new Date() } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: id, summary: `Submitted ${plan.name} for approval` });
    return done([...PATHS, `/workforce-planning/${id}`], "Plan sent for approval.");
  }
  if (kind === "budget") {
    const b = await prisma.workforceBudget.findFirst({ where });
    if (!b) return { ok: false, message: "Budget not found." };
    if (!EDITABLE.includes(b.status)) return { ok: false, message: "Only a draft or rejected budget can be submitted." };
    const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "BUDGET", entityType: "WorkforceBudget", entityId: id, label: `${b.name} v${b.version}`, by: viewer.user.id });
    if (!res.ok) return res;
    await prisma.workforceBudget.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforceBudget", entityId: id, summary: `Submitted budget ${b.name} v${b.version} for approval` });
    return done(PATHS, "Budget sent for approval.");
  }
  if (kind === "capacity") {
    const c = await prisma.capacityPlan.findFirst({ where, include: { _count: { select: { lines: true } } } });
    if (!c) return { ok: false, message: "Capacity plan not found." };
    if (!EDITABLE.includes(c.status)) return { ok: false, message: "Only a draft or rejected capacity plan can be submitted." };
    if (c._count.lines === 0) return { ok: false, message: "Add at least one role first." };
    const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "CAPACITY", entityType: "CapacityPlan", entityId: id, label: c.name, by: viewer.user.id });
    if (!res.ok) return res;
    await prisma.capacityPlan.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CapacityPlan", entityId: id, summary: `Submitted capacity plan ${c.name} for approval` });
    return done(PATHS, "Capacity plan sent for approval.");
  }
  return { ok: false, message: "Unknown kind." };
}

/**
 * Put an approved plan in force for its year and department. Hiring beyond
 * it (positions, requisitions, new employees) is then flagged. An approved
 * scenario becomes the plan.
 */
export async function activatePlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const plan = await prisma.workforcePlan.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Plan not found." };
  if (plan.status !== "ACTIVE") return { ok: false, message: "Only an approved plan can be activated." };
  await prisma.$transaction([
    prisma.workforcePlan.updateMany({ where: { tenantId: viewer.tenantId, fiscalYear: plan.fiscalYear, departmentId: plan.departmentId, isActive: true }, data: { isActive: false } }),
    prisma.workforcePlan.update({ where: { id: plan.id }, data: { isActive: true, isScenario: false } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforcePlan", entityId: plan.id, summary: `Activated ${plan.name} for ${fiscalYearLabel(plan.fiscalYear)}` });
  return done([...PATHS, `/workforce-planning/${plan.id}`], `${plan.name} is now the plan in force.`);
}

const scenarioSchema = z.object({
  planId: zId(),
  name: zName(120),
  headcountChangePct: zNumber({ min: -90, max: 300 }),
  salaryIncreasePct: zNumber({ min: 0, max: 100 }),
  attritionPct: zNumber({ min: 0, max: 100 }),
});

/** Copy a plan as a scenario, scaling headcount and changing the increment and attrition. */
export async function createScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(scenarioSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const base = await prisma.workforcePlan.findFirst({ where: { id: d.planId, tenantId: viewer.tenantId }, include: { lines: true } });
  if (!base) return { ok: false, message: "Plan not found." };
  const lines = scaleLines(base.lines.map((l) => ({ ...l, avgAnnualSalary: Number(l.avgAnnualSalary) })), d.headcountChangePct ?? 0);
  const s = await prisma.workforcePlan.create({
    data: {
      tenantId: viewer.tenantId, name: d.name, fiscalYear: base.fiscalYear, departmentId: base.departmentId, isScenario: true, baseplanId: base.id,
      attritionPct: d.attritionPct ?? base.attritionPct, salaryIncreasePct: d.salaryIncreasePct ?? base.salaryIncreasePct,
      benefitsLoadPct: base.benefitsLoadPct, overtimePct: base.overtimePct, contractorCost: base.contractorCost,
      notes: `Scenario of ${base.name}: headcount ${d.headcountChangePct ?? 0}%`, createdBy: viewer.user.id,
      lines: { create: lines.map(({ id: _i, planId: _p, ...l }) => l) },
    },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WorkforcePlan", entityId: s.id, summary: `Created scenario ${d.name} from ${base.name}`, newValue: { headcountChangePct: d.headcountChangePct, salaryIncreasePct: d.salaryIncreasePct, attritionPct: d.attritionPct } });
  return { ...done(PATHS, `Created scenario ${d.name}.`), values: { id: s.id } };
}

// ---------------------------------------------------------------------------
//  Budgets (versioned)
// ---------------------------------------------------------------------------

const budgetSchema = z.object({
  id: zOptionalId(),
  name: zName(120),
  fiscalYear: zRequiredNumber({ min: 2000, max: 2100 }),
  departmentId: zOptionalId(),
  planId: zOptionalId(),
  salaryBudget: zNumber({ min: 0 }),
  benefitsBudget: zNumber({ min: 0 }),
  hiringBudget: zNumber({ min: 0 }),
  contractorBudget: zNumber({ min: 0 }),
  notes: zOptional(2000),
});

export async function saveBudgetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(budgetSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId });
  if (foreign) return { ok: false, message: foreign };
  if (d.planId && !(await prisma.workforcePlan.findFirst({ where: { id: d.planId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Plan not found." };
  const data = { name: d.name, fiscalYear: d.fiscalYear, departmentId: d.departmentId, planId: d.planId, salaryBudget: d.salaryBudget ?? 0, benefitsBudget: d.benefitsBudget ?? 0, hiringBudget: d.hiringBudget ?? 0, contractorBudget: d.contractorBudget ?? 0, notes: d.notes };
  if (d.id) {
    const before = await prisma.workforceBudget.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
    if (!before) return { ok: false, message: "Budget not found." };
    if (!EDITABLE.includes(before.status)) return { ok: false, message: "An approved budget is locked. Revise it to create a new version." };
    await prisma.workforceBudget.update({ where: { id: d.id }, data: { ...data, status: "DRAFT" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WorkforceBudget", entityId: d.id, summary: `Updated budget ${d.name} v${before.version}`, oldValue: { salaryBudget: Number(before.salaryBudget), benefitsBudget: Number(before.benefitsBudget), hiringBudget: Number(before.hiringBudget), contractorBudget: Number(before.contractorBudget) }, newValue: { salaryBudget: data.salaryBudget, benefitsBudget: data.benefitsBudget, hiringBudget: data.hiringBudget, contractorBudget: data.contractorBudget } });
    return done(PATHS, "Budget saved.");
  }
  const b = await prisma.workforceBudget.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WorkforceBudget", entityId: b.id, summary: `Created budget ${d.name} for ${fiscalYearLabel(d.fiscalYear)}` });
  return { ...done(PATHS, `Created budget ${d.name}.`), values: { id: b.id } };
}

/** Budget from a plan: salary, benefits and contractor lines from the plan's cost model. */
export async function budgetFromPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const plan = await prisma.workforcePlan.findFirst({ where: { id: String(formData.get("planId") ?? ""), tenantId: viewer.tenantId }, include: { lines: true } });
  if (!plan) return { ok: false, message: "Plan not found." };
  const cost = planCost(plan.lines.map((l) => ({ ...l, avgAnnualSalary: Number(l.avgAnnualSalary) })), {
    attritionPct: Number(plan.attritionPct), salaryIncreasePct: Number(plan.salaryIncreasePct), benefitsLoadPct: Number(plan.benefitsLoadPct), overtimePct: Number(plan.overtimePct), contractorCost: Number(plan.contractorCost),
  });
  const newHireSalary = plan.lines.reduce((s, l) => s + l.newHires * Number(l.avgAnnualSalary), 0);
  const b = await prisma.workforceBudget.create({
    data: {
      tenantId: viewer.tenantId, name: `${plan.name} budget`, fiscalYear: plan.fiscalYear, departmentId: plan.departmentId, planId: plan.id,
      salaryBudget: cost.salary + cost.overtime, benefitsBudget: cost.benefits, contractorBudget: cost.contractor, hiringBudget: Math.round(newHireSalary * 0.083), createdBy: viewer.user.id,
      notes: "Built from the plan's cost model; hiring budget at one month's salary per new hire.",
    },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WorkforceBudget", entityId: b.id, summary: `Built budget from plan ${plan.name}`, newValue: cost });
  return { ...done(PATHS, `Created ${b.name}.`), values: { id: b.id } };
}

/** Budget version control: a revision is a new draft version; the old one stays for history. */
export async function reviseBudgetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const b = await prisma.workforceBudget.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!b) return { ok: false, message: "Budget not found." };
  if (!b.isCurrent) return { ok: false, message: "Revise the current version." };
  if (b.status === "PENDING_APPROVAL") return { ok: false, message: "Wait for the pending approval first." };
  const { id: _id, createdAt: _c, updatedAt: _u, approvedAt: _a, approvedBy: _ab, ...rest } = b;
  const next = await prisma.$transaction(async (tx) => {
    await tx.workforceBudget.update({ where: { id: b.id }, data: { isCurrent: false } });
    return tx.workforceBudget.create({ data: { ...rest, version: b.version + 1, previousId: b.id, status: "DRAFT", isCurrent: true, createdBy: viewer.user.id } });
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WorkforceBudget", entityId: next.id, summary: `Revised budget ${b.name}: v${b.version} → v${next.version}` });
  return { ...done(PATHS, `Created v${next.version} as a draft.`), values: { id: next.id } };
}

// ---------------------------------------------------------------------------
//  Capacity plans
// ---------------------------------------------------------------------------

const capacitySchema = z.object({
  id: zOptionalId(),
  name: zName(120),
  departmentId: zOptionalId(),
  periodStart: zRequiredDate(),
  periodEnd: zRequiredDate(),
  notes: zOptional(2000),
});

export async function saveCapacityPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(capacitySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;
  if (data.periodEnd < data.periodStart) return { ok: false, message: "The period must end after it starts.", errors: { periodEnd: "Before start" } };
  const foreign = await foreignReference(viewer.tenantId, { department: data.departmentId });
  if (foreign) return { ok: false, message: foreign };
  if (id) {
    const before = await prisma.capacityPlan.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!before) return { ok: false, message: "Capacity plan not found." };
    if (!EDITABLE.includes(before.status)) return { ok: false, message: "Only a draft or rejected capacity plan can be changed." };
    await prisma.capacityPlan.update({ where: { id }, data: { ...data, status: "DRAFT" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CapacityPlan", entityId: id, summary: `Updated capacity plan ${data.name}` });
    return done(PATHS, "Capacity plan saved.");
  }
  const c = await prisma.capacityPlan.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CapacityPlan", entityId: c.id, summary: `Created capacity plan ${data.name}` });
  return { ...done(PATHS, `Created ${data.name}.`), values: { id: c.id } };
}

const capacityLineSchema = z.object({
  planId: zId(),
  role: zName(120),
  departmentId: zOptionalId(),
  demandFte: zRequiredNumber({ min: 0, max: 100000 }),
  note: zOptional(500),
});

export async function saveCapacityLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const parsed = parseForm(capacityLineSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const c = await prisma.capacityPlan.findFirst({ where: { id: d.planId, tenantId: viewer.tenantId } });
  if (!c) return { ok: false, message: "Capacity plan not found." };
  if (!EDITABLE.includes(c.status)) return { ok: false, message: "Only a draft or rejected capacity plan can be changed." };
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId });
  if (foreign) return { ok: false, message: foreign };
  await prisma.capacityPlanLine.create({ data: { planId: c.id, role: d.role, departmentId: d.departmentId ?? c.departmentId, demandFte: d.demandFte, note: d.note } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CapacityPlan", entityId: c.id, summary: `Added demand ${d.demandFte} FTE ${d.role} to ${c.name}` });
  return done(PATHS, "Role added.");
}

export async function deleteCapacityLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_MANAGE);
  const line = await prisma.capacityPlanLine.findFirst({ where: { id: String(formData.get("id") ?? ""), plan: { tenantId: viewer.tenantId } }, include: { plan: true } });
  if (!line) return { ok: false, message: "Line not found." };
  if (!EDITABLE.includes(line.plan.status)) return { ok: false, message: "Only a draft or rejected capacity plan can be changed." };
  await prisma.capacityPlanLine.delete({ where: { id: line.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "CapacityPlan", entityId: line.planId, summary: `Removed ${line.role} from ${line.plan.name}` });
  return done(PATHS, "Role removed.");
}
