import { prisma, Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { govAudit } from "./governance-core";
import { startWorkflow } from "./workflow-engine";
import { newOfferToken, hashOfferToken, offerTokenSigned } from "./offers-math";
import { appBaseUrl } from "./offers";
import { HIRE_REQUEST_KINDS, type HireRequestKind } from "./hire-depth-core";
import {
  attributeSource, tagsFor, segmentMatches, parseSegmentRules, cadenceStepsOf, hireStringList,
  type ProspectFacts,
} from "./hire-depth-math";

/**
 * Hire depth, database side: hiring requests on the workflow engine, the
 * hire alert job (SLAs, time in stage, stalled applications, overdue
 * feedback, offer answers, requisition approval and aging, pool expiry,
 * consent expiry), attribution after a careers-site application, the
 * applicant portal, job alerts, silver-medallist capture, pool segments,
 * tag rules and outreach cadences.
 */

type R = { ok: boolean; message: string };
const DAY = 86_400_000, HOUR = 3_600_000;

export const HIRE_DEPTH_DEFAULTS = {
  screenSlaHours: 72, feedbackSlaHours: 24, offerResponseSlaHours: 120, requisitionApprovalSlaHours: 48, requisitionMaxAgeDays: 60,
  requirePostingApproval: false, intakeQuestions: [] as string[], offerChecklist: [] as string[], biasTerms: [] as string[],
  noShowLimit: 2, consentValidityDays: 365, reactivationAfterDays: 90,
};
export type HireDepthConfig = typeof HIRE_DEPTH_DEFAULTS;

export async function hireDepthConfig(tenantId: string): Promise<HireDepthConfig> {
  const s = await prisma.hireDepthSetting.findUnique({ where: { tenantId } });
  if (!s) return { ...HIRE_DEPTH_DEFAULTS };
  return {
    screenSlaHours: s.screenSlaHours, feedbackSlaHours: s.feedbackSlaHours, offerResponseSlaHours: s.offerResponseSlaHours,
    requisitionApprovalSlaHours: s.requisitionApprovalSlaHours, requisitionMaxAgeDays: s.requisitionMaxAgeDays, requirePostingApproval: s.requirePostingApproval,
    intakeQuestions: hireStringList(s.intakeQuestions), offerChecklist: hireStringList(s.offerChecklist), biasTerms: hireStringList(s.biasTerms),
    noShowLimit: s.noShowLimit, consentValidityDays: s.consentValidityDays, reactivationAfterDays: s.reactivationAfterDays,
  };
}

// ---------------------------------------------------------------------------
//  Hiring requests on the workflow engine
// ---------------------------------------------------------------------------

export async function startHireRequest(input: {
  tenantId: string; kind: HireRequestKind; entityId: string; title: string; details?: string | null; amount?: number | null;
  data?: Record<string, unknown>; requesterUserId: string; subjectEmployeeId?: string | null; reviewerUserId?: string | null;
}): Promise<R & { requestId?: string; status?: string }> {
  const open = await pendingHireRequest(input.tenantId, input.kind, input.entityId);
  if (open) return { ok: false, message: "This is already waiting for approval." };
  const r = await startWorkflow({
    tenantId: input.tenantId, entityType: "HIRE_REQUEST", entityId: input.entityId, category: input.kind, changeKind: input.kind,
    title: input.title, details: input.details ?? HIRE_REQUEST_KINDS[input.kind].label, amount: input.amount ?? null, data: input.data ?? null,
    requesterUserId: input.requesterUserId, subjectEmployeeId: input.subjectEmployeeId ?? null, reviewerUserId: input.reviewerUserId ?? null,
  });
  if (!r.ok || !r.requestId) return r;
  const after = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: r.requestId }, select: { status: true } });
  return { ...r, status: after.status };
}

export async function pendingHireRequest(tenantId: string, kind: HireRequestKind, entityId: string) {
  return prisma.workflowRequest.findFirst({ where: { tenantId, entityType: "HIRE_REQUEST", category: kind, entityId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
}

/** Pending hiring requests by entity, for showing "waiting for approval" next to records. */
export async function pendingHireRequests(tenantId: string, kind: HireRequestKind, entityIds: string[]): Promise<Set<string>> {
  if (!entityIds.length) return new Set();
  const rows = await prisma.workflowRequest.findMany({ where: { tenantId, entityType: "HIRE_REQUEST", category: kind, entityId: { in: entityIds }, status: "PENDING" }, select: { entityId: true } });
  return new Set(rows.map((r) => r.entityId!).filter(Boolean));
}

// ---------------------------------------------------------------------------
//  Sourcing profiles, attribution, tags
// ---------------------------------------------------------------------------

export async function ensureSourcingProfile(tenantId: string, candidateId: string) {
  return prisma.candidateSourcingProfile.upsert({ where: { candidateId }, create: { tenantId, candidateId }, update: {} });
}

export function prospectFacts(c: { skills: unknown; currentTitle: string | null; currentEmployer: string | null; city: string | null; source: string; totalExperienceYears: Prisma.Decimal | number | null; education: string | null }): ProspectFacts {
  return { skills: c.skills, currentTitle: c.currentTitle, currentEmployer: c.currentEmployer, city: c.city, source: c.source, experienceYears: c.totalExperienceYears === null ? null : Number(c.totalExperienceYears), education: c.education };
}

/** Re-apply the tenant's tag rules to every candidate (or one). Returns how many profiles changed. */
export async function applyTagRules(tenantId: string, candidateId?: string): Promise<number> {
  const rules = await prisma.prospectTagRule.findMany({ where: { tenantId, isActive: true } });
  const cands = await prisma.candidate.findMany({ where: { tenantId, ...(candidateId ? { id: candidateId } : {}) }, include: { sourcingProfile: true }, take: 5000 });
  let changed = 0;
  for (const c of cands) {
    const before = hireStringList(c.sourcingProfile?.tags).map((x) => x.toLowerCase()).sort();
    const after = tagsFor(rules, prospectFacts(c), before);
    if (after.join("|") === before.join("|")) continue;
    await prisma.candidateSourcingProfile.upsert({ where: { candidateId: c.id }, create: { tenantId, candidateId: c.id, tags: after }, update: { tags: after } });
    changed++;
  }
  return changed;
}

/**
 * After someone applies on the careers site: attribute the source (campaign
 * code, then the attribution rules), record the visit context, audit the
 * application, apply tag rules, and send them their applicant portal link.
 */
export async function afterPublicApply(tenantId: string, applicationId: string, ctx: { utmSource?: string | null; utmCampaign?: string | null; campaignCode?: string | null }): Promise<void> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { candidate: true, job: { select: { title: true } } } });
  if (!app) return;
  const code = ctx.campaignCode?.trim().slice(0, 40) || null;
  const campaign = code ? await prisma.sourcingCampaign.findFirst({ where: { tenantId, code, status: "ACTIVE" } }) : null;
  const rules = await prisma.sourceAttributionRule.findMany({ where: { tenantId, isActive: true } });
  const rule = attributeSource(rules, { utmSource: ctx.utmSource ?? null, email: app.candidate.email, campaignCode: code });
  const channelId = campaign?.channelId ?? rule?.channelId ?? null;
  const channel = channelId ? await prisma.sourcingChannel.findFirst({ where: { id: channelId, tenantId } }) : null;
  const source = rule?.source ?? channel?.baseSource ?? null;
  if (source && source !== app.candidate.source && app.candidate.source === "CAREER_PORTAL") await prisma.candidate.update({ where: { id: app.candidateId }, data: { source } });
  await prisma.candidateSourcingProfile.upsert({
    where: { candidateId: app.candidateId },
    create: { tenantId, candidateId: app.candidateId, channelId, campaignId: campaign?.id ?? null, utmSource: ctx.utmSource?.slice(0, 80) ?? null, utmCampaign: ctx.utmCampaign?.slice(0, 80) ?? null },
    update: { ...(channelId ? { channelId } : {}), ...(campaign ? { campaignId: campaign.id } : {}), ...(ctx.utmSource ? { utmSource: ctx.utmSource.slice(0, 80) } : {}), ...(ctx.utmCampaign ? { utmCampaign: ctx.utmCampaign.slice(0, 80) } : {}) },
  });
  await applyTagRules(tenantId, app.candidateId);
  await govAudit(tenantId, null, {
    module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: app.id,
    summary: `${app.candidate.firstName} ${app.candidate.lastName} applied for ${app.job.title} on the careers site${campaign ? ` (campaign ${campaign.name})` : ""}${rule ? ` — attributed by rule “${rule.name}”` : ""}`,
    newValue: { utmSource: ctx.utmSource ?? null, utmCampaign: ctx.utmCampaign ?? null, campaign: code, source: source ?? app.candidate.source },
  });
  await issueApplicantLink(tenantId, applicationId);
}

// ---------------------------------------------------------------------------
//  Applicant portal
// ---------------------------------------------------------------------------

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

/** A fresh applicant link (older ones stop working), emailed to the applicant. */
export async function issueApplicantLink(tenantId: string, applicationId: string, baseUrl?: string): Promise<R & { url?: string }> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { candidate: true, job: { select: { title: true } } } });
  if (!app) return { ok: false, message: "Application not found." };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const { token, hash } = newOfferToken(secret());
  const url = `${(baseUrl ?? appBaseUrl()).replace(/\/+$/, "")}/careers/status/${token}`;
  await prisma.$transaction([
    prisma.applicantPortalLink.updateMany({ where: { applicationId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.applicantPortalLink.create({ data: { tenantId, applicationId, tokenHash: hash, expiresAt: new Date(Date.now() + 180 * DAY) } }),
    prisma.emailOutbox.create({ data: { tenantId, toAddress: app.candidate.email, subject: `Your application for ${app.job.title} at ${tenant.name}`, textBody: `Dear ${app.candidate.firstName},\n\nThank you for applying for ${app.job.title}. Follow your application, update your details or withdraw at any time here:\n\n${url}\n\nThe link is personal to you.\n\nTalent Acquisition, ${tenant.name}`, relatedType: "ApplicantPortal", relatedId: applicationId } }),
  ]);
  return { ok: true, message: `Sent ${app.candidate.firstName} a link to follow their application.`, url };
}

export async function openApplicantLink(token: string, opts: { recordView?: boolean } = {}) {
  if (!offerTokenSigned(token, secret())) return null;
  const link = await prisma.applicantPortalLink.findUnique({ where: { tokenHash: hashOfferToken(token) } });
  if (!link || link.revokedAt || link.expiresAt <= new Date()) return null;
  const app = await prisma.application.findFirst({
    where: { id: link.applicationId, tenantId: link.tenantId },
    include: {
      candidate: { select: { id: true, firstName: true, lastName: true, phone: true, city: true, noticePeriodDays: true, expectedAnnualCtc: true, sourcingProfile: { select: { timeZone: true } } } },
      job: { select: { id: true, title: true, flow: { select: { stages: { select: { id: true, name: true, sequence: true, stageKind: true }, orderBy: { sequence: "asc" } } } } } },
      interviews: { where: { status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] } }, select: { id: true, title: true, scheduledAt: true, durationMinutes: true, mode: true, status: true }, orderBy: { scheduledAt: "asc" } },
    },
  });
  if (!app) return null;
  if (opts.recordView) await prisma.applicantPortalLink.update({ where: { id: link.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } });
  const consents = await prisma.interviewConsent.findMany({ where: { tenantId: link.tenantId, interviewId: { in: app.interviews.map((i) => i.id) } } });
  const requests = await prisma.applicantChangeRequest.findMany({ where: { tenantId: link.tenantId, applicationId: app.id }, orderBy: { createdAt: "desc" }, take: 10 });
  return { link, app, consents, requests };
}

// ---------------------------------------------------------------------------
//  Talent pools: silver medallists, segments, expiry
// ---------------------------------------------------------------------------

async function poolOfKind(tenantId: string, kind: string, name: string, by: string | null) {
  const found = await prisma.talentPool.findFirst({ where: { tenantId, kind, archivedAt: null }, orderBy: { createdAt: "asc" } });
  if (found) return found;
  const taken = await prisma.talentPool.findFirst({ where: { tenantId, name } });
  return prisma.talentPool.create({ data: { tenantId, name: taken ? `${name} (${kind.toLowerCase()})` : name, kind, description: "Kept automatically.", createdBy: by } });
}

/**
 * Finalists who were not hired — reached an offer or the late stages with a
 * good score — go to the silver-medallist pool for the next opening.
 */
export async function captureSilverMedalists(tenantId: string, jobId: string, by: string | null): Promise<number> {
  const job = await prisma.job.findFirst({ where: { id: jobId, tenantId }, include: { flow: { include: { stages: true } } } });
  if (!job) return 0;
  const maxSeq = Math.max(0, ...(job.flow?.stages.map((s) => s.sequence) ?? [0]));
  const lateStages = new Set(job.flow?.stages.filter((s) => s.sequence >= maxSeq - 1 || s.stageKind === "OFFER").map((s) => s.id) ?? []);
  const apps = await prisma.application.findMany({ where: { jobId, tenantId, status: { not: "HIRED" } }, include: { stageHistory: { select: { stageId: true } }, offer: { select: { status: true } } } });
  const finalists = apps.filter((a) => !!a.offer || a.stageHistory.some((h) => lateStages.has(h.stageId)) || (a.averageScore !== null && Number(a.averageScore) >= 3.5));
  if (!finalists.length) return 0;
  const pool = await poolOfKind(tenantId, "SILVER_MEDALIST", "Silver medallists", by);
  const r = await prisma.talentPoolMember.createMany({ data: finalists.map((a) => ({ poolId: pool.id, candidateId: a.candidateId, note: `Finalist for ${job.title}`, addedBy: by })), skipDuplicates: true });
  if (r.count) await govAudit(tenantId, by, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Captured ${r.count} silver medallist(s) from ${job.title}` });
  return r.count;
}

/** Add every candidate matching the pool's segment rules. */
export async function refreshPoolSegment(tenantId: string, poolId: string, by: string | null): Promise<R & { added?: number }> {
  const pool = await prisma.talentPool.findFirst({ where: { id: poolId, tenantId, archivedAt: null } });
  if (!pool) return { ok: false, message: "Pool not found." };
  const rules = parseSegmentRules(pool.rules);
  if (!rules) return { ok: false, message: "This pool has no segment rules." };
  const cands = await prisma.candidate.findMany({ where: { tenantId, convertedEmployeeId: null }, include: { sourcingProfile: { select: { tags: true, isHighPotential: true } } }, take: 5000 });
  const hits = cands.filter((c) => segmentMatches(rules, { ...prospectFacts(c), tags: c.sourcingProfile?.tags, highPotential: c.sourcingProfile?.isHighPotential ?? false }));
  const expiresAt = pool.memberExpiryDays ? new Date(Date.now() + pool.memberExpiryDays * DAY) : null;
  const r = await prisma.talentPoolMember.createMany({ data: hits.map((c) => ({ poolId, candidateId: c.id, note: "Matched the pool's segment", addedBy: by, expiresAt })), skipDuplicates: true });
  await govAudit(tenantId, by, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: poolId, summary: `Refreshed segment of ${pool.name}: ${r.count} added of ${hits.length} matching` });
  return { ok: true, message: `${r.count} candidate(s) added; ${hits.length} match the segment.`, added: r.count };
}

// ---------------------------------------------------------------------------
//  Outreach cadences
// ---------------------------------------------------------------------------

export async function enrollInCadence(tenantId: string, cadenceId: string, candidateId: string, by: string): Promise<R> {
  const [cadence, cand] = await Promise.all([
    prisma.outreachCadence.findFirst({ where: { id: cadenceId, tenantId, isActive: true } }),
    prisma.candidate.findFirst({ where: { id: candidateId, tenantId }, include: { sourcingProfile: true } }),
  ]);
  if (!cadence) return { ok: false, message: "Choose an active cadence." };
  if (!cand) return { ok: false, message: "Candidate not found." };
  const p = cand.sourcingProfile;
  if (p?.consentStatus === "WITHDRAWN" || (p?.consentExpiresAt && p.consentExpiresAt < new Date())) return { ok: false, message: `${cand.firstName} has not consented to contact; record consent first.` };
  if (await prisma.cadenceEnrollment.count({ where: { cadenceId, candidateId, status: "ACTIVE" } })) return { ok: false, message: `${cand.firstName} is already on this cadence.` };
  const start = new Date();
  await prisma.cadenceEnrollment.upsert({ where: { cadenceId_candidateId: { cadenceId, candidateId } }, create: { cadenceId, candidateId, enrolledBy: by, startedAt: start }, update: { status: "ACTIVE", startedAt: start, stoppedAt: null, enrolledBy: by } });
  const steps = cadenceStepsOf(cadence.steps);
  for (const [i, s] of steps.entries()) {
    const key = `cadence:${cadenceId}:${candidateId}:${start.getTime()}:${i}`;
    await prisma.recruiterTask.create({ data: { tenantId, title: `${s.channel.toLowerCase()}: ${s.action} — ${cand.firstName} ${cand.lastName}`, queue: "OUTREACH", assigneeUserId: by, createdBy: by, dueAt: new Date(start.getTime() + s.day * DAY), candidateId, sourceKey: key, details: `Step ${i + 1} of “${cadence.name}”` } });
  }
  await govAudit(tenantId, by, { module: "EMPLOYEE", action: "CREATE", entityType: "CadenceEnrollment", entityId: candidateId, summary: `Enrolled ${cand.firstName} ${cand.lastName} in ${cadence.name} (${steps.length} step(s))` });
  return { ok: true, message: `${cand.firstName} is on “${cadence.name}”; ${steps.length} outreach task(s) are queued.` };
}

// ---------------------------------------------------------------------------
//  Career page versions
// ---------------------------------------------------------------------------

export async function snapshotCareerSite(tenantId: string, by: string | null, note: string | null): Promise<number> {
  const [site, config] = await Promise.all([prisma.careerSiteSetting.findUnique({ where: { tenantId } }), prisma.careerSiteConfig.findUnique({ where: { tenantId } })]);
  const strip = <T extends object | null>(o: T) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !["id", "tenantId", "updatedAt"].includes(k))) : null);
  const last = await prisma.careerSiteSnapshot.findFirst({ where: { tenantId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  await prisma.careerSiteSnapshot.create({ data: { tenantId, version, data: { site: strip(site), config: strip(config) } as Prisma.InputJsonValue, note, createdBy: by } });
  return version;
}

// ---------------------------------------------------------------------------
//  The hire alert job
// ---------------------------------------------------------------------------

async function raise(tenantId: string, a: { kind: string; key: string; entityType: string; entityId: string; message: string; userIds: Array<string | null | undefined>; link: string; task?: { title: string; queue: string; assigneeUserId: string | null; applicationId?: string | null } }): Promise<boolean> {
  const exists = await prisma.hireAlert.findUnique({ where: { tenantId_key: { tenantId, key: a.key } } });
  if (exists) return false;
  const n = await notify({ tenantId, userIds: a.userIds, kind: "HIRING", title: a.message, link: a.link });
  await prisma.hireAlert.create({ data: { tenantId, kind: a.kind, key: a.key, entityType: a.entityType, entityId: a.entityId, message: a.message, notified: n } });
  if (a.task) await prisma.recruiterTask.createMany({ data: [{ tenantId, title: a.task.title, queue: a.task.queue, priority: "HIGH", assigneeUserId: a.task.assigneeUserId, applicationId: a.task.applicationId ?? null, sourceKey: `alert:${a.key}`, dueAt: new Date(Date.now() + DAY) }], skipDuplicates: true });
  return true;
}

const userOfEmployee = async (tenantId: string, employeeId: string | null | undefined) => (employeeId ? (await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { userId: true } }))?.userId ?? null : null);

/**
 * Raise every hiring alert that is due, once each: notifications to the
 * people who can act, a recruiter task where there is something to do, and
 * an HireAlert row so the exception dashboard can list it.
 */
export async function runHireAlerts(tenantId: string, now = new Date()): Promise<Record<string, number>> {
  const cfg = await hireDepthConfig(tenantId);
  const out: Record<string, number> = { stageTime: 0, stalled: 0, screenSla: 0, feedbackOverdue: 0, offerResponse: 0, reqApproval: 0, reqAging: 0, poolExpired: 0, consentExpired: 0 };
  const recruiters = await usersWithPermission(tenantId, "hire.candidate.manage");

  // Time in stage (the stage's own limit) and stalled applications (no movement for 2× the screening SLA).
  const active = await prisma.application.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "ON_HOLD"] } },
    include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true, flow: { select: { stages: true } } } }, stageHistory: { where: { exitedAt: null }, select: { enteredAt: true, stageId: true } } },
  });
  for (const a of active) {
    const h = a.stageHistory[0];
    const entered = h?.enteredAt ?? a.appliedAt;
    const stage = a.job.flow?.stages.find((s) => s.id === a.currentStageId);
    const who = `${a.candidate.firstName} ${a.candidate.lastName}`;
    const days = Math.floor((now.getTime() - entered.getTime()) / DAY);
    const owner = a.ownerId ? [a.ownerId] : recruiters;
    // Application.ownerId (like Job.recruiterId) is a user id.
    const ownerUser = a.ownerId;
    if (stage?.staleAfterDays && days >= stage.staleAfterDays) {
      if (await raise(tenantId, { kind: "STAGE_TIME", key: `stage:${a.id}:${stage.id}`, entityType: "Application", entityId: a.id, message: `${who} has been in ${stage.name} for ${days} days (${a.job.title})`, userIds: owner, link: `/hiring/applications/${a.id}`, task: { title: `Move or close ${who} — ${days} days in ${stage.name}`, queue: "SCREENING", assigneeUserId: ownerUser, applicationId: a.id } })) out.stageTime++;
    }
    if (stage && stage.sequence === Math.min(...(a.job.flow?.stages.map((s) => s.sequence) ?? [stage.sequence])) && now.getTime() - entered.getTime() > cfg.screenSlaHours * HOUR) {
      if (await raise(tenantId, { kind: "SCREEN_SLA", key: `screen:${a.id}`, entityType: "Application", entityId: a.id, message: `${who} has not been screened within ${cfg.screenSlaHours} hours (${a.job.title})`, userIds: owner, link: `/hiring/applications/${a.id}`, task: { title: `Screen ${who} for ${a.job.title}`, queue: "SCREENING", assigneeUserId: ownerUser, applicationId: a.id } })) out.screenSla++;
    }
    if (now.getTime() - Math.max(entered.getTime(), a.updatedAt.getTime()) > 2 * cfg.screenSlaHours * HOUR && days >= 7) {
      if (await raise(tenantId, { kind: "STALLED", key: `stalled:${a.id}:${entered.getTime()}`, entityType: "Application", entityId: a.id, message: `${who}'s application for ${a.job.title} has stalled (${days} days without movement)`, userIds: owner, link: `/hiring/applications/${a.id}` })) out.stalled++;
    }
  }

  // Feedback overdue past the SLA: remind the panellist, escalate to the hiring manager and the recruiter.
  const overdue = await prisma.interview.findMany({
    where: { application: { tenantId }, status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] }, scheduledAt: { lt: new Date(now.getTime() - cfg.feedbackSlaHours * HOUR) } },
    include: { panel: { include: { employee: { select: { userId: true, displayName: true } } } }, scorecards: { where: { status: "SUBMITTED" }, select: { panelistId: true } }, application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true, hiringManagerId: true, recruiterId: true } } } } },
  });
  for (const iv of overdue) {
    const done = new Set(iv.scorecards.map((s) => s.panelistId));
    for (const p of iv.panel.filter((x) => !done.has(x.employeeId))) {
      if (iv.scheduledAt.getTime() + iv.durationMinutes * 60_000 + cfg.feedbackSlaHours * HOUR > now.getTime()) continue;
      const hm = await userOfEmployee(tenantId, iv.application.job.hiringManagerId);
      if (await raise(tenantId, {
        kind: "FEEDBACK_OVERDUE", key: `feedback:${iv.id}:${p.employeeId}`, entityType: "Interview", entityId: iv.id,
        message: `Feedback overdue: ${p.employee.displayName} for ${iv.application.candidate.firstName} ${iv.application.candidate.lastName} (${iv.title})`,
        userIds: [p.employee.userId, hm, iv.application.job.recruiterId, ...(iv.application.job.recruiterId ? [] : recruiters)], link: `/hiring/applications/${iv.applicationId}?tab=feedback`,
        task: { title: `Chase ${p.employee.displayName}'s feedback on ${iv.application.candidate.firstName} ${iv.application.candidate.lastName}`, queue: "FEEDBACK", assigneeUserId: iv.application.job.recruiterId ?? null, applicationId: iv.applicationId },
      })) out.feedbackOverdue++;
    }
  }

  // Extended offers with no answer past the SLA.
  const offers = await prisma.offer.findMany({ where: { status: "EXTENDED", extendedAt: { lt: new Date(now.getTime() - cfg.offerResponseSlaHours * HOUR) }, application: { tenantId } }, include: { application: { include: { candidate: { select: { firstName: true, lastName: true } } } } } });
  const offerManagers = await usersWithPermission(tenantId, "hire.offer.manage");
  for (const o of offers) {
    if (await raise(tenantId, { kind: "OFFER_RESPONSE", key: `offer:${o.id}:${o.extendedAt!.getTime()}`, entityType: "Offer", entityId: o.applicationId, message: `${o.application.candidate.firstName} ${o.application.candidate.lastName} has not answered the offer in ${cfg.offerResponseSlaHours} hours`, userIds: offerManagers, link: `/hiring/offers/${o.applicationId}`, task: { title: `Follow up the offer with ${o.application.candidate.firstName}`, queue: "OFFER", assigneeUserId: o.application.ownerId, applicationId: o.applicationId } })) out.offerResponse++;
  }

  // Requisition approvals past their SLA go to every requisition approver; approved requisitions age out.
  const reqApprovers = await usersWithPermission(tenantId, "hire.requisition.approve");
  const stuck = await prisma.requisition.findMany({ where: { tenantId, status: "PENDING_APPROVAL", archivedAt: null, updatedAt: { lt: new Date(now.getTime() - cfg.requisitionApprovalSlaHours * HOUR) } } });
  for (const r of stuck) {
    if (await raise(tenantId, { kind: "REQ_APPROVAL_SLA", key: `reqsla:${r.id}:${r.updatedAt.getTime()}`, entityType: "Requisition", entityId: r.id, message: `Requisition ${r.code ?? r.title} has waited over ${cfg.requisitionApprovalSlaHours} hours for approval`, userIds: [r.approverUserId, ...reqApprovers], link: "/hiring/requisitions" })) out.reqApproval++;
  }
  const aging = await prisma.requisition.findMany({ where: { tenantId, status: "APPROVED", archivedAt: null, approvedAt: { lt: new Date(now.getTime() - cfg.requisitionMaxAgeDays * DAY) } } });
  for (const r of aging) {
    if (await raise(tenantId, { kind: "REQ_AGING", key: `reqage:${r.id}`, entityType: "Requisition", entityId: r.id, message: `Requisition ${r.code ?? r.title} is over ${cfg.requisitionMaxAgeDays} days old and still unfilled`, userIds: [r.raisedBy, r.recruiterId, ...reqApprovers], link: "/hiring/requisitions" })) out.reqAging++;
  }

  // Pool memberships past their expiry, and consent past its date.
  const expired = await prisma.talentPoolMember.findMany({ where: { status: "ACTIVE", expiresAt: { lt: now }, pool: { tenantId } }, include: { pool: { select: { name: true } } } });
  if (expired.length) {
    await prisma.talentPoolMember.updateMany({ where: { id: { in: expired.map((m) => m.id) } }, data: { status: "EXPIRED" } });
    out.poolExpired = expired.length;
    await govAudit(tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", summary: `Expired ${expired.length} pool membership(s) past their expiry date` });
  }
  const lapsed = await prisma.candidateSourcingProfile.findMany({ where: { tenantId, consentStatus: "GRANTED", consentExpiresAt: { lt: now } } });
  if (lapsed.length) {
    await prisma.candidateSourcingProfile.updateMany({ where: { id: { in: lapsed.map((p) => p.id) } }, data: { consentStatus: "EXPIRED" } });
    await prisma.cadenceEnrollment.updateMany({ where: { candidateId: { in: lapsed.map((p) => p.candidateId) }, status: "ACTIVE" }, data: { status: "STOPPED", stoppedAt: now } });
    out.consentExpired = lapsed.length;
    await govAudit(tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "CandidateSourcingProfile", summary: `Consent lapsed for ${lapsed.length} prospect(s); outreach stopped` });
  }
  await prisma.hireDepthSetting.upsert({ where: { tenantId }, create: { tenantId, alertsLastRunAt: now }, update: { alertsLastRunAt: now } });
  return out;
}
