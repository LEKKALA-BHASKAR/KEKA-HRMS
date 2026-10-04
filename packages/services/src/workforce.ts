import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { contractExpiry, fiscalMonths, fiscalYearOf, headcountPosition, nextWorkforceCode } from "./workforce-math";

/**
 * Positions, workforce planning and the contingent workforce: the approval
 * engine shared by all three, live headcount and payroll actuals for plans,
 * and the nightly job (contract expiry alerts and ends, vacating seats whose
 * incumbent has left).
 */

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const today0 = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export type WorkforceArea = "positions" | "planning" | "contingent";

/** Every request kind: who may decide it and where it is listed. */
export const REQUEST_KINDS: Record<string, { label: string; permission: string; area: WorkforceArea; link: string }> = {
  JOB_FAMILY: { label: "Activate job family", permission: "org.position.approve", area: "positions", link: "/positions/architecture" },
  JOB_LEVEL: { label: "Activate job level", permission: "org.position.approve", area: "positions", link: "/positions/architecture" },
  JOB_DESCRIPTION: { label: "Approve job description", permission: "org.position.approve", area: "positions", link: "/positions/jobs" },
  POSITION_CREATE: { label: "Open position", permission: "org.position.approve", area: "positions", link: "/positions" },
  POSITION_FREEZE: { label: "Freeze position", permission: "org.position.approve", area: "positions", link: "/positions" },
  POSITION_UNFREEZE: { label: "Unfreeze position", permission: "org.position.approve", area: "positions", link: "/positions" },
  POSITION_CLOSE: { label: "Close position", permission: "org.position.approve", area: "positions", link: "/positions" },
  PLAN: { label: "Approve workforce plan", permission: "org.workforce_plan.approve", area: "planning", link: "/workforce-planning" },
  BUDGET: { label: "Approve workforce budget", permission: "org.workforce_plan.approve", area: "planning", link: "/workforce-planning/budgets" },
  CAPACITY: { label: "Approve capacity plan", permission: "org.workforce_plan.approve", area: "planning", link: "/workforce-planning/capacity" },
  WORKER_ONBOARD: { label: "Engage contingent worker", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  ASSIGNMENT: { label: "Approve contract assignment", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  CONTRACT_EXTEND: { label: "Extend contract", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  CONTRACT_END: { label: "End contract", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  PAYMENT_PROFILE: { label: "Verify payment profile", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  ACCESS: { label: "Grant contractor access", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
  CONVERSION: { label: "Convert contractor to employee", permission: "org.contingent.approve", area: "contingent", link: "/contingent/workers" },
};

export function kindsOfArea(area: WorkforceArea): string[] {
  return Object.entries(REQUEST_KINDS).filter(([, k]) => k.area === area).map(([key]) => key);
}

type Result = { ok: boolean; message: string; id?: string };

/** Raise a request. One pending request per record and kind. Approvers are notified. */
export async function submitWorkforceRequest(input: {
  tenantId: string; kind: string; entityType: string; entityId: string; label: string;
  payload?: Record<string, unknown> | null; reason?: string | null; by: string;
}, tx: Tx = prisma): Promise<Result> {
  const def = REQUEST_KINDS[input.kind];
  if (!def) return { ok: false, message: "Unknown request." };
  const pending = await tx.workforceRequest.findFirst({ where: { tenantId: input.tenantId, kind: input.kind, entityId: input.entityId, status: "PENDING" } });
  if (pending) return { ok: false, message: "A request for this is already waiting for approval." };
  const r = await tx.workforceRequest.create({
    data: {
      tenantId: input.tenantId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, label: input.label,
      payload: (input.payload ?? undefined) as never, reason: input.reason ?? null, requestedBy: input.by,
    },
  });
  const approvers = (await usersWithPermission(input.tenantId, def.permission)).filter((u) => u !== input.by);
  await notify({ tenantId: input.tenantId, userIds: approvers, kind: "APPROVAL", title: `${def.label}: ${input.label}`, body: input.reason ?? null, link: `${areaHome(def.area)}/approvals` }, tx);
  return { ok: true, message: "Sent for approval.", id: r.id };
}

function areaHome(area: WorkforceArea): string {
  return area === "positions" ? "/positions" : area === "planning" ? "/workforce-planning" : "/contingent";
}

/** Withdraw your own pending request; the record goes back to draft where that applies. */
export async function withdrawWorkforceRequest(tenantId: string, id: string, by: string): Promise<Result> {
  const r = await prisma.workforceRequest.findFirst({ where: { id, tenantId, status: "PENDING" } });
  if (!r) return { ok: false, message: "That request is no longer pending." };
  if (r.requestedBy !== by) return { ok: false, message: "Only the person who raised it can withdraw it." };
  await prisma.$transaction(async (tx) => {
    await tx.workforceRequest.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedBy: by } });
    await revertOnWithdraw(tx, r);
  });
  return { ok: true, message: "Request withdrawn." };
}

async function revertOnWithdraw(tx: Tx, r: { kind: string; entityId: string; tenantId: string; payload: unknown }) {
  const where = { id: r.entityId, tenantId: r.tenantId };
  switch (r.kind) {
    case "JOB_FAMILY": await tx.jobFamily.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } }); break;
    case "JOB_LEVEL": await tx.jobLevel.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } }); break;
    case "JOB_DESCRIPTION": {
      const v = (r.payload as { version?: number } | null)?.version;
      if (v) await tx.jobDescriptionVersion.updateMany({ where: { jobId: r.entityId, version: v, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
      await tx.jobProfile.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
      break;
    }
    case "PLAN": await tx.workforcePlan.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT", submittedAt: null, submittedBy: null } }); break;
    case "BUDGET": await tx.workforceBudget.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } }); break;
    case "CAPACITY": await tx.capacityPlan.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } }); break;
    default: break;
  }
}

/**
 * Approve or reject. The requester can never decide their own request, and
 * the decider must hold the kind's approval permission (checked by the
 * caller, which knows the viewer). Approving applies the change.
 */
export async function decideWorkforceRequest(input: { tenantId: string; id: string; approve: boolean; note?: string | null; by: string }): Promise<Result & { kind?: string; entityId?: string }> {
  const r = await prisma.workforceRequest.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!r) return { ok: false, message: "Request not found." };
  if (r.status !== "PENDING") return { ok: false, message: `This request is already ${r.status.toLowerCase()}.` };
  if (r.requestedBy === input.by) return { ok: false, message: "You cannot decide your own request." };
  if (!input.approve && !input.note?.trim()) return { ok: false, message: "Give a reason for rejecting." };
  const problem = await prisma.$transaction(async (tx) => {
    const p = input.approve ? await applyApproval(tx, r, input.by) : await applyRejection(tx, r);
    if (p) return p;
    await tx.workforceRequest.update({
      where: { id: r.id },
      data: { status: input.approve ? "APPROVED" : "REJECTED", decidedBy: input.by, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
    });
    return null;
  });
  if (problem) return { ok: false, message: problem };
  await notify({
    tenantId: r.tenantId, userIds: [r.requestedBy], kind: "APPROVAL",
    title: `${REQUEST_KINDS[r.kind]?.label ?? r.kind} ${input.approve ? "approved" : "rejected"}: ${r.label}`,
    body: input.note ?? null, link: REQUEST_KINDS[r.kind]?.link ?? null,
  });
  return { ok: true, message: input.approve ? "Approved." : "Rejected.", kind: r.kind, entityId: r.entityId };
}

type Req = { id: string; tenantId: string; kind: string; entityId: string; payload: unknown; reason: string | null };

async function applyApproval(tx: Tx, r: Req, by: string): Promise<string | null> {
  const where = { id: r.entityId, tenantId: r.tenantId };
  const now = new Date();
  const payload = (r.payload ?? {}) as Record<string, unknown>;
  switch (r.kind) {
    case "JOB_FAMILY": await tx.jobFamily.updateMany({ where, data: { status: "ACTIVE" } }); return null;
    case "JOB_LEVEL": await tx.jobLevel.updateMany({ where, data: { status: "ACTIVE" } }); return null;
    case "JOB_DESCRIPTION": {
      const version = Number(payload.version);
      const v = await tx.jobDescriptionVersion.findFirst({ where: { jobId: r.entityId, version, job: { tenantId: r.tenantId } } });
      if (!v) return "That job description version no longer exists.";
      await tx.jobDescriptionVersion.update({ where: { id: v.id }, data: { status: "ACTIVE", approvedBy: by, approvedAt: now } });
      await tx.jobDescriptionVersion.updateMany({ where: { jobId: r.entityId, status: "ACTIVE", NOT: { id: v.id } }, data: { status: "RETIRED" } });
      await tx.jobProfile.updateMany({
        where, data: { status: "ACTIVE", version, summary: v.summary, responsibilities: v.responsibilities, qualifications: v.qualifications, competencies: v.competencies, skills: v.skills },
      });
      return null;
    }
    case "POSITION_CREATE": {
      const p = await tx.position.findFirst({ where });
      if (!p || p.status !== "PROPOSED") return "That position is no longer waiting to open.";
      await tx.position.update({ where: { id: p.id }, data: { status: "VACANT", vacantSince: p.effectiveFrom > now ? p.effectiveFrom : today0(now), vacancyReason: p.vacancyReason ?? "NEW" } });
      return null;
    }
    case "POSITION_FREEZE": {
      const p = await tx.position.findFirst({ where });
      if (!p || p.status !== "VACANT") return "Only a vacant position can be frozen.";
      await tx.position.update({ where: { id: p.id }, data: { status: "FROZEN", frozenAt: now, frozenReason: r.reason } });
      return null;
    }
    case "POSITION_UNFREEZE": {
      const p = await tx.position.findFirst({ where });
      if (!p || p.status !== "FROZEN") return "That position is not frozen.";
      await tx.position.update({ where: { id: p.id }, data: { status: "VACANT", frozenAt: null, frozenReason: null } });
      return null;
    }
    case "POSITION_CLOSE": {
      const p = await tx.position.findFirst({ where });
      if (!p || p.status === "FILLED") return "Move the incumbent out before closing the position.";
      await tx.position.update({ where: { id: p.id }, data: { status: "CLOSED", effectiveTo: today0(now) } });
      return null;
    }
    case "PLAN": await tx.workforcePlan.updateMany({ where, data: { status: "ACTIVE", approvedBy: by, approvedAt: now, rejectReason: null } }); return null;
    case "BUDGET": {
      const b = await tx.workforceBudget.findFirst({ where });
      if (!b) return "Budget not found.";
      await tx.workforceBudget.update({ where: { id: b.id }, data: { status: "ACTIVE", approvedBy: by, approvedAt: now } });
      return null;
    }
    case "CAPACITY": await tx.capacityPlan.updateMany({ where, data: { status: "ACTIVE", approvedBy: by, approvedAt: now } }); return null;
    case "WORKER_ONBOARD": await tx.contingentWorker.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "ACTIVE", startedAt: now } }); return null;
    case "ASSIGNMENT": {
      const a = await tx.contractAssignment.findFirst({ where });
      if (!a || a.status !== "PENDING_APPROVAL") return "That assignment is no longer pending.";
      await tx.contractAssignment.update({ where: { id: a.id }, data: { status: "ACTIVE" } });
      await tx.contingentWorker.updateMany({ where: { id: a.workerId, status: "PENDING_APPROVAL" }, data: { status: "ACTIVE", startedAt: now } });
      return null;
    }
    case "CONTRACT_EXTEND": {
      const a = await tx.contractAssignment.findFirst({ where });
      if (!a || a.status !== "ACTIVE") return "Only an active contract can be extended.";
      const newEnd = new Date(String(payload.newEndDate));
      if (Number.isNaN(newEnd.getTime()) || newEnd <= a.endDate) return "The new end date must be after the current one.";
      const rate = payload.newRate === undefined || payload.newRate === null ? undefined : Number(payload.newRate);
      await tx.contractAssignment.update({ where: { id: a.id }, data: { endDate: newEnd, extensions: { increment: 1 }, alertedAt: null, ...(rate ? { rate } : {}) } });
      return null;
    }
    case "CONTRACT_END": {
      const a = await tx.contractAssignment.findFirst({ where });
      if (!a || a.status !== "ACTIVE") return "Only an active contract can be ended.";
      const end = new Date(String(payload.endDate));
      if (Number.isNaN(end.getTime())) return "End date is invalid.";
      await tx.contractAssignment.update({ where: { id: a.id }, data: { endDate: end, endReason: r.reason } });
      if (end <= today0(now)) await endAssignment(tx, a.id, r.reason ?? "Ended early");
      return null;
    }
    case "PAYMENT_PROFILE": await tx.contractorPaymentProfile.updateMany({ where: { workerId: r.entityId, worker: { tenantId: r.tenantId } }, data: { status: "VERIFIED", verifiedBy: by, verifiedAt: now } }); return null;
    case "ACCESS": await tx.contractorAccess.updateMany({ where: { id: r.entityId, tenantId: r.tenantId, status: "PENDING_APPROVAL" }, data: { status: "GRANTED" } }); return null;
    case "CONVERSION": return null; // HR then creates the employee record from the worker (convertContractor).
    default: return "Unknown request.";
  }
}

async function applyRejection(tx: Tx, r: Req): Promise<string | null> {
  const where = { id: r.entityId, tenantId: r.tenantId };
  switch (r.kind) {
    case "JOB_FAMILY": await tx.jobFamily.updateMany({ where, data: { status: "REJECTED" } }); break;
    case "JOB_LEVEL": await tx.jobLevel.updateMany({ where, data: { status: "REJECTED" } }); break;
    case "JOB_DESCRIPTION": {
      const version = Number((r.payload as { version?: number } | null)?.version);
      await tx.jobDescriptionVersion.updateMany({ where: { jobId: r.entityId, version }, data: { status: "REJECTED" } });
      // A job with an approved earlier version stays active on it.
      const hasActive = await tx.jobDescriptionVersion.count({ where: { jobId: r.entityId, status: "ACTIVE" } });
      await tx.jobProfile.updateMany({ where, data: { status: hasActive ? "ACTIVE" : "REJECTED" } });
      break;
    }
    case "POSITION_CREATE": await tx.position.updateMany({ where: { ...where, status: "PROPOSED" }, data: { status: "REJECTED" } }); break;
    case "PLAN": await tx.workforcePlan.updateMany({ where, data: { status: "REJECTED" } }); break;
    case "BUDGET": await tx.workforceBudget.updateMany({ where, data: { status: "REJECTED" } }); break;
    case "CAPACITY": await tx.capacityPlan.updateMany({ where, data: { status: "REJECTED" } }); break;
    case "WORKER_ONBOARD": await tx.contingentWorker.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "REJECTED" } }); break;
    case "ASSIGNMENT": await tx.contractAssignment.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "REJECTED" } }); break;
    case "PAYMENT_PROFILE": await tx.contractorPaymentProfile.updateMany({ where: { workerId: r.entityId, worker: { tenantId: r.tenantId } }, data: { status: "REJECTED" } }); break;
    case "ACCESS": await tx.contractorAccess.updateMany({ where: { ...where, status: "PENDING_APPROVAL" }, data: { status: "REJECTED" } }); break;
    default: break; // freeze/unfreeze/close/extend/end/conversion: nothing changes.
  }
  return null;
}

/**
 * Contractor offboarding: end the assignment, revoke every access grant
 * once no other contract is running, and end the worker.
 */
export async function endAssignment(tx: Tx, assignmentId: string, reason: string): Promise<void> {
  const a = await tx.contractAssignment.update({ where: { id: assignmentId }, data: { status: "ENDED", endReason: reason } });
  const others = await tx.contractAssignment.count({ where: { workerId: a.workerId, status: "ACTIVE" } });
  if (others === 0) {
    await tx.contractorAccess.updateMany({ where: { workerId: a.workerId, status: { in: ["GRANTED", "PENDING_APPROVAL"] } }, data: { status: "REVOKED", revokedAt: new Date() } });
    await tx.contingentWorker.updateMany({ where: { id: a.workerId, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date() } });
  }
}

// ---------------------------------------------------------------------------
//  Codes
// ---------------------------------------------------------------------------

export async function nextJobCode(tenantId: string): Promise<string> {
  return nextWorkforceCode("JOB", (await prisma.jobProfile.findMany({ where: { tenantId }, select: { code: true } })).map((r) => r.code));
}
export async function nextPositionCode(tenantId: string, tx: Tx = prisma): Promise<string> {
  return nextWorkforceCode("POS", (await tx.position.findMany({ where: { tenantId }, select: { code: true } })).map((r) => r.code));
}
export async function nextWorkerCode(tenantId: string): Promise<string> {
  return nextWorkforceCode("CW", (await prisma.contingentWorker.findMany({ where: { tenantId }, select: { code: true } })).map((r) => r.code));
}

// ---------------------------------------------------------------------------
//  Headcount and payroll actuals
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] as const;

/** Live headcount per department (key "" = no department). */
export async function headcountActuals(tenantId: string): Promise<Map<string, { active: number; preJoining: number; exiting: number; openRequisitions: number }>> {
  const [emps, reqs] = await Promise.all([
    prisma.employee.groupBy({ by: ["departmentId", "status"], where: { tenantId, status: { in: [...ACTIVE_STATUSES, "PREBOARDING"] } }, _count: { _all: true } }),
    prisma.requisition.groupBy({ by: ["departmentId"], where: { tenantId, status: { in: ["APPROVED", "PENDING_APPROVAL"] }, archivedAt: null }, _sum: { positions: true } }),
  ]);
  const out = new Map<string, { active: number; preJoining: number; exiting: number; openRequisitions: number }>();
  const row = (k: string | null) => {
    const key = k ?? "";
    if (!out.has(key)) out.set(key, { active: 0, preJoining: 0, exiting: 0, openRequisitions: 0 });
    return out.get(key)!;
  };
  for (const e of emps) {
    const r = row(e.departmentId);
    if (e.status === "PREBOARDING") r.preJoining += e._count._all;
    else r.active += e._count._all;
    if (e.status === "NOTICE_PERIOD") r.exiting += e._count._all;
  }
  for (const q of reqs) row(q.departmentId).openRequisitions += q._sum.positions ?? 0;
  return out;
}

/** Planned vs live headcount for each line department of a plan. */
export async function planHeadcount(tenantId: string, planId: string) {
  const plan = await prisma.workforcePlan.findFirst({ where: { id: planId, tenantId }, include: { lines: true } });
  if (!plan) return [];
  const live = await headcountActuals(tenantId);
  const byDept = new Map<string, number>();
  for (const l of plan.lines) byDept.set(l.departmentId, (byDept.get(l.departmentId) ?? 0) + l.plannedHeadcount);
  return [...byDept.entries()].map(([departmentId, planned]) => {
    const a = live.get(departmentId) ?? { active: 0, preJoining: 0, exiting: 0, openRequisitions: 0 };
    return { departmentId, ...headcountPosition({ planned, ...a }) };
  });
}

/** Salary (gross) and employer contributions actually paid in locked/finalised runs of a fiscal year. */
export async function payrollActuals(tenantId: string, fiscalYear: number, departmentId?: string | null): Promise<{ salary: number; employer: number; total: number; byMonth: number[] }> {
  const months = fiscalMonths(fiscalYear);
  const rows = await prisma.payrollRunEmployee.findMany({
    where: {
      run: { tenantId, status: { in: ["LOCKED", "FINALIZED"] }, OR: months.map((m) => ({ year: m.year, month: m.month })) },
      ...(departmentId ? { employee: { departmentId } } : {}),
    },
    select: { grossEarnings: true, employerCost: true, run: { select: { year: true, month: true } } },
  });
  const byMonth = Array(12).fill(0) as number[];
  let salary = 0, employer = 0;
  for (const r of rows) {
    const g = Number(r.grossEarnings), e = Number(r.employerCost);
    salary += g; employer += e;
    const i = months.findIndex((m) => m.year === r.run.year && m.month === r.run.month);
    if (i >= 0) byMonth[i] += g + e;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { salary: r2(salary), employer: r2(employer), total: r2(salary + employer), byMonth: byMonth.map(r2) };
}

/**
 * Headroom under the active (approved, activated) plan for a department in
 * the current fiscal year. Null when no plan is in force.
 */
export async function activePlanHeadroom(tenantId: string, departmentId: string | null, extra = 0, on: Date = new Date()): Promise<{ planName: string; planned: number; committed: number; headroom: number } | null> {
  if (!departmentId) return null;
  const fy = fiscalYearOf(on);
  const plan = await prisma.workforcePlan.findFirst({
    where: { tenantId, fiscalYear: fy, isActive: true, isScenario: false, lines: { some: { departmentId } } },
    include: { lines: { where: { departmentId } } },
    orderBy: { approvedAt: "desc" },
  });
  if (!plan) return null;
  const planned = plan.lines.reduce((s, l) => s + l.plannedHeadcount, 0);
  const a = (await headcountActuals(tenantId)).get(departmentId) ?? { active: 0, preJoining: 0, exiting: 0, openRequisitions: 0 };
  const committed = a.active + a.preJoining - a.exiting + a.openRequisitions + extra;
  return { planName: plan.name, planned, committed, headroom: planned - committed };
}

/** A sentence to append to a hiring action's message when it goes beyond plan. */
export async function beyondPlanWarning(tenantId: string, departmentId: string | null, extra = 0): Promise<string> {
  const h = await activePlanHeadroom(tenantId, departmentId, extra);
  if (!h || h.headroom >= 0) return "";
  return ` Note: this takes the department ${-h.headroom} beyond its workforce plan “${h.planName}” (${h.planned} planned, ${h.committed} committed).`;
}

// ---------------------------------------------------------------------------
//  Nightly job
// ---------------------------------------------------------------------------

/**
 * For one tenant: alert managers and contingent admins once when a contract
 * enters its last 30 days, end contracts whose end date has passed
 * (offboarding them), and vacate positions whose incumbent has left.
 */
export async function runWorkforceJob(tenantId: string, now: Date = new Date()): Promise<{ alerted: number; ended: number; vacated: number }> {
  const today = today0(now);
  let alerted = 0, ended = 0, vacated = 0;
  const admins = await usersWithPermission(tenantId, "org.contingent.manage");
  const soon = await prisma.contractAssignment.findMany({
    where: { tenantId, status: "ACTIVE", endDate: { gte: today, lte: new Date(today.getTime() + 30 * DAY) }, alertedAt: null },
    include: { worker: { select: { firstName: true, lastName: true, code: true } } },
  });
  for (const a of soon) {
    const mgr = a.managerEmployeeId ? await prisma.employee.findFirst({ where: { id: a.managerEmployeeId, tenantId }, select: { userId: true } }) : null;
    const { days } = contractExpiry(a.endDate, today);
    await notify({
      tenantId, userIds: [...admins, mgr?.userId ?? null].filter((x): x is string => !!x), kind: "CONTINGENT",
      title: `Contract for ${a.worker.firstName} ${a.worker.lastName} (${a.worker.code}) ends in ${days} day(s)`,
      body: `${a.role} — ends ${a.endDate.toISOString().slice(0, 10)}. Extend or end it.`, link: `/contingent/workers/${a.workerId}`,
    });
    await prisma.contractAssignment.update({ where: { id: a.id }, data: { alertedAt: now } });
    alerted++;
  }
  const expired = await prisma.contractAssignment.findMany({ where: { tenantId, status: "ACTIVE", endDate: { lt: today } }, select: { id: true } });
  for (const a of expired) {
    await prisma.$transaction((tx) => endAssignment(tx, a.id, "Contract end date reached"));
    ended++;
  }
  const filled = await prisma.position.findMany({ where: { tenantId, status: "FILLED", incumbentEmployeeId: { not: null } }, select: { id: true, incumbentEmployeeId: true } });
  if (filled.length) {
    const gone = await prisma.employee.findMany({ where: { tenantId, id: { in: filled.map((p) => p.incumbentEmployeeId!) }, status: "EXITED" }, select: { id: true, lastWorkingDay: true } });
    const goneById = new Map(gone.map((g) => [g.id, g]));
    for (const p of filled) {
      const g = goneById.get(p.incumbentEmployeeId!);
      if (!g) continue;
      await prisma.$transaction(async (tx) => {
        await tx.position.update({ where: { id: p.id }, data: { status: "VACANT", incumbentEmployeeId: null, vacantSince: g.lastWorkingDay ?? today, vacancyReason: "RESIGNATION" } });
        await tx.positionIncumbency.updateMany({ where: { positionId: p.id, employeeId: g.id, endDate: null }, data: { endDate: g.lastWorkingDay ?? today, endReason: "Employee exited" } });
      });
      vacated++;
    }
  }
  return { alerted, ended, vacated };
}

