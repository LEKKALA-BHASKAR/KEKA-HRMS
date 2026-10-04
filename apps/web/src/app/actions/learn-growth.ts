"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  enrolEmployees, enrolEveryone, notify, reviewStep, refreshPathAssignments, sessionSeat, sessionOpen,
  parseQuestionCsv, toQuizQuestion, refreshEnrolment,
} from "@keka/services";
import { requireAuth, requireViewer, canAny, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, formList, type ActionState } from "@/lib/forms";
import { reaches, unreachable, field, dateField, intField, missingPrerequisite } from "@/lib/growth";

/**
 * Learn, beyond single courses: learning paths (ordered courses assigned as
 * a whole, approved before use), course review before publishing, quiz
 * editing, bulk question upload and attempt limits, enrolment and retake
 * requests decided by the learner's manager, classroom and virtual training
 * sessions with registration, waitlists and attendance, certificates, and
 * maintenance of learning records. Every write is audited.
 */

const P = PERMISSIONS;
const LEARN = ["/learn/my-courses", "/learn/library", "/learn/manage-courses", "/learn/paths", "/learn/sessions", "/learn/approvals", "/learn/reports"];
const NO = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ ok: false, message, ...extra });

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string) {
  await writeAudit(viewer, { module: "SYSTEM", action, entityType, entityId, summary });
}

// ---------------------------------------------------------------------------
//  Learning paths
// ---------------------------------------------------------------------------

async function pathOf(viewer: Viewer, id: string) {
  return prisma.learningPath.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { courses: { orderBy: { sequence: "asc" }, include: { course: { select: { id: true, title: true, status: true } } } } } });
}

export async function savePathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 160);
  const values = { name, description: field(formData, "description"), category: field(formData, "category", 60), jobTitle: field(formData, "jobTitle", 120) };
  if (!name) return NO("Name the learning path.", { errors: { name: "Required" }, values });
  const dueInDays = intField(formData, "dueInDays", 1, 730);
  if (dueInDays === undefined) return NO("Days to finish is a whole number from 1 to 730.", { errors: { dueInDays: "1–730" }, values });
  const data = { name, description: values.description || null, category: values.category || null, jobTitle: values.jobTitle || null, isMandatory: formData.get("isMandatory") === "on", dueInDays };
  const clash = await prisma.learningPath.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: name, mode: "insensitive" }, NOT: id ? { id } : undefined } });
  if (clash) return NO("There is already a path with that name.", { errors: { name: "Duplicate" }, values });
  if (id) {
    const p = await pathOf(viewer, id);
    if (!p) return NO("Learning path not found.");
    if (p.status === "ARCHIVED") return NO("An archived path cannot be changed.");
    await prisma.learningPath.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "LearningPath", id, `Updated learning path "${name}"`);
    return done([...LEARN, `/learn/paths/${id}`], "Saved.");
  }
  const p = await prisma.learningPath.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await audit(viewer, "CREATE", "LearningPath", p.id, `Created learning path "${name}"`);
  return { ...done(LEARN, "Learning path created — add its courses, then submit it for approval."), values: { pathId: p.id } };
}

/** Add, remove or reorder the courses of a path that is still being drafted. */
export async function pathCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const p = await pathOf(viewer, field(formData, "pathId", 40));
  if (!p) return NO("Learning path not found.");
  if (p.status !== "DRAFT" && p.status !== "REJECTED") return NO("Reopen the path to change its courses.");
  const op = field(formData, "op", 20);
  const courseId = field(formData, "courseId", 40);
  if (op === "add") {
    const c = await prisma.course.findFirst({ where: { id: courseId, tenantId: viewer.tenantId } });
    if (!c) return NO("Course not found.");
    if (c.status !== "PUBLISHED") return NO("Only published courses can go on a path.");
    if (p.courses.some((x) => x.courseId === courseId)) return NO("That course is already on the path.");
    if (p.courses.length >= 30) return NO("A path can hold 30 courses.");
    await prisma.learningPathCourse.create({ data: { pathId: p.id, courseId, sequence: (p.courses.at(-1)?.sequence ?? 0) + 1, isOptional: formData.get("isOptional") === "on" } });
    await audit(viewer, "UPDATE", "LearningPath", p.id, `Added "${c.title}" to "${p.name}"`);
    return done([`/learn/paths/${p.id}`], `${c.title} added.`);
  }
  const item = p.courses.find((x) => x.courseId === courseId);
  if (!item) return NO("That course is not on the path.");
  if (op === "remove") {
    await prisma.learningPathCourse.delete({ where: { id: item.id } });
    await audit(viewer, "UPDATE", "LearningPath", p.id, `Removed "${item.course.title}" from "${p.name}"`);
    return done([`/learn/paths/${p.id}`], "Removed.");
  }
  if (op === "up" || op === "down") {
    const list = [...p.courses];
    const i = list.findIndex((x) => x.id === item.id), j = op === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return NO("It is already at the edge.");
    [list[i], list[j]] = [list[j], list[i]];
    await prisma.$transaction([
      ...list.map((x, k) => prisma.learningPathCourse.update({ where: { id: x.id }, data: { sequence: -(k + 1) } })),
      ...list.map((x, k) => prisma.learningPathCourse.update({ where: { id: x.id }, data: { sequence: k + 1 } })),
    ]);
    await audit(viewer, "UPDATE", "LearningPath", p.id, `Moved "${item.course.title}" ${op} in "${p.name}"`);
    return done([`/learn/paths/${p.id}`], "Moved.");
  }
  return NO("Unknown action.");
}

/** Submit, withdraw, approve, reject, reopen or archive a path. */
export async function pathReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const p = await pathOf(viewer, field(formData, "pathId", 40));
  if (!p) return NO("Learning path not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  if (op === "submit" && p.courses.filter((c) => !c.isOptional).length === 0) return NO("Add at least one required course before submitting.");
  if (op === "submit" && p.courses.some((c) => c.course.status !== "PUBLISHED")) return NO("Every course on the path must be published.");
  const step = reviewStep(p.status, op, { actor: viewer.user.id, submittedBy: p.submittedBy, note });
  if (!step.ok) return NO(step.message);
  const now = new Date();
  await prisma.learningPath.update({
    where: { id: p.id },
    data: {
      status: step.next,
      ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: now, decisionNote: null } : {}),
      ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: now, decisionNote: note || null } : {}),
    },
  });
  if (op === "submit") {
    const reviewers = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { not: viewer.user.id }, roleAssignments: { some: { role: { permissions: { some: { permission: P.COURSE_MANAGE } } } } } }, select: { id: true } });
    await notify({ tenantId: viewer.tenantId, userIds: reviewers.map((r) => r.id), kind: "LEARNING", title: `Learning path to review: ${p.name}`, link: `/learn/paths/${p.id}` });
  }
  if ((op === "approve" || op === "reject") && p.submittedBy) {
    await notify({ tenantId: viewer.tenantId, userIds: [p.submittedBy], kind: "LEARNING", title: `Learning path ${op === "approve" ? "approved" : "sent back"}: ${p.name}`, body: note || null, link: `/learn/paths/${p.id}` });
  }
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "LearningPath", p.id, `${op} learning path "${p.name}"${note ? `: ${note}` : ""}`);
  const msg: Record<string, string> = { submit: "Submitted for approval.", withdraw: "Withdrawn to draft.", approve: "Approved — it can now be assigned.", reject: "Sent back with your note.", reopen: "Reopened for changes.", archive: "Archived." };
  return done([...LEARN, `/learn/paths/${p.id}`], msg[op] ?? "Done.");
}

export async function deletePathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const p = await prisma.learningPath.findFirst({ where: { id: field(formData, "pathId", 40), tenantId: viewer.tenantId }, include: { _count: { select: { assignments: true } } } });
  if (!p) return NO("Learning path not found.");
  if (p._count.assignments > 0) return NO("People are on this path; archive it instead.");
  await prisma.learningPath.delete({ where: { id: p.id } });
  await audit(viewer, "DELETE", "LearningPath", p.id, `Deleted learning path "${p.name}"`);
  return done(LEARN, "Deleted.");
}

async function assignPath(viewer: Viewer, pathId: string, employeeIds: string[], dueDate: Date | null, self: boolean) {
  const p = await pathOf(viewer, pathId);
  if (!p) return NO("Learning path not found.");
  if (p.status !== "APPROVED") return NO("Only an approved path can be assigned.");
  const due = dueDate ?? (p.dueInDays ? new Date(Date.now() + p.dueInDays * 86_400_000) : null);
  const existing = new Set((await prisma.learningPathAssignment.findMany({ where: { pathId: p.id, employeeId: { in: employeeIds } }, select: { employeeId: true } })).map((a) => a.employeeId));
  const fresh = employeeIds.filter((id) => !existing.has(id));
  if (fresh.length === 0) return NO(self ? "You are already on this path." : "Everyone chosen is already on this path.");
  await prisma.learningPathAssignment.createMany({ data: fresh.map((employeeId) => ({ tenantId: viewer.tenantId, pathId: p.id, employeeId, assignedBy: viewer.employee?.id ?? viewer.user.id, dueDate: due })), skipDuplicates: true });
  for (const item of p.courses) {
    await enrolEmployees({ tenantId: viewer.tenantId, courseId: item.courseId, employeeIds: fresh, assignedBy: viewer.employee?.id ?? null, dueDate: due, source: self ? "SELF" : "ASSIGNED", notifyThem: false });
  }
  for (const id of fresh) await refreshPathAssignments(id, p.id);
  if (!self) {
    const users = await prisma.employee.findMany({ where: { id: { in: fresh } }, select: { userId: true } });
    await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "LEARNING", title: `Learning path assigned: ${p.name}`, body: `${p.courses.length} courses${due ? `, due ${due.toISOString().slice(0, 10)}` : ""}.`, link: "/learn/my-courses" });
  }
  await audit(viewer, "CREATE", "LearningPathAssignment", p.id, `${self ? "Joined" : `Assigned ${fresh.length} to`} learning path "${p.name}"`);
  return done([...LEARN, `/learn/paths/${p.id}`], self ? "You are on the path — its courses are in My Courses." : `Assigned to ${fresh.length} ${fresh.length === 1 ? "person" : "people"}; their courses are enrolled.`);
}

export async function assignPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_ASSIGN);
  const ids = [...new Set(formList(formData, "employeeIds"))];
  if (ids.length === 0) return NO("Choose at least one person.");
  const outside = await unreachable(viewer, ids, P.COURSE_ASSIGN);
  if (outside.length) return NO(`You can assign paths only to people in your scope (${outside.length} chosen are not).`);
  return assignPath(viewer, field(formData, "pathId", 40), ids, dateField(formData, "dueDate"), false);
}

export async function joinPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  if (!viewer.employee) return NO("Only employees can join a path.");
  const p = await prisma.learningPath.findFirst({ where: { id: field(formData, "pathId", 40), tenantId: viewer.tenantId }, include: { courses: { include: { course: true } } } });
  if (!p) return NO("Learning path not found.");
  if (p.courses.some((c) => c.course.requiresApproval)) return NO("A course on this path needs approval — ask your manager to assign the path.");
  return assignPath(viewer, p.id, [viewer.employee.id], null, true);
}

// ---------------------------------------------------------------------------
//  Course review before publishing
// ---------------------------------------------------------------------------

export async function courseReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const c = await prisma.course.findFirst({ where: { id: field(formData, "courseId", 40), tenantId: viewer.tenantId }, include: { lessons: { include: { _count: { select: { questions: true } } } } } });
  if (!c) return NO("Course not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  const paths = [...LEARN, `/learn/courses/${c.id}`];
  if (op === "submit") {
    if (c.status !== "DRAFT") return NO("Only a draft course can be submitted for review.");
    if (c.lessons.length === 0) return NO("Add at least one lesson first.");
    const empty = c.lessons.find((l) => l.kind === "QUIZ" && l._count.questions === 0);
    if (empty) return NO(`The quiz "${empty.title}" has no questions.`);
    await prisma.course.update({ where: { id: c.id }, data: { status: "IN_REVIEW", submittedBy: viewer.user.id, submittedAt: new Date(), reviewNote: null } });
    const reviewers = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { not: viewer.user.id }, roleAssignments: { some: { role: { permissions: { some: { permission: P.COURSE_MANAGE } } } } } }, select: { id: true } });
    await notify({ tenantId: viewer.tenantId, userIds: reviewers.map((r) => r.id), kind: "LEARNING", title: `Course to review: ${c.title}`, link: "/learn/approvals" });
    await audit(viewer, "UPDATE", "Course", c.id, `Submitted "${c.title}" for review`);
    return done(paths, "Submitted — another course admin will review and publish it.");
  }
  if (op === "approve" || op === "reject") {
    if (c.status !== "IN_REVIEW") return NO("This course is not waiting for review.");
    if (c.submittedBy === viewer.user.id) return NO("You submitted this course — someone else has to review it.");
    if (op === "reject") {
      if (!note) return NO("Say what needs to change.", { errors: { note: "Required" } });
      await prisma.course.update({ where: { id: c.id }, data: { status: "DRAFT", reviewNote: note } });
      await notify({ tenantId: viewer.tenantId, userIds: [c.submittedBy], kind: "LEARNING", title: `Course sent back: ${c.title}`, body: note, link: `/learn/courses/${c.id}?view=admin` });
      await audit(viewer, "REJECT", "Course", c.id, `Sent "${c.title}" back: ${note}`);
      return done(paths, "Sent back to the author.");
    }
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", reviewNote: note || null } });
    const enrolled = c.isMandatory ? (await enrolEveryone(viewer.tenantId, c.id, viewer.employee?.id ?? null)).created : 0;
    await notify({ tenantId: viewer.tenantId, userIds: [c.submittedBy], kind: "LEARNING", title: `Course published: ${c.title}`, link: `/learn/courses/${c.id}` });
    await audit(viewer, "APPROVE", "Course", c.id, `Approved and published "${c.title}"${enrolled ? `, enrolling ${enrolled}` : ""}`);
    return done(paths, c.isMandatory ? `Published and assigned to ${enrolled} people.` : "Approved and published.");
  }
  if (op === "revise") {
    // A new version: the published course goes back to draft for changes; progress is kept.
    if (c.status !== "PUBLISHED") return NO("Only a published course can be revised.");
    await prisma.course.update({ where: { id: c.id }, data: { status: "DRAFT", version: { increment: 1 } } });
    await audit(viewer, "UPDATE", "Course", c.id, `Opened version ${c.version + 1} of "${c.title}" for changes`);
    return done(paths, `Version ${c.version + 1} is open for changes; submit it for review when ready.`);
  }
  return NO("Unknown action.");
}

// ---------------------------------------------------------------------------
//  Quiz questions: edit, delete, bulk upload, attempt limits
// ---------------------------------------------------------------------------

async function quizOf(viewer: Viewer, lessonId: string) {
  return prisma.courseLesson.findFirst({ where: { id: lessonId, kind: "QUIZ", course: { tenantId: viewer.tenantId } }, include: { course: true, questions: { orderBy: { sequence: "asc" } } } });
}

export async function updateQuizQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const q = await prisma.quizQuestion.findFirst({ where: { id: field(formData, "questionId", 40), lesson: { course: { tenantId: viewer.tenantId } } }, include: { lesson: { include: { course: true } } } });
  if (!q) return NO("Question not found.");
  if (q.lesson.course.status === "ARCHIVED") return NO("An archived course cannot be changed.");
  const prompt = field(formData, "prompt", 500);
  const options = field(formData, "options").split("\n").map((s) => s.trim()).filter(Boolean);
  const correct = Number(field(formData, "correct", 4)) - 1;
  if (!prompt) return NO("Type the question.", { errors: { prompt: "Required" } });
  if (options.length < 2) return NO("Give at least two options, one per line.", { errors: { options: "At least two" } });
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return NO(`The correct option must be between 1 and ${options.length}.`, { errors: { correct: "Out of range" } });
  await prisma.quizQuestion.update({ where: { id: q.id }, data: { prompt, options, correctIndex: correct } });
  await audit(viewer, "UPDATE", "QuizQuestion", q.id, `Edited a question in "${q.lesson.title}" (${q.lesson.course.title})`);
  return done([`/learn/courses/${q.lesson.courseId}`, "/learn/manage-courses"], "Question saved.");
}

export async function deleteQuizQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const q = await prisma.quizQuestion.findFirst({ where: { id: field(formData, "questionId", 40), lesson: { course: { tenantId: viewer.tenantId } } }, include: { lesson: { include: { course: true, _count: { select: { questions: true } } } } } });
  if (!q) return NO("Question not found.");
  if (q.lesson.course.status === "PUBLISHED" && q.lesson._count.questions <= 1) return NO("A published quiz needs at least one question.");
  await prisma.$transaction(async (tx) => {
    await tx.quizQuestion.delete({ where: { id: q.id } });
    const rest = await tx.quizQuestion.findMany({ where: { lessonId: q.lessonId }, orderBy: { sequence: "asc" } });
    for (const [i, r] of rest.entries()) await tx.quizQuestion.update({ where: { id: r.id }, data: { sequence: -(i + 1) } });
    for (const [i, r] of rest.entries()) await tx.quizQuestion.update({ where: { id: r.id }, data: { sequence: i + 1 } });
  });
  await audit(viewer, "DELETE", "QuizQuestion", q.id, `Deleted a question from "${q.lesson.title}" (${q.lesson.course.title})`);
  return done([`/learn/courses/${q.lesson.courseId}`, "/learn/manage-courses"], "Question deleted.");
}

/** The question bank: a CSV of questions, the same format as the course builder's bulk upload. */
export async function importQuizQuestionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const lesson = await quizOf(viewer, field(formData, "lessonId", 40));
  if (!lesson) return NO("Quiz not found.");
  if (lesson.course.status === "ARCHIVED") return NO("An archived course cannot be changed.");
  const file = formData.get("file");
  const text = file && typeof file !== "string" && file.size > 0 ? (file.size > 512 * 1024 ? null : await file.text()) : field(formData, "csv", 200_000);
  if (text === null) return NO("Keep the CSV under 512 KB.");
  if (!text) return NO("Choose a CSV file or paste the questions.");
  const { questions, errors } = parseQuestionCsv(text);
  const ready: Array<{ prompt: string; options: string[]; correctIndex: number }> = [];
  for (const q of questions) {
    const r = toQuizQuestion(q);
    if (r.ok) ready.push(r); else errors.push(r.message);
  }
  if (ready.length === 0) return NO(errors.length ? `Nothing imported. ${errors.slice(0, 3).join(" ")}` : "The file had no questions.");
  if (lesson.questions.length + ready.length > 100) return NO("A quiz can have 100 questions.");
  const start = lesson.questions.at(-1)?.sequence ?? 0;
  await prisma.quizQuestion.createMany({ data: ready.map((q, k) => ({ lessonId: lesson.id, sequence: start + k + 1, prompt: q.prompt, options: q.options, correctIndex: q.correctIndex })) });
  await audit(viewer, "CREATE", "QuizQuestion", lesson.id, `Imported ${ready.length} questions into "${lesson.title}" (${lesson.course.title})`);
  return done([`/learn/courses/${lesson.courseId}`, "/learn/manage-courses"], `${ready.length} question(s) imported${errors.length ? `; ${errors.length} skipped: ${errors.slice(0, 2).join(" ")}` : "."}`);
}

export async function setQuizRulesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const lesson = await quizOf(viewer, field(formData, "lessonId", 40));
  if (!lesson) return NO("Quiz not found.");
  const maxAttempts = intField(formData, "maxAttempts", 1, 20);
  if (maxAttempts === undefined) return NO("Attempts is a whole number from 1 to 20, or blank for unlimited.", { errors: { maxAttempts: "1–20" } });
  await prisma.courseLesson.update({ where: { id: lesson.id }, data: { maxAttempts } });
  await audit(viewer, "UPDATE", "CourseLesson", lesson.id, `Set "${lesson.title}" to ${maxAttempts ? `${maxAttempts} attempts` : "unlimited attempts"}`);
  return done([`/learn/courses/${lesson.courseId}`], maxAttempts ? `Learners get ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}; more need an approved retake.` : "Unlimited attempts.");
}

// ---------------------------------------------------------------------------
//  Requests: enrolment approval and quiz retakes
// ---------------------------------------------------------------------------

export async function requestEnrolmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const me = viewer.employee;
  if (!me) return NO("Only employees can request a course.");
  const c = await prisma.course.findFirst({ where: { id: field(formData, "courseId", 40), tenantId: viewer.tenantId, status: "PUBLISHED" } });
  if (!c) return NO("Course not found.");
  if (await prisma.courseEnrolment.count({ where: { courseId: c.id, employeeId: me.id } })) return NO("You are already enrolled.");
  if (await prisma.learningRequest.count({ where: { kind: "ENROLMENT", courseId: c.id, employeeId: me.id, status: "PENDING" } })) return NO("Your request is already waiting for a decision.");
  const missing = await missingPrerequisite(c.prerequisiteCourseId, me.id);
  if (missing) return NO(`Complete "${missing}" first.`);
  const r = await prisma.learningRequest.create({ data: { tenantId: viewer.tenantId, kind: "ENROLMENT", courseId: c.id, employeeId: me.id, reason: field(formData, "reason", 1000) || null } });
  const mgr = await prisma.employee.findUnique({ where: { id: me.id }, select: { reportingManager: { select: { userId: true } } } });
  await notify({ tenantId: viewer.tenantId, userIds: [mgr?.reportingManager?.userId], kind: "LEARNING", title: `${me.displayName} asks to take ${c.title}`, link: "/learn/approvals" });
  await audit(viewer, "CREATE", "LearningRequest", r.id, `Requested enrolment in "${c.title}"`);
  return done(LEARN, "Requested — your manager will decide.");
}

export async function requestRetakeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("Only employees can request a retake.");
  const e = await prisma.courseEnrolment.findFirst({ where: { id: field(formData, "enrolmentId", 40), tenantId: viewer.tenantId, employeeId: me.id }, include: { course: true } });
  if (!e) return NO("You are not enrolled in this course.");
  const lesson = await prisma.courseLesson.findFirst({ where: { id: field(formData, "lessonId", 40), courseId: e.courseId, kind: "QUIZ" } });
  if (!lesson || !lesson.maxAttempts) return NO("This quiz has no attempt limit.");
  if (await prisma.learningRequest.count({ where: { kind: "RETAKE", lessonId: lesson.id, employeeId: me.id, status: "PENDING" } })) return NO("Your retake request is already waiting.");
  const r = await prisma.learningRequest.create({ data: { tenantId: viewer.tenantId, kind: "RETAKE", courseId: e.courseId, lessonId: lesson.id, employeeId: me.id, reason: field(formData, "reason", 1000) || null } });
  const mgr = await prisma.employee.findUnique({ where: { id: me.id }, select: { reportingManager: { select: { userId: true } } } });
  await notify({ tenantId: viewer.tenantId, userIds: [mgr?.reportingManager?.userId], kind: "LEARNING", title: `${me.displayName} asks to retake ${lesson.title}`, link: "/learn/approvals" });
  await audit(viewer, "CREATE", "LearningRequest", r.id, `Requested a retake of "${lesson.title}" (${e.course.title})`);
  return done(LEARN, "Retake requested.");
}

/** The learner's manager (or a course admin in scope) approves or rejects a request. */
export async function decideLearningRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.learningRequest.findFirst({ where: { id: field(formData, "requestId", 40), tenantId: viewer.tenantId }, include: { course: true, employee: { select: { userId: true, displayName: true } } } });
  if (!r) return NO("Request not found.");
  if (r.status !== "PENDING") return NO("This request has already been decided.");
  if (!(await reaches(viewer, r.employeeId, P.COURSE_ASSIGN))) return NO("Only their manager or a learning admin can decide this.");
  const decision = field(formData, "decision", 10);
  const note = field(formData, "note", 1000);
  if (decision !== "approve" && decision !== "reject") return NO("Approve or reject.");
  if (decision === "reject" && !note) return NO("Say why, so they know what to do next.", { errors: { note: "Required" } });
  await prisma.learningRequest.update({ where: { id: r.id }, data: { status: decision === "approve" ? "APPROVED" : "REJECTED", decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } });
  if (decision === "approve" && r.kind === "ENROLMENT") {
    await enrolEmployees({ tenantId: viewer.tenantId, courseId: r.courseId, employeeIds: [r.employeeId], assignedBy: viewer.employee?.id ?? null, source: "ASSIGNED", notifyThem: false });
  }
  await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "LEARNING", title: `${r.kind === "RETAKE" ? "Retake" : "Enrolment"} ${decision === "approve" ? "approved" : "declined"}: ${r.course.title}`, body: note || null, link: `/learn/courses/${r.courseId}` });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "LearningRequest", r.id, `${decision === "approve" ? "Approved" : "Rejected"} ${r.kind.toLowerCase()} request of ${r.employee.displayName} for "${r.course.title}"`);
  return done(LEARN, decision === "approve" ? (r.kind === "ENROLMENT" ? "Approved — they are enrolled." : "Approved — they have one more attempt.") : "Declined.");
}

export async function withdrawLearningRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.learningRequest.findFirst({ where: { id: field(formData, "requestId", 40), tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__" } });
  if (!r) return NO("Request not found.");
  if (r.status !== "PENDING") return NO("It has already been decided.");
  await prisma.learningRequest.update({ where: { id: r.id }, data: { status: "WITHDRAWN" } });
  await audit(viewer, "UPDATE", "LearningRequest", r.id, "Withdrew a learning request");
  return done(LEARN, "Withdrawn.");
}

// ---------------------------------------------------------------------------
//  Learning records and certificates
// ---------------------------------------------------------------------------

/** Change an enrolment's due date, or recompute it after content changed. */
export async function updateEnrolmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_ASSIGN);
  const e = await prisma.courseEnrolment.findFirst({ where: { id: field(formData, "enrolmentId", 40), tenantId: viewer.tenantId }, include: { course: true, employee: { select: { displayName: true } } } });
  if (!e) return NO("Enrolment not found.");
  if (!(await reaches(viewer, e.employeeId, P.COURSE_ASSIGN))) return NO("That person is outside your scope.");
  const op = field(formData, "op", 20) || "due";
  if (op === "refresh") {
    await refreshEnrolment(e.id);
    await audit(viewer, "UPDATE", "CourseEnrolment", e.id, `Recomputed ${e.employee.displayName}'s progress on "${e.course.title}"`);
    return done(LEARN, "Progress recomputed.");
  }
  if (e.status === "COMPLETED") return NO("A completed enrolment keeps its dates.");
  const due = dateField(formData, "dueDate");
  if (field(formData, "dueDate") && !due) return NO("Give a valid date.", { errors: { dueDate: "Invalid" } });
  await prisma.courseEnrolment.update({ where: { id: e.id }, data: { dueDate: due } });
  await audit(viewer, "UPDATE", "CourseEnrolment", e.id, `Set ${e.employee.displayName}'s due date on "${e.course.title}" to ${due ? due.toISOString().slice(0, 10) : "none"}`);
  return done([...LEARN, `/learn/courses/${e.courseId}`], due ? `Due ${due.toISOString().slice(0, 10)}.` : "Due date cleared.");
}

export async function revokeCertificateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COURSE_MANAGE);
  const c = await prisma.learningCertificate.findFirst({ where: { id: field(formData, "certificateId", 40), tenantId: viewer.tenantId } });
  if (!c) return NO("Certificate not found.");
  if (c.revokedAt) return NO("Already revoked.");
  const reason = field(formData, "reason", 500);
  if (!reason) return NO("Say why it is being revoked.", { errors: { reason: "Required" } });
  await prisma.learningCertificate.update({ where: { id: c.id }, data: { revokedAt: new Date(), revokedReason: reason } });
  await audit(viewer, "UPDATE", "LearningCertificate", c.id, `Revoked certificate ${c.number}: ${reason}`);
  return done(LEARN, "Certificate revoked.");
}

// ---------------------------------------------------------------------------
//  Training sessions
// ---------------------------------------------------------------------------

const mayRunSessions = (viewer: Viewer) => canAny(viewer, [P.COURSE_MANAGE, P.TRAINING_MANAGE]);

async function sessionOf(viewer: Viewer, id: string) {
  return prisma.trainingSession.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { registrations: { include: { employee: { select: { userId: true, displayName: true } } }, orderBy: { requestedAt: "asc" } } } });
}

export async function saveSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!mayRunSessions(viewer)) return NO("You cannot schedule training sessions.");
  const id = field(formData, "id", 40);
  const title = field(formData, "title", 160);
  const mode = field(formData, "mode", 20) === "VIRTUAL" ? "VIRTUAL" : "CLASSROOM";
  const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)]));
  if (!title) return NO("Give the session a title.", { errors: { title: "Required" }, values });
  const startsAt = dateField(formData, "startsAt"), endsAt = dateField(formData, "endsAt");
  if (!startsAt || !endsAt) return NO("Give a start and an end.", { errors: { startsAt: "Required" }, values });
  if (endsAt.getTime() <= startsAt.getTime()) return NO("The session must end after it starts.", { errors: { endsAt: "Before the start" }, values });
  const capacity = intField(formData, "capacity", 1, 1000);
  if (capacity === undefined) return NO("Capacity is a whole number from 1 to 1000, or blank.", { errors: { capacity: "1–1000" }, values });
  const meetingUrl = field(formData, "meetingUrl", 500);
  if (mode === "VIRTUAL" && !/^https:\/\//i.test(meetingUrl)) return NO("A virtual session needs an https meeting link.", { errors: { meetingUrl: "https link" }, values });
  const venue = field(formData, "venue", 200);
  if (mode === "CLASSROOM" && !venue) return NO("Where is the classroom?", { errors: { venue: "Required" }, values });
  const courseId = field(formData, "courseId", 40) || null;
  if (courseId && !(await prisma.course.count({ where: { id: courseId, tenantId: viewer.tenantId } }))) return NO("Course not found.", { values });
  const instructorId = field(formData, "instructorId", 40) || null;
  const instructor = instructorId ? await prisma.employee.findFirst({ where: { id: instructorId, tenantId: viewer.tenantId }, select: { displayName: true } }) : null;
  if (instructorId && !instructor) return NO("Instructor not found.", { values });
  const data = {
    title, description: field(formData, "description") || null, mode, venue: venue || null, meetingUrl: meetingUrl || null, courseId,
    instructorId, instructorName: instructor?.displayName ?? (field(formData, "instructorName", 120) || null),
    startsAt, endsAt, capacity, requiresApproval: formData.get("requiresApproval") === "on",
  };
  if (id) {
    const s = await sessionOf(viewer, id);
    if (!s) return NO("Session not found.");
    if (s.status !== "SCHEDULED") return NO("Only a scheduled session can be changed.");
    const seated = s.registrations.filter((r) => r.status === "REGISTERED").length;
    if (capacity && capacity < seated) return NO(`${seated} people are already registered; capacity cannot go below that.`, { errors: { capacity: "Too low" }, values });
    await prisma.trainingSession.update({ where: { id }, data });
    const moved = s.startsAt.getTime() !== startsAt.getTime();
    if (moved) await notify({ tenantId: viewer.tenantId, userIds: s.registrations.filter((r) => r.status === "REGISTERED").map((r) => r.employee.userId), kind: "LEARNING", title: `Session moved: ${title}`, body: `Now ${startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`, link: `/learn/sessions/${id}` });
    await audit(viewer, "UPDATE", "TrainingSession", id, `Updated session "${title}"`);
    return done([...LEARN, `/learn/sessions/${id}`], "Saved.");
  }
  const s = await prisma.trainingSession.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await audit(viewer, "CREATE", "TrainingSession", s.id, `Scheduled session "${title}" on ${startsAt.toISOString().slice(0, 10)}`);
  return { ...done(LEARN, "Session scheduled."), values: { sessionId: s.id } };
}

export async function sessionOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!mayRunSessions(viewer)) return NO("You cannot manage training sessions.");
  const s = await sessionOf(viewer, field(formData, "sessionId", 40));
  if (!s) return NO("Session not found.");
  const op = field(formData, "op", 20);
  if (s.status !== "SCHEDULED") return NO("This session is already closed.");
  if (op === "cancel") {
    await prisma.trainingSession.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
    await notify({ tenantId: viewer.tenantId, userIds: s.registrations.filter((r) => ["REGISTERED", "WAITLISTED", "REQUESTED"].includes(r.status)).map((r) => r.employee.userId), kind: "LEARNING", title: `Session cancelled: ${s.title}`, link: "/learn/sessions" });
    await audit(viewer, "UPDATE", "TrainingSession", s.id, `Cancelled session "${s.title}"`);
    return done([...LEARN, `/learn/sessions/${s.id}`], "Cancelled; registrants have been told.");
  }
  if (op === "complete") {
    if (s.startsAt.getTime() > Date.now()) return NO("The session has not started yet.");
    const unmarked = s.registrations.filter((r) => r.status === "REGISTERED" && !r.attendance).length;
    if (unmarked) return NO(`Mark attendance for everyone first (${unmarked} left).`);
    await prisma.trainingSession.update({ where: { id: s.id }, data: { status: "COMPLETED" } });
    await audit(viewer, "UPDATE", "TrainingSession", s.id, `Completed session "${s.title}"`);
    return done([...LEARN, `/learn/sessions/${s.id}`], "Session closed.");
  }
  return NO("Unknown action.");
}

/** Self-registration: straight in (or waitlisted), unless the session needs approval. */
export async function registerSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const me = viewer.employee;
  if (!me) return NO("Only employees can register.");
  const s = await sessionOf(viewer, field(formData, "sessionId", 40));
  if (!s) return NO("Session not found.");
  if (!sessionOpen(s)) return NO("Registration for this session has closed.");
  const mine = s.registrations.find((r) => r.employeeId === me.id);
  if (mine && mine.status !== "CANCELLED" && mine.status !== "REJECTED") return NO("You are already registered.");
  const status = s.requiresApproval ? "REQUESTED" : sessionSeat(s.capacity, s.registrations.filter((r) => r.status === "REGISTERED").length);
  const data = { status, note: field(formData, "note", 500) || null, requestedAt: new Date(), decidedBy: null, decidedAt: null, attendance: null };
  const reg = mine ? await prisma.sessionRegistration.update({ where: { id: mine.id }, data }) : await prisma.sessionRegistration.create({ data: { ...data, sessionId: s.id, employeeId: me.id } });
  if (status === "REQUESTED") {
    const mgr = await prisma.employee.findUnique({ where: { id: me.id }, select: { reportingManager: { select: { userId: true } } } });
    await notify({ tenantId: viewer.tenantId, userIds: [mgr?.reportingManager?.userId], kind: "LEARNING", title: `${me.displayName} wants to attend ${s.title}`, link: "/learn/approvals" });
  }
  await audit(viewer, "CREATE", "SessionRegistration", reg.id, `Registered for "${s.title}" (${status.toLowerCase()})`);
  return done([...LEARN, `/learn/sessions/${s.id}`], status === "REQUESTED" ? "Requested — your manager will approve." : status === "WAITLISTED" ? "The session is full; you are on the waitlist." : "You are registered.");
}

/** A manager or admin registers people directly. */
export async function nominateSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const s = await sessionOf(viewer, field(formData, "sessionId", 40));
  if (!s) return NO("Session not found.");
  if (!sessionOpen(s)) return NO("Registration for this session has closed.");
  const ids = [...new Set(formList(formData, "employeeIds"))];
  if (ids.length === 0) return NO("Choose at least one person.");
  if (!mayRunSessions(viewer)) {
    const outside = await unreachable(viewer, ids, P.COURSE_ASSIGN);
    if (outside.length) return NO(`You can nominate only people in your team (${outside.length} chosen are not).`);
  } else {
    const found = await prisma.employee.count({ where: { tenantId: viewer.tenantId, id: { in: ids } } });
    if (found !== ids.length) return NO("Someone chosen was not found.");
  }
  let seated = s.registrations.filter((r) => r.status === "REGISTERED").length, added = 0, waitlisted = 0;
  for (const employeeId of ids) {
    const mine = s.registrations.find((r) => r.employeeId === employeeId);
    if (mine && !["CANCELLED", "REJECTED"].includes(mine.status)) continue;
    const status = sessionSeat(s.capacity, seated);
    const data = { status, requestedAt: new Date(), decidedBy: viewer.user.id, decidedAt: new Date(), attendance: null };
    if (mine) await prisma.sessionRegistration.update({ where: { id: mine.id }, data }); else await prisma.sessionRegistration.create({ data: { ...data, sessionId: s.id, employeeId } });
    if (status === "REGISTERED") seated++; else waitlisted++;
    added++;
  }
  if (!added) return NO("Everyone chosen is already registered.");
  const users = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "LEARNING", title: `You are registered for ${s.title}`, link: `/learn/sessions/${s.id}` });
  await audit(viewer, "CREATE", "SessionRegistration", s.id, `Registered ${added} people for "${s.title}"${waitlisted ? ` (${waitlisted} waitlisted)` : ""}`);
  return done([...LEARN, `/learn/sessions/${s.id}`], `${added} registered${waitlisted ? `, ${waitlisted} on the waitlist` : ""}.`);
}

async function promoteWaitlist(sessionId: string) {
  const s = await prisma.trainingSession.findUnique({ where: { id: sessionId }, include: { registrations: { orderBy: { requestedAt: "asc" }, include: { employee: { select: { userId: true } } } } } });
  if (!s) return;
  let seated = s.registrations.filter((r) => r.status === "REGISTERED").length;
  for (const r of s.registrations.filter((x) => x.status === "WAITLISTED")) {
    if (sessionSeat(s.capacity, seated) !== "REGISTERED") break;
    await prisma.sessionRegistration.update({ where: { id: r.id }, data: { status: "REGISTERED" } });
    await notify({ tenantId: s.tenantId, userIds: [r.employee.userId], kind: "LEARNING", title: `A place opened up: ${s.title}`, body: "You are now registered.", link: `/learn/sessions/${s.id}` });
    seated++;
  }
}

export async function cancelRegistrationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.sessionRegistration.findFirst({ where: { id: field(formData, "registrationId", 40), session: { tenantId: viewer.tenantId } }, include: { session: true } });
  if (!r) return NO("Registration not found.");
  const own = r.employeeId === viewer.employee?.id;
  if (!own && !mayRunSessions(viewer)) return NO("You cannot change this registration.");
  if (!sessionOpen(r.session)) return NO("The session has started or closed.");
  if (["CANCELLED", "REJECTED"].includes(r.status)) return NO("Already cancelled.");
  await prisma.sessionRegistration.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
  await promoteWaitlist(r.sessionId);
  await audit(viewer, "UPDATE", "SessionRegistration", r.id, `Cancelled a registration for "${r.session.title}"`);
  return done([...LEARN, `/learn/sessions/${r.sessionId}`], "Registration cancelled.");
}

export async function decideRegistrationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await prisma.sessionRegistration.findFirst({ where: { id: field(formData, "registrationId", 40), session: { tenantId: viewer.tenantId } }, include: { session: { include: { registrations: true } }, employee: { select: { userId: true, displayName: true } } } });
  if (!r) return NO("Registration not found.");
  if (r.status !== "REQUESTED") return NO("This registration is not waiting for approval.");
  if (r.employeeId === viewer.employee?.id) return NO("You cannot approve your own registration.");
  if (!mayRunSessions(viewer) && !(await reaches(viewer, r.employeeId, P.COURSE_ASSIGN))) return NO("Only their manager or a learning admin can decide this.");
  const decision = field(formData, "decision", 10);
  if (decision !== "approve" && decision !== "reject") return NO("Approve or reject.");
  const status = decision === "reject" ? "REJECTED" : sessionSeat(r.session.capacity, r.session.registrations.filter((x) => x.status === "REGISTERED").length);
  await prisma.sessionRegistration.update({ where: { id: r.id }, data: { status, decidedBy: viewer.user.id, decidedAt: new Date(), note: field(formData, "note", 500) || r.note } });
  await notify({ tenantId: viewer.tenantId, userIds: [r.employee.userId], kind: "LEARNING", title: `${r.session.title}: ${status === "REJECTED" ? "request declined" : status === "WAITLISTED" ? "approved, on the waitlist" : "you are registered"}`, link: `/learn/sessions/${r.sessionId}` });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "SessionRegistration", r.id, `${decision === "approve" ? "Approved" : "Rejected"} ${r.employee.displayName} for "${r.session.title}"`);
  return done([...LEARN, `/learn/sessions/${r.sessionId}`], status === "REJECTED" ? "Declined." : status === "WAITLISTED" ? "Approved; the session is full so they are waitlisted." : "Approved and registered.");
}

/** Attendance, once the session has started: present ids are ticked, every other registrant is absent. */
export async function markAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!mayRunSessions(viewer)) return NO("You cannot mark attendance.");
  const s = await sessionOf(viewer, field(formData, "sessionId", 40));
  if (!s) return NO("Session not found.");
  if (s.status === "CANCELLED") return NO("This session was cancelled.");
  if (s.startsAt.getTime() > Date.now()) return NO("Attendance can be marked once the session starts.");
  const present = new Set(formList(formData, "present"));
  const registered = s.registrations.filter((r) => r.status === "REGISTERED");
  if (registered.length === 0) return NO("Nobody is registered.");
  for (const r of registered) await prisma.sessionRegistration.update({ where: { id: r.id }, data: { attendance: present.has(r.id) ? "PRESENT" : "ABSENT" } });
  const n = registered.filter((r) => present.has(r.id)).length;
  await audit(viewer, "UPDATE", "TrainingSession", s.id, `Marked attendance for "${s.title}": ${n} of ${registered.length} present`);
  return done([...LEARN, `/learn/sessions/${s.id}`], `${n} of ${registered.length} marked present.`);
}
