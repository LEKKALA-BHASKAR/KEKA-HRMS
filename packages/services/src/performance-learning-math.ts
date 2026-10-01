/**
 * Pure arithmetic for Perform (goal timeframes, the goals page's status
 * buckets, the average-progress line) and Learn (grading, course progress,
 * durations, question checks), plus the validators every AI answer passes
 * through before anyone sees it. No database here, so all of it is unit-tested.
 */

// ---------------------------------------------------------------------------
//  Goal timeframes — the financial year in quarters, halves and years
// ---------------------------------------------------------------------------

export type TimeframeKind = "QUARTER" | "HALF_YEAR" | "YEAR";
export interface Timeframe { kind: TimeframeKind; label: string; start: Date; end: Date }

const utc = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d));
const fyTag = (startYear: number) => `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;

/** The FY start year a date falls in (April-start by default). */
function fyOf(on: Date, fyStartMonth: number): number {
  return on.getUTCMonth() + 1 >= fyStartMonth ? on.getUTCFullYear() : on.getUTCFullYear() - 1;
}

/** Months since the FY started, 0–11. */
function fyMonthIndex(on: Date, fyStartMonth: number): number {
  return (on.getUTCMonth() - (fyStartMonth - 1) + 12) % 12;
}

/** The quarter, half or year a date falls in: "Q3 2026-27", "H2 2026-27", "FY 2026-27". */
export function timeframeFor(kind: TimeframeKind, on: Date, fyStartMonth = 4): Timeframe {
  const fy = fyOf(on, fyStartMonth);
  const idx = fyMonthIndex(on, fyStartMonth);
  const span = kind === "QUARTER" ? 3 : kind === "HALF_YEAR" ? 6 : 12;
  const n = Math.floor(idx / span); // 0-based period within the FY
  const startMonth0 = fyStartMonth - 1 + n * span;
  const start = utc(fy, startMonth0, 1);
  const end = utc(fy, startMonth0 + span, 0); // day 0 = last day of the previous month
  const label = kind === "QUARTER" ? `Q${n + 1} ${fyTag(fy)}` : kind === "HALF_YEAR" ? `H${n + 1} ${fyTag(fy)}` : `FY ${fyTag(fy)}`;
  return { kind, label, start, end };
}

/**
 * The timeframes a goal can be set for: every quarter, half and the year of
 * the current financial year and the next one, in date order.
 */
export function timeframeOptions(today: Date, fyStartMonth = 4): Timeframe[] {
  const fy = fyOf(today, fyStartMonth);
  const out: Timeframe[] = [];
  for (const year of [fy, fy + 1]) {
    const first = utc(year, fyStartMonth - 1, 1);
    out.push(timeframeFor("YEAR", first, fyStartMonth));
    for (let h = 0; h < 2; h++) out.push(timeframeFor("HALF_YEAR", utc(year, fyStartMonth - 1 + h * 6, 1), fyStartMonth));
    for (let q = 0; q < 4; q++) out.push(timeframeFor("QUARTER", utc(year, fyStartMonth - 1 + q * 3, 1), fyStartMonth));
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
}

/** The label of the period a goal's dates cover exactly, else its due date's FY. */
export function timeframeOfDates(start: Date, due: Date, fyStartMonth = 4): string {
  for (const kind of ["QUARTER", "HALF_YEAR", "YEAR"] as const) {
    const t = timeframeFor(kind, start, fyStartMonth);
    if (sameDay(t.start, start) && sameDay(t.end, due)) return t.label;
  }
  return timeframeFor("YEAR", due, fyStartMonth).label;
}

/** Parse a stored label back into its dates, for ordering and "past" checks. */
export function parseTimeframe(label: string, fyStartMonth = 4): Timeframe | null {
  const m = /^(Q([1-4])|H([12])|FY) (\d{4})-\d{2}$/.exec(label.trim());
  if (!m) return null;
  const fy = Number(m[4]);
  const kind: TimeframeKind = m[2] ? "QUARTER" : m[3] ? "HALF_YEAR" : "YEAR";
  const n = Number(m[2] ?? m[3] ?? 1) - 1;
  const span = kind === "QUARTER" ? 3 : kind === "HALF_YEAR" ? 6 : 12;
  return timeframeFor(kind, utc(fy, fyStartMonth - 1 + n * span, 1), fyStartMonth);
}

const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
//  The goals page: status buckets and the average-progress line
// ---------------------------------------------------------------------------

export type GoalBucket = "DRAFT" | "NOT_STARTED" | "ON_TRACK" | "NEEDS_ATTENTION" | "AT_RISK" | "CLOSED";

/**
 * Keka's "Goal by status" buckets. A live goal nobody has checked in on yet is
 * "not started"; completed, missed and cancelled goals are all "closed".
 */
export function goalBucket(g: { status: string; progressPercent: number; checkIns: number }): GoalBucket {
  if (g.status === "DRAFT") return "DRAFT";
  if (["COMPLETED", "MISSED", "CANCELLED"].includes(g.status)) return "CLOSED";
  if (g.checkIns === 0 && g.progressPercent <= 0) return "NOT_STARTED";
  if (g.status === "AT_RISK") return "AT_RISK";
  if (g.status === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  return "ON_TRACK";
}

/**
 * Average progress across goals at `points` evenly spaced dates from `from`
 * to `to`: each goal counts the latest check-in on or before the date (0
 * before its first). Feeds the small line on the goals page.
 */
export function progressSeries(
  goals: Array<{ checkIns: Array<{ at: Date; progress: number }> }>,
  from: Date, to: Date, points = 6,
): Array<{ at: Date; value: number }> {
  const out: Array<{ at: Date; value: number }> = [];
  if (points < 2) points = 2;
  const span = Math.max(0, to.getTime() - from.getTime());
  for (let i = 0; i < points; i++) {
    const at = new Date(from.getTime() + (span * i) / (points - 1));
    if (goals.length === 0) { out.push({ at, value: 0 }); continue; }
    const sum = goals.reduce((s, g) => {
      let v = 0;
      for (const c of g.checkIns) if (c.at.getTime() <= at.getTime()) v = c.progress;
      return s + v;
    }, 0);
    out.push({ at, value: Math.round((sum / goals.length) * 100) / 100 });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Learn
// ---------------------------------------------------------------------------

export type QuestionKind = "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "TRUE_FALSE";
export type QuestionOption = { id: string; text: string };
export interface QuestionInput { type: QuestionKind; prompt: string; options: QuestionOption[]; correctOptionIds: string[] }

/** "2h 49m", "0h 00m" — Keka's course-structure duration. */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole-number percent of modules completed. */
export function courseProgress(totalModules: number, completedModules: number): number {
  if (totalModules <= 0) return 0;
  return Math.min(100, Math.round((Math.min(completedModules, totalModules) / totalModules) * 100));
}

/**
 * Score an attempt. A question counts only when the chosen options are exactly
 * the correct set — picking every option of a multiple-choice question earns
 * nothing.
 */
export function gradeAttempt(
  questions: Array<{ id: string; correctOptionIds: string[] }>,
  answers: Record<string, string[] | undefined>,
): { correct: number; total: number; percent: number } {
  let correct = 0;
  for (const q of questions) {
    const want = new Set(q.correctOptionIds);
    const got = new Set(answers[q.id] ?? []);
    if (want.size > 0 && want.size === got.size && [...want].every((id) => got.has(id))) correct++;
  }
  const total = questions.length;
  return { correct, total, percent: total === 0 ? 0 : Math.round((correct / total) * 10000) / 100 };
}

/** What is wrong with a question, or null when it can be saved. */
export function validateQuestion(q: QuestionInput): string | null {
  if (!q.prompt.trim()) return "Type the question.";
  if (q.prompt.length > 1000) return "Keep the question under 1,000 characters.";
  const opts = q.options.filter((o) => o.text.trim());
  if (q.type === "TRUE_FALSE" && opts.length !== 2) return "A true/false question has exactly two options.";
  if (opts.length < 2) return "Add at least two options.";
  if (opts.length > 6) return "Use at most six options.";
  if (new Set(opts.map((o) => o.text.trim().toLowerCase())).size !== opts.length) return "Two options say the same thing.";
  if (opts.some((o) => o.text.length > 300)) return "Keep each option under 300 characters.";
  const ids = new Set(opts.map((o) => o.id));
  const correct = q.correctOptionIds.filter((id) => ids.has(id));
  if (correct.length === 0) return "Mark the correct answer.";
  if (q.type !== "MULTIPLE_CHOICE" && correct.length !== 1) return "A single-choice question has exactly one correct answer.";
  return null;
}

/**
 * Bulk upload: `question, type, option 1 … option 6, correct` per line, where
 * type is single/multiple/true-false and correct is the option number(s),
 * separated by `;` (e.g. `2` or `1;3`). A header row is skipped.
 */
export function parseQuestionCsv(text: string): { questions: QuestionInput[]; errors: string[] } {
  const questions: QuestionInput[] = [];
  const errors: string[] = [];
  const lines = splitCsv(text);
  lines.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    if (i === 0 && /^question$/i.test(cells[0]?.trim() ?? "")) return;
    const [prompt = "", rawType = "", ...rest] = cells;
    const correctRaw = rest.length ? rest[rest.length - 1] : "";
    const optionTexts = rest.slice(0, -1).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const t = rawType.trim().toLowerCase();
    const type: QuestionKind = t.startsWith("multi") ? "MULTIPLE_CHOICE" : t.startsWith("true") ? "TRUE_FALSE" : "SINGLE_CHOICE";
    const options = optionTexts.map((text, k) => ({ id: `o${k + 1}`, text }));
    const correctOptionIds = correctRaw.split(/[;|]/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length).map((n) => `o${n}`);
    const q: QuestionInput = { type, prompt: prompt.trim(), options, correctOptionIds };
    const problem = validateQuestion(q);
    if (problem) errors.push(`Line ${i + 1}: ${problem}`);
    else questions.push(q);
  });
  return { questions, errors };
}

/** RFC-4180-ish: commas, double-quoted fields, doubled quotes inside them. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
//  AI answer shapes — a malformed answer is a failure, never something shown
// ---------------------------------------------------------------------------

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** A 1:1 agenda: 3 to 8 short items. */
export function parseAgendaItems(v: unknown): string[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : null;
  if (!list) return null;
  const items = list.map((x) => str(x, 160)).filter((x): x is string => !!x).map((x) => x.replace(/^[-•*\d.)\s]+/, "")).filter(Boolean).slice(0, 8);
  return items.length >= 3 ? items : null;
}

export interface MeetingSummaryShape {
  summary: string;
  decisions: string[];
  actionItems: Array<{ description: string; owner: "MANAGER" | "REPORT"; dueInDays: number | null }>;
}

/** A 1:1 summary with decisions and suggested action items. */
export function parseMeetingSummary(v: unknown): MeetingSummaryShape | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const summary = str(o.summary, 700);
  if (!summary) return null;
  const decisions = (Array.isArray(o.decisions) ? o.decisions : []).map((d) => str(d, 200)).filter((d): d is string => !!d).slice(0, 5);
  const actionItems = (Array.isArray(o.actionItems) ? o.actionItems : []).flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const x = a as Record<string, unknown>;
    const description = str(x.description, 160);
    if (!description) return [];
    const owner = x.owner === "REPORT" ? "REPORT" as const : "MANAGER" as const;
    const due = Number(x.dueInDays);
    return [{ description, owner, dueInDays: Number.isInteger(due) && due >= 1 && due <= 60 ? due : null }];
  }).slice(0, 6);
  return { summary, decisions, actionItems };
}

export interface GoalSuggestionShape {
  title: string; description: string | null;
  metricType: "PERCENTAGE" | "COMPLETION" | "NUMBER_INCREASE" | "NUMBER_DECREASE" | "CURRENCY";
  startValue: number | null; targetValue: number | null; metricName: string | null;
  alignsTo: number | null;
}

const METRICS = new Set(["PERCENTAGE", "COMPLETION", "NUMBER_INCREASE", "NUMBER_DECREASE", "CURRENCY"]);

/** Goal suggestions: up to 5, with a metric that makes sense for each. */
export function parseGoalSuggestions(v: unknown, alignable: number): GoalSuggestionShape[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { goals?: unknown }).goals) ? (v as { goals: unknown[] }).goals : null;
  if (!list) return null;
  const seen = new Set<string>();
  const out: GoalSuggestionShape[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const title = str(o.title, 90);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    let metricType = typeof o.metricType === "string" && METRICS.has(o.metricType) ? o.metricType as GoalSuggestionShape["metricType"] : "PERCENTAGE";
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
    let startValue = num(o.startValue), targetValue = num(o.targetValue);
    if (metricType === "NUMBER_INCREASE" || metricType === "CURRENCY") {
      if (startValue === null || targetValue === null || !(targetValue > startValue)) { metricType = "PERCENTAGE"; startValue = targetValue = null; }
    } else if (metricType === "NUMBER_DECREASE") {
      if (startValue === null || targetValue === null || !(targetValue < startValue)) { metricType = "PERCENTAGE"; startValue = targetValue = null; }
    } else { startValue = targetValue = null; }
    const align = num(o.alignsTo);
    out.push({
      title, description: str(o.description, 240), metricType, startValue, targetValue,
      metricName: metricType.startsWith("NUMBER") ? str(o.metricName, 40) : null,
      alignsTo: align !== null && Number.isInteger(align) && align >= 0 && align < alignable ? align : null,
    });
    if (out.length === 5) break;
  }
  return out.length ? out : null;
}

/** Generated assessment questions, checked like hand-written ones. */
export function parseGeneratedQuestions(v: unknown, type: QuestionKind, count: number): QuestionInput[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { questions?: unknown }).questions) ? (v as { questions: unknown[] }).questions : null;
  if (!list) return null;
  const out: QuestionInput[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const prompt = str(o.prompt ?? o.question, 300);
    const texts = type === "TRUE_FALSE" ? ["True", "False"] : (Array.isArray(o.options) ? o.options : []).map((x) => str(x, 300)).filter((x): x is string => !!x).slice(0, 6);
    const options = texts.map((text, k) => ({ id: `o${k + 1}`, text }));
    const correctRaw = Array.isArray(o.correct) ? o.correct : o.correct !== undefined ? [o.correct] : [];
    // Indices may come 0- or 1-based; the prompt asks for 1-based.
    const correctOptionIds = correctRaw.map((c) => Number(c)).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length).map((n) => `o${n}`);
    const q: QuestionInput = { type, prompt: prompt ?? "", options, correctOptionIds: [...new Set(correctOptionIds)] };
    if (validateQuestion(q) === null) out.push(q);
    if (out.length === count) break;
  }
  return out.length ? out : null;
}
