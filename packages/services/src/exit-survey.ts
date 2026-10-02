import { randomUUID } from "node:crypto";
import { prisma } from "@keka/db";
import { validateSubmission, type QuestionDef, type SubmittedAnswer } from "./engagement-math";
import { summariseExitSurvey } from "./core-hr-workflows-math";

/**
 * Exit surveys reuse the engagement survey models: a Survey of kind EXIT
 * holds the questions, and each leaving employee's answers are one
 * SurveyResponse tagged with their exit. Exit surveys are never anonymous
 * (HR reads them against the exit) and never appear with the engagement
 * surveys. An exit uses the survey chosen on it, or else the organisation's
 * active exit survey.
 */

export const EXIT_SURVEY_QUESTIONS: Array<{ prompt: string; type: "RATING" | "NPS" | "SINGLE_CHOICE" | "TEXT"; options?: string[]; required?: boolean; driver?: string }> = [
  { prompt: "What is the main reason you are leaving?", type: "SINGLE_CHOICE", options: ["Career growth", "Compensation", "My manager", "Work-life balance", "The role or work", "Relocation", "Personal reasons", "Other"], driver: "Reason" },
  { prompt: "My manager supported me well.", type: "RATING", driver: "Manager" },
  { prompt: "I had good opportunities to learn and grow here.", type: "RATING", driver: "Growth" },
  { prompt: "I was fairly paid for my work.", type: "RATING", driver: "Compensation" },
  { prompt: "Overall, I enjoyed working here.", type: "RATING", driver: "Experience" },
  { prompt: "How likely are you to recommend us as a place to work?", type: "NPS", driver: "eNPS" },
  { prompt: "What could we have done to keep you?", type: "TEXT", required: false },
  { prompt: "Anything else you would like to tell us?", type: "TEXT", required: false },
];

/** The organisation's exit survey, created from the standard questions when there is none. */
export async function ensureExitSurvey(tenantId: string, createdBy?: string | null) {
  const existing = await prisma.survey.findFirst({ where: { tenantId, kind: "EXIT", status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (existing) return { survey: existing, created: false };
  const survey = await prisma.survey.create({
    data: {
      tenantId, kind: "EXIT", status: "ACTIVE", isAnonymous: false, minGroupSize: 1, title: "Exit survey",
      description: "Asked of everyone leaving, on their My exit page. HR reads each answer with the exit.",
      launchedAt: new Date(), opensAt: new Date(), createdBy: createdBy ?? null,
      questions: {
        create: EXIT_SURVEY_QUESTIONS.map((q, i) => ({ sequence: i + 1, prompt: q.prompt, type: q.type, options: q.options ?? [], required: q.required ?? true, driver: q.driver ?? null })),
      },
    },
  });
  return { survey, created: true };
}

/** The survey an exit asks for: its own, else the organisation's active one. Null when there is none. */
export async function exitSurveyFor(exitId: string) {
  const exit = await prisma.exitRecord.findUnique({ where: { id: exitId }, select: { exitSurveyId: true, employee: { select: { tenantId: true } } } });
  if (!exit) return null;
  const include = { questions: { orderBy: { sequence: "asc" as const } } };
  const own = exit.exitSurveyId
    ? await prisma.survey.findFirst({ where: { id: exit.exitSurveyId, tenantId: exit.employee.tenantId, kind: "EXIT" }, include })
    : null;
  return own ?? prisma.survey.findFirst({ where: { tenantId: exit.employee.tenantId, kind: "EXIT", status: "ACTIVE" }, orderBy: { createdAt: "desc" }, include });
}

/** Exits that may take the survey: accepted (or in clearance onward), not withdrawn. */
export const EXIT_SURVEY_STATUSES = ["PENDING_APPROVAL", "APPROVED", "IN_CLEARANCE", "SETTLED", "COMPLETED"] as const;

/** Record a leaving employee's answers. One response per exit. */
export async function submitExitSurvey(input: { exitId: string; employeeId: string; answers: SubmittedAnswer[] }):
  Promise<{ ok: true; responseId: string } | { ok: false; message: string; errors?: Record<string, string> }> {
  const exit = await prisma.exitRecord.findUnique({ where: { id: input.exitId }, select: { id: true, employeeId: true, status: true, employee: { select: { departmentId: true } } } });
  if (!exit || exit.employeeId !== input.employeeId) return { ok: false, message: "That exit was not found." };
  if (!(EXIT_SURVEY_STATUSES as readonly string[]).includes(exit.status)) return { ok: false, message: "The exit survey opens once you have resigned." };
  const survey = await exitSurveyFor(exit.id);
  if (!survey) return { ok: false, message: "Your organisation has not set up an exit survey." };
  if (await prisma.surveyResponse.count({ where: { surveyId: survey.id, exitRecordId: exit.id } })) return { ok: false, message: "You have already completed the exit survey." };
  const v = validateSubmission(survey.questions as unknown as QuestionDef[], input.answers);
  if (!v.ok) return { ok: false, message: "Please answer the highlighted questions.", errors: v.errors };
  try {
    const response = await prisma.$transaction(async (tx) => {
      await tx.surveyParticipant.create({ data: { surveyId: survey.id, employeeId: input.employeeId } });
      return tx.surveyResponse.create({
        data: {
          id: randomUUID(), surveyId: survey.id, employeeId: input.employeeId, departmentId: exit.employee.departmentId, exitRecordId: exit.id,
          answers: { create: v.answers.map((a) => ({ ...a, id: randomUUID() })) },
        },
      });
    });
    return { ok: true, responseId: response.id };
  } catch (err) {
    // The participant row is unique per survey: a rehire leaving again answers a fresh survey.
    if (String(err).includes("Unique constraint")) return { ok: false, message: "You have already answered this exit survey." };
    throw err;
  }
}

/** One exit's response with its questions, for the exit page. */
export async function exitSurveyResponse(exitId: string) {
  const response = await prisma.surveyResponse.findFirst({
    where: { exitRecordId: exitId, survey: { kind: "EXIT" } },
    include: { answers: true, survey: { include: { questions: { orderBy: { sequence: "asc" } } } } },
    orderBy: { submittedAt: "desc" },
  });
  return response;
}

/** Roll-up across exits for one survey, optionally limited to some exits (the viewer's scope, a date range). */
export async function exitSurveyAggregate(surveyId: string, exitIds?: string[]) {
  const survey = await prisma.survey.findUniqueOrThrow({ where: { id: surveyId }, include: { questions: { orderBy: { sequence: "asc" } } } });
  const responses = await prisma.surveyResponse.findMany({
    where: { surveyId, exitRecordId: exitIds ? { in: exitIds } : { not: null } },
    include: { answers: true },
  });
  return {
    survey, responses: responses.length,
    questions: summariseExitSurvey(survey.questions, responses.flatMap((r) => r.answers)),
  };
}
