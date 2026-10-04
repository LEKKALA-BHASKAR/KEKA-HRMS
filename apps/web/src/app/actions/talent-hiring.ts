"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  notify, usersWithPermission, approveOffer, offerInterviewSlots, decideHireStep,
  parseKit, asStringList, checkCustomValue, fieldKeyFor, parseOptions, isHexColor, type CustomFieldKind,
} from "@keka/services";
import { requireAuth, requireViewer, canAny, type Viewer } from "@/lib/context";
import { saveFile, sniffUpload } from "@/lib/storage";
import { writeAudit, actionDone as done, formValues, type ActionState } from "@/lib/forms";

/**
 * Hiring parity: talent pools, internal applications, résumés on the
 * candidate profile, the profile score and scorecard library, candidate
 * self-scheduling, multi-level approval chains, candidate custom fields and
 * the career site's branding.
 */

const P = PERMISSIONS;
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max);
const fail = (message: string, f?: FormData, errors?: Record<string, string>): ActionState => ({ ok: false, message, errors, values: f ? formValues(f) : undefined });

async function candidateOf(viewer: Viewer, id: string) {
  return prisma.candidate.findFirst({ where: { id, tenantId: viewer.tenantId } });
}

// ---------------------------------------------------------------------------
//  Talent pools
// ---------------------------------------------------------------------------

export async function createPoolAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const name = str(f, "name", 80);
  if (!name) return fail("Name the pool.", f, { name: "Required" });
  if (await prisma.talentPool.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A pool with that name exists.", f, { name: "Taken" });
  const pool = await prisma.talentPool.create({ data: { tenantId: viewer.tenantId, name, description: str(f, "description", 500) || null, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "TalentPool", entityId: pool.id, summary: `Created talent pool ${name}` });
  return done(["/hiring/pools"], `Created “${name}”.`);
}

export async function addToPoolAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const pool = await prisma.talentPool.findFirst({ where: { id: str(f, "poolId"), tenantId: viewer.tenantId } });
  const cand = await candidateOf(viewer, str(f, "candidateId"));
  if (!pool) return fail("Choose a pool.", f, { poolId: "Required" });
  if (!cand) return fail("Candidate not found.");
  const r = await prisma.talentPoolMember.createMany({ data: [{ poolId: pool.id, candidateId: cand.id, note: str(f, "note", 300) || null, addedBy: viewer.user.id }], skipDuplicates: true });
  if (!r.count) return fail(`${cand.firstName} is already in ${pool.name}.`);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TalentPool", entityId: pool.id, summary: `Saved ${cand.firstName} ${cand.lastName} to ${pool.name}` });
  return done(["/hiring/pools", `/hiring/pools/${pool.id}`, "/hiring/applications"], `Saved to ${pool.name}.`);
}

export async function removeFromPoolAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const m = await prisma.talentPoolMember.findFirst({ where: { id: str(f, "id"), pool: { tenantId: viewer.tenantId } } });
  if (!m) return fail("Not found.");
  await prisma.talentPoolMember.delete({ where: { id: m.id } });
  return done(["/hiring/pools", `/hiring/pools/${m.poolId}`], "Removed from the pool.");
}

/** Put a pooled candidate forward for an open job. */
export async function poolToJobAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer, str(f, "candidateId"));
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId, status: "OPEN" }, include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } });
  if (!cand) return fail("Candidate not found.");
  if (!job) return fail("Choose an open job.", f, { jobId: "Required" });
  if (await prisma.application.count({ where: { jobId: job.id, candidateId: cand.id } })) return fail(`${cand.firstName} is already on ${job.title}.`);
  const first = job.flow?.stages[0];
  const app = await prisma.application.create({ data: { tenantId: viewer.tenantId, jobId: job.id, candidateId: cand.id, currentStageId: first?.id ?? null, ownerId: job.recruiterId, ...(first ? { stageHistory: { create: { stageId: first.id, movedBy: viewer.user.id, note: "From a talent pool" } } } : {}) } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Application", entityId: app.id, summary: `Moved ${cand.firstName} ${cand.lastName} from a talent pool to ${job.title}` });
  return done(["/hiring/pools", `/hiring/jobs/${job.id}`], `${cand.firstName} is now on ${job.title}.`);
}

// ---------------------------------------------------------------------------
//  Internal job board
// ---------------------------------------------------------------------------

/**
 * An employee applies to an internal opening. They enter the pipeline as an
 * INTERNAL candidate linked to their employee record; their manager is told.
 */
export async function applyInternallyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return fail("No employee record is linked to this login.");
  const job = await prisma.job.findFirst({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId, status: "OPEN", allowInternal: true }, include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } });
  if (!job) return fail("This job is not open to internal applicants.");
  const emp = await prisma.employee.findFirstOrThrow({ where: { id: viewer.employee.id, tenantId: viewer.tenantId }, select: { id: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, jobTitleName: true, reportingManager: { select: { userId: true } } } });
  if (await prisma.internalApplication.count({ where: { employeeId: emp.id, application: { jobId: job.id } } })) return fail("You have already applied to this job.");
  const email = (emp.workEmail ?? emp.personalEmail ?? viewer.user.email).toLowerCase();
  const cand = await prisma.candidate.upsert({
    where: { tenantId_email: { tenantId: viewer.tenantId, email } },
    create: { tenantId: viewer.tenantId, firstName: emp.firstName, lastName: emp.lastName, email, currentEmployer: viewer.tenant.name, currentTitle: emp.jobTitleName, source: "INTERNAL" },
    update: {},
  });
  if (await prisma.application.count({ where: { jobId: job.id, candidateId: cand.id } })) return fail("You have already applied to this job.");
  const first = job.flow?.stages[0];
  const app = await prisma.application.create({
    data: {
      tenantId: viewer.tenantId, jobId: job.id, candidateId: cand.id, currentStageId: first?.id ?? null, ownerId: job.recruiterId,
      ...(first ? { stageHistory: { create: { stageId: first.id, movedBy: viewer.user.id, note: "Internal application" } } } : {}),
      internal: { create: { tenantId: viewer.tenantId, employeeId: emp.id, note: str(f, "note", 1000) || null } },
    },
  });
  const team = await prisma.employee.findMany({ where: { id: { in: [job.recruiterId, job.hiringManagerId].filter((x): x is string => !!x) } }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: team.map((t) => t.userId), kind: "HIRING", title: `Internal application: ${viewer.employee.displayName} for ${job.title}`, link: `/hiring/applications/${app.id}` });
  await notify({ tenantId: viewer.tenantId, userIds: [emp.reportingManager?.userId], kind: "HIRING", title: `${viewer.employee.displayName} applied internally for ${job.title}`, link: "/hiring/refer" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "InternalApplication", entityId: app.id, summary: `Applied internally for ${job.title}` });
  return done(["/hiring/refer", `/hiring/jobs/${job.id}`], `Applied for ${job.title}. The hiring team and your manager have been told.`);
}

// ---------------------------------------------------------------------------
//  Candidate profile: résumé, education and skills, custom fields
// ---------------------------------------------------------------------------

export async function uploadResumeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer, str(f, "candidateId"));
  if (!cand) return fail("Candidate not found.");
  const file = f.get("resume");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) return fail("Choose a PDF résumé.", f, { resume: "Required" });
  if (file.size > 5 * 1024 * 1024) return fail("The résumé is larger than 5 MB.", f, { resume: "Too large" });
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok || sniff.mimeType !== "application/pdf") return fail("The résumé must be a PDF.", f, { resume: "PDF only" });
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: `resume-${cand.firstName}-${cand.lastName}.pdf`, mimeType: "application/pdf", data, relatedType: "CandidateResume", relatedId: cand.id, uploadedBy: viewer.user.id });
  await prisma.candidate.update({ where: { id: cand.id }, data: { resumeUrl: `/files/${stored.id}` } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: cand.id, summary: `Uploaded a résumé for ${cand.firstName} ${cand.lastName}` });
  return done([`/hiring/applications/${str(f, "applicationId")}`], "Résumé uploaded.");
}

export async function saveCandidateProfileAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CANDIDATE_MANAGE);
  const cand = await candidateOf(viewer, str(f, "candidateId"));
  if (!cand) return fail("Candidate not found.");
  const skills = asStringList(str(f, "skills", 2000)).slice(0, 40);
  const years = str(f, "totalExperienceYears");
  const exp = years === "" ? null : Number(years);
  if (exp !== null && (!Number.isFinite(exp) || exp < 0 || exp > 60)) return fail("Experience is 0 to 60 years.", f, { totalExperienceYears: "Out of range" });
  // Candidate custom fields arrive as cf_<definition id>.
  const defs = await prisma.customFieldDefinition.findMany({ where: { tenantId: viewer.tenantId, entity: "CANDIDATE", isActive: true } });
  const errors: Record<string, string> = {};
  const cfValues: Array<{ id: string; value: string | null }> = [];
  for (const def of defs) {
    const raw = f.get(`cf_${def.id}`);
    const r = checkCustomValue({ label: def.label, type: def.type as CustomFieldKind, options: (def.options as string[] | null) ?? null, isMandatory: def.isMandatory }, typeof raw === "string" ? raw : null);
    if ("error" in r) errors[`cf_${def.id}`] = r.error; else cfValues.push({ id: def.id, value: r.value });
  }
  if (Object.keys(errors).length) return fail("Please correct the highlighted fields.", f, errors);
  await prisma.candidate.update({ where: { id: cand.id }, data: { education: str(f, "education", 300) || null, skills, totalExperienceYears: exp } });
  for (const v of cfValues) {
    await prisma.customFieldValue.upsert({ where: { definitionId_ownerId: { definitionId: v.id, ownerId: cand.id } }, create: { definitionId: v.id, ownerId: cand.id, value: v.value }, update: { value: v.value } });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: cand.id, summary: `Updated the profile of ${cand.firstName} ${cand.lastName}` });
  return done([`/hiring/applications/${str(f, "applicationId")}`], "Profile saved.");
}

export async function saveCandidateFieldAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const label = str(f, "label", 80);
  const type = ["TEXT", "NUMBER", "DATE", "DROPDOWN", "CHECKBOX", "MULTILINE", "EMAIL", "PHONE"].includes(str(f, "type")) ? str(f, "type") : null;
  if (!label) return fail("Name the field.", f, { label: "Required" });
  if (!type) return fail("Choose a type.", f, { type: "Required" });
  const options = type === "DROPDOWN" ? parseOptions(str(f, "options", 2000)) : null;
  if (type === "DROPDOWN" && options!.length < 2) return fail("A dropdown needs at least two options.", f, { options: "Two or more" });
  let fieldKey = fieldKeyFor(label);
  const taken = new Set((await prisma.customFieldDefinition.findMany({ where: { tenantId: viewer.tenantId, entity: "CANDIDATE", fieldKey: { startsWith: fieldKey } }, select: { fieldKey: true } })).map((r) => r.fieldKey));
  for (let n = 2; taken.has(fieldKey); n++) fieldKey = `${fieldKeyFor(label)}_${n}`;
  const order = await prisma.customFieldDefinition.count({ where: { tenantId: viewer.tenantId, entity: "CANDIDATE" } });
  await prisma.customFieldDefinition.create({ data: { tenantId: viewer.tenantId, entity: "CANDIDATE", fieldKey, label, type: type as never, options: options ?? Prisma.DbNull, isMandatory: f.get("isMandatory") === "on", displayOrder: order } });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "CustomFieldDefinition", summary: `Added candidate field “${label}” (${type.toLowerCase()})` });
  return done(["/hiring/settings/talent"], `Added “${label}”.`);
}

export async function toggleCandidateFieldAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const def = await prisma.customFieldDefinition.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, entity: "CANDIDATE" } });
  if (!def) return fail("Field not found.");
  await prisma.customFieldDefinition.update({ where: { id: def.id }, data: { isActive: !def.isActive } });
  return done(["/hiring/settings/talent"], def.isActive ? "Switched off." : "Switched on.");
}

// ---------------------------------------------------------------------------
//  Profile score and scorecard library
// ---------------------------------------------------------------------------

export async function saveScoreConfigAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const w = (k: string) => Number(str(f, k));
  const weights = { skillsWeight: w("skillsWeight"), experienceWeight: w("experienceWeight"), educationWeight: w("educationWeight") };
  if (Object.values(weights).some((x) => !Number.isInteger(x) || x < 0 || x > 100)) return fail("Weights are whole numbers from 0 to 100.", f);
  const total = weights.skillsWeight + weights.experienceWeight + weights.educationWeight;
  if (total !== 100) return fail(`Weights must add up to 100; they add up to ${total}.`, f, { educationWeight: "≠ 100" });
  const ideal = Number(str(f, "idealExperienceYears") || 5);
  if (!Number.isFinite(ideal) || ideal < 0 || ideal > 40) return fail("Ideal experience is 0 to 40 years.", f, { idealExperienceYears: "Out of range" });
  const data = { ...weights, idealExperienceYears: ideal, skillKeywords: asStringList(str(f, "skillKeywords", 2000)).slice(0, 60), educationKeywords: asStringList(str(f, "educationKeywords", 2000)).slice(0, 40) };
  await prisma.candidateScoreConfig.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CandidateScoreConfig", summary: `Profile score weights ${weights.skillsWeight}/${weights.experienceWeight}/${weights.educationWeight}`, newValue: data });
  return done(["/hiring/settings/talent"], "Profile score saved.");
}

/** "Section: skill, skill" per line. */
function kitFromText(text: string) {
  const sections = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [section, rest] = l.split(":");
    return { section: (section ?? "").trim(), skills: (rest ?? "").split(",").map((s) => ({ name: s.trim() })).filter((s) => s.name) };
  });
  return parseKit(sections);
}

export async function saveScorecardLibraryAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const name = str(f, "name", 80);
  if (!name) return fail("Name the scorecard.", f, { name: "Required" });
  const kit = kitFromText(String(f.get("kit") ?? ""));
  if (!kit) return fail("Add at least one line like “Engineering: System design, Code quality”.", f, { kit: "Required" });
  if (await prisma.scorecardTemplate.count({ where: { tenantId: viewer.tenantId, name } })) return fail("A scorecard with that name exists.", f, { name: "Taken" });
  await prisma.scorecardTemplate.create({ data: { tenantId: viewer.tenantId, name, kit: kit as unknown as Prisma.InputJsonValue, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ScorecardTemplate", summary: `Added scorecard ${name} (${kit.length} section(s))` });
  return done(["/hiring/settings/talent"], `Added “${name}”.`);
}

export async function deleteScorecardLibraryAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const r = await prisma.scorecardTemplate.deleteMany({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  return r.count ? done(["/hiring/settings/talent"], "Deleted.") : fail("Not found.");
}

/** Copy a library scorecard into a job's interview kit. */
export async function applyScorecardToJobAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const t = await prisma.scorecardTemplate.findFirst({ where: { id: str(f, "templateId"), tenantId: viewer.tenantId } });
  if (!t) return fail("Choose a scorecard.", f, { templateId: "Required" });
  const u = await prisma.job.updateMany({ where: { id: str(f, "jobId"), tenantId: viewer.tenantId }, data: { scorecardTemplate: t.kit as Prisma.InputJsonValue } });
  if (!u.count) return fail("Job not found.");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Job", entityId: str(f, "jobId"), summary: `Scorecard set from the library: ${t.name}` });
  return done([`/hiring/jobs/${str(f, "jobId")}`], `The job now uses “${t.name}”.`);
}

// ---------------------------------------------------------------------------
//  Candidate self-scheduling
// ---------------------------------------------------------------------------

export async function offerSlotsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INTERVIEW_MANAGE);
  const applicationId = str(f, "applicationId");
  const r = await offerInterviewSlots({
    tenantId: viewer.tenantId, applicationId, title: str(f, "title", 120) || "Interview", mode: ["VIDEO", "IN_PERSON", "PHONE"].includes(str(f, "mode")) ? str(f, "mode") : "VIDEO",
    durationMinutes: Number(str(f, "durationMinutes") || 60), meetingUrl: str(f, "meetingUrl", 300) || null,
    panelIds: f.getAll("panelIds").map(String), slots: f.getAll("slots").map(String), byUserId: viewer.user.id,
  });
  if (!r.ok) return fail(r.message, f);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "InterviewSlotOffer", entityId: r.id, summary: r.message });
  return { ...done([`/hiring/applications/${applicationId}`], r.message), values: { url: r.url ?? "" } };
}

export async function cancelSlotOfferAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INTERVIEW_MANAGE);
  const u = await prisma.interviewSlotOffer.updateMany({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "OPEN" }, data: { status: "CANCELLED" } });
  return u.count ? done([`/hiring/applications/${str(f, "applicationId")}`], "The link no longer works.") : fail("Nothing open to cancel.");
}

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

export async function saveApprovalRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.JOB_MANAGE, P.REQUISITION_MANAGE])) return fail("You cannot change approval chains.");
  const kind = ["REQUISITION", "OFFER"].includes(str(f, "kind")) ? str(f, "kind") : null;
  const name = str(f, "name", 80);
  if (!kind) return fail("Choose what the chain approves.", f, { kind: "Required" });
  if (!name) return fail("Name the rule.", f, { name: "Required" });
  const approvers = [...new Set(f.getAll("approverUserIds").map(String).filter(Boolean))];
  if (approvers.length === 0) return fail("Add at least one approver.", f, { approverUserIds: "Required" });
  if (approvers.length > 6) return fail("Up to six approvers in a chain.", f);
  if ((await prisma.user.count({ where: { tenantId: viewer.tenantId, id: { in: approvers } } })) !== approvers.length) return fail("An approver was not found.", f);
  const departmentId = str(f, "departmentId") || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return fail("Department not found.", f);
  const minRaw = str(f, "minAmount");
  const minAmount = minRaw === "" ? null : Number(minRaw);
  if (minAmount !== null && (!Number.isFinite(minAmount) || minAmount < 0)) return fail("The amount must be a positive number.", f, { minAmount: "Invalid" });
  const priority = Number(str(f, "priority") || 100);
  const rule = await prisma.hireApprovalRule.create({ data: { tenantId: viewer.tenantId, kind, name, departmentId, minAmount, approverUserIds: approvers, priority: Number.isInteger(priority) ? priority : 100 } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "HireApprovalRule", entityId: rule.id, summary: `Added ${kind.toLowerCase()} approval chain ${name} (${approvers.length} level(s))` });
  return done(["/hiring/settings/approvals"], `Added “${name}”.`);
}

export async function toggleApprovalRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.JOB_MANAGE, P.REQUISITION_MANAGE])) return fail("You cannot change approval chains.");
  const rule = await prisma.hireApprovalRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!rule) return fail("Rule not found.");
  await prisma.hireApprovalRule.update({ where: { id: rule.id }, data: { isActive: !rule.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HireApprovalRule", entityId: rule.id, summary: `${rule.isActive ? "Paused" : "Resumed"} approval chain ${rule.name}` });
  return done(["/hiring/settings/approvals"], rule.isActive ? "Paused." : "Resumed.");
}

/** An approver in an offer's chain approves or rejects their level. */
export async function decideOfferStepAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const applicationId = str(f, "applicationId");
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId: viewer.tenantId }, include: { offer: true, job: true, candidate: true } });
  if (!app?.offer || app.offer.status !== "PENDING_APPROVAL") return fail("No offer is waiting for approval.");
  const approve = str(f, "decision") === "approve";
  const comment = str(f, "comment", 500);
  if (!approve && !comment) return fail("Give a reason when rejecting.", f, { comment: "Required" });
  const r = await decideHireStep({ tenantId: viewer.tenantId, kind: "OFFER", entityId: app.id, userId: viewer.user.id, approve, comment });
  if (!r.handled) return fail("This offer has no approval chain; approve it from the candidate page.");
  if (!r.ok) return fail(`You cannot decide this: ${r.message}.`);
  const recruiters = await usersWithPermission(viewer.tenantId, P.OFFER_MANAGE);
  const who = `${app.candidate.firstName} ${app.candidate.lastName}`;
  if (!approve) {
    await prisma.offer.update({ where: { id: app.offer.id }, data: { status: "WITHDRAWN", declineReason: `Rejected in approval: ${comment}` } });
    await notify({ tenantId: viewer.tenantId, userIds: recruiters, kind: "HIRING", title: `Offer for ${who} rejected in approval`, body: comment, link: `/hiring/applications/${app.id}` });
  } else if (r.final) {
    await approveOffer(app.id, viewer.user.id);
    await notify({ tenantId: viewer.tenantId, userIds: recruiters, kind: "HIRING", title: `Offer for ${who} is fully approved`, body: "Extend it when ready.", link: `/hiring/applications/${app.id}` });
  } else {
    await notify({ tenantId: viewer.tenantId, userIds: [r.next], kind: "APPROVAL", title: `Offer for ${who} needs your approval`, body: `${app.job.title} · ₹${Number(app.offer.annualCtc).toLocaleString("en-IN")}`, link: `/inbox?cat=hire-approvals` });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: approve ? "APPROVE" : "REJECT", entityType: "Offer", entityId: app.id, summary: `Offer approval level: ${approve ? (r.final ? "approved (final)" : "approved, sent on") : `rejected — ${comment}`}` });
  return done(["/inbox", `/hiring/applications/${app.id}`, "/hiring/offers"], approve ? (r.final ? "Approved — the offer can now be extended." : "Approved; sent to the next approver.") : "Rejected; the recruiter has been told.");
}

// ---------------------------------------------------------------------------
//  Career site
// ---------------------------------------------------------------------------

async function uploadImage(viewer: Viewer, f: FormData, key: string): Promise<{ id?: string; error?: string }> {
  const file = f.get(key);
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) return {};
  if (file.size > 2 * 1024 * 1024) return { error: "Images are limited to 2 MB." };
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok || !sniff.mimeType.startsWith("image/")) return { error: "Upload a PNG or JPEG image." };
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: `${key}.${sniff.mimeType === "image/png" ? "png" : "jpg"}`, mimeType: sniff.mimeType, data, relatedType: "CareerSiteAsset", relatedId: viewer.tenantId, uploadedBy: viewer.user.id });
  return { id: stored.id };
}

export async function saveCareerSiteAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.JOB_MANAGE);
  const primaryColor = str(f, "primaryColor", 7) || "#1266a8";
  const accentColor = str(f, "accentColor", 7) || "#0f8a55";
  if (!isHexColor(primaryColor) || !isHexColor(accentColor)) return fail("Colours must be hex values like #1266a8.", f);
  const logo = await uploadImage(viewer, f, "logo");
  const banner = await uploadImage(viewer, f, "banner");
  if (logo.error || banner.error) return fail(logo.error ?? banner.error!, f);
  const data = {
    headline: str(f, "headline", 120) || null, about: str(f, "about", 4000) || null, primaryColor, accentColor,
    embedEnabled: f.get("embedEnabled") === "on", collectEeo: f.get("collectEeo") === "on",
    ...(logo.id ? { logoFileId: logo.id } : f.get("removeLogo") === "on" ? { logoFileId: null } : {}),
    ...(banner.id ? { bannerFileId: banner.id } : f.get("removeBanner") === "on" ? { bannerFileId: null } : {}),
  };
  await prisma.careerSiteSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerSiteSetting", summary: "Updated the career site", newValue: { ...data } });
  return done(["/hiring/settings/careers", "/careers"], "Career site saved.");
}
