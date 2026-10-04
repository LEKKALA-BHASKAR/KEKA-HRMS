"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { notify, actionStep, actionsProgress, enrolEmployees } from "@keka/services";
import { requireAuth, requireViewer, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { employeeOf, reaches, inLine, field, dateField, intField } from "@/lib/growth";

/**
 * Development: individual development plans (the employee drafts, the
 * manager approves), the actions inside them — and inside improvement plans
 * and coaching plans, or raised against a skill gap — which the owner
 * submits with evidence and someone else verifies; coaching plans the coachee
 * accepts, with session logs and an effectiveness rating; and the depth of an
 * improvement plan: editing, the employee's acknowledgement and response,
 * milestones, check-ins the employee acknowledges, and a second sign-off on
 * an unsuccessful outcome.
 */

const P = PERMISSIONS;
const PATHS = ["/me/career", "/performance/careers", "/performance/development", "/performance/plans", "/me/performance"];
const NO = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ ok: false, message, ...extra });
const ACTION_KINDS = ["COURSE", "MENTORING", "PROJECT", "READING", "PRACTICE", "OTHER"];

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string) {
  await writeAudit(viewer, { module: "EMPLOYEE", action, entityType, entityId, summary });
}

async function userOf(employeeId: string | null | undefined) {
  if (!employeeId) return null;
  return (await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } }))?.userId ?? null;
}

// ---------------------------------------------------------------------------
//  Individual development plans
// ---------------------------------------------------------------------------

export async function saveDevelopmentPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = field(formData, "id", 40);
  const employeeId = field(formData, "employeeId", 40) || viewer.employee?.id || "";
  const own = employeeId === viewer.employee?.id;
  if (!own && !(await reaches(viewer, employeeId, P.CAREER_PATH_MANAGE))) return NO("You can plan only for yourself or your team.");
  const title = field(formData, "title", 160), objective = field(formData, "objective", 4000);
  if (!title || !objective) return NO("Give the plan a title and an objective.", { errors: { title: title ? "" : "Required", objective: objective ? "" : "Required" } });
  const startDate = dateField(formData, "startDate"), endDate = dateField(formData, "endDate");
  if (!startDate || !endDate || endDate <= startDate) return NO("Give a start and a later end date.", { errors: { endDate: "After the start" } });
  const careerStepId = field(formData, "careerStepId", 40) || null;
  if (careerStepId && !(await prisma.careerPathStep.count({ where: { id: careerStepId, path: { tenantId: viewer.tenantId } } }))) return NO("Career step not found.");
  const data = { title, objective, startDate, endDate, careerStepId };
  if (id) {
    const p = await prisma.developmentPlan.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!p) return NO("Plan not found.");
    if (p.employeeId !== viewer.employee?.id && !(await reaches(viewer, p.employeeId, P.CAREER_PATH_MANAGE))) return NO("You cannot change this plan.");
    if (!["DRAFT", "REJECTED", "APPROVED"].includes(p.status)) return NO("This plan is waiting for a decision or closed.");
    await prisma.developmentPlan.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "DevelopmentPlan", id, `Updated development plan "${title}"`);
    return done(PATHS, "Saved.");
  }
  const target = await employeeOf(viewer, employeeId);
  if (!target) return NO("Employee not found.");
  const p = await prisma.developmentPlan.create({ data: { ...data, tenantId: viewer.tenantId, employeeId, managerId: target.reportingManagerId, createdBy: viewer.user.id } });
  if (!own) await notify({ tenantId: viewer.tenantId, userIds: [target.userId], kind: "PERFORMANCE", title: `A development plan was started for you: ${title}`, link: "/me/career?tab=development" });
  await audit(viewer, "CREATE", "DevelopmentPlan", p.id, `Created development plan "${title}" for ${target.displayName}`);
  return { ...done(PATHS, "Plan created — add its actions, then submit it."), values: { planId: p.id } };
}

/** submit (owner) → approve / reject (manager) → complete; cancel by the manager. */
export async function developmentPlanOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const p = await prisma.developmentPlan.findFirst({ where: { id: field(formData, "planId", 40), tenantId: viewer.tenantId }, include: { actions: true, employee: { select: { userId: true, displayName: true, reportingManager: { select: { userId: true } } } } } });
  if (!p) return NO("Plan not found.");
  const own = p.employeeId === viewer.employee?.id;
  const reviewer = !own && (await reaches(viewer, p.employeeId, P.CAREER_PATH_MANAGE));
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  const now = new Date();
  if (op === "submit") {
    if (!own && !reviewer) return NO("You cannot submit this plan.");
    if (!["DRAFT", "REJECTED"].includes(p.status)) return NO("Only a draft can be submitted.");
    if (p.actions.filter((a) => a.status !== "CANCELLED").length === 0) return NO("Add at least one action first.");
    await prisma.developmentPlan.update({ where: { id: p.id }, data: { status: "SUBMITTED", submittedAt: now, decisionNote: null } });
    await notify({ tenantId: viewer.tenantId, userIds: [own ? p.employee.reportingManager?.userId : p.employee.userId], kind: "PERFORMANCE", title: `Development plan to approve: ${p.title}`, link: own ? "/performance/development" : "/me/career?tab=development" });
    await audit(viewer, "UPDATE", "DevelopmentPlan", p.id, `Submitted development plan "${p.title}"`);
    return done(PATHS, "Submitted for approval.");
  }
  if (op === "approve" || op === "reject") {
    if (!reviewer) return NO("Only the employee's manager (or a careers admin) decides this plan.");
    if (p.status !== "SUBMITTED") return NO("This plan is not waiting for approval.");
    if (op === "reject" && !note) return NO("Say what should change.", { errors: { note: "Required" } });
    await prisma.developmentPlan.update({ where: { id: p.id }, data: { status: op === "approve" ? "APPROVED" : "REJECTED", decidedBy: viewer.user.id, decidedAt: now, decisionNote: note || null } });
    await notify({ tenantId: viewer.tenantId, userIds: [p.employee.userId], kind: "PERFORMANCE", title: `Development plan ${op === "approve" ? "approved" : "sent back"}: ${p.title}`, body: note || null, link: "/me/career?tab=development" });
    await audit(viewer, op === "approve" ? "APPROVE" : "REJECT", "DevelopmentPlan", p.id, `${op === "approve" ? "Approved" : "Sent back"} ${p.employee.displayName}'s development plan "${p.title}"`);
    return done(PATHS, op === "approve" ? "Approved." : "Sent back.");
  }
  if (op === "complete") {
    if (!own && !reviewer) return NO("You cannot close this plan.");
    if (p.status !== "APPROVED") return NO("Only an approved plan can be completed.");
    const open = p.actions.filter((a) => !["VERIFIED", "CANCELLED"].includes(a.status)).length;
    if (open) return NO(`${open} action${open === 1 ? " is" : "s are"} still open.`);
    await prisma.developmentPlan.update({ where: { id: p.id }, data: { status: "COMPLETED" } });
    await audit(viewer, "UPDATE", "DevelopmentPlan", p.id, `Completed development plan "${p.title}" (${actionsProgress(p.actions)}% of actions verified)`);
    return done(PATHS, "Plan completed.");
  }
  if (op === "cancel") {
    if (!reviewer && !(own && p.status === "DRAFT")) return NO("Only the manager can cancel an active plan.");
    if (["COMPLETED", "CANCELLED"].includes(p.status)) return NO("Already closed.");
    await prisma.developmentPlan.update({ where: { id: p.id }, data: { status: "CANCELLED", decisionNote: note || p.decisionNote } });
    await audit(viewer, "UPDATE", "DevelopmentPlan", p.id, `Cancelled development plan "${p.title}"`);
    return done(PATHS, "Cancelled.");
  }
  return NO("Unknown action.");
}

// ---------------------------------------------------------------------------
//  Development actions
// ---------------------------------------------------------------------------

/** Who reviews an action: the owner's manager line, the plan's coach, or the matching admin in scope. */
async function reviewsAction(viewer: Viewer, a: { employeeId: string; pipId: string | null; coachingPlanId: string | null }): Promise<boolean> {
  if (a.employeeId === viewer.employee?.id) return false;
  if (inLine(viewer, a.employeeId)) return true;
  if (a.coachingPlanId) {
    const c = await prisma.coachingPlan.findUnique({ where: { id: a.coachingPlanId }, select: { coachId: true } });
    if (c && c.coachId === viewer.employee?.id) return true;
  }
  if (a.pipId) return reaches(viewer, a.employeeId, P.PIP_MANAGE);
  return (await reaches(viewer, a.employeeId, P.CAREER_PATH_MANAGE)) || (await reaches(viewer, a.employeeId, P.SKILL_MANAGE));
}

export async function saveDevelopmentActionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = field(formData, "id", 40);
  const title = field(formData, "title", 200);
  if (!title) return NO("Describe the action.", { errors: { title: "Required" } });
  const kind = field(formData, "kind", 20) || "OTHER";
  if (!ACTION_KINDS.includes(kind)) return NO("Choose what kind of action it is.");
  const courseId = field(formData, "courseId", 40) || null;
  const course = courseId ? await prisma.course.findFirst({ where: { id: courseId, tenantId: viewer.tenantId } }) : null;
  if (courseId && !course) return NO("Course not found.");
  if (kind === "COURSE" && !course) return NO("Choose the course.", { errors: { courseId: "Required" } });
  const skillId = field(formData, "skillId", 40) || null;
  if (skillId && !(await prisma.skill.count({ where: { id: skillId, tenantId: viewer.tenantId } }))) return NO("Skill not found.");
  const data = { title, description: field(formData, "description", 2000) || null, kind, courseId, skillId, dueDate: dateField(formData, "dueDate") };
  if (id) {
    const a = await prisma.developmentAction.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!a) return NO("Action not found.");
    if (a.employeeId !== viewer.employee?.id && !(await reviewsAction(viewer, a))) return NO("You cannot change this action.");
    if (["VERIFIED", "CANCELLED"].includes(a.status)) return NO("This action is closed.");
    await prisma.developmentAction.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "DevelopmentAction", id, `Updated development action "${title}"`);
    return done(PATHS, "Saved.");
  }
  // Where it belongs: a development plan, an improvement plan, a coaching plan, or a skill gap.
  const planId = field(formData, "planId", 40) || null, pipId = field(formData, "pipId", 40) || null, coachingPlanId = field(formData, "coachingPlanId", 40) || null;
  let employeeId = field(formData, "employeeId", 40);
  if (planId) {
    const p = await prisma.developmentPlan.findFirst({ where: { id: planId, tenantId: viewer.tenantId } });
    if (!p) return NO("Plan not found.");
    if (["COMPLETED", "CANCELLED", "SUBMITTED"].includes(p.status)) return NO("This plan cannot take new actions now.");
    employeeId = p.employeeId;
  } else if (pipId) {
    const p = await prisma.improvementPlan.findFirst({ where: { id: pipId, tenantId: viewer.tenantId } });
    if (!p || p.status !== "ACTIVE") return NO("Active improvement plan not found.");
    employeeId = p.employeeId;
  } else if (coachingPlanId) {
    const c = await prisma.coachingPlan.findFirst({ where: { id: coachingPlanId, tenantId: viewer.tenantId } });
    if (!c || !["PROPOSED", "ACTIVE"].includes(c.status)) return NO("Open coaching plan not found.");
    employeeId = c.employeeId;
  } else if (!skillId) return NO("Link the action to a plan or a skill gap.");
  else employeeId = employeeId || viewer.employee?.id || "";
  if (!employeeId) return NO("Whose action is it?");
  const own = employeeId === viewer.employee?.id;
  const draft = { employeeId, pipId, coachingPlanId };
  if (pipId ? !(await reviewsAction(viewer, draft)) : !own && !(await reviewsAction(viewer, draft))) return NO(pipId ? "Only the plan's manager or HR adds improvement-plan actions." : "You can add actions for yourself or your team.");
  const a = await prisma.developmentAction.create({ data: { ...data, tenantId: viewer.tenantId, employeeId, planId, pipId, coachingPlanId, createdBy: viewer.user.id } });
  // A course action enrols the person straight away when the course allows it.
  if (course && course.status === "PUBLISHED" && !course.requiresApproval) {
    await enrolEmployees({ tenantId: viewer.tenantId, courseId: course.id, employeeIds: [employeeId], assignedBy: viewer.employee?.id ?? null, dueDate: data.dueDate, notifyThem: false });
  }
  if (!own) await notify({ tenantId: viewer.tenantId, userIds: [await userOf(employeeId)], kind: "PERFORMANCE", title: `New development action: ${title}`, link: "/me/career?tab=development" });
  await audit(viewer, "CREATE", "DevelopmentAction", a.id, `Added development action "${title}"${skillId ? " against a skill gap" : ""}`);
  return done(PATHS, "Action added.");
}

/** start / submit (owner, with evidence) / verify / return / cancel (reviewer). */
export async function developmentActionStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const a = await prisma.developmentAction.findFirst({ where: { id: field(formData, "actionId", 40), tenantId: viewer.tenantId }, include: { employee: { select: { userId: true, displayName: true, reportingManager: { select: { userId: true } } } } } });
  if (!a) return NO("Action not found.");
  const op = field(formData, "op", 20);
  const evidence = field(formData, "evidence", 2000), note = field(formData, "note", 1000);
  const step = actionStep(a.status, op, { isOwner: a.employeeId === viewer.employee?.id, isReviewer: await reviewsAction(viewer, a), evidence, note });
  if (!step.ok) return NO(step.message);
  await prisma.developmentAction.update({
    where: { id: a.id },
    data: {
      status: step.next,
      ...(op === "submit" ? { evidence } : {}),
      ...(op === "verify" || op === "return" ? { verifiedBy: viewer.user.id, verifiedAt: new Date(), verifierNote: note || null } : {}),
    },
  });
  if (op === "submit") {
    const coach = a.coachingPlanId ? await prisma.coachingPlan.findUnique({ where: { id: a.coachingPlanId }, select: { coach: { select: { userId: true } } } }) : null;
    await notify({ tenantId: viewer.tenantId, userIds: [coach?.coach.userId ?? a.employee.reportingManager?.userId], kind: "PERFORMANCE", title: `${a.employee.displayName} finished: ${a.title}`, body: "Please verify.", link: "/performance/development" });
  }
  if (op === "verify" || op === "return") await notify({ tenantId: viewer.tenantId, userIds: [a.employee.userId], kind: "PERFORMANCE", title: `${a.title}: ${op === "verify" ? "verified" : "needs more work"}`, body: note || null, link: "/me/career?tab=development" });
  await audit(viewer, op === "verify" ? "APPROVE" : op === "return" ? "REJECT" : "UPDATE", "DevelopmentAction", a.id, `${op} development action "${a.title}" for ${a.employee.displayName}`);
  const msg: Record<string, string> = { start: "Started.", submit: "Submitted for verification.", verify: "Verified.", return: "Sent back.", cancel: "Cancelled." };
  return done(PATHS, msg[op] ?? "Done.");
}

// ---------------------------------------------------------------------------
//  Coaching plans
// ---------------------------------------------------------------------------

/** A coach — the manager, or anyone HR names — proposes; the coachee accepts or declines. */
export async function saveCoachingPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = field(formData, "id", 40);
  const focusArea = field(formData, "focusArea", 200), goals = field(formData, "goals", 4000);
  if (!focusArea || !goals) return NO("Give the focus area and the goals.", { errors: { focusArea: focusArea ? "" : "Required", goals: goals ? "" : "Required" } });
  const startDate = dateField(formData, "startDate"), endDate = dateField(formData, "endDate");
  if (!startDate || !endDate || endDate <= startDate) return NO("Give a start and a later end date.", { errors: { endDate: "After the start" } });
  if (id) {
    const c = await prisma.coachingPlan.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!c) return NO("Coaching plan not found.");
    if (c.coachId !== viewer.employee?.id && !(await reaches(viewer, c.employeeId, P.PIP_MANAGE))) return NO("Only the coach or HR can change this plan.");
    if (!["PROPOSED", "ACTIVE"].includes(c.status)) return NO("This plan is closed.");
    await prisma.coachingPlan.update({ where: { id }, data: { focusArea, goals, startDate, endDate } });
    await audit(viewer, "UPDATE", "CoachingPlan", id, `Updated coaching plan "${focusArea}"`);
    return done(PATHS, "Saved.");
  }
  const employeeId = field(formData, "employeeId", 40);
  const coachId = field(formData, "coachId", 40) || viewer.employee?.id || "";
  const hr = await reaches(viewer, employeeId, P.PIP_MANAGE);
  if (!inLine(viewer, employeeId) && !hr) return NO("You can coach people in your team; HR can pair anyone.");
  if (coachId !== viewer.employee?.id && !hr) return NO("Only HR can name someone else as the coach.");
  if (coachId === employeeId) return NO("Someone cannot coach themselves.");
  const [emp, coach] = await Promise.all([employeeOf(viewer, employeeId), employeeOf(viewer, coachId)]);
  if (!emp || !coach) return NO("Employee or coach not found.");
  const c = await prisma.coachingPlan.create({ data: { tenantId: viewer.tenantId, employeeId, coachId, focusArea, goals, startDate, endDate, createdBy: viewer.user.id } });
  await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "PERFORMANCE", title: `${coach.displayName} proposes coaching: ${focusArea}`, body: "Accept or decline the plan.", link: "/me/career?tab=development" });
  await audit(viewer, "CREATE", "CoachingPlan", c.id, `Proposed coaching "${focusArea}" for ${emp.displayName} with ${coach.displayName}`);
  return { ...done(PATHS, "Proposed — the coachee will accept or decline."), values: { coachingPlanId: c.id } };
}

export async function coachingPlanOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const c = await prisma.coachingPlan.findFirst({ where: { id: field(formData, "coachingPlanId", 40), tenantId: viewer.tenantId }, include: { actions: true, employee: { select: { userId: true, displayName: true } }, coach: { select: { userId: true, displayName: true } } } });
  if (!c) return NO("Coaching plan not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 2000);
  const coachee = c.employeeId === viewer.employee?.id, coach = c.coachId === viewer.employee?.id;
  if (op === "accept" || op === "decline") {
    if (!coachee) return NO("Only the coachee answers the proposal.");
    if (c.status !== "PROPOSED") return NO("Already answered.");
    if (op === "decline" && !note) return NO("Say why, so you can agree a better plan.", { errors: { note: "Required" } });
    await prisma.coachingPlan.update({ where: { id: c.id }, data: { status: op === "accept" ? "ACTIVE" : "DECLINED", employeeResponse: note || null, respondedAt: new Date() } });
    await notify({ tenantId: viewer.tenantId, userIds: [c.coach.userId], kind: "PERFORMANCE", title: `${c.employee.displayName} ${op === "accept" ? "accepted" : "declined"} coaching: ${c.focusArea}`, body: note || null, link: "/performance/development" });
    await audit(viewer, op === "accept" ? "APPROVE" : "REJECT", "CoachingPlan", c.id, `${op === "accept" ? "Accepted" : "Declined"} coaching "${c.focusArea}"`);
    return done(PATHS, op === "accept" ? "Accepted." : "Declined.");
  }
  if (op === "complete") {
    if (!coach && !coachee) return NO("Only the coach or coachee can complete the plan.");
    if (c.status !== "ACTIVE") return NO("Only an active plan can be completed.");
    const score = intField(formData, "effectivenessScore", 1, 5);
    if (coachee && (score === null || score === undefined)) return NO("Rate how useful the coaching was, 1 to 5.", { errors: { effectivenessScore: "1–5" } });
    if (score === undefined) return NO("Rate from 1 to 5.");
    await prisma.coachingPlan.update({ where: { id: c.id }, data: { status: "COMPLETED", closingNote: note || null, ...(score ? { effectivenessScore: score } : {}) } });
    await audit(viewer, "UPDATE", "CoachingPlan", c.id, `Completed coaching "${c.focusArea}"${score ? ` (rated ${score}/5)` : ""}; ${actionsProgress(c.actions)}% of actions verified`);
    return done(PATHS, "Coaching completed.");
  }
  if (op === "rate") {
    if (!coachee) return NO("The coachee rates the coaching.");
    const score = intField(formData, "effectivenessScore", 1, 5);
    if (!score) return NO("Rate from 1 to 5.");
    await prisma.coachingPlan.update({ where: { id: c.id }, data: { effectivenessScore: score } });
    await audit(viewer, "UPDATE", "CoachingPlan", c.id, `Rated coaching "${c.focusArea}" ${score}/5`);
    return done(PATHS, "Thanks — rated.");
  }
  if (op === "cancel") {
    if (!coach && !(await reaches(viewer, c.employeeId, P.PIP_MANAGE))) return NO("Only the coach or HR can cancel.");
    if (!["PROPOSED", "ACTIVE"].includes(c.status)) return NO("Already closed.");
    await prisma.coachingPlan.update({ where: { id: c.id }, data: { status: "CANCELLED", closingNote: note || null } });
    await audit(viewer, "UPDATE", "CoachingPlan", c.id, `Cancelled coaching "${c.focusArea}"`);
    return done(PATHS, "Cancelled.");
  }
  return NO("Unknown action.");
}

export async function logCoachingSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const c = await prisma.coachingPlan.findFirst({ where: { id: field(formData, "coachingPlanId", 40), tenantId: viewer.tenantId } });
  if (!c) return NO("Coaching plan not found.");
  if (c.coachId !== viewer.employee?.id) return NO("Only the coach logs sessions.");
  if (c.status !== "ACTIVE") return NO("Sessions are logged on an active plan.");
  const heldOn = dateField(formData, "heldOn"), notes = field(formData, "notes", 4000);
  const progress = field(formData, "progress", 10) || "STEADY";
  if (!heldOn || !notes) return NO("Give the date and what was covered.");
  if (!["GOOD", "STEADY", "CONCERN"].includes(progress)) return NO("Progress is good, steady or a concern.");
  const s = await prisma.coachingSessionLog.create({ data: { planId: c.id, heldOn, notes, progress, createdBy: viewer.user.id } });
  await audit(viewer, "CREATE", "CoachingSessionLog", s.id, `Logged a coaching session for "${c.focusArea}" (${progress.toLowerCase()})`);
  return done(PATHS, "Session logged.");
}

// ---------------------------------------------------------------------------
//  Improvement plans: edit, respond, milestones, check-ins, outcome sign-off
// ---------------------------------------------------------------------------

async function pipFor(viewer: Viewer, id: string) {
  const pip = await prisma.improvementPlan.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { employee: { select: { userId: true, displayName: true, reportingManager: { select: { userId: true } } } } } });
  if (!pip) return null;
  return { pip, manages: await reaches(viewer, pip.employeeId, P.PIP_MANAGE), own: pip.employeeId === viewer.employee?.id };
}

export async function updatePipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PIP_MANAGE);
  const r = await pipFor(viewer, field(formData, "pipId", 40));
  if (!r || !r.manages) return NO("Plan not found or outside your scope.");
  if (r.pip.status !== "ACTIVE") return NO("Only an active plan can be changed.");
  const reason = field(formData, "reason", 2000), objectives = field(formData, "objectives", 4000);
  if (!reason || !objectives) return NO("The reason and objectives are required.");
  const endDate = dateField(formData, "endDate") ?? r.pip.endDate;
  const days = (endDate.getTime() - r.pip.startDate.getTime()) / 86_400_000;
  if (days < 30 || days > 180) return NO("A plan runs between 30 and 180 days.", { errors: { endDate: "30–180 days" } });
  await prisma.improvementPlan.update({ where: { id: r.pip.id }, data: { reason, objectives, endDate } });
  await notify({ tenantId: viewer.tenantId, userIds: [r.pip.employee.userId], kind: "PERFORMANCE", title: "Your improvement plan was updated", link: "/performance/plans" });
  await audit(viewer, "UPDATE", "ImprovementPlan", r.pip.id, `Edited ${r.pip.employee.displayName}'s improvement plan (ends ${endDate.toISOString().slice(0, 10)})`);
  return done(PATHS, "Plan updated; the employee has been told.");
}

/** The employee acknowledges the plan, with their response on record. */
export async function respondPipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await pipFor(viewer, field(formData, "pipId", 40));
  if (!r || !r.own) return NO("Plan not found.");
  if (r.pip.acknowledgedAt) return NO("You have already acknowledged this plan.");
  const response = field(formData, "response", 4000);
  await prisma.improvementPlan.update({ where: { id: r.pip.id }, data: { acknowledgedAt: new Date(), employeeResponse: response || null } });
  await notify({ tenantId: viewer.tenantId, userIds: [r.pip.employee.reportingManager?.userId], kind: "PERFORMANCE", title: `${r.pip.employee.displayName} acknowledged the improvement plan`, body: response || null, link: "/performance/plans" });
  await audit(viewer, "UPDATE", "ImprovementPlan", r.pip.id, "Acknowledged the improvement plan" + (response ? " with a response" : ""));
  return done(PATHS, "Acknowledged.");
}

export async function pipMilestoneAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PIP_MANAGE);
  const op = field(formData, "op", 10) || "add";
  if (op === "add") {
    const r = await pipFor(viewer, field(formData, "pipId", 40));
    if (!r || !r.manages) return NO("Plan not found or outside your scope.");
    if (r.pip.status !== "ACTIVE") return NO("Only an active plan takes milestones.");
    const title = field(formData, "title", 200), dueDate = dateField(formData, "dueDate");
    if (!title || !dueDate) return NO("Give the milestone and its date.");
    if (dueDate < r.pip.startDate || dueDate > r.pip.endDate) return NO("The milestone must fall within the plan.", { errors: { dueDate: "Outside the plan" } });
    const m = await prisma.pipMilestone.create({ data: { pipId: r.pip.id, title, dueDate } });
    await audit(viewer, "CREATE", "PipMilestone", m.id, `Added milestone "${title}" to ${r.pip.employee.displayName}'s plan`);
    return done(PATHS, "Milestone added.");
  }
  const m = await prisma.pipMilestone.findFirst({ where: { id: field(formData, "milestoneId", 40), pip: { tenantId: viewer.tenantId } }, include: { pip: true } });
  if (!m) return NO("Milestone not found.");
  if (!(await reaches(viewer, m.pip.employeeId, P.PIP_MANAGE))) return NO("Outside your scope.");
  if (op !== "met" && op !== "missed") return NO("Mark it met or missed.");
  await prisma.pipMilestone.update({ where: { id: m.id }, data: { status: op === "met" ? "MET" : "MISSED", completedAt: new Date(), note: field(formData, "note", 1000) || m.note } });
  await audit(viewer, "UPDATE", "PipMilestone", m.id, `Milestone "${m.title}" ${op}`);
  return done(PATHS, `Marked ${op}.`);
}

/** The manager records a check-in; the employee acknowledges it and may comment. */
export async function pipCheckInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const op = field(formData, "op", 10) || "add";
  if (op === "add") {
    const r = await pipFor(viewer, field(formData, "pipId", 40));
    if (!r || !r.manages) return NO("Plan not found or outside your scope.");
    if (r.pip.status !== "ACTIVE") return NO("Check-ins are recorded on an active plan.");
    const progress = field(formData, "progress", 12), notes = field(formData, "notes", 4000), heldOn = dateField(formData, "heldOn") ?? new Date();
    if (!["ON_TRACK", "AT_RISK", "OFF_TRACK"].includes(progress)) return NO("Choose on track, at risk or off track.");
    if (!notes) return NO("Note what was discussed.", { errors: { notes: "Required" } });
    const c = await prisma.pipCheckIn.create({ data: { pipId: r.pip.id, heldOn, progress, notes, createdBy: viewer.user.id } });
    await notify({ tenantId: viewer.tenantId, userIds: [r.pip.employee.userId], kind: "PERFORMANCE", title: "Improvement plan check-in recorded", body: "Please read and acknowledge it.", link: "/performance/plans" });
    await audit(viewer, "CREATE", "PipCheckIn", c.id, `Check-in on ${r.pip.employee.displayName}'s plan: ${progress.toLowerCase().replace("_", " ")}`);
    return done(PATHS, "Check-in recorded; the employee will acknowledge it.");
  }
  if (op === "ack") {
    const c = await prisma.pipCheckIn.findFirst({ where: { id: field(formData, "checkInId", 40), pip: { tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__" } } });
    if (!c) return NO("Check-in not found.");
    if (c.acknowledgedAt) return NO("Already acknowledged.");
    await prisma.pipCheckIn.update({ where: { id: c.id }, data: { acknowledgedAt: new Date(), employeeComment: field(formData, "comment", 2000) || null } });
    await audit(viewer, "APPROVE", "PipCheckIn", c.id, "Acknowledged an improvement-plan check-in");
    return done(PATHS, "Acknowledged.");
  }
  return NO("Unknown action.");
}

/** A second PIP manager confirms or overturns a proposed unsuccessful outcome. */
export async function decidePipOutcomeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PIP_MANAGE);
  const r = await pipFor(viewer, field(formData, "pipId", 40));
  if (!r || !r.manages) return NO("Plan not found or outside your scope.");
  const pip = r.pip;
  if (!pip.proposedOutcome) return NO("No outcome is waiting for sign-off.");
  if (pip.proposedBy === viewer.user.id) return NO("You proposed this outcome — another PIP manager signs it off.");
  const decision = field(formData, "decision", 10);
  const note = field(formData, "note", 1000);
  if (decision !== "approve" && decision !== "reject") return NO("Approve or reject.");
  if (decision === "reject" && !note) return NO("Say why the outcome is not confirmed.", { errors: { note: "Required" } });
  const clear = { proposedOutcome: null, proposedNote: null, proposedBy: null, proposedAt: null };
  if (decision === "approve") {
    await prisma.improvementPlan.update({ where: { id: pip.id }, data: { ...clear, status: "CLOSED", outcome: pip.proposedOutcome, outcomeNote: [pip.proposedNote, note].filter(Boolean).join(" — "), decidedAt: new Date(), decidedBy: viewer.user.id } });
    await notify({ tenantId: viewer.tenantId, userIds: [pip.employee.userId], kind: "PERFORMANCE", title: "Your improvement plan has closed", link: "/performance/plans" });
  } else {
    await prisma.improvementPlan.update({ where: { id: pip.id }, data: clear });
  }
  if (pip.proposedBy) await notify({ tenantId: viewer.tenantId, userIds: [pip.proposedBy], kind: "PERFORMANCE", title: `Improvement plan outcome ${decision === "approve" ? "confirmed" : "not confirmed"}: ${pip.employee.displayName}`, body: note || null, link: "/performance/plans" });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "ImprovementPlan", pip.id, `${decision === "approve" ? "Confirmed" : "Overturned"} the ${String(pip.proposedOutcome).toLowerCase()} outcome for ${pip.employee.displayName}${note ? `: ${note}` : ""}`);
  return done(PATHS, decision === "approve" ? "Outcome confirmed; the plan is closed." : "Not confirmed; the plan stays active.");
}
