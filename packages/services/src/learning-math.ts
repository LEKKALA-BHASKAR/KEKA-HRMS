/**
 * Pure learning arithmetic — no database. Quiz marking, course progress from
 * lesson completion, and where an enrolment stands against its due date.
 */

export interface QuizKey { id: string; correctIndex: number; options: string[] }

/**
 * Mark a quiz attempt. Unanswered questions count as wrong; a percentage is
 * rounded down so 69.9% never passes a 70% bar.
 */
export function gradeQuiz(questions: QuizKey[], picked: Record<string, number | undefined>, passPercent: number) {
  const results = questions.map((q) => ({ questionId: q.id, picked: picked[q.id] ?? null, correct: picked[q.id] === q.correctIndex }));
  const right = results.filter((r) => r.correct).length;
  const score = questions.length === 0 ? 100 : Math.floor((right / questions.length) * 100);
  return { score, right, total: questions.length, passed: score >= passPercent, results };
}

/** Share of lessons finished, 0–100, rounded down so 100 means truly done. */
export function courseProgress(totalLessons: number, completedLessons: number): number {
  if (totalLessons <= 0) return 0;
  return Math.floor((Math.min(completedLessons, totalLessons) / totalLessons) * 100);
}

/** The average of the best scores across quiz lessons, or null with no quizzes. */
export function courseScore(quizScores: Array<number | null>): number | null {
  const s = quizScores.filter((x): x is number => x !== null);
  return s.length === 0 ? null : Math.round(s.reduce((a, b) => a + b, 0) / s.length);
}

export type EnrolmentStanding = "COMPLETED" | "OVERDUE" | "DUE_SOON" | "ON_TRACK" | "NOT_STARTED";

/** Due within a week counts as due soon. */
export function enrolmentStanding(e: { status: string; dueDate: Date | null; progressPercent: number }, today = new Date()): EnrolmentStanding {
  if (e.status === "COMPLETED") return "COMPLETED";
  if (e.dueDate) {
    const days = Math.floor((e.dueDate.getTime() - today.getTime()) / 86_400_000);
    if (days < 0) return "OVERDUE";
    if (days <= 7) return "DUE_SOON";
  }
  return e.progressPercent > 0 ? "ON_TRACK" : "NOT_STARTED";
}

/** Total minutes for a course, displayed as "1h 25m". */
export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface SkillRequirement { skillId: string; level: number }

/**
 * Readiness for a career step: each required skill is met when the person
 * holds it, approved, at or above the required level. Readiness is the share
 * of requirements met; an unapproved self-rating does not count yet.
 */
export function careerGap(required: SkillRequirement[], held: Array<{ skillId: string; level: number; isApproved: boolean }>) {
  const mine = new Map(held.filter((h) => h.isApproved).map((h) => [h.skillId, h.level]));
  const rows = required.map((r) => {
    const level = mine.get(r.skillId) ?? null;
    return { skillId: r.skillId, required: r.level, held: level, met: level !== null && level >= r.level };
  });
  const met = rows.filter((r) => r.met).length;
  return { rows, met, total: rows.length, readiness: rows.length === 0 ? 100 : Math.floor((met / rows.length) * 100) };
}

/** Find the rung of a ladder matching a job title, ignoring case and spacing. */
export function placeOnPath<T extends { title: string; sequence: number }>(steps: T[], jobTitle: string | null | undefined): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (!jobTitle) return null;
  return steps.find((s) => norm(s.title) === norm(jobTitle)) ?? null;
}
