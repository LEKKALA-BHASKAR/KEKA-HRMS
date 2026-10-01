"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  checkInGoal, refreshGoal, launchCycle, submitReviewResponse, calibrateReview, shareCycle, acknowledgeReview, notify,
} from "@keka/services";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zOptionalId, zId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

async function targetOf(viewer: Viewer, employeeId: string) {
  return prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, userId: true, displayName: true },
  });
}

/** Own goals, your reports' goals, or anyone's in scope with goal management. */
async function mayEditGoalsOf(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return true;
  if (viewer.allReportIds.has(employeeId)) return true;
  const t = await targetOf(viewer, employeeId);
  return !!t && can(viewer, P.GOALS_MANAGE) && canAccessEmployee(viewer, t, P.GOALS_MANAGE);
}

const goalSchema = z.object({
  id: zOptionalId(),
  title: zName(200),
  description: zOptional(2000),
  level: z.enum(["COMPANY", "DEPARTMENT", "TEAM", "INDIVIDUAL"]),
  employeeId: zOptionalId(),
  departmentId: zOptionalId(),
  metricType: z.enum(["PERCENTAGE", "COMPLETION", "NUMBER_INCREASE", "NUMBER_DECREASE", "CURRENCY"]),
  metricName: zOptional(60),
  startValue: zNumber(),
  targetValue: zNumber(),
  startDate: zRequiredDate(),
  dueDate: zRequiredDate(),
  parentGoalId: zOptionalId(),
  weight: zNumber({ min: 0, max: 100 }),
  rollupMethod: z.enum(["AVERAGE", "WEIGHTED", "MANUAL"]).default("AVERAGE"),
});

export async function saveGoalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(goalSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  if (d.level === "INDIVIDUAL") {
    d.employeeId = d.employeeId ?? viewer.employee?.id ?? null;
    if (!d.employeeId) return { ok: false, message: "Choose whose goal this is.", values };
    if (!(await mayEditGoalsOf(viewer, d.employeeId))) return { ok: false, message: "You can set goals for yourself and your team only.", values };
  } else {
    if (!can(viewer, P.GOALS_MANAGE)) return { ok: false, message: "Company and department goals are set by HR.", errors: { level: "Needs goal management" }, values };
    d.employeeId = null;
    if (d.level === "DEPARTMENT" && !d.departmentId) return { ok: false, message: "Choose the department.", errors: { departmentId: "Required" }, values };
  }
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, employee: d.employeeId });
  if (foreign) return { ok: false, message: foreign, values };
  if (d.dueDate <= d.startDate) return { ok: false, message: "The due date must be after the start.", errors: { dueDate: "Before start" }, values };
  const start = d.metricType === "PERCENTAGE" || d.metricType === "COMPLETION" ? 0 : d.startValue ?? 0;
  const target = d.metricType === "PERCENTAGE" ? 100 : d.metricType === "COMPLETION" ? 1 : d.targetValue ?? 0;
  if (d.metricType === "NUMBER_INCREASE" || d.metricType === "CURRENCY") {
    if (!(target > start)) return { ok: false, message: "For an increase, the target must be above the starting value.", errors: { targetValue: "Must exceed start" }, values };
  }
  if (d.metricType === "NUMBER_DECREASE" && !(target < start)) {
    return { ok: false, message: "For a decrease, the target must be below the starting value.", errors: { targetValue: "Must be below start" }, values };
  }
  if (d.parentGoalId) {
    const parent = await prisma.goal.findFirst({ where: { id: d.parentGoalId, tenantId: viewer.tenantId } });
    if (!parent) return { ok: false, message: "The goal it aligns to was not found.", values };
    if (id && (parent.id === id)) return { ok: false, message: "A goal cannot align to itself.", values };
  }
  try {
    const data = { ...d, startValue: start, targetValue: target, weight: d.weight ?? 0 };
    let goalId = id;
    if (id) {
      const existing = await prisma.goal.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!existing) return { ok: false, message: "Goal not found." };
      if (existing.employeeId && !(await mayEditGoalsOf(viewer, existing.employeeId))) return { ok: false, message: "You cannot edit this goal." };
      await prisma.goal.update({ where: { id }, data });
    } else {
      goalId = (await prisma.goal.create({ data: { ...data, tenantId: viewer.tenantId, status: "ON_TRACK", createdBy: viewer.user.id, currentValue: start } })).id;
    }
    await refreshGoal(goalId!);
    if (d.employeeId && d.employeeId !== viewer.employee?.id) {
      const t = await targetOf(viewer, d.employeeId);
      await notify({ tenantId: viewer.tenantId, userIds: [t?.userId], kind: "PERFORMANCE", title: `New goal: ${d.title}`, body: `Set by ${viewer.employee?.displayName ?? viewer.user.email}`, link: "/performance" });
    }
    return done(["/performance"], id ? "Saved." : "Goal created.");
  } catch (err) {
    return toErrorState(err, values);
  }
}

export async function checkInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const goalId = String(formData.get("goalId"));
  const value = Number(formData.get("value"));
  if (!Number.isFinite(value)) return { ok: false, message: "Enter the current value.", errors: { value: "Required" } };
  const goal = await prisma.goal.findFirst({ where: { id: goalId, tenantId: viewer.tenantId } });
  if (!goal) return { ok: false, message: "Goal not found." };
  const allowed = goal.employeeId ? await mayEditGoalsOf(viewer, goal.employeeId) : can(viewer, P.GOALS_MANAGE);
  if (!allowed) return { ok: false, message: "You cannot update this goal." };
  const r = await checkInGoal({ goalId, value, note: String(formData.get("note") ?? "") || null, byEmployeeId: viewer.employee?.id });
  return r.ok ? done(["/performance"], r.message) : { ok: false, message: r.message };
}

export async function setGoalStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const goalId = String(formData.get("goalId"));
  const op = String(formData.get("op"));
  const goal = await prisma.goal.findFirst({ where: { id: goalId, tenantId: viewer.tenantId } });
  if (!goal) return { ok: false, message: "Goal not found." };
  const allowed = goal.employeeId ? await mayEditGoalsOf(viewer, goal.employeeId) : can(viewer, P.GOALS_MANAGE);
  if (!allowed) return { ok: false, message: "You cannot change this goal." };
  if (op === "cancel") await prisma.goal.update({ where: { id: goalId }, data: { status: "CANCELLED" } });
  else if (op === "reopen") { await prisma.goal.update({ where: { id: goalId }, data: { status: "ON_TRACK", statusOverride: null } }); await refreshGoal(goalId); }
  else return { ok: false, message: "Unknown action." };
  if (goal.parentGoalId) await refreshGoal(goal.parentGoalId);
  return done(["/performance"], op === "cancel" ? "Cancelled." : "Reopened.");
}

// ---------------------------------------------------------------------------

const cycleSchema = z.object({
  name: zName(80),
  periodStart: zRequiredDate(),
  periodEnd: zRequiredDate(),
  reviewClosesAt: zDate(),
  selfWeight: zRequiredNumber({ min: 0, max: 100 }),
  managerWeight: zRequiredNumber({ min: 0, max: 100 }),
});

export async function createCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const parsed = parseForm(cycleSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.periodEnd <= d.periodStart) return { ok: false, message: "The period must end after it starts.", errors: { periodEnd: "Before start" } };
  if (d.selfWeight + d.managerWeight !== 100) return { ok: false, message: "Self and manager weights must add up to 100.", errors: { managerWeight: "Weights ≠ 100" } };
  try {
    const cycle = await prisma.reviewCycle.create({
      data: {
        tenantId: viewer.tenantId, name: d.name, periodStart: d.periodStart, periodEnd: d.periodEnd, reviewClosesAt: d.reviewClosesAt,
        reviewerTypes: [{ type: "SELF", weight: d.selfWeight }, { type: "MANAGER", weight: d.managerWeight }], ratingScale: { min: 1, max: 5 },
        bands: {
          create: [
            { name: "Outstanding", minRating: 4.5, maxRating: 5, targetPercent: 10, color: "#0f8a55", displayOrder: 0 },
            { name: "Exceeds expectations", minRating: 3.5, maxRating: 4.5, targetPercent: 25, color: "#1266a8", displayOrder: 1 },
            { name: "Meets expectations", minRating: 2.5, maxRating: 3.5, targetPercent: 50, color: "#8891a3", displayOrder: 2 },
            { name: "Below expectations", minRating: 1, maxRating: 2.5, targetPercent: 15, color: "#c92a2a", displayOrder: 3 },
          ],
        },
      },
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ReviewCycle", entityId: cycle.id, summary: `Created review cycle ${d.name}` });
    return done(["/performance"], `Created ${d.name}. Launch it when you are ready.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function cycleOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const cycleId = String(formData.get("cycleId"));
  const op = String(formData.get("op"));
  const c = await prisma.reviewCycle.findFirst({ where: { id: cycleId, tenantId: viewer.tenantId } });
  if (!c) return { ok: false, message: "Cycle not found." };
  const r = op === "launch" ? await launchCycle(cycleId) : op === "share" ? await shareCycle(cycleId) : { ok: false, message: "Unknown action." };
  if (r.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReviewCycle", entityId: cycleId, summary: `${op} ${c.name}: ${r.message}` });
  return r.ok ? done(["/performance", `/performance/cycles/${cycleId}`], r.message) : { ok: false, message: r.message };
}

const responseSchema = z.object({
  reviewId: zId(),
  reviewerType: z.enum(["SELF", "MANAGER"]),
  overallRating: zRequiredNumber({ min: 1, max: 5 }),
  strengths: zOptional(4000),
  improvements: zOptional(4000),
});

export async function submitReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(responseSchema, formData);
  if (parsed.state) return parsed.state;
  const indicatorRatings = [...formData.entries()]
    .filter(([k, v]) => k.startsWith("indicator:") && String(v))
    .map(([k, v]) => ({ indicatorId: k.slice("indicator:".length), rating: Number(v) }))
    .filter((r) => r.rating >= 1 && r.rating <= 5);
  const r = await submitReviewResponse({ ...parsed.data, reviewerEmployeeId: viewer.employee.id, indicatorRatings });
  return r.ok ? done(["/performance", `/performance/reviews/${parsed.data.reviewId}`, "/inbox"], r.message) : { ok: false, message: r.message };
}

export async function calibrateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_CALIBRATE);
  const reviewId = String(formData.get("reviewId"));
  const review = await prisma.employeeReview.findFirst({ where: { id: reviewId, cycle: { tenantId: viewer.tenantId } } });
  if (!review) return { ok: false, message: "Review not found." };
  if (review.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot calibrate your own rating." };
  const t = await targetOf(viewer, review.employeeId);
  if (!t || !canAccessEmployee(viewer, t, P.PERFORMANCE_CALIBRATE)) return { ok: false, message: "This review is outside your scope." };
  const finalRating = Number(formData.get("finalRating"));
  const r = await calibrateReview({ reviewId, finalRating, reason: String(formData.get("reason") ?? "") || null, byUserId: viewer.user.id });
  if (r.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeReview", entityId: reviewId, summary: `Calibrated ${t.displayName}: ${r.message}` });
  return r.ok ? done([`/performance/cycles/${review.cycleId}`, `/performance/reviews/${reviewId}`], r.message) : { ok: false, message: r.message };
}

export async function acknowledgeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await acknowledgeReview(String(formData.get("reviewId")), viewer.employee?.id ?? "", String(formData.get("comments") ?? "") || null);
  return r.ok ? done(["/performance"], r.message) : { ok: false, message: r.message };
}

// ---------------------------------------------------------------------------

const pipSchema = z.object({
  employeeId: zId(), reason: zName(2000), objectives: zName(4000),
  startDate: zRequiredDate(), endDate: zRequiredDate(),
});

export async function createPipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PIP_MANAGE);
  const parsed = parseForm(pipSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const t = await targetOf(viewer, d.employeeId);
  if (!t || !canAccessEmployee(viewer, t, P.PIP_MANAGE)) return { ok: false, message: "This employee is outside your scope." };
  if (d.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot place yourself on a plan." };
  const days = (d.endDate.getTime() - d.startDate.getTime()) / 86_400_000;
  if (days < 30 || days > 180) return { ok: false, message: "A plan runs between 30 and 180 days — long enough to improve, short enough to decide.", errors: { endDate: "30–180 days" } };
  const open = await prisma.improvementPlan.count({ where: { employeeId: d.employeeId, status: "ACTIVE" } });
  if (open) return { ok: false, message: "There is already an active plan for this employee." };
  await prisma.improvementPlan.create({ data: { ...d, tenantId: viewer.tenantId, managerId: t.reportingManagerId, createdBy: viewer.user.id } });
  await notify({ tenantId: viewer.tenantId, userIds: [t.userId], kind: "PERFORMANCE", title: "A performance improvement plan has been set up with you", body: `It runs until ${d.endDate.toISOString().slice(0, 10)}.`, link: "/performance?tab=plans" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ImprovementPlan", entityId: d.employeeId, summary: `Started an improvement plan for ${t.displayName}` });
  return done(["/performance"], "Plan started; the employee has been told.");
}

export async function closePipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PIP_MANAGE);
  const id = String(formData.get("id"));
  const outcome = String(formData.get("outcome"));
  const note = String(formData.get("note") ?? "").trim();
  if (!["SUCCESSFUL", "EXTENDED", "UNSUCCESSFUL"].includes(outcome)) return { ok: false, message: "Choose an outcome." };
  if (!note) return { ok: false, message: "Record what the outcome is based on.", errors: { note: "Required" } };
  const pip = await prisma.improvementPlan.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!pip) return { ok: false, message: "Plan not found." };
  const t = await targetOf(viewer, pip.employeeId);
  if (!t || !canAccessEmployee(viewer, t, P.PIP_MANAGE)) return { ok: false, message: "This plan is outside your scope." };
  await prisma.improvementPlan.update({
    where: { id },
    data: outcome === "EXTENDED"
      ? { endDate: new Date(pip.endDate.getTime() + 30 * 86_400_000), outcomeNote: note }
      : { status: "CLOSED", outcome, outcomeNote: note, decidedAt: new Date(), decidedBy: viewer.user.id },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ImprovementPlan", entityId: id, summary: `Improvement plan for ${t.displayName}: ${outcome.toLowerCase()}` });
  return done(["/performance"], outcome === "EXTENDED" ? "Extended by 30 days." : `Closed as ${outcome.toLowerCase()}.`);
}
