import { prisma } from "@keka/db";
import { courseProgress, courseScore, gradeQuiz } from "./learning-math";
import { notify } from "./lifecycle";

/**
 * Learning orchestration. An enrolment's progress, score and status are
 * always derived from its lesson rows, never set directly, so they cannot
 * disagree with what the learner actually did.
 */

/**
 * Recompute an enrolment from its lessons. Completing the last lesson
 * completes the course and records the course's skill on the learner's
 * profile — at the course's level, never lowering a level they already hold.
 */
export async function refreshEnrolment(enrolmentId: string) {
  const e = await prisma.courseEnrolment.findUniqueOrThrow({
    where: { id: enrolmentId },
    include: { course: { include: { lessons: { select: { id: true, kind: true } } } }, lessons: true },
  });
  const lessonIds = new Set(e.course.lessons.map((l) => l.id));
  const done = e.lessons.filter((p) => p.completedAt && lessonIds.has(p.lessonId));
  const progress = courseProgress(e.course.lessons.length, done.length);
  const quizIds = new Set(e.course.lessons.filter((l) => l.kind === "QUIZ").map((l) => l.id));
  const score = courseScore(e.lessons.filter((p) => quizIds.has(p.lessonId)).map((p) => p.score));
  const complete = progress === 100;
  const touched = e.lessons.some((p) => p.attempts > 0 || p.completedAt);

  const updated = await prisma.courseEnrolment.update({
    where: { id: e.id },
    data: {
      progressPercent: progress, score,
      status: complete ? "COMPLETED" : touched ? "IN_PROGRESS" : "ASSIGNED",
      startedAt: e.startedAt ?? (touched ? new Date() : null),
      completedAt: complete ? (e.completedAt ?? new Date()) : null,
    },
  });

  if (complete && !e.completedAt && e.course.skillId) {
    const existing = await prisma.employeeSkill.findUnique({ where: { employeeId_skillId: { employeeId: e.employeeId, skillId: e.course.skillId } } });
    if (!existing) {
      await prisma.employeeSkill.create({
        data: { employeeId: e.employeeId, skillId: e.course.skillId, level: e.course.skillLevel, source: "COURSE_COMPLETION", isApproved: true, approvedAt: new Date() },
      });
    } else if (existing.level < e.course.skillLevel) {
      await prisma.employeeSkill.update({
        where: { id: existing.id },
        data: { level: e.course.skillLevel, source: "COURSE_COMPLETION", isApproved: true, approvedAt: new Date() },
      });
    }
  }
  return updated;
}

/** Mark a reading, video or document lesson as done. Quizzes are passed, not ticked. */
export async function completeLesson(enrolmentId: string, lessonId: string) {
  const e = await prisma.courseEnrolment.findUniqueOrThrow({ where: { id: enrolmentId }, include: { course: true } });
  const lesson = await prisma.courseLesson.findFirst({ where: { id: lessonId, courseId: e.courseId } });
  if (!lesson) return { ok: false, message: "That lesson is not part of this course." };
  if (lesson.kind === "QUIZ") return { ok: false, message: "A quiz is completed by passing it." };
  if (e.course.status !== "PUBLISHED") return { ok: false, message: "This course is not available." };
  await prisma.lessonProgress.upsert({
    where: { enrolmentId_lessonId: { enrolmentId, lessonId } },
    create: { enrolmentId, lessonId, completedAt: new Date(), attempts: 1 },
    update: { completedAt: new Date() },
  });
  const after = await refreshEnrolment(enrolmentId);
  return { ok: true, message: after.status === "COMPLETED" ? "Course complete — well done!" : "Lesson marked complete.", completed: after.status === "COMPLETED" };
}

/**
 * Mark a quiz. The best score is kept; the lesson counts as done once a
 * score reaches the course's pass mark, and a later failed attempt cannot
 * undo a pass.
 */
export async function attemptQuiz(enrolmentId: string, lessonId: string, picked: Record<string, number | undefined>) {
  const e = await prisma.courseEnrolment.findUniqueOrThrow({ where: { id: enrolmentId }, include: { course: true } });
  const lesson = await prisma.courseLesson.findFirst({
    where: { id: lessonId, courseId: e.courseId, kind: "QUIZ" },
    include: { questions: { orderBy: { sequence: "asc" } } },
  });
  if (!lesson) return { ok: false, message: "Quiz not found." };
  if (e.course.status !== "PUBLISHED") return { ok: false, message: "This course is not available." };
  const g = gradeQuiz(lesson.questions, picked, e.course.passPercent);
  const prior = await prisma.lessonProgress.findUnique({ where: { enrolmentId_lessonId: { enrolmentId, lessonId } } });
  const best = Math.max(prior?.score ?? 0, g.score);
  await prisma.lessonProgress.upsert({
    where: { enrolmentId_lessonId: { enrolmentId, lessonId } },
    create: { enrolmentId, lessonId, score: g.score, attempts: 1, completedAt: g.passed ? new Date() : null },
    update: { score: best, attempts: { increment: 1 }, completedAt: prior?.completedAt ?? (g.passed ? new Date() : null) },
  });
  const after = await refreshEnrolment(enrolmentId);
  return {
    ok: true, passed: g.passed, score: g.score, right: g.right, total: g.total, results: g.results,
    message: g.passed
      ? `Passed with ${g.score}% (${g.right} of ${g.total}).${after.status === "COMPLETED" ? " Course complete!" : ""}`
      : `${g.score}% — you need ${e.course.passPercent}% to pass. Review the lessons and try again.`,
  };
}

/**
 * Enrol people in a published course. Existing enrolments are left as they
 * are, so re-assigning never resets anyone's progress.
 */
export async function enrolEmployees(opts: {
  tenantId: string; courseId: string; employeeIds: string[]; assignedBy?: string | null;
  dueDate?: Date | null; source?: "ASSIGNED" | "SELF" | "MANDATORY"; notifyThem?: boolean;
}) {
  const course = await prisma.course.findFirstOrThrow({ where: { id: opts.courseId, tenantId: opts.tenantId } });
  const due = opts.dueDate ?? (course.dueInDays ? new Date(Date.now() + course.dueInDays * 86_400_000) : null);
  const existing = new Set((await prisma.courseEnrolment.findMany({
    where: { courseId: course.id, employeeId: { in: opts.employeeIds } }, select: { employeeId: true },
  })).map((e) => e.employeeId));
  const fresh = opts.employeeIds.filter((id) => !existing.has(id));
  if (fresh.length === 0) return { created: 0, skipped: existing.size };
  await prisma.courseEnrolment.createMany({
    data: fresh.map((employeeId) => ({
      tenantId: opts.tenantId, courseId: course.id, employeeId,
      source: opts.source ?? "ASSIGNED", assignedBy: opts.assignedBy ?? null, dueDate: due,
    })),
    skipDuplicates: true,
  });
  if (opts.notifyThem !== false) {
    const users = await prisma.employee.findMany({ where: { id: { in: fresh } }, select: { userId: true } });
    await notify({
      tenantId: opts.tenantId, userIds: users.map((u) => u.userId), kind: "LEARNING",
      title: `Course assigned: ${course.title}`,
      body: due ? `Please complete it by ${due.toISOString().slice(0, 10)}.` : "Start whenever you are ready.",
      link: `/learn/courses/${course.id}`,
    });
  }
  return { created: fresh.length, skipped: existing.size };
}

/** Every active employee, for mandatory courses. */
export async function enrolEveryone(tenantId: string, courseId: string, assignedBy?: string | null) {
  const people = await prisma.employee.findMany({
    where: { tenantId, status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] } }, select: { id: true },
  });
  return enrolEmployees({ tenantId, courseId, employeeIds: people.map((p) => p.id), assignedBy, source: "MANDATORY" });
}

/** A new joiner is enrolled in every published mandatory course. */
export async function enrolInMandatoryCourses(tenantId: string, employeeId: string, assignedBy?: string | null) {
  const courses = await prisma.course.findMany({ where: { tenantId, status: "PUBLISHED", isMandatory: true }, select: { id: true } });
  let created = 0;
  for (const c of courses) created += (await enrolEmployees({ tenantId, courseId: c.id, employeeIds: [employeeId], assignedBy, source: "MANDATORY" })).created;
  return created;
}
