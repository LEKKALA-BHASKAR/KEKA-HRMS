/**
 * Pure rules behind the core HR workflows: when an approved job change is
 * due, who an event's email goes to once an admin has changed its settings,
 * when a scheduled report next runs, CSV that is safe to open in a
 * spreadsheet, and the exit survey roll-up. No database.
 */

const DAY = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// ---------------------------------------------------------------------------
//  Job changes
// ---------------------------------------------------------------------------

/** A change takes effect on its effective date: due once that day has begun (UTC). */
export function jobChangeDue(effectiveFrom: Date, today: Date = new Date()): boolean {
  return utcDay(effectiveFrom) <= utcDay(today);
}

/** The day before a new job record starts, which is where the open one closes. */
export function dayBefore(d: Date): Date {
  return new Date(utcDay(d) - DAY);
}

// ---------------------------------------------------------------------------
//  Notification settings
// ---------------------------------------------------------------------------

export type RecipientGroup = "EMPLOYEE" | "MANAGER" | "HR";
export const RECIPIENT_GROUPS: RecipientGroup[] = ["EMPLOYEE", "MANAGER", "HR"];

export interface EmailSettingLike {
  emailEnabled: boolean;
  recipients: string[];
  customEmails: string[];
}

export type EmailPlan =
  | { send: false }
  /** `useCallSite`: email exactly the users the event chose, as before. */
  | { send: true; useCallSite: true; groups: []; customEmails: string[] }
  | { send: true; useCallSite: false; groups: RecipientGroup[]; customEmails: string[] };

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What an event's email should do. With no setting the event behaves as it
 * always has. When the admin leaves the recipients at the event's defaults
 * (or the event has no single employee to resolve groups from) the event's
 * own recipient list is kept, so turning on a custom address never changes
 * who else is mailed.
 */
export function planEmail(setting: EmailSettingLike | null, defaults: RecipientGroup[], configurable: boolean): EmailPlan {
  if (!setting) return { send: true, useCallSite: true, groups: [], customEmails: [] };
  if (!setting.emailEnabled) return { send: false };
  const customEmails = cleanEmails(setting.customEmails);
  const groups = setting.recipients.filter((r): r is RecipientGroup => (RECIPIENT_GROUPS as string[]).includes(r));
  if (!configurable || sameSet(groups, defaults)) return { send: true, useCallSite: true, groups: [], customEmails };
  return { send: true, useCallSite: false, groups, customEmails };
}

/** Addresses typed into a box: split on commas, semicolons and spaces; lower-cased, valid, unique. */
export function cleanEmails(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : input.split(/[,;\s]+/)).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set(parts.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

/** The entries in a typed list that are not email addresses, to report back. */
export function invalidEmails(input: string): string[] {
  return input.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

// ---------------------------------------------------------------------------
//  Scheduled reports
// ---------------------------------------------------------------------------

export type Cadence = "DAILY" | "WEEKLY" | "MONTHLY";

/**
 * The next send after `from`, at 09:00 IST (03:30 UTC). Weekly takes the day
 * as stored by the schedulers (0–6 with Sunday 0, or 7 for Sunday); monthly
 * days are capped at 28 so every month has one. Always strictly after
 * `from`'s day, so a run that is late never sends twice.
 */
export function nextReportRun(frequency: Cadence, dayOfWeek: number | null, dayOfMonth: number | null, from: Date = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 3, 30));
  if (frequency === "DAILY") { d.setUTCDate(d.getUTCDate() + 1); return d; }
  if (frequency === "WEEKLY") {
    const want = (dayOfWeek ?? 1) % 7;
    do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== want);
    return d;
  }
  const dom = Math.min(28, Math.max(1, dayOfMonth ?? 1));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() >= dom ? 1 : 0), dom, 3, 30));
}

// ---------------------------------------------------------------------------
//  CSV
// ---------------------------------------------------------------------------

/**
 * One CSV field. Spreadsheet apps execute cells that start with = + - @, so
 * those are prefixed with an apostrophe (numbers like -42 are left alone).
 */
export function safeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function safeCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(safeCsvCell).join(",")).join("\r\n");
}

// ---------------------------------------------------------------------------
//  Exit survey roll-up
// ---------------------------------------------------------------------------

export interface ExitQuestionLike { id: string; prompt: string; type: string; options: string[] }
export interface ExitAnswerLike { questionId: string; score: number | null; choices: number[]; text: string | null }

export type ExitQuestionSummary =
  | { id: string; prompt: string; type: "RATING" | "NPS"; responses: number; average: number | null; nps: number | null }
  | { id: string; prompt: string; type: "SINGLE_CHOICE" | "MULTI_CHOICE"; responses: number; counts: Array<{ option: string; count: number }> }
  | { id: string; prompt: string; type: "TEXT"; responses: number; texts: string[] };

/**
 * Per-question results across exit responses: the average for ratings, the
 * NPS (promoters 9–10 minus detractors 0–6, as a percentage) for 0–10
 * questions, counts per option for choices, and the comments for text.
 */
export function summariseExitSurvey(questions: ExitQuestionLike[], answers: ExitAnswerLike[]): ExitQuestionSummary[] {
  return questions.map((q) => {
    const mine = answers.filter((a) => a.questionId === q.id);
    if (q.type === "RATING" || q.type === "NPS") {
      const scores = mine.map((a) => a.score).filter((s): s is number => s !== null && s !== undefined);
      const average = scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10 : null;
      const nps = q.type === "NPS" && scores.length
        ? Math.round(((scores.filter((s) => s >= 9).length - scores.filter((s) => s <= 6).length) / scores.length) * 100)
        : null;
      return { id: q.id, prompt: q.prompt, type: q.type, responses: scores.length, average, nps };
    }
    if (q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE") {
      const counts = q.options.map((option, i) => ({ option, count: mine.filter((a) => a.choices.includes(i)).length }));
      return { id: q.id, prompt: q.prompt, type: q.type, responses: mine.filter((a) => a.choices.length > 0).length, counts };
    }
    const texts = mine.map((a) => a.text?.trim() ?? "").filter(Boolean);
    return { id: q.id, prompt: q.prompt, type: "TEXT" as const, responses: texts.length, texts };
  });
}
