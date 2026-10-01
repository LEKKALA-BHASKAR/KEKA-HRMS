"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  courseProblems, completeModule, submitAttempt, recomputeEnrolment, notify,
  validateQuestion, parseQuestionCsv, parseGeneratedQuestions, type QuestionInput, type QuestionKind,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, safeRevalidate, type ActionState } from "@/lib/forms";
import { aiForViewer, aiJson, aiText, aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { saveFile } from "@/lib/storage";

/**
 * Learn: building courses (sections, modules, assessments), the two AI
 * helpers in the builder, publishing, and the learner's side — enrolling,
 * completing modules and taking assessments. Builders need TRAINING_MANAGE;
 * learners act only on their own enrolment. Correct answers never leave the
 * server except to a builder.
 */

const P = PERMISSIONS;
const MANAGE = "/learn/manage-courses";
const learnPaths = (courseId?: string) => [MANAGE, "/learn/my-courses", "/learn/library", "/training", ...(courseId ? [`${MANAGE}/${courseId}`, `/learn/courses/${courseId}`] : [])];
const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
/** Keka shows "Generate using AI (3)": three goes per item per day. */
const AI_PER_ITEM = 3;
const QTYPES = ["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE"] as const;

async function course(viewer: Viewer, courseId: string) {
  return prisma.trainingProgram.findFirst({ where: { id: courseId, tenantId: viewer.tenantId, format: "COURSE" } });
}

async function moduleOf(viewer: Viewer, moduleId: string) {
  return prisma.courseModule.findFirst({ where: { id: moduleId, program: { tenantId: viewer.tenantId, format: "COURSE" } }, include: { program: true } });
}

/** Changes to content re-date the course and keep every learner's progress honest. */
async function touch(courseId: string, structural = false) {
  await prisma.trainingProgram.update({ where: { id: courseId }, data: { updatedAt: new Date() } });
  if (structural) {
    const enrolments = await prisma.trainingEnrolment.findMany({ where: { programId: courseId }, select: { id: true } });
    for (const e of enrolments) await recomputeEnrolment(e.id);
  }
}

async function aiRemaining(viewer: Viewer, feature: string, subjectId: string): Promise<number> {
  const used = await prisma.aiGeneration.count({ where: { tenantId: viewer.tenantId, userId: viewer.user.id, feature, subjectId, ok: true, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  return Math.max(0, AI_PER_ITEM - used);
}

async function courseType(tenantId: string) {
  return (await prisma.trainingType.findFirst({ where: { tenantId, name: "Self-paced Course" } }))
    ?? prisma.trainingType.create({ data: { tenantId, name: "Self-paced Course", mode: "ONLINE", description: "Courses built in Learn" } });
}

// ---------------------------------------------------------------------------
//  Courses
// ---------------------------------------------------------------------------

export async function createCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState & { courseId?: string }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const title = text(formData, "title");
  const description = text(formData, "description");
  const values = { title, description };
  if (!title) return { ok: false, message: "Add a course title.", errors: { title: "Required" }, values };
  if (title.length > 120) return { ok: false, message: "Keep the title under 120 characters.", errors: { title: "Too long" }, values };
  if (description.length > 1000) return { ok: false, message: "Keep the description under 1,000 characters.", errors: { description: "Too long" }, values };
  const type = await courseType(viewer.tenantId);
  const c = await prisma.trainingProgram.create({
    data: {
      tenantId: viewer.tenantId, trainingTypeId: type.id, title, description: description || null,
      format: "COURSE", courseState: "DRAFT", status: "PLANNED", authorId: viewer.employee?.id ?? null, trainer: viewer.employee?.displayName ?? null,
    },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "TrainingProgram", entityId: c.id, summary: `Created course ${title}` });
  safeRevalidate(MANAGE);
  return { ok: true, message: "Course created.", courseId: c.id };
}

/** "Generate using AI" for a course description. Sent: the title, and the category and skills if set. */
export async function generateCourseDescriptionAction(input: { title: string; courseId?: string; draftKey?: string }): Promise<{ ok: boolean; message?: string; text?: string; remaining?: number }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  if (!aiEnabled()) return { ok: false, message: AI_UNAVAILABLE };
  const title = String(input.title ?? "").trim().slice(0, 120);
  if (!title) return { ok: false, message: "Add the course title first." };
  const c = input.courseId ? await course(viewer, String(input.courseId)) : null;
  const subjectId = c?.id ?? `draft:${String(input.draftKey ?? "").slice(0, 40) || "new"}`;
  const remaining = await aiRemaining(viewer, "COURSE_DESCRIPTION", subjectId);
  if (remaining <= 0) return { ok: false, message: "You have used all three AI generations for this course today.", remaining: 0 };
  const skills = Array.isArray(c?.skills) ? (c!.skills as unknown[]).filter((s): s is string => typeof s === "string").join(", ") : "";
  const prompt = [`Course title: ${title}`, c?.category ? `Category: ${c.category}` : "", skills ? `Skills: ${skills}` : ""].filter(Boolean).join("\n");
  const r = await aiForViewer(viewer, { feature: "COURSE_DESCRIPTION", subjectId, inputChars: prompt.length }, () => aiText({
    system: "You write the description of an internal company training course for its course page: one paragraph of 80 to 140 words saying what the learner will learn and how, in plain professional English. No headings, no bullet points, no quotation marks.",
    prompt, maxTokens: 600,
  }));
  if (!r.ok) return { ok: false, message: r.reason, remaining };
  return { ok: true, text: r.value.replace(/^["“]|["”]$/g, "").trim().slice(0, 1000), remaining: remaining - 1 };
}

export async function updateCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const c = await course(viewer, text(formData, "courseId"));
  if (!c) return { ok: false, message: "Course not found." };
  const title = formData.has("title") ? text(formData, "title") : c.title;
  if (!title || title.length > 120) return { ok: false, message: "The title is required (under 120 characters).", errors: { title: "Required" } };
  const data: Record<string, unknown> = { title };
  if (formData.has("description")) {
    const d = text(formData, "description");
    if (d.length > 1000) return { ok: false, message: "Keep the description under 1,000 characters.", errors: { description: "Too long" } };
    data.description = d || null;
  }
  if (formData.has("category")) data.category = text(formData, "category").slice(0, 60) || null;
  if (formData.has("skills")) data.skills = [...new Set(text(formData, "skills").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  if (formData.has("settings")) {
    data.selfEnrol = formData.get("selfEnrol") === "on";
    data.isMandatory = formData.get("isMandatory") === "on";
  }
  await prisma.trainingProgram.update({ where: { id: c.id }, data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TrainingProgram", entityId: c.id, summary: `Updated course ${title}` });
  return done(learnPaths(c.id), "Changes saved.");
}

export async function courseStateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const c = await course(viewer, text(formData, "courseId"));
  if (!c) return { ok: false, message: "Course not found." };
  const op = text(formData, "op");
  if (op === "publish") {
    if (c.courseState === "PUBLISHED") return { ok: false, message: "Already published." };
    const problems = await courseProblems(c.id);
    if (problems.length) return { ok: false, message: `Not ready to publish: ${problems.slice(0, 3).join(" ")}` };
    await prisma.trainingProgram.update({ where: { id: c.id }, data: { courseState: "PUBLISHED", publishedAt: c.publishedAt ?? new Date(), status: "IN_PROGRESS" } });
    const learners = await prisma.trainingEnrolment.findMany({ where: { programId: c.id }, select: { employee: { select: { userId: true } } } });
    await notify({ tenantId: viewer.tenantId, userIds: learners.map((l) => l.employee.userId), kind: "TRAINING", title: `Course ready: ${c.title}`, link: `/learn/courses/${c.id}` });
  } else if (op === "archive") {
    if (c.courseState === "ARCHIVED") return { ok: false, message: "Already archived." };
    await prisma.trainingProgram.update({ where: { id: c.id }, data: { courseState: "ARCHIVED" } });
  } else if (op === "restore" || op === "unpublish") {
    if (c.courseState === "DRAFT") return { ok: false, message: "Already a draft." };
    await prisma.trainingProgram.update({ where: { id: c.id }, data: { courseState: "DRAFT", status: "PLANNED" } });
  } else return { ok: false, message: "Unknown action." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TrainingProgram", entityId: c.id, summary: `${op} course ${c.title}` });
  return done(learnPaths(c.id), op === "publish" ? "Course published." : op === "archive" ? "Course archived." : "Course moved back to drafts.");
}

// ---------------------------------------------------------------------------
//  Structure: sections and modules
// ---------------------------------------------------------------------------

export async function saveSectionAction(_prev: ActionState, formData: FormData): Promise<ActionState & { sectionId?: string }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const c = await course(viewer, text(formData, "courseId"));
  if (!c) return { ok: false, message: "Course not found." };
  const title = text(formData, "title");
  if (!title || title.length > 120) return { ok: false, message: "Name the section (under 120 characters).", errors: { title: "Required" } };
  const id = text(formData, "sectionId");
  let sectionId = id;
  if (id) {
    const s = await prisma.courseSection.findFirst({ where: { id, programId: c.id } });
    if (!s) return { ok: false, message: "Section not found." };
    await prisma.courseSection.update({ where: { id }, data: { title } });
  } else {
    const n = await prisma.courseSection.count({ where: { programId: c.id } });
    if (n >= 40) return { ok: false, message: "A course can have 40 sections." };
    sectionId = (await prisma.courseSection.create({ data: { programId: c.id, title, displayOrder: n } })).id;
  }
  await touch(c.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "CourseSection", entityId: sectionId, summary: `${id ? "Renamed" : "Added"} section ${title} in ${c.title}` });
  safeRevalidate(...learnPaths(c.id));
  return { ok: true, message: id ? "Section renamed." : "Section added.", sectionId };
}

export async function deleteSectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const s = await prisma.courseSection.findFirst({ where: { id: text(formData, "sectionId"), program: { tenantId: viewer.tenantId, format: "COURSE" } } });
  if (!s) return { ok: false, message: "Section not found." };
  await prisma.courseSection.delete({ where: { id: s.id } });
  await touch(s.programId, true);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "CourseSection", entityId: s.id, summary: `Deleted section ${s.title} and its modules` });
  return done(learnPaths(s.programId), "Section deleted.");
}

const MODULE_TYPES = ["DOCUMENT", "VIDEO", "PAGE", "ASSESSMENT"] as const;
const VIDEO_HOSTS = /^(www\.)?(youtube\.com|youtu\.be|vimeo\.com|player\.vimeo\.com|drive\.google\.com|onedrive\.live\.com|1drv\.ms|[\w-]+\.sharepoint\.com)$/i;

export async function saveModuleAction(_prev: ActionState, formData: FormData): Promise<ActionState & { moduleId?: string }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const c = await course(viewer, text(formData, "courseId"));
  if (!c) return { ok: false, message: "Course not found." };
  const id = text(formData, "moduleId");
  const existing = id ? await prisma.courseModule.findFirst({ where: { id, programId: c.id } }) : null;
  if (id && !existing) return { ok: false, message: "Module not found." };
  const type = existing?.type ?? ((MODULE_TYPES as readonly string[]).includes(text(formData, "type")) ? text(formData, "type") as (typeof MODULE_TYPES)[number] : null);
  if (!type) return { ok: false, message: "Choose a module type." };
  const title = text(formData, "title");
  const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)]));
  if (!title || title.length > 160) return { ok: false, message: "Give the module a title (under 160 characters).", errors: { title: "Required" }, values };
  const minutes = Number(text(formData, "durationMinutes") || 0);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return { ok: false, message: "Duration is in whole minutes, up to a day.", errors: { durationMinutes: "0–1440" }, values };
  const sectionId = text(formData, "sectionId") || null;
  if (sectionId && !(await prisma.courseSection.findFirst({ where: { id: sectionId, programId: c.id } }))) return { ok: false, message: "Section not found.", values };
  const data: Record<string, unknown> = { title, durationMinutes: minutes };
  if (type === "PAGE") {
    const body = String(formData.get("body") ?? "").trim();
    if (body.length > 50_000) return { ok: false, message: "Keep a page under 50,000 characters.", errors: { body: "Too long" }, values };
    data.body = body || null;
  }
  if (type === "VIDEO") {
    const url = text(formData, "url");
    let okUrl = false;
    try { const u = new URL(url); okUrl = u.protocol === "https:" && VIDEO_HOSTS.test(u.hostname); } catch { okUrl = false; }
    if (!okUrl) return { ok: false, message: "Use an https link from YouTube, Vimeo, Google Drive, OneDrive or SharePoint.", errors: { url: "Unsupported link" }, values };
    data.url = url;
  }
  if (type === "ASSESSMENT") {
    const pass = Number(text(formData, "passPercent") || 70);
    if (!Number.isInteger(pass) || pass < 1 || pass > 100) return { ok: false, message: "The pass mark is a whole percentage from 1 to 100.", errors: { passPercent: "1–100" }, values };
    data.passPercent = pass;
  }
  let moduleId = id;
  if (existing) {
    await prisma.courseModule.update({ where: { id }, data });
  } else {
    const n = await prisma.courseModule.count({ where: { programId: c.id, sectionId } });
    if ((await prisma.courseModule.count({ where: { programId: c.id } })) >= 200) return { ok: false, message: "A course can have 200 modules.", values };
    moduleId = (await prisma.courseModule.create({ data: { ...data, programId: c.id, sectionId, type, displayOrder: n } as never })).id;
  }
  if (type === "DOCUMENT") {
    const file = formData.get("file");
    if (file && typeof file !== "string" && file.size > 0) {
      if (file.type !== "application/pdf") return { ok: false, message: "Upload a PDF.", errors: { file: "PDF only" }, values, moduleId };
      try {
        const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name, mimeType: file.type, data: Buffer.from(await file.arrayBuffer()), relatedType: "CourseModule", relatedId: moduleId, uploadedBy: viewer.user.id });
        await prisma.courseModule.update({ where: { id: moduleId }, data: { fileId: stored.id } });
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "The file could not be stored.", values, moduleId };
      }
    } else if (!existing?.fileId) {
      // Saved without a file: the course cannot publish until one is added.
    }
  }
  await touch(c.id, !existing);
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "CourseModule", entityId: moduleId, summary: `${existing ? "Updated" : "Added"} ${type.toLowerCase()} module ${title} in ${c.title}` });
  safeRevalidate(...learnPaths(c.id));
  return { ok: true, message: existing ? "Module saved." : "Module has been successfully added.", moduleId };
}

export async function moduleOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const m = await moduleOf(viewer, text(formData, "moduleId"));
  if (!m) return { ok: false, message: "Module not found." };
  const op = text(formData, "op");
  if (op === "delete") {
    await prisma.courseModule.delete({ where: { id: m.id } });
    await touch(m.programId, true);
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "CourseModule", entityId: m.id, summary: `Deleted module ${m.title} from ${m.program.title}` });
    return done(learnPaths(m.programId), "Module deleted.");
  }
  if (op === "up" || op === "down") {
    const siblings = await prisma.courseModule.findMany({ where: { programId: m.programId, sectionId: m.sectionId }, orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const i = siblings.findIndex((s) => s.id === m.id);
    const j = op === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return { ok: false, message: "It is already at the edge." };
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    await prisma.$transaction(siblings.map((s, k) => prisma.courseModule.update({ where: { id: s.id }, data: { displayOrder: k } })));
    await touch(m.programId);
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CourseModule", entityId: m.id, summary: `Moved module ${m.title} ${op}` });
    return done(learnPaths(m.programId), "Moved.");
  }
  return { ok: false, message: "Unknown action." };
}

// ---------------------------------------------------------------------------
//  Assessment questions
// ---------------------------------------------------------------------------

function readQuestion(formData: FormData): QuestionInput | null {
  try {
    const type = (QTYPES as readonly string[]).includes(text(formData, "type")) ? text(formData, "type") as QuestionKind : "SINGLE_CHOICE";
    const options = (JSON.parse(String(formData.get("options") ?? "[]")) as Array<{ id: unknown; text: unknown }>)
      .map((o, k) => ({ id: typeof o.id === "string" && /^[\w-]{1,20}$/.test(o.id) ? o.id : `o${k + 1}`, text: String(o.text ?? "").trim() }))
      .filter((o) => o.text);
    const correctOptionIds = (JSON.parse(String(formData.get("correct") ?? "[]")) as unknown[]).map(String);
    return { type, prompt: text(formData, "prompt"), options, correctOptionIds };
  } catch {
    return null;
  }
}

async function assessmentOf(viewer: Viewer, moduleId: string) {
  const m = await moduleOf(viewer, moduleId);
  return m && m.type === "ASSESSMENT" ? m : null;
}

export async function saveQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const m = await assessmentOf(viewer, text(formData, "moduleId"));
  if (!m) return { ok: false, message: "Assessment not found." };
  const q = readQuestion(formData);
  if (!q) return { ok: false, message: "The question could not be read." };
  const problem = validateQuestion(q);
  if (problem) return { ok: false, message: problem };
  const id = text(formData, "questionId");
  const correct = q.correctOptionIds.filter((c) => q.options.some((o) => o.id === c));
  if (id) {
    const existing = await prisma.assessmentQuestion.findFirst({ where: { id, moduleId: m.id } });
    if (!existing) return { ok: false, message: "Question not found." };
    await prisma.assessmentQuestion.update({ where: { id }, data: { type: q.type, prompt: q.prompt, options: q.options, correctOptionIds: correct } });
  } else {
    const n = await prisma.assessmentQuestion.count({ where: { moduleId: m.id } });
    if (n >= 100) return { ok: false, message: "An assessment can have 100 questions." };
    await prisma.assessmentQuestion.create({ data: { moduleId: m.id, type: q.type, prompt: q.prompt, options: q.options, correctOptionIds: correct, displayOrder: n } });
  }
  await touch(m.programId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "AssessmentQuestion", entityId: id || m.id, summary: `${id ? "Edited" : "Added"} a question in ${m.title}` });
  return done(learnPaths(m.programId), id ? "Question saved." : "Question added.");
}

export async function questionOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const q = await prisma.assessmentQuestion.findFirst({ where: { id: text(formData, "questionId"), module: { program: { tenantId: viewer.tenantId, format: "COURSE" } } }, include: { module: true } });
  if (!q) return { ok: false, message: "Question not found." };
  const op = text(formData, "op");
  if (op === "delete") {
    await prisma.assessmentQuestion.delete({ where: { id: q.id } });
  } else if (op === "duplicate") {
    const n = await prisma.assessmentQuestion.count({ where: { moduleId: q.moduleId } });
    await prisma.assessmentQuestion.create({ data: { moduleId: q.moduleId, type: q.type, prompt: `${q.prompt} (copy)`.slice(0, 1000), options: q.options as never, correctOptionIds: q.correctOptionIds as never, difficulty: q.difficulty, displayOrder: n } });
  } else return { ok: false, message: "Unknown action." };
  await touch(q.module.programId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: op === "delete" ? "DELETE" : "CREATE", entityType: "AssessmentQuestion", entityId: q.id, summary: `${op === "delete" ? "Deleted" : "Duplicated"} a question in ${q.module.title}` });
  return done(learnPaths(q.module.programId), op === "delete" ? "Question deleted." : "Question duplicated.");
}

export async function bulkUploadQuestionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const m = await assessmentOf(viewer, text(formData, "moduleId"));
  if (!m) return { ok: false, message: "Assessment not found." };
  const file = formData.get("file");
  if (!file || typeof file === "string" || file.size === 0) return { ok: false, message: "Choose a CSV file." };
  if (file.size > 512 * 1024) return { ok: false, message: "Keep the CSV under 512 KB." };
  const { questions, errors } = parseQuestionCsv(await file.text());
  if (questions.length === 0) return { ok: false, message: errors.length ? `Nothing imported. ${errors.slice(0, 3).join(" ")}` : "The file had no questions." };
  const n = await prisma.assessmentQuestion.count({ where: { moduleId: m.id } });
  if (n + questions.length > 100) return { ok: false, message: "An assessment can have 100 questions." };
  await prisma.assessmentQuestion.createMany({ data: questions.map((q, k) => ({ moduleId: m.id, type: q.type, prompt: q.prompt, options: q.options, correctOptionIds: q.correctOptionIds, source: "BULK", displayOrder: n + k })) });
  await touch(m.programId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "AssessmentQuestion", entityId: m.id, summary: `Bulk-uploaded ${questions.length} questions to ${m.title}` });
  return done(learnPaths(m.programId), `${questions.length} question(s) imported${errors.length ? `; ${errors.length} line(s) skipped: ${errors.slice(0, 2).join(" ")}` : "."}`);
}

/**
 * "Generate questions": a preview only, nothing saved. Sent: the context the
 * builder typed, the question type, difficulty and count, and the course's
 * own text — its title, description, section and module titles and page
 * content (capped). The answer key comes back for the builder to check.
 */
export async function generateQuestionsAction(input: { moduleId: string; context: string; type: string; difficulty: string; count: number }): Promise<{ ok: boolean; message?: string; questions?: QuestionInput[]; remaining?: number }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  if (!aiEnabled()) return { ok: false, message: AI_UNAVAILABLE };
  const m = await assessmentOf(viewer, String(input.moduleId ?? ""));
  if (!m) return { ok: false, message: "Assessment not found." };
  const remaining = await aiRemaining(viewer, "ASSESSMENT_QUESTIONS", m.id);
  if (remaining <= 0) return { ok: false, message: "You have used all three AI generations for this assessment today.", remaining: 0 };
  const type = (QTYPES as readonly string[]).includes(String(input.type)) ? input.type as QuestionKind : "SINGLE_CHOICE";
  const difficulty = ["EASY", "MEDIUM", "HARD"].includes(String(input.difficulty)) ? String(input.difficulty) : "MEDIUM";
  const count = Math.min(10, Math.max(1, Math.round(Number(input.count) || 5)));
  const context = String(input.context ?? "").trim().slice(0, 500) || m.title;
  const [sections, modules] = await Promise.all([
    prisma.courseSection.findMany({ where: { programId: m.programId }, orderBy: { displayOrder: "asc" }, select: { title: true } }),
    prisma.courseModule.findMany({ where: { programId: m.programId }, orderBy: { displayOrder: "asc" }, select: { title: true, type: true, body: true } }),
  ]);
  let budget = 8000;
  const pages = modules.filter((x) => x.type === "PAGE" && x.body).map((x) => {
    const t = x.body!.replace(/\s+/g, " ").slice(0, Math.max(0, budget));
    budget -= t.length;
    return t ? `## ${x.title}\n${t}` : "";
  }).filter(Boolean);
  const prompt = [
    `Context: ${context}`,
    `Question type: ${type.replace(/_/g, " ").toLowerCase()}`,
    `Difficulty: ${difficulty.toLowerCase()}`,
    `Number of questions: ${count}`,
    `Course: ${m.program.title}`,
    m.program.description ? `Course description: ${m.program.description}` : "",
    sections.length ? `Sections: ${sections.map((s) => s.title).join("; ")}` : "",
    `Modules: ${modules.map((x) => x.title).join("; ")}`,
    pages.length ? `Course content:\n${pages.join("\n\n")}` : "",
  ].filter(Boolean).join("\n");
  const shape = type === "TRUE_FALSE"
    ? "{\"prompt\": string (a statement), \"correct\": [1] for True or [2] for False}"
    : type === "MULTIPLE_CHOICE"
      ? "{\"prompt\": string, \"options\": string[4], \"correct\": number[] (1-based indexes of every correct option, at least one)}"
      : "{\"prompt\": string, \"options\": string[4], \"correct\": [number] (the 1-based index of the one correct option)}";
  const r = await aiForViewer(viewer, { feature: "ASSESSMENT_QUESTIONS", subjectId: m.id, inputChars: prompt.length }, () => aiJson({
    system: `You write assessment questions for an internal company course, testing what the course teaches. Questions must be unambiguous with exactly the stated correct answers; keep each question under 250 characters and each option under 120. Return a JSON array of ${count} objects shaped ${shape}.`,
    prompt, maxTokens: 3000, validate: (v) => parseGeneratedQuestions(v, type, count),
  }));
  if (!r.ok) return { ok: false, message: r.reason, remaining };
  return { ok: true, questions: r.value, remaining: remaining - 1 };
}

/** "Import Questions": what came back from the preview, checked again on the way in. */
export async function importQuestionsAction(input: { moduleId: string; questions: QuestionInput[]; difficulty?: string }): Promise<{ ok: boolean; message: string }> {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const m = await assessmentOf(viewer, String(input.moduleId ?? ""));
  if (!m) return { ok: false, message: "Assessment not found." };
  const list = (Array.isArray(input.questions) ? input.questions : []).slice(0, 10).map((q) => ({
    type: (QTYPES as readonly string[]).includes(String(q?.type)) ? q.type : "SINGLE_CHOICE" as QuestionKind,
    prompt: String(q?.prompt ?? "").trim().slice(0, 1000),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o, k) => ({ id: `o${k + 1}`, text: String(o?.text ?? "").trim().slice(0, 300), was: String(o?.id ?? "") })),
    correct: (Array.isArray(q?.correctOptionIds) ? q.correctOptionIds : []).map(String),
  })).map((q) => ({ type: q.type, prompt: q.prompt, options: q.options.map(({ id, text: t }) => ({ id, text: t })), correctOptionIds: q.options.filter((o) => q.correct.includes(o.was)).map((o) => o.id) }));
  if (list.length === 0) return { ok: false, message: "Nothing to import." };
  for (const q of list) {
    const problem = validateQuestion(q);
    if (problem) return { ok: false, message: `A question could not be imported: ${problem}` };
  }
  const n = await prisma.assessmentQuestion.count({ where: { moduleId: m.id } });
  if (n + list.length > 100) return { ok: false, message: "An assessment can have 100 questions." };
  const difficulty = ["EASY", "MEDIUM", "HARD"].includes(String(input.difficulty)) ? String(input.difficulty) : null;
  await prisma.assessmentQuestion.createMany({ data: list.map((q, k) => ({ moduleId: m.id, type: q.type, prompt: q.prompt, options: q.options, correctOptionIds: q.correctOptionIds, difficulty, source: "AI", displayOrder: n + k })) });
  await touch(m.programId);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "AssessmentQuestion", entityId: m.id, summary: `Imported ${list.length} AI-generated questions into ${m.title}` });
  safeRevalidate(...learnPaths(m.programId));
  return { ok: true, message: `${list.length} question(s) imported.` };
}

// ---------------------------------------------------------------------------
//  Learners
// ---------------------------------------------------------------------------

/** Assign a course to people. Course builders and those who manage enrolment may. */
export async function assignCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.TRAINING_MANAGE) && !can(viewer, P.TRAINING_ENROL)) return { ok: false, message: "You cannot assign courses." };
  const c = await course(viewer, text(formData, "courseId"));
  if (!c) return { ok: false, message: "Course not found." };
  if (c.courseState !== "PUBLISHED") return { ok: false, message: "Publish the course before assigning it." };
  const ids = [...new Set(formData.getAll("employeeIds").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, message: "Choose at least one person." };
  const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids }, status: { notIn: ["EXITED"] } }, select: { id: true, userId: true } });
  if (people.length !== ids.length) return { ok: false, message: "Someone you chose was not found." };
  const r = await prisma.trainingEnrolment.createMany({ data: people.map((p) => ({ programId: c.id, employeeId: p.id, assignedBy: viewer.employee?.id ?? null })), skipDuplicates: true });
  await notify({ tenantId: viewer.tenantId, userIds: people.map((p) => p.userId), kind: "TRAINING", title: `Course assigned: ${c.title}`, link: `/learn/courses/${c.id}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "TrainingEnrolment", entityId: c.id, summary: `Assigned ${c.title} to ${r.count} people` });
  return done(learnPaths(c.id), r.count ? `Assigned to ${r.count} ${r.count === 1 ? "person" : "people"}.` : "Everyone chosen was already enrolled.");
}

export async function selfEnrolAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  if (!me) return { ok: false, message: "This login is not linked to an employee." };
  const c = await course(viewer, text(formData, "courseId"));
  if (!c || c.courseState !== "PUBLISHED") return { ok: false, message: "Course not found." };
  if (!c.selfEnrol) return { ok: false, message: "This course is assigned by HR rather than self-enrolled." };
  const existing = await prisma.trainingEnrolment.findUnique({ where: { programId_employeeId: { programId: c.id, employeeId: me } } });
  if (existing && existing.status !== "WITHDRAWN") return { ok: false, message: "You are already enrolled." };
  const e = existing
    ? await prisma.trainingEnrolment.update({ where: { id: existing.id }, data: { status: "ASSIGNED", assignedAt: new Date(), assignedBy: me } })
    : await prisma.trainingEnrolment.create({ data: { programId: c.id, employeeId: me, assignedBy: me } });
  await recomputeEnrolment(e.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "TrainingEnrolment", entityId: e.id, summary: `Enrolled in ${c.title}` });
  return done(learnPaths(c.id), "You are enrolled. Start whenever you are ready.");
}

async function myEnrolmentFor(viewer: Viewer, moduleId: string) {
  const me = viewer.employee?.id;
  if (!me) return null;
  const m = await prisma.courseModule.findFirst({ where: { id: moduleId, program: { tenantId: viewer.tenantId, format: "COURSE", courseState: "PUBLISHED" } } });
  if (!m) return null;
  const e = await prisma.trainingEnrolment.findUnique({ where: { programId_employeeId: { programId: m.programId, employeeId: me } } });
  return e && e.status !== "WITHDRAWN" ? { m, e } : null;
}

export async function completeModuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await myEnrolmentFor(viewer, text(formData, "moduleId"));
  if (!r) return { ok: false, message: "Enrol in the course first." };
  if (r.m.type === "ASSESSMENT") return { ok: false, message: "An assessment is completed by passing it." };
  const res = await completeModule(r.e.id, r.m.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TrainingEnrolment", entityId: r.e.id, summary: `Completed module ${r.m.title} (${res.progress}%)` });
  return done(learnPaths(r.m.programId), res.completed ? "Course completed — well done." : "Marked as complete.");
}

export async function submitAssessmentAction(input: { moduleId: string; answers: Record<string, string[]> }): Promise<{ ok: boolean; message: string; correct?: number; total?: number; percent?: number; passed?: boolean; passPercent?: number; completed?: boolean }> {
  const viewer = await requireViewer();
  const r = await myEnrolmentFor(viewer, String(input.moduleId ?? ""));
  if (!r) return { ok: false, message: "Enrol in the course first." };
  if (r.m.type !== "ASSESSMENT") return { ok: false, message: "That is not an assessment." };
  const recent = await prisma.assessmentAttempt.count({ where: { enrolmentId: r.e.id, moduleId: r.m.id, submittedAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (recent >= 10) return { ok: false, message: "That is ten attempts in an hour — take a break and review the course first." };
  const answers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(input.answers ?? {})) if (Array.isArray(v)) answers[String(k)] = v.map(String).slice(0, 6);
  const res = await submitAttempt(r.e.id, r.m.id, answers);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "AssessmentAttempt", entityId: r.e.id, summary: `Attempted ${r.m.title}: ${res.percent}% (${res.passed ? "passed" : "not passed"})` });
  safeRevalidate(...learnPaths(r.m.programId));
  return {
    ok: true, message: res.passed ? `Passed with ${res.percent}%.` : `${res.percent}% — the pass mark is ${res.passPercent}%. Review and try again.`,
    correct: res.correct, total: res.total, percent: res.percent, passed: res.passed, passPercent: res.passPercent, completed: res.completed,
  };
}
