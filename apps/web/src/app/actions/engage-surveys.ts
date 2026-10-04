"use server";

import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { runSurveySchedules, notify, engageSettings, purgeSurveyData } from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import { formList, writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Survey administration: recurring pulse schedules, the template library,
 * action plans from results, and the engage settings (approval switches,
 * points, anonymity minimums).
 */

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const int = (f: FormData, k: string) => { const v = str(f, k); if (v === "") return null; const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const ADMIN = "/engage/survey-admin";

// ---------------------------------------------------------------------------
//  Recurring pulse schedules
// ---------------------------------------------------------------------------

export async function saveScheduleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title");
  const kind = str(f, "kind") || "PULSE";
  const everyDays = int(f, "everyDays");
  const openDays = int(f, "openDays") ?? 7;
  const firstRun = day(str(f, "nextRunOn"));
  const templateId = str(f, "templateId") || null;
  const departmentIds = formList(f, "departmentIds");
  if (!title) return { ok: false, message: "Give the schedule a title.", errors: { title: "Required" } };
  if (!["PULSE", "ENPS", "ENGAGEMENT"].includes(kind)) return { ok: false, message: "Pick a survey type." };
  if (everyDays === null || Number.isNaN(everyDays) || everyDays < 7 || everyDays > 365) return { ok: false, message: "Run every 7 to 365 days.", errors: { everyDays: "7–365" } };
  if (Number.isNaN(openDays) || openDays < 1 || openDays > everyDays) return { ok: false, message: "Each run stays open between 1 day and the interval.", errors: { openDays: "Too long" } };
  if (!firstRun) return { ok: false, message: "Pick the first run date.", errors: { nextRunOn: "Required" } };
  const foreign = await foreignReference(viewer.tenantId, { department: departmentIds });
  if (foreign) return { ok: false, message: foreign };
  if (templateId && !(await prisma.surveyTemplate.count({ where: { id: templateId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Template not found." };
  const data = { title, kind, everyDays, openDays, nextRunOn: firstRun, templateId, departmentIds, onSignIn: f.get("onSignIn") === "on" };
  let sid = id;
  if (id) {
    const res = await prisma.surveySchedule.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
    if (res.count === 0) return { ok: false, message: "Schedule not found." };
  } else {
    sid = (await prisma.surveySchedule.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } })).id;
  }
  await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "SurveySchedule", entityId: sid, summary: `${id ? "Updated" : "Created"} recurring ${kind.toLowerCase()} "${title}" every ${everyDays} days` });
  return done([ADMIN], id ? "Schedule updated." : `Scheduled. The first run goes out on ${firstRun.toISOString().slice(0, 10)}.`);
}

export async function scheduleOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const sc = await prisma.surveySchedule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  const op = str(f, "op");
  if (op === "run-due") {
    const n = await runSurveySchedules(viewer.tenantId);
    return done([ADMIN, "/engage/surveys"], n ? `Launched ${n} scheduled survey(s).` : "Nothing is due.");
  }
  if (!sc) return { ok: false, message: "Schedule not found." };
  if (op === "pause" || op === "resume") {
    await prisma.surveySchedule.update({ where: { id: sc.id }, data: { isActive: op === "resume" } });
  } else if (op === "run-now") {
    await prisma.surveySchedule.update({ where: { id: sc.id }, data: { nextRunOn: new Date() } });
    const n = await runSurveySchedules(viewer.tenantId);
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "SurveySchedule", entityId: sc.id, summary: `Ran "${sc.title}" now` });
    return done([ADMIN, "/engage/surveys"], n ? "Launched this run now." : "Could not launch the run.");
  } else if (op === "delete") {
    await prisma.surveySchedule.delete({ where: { id: sc.id } });
  } else return { ok: false, message: "Unknown operation." };
  await writeAudit(viewer, { module: "SYSTEM", action: op === "delete" ? "DELETE" : "UPDATE", entityType: "SurveySchedule", entityId: sc.id, summary: `${op} "${sc.title}"` });
  return done([ADMIN], op === "delete" ? "Schedule deleted; past runs are kept." : op === "pause" ? "Paused." : "Resumed.");
}

// ---------------------------------------------------------------------------
//  Template library
// ---------------------------------------------------------------------------

/** Save an existing survey's questions as a reusable template. */
export async function saveTemplateFromSurveyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const s = await prisma.survey.findFirst({ where: { id: str(f, "surveyId"), tenantId: viewer.tenantId, kind: { notIn: ["EXIT"] } }, include: { questions: { orderBy: { sequence: "asc" } } } });
  if (!s) return { ok: false, message: "Survey not found." };
  const name = str(f, "name") || s.title;
  if (s.questions.length === 0) return { ok: false, message: "The survey has no questions." };
  const questions = s.questions.map((q) => ({ prompt: q.prompt, type: q.type, driver: q.driver, options: q.options, required: q.required }));
  try {
    const t = await prisma.surveyTemplate.create({ data: { tenantId: viewer.tenantId, name, description: str(f, "description") || s.description, kind: s.kind, questions: questions as Prisma.InputJsonValue, createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "SurveyTemplate", entityId: t.id, summary: `Saved "${name}" to the template library (${questions.length} questions)` });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A template with that name already exists.", errors: { name: "Taken" } };
    throw err;
  }
  return done([ADMIN, `/engage/surveys/${s.id}`], "Saved to the template library.");
}

export async function templateOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const t = await prisma.surveyTemplate.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  const op = str(f, "op");
  if (op === "rename") {
    const name = str(f, "name");
    if (!name) return { ok: false, message: "Give it a name." };
    await prisma.surveyTemplate.update({ where: { id: t.id }, data: { name, description: str(f, "description") || t.description } });
  } else if (op === "toggle") await prisma.surveyTemplate.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
  else if (op === "delete") await prisma.surveyTemplate.delete({ where: { id: t.id } });
  else return { ok: false, message: "Unknown operation." };
  await writeAudit(viewer, { module: "SYSTEM", action: op === "delete" ? "DELETE" : "UPDATE", entityType: "SurveyTemplate", entityId: t.id, summary: `Template "${t.name}": ${op}` });
  return done([ADMIN], op === "delete" ? "Template deleted." : "Saved.");
}

// ---------------------------------------------------------------------------
//  Action plans
// ---------------------------------------------------------------------------

export async function createActionPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const s = await prisma.survey.findFirst({ where: { id: str(f, "surveyId"), tenantId: viewer.tenantId } });
  if (!s) return { ok: false, message: "Survey not found." };
  if (s.status === "DRAFT") return { ok: false, message: "Plan actions once results are in." };
  const title = str(f, "title");
  const ownerEmployeeId = str(f, "ownerEmployeeId");
  const dueOn = day(str(f, "dueOn"));
  if (!title) return { ok: false, message: "Say what will be done.", errors: { title: "Required" } };
  if (!dueOn) return { ok: false, message: "Set a due date.", errors: { dueOn: "Required" } };
  const owner = await prisma.employee.findFirst({ where: { id: ownerEmployeeId, tenantId: viewer.tenantId }, select: { id: true, userId: true, displayName: true } });
  if (!owner) return { ok: false, message: "Pick an owner.", errors: { ownerEmployeeId: "Required" } };
  const plan = await prisma.surveyActionPlan.create({
    data: { tenantId: viewer.tenantId, surveyId: s.id, driver: str(f, "driver") || null, title, description: str(f, "description") || null, ownerEmployeeId: owner.id, dueOn, createdBy: viewer.user.id },
  });
  await notify({ tenantId: viewer.tenantId, userIds: [owner.userId], kind: "ENGAGE", title: `Action plan assigned: ${title}`, body: `From the "${s.title}" results, due ${dueOn.toISOString().slice(0, 10)}`, link: `/engage/surveys/${s.id}` });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "SurveyActionPlan", entityId: plan.id, summary: `Action plan "${title}" for ${owner.displayName} from "${s.title}"` });
  return done([`/engage/surveys/${s.id}`, ADMIN], "Action plan created and the owner notified.");
}

/** The owner (or a survey manager) moves an action plan along. */
export async function updateActionPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const plan = await prisma.surveyActionPlan.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Action plan not found." };
  const isOwner = viewer.employee?.id === plan.ownerEmployeeId;
  if (!isOwner && !can(viewer, P.SURVEY_MANAGE)) return { ok: false, message: "Only the owner or a survey manager can update this plan." };
  const status = str(f, "status");
  if (!["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) return { ok: false, message: "Pick a status." };
  if (status === "CANCELLED" && !can(viewer, P.SURVEY_MANAGE)) return { ok: false, message: "Only a survey manager can cancel a plan." };
  const note = str(f, "progressNote") || plan.progressNote;
  await prisma.surveyActionPlan.update({ where: { id: plan.id }, data: { status, progressNote: note, completedAt: status === "DONE" ? new Date() : null } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "SurveyActionPlan", entityId: plan.id, summary: `Action plan "${plan.title}": ${plan.status} → ${status}` });
  return done([`/engage/surveys/${plan.surveyId}`, ADMIN], "Action plan updated.");
}

// ---------------------------------------------------------------------------
//  Engage settings
// ---------------------------------------------------------------------------

/** Each scope is guarded by the permission of the module it governs. */
export async function saveEngageSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const scope = str(f, "scope");
  const perm = scope === "surveys" ? P.SURVEY_MANAGE : scope === "announcements" ? P.ANNOUNCEMENT_MANAGE : scope === "rewards" ? P.AWARD_MANAGE : scope === "wellness" ? P.WELLNESS_MANAGE : null;
  if (!perm) return { ok: false, message: "Unknown settings." };
  const viewer = await requireAuth(perm);
  const data: Record<string, boolean | number> = {};
  if (scope === "surveys") {
    data.surveyApproval = f.get("surveyApproval") === "on";
    const days = int(f, "surveyRetentionDays") ?? 0;
    if (Number.isNaN(days) || days < 0 || days > 3650) return { ok: false, message: "Retention: 0 (keep) to 3650 days.", errors: { surveyRetentionDays: "0–3650" } };
    if (days > 0 && days < 30) return { ok: false, message: "Keep responses at least 30 days after a survey closes.", errors: { surveyRetentionDays: "30 or more" } };
    data.surveyRetentionDays = days;
  }
  if (scope === "announcements") data.announcementApproval = f.get("announcementApproval") === "on";
  if (scope === "rewards") {
    const pp = int(f, "pointsPerPraise"), ap = int(f, "anniversaryPoints");
    if (pp === null || Number.isNaN(pp) || pp < 0 || pp > 1000) return { ok: false, message: "Points per praise: 0 to 1000.", errors: { pointsPerPraise: "0–1000" } };
    if (ap === null || Number.isNaN(ap) || ap < 0 || ap > 10000) return { ok: false, message: "Anniversary points: 0 to 10000.", errors: { anniversaryPoints: "0–10000" } };
    data.pointsPerPraise = pp; data.anniversaryPoints = ap;
  }
  if (scope === "wellness") {
    const m = int(f, "checkInMinGroup");
    if (m === null || Number.isNaN(m) || m < 2 || m > 20) return { ok: false, message: "Minimum group: 2 to 20.", errors: { checkInMinGroup: "2–20" } };
    data.checkInMinGroup = m;
  }
  const before = await prisma.engageSetting.findUnique({ where: { tenantId: viewer.tenantId } });
  await prisma.engageSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EngageSetting", entityId: viewer.tenantId, summary: `Updated ${scope} settings`, oldValue: before, newValue: data });
  return done([ADMIN, "/announcements", "/engage/rewards", "/engage/wellness"], "Settings saved.");
}

// ---------------------------------------------------------------------------
//  Comment moderation and retention
// ---------------------------------------------------------------------------

/** Hide (or restore) a free-text survey comment, e.g. one that names a colleague. The text stays stored for audit; results and exports leave it out. */
export async function moderateSurveyCommentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const a = await prisma.surveyAnswer.findFirst({ where: { id: str(f, "answerId"), response: { survey: { tenantId: viewer.tenantId } } }, include: { response: { select: { surveyId: true } } } });
  if (!a || !a.text) return { ok: false, message: "Comment not found." };
  const op = str(f, "op");
  if (op === "hide") {
    const reason = str(f, "reason");
    if (!reason) return { ok: false, message: "Say why it is hidden." };
    await prisma.surveyAnswer.update({ where: { id: a.id }, data: { textHiddenAt: new Date(), textHiddenReason: reason.slice(0, 300) } });
  } else if (op === "restore") {
    await prisma.surveyAnswer.update({ where: { id: a.id }, data: { textHiddenAt: null, textHiddenReason: null } });
  } else return { ok: false, message: "Unknown operation." };
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "SurveyAnswer", entityId: a.id, summary: `${op === "hide" ? "Hid" : "Restored"} a survey comment${op === "hide" ? `: ${str(f, "reason")}` : ""}` });
  return done([`/engage/surveys/${a.response.surveyId}`], op === "hide" ? "Comment hidden from results." : "Comment restored.");
}

/** Apply the retention policy now (it also runs nightly). */
export async function applySurveyRetentionAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const s = await engageSettings(viewer.tenantId);
  if (!s.surveyRetentionDays) return { ok: false, message: "Set a retention period first." };
  const n = await purgeSurveyData(viewer.tenantId, s.surveyRetentionDays);
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: "SurveyResponse", entityId: viewer.tenantId, summary: `Retention: deleted responses of ${n} survey${n === 1 ? "" : "s"} closed over ${s.surveyRetentionDays} days ago` });
  return done(["/engage/surveys", ADMIN], n ? `Deleted the responses of ${n} survey${n === 1 ? "" : "s"}.` : "Nothing is past the retention period.");
}
