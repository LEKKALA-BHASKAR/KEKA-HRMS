"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { completeLesson, attemptQuiz, enrolEmployees, enrolEveryone, refreshEnrolment } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zBool, zDate, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

async function courseOf(viewer: Viewer, courseId: string) {
  return prisma.course.findFirst({ where: { id: courseId, tenantId: viewer.tenantId }, include: { lessons: { orderBy: { sequence: "asc" }, include: { _count: { select: { questions: true } } } } } });
}

// ---------------------------------------------------------------------------
//  Authoring
// ---------------------------------------------------------------------------

const courseSchema = z.object({
  id: zOptionalId(),
  title: zName(160),
  summary: zOptional(1000),
  category: zName(60),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
  isMandatory: zBool(),
  dueInDays: zNumber({ min: 1, max: 365 }),
  passPercent: zNumber({ min: 0, max: 100 }),
  skillId: zOptionalId(),
  skillLevel: zNumber({ min: 0, max: 10 }),
  coverColour: zOptional(20),
});

export async function saveCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const parsed = parseForm(courseSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  if (d.skillId && !(await prisma.skill.count({ where: { id: d.skillId, tenantId: viewer.tenantId } }))) return { ok: false, message: "That skill was not found.", values };
  const data = { ...d, passPercent: d.passPercent ?? 70, skillLevel: d.skillLevel ?? 1, coverColour: d.coverColour ?? "#3b6fe0" };
  try {
    if (id) {
      const c = await courseOf(viewer, id);
      if (!c) return { ok: false, message: "Course not found." };
      await prisma.course.update({ where: { id }, data });
      return done(["/learn", `/learn/courses/${id}`], "Saved.");
    }
    const c = await prisma.course.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "Course", entityId: c.id, summary: `Created course "${c.title}"` });
    return { ...done(["/learn"], "Course created — add lessons, then publish."), values: { courseId: c.id } };
  } catch (err) {
    return toErrorState(err, values);
  }
}

const lessonSchema = z.object({
  courseId: z.string().min(1),
  title: zName(160),
  kind: z.enum(["ARTICLE", "VIDEO", "DOCUMENT", "QUIZ"]),
  body: zOptional(20000),
  url: zOptional(500),
  durationMinutes: zNumber({ min: 1, max: 600 }),
});

export async function addLessonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const parsed = parseForm(lessonSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const c = await courseOf(viewer, d.courseId);
  if (!c) return { ok: false, message: "Course not found." };
  if (c.status === "ARCHIVED") return { ok: false, message: "An archived course cannot be changed." };
  if ((d.kind === "VIDEO" || d.kind === "DOCUMENT") && !d.url) return { ok: false, message: "Give the link to the video or document.", errors: { url: "Required" } };
  if (d.url && !/^https?:\/\//i.test(d.url) && !d.url.startsWith("/")) return { ok: false, message: "Links must start with http:// or https://", errors: { url: "Use a full link" } };
  if (d.kind === "ARTICLE" && !d.body) return { ok: false, message: "An article needs some text.", errors: { body: "Required" } };
  await prisma.courseLesson.create({
    data: { courseId: c.id, sequence: (c.lessons.at(-1)?.sequence ?? 0) + 1, title: d.title, kind: d.kind, body: d.body, url: d.url, durationMinutes: d.durationMinutes ?? 5 },
  });
  // New material makes completed enrolments incomplete again — refresh them.
  if (c.status === "PUBLISHED") {
    const enrolments = await prisma.courseEnrolment.findMany({ where: { courseId: c.id }, select: { id: true } });
    for (const e of enrolments) await refreshEnrolment(e.id);
  }
  return done([`/learn/courses/${c.id}`], "Lesson added.");
}

export async function removeLessonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const lessonId = String(formData.get("lessonId"));
  const lesson = await prisma.courseLesson.findFirst({ where: { id: lessonId, course: { tenantId: viewer.tenantId } }, include: { course: true, _count: { select: { progress: true } } } });
  if (!lesson) return { ok: false, message: "Lesson not found." };
  if (lesson.course.status !== "DRAFT" && lesson._count.progress > 0) return { ok: false, message: "Learners have already worked through this lesson; archive the course and create a new version instead." };
  await prisma.$transaction(async (tx) => {
    await tx.courseLesson.delete({ where: { id: lesson.id } });
    const rest = await tx.courseLesson.findMany({ where: { courseId: lesson.courseId }, orderBy: { sequence: "asc" } });
    for (const [i, r] of rest.entries()) await tx.courseLesson.update({ where: { id: r.id }, data: { sequence: -(i + 1) } });
    for (const [i, r] of rest.entries()) await tx.courseLesson.update({ where: { id: r.id }, data: { sequence: i + 1 } });
  });
  return done([`/learn/courses/${lesson.courseId}`], "Lesson removed.");
}

const quizQuestionSchema = z.object({
  lessonId: z.string().min(1),
  prompt: zName(500),
  options: zName(2000),
  correct: zNumber({ min: 1, max: 10, required: true }),
});

export async function addQuizQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const parsed = parseForm(quizQuestionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const lesson = await prisma.courseLesson.findFirst({ where: { id: d.lessonId, kind: "QUIZ", course: { tenantId: viewer.tenantId } }, include: { questions: { orderBy: { sequence: "asc" } } } });
  if (!lesson) return { ok: false, message: "Quiz not found." };
  const options = d.options.split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) return { ok: false, message: "Give at least two options, one per line.", errors: { options: "At least two" } };
  const correct = (d.correct as number) - 1;
  if (correct >= options.length) return { ok: false, message: `The correct option must be between 1 and ${options.length}.`, errors: { correct: "Out of range" } };
  await prisma.quizQuestion.create({ data: { lessonId: lesson.id, sequence: (lesson.questions.at(-1)?.sequence ?? 0) + 1, prompt: d.prompt, options, correctIndex: correct } });
  return done([`/learn/courses/${lesson.courseId}`], "Question added.");
}

export async function courseOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const c = await courseOf(viewer, String(formData.get("courseId")));
  if (!c) return { ok: false, message: "Course not found." };
  const op = String(formData.get("op"));
  if (op === "publish") {
    if (c.status === "PUBLISHED") return { ok: false, message: "Already published." };
    if (c.lessons.length === 0) return { ok: false, message: "Add at least one lesson before publishing." };
    const emptyQuiz = c.lessons.find((l) => l.kind === "QUIZ" && l._count.questions === 0);
    if (emptyQuiz) return { ok: false, message: `The quiz "${emptyQuiz.title}" has no questions.` };
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED" } });
    const enrolled = c.isMandatory ? (await enrolEveryone(viewer.tenantId, c.id, viewer.employee?.id ?? null)).created : 0;
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "Course", entityId: c.id, summary: `Published "${c.title}"${enrolled ? `, enrolling ${enrolled}` : ""}` });
    return done(["/learn", `/learn/courses/${c.id}`], c.isMandatory ? `Published and assigned to ${enrolled} people.` : "Published to the catalogue.");
  }
  if (op === "archive") {
    await prisma.course.update({ where: { id: c.id }, data: { status: "ARCHIVED" } });
    return done(["/learn", `/learn/courses/${c.id}`], "Archived. Completion records are kept.");
  }
  return { ok: false, message: "Unknown operation." };
}

// ---------------------------------------------------------------------------
//  Assigning
// ---------------------------------------------------------------------------

export async function assignCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_ASSIGN);
  const courseId = String(formData.get("courseId"));
  const employeeIds = formList(formData, "employeeIds");
  const dueRaw = String(formData.get("dueDate") ?? "");
  const parsedDue = zDate().safeParse(dueRaw);
  const dueDate = parsedDue.success ? parsedDue.data : null;
  if (employeeIds.length === 0) return { ok: false, message: "Choose at least one person." };
  const c = await prisma.course.findFirst({ where: { id: courseId, tenantId: viewer.tenantId } });
  if (!c) return { ok: false, message: "Course not found." };
  if (c.status !== "PUBLISHED") return { ok: false, message: "Publish the course before assigning it." };
  if (dueDate && dueDate.getTime() < Date.now() - 86_400_000) return { ok: false, message: "The due date has passed.", errors: { dueDate: "In the past" } };
  // A manager's implicit right covers their own people; HR's covers their scope.
  const targets = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  if (targets.length !== new Set(employeeIds).size) return { ok: false, message: "A selected employee was not found." };
  const outside = targets.filter((t) => !canAccessEmployee(viewer, t, P.COURSE_ASSIGN));
  if (outside.length) return { ok: false, message: `You can assign courses only to people in your scope (${outside.length} selected are not).` };
  const r = await enrolEmployees({ tenantId: viewer.tenantId, courseId, employeeIds, assignedBy: viewer.employee?.id ?? null, dueDate });
  return done(["/learn", `/learn/courses/${courseId}`], r.created
    ? `Assigned to ${r.created} ${r.created === 1 ? "person" : "people"}${r.skipped ? `; ${r.skipped} already enrolled` : ""}.`
    : "Everyone selected is already enrolled.");
}

// ---------------------------------------------------------------------------
//  Learning
// ---------------------------------------------------------------------------

export async function enrolSelfAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  if (!viewer.employee) return { ok: false, message: "Only employees can enrol." };
  const courseId = String(formData.get("courseId"));
  const c = await prisma.course.findFirst({ where: { id: courseId, tenantId: viewer.tenantId, status: "PUBLISHED" } });
  if (!c) return { ok: false, message: "Course not found." };
  await enrolEmployees({ tenantId: viewer.tenantId, courseId, employeeIds: [viewer.employee.id], source: "SELF", notifyThem: false });
  return done(["/learn", `/learn/courses/${courseId}`], "Enrolled — start with the first lesson.");
}

async function myEnrolment(viewer: Viewer, enrolmentId: string) {
  if (!viewer.employee) return null;
  return prisma.courseEnrolment.findFirst({ where: { id: enrolmentId, tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
}

export async function completeLessonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await myEnrolment(viewer, String(formData.get("enrolmentId")));
  if (!e) return { ok: false, message: "You are not enrolled in this course." };
  const r = await completeLesson(e.id, String(formData.get("lessonId")));
  return r.ok ? done(["/learn", `/learn/courses/${e.courseId}`], r.message) : { ok: false, message: r.message };
}

export async function submitQuizAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await myEnrolment(viewer, String(formData.get("enrolmentId")));
  if (!e) return { ok: false, message: "You are not enrolled in this course." };
  const lessonId = String(formData.get("lessonId"));
  const picked: Record<string, number> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("qq_")) picked[k.slice(3)] = Number(v);
  }
  const r = await attemptQuiz(e.id, lessonId, picked);
  if (!r.ok) return { ok: false, message: r.message };
  // The marked answers come back so the learner can see what they got wrong.
  const values: Record<string, string> = Object.fromEntries((r.results ?? []).map((x) => [`r_${x.questionId}`, x.correct ? "1" : "0"]));
  return { ...done(["/learn", `/learn/courses/${e.courseId}`], r.message), ok: !!r.passed, values };
}

/** HR can reset an enrolment that was assigned by mistake. */
export async function removeEnrolmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_ASSIGN);
  const e = await prisma.courseEnrolment.findFirst({
    where: { id: String(formData.get("enrolmentId")), tenantId: viewer.tenantId },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!e) return { ok: false, message: "Enrolment not found." };
  if (!canAccessEmployee(viewer, e.employee, P.COURSE_ASSIGN)) return { ok: false, message: "That person is outside your scope." };
  if (e.status === "COMPLETED" && !can(viewer, P.COURSE_MANAGE)) return { ok: false, message: "A completed course stays on the record." };
  await prisma.courseEnrolment.delete({ where: { id: e.id } });
  return done([`/learn/courses/${e.courseId}`], "Enrolment removed.");
}
