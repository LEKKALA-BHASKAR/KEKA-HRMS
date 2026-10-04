"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { notify, internalEligibility, requestJobChange, reviewStep } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { reaches, inLine, field, dateField, intField } from "@/lib/growth";

/**
 * Career and internal mobility: jobs posted internally and the employee's
 * application (endorsed by their manager, decided by HR), transfer and role
 * change requests (manager, then HR, whose approval raises the job change),
 * career aspirations endorsed by the manager, and career paths that go
 * through approval before employees can aim for them.
 */

const P = PERMISSIONS;
const PATHS = ["/me/career", "/performance/careers", "/performance/mobility"];
const NO = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ ok: false, message, ...extra });

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string) {
  await writeAudit(viewer, { module: "EMPLOYEE", action, entityType, entityId, summary });
}

async function managerUserOf(employeeId: string) {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { reportingManagerId: true, reportingManager: { select: { userId: true } } } });
  return { managerId: e?.reportingManagerId ?? null, managerUserId: e?.reportingManager?.userId ?? null };
}

async function hrUsers(viewer: Viewer, permission: string) {
  const users = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { not: viewer.user.id }, roleAssignments: { some: { role: { permissions: { some: { permission } } } } } }, select: { id: true } });
  return users.map((u) => u.id);
}

// ---------------------------------------------------------------------------
//  Internal job postings
// ---------------------------------------------------------------------------

export async function setInternalPostingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const job = await prisma.job.findFirst({ where: { id: field(formData, "jobId", 40), tenantId: viewer.tenantId } });
  if (!job) return NO("Job not found.");
  const allowInternal = formData.get("allowInternal") === "on";
  const internalMinTenureMonths = intField(formData, "internalMinTenureMonths", 0, 120);
  if (internalMinTenureMonths === undefined) return NO("Minimum service is a whole number of months, up to 120.", { errors: { internalMinTenureMonths: "0–120" } });
  const internalClosesAt = dateField(formData, "internalClosesAt");
  if (allowInternal && job.status !== "OPEN") return NO("Open the job before posting it internally.");
  await prisma.job.update({ where: { id: job.id }, data: { allowInternal, internalClosesAt, internalMinTenureMonths } });
  if (allowInternal && !job.allowInternal) {
    const everyone = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["CONFIRMED", "PROBATION"] } }, select: { userId: true }, take: 2000 });
    await notify({ tenantId: viewer.tenantId, userIds: everyone.map((e) => e.userId), kind: "CAREER", title: `New internal opening: ${job.title}`, link: "/me/career?tab=jobs" });
  }
  await audit(viewer, "UPDATE", "Job", job.id, `${allowInternal ? "Posted" : "Withdrew"} ${job.title} ${allowInternal ? "internally" : "from internal posting"}${internalClosesAt ? ` until ${internalClosesAt.toISOString().slice(0, 10)}` : ""}`);
  return done([...PATHS, "/hiring/jobs"], allowInternal ? "Posted to the internal job board." : "Removed from the internal job board.");
}

export async function applyInternalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("Only employees can apply internally.");
  const job = await prisma.job.findFirst({ where: { id: field(formData, "jobId", 40), tenantId: viewer.tenantId } });
  if (!job) return NO("Job not found.");
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: me.id }, select: { dateOfJoining: true, status: true } });
  const onActivePip = (await prisma.improvementPlan.count({ where: { employeeId: me.id, status: "ACTIVE" } })) > 0;
  const ok = internalEligibility(job, { ...emp, onActivePip });
  if (!ok.ok) return NO(ok.message);
  const existing = await prisma.internalApplication.findUnique({ where: { jobId_employeeId: { jobId: job.id, employeeId: me.id } } });
  if (existing && existing.status !== "WITHDRAWN") return NO("You have already applied for this job.");
  const { managerId, managerUserId } = await managerUserOf(me.id);
  const data = { coverNote: field(formData, "coverNote", 2000) || null, status: "APPLIED", managerId, managerNote: null, managerDecidedAt: null, hrDecidedBy: null, hrDecidedAt: null, hrNote: null };
  const a = existing ? await prisma.internalApplication.update({ where: { id: existing.id }, data }) : await prisma.internalApplication.create({ data: { ...data, tenantId: viewer.tenantId, jobId: job.id, employeeId: me.id } });
  await notify({ tenantId: viewer.tenantId, userIds: managerUserId ? [managerUserId] : await hrUsers(viewer, P.MOBILITY_MANAGE), kind: "CAREER", title: `${me.displayName} applied internally for ${job.title}`, link: "/performance/mobility" });
  await audit(viewer, "CREATE", "InternalApplication", a.id, `Applied internally for ${job.title}`);
  return done(PATHS, managerId ? "Applied — your manager is asked to endorse it." : "Applied — HR will review it.");
}

export async function withdrawInternalApplicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const a = await prisma.internalApplication.findFirst({ where: { id: field(formData, "applicationId", 40), tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__" }, include: { job: true } });
  if (!a) return NO("Application not found.");
  if (!["APPLIED", "ENDORSED", "SHORTLISTED"].includes(a.status)) return NO("This application is already closed.");
  await prisma.internalApplication.update({ where: { id: a.id }, data: { status: "WITHDRAWN" } });
  await audit(viewer, "UPDATE", "InternalApplication", a.id, `Withdrew the internal application for ${a.job.title}`);
  return done(PATHS, "Withdrawn.");
}

/** The applicant's manager endorses or declines. */
export async function endorseInternalApplicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const a = await prisma.internalApplication.findFirst({ where: { id: field(formData, "applicationId", 40), tenantId: viewer.tenantId }, include: { job: true, employee: { select: { userId: true, displayName: true } } } });
  if (!a) return NO("Application not found.");
  if (a.status !== "APPLIED") return NO("This application is not waiting for the manager.");
  if (!inLine(viewer, a.employeeId)) return NO("Only the applicant's manager can endorse.");
  const decision = field(formData, "decision", 10);
  const note = field(formData, "note", 1000);
  if (decision !== "endorse" && decision !== "decline") return NO("Endorse or decline.");
  if (decision === "decline" && !note) return NO("Say why, so they can talk it through with you.", { errors: { note: "Required" } });
  await prisma.internalApplication.update({ where: { id: a.id }, data: { status: decision === "endorse" ? "ENDORSED" : "MANAGER_DECLINED", managerNote: note || null, managerDecidedAt: new Date() } });
  await notify({ tenantId: viewer.tenantId, userIds: decision === "endorse" ? await hrUsers(viewer, P.MOBILITY_MANAGE) : [a.employee.userId], kind: "CAREER", title: decision === "endorse" ? `Endorsed internal applicant for ${a.job.title}: ${a.employee.displayName}` : `Your application for ${a.job.title} was not endorsed`, body: note || null, link: decision === "endorse" ? "/performance/mobility" : "/me/career?tab=jobs" });
  await audit(viewer, decision === "endorse" ? "APPROVE" : "REJECT", "InternalApplication", a.id, `${decision === "endorse" ? "Endorsed" : "Declined"} ${a.employee.displayName}'s application for ${a.job.title}`);
  return done(PATHS, decision === "endorse" ? "Endorsed — HR will take it from here." : "Declined.");
}

/** HR moves an endorsed application on: shortlist, select or reject. */
export async function decideInternalApplicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.MOBILITY_MANAGE);
  const a = await prisma.internalApplication.findFirst({ where: { id: field(formData, "applicationId", 40), tenantId: viewer.tenantId }, include: { job: true, employee: { select: { userId: true, displayName: true } } } });
  if (!a) return NO("Application not found.");
  if (a.employeeId === viewer.employee?.id) return NO("You cannot decide your own application.");
  const decision = field(formData, "decision", 12);
  const note = field(formData, "note", 1000);
  const allowed: Record<string, string[]> = { shortlist: ["ENDORSED", ...(a.managerId ? [] : ["APPLIED"])], select: ["SHORTLISTED"], reject: ["APPLIED", "ENDORSED", "SHORTLISTED"] };
  if (!allowed[decision]) return NO("Shortlist, select or reject.");
  if (!allowed[decision].includes(a.status)) return NO(a.status === "APPLIED" ? "Waiting for the manager's endorsement." : "That is not the next step for this application.");
  if (decision === "reject" && !note) return NO("Give the applicant a reason.", { errors: { note: "Required" } });
  const status = decision === "shortlist" ? "SHORTLISTED" : decision === "select" ? "SELECTED" : "REJECTED";
  await prisma.internalApplication.update({ where: { id: a.id }, data: { status, hrDecidedBy: viewer.user.id, hrDecidedAt: new Date(), hrNote: note || a.hrNote } });
  await notify({ tenantId: viewer.tenantId, userIds: [a.employee.userId], kind: "CAREER", title: `${a.job.title}: ${status === "SELECTED" ? "you have been selected" : status === "SHORTLISTED" ? "you are shortlisted" : "not taken forward"}`, body: note || null, link: "/me/career?tab=jobs" });
  await audit(viewer, status === "REJECTED" ? "REJECT" : "APPROVE", "InternalApplication", a.id, `${status.toLowerCase()} ${a.employee.displayName} for ${a.job.title}`);
  return done(PATHS, `Marked ${status.toLowerCase()}.`);
}

// ---------------------------------------------------------------------------
//  Transfer and role-change requests
// ---------------------------------------------------------------------------

export async function requestMobilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("Only employees can request a move.");
  const kind = field(formData, "kind", 20);
  if (!["TRANSFER", "ROLE_CHANGE", "RELOCATION"].includes(kind)) return NO("Choose the kind of move.");
  const toDepartmentId = field(formData, "toDepartmentId", 40) || null, toLocationId = field(formData, "toLocationId", 40) || null, toJobTitleId = field(formData, "toJobTitleId", 40) || null;
  if (!toDepartmentId && !toLocationId && !toJobTitleId) return NO("Say where you would like to move — a department, location or role.");
  const [dept, loc, title] = await Promise.all([
    toDepartmentId ? prisma.department.count({ where: { id: toDepartmentId, tenantId: viewer.tenantId } }) : 1,
    toLocationId ? prisma.location.count({ where: { id: toLocationId, tenantId: viewer.tenantId } }) : 1,
    toJobTitleId ? prisma.jobTitle.count({ where: { id: toJobTitleId, tenantId: viewer.tenantId } }) : 1,
  ]);
  if (!dept || !loc || !title) return NO("A chosen department, location or role was not found.");
  const reason = field(formData, "reason", 2000);
  if (!reason) return NO("Say why you would like to move.", { errors: { reason: "Required" } });
  if (await prisma.mobilityRequest.count({ where: { employeeId: me.id, status: { in: ["PENDING_MANAGER", "PENDING_HR"] } } })) return NO("You already have a move request open.");
  const { managerId, managerUserId } = await managerUserOf(me.id);
  const r = await prisma.mobilityRequest.create({
    data: { tenantId: viewer.tenantId, employeeId: me.id, kind, toDepartmentId, toLocationId, toJobTitleId, preferredDate: dateField(formData, "preferredDate"), reason, managerId, status: managerId ? "PENDING_MANAGER" : "PENDING_HR" },
  });
  await notify({ tenantId: viewer.tenantId, userIds: managerUserId ? [managerUserId] : await hrUsers(viewer, P.MOBILITY_MANAGE), kind: "CAREER", title: `${me.displayName} asks for a ${kind.replace("_", " ").toLowerCase()}`, link: "/performance/mobility" });
  await audit(viewer, "CREATE", "MobilityRequest", r.id, `Requested a ${kind.toLowerCase()}`);
  return done(PATHS, managerId ? "Sent to your manager." : "Sent to HR.");
}

export async function withdrawMobilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.mobilityRequest.findFirst({ where: { id: field(formData, "requestId", 40), tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__" } });
  if (!r) return NO("Request not found.");
  if (!["PENDING_MANAGER", "PENDING_HR"].includes(r.status)) return NO("This request is already decided.");
  await prisma.mobilityRequest.update({ where: { id: r.id }, data: { status: "WITHDRAWN" } });
  await audit(viewer, "UPDATE", "MobilityRequest", r.id, "Withdrew a move request");
  return done(PATHS, "Withdrawn.");
}

/**
 * The manager endorses (on to HR) or declines; HR approves — raising the job
 * change, which runs its own approval chain and effective date — or rejects.
 */
export async function decideMobilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.mobilityRequest.findFirst({ where: { id: field(formData, "requestId", 40), tenantId: viewer.tenantId }, include: { employee: { select: { userId: true, displayName: true } } } });
  if (!r) return NO("Request not found.");
  if (r.employeeId === viewer.employee?.id) return NO("You cannot decide your own request.");
  const decision = field(formData, "decision", 10);
  const note = field(formData, "note", 1000);
  if (decision !== "approve" && decision !== "reject") return NO("Approve or reject.");
  if (decision === "reject" && !note) return NO("Give a reason.", { errors: { note: "Required" } });
  if (r.status === "PENDING_MANAGER") {
    if (!inLine(viewer, r.employeeId)) return NO("Waiting for the employee's manager.");
    await prisma.mobilityRequest.update({ where: { id: r.id }, data: { status: decision === "approve" ? "PENDING_HR" : "REJECTED", managerNote: note || null, managerDecidedAt: new Date() } });
    await notify({ tenantId: viewer.tenantId, userIds: decision === "approve" ? await hrUsers(viewer, P.MOBILITY_MANAGE) : [r.employee.userId], kind: "CAREER", title: decision === "approve" ? `Move request endorsed: ${r.employee.displayName}` : "Your move request was declined", body: note || null, link: decision === "approve" ? "/performance/mobility" : "/me/career?tab=moves" });
    await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "MobilityRequest", r.id, `Manager ${decision === "approve" ? "endorsed" : "declined"} ${r.employee.displayName}'s move request`);
    return done(PATHS, decision === "approve" ? "Endorsed — on to HR." : "Declined.");
  }
  if (r.status !== "PENDING_HR") return NO("This request is already decided.");
  if (!can(viewer, P.MOBILITY_MANAGE) || !(await reaches(viewer, r.employeeId, P.MOBILITY_MANAGE))) return NO("HR decides this request.");
  if (decision === "reject") {
    await prisma.mobilityRequest.update({ where: { id: r.id }, data: { status: "REJECTED", hrDecidedBy: viewer.user.id, hrDecidedAt: new Date(), hrNote: note } });
    await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "CAREER", title: "Your move request was not approved", body: note, link: "/me/career?tab=moves" });
    await audit(viewer, "REJECT", "MobilityRequest", r.id, `HR rejected ${r.employee.displayName}'s move request: ${note}`);
    return done(PATHS, "Rejected.");
  }
  const effectiveFrom = dateField(formData, "effectiveFrom") ?? r.preferredDate;
  if (!effectiveFrom) return NO("Give the date the move takes effect.", { errors: { effectiveFrom: "Required" } });
  const reason = r.kind === "ROLE_CHANGE" ? "PROMOTION" : r.toDepartmentId && !r.toLocationId ? "DEPARTMENT_CHANGE" : r.toLocationId && !r.toDepartmentId ? "LOCATION_CHANGE" : "TRANSFER";
  const change = await requestJobChange({
    tenantId: viewer.tenantId, employeeId: r.employeeId, requestedBy: viewer.user.id, holdUntilEffective: true,
    fields: { effectiveFrom, reason, departmentId: r.toDepartmentId, locationId: r.toLocationId, jobTitleId: r.toJobTitleId, note: `Internal move request: ${r.reason}`.slice(0, 500), logActivity: true },
    summary: `Internal move for ${r.employee.displayName}`,
  });
  await prisma.mobilityRequest.update({ where: { id: r.id }, data: { status: "APPROVED", hrDecidedBy: viewer.user.id, hrDecidedAt: new Date(), hrNote: note || null, jobChangeId: change.jobChangeId } });
  await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "CAREER", title: "Your move request is approved", body: `Effective ${effectiveFrom.toISOString().slice(0, 10)}.`, link: "/me/career?tab=moves" });
  await audit(viewer, "APPROVE", "MobilityRequest", r.id, `HR approved ${r.employee.displayName}'s move effective ${effectiveFrom.toISOString().slice(0, 10)} (job change ${change.status.toLowerCase()})`);
  return done([...PATHS, "/inbox"], change.status === "PENDING_APPROVAL" ? "Approved; the job change is now in its approval chain." : change.status === "SCHEDULED" ? "Approved; the job change is scheduled for its date." : "Approved and applied.");
}

// ---------------------------------------------------------------------------
//  Career aspirations
// ---------------------------------------------------------------------------

/** The manager endorses (or declines) the rung an employee is aiming for. */
export async function endorseAspirationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const a = await prisma.careerAspiration.findFirst({ where: { id: field(formData, "aspirationId", 40), employee: { tenantId: viewer.tenantId } }, include: { step: true, employee: { select: { userId: true, displayName: true } } } });
  if (!a) return NO("Aspiration not found.");
  if (!(await reaches(viewer, a.employeeId, P.CAREER_PATH_MANAGE))) return NO("Only their manager or a careers admin can endorse this.");
  const decision = field(formData, "decision", 10);
  const note = field(formData, "note", 1000);
  if (decision !== "endorse" && decision !== "decline") return NO("Endorse or decline.");
  if (decision === "decline" && !note) return NO("Say why, and what would help.", { errors: { note: "Required" } });
  await prisma.careerAspiration.update({ where: { id: a.id }, data: { status: decision === "endorse" ? "ENDORSED" : "DECLINED", managerNote: note || null, endorsedBy: viewer.user.id, endorsedAt: new Date() } });
  await notify({ tenantId: viewer.tenantId, userIds: [a.employee.userId], kind: "CAREER", title: `Your goal of ${a.step.title} was ${decision === "endorse" ? "endorsed" : "not endorsed"}`, body: note || null, link: "/me/career" });
  await audit(viewer, decision === "endorse" ? "APPROVE" : "REJECT", "CareerAspiration", a.id, `${decision === "endorse" ? "Endorsed" : "Declined"} ${a.employee.displayName}'s aspiration to ${a.step.title}`);
  return done(PATHS, decision === "endorse" ? "Endorsed." : "Declined.");
}

// ---------------------------------------------------------------------------
//  Career paths: edit, remove, approve
// ---------------------------------------------------------------------------

export async function updateCareerPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const p = await prisma.careerPath.findFirst({ where: { id: field(formData, "pathId", 40), tenantId: viewer.tenantId } });
  if (!p) return NO("Career path not found.");
  const name = field(formData, "name", 100);
  if (!name) return NO("Name the path.", { errors: { name: "Required" } });
  if (await prisma.careerPath.count({ where: { tenantId: viewer.tenantId, name: { equals: name, mode: "insensitive" }, NOT: { id: p.id } } })) return NO("Another path has that name.");
  const departmentId = field(formData, "departmentId", 40) || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return NO("Department not found.");
  await prisma.careerPath.update({ where: { id: p.id }, data: { name, description: field(formData, "description", 500) || null, departmentId } });
  await audit(viewer, "UPDATE", "CareerPath", p.id, `Updated career path "${name}"`);
  return done(PATHS, "Saved.");
}

export async function deleteCareerPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const p = await prisma.careerPath.findFirst({ where: { id: field(formData, "pathId", 40), tenantId: viewer.tenantId }, include: { steps: { include: { _count: { select: { aspirants: true } } } } } });
  if (!p) return NO("Career path not found.");
  const aspirants = p.steps.reduce((s, x) => s + x._count.aspirants, 0);
  if (aspirants) return NO(`${aspirants} people are working towards a step on this path.`);
  await prisma.careerPath.delete({ where: { id: p.id } });
  await audit(viewer, "DELETE", "CareerPath", p.id, `Deleted career path "${p.name}"`);
  return done(PATHS, "Deleted.");
}

export async function updateCareerStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const s = await prisma.careerPathStep.findFirst({ where: { id: field(formData, "stepId", 40), path: { tenantId: viewer.tenantId } }, include: { _count: { select: { aspirants: true } } } });
  if (!s) return NO("Step not found.");
  if (field(formData, "op", 10) === "delete") {
    if (s._count.aspirants) return NO("People are working towards this step.");
    await prisma.careerPathStep.delete({ where: { id: s.id } });
    await audit(viewer, "DELETE", "CareerPathStep", s.id, `Removed step "${s.title}"`);
    return done(PATHS, "Step removed.");
  }
  const title = field(formData, "title", 100);
  if (!title) return NO("Name the step.", { errors: { title: "Required" } });
  const minYears = intField(formData, "minYears", 0, 40);
  if (minYears === undefined) return NO("Years is 0 to 40.");
  await prisma.careerPathStep.update({ where: { id: s.id }, data: { title, description: field(formData, "description", 500) || null, minYears: minYears ?? 0 } });
  await audit(viewer, "UPDATE", "CareerPathStep", s.id, `Updated step "${title}"`);
  return done(PATHS, "Saved.");
}

/** New paths are drafts; a second careers admin approves them before employees can aim for them. */
export async function careerPathReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const p = await prisma.careerPath.findFirst({ where: { id: field(formData, "pathId", 40), tenantId: viewer.tenantId }, include: { _count: { select: { steps: true } } } });
  if (!p) return NO("Career path not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  if (op === "submit" && p._count.steps === 0) return NO("Add the path's steps first.");
  const step = reviewStep(p.status, op, { actor: viewer.user.id, submittedBy: p.submittedBy, note });
  if (!step.ok) return NO(step.message);
  if (step.next === "ARCHIVED") return NO("Delete a path you no longer need.");
  await prisma.careerPath.update({
    where: { id: p.id },
    data: { status: step.next, ...(op === "submit" ? { submittedBy: viewer.user.id } : {}), ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}) },
  });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "CareerPath", p.id, `${op} career path "${p.name}"${note ? `: ${note}` : ""}`);
  return done(PATHS, op === "approve" ? "Approved — employees can now aim for its steps." : op === "submit" ? "Submitted for approval." : op === "reject" ? "Sent back." : "Done.");
}
