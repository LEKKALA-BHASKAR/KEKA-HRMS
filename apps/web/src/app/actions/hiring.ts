"use server";

import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  openJobFromRequisition, applyCandidate, moveStage, rejectApplication, scheduleInterview,
  draftOffer, approveOffer, extendOffer, recordOfferResponse, completeHire, notify,
  raiseRequisition, updateRequisition, decideRequisitions, archiveRequisition, isSuperApprover, saveScorecard,
  requisitionProblems, parseKit, plainText, type RequisitionInput,
} from "@keka/services";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formValues,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zId, zRequiredEmail, type ActionState,
} from "@/lib/forms";
import { createEmployee } from "./employee";

const P = PERMISSIONS;
const values = (f: FormData) => formValues(f);
const REQ_PATHS = ["/hiring/requisitions", "/inbox"];

async function inTenant<T extends { tenantId: string }>(viewer: { tenantId: string }, row: T | null): Promise<T | null> {
  return row && row.tenantId === viewer.tenantId ? row : null;
}

// --- Requisitions -----------------------------------------------------------------

/**
 * Read the Create/Edit Requisition form. Backfills come as parallel lists
 * (`backfillEmployeeId`, `backfillReason`); the job title id is looked up
 * from the typed title rather than trusted from the form.
 */
async function readRequisition(viewer: Viewer, f: FormData): Promise<{ input: RequisitionInput; errors: Record<string, string> }> {
  const v = formValues(f);
  const num = (k: string) => (v[k] ? Number(v[k]) : null);
  const ids = f.getAll("backfillEmployeeId").map(String);
  const reasons = f.getAll("backfillReason").map(String);
  const backfillOn = v.backfill === "on";
  const backfills = backfillOn ? ids.map((employeeId, i) => ({ employeeId, reason: reasons[i] ?? "" })).filter((b) => b.employeeId) : [];
  const title = (v.title ?? "").slice(0, 120);
  const jobTitle = title ? await prisma.jobTitle.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: title, mode: "insensitive" } }, select: { id: true } }) : null;
  const dateRaw = v.targetStartDate;
  const targetStartDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? new Date(`${dateRaw}T00:00:00Z`) : null;
  const input: RequisitionInput = {
    title, jobTitleId: jobTitle?.id ?? null, isPriority: v.isPriority === "on",
    departmentId: v.departmentId ?? "", minExperienceYears: num("minExperienceYears"),
    newHire: v.newHire === "on", newPositions: Math.trunc(num("newPositions") ?? 0), backfills,
    locationId: v.locationId || null, targetStartDate,
    currency: v.currency || "INR", salaryMin: num("salaryMin"), salaryMax: num("salaryMax"), salaryFrequency: v.salaryFrequency || null,
    jobType: v.jobType === "PART_TIME" ? "PART_TIME" : "FULL_TIME",
    employmentType: ["PERMANENT", "CONTRACT", "INTERN", "CONSULTANT"].includes(v.employmentType ?? "") ? v.employmentType! : null,
    description: (v.description ?? "").slice(0, 20000), justification: (v.justification ?? "").slice(0, 2000) || null,
    hiringManagerId: v.hiringManagerId || null, recruiterId: v.recruiterId || null,
  };
  const errors = requisitionProblems({ ...input, departmentId: input.departmentId || null }, new Date());
  if (dateRaw && !targetStartDate) errors.targetStartDate = "Use a valid date";
  for (const k of ["minExperienceYears", "newPositions", "salaryMin", "salaryMax"]) if (v[k] && Number.isNaN(Number(v[k]))) errors[k] = "Enter a number";
  if (input.minExperienceYears !== null && (input.minExperienceYears < 0 || input.minExperienceYears > 50)) errors.minExperienceYears = "Between 0 and 50 years";
  if (backfillOn && backfills.length === 0) errors.backfills = "Select the employees this requisition backfills";
  return { input, errors };
}

/** Every id the form names must be this tenant's; backfilled people must still be here. */
async function referencesProblem(viewer: Viewer, input: RequisitionInput): Promise<string | null> {
  const foreign = await foreignReference(viewer.tenantId, {
    department: input.departmentId, location: input.locationId,
    employee: [...input.backfills.map((b) => b.employeeId), input.hiringManagerId], user: input.recruiterId,
  });
  if (foreign) return foreign;
  if (input.backfills.length) {
    const gone = await prisma.employee.count({ where: { tenantId: viewer.tenantId, id: { in: input.backfills.map((b) => b.employeeId) }, status: "EXITED" } });
    if (gone) return "A backfilled employee has already left; raise a new hire instead.";
  }
  return null;
}

export async function raiseRequisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REQUISITION_MANAGE);
  const { input, errors } = await readRequisition(viewer, formData);
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors, values: values(formData) };
  const bad = await referencesProblem(viewer, input);
  if (bad) return { ok: false, message: bad, values: values(formData) };
  const res = await raiseRequisition(viewer.tenantId, input, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message, values: values(formData) };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Requisition", entityId: res.id!, summary: "Created Requisition", newValue: { code: res.code, title: input.title } });
  return { ...done(REQ_PATHS, res.message), values: { id: res.id! } };
}

export async function updateRequisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const r = await prisma.requisition.findFirst({ where: { tenantId: viewer.tenantId, id }, select: { id: true, raisedBy: true } });
  if (!r) return { ok: false, message: "Requisition not found." };
  if (!canAny(viewer, [P.REQUISITION_MANAGE, P.REQUISITION_APPROVE]) && r.raisedBy !== viewer.user.id) return { ok: false, message: "You cannot edit requisitions." };
  const { input, errors } = await readRequisition(viewer, formData);
  // An approved requisition may keep a target date that has since passed.
  delete errors.targetStartDate;
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors, values: values(formData) };
  const bad = await referencesProblem(viewer, input);
  if (bad) return { ok: false, message: bad, values: values(formData) };
  const res = await updateRequisition(viewer.tenantId, id, input, { userId: viewer.user.id, canManage: can(viewer, P.REQUISITION_MANAGE), canApprove: can(viewer, P.REQUISITION_APPROVE) });
  if (!res.ok) return { ok: false, message: res.message, values: values(formData) };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Requisition", entityId: id, summary: res.changes?.length ? `Edited: ${res.changes.join(", ")}` : "Edited requisition" });
  return { ...done(REQ_PATHS, res.message), values: { id } };
}

/** Approve or reject one or many requisitions (the Pending Approvals checkboxes, or Take Action). */
export async function bulkDecideRequisitionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { ok: false, message: "Unknown decision." };
  const actor = { userId: viewer.user.id, canApprove: can(viewer, P.REQUISITION_APPROVE), superApprover: await isSuperApprover(viewer.tenantId, viewer.user.id) };
  const res = await decideRequisitions({ tenantId: viewer.tenantId, ids, approve: decision === "approve", reason: String(formData.get("reason") ?? "") || null, actor });
  for (const d of res.done) {
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: decision === "approve" ? "APPROVE" : "REJECT", entityType: "Requisition", entityId: d.id,
      summary: decision === "approve" ? "Approved Requisition" : `Rejected Requisition: ${String(formData.get("reason") ?? "").trim()}`,
    });
  }
  return res.ok ? done(REQ_PATHS, res.message) : { ok: false, message: res.message };
}

/** Kept for existing callers: one requisition, `id` + `decision` (+ `reason`). */
export async function decideRequisitionAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const f = new FormData();
  f.append("ids", String(formData.get("id") ?? ""));
  f.set("decision", String(formData.get("decision") ?? ""));
  if (formData.get("reason")) f.set("reason", String(formData.get("reason")));
  return bulkDecideRequisitionsAction(prev, f);
}

export async function archiveRequisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REQUISITION_MANAGE);
  const id = String(formData.get("id") ?? "");
  const archive = formData.get("archive") !== "0";
  const res = await archiveRequisition(viewer.tenantId, id, viewer.user.id, archive);
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Requisition", entityId: id, summary: archive ? "Archived Requisition" : "Restored Requisition" });
  return res.ok ? done(REQ_PATHS, res.message) : { ok: false, message: res.message };
}

export async function openJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const id = String(formData.get("requisitionId"));
  if (!(await inTenant(viewer, await prisma.requisition.findUnique({ where: { id } })))) return { ok: false, message: "Requisition not found." };
  const hm = String(formData.get("hiringManagerId") ?? "") || null;
  const foreign = await foreignReference(viewer.tenantId, { employee: hm });
  if (foreign) return { ok: false, message: foreign };
  const res = await openJobFromRequisition(id, { hiringManagerId: hm, recruiterId: viewer.user.id, description: String(formData.get("description") ?? "") || null });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Job", entityId: res.jobId!, summary: `Opened a job from requisition: ${res.message}` });
  return res.ok ? done([...REQ_PATHS, "/hiring/jobs"], res.message) : { ok: false, message: res.message };
}

// --- Jobs ------------------------------------------------------------------------------

export async function jobStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const id = String(formData.get("jobId"));
  const status = String(formData.get("status")) as "OPEN" | "ON_HOLD" | "CLOSED";
  if (!["OPEN", "ON_HOLD", "CLOSED"].includes(status)) return { ok: false, message: "Unknown status." };
  const u = await prisma.job.updateMany({ where: { id, tenantId: viewer.tenantId, status: { not: "FILLED" } }, data: { status, isPublished: status === "OPEN" } });
  if (u.count) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: id, summary: `Job set to ${status.toLowerCase().replace("_", " ")}` });
  return u.count ? done(["/hiring/jobs", `/hiring/jobs/${id}`], `Job ${status.toLowerCase().replace("_", " ")}.`) : { ok: false, message: "Job not found or already filled." };
}

export async function saveJobDetailsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const parsed = parseForm(z.object({
    jobId: zId(), description: z.string().min(30, "Add a job description (at least 30 characters)").max(20000),
    requirements: zOptional(5000), minExperienceYears: zNumber({ min: 0, max: 50 }),
  }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const u = await prisma.job.updateMany({ where: { id: d.jobId, tenantId: viewer.tenantId }, data: { description: d.description, requirements: d.requirements, minExperienceYears: d.minExperienceYears } });
  if (!u.count) return { ok: false, message: "Job not found." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: d.jobId, summary: "Edited job details" });
  return done([`/hiring/jobs/${d.jobId}`], "Job details saved.");
}

/** The job's interview kit: scorecard sections and the skills each rates. */
export async function saveScorecardTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const jobId = String(formData.get("jobId") ?? "");
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("kit") ?? "[]")); } catch { return { ok: false, message: "The scorecard could not be read." }; }
  const kit = parseKit(raw);
  if (!kit) return { ok: false, message: "Add at least one section with one skill." };
  const names = kit.map((k) => k.section.toLowerCase());
  if (new Set(names).size !== names.length) return { ok: false, message: "Section names must be unique." };
  const u = await prisma.job.updateMany({ where: { id: jobId, tenantId: viewer.tenantId }, data: { scorecardTemplate: kit as unknown as Prisma.InputJsonValue } });
  if (!u.count) return { ok: false, message: "Job not found." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: jobId, summary: `Scorecard: ${kit.map((k) => `${k.section} (${k.skills.length})`).join(", ")}` });
  return done([`/hiring/jobs/${jobId}`], "Scorecard saved.");
}

// --- Candidates ---------------------------------------------------------------------

const candidateSchema = z.object({
  jobId: zId(), firstName: zName(60), lastName: zName(60), email: zRequiredEmail(), phone: zOptional(20),
  currentEmployer: zOptional(120), currentTitle: zOptional(120), totalExperienceYears: zNumber({ min: 0, max: 50 }),
  currentAnnualCtc: zNumber({ min: 0 }), expectedAnnualCtc: zNumber({ min: 0 }), noticePeriodDays: zNumber({ min: 0, max: 365 }),
  source: z.enum(["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"]).default("DIRECT_SOURCING"),
});

export async function addCandidateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const parsed = parseForm(candidateSchema, formData);
  if (parsed.state) return parsed.state;
  if (!(await prisma.job.count({ where: { id: parsed.data.jobId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Job not found." };
  const res = await applyCandidate({ ...parsed.data, tenantId: viewer.tenantId, byUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: res.applicationId!, summary: `Added a candidate: ${res.message}` });
  return res.ok ? done(["/hiring/jobs", `/hiring/jobs/${parsed.data.jobId}`], res.message) : { ok: false, message: res.message, values: values(formData) };
}

/** Any employee can refer someone to a job that accepts referrals. */
export async function referAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(candidateSchema.pick({ jobId: true, firstName: true, lastName: true, email: true, phone: true, currentTitle: true }), formData);
  if (parsed.state) return parsed.state;
  const job = await prisma.job.findFirst({ where: { id: parsed.data.jobId, tenantId: viewer.tenantId, status: "OPEN", allowReferral: true } });
  if (!job) return { ok: false, message: "This job is not taking referrals." };
  const res = await applyCandidate({ ...parsed.data, tenantId: viewer.tenantId, source: "REFERRAL", referredById: viewer.employee.id, byUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: res.applicationId!, summary: `Referred a candidate to ${job.title}` });
  return res.ok ? done(["/hiring/refer"], `Thanks — ${res.message}`) : { ok: false, message: res.message, values: values(formData) };
}

export async function moveStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const id = String(formData.get("applicationId"));
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id } })))) return { ok: false, message: "Application not found." };
  const res = await moveStage({ applicationId: id, stageId: String(formData.get("stageId")), byUserId: viewer.user.id, note: String(formData.get("note") ?? "") || null });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: id, summary: res.message });
  return res.ok ? done([`/hiring/applications/${id}`, "/hiring/jobs"], res.message) : { ok: false, message: res.message };
}

/** Keka's "Archive" on a candidate: reject with the reason kept, and tell them. */
export async function rejectApplicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const id = String(formData.get("applicationId"));
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id } })))) return { ok: false, message: "Application not found." };
  const res = await rejectApplication(id, String(formData.get("reason") ?? ""));
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "REJECT", entityType: "Application", entityId: id, summary: `Archived candidate: ${String(formData.get("reason") ?? "").trim()}` });
  return res.ok ? done([`/hiring/applications/${id}`, "/hiring/jobs"], res.message) : { ok: false, message: res.message };
}

/** A note on the candidate for the hiring team: recruiters and the candidate's interviewers. */
export async function addCandidateNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const applicationId = String(formData.get("applicationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId: viewer.tenantId }, select: { id: true, interviews: { select: { panel: { select: { employeeId: true } } } } } });
  if (!app) return { ok: false, message: "Candidate not found." };
  const panelist = !!viewer.employee && app.interviews.some((i) => i.panel.some((p) => p.employeeId === viewer.employee!.id));
  if (!can(viewer, P.CANDIDATE_MANAGE) && !panelist) return { ok: false, message: "Only the hiring team can add notes." };
  if (body.length < 2) return { ok: false, message: "Write a note first.", errors: { body: "Required" } };
  if (body.length > 2000) return { ok: false, message: "Keep notes under 2,000 characters.", errors: { body: "Too long" } };
  const note = await prisma.candidateNote.create({ data: { tenantId: viewer.tenantId, applicationId, authorId: viewer.user.id, body } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CandidateNote", entityId: note.id, summary: "Added a note on a candidate" });
  return done([`/hiring/applications/${applicationId}`], "Note added.");
}

// --- Interviews and feedback ----------------------------------------------------------

const interviewSchema = z.object({
  applicationId: zId(), title: zName(120), date: zRequiredDate(), time: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  durationMinutes: zRequiredNumber({ min: 15, max: 240 }), mode: z.enum(["VIDEO", "PHONE", "ONSITE"]), meetingUrl: zOptional(300),
});

export async function scheduleInterviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INTERVIEW_MANAGE);
  const parsed = parseForm(interviewSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id: d.applicationId } })))) return { ok: false, message: "Application not found." };
  const [h, m] = d.time.split(":").map(Number);
  // Times are entered in IST.
  const at = new Date(d.date.getTime() + (h * 60 + m - 330) * 60_000);
  const panel = formData.getAll("panel").map(String).filter(Boolean);
  const valid = await prisma.employee.count({ where: { id: { in: panel }, tenantId: viewer.tenantId } });
  if (valid !== panel.length) return { ok: false, message: "Some interviewers were not found." };
  const res = await scheduleInterview({ applicationId: d.applicationId, title: d.title, scheduledAt: at, durationMinutes: d.durationMinutes, mode: d.mode, meetingUrl: d.meetingUrl, panel });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Interview", entityId: res.interviewId!, summary: `Scheduled ${d.title}` });
  return res.ok ? done([`/hiring/applications/${d.applicationId}`, "/hiring/interviews"], res.message) : { ok: false, message: res.message, values: values(formData) };
}

/**
 * Save or submit interview feedback. Panel membership is the authority;
 * the decision, text and per-skill ratings are checked in the service
 * against the job's own scorecard.
 */
export async function saveScorecardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const interviewId = String(formData.get("interviewId") ?? "");
  const iv = await prisma.interview.findFirst({ where: { id: interviewId, application: { tenantId: viewer.tenantId } }, select: { id: true, applicationId: true } });
  if (!iv) return { ok: false, message: "Interview not found." };
  let ratings: unknown = [];
  try { ratings = JSON.parse(String(formData.get("ratings") ?? "[]")); } catch { return { ok: false, message: "The ratings could not be read." }; }
  const submit = formData.get("intent") === "submit";
  const res = await saveScorecard({
    interviewId, panelistEmployeeId: viewer.employee.id, recommendation: String(formData.get("recommendation") ?? "") || null,
    notes: String(formData.get("notes") ?? ""), ratings, submit, aiAssisted: formData.get("aiAssisted") === "1",
  });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: submit ? "CREATE" : "UPDATE", entityType: "Scorecard", entityId: interviewId, summary: submit ? "Submitted interview feedback" : "Saved interview feedback as draft" });
  return res.ok ? done([`/hiring/applications/${iv.applicationId}`, "/hiring/interviews"], res.message) : { ok: false, message: res.message };
}

/** Nudge a panellist whose feedback is still outstanding — at most once a day. */
export async function remindPanelistAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const interviewId = String(formData.get("interviewId") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  const iv = await prisma.interview.findFirst({
    where: { id: interviewId, application: { tenantId: viewer.tenantId } },
    include: { panel: { include: { employee: { select: { userId: true, displayName: true } } } }, scorecards: { select: { panelistId: true, status: true } }, application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } } },
  });
  if (!iv) return { ok: false, message: "Interview not found." };
  const seat = iv.panel.find((p) => p.employeeId === employeeId);
  if (!seat) return { ok: false, message: "They are not on this panel." };
  if (iv.scorecards.some((x) => x.panelistId === employeeId && x.status === "SUBMITTED")) return { ok: false, message: "They have already given feedback." };
  if (iv.scheduledAt.getTime() > Date.now()) return { ok: false, message: "The interview has not happened yet." };
  if (!seat.employee.userId) return { ok: false, message: "They have no login to remind." };
  const link = `/hiring/applications/${iv.applicationId}?tab=feedback&feedback=${iv.id}`;
  const recent = await prisma.notification.count({ where: { tenantId: viewer.tenantId, userId: seat.employee.userId, link, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  if (recent) return { ok: false, message: `${seat.employee.displayName} was reminded in the last 24 hours.` };
  await notify({ tenantId: viewer.tenantId, userIds: [seat.employee.userId], kind: "HIRING", title: `Feedback due: ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, body: `${iv.title} for ${iv.application.job.title}`, link, email: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Interview", entityId: iv.id, summary: `Reminded ${seat.employee.displayName} to give feedback` });
  return done([`/hiring/applications/${iv.applicationId}`], `Reminder sent to ${seat.employee.displayName}.`);
}

/** Keep the (edited) AI summary of the panel's feedback on the candidate. */
export async function saveFeedbackSummaryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const applicationId = String(formData.get("applicationId") ?? "");
  const summary = String(formData.get("summary") ?? "").trim();
  if (plainText(summary).length < 20) return { ok: false, message: "The summary is too short to save." };
  if (summary.length > 4000) return { ok: false, message: "Keep the summary under 4,000 characters." };
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId: viewer.tenantId }, include: { interviews: { include: { scorecards: { where: { status: "SUBMITTED" }, select: { panelistId: true } } } } } });
  if (!app) return { ok: false, message: "Candidate not found." };
  const panelists = new Set(app.interviews.flatMap((i) => i.scorecards.map((x) => x.panelistId)));
  let detail: Array<{ panelistId: string; text: string }> = [];
  try {
    const raw = JSON.parse(String(formData.get("detail") ?? "[]")) as Array<{ panelistId?: unknown; text?: unknown }>;
    detail = (Array.isArray(raw) ? raw : []).filter((d) => typeof d.panelistId === "string" && panelists.has(d.panelistId) && typeof d.text === "string")
      .map((d) => ({ panelistId: d.panelistId as string, text: (d.text as string).slice(0, 400) }));
  } catch { /* an unreadable detail list is dropped, not fatal */ }
  await prisma.application.update({ where: { id: app.id }, data: { feedbackSummary: summary, feedbackSummaryDetail: detail, feedbackSummaryById: viewer.user.id, feedbackSummaryAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: app.id, summary: "Saved the feedback summary (AI-assisted)" });
  return done([`/hiring/applications/${app.id}`], "Summary saved successfully");
}

export async function saveCandidateFeedbackAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const applicationId = String(formData.get("applicationId") ?? "");
  const text = String(formData.get("text") ?? "").trim();
  if (plainText(text).length < 20) return { ok: false, message: "The feedback is too short to save." };
  if (text.length > 3000) return { ok: false, message: "Keep it under 3,000 characters." };
  const u = await prisma.application.updateMany({ where: { id: applicationId, tenantId: viewer.tenantId }, data: { candidateFeedback: text, candidateFeedbackAt: new Date() } });
  if (!u.count) return { ok: false, message: "Candidate not found." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: applicationId, summary: "Saved candidate-friendly feedback (AI-assisted)" });
  return done([`/hiring/applications/${applicationId}`], "Candidate friendly feedback saved");
}

// --- Offers and hire ---------------------------------------------------------------------

const offerSchema = z.object({
  applicationId: zId(), annualCtc: zRequiredNumber({ min: 1 }), joiningBonus: zNumber({ min: 0 }),
  proposedJoiningDate: zRequiredDate(), expiresOn: zRequiredDate(), reportingManagerId: z.string().optional().transform((v) => v || null), jobTitleId: z.string().optional().transform((v) => v || null),
});

export async function draftOfferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OFFER_MANAGE);
  const parsed = parseForm(offerSchema, formData);
  if (parsed.state) return parsed.state;
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id: parsed.data.applicationId } })))) return { ok: false, message: "Application not found." };
  const foreign = await foreignReference(viewer.tenantId, { employee: parsed.data.reportingManagerId, jobTitle: parsed.data.jobTitleId });
  if (foreign) return { ok: false, message: foreign };
  const res = await draftOffer(parsed.data);
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Offer", entityId: parsed.data.applicationId, summary: `Offer drafted at ₹${parsed.data.annualCtc}: ${res.message}` });
  return res.ok ? done([`/hiring/applications/${parsed.data.applicationId}`, "/hiring/offers"], res.message) : { ok: false, message: res.message, values: values(formData) };
}

export async function offerOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const applicationId = String(formData.get("applicationId"));
  const op = String(formData.get("op"));
  const app = await inTenant(viewer, await prisma.application.findUnique({ where: { id: applicationId } }));
  if (!app) return { ok: false, message: "Application not found." };
  let res: { ok: boolean; message: string };
  if (op === "approve") {
    if (!can(viewer, P.OFFER_APPROVE)) return { ok: false, message: "You cannot approve offers." };
    res = await approveOffer(applicationId, viewer.user.id);
  } else if (op === "extend") {
    if (!can(viewer, P.OFFER_MANAGE)) return { ok: false, message: "You cannot extend offers." };
    res = await extendOffer(applicationId, async (pdf, filename) => {
      const f = await saveFile({ tenantId: viewer.tenantId, filename, mimeType: "application/pdf", data: pdf, relatedType: "Offer", relatedId: applicationId, uploadedBy: viewer.user.id });
      return `/files/${f.id}`;
    });
  } else if (op === "accepted" || op === "declined") {
    if (!can(viewer, P.OFFER_MANAGE)) return { ok: false, message: "You cannot record offer responses." };
    res = await recordOfferResponse(applicationId, op === "accepted", String(formData.get("reason") ?? "") || null);
  } else return { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: op === "approve" ? "APPROVE" : "UPDATE", entityType: "Offer", entityId: applicationId, summary: `Offer ${op}: ${res.message}` });
  return res.ok ? done([`/hiring/applications/${applicationId}`, "/hiring/offers"], res.message) : { ok: false, message: res.message };
}

/**
 * Convert an accepted candidate into an employee through the same action
 * HR uses by hand — one definition of a valid employee record, and the
 * onboarding journey starts as it would for any joiner.
 */
export async function hireAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OFFER_MANAGE);
  if (!can(viewer, P.EMPLOYEE_CREATE)) return { ok: false, message: "Creating the employee record needs employee-creation rights." };
  const applicationId = String(formData.get("applicationId"));
  const app = await prisma.application.findFirst({
    where: { id: applicationId, tenantId: viewer.tenantId },
    include: { candidate: true, offer: true, job: true },
  });
  if (!app?.offer) return { ok: false, message: "Application not found." };
  if (app.status !== "OFFER_ACCEPTED") return { ok: false, message: "The offer must be accepted before hiring." };
  const [entity, location, payGroup] = await Promise.all([
    app.job.legalEntityId ? prisma.legalEntity.findUnique({ where: { id: app.job.legalEntityId } }) : prisma.legalEntity.findFirst({ where: { tenantId: viewer.tenantId } }),
    app.job.locationId ? prisma.location.findUnique({ where: { id: app.job.locationId } }) : prisma.location.findFirst({ where: { tenantId: viewer.tenantId } }),
    prisma.payGroup.findFirst({ where: { tenantId: viewer.tenantId } }),
  ]);
  if (!entity || !location) return { ok: false, message: "Set up a legal entity and location first." };
  const domain = viewer.user.email.split("@")[1];
  const local = `${app.candidate.firstName}.${app.candidate.lastName}`.toLowerCase().replace(/[^a-z.]/g, "");
  const workEmail = String(formData.get("workEmail") ?? "") || `${local}@${domain}`;
  const joining = app.offer.proposedJoiningDate ?? new Date();
  const f = new FormData();
  const set = (k: string, v: string | null | undefined) => { if (v) f.set(k, v); };
  set("firstName", app.candidate.firstName); set("lastName", app.candidate.lastName); set("workEmail", workEmail);
  set("personalEmail", app.candidate.email); set("mobile", app.candidate.phone);
  set("dateOfJoining", joining.toISOString().slice(0, 10)); set("legalEntityId", entity.id); set("locationId", location.id);
  set("departmentId", app.job.departmentId); set("jobTitleId", app.offer.jobTitleId); set("reportingManagerId", app.offer.reportingManagerId);
  set("status", joining > new Date() ? "PREBOARDING" : "PROBATION"); f.set("inviteToPortal", "on");
  set("payGroupId", payGroup?.id); set("annualCtc", String(Number(app.offer.annualCtc)));
  const created = await createEmployee({}, f);
  if (!created.ok) return { ok: false, message: `The employee record could not be created: ${created.message}`, errors: created.errors };
  const emp = await prisma.employee.findFirstOrThrow({ where: { tenantId: viewer.tenantId, workEmail } });
  const res = await completeHire(applicationId, emp.id);
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: applicationId, summary: `Hired ${emp.displayName} as ${emp.employeeNumber} from ${app.job.code}` });
  return done(["/hiring/jobs", "/hiring/offers", "/employees", "/onboarding"], `${created.message}`);
}

// --- Settings ------------------------------------------------------------------------------

export async function addHiringFlowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const name = String(formData.get("name") ?? "").trim();
  const stages = String(formData.get("stages") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!name || stages.length < 2) return { ok: false, message: "Name the flow and give at least two stages, comma separated." };
  try {
    const flow = await prisma.hiringFlow.create({ data: { tenantId: viewer.tenantId, name, stages: { create: stages.map((x, i) => ({ name: x, sequence: i + 1, requireScorecard: /interview|round|technical/i.test(x) })) } } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "HiringFlow", entityId: flow.id, summary: `Created hiring flow ${name}` });
    return done(["/hiring/settings"], `Created ${name} with ${stages.length} stages.`);
  } catch (err) {
    return toErrorState(err);
  }
}

/** Requisition instructions, the default approver and the AI question allowance. */
export async function saveHiringSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const parsed = parseForm(z.object({
    requisitionInstructions: zOptional(1000), defaultApproverUserId: z.string().optional().transform((v) => v || null),
    aiQuestionAttempts: zRequiredNumber({ min: 1, max: 5 }),
  }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.defaultApproverUserId) {
    const foreign = await foreignReference(viewer.tenantId, { user: d.defaultApproverUserId });
    if (foreign) return { ok: false, message: foreign };
  }
  await prisma.hiringSetting.upsert({
    where: { tenantId: viewer.tenantId },
    create: { tenantId: viewer.tenantId, requisitionInstructions: d.requisitionInstructions, defaultApproverUserId: d.defaultApproverUserId, aiQuestionAttempts: Math.trunc(d.aiQuestionAttempts) },
    update: { requisitionInstructions: d.requisitionInstructions, defaultApproverUserId: d.defaultApproverUserId, aiQuestionAttempts: Math.trunc(d.aiQuestionAttempts) },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HiringSetting", summary: "Updated hiring settings" });
  return done(["/hiring/settings", "/hiring/requisitions"], "Hiring settings saved.");
}

export async function saveJdTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const parsed = parseForm(z.object({ title: zName(120), body: z.string().min(30, "At least 30 characters").max(20000) }), formData);
  if (parsed.state) return parsed.state;
  try {
    const t = await prisma.jobDescriptionTemplate.create({ data: { tenantId: viewer.tenantId, title: parsed.data.title, body: parsed.data.body } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "JobDescriptionTemplate", entityId: t.id, summary: `Added JD template ${t.title}` });
    return done(["/hiring/settings"], "Template added.");
  } catch (err) {
    return toErrorState(err, values(formData));
  }
}

export async function deleteJdTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const id = String(formData.get("id") ?? "");
  const u = await prisma.jobDescriptionTemplate.deleteMany({ where: { id, tenantId: viewer.tenantId } });
  if (!u.count) return { ok: false, message: "Template not found." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "JobDescriptionTemplate", entityId: id, summary: "Deleted a JD template" });
  return done(["/hiring/settings"], "Template deleted.");
}
