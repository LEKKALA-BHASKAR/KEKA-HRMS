"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { notify, validateSubmission, type QuestionDef, type SubmittedAnswer } from "@keka/services";
import { randomUUID } from "node:crypto";
import { foreignReference } from "@/lib/ownership";
import { surveyAudience } from "@/lib/engage";
import { requireAuth, requireViewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zDate, zBool, zNumber, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

type QuestionSeed = { prompt: string; type: QuestionDef["type"]; driver?: string; options?: string[]; required?: boolean };

/**
 * Starting questions per survey kind. An admin edits them before launch; the
 * templates exist so a pulse can go out in a minute, as it does in Keka.
 */
const TEMPLATES: Record<"PULSE" | "ENGAGEMENT" | "ENPS", QuestionSeed[]> = {
  PULSE: [
    { prompt: "I feel recognised for the work I do.", type: "RATING", driver: "Recognition" },
    { prompt: "I have a clear path to grow here.", type: "RATING", driver: "Growth" },
    { prompt: "My manager supports me when I need it.", type: "RATING", driver: "Manager" },
    { prompt: "My workload is manageable.", type: "RATING", driver: "Wellbeing" },
    { prompt: "Anything you would like us to know?", type: "TEXT", required: false },
  ],
  ENGAGEMENT: [
    { prompt: "I am proud to work for this organisation.", type: "RATING", driver: "Alignment" },
    { prompt: "I understand how my work contributes to company goals.", type: "RATING", driver: "Alignment" },
    { prompt: "I receive appropriate recognition when I do good work.", type: "RATING", driver: "Recognition" },
    { prompt: "I have had a conversation about my growth in the last six months.", type: "RATING", driver: "Growth" },
    { prompt: "There are opportunities for me to learn new skills.", type: "RATING", driver: "Growth" },
    { prompt: "My manager gives me useful feedback.", type: "RATING", driver: "Manager" },
    { prompt: "I trust my manager to have my back.", type: "RATING", driver: "Manager" },
    { prompt: "I can switch off from work in my own time.", type: "RATING", driver: "Wellbeing" },
    { prompt: "My team mates help each other out.", type: "RATING", driver: "Peers" },
    { prompt: "I have the freedom to decide how I do my work.", type: "RATING", driver: "Autonomy" },
    { prompt: "Leadership keeps us informed about what is happening.", type: "RATING", driver: "Communication" },
    { prompt: "How likely are you to recommend this organisation as a place to work?", type: "NPS" },
    { prompt: "What one thing would make this a better place to work?", type: "TEXT", required: false },
  ],
  ENPS: [
    { prompt: "How likely are you to recommend this organisation as a place to work?", type: "NPS" },
    { prompt: "What is the main reason for your score?", type: "TEXT", required: false },
  ],
};

const createSchema = z.object({
  title: zName(160),
  description: zOptional(1000),
  kind: z.enum(["PULSE", "ENGAGEMENT", "ENPS", "POLL"]),
  isAnonymous: zBool(),
  minGroupSize: zNumber({ min: 1, max: 20 }),
  closesAt: zDate(),
  // A poll is created with its single question in one step.
  pollQuestion: zOptional(300),
  pollOptions: zOptional(2000),
  pollMulti: zBool(),
});

export async function createSurveyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const parsed = parseForm(createSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  const departmentIds = formList(formData, "departmentIds");
  const foreign = await foreignReference(viewer.tenantId, { department: departmentIds });
  if (foreign) return { ok: false, message: foreign, values };
  if (d.closesAt && d.closesAt.getTime() < Date.now() - 86_400_000) {
    return { ok: false, message: "The closing date has already passed.", errors: { closesAt: "In the past" }, values };
  }

  let questions: QuestionSeed[];
  if (d.kind === "POLL") {
    const options = (d.pollOptions ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (!d.pollQuestion) return { ok: false, message: "A poll needs a question.", errors: { pollQuestion: "Required" }, values };
    if (options.length < 2) return { ok: false, message: "Give at least two options, one per line.", errors: { pollOptions: "At least two" }, values };
    if (options.length > 10) return { ok: false, message: "Keep a poll to ten options.", errors: { pollOptions: "At most ten" }, values };
    questions = [{ prompt: d.pollQuestion, type: d.pollMulti ? "MULTI_CHOICE" : "SINGLE_CHOICE", options }];
  } else {
    questions = TEMPLATES[d.kind];
  }

  try {
    const survey = await prisma.survey.create({
      data: {
        tenantId: viewer.tenantId, title: d.title, description: d.description, kind: d.kind,
        // A poll's results are shown to voters by design; it is still not linked to names.
        isAnonymous: d.kind === "POLL" ? true : d.isAnonymous,
        minGroupSize: d.minGroupSize ?? 3, departmentIds, closesAt: d.closesAt,
        createdBy: viewer.user.id,
        questions: {
          create: questions.map((q, i) => ({
            sequence: i + 1, prompt: q.prompt, type: q.type, driver: q.driver ?? null,
            options: q.options ?? [], required: q.required ?? true,
          })),
        },
      },
    });
    await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "Survey", entityId: survey.id, summary: `Drafted ${d.kind.toLowerCase()} "${d.title}"` });
    return { ...done(["/engage/surveys"], d.kind === "POLL" ? "Poll drafted — launch it when ready." : "Survey drafted from the template — review the questions, then launch."), values: { surveyId: survey.id } };
  } catch (err) {
    return toErrorState(err, values);
  }
}

async function draftSurvey(tenantId: string, surveyId: string) {
  const s = await prisma.survey.findFirst({ where: { id: surveyId, tenantId }, include: { questions: { orderBy: { sequence: "asc" } } } });
  if (!s) throw new Error("Survey not found.");
  return s;
}

const questionSchema = z.object({
  surveyId: z.string().min(1),
  prompt: zName(300),
  type: z.enum(["RATING", "NPS", "SINGLE_CHOICE", "MULTI_CHOICE", "TEXT"]),
  driver: zOptional(40),
  options: zOptional(2000),
  required: zBool(),
});

export async function addQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const parsed = parseForm(questionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    const s = await draftSurvey(viewer.tenantId, d.surveyId);
    if (s.status !== "DRAFT") return { ok: false, message: "Questions are fixed once a survey is launched." };
    const options = (d.options ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    if ((d.type === "SINGLE_CHOICE" || d.type === "MULTI_CHOICE") && options.length < 2) {
      return { ok: false, message: "A choice question needs at least two options, one per line.", errors: { options: "At least two" } };
    }
    const next = (s.questions.at(-1)?.sequence ?? 0) + 1;
    await prisma.surveyQuestion.create({
      data: {
        surveyId: s.id, sequence: next, prompt: d.prompt, type: d.type, driver: d.type === "RATING" ? d.driver : null,
        options: d.type === "SINGLE_CHOICE" || d.type === "MULTI_CHOICE" ? options : [], required: d.required,
      },
    });
    return done([`/engage/surveys/${s.id}`], "Question added.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function removeQuestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const questionId = String(formData.get("questionId"));
  const q = await prisma.surveyQuestion.findFirst({ where: { id: questionId, survey: { tenantId: viewer.tenantId } }, include: { survey: true } });
  if (!q) return { ok: false, message: "Question not found." };
  if (q.survey.status !== "DRAFT") return { ok: false, message: "Questions are fixed once a survey is launched." };
  // Renumber so sequences stay contiguous and unique.
  await prisma.$transaction(async (tx) => {
    await tx.surveyQuestion.delete({ where: { id: q.id } });
    const rest = await tx.surveyQuestion.findMany({ where: { surveyId: q.surveyId }, orderBy: { sequence: "asc" } });
    for (const [i, r] of rest.entries()) await tx.surveyQuestion.update({ where: { id: r.id }, data: { sequence: -(i + 1) } });
    for (const [i, r] of rest.entries()) await tx.surveyQuestion.update({ where: { id: r.id }, data: { sequence: i + 1 } });
  });
  return done([`/engage/surveys/${q.surveyId}`], "Question removed.");
}

export async function surveyOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SURVEY_MANAGE);
  const surveyId = String(formData.get("surveyId"));
  const op = String(formData.get("op"));
  try {
    const s = await draftSurvey(viewer.tenantId, surveyId);
    if (op === "launch") {
      if (s.status !== "DRAFT") return { ok: false, message: "Only a draft can be launched." };
      if (s.questions.length === 0) return { ok: false, message: "Add at least one question first." };
      const audience = await surveyAudience(viewer.tenantId, s.departmentIds);
      if (audience.length === 0) return { ok: false, message: "Nobody is in the chosen departments." };
      await prisma.survey.update({ where: { id: s.id }, data: { status: "ACTIVE", launchedAt: new Date(), opensAt: new Date() } });
      await notify({
        tenantId: viewer.tenantId, userIds: audience.map((a) => a.userId), kind: "ENGAGE",
        title: s.kind === "POLL" ? `New poll: ${s.title}` : `Your voice counts: ${s.title}`,
        body: s.isAnonymous ? "Your answers are anonymous." : "Your answers will carry your name.",
        link: `/engage/surveys/${s.id}`,
      });
      await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "Survey", entityId: s.id, summary: `Launched "${s.title}" to ${audience.length} people` });
      return done(["/engage/surveys", `/engage/surveys/${s.id}`], `Launched to ${audience.length} people.`);
    }
    if (op === "close") {
      if (s.status !== "ACTIVE") return { ok: false, message: "Only a live survey can be closed." };
      await prisma.survey.update({ where: { id: s.id }, data: { status: "CLOSED", closedAt: new Date() } });
      await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "Survey", entityId: s.id, summary: `Closed "${s.title}"` });
      return done(["/engage/surveys", `/engage/surveys/${s.id}`], "Closed. No more responses will be accepted.");
    }
    if (op === "delete") {
      if (s.status !== "DRAFT") return { ok: false, message: "A launched survey keeps its responses — close it instead." };
      await prisma.survey.delete({ where: { id: s.id } });
      return done(["/engage/surveys"], "Draft deleted.");
    }
    return { ok: false, message: "Unknown operation." };
  } catch (err) {
    return toErrorState(err);
  }
}

/**
 * Submit a response. On an anonymous survey the response row carries no
 * employee id; only the participant row records that this person answered,
 * so the two cannot be joined.
 */
export async function submitSurveyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can respond." };
  const surveyId = String(formData.get("surveyId"));
  const s = await prisma.survey.findFirst({ where: { id: surveyId, tenantId: viewer.tenantId, kind: { not: "EXIT" } }, include: { questions: { orderBy: { sequence: "asc" } } } });
  if (!s) return { ok: false, message: "Survey not found." };
  if (s.status !== "ACTIVE") return { ok: false, message: "This survey is not open for responses." };
  if (s.closesAt && s.closesAt.getTime() + 86_400_000 <= Date.now()) return { ok: false, message: "This survey has closed." };
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { departmentId: true, status: true } });
  if (s.departmentIds.length && !s.departmentIds.includes(me.departmentId ?? "")) return { ok: false, message: "This survey is not addressed to you." };

  const submitted: SubmittedAnswer[] = s.questions.map((q) => {
    const key = `q_${q.id}`;
    if (q.type === "RATING" || q.type === "NPS") {
      const v = String(formData.get(key) ?? "");
      return { questionId: q.id, score: v === "" ? null : Number(v) };
    }
    if (q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE") {
      return { questionId: q.id, choices: formList(formData, key).map(Number).filter((n) => Number.isInteger(n)) };
    }
    return { questionId: q.id, text: String(formData.get(key) ?? "") };
  });
  const v = validateSubmission(s.questions as QuestionDef[], submitted);
  if (!v.ok) {
    const errors = Object.fromEntries(Object.entries(v.errors).map(([k, m]) => [`q_${k}`, m]));
    return { ok: false, message: "Please answer the highlighted questions.", errors };
  }
  try {
    await prisma.$transaction(async (tx) => {
      // The unique participant row is the guard against answering twice.
      await tx.surveyParticipant.create({ data: { surveyId: s.id, employeeId: viewer.employee!.id } });
      // Random ids rather than the default cuid, which embeds a timestamp
      // that could be matched against the participant row.
      await tx.surveyResponse.create({
        data: {
          id: randomUUID(), surveyId: s.id, employeeId: s.isAnonymous ? null : viewer.employee!.id, departmentId: me.departmentId,
          // An anonymous response is stamped with the day only, so its time cannot be matched to the participant row.
          submittedAt: s.isAnonymous ? new Date(new Date().toISOString().slice(0, 10)) : new Date(),
          answers: { create: v.answers.map((a) => ({ ...a, id: randomUUID() })) },
        },
      });
    });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "You have already responded." };
    return toErrorState(err);
  }
  return done(["/engage/surveys", `/engage/surveys/${s.id}`, "/"], s.kind === "POLL" ? "Vote recorded." : "Thank you — your response has been recorded.");
}
