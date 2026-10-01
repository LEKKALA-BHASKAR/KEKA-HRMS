"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  decideRequisition, openJobFromRequisition, applyCandidate, moveStage, rejectApplication, scheduleInterview,
  submitScorecard, draftOffer, approveOffer, extendOffer, recordOfferResponse, completeHire,
} from "@keka/services";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zOptionalId, zId, zRequiredEmail, type ActionState,
} from "@/lib/forms";
import { createEmployee } from "./employee";

const P = PERMISSIONS;
const values = (f: FormData) => Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));

async function inTenant<T extends { tenantId: string }>(viewer: { tenantId: string }, row: T | null): Promise<T | null> {
  return row && row.tenantId === viewer.tenantId ? row : null;
}

const requisitionSchema = z.object({
  title: zName(120), type: z.enum(["NEW_HIRE", "BACKFILL"]),
  departmentId: zOptionalId(), locationId: zOptionalId(), legalEntityId: zOptionalId(),
  positions: zRequiredNumber({ min: 1, max: 100 }),
  minAnnualCtc: zNumber({ min: 0 }), maxAnnualCtc: zNumber({ min: 0 }),
  justification: zName(2000), replacingEmployeeId: zOptionalId(), targetStartDate: zDate(),
});

export async function raiseRequisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REQUISITION_MANAGE);
  const parsed = parseForm(requisitionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.minAnnualCtc && d.maxAnnualCtc && d.minAnnualCtc > d.maxAnnualCtc) return { ok: false, message: "The minimum is above the maximum.", errors: { maxAnnualCtc: "Below minimum" }, values: values(formData) };
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, location: d.locationId, legalEntity: d.legalEntityId, employee: d.replacingEmployeeId });
  if (foreign) return { ok: false, message: foreign };
  if (d.type === "BACKFILL" && !d.replacingEmployeeId) return { ok: false, message: "Say who is being replaced.", errors: { replacingEmployeeId: "Required for a backfill" }, values: values(formData) };
  const r = await prisma.requisition.create({ data: { ...d, tenantId: viewer.tenantId, status: "PENDING_APPROVAL", raisedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Requisition", entityId: r.id, summary: `Raised requisition: ${d.title} × ${d.positions}` });
  return done(["/hiring"], "Raised for approval.");
}

export async function decideRequisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REQUISITION_APPROVE);
  const id = String(formData.get("id"));
  const r = await inTenant(viewer, await prisma.requisition.findUnique({ where: { id } }));
  if (!r) return { ok: false, message: "Requisition not found." };
  if (r.raisedBy === viewer.user.id) return { ok: false, message: "You cannot approve a requisition you raised." };
  const res = await decideRequisition({ requisitionId: id, approve: formData.get("decision") === "approve", byUserId: viewer.user.id, reason: String(formData.get("reason") ?? "") || null });
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: formData.get("decision") === "approve" ? "APPROVE" : "REJECT", entityType: "Requisition", entityId: id, summary: `${r.title}: ${res.message}` });
  return res.ok ? done(["/hiring"], res.message) : { ok: false, message: res.message };
}

export async function openJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const id = String(formData.get("requisitionId"));
  if (!(await inTenant(viewer, await prisma.requisition.findUnique({ where: { id } })))) return { ok: false, message: "Requisition not found." };
  const hm = String(formData.get("hiringManagerId") ?? "") || null;
  const foreign = await foreignReference(viewer.tenantId, { employee: hm });
  if (foreign) return { ok: false, message: foreign };
  const res = await openJobFromRequisition(id, { hiringManagerId: String(formData.get("hiringManagerId") ?? "") || null, recruiterId: viewer.user.id, description: String(formData.get("description") ?? "") || null });
  return res.ok ? done(["/hiring"], res.message) : { ok: false, message: res.message };
}

export async function jobStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const id = String(formData.get("jobId"));
  const status = String(formData.get("status")) as "OPEN" | "ON_HOLD" | "CLOSED";
  if (!["OPEN", "ON_HOLD", "CLOSED"].includes(status)) return { ok: false, message: "Unknown status." };
  const u = await prisma.job.updateMany({ where: { id, tenantId: viewer.tenantId, status: { not: "FILLED" } }, data: { status, isPublished: status === "OPEN" } });
  return u.count ? done(["/hiring", `/hiring/jobs/${id}`], `Job ${status.toLowerCase().replace("_", " ")}.`) : { ok: false, message: "Job not found or already filled." };
}

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
  const res = await applyCandidate({ ...parsed.data, tenantId: viewer.tenantId, byUserId: viewer.user.id });
  return res.ok ? done(["/hiring", `/hiring/jobs/${parsed.data.jobId}`], res.message) : { ok: false, message: res.message, values: values(formData) };
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
  return res.ok ? done(["/hiring"], `Thanks — ${res.message}`) : { ok: false, message: res.message, values: values(formData) };
}

export async function moveStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const id = String(formData.get("applicationId"));
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id } })))) return { ok: false, message: "Application not found." };
  const res = await moveStage({ applicationId: id, stageId: String(formData.get("stageId")), byUserId: viewer.user.id, note: String(formData.get("note") ?? "") || null });
  return res.ok ? done([`/hiring/applications/${id}`, "/hiring"], res.message) : { ok: false, message: res.message };
}

export async function rejectApplicationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const id = String(formData.get("applicationId"));
  if (!(await inTenant(viewer, await prisma.application.findUnique({ where: { id } })))) return { ok: false, message: "Application not found." };
  const res = await rejectApplication(id, String(formData.get("reason") ?? ""));
  return res.ok ? done([`/hiring/applications/${id}`, "/hiring"], res.message) : { ok: false, message: res.message };
}

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
  return res.ok ? done([`/hiring/applications/${d.applicationId}`, "/hiring"], res.message) : { ok: false, message: res.message, values: values(formData) };
}

/** Panel membership is the authority to give feedback. */
export async function scorecardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const interviewId = String(formData.get("interviewId"));
  const iv = await prisma.interview.findFirst({ where: { id: interviewId, application: { tenantId: viewer.tenantId } } });
  if (!iv) return { ok: false, message: "Interview not found." };
  const res = await submitScorecard({
    interviewId, panelistEmployeeId: viewer.employee.id, overallScore: Number(formData.get("overallScore")), recommendation: String(formData.get("recommendation")),
    strengths: String(formData.get("strengths") ?? "") || null, concerns: String(formData.get("concerns") ?? "") || null,
  });
  return res.ok ? done([`/hiring/applications/${iv.applicationId}`, "/hiring"], res.message) : { ok: false, message: res.message };
}

const offerSchema = z.object({
  applicationId: zId(), annualCtc: zRequiredNumber({ min: 1 }), joiningBonus: zNumber({ min: 0 }),
  proposedJoiningDate: zRequiredDate(), expiresOn: zRequiredDate(), reportingManagerId: zOptionalId(), jobTitleId: zOptionalId(),
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
  return res.ok ? done([`/hiring/applications/${parsed.data.applicationId}`], res.message) : { ok: false, message: res.message, values: values(formData) };
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
  return res.ok ? done([`/hiring/applications/${applicationId}`, "/hiring"], res.message) : { ok: false, message: res.message };
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
  return done(["/hiring", "/employees", "/onboarding"], `${created.message}`);
}

export async function addHiringFlowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const name = String(formData.get("name") ?? "").trim();
  const stages = String(formData.get("stages") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!name || stages.length < 2) return { ok: false, message: "Name the flow and give at least two stages, comma separated." };
  try {
    await prisma.hiringFlow.create({ data: { tenantId: viewer.tenantId, name, stages: { create: stages.map((s, i) => ({ name: s, sequence: i + 1, requireScorecard: /interview|round|technical/i.test(s) })) } } });
    return done(["/hiring"], `Created ${name} with ${stages.length} stages.`);
  } catch (err) {
    return toErrorState(err);
  }
}
