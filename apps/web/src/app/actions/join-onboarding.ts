"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, notify, buddyCheck, generateMilestones, escalateOverdueJourneyTasks, snapshotJourneyTemplate,
  onboardingPhase, phaseDefaultOffset, ONBOARDING_PHASES, type OnboardingPhase,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { jstr as str, jnum as num, jday as day, jlist as list, scopedEmployee, tenantEmployee, managesEmployee } from "@/lib/join-depth";

/**
 * Onboarding depth: plan sign-off and task sign-off through the workflow
 * engine, task delegation and escalation, the journey designer and its
 * revision history, buddies (accepted by the buddy in their inbox) with
 * check-ins, orientation sessions and onboarding meetings (scheduled after
 * approval, with RSVPs and attendance), and first-week / 30-60-90-day
 * milestones with manager reviews and the hire's own feedback.
 */

const P = PERMISSIONS;
const PATHS = ["/onboarding", "/onboarding/people", "/onboarding/insights", "/me/onboarding", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });

async function hrOrManager(viewer: Viewer, employeeId: string) {
  return (can(viewer, P.ONBOARDING_MANAGE) && !!(await scopedEmployee(viewer, employeeId, P.ONBOARDING_MANAGE))) || (await managesEmployee(viewer, employeeId));
}

// ---------------------------------------------------------------------------
//  Plans and tasks
// ---------------------------------------------------------------------------

/** HR sends a hire's onboarding plan to their manager for sign-off. */
export async function submitOnboardingPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const j = await prisma.journey.findFirst({ where: { id: str(f, "journeyId"), tenantId: viewer.tenantId }, include: { employee: { select: { displayName: true } }, _count: { select: { tasks: true } } } });
  if (!j || !(await scopedEmployee(viewer, j.employeeId, P.ONBOARDING_MANAGE))) return NO("Journey not found.");
  if (j.status !== "ACTIVE") return NO("Only a running journey can be sent for sign-off.");
  if (j.planStatus === "PENDING_APPROVAL") return NO("It is already waiting for sign-off.");
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ONBOARDING_PLAN", entityId: j.id, title: `Onboarding plan for ${j.employee.displayName}`, details: `${j._count.tasks} task(s): ${j.title}`, requesterUserId: viewer.user.id, subjectEmployeeId: j.employeeId });
  if (!wf.ok) return NO(wf.message);
  await prisma.journey.update({ where: { id: j.id }, data: { planStatus: wf.message === "Approved automatically." ? "APPROVED" : "PENDING_APPROVAL", planWorkflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "Journey", entityId: j.id, summary: `Sent the onboarding plan for ${j.employee.displayName} for sign-off` });
  return done([...PATHS, `/onboarding/${j.id}`], wf.message === "Approved automatically." ? "Approved automatically." : "Sent to the hire's manager for sign-off.");
}

/** Hand a task to someone else (the assignee or onboarding HR). */
export async function delegateJourneyTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const task = await prisma.journeyTask.findFirst({ where: { id: str(f, "taskId"), journey: { tenantId: viewer.tenantId } }, include: { journey: { select: { id: true, employeeId: true, trigger: true } } } });
  if (!task) return NO("Task not found.");
  if (task.status !== "PENDING") return NO("Only a pending task can be handed over.");
  const mine = !!task.assigneeEmployeeId && task.assigneeEmployeeId === viewer.employee?.id;
  const hr = can(viewer, P.ONBOARDING_MANAGE) && !!(await scopedEmployee(viewer, task.journey.employeeId, P.ONBOARDING_MANAGE));
  if (!mine && !hr) return NO("Only the assignee or onboarding HR can hand this task over.");
  const to = await tenantEmployee(viewer, str(f, "toEmployeeId"));
  if (!to || ["EXITED", "PREBOARDING"].includes(to.status)) return NO("Pick a colleague who is working here.");
  if (to.id === task.assigneeEmployeeId) return NO("It is already theirs.");
  const note = str(f, "note");
  await prisma.journeyTask.update({ where: { id: task.id }, data: { assigneeEmployeeId: to.id, delegatedFromEmployeeId: task.assigneeEmployeeId, note: note ? `Handed over: ${note}` : task.note, escalationLevel: 0 } });
  await notify({ tenantId: viewer.tenantId, userIds: [to.userId], kind: "JOURNEY", title: `Task handed to you: ${task.title}`, body: note || null, link: `/onboarding/${task.journey.id}` });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTask", entityId: task.id, summary: `Handed "${task.title}" to ${to.displayName}${note ? ` — ${note}` : ""}` });
  return done([...PATHS, `/onboarding/${task.journey.id}`], `Handed to ${to.displayName}.`);
}

export async function escalateJourneyTasksAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const n = await escalateOverdueJourneyTasks(viewer.tenantId);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTask", summary: `Escalated ${n} overdue onboarding task(s)` });
  return done(PATHS, n ? `${n} overdue task(s) escalated.` : "Nothing new to escalate.");
}

// ---------------------------------------------------------------------------
//  Journey designer
// ---------------------------------------------------------------------------

export async function designerTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const k = await prisma.journeyTaskTemplate.findFirst({ where: { id: str(f, "id"), template: { tenantId: viewer.tenantId } }, include: { template: { select: { id: true, name: true } } } });
  if (!k) return NO("Task not found.");
  const op = str(f, "op");
  if (op === "phase") {
    const phase = str(f, "phase") as OnboardingPhase;
    if (!(phase in ONBOARDING_PHASES)) return NO("Pick a phase.");
    const offset = num(f, "offsetDays");
    const next = offset !== null && !Number.isNaN(offset) && onboardingPhase(offset) === phase ? Math.round(offset) : phaseDefaultOffset(phase);
    await prisma.journeyTaskTemplate.update({ where: { id: k.id }, data: { offsetDays: next } });
  } else if (op === "approval") {
    await prisma.journeyTaskTemplate.update({ where: { id: k.id }, data: { needsApproval: !k.needsApproval } });
  } else if (op === "up" || op === "down") {
    const siblings = await prisma.journeyTaskTemplate.findMany({ where: { templateId: k.templateId }, orderBy: [{ offsetDays: "asc" }, { sortOrder: "asc" }] });
    const i = siblings.findIndex((s) => s.id === k.id), j = op === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return done(PATHS, "Already at the end.");
    const other = siblings[j]!;
    await prisma.$transaction([
      prisma.journeyTaskTemplate.update({ where: { id: k.id }, data: { sortOrder: j, offsetDays: other.offsetDays } }),
      prisma.journeyTaskTemplate.update({ where: { id: other.id }, data: { sortOrder: i, offsetDays: k.offsetDays } }),
    ]);
  } else return NO("Unknown action.");
  const v = await snapshotJourneyTemplate(viewer.tenantId, k.template.id, viewer.user.id, `Designer: ${op} "${k.title}"`);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTemplate", entityId: k.template.id, summary: `${k.template.name} v${v}: ${op} "${k.title}"` });
  return done([...PATHS, `/onboarding/templates/${k.template.id}`], "Updated.");
}

/** Restore a template's tasks from an earlier revision. */
export async function restoreTemplateRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const r = await prisma.journeyTemplateRevision.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return NO("Revision not found.");
  const snap = r.snapshot as { tasks?: Array<{ title: string; owner: string; offsetDays: number; category: string; isRequired: boolean; needsApproval?: boolean }> };
  const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  await prisma.$transaction([
    prisma.journeyTaskTemplate.deleteMany({ where: { templateId: r.templateId } }),
    prisma.journeyTaskTemplate.createMany({ data: tasks.map((t, i) => ({ templateId: r.templateId, title: t.title, owner: t.owner as never, offsetDays: t.offsetDays, category: t.category, isRequired: t.isRequired, needsApproval: !!t.needsApproval, sortOrder: i })) }),
  ]);
  const v = await snapshotJourneyTemplate(viewer.tenantId, r.templateId, viewer.user.id, `Restored version ${r.version}`);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTemplate", entityId: r.templateId, summary: `Restored tasks from version ${r.version} (now v${v})` });
  return done([...PATHS, `/onboarding/templates/${r.templateId}`], `Restored version ${r.version}.`);
}

// ---------------------------------------------------------------------------
//  Buddies
// ---------------------------------------------------------------------------

export async function assignBuddyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const hire = await tenantEmployee(viewer, str(f, "employeeId"));
  if (!hire || !(await hrOrManager(viewer, hire.id))) return NO("Only onboarding HR or the hire's manager can assign a buddy.");
  const buddy = await tenantEmployee(viewer, str(f, "buddyEmployeeId"));
  if (!buddy) return NO("Pick a buddy.");
  const active = await prisma.onboardingBuddy.count({ where: { tenantId: viewer.tenantId, buddyEmployeeId: buddy.id, status: { in: ["PROPOSED", "ACTIVE"] } } });
  const chk = buddyCheck({ hireId: hire.id, buddyId: buddy.id, buddyStatus: buddy.status, activeBuddyCount: active });
  if (!chk.ok) return NO(chk.message);
  if (await prisma.onboardingBuddy.count({ where: { tenantId: viewer.tenantId, employeeId: hire.id, status: { in: ["PROPOSED", "ACTIVE"] } } })) return NO(`${hire.displayName} already has a buddy.`);
  const startsOn = day(str(f, "startsOn")) ?? hire.dateOfJoining;
  const endsOn = day(str(f, "endsOn")) ?? new Date(startsOn.getTime() + 90 * 86_400_000);
  if (endsOn <= startsOn) return NO("The buddy period ends before it starts.");
  const b = await prisma.onboardingBuddy.create({ data: { tenantId: viewer.tenantId, employeeId: hire.id, buddyEmployeeId: buddy.id, startsOn, endsOn, goals: str(f, "goals") || null, assignedBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "BUDDY_ASSIGNMENT", entityId: b.id, title: `Be the onboarding buddy for ${hire.displayName}?`, details: b.goals, requesterUserId: viewer.user.id, subjectEmployeeId: hire.id, reviewerUserId: buddy.userId });
  if (!wf.ok) { await prisma.onboardingBuddy.delete({ where: { id: b.id } }); return NO(wf.message); }
  await prisma.onboardingBuddy.update({ where: { id: b.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "OnboardingBuddy", entityId: b.id, summary: `Proposed ${buddy.displayName} as buddy for ${hire.displayName}` });
  return done(PATHS, wf.message === "Approved automatically." ? "Buddy assigned." : `Asked ${buddy.displayName} to accept in their inbox.`);
}

export async function buddyOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const b = await prisma.onboardingBuddy.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!b) return NO("Buddy assignment not found.");
  const me = viewer.employee?.id;
  const op = str(f, "op");
  if (op === "checkin") {
    if (b.status !== "ACTIVE") return NO("Check-ins are for an active buddy.");
    if (me !== b.buddyEmployeeId && me !== b.employeeId && !(await hrOrManager(viewer, b.employeeId))) return NO("Not your buddy pairing.");
    const note = str(f, "note");
    if (!note) return NO("Add a note about the check-in.");
    await prisma.onboardingBuddyCheckin.create({ data: { buddyId: b.id, heldOn: day(str(f, "heldOn")) ?? new Date(), note: note.slice(0, 1000), byEmployeeId: me ?? null } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "OnboardingBuddyCheckin", entityId: b.id, summary: "Logged a buddy check-in" });
    return done(PATHS, "Check-in logged.");
  }
  if (op === "feedback") {
    if (me !== b.employeeId) return NO("Only the new hire gives buddy feedback.");
    const rating = num(f, "rating");
    if (!rating || rating < 1 || rating > 5) return NO("Rate 1 to 5.");
    await prisma.onboardingBuddy.update({ where: { id: b.id }, data: { feedbackRating: Math.round(rating), feedbackNote: str(f, "note") || null } });
    return done(PATHS, "Thanks for the feedback.");
  }
  if (!(await hrOrManager(viewer, b.employeeId))) return NO("Only onboarding HR or the hire's manager can change this.");
  if (op === "complete") {
    if (b.status !== "ACTIVE") return NO("Only an active buddy period can be completed.");
    await prisma.onboardingBuddy.update({ where: { id: b.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  } else if (op === "cancel") {
    if (!["PROPOSED", "ACTIVE"].includes(b.status)) return NO("Already closed.");
    await prisma.onboardingBuddy.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "OnboardingBuddy", entityId: b.id, summary: `Buddy assignment ${op}` });
  return done(PATHS, op === "complete" ? "Buddy period completed." : "Cancelled.");
}

// ---------------------------------------------------------------------------
//  Orientation sessions and onboarding meetings
// ---------------------------------------------------------------------------

const KINDS = ["ORIENTATION", "MANAGER_INTRO", "TEAM_MEET", "IT_SETUP", "CHECKIN"];
const dt = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? new Date(new Date(`${v}:00Z`).getTime() - 330 * 60_000) : null);

export async function saveOrientationSessionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const isHr = can(viewer, P.ONBOARDING_MANAGE);
  const kind = str(f, "kind") || "ORIENTATION";
  if (!KINDS.includes(kind)) return NO("Pick a session type.");
  if (!isHr && kind !== "MANAGER_INTRO" && kind !== "CHECKIN") return NO("Managers can schedule introductions and check-ins; orientation is for onboarding HR.");
  const title = str(f, "title"), startsAt = dt(str(f, "startsAt")), endsAt = dt(str(f, "endsAt"));
  if (!title) return { ok: false, message: "Give the session a title.", errors: { title: "Required" } };
  if (!startsAt || !endsAt || endsAt <= startsAt) return NO("Pick a start and an end after it.");
  const attendees = list(f, "attendeeIds");
  const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: attendees }, status: { notIn: ["EXITED"] } }, select: { id: true } });
  if (people.length !== attendees.length) return NO("Some attendees were not found.");
  if (!isHr) for (const a of attendees) if (!(await managesEmployee(viewer, a))) return NO("Managers can only invite their own team.");
  const capacity = num(f, "capacity");
  if (capacity !== null && (Number.isNaN(capacity) || capacity < 1)) return NO("Capacity must be at least 1.");
  if (capacity && attendees.length > capacity) return NO(`Only ${capacity} place(s); ${attendees.length} invited.`);
  const courseId = str(f, "courseId") || null;
  if (courseId && !(await prisma.course.count({ where: { id: courseId, tenantId: viewer.tenantId } }))) return NO("Course not found.");
  const host = str(f, "hostEmployeeId") || viewer.employee?.id || null;
  if (host && !(await tenantEmployee(viewer, host))) return NO("Host not found.");
  const s = await prisma.orientationSession.create({
    data: { tenantId: viewer.tenantId, title: title.slice(0, 120), kind, startsAt, endsAt, location: str(f, "location") || null, meetingLink: str(f, "meetingLink") || null, hostEmployeeId: host, capacity: capacity ?? null, agenda: str(f, "agenda") || null, courseId, createdBy: viewer.user.id, attendees: { create: attendees.map((employeeId) => ({ employeeId })) } },
  });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "OrientationSession", entityId: s.id, summary: `Drafted ${kind.toLowerCase().replace("_", " ")} "${s.title}" with ${attendees.length} attendee(s)` });
  return done(PATHS, "Drafted. Submit it for approval to send the invitations.");
}

export async function orientationOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const s = await prisma.orientationSession.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId }, include: { attendees: true } });
  if (!s) return NO("Session not found.");
  const owner = s.createdBy === viewer.user.id || can(viewer, P.ONBOARDING_MANAGE);
  if (!owner) return NO("Only its organiser or onboarding HR can change this session.");
  const op = str(f, "op");
  if (op === "submit") {
    if (!["DRAFT", "REJECTED"].includes(s.status)) return NO("Only a draft can be submitted.");
    await prisma.orientationSession.update({ where: { id: s.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ORIENTATION_SESSION", entityId: s.id, title: `Schedule: ${s.title}`, details: `${s.startsAt.toISOString()} · ${s.attendees.length} attendee(s)`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.orientationSession.update({ where: { id: s.id }, data: { status: s.status } }); return NO(wf.message); }
    await prisma.orientationSession.update({ where: { id: s.id }, data: { workflowRequestId: wf.requestId } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "OrientationSession", entityId: s.id, summary: `Submitted "${s.title}" for approval` });
    return done(PATHS, wf.message);
  }
  if (op === "cancel") {
    if (["COMPLETED", "CANCELLED"].includes(s.status)) return NO("Already closed.");
    await prisma.orientationSession.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
    const users = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: s.attendees.map((a) => a.employeeId) } }, select: { userId: true } });
    if (s.status === "SCHEDULED") await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "LIFECYCLE", title: `Cancelled: ${s.title}`, link: "/me/onboarding" });
  } else if (op === "complete") {
    if (s.status !== "SCHEDULED") return NO("Only a scheduled session can be completed.");
    await prisma.orientationSession.update({ where: { id: s.id }, data: { status: "COMPLETED" } });
    await prisma.orientationAttendee.updateMany({ where: { sessionId: s.id, status: { in: ["INVITED", "CONFIRMED"] } }, data: { status: "NO_SHOW" } });
  } else if (op === "attend") {
    const a = s.attendees.find((x) => x.employeeId === str(f, "employeeId"));
    if (!a) return NO("Not an attendee.");
    const status = str(f, "status");
    if (!["ATTENDED", "NO_SHOW"].includes(status)) return NO("Mark attended or no-show.");
    await prisma.orientationAttendee.update({ where: { id: a.id }, data: { status } });
  } else if (op === "invite") {
    const emp = await tenantEmployee(viewer, str(f, "employeeId"));
    if (!emp) return NO("Employee not found.");
    if (s.capacity && s.attendees.length >= s.capacity) return NO("The session is full.");
    await prisma.orientationAttendee.upsert({ where: { sessionId_employeeId: { sessionId: s.id, employeeId: emp.id } }, create: { sessionId: s.id, employeeId: emp.id }, update: {} });
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "OrientationSession", entityId: s.id, summary: `"${s.title}": ${op}` });
  return done(PATHS, "Updated.");
}

export async function rsvpOrientationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const a = await prisma.orientationAttendee.findFirst({ where: { sessionId: str(f, "sessionId"), employeeId: viewer.employee.id, session: { tenantId: viewer.tenantId, status: "SCHEDULED" } } });
  if (!a) return NO("You are not invited to that session.");
  const r = str(f, "response");
  if (!["CONFIRMED", "DECLINED"].includes(r)) return NO("Accept or decline.");
  await prisma.orientationAttendee.update({ where: { id: a.id }, data: { status: r, respondedAt: new Date() } });
  return done(PATHS, r === "CONFIRMED" ? "See you there." : "Declined.");
}

// ---------------------------------------------------------------------------
//  Milestones
// ---------------------------------------------------------------------------

export async function generateMilestonesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.ONBOARDING_MANAGE);
  if (!emp) return NO("That employee is outside your scope.");
  const n = await generateMilestones(viewer.tenantId, emp.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "OnboardingMilestone", entityId: emp.id, summary: `Set up first-week and 30/60/90-day milestones for ${emp.displayName}` });
  return done(PATHS, n ? `Added ${n} milestone(s) for ${emp.displayName}.` : `${emp.displayName} already has every milestone.`);
}

/** The manager's (or HR's) review at a milestone. */
export async function reviewMilestoneAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const m = await prisma.onboardingMilestone.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!m || !(await hrOrManager(viewer, m.employeeId))) return NO("Milestone not found.");
  const op = str(f, "op");
  if (op === "objectives") {
    await prisma.onboardingMilestone.update({ where: { id: m.id }, data: { objectives: str(f, "objectives") || null } });
    return done(PATHS, "Objectives saved.");
  }
  if (m.status !== "PENDING") return NO("This milestone is closed.");
  const rating = num(f, "rating");
  if (!rating || rating < 1 || rating > 5) return NO("Rate progress 1 to 5.");
  const now = new Date();
  await prisma.onboardingMilestone.update({ where: { id: m.id }, data: { managerRating: Math.round(rating), managerNote: str(f, "note") || null, managerDoneAt: now, ...(m.hireDoneAt ? { status: "COMPLETED", completedAt: now } : {}) } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "OnboardingMilestone", entityId: m.id, summary: `Reviewed the ${m.kind.replace("_", " ").toLowerCase()} milestone (${rating}/5)` });
  return done(PATHS, "Review saved.");
}

/** Issue the onboarding completion certificate for a finished joining journey. */
export async function issueOnboardingCertificateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const j = await prisma.journey.findFirst({ where: { id: str(f, "journeyId"), tenantId: viewer.tenantId, trigger: "JOINING" }, include: { employee: { select: { displayName: true, userId: true } } } });
  if (!j || !(await scopedEmployee(viewer, j.employeeId, P.ONBOARDING_MANAGE))) return NO("Journey not found.");
  if (j.status !== "COMPLETED") return NO("Onboarding is not complete yet.");
  if (j.certificateIssuedAt) return NO("The certificate has already been issued.");
  await prisma.journey.update({ where: { id: j.id }, data: { certificateIssuedAt: new Date() } });
  await notify({ tenantId: viewer.tenantId, userIds: [j.employee.userId], kind: "LIFECYCLE", title: "Your onboarding completion certificate is ready", link: `/onboarding/certificate/${j.id}` });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "Journey", entityId: j.id, summary: `Issued the onboarding completion certificate to ${j.employee.displayName}` });
  return done([...PATHS, `/onboarding/${j.id}`, `/onboarding/certificate/${j.id}`], "Certificate issued.");
}

/** The new hire's own feedback at a checkpoint. */
export async function milestoneFeedbackAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const m = await prisma.onboardingMilestone.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
  if (!m) return NO("Milestone not found.");
  if (m.hireDoneAt) return NO("You have already given feedback for this checkpoint.");
  const rating = num(f, "rating");
  if (!rating || rating < 1 || rating > 5) return NO("Rate your experience 1 to 5.");
  const now = new Date();
  await prisma.onboardingMilestone.update({ where: { id: m.id }, data: { hireRating: Math.round(rating), hireComment: str(f, "comment") || null, hireDoneAt: now, ...(m.managerDoneAt ? { status: "COMPLETED", completedAt: now } : {}) } });
  const mgr = await prisma.employee.findFirst({ where: { id: viewer.employee.id }, select: { reportingManager: { select: { userId: true } } } });
  await notify({ tenantId: viewer.tenantId, userIds: [mgr?.reportingManager?.userId], kind: "LIFECYCLE", title: `${viewer.employee.displayName} gave ${m.kind.replace("_", " ").toLowerCase()} feedback`, link: "/onboarding/people?tab=milestones" });
  return done(PATHS, "Thanks — your feedback is with your manager and HR.");
}

