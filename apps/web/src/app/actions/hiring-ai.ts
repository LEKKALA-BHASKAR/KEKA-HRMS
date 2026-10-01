"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { kitOf, parseRatings, cleanRatings, normaliseDecision, type KitSection } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { aiForViewer, type AiResult } from "@/lib/ai";
import { writeAudit } from "@/lib/forms";
import {
  generateJobDescription, generateInterviewQuestions, draftInterviewFeedback, summarizeFeedback, rephraseSummary, candidateFriendlyFeedback,
} from "@/lib/hire-ai";

/**
 * Hire's AI actions. Every one re-checks who is asking and what they may
 * see, sends the model only the minimum (see lib/hire-ai.ts), and goes
 * through `aiForViewer` — the hourly cap and the AiGeneration log. Without
 * an API key each answers with the honest AI_UNAVAILABLE reason.
 */

const P = PERMISSIONS;
const NO = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Job description for a requisition or a job, from the role's facts alone. */
export async function generateJobDescriptionAction(input: {
  title: string; departmentId?: string | null; minExperienceYears?: number | null; jobType?: string; employmentType?: string | null;
}): Promise<AiResult<string>> {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.REQUISITION_MANAGE, P.JOB_MANAGE])) return NO("You cannot write job descriptions.");
  const title = String(input.title ?? "").trim().slice(0, 120);
  if (title.length < 2) return NO("Select or enter a job title first.");
  const dept = input.departmentId ? await prisma.department.findFirst({ where: { tenantId: viewer.tenantId, id: input.departmentId }, select: { name: true } }) : null;
  const exp = typeof input.minExperienceYears === "number" && input.minExperienceYears >= 0 && input.minExperienceYears <= 50 ? input.minExperienceYears : null;
  const jd = { title, department: dept?.name ?? null, minExperienceYears: exp, jobType: input.jobType === "PART_TIME" ? "PART_TIME" : "FULL_TIME", employmentType: input.employmentType ?? null };
  return aiForViewer(viewer, { feature: "HIRE_JD", inputChars: JSON.stringify(jd).length }, () => generateJobDescription(jd));
}

/**
 * Interview questions for chosen skills of one scorecard section. Limited
 * per job section (Keka: "only twice per section in a scorecard"), and kept
 * so the whole panel sees them.
 */
export async function generateQuestionsAction(input: { jobId: string; section: string; skills: string[] }): Promise<AiResult<{ questions: Array<{ skill: string; questions: string[] }>; used: number; max: number }>> {
  const viewer = await requireViewer();
  const job = await prisma.job.findFirst({ where: { id: String(input.jobId), tenantId: viewer.tenantId }, select: { id: true, title: true, requirements: true, scorecardTemplate: true } });
  if (!job) return NO("Job not found.");
  const onPanel = viewer.employee
    ? (await prisma.interviewPanelist.count({ where: { employeeId: viewer.employee.id, interview: { application: { jobId: job.id } } } })) > 0
    : false;
  if (!canAny(viewer, [P.JOB_MANAGE, P.INTERVIEW_MANAGE]) && !onPanel) return NO("Only the hiring team for this job can generate questions.");
  const kit: KitSection[] = kitOf(job.scorecardTemplate);
  const section = kit.find((k) => k.section === input.section);
  if (!section) return NO("That scorecard section does not exist.");
  const chosen = section.skills.filter((sk) => (input.skills ?? []).includes(sk.name)).slice(0, 6);
  if (chosen.length === 0) return NO("Select at least one skill.");
  const [setting, used] = await Promise.all([
    prisma.hiringSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { aiQuestionAttempts: true } }),
    prisma.interviewQuestionSet.count({ where: { jobId: job.id, section: section.section } }),
  ]);
  const max = setting?.aiQuestionAttempts ?? 2;
  if (used >= max) return NO(`Questions can be generated only ${max === 2 ? "twice" : `${max} times`} per section in a scorecard.`);
  const payload = { jobTitle: job.title, section: section.section, skills: chosen.map((c) => ({ name: c.name, description: c.description ?? null })), requirements: job.requirements };
  const res = await aiForViewer(viewer, { feature: "HIRE_QUESTIONS", subjectId: job.id, inputChars: JSON.stringify(payload).length }, () => generateInterviewQuestions(payload));
  if (!res.ok) return res;
  try {
    await prisma.interviewQuestionSet.create({ data: { tenantId: viewer.tenantId, jobId: job.id, section: section.section, attempt: used + 1, questions: res.value, createdById: viewer.user.id } });
  } catch {
    return NO("Someone generated questions for this section at the same moment. Reopen to see them.");
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "InterviewQuestionSet", entityId: job.id, summary: `Generated interview questions (AI) for ${section.section}` });
  return { ok: true, value: { questions: res.value, used: used + 1, max } };
}

/** Polished first-person feedback from the panellist's own ratings and rough notes. */
export async function draftFeedbackAction(input: { interviewId: string; decision: string | null; ratings: unknown; notes: string }): Promise<AiResult<string>> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record linked to this login.");
  const iv = await prisma.interview.findFirst({
    where: { id: String(input.interviewId), application: { tenantId: viewer.tenantId }, panel: { some: { employeeId: viewer.employee.id } } },
    select: { id: true, application: { select: { job: { select: { scorecardTemplate: true } } } } },
  });
  if (!iv) return NO("Only this interview's panel can draft its feedback.");
  const ratings = cleanRatings(input.ratings, kitOf(iv.application.job.scorecardTemplate));
  const notes = String(input.notes ?? "").slice(0, 3000);
  if (!ratings.length && notes.trim().length < 10) return NO("Rate a few skills or jot some rough notes first — the draft is built only from what you wrote.");
  const payload = { decision: normaliseDecision(input.decision), ratings, notes };
  return aiForViewer(viewer, { feature: "HIRE_FEEDBACK_DRAFT", subjectId: iv.id, inputChars: JSON.stringify(payload).length }, () => draftInterviewFeedback(payload));
}

/** The panel's submitted feedback, summarised. Interviewers travel as "Interviewer n". */
export async function summarizeFeedbackAction(input: { applicationId: string }): Promise<AiResult<{ summary: string; individual: Array<{ panelistId: string; name: string; text: string }> }>> {
  const viewer = await requireViewer();
  if (!can(viewer, P.CANDIDATE_MANAGE)) return NO("Only recruiters can summarise feedback.");
  const app = await prisma.application.findFirst({
    where: { id: String(input.applicationId), tenantId: viewer.tenantId },
    select: { id: true, interviews: { orderBy: { scheduledAt: "asc" }, select: { title: true, round: true, scorecards: { where: { status: "SUBMITTED" }, orderBy: { submittedAt: "asc" } }, panel: { select: { employeeId: true, employee: { select: { displayName: true } } } } } } },
  });
  if (!app) return NO("Candidate not found.");
  const cards = app.interviews.flatMap((iv) => iv.scorecards.map((sc) => ({ iv, sc })));
  if (cards.length === 0) return NO("There is no submitted feedback to summarise yet.");
  const refs = new Map<string, string>();
  const names = new Map(app.interviews.flatMap((iv) => iv.panel.map((p) => [p.employeeId, p.employee.displayName] as const)));
  const payload = cards.map(({ iv, sc }) => {
    if (!refs.has(sc.panelistId)) refs.set(sc.panelistId, `Interviewer ${refs.size + 1}`);
    const notes = [sc.notes, sc.strengths ? `Strengths: ${sc.strengths}` : null, sc.concerns ? `Concerns: ${sc.concerns}` : null].filter(Boolean).join("\n");
    return { ref: refs.get(sc.panelistId)!, round: `Round ${iv.round}: ${iv.title}`, decision: normaliseDecision(sc.recommendation), ratings: parseRatings(sc.ratings), notes: notes || null };
  });
  const res = await aiForViewer(viewer, { feature: "HIRE_SUMMARY", subjectId: app.id, inputChars: JSON.stringify(payload).length }, () => summarizeFeedback(payload));
  if (!res.ok) return res;
  const byRef = new Map([...refs.entries()].map(([id, ref]) => [ref, id]));
  return {
    ok: true,
    value: {
      summary: res.value.summary,
      individual: res.value.individual.map((i) => ({ panelistId: byRef.get(i.ref)!, name: names.get(byRef.get(i.ref)!) ?? i.ref, text: i.text })).filter((i) => i.panelistId),
    },
  };
}

export async function rephraseSummaryAction(input: { applicationId: string; text: string }): Promise<AiResult<string>> {
  const viewer = await requireViewer();
  if (!can(viewer, P.CANDIDATE_MANAGE)) return NO("Only recruiters can rephrase feedback.");
  if (!(await prisma.application.count({ where: { id: String(input.applicationId), tenantId: viewer.tenantId } }))) return NO("Candidate not found.");
  const text = String(input.text ?? "").trim();
  if (text.length < 20) return NO("There is nothing to rephrase yet.");
  return aiForViewer(viewer, { feature: "HIRE_REPHRASE", subjectId: String(input.applicationId), inputChars: Math.min(text.length, 4000) }, () => rephraseSummary(text));
}

/** Feedback fit to share with the candidate, from the saved summary only. */
export async function candidateFeedbackAction(input: { applicationId: string }): Promise<AiResult<string>> {
  const viewer = await requireViewer();
  if (!can(viewer, P.CANDIDATE_MANAGE)) return NO("Only recruiters can prepare candidate feedback.");
  const app = await prisma.application.findFirst({ where: { id: String(input.applicationId), tenantId: viewer.tenantId }, select: { id: true, feedbackSummary: true } });
  if (!app) return NO("Candidate not found.");
  if (!app.feedbackSummary) return NO("Summarize and confirm the panel's feedback first.");
  const summary = app.feedbackSummary;
  return aiForViewer(viewer, { feature: "HIRE_CANDIDATE_FEEDBACK", subjectId: app.id, inputChars: Math.min(summary.length, 4000) }, () => candidateFriendlyFeedback(summary));
}
