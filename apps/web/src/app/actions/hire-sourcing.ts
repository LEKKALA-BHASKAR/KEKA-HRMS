"use server";

import { prisma, Prisma } from "@keka/db";
import {
  startHireRequest, applyTagRules, refreshPoolSegment, enrollInCadence, captureSilverMedalists, hireDepthConfig, applyCandidate, notify,
  parseBooleanQuery, matchesBoolean, candidateHaystack, parseSegmentRules, parseCadenceSteps, parseLinkedProfile, mapImportRow, parseCsv,
  hireStringList, TAG_RULE_FIELDS, CANDIDATE_IMPORT_FIELDS,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { HP, requireAnyOf, str, fail, numField, dateOf, tenantUser } from "@/lib/hire-depth";

/**
 * Hire depth — candidate sourcing: channels and campaigns (approved on the
 * workflow engine), sourcing projects and their prospects, saved boolean
 * searches, prospect profiles and consent, tag and attribution rules,
 * agencies, outreach cadences, talent-pool management, re-attribution and
 * candidate import.
 */

const SOURCES = ["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"] as const;
type Source = (typeof SOURCES)[number];
const sourceOf = (v: string): Source | null => ((SOURCES as readonly string[]).includes(v) ? (v as Source) : null);
const SP = ["/hiring/sourcing"];
const DAY = 86_400_000;

async function candidateOf(tenantId: string, id: string) {
  return prisma.candidate.findFirst({ where: { id, tenantId } });
}

// ---------------------------------------------------------------------------
//  Channels
// ---------------------------------------------------------------------------

export async function createChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const name = str(f, "name", 80);
  const base = sourceOf(str(f, "baseSource"));
  if (name.length < 2) return fail("Name the channel.", f, { name: "Required" });
  if (!base) return fail("Choose what kind of source it is.", f, { baseSource: "Required" });
  if (await prisma.sourcingChannel.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A channel with that name exists.", f, { name: "Taken" });
  const cost = numField(f, "monthlyCost");
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return fail("Enter a valid monthly cost.", f, { monthlyCost: "Invalid" });
  const ch = await prisma.sourcingChannel.create({ data: { tenantId: viewer.tenantId, name, baseSource: base, description: str(f, "description", 500) || null, monthlyCost: cost, createdBy: viewer.user.id } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "CHANNEL_ACTIVATION", entityId: ch.id, title: `Activate sourcing channel ${name}${cost ? ` (₹${cost.toLocaleString("en-IN")}/month)` : ""}`, amount: cost, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "SourcingChannel", entityId: ch.id, summary: `Proposed sourcing channel ${name} (${base})` });
  return done(SP, r.ok && r.status === "PENDING" ? "Channel sent for approval." : r.ok ? "Channel active." : r.message);
}

export async function deactivateChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const ch = await prisma.sourcingChannel.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!ch) return fail("Channel not found.");
  if (ch.status !== "ACTIVE") return fail("Only an active channel can be switched off.");
  await prisma.sourcingChannel.update({ where: { id: ch.id }, data: { status: "INACTIVE" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingChannel", entityId: ch.id, summary: `Deactivated channel ${ch.name}` });
  return done(SP, "Channel switched off.");
}

export async function reactivateChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const ch = await prisma.sourcingChannel.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!ch || !["INACTIVE", "REJECTED"].includes(ch.status)) return fail("Only an inactive channel can be proposed again.");
  await prisma.sourcingChannel.update({ where: { id: ch.id }, data: { status: "PENDING_APPROVAL" } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "CHANNEL_ACTIVATION", entityId: ch.id, title: `Reactivate sourcing channel ${ch.name}`, amount: ch.monthlyCost === null ? null : Number(ch.monthlyCost), requesterUserId: viewer.user.id });
  if (!r.ok) { await prisma.sourcingChannel.update({ where: { id: ch.id }, data: { status: ch.status } }); return fail(r.message); }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingChannel", entityId: ch.id, summary: `Asked to reactivate channel ${ch.name}` });
  return done(SP, r.status === "PENDING" ? "Sent for approval." : "Channel active.");
}

// ---------------------------------------------------------------------------
//  Campaigns
// ---------------------------------------------------------------------------

export async function saveCampaignAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const id = str(f, "id");
  const existing = id ? await prisma.sourcingCampaign.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
  if (id && !existing) return fail("Campaign not found.");
  if (existing && !["DRAFT", "PAUSED", "REJECTED"].includes(existing.status)) return fail("Pause the campaign before editing it.");
  const name = str(f, "name", 120);
  const code = (str(f, "code", 40) || name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (name.length < 3) return fail("Name the campaign.", f, { name: "Required" });
  if (!code) return fail("Give the campaign a tracking code.", f, { code: "Required" });
  const clash = await prisma.sourcingCampaign.findFirst({ where: { tenantId: viewer.tenantId, OR: [{ code }, { name }], NOT: { id: existing?.id ?? "-" } } });
  if (clash) return fail("Another campaign uses that name or code.", f, { code: "Taken" });
  const jobId = str(f, "jobId") || null, channelId = str(f, "channelId") || null;
  if (jobId && !(await prisma.job.count({ where: { id: jobId, tenantId: viewer.tenantId } }))) return fail("Job not found.", f, { jobId: "Not found" });
  if (channelId && !(await prisma.sourcingChannel.count({ where: { id: channelId, tenantId: viewer.tenantId } }))) return fail("Channel not found.", f, { channelId: "Not found" });
  const budget = numField(f, "budget"), target = numField(f, "targetApplicants");
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) return fail("Enter a valid budget.", f, { budget: "Invalid" });
  if (target !== null && (!Number.isInteger(target) || target < 1)) return fail("Target applicants is a whole number.", f, { targetApplicants: "Invalid" });
  const startsOn = dateOf(f, "startsOn"), endsOn = dateOf(f, "endsOn");
  if (startsOn && endsOn && endsOn < startsOn) return fail("The campaign ends before it starts.", f, { endsOn: "Before start" });
  const data = { name, code, jobId, channelId, budget, targetApplicants: target, startsOn, endsOn, description: str(f, "description", 2000) || null };
  const c = existing
    ? await prisma.sourcingCampaign.update({ where: { id: existing.id }, data: { ...data, status: existing.status === "REJECTED" ? "DRAFT" : existing.status } })
    : await prisma.sourcingCampaign.create({ data: { tenantId: viewer.tenantId, ...data, ownerUserId: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "SourcingCampaign", entityId: c.id, summary: `${existing ? "Edited" : "Created"} campaign ${name} (${code})`, oldValue: existing ? { name: existing.name, budget: existing.budget?.toString() ?? null } : undefined, newValue: { name, code, budget } });
  return done([...SP, `/hiring/sourcing/campaigns/${c.id}`], existing ? "Campaign saved." : "Campaign drafted — submit it to launch.");
}

export async function submitCampaignAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const c = await prisma.sourcingCampaign.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId }, include: { channel: true } });
  if (!c) return fail("Campaign not found.");
  if (!["DRAFT", "REJECTED"].includes(c.status)) return fail(`The campaign is ${c.status.toLowerCase().replace("_", " ")}.`);
  if (c.channel && c.channel.status !== "ACTIVE") return fail(`The channel ${c.channel.name} is not active yet.`);
  await prisma.sourcingCampaign.update({ where: { id: c.id }, data: { status: "PENDING_APPROVAL" } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "CAMPAIGN_LAUNCH", entityId: c.id, title: `Launch campaign ${c.name}${c.budget ? ` (budget ₹${Number(c.budget).toLocaleString("en-IN")})` : ""}`, details: c.description, amount: c.budget === null ? null : Number(c.budget), requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!r.ok) { await prisma.sourcingCampaign.update({ where: { id: c.id }, data: { status: c.status } }); return fail(r.message); }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingCampaign", entityId: c.id, summary: `Submitted campaign ${c.name} for launch` });
  return done([...SP, `/hiring/sourcing/campaigns/${c.id}`], r.status === "PENDING" ? "Sent for launch approval." : "Campaign live.");
}

export async function campaignStatusAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const c = await prisma.sourcingCampaign.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!c) return fail("Campaign not found.");
  const to = str(f, "status");
  const allowed: Record<string, string[]> = { PAUSED: ["ACTIVE"], ACTIVE: ["PAUSED"], CLOSED: ["ACTIVE", "PAUSED", "DRAFT"] };
  if (!allowed[to]?.includes(c.status)) return fail(`A ${c.status.toLowerCase()} campaign cannot be ${to.toLowerCase()}.`);
  await prisma.sourcingCampaign.update({ where: { id: c.id }, data: { status: to } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingCampaign", entityId: c.id, summary: `Campaign ${c.name}: ${c.status} → ${to}` });
  return done([...SP, `/hiring/sourcing/campaigns/${c.id}`], `Campaign ${to.toLowerCase()}.`);
}

// ---------------------------------------------------------------------------
//  Sourcing projects and prospects
// ---------------------------------------------------------------------------

const PROSPECT_STAGES = ["IDENTIFIED", "CONTACTED", "RESPONDED", "INTERESTED", "NOT_INTERESTED", "APPLIED"];

export async function createProjectAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const name = str(f, "name", 120);
  if (name.length < 3) return fail("Name the project.", f, { name: "Required" });
  if (await prisma.sourcingProject.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A project with that name exists.", f, { name: "Taken" });
  const jobId = str(f, "jobId") || null;
  if (jobId && !(await prisma.job.count({ where: { id: jobId, tenantId: viewer.tenantId } }))) return fail("Job not found.");
  const members: string[] = [];
  for (const m of f.getAll("memberUserIds").map(String).filter(Boolean)) if (await tenantUser(viewer, m)) members.push(m);
  const p = await prisma.sourcingProject.create({ data: { tenantId: viewer.tenantId, name, description: str(f, "description", 1000) || null, jobId, ownerUserId: viewer.user.id, memberUserIds: members } });
  if (members.length) await notify({ tenantId: viewer.tenantId, userIds: members.filter((m) => m !== viewer.user.id), kind: "HIRING", title: `You were added to the sourcing project ${name}`, link: `/hiring/sourcing/projects/${p.id}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "SourcingProject", entityId: p.id, summary: `Created sourcing project ${name}` });
  return done(["/hiring/sourcing/projects"], "Project created.");
}

export async function addProjectMemberAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const p = await prisma.sourcingProject.findFirst({ where: { id: str(f, "projectId"), tenantId: viewer.tenantId } });
  if (!p) return fail("Project not found.");
  const u = str(f, "userId");
  if (!(await tenantUser(viewer, u))) return fail("Choose a colleague.", f, { userId: "Required" });
  const members = hireStringList(p.memberUserIds);
  if (members.includes(u)) return fail("They are already on the project.");
  await prisma.sourcingProject.update({ where: { id: p.id }, data: { memberUserIds: [...members, u] } });
  await notify({ tenantId: viewer.tenantId, userIds: [u], kind: "HIRING", title: `You were added to the sourcing project ${p.name}`, link: `/hiring/sourcing/projects/${p.id}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingProject", entityId: p.id, summary: `Added a collaborator to ${p.name}` });
  return done([`/hiring/sourcing/projects/${p.id}`], "Collaborator added.");
}

/** Add a prospect — an existing candidate, or a new one sourced directly. */
export async function addProspectAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const p = await prisma.sourcingProject.findFirst({ where: { id: str(f, "projectId"), tenantId: viewer.tenantId } });
  if (!p) return fail("Project not found.");
  let cand = str(f, "candidateId") ? await candidateOf(viewer.tenantId, str(f, "candidateId")) : null;
  if (!cand) {
    const email = str(f, "email", 200).toLowerCase(), firstName = str(f, "firstName", 80), lastName = str(f, "lastName", 80);
    if (!email || !firstName) return fail("Choose a candidate, or enter a new prospect's name and email.", f, { email: "Required" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email.", f, { email: "Invalid" });
    cand = await prisma.candidate.findFirst({ where: { tenantId: viewer.tenantId, email } });
    if (!cand) {
      cand = await prisma.candidate.create({ data: { tenantId: viewer.tenantId, email, firstName, lastName: lastName || "-", currentTitle: str(f, "currentTitle", 120) || null, currentEmployer: str(f, "currentEmployer", 120) || null, linkedinUrl: /^https?:\/\//.test(str(f, "linkedinUrl")) ? str(f, "linkedinUrl", 300) : null, source: "DIRECT_SOURCING" } });
      await prisma.candidateSourcingProfile.create({ data: { tenantId: viewer.tenantId, candidateId: cand.id, isPassive: true } });
      await applyTagRules(viewer.tenantId, cand.id);
    }
  }
  const r = await prisma.sourcingProjectCandidate.createMany({ data: [{ projectId: p.id, candidateId: cand.id, addedBy: viewer.user.id, note: str(f, "note", 500) || null }], skipDuplicates: true });
  if (!r.count) return fail(`${cand.firstName} is already in this project.`);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingProject", entityId: p.id, summary: `Added prospect ${cand.firstName} ${cand.lastName} to ${p.name}` });
  return done([`/hiring/sourcing/projects/${p.id}`], `${cand.firstName} added.`);
}

export async function prospectStageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const e = await prisma.sourcingProjectCandidate.findFirst({ where: { id: str(f, "id"), project: { tenantId: viewer.tenantId } }, include: { candidate: true } });
  if (!e) return fail("Prospect not found.");
  const stage = str(f, "stage");
  if (!PROSPECT_STAGES.includes(stage)) return fail("Choose a stage.");
  await prisma.sourcingProjectCandidate.update({ where: { id: e.id }, data: { stage, note: str(f, "note", 500) || e.note } });
  const engagement: Record<string, string> = { CONTACTED: "CONTACTED", RESPONDED: "ENGAGED", INTERESTED: "INTERESTED", NOT_INTERESTED: "NOT_INTERESTED" };
  if (engagement[stage]) await prisma.candidateSourcingProfile.upsert({ where: { candidateId: e.candidateId }, create: { tenantId: viewer.tenantId, candidateId: e.candidateId, engagementStatus: engagement[stage]! }, update: { engagementStatus: engagement[stage]! } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourcingProject", entityId: e.projectId, summary: `${e.candidate.firstName} ${e.candidate.lastName}: ${e.stage} → ${stage}` });
  return done([`/hiring/sourcing/projects/${e.projectId}`], "Updated.");
}

export async function removeProspectAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const e = await prisma.sourcingProjectCandidate.findFirst({ where: { id: str(f, "id"), project: { tenantId: viewer.tenantId } } });
  if (!e) return fail("Prospect not found.");
  await prisma.sourcingProjectCandidate.delete({ where: { id: e.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "SourcingProject", entityId: e.projectId, summary: "Removed a prospect" });
  return done([`/hiring/sourcing/projects/${e.projectId}`], "Removed.");
}

// ---------------------------------------------------------------------------
//  Saved searches and the search library
// ---------------------------------------------------------------------------

export async function saveSearchAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const name = str(f, "name", 120), query = str(f, "q", 1000);
  if (name.length < 2) return fail("Name the search.", f, { name: "Required" });
  const parsed = parseBooleanQuery(query);
  if (!query || parsed.error) return fail(parsed.error ?? "Write a search.", f, { q: parsed.error ?? "Required" });
  const projectId = str(f, "projectId") || null;
  if (projectId && !(await prisma.sourcingProject.count({ where: { id: projectId, tenantId: viewer.tenantId } }))) return fail("Project not found.");
  const filters = { source: sourceOf(str(f, "source")), city: str(f, "city", 80) || null, minExperience: numField(f, "minExperience") };
  const s = await prisma.savedSourcingSearch.create({ data: { tenantId: viewer.tenantId, name, query, filters, isShared: f.get("isShared") === "on", projectId, ownerUserId: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "SavedSourcingSearch", entityId: s.id, summary: `Saved search “${name}”: ${query}${s.isShared ? " (shared to the library)" : ""}` });
  return done(SP, s.isShared ? "Saved to the shared search library." : "Search saved.");
}

export async function runSavedSearchAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const s = await prisma.savedSourcingSearch.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, OR: [{ ownerUserId: viewer.user.id }, { isShared: true }] } });
  if (!s) return fail("Search not found.");
  const node = parseBooleanQuery(s.query).node;
  const filters = (s.filters ?? {}) as { source?: string | null; city?: string | null; minExperience?: number | null };
  const cands = await prisma.candidate.findMany({ where: { tenantId: viewer.tenantId, ...(filters.source ? { source: filters.source as Source } : {}), ...(filters.city ? { city: { equals: filters.city, mode: "insensitive" } } : {}) }, take: 5000 });
  const hits = cands.filter((c) => (filters.minExperience == null || Number(c.totalExperienceYears ?? 0) >= filters.minExperience) && matchesBoolean(node, candidateHaystack(c)));
  await prisma.savedSourcingSearch.update({ where: { id: s.id }, data: { lastRunAt: new Date(), lastCount: hits.length } });
  return done(SP, `${hits.length} candidate(s) match “${s.name}”.`);
}

export async function deleteSearchAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const u = await prisma.savedSourcingSearch.deleteMany({ where: { id: str(f, "id"), tenantId: viewer.tenantId, ownerUserId: viewer.user.id } });
  if (!u.count) return fail("Only the owner can delete a saved search.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "SavedSourcingSearch", entityId: str(f, "id"), summary: "Deleted a saved search" });
  return done(SP, "Deleted.");
}

// ---------------------------------------------------------------------------
//  Prospect profile: engagement, tags, passive / high-potential, consent
// ---------------------------------------------------------------------------

const ENGAGEMENT = ["NEW", "CONTACTED", "ENGAGED", "INTERESTED", "NOT_INTERESTED", "UNRESPONSIVE"];

export async function saveSourcingProfileAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await prisma.candidate.findFirst({ where: { id: str(f, "candidateId"), tenantId: viewer.tenantId }, include: { sourcingProfile: true } });
  if (!cand) return fail("Candidate not found.");
  const engagementStatus = ENGAGEMENT.includes(str(f, "engagementStatus")) ? str(f, "engagementStatus") : cand.sourcingProfile?.engagementStatus ?? "NEW";
  const tz = str(f, "timeZone", 60) || null;
  if (tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return fail("That is not a time zone (e.g. Asia/Kolkata).", f, { timeZone: "Invalid" }); } }
  const tags = str(f, "tags", 1000).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 30);
  const agencyId = str(f, "agencyId") || null;
  if (agencyId && !(await prisma.recruitmentAgency.count({ where: { id: agencyId, tenantId: viewer.tenantId } }))) return fail("Agency not found.");
  const data = { engagementStatus, isPassive: f.get("isPassive") === "on", isHighPotential: f.get("isHighPotential") === "on", tags: [...new Set(tags)], timeZone: tz, agencyId };
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, ...data }, update: data });
  const p = cand.sourcingProfile;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CandidateSourcingProfile", entityId: cand.id, summary: `Updated the sourcing profile of ${cand.firstName} ${cand.lastName}`, oldValue: p ? { engagementStatus: p.engagementStatus, isPassive: p.isPassive, isHighPotential: p.isHighPotential, tags: p.tags } : undefined, newValue: data });
  return done([`/hiring/candidates/${cand.id}`, "/hiring/candidates"], "Profile saved.");
}

export async function recordConsentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer.tenantId, str(f, "candidateId"));
  if (!cand) return fail("Candidate not found.");
  const status = str(f, "status") === "WITHDRAWN" ? "WITHDRAWN" : "GRANTED";
  const source = str(f, "source", 120);
  if (!source) return fail("Record how consent was given or withdrawn.", f, { source: "Required" });
  const cfg = await hireDepthConfig(viewer.tenantId);
  const now = new Date();
  const data = { consentStatus: status, consentSource: source, consentAt: now, consentExpiresAt: status === "GRANTED" ? new Date(now.getTime() + cfg.consentValidityDays * DAY) : null };
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, ...data }, update: data });
  let stopped = 0;
  if (status === "WITHDRAWN") stopped = (await prisma.cadenceEnrollment.updateMany({ where: { candidateId: cand.id, status: "ACTIVE" }, data: { status: "STOPPED", stoppedAt: now } })).count;
  if (stopped) await prisma.recruiterTask.updateMany({ where: { tenantId: viewer.tenantId, candidateId: cand.id, queue: "OUTREACH", status: "OPEN" }, data: { status: "CANCELLED" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CandidateSourcingProfile", entityId: cand.id, summary: `Consent ${status.toLowerCase()} for ${cand.firstName} ${cand.lastName} (${source})${stopped ? `; ${stopped} cadence(s) stopped` : ""}` });
  return done([`/hiring/candidates/${cand.id}`], status === "GRANTED" ? `Consent recorded until ${data.consentExpiresAt!.toISOString().slice(0, 10)}.` : "Consent withdrawn; outreach stopped.");
}

/** Capture a public profile the recruiter pasted (no scraping: the text is what they copied). */
export async function captureProfileAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer.tenantId, str(f, "candidateId"));
  if (!cand) return fail("Candidate not found.");
  const text = str(f, "profileText", 8000);
  if (text.length < 10) return fail("Paste the profile text.", f, { profileText: "Required" });
  const p = parseLinkedProfile(text, str(f, "url", 300) || null);
  const skills = [...new Set([...hireStringList(cand.skills).map((s) => s.toLowerCase()), ...p.skills])];
  await prisma.candidate.update({ where: { id: cand.id }, data: { currentTitle: cand.currentTitle ?? p.title, currentEmployer: cand.currentEmployer ?? p.employer, skills, linkedinUrl: cand.linkedinUrl ?? p.url } });
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: cand.id }, create: { tenantId: viewer.tenantId, candidateId: cand.id, linkedProfile: p }, update: { linkedProfile: p } });
  await applyTagRules(viewer.tenantId, cand.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: cand.id, summary: `Captured a public profile for ${cand.firstName} ${cand.lastName} (${p.skills.length} skill(s))` });
  return done([`/hiring/candidates/${cand.id}`], `Captured: ${p.headline ?? "profile"}${p.skills.length ? `; ${p.skills.length} skill(s)` : ""}.`);
}

// ---------------------------------------------------------------------------
//  Tag rules and attribution rules
// ---------------------------------------------------------------------------

export async function saveTagRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const tag = str(f, "tag", 40).toLowerCase(), field = str(f, "field"), value = str(f, "value", 120);
  if (!tag) return fail("Name the tag.", f, { tag: "Required" });
  if (!(field in TAG_RULE_FIELDS)) return fail("Choose what to match.", f, { field: "Required" });
  if (!value) return fail("Enter the value to match.", f, { value: "Required" });
  if (field === "MIN_EXPERIENCE" && !Number.isFinite(Number(value))) return fail("Experience is a number of years.", f, { value: "Number" });
  const r = await prisma.prospectTagRule.create({ data: { tenantId: viewer.tenantId, tag, field, value } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ProspectTagRule", entityId: r.id, summary: `Tag rule: ${TAG_RULE_FIELDS[field as keyof typeof TAG_RULE_FIELDS]} “${value}” → #${tag}` });
  return done(["/hiring/sourcing/rules"], "Rule added.");
}

export async function toggleTagRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const r = await prisma.prospectTagRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return fail("Rule not found.");
  await prisma.prospectTagRule.update({ where: { id: r.id }, data: { isActive: !r.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ProspectTagRule", entityId: r.id, summary: `${r.isActive ? "Paused" : "Resumed"} tag rule #${r.tag}` });
  return done(["/hiring/sourcing/rules"], r.isActive ? "Paused." : "Resumed.");
}

export async function applyTagRulesAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const n = await applyTagRules(viewer.tenantId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ProspectTagRule", summary: `Applied tag rules: ${n} profile(s) re-tagged` });
  return done(["/hiring/sourcing/rules", "/hiring/candidates"], `${n} candidate(s) re-tagged.`);
}

export async function saveAttributionRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const name = str(f, "name", 80), matchField = str(f, "matchField"), pattern = str(f, "pattern", 120).toLowerCase();
  const source = sourceOf(str(f, "source"));
  if (!name) return fail("Name the rule.", f, { name: "Required" });
  if (!["UTM_SOURCE", "EMAIL_DOMAIN", "CAMPAIGN_CODE"].includes(matchField)) return fail("Choose what to match.", f, { matchField: "Required" });
  if (!pattern) return fail("Enter the pattern (use * as a wildcard).", f, { pattern: "Required" });
  if (!source) return fail("Choose the source to attribute.", f, { source: "Required" });
  const channelId = str(f, "channelId") || null;
  if (channelId && !(await prisma.sourcingChannel.count({ where: { id: channelId, tenantId: viewer.tenantId } }))) return fail("Channel not found.");
  const priority = numField(f, "priority") ?? 100;
  const r = await prisma.sourceAttributionRule.create({ data: { tenantId: viewer.tenantId, name, matchField, pattern, source, channelId, priority: Number.isInteger(priority) ? priority : 100 } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "SourceAttributionRule", entityId: r.id, summary: `Attribution rule ${name}: ${matchField.toLowerCase()} ${pattern} → ${source}` });
  return done(["/hiring/sourcing/rules"], "Rule added.");
}

export async function toggleAttributionRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const r = await prisma.sourceAttributionRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return fail("Rule not found.");
  await prisma.sourceAttributionRule.update({ where: { id: r.id }, data: { isActive: !r.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SourceAttributionRule", entityId: r.id, summary: `${r.isActive ? "Paused" : "Resumed"} attribution rule ${r.name}` });
  return done(["/hiring/sourcing/rules"], r.isActive ? "Paused." : "Resumed.");
}

/** Correct a candidate's source — reviewed by a recruiter lead, since it moves the source analytics. */
export async function requestReattributionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer.tenantId, str(f, "candidateId"));
  if (!cand) return fail("Candidate not found.");
  const source = sourceOf(str(f, "source"));
  if (!source) return fail("Choose the correct source.", f, { source: "Required" });
  const channelId = str(f, "channelId") || null;
  if (channelId && !(await prisma.sourcingChannel.count({ where: { id: channelId, tenantId: viewer.tenantId } }))) return fail("Channel not found.");
  const reason = str(f, "reason", 500);
  if (!reason) return fail("Say why the source is wrong.", f, { reason: "Required" });
  if (source === cand.source && !channelId) return fail("That is already the source.");
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "SOURCE_REATTRIBUTION", entityId: cand.id, title: `Change the source of ${cand.firstName} ${cand.lastName} from ${cand.source} to ${source}`, details: reason, data: { source, channelId }, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!r.ok) return fail(r.message);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: cand.id, summary: `Requested source change ${cand.source} → ${source}: ${reason}` });
  return done([`/hiring/candidates/${cand.id}`], r.status === "PENDING" ? "Sent for approval." : "Source changed.");
}

// ---------------------------------------------------------------------------
//  Agencies
// ---------------------------------------------------------------------------

export async function saveAgencyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const name = str(f, "name", 120);
  if (name.length < 2) return fail("Name the agency.", f, { name: "Required" });
  if (await prisma.recruitmentAgency.count({ where: { tenantId: viewer.tenantId, name } })) return fail("That agency exists.", f, { name: "Taken" });
  const email = str(f, "contactEmail", 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email.", f, { contactEmail: "Invalid" });
  const fee = numField(f, "feePercent");
  if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 100)) return fail("The fee is a percentage.", f, { feePercent: "0–100" });
  const owner = str(f, "ownerUserId") || null;
  if (owner && !(await tenantUser(viewer, owner))) return fail("Owner not found.");
  const a = await prisma.recruitmentAgency.create({ data: { tenantId: viewer.tenantId, name, contactEmail: email || null, feePercent: fee, ownerUserId: owner, entryStage: str(f, "entryStage", 80) || null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "RecruitmentAgency", entityId: a.id, summary: `Added agency ${name}` });
  return done(SP, "Agency added.");
}

export async function toggleAgencyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAnyOf([HP.JOB_MANAGE, HP.CANDIDATE_MANAGE]);
  const a = await prisma.recruitmentAgency.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!a) return fail("Agency not found.");
  await prisma.recruitmentAgency.update({ where: { id: a.id }, data: { isActive: !a.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecruitmentAgency", entityId: a.id, summary: `${a.isActive ? "Paused" : "Resumed"} agency ${a.name}` });
  return done(SP, a.isActive ? "Paused." : "Resumed.");
}

/** Log an agency submission: it enters the job's pipeline, routed to the agency's owner and entry stage. */
export async function agencySubmissionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const agency = await prisma.recruitmentAgency.findFirst({ where: { id: str(f, "agencyId"), tenantId: viewer.tenantId, isActive: true } });
  if (!agency) return fail("Choose an active agency.", f, { agencyId: "Required" });
  const email = str(f, "email", 200).toLowerCase(), firstName = str(f, "firstName", 80);
  if (!firstName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter the candidate's name and email.", f, { email: "Required" });
  const r = await applyCandidate({ tenantId: viewer.tenantId, jobId: str(f, "jobId"), firstName, lastName: str(f, "lastName", 80) || "-", email, phone: str(f, "phone", 30) || null, currentTitle: str(f, "currentTitle", 120) || null, source: "AGENCY", byUserId: viewer.user.id, updateExisting: false });
  if (!r.ok || !r.applicationId) return fail(r.message);
  const app = await prisma.application.findUniqueOrThrow({ where: { id: r.applicationId }, include: { job: { include: { flow: { include: { stages: true } } } } } });
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: app.candidateId }, create: { tenantId: viewer.tenantId, candidateId: app.candidateId, agencyId: agency.id }, update: { agencyId: agency.id } });
  if (agency.ownerUserId) await prisma.application.update({ where: { id: app.id }, data: { ownerId: agency.ownerUserId } });
  const entry = agency.entryStage ? app.job.flow?.stages.find((s) => s.name.toLowerCase() === agency.entryStage!.toLowerCase()) : null;
  if (entry && entry.id !== app.currentStageId) {
    await prisma.$transaction([
      prisma.applicationStageHistory.updateMany({ where: { applicationId: app.id, exitedAt: null }, data: { exitedAt: new Date() } }),
      prisma.applicationStageHistory.create({ data: { applicationId: app.id, stageId: entry.id, movedBy: viewer.user.id, note: `Routed for ${agency.name}` } }),
      prisma.application.update({ where: { id: app.id }, data: { currentStageId: entry.id } }),
    ]);
  }
  if (agency.ownerUserId) await notify({ tenantId: viewer.tenantId, userIds: [agency.ownerUserId], kind: "HIRING", title: `${agency.name} submitted ${firstName} for ${app.job.title}`, link: `/hiring/applications/${app.id}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: app.id, summary: `${agency.name} submitted ${firstName} for ${app.job.title}${entry ? ` (routed to ${entry.name})` : ""}` });
  return done(SP, `${r.message}${entry ? ` Routed to ${entry.name}.` : ""}`);
}

// ---------------------------------------------------------------------------
//  Outreach cadences
// ---------------------------------------------------------------------------

export async function saveCadenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const name = str(f, "name", 80);
  if (name.length < 2) return fail("Name the cadence.", f, { name: "Required" });
  if (await prisma.outreachCadence.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A cadence with that name exists.", f, { name: "Taken" });
  const parsed = parseCadenceSteps(str(f, "steps", 4000));
  if (parsed.error) return fail(parsed.error, f, { steps: "Check the steps" });
  const c = await prisma.outreachCadence.create({ data: { tenantId: viewer.tenantId, name, steps: parsed.steps! } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "OutreachCadence", entityId: c.id, summary: `Created cadence ${name} (${parsed.steps!.length} steps)` });
  return done(SP, "Cadence saved.");
}

export async function enrollCadenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const ids = f.getAll("candidateIds").map(String).filter(Boolean);
  const list = ids.length ? ids : [str(f, "candidateId")];
  const results = [];
  for (const id of list) results.push(await enrollInCadence(viewer.tenantId, str(f, "cadenceId"), id, viewer.user.id));
  const ok = results.filter((r) => r.ok).length;
  if (!ok) return fail(results[0]?.message ?? "Nothing enrolled.");
  return done(["/hiring/tasks", SP[0]!, ...(list.length === 1 ? [`/hiring/candidates/${list[0]}`] : [])], list.length === 1 ? results[0]!.message : `${ok} of ${list.length} enrolled.`);
}

export async function stopCadenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const e = await prisma.cadenceEnrollment.findFirst({ where: { id: str(f, "id"), cadence: { tenantId: viewer.tenantId }, status: "ACTIVE" }, include: { cadence: true } });
  if (!e) return fail("Not on an active cadence.");
  await prisma.cadenceEnrollment.update({ where: { id: e.id }, data: { status: "STOPPED", stoppedAt: new Date() } });
  await prisma.recruiterTask.updateMany({ where: { tenantId: viewer.tenantId, candidateId: e.candidateId, queue: "OUTREACH", status: "OPEN", sourceKey: { startsWith: `cadence:${e.cadenceId}:` } }, data: { status: "CANCELLED" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CadenceEnrollment", entityId: e.id, summary: `Stopped cadence ${e.cadence.name}` });
  return done([`/hiring/candidates/${e.candidateId}`, "/hiring/tasks"], "Cadence stopped.");
}

// ---------------------------------------------------------------------------
//  Talent pools: settings, segments, approval, silver medallists, reactivation
// ---------------------------------------------------------------------------

const POOL_KINDS = ["STANDARD", "SILVER_MEDALIST", "HIGH_POTENTIAL", "COMMUNITY", "REACTIVATION"];

export async function savePoolSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const pool = await prisma.talentPool.findFirst({ where: { id: str(f, "poolId"), tenantId: viewer.tenantId } });
  if (!pool) return fail("Pool not found.");
  const name = str(f, "name", 80) || pool.name;
  if (name !== pool.name && (await prisma.talentPool.count({ where: { tenantId: viewer.tenantId, name } }))) return fail("Another pool has that name.", f, { name: "Taken" });
  const expiry = numField(f, "memberExpiryDays");
  if (expiry !== null && (!Number.isInteger(expiry) || expiry < 1 || expiry > 3650)) return fail("Membership lasts 1–3650 days.", f, { memberExpiryDays: "1–3650" });
  const rulesRaw = {
    skills: str(f, "segSkills", 500).split(",").map((s) => s.trim()).filter(Boolean), city: str(f, "segCity", 80) || null, minExperience: numField(f, "segMinExperience"),
    tags: str(f, "segTags", 300).split(",").map((s) => s.trim()).filter(Boolean), source: sourceOf(str(f, "segSource")), highPotential: f.get("segHighPotential") === "on",
  };
  const rules = parseSegmentRules(rulesRaw);
  const data = { name, description: str(f, "description", 500) || pool.description, kind: POOL_KINDS.includes(str(f, "kind")) ? str(f, "kind") : pool.kind, memberExpiryDays: expiry, requiresApproval: f.get("requiresApproval") === "on", rules: rules ? (rules as Prisma.InputJsonValue) : Prisma.DbNull };
  await prisma.talentPool.update({ where: { id: pool.id }, data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Updated pool ${pool.name}${name !== pool.name ? ` (renamed ${name})` : ""}`, oldValue: { name: pool.name, kind: pool.kind, memberExpiryDays: pool.memberExpiryDays, requiresApproval: pool.requiresApproval }, newValue: { name, kind: data.kind, memberExpiryDays: expiry, requiresApproval: data.requiresApproval, rules } });
  return done(["/hiring/pools", `/hiring/pools/${pool.id}`], "Pool saved.");
}

export async function archivePoolAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const pool = await prisma.talentPool.findFirst({ where: { id: str(f, "poolId"), tenantId: viewer.tenantId } });
  if (!pool) return fail("Pool not found.");
  await prisma.talentPool.update({ where: { id: pool.id }, data: { archivedAt: pool.archivedAt ? null : new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `${pool.archivedAt ? "Restored" : "Archived"} pool ${pool.name}` });
  return done(["/hiring/pools", `/hiring/pools/${pool.id}`], pool.archivedAt ? "Restored." : "Archived.");
}

export async function refreshSegmentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const r = await refreshPoolSegment(viewer.tenantId, str(f, "poolId"), viewer.user.id);
  return r.ok ? done(["/hiring/pools", `/hiring/pools/${str(f, "poolId")}`], r.message) : fail(r.message);
}

/** Add to a pool that needs approval: the member waits as pending until a lead approves. */
export async function requestPoolMemberAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const pool = await prisma.talentPool.findFirst({ where: { id: str(f, "poolId"), tenantId: viewer.tenantId, archivedAt: null } });
  const cand = await candidateOf(viewer.tenantId, str(f, "candidateId"));
  if (!pool) return fail("Choose a pool.", f, { poolId: "Required" });
  if (!cand) return fail("Candidate not found.");
  if (await prisma.talentPoolMember.count({ where: { poolId: pool.id, candidateId: cand.id } })) return fail(`${cand.firstName} is already in ${pool.name}.`);
  const expiresAt = pool.memberExpiryDays ? new Date(Date.now() + pool.memberExpiryDays * DAY) : null;
  const m = await prisma.talentPoolMember.create({ data: { poolId: pool.id, candidateId: cand.id, note: str(f, "note", 300) || null, addedBy: viewer.user.id, status: pool.requiresApproval ? "PENDING_APPROVAL" : "ACTIVE", expiresAt: pool.requiresApproval ? null : expiresAt } });
  if (pool.requiresApproval) {
    const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "POOL_MEMBERSHIP", entityId: m.id, title: `Add ${cand.firstName} ${cand.lastName} to ${pool.name}`, details: m.note, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!r.ok) { await prisma.talentPoolMember.delete({ where: { id: m.id } }); return fail(r.message); }
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Asked to add ${cand.firstName} ${cand.lastName} to ${pool.name}` });
    return done(["/hiring/pools", `/hiring/pools/${pool.id}`], r.status === "PENDING" ? "Sent for approval." : "Added.");
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Saved ${cand.firstName} ${cand.lastName} to ${pool.name}` });
  return done(["/hiring/pools", `/hiring/pools/${pool.id}`], `Saved to ${pool.name}.`);
}

export async function captureSilverAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId } });
  if (!job) return fail("Choose a job.", f, { jobId: "Required" });
  const n = await captureSilverMedalists(viewer.tenantId, job.id, viewer.user.id);
  return done(["/hiring/pools"], n ? `${n} finalist(s) from ${job.title} kept as silver medallists.` : `No new finalists from ${job.title}.`);
}

/** Find past candidates not contacted for a while and queue them for re-engagement. */
export async function reactivationCampaignAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const cfg = await hireDepthConfig(viewer.tenantId);
  const cutoff = new Date(Date.now() - cfg.reactivationAfterDays * DAY);
  const cands = await prisma.candidate.findMany({
    where: { tenantId: viewer.tenantId, convertedEmployeeId: null, applications: { some: {}, none: { OR: [{ status: { in: ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED", "HIRED"] } }, { appliedAt: { gte: cutoff } }] } } },
    include: { sourcingProfile: true }, take: 500,
  });
  const due = cands.filter((c) => c.sourcingProfile?.consentStatus !== "WITHDRAWN" && (!c.sourcingProfile?.lastContactedAt || c.sourcingProfile.lastContactedAt < cutoff));
  if (!due.length) return done(["/hiring/pools"], "Nobody is due for re-engagement.");
  const pool = (await prisma.talentPool.findFirst({ where: { tenantId: viewer.tenantId, kind: "REACTIVATION", archivedAt: null } })) ?? (await prisma.talentPool.create({ data: { tenantId: viewer.tenantId, name: (await prisma.talentPool.count({ where: { tenantId: viewer.tenantId, name: "Re-engage" } })) ? `Re-engage ${new Date().toISOString().slice(0, 10)}` : "Re-engage", kind: "REACTIVATION", description: `Past candidates not contacted for ${cfg.reactivationAfterDays} days.`, createdBy: viewer.user.id } }));
  const added = await prisma.talentPoolMember.createMany({ data: due.map((c) => ({ poolId: pool.id, candidateId: c.id, addedBy: viewer.user.id, note: "Due for re-engagement" })), skipDuplicates: true });
  const owner = str(f, "assigneeUserId") || viewer.user.id;
  await prisma.recruiterTask.createMany({ data: due.map((c) => ({ tenantId: viewer.tenantId, title: `Re-engage ${c.firstName} ${c.lastName}`, queue: "OUTREACH", assigneeUserId: owner, createdBy: viewer.user.id, candidateId: c.id, sourceKey: `reactivate:${c.id}:${new Date().toISOString().slice(0, 7)}`, dueAt: new Date(Date.now() + 7 * DAY) })), skipDuplicates: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Re-engagement: ${due.length} past candidate(s) due, ${added.count} added to ${pool.name}` });
  return done(["/hiring/pools", "/hiring/tasks"], `${due.length} past candidate(s) queued for re-engagement in ${pool.name}.`);
}

// ---------------------------------------------------------------------------
//  Import with field mapping
// ---------------------------------------------------------------------------

export async function importCandidatesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CANDIDATE_MANAGE);
  const file = f.get("file");
  const text = file && typeof file === "object" && "text" in file && file.size > 0 ? (file.size > 2 * 1024 * 1024 ? "" : await (file as File).text()) : str(f, "csv", 200_000);
  if (!text.trim()) return fail("Choose a CSV (up to 2 MB) or paste rows.", f, { file: "Required" });
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) return fail("The file needs a header row and at least one candidate.");
  const headers = rows[0]!;
  const mapping: Record<string, string> = {};
  for (const field of CANDIDATE_IMPORT_FIELDS) {
    const h = str(f, `map_${field}`, 120);
    if (h) mapping[h] = field;
    else { const auto = headers.find((x) => x.trim().toLowerCase().replace(/[^a-z]/g, "") === field.toLowerCase()); if (auto) mapping[auto] = field; }
  }
  const tag = str(f, "tag", 40).toLowerCase();
  const errors: string[] = [];
  let created = 0, skipped = 0;
  for (const [i, row] of rows.slice(1, 1001).entries()) {
    const m = mapImportRow(headers, row, mapping);
    if (m.error) { errors.push(`Row ${i + 2}: ${m.error}`); continue; }
    const v = m.values;
    const email = v.email!.toLowerCase();
    if (await prisma.candidate.count({ where: { tenantId: viewer.tenantId, email } })) { skipped++; continue; }
    const exp = v.totalExperienceYears ? Number(v.totalExperienceYears) : null;
    const c = await prisma.candidate.create({ data: {
      tenantId: viewer.tenantId, email, firstName: v.firstName!, lastName: v.lastName || "-", phone: v.phone ?? null, currentTitle: v.currentTitle ?? null, currentEmployer: v.currentEmployer ?? null, city: v.city ?? null,
      totalExperienceYears: exp !== null && Number.isFinite(exp) ? exp : null, skills: v.skills ? v.skills.split(/[;,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined,
      linkedinUrl: v.linkedinUrl && /^https?:\/\//.test(v.linkedinUrl) ? v.linkedinUrl : null, source: sourceOf((v.source ?? "").toUpperCase()) ?? "DIRECT_SOURCING",
    } });
    await prisma.candidateSourcingProfile.create({ data: { tenantId: viewer.tenantId, candidateId: c.id, isPassive: true, tags: tag ? [tag] : undefined } });
    created++;
  }
  if (created) await applyTagRules(viewer.tenantId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Candidate", summary: `Imported ${created} candidate(s); ${skipped} already on file; ${errors.length} row error(s)`, newValue: { mapping, errors: errors.slice(0, 20) } });
  if (!created && errors.length) return fail(`Nothing imported. ${errors.slice(0, 3).join(" ")}`);
  return done(["/hiring/candidates", SP[0]!], `Imported ${created} candidate(s)${skipped ? `; ${skipped} already on file` : ""}${errors.length ? `; ${errors.length} row(s) skipped — ${errors.slice(0, 2).join(" ")}` : ""}.`);
}
