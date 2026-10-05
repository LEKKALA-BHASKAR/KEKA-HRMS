"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, notify, parseScalePoints, cycleTemplateConfigOf, performanceSummary, describeRating, scalePointsOf, weightedCompetencyScore,
  refreshPerfExceptions, sendReviewReminders, sendCheckInAlerts, sendCoachingReminders, sendFeedbackDigests, snapshotGoals, stretchProblem, CHECKIN_CADENCES,
  dependencyLoop, parseTagList, feedbackEditable, processFeedback, parseMilestoneLines, milestonesFromTemplate, extensionProblem, PERF_EXCEPTION_KINDS,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, actionDone, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, DENIED, no, readUpload } from "@/lib/cases-docs";
import { reaches, inLine, employeeOf } from "@/lib/growth";
import { saveFile } from "@/lib/storage";
import { pipEligibilityProblems, seedPipChecklist } from "@/lib/insight/pips";

/**
 * Insights › performance, OKRs, continuous feedback and improvement plans:
 * cycle templates, rating scales and their description library, competency
 * weights, conditional form sections, review reopening (approval), the
 * calibration notes repository, the exception queue, generated summaries,
 * 360 campaign settings and questionnaires, OKR settings, stretch targets,
 * check-in cadence, links and dependencies, at-risk triage, close-out
 * (approval) and snapshots; feedback topics, tags, edits, request
 * maintenance, escalation rules, follow-ups; PIP templates, eligibility,
 * objectives, evidence, compliance checklists, behaviour logs and PIP
 * requests (extension, escalation, check-in sign-off — approvals).
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
const PERF_PATHS = ["/performance/operations", "/performance/cycles", "/performance"];
const OKR_PATHS = ["/performance/okr", "/performance/goals", "/me/performance"];
const FB_PATHS = ["/performance/feedback-hub", "/me/performance", "/me/performance/requests"];
const PIP_PATHS = ["/performance/pip-ops", "/performance/plans", "/performance/development"];

async function audit(v: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string | null, summary: string) {
  await writeAudit(v, { module: "EMPLOYEE", action, entityType, entityId, summary });
}
const perfAdmin = (v: Viewer) => can(v, P.PERFORMANCE_MANAGE);
const num = (fd: FormData, k: string) => { const n = money(fd, k); return n === null || Number.isNaN(n) ? null : n; };

async function cycleOf(v: Viewer, id: string) {
  return prisma.reviewCycle.findFirst({ where: { id, tenantId: v.tenantId }, include: { bands: true, formSections: { include: { questions: true }, orderBy: { displayOrder: "asc" } } } });
}

// ---------------------------------------------------------------------------
//  Cycle templates
// ---------------------------------------------------------------------------

/** Save a cycle's set-up (reviewers, weights, scale, bands, form) as a reusable template. */
export async function saveCycleTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const c = await cycleOf(v, str(fd, "cycleId"));
  if (!c) return { ok: false, message: "Choose the cycle to copy.", errors: { cycleId: "Required" } };
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the template.", errors: { name: "Required" } };
  if (await prisma.insightCycleTemplate.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "A template with this name exists.", errors: { name: "Exists" } };
  const config = {
    reviewerTypes: Array.isArray(c.reviewerTypes) ? c.reviewerTypes : [], ratingMax: (c.ratingScale as { max?: number } | null)?.max ?? 5, maxPeers: c.maxPeers, anonymousFeedback: c.anonymousFeedback,
    ratingScaleId: c.ratingScaleId,
    bands: c.bands.map((b) => ({ name: b.name, minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null ? null : Number(b.targetPercent), color: b.color })),
    sections: c.formSections.map((s) => ({ title: s.title, questions: s.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, competency: q.competency, isRequired: q.isRequired, appliesTo: Array.isArray(q.appliesTo) ? q.appliesTo : [], weight: q.weight === null ? null : Number(q.weight) })) })),
  };
  const t = await prisma.insightCycleTemplate.create({ data: { tenantId: v.tenantId, name, description: optStr(fd, "description"), config: JSON.parse(JSON.stringify(config)), createdBy: v.user.id } });
  await audit(v, "CREATE", "InsightCycleTemplate", t.id, `Cycle template ${name} saved from ${c.name}`);
  return actionDone(PERF_PATHS, "Template saved.");
}

/** A new draft cycle from a template. */
export async function createCycleFromTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const t = await prisma.insightCycleTemplate.findFirst({ where: { id: str(fd, "templateId"), tenantId: v.tenantId, isActive: true } });
  if (!t) return { ok: false, message: "Choose a template.", errors: { templateId: "Required" } };
  const name = str(fd, "name").slice(0, 80);
  const periodStart = day(fd, "periodStart"), periodEnd = day(fd, "periodEnd");
  if (name.length < 2) return { ok: false, message: "Name the cycle.", errors: { name: "Required" } };
  if (!periodStart || !periodEnd || periodEnd <= periodStart) return { ok: false, message: "Give a period that ends after it starts.", errors: { periodEnd: "After the start" } };
  const cfg = cycleTemplateConfigOf(t.config);
  const scaleId = (t.config as { ratingScaleId?: string | null } | null)?.ratingScaleId ?? null;
  const scale = scaleId ? await prisma.insightRatingScale.findFirst({ where: { id: scaleId, tenantId: v.tenantId } }) : null;
  const c = await prisma.reviewCycle.create({
    data: {
      tenantId: v.tenantId, name, periodStart, periodEnd, reviewClosesAt: day(fd, "reviewClosesAt"),
      reviewerTypes: cfg.reviewerTypes.length ? cfg.reviewerTypes : [{ type: "SELF", weight: 30 }, { type: "MANAGER", weight: 70 }],
      ratingScale: { min: 1, max: cfg.ratingMax }, ratingScaleId: scale?.id ?? null, maxPeers: cfg.maxPeers, anonymousFeedback: cfg.anonymousFeedback,
      bands: { create: cfg.bands.map((b, i) => ({ name: b.name, minRating: b.minRating, maxRating: b.maxRating, targetPercent: b.targetPercent, color: b.color, displayOrder: i })) },
    },
  });
  for (const [i, s] of cfg.sections.entries()) {
    await prisma.reviewFormSection.create({ data: { cycleId: c.id, title: s.title, displayOrder: i, questions: { create: s.questions.map((q, j) => ({ kind: q.kind, prompt: q.prompt, competency: q.competency, isRequired: q.isRequired, appliesTo: q.appliesTo.length ? q.appliesTo : undefined, weight: q.weight, displayOrder: j })) } } });
  }
  await audit(v, "CREATE", "ReviewCycle", c.id, `Created review cycle ${name} from template ${t.name}`);
  return { ...actionDone(PERF_PATHS, `Created ${name} from ${t.name}.`), values: { cycleId: c.id } };
}

export async function toggleCycleTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const t = await prisma.insightCycleTemplate.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!t) return no("Template not found.");
  await prisma.insightCycleTemplate.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
  await audit(v, "UPDATE", "InsightCycleTemplate", t.id, `Cycle template ${t.name} ${t.isActive ? "retired" : "reactivated"}`);
  return actionDone(PERF_PATHS, t.isActive ? "Retired." : "Reactivated.");
}

// ---------------------------------------------------------------------------
//  Rating scales and the description library
// ---------------------------------------------------------------------------

export async function saveRatingScaleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const name = str(fd, "name").slice(0, 80);
  if (name.length < 2) return { ok: false, message: "Name the scale.", errors: { name: "Required" } };
  const parsed = parseScalePoints(str(fd, "points"));
  if (!parsed.ok) return { ok: false, message: parsed.message, errors: { points: parsed.message } };
  const id = optStr(fd, "id");
  if (id) {
    const s = await prisma.insightRatingScale.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!s) return no("Scale not found.");
    const used = await prisma.reviewCycle.count({ where: { tenantId: v.tenantId, ratingScaleId: s.id, status: { not: "DRAFT" } } });
    if (used && scalePointsOf(s.points).length !== parsed.points.length) return no("Launched cycles use this scale; you can reword its points but not change how many there are.");
    await prisma.insightRatingScale.update({ where: { id }, data: { name, points: JSON.parse(JSON.stringify(parsed.points)), isActive: fd.has("isActive") ? bool(fd, "isActive") : s.isActive } });
    await audit(v, "UPDATE", "InsightRatingScale", id, `Rating scale ${name} updated (${parsed.points.length} points)`);
    return actionDone(PERF_PATHS, "Saved.");
  }
  if (await prisma.insightRatingScale.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "A scale with this name exists.", errors: { name: "Exists" } };
  const s = await prisma.insightRatingScale.create({ data: { tenantId: v.tenantId, name, points: JSON.parse(JSON.stringify(parsed.points)), createdBy: v.user.id } });
  await audit(v, "CREATE", "InsightRatingScale", s.id, `Rating scale ${name} created (${parsed.points.length} points)`);
  return actionDone(PERF_PATHS, "Scale saved.");
}

/** Use a scale on a draft cycle: its maximum becomes the cycle's, and the bands are stretched to fit. */
export async function applyRatingScaleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const c = await cycleOf(v, str(fd, "cycleId"));
  if (!c) return { ok: false, message: "Choose a cycle.", errors: { cycleId: "Required" } };
  if (c.status !== "DRAFT") return no("A scale can change only while the cycle is a draft.");
  const s = await prisma.insightRatingScale.findFirst({ where: { id: str(fd, "scaleId"), tenantId: v.tenantId, isActive: true } });
  if (!s) return { ok: false, message: "Choose a scale.", errors: { scaleId: "Required" } };
  const max = scalePointsOf(s.points).length;
  const oldMax = (c.ratingScale as { max?: number } | null)?.max ?? 5;
  const f = (x: unknown) => Math.round((1 + ((Number(x) - 1) * (max - 1)) / Math.max(1, oldMax - 1)) * 100) / 100;
  await prisma.$transaction([
    prisma.reviewCycle.update({ where: { id: c.id }, data: { ratingScaleId: s.id, ratingScale: { min: 1, max } } }),
    ...c.bands.map((b) => prisma.performanceBand.update({ where: { id: b.id }, data: { minRating: f(b.minRating), maxRating: f(b.maxRating) } })),
  ]);
  await audit(v, "UPDATE", "ReviewCycle", c.id, `Rating scale ${s.name} (1–${max}) applied to ${c.name}`);
  return actionDone(PERF_PATHS, `${c.name} now rates 1–${max}; the bands were rescaled.`);
}

// ---------------------------------------------------------------------------
//  Review form: competency weights and conditional sections
// ---------------------------------------------------------------------------

export async function setQuestionWeightAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const q = await prisma.reviewFormQuestion.findFirst({ where: { id: str(fd, "questionId"), section: { cycle: { tenantId: v.tenantId } } }, include: { section: { include: { cycle: true } } } });
  if (!q) return no("Question not found.");
  if (q.section.cycle.status !== "DRAFT") return no("The form can change only while the cycle is a draft.");
  if (q.kind !== "COMPETENCY") return no("Weights apply to competency questions.");
  const weight = num(fd, "weight");
  if (weight !== null && (weight < 0 || weight > 100)) return { ok: false, message: "Weight is 0–100.", errors: { weight: "0–100" } };
  await prisma.reviewFormQuestion.update({ where: { id: q.id }, data: { weight } });
  await audit(v, "UPDATE", "ReviewFormQuestion", q.id, `Competency “${q.competency ?? q.prompt.slice(0, 40)}” weighted ${weight ?? "equally"} in ${q.section.cycle.name}`);
  return actionDone(PERF_PATHS, "Weight saved.");
}

export async function setSectionConditionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const s = await prisma.reviewFormSection.findFirst({ where: { id: str(fd, "sectionId"), cycle: { tenantId: v.tenantId } }, include: { cycle: { include: { formSections: { include: { questions: true } } } } } });
  if (!s) return no("Section not found.");
  if (s.cycle.status !== "DRAFT") return no("The form can change only while the cycle is a draft.");
  const qid = optStr(fd, "conditionQuestionId");
  if (!qid) {
    await prisma.reviewFormSection.update({ where: { id: s.id }, data: { conditionQuestionId: null, conditionOp: null, conditionValue: null } });
    await audit(v, "UPDATE", "ReviewFormSection", s.id, `Section ${s.title} always shows`);
    return actionDone(PERF_PATHS, "The section always shows.");
  }
  const q = s.cycle.formSections.flatMap((x) => x.questions.map((y) => ({ ...y, sectionId: x.id }))).find((y) => y.id === qid);
  if (!q || q.sectionId === s.id) return { ok: false, message: "Choose a rating question from another section.", errors: { conditionQuestionId: "Another section's question" } };
  if (q.kind !== "RATING" && q.kind !== "COMPETENCY") return no("The condition must be on a rated question.");
  const op = ["LTE", "GTE", "EQ"].includes(str(fd, "conditionOp")) ? str(fd, "conditionOp") : null;
  const value = num(fd, "conditionValue");
  if (!op || value === null) return { ok: false, message: "Give the comparison and the value.", errors: { conditionValue: "Required" } };
  await prisma.reviewFormSection.update({ where: { id: s.id }, data: { conditionQuestionId: qid, conditionOp: op, conditionValue: value } });
  await audit(v, "UPDATE", "ReviewFormSection", s.id, `Section ${s.title} shows when “${q.prompt.slice(0, 40)}” ${op === "LTE" ? "≤" : op === "GTE" ? "≥" : "="} ${value}`);
  return actionDone(PERF_PATHS, "Condition saved.");
}

/** Build a 360 section from an approved THREE_SIXTY feedback template, asked of peers, reports and skip-level reviewers. */
export async function apply360TemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const c = await cycleOf(v, str(fd, "cycleId"));
  if (!c) return { ok: false, message: "Choose a cycle.", errors: { cycleId: "Required" } };
  if (c.status !== "DRAFT") return no("The form can change only while the cycle is a draft.");
  const t = await prisma.feedbackTemplate.findFirst({ where: { id: str(fd, "templateId"), tenantId: v.tenantId, status: "APPROVED", purpose: "THREE_SIXTY" } });
  if (!t) return { ok: false, message: "Choose an approved 360 template.", errors: { templateId: "Required" } };
  const title = `360: ${t.name}`.slice(0, 120);
  if (c.formSections.some((s) => s.title === title)) return no("This template is already on the form.");
  const s = await prisma.reviewFormSection.create({
    data: { cycleId: c.id, title, description: t.description, displayOrder: c.formSections.length, questions: { create: t.questions.map((prompt, i) => ({ kind: "TEXT", prompt: prompt.slice(0, 500), isRequired: true, appliesTo: ["PEER", "SUBORDINATE", "SKIP_LEVEL"], displayOrder: i })) } },
  });
  await audit(v, "UPDATE", "ReviewFormSection", s.id, `360 questionnaire ${t.name} (${t.questions.length} questions) added to ${c.name}`);
  return actionDone(PERF_PATHS, `${t.questions.length} question(s) added for 360 reviewers.`);
}

/** 360 campaign settings after creation: name, close date, peers, anonymity. */
export async function updateCycleSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const c = await cycleOf(v, str(fd, "cycleId"));
  if (!c) return no("Cycle not found.");
  if (c.status === "COMPLETED" || c.status === "CANCELLED") return no("A finished cycle cannot change.");
  const name = str(fd, "name").slice(0, 80) || c.name;
  const maxPeers = int(fd, "maxPeers") ?? c.maxPeers;
  if (Number.isNaN(maxPeers) || maxPeers < 1 || maxPeers > 10) return { ok: false, message: "Peers: 1–10.", errors: { maxPeers: "1–10" } };
  const closes = day(fd, "reviewClosesAt") ?? c.reviewClosesAt;
  if (closes && closes < c.periodStart) return { ok: false, message: "The review closes after the period starts.", errors: { reviewClosesAt: "Too early" } };
  const anonymous = fd.has("anonymousFeedback") ? bool(fd, "anonymousFeedback") : c.anonymousFeedback;
  // Once feedback has arrived, it cannot be un-anonymised.
  if (c.anonymousFeedback && !anonymous && c.status !== "DRAFT") return no("Feedback was collected anonymously; anonymity cannot be switched off now.");
  await prisma.reviewCycle.update({ where: { id: c.id }, data: { name, maxPeers, reviewClosesAt: closes, anonymousFeedback: anonymous } });
  await audit(v, "UPDATE", "ReviewCycle", c.id, `360 settings of ${name}: ${maxPeers} peers, ${anonymous ? "anonymous" : "named"}, closes ${closes ? closes.toISOString().slice(0, 10) : "—"}`);
  return actionDone([...PERF_PATHS, "/performance/feedback-hub"], "Saved.");
}

export async function saveAnonymityThresholdAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const n = int(fd, "minAnonymousResponses");
  if (n === null || Number.isNaN(n) || n < 1 || n > 10) return { ok: false, message: "1–10 responses.", errors: { minAnonymousResponses: "1–10" } };
  await prisma.feedbackSetting.upsert({ where: { tenantId: v.tenantId }, create: { tenantId: v.tenantId, minAnonymousResponses: n }, update: { minAnonymousResponses: n } });
  await audit(v, "UPDATE", "FeedbackSetting", null, `Anonymous 360 answers show once ${n} have arrived`);
  return actionDone(FB_PATHS, "Saved.");
}

// ---------------------------------------------------------------------------
//  Reopening, calibration notes, exceptions, summaries, reminders
// ---------------------------------------------------------------------------

export async function requestReviewReopenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const r = await prisma.employeeReview.findFirst({ where: { id: str(fd, "reviewId"), cycle: { tenantId: v.tenantId } }, include: { cycle: true, employee: { select: { displayName: true, reportingManagerId: true } } } });
  if (!r) return no("Review not found.");
  const mine = r.employee.reportingManagerId === v.employee?.id;
  if (!mine && !canAny(v, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) return DENIED;
  if (!["CALIBRATED", "SHARED", "ACKNOWLEDGED", "PENDING_CALIBRATION"].includes(r.status) && !r.finalRating) return no("Only a submitted or calibrated review can be reopened.");
  const reason = str(fd, "reason").slice(0, 1000);
  if (reason.length < 5) return { ok: false, message: "Say why it should be reopened.", errors: { reason: "Required" } };
  if (await prisma.insightReviewReopen.findFirst({ where: { tenantId: v.tenantId, reviewId: r.id, status: "PENDING" } })) return no("A reopening request is already waiting.");
  const q = await prisma.insightReviewReopen.create({ data: { tenantId: v.tenantId, reviewId: r.id, cycleId: r.cycleId, employeeId: r.employeeId, reason, previousStatus: r.status, requestedBy: v.user.id } });
  const wf = await startWorkflow({ tenantId: v.tenantId, entityType: "REVIEW_REOPEN", entityId: q.id, title: `Reopen ${r.employee.displayName}'s ${r.cycle.name} review`, details: reason, requesterUserId: v.user.id, subjectEmployeeId: r.employeeId, data: { link: `/performance/reviews/${r.id}` } });
  if (!wf.ok) { await prisma.insightReviewReopen.delete({ where: { id: q.id } }); return no(wf.message); }
  await prisma.insightReviewReopen.update({ where: { id: q.id }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "UPDATE", "EmployeeReview", r.id, `Asked to reopen ${r.employee.displayName}'s review: ${reason.slice(0, 80)}`);
  return actionDone([...PERF_PATHS, `/performance/reviews/${r.id}`], wf.message);
}

export async function addCalibrationNoteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PERFORMANCE_CALIBRATE, P.PERFORMANCE_MANAGE])) return DENIED;
  const c = await prisma.reviewCycle.findFirst({ where: { id: str(fd, "cycleId"), tenantId: v.tenantId } });
  if (!c) return { ok: false, message: "Choose the cycle.", errors: { cycleId: "Required" } };
  const employeeId = optStr(fd, "employeeId");
  if (employeeId && !(await prisma.employeeReview.findFirst({ where: { cycleId: c.id, employeeId } }))) return no("That person has no review in this cycle.");
  const body = str(fd, "body").slice(0, 4000);
  if (body.length < 3) return { ok: false, message: "Write the note.", errors: { body: "Required" } };
  const n = await prisma.insightCalibrationNote.create({ data: { tenantId: v.tenantId, cycleId: c.id, employeeId, body, tags: parseTagList(str(fd, "tags")), authorUserId: v.user.id } });
  await audit(v, "CREATE", "InsightCalibrationNote", n.id, `Calibration note on ${c.name}${employeeId ? " for one review" : ""}`);
  return actionDone(PERF_PATHS, "Note saved.");
}

export async function deleteCalibrationNoteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const n = await prisma.insightCalibrationNote.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!n) return no("Note not found.");
  if (n.authorUserId !== v.user.id && !perfAdmin(v)) return DENIED;
  await prisma.insightCalibrationNote.delete({ where: { id: n.id } });
  await audit(v, "DELETE", "InsightCalibrationNote", n.id, "Calibration note deleted");
  return actionDone(PERF_PATHS, "Deleted.");
}

export async function refreshExceptionsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) return DENIED;
  const c = await prisma.reviewCycle.findFirst({ where: { id: str(fd, "cycleId"), tenantId: v.tenantId } });
  if (!c) return { ok: false, message: "Choose the cycle.", errors: { cycleId: "Required" } };
  const n = await refreshPerfExceptions(v.tenantId, c.id);
  await audit(v, "UPDATE", "InsightPerfException", c.id, `Exception queue of ${c.name} refreshed: ${n} new`);
  return actionDone(PERF_PATHS, `${n} new exception(s).`);
}

export async function resolveExceptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) return DENIED;
  const e = await prisma.insightPerfException.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!e) return no("Exception not found.");
  if (e.status !== "OPEN") return no("Already handled.");
  const status = str(fd, "status") === "DISMISSED" ? "DISMISSED" : "RESOLVED";
  const note = str(fd, "note").slice(0, 1000);
  if (!note) return { ok: false, message: "Note how it was handled.", errors: { note: "Required" } };
  await prisma.insightPerfException.update({ where: { id: e.id }, data: { status, note, resolvedBy: v.user.id, resolvedAt: new Date() } });
  await audit(v, "UPDATE", "InsightPerfException", e.id, `${PERF_EXCEPTION_KINDS[e.kind as keyof typeof PERF_EXCEPTION_KINDS] ?? e.kind} ${status.toLowerCase()}: ${note.slice(0, 80)}`);
  return actionDone(PERF_PATHS, status === "DISMISSED" ? "Dismissed." : "Resolved.");
}

/** Generate the review summary from its facts and keep it as the manager summary. */
export async function generateReviewSummaryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const r = await prisma.employeeReview.findFirst({ where: { id: str(fd, "reviewId"), cycle: { tenantId: v.tenantId } }, include: { band: true, responses: true, cycle: { include: { formSections: { include: { questions: true } } } }, employee: { select: { id: true, displayName: true, reportingManagerId: true } } } });
  if (!r) return no("Review not found.");
  if (r.employee.reportingManagerId !== v.employee?.id && !canAny(v, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) return DENIED;
  const [goals, prev, scale] = await Promise.all([
    prisma.goal.findMany({ where: { tenantId: v.tenantId, employeeId: r.employeeId, countsInReview: true, dueDate: { gte: r.cycle.periodStart }, startDate: { lte: r.cycle.periodEnd }, status: { not: "CANCELLED" } }, select: { status: true, progressPercent: true } }),
    prisma.employeeReview.findFirst({ where: { employeeId: r.employeeId, finalRating: { not: null }, cycle: { tenantId: v.tenantId, periodEnd: { lt: r.cycle.periodStart } } }, orderBy: { cycle: { periodEnd: "desc" } }, select: { finalRating: true } }),
    r.cycle.ratingScaleId ? prisma.insightRatingScale.findFirst({ where: { id: r.cycle.ratingScaleId, tenantId: v.tenantId } }) : null,
  ]);
  const rating = r.finalRating === null ? (r.rawRating === null ? null : Number(r.rawRating)) : Number(r.finalRating);
  const mgr = r.responses.find((x) => x.reviewerType === "MANAGER");
  const qs = r.cycle.formSections.flatMap((s) => s.questions.map((q) => ({ id: q.id, kind: q.kind, weight: q.weight === null ? null : Number(q.weight) })));
  const summary = performanceSummary({
    name: r.employee.displayName ?? "The employee", cycle: r.cycle.name, rating, scaleMax: (r.cycle.ratingScale as { max?: number } | null)?.max ?? 5, band: r.band?.name ?? null,
    ratingLabel: scale ? describeRating(scalePointsOf(scale.points), rating)?.label ?? null : null,
    goalsTotal: goals.length, goalsCompleted: goals.filter((g) => g.status === "COMPLETED" || Number(g.progressPercent) >= 100).length,
    avgGoalProgress: goals.length ? Math.round(goals.reduce((s, g) => s + Number(g.progressPercent), 0) / goals.length) : null,
    strengths: r.responses.map((x) => x.strengths ?? "").filter(Boolean).slice(0, 2), improvements: r.responses.map((x) => x.improvements ?? "").filter(Boolean).slice(0, 2),
    peerCount: r.responses.filter((x) => x.reviewerType === "PEER" && x.submittedAt).length,
    competencyScore: weightedCompetencyScore(qs, (mgr?.answers ?? {}) as Record<string, unknown>), previousRating: prev?.finalRating === null || !prev ? null : Number(prev.finalRating),
  });
  await prisma.employeeReview.update({ where: { id: r.id }, data: { managerSummary: summary } });
  await audit(v, "UPDATE", "EmployeeReview", r.id, `Generated the performance summary of ${r.employee.displayName}'s review`);
  return actionDone([...PERF_PATHS, `/performance/reviews/${r.id}`, "/performance/feedback-hub"], "Summary generated.");
}

/** Run a reminder or alert job now (it also runs nightly). */
export async function runInsightJobAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const job = str(fd, "job");
  let n = 0;
  if (job === "reviews" && perfAdmin(v)) n = await sendReviewReminders(v.tenantId);
  else if (job === "checkins" && can(v, P.GOALS_MANAGE)) n = await sendCheckInAlerts(v.tenantId);
  else if (job === "coaching" && can(v, P.PIP_MANAGE)) n = await sendCoachingReminders(v.tenantId);
  else if (job === "digests" && perfAdmin(v)) n = await sendFeedbackDigests(v.tenantId);
  else return DENIED;
  await audit(v, "UPDATE", "InsightAlert", null, `Ran the ${job} reminders: ${n} sent`);
  return actionDone([...PERF_PATHS, ...OKR_PATHS, ...FB_PATHS, ...PIP_PATHS], `${n} reminder(s) sent.`);
}

// ---------------------------------------------------------------------------
//  OKRs
// ---------------------------------------------------------------------------

export async function saveOkrSettingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.GOALS_MANAGE)) return DENIED;
  const cadence = str(fd, "defaultCadence") in CHECKIN_CADENCES ? str(fd, "defaultCadence") : "MONTHLY";
  const grace = int(fd, "graceDays") ?? 3;
  if (Number.isNaN(grace) || grace < 0 || grace > 30) return { ok: false, message: "Grace: 0–30 days.", errors: { graceDays: "0–30" } };
  const requireApproval = bool(fd, "requireApproval");
  await prisma.insightOkrSetting.upsert({ where: { tenantId: v.tenantId }, create: { tenantId: v.tenantId, requireApproval, defaultCadence: cadence, graceDays: grace }, update: { requireApproval, defaultCadence: cadence, graceDays: grace } });
  await audit(v, "UPDATE", "InsightOkrSetting", null, `OKR settings: approval ${requireApproval ? "on" : "off"}, ${cadence.toLowerCase()} check-ins, ${grace} grace day(s)`);
  return actionDone(OKR_PATHS, "Saved.");
}

async function goalFor(v: Viewer, id: string) {
  const g = await prisma.goal.findFirst({ where: { id, tenantId: v.tenantId } });
  if (!g) return null;
  const may = g.employeeId ? g.employeeId === v.employee?.id || inLine(v, g.employeeId) || (can(v, P.GOALS_MANAGE) && (await reaches(v, g.employeeId, P.GOALS_MANAGE))) : can(v, P.GOALS_MANAGE);
  return { g, may };
}

/** Stretch target and check-in cadence of a goal or key result. */
export async function setGoalPlanAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await goalFor(v, str(fd, "goalId"));
  if (!x) return no("Goal not found.");
  if (!x.may) return DENIED;
  const stretch = num(fd, "stretchValue");
  const sp = stretchProblem(Number(x.g.startValue), Number(x.g.targetValue), stretch);
  if (sp) return { ok: false, message: sp, errors: { stretchValue: sp } };
  const cadence = str(fd, "checkInCadence");
  if (cadence && !(cadence in CHECKIN_CADENCES)) return no("Unknown cadence.");
  await prisma.goal.update({ where: { id: x.g.id }, data: { stretchValue: stretch, checkInCadence: cadence || null } });
  await audit(v, "UPDATE", "Goal", x.g.id, `Goal ${x.g.title.slice(0, 60)}: stretch ${stretch ?? "none"}, ${cadence ? cadence.toLowerCase() : "default"} check-ins`);
  return actionDone(OKR_PATHS, "Saved.");
}


/** A cross-team link (SUPPORTS) or a dependency (DEPENDS_ON) between objectives; dependencies may not loop. */
export async function linkGoalsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const from = await goalFor(v, str(fd, "fromGoalId"));
  if (!from) return { ok: false, message: "Choose the objective.", errors: { fromGoalId: "Required" } };
  if (!from.may) return DENIED;
  const to = await prisma.goal.findFirst({ where: { id: str(fd, "toGoalId"), tenantId: v.tenantId } });
  if (!to) return { ok: false, message: "Choose what it links to.", errors: { toGoalId: "Required" } };
  const kind = str(fd, "kind") === "DEPENDS_ON" ? "DEPENDS_ON" : "SUPPORTS";
  if (to.id === from.g.id) return no("An objective cannot link to itself.");
  if (kind === "DEPENDS_ON") {
    const links = await prisma.insightGoalLink.findMany({ where: { tenantId: v.tenantId, kind: "DEPENDS_ON" }, select: { fromGoalId: true, toGoalId: true } });
    if (dependencyLoop(links.map((l) => ({ from: l.fromGoalId, to: l.toGoalId })), from.g.id, to.id)) return no("That dependency would make a loop.");
  }
  if (await prisma.insightGoalLink.findFirst({ where: { fromGoalId: from.g.id, toGoalId: to.id, kind } })) return no("Already linked.");
  const l = await prisma.insightGoalLink.create({ data: { tenantId: v.tenantId, fromGoalId: from.g.id, toGoalId: to.id, kind, note: optStr(fd, "note"), createdBy: v.user.id } });
  await audit(v, "CREATE", "InsightGoalLink", l.id, `“${from.g.title.slice(0, 50)}” ${kind === "DEPENDS_ON" ? "depends on" : "supports"} “${to.title.slice(0, 50)}”`);
  return actionDone(OKR_PATHS, "Linked.");
}

export async function unlinkGoalsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const l = await prisma.insightGoalLink.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!l) return no("Link not found.");
  const from = await goalFor(v, l.fromGoalId);
  if (!from?.may) return DENIED;
  await prisma.insightGoalLink.delete({ where: { id: l.id } });
  await audit(v, "DELETE", "InsightGoalLink", l.id, "Objective link removed");
  return actionDone(OKR_PATHS, "Removed.");
}

/** At-risk queue: record the review of an at-risk objective and what happens next. */
export async function triageGoalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await goalFor(v, str(fd, "goalId"));
  if (!x) return no("Goal not found.");
  if (!x.may) return DENIED;
  const note = str(fd, "riskNote").slice(0, 1000);
  if (note.length < 3) return { ok: false, message: "Note the plan for this objective.", errors: { riskNote: "Required" } };
  await prisma.goal.update({ where: { id: x.g.id }, data: { riskNote: note, riskReviewedAt: new Date() } });
  await audit(v, "UPDATE", "Goal", x.g.id, `At-risk review of ${x.g.title.slice(0, 60)}: ${note.slice(0, 80)}`);
  if (x.g.employeeId && x.g.employeeId !== v.employee?.id) {
    const e = await prisma.employee.findFirst({ where: { id: x.g.employeeId, tenantId: v.tenantId }, select: { userId: true } });
    await notify({ tenantId: v.tenantId, userIds: [e?.userId], kind: "PERFORMANCE", title: `Your goal “${x.g.title.slice(0, 60)}” was reviewed as at risk`, body: note, link: "/performance/okr?tab=risk" });
  }
  return actionDone(OKR_PATHS, "Reviewed.");
}

/** Close out a timeframe: every goal scored final and snapshotted, after approval. */
export async function requestCloseoutAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.GOALS_MANAGE)) return DENIED;
  const timeframe = str(fd, "timeframe").slice(0, 40);
  if (!timeframe) return { ok: false, message: "Choose the timeframe.", errors: { timeframe: "Required" } };
  const open = await prisma.goal.count({ where: { tenantId: v.tenantId, timeframe, closedOutAt: null } });
  if (!open) return no("No open goals in that timeframe.");
  if (await prisma.insightOkrCloseout.findFirst({ where: { tenantId: v.tenantId, timeframe, status: "PENDING" } })) return no("A close-out of this timeframe is already waiting.");
  const c = await prisma.insightOkrCloseout.create({ data: { tenantId: v.tenantId, timeframe, requestedBy: v.user.id } });
  const wf = await startWorkflow({ tenantId: v.tenantId, entityType: "OKR_CLOSEOUT", entityId: c.id, title: `Close out ${timeframe} OKRs (${open} goals)`, details: optStr(fd, "note"), requesterUserId: v.user.id, subjectEmployeeId: v.employee?.id ?? null, data: { link: "/performance/okr?tab=closeout" } });
  if (!wf.ok) { await prisma.insightOkrCloseout.delete({ where: { id: c.id } }); return no(wf.message); }
  await prisma.insightOkrCloseout.updateMany({ where: { id: c.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "CREATE", "InsightOkrCloseout", c.id, `Close-out of ${timeframe} submitted (${open} goals)`);
  return actionDone(OKR_PATHS, wf.message);
}

export async function snapshotGoalsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.GOALS_MANAGE)) return DENIED;
  const label = str(fd, "label").slice(0, 80) || `Snapshot ${new Date().toISOString().slice(0, 10)}`;
  const timeframe = optStr(fd, "timeframe");
  const n = await snapshotGoals(v.tenantId, label, { status: { not: "CANCELLED" }, ...(timeframe ? { timeframe } : {}) });
  if (!n) return no("No goals to snapshot.");
  await audit(v, "CREATE", "InsightGoalSnapshot", null, `OKR snapshot “${label}”: ${n} goals`);
  return actionDone(OKR_PATHS, `${n} goal(s) snapshotted.`);
}

// ---------------------------------------------------------------------------
//  Continuous feedback
// ---------------------------------------------------------------------------

export async function saveFeedbackTopicAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const name = str(fd, "name").slice(0, 60);
  if (name.length < 2) return { ok: false, message: "Name the topic.", errors: { name: "Required" } };
  const parentId = optStr(fd, "parentId");
  if (parentId && !(await prisma.insightFeedbackTopic.findFirst({ where: { id: parentId, tenantId: v.tenantId } }))) return no("Unknown parent topic.");
  const id = optStr(fd, "id");
  if (id) {
    const t = await prisma.insightFeedbackTopic.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!t) return no("Topic not found.");
    if (parentId === id) return no("A topic cannot sit under itself.");
    await prisma.insightFeedbackTopic.update({ where: { id }, data: { name, description: optStr(fd, "description"), parentId, isActive: fd.has("isActive") ? bool(fd, "isActive") : t.isActive } });
    await audit(v, "UPDATE", "InsightFeedbackTopic", id, `Feedback topic ${name} updated`);
    return actionDone(FB_PATHS, "Saved.");
  }
  if (await prisma.insightFeedbackTopic.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "This topic exists.", errors: { name: "Exists" } };
  const t = await prisma.insightFeedbackTopic.create({ data: { tenantId: v.tenantId, name, description: optStr(fd, "description"), parentId } });
  await audit(v, "CREATE", "InsightFeedbackTopic", t.id, `Feedback topic ${name} added`);
  return actionDone(FB_PATHS, "Topic added.");
}

/** The author edits their feedback within the edit window; it is re-classified. */
export async function editFeedbackAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const f = await prisma.feedback.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId, deletedAt: null } });
  if (!f) return no("Feedback not found.");
  if (f.fromEmployeeId !== v.employee?.id) return no("Only the author can edit feedback.");
  if (!feedbackEditable(f.createdAt)) return no("Feedback can be edited for 48 hours after it is given.");
  const message = str(fd, "message").slice(0, 2000);
  if (!message) return { ok: false, message: "Write the feedback.", errors: { message: "Required" } };
  const topicId = optStr(fd, "topicId");
  if (topicId && !(await prisma.insightFeedbackTopic.findFirst({ where: { id: topicId, tenantId: v.tenantId } }))) return no("Unknown topic.");
  await prisma.feedback.update({ where: { id: f.id }, data: { message, tags: fd.has("tags") ? parseTagList(str(fd, "tags")) : f.tags, topicId: fd.has("topicId") ? topicId : f.topicId, editedAt: new Date() } });
  await processFeedback(v.tenantId, f.id);
  await audit(v, "UPDATE", "Feedback", f.id, f.kind === "INTERNAL_NOTE" ? "Internal note edited" : "Feedback edited by its author");
  return actionDone(FB_PATHS, "Saved.");
}

/** The author (within the window) or HR removes feedback; the record stays for the audit trail. */
export async function deleteFeedbackAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const f = await prisma.feedback.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId, deletedAt: null } });
  if (!f) return no("Feedback not found.");
  const author = f.fromEmployeeId === v.employee?.id;
  const hr = perfAdmin(v) && (await reaches(v, f.aboutEmployeeId, P.PERFORMANCE_MANAGE));
  if (!(author && feedbackEditable(f.createdAt)) && !hr) return no(author ? "Feedback can be deleted for 48 hours after it is given; ask HR after that." : "Only the author or HR can delete feedback.");
  if (hr && !author && str(fd, "reason").length < 3) return { ok: false, message: "Say why it is removed.", errors: { reason: "Required" } };
  await prisma.feedback.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
  await audit(v, "DELETE", "Feedback", f.id, author ? "Feedback withdrawn by its author" : `Feedback removed by HR: ${str(fd, "reason").slice(0, 100)}`);
  return actionDone(FB_PATHS, "Deleted.");
}

/** The requester edits or withdraws a pending feedback request. */
export async function updateFeedbackRequestAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const r = await prisma.feedbackRequest.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId }, include: { asked: { select: { userId: true } } } });
  if (!r) return no("Request not found.");
  if (r.requesterId !== v.employee?.id) return no("Only the person who asked can change the request.");
  if (r.status !== "PENDING") return no("This request has been answered or closed.");
  if (str(fd, "op") === "withdraw") {
    await prisma.feedbackRequest.update({ where: { id: r.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    await notify({ tenantId: v.tenantId, userIds: [r.asked.userId], kind: "FEEDBACK", title: `${v.employee.displayName} withdrew their feedback request`, link: "/me/performance/requests" });
    await audit(v, "UPDATE", "FeedbackRequest", r.id, "Feedback request withdrawn");
    return actionDone(FB_PATHS, "Withdrawn.");
  }
  const due = day(fd, "dueDate");
  if (due && due.getTime() < Date.now() - DAY) return { ok: false, message: "The due date is in the past.", errors: { dueDate: "Past" } };
  await prisma.feedbackRequest.update({ where: { id: r.id }, data: { message: optStr(fd, "message")?.slice(0, 1000) ?? r.message, dueDate: due ?? r.dueDate } });
  await audit(v, "UPDATE", "FeedbackRequest", r.id, `Feedback request edited${due ? `, due ${due.toISOString().slice(0, 10)}` : ""}`);
  return actionDone(FB_PATHS, "Saved.");
}

export async function saveFeedbackRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!perfAdmin(v)) return DENIED;
  const name = str(fd, "name").slice(0, 80);
  if (name.length < 2) return { ok: false, message: "Name the rule.", errors: { name: "Required" } };
  const trigger = ["NEGATIVE", "KEYWORD", "TOPIC"].includes(str(fd, "trigger")) ? str(fd, "trigger") : "";
  if (!trigger) return { ok: false, message: "Choose what triggers it.", errors: { trigger: "Required" } };
  const keyword = optStr(fd, "keyword")?.slice(0, 60) ?? null;
  const topicId = optStr(fd, "topicId");
  if (trigger === "KEYWORD" && !keyword) return { ok: false, message: "Give the keyword.", errors: { keyword: "Required" } };
  if (trigger === "TOPIC" && !(topicId && (await prisma.insightFeedbackTopic.findFirst({ where: { id: topicId, tenantId: v.tenantId } })))) return { ok: false, message: "Choose the topic.", errors: { topicId: "Required" } };
  const notifyWho = ["HR", "MANAGER", "SKIP_MANAGER"].includes(str(fd, "notify")) ? str(fd, "notify") : "HR";
  const id = optStr(fd, "id");
  const data = { name, trigger, keyword: trigger === "KEYWORD" ? keyword : null, topicId: trigger === "TOPIC" ? topicId : null, notify: notifyWho, isActive: fd.has("isActive") ? bool(fd, "isActive") : true };
  if (id) {
    const r = await prisma.insightFeedbackRule.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!r) return no("Rule not found.");
    await prisma.insightFeedbackRule.update({ where: { id }, data });
    await audit(v, "UPDATE", "InsightFeedbackRule", id, `Escalation rule ${name} updated`);
    return actionDone(FB_PATHS, "Saved.");
  }
  if (await prisma.insightFeedbackRule.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "A rule with this name exists.", errors: { name: "Exists" } };
  const r = await prisma.insightFeedbackRule.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  await audit(v, "CREATE", "InsightFeedbackRule", r.id, `Escalation rule ${name} (${trigger.toLowerCase()} → ${notifyWho.toLowerCase()})`);
  return actionDone(FB_PATHS, "Rule saved.");
}

export async function resolveEscalationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const e = await prisma.insightFeedbackEscalation.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!e) return no("Escalation not found.");
  if (!perfAdmin(v) && !e.notifiedUserIds.includes(v.user.id)) return DENIED;
  if (e.status !== "OPEN") return no("Already resolved.");
  const note = str(fd, "note").slice(0, 1000);
  if (note.length < 3) return { ok: false, message: "Note what was done.", errors: { note: "Required" } };
  await prisma.insightFeedbackEscalation.update({ where: { id: e.id }, data: { status: "RESOLVED", resolutionNote: note, resolvedBy: v.user.id, resolvedAt: new Date() } });
  await audit(v, "UPDATE", "InsightFeedbackEscalation", e.id, `Feedback escalation resolved: ${note.slice(0, 80)}`);
  return actionDone(FB_PATHS, "Resolved.");
}

/** A follow-up task on feedback: the subject's manager, HR, or the subject themselves. */
export async function addFollowUpAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const f = await prisma.feedback.findFirst({ where: { id: str(fd, "feedbackId"), tenantId: v.tenantId, deletedAt: null } });
  if (!f) return no("Feedback not found.");
  const allowed = f.aboutEmployeeId === v.employee?.id || inLine(v, f.aboutEmployeeId) || (perfAdmin(v) && (await reaches(v, f.aboutEmployeeId, P.PERFORMANCE_MANAGE)));
  if (!allowed) return DENIED;
  const title = str(fd, "title").slice(0, 200);
  const dueDate = day(fd, "dueDate");
  if (title.length < 3) return { ok: false, message: "Say what will be done.", errors: { title: "Required" } };
  if (!dueDate) return { ok: false, message: "Pick a due date.", errors: { dueDate: "Required" } };
  const owner = optStr(fd, "ownerEmployeeId") ?? f.aboutEmployeeId;
  const emp = await employeeOf(v, owner);
  if (!emp) return no("Unknown owner.");
  const t = await prisma.insightFeedbackFollowUp.create({ data: { tenantId: v.tenantId, feedbackId: f.id, ownerEmployeeId: owner, title, dueDate, createdBy: v.user.id } });
  if (emp.userId && emp.userId !== v.user.id) await notify({ tenantId: v.tenantId, userIds: [emp.userId], kind: "FEEDBACK", title: `Follow-up from feedback: ${title}`, body: `Due ${dueDate.toISOString().slice(0, 10)}`, link: "/performance/feedback-hub?tab=followups" });
  await audit(v, "CREATE", "InsightFeedbackFollowUp", t.id, `Follow-up “${title.slice(0, 60)}” due ${dueDate.toISOString().slice(0, 10)}`);
  return actionDone(FB_PATHS, "Follow-up added.");
}

export async function completeFollowUpAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await prisma.insightFeedbackFollowUp.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!t) return no("Follow-up not found.");
  if (t.ownerEmployeeId !== v.employee?.id && t.createdBy !== v.user.id && !perfAdmin(v)) return DENIED;
  const done = str(fd, "op") !== "reopen";
  await prisma.insightFeedbackFollowUp.update({ where: { id: t.id }, data: { status: done ? "DONE" : "OPEN", doneAt: done ? new Date() : null } });
  await audit(v, "UPDATE", "InsightFeedbackFollowUp", t.id, `Follow-up “${t.title.slice(0, 60)}” ${done ? "done" : "reopened"}`);
  return actionDone(FB_PATHS, done ? "Done." : "Reopened.");
}

// ---------------------------------------------------------------------------
//  PIP & coaching
// ---------------------------------------------------------------------------

export async function savePipSettingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PIP_MANAGE)) return DENIED;
  const minTenureDays = int(fd, "minTenureDays") ?? 90;
  if (Number.isNaN(minTenureDays) || minTenureDays < 0 || minTenureDays > 730) return { ok: false, message: "Tenure: 0–730 days.", errors: { minTenureDays: "0–730" } };
  const maxRating = num(fd, "maxRating");
  const reminder = int(fd, "coachingReminderDays") ?? 14;
  if (Number.isNaN(reminder) || reminder < 3 || reminder > 90) return { ok: false, message: "Coaching reminders: 3–90 days.", errors: { coachingReminderDays: "3–90" } };
  const defaultChecklist = str(fd, "defaultChecklist").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20);
  const data = { minTenureDays, maxRating, blockProbation: bool(fd, "blockProbation"), blockNotice: bool(fd, "blockNotice"), requireChecklist: bool(fd, "requireChecklist"), defaultChecklist, coachingReminderDays: reminder };
  await prisma.insightPipSetting.upsert({ where: { tenantId: v.tenantId }, create: { tenantId: v.tenantId, ...data }, update: data });
  await audit(v, "UPDATE", "InsightPipSetting", null, `PIP rules: ${minTenureDays} days' tenure${maxRating !== null ? `, rating ≤ ${maxRating}` : ""}, ${defaultChecklist.length} checklist item(s)`);
  return actionDone(PIP_PATHS, "Saved.");
}

export async function savePipTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PIP_MANAGE)) return DENIED;
  const kind = str(fd, "kind") === "COACHING" ? "COACHING" : "PIP";
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the template.", errors: { name: "Required" } };
  const durationDays = int(fd, "durationDays") ?? 60;
  if (Number.isNaN(durationDays) || (kind === "PIP" ? durationDays < 30 || durationDays > 180 : durationDays < 7 || durationDays > 365)) return { ok: false, message: kind === "PIP" ? "A plan runs 30–180 days." : "Coaching runs 7–365 days.", errors: { durationDays: "Out of range" } };
  const ms = parseMilestoneLines(str(fd, "milestones"));
  if (!ms.ok) return { ok: false, message: ms.message, errors: { milestones: ms.message } };
  if (ms.milestones.some((m) => m.offsetDays > durationDays)) return { ok: false, message: "A milestone falls after the plan ends.", errors: { milestones: "After the end" } };
  const every = int(fd, "sessionEveryDays");
  const data = {
    kind, name, reason: optStr(fd, "reason"), objectives: optStr(fd, "objectives"), durationDays, milestones: ms.milestones,
    checklist: str(fd, "checklist").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20), sessionEveryDays: every !== null && !Number.isNaN(every) ? every : null,
    isActive: fd.has("isActive") ? bool(fd, "isActive") : true,
  };
  const id = optStr(fd, "id");
  if (id) {
    const t = await prisma.insightPipTemplate.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!t) return no("Template not found.");
    await prisma.insightPipTemplate.update({ where: { id }, data });
    await audit(v, "UPDATE", "InsightPipTemplate", id, `${kind === "PIP" ? "PIP" : "Coaching"} template ${name} updated`);
    return actionDone(PIP_PATHS, "Saved.");
  }
  if (await prisma.insightPipTemplate.findFirst({ where: { tenantId: v.tenantId, kind, name } })) return { ok: false, message: "A template with this name exists.", errors: { name: "Exists" } };
  const t = await prisma.insightPipTemplate.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  await audit(v, "CREATE", "InsightPipTemplate", t.id, `${kind === "PIP" ? "PIP" : "Coaching"} template ${name} created`);
  return actionDone(PIP_PATHS, "Template saved.");
}

/** Start an improvement plan from a template: eligibility, milestones, objectives and checklist come with it. */
export async function startPipFromTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PIP_MANAGE)) return DENIED;
  const t = await prisma.insightPipTemplate.findFirst({ where: { id: str(fd, "templateId"), tenantId: v.tenantId, kind: "PIP", isActive: true } });
  if (!t) return { ok: false, message: "Choose a template.", errors: { templateId: "Required" } };
  const employeeId = str(fd, "employeeId");
  const emp = await employeeOf(v, employeeId);
  if (!emp || !(await reaches(v, employeeId, P.PIP_MANAGE))) return { ok: false, message: "Choose someone in your scope.", errors: { employeeId: "Out of scope" } };
  if (employeeId === v.employee?.id) return no("You cannot place yourself on a plan.");
  if (await prisma.improvementPlan.count({ where: { tenantId: v.tenantId, employeeId, status: "ACTIVE" } })) return no("There is already an active plan for this employee.");
  const why = await pipEligibilityProblems(v.tenantId, employeeId);
  if (why.length) return no(`Not eligible for a plan: ${why.join(" ")}`);
  const startDate = day(fd, "startDate") ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const endDate = new Date(startDate.getTime() + t.durationDays * DAY);
  const reason = str(fd, "reason") || t.reason || "";
  if (reason.length < 3) return { ok: false, message: "Give the reason for the plan.", errors: { reason: "Required" } };
  const objectivesText = t.objectives ?? "";
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: v.tenantId }, select: { reportingManagerId: true, userId: true, displayName: true } });
  const pip = await prisma.improvementPlan.create({ data: { tenantId: v.tenantId, employeeId, reason, objectives: objectivesText || "See the objectives on the plan.", startDate, endDate, managerId: e?.reportingManagerId ?? null, createdBy: v.user.id } });
  const ms = milestonesFromTemplate(t.milestones, startDate, endDate);
  if (ms.length) await prisma.pipMilestone.createMany({ data: ms.map((m) => ({ pipId: pip.id, title: m.title, dueDate: m.dueDate })) });
  const objLines = objectivesText.split(/\r?\n/).map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 10);
  if (objLines.length) await prisma.insightPipObjective.createMany({ data: objLines.map((title) => ({ tenantId: v.tenantId, pipId: pip.id, title: title.slice(0, 200) })) });
  await seedPipChecklist(v.tenantId, pip.id, t.checklist);
  await notify({ tenantId: v.tenantId, userIds: [e?.userId], kind: "PERFORMANCE", title: "A performance improvement plan has been set up with you", body: `It runs until ${endDate.toISOString().slice(0, 10)}.`, link: "/performance/plans" });
  await audit(v, "CREATE", "ImprovementPlan", pip.id, `Started an improvement plan for ${e?.displayName} from template ${t.name}`);
  return { ...actionDone(PIP_PATHS, "Plan started from the template."), values: { pipId: pip.id } };
}

/** Coaching from a template: the coachee accepts or declines as usual. */
export async function startCoachingFromTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const t = await prisma.insightPipTemplate.findFirst({ where: { id: str(fd, "templateId"), tenantId: v.tenantId, kind: "COACHING", isActive: true } });
  if (!t) return { ok: false, message: "Choose a template.", errors: { templateId: "Required" } };
  const employeeId = str(fd, "employeeId");
  const hr = await reaches(v, employeeId, P.PIP_MANAGE);
  if (!inLine(v, employeeId) && !hr) return no("You can coach people in your team; HR can pair anyone.");
  const coachId = optStr(fd, "coachId") ?? v.employee?.id ?? "";
  if (coachId !== v.employee?.id && !hr) return no("Only HR can name someone else as the coach.");
  if (coachId === employeeId) return no("Someone cannot coach themselves.");
  const [emp, coach] = await Promise.all([employeeOf(v, employeeId), employeeOf(v, coachId)]);
  if (!emp || !coach) return no("Employee or coach not found.");
  const startDate = day(fd, "startDate") ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const endDate = new Date(startDate.getTime() + t.durationDays * DAY);
  const c = await prisma.coachingPlan.create({ data: { tenantId: v.tenantId, employeeId, coachId, focusArea: t.name, goals: t.objectives ?? t.reason ?? t.name, startDate, endDate, createdBy: v.user.id } });
  await notify({ tenantId: v.tenantId, userIds: [emp.userId], kind: "PERFORMANCE", title: `${coach.displayName} proposes coaching: ${t.name}`, body: "Accept or decline the plan.", link: "/me/career?tab=development" });
  await audit(v, "CREATE", "CoachingPlan", c.id, `Proposed coaching “${t.name}” (template) for ${emp.displayName} with ${coach.displayName}`);
  return actionDone(PIP_PATHS, "Proposed — the coachee will accept or decline.");
}

async function managedPip(v: Viewer, id: string) {
  const pip = await prisma.improvementPlan.findFirst({ where: { id, tenantId: v.tenantId }, include: { employee: { select: { userId: true, displayName: true } } } });
  if (!pip) return null;
  const manages = can(v, P.PIP_MANAGE) && (await reaches(v, pip.employeeId, P.PIP_MANAGE));
  const manager = pip.managerId === v.employee?.id || inLine(v, pip.employeeId);
  return { pip, manages, manager };
}
const pipPaths = (id: string) => [...PIP_PATHS, `/performance/plans/${id}`];

export async function savePipObjectiveAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const id = optStr(fd, "id");
  if (id) {
    const o = await prisma.insightPipObjective.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!o) return no("Objective not found.");
    const x = await managedPip(v, o.pipId);
    if (!x || !(x.manages || x.manager)) return DENIED;
    const status = ["OPEN", "MET", "NOT_MET"].includes(str(fd, "status")) ? str(fd, "status") : o.status;
    await prisma.insightPipObjective.update({ where: { id }, data: { status, note: optStr(fd, "note") ?? o.note, ...(str(fd, "title") ? { title: str(fd, "title").slice(0, 200), measure: optStr(fd, "measure"), target: optStr(fd, "target") } : {}) } });
    await audit(v, "UPDATE", "InsightPipObjective", id, `Objective “${o.title.slice(0, 60)}” ${status === o.status ? "edited" : `assessed ${status.toLowerCase().replace("_", " ")}`}`);
    return actionDone(pipPaths(o.pipId), "Saved.");
  }
  const x = await managedPip(v, str(fd, "pipId"));
  if (!x || !(x.manages || x.manager)) return DENIED;
  if (x.pip.status !== "ACTIVE") return no("Only an active plan takes objectives.");
  const title = str(fd, "title").slice(0, 200);
  if (title.length < 3) return { ok: false, message: "Describe the objective.", errors: { title: "Required" } };
  const weight = int(fd, "weight") ?? 1;
  const o = await prisma.insightPipObjective.create({ data: { tenantId: v.tenantId, pipId: x.pip.id, title, measure: optStr(fd, "measure"), target: optStr(fd, "target"), weight: Number.isNaN(weight) ? 1 : Math.max(1, Math.min(10, weight)) } });
  await audit(v, "CREATE", "InsightPipObjective", o.id, `Objective “${title.slice(0, 60)}” added to ${x.pip.employee.displayName}'s plan`);
  return actionDone(pipPaths(x.pip.id), "Objective added.");
}

export async function addPipEvidenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await managedPip(v, str(fd, "pipId"));
  if (!x || !(x.manages || x.manager)) return DENIED;
  const title = str(fd, "title").slice(0, 200);
  if (title.length < 2) return { ok: false, message: "Name the evidence.", errors: { title: "Required" } };
  const up = await readUpload(fd, "file");
  if (up && "error" in up) return { ok: false, message: up.error, errors: { file: up.error } };
  const stored = up ? await saveFile({ tenantId: v.tenantId, filename: up.name, mimeType: up.type, data: up.data, relatedType: "PipEvidence", relatedId: x.pip.id, employeeId: x.pip.employeeId, uploadedBy: v.user.id }) : null;
  const note = optStr(fd, "note");
  if (!stored && !note) return { ok: false, message: "Attach a file or describe the evidence.", errors: { file: "File or note" } };
  const kind = ["DOCUMENT", "OBSERVATION", "EMAIL", "METRIC"].includes(str(fd, "kind")) ? str(fd, "kind") : stored ? "DOCUMENT" : "OBSERVATION";
  const e = await prisma.insightPipEvidence.create({ data: { tenantId: v.tenantId, pipId: x.pip.id, title, note, kind, fileId: stored?.id ?? null, addedBy: v.user.id } });
  await audit(v, "CREATE", "InsightPipEvidence", e.id, `Evidence “${title.slice(0, 60)}” added to ${x.pip.employee.displayName}'s plan${stored ? ` (SHA-256 ${stored.sha256.slice(0, 12)})` : ""}`);
  return actionDone(pipPaths(x.pip.id), "Evidence added.");
}

export async function checklistItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const op = str(fd, "op");
  if (op === "add") {
    const x = await managedPip(v, str(fd, "pipId"));
    if (!x?.manages) return DENIED;
    const label = str(fd, "label").slice(0, 200);
    if (label.length < 2) return { ok: false, message: "Describe the step.", errors: { label: "Required" } };
    const count = await prisma.insightPipChecklistItem.count({ where: { tenantId: v.tenantId, pipId: x.pip.id } });
    const i = await prisma.insightPipChecklistItem.create({ data: { tenantId: v.tenantId, pipId: x.pip.id, label, required: !bool(fd, "optional"), position: count } });
    await audit(v, "CREATE", "InsightPipChecklistItem", i.id, `Checklist step “${label.slice(0, 60)}” added`);
    return actionDone(pipPaths(x.pip.id), "Added.");
  }
  const i = await prisma.insightPipChecklistItem.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!i) return no("Step not found.");
  const x = await managedPip(v, i.pipId);
  if (!x?.manages) return DENIED;
  const done = op !== "undo";
  await prisma.insightPipChecklistItem.update({ where: { id: i.id }, data: done ? { doneAt: new Date(), doneBy: v.user.id, note: optStr(fd, "note") } : { doneAt: null, doneBy: null } });
  await audit(v, "UPDATE", "InsightPipChecklistItem", i.id, `Checklist step “${i.label.slice(0, 60)}” ${done ? "done" : "undone"}`);
  return actionDone(pipPaths(i.pipId), done ? "Done." : "Undone.");
}

/** Observed behaviour, 1–5, on a plan or a coaching plan. */
export async function logBehaviourAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const pipId = optStr(fd, "pipId"), coachingPlanId = optStr(fd, "coachingPlanId");
  let employeeId: string | null = null;
  if (pipId) {
    const x = await managedPip(v, pipId);
    if (!x || !(x.manages || x.manager)) return DENIED;
    employeeId = x.pip.employeeId;
  } else if (coachingPlanId) {
    const c = await prisma.coachingPlan.findFirst({ where: { id: coachingPlanId, tenantId: v.tenantId } });
    if (!c) return no("Coaching plan not found.");
    if (c.coachId !== v.employee?.id && !(await reaches(v, c.employeeId, P.PIP_MANAGE))) return DENIED;
    employeeId = c.employeeId;
  } else return no("Choose the plan.");
  const behaviour = str(fd, "behaviour").slice(0, 120);
  const rating = int(fd, "rating");
  if (behaviour.length < 2) return { ok: false, message: "Name the behaviour.", errors: { behaviour: "Required" } };
  if (rating === null || Number.isNaN(rating) || rating < 1 || rating > 5) return { ok: false, message: "Rate 1–5.", errors: { rating: "1–5" } };
  const observedOn = day(fd, "observedOn") ?? new Date();
  const l = await prisma.insightBehaviorLog.create({ data: { tenantId: v.tenantId, employeeId: employeeId!, pipId, coachingPlanId, behaviour, rating, note: optStr(fd, "note"), observedOn, observedBy: v.user.id } });
  await audit(v, "CREATE", "InsightBehaviorLog", l.id, `Behaviour “${behaviour}” observed at ${rating}/5`);
  return actionDone(pipId ? pipPaths(pipId) : PIP_PATHS, "Recorded.");
}

/** Ask for an extension, an escalation, or HR sign-off of a check-in. */
export async function requestPipChangeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await managedPip(v, str(fd, "pipId"));
  if (!x || !(x.manages || x.manager)) return DENIED;
  if (x.pip.status !== "ACTIVE") return no("Only an active plan.");
  const kind = ["EXTENSION", "ESCALATION", "CHECKIN_SIGNOFF"].includes(str(fd, "kind")) ? str(fd, "kind") : "";
  if (!kind) return { ok: false, message: "Choose the request.", errors: { kind: "Required" } };
  const reason = str(fd, "reason").slice(0, 1000);
  if (reason.length < 5) return { ok: false, message: "Give the reason.", errors: { reason: "Required" } };
  let days: number | null = null, checkInId: string | null = null;
  if (kind === "EXTENSION") {
    days = int(fd, "days");
    const ep = extensionProblem(x.pip, days ?? 0);
    if (ep) return { ok: false, message: ep, errors: { days: ep } };
  }
  if (kind === "CHECKIN_SIGNOFF") {
    const c = await prisma.pipCheckIn.findFirst({ where: { id: str(fd, "checkInId"), pipId: x.pip.id } });
    if (!c) return { ok: false, message: "Choose the check-in.", errors: { checkInId: "Required" } };
    if (c.signoffStatus === "APPROVED" || c.signoffStatus === "PENDING") return no("That check-in is signed off or waiting.");
    checkInId = c.id;
  }
  if (await prisma.insightPipRequest.findFirst({ where: { tenantId: v.tenantId, pipId: x.pip.id, kind, status: "PENDING" } })) return no("A request of this kind is already waiting.");
  const q = await prisma.insightPipRequest.create({ data: { tenantId: v.tenantId, pipId: x.pip.id, kind, days, checkInId, reason, requestedBy: v.user.id } });
  if (checkInId) await prisma.pipCheckIn.update({ where: { id: checkInId }, data: { signoffStatus: "PENDING" } });
  const label = kind === "EXTENSION" ? `Extend ${x.pip.employee.displayName}'s plan by ${days} days` : kind === "ESCALATION" ? `Escalate ${x.pip.employee.displayName}'s improvement plan` : `Sign off a check-in on ${x.pip.employee.displayName}'s plan`;
  const wf = await startWorkflow({ tenantId: v.tenantId, entityType: "PIP_REQUEST", entityId: q.id, title: label, details: reason, requesterUserId: v.user.id, subjectEmployeeId: x.pip.employeeId, changeKind: kind, data: { link: `/performance/plans/${x.pip.id}` } });
  if (!wf.ok) {
    await prisma.insightPipRequest.delete({ where: { id: q.id } });
    if (checkInId) await prisma.pipCheckIn.update({ where: { id: checkInId }, data: { signoffStatus: null } });
    return no(wf.message);
  }
  await prisma.insightPipRequest.updateMany({ where: { id: q.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "CREATE", "InsightPipRequest", q.id, `${label}: ${reason.slice(0, 80)}`);
  return actionDone(pipPaths(x.pip.id), wf.message);
}

/** Amend a proposed outcome (its proposer) or the record of a closed plan's outcome (PIP managers). */
export async function editPipOutcomeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await managedPip(v, str(fd, "pipId"));
  if (!x?.manages) return DENIED;
  const note = str(fd, "note").slice(0, 2000);
  if (note.length < 3) return { ok: false, message: "Write the outcome note.", errors: { note: "Required" } };
  if (x.pip.proposedOutcome) {
    if (x.pip.proposedBy !== v.user.id) return no("Only the person who proposed the outcome can amend it before sign-off.");
    await prisma.improvementPlan.update({ where: { id: x.pip.id }, data: { proposedNote: note, proposedAt: new Date() } });
    await audit(v, "UPDATE", "ImprovementPlan", x.pip.id, `Amended the proposed ${x.pip.proposedOutcome.toLowerCase()} outcome for ${x.pip.employee.displayName}`);
    return actionDone(pipPaths(x.pip.id), "Proposal amended.");
  }
  if (x.pip.status !== "CLOSED") return no("There is no outcome to amend yet.");
  const reason = str(fd, "reason").slice(0, 500);
  if (reason.length < 3) return { ok: false, message: "Say why the record changes.", errors: { reason: "Required" } };
  await prisma.improvementPlan.update({ where: { id: x.pip.id }, data: { outcomeNote: note } });
  await audit(v, "UPDATE", "ImprovementPlan", x.pip.id, `Amended the ${String(x.pip.outcome).toLowerCase()} outcome record for ${x.pip.employee.displayName}: ${reason}`);
  return actionDone(pipPaths(x.pip.id), "Outcome record amended.");
}
