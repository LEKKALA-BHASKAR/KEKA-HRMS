"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { notify, reviewStep, parseLevels } from "@keka/services";
import { requireAuth, requireViewer, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { field, intField } from "@/lib/growth";

/**
 * Skills & competency: the skill library (edit, deactivate, employee
 * proposals HR approves), competency frameworks per job profile with a
 * second-person approval and versioning, proficiency scales that are applied
 * to skills once approved, and feedback templates on the same review flow.
 */

const P = PERMISSIONS;
const PATHS = ["/performance/skills", "/me/career", "/performance/careers", "/performance/feedback-templates"];
const NO = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ ok: false, message, ...extra });

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string) {
  await writeAudit(viewer, { module: "EMPLOYEE", action, entityType, entityId, summary });
}

const duplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ---------------------------------------------------------------------------
//  The skill library
// ---------------------------------------------------------------------------

export async function updateSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const s = await prisma.skill.findFirst({ where: { id: field(formData, "skillId", 40), tenantId: viewer.tenantId } });
  if (!s) return NO("Skill not found.");
  const name = field(formData, "name", 80);
  if (!name) return NO("Name the skill.", { errors: { name: "Required" } });
  const validity = intField(formData, "validityMonths", 1, 120);
  if (validity === undefined) return NO("Validity is 1 to 120 months, or blank.", { errors: { validityMonths: "1–120" } });
  const levelsRaw = field(formData, "levels", 800);
  let levels: string[] | undefined;
  if (levelsRaw) {
    const parsed = parseLevels(levelsRaw);
    if (!parsed.ok) return NO(parsed.message, { errors: { levels: parsed.message } });
    const held = await prisma.employeeSkill.aggregate({ where: { skillId: s.id }, _max: { level: true } });
    if ((held._max.level ?? -1) >= parsed.levels.length) return NO("Someone holds a level this ladder would remove — keep at least as many levels.");
    levels = parsed.levels;
  }
  try {
    await prisma.skill.update({ where: { id: s.id }, data: { name, category: field(formData, "category", 60) || null, description: field(formData, "description", 500) || null, isCritical: formData.get("isCritical") === "on", validityMonths: validity, ...(levels ? { levels } : {}) } });
  } catch (e) {
    if (duplicate(e)) return NO("Another skill already has that name.", { errors: { name: "Taken" } });
    throw e;
  }
  await audit(viewer, "UPDATE", "Skill", s.id, `Updated skill "${name}"`);
  return done(PATHS, "Saved.");
}

/** Deactivate (kept on records, no longer offered) or reactivate. */
export async function toggleSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const s = await prisma.skill.findFirst({ where: { id: field(formData, "skillId", 40), tenantId: viewer.tenantId } });
  if (!s) return NO("Skill not found.");
  await prisma.skill.update({ where: { id: s.id }, data: { isActive: !s.isActive } });
  await audit(viewer, "UPDATE", "Skill", s.id, `${s.isActive ? "Deactivated" : "Reactivated"} skill "${s.name}"`);
  return done(PATHS, s.isActive ? "Deactivated — it stays on people's records." : "Reactivated.");
}

/** Anyone can suggest a skill the library lacks; a skills admin approves it. */
export async function proposeSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const name = field(formData, "name", 80);
  if (!name) return NO("Name the skill.", { errors: { name: "Required" } });
  const clash = await prisma.skill.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: name, mode: "insensitive" } } });
  if (clash) return NO(clash.status === "PROPOSED" ? "That skill has already been suggested." : "That skill is already in the library.");
  const s = await prisma.skill.create({ data: { tenantId: viewer.tenantId, name, category: field(formData, "category", 60) || null, description: field(formData, "description", 500) || null, status: "PROPOSED", proposedBy: viewer.user.id, levels: ["Beginner", "Working knowledge", "Proficient", "Expert"] } });
  await audit(viewer, "CREATE", "Skill", s.id, `Suggested skill "${name}"`);
  return done(PATHS, "Suggested — a skills admin will review it.");
}

export async function decideSkillProposalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const s = await prisma.skill.findFirst({ where: { id: field(formData, "skillId", 40), tenantId: viewer.tenantId, status: "PROPOSED" } });
  if (!s) return NO("Suggestion not found.");
  if (s.proposedBy === viewer.user.id) return NO("You suggested this skill — another admin approves it.");
  const decision = field(formData, "decision", 10);
  if (decision !== "approve" && decision !== "reject") return NO("Approve or reject.");
  await prisma.skill.update({ where: { id: s.id }, data: decision === "approve" ? { status: "ACTIVE" } : { status: "REJECTED", isActive: false } });
  if (s.proposedBy) await notify({ tenantId: viewer.tenantId, userIds: [s.proposedBy], kind: "PERFORMANCE", title: `Skill suggestion ${decision === "approve" ? "added" : "declined"}: ${s.name}`, link: "/me/career" });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "Skill", s.id, `${decision === "approve" ? "Approved" : "Declined"} the skill suggestion "${s.name}"`);
  return done(PATHS, decision === "approve" ? "Added to the library." : "Declined.");
}

// ---------------------------------------------------------------------------
//  Competency frameworks
// ---------------------------------------------------------------------------

export async function saveFrameworkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 120);
  if (!name) return NO("Name the framework.", { errors: { name: "Required" } });
  const data = { name, description: field(formData, "description", 1000) || null, jobTitle: field(formData, "jobTitle", 120) || null };
  try {
    if (id) {
      const f = await prisma.competencyFramework.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!f) return NO("Framework not found.");
      if (!["DRAFT", "REJECTED"].includes(f.status)) return NO("Only a draft can be changed — start a new version instead.");
      await prisma.competencyFramework.update({ where: { id }, data });
      await audit(viewer, "UPDATE", "CompetencyFramework", id, `Updated framework "${name}" v${f.version}`);
      return done(PATHS, "Saved.");
    }
    const f = await prisma.competencyFramework.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await audit(viewer, "CREATE", "CompetencyFramework", f.id, `Created competency framework "${name}"`);
    return { ...done(PATHS, "Framework created — add its skills, then submit it."), values: { frameworkId: f.id } };
  } catch (e) {
    if (duplicate(e)) return NO("A framework with that name already exists.", { errors: { name: "Taken" } });
    throw e;
  }
}

/** add / remove a skill on a draft framework. */
export async function frameworkItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const f = await prisma.competencyFramework.findFirst({ where: { id: field(formData, "frameworkId", 40), tenantId: viewer.tenantId } });
  if (!f) return NO("Framework not found.");
  if (!["DRAFT", "REJECTED"].includes(f.status)) return NO("Only a draft can be changed — start a new version instead.");
  const skill = await prisma.skill.findFirst({ where: { id: field(formData, "skillId", 40), tenantId: viewer.tenantId } });
  if (!skill) return NO("Choose a skill.");
  if (field(formData, "op", 10) === "remove") {
    await prisma.competencyItem.deleteMany({ where: { frameworkId: f.id, skillId: skill.id } });
    await audit(viewer, "UPDATE", "CompetencyFramework", f.id, `Removed ${skill.name} from "${f.name}"`);
    return done(PATHS, "Removed.");
  }
  if (skill.status !== "ACTIVE" || !skill.isActive) return NO("That skill is not active.");
  const levels = Array.isArray(skill.levels) ? (skill.levels as string[]) : [];
  const requiredLevel = intField(formData, "requiredLevel", 0, Math.max(0, levels.length - 1));
  if (requiredLevel === null || requiredLevel === undefined) return NO("Choose the level the role needs.", { errors: { requiredLevel: "Required" } });
  const weight = intField(formData, "weight", 1, 5) ?? 1;
  if (weight === undefined) return NO("Weight is 1 to 5.");
  const isCritical = formData.get("isCritical") === "on";
  await prisma.competencyItem.upsert({ where: { frameworkId_skillId: { frameworkId: f.id, skillId: skill.id } }, create: { frameworkId: f.id, skillId: skill.id, requiredLevel, weight, isCritical }, update: { requiredLevel, weight, isCritical } });
  await audit(viewer, "UPDATE", "CompetencyFramework", f.id, `${skill.name} at ${levels[requiredLevel] ?? requiredLevel} on "${f.name}"`);
  return done(PATHS, "Saved.");
}

/** submit / withdraw / approve / reject / archive; "version" copies an approved framework into a new draft. */
export async function frameworkReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const f = await prisma.competencyFramework.findFirst({ where: { id: field(formData, "frameworkId", 40), tenantId: viewer.tenantId }, include: { items: true } });
  if (!f) return NO("Framework not found.");
  const op = field(formData, "op", 12);
  const note = field(formData, "note", 1000);
  if (op === "version") {
    if (f.status !== "APPROVED") return NO("Only an approved framework gets a new version.");
    const latest = await prisma.competencyFramework.findFirst({ where: { tenantId: viewer.tenantId, name: f.name }, orderBy: { version: "desc" } });
    if (latest && latest.id !== f.id) return NO(`Version ${latest.version} already exists.`);
    const next = await prisma.competencyFramework.create({ data: { tenantId: viewer.tenantId, name: f.name, description: f.description, jobTitle: f.jobTitle, version: f.version + 1, previousId: f.id, createdBy: viewer.user.id, items: { create: f.items.map((i) => ({ skillId: i.skillId, requiredLevel: i.requiredLevel, weight: i.weight, isCritical: i.isCritical })) } } });
    await audit(viewer, "CREATE", "CompetencyFramework", next.id, `Started version ${next.version} of "${f.name}"`);
    return { ...done(PATHS, `Version ${next.version} started as a draft.`), values: { frameworkId: next.id } };
  }
  if (op === "submit" && f.items.length === 0) return NO("Add at least one skill first.");
  const step = reviewStep(f.status, op, { actor: viewer.user.id, submittedBy: f.submittedBy, note });
  if (!step.ok) return NO(step.message);
  await prisma.$transaction(async (tx) => {
    await tx.competencyFramework.update({
      where: { id: f.id },
      data: { status: step.next, ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: new Date(), decisionNote: null } : {}), ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}) },
    });
    // Approving a new version retires the one it replaces.
    if (op === "approve" && f.previousId) await tx.competencyFramework.updateMany({ where: { id: f.previousId, status: "APPROVED" }, data: { status: "ARCHIVED" } });
  });
  if ((op === "approve" || op === "reject") && f.submittedBy) await notify({ tenantId: viewer.tenantId, userIds: [f.submittedBy], kind: "PERFORMANCE", title: `Competency framework ${op === "approve" ? "approved" : "sent back"}: ${f.name}`, body: note || null, link: `/performance/skills?tab=frameworks` });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "CompetencyFramework", f.id, `${op} framework "${f.name}" v${f.version}`);
  return done(PATHS, { submit: "Submitted for approval.", withdraw: "Withdrawn.", approve: "Approved — gap reports now use it.", reject: "Sent back.", archive: "Archived.", reopen: "Reopened." }[op] ?? "Done.");
}

export async function deleteFrameworkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const f = await prisma.competencyFramework.findFirst({ where: { id: field(formData, "frameworkId", 40), tenantId: viewer.tenantId } });
  if (!f) return NO("Framework not found.");
  if (f.status !== "DRAFT") return NO("Only a draft can be deleted; archive an approved framework.");
  await prisma.competencyFramework.delete({ where: { id: f.id } });
  await audit(viewer, "DELETE", "CompetencyFramework", f.id, `Deleted draft framework "${f.name}" v${f.version}`);
  return done(PATHS, "Deleted.");
}

// ---------------------------------------------------------------------------
//  Proficiency scales
// ---------------------------------------------------------------------------

export async function saveScaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 80);
  if (!name) return NO("Name the scale.", { errors: { name: "Required" } });
  const parsed = parseLevels(field(formData, "levels", 800));
  if (!parsed.ok) return NO(parsed.message, { errors: { levels: parsed.message } });
  const descriptions = field(formData, "descriptions", 4000).split("\n").map((d) => d.trim().slice(0, 300)).slice(0, parsed.levels.length);
  try {
    if (id) {
      const s = await prisma.proficiencyScale.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!s) return NO("Scale not found.");
      if (!["DRAFT", "REJECTED"].includes(s.status)) return NO("Reopen the scale before changing it.");
      await prisma.proficiencyScale.update({ where: { id }, data: { name, levels: parsed.levels, descriptions } });
      await audit(viewer, "UPDATE", "ProficiencyScale", id, `Updated proficiency scale "${name}"`);
      return done(PATHS, "Saved.");
    }
    const s = await prisma.proficiencyScale.create({ data: { tenantId: viewer.tenantId, name, levels: parsed.levels, descriptions, createdBy: viewer.user.id } });
    await audit(viewer, "CREATE", "ProficiencyScale", s.id, `Created proficiency scale "${name}" (${parsed.levels.length} levels)`);
    return { ...done(PATHS, "Scale created — submit it for approval."), values: { scaleId: s.id } };
  } catch (e) {
    if (duplicate(e)) return NO("A scale with that name already exists.", { errors: { name: "Taken" } });
    throw e;
  }
}

export async function scaleReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const s = await prisma.proficiencyScale.findFirst({ where: { id: field(formData, "scaleId", 40), tenantId: viewer.tenantId } });
  if (!s) return NO("Scale not found.");
  const op = field(formData, "op", 12), note = field(formData, "note", 1000);
  const step = reviewStep(s.status, op, { actor: viewer.user.id, submittedBy: s.submittedBy, note });
  if (!step.ok) return NO(step.message);
  await prisma.proficiencyScale.update({ where: { id: s.id }, data: { status: step.next, ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: new Date(), decisionNote: null } : {}), ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}) } });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "ProficiencyScale", s.id, `${op} proficiency scale "${s.name}"`);
  return done(PATHS, "Done.");
}

/** Put an approved scale's levels on a skill (only if nobody holds a level it would drop). */
export async function applyScaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const s = await prisma.proficiencyScale.findFirst({ where: { id: field(formData, "scaleId", 40), tenantId: viewer.tenantId } });
  if (!s || s.status !== "APPROVED") return NO("Choose an approved scale.");
  const skill = await prisma.skill.findFirst({ where: { id: field(formData, "skillId", 40), tenantId: viewer.tenantId } });
  if (!skill) return NO("Skill not found.");
  const held = await prisma.employeeSkill.aggregate({ where: { skillId: skill.id }, _max: { level: true } });
  if ((held._max.level ?? -1) >= s.levels.length) return NO("Someone holds a level this scale does not have.");
  await prisma.skill.update({ where: { id: skill.id }, data: { levels: s.levels } });
  await audit(viewer, "UPDATE", "Skill", skill.id, `Applied scale "${s.name}" to ${skill.name}`);
  return done(PATHS, `${skill.name} now uses "${s.name}".`);
}

// ---------------------------------------------------------------------------
//  Feedback templates
// ---------------------------------------------------------------------------

const PURPOSES = ["PEER", "MANAGER", "UPWARD", "THREE_SIXTY", "ADHOC"];

export async function saveFeedbackTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 120);
  const purpose = field(formData, "purpose", 20) || "ADHOC";
  const questions = field(formData, "questions", 6000).split("\n").map((q) => q.trim().slice(0, 400)).filter(Boolean);
  if (!name) return NO("Name the template.", { errors: { name: "Required" } });
  if (!PURPOSES.includes(purpose)) return NO("Choose what the template is for.");
  if (questions.length === 0 || questions.length > 20) return NO("Give 1 to 20 questions, one per line.", { errors: { questions: "1–20" } });
  const data = { name, purpose, questions, description: field(formData, "description", 500) || null };
  try {
    if (id) {
      const t = await prisma.feedbackTemplate.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!t) return NO("Template not found.");
      if (!["DRAFT", "REJECTED"].includes(t.status)) return NO("Reopen the template before changing it.");
      await prisma.feedbackTemplate.update({ where: { id }, data });
      await audit(viewer, "UPDATE", "FeedbackTemplate", id, `Updated feedback template "${name}"`);
      return done(PATHS, "Saved.");
    }
    const t = await prisma.feedbackTemplate.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await audit(viewer, "CREATE", "FeedbackTemplate", t.id, `Created feedback template "${name}"`);
    return { ...done(PATHS, "Template created — submit it for approval."), values: { templateId: t.id } };
  } catch (e) {
    if (duplicate(e)) return NO("A template with that name already exists.", { errors: { name: "Taken" } });
    throw e;
  }
}

export async function feedbackTemplateReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const t = await prisma.feedbackTemplate.findFirst({ where: { id: field(formData, "templateId", 40), tenantId: viewer.tenantId } });
  if (!t) return NO("Template not found.");
  const op = field(formData, "op", 12), note = field(formData, "note", 1000);
  if (op === "delete") {
    if (t.status !== "DRAFT") return NO("Only a draft can be deleted; archive it instead.");
    await prisma.feedbackTemplate.delete({ where: { id: t.id } });
    await audit(viewer, "DELETE", "FeedbackTemplate", t.id, `Deleted feedback template "${t.name}"`);
    return done(PATHS, "Deleted.");
  }
  const step = reviewStep(t.status, op, { actor: viewer.user.id, submittedBy: t.submittedBy, note });
  if (!step.ok) return NO(step.message);
  await prisma.feedbackTemplate.update({ where: { id: t.id }, data: { status: step.next, ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: new Date(), decisionNote: null } : {}), ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}) } });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "FeedbackTemplate", t.id, `${op} feedback template "${t.name}"`);
  return done(PATHS, "Done.");
}
