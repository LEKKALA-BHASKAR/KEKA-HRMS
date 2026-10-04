import { prisma, Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { govAudit } from "./governance-core";
import { moveStage } from "./recruitment";
import { recomputeApplicationScore } from "./hire";
import { appBaseUrl } from "./offers";
import { jobAlertMatches } from "./hire-depth-math";

/**
 * Hire depth: what an approved (or rejected) hiring request does. The
 * workflow engine calls `applyHireRequest` with the request's category;
 * nothing here starts a workflow, so the engine can import it without a
 * cycle. Also the record-level operations those effects share: merging a
 * duplicate candidate, revising an offer, recording offer versions.
 */

type Outcome = "APPROVED" | "REJECTED" | "WITHDRAWN";

/** What each kind of hiring request approves, and who approves it by default. */
export const HIRE_REQUEST_KINDS = {
  CAMPAIGN_LAUNCH: { label: "Sourcing campaign launch", permission: "hire.requisition.approve" },
  CHANNEL_ACTIVATION: { label: "New sourcing channel", permission: "hire.requisition.approve" },
  SOURCE_REATTRIBUTION: { label: "Candidate source change", permission: "hire.candidate.manage" },
  POOL_MEMBERSHIP: { label: "Restricted talent pool membership", permission: "hire.candidate.manage" },
  CANDIDATE_MERGE: { label: "Candidate merge", permission: "hire.candidate.manage" },
  STAGE_MOVE: { label: "Move into an approval-gated stage", permission: "hire.candidate.manage" },
  APPLICANT_CHANGE: { label: "Applicant change request", permission: "hire.candidate.manage" },
  REFERRAL_BONUS: { label: "Referral bonus", permission: "hire.offer.approve" },
  OFFER_REVISION: { label: "Offer revision", permission: "hire.offer.approve" },
  CONTENT_PUBLISH: { label: "Career site content", permission: "hire.portal.manage" },
  JOB_POSTING: { label: "Job posting on the careers site", permission: "hire.portal.manage" },
  TASK_SIGNOFF: { label: "Recruiter task sign-off", permission: "hire.candidate.manage" },
  INTERVIEW_PLAN: { label: "Interview plan sign-off", permission: "hire.job.manage" },
  SCORECARD_REOPEN: { label: "Reopen submitted feedback", permission: "hire.interview.manage" },
} as const;
export type HireRequestKind = keyof typeof HIRE_REQUEST_KINDS;
export const isHireRequestKind = (k: string | null | undefined): k is HireRequestKind => !!k && k in HIRE_REQUEST_KINDS;
export const hireRequestPermission = (k: string | null | undefined) => (isHireRequestKind(k) ? HIRE_REQUEST_KINDS[k].permission : "hire.job.manage");

const audit = (t: string, actor: string | null, action: "APPROVE" | "REJECT" | "UPDATE", entityType: string, entityId: string, summary: string) =>
  govAudit(t, actor, { module: "EMPLOYEE", action, entityType, entityId, summary });

/** Run the effect of a decided hiring request. Throws to leave the request in ERROR. */
export async function applyHireRequest(req: { tenantId: string; entityId: string | null; category: string | null; data: Prisma.JsonValue }, outcome: Outcome, actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  const ok = outcome === "APPROVED";
  const data = (req.data ?? {}) as Record<string, unknown>;
  const verb = ok ? "APPROVE" : "REJECT";
  switch (req.category) {
    case "CAMPAIGN_LAUNCH": {
      const u = await prisma.sourcingCampaign.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : outcome === "REJECTED" ? "REJECTED" : "DRAFT" } });
      if (u.count) await audit(t, actorUserId, verb, "SourcingCampaign", id, ok ? "Campaign approved and live" : `Campaign ${outcome.toLowerCase()}`);
      return;
    }
    case "CHANNEL_ACTIVATION": {
      const u = await prisma.sourcingChannel.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : outcome === "REJECTED" ? "REJECTED" : "INACTIVE" } });
      if (u.count) await audit(t, actorUserId, verb, "SourcingChannel", id, ok ? "Channel approved and active" : `Channel ${outcome.toLowerCase()}`);
      return;
    }
    case "SOURCE_REATTRIBUTION": {
      if (!ok) return;
      const cand = await prisma.candidate.findFirst({ where: { id, tenantId: t } });
      if (!cand) throw new Error("Candidate not found.");
      const source = String(data.source ?? "") as Prisma.CandidateUpdateInput["source"];
      const channelId = typeof data.channelId === "string" && data.channelId ? data.channelId : null;
      await prisma.candidate.update({ where: { id }, data: { source } });
      await prisma.candidateSourcingProfile.upsert({ where: { candidateId: id }, create: { tenantId: t, candidateId: id, channelId }, update: { channelId } });
      await audit(t, actorUserId, "APPROVE", "Candidate", id, `Source changed from ${cand.source} to ${String(source)}`);
      return;
    }
    case "POOL_MEMBERSHIP": {
      const m = await prisma.talentPoolMember.findFirst({ where: { id, pool: { tenantId: t } }, include: { pool: true } });
      if (!m) return;
      if (ok) {
        const expiresAt = m.pool.memberExpiryDays ? new Date(Date.now() + m.pool.memberExpiryDays * 86_400_000) : null;
        await prisma.talentPoolMember.update({ where: { id }, data: { status: "ACTIVE", expiresAt } });
      } else await prisma.talentPoolMember.delete({ where: { id } });
      await audit(t, actorUserId, verb, "TalentPool", m.poolId, ok ? `Membership approved in ${m.pool.name}` : `Membership in ${m.pool.name} ${outcome.toLowerCase()}`);
      return;
    }
    case "CANDIDATE_MERGE": {
      if (!ok) return;
      const dup = typeof data.duplicateId === "string" ? data.duplicateId : "";
      await mergeCandidates(t, id, dup, { requestedBy: typeof data.requestedBy === "string" ? data.requestedBy : null, approvedBy: actorUserId });
      return;
    }
    case "STAGE_MOVE": {
      if (!ok) return;
      const app = await prisma.application.findFirst({ where: { id, tenantId: t } });
      if (!app) throw new Error("Application not found.");
      const r = await moveStage({ applicationId: id, stageId: String(data.stageId ?? ""), byUserId: typeof data.requestedBy === "string" ? data.requestedBy : actorUserId ?? "", note: `Approved move${data.note ? `: ${String(data.note)}` : ""}` });
      if (!r.ok) throw new Error(r.message);
      await audit(t, actorUserId, "APPROVE", "Application", id, r.message);
      return;
    }
    case "APPLICANT_CHANGE": {
      const cr = await prisma.applicantChangeRequest.findFirst({ where: { id, tenantId: t, status: "PENDING" } });
      if (!cr) return;
      const app = await prisma.application.findFirst({ where: { id: cr.applicationId, tenantId: t }, include: { candidate: true, job: { select: { title: true } } } });
      if (ok && app) {
        if (cr.field === "EXPECTED_CTC") await prisma.candidate.update({ where: { id: app.candidateId }, data: { expectedAnnualCtc: Number(cr.newValue) } });
        if (cr.field === "NOTICE_PERIOD") await prisma.candidate.update({ where: { id: app.candidateId }, data: { noticePeriodDays: Math.trunc(Number(cr.newValue)) } });
      }
      await prisma.applicantChangeRequest.update({ where: { id }, data: { status: outcome, decidedAt: new Date() } });
      if (app && outcome !== "WITHDRAWN") {
        await prisma.emailOutbox.create({ data: { tenantId: t, toAddress: app.candidate.email, subject: `Your request about the ${app.job.title} application`, textBody: `Dear ${app.candidate.firstName},\n\nYour request (${cr.field.toLowerCase().replace(/_/g, " ")}: ${cr.newValue}) has been ${ok ? "accepted" : "declined"} by the hiring team.\n\nTalent Acquisition`, relatedType: "Application", relatedId: app.id } });
      }
      await audit(t, actorUserId, verb, "ApplicantChangeRequest", id, `Applicant change ${cr.field} → ${cr.newValue}: ${outcome.toLowerCase()}`);
      return;
    }
    case "REFERRAL_BONUS": {
      const u = await prisma.referralRecord.updateMany({ where: { id, tenantId: t, bonusStatus: "REQUESTED" }, data: { bonusStatus: ok ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "NONE", bonusDecidedAt: new Date() } });
      if (u.count) {
        const r = await prisma.referralRecord.findUniqueOrThrow({ where: { id } });
        const referrer = await prisma.employee.findFirst({ where: { id: r.referrerEmployeeId, tenantId: t }, select: { userId: true } });
        if (outcome !== "WITHDRAWN") await notify({ tenantId: t, userIds: [referrer?.userId], kind: "HIRING", title: ok ? "Your referral bonus was approved" : "Your referral bonus request was declined", link: "/hiring/refer" });
        await audit(t, actorUserId, verb, "ReferralRecord", id, `Referral bonus ${outcome.toLowerCase()}`);
      }
      return;
    }
    case "OFFER_REVISION": {
      if (!ok) {
        await audit(t, actorUserId, "REJECT", "Offer", id, `Offer revision ${outcome.toLowerCase()}`);
        return;
      }
      await reviseOffer(t, id, {
        annualCtc: Number(data.annualCtc), joiningBonus: data.joiningBonus === null || data.joiningBonus === undefined ? null : Number(data.joiningBonus),
        proposedJoiningDate: data.proposedJoiningDate ? new Date(String(data.proposedJoiningDate)) : null, expiresOn: data.expiresOn ? new Date(String(data.expiresOn)) : null,
        reason: String(data.reason ?? ""),
      }, actorUserId);
      return;
    }
    case "CONTENT_PUBLISH": {
      const u = await prisma.careerContent.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: ok ? { status: "PUBLISHED", publishedAt: new Date() } : { status: "DRAFT" } });
      if (u.count) await audit(t, actorUserId, verb, "CareerContent", id, ok ? "Career content approved and published" : `Career content ${outcome.toLowerCase()}; back to draft`);
      return;
    }
    case "JOB_POSTING": {
      if (!ok) { await audit(t, actorUserId, "REJECT", "Job", id, `Careers posting ${outcome.toLowerCase()}`); return; }
      const u = await prisma.job.updateMany({ where: { id, tenantId: t, status: "OPEN" }, data: { isPublished: true, publishedAt: new Date() } });
      if (!u.count) throw new Error("The job is no longer open.");
      await audit(t, actorUserId, "APPROVE", "Job", id, "Posting approved; the job is live on the careers site");
      await sendJobAlerts(t, id);
      return;
    }
    case "TASK_SIGNOFF": {
      const u = await prisma.recruiterTask.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: ok ? { status: "DONE", completedAt: new Date() } : { status: "OPEN", completedAt: null } });
      if (u.count) await audit(t, actorUserId, verb, "RecruiterTask", id, ok ? "Task signed off" : `Task sign-off ${outcome.toLowerCase()}; reopened`);
      return;
    }
    case "INTERVIEW_PLAN": {
      const u = await prisma.interviewPlan.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: ok ? { status: "APPROVED", approvedBy: actorUserId, approvedAt: new Date() } : { status: outcome === "REJECTED" ? "REJECTED" : "DRAFT" } });
      if (u.count) await audit(t, actorUserId, verb, "InterviewPlan", id, ok ? "Interview plan signed off" : `Interview plan ${outcome.toLowerCase()}`);
      return;
    }
    case "SCORECARD_REOPEN": {
      if (!ok) return;
      const sc = await prisma.scorecard.findFirst({ where: { id, interview: { application: { tenantId: t } } }, include: { interview: true } });
      if (!sc) throw new Error("Scorecard not found.");
      await prisma.scorecard.update({ where: { id }, data: { status: "DRAFT" } });
      await recomputeApplicationScore(sc.interview.applicationId);
      const panelist = await prisma.employee.findFirst({ where: { id: sc.panelistId, tenantId: t }, select: { userId: true } });
      await notify({ tenantId: t, userIds: [panelist?.userId], kind: "HIRING", title: "Your interview feedback is open to amend", link: `/hiring/applications/${sc.interview.applicationId}?tab=feedback&feedback=${sc.interviewId}` });
      await audit(t, actorUserId, "APPROVE", "Scorecard", id, "Submitted feedback reopened for amendment");
      return;
    }
    default:
      throw new Error(`Unknown hiring request “${req.category}”.`);
  }
}

// ---------------------------------------------------------------------------
//  Candidate merge
// ---------------------------------------------------------------------------

/** Clashes that stop a merge: both applied to the same job. */
export async function mergeBlocker(tenantId: string, survivorId: string, duplicateId: string): Promise<string | null> {
  if (!survivorId || !duplicateId || survivorId === duplicateId) return "Choose two different candidates.";
  const [a, b] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: survivorId, tenantId }, include: { applications: { select: { jobId: true } } } }),
    prisma.candidate.findFirst({ where: { id: duplicateId, tenantId }, include: { applications: { select: { jobId: true, status: true } } } }),
  ]);
  if (!a || !b) return "Candidate not found.";
  if (b.convertedEmployeeId) return "The duplicate has been hired; keep that record.";
  const jobs = new Set(a.applications.map((x) => x.jobId));
  if (b.applications.some((x) => jobs.has(x.jobId))) return "Both records applied to the same job; close one application first.";
  return null;
}

/** Fold a duplicate candidate into the survivor, keep a log, delete the duplicate. */
export async function mergeCandidates(tenantId: string, survivorId: string, duplicateId: string, meta: { requestedBy: string | null; approvedBy: string | null }): Promise<{ moved: Record<string, number> }> {
  const blocker = await mergeBlocker(tenantId, survivorId, duplicateId);
  if (blocker) throw new Error(blocker);
  const [s, d] = await Promise.all([
    prisma.candidate.findUniqueOrThrow({ where: { id: survivorId }, include: { talentPools: true, projectEntries: true, cadenceEnrollments: true, referralRecord: true, eeo: true, sourcingProfile: true } }),
    prisma.candidate.findUniqueOrThrow({ where: { id: duplicateId }, include: { talentPools: true, projectEntries: true, cadenceEnrollments: true, referralRecord: true, eeo: true, sourcingProfile: true } }),
  ]);
  const skills = [...new Set([...(Array.isArray(s.skills) ? s.skills : []), ...(Array.isArray(d.skills) ? d.skills : [])].filter((x): x is string => typeof x === "string"))];
  const moved: Record<string, number> = {};
  await prisma.$transaction(async (tx) => {
    moved.applications = (await tx.application.updateMany({ where: { candidateId: duplicateId }, data: { candidateId: survivorId } })).count;
    const pools = new Set(s.talentPools.map((m) => m.poolId));
    moved.pools = 0;
    for (const m of d.talentPools) {
      if (pools.has(m.poolId)) await tx.talentPoolMember.delete({ where: { id: m.id } });
      else { await tx.talentPoolMember.update({ where: { id: m.id }, data: { candidateId: survivorId } }); moved.pools++; }
    }
    const projects = new Set(s.projectEntries.map((m) => m.projectId));
    for (const m of d.projectEntries) if (!projects.has(m.projectId)) await tx.sourcingProjectCandidate.update({ where: { id: m.id }, data: { candidateId: survivorId } });
    const cadences = new Set(s.cadenceEnrollments.map((m) => m.cadenceId));
    for (const m of d.cadenceEnrollments) if (!cadences.has(m.cadenceId)) await tx.cadenceEnrollment.update({ where: { id: m.id }, data: { candidateId: survivorId } });
    moved.communications = (await tx.candidateCommunication.updateMany({ where: { candidateId: duplicateId }, data: { candidateId: survivorId } })).count;
    moved.documents = (await tx.candidateDocument.updateMany({ where: { candidateId: duplicateId }, data: { candidateId: survivorId } })).count;
    if (d.referralRecord && !s.referralRecord) await tx.referralRecord.update({ where: { id: d.referralRecord.id }, data: { candidateId: survivorId } });
    if (d.eeo && !s.eeo) await tx.candidateEeo.update({ where: { id: d.eeo.id }, data: { candidateId: survivorId } });
    if (d.sourcingProfile && !s.sourcingProfile) await tx.candidateSourcingProfile.update({ where: { id: d.sourcingProfile.id }, data: { candidateId: survivorId } });
    await tx.candidate.update({
      where: { id: survivorId },
      data: {
        phone: s.phone ?? d.phone, currentEmployer: s.currentEmployer ?? d.currentEmployer, currentTitle: s.currentTitle ?? d.currentTitle,
        resumeUrl: s.resumeUrl ?? d.resumeUrl, linkedinUrl: s.linkedinUrl ?? d.linkedinUrl, portfolioUrl: s.portfolioUrl ?? d.portfolioUrl,
        city: s.city ?? d.city, education: s.education ?? d.education, totalExperienceYears: s.totalExperienceYears ?? d.totalExperienceYears,
        referredById: s.referredById ?? d.referredById, skills,
      },
    });
    await tx.candidateMergeLog.create({ data: { tenantId, survivorId, mergedCandidateId: duplicateId, mergedName: `${d.firstName} ${d.lastName}`, mergedEmail: d.email, moved, requestedBy: meta.requestedBy, approvedBy: meta.approvedBy } });
    await tx.candidate.delete({ where: { id: duplicateId } });
  });
  await govAudit(tenantId, meta.approvedBy, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: survivorId, summary: `Merged ${d.firstName} ${d.lastName} <${d.email}> into ${s.firstName} ${s.lastName}`, newValue: moved });
  return { moved };
}

// ---------------------------------------------------------------------------
//  Offer versions and revisions
// ---------------------------------------------------------------------------

/** Snapshot the offer as it stands now as the next version. */
export async function recordOfferVersion(tenantId: string, applicationId: string, event: string, reason: string | null, byUserId: string | null): Promise<number | null> {
  const offer = await prisma.offer.findFirst({ where: { applicationId, application: { tenantId } } });
  if (!offer) return null;
  const last = await prisma.offerVersion.findFirst({ where: { applicationId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  await prisma.offerVersion.create({
    data: {
      tenantId, applicationId, version, annualCtc: offer.annualCtc, joiningBonus: offer.joiningBonus, proposedJoiningDate: offer.proposedJoiningDate,
      expiresOn: offer.expiresOn, breakup: offer.salaryBreakup ?? Prisma.DbNull, event, reason, status: offer.status, contentHash: offer.contentHash, createdBy: byUserId,
    },
  });
  return version;
}

/** Apply an approved revision: new terms, back to approved for re-extending, old links revoked. */
export async function reviseOffer(tenantId: string, applicationId: string, v: { annualCtc: number; joiningBonus: number | null; proposedJoiningDate: Date | null; expiresOn: Date | null; reason: string }, actorUserId: string | null): Promise<void> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { offer: true, candidate: true } });
  if (!app?.offer) throw new Error("Offer not found.");
  if (!["APPROVED", "EXTENDED", "DECLINED"].includes(app.offer.status)) throw new Error(`An offer that is ${app.offer.status.toLowerCase()} cannot be revised.`);
  if (!Number.isFinite(v.annualCtc) || v.annualCtc <= 0) throw new Error("The revised CTC is not valid.");
  await prisma.$transaction([
    prisma.offer.update({
      where: { id: app.offer.id },
      data: {
        annualCtc: v.annualCtc, joiningBonus: v.joiningBonus, ...(v.proposedJoiningDate ? { proposedJoiningDate: v.proposedJoiningDate } : {}), ...(v.expiresOn ? { expiresOn: v.expiresOn } : {}),
        status: "APPROVED", approvedBy: actorUserId, approvedAt: new Date(), renderedBody: null, contentHash: null, letterUrl: null, extendedAt: null, respondedAt: null, declineReason: null,
        // A manual breakup no longer adds up to the new CTC; fall back to the structure.
        ...(app.offer.breakupSource === "MANUAL" ? { salaryBreakup: Prisma.DbNull, breakupSource: "STRUCTURE" } : {}),
      },
    }),
    prisma.offerLink.updateMany({ where: { offerId: app.offer.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "Offer revised" } }),
    prisma.application.update({ where: { id: applicationId }, data: { status: "ACTIVE" } }),
  ]);
  await recordOfferVersion(tenantId, applicationId, "REVISED", v.reason || null, actorUserId);
  await notify({ tenantId, userIds: await usersWithPermission(tenantId, "hire.offer.manage"), kind: "HIRING", title: `Revised offer for ${app.candidate.firstName} ${app.candidate.lastName} is approved`, body: "Extend the new letter when ready.", link: `/hiring/offers/${applicationId}` });
  await govAudit(tenantId, actorUserId, { module: "EMPLOYEE", action: "APPROVE", entityType: "Offer", entityId: applicationId, summary: `Offer revised to ₹${v.annualCtc.toLocaleString("en-IN")}${v.reason ? `: ${v.reason}` : ""}`, oldValue: { annualCtc: Number(app.offer.annualCtc) }, newValue: { annualCtc: v.annualCtc } });
}

// ---------------------------------------------------------------------------
//  Job alerts
// ---------------------------------------------------------------------------

/** Email every confirmed subscriber whose alert matches a newly published job, once. */
export async function sendJobAlerts(tenantId: string, jobId: string, baseUrl?: string): Promise<number> {
  const job = await prisma.job.findFirst({ where: { id: jobId, tenantId, status: "OPEN", isPublished: true } });
  if (!job) return 0;
  const subs = await prisma.jobAlertSubscription.findMany({ where: { tenantId, confirmedAt: { not: null }, unsubscribedAt: null }, include: { sent: { where: { jobId } } } });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  let n = 0;
  for (const s of subs) {
    if (s.sent.length || !jobAlertMatches(s, job)) continue;
    await prisma.$transaction([
      prisma.jobAlertSent.create({ data: { subscriptionId: s.id, jobId } }),
      prisma.emailOutbox.create({ data: { tenantId, toAddress: s.email, subject: `New role at ${tenant.name}: ${job.title}`, textBody: `A new role matches your job alert:\n\n${job.title}\n${(baseUrl ?? appBaseUrl()).replace(/\/+$/, "")}/careers/${job.id}\n\nTo stop these emails, use the unsubscribe link in your confirmation email.`, relatedType: "JobAlert", relatedId: s.id } }),
    ]);
    n++;
  }
  return n;
}

