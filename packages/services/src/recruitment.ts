import { prisma } from "@keka/db";
import { renderLetter } from "@keka/documents";
import { notify, usersWithPermission } from "./lifecycle";

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
}): Promise<Result & { applicationId?: string }> {
  const job = await prisma.job.findFirst({ where: { id: input.jobId, tenantId: input.tenantId }, include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } });
  if (!job) return { ok: false, message: "Job not found." };
  if (job.status !== "OPEN") return { ok: false, message: "This job is not open." };
  const email = input.email.trim().toLowerCase();
  const { tenantId, jobId, byUserId, ...fields } = input;
  const candidate = await prisma.candidate.upsert({
    where: { tenantId_email: { tenantId, email } },
    create: { ...fields, email, tenantId },
    update: { phone: fields.phone ?? undefined, currentEmployer: fields.currentEmployer ?? undefined, currentTitle: fields.currentTitle ?? undefined, expectedAnnualCtc: fields.expectedAnnualCtc ?? undefined },
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
}): Promise<Result> {
  const app = await prisma.application.findUnique({ where: { id: opts.applicationId }, include: { job: true, offer: true } });
  if (!app) return { ok: false, message: "Application not found." };
  if (app.status !== "ACTIVE") return { ok: false, message: "Only an active application can get an offer." };
  if (app.offer && !["DECLINED", "WITHDRAWN", "EXPIRED"].includes(app.offer.status)) return { ok: false, message: "There is already an offer in progress." };
  if (opts.expiresOn <= new Date()) return { ok: false, message: "The offer must expire in the future." };
  if (opts.proposedJoiningDate < opts.expiresOn) return { ok: false, message: "The joining date should be after the offer expires." };
  const max = app.job.maxAnnualCtc === null ? null : Number(app.job.maxAnnualCtc);
  const needsApproval = max !== null && opts.annualCtc > max;
  const data = {
    status: (needsApproval ? "PENDING_APPROVAL" : "APPROVED") as "PENDING_APPROVAL" | "APPROVED",
    annualCtc: opts.annualCtc, proposedJoiningDate: opts.proposedJoiningDate, expiresOn: opts.expiresOn,
    reportingManagerId: opts.reportingManagerId ?? app.job.hiringManagerId, jobTitleId: opts.jobTitleId ?? null, joiningBonus: opts.joiningBonus ?? null,
    approvedAt: needsApproval ? null : new Date(), declineReason: null, respondedAt: null, extendedAt: null,
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

/** Send the offer: a letter PDF, an email, and the application marked as offered. */
export async function extendOffer(applicationId: string, saveLetter: (pdf: Buffer, filename: string) => Promise<string>): Promise<Result> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { offer: true, candidate: true, job: { include: { requisition: true } } },
  });
  if (!app?.offer) return { ok: false, message: "Draft an offer first." };
  if (app.offer.status !== "APPROVED") return { ok: false, message: app.offer.status === "PENDING_APPROVAL" ? "The offer is waiting for approval." : "This offer cannot be extended." };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: app.tenantId } });
  const [location, manager] = await Promise.all([
    app.job.locationId ? prisma.location.findUnique({ where: { id: app.job.locationId } }) : null,
    app.offer.reportingManagerId ? prisma.employee.findUnique({ where: { id: app.offer.reportingManagerId }, select: { displayName: true, jobTitleName: true } }) : null,
  ]);
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const pdf = renderLetter({
    company: { name: tenant.name, address: location?.name ?? null },
    date: fmt(new Date()), to: [`${app.candidate.firstName} ${app.candidate.lastName}`, app.candidate.email],
    subject: `Offer of employment — ${app.job.title}`,
    paragraphs: [
      `Dear ${app.candidate.firstName},`,
      `We are delighted to offer you the position of ${app.job.title} at ${tenant.name}. The principal terms of the offer are set out below; the detailed terms will be in your appointment letter on joining.`,
      `This offer is valid until ${fmt(app.offer.expiresOn!)}. Please confirm your acceptance by replying to this email before then.`,
    ],
    table: [
      ["Position", app.job.title],
      ["Annual cost to company", `Rs. ${Number(app.offer.annualCtc).toLocaleString("en-IN")}`],
      ...(app.offer.joiningBonus ? [["Joining bonus", `Rs. ${Number(app.offer.joiningBonus).toLocaleString("en-IN")}`] as [string, string]] : []),
      ["Date of joining", fmt(app.offer.proposedJoiningDate!)],
      ["Location", location?.name ?? "As agreed"],
      ["Reporting to", manager ? `${manager.displayName}${manager.jobTitleName ? `, ${manager.jobTitleName}` : ""}` : "To be confirmed"],
    ],
    signatory: { name: "Talent Acquisition", title: tenant.name },
    footer: "This offer is subject to satisfactory background verification and the documents listed in your onboarding checklist.",
  });
  const url = await saveLetter(pdf, `Offer-${app.candidate.lastName}-${app.job.code ?? app.jobId}.pdf`);
  await prisma.$transaction([
    prisma.offer.update({ where: { id: app.offer.id }, data: { status: "EXTENDED", extendedAt: new Date(), letterUrl: url } }),
    prisma.application.update({ where: { id: app.id }, data: { status: "OFFER_EXTENDED" } }),
    prisma.emailOutbox.create({
      data: {
        tenantId: app.tenantId, toAddress: app.candidate.email, subject: `Your offer from ${tenant.name}`,
        textBody: `Dear ${app.candidate.firstName},\n\nCongratulations — please find your offer for the ${app.job.title} role attached. It is valid until ${fmt(app.offer.expiresOn!)}.\n\nTalent Acquisition, ${tenant.name}`,
        relatedType: "Offer", relatedId: app.offer.id,
      },
    }),
  ]);
  return { ok: true, message: "Offer extended; the letter is attached to the email." };
}

export async function recordOfferResponse(applicationId: string, accepted: boolean, reason?: string | null): Promise<Result> {
  const offer = await prisma.offer.findUnique({ where: { applicationId } });
  if (!offer || offer.status !== "EXTENDED") return { ok: false, message: "No extended offer to respond to." };
  if (offer.expiresOn && offer.expiresOn < new Date(Date.now() - DAY) && accepted) return { ok: false, message: "This offer has expired. Extend a fresh one." };
  await prisma.$transaction([
    prisma.offer.update({ where: { id: offer.id }, data: { status: accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date(), declineReason: accepted ? null : reason ?? null } }),
    prisma.application.update({ where: { id: applicationId }, data: { status: accepted ? "OFFER_ACCEPTED" : "OFFER_DECLINED" } }),
  ]);
  return { ok: true, message: accepted ? "Accepted. Convert the candidate to an employee when the paperwork is in." : "Declined." };
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
