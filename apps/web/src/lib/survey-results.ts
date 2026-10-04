import "server-only";
import { prisma } from "@keka/db";
import {
  enps, ratingSummary, choiceTally, driverScores, canReveal, participation,
  type QuestionDef, type AnswerRow,
} from "@keka/services";
import { surveyAudience } from "./engage";

/**
 * Everything the results screen shows, with the anonymity rule applied in
 * one place: a figure drawn from fewer than the survey's minimum group size
 * is replaced by `null`, never computed and hidden by the page.
 */
export async function surveyResults(tenantId: string, surveyId: string) {
  const survey = await prisma.survey.findFirst({
    where: { id: surveyId, tenantId },
    include: {
      questions: { orderBy: { sequence: "asc" } },
      responses: { include: { answers: true } },
      _count: { select: { participants: true } },
    },
  });
  if (!survey) return null;

  const audience = await surveyAudience(tenantId, survey.departmentIds);
  const invited = survey.status === "DRAFT" ? audience.length : Math.max(audience.length, survey._count.participants);
  const respondents = survey.responses.length;
  const min = survey.kind === "POLL" ? 1 : survey.minGroupSize;
  const revealed = canReveal(respondents, min);

  const questions = survey.questions as unknown as QuestionDef[];
  const answers: AnswerRow[] = survey.responses.flatMap((r) =>
    r.answers.map((a) => ({ questionId: a.questionId, score: a.score, choices: a.choices, text: a.textHiddenAt ? null : a.text, departmentId: r.departmentId })));

  const perQuestion = survey.questions.map((q) => {
    const qa = answers.filter((a) => a.questionId === q.id);
    const base = { id: q.id, prompt: q.prompt, type: q.type, driver: q.driver, answered: qa.length };
    if (!revealed) return { ...base, rating: null, nps: null, choices: null, comments: null };
    return {
      ...base,
      rating: q.type === "RATING" ? ratingSummary(qa.map((a) => a.score!).filter((s) => s !== null)) : null,
      nps: q.type === "NPS" ? enps(qa.map((a) => a.score!).filter((s) => s !== null)) : null,
      choices: q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE" ? choiceTally(q.options, qa) : null,
      // Comments are shuffled into a stable but non-chronological order.
      comments: q.type === "TEXT" ? qa.map((a) => a.text).filter((t): t is string => !!t).sort() : null,
    };
  });

  const npsQuestion = survey.questions.find((q) => q.type === "NPS");
  const headlineNps = revealed && npsQuestion ? enps(answers.filter((a) => a.questionId === npsQuestion.id && a.score !== null).map((a) => a.score!)) : null;
  const drivers = revealed ? driverScores(questions, answers) : [];

  // Department breakdown: each slice is held to the same minimum.
  const departments = await prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const byDept = new Map<string, typeof survey.responses>();
  for (const r of survey.responses) {
    const k = r.departmentId ?? "—";
    byDept.set(k, [...(byDept.get(k) ?? []), r]);
  }
  const ratingIds = new Set(survey.questions.filter((q) => q.type === "RATING").map((q) => q.id));
  const breakdown = [...byDept.entries()].map(([deptId, rows]) => {
    const show = revealed && canReveal(rows.length, min);
    const scores = rows.flatMap((r) => r.answers.filter((a) => ratingIds.has(a.questionId) && a.score !== null).map((a) => a.score!));
    const npsScores = npsQuestion ? rows.flatMap((r) => r.answers.filter((a) => a.questionId === npsQuestion.id && a.score !== null).map((a) => a.score!)) : [];
    const invitedHere = audience.filter((a) => (a.departmentId ?? "—") === deptId).length;
    return {
      department: deptName.get(deptId) ?? "No department",
      responses: rows.length,
      invited: invitedHere,
      favourable: show && scores.length ? ratingSummary(scores).favourable : null,
      enps: show && npsScores.length ? enps(npsScores).score : null,
    };
  }).sort((a, b) => b.responses - a.responses);

  return {
    survey, invited, respondents, revealed, minGroupSize: min,
    participationPct: participation(survey._count.participants, invited),
    perQuestion, headlineNps, drivers, breakdown,
    favourable: revealed ? ratingSummary(answers.filter((a) => ratingIds.has(a.questionId) && a.score !== null).map((a) => a.score!)).favourable : null,
  };
}
