import "server-only";
import { aiText, aiJson, type AiResult } from "./ai";
import { validateQuestionSet, validateSummary, decisionLabel } from "@keka/services";

/**
 * The prompts behind Hire's AI. Each takes only what its task needs — a
 * role's title and requirements, a scorecard's ratings and notes — and never
 * a candidate's name, contact details, pay, employer or résumé. Interviewers
 * are sent as "Interviewer n"; the caller maps them back.
 */

const GUARD = "Never invent facts that are not in the input. Never mention or infer age, gender, religion, caste, marital status, disability, nationality or any other protected characteristic.";

export interface JdInput {
  title: string; department: string | null; minExperienceYears: number | null; jobType: string; employmentType: string | null; workMode?: string | null; skills?: string[];
}

export function generateJobDescription(i: JdInput): Promise<AiResult<string>> {
  const facts = [
    `Job title: ${i.title}`,
    i.department ? `Department: ${i.department}` : null,
    i.minExperienceYears !== null ? `Minimum experience: ${i.minExperienceYears} years` : null,
    `Job type: ${i.jobType.replace("_", " ").toLowerCase()}`,
    i.employmentType ? `Employment type: ${i.employmentType.toLowerCase()}` : null,
    i.workMode ? `Work mode: ${i.workMode.toLowerCase()}` : null,
    i.skills?.length ? `Key skills: ${i.skills.join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return aiText({
    system: `You write clear, inclusive job descriptions for an Indian company's internal hiring requisition. Write in Markdown with exactly these sections, each a "**Heading:**" line followed by bullets: "About the role" (2-3 sentences, no bullets), "Your responsibilities" (6-8 bullets), "Skill sets/Experience we require" (5-7 bullets), "Nice to have" (2-4 bullets). Do not mention salary, benefits, the company's name or claims about the company. Use gender-neutral language. ${GUARD}`,
    prompt: facts,
    maxTokens: 900,
  });
}

export interface QuestionInput { jobTitle: string; section: string; skills: Array<{ name: string; description: string | null }>; requirements: string | null }

export function generateInterviewQuestions(i: QuestionInput): Promise<AiResult<Array<{ skill: string; questions: string[] }>>> {
  const skills = i.skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n");
  return aiJson({
    system: `You help interviewers prepare structured interviews. For each skill listed, write 4 or 5 open, behavioural or situational interview questions that let a candidate show evidence of that skill for the given role. Questions must be job-related, answerable by any qualified candidate, under 300 characters each, and distinct. ${GUARD} Return JSON of the shape {"skills":[{"skill":"<exact skill name>","questions":["..."]}]} with one entry per listed skill, in the same order.`,
    prompt: `Role: ${i.jobTitle}\nScorecard section: ${i.section}\nSkills:\n${skills}${i.requirements ? `\n\nRole requirements (for context):\n${i.requirements.slice(0, 1500)}` : ""}`,
    maxTokens: 1600,
    validate: (v) => validateQuestionSet(v, i.skills.map((s) => s.name)),
  });
}

export interface FeedbackDraftInput {
  decision: string | null;
  ratings: Array<{ section: string; skill: string; rating: number | null; comment: string | null }>;
  notes: string;
}

export function draftInterviewFeedback(i: FeedbackDraftInput): Promise<AiResult<string>> {
  const rated = i.ratings.map((r) => `- ${r.section} › ${r.skill}: ${r.rating === null ? "N/A" : `${r.rating}/5`}${r.comment ? ` — ${r.comment}` : ""}`).join("\n");
  return aiText({
    system: `You turn an interviewer's own ratings and rough notes into polished interview feedback, written in the first person as that interviewer. Be specific and evidence-based, balanced (strengths, then concerns), and under 220 words. Use only what the interviewer wrote; if something is not in the notes, leave it out. Refer to the candidate as "the candidate". Plain text with short paragraphs. ${GUARD}`,
    prompt: `My recommendation: ${i.decision ? decisionLabel(i.decision) : "not chosen yet"}\nMy ratings:\n${rated || "(none)"}\nMy rough notes:\n${i.notes.slice(0, 3000) || "(none)"}`,
    maxTokens: 600,
  });
}

export interface SummaryCard {
  ref: string; round: string; decision: string | null; ratings: Array<{ section: string; skill: string; rating: number | null; comment: string | null }>; notes: string | null;
}

export function summarizeFeedback(cards: SummaryCard[]): Promise<AiResult<{ summary: string; individual: Array<{ ref: string; text: string }> }>> {
  const body = cards.map((c) => [
    `${c.ref} — ${c.round} — decision: ${c.decision ? decisionLabel(c.decision) : "none"}`,
    ...c.ratings.map((r) => `  ${r.section} › ${r.skill}: ${r.rating === null ? "N/A" : `${r.rating}/5`}${r.comment ? ` — ${r.comment}` : ""}`),
    c.notes ? `  Feedback: ${c.notes.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  return aiJson({
    system: `You summarise an interview panel's feedback on one candidate for the hiring team. Write "summary": 80-150 words covering where the panel agrees, where it disagrees, the main strengths and the main risks — no hire/no-hire verdict beyond what the panel said. Then "individual": one sentence per interviewer, keyed by the exact "ref" given (e.g. "Interviewer 1"). Refer to the candidate as "the candidate". ${GUARD} Return JSON {"summary":"...","individual":[{"ref":"Interviewer 1","text":"..."}]}.`,
    prompt: body,
    maxTokens: 900,
    validate: (v) => validateSummary(v, cards.map((c) => c.ref)),
  });
}

export function rephraseSummary(text: string): Promise<AiResult<string>> {
  return aiText({
    system: `Rewrite this hiring-panel feedback summary with better tone, clarity and structure. Keep every fact and judgement; add nothing new; keep it about the same length. Plain text only. ${GUARD}`,
    prompt: text.slice(0, 4000),
    maxTokens: 700,
  });
}

export function candidateFriendlyFeedback(summary: string): Promise<AiResult<string>> {
  return aiText({
    system: `Turn an internal interview-panel summary into constructive feedback that can be shared with the candidate. Write in the second person ("you"), warm and specific, under 150 words: what went well, then one or two areas to develop. Do not include scores, interviewer names or references to individual interviewers, internal deliberation, or any hiring decision. Plain text. ${GUARD}`,
    prompt: summary.slice(0, 4000),
    maxTokens: 400,
  });
}
