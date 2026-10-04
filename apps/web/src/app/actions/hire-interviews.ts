"use server";

import { prisma } from "@keka/db";
import {
  startHireRequest, hireDepthConfig, rejectApplication, notify, parseSkillWeights, zonedLocalToUtc, formatInZone, isValidTimeZone,
} from "@keka/services";
import { requireViewer, requireAuth, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { HP, str, fail, numField, panelRuleProblems, capacityProblems } from "@/lib/hire-depth";

/**
 * Hire depth — interviews: the job's interview plan (approved on the
 * workflow engine), panel rules, panellist responses, reschedules with a
 * reason and the candidate's time zone, no-shows, cancellations, recording
 * consent, interviewer capacity, guides, the question bank, and reopening
 * submitted feedback.
 */


async function interviewOf(viewer: Viewer, id: string) {
  return prisma.interview.findFirst({
    where: { id, application: { tenantId: viewer.tenantId } },
    include: {
      panel: { include: { employee: { select: { id: true, userId: true, displayName: true, departmentId: true } } } },
      application: { include: { candidate: { include: { sourcingProfile: { select: { timeZone: true } } } }, job: { include: { requisition: { select: { departmentId: true } } } } } },
    },
  });
}
type IV = NonNullable<Awaited<ReturnType<typeof interviewOf>>>;

const ivPaths = (iv: { id: string; applicationId: string }) => [`/hiring/applications/${iv.applicationId}`, "/hiring/interviews"];

async function event(viewer: Viewer, interviewId: string, kind: string, extra: { reason?: string | null; fromAt?: Date | null; toAt?: Date | null; employeeId?: string | null } = {}) {
  await prisma.interviewEvent.create({ data: { tenantId: viewer.tenantId, interviewId, kind, reason: extra.reason ?? null, fromAt: extra.fromAt ?? null, toAt: extra.toAt ?? null, employeeId: extra.employeeId ?? null, byUserId: viewer.user.id } });
}

function candidateEmail(viewer: Viewer, iv: IV, subject: string, body: string) {
  return prisma.emailOutbox.create({ data: { tenantId: viewer.tenantId, toAddress: iv.application.candidate.email, subject, textBody: `Dear ${iv.application.candidate.firstName},\n\n${body}\n\nTalent Acquisition`, relatedType: "Interview", relatedId: iv.id } });
}

const candWhen = (iv: IV, at: Date) => formatInZone(at, iv.application.candidate.sourcingProfile?.timeZone ?? "Asia/Kolkata");


// ---------------------------------------------------------------------------
//  Interview plan
// ---------------------------------------------------------------------------

export async function saveInterviewPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId } });
  if (!job) return fail("Job not found.");
  const rounds: Array<{ name: string; minutes: number; focus: string }> = [];
  for (const line of str(f, "rounds", 4000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [name, minutes, focus] = line.split("|").map((x) => x.trim());
    const m = Number(minutes || 60);
    if (!name || !Number.isInteger(m) || m < 15 || m > 480) return fail(`Write each round as “Technical | 60 | system design” — “${line}” is not.`, f, { rounds: "Check the rounds" });
    rounds.push({ name: name.slice(0, 80), minutes: m, focus: (focus ?? "").slice(0, 200) });
  }
  if (!rounds.length) return fail("Add at least one round.", f, { rounds: "Required" });
  const minPanel = numField(f, "minPanel"), maxPanel = numField(f, "maxPanel");
  if (minPanel !== null && maxPanel !== null && minPanel > maxPanel) return fail("The minimum panel is larger than the maximum.", f, { minPanel: "Too large" });
  const panelRules = { minPanel, maxPanel, requireHiringManager: f.get("requireHiringManager") === "on", requireOtherDepartment: f.get("requireOtherDepartment") === "on" };
  const weights: Record<string, number> = {};
  for (const line of str(f, "skillWeights", 2000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[:=]\s*(\d+(?:\.\d+)?)$/.exec(line);
    if (!m) return fail(`Write each weight as “Communication: 2” — “${line}” is not.`, f, { skillWeights: "Check the weights" });
    weights[m[1]!.trim()] = Number(m[2]);
  }
  const skillWeights = parseSkillWeights(weights);
  const existing = await prisma.interviewPlan.findUnique({ where: { jobId: job.id } });
  if (existing?.status === "PENDING_APPROVAL") return fail("The plan is waiting for sign-off; it cannot change now.");
  const data = { rounds, panelRules, skillWeights: Object.keys(skillWeights).length ? skillWeights : undefined, status: "DRAFT", updatedBy: viewer.user.id, approvedBy: null, approvedAt: null };
  await prisma.interviewPlan.upsert({ where: { jobId: job.id }, create: { tenantId: viewer.tenantId, jobId: job.id, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "InterviewPlan", entityId: job.id, summary: `Interview plan for ${job.title}: ${rounds.length} round(s)${existing?.status === "APPROVED" ? " — edited after sign-off, back to draft" : ""}`, oldValue: existing ? { rounds: existing.rounds, panelRules: existing.panelRules } : undefined, newValue: { rounds, panelRules, skillWeights } });
  return done([`/hiring/jobs/${job.id}/plan`], "Plan saved as a draft.");
}

export async function submitInterviewPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.JOB_MANAGE);
  const plan = await prisma.interviewPlan.findFirst({ where: { jobId: str(f, "jobId"), tenantId: viewer.tenantId } });
  if (!plan) return fail("Save the plan first.");
  if (!["DRAFT", "REJECTED"].includes(plan.status)) return fail(`The plan is ${plan.status.toLowerCase().replace("_", " ")}.`);
  const job = await prisma.job.findUniqueOrThrow({ where: { id: plan.jobId } });
  const hmUser = job.hiringManagerId ? (await prisma.employee.findFirst({ where: { id: job.hiringManagerId, tenantId: viewer.tenantId }, select: { userId: true } }))?.userId ?? null : null;
  await prisma.interviewPlan.update({ where: { id: plan.id }, data: { status: "PENDING_APPROVAL" } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "INTERVIEW_PLAN", entityId: plan.id, title: `Sign off the interview plan for ${job.title}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null, reviewerUserId: hmUser && hmUser !== viewer.user.id ? hmUser : null });
  if (!r.ok) { await prisma.interviewPlan.update({ where: { id: plan.id }, data: { status: plan.status } }); return fail(r.message); }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "InterviewPlan", entityId: plan.id, summary: `Sent the interview plan for ${job.title} for sign-off` });
  return done([`/hiring/jobs/${job.id}/plan`], r.status === "PENDING" ? "Sent for sign-off." : "Plan approved.");
}

// ---------------------------------------------------------------------------
//  Panel
// ---------------------------------------------------------------------------

export async function addPanelistAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  if (!["SCHEDULED", "RESCHEDULED"].includes(iv.status)) return fail("The interview is not upcoming.");
  const emp = await prisma.employee.findFirst({ where: { id: str(f, "employeeId"), tenantId: viewer.tenantId }, select: { id: true, userId: true, displayName: true } });
  if (!emp) return fail("Choose an interviewer.", f, { employeeId: "Required" });
  if (iv.panel.some((p) => p.employeeId === emp.id)) return fail(`${emp.displayName} is already on the panel.`);
  const problems = (await panelRuleProblems(viewer.tenantId, iv.application.jobId, [...iv.panel.map((p) => p.employeeId), emp.id])).filter((p) => /at most/i.test(p));
  if (problems.length) return fail(problems.join(" "));
  if (f.get("override") !== "on") {
    const over = await capacityProblems(viewer.tenantId, [emp.id], iv.scheduledAt, iv.id);
    if (over.length) return fail(`${over.join(" ")} Tick override to add them anyway.`);
  }
  await prisma.interviewPanelist.create({ data: { interviewId: iv.id, employeeId: emp.id } });
  await event(viewer, iv.id, "PANEL_ADDED", { employeeId: emp.id });
  await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "HIRING", title: `Interview: ${iv.application.candidate.firstName} ${iv.application.candidate.lastName} for ${iv.application.job.title}`, body: formatInZone(iv.scheduledAt, "Asia/Kolkata"), link: `/hiring/applications/${iv.applicationId}`, email: true, event: "INTERVIEW_SCHEDULED" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Added ${emp.displayName} to the panel of ${iv.title}` });
  return done(ivPaths(iv), `${emp.displayName} added.`);
}

export async function removePanelistAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  const p = iv.panel.find((x) => x.employeeId === str(f, "employeeId"));
  if (!p) return fail("Not on the panel.");
  if (iv.panel.length <= 1) return fail("An interview needs at least one interviewer.");
  if (await prisma.scorecard.count({ where: { interviewId: iv.id, panelistId: p.employeeId } })) return fail(`${p.employee.displayName} has already given feedback.`);
  const rest = iv.panel.filter((x) => x.employeeId !== p.employeeId).map((x) => x.employeeId);
  const problems = (await panelRuleProblems(viewer.tenantId, iv.application.jobId, rest)).filter((x) => !/at most/i.test(x));
  if (problems.length && f.get("override") !== "on") return fail(`${problems.join(" ")} Tick “override” to remove anyway.`);
  await prisma.interviewPanelist.delete({ where: { id: p.id } });
  await event(viewer, iv.id, "PANEL_REMOVED", { employeeId: p.employeeId, reason: str(f, "reason", 300) || null });
  await notify({ tenantId: viewer.tenantId, userIds: [p.employee.userId], kind: "HIRING", title: `You are no longer on the ${iv.title} panel for ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, link: "/hiring/interviews" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Removed ${p.employee.displayName} from the panel of ${iv.title}${problems.length ? " (panel rules overridden)" : ""}` });
  return done(ivPaths(iv), "Removed from the panel.");
}

/** A panellist accepts or declines the invitation. */
export async function respondToPanelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return fail("No employee record linked to this login.");
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  const p = iv?.panel.find((x) => x.employeeId === viewer.employee!.id);
  if (!iv || !p) return fail("You are not on this panel.");
  const accept = str(f, "response") === "ACCEPTED";
  const reason = str(f, "reason", 300);
  if (!accept && !reason) return fail("Say why you cannot make it, so the recruiter can find a replacement.", f, { reason: "Required" });
  await prisma.interviewPanelist.update({ where: { id: p.id }, data: { response: accept ? "ACCEPTED" : "DECLINED" } });
  await event(viewer, iv.id, accept ? "PANEL_ACCEPTED" : "PANEL_DECLINED", { employeeId: p.employeeId, reason: reason || null });
  if (!accept && iv.application.ownerId) await notify({ tenantId: viewer.tenantId, userIds: [iv.application.ownerId], kind: "HIRING", title: `${viewer.employee.displayName} declined ${iv.title} with ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, body: reason, link: `/hiring/applications/${iv.applicationId}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `${viewer.employee.displayName} ${accept ? "accepted" : `declined: ${reason}`}` });
  return done(ivPaths(iv), accept ? "Accepted." : "Declined; the recruiter has been told.");
}

// ---------------------------------------------------------------------------
//  Reschedule, no-show, cancel, complete
// ---------------------------------------------------------------------------

export async function rescheduleInterviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  if (!["SCHEDULED", "RESCHEDULED"].includes(iv.status)) return fail("Only an upcoming interview can be rescheduled.");
  const reason = str(f, "reason", 500);
  if (!reason) return fail("Record why it is being moved.", f, { reason: "Required" });
  const tz = str(f, "timeZone", 60) || "Asia/Kolkata";
  if (!isValidTimeZone(tz)) return fail("Choose a valid time zone.", f, { timeZone: "Invalid" });
  const at = zonedLocalToUtc(str(f, "date", 10), str(f, "time", 5), tz);
  if (!at) return fail("Enter the new date and time.", f, { date: "Required" });
  if (at.getTime() < Date.now()) return fail("That time has passed.", f, { date: "Past" });
  const end = new Date(at.getTime() + iv.durationMinutes * 60_000);
  const clashes = await prisma.interviewPanelist.findMany({ where: { employeeId: { in: iv.panel.map((p) => p.employeeId) }, interview: { id: { not: iv.id }, status: { in: ["SCHEDULED", "RESCHEDULED"] }, scheduledAt: { lt: end, gte: new Date(at.getTime() - 8 * 3_600_000) } } }, include: { interview: true, employee: { select: { displayName: true } } } });
  const busy = clashes.filter((c) => new Date(c.interview.scheduledAt.getTime() + c.interview.durationMinutes * 60_000) > at);
  if (busy.length) return fail(`${busy.map((c) => c.employee.displayName).join(", ")} already interviewing then.`);
  const from = iv.scheduledAt;
  await prisma.interview.update({ where: { id: iv.id }, data: { scheduledAt: at, status: "RESCHEDULED" } });
  await prisma.interviewPanelist.updateMany({ where: { interviewId: iv.id }, data: { response: "PENDING" } });
  await event(viewer, iv.id, "RESCHEDULED", { reason, fromAt: from, toAt: at });
  await notify({ tenantId: viewer.tenantId, userIds: iv.panel.map((p) => p.employee.userId), kind: "HIRING", title: `Moved: ${iv.title} with ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, body: `Now ${formatInZone(at, "Asia/Kolkata")} (was ${formatInZone(from, "Asia/Kolkata")}). ${reason}`, link: `/hiring/applications/${iv.applicationId}`, email: true, event: "INTERVIEW_SCHEDULED" });
  if (f.get("notifyCandidate") !== "off") await candidateEmail(viewer, iv, `Your ${iv.title} interview has moved`, `Your ${iv.title} interview for ${iv.application.job.title} is now on ${candWhen(iv, at)}.\nReason: ${reason}`);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Rescheduled ${iv.title}: ${reason}`, oldValue: { scheduledAt: from }, newValue: { scheduledAt: at, timeZone: tz } });
  return done(ivPaths(iv), `Moved to ${formatInZone(at, tz)}; the panel and candidate have been told.`);
}

export async function markNoShowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  if (!["SCHEDULED", "RESCHEDULED"].includes(iv.status)) return fail("Only a scheduled interview can be marked a no-show.");
  if (iv.scheduledAt.getTime() > Date.now()) return fail("The interview has not started yet.");
  const reason = str(f, "reason", 300) || null;
  await prisma.interview.update({ where: { id: iv.id }, data: { status: "NO_SHOW" } });
  await event(viewer, iv.id, "NO_SHOW", { reason });
  const cfg = await hireDepthConfig(viewer.tenantId);
  const count = await prisma.interview.count({ where: { applicationId: iv.applicationId, status: "NO_SHOW" } });
  let closed = false;
  if (count >= cfg.noShowLimit && iv.application.status === "ACTIVE") {
    const label = `No-show (${count} missed interviews)`;
    const r = await rejectApplication(iv.applicationId, label);
    if (r.ok) {
      closed = true;
      await prisma.applicationDisposition.upsert({ where: { applicationId: iv.applicationId }, create: { tenantId: viewer.tenantId, applicationId: iv.applicationId, kind: "REJECT", label, byWhom: "SYSTEM", byUserId: viewer.user.id }, update: { kind: "REJECT", label, byWhom: "SYSTEM", byUserId: viewer.user.id } });
    }
  } else {
    await candidateEmail(viewer, iv, `We missed you at your ${iv.title} interview`, `We were expecting you for your ${iv.title} interview for ${iv.application.job.title} on ${candWhen(iv, iv.scheduledAt)}. Reply to this email if you would like to find another time.`);
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `No-show at ${iv.title}${reason ? `: ${reason}` : ""}${closed ? `; application closed after ${count} no-shows` : ""}` });
  return done(ivPaths(iv), closed ? `Marked a no-show; the application is closed after ${count} no-shows.` : `Marked a no-show (${count} of ${cfg.noShowLimit}).`);
}

export async function cancelInterviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  if (!["SCHEDULED", "RESCHEDULED"].includes(iv.status)) return fail("Only an upcoming interview can be cancelled.");
  const reason = str(f, "reason", 500);
  if (!reason) return fail("Record why it is cancelled.", f, { reason: "Required" });
  await prisma.interview.update({ where: { id: iv.id }, data: { status: "CANCELLED" } });
  await event(viewer, iv.id, "CANCELLED", { reason });
  await notify({ tenantId: viewer.tenantId, userIds: iv.panel.map((p) => p.employee.userId), kind: "HIRING", title: `Cancelled: ${iv.title} with ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, body: reason, link: "/hiring/interviews", email: true });
  if (f.get("notifyCandidate") !== "off") await candidateEmail(viewer, iv, `Your ${iv.title} interview is cancelled`, `Your ${iv.title} interview for ${iv.application.job.title} on ${candWhen(iv, iv.scheduledAt)} is cancelled. We will be in touch about next steps.`);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Cancelled ${iv.title}: ${reason}` });
  return done(ivPaths(iv), "Interview cancelled.");
}

export async function completeInterviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  if (!["SCHEDULED", "RESCHEDULED"].includes(iv.status)) return fail("The interview is not upcoming.");
  if (iv.scheduledAt.getTime() > Date.now()) return fail("The interview has not started yet.");
  await prisma.interview.update({ where: { id: iv.id }, data: { status: "COMPLETED" } });
  await event(viewer, iv.id, "COMPLETED");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Marked ${iv.title} as held` });
  return done(ivPaths(iv), "Marked as held.");
}

/** Send the candidate the interview details in their own time zone. */
export async function notifyCandidateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  const tz = iv.application.candidate.sourcingProfile?.timeZone ?? "Asia/Kolkata";
  await candidateEmail(viewer, iv, `Your ${iv.title} interview for ${iv.application.job.title}`, `Your ${iv.title} interview is on ${formatInZone(iv.scheduledAt, tz)} (${iv.durationMinutes} minutes, ${iv.mode.toLowerCase()}).${iv.meetingUrl ? `\nJoin: ${iv.meetingUrl}` : ""}`);
  await event(viewer, iv.id, "CANDIDATE_NOTIFIED", { reason: tz });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Sent the candidate the ${iv.title} details (${tz})` });
  return done(ivPaths(iv), `Sent for ${formatInZone(iv.scheduledAt, tz)}.`);
}

export async function recordInterviewConsentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const iv = await interviewOf(viewer, str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  const status = str(f, "status") === "DECLINED" ? "DECLINED" : "GRANTED";
  const method = str(f, "method", 120);
  if (!method) return fail("Record how the candidate answered.", f, { method: "Required" });
  await prisma.interviewConsent.upsert({ where: { interviewId: iv.id }, create: { tenantId: viewer.tenantId, interviewId: iv.id, status, method, recordedBy: viewer.user.id }, update: { status, method, recordedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "InterviewConsent", entityId: iv.id, summary: `Recording consent ${status.toLowerCase()} for ${iv.title} (${method})` });
  return done(ivPaths(iv), status === "GRANTED" ? "Consent to record noted." : "Noted: do not record.");
}

// ---------------------------------------------------------------------------
//  Capacity, guides, question bank
// ---------------------------------------------------------------------------

export async function saveCapacityAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const emp = await prisma.employee.findFirst({ where: { id: str(f, "employeeId"), tenantId: viewer.tenantId }, select: { id: true, displayName: true } });
  if (!emp) return fail("Choose an interviewer.", f, { employeeId: "Required" });
  const week = numField(f, "maxPerWeek"), day = numField(f, "maxPerDay");
  if (week === null || !Number.isInteger(week) || week < 0 || week > 40) return fail("Per week is 0–40.", f, { maxPerWeek: "0–40" });
  if (day === null || !Number.isInteger(day) || day < 0 || day > 10 || day > Math.max(week, 1)) return fail("Per day is 0–10 and no more than per week.", f, { maxPerDay: "Invalid" });
  await prisma.interviewerCapacity.upsert({ where: { tenantId_employeeId: { tenantId: viewer.tenantId, employeeId: emp.id } }, create: { tenantId: viewer.tenantId, employeeId: emp.id, maxPerWeek: week, maxPerDay: day }, update: { maxPerWeek: week, maxPerDay: day, isActive: f.get("isActive") !== "off" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "InterviewerCapacity", entityId: emp.id, summary: `${emp.displayName}: up to ${week} interviews a week, ${day} a day` });
  return done(["/hiring/interviews/capacity"], "Capacity saved.");
}

export async function saveGuideAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const title = str(f, "title", 120), body = str(f, "body", 20000);
  if (title.length < 3) return fail("Name the guide.", f, { title: "Required" });
  if (body.length < 20) return fail("Write the guide.", f, { body: "Required" });
  const id = str(f, "id");
  const departmentId = str(f, "departmentId") || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return fail("Department not found.");
  const data = { title, body, roleKeyword: str(f, "roleKeyword", 80) || null, departmentId };
  if (await prisma.interviewGuide.count({ where: { tenantId: viewer.tenantId, title, NOT: { id: id || "-" } } })) return fail("A guide with that title exists.", f, { title: "Taken" });
  const g = id
    ? (await prisma.interviewGuide.updateMany({ where: { id, tenantId: viewer.tenantId }, data })).count ? { id } : null
    : await prisma.interviewGuide.create({ data: { tenantId: viewer.tenantId, ...data } });
  if (!g) return fail("Guide not found.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "InterviewGuide", entityId: g.id, summary: `${id ? "Edited" : "Added"} interview guide ${title}` });
  return done(["/hiring/settings/interviewing"], "Guide saved.");
}

export async function toggleGuideAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const g = await prisma.interviewGuide.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!g) return fail("Guide not found.");
  await prisma.interviewGuide.update({ where: { id: g.id }, data: { isActive: !g.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "InterviewGuide", entityId: g.id, summary: `${g.isActive ? "Retired" : "Restored"} guide ${g.title}` });
  return done(["/hiring/settings/interviewing"], g.isActive ? "Retired." : "Restored.");
}

export async function saveQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const text = str(f, "text", 1000), competency = str(f, "competency", 80);
  if (text.length < 10) return fail("Write the question.", f, { text: "Required" });
  if (!competency) return fail("Which competency does it test?", f, { competency: "Required" });
  const difficulty = ["EASY", "MEDIUM", "HARD"].includes(str(f, "difficulty")) ? str(f, "difficulty") : "MEDIUM";
  const q = await prisma.questionBankItem.create({ data: { tenantId: viewer.tenantId, text, competency, difficulty, guidance: str(f, "guidance", 2000) || null, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "QuestionBankItem", entityId: q.id, summary: `Added a ${difficulty.toLowerCase()} ${competency} question to the bank` });
  return done(["/hiring/settings/interviewing"], "Question added.");
}

export async function toggleQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.INTERVIEW_MANAGE);
  const q = await prisma.questionBankItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!q) return fail("Question not found.");
  await prisma.questionBankItem.update({ where: { id: q.id }, data: { isActive: !q.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "QuestionBankItem", entityId: q.id, summary: `${q.isActive ? "Retired" : "Restored"} a bank question` });
  return done(["/hiring/settings/interviewing"], q.isActive ? "Retired." : "Restored.");
}

// ---------------------------------------------------------------------------
//  Reopen submitted feedback (approved on the engine)
// ---------------------------------------------------------------------------

export async function requestScorecardReopenAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const sc = await prisma.scorecard.findFirst({ where: { id: str(f, "scorecardId"), interview: { application: { tenantId: viewer.tenantId } } }, include: { interview: true } });
  if (!sc) return fail("Feedback not found.");
  const own = viewer.employee?.id === sc.panelistId;
  if (!own && !can(viewer, HP.INTERVIEW_MANAGE)) return fail("Only the interviewer or a recruiter can ask to reopen feedback.");
  if (sc.status !== "SUBMITTED") return fail("This feedback is not submitted.");
  const reason = str(f, "reason", 500);
  if (!reason) return fail("Say what needs amending.", f, { reason: "Required" });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "SCORECARD_REOPEN", entityId: sc.id, title: `Reopen submitted feedback for ${sc.interview.title}`, details: reason, requesterUserId: viewer.user.id, subjectEmployeeId: sc.panelistId });
  if (!r.ok) return fail(r.message);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Scorecard", entityId: sc.id, summary: `Asked to reopen feedback: ${reason}` });
  return done([`/hiring/applications/${sc.interview.applicationId}`], r.status === "PENDING" ? "Sent for approval." : "Reopened.");
}

