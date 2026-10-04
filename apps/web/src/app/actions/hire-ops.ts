"use server";

import { prisma, Prisma } from "@keka/db";
import {
  startHireRequest, runHireAlerts, mergeBlocker, balanceAssignments, usersWithPermission, notify, intakeQuestionsFrom, hireDepthConfig,
  rejectApplication, sendJobAlerts,
} from "@keka/services";
import { requireViewer, requireAuth, can, canAny } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload } from "@/lib/storage";
import { HP, requireAnyOf, str, fail, numField, dateOf, tenantUser, gatedStageMove, closeAsWithdrawn } from "@/lib/hire-depth";

/**
 * Hire depth — ATS operations: recruiter tasks and their sign-off, SLA and
 * intake settings, requisition intake, stage editing and entry criteria,
 * dispositions and withdrawals, ownership transfer and workload balancing,
 * candidate merges, communications, documents, referrals and job postings.
 */

const TASK_QUEUES = ["SOURCING", "SCREENING", "SCHEDULING", "FEEDBACK", "OFFER", "OUTREACH", "OTHER"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"];
const TASK_PATHS = ["/hiring/tasks"];

// ---------------------------------------------------------------------------
//  Recruiter tasks
// ---------------------------------------------------------------------------

export async function createTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const title = str(f, "title", 160);
  if (title.length < 3) return fail("Give the task a title.", f, { title: "Required" });
  const assignee = str(f, "assigneeUserId") || viewer.user.id;
  if (!(await tenantUser(viewer, assignee))) return fail("Assignee not found.", f, { assigneeUserId: "Not found" });
  const applicationId = str(f, "applicationId") || null, candidateId = str(f, "candidateId") || null, campaignId = str(f, "campaignId") || null;
  if (applicationId && !(await prisma.application.count({ where: { id: applicationId, tenantId: viewer.tenantId } }))) return fail("Application not found.", f);
  if (candidateId && !(await prisma.candidate.count({ where: { id: candidateId, tenantId: viewer.tenantId } }))) return fail("Candidate not found.", f);
  if (campaignId && !(await prisma.sourcingCampaign.count({ where: { id: campaignId, tenantId: viewer.tenantId } }))) return fail("Campaign not found.", f);
  const t = await prisma.recruiterTask.create({
    data: {
      tenantId: viewer.tenantId, title, details: str(f, "details", 2000) || null, queue: TASK_QUEUES.includes(str(f, "queue")) ? str(f, "queue") : "OTHER",
      priority: PRIORITIES.includes(str(f, "priority")) ? str(f, "priority") : "MEDIUM", assigneeUserId: assignee, createdBy: viewer.user.id, dueAt: dateOf(f, "dueAt"),
      requiresSignOff: f.get("requiresSignOff") === "on", applicationId, candidateId, campaignId,
    },
  });
  if (assignee !== viewer.user.id) await notify({ tenantId: viewer.tenantId, userIds: [assignee], kind: "HIRING", title: `New recruiting task: ${title}`, link: "/hiring/tasks" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "RecruiterTask", entityId: t.id, summary: `Created task “${title}” (${t.queue.toLowerCase()})` });
  return done(TASK_PATHS, "Task added.");
}

async function taskFor(viewerTenant: string, id: string) {
  return prisma.recruiterTask.findFirst({ where: { id, tenantId: viewerTenant } });
}

export async function updateTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await taskFor(viewer.tenantId, str(f, "id"));
  if (!t) return fail("Task not found.");
  const manager = can(viewer, HP.CANDIDATE_MANAGE);
  if (!manager && t.assigneeUserId !== viewer.user.id) return fail("Only the assignee or a recruiter can change this task.");
  if (t.status === "DONE" || t.status === "PENDING_APPROVAL") return fail("A completed task cannot be edited.");
  const data: Prisma.RecruiterTaskUpdateInput = {};
  const changes: string[] = [];
  if (f.has("title")) { const v = str(f, "title", 160); if (v.length < 3) return fail("Give the task a title.", f, { title: "Required" }); if (v !== t.title) { data.title = v; changes.push("title"); } }
  if (f.has("priority") && PRIORITIES.includes(str(f, "priority")) && str(f, "priority") !== t.priority) { data.priority = str(f, "priority"); changes.push("priority"); }
  if (f.has("queue") && TASK_QUEUES.includes(str(f, "queue")) && str(f, "queue") !== t.queue) { data.queue = str(f, "queue"); changes.push("queue"); }
  if (f.has("dueAt")) { data.dueAt = dateOf(f, "dueAt"); changes.push("due date"); }
  if (f.has("assigneeUserId") && manager) {
    const a = str(f, "assigneeUserId");
    if (a && a !== t.assigneeUserId) {
      if (!(await tenantUser(viewer, a))) return fail("Assignee not found.");
      data.assigneeUserId = a; changes.push("assignee");
      await notify({ tenantId: viewer.tenantId, userIds: [a], kind: "HIRING", title: `Recruiting task assigned to you: ${t.title}`, link: "/hiring/tasks" });
    }
  }
  if (str(f, "status") === "CANCELLED") { data.status = "CANCELLED"; changes.push("cancelled"); }
  if (!changes.length) return fail("Nothing changed.");
  await prisma.recruiterTask.update({ where: { id: t.id }, data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecruiterTask", entityId: t.id, summary: `Task “${t.title}”: ${changes.join(", ")}` });
  return done(TASK_PATHS, "Task updated.");
}

/** Complete a task; one that needs sign-off goes to its creator (or a recruiter lead) to approve. */
export async function completeTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await taskFor(viewer.tenantId, str(f, "id"));
  if (!t) return fail("Task not found.");
  if (!can(viewer, HP.CANDIDATE_MANAGE) && t.assigneeUserId !== viewer.user.id) return fail("Only the assignee or a recruiter can complete this task.");
  if (t.status !== "OPEN") return fail(`This task is ${t.status.toLowerCase().replace("_", " ")}.`);
  const outcome = str(f, "outcome", 1000) || null;
  if (t.requiresSignOff) {
    await prisma.recruiterTask.update({ where: { id: t.id }, data: { status: "PENDING_APPROVAL", completedBy: viewer.user.id, outcome } });
    const reviewer = t.createdBy && t.createdBy !== viewer.user.id ? t.createdBy : null;
    const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "TASK_SIGNOFF", entityId: t.id, title: `Sign off task: ${t.title}`, details: outcome, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null, reviewerUserId: reviewer });
    if (!r.ok) { await prisma.recruiterTask.update({ where: { id: t.id }, data: { status: "OPEN" } }); return fail(r.message); }
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecruiterTask", entityId: t.id, summary: `Task “${t.title}” sent for sign-off` });
    return done(TASK_PATHS, r.status === "PENDING" ? "Sent for sign-off." : "Signed off.");
  }
  await prisma.recruiterTask.update({ where: { id: t.id }, data: { status: "DONE", completedAt: new Date(), completedBy: viewer.user.id, outcome } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecruiterTask", entityId: t.id, summary: `Completed task “${t.title}”` });
  return done(TASK_PATHS, "Task completed.");
}

// ---------------------------------------------------------------------------
//  Settings: SLAs, intake, aging, posting approval, checklist, bias terms
// ---------------------------------------------------------------------------

export async function saveHireOpsSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const ints: Record<string, [number, number]> = {
    screenSlaHours: [1, 2160], feedbackSlaHours: [1, 720], offerResponseSlaHours: [1, 2160], requisitionApprovalSlaHours: [1, 2160], requisitionMaxAgeDays: [1, 730],
    noShowLimit: [1, 10], consentValidityDays: [30, 3650], reactivationAfterDays: [7, 1095],
  };
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [k, [min, max]] of Object.entries(ints)) {
    const n = numField(f, k);
    if (n === null) continue;
    if (!Number.isInteger(n) || n < min || n > max) errors[k] = `${min}–${max}`; else data[k] = n;
  }
  if (Object.keys(errors).length) return fail("Please correct the highlighted fields.", f, errors);
  data.requirePostingApproval = f.get("requirePostingApproval") === "on";
  data.intakeQuestions = intakeQuestionsFrom(str(f, "intakeQuestions", 6000));
  data.offerChecklist = intakeQuestionsFrom(str(f, "offerChecklist", 4000));
  data.biasTerms = str(f, "biasTerms", 2000).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 50);
  await prisma.hireDepthSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HireDepthSetting", summary: "Updated hiring SLAs, intake and controls", newValue: data });
  return done(["/hiring/settings/ops"], "Hiring operations settings saved.");
}

export async function saveDispositionReasonAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const label = str(f, "label", 120);
  const kind = str(f, "kind") === "WITHDRAW" ? "WITHDRAW" : "REJECT";
  if (label.length < 2) return fail("Name the reason.", f, { label: "Required" });
  if (await prisma.dispositionReason.count({ where: { tenantId: viewer.tenantId, kind, label } })) return fail("That reason exists.", f, { label: "Taken" });
  const order = await prisma.dispositionReason.count({ where: { tenantId: viewer.tenantId, kind } });
  const r = await prisma.dispositionReason.create({ data: { tenantId: viewer.tenantId, label, kind, sortOrder: order } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "DispositionReason", entityId: r.id, summary: `Added ${kind.toLowerCase()} reason “${label}”` });
  return done(["/hiring/settings/ops"], "Reason added.");
}

export async function toggleDispositionReasonAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const r = await prisma.dispositionReason.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return fail("Reason not found.");
  await prisma.dispositionReason.update({ where: { id: r.id }, data: { isActive: !r.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "DispositionReason", entityId: r.id, summary: `${r.isActive ? "Retired" : "Restored"} reason “${r.label}”` });
  return done(["/hiring/settings/ops"], r.isActive ? "Retired." : "Restored.");
}

export async function runHireAlertsAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const out = await runHireAlerts(viewer.tenantId);
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HireAlert", summary: `Ran hiring alerts: ${total} raised`, newValue: out });
  return done(["/hiring/exceptions", "/hiring/tasks"], total ? `Raised ${total} alert(s): ${Object.entries(out).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ")}.` : "Nothing new to alert on.");
}

export async function resolveHireAlertAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const u = await prisma.hireAlert.updateMany({ where: { id: str(f, "id"), tenantId: viewer.tenantId, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (!u.count) return fail("Alert not found.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HireAlert", entityId: str(f, "id"), summary: "Resolved a hiring alert" });
  return done(["/hiring/exceptions"], "Resolved.");
}

// ---------------------------------------------------------------------------
//  Requisition intake questionnaire
// ---------------------------------------------------------------------------

export async function saveRequisitionIntakeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.requisition.findFirst({ where: { id: str(f, "requisitionId"), tenantId: viewer.tenantId } });
  if (!r) return fail("Requisition not found.");
  if (!canAny(viewer, [HP.REQUISITION_MANAGE, HP.REQUISITION_APPROVE]) && r.raisedBy !== viewer.user.id) return fail("Only the requester or the hiring team can answer the intake.");
  const questions = (await hireDepthConfig(viewer.tenantId)).intakeQuestions;
  if (!questions.length) return fail("No intake questions are set up in Hire › Settings › Operations.");
  const answers = questions.map((q, i) => ({ question: q, answer: str(f, `a_${i}`, 2000) }));
  const missing = answers.findIndex((a) => !a.answer);
  if (missing >= 0) return fail("Answer every intake question.", f, { [`a_${missing}`]: "Required" });
  await prisma.requisitionIntake.upsert({ where: { requisitionId: r.id }, create: { tenantId: viewer.tenantId, requisitionId: r.id, answers, submittedBy: viewer.user.id }, update: { answers, submittedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Requisition", entityId: r.id, summary: `Intake questionnaire answered (${answers.length} questions)` });
  return done([`/hiring/requisitions/${r.id}/intake`, "/hiring/requisitions"], "Intake saved.");
}

// ---------------------------------------------------------------------------
//  Stages: edit, reorder, add, delete, criteria; gated moves
// ---------------------------------------------------------------------------

const STAGE_KINDS = ["SOURCED", "SCREENING", "ASSESSMENT", "INTERVIEW", "OFFER", "PREBOARDING", "HIRED", "REJECTED"];

async function stageOf(tenantId: string, id: string) {
  return prisma.hiringStage.findFirst({ where: { id, flow: { tenantId } }, include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } });
}

export async function saveStageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const st = await stageOf(viewer.tenantId, str(f, "stageId"));
  if (!st) return fail("Stage not found.");
  const name = str(f, "name", 80);
  if (!name) return fail("Name the stage.", f, { name: "Required" });
  if (st.flow.stages.some((x) => x.id !== st.id && x.name.toLowerCase() === name.toLowerCase())) return fail("Another stage in this flow has that name.", f, { name: "Taken" });
  const stale = numField(f, "staleAfterDays"), minScore = numField(f, "entryMinScore");
  if (stale !== null && (!Number.isInteger(stale) || stale < 1 || stale > 365)) return fail("Days in stage is 1–365.", f, { staleAfterDays: "1–365" });
  if (minScore !== null && (!Number.isFinite(minScore) || minScore < 1 || minScore > 5)) return fail("The minimum score is 1–5.", f, { entryMinScore: "1–5" });
  const data = {
    name, stageKind: STAGE_KINDS.includes(str(f, "stageKind")) ? str(f, "stageKind") : st.stageKind, requireScorecard: f.get("requireScorecard") === "on",
    staleAfterDays: stale, entryMinScore: minScore, entryRequiresResume: f.get("entryRequiresResume") === "on", entryRequiresApproval: f.get("entryRequiresApproval") === "on",
  };
  await prisma.hiringStage.update({ where: { id: st.id }, data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HiringStage", entityId: st.id, summary: `Edited stage ${st.name} in ${st.flow.name}`, oldValue: { name: st.name, requireScorecard: st.requireScorecard, staleAfterDays: st.staleAfterDays, entryRequiresApproval: st.entryRequiresApproval }, newValue: data });
  return done(["/hiring/settings/stages", "/hiring/settings"], "Stage saved.");
}

export async function addStageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const flow = await prisma.hiringFlow.findFirst({ where: { id: str(f, "flowId"), tenantId: viewer.tenantId }, include: { stages: { orderBy: { sequence: "asc" } } } });
  if (!flow) return fail("Flow not found.");
  const name = str(f, "name", 80);
  if (!name) return fail("Name the stage.", f, { name: "Required" });
  if (flow.stages.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail("This flow already has that stage.", f, { name: "Taken" });
  const after = numField(f, "afterSequence") ?? flow.stages.at(-1)?.sequence ?? 0;
  // Shift later stages up by one, highest first, so (flow, sequence) stays unique throughout.
  await prisma.$transaction(async (tx) => {
    for (const s of [...flow.stages].reverse()) if (s.sequence > after) await tx.hiringStage.update({ where: { id: s.id }, data: { sequence: s.sequence + 1 } });
    await tx.hiringStage.create({ data: { flowId: flow.id, name, sequence: after + 1, stageKind: STAGE_KINDS.includes(str(f, "stageKind")) ? str(f, "stageKind") : "INTERVIEW" } });
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "HiringStage", entityId: flow.id, summary: `Added stage ${name} to ${flow.name}` });
  return done(["/hiring/settings/stages"], `Added ${name}.`);
}

export async function reorderStageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const st = await stageOf(viewer.tenantId, str(f, "stageId"));
  if (!st) return fail("Stage not found.");
  const list = st.flow.stages;
  const i = list.findIndex((x) => x.id === st.id);
  const j = str(f, "dir") === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return fail("It is already at that end.");
  const other = list[j]!;
  await prisma.$transaction([
    prisma.hiringStage.update({ where: { id: st.id }, data: { sequence: -1 } }),
    prisma.hiringStage.update({ where: { id: other.id }, data: { sequence: st.sequence } }),
    prisma.hiringStage.update({ where: { id: st.id }, data: { sequence: other.sequence } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HiringStage", entityId: st.id, summary: `Moved ${st.name} ${str(f, "dir") === "up" ? "before" : "after"} ${other.name} in ${st.flow.name}` });
  return done(["/hiring/settings/stages"], "Order saved.");
}

export async function deleteStageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const st = await stageOf(viewer.tenantId, str(f, "stageId"));
  if (!st) return fail("Stage not found.");
  if (st.flow.stages.length <= 2) return fail("A flow needs at least two stages.");
  const used = await prisma.applicationStageHistory.count({ where: { stageId: st.id } });
  if (used) return fail(`${used} candidate move(s) went through ${st.name}; it cannot be deleted. Rename it instead.`);
  await prisma.hiringStage.delete({ where: { id: st.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "HiringStage", entityId: st.id, summary: `Deleted stage ${st.name} from ${st.flow.name}` });
  return done(["/hiring/settings/stages"], `Deleted ${st.name}.`);
}

export async function setDefaultFlowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const flow = await prisma.hiringFlow.findFirst({ where: { id: str(f, "flowId"), tenantId: viewer.tenantId } });
  if (!flow) return fail("Flow not found.");
  await prisma.$transaction([
    prisma.hiringFlow.updateMany({ where: { tenantId: viewer.tenantId }, data: { isDefault: false } }),
    prisma.hiringFlow.update({ where: { id: flow.id }, data: { isDefault: true, isActive: true } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HiringFlow", entityId: flow.id, summary: `${flow.name} is now the default hiring flow` });
  return done(["/hiring/settings/stages", "/hiring/settings"], `${flow.name} is the default.`);
}

/** Move a candidate through the stage gate (criteria, approval). */
export async function requestStageMoveAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const applicationId = str(f, "applicationId");
  const r = await gatedStageMove(viewer, applicationId, str(f, "stageId"), str(f, "note", 500) || null);
  if (r.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: applicationId, summary: r.message });
  return r.ok ? done([`/hiring/applications/${applicationId}`, "/hiring/jobs", "/hiring/candidates"], r.message) : fail(r.message);
}

// ---------------------------------------------------------------------------
//  Dispositions and withdrawals
// ---------------------------------------------------------------------------

async function reasonLabel(tenantId: string, reasonId: string, kind: string): Promise<{ id: string | null; label: string } | null> {
  if (!reasonId) return null;
  const r = await prisma.dispositionReason.findFirst({ where: { id: reasonId, tenantId, kind, isActive: true } });
  return r ? { id: r.id, label: r.label } : null;
}

/** Reject with a reason from the library (and a note), recorded as the application's disposition. */
export async function rejectWithReasonAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const app = await prisma.application.findFirst({ where: { id: str(f, "applicationId"), tenantId: viewer.tenantId } });
  if (!app) return fail("Application not found.");
  const reason = await reasonLabel(viewer.tenantId, str(f, "reasonId"), "REJECT");
  if (!reason) return fail("Choose a reason from the library.", f, { reasonId: "Required" });
  const note = str(f, "note", 1000) || null;
  const res = await rejectApplication(app.id, note ? `${reason.label}: ${note}` : reason.label);
  if (!res.ok) return fail(res.message);
  await prisma.applicationDisposition.upsert({ where: { applicationId: app.id }, create: { tenantId: viewer.tenantId, applicationId: app.id, reasonId: reason.id, kind: "REJECT", label: reason.label, note, byUserId: viewer.user.id }, update: { reasonId: reason.id, kind: "REJECT", label: reason.label, note, byWhom: "RECRUITER", byUserId: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "REJECT", entityType: "Application", entityId: app.id, summary: `Rejected: ${reason.label}${note ? ` — ${note}` : ""}` });
  return done([`/hiring/applications/${app.id}`, "/hiring/jobs"], res.message);
}

/** The candidate withdrew (told the recruiter): close the application with the reason. */
export async function withdrawApplicationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const app = await prisma.application.findFirst({ where: { id: str(f, "applicationId"), tenantId: viewer.tenantId } });
  if (!app) return fail("Application not found.");
  if (["HIRED", "REJECTED", "WITHDRAWN"].includes(app.status)) return fail(`This application is already ${app.status.toLowerCase()}.`);
  const reason = await reasonLabel(viewer.tenantId, str(f, "reasonId"), "WITHDRAW");
  const label = reason?.label ?? str(f, "reason", 300);
  if (!label) return fail("Record why they withdrew.", f, { reasonId: "Required" });
  await closeAsWithdrawn(viewer.tenantId, app.id, label, reason?.id ?? null, "RECRUITER", viewer.user.id, str(f, "note", 1000) || null);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: app.id, summary: `Withdrawn by the candidate: ${label}` });
  return done([`/hiring/applications/${app.id}`, "/hiring/jobs"], "Marked as withdrawn.");
}

// ---------------------------------------------------------------------------
//  Ownership transfer and workload balancing
// ---------------------------------------------------------------------------

export async function transferOwnershipAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const to = str(f, "ownerUserId");
  if (!(await tenantUser(viewer, to))) return fail("Choose the new owner.", f, { ownerUserId: "Required" });
  const ids = f.getAll("applicationIds").map(String).filter(Boolean);
  const candidateId = str(f, "candidateId");
  const apps = await prisma.application.findMany({ where: { tenantId: viewer.tenantId, ...(ids.length ? { id: { in: ids } } : candidateId ? { candidateId, status: { in: ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"] } } : { id: "-" }) }, select: { id: true, ownerId: true } });
  if (!apps.length) return fail("Choose the applications to transfer.");
  const moving = apps.filter((a) => a.ownerId !== to);
  if (!moving.length) return fail("They already own these.");
  await prisma.application.updateMany({ where: { id: { in: moving.map((a) => a.id) } }, data: { ownerId: to } });
  for (const a of moving) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: a.id, summary: "Ownership transferred", oldValue: { ownerId: a.ownerId }, newValue: { ownerId: to } });
  await notify({ tenantId: viewer.tenantId, userIds: [to], kind: "HIRING", title: `${moving.length} candidate application(s) transferred to you`, link: "/hiring/candidates?owner=me" });
  return done(["/hiring/candidates", ...(candidateId ? [`/hiring/candidates/${candidateId}`] : [])], `Transferred ${moving.length} application(s).`);
}

export async function balanceWorkloadAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const recruiters = (await usersWithPermission(viewer.tenantId, HP.CANDIDATE_MANAGE)).filter((x) => !f.getAll("exclude").map(String).includes(x));
  const items = await prisma.application.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["ACTIVE", "ON_HOLD"] }, ...(str(f, "jobId") ? { jobId: str(f, "jobId") } : {}) }, select: { id: true, ownerId: true }, orderBy: { appliedAt: "desc" } });
  const moves = balanceAssignments(items, recruiters);
  if (!moves.length) return done(["/hiring/insights"], "The workload is already even.");
  for (const m of moves) await prisma.application.update({ where: { id: m.id }, data: { ownerId: m.to } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", summary: `Balanced recruiter workload: ${moves.length} application(s) reassigned`, newValue: moves });
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m.to, (counts.get(m.to) ?? 0) + 1);
  for (const [u, n] of counts) await notify({ tenantId: viewer.tenantId, userIds: [u], kind: "HIRING", title: `${n} application(s) assigned to you to balance the workload`, link: "/hiring/candidates?owner=me" });
  return done(["/hiring/insights", "/hiring/candidates"], `Reassigned ${moves.length} application(s).`);
}

// ---------------------------------------------------------------------------
//  Candidate merge (approved through the workflow engine)
// ---------------------------------------------------------------------------

export async function requestMergeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const survivorId = str(f, "survivorId"), duplicateId = str(f, "duplicateId");
  const blocker = await mergeBlocker(viewer.tenantId, survivorId, duplicateId);
  if (blocker) return fail(blocker);
  const [s, d] = await Promise.all([prisma.candidate.findFirstOrThrow({ where: { id: survivorId, tenantId: viewer.tenantId } }), prisma.candidate.findFirstOrThrow({ where: { id: duplicateId, tenantId: viewer.tenantId } })]);
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "CANDIDATE_MERGE", entityId: survivorId, title: `Merge ${d.firstName} ${d.lastName} <${d.email}> into ${s.firstName} ${s.lastName} <${s.email}>`, details: str(f, "note", 500) || null, data: { duplicateId, requestedBy: viewer.user.id }, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!r.ok) return fail(r.message);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: survivorId, summary: `Requested merging ${d.email} into ${s.email}` });
  return done(["/hiring/candidates/duplicates", `/hiring/candidates/${survivorId}`], r.status === "PENDING" ? "Merge sent for approval." : "Merged.");
}

// ---------------------------------------------------------------------------
//  Communication history and documents
// ---------------------------------------------------------------------------

const CHANNELS = ["EMAIL", "CALL", "SMS", "MEETING", "LINKEDIN", "NOTE"];

export async function logCommunicationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId } });
  if (!cand) return fail("Candidate not found.");
  const channel = CHANNELS.includes(str(f, "channel")) ? str(f, "channel") : null;
  if (!channel) return fail("Choose how you were in touch.", f, { channel: "Required" });
  const body = str(f, "body", 4000);
  if (!body && !str(f, "subject")) return fail("Write what was said.", f, { body: "Required" });
  const when = dateOf(f, "occurredAt") ?? new Date();
  const direction = str(f, "direction") === "INBOUND" ? "INBOUND" : "OUTBOUND";
  const row = await prisma.candidateCommunication.create({ data: { tenantId: viewer.tenantId, candidateId: cand.id, applicationId: str(f, "applicationId") || null, channel, direction, subject: str(f, "subject", 200) || null, body: body || null, occurredAt: when, byUserId: viewer.user.id } });
  const profile = await prisma.candidateSourcingProfile.findUnique({ where: { candidateId: cand.id } });
  await prisma.candidateSourcingProfile.upsert({
    where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, lastContactedAt: when, engagementStatus: direction === "INBOUND" ? "ENGAGED" : "CONTACTED" },
    update: { lastContactedAt: when, ...(profile?.engagementStatus === "NEW" ? { engagementStatus: direction === "INBOUND" ? "ENGAGED" : "CONTACTED" } : {}) },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CandidateCommunication", entityId: row.id, summary: `Logged ${channel.toLowerCase()} with ${cand.firstName} ${cand.lastName}` });
  return done([`/hiring/candidates/${cand.id}`], "Logged.");
}

export async function emailCandidateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId }, include: { sourcingProfile: true } });
  if (!cand) return fail("Candidate not found.");
  if (cand.sourcingProfile?.consentStatus === "WITHDRAWN") return fail(`${cand.firstName} has withdrawn consent to be contacted.`);
  const subject = str(f, "subject", 200), body = str(f, "body", 6000);
  if (!subject || body.length < 10) return fail("Write a subject and a message.", f, { body: "Required" });
  await prisma.emailOutbox.create({ data: { tenantId: viewer.tenantId, toAddress: cand.email, subject, textBody: body, relatedType: "Candidate", relatedId: cand.id } });
  const row = await prisma.candidateCommunication.create({ data: { tenantId: viewer.tenantId, candidateId: cand.id, channel: "EMAIL", direction: "OUTBOUND", subject, body, byUserId: viewer.user.id } });
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, lastContactedAt: new Date(), engagementStatus: "CONTACTED" }, update: { lastContactedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CandidateCommunication", entityId: row.id, summary: `Emailed ${cand.firstName} ${cand.lastName}: ${subject}` });
  return done([`/hiring/candidates/${cand.id}`], `Email queued to ${cand.email}.`);
}

const DOC_KINDS = ["ID_PROOF", "EDUCATION", "EXPERIENCE", "ADDRESS", "OTHER"];

export async function uploadCandidateDocumentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId } });
  if (!cand) return fail("Candidate not found.");
  const kind = DOC_KINDS.includes(str(f, "kind")) ? str(f, "kind") : null;
  if (!kind) return fail("Choose the document type.", f, { kind: "Required" });
  const file = f.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) return fail("Choose a file.", f, { file: "Required" });
  if (file.size > 5 * 1024 * 1024) return fail("Documents are limited to 5 MB.", f, { file: "Too large" });
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok || !(sniff.mimeType === "application/pdf" || sniff.mimeType.startsWith("image/"))) return fail("Upload a PDF or an image.", f, { file: "PDF or image" });
  const name = (file as File).name?.slice(0, 120) || `${kind.toLowerCase()}.pdf`;
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: name, mimeType: sniff.mimeType, data, relatedType: "CandidateDocument", relatedId: cand.id, uploadedBy: viewer.user.id });
  const doc = await prisma.candidateDocument.create({ data: { tenantId: viewer.tenantId, candidateId: cand.id, kind, fileId: stored.id, fileName: name, uploadedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CandidateDocument", entityId: doc.id, summary: `Uploaded ${kind.toLowerCase().replace("_", " ")} for ${cand.firstName} ${cand.lastName}` });
  return done([`/hiring/candidates/${cand.id}`], "Document uploaded for verification.");
}

export async function verifyCandidateDocumentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const doc = await prisma.candidateDocument.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!doc) return fail("Document not found.");
  if (doc.status !== "PENDING") return fail("This document has already been checked.");
  const verified = str(f, "decision") === "VERIFIED";
  const note = str(f, "note", 500) || null;
  if (!verified && !note) return fail("Say what is wrong with it.", f, { note: "Required" });
  if (doc.uploadedBy === viewer.user.id && verified) return fail("Someone other than the uploader verifies a document.");
  await prisma.candidateDocument.update({ where: { id: doc.id }, data: { status: verified ? "VERIFIED" : "REJECTED", note, verifiedBy: viewer.user.id, verifiedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: verified ? "APPROVE" : "REJECT", entityType: "CandidateDocument", entityId: doc.id, summary: `${verified ? "Verified" : "Rejected"} ${doc.kind.toLowerCase().replace("_", " ")} ${doc.fileName}${note ? `: ${note}` : ""}` });
  return done([`/hiring/candidates/${doc.candidateId}`], verified ? "Verified." : "Marked as rejected.");
}

// ---------------------------------------------------------------------------
//  Referrals: edit, bonus request (approved on the engine), payout
// ---------------------------------------------------------------------------

export async function updateReferralAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId }, include: { referralRecord: true } });
  if (!cand) return fail("Candidate not found.");
  const referrer = str(f, "referrerEmployeeId") || cand.referredById;
  if (!referrer || !(await prisma.employee.count({ where: { id: referrer, tenantId: viewer.tenantId } }))) return fail("Choose the employee who referred them.", f, { referrerEmployeeId: "Required" });
  const data = { referrerEmployeeId: referrer, relationship: str(f, "relationship", 120) || null, recommendation: str(f, "recommendation", 2000) || null };
  await prisma.referralRecord.upsert({ where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, ...data }, update: data });
  await prisma.candidate.update({ where: { id: cand.id }, data: { referredById: referrer, source: "REFERRAL" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReferralRecord", entityId: cand.id, summary: `Updated the referral of ${cand.firstName} ${cand.lastName}`, oldValue: cand.referralRecord ? { referrerEmployeeId: cand.referralRecord.referrerEmployeeId, relationship: cand.referralRecord.relationship } : { referrerEmployeeId: cand.referredById }, newValue: data });
  return done(["/hiring/referrals", `/hiring/candidates/${cand.id}`], "Referral saved.");
}

export async function requestReferralBonusAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId }, include: { referralRecord: true, applications: { select: { status: true } } } });
  if (!cand?.referredById) return fail("This candidate was not referred.");
  if (!cand.applications.some((a) => a.status === "HIRED" || a.status === "OFFER_ACCEPTED")) return fail("A referral bonus is due once the candidate accepts an offer.");
  const amount = numField(f, "amount");
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return fail("Enter the bonus amount.", f, { amount: "Required" });
  if (cand.referralRecord && ["REQUESTED", "APPROVED", "PAID"].includes(cand.referralRecord.bonusStatus)) return fail(`The bonus is already ${cand.referralRecord.bonusStatus.toLowerCase()}.`);
  const rec = await prisma.referralRecord.upsert({
    where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, referrerEmployeeId: cand.referredById, bonusAmount: amount, bonusStatus: "REQUESTED", bonusRequestedAt: new Date() },
    update: { bonusAmount: amount, bonusStatus: "REQUESTED", bonusRequestedAt: new Date(), bonusDecidedAt: null },
  });
  const referrer = await prisma.employee.findFirst({ where: { id: cand.referredById, tenantId: viewer.tenantId }, select: { displayName: true } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "REFERRAL_BONUS", entityId: rec.id, title: `Referral bonus ₹${amount.toLocaleString("en-IN")} for ${referrer?.displayName ?? "an employee"} (referred ${cand.firstName} ${cand.lastName})`, amount, requesterUserId: viewer.user.id, subjectEmployeeId: cand.referredById });
  if (!r.ok) { await prisma.referralRecord.update({ where: { id: rec.id }, data: { bonusStatus: "NONE" } }); return fail(r.message); }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ReferralRecord", entityId: rec.id, summary: `Requested a ₹${amount} referral bonus` });
  return done(["/hiring/referrals"], r.status === "PENDING" ? "Bonus sent for approval." : "Bonus approved.");
}

export async function markReferralBonusPaidAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const u = await prisma.referralRecord.updateMany({ where: { id: str(f, "id"), tenantId: viewer.tenantId, bonusStatus: "APPROVED" }, data: { bonusStatus: "PAID", bonusPaidAt: new Date() } });
  if (!u.count) return fail("Only an approved bonus can be marked paid.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReferralRecord", entityId: str(f, "id"), summary: "Referral bonus marked paid" });
  return done(["/hiring/referrals"], "Marked paid.");
}

// ---------------------------------------------------------------------------
//  Job postings on the careers site
// ---------------------------------------------------------------------------

/** Publish a job on the careers site — through an approval when the company requires one. */
export async function requestJobPostingAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CAREER_PORTAL_MANAGE]);
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId } });
  if (!job) return fail("Job not found.");
  if (job.status !== "OPEN") return fail("Only an open job can be posted.");
  if (job.isPublished) return fail("It is already on the careers site.");
  if ((job.description ?? "").trim().length < 30) return fail("Add a job description before posting.");
  const cfg = await hireDepthConfig(viewer.tenantId);
  if (cfg.requirePostingApproval) {
    const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "JOB_POSTING", entityId: job.id, title: `Post ${job.title} (${job.code ?? ""}) on the careers site`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!r.ok) return fail(r.message);
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: job.id, summary: "Careers posting sent for approval" });
    return done([`/hiring/jobs/${job.id}`, `/hiring/jobs/${job.id}/plan`], r.status === "PENDING" ? "Posting sent for approval." : "Posted.");
  }
  await prisma.job.update({ where: { id: job.id }, data: { isPublished: true, publishedAt: new Date() } });
  const alerts = await sendJobAlerts(viewer.tenantId, job.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: job.id, summary: `Posted on the careers site${alerts ? `; ${alerts} job alert(s) sent` : ""}` });
  return done([`/hiring/jobs/${job.id}`, `/hiring/jobs/${job.id}/plan`, "/careers"], `Posted${alerts ? `; ${alerts} subscriber(s) alerted` : ""}.`);
}

export async function unpublishJobAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CAREER_PORTAL_MANAGE]);
  const u = await prisma.job.updateMany({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId, isPublished: true }, data: { isPublished: false } });
  if (!u.count) return fail("It is not on the careers site.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: str(f, "jobId"), summary: "Taken off the careers site" });
  return done([`/hiring/jobs/${str(f, "jobId")}`, `/hiring/jobs/${str(f, "jobId")}/plan`, "/careers"], "Taken off the careers site.");
}

export async function saveJobPostingMetaAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CAREER_PORTAL_MANAGE]);
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId } });
  if (!job) return fail("Job not found.");
  const translations: Record<string, { title: string; description: string }> = {};
  const loc = str(f, "locale", 5).toLowerCase();
  const existing = await prisma.jobPostingMeta.findUnique({ where: { jobId: job.id } });
  Object.assign(translations, (existing?.translations ?? {}) as Record<string, { title: string; description: string }>);
  if (loc && loc !== "en") {
    const t = str(f, "tTitle", 160), d = str(f, "tDescription", 20000);
    if (t) translations[loc] = { title: t, description: d }; else delete translations[loc];
  }
  const data = { seoTitle: str(f, "seoTitle", 70) || null, seoDescription: str(f, "seoDescription", 170) || null, translations: translations as Prisma.InputJsonValue };
  await prisma.jobPostingMeta.upsert({ where: { jobId: job.id }, create: { tenantId: viewer.tenantId, jobId: job.id, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobPostingMeta", entityId: job.id, summary: `Posting SEO and translations saved (${Object.keys(translations).join(", ") || "English only"})` });
  return done([`/hiring/jobs/${job.id}/plan`, `/careers/${job.id}`], "Posting details saved.");
}
