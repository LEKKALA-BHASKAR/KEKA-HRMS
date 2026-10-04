"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { notify } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { z, parseForm, toErrorState, actionDone as done, writeAudit, zName, zOptional, zNumber, zOptionalId, zId, type ActionState } from "@/lib/forms";

/** Every rating of a skill is kept as history. */
async function logAssessment(viewer: Viewer, employeeId: string, skillId: string, kind: "SELF" | "MANAGER" | "REJECTED", level: number, evidence?: string | null) {
  await prisma.skillAssessmentLog.create({ data: { tenantId: viewer.tenantId, employeeId, skillId, kind, level, evidence: evidence || null, assessedBy: viewer.user.id } });
}

const P = PERMISSIONS;
const PATHS = ["/me/career", "/performance/careers"];
const DEFAULT_LEVELS = ["Beginner", "Working knowledge", "Proficient", "Expert"];

/** Line managers (direct or skip-level) and skill admins in scope may rate and approve. */
async function mayRate(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return false;
  if (viewer.allReportIds.has(employeeId)) return true;
  if (!can(viewer, P.SKILL_MANAGE)) return false;
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, P.SKILL_MANAGE);
}

const levelsOf = (raw: unknown): string[] => (Array.isArray(raw) && raw.length ? (raw as string[]) : DEFAULT_LEVELS);

// ---------------------------------------------------------------------------
//  The skill catalogue
// ---------------------------------------------------------------------------

const skillSchema = z.object({ name: zName(80), category: zOptional(60), description: zOptional(500), levels: zOptional(500) });

export async function createSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const parsed = parseForm(skillSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const levels = (d.levels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (levels.length === 1) return { ok: false, message: "Give at least two levels, separated by commas — or leave blank for the default four.", errors: { levels: "At least two" } };
  try {
    const s = await prisma.skill.create({ data: { tenantId: viewer.tenantId, name: d.name, category: d.category, description: d.description, levels: levels.length ? levels : DEFAULT_LEVELS } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Skill", entityId: s.id, summary: `Added skill "${d.name}"` });
    return done([...PATHS, "/performance/skills"], `${d.name} added to the skill catalogue.`);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  An employee's skills
// ---------------------------------------------------------------------------

const mySkillSchema = z.object({ skillId: zId(), level: zNumber({ min: 0, max: 10, required: true }) });

/** Self-assessed skills wait for the manager's approval before they count. */
export async function addMySkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record." };
  const parsed = parseForm(mySkillSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const skill = await prisma.skill.findFirst({ where: { id: d.skillId, tenantId: viewer.tenantId, isActive: true, status: "ACTIVE" } });
  if (!skill) return { ok: false, message: "Skill not found." };
  const level = d.level as number;
  if (level >= levelsOf(skill.levels).length) return { ok: false, message: "Choose one of the skill's levels.", errors: { level: "Out of range" } };
  const existing = await prisma.employeeSkill.findUnique({ where: { employeeId_skillId: { employeeId: viewer.employee.id, skillId: skill.id } } });
  // An approved level is never replaced by an unapproved one: that would
  // drop the confirmed level from readiness while the new one waits.
  if (existing?.isApproved) {
    return { ok: false, message: `Your ${skill.name} is confirmed at ${levelsOf(skill.levels)[existing.level]}. Ask your manager to update it.` };
  }
  await prisma.employeeSkill.upsert({
    where: { employeeId_skillId: { employeeId: viewer.employee.id, skillId: skill.id } },
    create: { employeeId: viewer.employee.id, skillId: skill.id, level, source: "SELF", isApproved: false },
    update: { level, source: "SELF" },
  });
  const evidence = String(formData.get("evidence") ?? "").trim().slice(0, 1000);
  await logAssessment(viewer, viewer.employee.id, skill.id, "SELF", level, evidence);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeSkill", entityId: skill.id, summary: `Self-rated ${skill.name} at ${levelsOf(skill.levels)[level]}` });
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { reportingManager: { select: { userId: true } } } });
  await notify({ tenantId: viewer.tenantId, userIds: [me.reportingManager?.userId], kind: "PERFORMANCE", title: `${viewer.employee.displayName} added ${skill.name}`, body: `Self-rated ${levelsOf(skill.levels)[level]} — please review`, link: "/performance/careers?tab=team" });
  return done(PATHS, "Added. Your manager will confirm the level.");
}

export async function removeMySkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record." };
  const id = String(formData.get("id"));
  const row = await prisma.employeeSkill.findFirst({ where: { id, employeeId: viewer.employee.id } });
  if (!row) return { ok: false, message: "Skill not found." };
  if (row.isApproved) return { ok: false, message: "An approved skill stays on your record; ask your manager to change it." };
  await prisma.employeeSkill.delete({ where: { id } });
  return done(PATHS, "Removed.");
}

const rateSchema = z.object({ employeeId: zId(), skillId: zId(), level: zNumber({ min: 0, max: 10, required: true }) });

/** A manager sets (and thereby approves) a level for someone in their line. */
export async function rateSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(rateSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await mayRate(viewer, d.employeeId))) return { ok: false, message: "You can rate skills for people in your line only, and not your own." };
  const skill = await prisma.skill.findFirst({ where: { id: d.skillId, tenantId: viewer.tenantId } });
  if (!skill) return { ok: false, message: "Skill not found." };
  const level = d.level as number;
  if (level >= levelsOf(skill.levels).length) return { ok: false, message: "Choose one of the skill's levels." };
  const stamp = { level, isApproved: true, approvedBy: viewer.employee?.id ?? viewer.user.id, approvedAt: new Date() };
  await prisma.employeeSkill.upsert({
    where: { employeeId_skillId: { employeeId: d.employeeId, skillId: skill.id } },
    create: { employeeId: d.employeeId, skillId: skill.id, source: "MANAGER", ...stamp },
    update: stamp,
  });
  await logAssessment(viewer, d.employeeId, skill.id, "MANAGER", level, String(formData.get("evidence") ?? "").trim().slice(0, 1000));
  await writeAudit(viewer, { module: "EMPLOYEE", action: "APPROVE", entityType: "EmployeeSkill", entityId: skill.id, summary: `Set ${skill.name} to ${levelsOf(skill.levels)[level]} for an employee` });
  return done(PATHS, `${skill.name} set to ${levelsOf(skill.levels)[level]}.`);
}

export async function rejectSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const row = await prisma.employeeSkill.findFirst({ where: { id: String(formData.get("id")), skill: { tenantId: viewer.tenantId } } });
  if (!row) return { ok: false, message: "Not found." };
  if (!(await mayRate(viewer, row.employeeId))) return { ok: false, message: "You cannot review this skill." };
  if (row.isApproved) return { ok: false, message: "Already approved." };
  await prisma.employeeSkill.delete({ where: { id: row.id } });
  await logAssessment(viewer, row.employeeId, row.skillId, "REJECTED", row.level);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "REJECT", entityType: "EmployeeSkill", entityId: row.skillId, summary: "Declined a self-rated skill" });
  return done(PATHS, "Self-rating declined.");
}

// ---------------------------------------------------------------------------
//  Career paths
// ---------------------------------------------------------------------------

const pathSchema = z.object({ name: zName(100), description: zOptional(500), departmentId: zOptionalId() });

export async function createPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const parsed = parseForm(pathSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.departmentId && !(await prisma.department.count({ where: { id: d.departmentId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Department not found." };
  try {
    // New paths are drafts until a second careers admin approves them.
    const p = await prisma.careerPath.create({ data: { tenantId: viewer.tenantId, ...d, status: "DRAFT" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CareerPath", entityId: p.id, summary: `Created career path "${d.name}"` });
    return done(PATHS, "Career path created — add its steps, then submit it for approval.");
  } catch (err) {
    return toErrorState(err);
  }
}

const stepSchema = z.object({ pathId: zId(), title: zName(100), description: zOptional(500), minYears: zNumber({ min: 0, max: 40 }) });

export async function addStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const parsed = parseForm(stepSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const path = await prisma.careerPath.findFirst({ where: { id: d.pathId, tenantId: viewer.tenantId }, include: { steps: { orderBy: { sequence: "asc" } } } });
  if (!path) return { ok: false, message: "Career path not found." };
  if (path.steps.some((s) => s.title.toLowerCase() === d.title.toLowerCase())) return { ok: false, message: "That step is already on this path.", errors: { title: "Duplicate" } };
  const step = await prisma.careerPathStep.create({ data: { pathId: path.id, sequence: (path.steps.at(-1)?.sequence ?? 0) + 1, title: d.title, description: d.description, minYears: d.minYears ?? 0 } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CareerPathStep", entityId: step.id, summary: `Added step "${d.title}" to "${path.name}"` });
  return done(PATHS, "Step added.");
}

const stepSkillSchema = z.object({ stepId: zId(), skillId: zId(), level: zNumber({ min: 0, max: 10, required: true }) });

export async function setStepSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const parsed = parseForm(stepSkillSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const [step, skill] = await Promise.all([
    prisma.careerPathStep.findFirst({ where: { id: d.stepId, path: { tenantId: viewer.tenantId } } }),
    prisma.skill.findFirst({ where: { id: d.skillId, tenantId: viewer.tenantId } }),
  ]);
  if (!step || !skill) return { ok: false, message: "Step or skill not found." };
  const level = d.level as number;
  if (level >= levelsOf(skill.levels).length) return { ok: false, message: "Choose one of the skill's levels." };
  await prisma.careerStepSkill.upsert({
    where: { stepId_skillId: { stepId: step.id, skillId: skill.id } },
    create: { stepId: step.id, skillId: skill.id, level }, update: { level },
  });
  return done(PATHS, `${skill.name} (${levelsOf(skill.levels)[level]}) required for ${step.title}.`);
}

export async function removeStepSkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CAREER_PATH_MANAGE);
  const row = await prisma.careerStepSkill.findFirst({ where: { id: String(formData.get("id")), step: { path: { tenantId: viewer.tenantId } } } });
  if (!row) return { ok: false, message: "Not found." };
  await prisma.careerStepSkill.delete({ where: { id: row.id } });
  return done(PATHS, "Requirement removed.");
}

/** An employee picks the rung they are working towards. */
export async function setAspirationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record." };
  const stepId = String(formData.get("stepId") ?? "");
  if (!stepId) {
    await prisma.careerAspiration.deleteMany({ where: { employeeId: viewer.employee.id } });
    return done(PATHS, "Cleared.");
  }
  const step = await prisma.careerPathStep.findFirst({ where: { id: stepId, path: { tenantId: viewer.tenantId, status: "APPROVED" } } });
  if (!step) return { ok: false, message: "Step not found." };
  const note = String(formData.get("note") ?? "").slice(0, 500) || null;
  const rawTarget = String(formData.get("targetDate") ?? "");
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawTarget) ? new Date(`${rawTarget}T00:00:00.000Z`) : null;
  const openToRelocate = formData.get("openToRelocate") === "on";
  // A new goal, or a changed one, goes back to the manager for endorsement.
  const fresh = { stepId, note, targetDate, openToRelocate, status: "PENDING", managerNote: null, endorsedBy: null, endorsedAt: null };
  const a = await prisma.careerAspiration.upsert({
    where: { employeeId: viewer.employee.id },
    create: { employeeId: viewer.employee.id, ...fresh }, update: fresh,
  });
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { reportingManager: { select: { userId: true } } } });
  await notify({ tenantId: viewer.tenantId, userIds: [me.reportingManager?.userId], kind: "CAREER", title: `${viewer.employee.displayName} is aiming for ${step.title}`, body: "Please endorse or discuss.", link: "/performance/careers?tab=team" });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerAspiration", entityId: a.id, summary: `Set career goal: ${step.title}` });
  return done(PATHS, `Goal set: ${step.title}.`);
}
