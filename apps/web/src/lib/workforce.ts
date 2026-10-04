import "server-only";
import { prisma, type Prisma } from "@keka/db";
import {
  vacancyAging, daysBetween, reconcile, planCost, headcountActuals, headcountPosition, payrollActuals, budgetVariance,
  contractExpiry, vendorCompliance, vendorScore, VENDOR_CHECKLIST, contingentSpendBy, workforceRisk, kindsOfArea, capacityGap,
  type WorkforceArea,
} from "@keka/services";

/**
 * Data loaders shared by the workforce pages and their CSV exports, so a
 * report on screen and its download always agree.
 */

export type NameMap = Map<string, string>;

export async function orgNames(tenantId: string) {
  const [depts, locs, ccs, grades, emps, users, jobs] = await Promise.all([
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.payGrade.findMany({ where: { tenantId }, select: { id: true, name: true, minAnnual: true, maxAnnual: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId }, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, status: true }, orderBy: { firstName: "asc" } }),
    prisma.user.findMany({ where: { tenantId }, select: { id: true, email: true } }),
    prisma.jobProfile.findMany({ where: { tenantId }, select: { id: true, code: true, title: true, status: true }, orderBy: { code: "asc" } }),
  ]);
  const m = <T extends { id: string }>(rows: T[], f: (r: T) => string): NameMap => new Map(rows.map((r) => [r.id, f(r)]));
  return {
    departments: depts, locations: locs, costCenters: ccs, payGrades: grades, employees: emps, jobs,
    dept: m(depts, (d) => d.name), loc: m(locs, (l) => l.name), cc: m(ccs, (c) => c.name), grade: m(grades, (g) => g.name),
    emp: m(emps, (e) => `${e.displayName ?? `${e.firstName} ${e.lastName}`} (${e.employeeNumber})`), user: m(users, (u) => u.email),
    job: m(jobs, (j) => `${j.code} ${j.title}`),
  };
}

// ---------------------------------------------------------------------------
//  Positions
// ---------------------------------------------------------------------------

export interface PositionFilter { q?: string; status?: string; departmentId?: string; criticality?: string }

export function positionWhere(tenantId: string, f: PositionFilter): Prisma.PositionWhereInput {
  const q = f.q?.trim();
  return {
    tenantId,
    ...(f.status ? { status: f.status as never } : {}),
    ...(f.departmentId ? { departmentId: f.departmentId } : {}),
    ...(f.criticality ? { criticality: f.criticality } : {}),
    ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { skills: { has: q } }, { job: { title: { contains: q, mode: "insensitive" } } }] } : {}),
  };
}

export async function positionRows(tenantId: string, f: PositionFilter) {
  return prisma.position.findMany({ where: positionWhere(tenantId, f), include: { job: { select: { code: true, title: true, status: true } } }, orderBy: { code: "asc" }, take: 2000 });
}

export async function vacancyReport(tenantId: string, today = new Date()) {
  const vacant = await prisma.position.findMany({ where: { tenantId, status: { in: ["VACANT", "FROZEN"] } }, include: { job: { select: { title: true } } }, orderBy: { vacantSince: "asc" } });
  const aging = vacancyAging(vacant.filter((p) => p.status === "VACANT").map((p) => p.vacantSince), today);
  const budget = vacant.filter((p) => p.status === "VACANT").reduce((s, p) => s + Number(p.budgetedAnnualSalary ?? 0), 0);
  return { vacant: vacant.map((p) => ({ ...p, ageDays: p.vacantSince ? Math.max(0, daysBetween(p.vacantSince, today)) : 0 })), aging, vacantBudget: budget };
}

export async function reconciliationReport(tenantId: string) {
  const [positions, emps] = await Promise.all([
    prisma.position.groupBy({ by: ["departmentId", "status"], where: { tenantId, isHeadcount: true, status: { in: ["FILLED", "VACANT"] } }, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ["departmentId"], where: { tenantId, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] } }, _count: { _all: true } }),
  ]);
  const keys = new Set<string | null>([...positions.map((p) => p.departmentId), ...emps.map((e) => e.departmentId)]);
  return reconcile([...keys].map((k) => ({
    departmentId: k,
    filledPositions: positions.filter((p) => p.departmentId === k && p.status === "FILLED").reduce((s, p) => s + p._count._all, 0),
    vacantPositions: positions.filter((p) => p.departmentId === k && p.status === "VACANT").reduce((s, p) => s + p._count._all, 0),
    activeEmployees: emps.find((e) => e.departmentId === k)?._count._all ?? 0,
  })));
}

// ---------------------------------------------------------------------------
//  Requests and audit
// ---------------------------------------------------------------------------

export async function requestsOf(tenantId: string, area: WorkforceArea, status?: string) {
  return prisma.workforceRequest.findMany({
    where: { tenantId, kind: { in: kindsOfArea(area) }, ...(status ? { status: status as never } : {}) },
    orderBy: { requestedAt: "desc" }, take: 500,
  });
}

export async function auditTrail(tenantId: string, entityTypes: string[], entityId: string) {
  return prisma.auditLog.findMany({ where: { tenantId, entityType: { in: entityTypes }, entityId }, orderBy: { createdAt: "desc" }, take: 200 });
}

// ---------------------------------------------------------------------------
//  Workforce planning
// ---------------------------------------------------------------------------

type PlanWithLines = Prisma.WorkforcePlanGetPayload<{ include: { lines: true } }>;

export function costOf(plan: PlanWithLines) {
  return planCost(plan.lines.map((l) => ({ ...l, avgAnnualSalary: Number(l.avgAnnualSalary) })), {
    attritionPct: Number(plan.attritionPct), salaryIncreasePct: Number(plan.salaryIncreasePct), benefitsLoadPct: Number(plan.benefitsLoadPct),
    overtimePct: Number(plan.overtimePct), contractorCost: Number(plan.contractorCost),
  });
}

/** Planned vs live headcount per department line of a plan. */
export async function headcountVsPlan(tenantId: string, plan: PlanWithLines) {
  const live = await headcountActuals(tenantId);
  const byDept = new Map<string, number>();
  for (const l of plan.lines) byDept.set(l.departmentId, (byDept.get(l.departmentId) ?? 0) + l.plannedHeadcount);
  return [...byDept.entries()].map(([departmentId, planned]) => {
    const a = live.get(departmentId) ?? { active: 0, preJoining: 0, exiting: 0, openRequisitions: 0 };
    return { departmentId, ...headcountPosition({ planned, ...a }) };
  });
}

/** Budget vs payroll actual for the budget's year and department. */
export async function budgetActuals(tenantId: string, b: { fiscalYear: number; departmentId: string | null; salaryBudget: unknown; benefitsBudget: unknown; contractorBudget: unknown; hiringBudget: unknown }) {
  const actual = await payrollActuals(tenantId, b.fiscalYear, b.departmentId);
  const contractor = await contingentSpendTotal(tenantId, b.fiscalYear, b.departmentId);
  const budgetTotal = Number(b.salaryBudget) + Number(b.benefitsBudget) + Number(b.contractorBudget) + Number(b.hiringBudget);
  return {
    actual, contractor,
    salary: budgetVariance(Number(b.salaryBudget), actual.salary),
    benefits: budgetVariance(Number(b.benefitsBudget), actual.employer),
    contractorVar: budgetVariance(Number(b.contractorBudget), contractor),
    total: budgetVariance(budgetTotal, actual.total + contractor), budgetTotal,
  };
}

/** Capacity: each role's FTE demand against active employees holding that job title (in the line's department). */
export async function capacitySupply(tenantId: string, plan: { departmentId: string | null; lines: Array<{ id: string; role: string; departmentId: string | null; demandFte: unknown }> }) {
  return Promise.all(plan.lines.map(async (l) => {
    const dept = l.departmentId ?? plan.departmentId;
    const supply = await prisma.employee.count({
      where: { tenantId, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] }, jobTitleName: { equals: l.role, mode: "insensitive" }, ...(dept ? { departmentId: dept } : {}) },
    });
    const demand = Number(l.demandFte);
    return { id: l.id, role: l.role, departmentId: dept, demand, supply, gap: capacityGap(demand, supply) };
  }));
}

/** Workforce risk heatmap rows, per department. */
export async function riskHeatmap(tenantId: string, fiscalYear: number) {
  const [live, plans, vacant] = await Promise.all([
    headcountActuals(tenantId),
    prisma.workforcePlan.findMany({ where: { tenantId, fiscalYear, isActive: true }, include: { lines: true } }),
    prisma.position.groupBy({ by: ["departmentId", "criticality"], where: { tenantId, status: "VACANT" }, _count: { _all: true } }),
  ]);
  const planned = new Map<string, number>();
  for (const p of plans) for (const l of p.lines) planned.set(l.departmentId, (planned.get(l.departmentId) ?? 0) + l.plannedHeadcount);
  const depts = new Set<string>([...live.keys()].filter(Boolean));
  for (const k of planned.keys()) depts.add(k);
  return [...depts].map((d) => {
    const a = live.get(d) ?? { active: 0, preJoining: 0, exiting: 0, openRequisitions: 0 };
    const v = vacant.filter((x) => x.departmentId === d);
    const vacantCount = v.reduce((s, x) => s + x._count._all, 0);
    const criticalVacant = v.filter((x) => x.criticality === "CRITICAL" || x.criticality === "HIGH").reduce((s, x) => s + x._count._all, 0);
    return { departmentId: d, planned: planned.get(d) ?? 0, active: a.active, exiting: a.exiting, vacant: vacantCount, criticalVacant, ...workforceRisk({ planned: planned.get(d) ?? 0, active: a.active, exiting: a.exiting, vacant: vacantCount, criticalVacant }) };
  }).sort((x, y) => y.score - x.score);
}

// ---------------------------------------------------------------------------
//  Contingent workforce
// ---------------------------------------------------------------------------

export interface WorkerFilter { q?: string; status?: string; vendorId?: string; kind?: string }

export async function workerRows(tenantId: string, f: WorkerFilter) {
  const q = f.q?.trim();
  return prisma.contingentWorker.findMany({
    where: {
      tenantId,
      ...(f.status ? { status: f.status } : {}),
      ...(f.vendorId ? { vendorId: f.vendorId } : {}),
      ...(f.kind ? { workerKind: f.kind } : {}),
      ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { skills: { has: q } }, { assignments: { some: { OR: [{ poNumber: { contains: q, mode: "insensitive" } }, { role: { contains: q, mode: "insensitive" } }] } } }] } : {}),
    },
    include: { vendor: { select: { name: true } }, assignments: { orderBy: { startDate: "desc" } }, paymentProfile: { select: { status: true } } },
    orderBy: { code: "asc" }, take: 2000,
  });
}

export async function expiringContracts(tenantId: string, today = new Date(), withinDays = 30) {
  const rows = await prisma.contractAssignment.findMany({
    where: { tenantId, status: "ACTIVE", endDate: { lte: new Date(today.getTime() + withinDays * 86_400_000) } },
    include: { worker: { select: { id: true, code: true, firstName: true, lastName: true } } }, orderBy: { endDate: "asc" },
  });
  return rows.map((a) => ({ ...a, expiry: contractExpiry(a.endDate, today) }));
}

/** Contingent spend: approved timesheets and expenses, paid milestones. */
export async function contingentSpend(tenantId: string, from?: Date, to?: Date) {
  const range = from && to ? { gte: from, lte: to } : undefined;
  const [ts, ex, ms] = await Promise.all([
    prisma.contractorTimesheet.findMany({ where: { tenantId, status: "APPROVED", ...(range ? { periodEnd: range } : {}) }, include: { assignment: { include: { worker: { select: { vendorId: true, code: true } } } } } }),
    prisma.contractorExpense.findMany({ where: { tenantId, status: "APPROVED", ...(range ? { date: range } : {}) }, include: { assignment: { include: { worker: { select: { vendorId: true, code: true } } } } } }),
    prisma.sowMilestone.findMany({ where: { assignment: { tenantId }, status: "PAID", ...(range ? { dueDate: range } : {}) }, include: { assignment: { include: { worker: { select: { vendorId: true, code: true } } } } } }),
  ]);
  return [
    ...ts.map((t) => ({ type: "Timesheet", date: t.periodEnd, amount: Number(t.amount), departmentId: t.assignment.departmentId, vendorId: t.assignment.worker.vendorId, worker: t.assignment.worker.code, role: t.assignment.role })),
    ...ex.map((e) => ({ type: "Expense", date: e.date, amount: Number(e.amount), departmentId: e.assignment.departmentId, vendorId: e.assignment.worker.vendorId, worker: e.assignment.worker.code, role: e.assignment.role })),
    ...ms.map((m) => ({ type: "Milestone", date: m.dueDate, amount: Number(m.amount), departmentId: m.assignment.departmentId, vendorId: m.assignment.worker.vendorId, worker: m.assignment.worker.code, role: m.assignment.role })),
  ];
}

export async function contingentSpendTotal(tenantId: string, fiscalYear: number, departmentId: string | null): Promise<number> {
  const rows = await contingentSpend(tenantId, new Date(Date.UTC(fiscalYear, 3, 1)), new Date(Date.UTC(fiscalYear + 1, 2, 31)));
  return Math.round(rows.filter((r) => !departmentId || r.departmentId === departmentId).reduce((s, r) => s + r.amount, 0) * 100) / 100;
}

export function spendRollups(rows: Awaited<ReturnType<typeof contingentSpend>>, names: { vendor: NameMap; dept: NameMap }) {
  return {
    byVendor: contingentSpendBy(rows, (r) => (r.vendorId ? names.vendor.get(r.vendorId) ?? "—" : "Independent contractors"), (r) => r.amount),
    byDepartment: contingentSpendBy(rows, (r) => (r.departmentId ? names.dept.get(r.departmentId) ?? "—" : "No department"), (r) => r.amount),
    byType: contingentSpendBy(rows, (r) => r.type, (r) => r.amount),
    total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
  };
}

export async function vendorScorecards(tenantId: string, today = new Date()) {
  const vendors = await prisma.contingentVendor.findMany({ where: { tenantId }, include: { documents: true, workers: { select: { id: true, status: true, feedback: { select: { rating: true } } } } }, orderBy: { name: "asc" } });
  return vendors.map((v) => {
    const compliance = vendorCompliance(v.documents, today);
    const ratings = v.workers.flatMap((w) => w.feedback.map((f) => f.rating));
    return {
      id: v.id, name: v.name, status: v.status, activeWorkers: v.workers.filter((w) => w.status === "ACTIVE").length, compliance,
      checklistDone: v.checklist.length, checklistTotal: VENDOR_CHECKLIST.length,
      ...vendorScore({ ratings, compliant: compliance.compliant, checklistDone: v.checklist.length, checklistTotal: VENDOR_CHECKLIST.length }),
    };
  });
}

/** CSV download response, with the export itself audited. */
export async function csvResponse(viewer: { tenantId: string; user: { id: string; email: string } }, name: string, csv: string, rows: number, entityType: string) {
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType, summary: `Exported ${name} (${rows} row${rows === 1 ? "" : "s"})`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
