import { prisma, Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { extendOfferFromTemplate, recordResponseOnBehalf } from "./offers";
import type { BreakupRow } from "./offers-math";

/**
 * The hiring pipeline: requisition → job → application → stages →
 * interviews and scorecards → offer → hire. Each step checks the one before
 * it, so an offer cannot exceed the approved budget and a stage that needs
 * feedback cannot be skipped past.
 */

const DAY = 86_400_000;
type Result = { ok: boolean; message: string };

export async function decideRequisition(opts: { requisitionId: string; approve: boolean; byUserId: string; reason?: string | null }): Promise<Result> {
  const r = await prisma.requisition.findUnique({ where: { id: opts.requisitionId } });
  if (!r) return { ok: false, message: "Requisition not found." };
  if (r.status !== "PENDING_APPROVAL") return { ok: false, message: `This requisition is ${r.status.toLowerCase().replace(/_/g, " ")}.` };
  if (!opts.approve && !opts.reason) return { ok: false, message: "Give a reason when rejecting." };
  await prisma.requisition.update({
    where: { id: r.id },
    data: opts.approve ? { status: "APPROVED", approvedBy: opts.byUserId, approvedAt: new Date() } : { status: "REJECTED", rejectReason: opts.reason },
  });
  return { ok: true, message: opts.approve ? "Approved — you can open a job against it." : "Rejected." };
}

/** Open a job from an approved requisition, inheriting its placement and budget. */
export async function openJobFromRequisition(requisitionId: string, extra: { description?: string | null; hiringManagerId?: string | null; recruiterId?: string | null }): Promise<Result & { jobId?: string }> {
  const r = await prisma.requisition.findUnique({ where: { id: requisitionId }, include: { jobs: true } });
  if (!r) return { ok: false, message: "Requisition not found." };
  if (r.status !== "APPROVED") return { ok: false, message: "Only an approved requisition can be opened as a job." };
  const opened = r.jobs.reduce((s, j) => s + j.openings, 0);
  if (opened >= r.positions) return { ok: false, message: "Every approved position already has a job." };
  const flow = await prisma.hiringFlow.findFirst({ where: { tenantId: r.tenantId, isActive: true }, orderBy: { isDefault: "desc" } });
  const count = await prisma.job.count({ where: { tenantId: r.tenantId } });
  // The job carries the requisition's description, experience, type and hiring team.
  const employmentType = r.jobType === "PART_TIME" ? "PART_TIME" : r.employmentType === "CONTRACT" || r.employmentType === "CONSULTANT" ? "CONTRACT" : r.employmentType === "INTERN" ? "INTERNSHIP" : "FULL_TIME";
  const job = await prisma.job.create({
    data: {
      tenantId: r.tenantId, requisitionId: r.id, flowId: flow?.id ?? null, title: r.title, code: `JOB-${1001 + count}`,
      description: extra.description ?? r.description ?? r.justification, departmentId: r.departmentId, locationId: r.locationId,
      businessUnitId: r.businessUnitId, legalEntityId: r.legalEntityId, openings: r.positions - opened,
      minAnnualCtc: r.minAnnualCtc, maxAnnualCtc: r.maxAnnualCtc, status: "OPEN", isPublished: true, publishedAt: new Date(),
      minExperienceYears: r.minExperienceYears, employmentType,
      hiringManagerId: extra.hiringManagerId ?? r.hiringManagerId ?? null, recruiterId: extra.recruiterId ?? r.recruiterId ?? null,
    },
  });
  return { ok: true, message: `Opened ${job.code}.`, jobId: job.id };
}

/** Add (or reuse, by email) a candidate and apply them to a job at its first stage. */
export async function applyCandidate(input: {
  tenantId: string; jobId: string; firstName: string; lastName: string; email: string; phone?: string | null;
  currentEmployer?: string | null; currentTitle?: string | null; totalExperienceYears?: number | null;
  currentAnnualCtc?: number | null; expectedAnnualCtc?: number | null; noticePeriodDays?: number | null;
  source?: "CAREER_PORTAL" | "REFERRAL" | "INTERNAL" | "JOB_BOARD" | "AGENCY" | "DIRECT_SOURCING" | "WALK_IN";
  referredById?: string | null; byUserId?: string | null;
  /** False from the public careers site: an applicant cannot edit someone else's record by typing their email. */
  updateExisting?: boolean;
}): Promise<Result & { applicationId?: string }> {
  const job = await prisma.job.findFirst({ where: { id: input.jobId, tenantId: input.tenantId }, include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } });
  if (!job) return { ok: false, message: "Job not found." };
  if (job.status !== "OPEN") return { ok: false, message: "This job is not open." };
  const email = input.email.trim().toLowerCase();
  const { tenantId, jobId, byUserId, updateExisting = true, ...fields } = input;
  const candidate = await prisma.candidate.upsert({
    where: { tenantId_email: { tenantId, email } },
    create: { ...fields, email, tenantId },
    update: updateExisting ? { phone: fields.phone ?? undefined, currentEmployer: fields.currentEmployer ?? undefined, currentTitle: fields.currentTitle ?? undefined, expectedAnnualCtc: fields.expectedAnnualCtc ?? undefined } : {},
  });
  if (candidate.convertedEmployeeId) return { ok: false, message: "This person is already an employee; use internal mobility instead." };
  const existing = await prisma.application.findUnique({ where: { jobId_candidateId: { jobId, candidateId: candidate.id } } });
  if (existing) return { ok: false, message: `${candidate.firstName} has already applied to this job.`, applicationId: existing.id };
  const first = job.flow?.stages[0];
  const app = await prisma.application.create({
    data: {
      tenantId, jobId, candidateId: candidate.id, currentStageId: first?.id ?? null, ownerId: job.recruiterId,
      ...(first ? { stageHistory: { create: { stageId: first.id, movedBy: byUserId ?? null, note: "Applied" } } } : {}),
    },
  });
  return { ok: true, message: `${candidate.firstName} ${candidate.lastName} is in ${first?.name ?? "the pipeline"}.`, applicationId: app.id };
}

/** Move to another stage. Leaving a stage that needs feedback needs a scorecard first. */
export async function moveStage(opts: { applicationId: string; stageId: string; byUserId: string; note?: string | null }): Promise<Result> {
  const app = await prisma.application.findUnique({
    where: { id: opts.applicationId },
    // Drafts are invisible to everyone but their author and count for nothing.
    include: { job: { include: { flow: { include: { stages: true } } } }, stageHistory: { where: { exitedAt: null } }, interviews: { include: { scorecards: { where: { status: "SUBMITTED" } } } } },
  });
  if (!app) return { ok: false, message: "Application not found." };
  if (app.status !== "ACTIVE" && app.status !== "ON_HOLD") return { ok: false, message: `This application is ${app.status.toLowerCase().replace(/_/g, " ")}.` };
  const target = app.job.flow?.stages.find((s) => s.id === opts.stageId);
  if (!target) return { ok: false, message: "That stage is not part of this job's flow." };
  const current = app.job.flow?.stages.find((s) => s.id === app.currentStageId);
  if (current?.id === target.id) return { ok: false, message: "Already in that stage." };
  if (current?.requireScorecard && target.sequence > current.sequence) {
    const enteredAt = app.stageHistory[0]?.enteredAt ?? app.appliedAt;
    const feedback = app.interviews.some((i) => i.scorecards.some((s) => s.submittedAt >= enteredAt));
    if (!feedback) return { ok: false, message: `${current.name} needs interview feedback before the candidate moves on.` };
  }
  await prisma.$transaction([
    prisma.applicationStageHistory.updateMany({ where: { applicationId: app.id, exitedAt: null }, data: { exitedAt: new Date() } }),
    prisma.applicationStageHistory.create({ data: { applicationId: app.id, stageId: target.id, movedBy: opts.byUserId, note: opts.note ?? null } }),
    prisma.application.update({ where: { id: app.id }, data: { currentStageId: target.id, status: "ACTIVE" } }),
  ]);
  return { ok: true, message: `Moved to ${target.name}.` };
}

export async function rejectApplication(applicationId: string, reason: string): Promise<Result> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { candidate: true, job: true } });
  if (!app) return { ok: false, message: "Application not found." };
  if (["HIRED", "REJECTED", "WITHDRAWN"].includes(app.status)) return { ok: false, message: `This application is already ${app.status.toLowerCase()}.` };
  if (!reason.trim()) return { ok: false, message: "Record why — it is what you will be asked about later." };
  await prisma.$transaction([
    prisma.application.update({ where: { id: applicationId }, data: { status: "REJECTED", rejectedAt: new Date(), rejectReason: reason } }),
    prisma.applicationStageHistory.updateMany({ where: { applicationId, exitedAt: null }, data: { exitedAt: new Date() } }),
    prisma.offer.updateMany({ where: { applicationId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } }, data: { status: "WITHDRAWN" } }),
  ]);
  await prisma.emailOutbox.create({
    data: {
      tenantId: app.tenantId, toAddress: app.candidate.email, subject: `Your application for ${app.job.title}`,
      textBody: `Dear ${app.candidate.firstName},\n\nThank you for your time and interest in the ${app.job.title} role. After careful consideration we will not be moving forward with your application on this occasion.\n\nWe will keep your details on file for future openings.\n\nRegards,\nTalent Acquisition`,
      relatedType: "Application", relatedId: applicationId,
    },
  });
  return { ok: true, message: "Rejected; the candidate has been told." };
}

/** Schedule an interview; refuses a panel member who is already booked then. */
export async function scheduleInterview(opts: {
  applicationId: string; title: string; scheduledAt: Date; durationMinutes: number; mode: string; meetingUrl?: string | null; panel: string[];
}): Promise<Result & { interviewId?: string }> {
  const app = await prisma.application.findUnique({ where: { id: opts.applicationId }, include: { candidate: true, job: true, interviews: true } });
  if (!app) return { ok: false, message: "Application not found." };
  if (app.status !== "ACTIVE") return { ok: false, message: "Interviews are scheduled only for active applications." };
  if (opts.panel.length === 0) return { ok: false, message: "Add at least one interviewer." };
  if (opts.scheduledAt.getTime() < Date.now() - 3_600_000) return { ok: false, message: "That time has passed." };
  const end = new Date(opts.scheduledAt.getTime() + opts.durationMinutes * 60_000);
  const clashes = await prisma.interviewPanelist.findMany({
    where: { employeeId: { in: opts.panel }, interview: { status: "SCHEDULED", scheduledAt: { lt: end, gte: new Date(opts.scheduledAt.getTime() - 4 * 3_600_000) } } },
    include: { interview: true, employee: { select: { displayName: true } } },
  });
  const overlapping = clashes.filter((c) => new Date(c.interview.scheduledAt.getTime() + c.interview.durationMinutes * 60_000) > opts.scheduledAt);
  if (overlapping.length) return { ok: false, message: `${overlapping.map((c) => c.employee.displayName).join(", ")} already interviewing at that time.` };
  const interview = await prisma.interview.create({
    data: {
      applicationId: app.id, round: app.interviews.length + 1, title: opts.title, scheduledAt: opts.scheduledAt, durationMinutes: opts.durationMinutes,
      mode: opts.mode, meetingUrl: opts.meetingUrl ?? null,
      panel: { create: opts.panel.map((employeeId, i) => ({ employeeId, isLead: i === 0 })) },
    },
  });
  const panelUsers = await prisma.employee.findMany({ where: { id: { in: opts.panel } }, select: { userId: true } });
  await notify({
    tenantId: app.tenantId, userIds: panelUsers.map((p) => p.userId), kind: "HIRING",
    title: `Interview: ${app.candidate.firstName} ${app.candidate.lastName} for ${app.job.title}`,
    body: `${opts.scheduledAt.toISOString().slice(0, 16).replace("T", " ")} UTC, ${opts.durationMinutes} min, ${opts.mode.toLowerCase()}`, link: `/hiring/applications/${app.id}`, email: true,
  });
  return { ok: true, message: `Scheduled round ${interview.round}; the panel has been invited.`, interviewId: interview.id };
}

/* Interview feedback lives in hire.ts (`saveScorecard`): Keka's five-level decision,
   ratings per skill by section, drafts — and it no longer writes the legacy values. */

/**
 * Draft an offer. Within the job's approved range it is approved at once;
 * above it, it needs an approver — the budget was agreed at requisition.
 */
export async function draftOffer(opts: {
  applicationId: string; annualCtc: number; proposedJoiningDate: Date; expiresOn: Date; reportingManagerId?: string | null; jobTitleId?: string | null; joiningBonus?: number | null;
  /** The offer letter template; empty takes the company's first offer template. */
  templateId?: string | null;
  /** Breakup from this salary structure, or typed by the recruiter; neither picks the structure for the CTC. */
  salaryStructureId?: string | null; breakup?: BreakupRow[] | null;
}): Promise<Result> {
  const app = await prisma.application.findUnique({ where: { id: opts.applicationId }, include: { job: true, offer: true } });
  if (!app) return { ok: false, message: "Application not found." };
  if (app.status !== "ACTIVE") return { ok: false, message: "Only an active application can get an offer." };
  if (app.offer && !["DECLINED", "WITHDRAWN", "EXPIRED"].includes(app.offer.status)) return { ok: false, message: "There is already an offer in progress." };
  if (opts.expiresOn <= new Date()) return { ok: false, message: "The offer must expire in the future." };
  if (opts.proposedJoiningDate < opts.expiresOn) return { ok: false, message: "The joining date should be after the offer expires." };
  if (opts.templateId && !(await prisma.documentTemplate.count({ where: { id: opts.templateId, tenantId: app.tenantId, category: "OFFER", isArchived: false } }))) return { ok: false, message: "Pick an offer letter template." };
  if (opts.salaryStructureId && !(await prisma.salaryStructure.count({ where: { id: opts.salaryStructureId, payGroup: { tenantId: app.tenantId }, isActive: true } }))) return { ok: false, message: "Pick an active salary structure." };
  const max = app.job.maxAnnualCtc === null ? null : Number(app.job.maxAnnualCtc);
  const needsApproval = max !== null && opts.annualCtc > max;
  const data = {
    status: (needsApproval ? "PENDING_APPROVAL" : "APPROVED") as "PENDING_APPROVAL" | "APPROVED",
    annualCtc: opts.annualCtc, proposedJoiningDate: opts.proposedJoiningDate, expiresOn: opts.expiresOn,
    reportingManagerId: opts.reportingManagerId ?? app.job.hiringManagerId, jobTitleId: opts.jobTitleId ?? null, joiningBonus: opts.joiningBonus ?? null,
    approvedAt: needsApproval ? null : new Date(), declineReason: null, respondedAt: null, extendedAt: null,
    templateId: opts.templateId ?? null, salaryStructureId: opts.breakup?.length ? null : opts.salaryStructureId ?? null,
    salaryBreakup: opts.breakup?.length ? (opts.breakup as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    breakupSource: opts.breakup?.length ? "MANUAL" : "STRUCTURE", renderedBody: null, contentHash: null, letterUrl: null,
  };
  if (app.offer) await prisma.offer.update({ where: { id: app.offer.id }, data });
  else await prisma.offer.create({ data: { ...data, applicationId: app.id } });
  if (needsApproval) {
    await notify({ tenantId: app.tenantId, userIds: await usersWithPermission(app.tenantId, "hire.offer.approve"), kind: "HIRING", title: `Offer above budget for ${app.job.title}`, body: `₹${opts.annualCtc.toLocaleString("en-IN")} against a ceiling of ₹${max!.toLocaleString("en-IN")}.`, link: `/hiring/applications/${app.id}` });
  }
  return { ok: true, message: needsApproval ? `Above the ₹${max!.toLocaleString("en-IN")} budget, so it needs approval.` : "Offer approved within budget; extend it when ready." };
}

export async function approveOffer(applicationId: string, byUserId: string): Promise<Result> {
  const offer = await prisma.offer.findUnique({ where: { applicationId } });
  if (!offer || offer.status !== "PENDING_APPROVAL") return { ok: false, message: "No offer is waiting for approval." };
  await prisma.offer.update({ where: { id: offer.id }, data: { status: "APPROVED", approvedBy: byUserId, approvedAt: new Date() } });
  return { ok: true, message: "Approved above budget." };
}

/**
 * Send the offer: the letter from the offer template (see offers.ts), and the
 * candidate's link to accept or decline it.
 */
export async function extendOffer(applicationId: string, saveLetter: (pdf: Buffer, filename: string) => Promise<string>, opts: { byUserId?: string | null; baseUrl?: string } = {}): Promise<Result & { url?: string }> {
  return extendOfferFromTemplate(applicationId, saveLetter, opts);
}

/** The recruiter records the candidate's answer given by phone or email. */
export async function recordOfferResponse(applicationId: string, accepted: boolean, reason?: string | null, byUserId?: string | null): Promise<Result> {
  const offer = await prisma.offer.findUnique({ where: { applicationId } });
  if (!offer || offer.status !== "EXTENDED") return { ok: false, message: "No extended offer to respond to." };
  if (offer.expiresOn && offer.expiresOn < new Date(Date.now() - DAY) && accepted) return { ok: false, message: "This offer has expired. Extend a fresh one." };
  return recordResponseOnBehalf(applicationId, accepted, reason ?? null, byUserId ?? null);
}

/** After the employee record exists: link it, close the application, fill the job. */
export async function completeHire(applicationId: string, employeeId: string): Promise<Result> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { job: { include: { applications: { where: { status: "HIRED" } } } } } });
  if (!app) return { ok: false, message: "Application not found." };
  await prisma.$transaction(async (tx) => {
    await tx.candidate.update({ where: { id: app.candidateId }, data: { convertedEmployeeId: employeeId } });
    await tx.application.update({ where: { id: app.id }, data: { status: "HIRED" } });
    await tx.applicationStageHistory.updateMany({ where: { applicationId: app.id, exitedAt: null }, data: { exitedAt: new Date() } });
    const hires = app.job.applications.length + 1;
    if (hires >= app.job.openings) {
      await tx.job.update({ where: { id: app.jobId }, data: { status: "FILLED", isPublished: false } });
      if (app.job.requisitionId) {
        const open = await tx.job.count({ where: { requisitionId: app.job.requisitionId, status: { notIn: ["FILLED", "CLOSED"] } } });
        if (open === 0) await tx.requisition.update({ where: { id: app.job.requisitionId }, data: { status: "FULFILLED" } });
      }
    }
  });
  return { ok: true, message: "Hired." };
}
