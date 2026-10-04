import "server-only";
import { prisma } from "@keka/db";
import { sourceAnalytics, hireMonthsBetween, calibration, offerTurnaround, hireMedian, stageConversion, type SourceRow } from "@keka/services";

/**
 * The numbers behind Hire › Insights and its CSV exports: source quality and
 * ROI, stage conversion, recruiter workload, offer turnaround, interviewer
 * calibration and careers-site traffic.
 */

const DAY = 86_400_000;

export async function sourceInsights(tenantId: string, since: Date, valuePerHire: number) {
  const apps = await prisma.application.findMany({
    where: { tenantId, appliedAt: { gte: since } },
    select: { id: true, status: true, averageScore: true, candidate: { select: { source: true, sourcingProfile: { select: { channelId: true } } } }, _count: { select: { interviews: true } }, offer: { select: { id: true } } },
  });
  const channels = await prisma.sourcingChannel.findMany({ where: { tenantId } });
  const campaigns = await prisma.sourcingCampaign.findMany({ where: { tenantId, OR: [{ startsOn: null }, { startsOn: { gte: since } }, { endsOn: { gte: since } }] }, select: { channelId: true, budget: true } });
  const now = new Date();
  const rows = new Map<string, SourceRow & { scores: number[] }>();
  const row = (key: string, label: string) => rows.get(key) ?? (rows.set(key, { key, label, applicants: 0, interviewed: 0, offered: 0, hired: 0, avgScore: null, cost: 0, scores: [] }), rows.get(key)!);
  for (const a of apps) {
    const ch = channels.find((c) => c.id === a.candidate.sourcingProfile?.channelId);
    const r = ch ? row(`channel:${ch.id}`, ch.name) : row(`source:${a.candidate.source}`, a.candidate.source.toLowerCase().replace(/_/g, " "));
    r.applicants++;
    if (a._count.interviews) r.interviewed++;
    if (a.offer) r.offered++;
    if (a.status === "HIRED") r.hired++;
    if (a.averageScore !== null) r.scores.push(Number(a.averageScore));
  }
  for (const ch of channels) {
    const r = row(`channel:${ch.id}`, ch.name);
    const start = ch.createdAt > since ? ch.createdAt : since;
    r.cost += Math.round((ch.monthlyCost ? Number(ch.monthlyCost) : 0) * (ch.status === "ACTIVE" ? hireMonthsBetween(start, now) : 0));
    r.cost += campaigns.filter((c) => c.channelId === ch.id).reduce((s, c) => s + Number(c.budget ?? 0), 0);
  }
  const list = [...rows.values()].filter((r) => r.applicants || r.cost).map(({ scores, ...r }) => ({ ...r, avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null }));
  return sourceAnalytics(list, valuePerHire);
}

export async function workloadInsights(tenantId: string) {
  const [open, tasks] = await Promise.all([
    prisma.application.groupBy({ by: ["ownerId"], where: { tenantId, status: { in: ["ACTIVE", "ON_HOLD"] } }, _count: { _all: true } }),
    prisma.recruiterTask.groupBy({ by: ["assigneeUserId"], where: { tenantId, status: "OPEN" }, _count: { _all: true } }),
  ]);
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: [...open.map((o) => o.ownerId), ...tasks.map((t) => t.assigneeUserId)].filter((x): x is string => !!x) } }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
  const name = new Map(users.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const ids = [...new Set([...open.map((o) => o.ownerId), ...tasks.map((t) => t.assigneeUserId)])];
  return ids.map((id) => ({ userId: id, name: id ? name.get(id) ?? "Unknown" : "Unassigned", openApplications: open.find((o) => o.ownerId === id)?._count._all ?? 0, openTasks: tasks.find((t) => t.assigneeUserId === id)?._count._all ?? 0 })).sort((a, b) => b.openApplications - a.openApplications);
}

export async function offerInsights(tenantId: string, since: Date) {
  const offers = await prisma.offer.findMany({ where: { application: { tenantId }, createdAt: { gte: since } }, select: { status: true, createdAt: true, approvedAt: true, extendedAt: true, respondedAt: true, applicationId: true } });
  const t = offers.map(offerTurnaround);
  const decided = offers.filter((o) => o.status === "ACCEPTED" || o.status === "DECLINED");
  const versions = await prisma.offerVersion.groupBy({ by: ["applicationId"], where: { tenantId, event: "REVISED" }, _count: { _all: true } });
  return {
    count: offers.length, accepted: offers.filter((o) => o.status === "ACCEPTED").length, declined: offers.filter((o) => o.status === "DECLINED").length,
    acceptanceRate: decided.length ? Math.round((offers.filter((o) => o.status === "ACCEPTED").length / decided.length) * 1000) / 10 : null,
    medianToApprove: hireMedian(t.map((x) => x.toApprove)), medianToExtend: hireMedian(t.map((x) => x.toExtend)), medianToRespond: hireMedian(t.map((x) => x.toRespond)), medianTotal: hireMedian(t.map((x) => x.total)),
    revised: versions.length,
  };
}

export async function calibrationInsights(tenantId: string, since: Date) {
  const cards = await prisma.scorecard.findMany({ where: { status: "SUBMITTED", interview: { application: { tenantId }, scheduledAt: { gte: since } } }, select: { panelistId: true, interviewId: true, overallScore: true, recommendation: true } });
  const rows = calibration(cards.map((c) => ({ panelistId: c.panelistId, interviewId: c.interviewId, score: c.overallScore === null ? null : Number(c.overallScore), recommendation: c.recommendation })));
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: rows.map((r) => r.panelistId) } }, select: { id: true, displayName: true } });
  const name = new Map(emps.map((e) => [e.id, e.displayName ?? e.id]));
  return rows.map((r) => ({ ...r, name: name.get(r.panelistId) ?? "Interviewer" }));
}

export async function stageInsights(tenantId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, tenantId }, include: { flow: { include: { stages: true } } } });
  if (!job?.flow) return [];
  const history = await prisma.applicationStageHistory.findMany({ where: { application: { jobId, tenantId } }, select: { applicationId: true, stageId: true, enteredAt: true, exitedAt: true } });
  return stageConversion(job.flow.stages, history);
}

export async function visitInsights(tenantId: string, since: Date) {
  const visits = await prisma.careerSiteVisit.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { utmSource: true, campaignCode: true, referrerHost: true, jobId: true } });
  const by = (f: (v: (typeof visits)[number]) => string | null) => {
    const m = new Map<string, number>();
    for (const v of visits) { const k = f(v) ?? "(direct)"; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  };
  return { total: visits.length, jobViews: visits.filter((v) => v.jobId).length, bySource: by((v) => v.utmSource ?? v.referrerHost), byCampaign: by((v) => v.campaignCode) };
}

/** Where the candidate database lives: candidates per city, with how many are active, passive or high-potential and their commonest skills. */
export async function talentMap(tenantId: string) {
  const cands = await prisma.candidate.findMany({ where: { tenantId }, select: { city: true, skills: true, sourcingProfile: { select: { isPassive: true, isHighPotential: true } }, applications: { select: { status: true } } }, take: 50000 });
  const m = new Map<string, { city: string; candidates: number; active: number; passive: number; highPotential: number; skills: Map<string, number> }>();
  for (const c of cands) {
    const city = c.city?.trim() || "Unknown";
    const key = city.toLowerCase();
    const r = m.get(key) ?? (m.set(key, { city, candidates: 0, active: 0, passive: 0, highPotential: 0, skills: new Map() }), m.get(key)!);
    r.candidates++;
    if (c.applications.some((a) => a.status === "ACTIVE" || a.status === "ON_HOLD")) r.active++;
    if (c.sourcingProfile?.isPassive) r.passive++;
    if (c.sourcingProfile?.isHighPotential) r.highPotential++;
    for (const k of Array.isArray(c.skills) ? (c.skills as unknown[]) : []) if (typeof k === "string" && k.trim()) r.skills.set(k.trim().toLowerCase(), (r.skills.get(k.trim().toLowerCase()) ?? 0) + 1);
  }
  return [...m.values()].map((r) => ({ city: r.city, candidates: r.candidates, active: r.active, passive: r.passive, highPotential: r.highPotential, topSkills: [...r.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k) })).sort((a, b) => b.candidates - a.candidates);
}

/** Interviews per role (job): volume, completion, no-shows, cancellations, the average submitted score and how often panels said hire. */
export async function interviewsByRole(tenantId: string, since: Date) {
  const ivs = await prisma.interview.findMany({ where: { application: { tenantId }, scheduledAt: { gte: since } }, select: { status: true, application: { select: { job: { select: { id: true, title: true } } } }, scorecards: { where: { status: "SUBMITTED" }, select: { overallScore: true, recommendation: true } } } });
  const m = new Map<string, { jobId: string; role: string; interviews: number; completed: number; noShows: number; cancelled: number; scores: number[]; cards: number; hireRecs: number }>();
  for (const iv of ivs) {
    const j = iv.application.job;
    const r = m.get(j.id) ?? (m.set(j.id, { jobId: j.id, role: j.title, interviews: 0, completed: 0, noShows: 0, cancelled: 0, scores: [], cards: 0, hireRecs: 0 }), m.get(j.id)!);
    r.interviews++;
    if (iv.status === "COMPLETED") r.completed++;
    if (iv.status === "NO_SHOW") r.noShows++;
    if (iv.status === "CANCELLED") r.cancelled++;
    for (const c of iv.scorecards) { r.cards++; if (c.overallScore !== null) r.scores.push(Number(c.overallScore)); if (/HIRE/.test(c.recommendation ?? "") && !/NO/.test(c.recommendation ?? "")) r.hireRecs++; }
  }
  return [...m.values()].map(({ scores, ...r }) => ({ ...r, avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null, noShowRate: r.interviews ? Math.round((r.noShows / r.interviews) * 1000) / 10 : 0, hireRate: r.cards ? Math.round((r.hireRecs / r.cards) * 1000) / 10 : null })).sort((a, b) => b.interviews - a.interviews);
}

// ---------------------------------------------------------------------------
//  CSV reports
// ---------------------------------------------------------------------------

export const HIRE_REPORTS = {
  sources: "Source quality and ROI", workload: "Recruiter workload", offers: "Offer turnaround and versions", calibration: "Interviewer calibration",
  visits: "Careers site visits", tasks: "Recruiting tasks", exceptions: "Hiring exceptions", campaigns: "Sourcing campaigns", referrals: "Referrals and bonuses",
  dispositions: "Rejection and withdrawal reasons", audit: "Hiring audit trail",
  candidates: "Candidate database", locations: "Talent map by location", interviews: "Interviews by role", pools: "Talent pools",
  postings: "Job postings", approvals: "Hiring approvals",
} as const;
export type HireReportKind = keyof typeof HIRE_REPORTS;

const ymd = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");
const AUDITED = ["RecruiterTask", "SourcingChannel", "SourcingCampaign", "SourcingProject", "SavedSourcingSearch", "CandidateSourcingProfile", "CandidateCommunication", "CandidateDocument", "ReferralRecord", "CareerContent", "CareerSiteConfig", "CareerSiteSnapshot", "InterviewPlan", "Interview", "InterviewConsent", "InterviewerCapacity", "InterviewGuide", "QuestionBankItem", "Offer", "OfferNegotiation", "OfferClause", "Application", "Candidate", "TalentPool", "HiringStage", "HiringFlow", "JobPostingMeta", "Job", "ApplicantChangeRequest", "HireDepthSetting", "DispositionReason", "Scorecard", "HireAlert", "ProspectTagRule", "SourceAttributionRule", "RecruitmentAgency", "OutreachCadence", "CadenceEnrollment", "JobAlertSubscription", "Requisition"];

export async function hireReport(tenantId: string, kind: HireReportKind, since: Date): Promise<{ title: string; head: string[]; rows: unknown[][] }> {
  const title = HIRE_REPORTS[kind];
  switch (kind) {
    case "sources": {
      const s = await sourceInsights(tenantId, since, 0);
      return { title, head: ["Source", "Applicants", "Interviewed", "Offered", "Hired", "Hire rate %", "vs benchmark", "Quality", "Cost", "Cost per hire"], rows: s.rows.map((r) => [r.label, r.applicants, r.interviewed, r.offered, r.hired, r.hireRate, r.vsBenchmark, r.quality, r.cost, r.costPerHire ?? ""]) };
    }
    case "workload": {
      const w = await workloadInsights(tenantId);
      return { title, head: ["Recruiter", "Open applications", "Open tasks"], rows: w.map((r) => [r.name, r.openApplications, r.openTasks]) };
    }
    case "offers": {
      const offers = await prisma.offer.findMany({ where: { application: { tenantId }, createdAt: { gte: since } }, include: { application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } } } });
      const versions = await prisma.offerVersion.groupBy({ by: ["applicationId"], where: { tenantId }, _max: { version: true } });
      const v = new Map(versions.map((x) => [x.applicationId, x._max.version ?? 0]));
      return { title, head: ["Candidate", "Job", "Status", "CTC", "Days to approve", "Days to extend", "Days to answer", "Versions"], rows: offers.map((o) => { const t = offerTurnaround(o); return [`${o.application.candidate.firstName} ${o.application.candidate.lastName}`, o.application.job.title, o.status, Number(o.annualCtc), t.toApprove ?? "", t.toExtend ?? "", t.toRespond ?? "", v.get(o.applicationId) ?? 0]; }) };
    }
    case "calibration": {
      const c = await calibrationInsights(tenantId, since);
      return { title, head: ["Interviewer", "Scorecards", "Mean score", "Delta vs panel", "Hire recommendation %", "Assessment"], rows: c.map((r) => [r.name, r.count, r.mean ?? "", r.delta ?? "", r.hireRate, r.label]) };
    }
    case "visits": {
      const visits = await prisma.careerSiteVisit.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20000 });
      return { title, head: ["When", "Page", "UTM source", "UTM medium", "UTM campaign", "Campaign code", "Referrer"], rows: visits.map((x) => [x.createdAt.toISOString(), x.path, x.utmSource ?? "", x.utmMedium ?? "", x.utmCampaign ?? "", x.campaignCode ?? "", x.referrerHost ?? ""]) };
    }
    case "tasks": {
      const tasks = await prisma.recruiterTask.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
      return { title, head: ["Task", "Queue", "Priority", "Status", "Assignee", "Due", "Completed", "Outcome"], rows: tasks.map((t) => [t.title, t.queue, t.priority, t.status, t.assigneeUserId ?? "", ymd(t.dueAt), ymd(t.completedAt), t.outcome ?? ""]) };
    }
    case "exceptions": {
      const a = await prisma.hireAlert.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
      return { title, head: ["Raised", "Kind", "Exception", "Record", "Resolved"], rows: a.map((x) => [x.createdAt.toISOString(), x.kind, x.message, `${x.entityType} ${x.entityId}`, ymd(x.resolvedAt)]) };
    }
    case "campaigns": {
      const c = await prisma.sourcingCampaign.findMany({ where: { tenantId }, include: { channel: { select: { name: true } } } });
      const counts = await prisma.candidateSourcingProfile.groupBy({ by: ["campaignId"], where: { tenantId, campaignId: { in: c.map((x) => x.id) } }, _count: { _all: true } });
      const visits = await prisma.careerSiteVisit.groupBy({ by: ["campaignCode"], where: { tenantId, campaignCode: { in: c.map((x) => x.code) } }, _count: { _all: true } });
      return { title, head: ["Campaign", "Code", "Channel", "Status", "Budget", "Starts", "Ends", "Visits", "Candidates"], rows: c.map((x) => [x.name, x.code, x.channel?.name ?? "", x.status, Number(x.budget ?? 0), ymd(x.startsOn), ymd(x.endsOn), visits.find((v) => v.campaignCode === x.code)?._count._all ?? 0, counts.find((v) => v.campaignId === x.id)?._count._all ?? 0]) };
    }
    case "referrals": {
      const r = await prisma.candidate.findMany({ where: { tenantId, referredById: { not: null } }, include: { referredBy: { select: { displayName: true } }, referralRecord: true, applications: { select: { status: true } } } });
      return { title, head: ["Candidate", "Referred by", "Relationship", "Best status", "Bonus status", "Bonus amount", "Paid on"], rows: r.map((c) => [`${c.firstName} ${c.lastName}`, c.referredBy?.displayName ?? "", c.referralRecord?.relationship ?? "", c.applications.some((a) => a.status === "HIRED") ? "HIRED" : c.applications[0]?.status ?? "", c.referralRecord?.bonusStatus ?? "NONE", Number(c.referralRecord?.bonusAmount ?? 0), ymd(c.referralRecord?.bonusPaidAt)]) };
    }
    case "dispositions": {
      const r = await prisma.applicationDisposition.groupBy({ by: ["kind", "label"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } });
      return { title, head: ["Kind", "Reason", "Applications"], rows: r.sort((a, b) => b._count._all - a._count._all).map((x) => [x.kind, x.label, x._count._all]) };
    }
    case "candidates": {
      const r = await prisma.candidate.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20000, include: { sourcingProfile: true, applications: { orderBy: { appliedAt: "desc" }, select: { status: true, job: { select: { title: true } } } } } });
      return { title, head: ["Name", "Email", "City", "Source", "Engagement", "Passive", "High potential", "Consent", "Applications", "Latest", "Added"], rows: r.map((c) => [`${c.firstName} ${c.lastName}`, c.email, c.city ?? "", c.source, c.sourcingProfile?.engagementStatus ?? "", c.sourcingProfile?.isPassive ? "yes" : "", c.sourcingProfile?.isHighPotential ? "yes" : "", c.sourcingProfile?.consentStatus ?? "", c.applications.length, c.applications[0] ? `${c.applications[0].job.title} (${c.applications[0].status})` : "", ymd(c.createdAt)]) };
    }
    case "locations": {
      const r = await talentMap(tenantId);
      return { title, head: ["City", "Candidates", "Active applicants", "Passive", "High potential", "Top skills"], rows: r.map((x) => [x.city, x.candidates, x.active, x.passive, x.highPotential, x.topSkills.join("; ")]) };
    }
    case "interviews": {
      const r = await interviewsByRole(tenantId, since);
      return { title, head: ["Role", "Interviews", "Completed", "No-shows", "No-show %", "Cancelled", "Feedback forms", "Average score", "Hire recommendations %"], rows: r.map((x) => [x.role, x.interviews, x.completed, x.noShows, x.noShowRate, x.cancelled, x.cards, x.avgScore ?? "", x.hireRate ?? ""]) };
    }
    case "pools": {
      const r = await prisma.talentPool.findMany({ where: { tenantId }, include: { members: { select: { status: true } } }, orderBy: { name: "asc" } });
      const n = (p: (typeof r)[number], st: string) => p.members.filter((m) => m.status === st).length;
      return { title, head: ["Pool", "Kind", "Active", "Waiting approval", "Expired", "Needs approval", "Expiry (days)", "Segment rules", "Archived"], rows: r.map((p) => [p.name, p.kind, n(p, "ACTIVE"), n(p, "PENDING_APPROVAL"), n(p, "EXPIRED"), p.requiresApproval ? "yes" : "", p.memberExpiryDays ?? "", p.rules ? "yes" : "", ymd(p.archivedAt)]) };
    }
    case "postings": {
      const jobs = await prisma.job.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, include: { _count: { select: { applications: true } } } });
      const [metas, views] = await Promise.all([
        prisma.jobPostingMeta.findMany({ where: { tenantId, jobId: { in: jobs.map((j) => j.id) } } }),
        prisma.careerSiteVisit.groupBy({ by: ["jobId"], where: { tenantId, jobId: { in: jobs.map((j) => j.id) }, createdAt: { gte: since } }, _count: { _all: true } }),
      ]);
      const meta = new Map(metas.map((m) => [m.jobId, m]));
      return { title, head: ["Job", "Code", "Status", "On careers site", "Published on", "Closes", "Applicants", "Careers views", "Search title", "Languages"], rows: jobs.map((j) => [j.title, j.code ?? "", j.status, j.isPublished ? "yes" : "no", ymd(j.publishedAt), ymd(j.closesAt), j._count.applications, views.find((v) => v.jobId === j.id)?._count._all ?? 0, meta.get(j.id)?.seoTitle ?? "", Object.keys((meta.get(j.id)?.translations as Record<string, unknown> | null) ?? {}).join("; ")]) };
    }
    case "approvals": {
      const [reqs, steps] = await Promise.all([
        prisma.workflowRequest.findMany({ where: { tenantId, entityType: "HIRE_REQUEST", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20000 }),
        prisma.hireApprovalStep.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20000 }),
      ]);
      const users = await prisma.user.findMany({ where: { tenantId, id: { in: [...reqs.map((r) => r.requesterUserId), ...steps.map((x) => x.approverUserId)] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
      const who = (id: string) => { const u = users.find((x) => x.id === id); return u ? u.employee?.displayName ?? u.email : id; };
      const hrs = (a: Date, b: Date | null) => (b ? Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10 : "");
      return { title, head: ["Raised", "Kind", "What", "Status", "Requested by / approver", "Decided", "Hours to decide"], rows: [
        ...reqs.map((r) => [r.createdAt.toISOString(), r.category ?? "", r.title, r.status, who(r.requesterUserId), r.decidedAt ? r.decidedAt.toISOString() : "", hrs(r.createdAt, r.decidedAt)]),
        ...steps.map((x) => [x.createdAt.toISOString(), `${x.kind} chain (level ${x.sequence})`, x.entityId, x.status, who(x.approverUserId), x.decidedAt ? x.decidedAt.toISOString() : "", hrs(x.createdAt, x.decidedAt)]),
      ] };
    }
    case "audit": {
      const logs = await prisma.auditLog.findMany({ where: { tenantId, entityType: { in: AUDITED }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20000 });
      return { title, head: ["When", "Action", "Record", "Record id", "Summary", "By"], rows: logs.map((l) => [l.createdAt.toISOString(), l.action, l.entityType, l.entityId ?? "", l.summary ?? "", l.actorId ?? "system"]) };
    }
  }
}

export async function timeToHire(tenantId: string, since: Date): Promise<number | null> {
  const hired = await prisma.application.findMany({ where: { tenantId, status: "HIRED", appliedAt: { gte: since } }, select: { appliedAt: true, offer: { select: { respondedAt: true } } } });
  return hireMedian(hired.map((h) => (h.offer?.respondedAt ? Math.round(((h.offer.respondedAt.getTime() - h.appliedAt.getTime()) / DAY) * 10) / 10 : null)));
}
