"use server";

import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  processFeedback,
  refreshGoal, notify, usersWithPermission, timeframeFor, bandFor, bandProblems, stageOrderProblem,
  parseGrowthItems, growthItemsOf, updateProposal, type BandRow,
} from "@keka/services";
import { requireAuth, requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { feedbackRules, feedbackBlocker, promotionPolicyOf, eligibilityFor } from "@/lib/talent";
import { writeAudit, actionDone as done, formValues, type ActionState } from "@/lib/forms";

/**
 * Performance parity: the goal library and timeframes, team goals, the
 * review form builder, stage dates and participant mapping, editable
 * calibration bands, feedback requests and settings, manager salary and
 * promotion recommendations, the promotion policy, and growth plans.
 */

const P = PERMISSIONS;
const PERF = ["/performance", "/performance/goals", "/performance/reviews", "/performance/cycles", "/me/performance"];
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max);
const dateOf = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const METRICS = ["PERCENTAGE", "COMPLETION", "NUMBER_INCREASE", "NUMBER_DECREASE", "CURRENCY"] as const;
const fail = (message: string, f?: FormData, errors?: Record<string, string>): ActionState => ({ ok: false, message, errors, values: f ? formValues(f) : undefined });

async function target(viewer: Viewer, employeeId: string) {
  return prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, userId: true, displayName: true, dateOfJoining: true, status: true },
  });
}

/** Own goals, the viewer's reports' goals, or anyone's in scope with goal management. */
async function mayEditGoalsOf(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return true;
  if (viewer.allReportIds.has(employeeId)) return true;
  const t = await target(viewer, employeeId);
  return !!t && can(viewer, P.GOALS_MANAGE) && canAccessEmployee(viewer, t, P.GOALS_MANAGE);
}

function goalNumbers(metric: string, startRaw: string, targetRaw: string): { start: number; target: number } | string {
  const start = metric === "PERCENTAGE" || metric === "COMPLETION" ? 0 : Number(startRaw || 0);
  const target = metric === "PERCENTAGE" ? 100 : metric === "COMPLETION" ? 1 : Number(targetRaw);
  if (!Number.isFinite(start) || !Number.isFinite(target)) return "Enter the starting value and target.";
  if ((metric === "NUMBER_INCREASE" || metric === "CURRENCY") && !(target > start)) return "For an increase, the target must be above the starting value.";
  if (metric === "NUMBER_DECREASE" && !(target < start)) return "For a decrease, the target must be below the starting value.";
  if (Math.abs(start) > 1e15 || Math.abs(target) > 1e15) return "That number is too large.";
  return { start, target };
}

// ---------------------------------------------------------------------------
//  Goal timeframes
// ---------------------------------------------------------------------------

export async function saveTimeframeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.GOALS_MANAGE);
  const name = str(f, "name", 60);
  const kind = ["QUARTER", "HALF_YEAR", "YEAR", "CUSTOM"].includes(str(f, "kind")) ? str(f, "kind") : "CUSTOM";
  const start = dateOf(str(f, "startDate")), end = dateOf(str(f, "endDate"));
  if (!name) return fail("Name the timeframe.", f, { name: "Required" });
  if (!start || !end || !(end > start)) return fail("The timeframe must end after it starts.", f, { endDate: "Before start" });
  if (await prisma.goalTimeframe.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A timeframe with that name exists.", f, { name: "Taken" });
  const row = await prisma.goalTimeframe.create({ data: { tenantId: viewer.tenantId, name, kind, startDate: start, endDate: end } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "GoalTimeframe", entityId: row.id, summary: `Added goal timeframe ${name}` });
  return done(["/performance/goals/library"], `Added ${name}.`);
}

/** Generate the quarters, halves or year of a financial year (e.g. FY starting 2026). */
export async function generateTimeframesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.GOALS_MANAGE);
  const kind = str(f, "kind") as "QUARTER" | "HALF_YEAR" | "YEAR";
  if (!["QUARTER", "HALF_YEAR", "YEAR"].includes(kind)) return fail("Choose quarters, half-years or the year.");
  const fyStart = Number(str(f, "fy"));
  if (!Number.isInteger(fyStart) || fyStart < 2000 || fyStart > 2100) return fail("Enter the year the financial year starts in.", f, { fy: "e.g. 2026" });
  const fm = viewer.tenant.fyStartMonth;
  const span = kind === "QUARTER" ? 3 : kind === "HALF_YEAR" ? 6 : 12;
  let made = 0;
  for (let i = 0; i < 12 / span; i++) {
    const t = timeframeFor(kind, new Date(Date.UTC(fyStart, fm - 1 + i * span, 1)), fm);
    const exists = await prisma.goalTimeframe.count({ where: { tenantId: viewer.tenantId, name: t.label } });
    if (exists) continue;
    await prisma.goalTimeframe.create({ data: { tenantId: viewer.tenantId, name: t.label, kind, startDate: t.start, endDate: t.end } });
    made++;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "GoalTimeframe", summary: `Generated ${made} ${kind.toLowerCase().replace("_", "-")} timeframe(s) for FY ${fyStart}` });
  return done(["/performance/goals/library"], made ? `Added ${made} timeframe(s).` : "Those timeframes already exist.");
}

export async function toggleTimeframeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.GOALS_MANAGE);
  const row = await prisma.goalTimeframe.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!row) return fail("Timeframe not found.");
  await prisma.goalTimeframe.update({ where: { id: row.id }, data: { isActive: !row.isActive } });
  return done(["/performance/goals/library"], row.isActive ? `${row.name} hidden from new goals.` : `${row.name} is available again.`);
}

// ---------------------------------------------------------------------------
//  Goal templates (the library) and goals from them
// ---------------------------------------------------------------------------

export async function saveGoalTemplateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.GOALS_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title", 200);
  const metric = (METRICS as readonly string[]).includes(str(f, "metricType")) ? str(f, "metricType") : null;
  if (!title) return fail("Give the template a title.", f, { title: "Required" });
  if (!metric) return fail("Choose how it is measured.", f, { metricType: "Required" });
  const nums = goalNumbers(metric, str(f, "startValue"), str(f, "targetValue"));
  if (typeof nums === "string") return fail(nums, f, { targetValue: nums });
  const tags = [...new Set(str(f, "tags").split(",").map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 8);
  const data = { title, description: str(f, "description", 2000) || null, category: str(f, "category", 60) || null, metricType: metric, metricName: str(f, "metricName", 60) || null, startValue: nums.start, targetValue: nums.target, tags };
  const clash = await prisma.goalTemplate.findFirst({ where: { tenantId: viewer.tenantId, title, NOT: id ? { id } : undefined } });
  if (clash) return fail("A template with that title exists.", f, { title: "Taken" });
  if (id) {
    const u = await prisma.goalTemplate.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
    if (!u.count) return fail("Template not found.");
  } else await prisma.goalTemplate.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "GoalTemplate", entityId: id || null, summary: `${id ? "Updated" : "Added"} goal template ${title}` });
  return done(["/performance/goals/library"], id ? "Template saved." : `Added “${title}” to the library.`);
}

export async function archiveGoalTemplateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.GOALS_MANAGE);
  const row = await prisma.goalTemplate.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!row) return fail("Template not found.");
  await prisma.goalTemplate.update({ where: { id: row.id }, data: { isActive: !row.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "GoalTemplate", entityId: row.id, summary: `${row.isActive ? "Archived" : "Restored"} goal template ${row.title}` });
  return done(["/performance/goals/library"], row.isActive ? "Archived." : "Restored.");
}

/**
 * Create goals from a library template: for one person (yourself, a report,
 * or anyone in goal-management scope) or, as a team goal, the same goal for
 * several people at once. Every owner is checked before anything is written.
 */
export async function assignGoalAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const templateId = str(f, "templateId");
  const tpl = templateId ? await prisma.goalTemplate.findFirst({ where: { id: templateId, tenantId: viewer.tenantId, isActive: true } }) : null;
  if (templateId && !tpl) return fail("Template not found.", f);
  const title = str(f, "title", 200) || tpl?.title || "";
  const metric = (METRICS as readonly string[]).includes(str(f, "metricType")) ? str(f, "metricType") : tpl?.metricType ?? "PERCENTAGE";
  if (!title) return fail("Give the goal a title.", f, { title: "Required" });
  const nums = goalNumbers(metric, str(f, "startValue") || String(tpl ? Number(tpl.startValue) : 0), str(f, "targetValue") || String(tpl ? Number(tpl.targetValue) : ""));
  if (typeof nums === "string") return fail(nums, f, { targetValue: nums });
  // Dates come from a timeframe HR maintains, or are typed.
  const tfId = str(f, "timeframeId");
  const tf = tfId ? await prisma.goalTimeframe.findFirst({ where: { id: tfId, tenantId: viewer.tenantId, isActive: true } }) : null;
  if (tfId && !tf) return fail("Timeframe not found.", f);
  const start = tf?.startDate ?? dateOf(str(f, "startDate")), due = tf?.endDate ?? dateOf(str(f, "dueDate"));
  if (!start || !due || !(due > start)) return fail("Pick a timeframe, or dates that end after they start.", f, { dueDate: "Required" });
  const owners = [...new Set(f.getAll("employeeIds").map(String).filter(Boolean))];
  if (owners.length === 0 && viewer.employee) owners.push(viewer.employee.id);
  if (owners.length === 0) return fail("Choose who the goal is for.", f, { employeeIds: "Required" });
  if (owners.length > 200) return fail("Assign to at most 200 people at once.", f);
  for (const id of owners) if (!(await mayEditGoalsOf(viewer, id))) return fail("You can set goals for yourself, your team, and people in your goal-management scope only.", f, { employeeIds: "Out of scope" });
  const teamGoalId = owners.length > 1 ? randomUUID() : null;
  const ids: string[] = [];
  for (const employeeId of owners) {
    const g = await prisma.goal.create({
      data: {
        tenantId: viewer.tenantId, title, description: str(f, "description", 2000) || tpl?.description || null, level: owners.length > 1 ? "TEAM" : "INDIVIDUAL",
        employeeId, metricType: metric as never, metricName: str(f, "metricName", 60) || tpl?.metricName || null,
        startValue: nums.start, targetValue: nums.target, currentValue: nums.start, startDate: start, dueDate: due, status: "ON_TRACK",
        timeframe: tf?.name ?? null, tags: (tpl?.tags as Prisma.InputJsonValue) ?? undefined, templateId: tpl?.id ?? null, teamGoalId, createdBy: viewer.user.id,
      },
    });
    ids.push(g.id);
    await refreshGoal(g.id);
  }
  const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: owners.filter((o) => o !== viewer.employee?.id) } }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: people.map((p) => p.userId), kind: "PERFORMANCE", title: `New goal: ${title}`, body: `Set by ${viewer.employee?.displayName ?? viewer.user.email}${teamGoalId ? " for your team" : ""}`, link: "/me/performance?view=goals" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Goal", entityId: teamGoalId ?? ids[0], summary: `${teamGoalId ? `Team goal for ${owners.length} people` : "Goal"}: ${title.slice(0, 80)}${tpl ? " (from the library)" : ""}` });
  return done([...PERF, "/performance/goals/library"], teamGoalId ? `Team goal assigned to ${owners.length} people.` : "Goal created.");
}

// ---------------------------------------------------------------------------
//  Review form builder, stage dates and participants
// ---------------------------------------------------------------------------

async function draftCycle(viewer: Viewer, id: string, allowLaunched = false) {
  const c = await prisma.reviewCycle.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!c) return { error: "Cycle not found." } as const;
  if (!allowLaunched && c.status !== "DRAFT") return { error: "The form and participants are fixed once a cycle is launched." } as const;
  if (c.status === "COMPLETED" || c.status === "CANCELLED") return { error: "This cycle is closed." } as const;
  return { cycle: c } as const;
}
const cyclePaths = (id: string) => [`/performance/cycles/${id}/setup`, `/performance/cycles/${id}`, "/performance/cycles"];

export async function saveFormSectionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const title = str(f, "title", 120);
  if (!title) return fail("Name the section.", f, { title: "Required" });
  const order = await prisma.reviewFormSection.count({ where: { cycleId: c.cycle.id } });
  await prisma.reviewFormSection.create({ data: { cycleId: c.cycle.id, title, description: str(f, "description", 500) || null, displayOrder: order } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReviewCycle", entityId: c.cycle.id, summary: `Review form: added section ${title}` });
  return done(cyclePaths(c.cycle.id), `Added section “${title}”.`);
}

export async function saveFormQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const section = await prisma.reviewFormSection.findFirst({ where: { id: str(f, "sectionId"), cycleId: c.cycle.id } });
  if (!section) return fail("Section not found.");
  const kind = ["RATING", "TEXT", "COMPETENCY"].includes(str(f, "kind")) ? str(f, "kind") : null;
  const prompt = str(f, "prompt", 300);
  if (!kind) return fail("Choose the question type.", f, { kind: "Required" });
  if (!prompt) return fail("Write the question.", f, { prompt: "Required" });
  const competency = kind === "COMPETENCY" ? str(f, "competency", 80) : "";
  if (kind === "COMPETENCY" && !competency) return fail("Name the competency it rates.", f, { competency: "Required" });
  const appliesTo = f.getAll("appliesTo").map(String).filter((t) => ["SELF", "MANAGER", "SKIP_LEVEL", "PEER", "SUBORDINATE"].includes(t));
  const order = await prisma.reviewFormQuestion.count({ where: { sectionId: section.id } });
  await prisma.reviewFormQuestion.create({ data: { sectionId: section.id, kind, prompt, competency: competency || null, isRequired: f.get("isRequired") === "on", appliesTo, displayOrder: order } });
  return done(cyclePaths(c.cycle.id), "Question added.");
}

export async function removeFormItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const kind = str(f, "kind");
  const id = str(f, "id");
  const r = kind === "section"
    ? await prisma.reviewFormSection.deleteMany({ where: { id, cycleId: c.cycle.id } })
    : await prisma.reviewFormQuestion.deleteMany({ where: { id, section: { cycleId: c.cycle.id } } });
  return r.count ? done(cyclePaths(c.cycle.id), "Removed.") : fail("Not found.");
}

/** Copy another cycle's form into this one (only while it has none). */
export async function copyFormAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const from = await prisma.reviewCycle.findFirst({ where: { id: str(f, "fromCycleId"), tenantId: viewer.tenantId }, include: { formSections: { include: { questions: true }, orderBy: { displayOrder: "asc" } } } });
  if (!from) return fail("Choose a cycle to copy from.");
  if (await prisma.reviewFormSection.count({ where: { cycleId: c.cycle.id } })) return fail("This cycle already has a form.");
  for (const s of from.formSections) {
    await prisma.reviewFormSection.create({
      data: {
        cycleId: c.cycle.id, title: s.title, description: s.description, displayOrder: s.displayOrder,
        questions: { create: s.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, competency: q.competency, isRequired: q.isRequired, appliesTo: (q.appliesTo ?? []) as Prisma.InputJsonValue, displayOrder: q.displayOrder })) },
      },
    });
  }
  return done(cyclePaths(c.cycle.id), `Copied ${from.formSections.length} section(s) from ${from.name}.`);
}

export async function saveStageDatesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"), true);
  if ("error" in c) return fail(c.error!);
  const keys = ["selfStartsAt", "selfEndsAt", "managerStartsAt", "managerEndsAt", "calibrationStartsAt", "calibrationEndsAt", "publishOn"] as const;
  const data = Object.fromEntries(keys.map((k) => [k, dateOf(str(f, k))])) as Record<(typeof keys)[number], Date | null>;
  for (const k of keys) if (str(f, k) && !data[k]) return fail("Use valid dates.", f, { [k]: "Invalid date" });
  const problem = stageOrderProblem(data);
  if (problem) return fail(problem, f);
  await prisma.reviewCycleStage.upsert({ where: { cycleId: c.cycle.id }, create: { cycleId: c.cycle.id, ...data }, update: data });
  // The existing "reviews close" date follows the manager stage.
  if (data.managerEndsAt) await prisma.reviewCycle.update({ where: { id: c.cycle.id }, data: { reviewClosesAt: data.managerEndsAt } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReviewCycle", entityId: c.cycle.id, summary: `Set stage dates for ${c.cycle.name}` });
  return done(cyclePaths(c.cycle.id), "Stage dates saved.");
}

/** Map employees into a draft cycle: by person, or a whole department. */
export async function addParticipantsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const scope = scopedEmployeeWhere(viewer, P.PERFORMANCE_MANAGE);
  const ids = f.getAll("employeeIds").map(String).filter(Boolean);
  const dept = str(f, "departmentId");
  const where: Prisma.EmployeeWhereInput = { AND: [scope, { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } }, ids.length ? { id: { in: ids } } : dept ? { departmentId: dept } : { id: "__none__" }] };
  const people = await prisma.employee.findMany({ where, select: { id: true } });
  if (people.length === 0) return fail("Choose people or a department in your scope.");
  if (ids.length && people.length !== new Set(ids).size) return fail("Someone chosen is not in your scope.");
  const r = await prisma.reviewCycleParticipant.createMany({ data: people.map((p) => ({ cycleId: c.cycle.id, employeeId: p.id, addedBy: viewer.user.id })), skipDuplicates: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReviewCycle", entityId: c.cycle.id, summary: `Mapped ${r.count} participant(s) into ${c.cycle.name}` });
  return done(cyclePaths(c.cycle.id), `${r.count} added${people.length - r.count ? `; ${people.length - r.count} already in` : ""}.`);
}

export async function updateParticipantAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const c = await draftCycle(viewer, str(f, "cycleId"));
  if ("error" in c) return fail(c.error!);
  const row = await prisma.reviewCycleParticipant.findFirst({ where: { id: str(f, "id"), cycleId: c.cycle.id } });
  if (!row) return fail("Participant not found.");
  if (str(f, "op") === "remove") {
    await prisma.reviewCycleParticipant.delete({ where: { id: row.id } });
    return done(cyclePaths(c.cycle.id), "Removed from the cycle.");
  }
  const managerId = str(f, "managerId") || null;
  if (managerId) {
    if (managerId === row.employeeId) return fail("Someone cannot be their own reviewing manager.");
    if (!(await prisma.employee.count({ where: { id: managerId, tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } } }))) return fail("Manager not found.");
  }
  await prisma.reviewCycleParticipant.update({ where: { id: row.id }, data: { managerId } });
  return done(cyclePaths(c.cycle.id), managerId ? "Reviewing manager set." : "Back to the reporting manager.");
}

// ---------------------------------------------------------------------------
//  Calibration bands
// ---------------------------------------------------------------------------

export async function saveBandsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) return fail("You cannot edit calibration bands.");
  const c = await draftCycle(viewer, str(f, "cycleId"), true);
  if ("error" in c) return fail(c.error!);
  const existing = await prisma.performanceBand.findMany({ where: { cycleId: c.cycle.id } });
  const rows: Array<BandRow & { id: string }> = existing.map((b) => ({
    id: b.id, name: str(f, `name:${b.id}`, 60) || b.name,
    minRating: Number(str(f, `min:${b.id}`) || b.minRating), maxRating: Number(str(f, `max:${b.id}`) || b.maxRating),
    targetPercent: str(f, `target:${b.id}`) === "" ? null : Number(str(f, `target:${b.id}`)), color: str(f, `color:${b.id}`, 7) || b.color,
  }));
  const problem = bandProblems(rows);
  if (problem) return fail(problem, f);
  for (const r of rows) await prisma.performanceBand.update({ where: { id: r.id }, data: { name: r.name, minRating: r.minRating, maxRating: r.maxRating, targetPercent: r.targetPercent, color: r.color } });
  // Re-band reviews already calibrated, so bands and ratings never disagree.
  const reviews = await prisma.employeeReview.findMany({ where: { cycleId: c.cycle.id, finalRating: { not: null } }, select: { id: true, finalRating: true } });
  for (const rv of reviews) {
    const b = bandFor(Number(rv.finalRating), rows);
    await prisma.employeeReview.update({ where: { id: rv.id }, data: { bandId: b?.id ?? null } });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "PerformanceBand", entityId: c.cycle.id, summary: `Edited calibration bands for ${c.cycle.name}`, newValue: rows });
  return done(cyclePaths(c.cycle.id), `Bands saved; ${reviews.length} calibrated review(s) re-banded.`);
}

// ---------------------------------------------------------------------------
//  Feedback settings and requests
// ---------------------------------------------------------------------------

export async function saveFeedbackSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const whoCanGive = ["EVERYONE", "SAME_DEPARTMENT", "REPORTING_LINE"].includes(str(f, "whoCanGive")) ? str(f, "whoCanGive") : "EVERYONE";
  const data = { allowAnonymous: f.get("allowAnonymous") === "on", allowRequests: f.get("allowRequests") === "on", whoCanGive };
  await prisma.feedbackSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "FeedbackSetting", summary: `Feedback settings: ${whoCanGive.toLowerCase()}, anonymous ${data.allowAnonymous ? "allowed" : "off"}, requests ${data.allowRequests ? "on" : "off"}`, newValue: data });
  return done(["/performance/settings", "/me/performance"], "Feedback settings saved.");
}

/**
 * Ask a colleague for feedback — about yourself, or (as a manager) about
 * someone in your reporting line. The colleague must be allowed to give it.
 */
export async function requestFeedbackAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return fail("No employee record is linked to this login.");
  const rules = await feedbackRules(viewer.tenantId);
  if (!rules.allowRequests) return fail("Your company has turned feedback requests off.");
  const askedIds = [...new Set(f.getAll("askedIds").map(String).filter(Boolean))];
  const aboutId = str(f, "aboutEmployeeId") || viewer.employee.id;
  if (aboutId !== viewer.employee.id && !viewer.allReportIds.has(aboutId)) return fail("You can ask for feedback about yourself or people in your reporting line.", f);
  if (askedIds.length === 0) return fail("Choose who to ask.", f, { askedIds: "Required" });
  if (askedIds.length > 10) return fail("Ask up to 10 people at once.", f);
  if (askedIds.includes(aboutId)) return fail("Someone cannot give feedback about themselves.", f);
  const asked = await prisma.employee.findMany({ where: { id: { in: askedIds }, tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, userId: true, displayName: true } });
  if (asked.length !== askedIds.length) return fail("A colleague was not found.", f);
  for (const a of asked) {
    const why = await feedbackBlocker(viewer.tenantId, a.id, aboutId);
    if (why) return fail(`${a.displayName}: ${why}`, f);
  }
  const due = dateOf(str(f, "dueDate"));
  const about = aboutId === viewer.employee.id ? null : await prisma.employee.findFirst({ where: { id: aboutId, tenantId: viewer.tenantId }, select: { displayName: true } });
  await prisma.feedbackRequest.createMany({ data: asked.map((a) => ({ tenantId: viewer.tenantId, requesterId: viewer.employee!.id, askedId: a.id, aboutEmployeeId: aboutId, message: str(f, "message", 1000) || null, dueDate: due })) });
  await notify({ tenantId: viewer.tenantId, userIds: asked.map((a) => a.userId), kind: "FEEDBACK", title: `${viewer.employee.displayName} asked for your feedback${about ? ` about ${about.displayName}` : ""}`, body: str(f, "message", 200) || undefined, link: "/me/performance/requests" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "FeedbackRequest", summary: `Asked ${asked.length} colleague(s) for feedback${about ? ` about ${about.displayName}` : ""}` });
  return done(["/me/performance/requests"], `Asked ${asked.map((a) => a.displayName).join(", ")}.`);
}

export async function answerFeedbackRequestAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return fail("No employee record is linked to this login.");
  const req = await prisma.feedbackRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, askedId: viewer.employee.id }, include: { requester: { select: { userId: true, displayName: true } } } });
  if (!req) return fail("Request not found.");
  if (req.status !== "PENDING") return fail("You have already answered this request.");
  if (str(f, "op") === "decline") {
    await prisma.feedbackRequest.update({ where: { id: req.id }, data: { status: "DECLINED", respondedAt: new Date() } });
    await notify({ tenantId: viewer.tenantId, userIds: [req.requester.userId], kind: "FEEDBACK", title: `${viewer.employee.displayName} declined your feedback request`, link: "/me/performance/requests" });
    return done(["/me/performance/requests"], "Declined.");
  }
  const message = str(f, "message", 2000);
  if (!message) return fail("Write your feedback.", f, { message: "Required" });
  const rules = await feedbackRules(viewer.tenantId);
  const anonymous = f.get("anonymous") === "on";
  if (anonymous && !rules.allowAnonymous) return fail("Your company does not allow anonymous feedback.", f);
  const why = await feedbackBlocker(viewer.tenantId, viewer.employee.id, req.aboutEmployeeId);
  if (why) return fail(why, f);
  const fb = await prisma.feedback.create({ data: { tenantId: viewer.tenantId, fromEmployeeId: viewer.employee.id, aboutEmployeeId: req.aboutEmployeeId, kind: "FEEDBACK", topic: str(f, "topic", 80) || "Requested feedback", message, isAnonymous: anonymous } });
  await prisma.feedbackRequest.update({ where: { id: req.id }, data: { status: "GIVEN", feedbackId: fb.id, respondedAt: new Date() } });
  await processFeedback(viewer.tenantId, fb.id);
  const subject = await prisma.employee.findFirst({ where: { id: req.aboutEmployeeId, tenantId: viewer.tenantId }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: [subject?.userId, req.requester.userId], kind: "FEEDBACK", title: anonymous ? "You received requested feedback" : `${viewer.employee.displayName} shared the feedback you asked for`, link: "/me/performance?tab=feedback-received" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Feedback", entityId: fb.id, summary: `Answered a feedback request${anonymous ? " anonymously" : ""}` });
  return done(["/me/performance/requests", "/me/performance"], "Feedback sent. Thank you.");
}

// ---------------------------------------------------------------------------
//  Manager recommendations (review to pay) and the promotion policy
// ---------------------------------------------------------------------------

export async function savePromotionPolicyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const n = (k: string, min: number, max: number) => { const v = Number(str(f, k)); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
  const data = { minTenureMonths: n("minTenureMonths", 0, 240), minMonthsSinceLastPromotion: n("minMonthsSinceLastPromotion", 0, 240), minRating: n("minRating", 1, 5), maxIncrementPercent: n("maxIncrementPercent", 0, 200) };
  const bad = Object.entries(data).find(([, v]) => v === null);
  if (bad) return fail("Check the highlighted value.", f, { [bad[0]]: "Out of range" });
  const clean = { minTenureMonths: Math.round(data.minTenureMonths!), minMonthsSinceLastPromotion: Math.round(data.minMonthsSinceLastPromotion!), minRating: data.minRating!, maxIncrementPercent: data.maxIncrementPercent!, excludeOnPip: f.get("excludeOnPip") === "on" };
  await prisma.promotionPolicy.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...clean }, update: clean });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "PromotionPolicy", summary: "Updated promotion eligibility", newValue: clean });
  return done(["/performance/settings"], "Promotion eligibility saved.");
}

/**
 * A manager recommends an increment (and optionally a promotion) for a
 * report once their manager review is in. It goes to Inbox › Salary
 * increments for someone who can revise salaries.
 */
export async function recommendSalaryAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return fail("No employee record is linked to this login.");
  const review = await prisma.employeeReview.findFirst({
    where: { id: str(f, "reviewId"), cycle: { tenantId: viewer.tenantId } },
    include: { cycle: true, employee: { select: { id: true, displayName: true } }, responses: { where: { reviewerType: "MANAGER" } } },
  });
  if (!review) return fail("Review not found.");
  const isManager = review.responses.some((r) => r.reviewerId === viewer.employee!.id && r.submittedAt);
  if (!isManager) return fail("Only the reviewing manager can recommend, after submitting their review.");
  const pct = Number(str(f, "incrementPercent"));
  const policy = await promotionPolicyOf(viewer.tenantId);
  if (!Number.isFinite(pct) || pct < 0 || pct > policy.maxIncrementPercent) return fail(`Recommend 0 to ${policy.maxIncrementPercent}%.`, f, { incrementPercent: "Out of range" });
  const justification = str(f, "justification", 2000);
  if (!justification) return fail("Say why.", f, { justification: "Required" });
  const promote = f.get("recommendPromotion") === "on";
  const proposedJobTitle = promote ? str(f, "proposedJobTitle", 120) : "";
  if (promote && !proposedJobTitle) return fail("Name the role you are recommending them for.", f, { proposedJobTitle: "Required" });
  if (promote) {
    const el = await eligibilityFor(viewer.tenantId, review.employeeId, review.finalRating ? Number(review.finalRating) : review.rawRating ? Number(review.rawRating) : null);
    if (!el.eligible) return fail(`Not eligible for promotion yet: ${el.reasons.join("; ")}.`, f);
  }
  const existing = await prisma.salaryRecommendation.findUnique({ where: { reviewId: review.id } });
  if (existing && existing.status !== "PENDING") return fail(`This recommendation was already ${existing.status.toLowerCase()}.`);
  const data = { incrementPercent: pct, recommendPromotion: promote, proposedJobTitle: proposedJobTitle || null, justification };
  if (existing) await prisma.salaryRecommendation.update({ where: { id: existing.id }, data });
  else await prisma.salaryRecommendation.create({ data: { ...data, tenantId: viewer.tenantId, cycleId: review.cycleId, reviewId: review.id, employeeId: review.employeeId, recommendedById: viewer.employee.id } });
  const approvers = await usersWithPermission(viewer.tenantId, P.SALARY_REVISE);
  await notify({ tenantId: viewer.tenantId, userIds: approvers.filter((u) => u !== viewer.user.id), kind: "APPROVAL", title: `Salary recommendation for ${review.employee.displayName}`, body: `${pct}%${promote ? ` and promotion to ${proposedJobTitle}` : ""} — ${review.cycle.name}`, link: "/inbox?cat=salary-increments" });
  await writeAudit(viewer, { module: "PAYROLL", action: existing ? "UPDATE" : "CREATE", entityType: "SalaryRecommendation", entityId: review.id, summary: `Recommended ${pct}%${promote ? " and a promotion" : ""} for ${review.employee.displayName}` });
  return done([`/performance/reviews/${review.id}`, "/inbox", `/performance/cycles/${review.cycleId}/pay`], "Recommendation sent for approval.");
}

/**
 * Approve or reject a manager's recommendation. Approval carries the
 * increment into the cycle's review-to-pay proposal when one is in draft.
 */
export async function decideRecommendationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const rec = await prisma.salaryRecommendation.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.SALARY_REVISE) }, include: { employee: { select: { displayName: true, userId: true } } } });
  if (!rec) return fail("Recommendation not found.");
  if (rec.status !== "PENDING") return fail(`Already ${rec.status.toLowerCase()}.`);
  if (rec.employeeId === viewer.employee?.id) return fail("You cannot decide your own increment.");
  const approve = str(f, "decision") === "approve";
  const note = str(f, "note", 500);
  if (!approve && !note) return fail("Give a reason when rejecting.", f, { note: "Required" });
  const u = await prisma.salaryRecommendation.updateMany({ where: { id: rec.id, status: "PENDING" }, data: { status: approve ? "APPROVED" : "REJECTED", decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } });
  if (!u.count) return fail("Someone else decided it first.");
  let carried = "";
  if (approve) {
    const prop = await prisma.compensationProposal.findFirst({ where: { tenantId: viewer.tenantId, reviewId: rec.reviewId, status: "DRAFT" } });
    if (prop) {
      const r = await updateProposal({ tenantId: viewer.tenantId, id: prop.id, proposedPercent: Number(rec.incrementPercent), bonusAmount: Number(prop.bonusAmount), note: `Manager recommendation: ${rec.justification}`.slice(0, 500), byUserId: viewer.user.id });
      carried = r.ok ? " It is now the review-to-pay proposal." : "";
    }
  }
  const mgr = await prisma.employee.findFirst({ where: { id: rec.recommendedById, tenantId: viewer.tenantId }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: [mgr?.userId], kind: "APPROVAL", title: `Your recommendation for ${rec.employee.displayName} was ${approve ? "approved" : "rejected"}`, body: note || undefined, link: `/performance/reviews/${rec.reviewId}` });
  await writeAudit(viewer, { module: "PAYROLL", action: approve ? "APPROVE" : "REJECT", entityType: "SalaryRecommendation", entityId: rec.id, summary: `${approve ? "Approved" : "Rejected"} ${Number(rec.incrementPercent)}% for ${rec.employee.displayName}${note ? `: ${note}` : ""}` });
  return done(["/inbox", `/performance/cycles/${rec.cycleId}/pay`, `/performance/reviews/${rec.reviewId}`], `${approve ? "Approved" : "Rejected"}.${carried}`);
}

// ---------------------------------------------------------------------------
//  Growth plans
// ---------------------------------------------------------------------------

const mayManageGrowth = (v: Viewer) => canAny(v, [P.PERFORMANCE_MANAGE, P.CAREER_PATH_MANAGE]);

export async function saveGrowthTemplateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!mayManageGrowth(viewer)) return fail("You cannot manage growth plan templates.");
  const name = str(f, "name", 120);
  if (!name) return fail("Name the template.", f, { name: "Required" });
  const parsed = parseGrowthItems(String(f.get("items") ?? ""));
  if (parsed.error) return fail(parsed.error, f, { items: parsed.error });
  if (await prisma.growthPlanTemplate.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A template with that name exists.", f, { name: "Taken" });
  await prisma.growthPlanTemplate.create({ data: { tenantId: viewer.tenantId, name, description: str(f, "description", 1000) || null, items: parsed.items as unknown as Prisma.InputJsonValue, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "GrowthPlanTemplate", summary: `Added growth plan template ${name}` });
  return done(["/performance/growth"], `Added “${name}”.`);
}

export async function toggleGrowthTemplateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!mayManageGrowth(viewer)) return fail("You cannot manage growth plan templates.");
  const t = await prisma.growthPlanTemplate.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!t) return fail("Template not found.");
  await prisma.growthPlanTemplate.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
  return done(["/performance/growth"], t.isActive ? "Archived." : "Restored.");
}

/** Start a growth plan for someone from a template: a manager for their reports, HR in scope. */
export async function startGrowthPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await prisma.growthPlanTemplate.findFirst({ where: { id: str(f, "templateId"), tenantId: viewer.tenantId, isActive: true } });
  if (!t) return fail("Choose a template.", f, { templateId: "Required" });
  const employeeId = str(f, "employeeId");
  const emp = await target(viewer, employeeId);
  if (!emp) return fail("Choose the employee.", f, { employeeId: "Required" });
  const allowed = viewer.allReportIds.has(emp.id) || (mayManageGrowth(viewer) && canAccessEmployee(viewer, emp, P.PERFORMANCE_MANAGE));
  if (!allowed || emp.id === viewer.employee?.id) return fail("You can start plans for your reports, or for people in your HR scope.", f);
  const start = dateOf(str(f, "startDate")) ?? new Date(new Date().toISOString().slice(0, 10));
  const items = growthItemsOf(t.items);
  const plan = await prisma.growthPlan.create({
    data: {
      tenantId: viewer.tenantId, employeeId: emp.id, templateId: t.id, title: str(f, "title", 120) || t.name, startDate: start, createdBy: viewer.user.id,
      items: { create: items.map((it, i) => ({ title: it.title, kind: it.kind, dueDate: it.dueInDays === null ? null : new Date(start.getTime() + it.dueInDays * 86_400_000), displayOrder: i })) },
    },
  });
  await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "PERFORMANCE", title: `A growth plan was started for you: ${plan.title}`, link: "/me/performance/growth" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "GrowthPlan", entityId: plan.id, summary: `Started growth plan ${plan.title} for ${emp.displayName}` });
  return done(["/performance/growth", "/me/performance/growth"], `Plan started for ${emp.displayName} with ${items.length} item(s).`);
}

/** Tick an item off (the employee, their manager line, or HR in scope). */
export async function toggleGrowthItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const item = await prisma.growthPlanItem.findFirst({ where: { id: str(f, "id"), plan: { tenantId: viewer.tenantId } }, include: { plan: true } });
  if (!item) return fail("Item not found.");
  const emp = await target(viewer, item.plan.employeeId);
  const allowed = item.plan.employeeId === viewer.employee?.id || viewer.allReportIds.has(item.plan.employeeId) || (!!emp && mayManageGrowth(viewer) && canAccessEmployee(viewer, emp, P.PERFORMANCE_MANAGE));
  if (!allowed) return fail("You cannot update this plan.");
  if (item.plan.status !== "ACTIVE") return fail("This plan is closed.");
  await prisma.growthPlanItem.update({ where: { id: item.id }, data: { doneAt: item.doneAt ? null : new Date() } });
  const open = await prisma.growthPlanItem.count({ where: { planId: item.planId, doneAt: null } });
  if (open === 0) await prisma.growthPlan.update({ where: { id: item.planId }, data: { status: "COMPLETED" } });
  return done(["/performance/growth", "/me/performance/growth"], open === 0 ? "Every item is done — plan completed." : item.doneAt ? "Reopened." : "Done.");
}
