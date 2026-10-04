"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  checkInGoal, refreshGoal, launchCycle, submitReviewResponse, nominatePeers, decidePeerNomination, REVIEWER_TYPES, calibrateReview, shareCycle, acknowledgeReview, notify,
  parseGoalSuggestions, parseTimeframe, timeframeOfDates, type GoalSuggestionShape,
} from "@keka/services";
import { aiForViewer, aiJson, aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zOptionalId, zId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
/** Every page that shows goals, reviews or plans. */
const PERF = ["/performance", "/performance/goals", "/performance/reviews", "/performance/cycles", "/performance/plans", "/me/performance"];

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
      await notify({ tenantId: viewer.tenantId, userIds: [t?.userId], kind: "PERFORMANCE", title: `New goal: ${d.title}`, body: `Set by ${viewer.employee?.displayName ?? viewer.user.email}`, link: "/me/performance" });
    }
    return done(PERF, id ? "Saved." : "Goal created.");
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
  return r.ok ? done(PERF, r.message) : { ok: false, message: r.message };
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
  return done(PERF, op === "cancel" ? "Cancelled." : "Reopened.");
}

// ---------------------------------------------------------------------------

const cycleSchema = z.object({
  name: zName(80),
  periodStart: zRequiredDate(),
  periodEnd: zRequiredDate(),
  reviewClosesAt: zDate(),
  selfWeight: zRequiredNumber({ min: 0, max: 100 }),
  managerWeight: zRequiredNumber({ min: 0, max: 100 }),
  skipLevelWeight: zNumber({ min: 0, max: 100 }),
  peerWeight: zNumber({ min: 0, max: 100 }),
  subordinateWeight: zNumber({ min: 0, max: 100 }),
  maxPeers: zNumber({ min: 1, max: 10 }),
});

export async function createCycleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const parsed = parseForm(cycleSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.periodEnd <= d.periodStart) return { ok: false, message: "The period must end after it starts.", errors: { periodEnd: "Before start" } };
  const extra = { SKIP_LEVEL: d.skipLevelWeight ?? 0, PEER: d.peerWeight ?? 0, SUBORDINATE: d.subordinateWeight ?? 0 };
  const total = d.selfWeight + d.managerWeight + extra.SKIP_LEVEL + extra.PEER + extra.SUBORDINATE;
  if (total !== 100) return { ok: false, message: `Reviewer weights must add up to 100; they add up to ${total}.`, errors: { managerWeight: "Weights ≠ 100" } };
  // Self and manager always take part; other reviewers only when weighted.
  const reviewerTypes = [{ type: "SELF", weight: d.selfWeight }, { type: "MANAGER", weight: d.managerWeight }, ...Object.entries(extra).filter(([, w]) => w > 0).map(([type, weight]) => ({ type, weight }))];
  try {
    const cycle = await prisma.reviewCycle.create({
      data: {
        tenantId: viewer.tenantId, name: d.name, periodStart: d.periodStart, periodEnd: d.periodEnd, reviewClosesAt: d.reviewClosesAt,
        reviewerTypes, ratingScale: { min: 1, max: 5 }, maxPeers: d.maxPeers ?? 3, anonymousFeedback: formData.get("anonymity") === "named" ? false : true,
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
    return done(PERF, `Created ${d.name}. Launch it when you are ready.`);
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
  return r.ok ? done([...PERF, `/performance/cycles/${cycleId}`], r.message) : { ok: false, message: r.message };
}

const responseSchema = z.object({
  reviewId: zId(),
  reviewerType: z.enum(REVIEWER_TYPES),
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
  return r.ok ? done([...PERF, `/performance/reviews/${parsed.data.reviewId}`, "/inbox"], r.message) : { ok: false, message: r.message };
}

export async function nominatePeersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const reviewId = String(formData.get("reviewId") ?? "");
  const r = await nominatePeers({ reviewId, byEmployeeId: viewer.employee.id, peerIds: formData.getAll("peerIds").map(String) });
  if (r.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeReview", entityId: reviewId, summary: `Peer feedback: ${r.message}` });
  return r.ok ? done([...PERF, `/performance/reviews/${reviewId}`], r.message) : { ok: false, message: r.message };
}

export async function decideNominationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const r = await decidePeerNomination({ responseId: String(formData.get("responseId") ?? ""), byEmployeeId: viewer.employee.id, approve: formData.get("decision") === "approve" });
  if (r.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReviewResponse", entityId: String(formData.get("responseId")), summary: `Peer nomination: ${r.message}` });
  return r.ok ? done([...PERF, `/performance/reviews/${String(formData.get("reviewId") ?? "")}`], r.message) : { ok: false, message: r.message };
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
  return r.ok ? done(PERF, r.message) : { ok: false, message: r.message };
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
  await notify({ tenantId: viewer.tenantId, userIds: [t.userId], kind: "PERFORMANCE", title: "A performance improvement plan has been set up with you", body: `It runs until ${d.endDate.toISOString().slice(0, 10)}.`, link: "/performance/plans" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ImprovementPlan", entityId: d.employeeId, summary: `Started an improvement plan for ${t.displayName}` });
  return done(PERF, "Plan started; the employee has been told.");
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
  if (pip.status !== "ACTIVE") return { ok: false, message: "This plan is already closed." };
  if (outcome === "UNSUCCESSFUL") {
    // An unsuccessful outcome has consequences: a second PIP manager confirms it.
    if (pip.proposedOutcome) return { ok: false, message: "An outcome is already waiting for sign-off." };
    await prisma.improvementPlan.update({ where: { id }, data: { proposedOutcome: outcome, proposedNote: note, proposedBy: viewer.user.id, proposedAt: new Date() } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ImprovementPlan", entityId: id, summary: `Proposed an unsuccessful outcome for ${t.displayName}'s improvement plan` });
    return done(PERF, "Proposed — another PIP manager must confirm an unsuccessful outcome.");
  }
  await prisma.improvementPlan.update({
    where: { id },
    data: outcome === "EXTENDED"
      ? { endDate: new Date(pip.endDate.getTime() + 30 * 86_400_000), outcomeNote: note }
      : { status: "CLOSED", outcome, outcomeNote: note, decidedAt: new Date(), decidedBy: viewer.user.id },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ImprovementPlan", entityId: id, summary: `Improvement plan for ${t.displayName}: ${outcome.toLowerCase()}` });
  return done(PERF, outcome === "EXTENDED" ? "Extended by 30 days." : `Closed as ${outcome.toLowerCase()}.`);
}

// ---------------------------------------------------------------------------
//  The goal wizard: AI suggestions, then publish (or save as draft) in a batch
// ---------------------------------------------------------------------------

const LEVELS = ["INDIVIDUAL", "DEPARTMENT", "COMPANY"] as const;
type WizardLevel = (typeof LEVELS)[number];

/**
 * "Generate goals". Sent: the goal level, the timeframe kind, a job title, a
 * department name and the titles of that department's live company and
 * department goals (so suggestions can align). No names or performance data.
 */
export async function suggestGoalsAction(input: { level: string; timeframe: string; jobTitle: string; departmentId: string }): Promise<{ ok: boolean; message?: string; goals?: Array<GoalSuggestionShape & { parentGoalId: string | null; parentTitle: string | null }> }> {
  const viewer = await requireViewer();
  if (!aiEnabled()) return { ok: false, message: AI_UNAVAILABLE };
  const level = (LEVELS as readonly string[]).includes(String(input.level)) ? input.level as WizardLevel : "INDIVIDUAL";
  const kind = ["QUARTER", "HALF_YEAR", "YEAR"].includes(String(input.timeframe)) ? String(input.timeframe) : "QUARTER";
  const jobTitle = String(input.jobTitle ?? "").trim().slice(0, 80);
  if (!jobTitle && level === "INDIVIDUAL") return { ok: false, message: "Choose the role the goals are for." };
  const dept = input.departmentId ? await prisma.department.findFirst({ where: { id: String(input.departmentId), tenantId: viewer.tenantId }, select: { id: true, name: true } }) : null;
  if (level !== "COMPANY" && !dept) return { ok: false, message: "Choose the department." };
  const parents = await prisma.goal.findMany({
    where: { tenantId: viewer.tenantId, status: { notIn: ["CANCELLED", "COMPLETED", "MISSED", "DRAFT"] }, OR: [{ level: "COMPANY" }, ...(dept ? [{ level: "DEPARTMENT" as const, departmentId: dept.id }] : [])] },
    select: { id: true, title: true }, take: 10, orderBy: [{ level: "asc" }, { createdAt: "asc" }],
  });
  const span = kind === "QUARTER" ? "a quarter" : kind === "HALF_YEAR" ? "half a year" : "a year";
  const prompt = [
    `Goal level: ${level.toLowerCase()}`,
    `Achievable within: ${span}`,
    jobTitle ? `Role: ${jobTitle}` : "",
    dept ? `Department: ${dept.name}` : "",
    parents.length ? `Existing company and department goals (0-based index, for alignment):\n${parents.map((g, i) => `${i}. ${g.title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const r = await aiForViewer(viewer, { feature: "GOAL_SUGGEST", subjectId: dept?.id ?? null, inputChars: prompt.length }, () => aiJson({
    system: "You suggest measurable work goals for an HR performance system. Return a JSON array of exactly 5 objects: {\"title\": string (under 70 characters, starts with a verb), \"description\": string (one sentence), \"metricType\": \"PERCENTAGE\" | \"COMPLETION\" | \"NUMBER_INCREASE\" | \"NUMBER_DECREASE\" | \"CURRENCY\", \"startValue\": number | null, \"targetValue\": number | null, \"metricName\": string | null, \"alignsTo\": number | null}. Use numbers only when a realistic baseline and target exist; currency is Indian rupees. alignsTo is the index of an existing goal it supports, or null.",
    prompt, maxTokens: 1200, validate: (v) => parseGoalSuggestions(v, parents.length),
  }));
  if (!r.ok) return { ok: false, message: r.reason };
  return { ok: true, goals: r.value.map((g) => ({ ...g, parentGoalId: g.alignsTo !== null ? parents[g.alignsTo].id : null, parentTitle: g.alignsTo !== null ? parents[g.alignsTo].title : null })) };
}

export interface GoalDraftInput {
  title: string; description?: string | null; level: string; employeeId?: string | null; departmentId?: string | null;
  metricType: string; metricName?: string | null; startValue?: number | string | null; targetValue?: number | string | null;
  timeframe?: string | null; startDate: string; dueDate: string; tags?: string[]; visibility?: string;
  countsInReview?: boolean; parentGoalId?: string | null; source?: string;
}

/**
 * Publish (or save as drafts) the goals built in the wizard. Every goal is
 * checked first and nothing is written unless all of them pass, so a batch
 * never half-lands.
 */
export async function publishGoalsAction(input: { goals: GoalDraftInput[]; draft: boolean }): Promise<{ ok: boolean; message: string; errors?: Record<number, string>; count?: number }> {
  const viewer = await requireViewer();
  const list = Array.isArray(input.goals) ? input.goals.slice(0, 20) : [];
  if (list.length === 0) return { ok: false, message: "Add at least one goal." };
  const errors: Record<number, string> = {};
  const rows: Array<Record<string, unknown>> = [];
  for (const [i, g] of list.entries()) {
    const title = String(g.title ?? "").trim();
    const level = (LEVELS as readonly string[]).includes(String(g.level)) ? g.level as WizardLevel : null;
    const metric = ["PERCENTAGE", "COMPLETION", "NUMBER_INCREASE", "NUMBER_DECREASE", "CURRENCY"].includes(String(g.metricType)) ? String(g.metricType) : null;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(g.startDate)) ? new Date(`${g.startDate}T00:00:00Z`) : null;
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(g.dueDate)) ? new Date(`${g.dueDate}T00:00:00Z`) : null;
    if (!title || title.length > 200) { errors[i] = "Give the goal a title (under 200 characters)."; continue; }
    if (!level) { errors[i] = "Choose the goal type."; continue; }
    if (!metric) { errors[i] = "Choose a metric type."; continue; }
    if (!startDate || !dueDate || !(dueDate > startDate)) { errors[i] = "The end date must be after the start date."; continue; }
    let employeeId: string | null = null, departmentId: string | null = null;
    if (level === "INDIVIDUAL") {
      employeeId = g.employeeId ? String(g.employeeId) : viewer.employee?.id ?? null;
      if (!employeeId) { errors[i] = "Choose the goal owner."; continue; }
      if (!(await mayEditGoalsOf(viewer, employeeId))) { errors[i] = "You can set goals for yourself and your team only."; continue; }
    } else {
      if (!can(viewer, P.GOALS_MANAGE)) { errors[i] = "Company and department goals are set by HR."; continue; }
      if (level === "DEPARTMENT") {
        departmentId = g.departmentId ? String(g.departmentId) : null;
        if (!departmentId || !(await prisma.department.findFirst({ where: { id: departmentId, tenantId: viewer.tenantId } }))) { errors[i] = "Choose the department."; continue; }
      }
    }
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    let start = metric === "PERCENTAGE" || metric === "COMPLETION" ? 0 : n(g.startValue) ?? 0;
    const target = metric === "PERCENTAGE" ? 100 : metric === "COMPLETION" ? 1 : n(g.targetValue);
    if (target === null || !Number.isFinite(target) || !Number.isFinite(start)) { errors[i] = "Enter the target."; continue; }
    if ((metric === "NUMBER_INCREASE" || metric === "CURRENCY") && !(target > start)) { errors[i] = "For an increase, the target must be above the starting value."; continue; }
    if (metric === "NUMBER_DECREASE" && !(target < start)) { errors[i] = "For a decrease, the target must be below the starting value."; continue; }
    if (Math.abs(start) > 1e15 || Math.abs(target) > 1e15) { errors[i] = "That number is too large."; continue; }
    let parentGoalId: string | null = g.parentGoalId ? String(g.parentGoalId) : null;
    if (parentGoalId && !(await prisma.goal.findFirst({ where: { id: parentGoalId, tenantId: viewer.tenantId } }))) parentGoalId = null;
    const tags = [...new Set((Array.isArray(g.tags) ? g.tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 8);
    const tf = g.timeframe && parseTimeframe(String(g.timeframe), viewer.tenant.fyStartMonth) ? String(g.timeframe) : timeframeOfDates(startDate, dueDate, viewer.tenant.fyStartMonth);
    start = Number(start);
    rows.push({
      tenantId: viewer.tenantId, title, description: String(g.description ?? "").trim().slice(0, 2000) || null, level, employeeId, departmentId,
      metricType: metric, metricName: metric.startsWith("NUMBER") ? String(g.metricName ?? "").trim().slice(0, 60) || null : null,
      startValue: start, targetValue: target, currentValue: start, startDate, dueDate, parentGoalId,
      timeframe: tf, tags, visibility: g.visibility === "MANAGER_CHAIN" ? "MANAGER_CHAIN" : "EVERYONE",
      countsInReview: g.countsInReview !== false, source: g.source === "AI" ? "AI" : "MANUAL",
      status: input.draft ? "DRAFT" : "ON_TRACK", createdBy: viewer.user.id,
    });
  }
  if (Object.keys(errors).length) return { ok: false, message: "Some goals need attention before they can be saved.", errors };
  const ids: string[] = [];
  for (const data of rows) ids.push((await prisma.goal.create({ data: data as never })).id);
  for (const id of ids) await refreshGoal(id);
  for (const [k, data] of rows.entries()) {
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Goal", entityId: ids[k], summary: `${input.draft ? "Saved a draft goal" : "Published a goal"}: ${String(data.title).slice(0, 80)}${data.source === "AI" ? " (AI suggested)" : ""}` });
    if (!input.draft && data.employeeId && data.employeeId !== viewer.employee?.id) {
      const t = await targetOf(viewer, String(data.employeeId));
      await notify({ tenantId: viewer.tenantId, userIds: [t?.userId], kind: "PERFORMANCE", title: `New goal: ${data.title}`, body: `Set by ${viewer.employee?.displayName ?? viewer.user.email}`, link: "/me/performance" });
    }
  }
  done(PERF, "");
  return { ok: true, count: ids.length, message: input.draft ? (ids.length > 1 ? `${ids.length} goals saved as drafts.` : "Goal saved as draft.") : (ids.length > 1 ? `${ids.length} goals published successfully.` : "Goal published successfully.") };
}

/** Publish a draft: it starts being measured against time from now on. */
export async function publishDraftGoalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const goal = await prisma.goal.findFirst({ where: { id: String(formData.get("goalId")), tenantId: viewer.tenantId } });
  if (!goal) return { ok: false, message: "Goal not found." };
  if (goal.status !== "DRAFT") return { ok: false, message: "Only a draft can be published." };
  const allowed = goal.employeeId ? await mayEditGoalsOf(viewer, goal.employeeId) : can(viewer, P.GOALS_MANAGE);
  if (!allowed) return { ok: false, message: "You cannot publish this goal." };
  await prisma.goal.update({ where: { id: goal.id }, data: { status: "ON_TRACK" } });
  await refreshGoal(goal.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Goal", entityId: goal.id, summary: `Published draft goal ${goal.title.slice(0, 80)}` });
  return done(PERF, "Goal published successfully.");
}
