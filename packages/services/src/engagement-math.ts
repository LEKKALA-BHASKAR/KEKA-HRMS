/**
 * Pure survey arithmetic — no database. Scoring a 1–5 agreement scale, eNPS
 * on 0–10, choice tallies, engagement driver scores, and the anonymity rule
 * that withholds any result drawn from too few people.
 */

export type SurveyQuestionType = "RATING" | "NPS" | "SINGLE_CHOICE" | "MULTI_CHOICE" | "TEXT";

export interface AnswerRow {
  questionId: string;
  score: number | null;
  choices: number[];
  text: string | null;
  /** The respondent's department at the time, for breakdowns. */
  departmentId?: string | null;
}

export interface QuestionDef {
  id: string;
  type: SurveyQuestionType;
  prompt: string;
  driver: string | null;
  options: string[];
  required: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Promoters 9–10, passives 7–8, detractors 0–6. eNPS = %promoters − %detractors. */
export function enps(scores: number[]): { score: number; promoters: number; passives: number; detractors: number; n: number } {
  const n = scores.length;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  const passives = n - promoters - detractors;
  const score = n === 0 ? 0 : Math.round(((promoters - detractors) / n) * 100);
  return { score, promoters, passives, detractors, n };
}

/**
 * A 1–5 rating summarised the way engagement tools do: the mean, and the
 * share who agreed (4 or 5) and disagreed (1 or 2). "Favourable" is the
 * headline because a mean of 3.4 hides whether people are split or lukewarm.
 */
export function ratingSummary(scores: number[]) {
  const n = scores.length;
  const dist = [1, 2, 3, 4, 5].map((v) => scores.filter((s) => s === v).length);
  const mean = n === 0 ? 0 : r1(scores.reduce((s, x) => s + x, 0) / n);
  const favourable = n === 0 ? 0 : Math.round(((dist[3] + dist[4]) / n) * 100);
  const unfavourable = n === 0 ? 0 : Math.round(((dist[0] + dist[1]) / n) * 100);
  return { n, mean, favourable, neutral: n === 0 ? 0 : 100 - favourable - unfavourable, unfavourable, distribution: dist };
}

/** Votes per option. A multi-choice respondent counts once per option ticked. */
export function choiceTally(options: string[], answers: Array<{ choices: number[] }>) {
  const counts = options.map(() => 0);
  let respondents = 0;
  for (const a of answers) {
    const valid = [...new Set(a.choices)].filter((c) => c >= 0 && c < options.length);
    if (valid.length === 0) continue;
    respondents++;
    for (const c of valid) counts[c]++;
  }
  return options.map((label, i) => ({
    label, count: counts[i],
    percent: respondents === 0 ? 0 : Math.round((counts[i] / respondents) * 100),
  }));
}

/**
 * Score per engagement driver: the favourable share across every rating
 * question tagged with that driver.
 */
export function driverScores(questions: QuestionDef[], answers: AnswerRow[]) {
  const byDriver = new Map<string, number[]>();
  const qById = new Map(questions.map((q) => [q.id, q]));
  for (const a of answers) {
    const q = qById.get(a.questionId);
    if (!q || q.type !== "RATING" || !q.driver || a.score === null) continue;
    const list = byDriver.get(q.driver) ?? [];
    list.push(a.score);
    byDriver.set(q.driver, list);
  }
  return [...byDriver.entries()]
    .map(([driver, scores]) => ({ driver, ...ratingSummary(scores) }))
    .sort((a, b) => b.favourable - a.favourable);
}

/**
 * The anonymity rule: a result is shown only when at least `minGroupSize`
 * people contributed to it. Applied to the whole survey and to every
 * department slice separately.
 */
export function canReveal(respondents: number, minGroupSize: number): boolean {
  return respondents >= Math.max(1, minGroupSize);
}

export interface SubmittedAnswer {
  questionId: string;
  score?: number | null;
  choices?: number[];
  text?: string | null;
}

/**
 * Validate a submission against the questions. Returns per-question errors
 * keyed by question id, and the cleaned answers to store.
 */
export function validateSubmission(questions: QuestionDef[], submitted: SubmittedAnswer[]) {
  const errors: Record<string, string> = {};
  const clean: Array<{ questionId: string; score: number | null; choices: number[]; text: string | null }> = [];
  const byQ = new Map(submitted.map((s) => [s.questionId, s]));
  for (const q of questions) {
    const s = byQ.get(q.id);
    const score = s?.score ?? null;
    const choices = [...new Set(s?.choices ?? [])];
    const text = s?.text?.trim() ? s.text.trim().slice(0, 2000) : null;
    const empty = score === null && choices.length === 0 && !text;
    if (empty) {
      if (q.required) errors[q.id] = "Please answer this question";
      continue;
    }
    switch (q.type) {
      case "RATING":
        if (score === null || !Number.isInteger(score) || score < 1 || score > 5) { errors[q.id] = "Choose 1 to 5"; continue; }
        clean.push({ questionId: q.id, score, choices: [], text: null });
        break;
      case "NPS":
        if (score === null || !Number.isInteger(score) || score < 0 || score > 10) { errors[q.id] = "Choose 0 to 10"; continue; }
        clean.push({ questionId: q.id, score, choices: [], text: null });
        break;
      case "SINGLE_CHOICE":
        if (choices.length !== 1 || choices[0] < 0 || choices[0] >= q.options.length) { errors[q.id] = "Choose one option"; continue; }
        clean.push({ questionId: q.id, score: null, choices, text: null });
        break;
      case "MULTI_CHOICE":
        if (choices.some((c) => c < 0 || c >= q.options.length)) { errors[q.id] = "Choose from the options given"; continue; }
        clean.push({ questionId: q.id, score: null, choices: choices.sort((a, b) => a - b), text: null });
        break;
      case "TEXT":
        clean.push({ questionId: q.id, score: null, choices: [], text });
        break;
    }
  }
  return { errors, answers: clean, ok: Object.keys(errors).length === 0 };
}

/** Participation as a share of those invited. */
export function participation(responded: number, invited: number): number {
  return invited === 0 ? 0 : Math.round((responded / invited) * 100);
}

/** Standard engagement driver set used by the templates. */
export const ENGAGEMENT_DRIVERS = [
  "Recognition", "Growth", "Manager", "Wellbeing", "Alignment", "Peers", "Autonomy", "Communication",
] as const;
