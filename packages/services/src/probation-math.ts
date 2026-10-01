/**
 * Probation arithmetic, free of the database and the clock.
 *
 * Dates are UTC midnights. `endDate` is the last day of probation, so a
 * 90-day probation starting 1 Aug ends 29 Oct and confirmation takes effect
 * on 30 Oct.
 */

import { startOfDay as utcDay, addDays as plusDays } from "@keka/shared";

const DAY = 86_400_000;
const addDays = (d: Date, n: number) => plusDays(utcDay(d), n);
/** Signed whole days from `from` to `to` (0 on the same day). */
const diffDays = (from: Date, to: Date) => Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / DAY);

export interface ProbationPolicyRule {
  durationDays: number;
  maxExtensions: number;
  completion: "EVALUATION" | "AUTO_CONFIRM";
  reviewLeadDays: number;
}

/** Last day of probation for someone starting on `start`. */
export function probationEndDate(start: Date, durationDays: number): Date {
  return addDays(start, Math.max(1, durationDays) - 1);
}

/** The day the review opens: `leadDays` before the end, never before the start. */
export function reviewOpensOn(start: Date, endDate: Date, leadDays: number): Date {
  const opens = addDays(endDate, -Math.max(0, leadDays));
  return opens < utcDay(start) ? utcDay(start) : opens;
}

/**
 * Confirmation takes effect the day after probation ends. Confirming early
 * takes effect on the day of the decision instead; confirming late is
 * backdated to the day after the end, because that is when probation stopped.
 */
export function confirmationEffectiveDate(endDate: Date, decidedOn: Date): Date {
  const dayAfter = addDays(endDate, 1);
  return utcDay(decidedOn) < dayAfter ? utcDay(decidedOn) : dayAfter;
}

export function extensionCheck(extensionsUsed: number, maxExtensions: number, days: number): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(days) || days < 1) return { ok: false, message: "An extension must be at least one day." };
  if (days > 365) return { ok: false, message: "An extension longer than a year is not a probation." };
  if (extensionsUsed >= maxExtensions) {
    return {
      ok: false,
      message: maxExtensions === 0
        ? "This probation policy does not allow extensions."
        : `Probation has already been extended ${extensionsUsed} time${extensionsUsed === 1 ? "" : "s"}, the most this policy allows.`,
    };
  }
  return { ok: true };
}

/**
 * New end date after an extension. Extending runs from the current end date,
 * or from today when the end has already passed, so an overdue probation is
 * never "extended" into the past.
 */
export function extendedEndDate(endDate: Date, days: number, today: Date): Date {
  const base = utcDay(today) > utcDay(endDate) ? utcDay(today) : utcDay(endDate);
  return addDays(base, days);
}

export type ProbationDue = "NOTHING" | "OPEN_REVIEW" | "AUTO_CONFIRM";

/** What the nightly job should do for one open probation today. */
export function probationDue(
  p: { status: string; startDate: Date; endDate: Date },
  policy: ProbationPolicyRule,
  today: Date,
): ProbationDue {
  if (p.status !== "ACTIVE") return "NOTHING";
  if (policy.completion === "AUTO_CONFIRM") return utcDay(today) > utcDay(p.endDate) ? "AUTO_CONFIRM" : "NOTHING";
  return utcDay(today) >= reviewOpensOn(p.startDate, p.endDate, policy.reviewLeadDays) ? "OPEN_REVIEW" : "NOTHING";
}

export type ProbationStage = "ON_TRACK" | "REVIEW_SOON" | "IN_REVIEW" | "OVERDUE" | "CONFIRMED" | "NOT_CONFIRMED";

/** How an open probation reads on a list, today. */
export function probationStage(
  p: { status: string; startDate: Date; endDate: Date },
  reviewLeadDays: number,
  today: Date,
): { stage: ProbationStage; daysLeft: number; progress: number } {
  const total = Math.max(1, diffDays(p.startDate, p.endDate) + 1);
  const elapsed = Math.min(total, Math.max(0, diffDays(p.startDate, today) + 1));
  const daysLeft = diffDays(today, p.endDate);
  const progress = Math.round((elapsed / total) * 100);
  if (p.status === "CONFIRMED" || p.status === "NOT_CONFIRMED") return { stage: p.status, daysLeft, progress: 100 };
  if (daysLeft < 0) return { stage: "OVERDUE", daysLeft, progress };
  if (p.status === "IN_REVIEW") return { stage: "IN_REVIEW", daysLeft, progress };
  if (utcDay(today) >= reviewOpensOn(p.startDate, p.endDate, reviewLeadDays)) return { stage: "REVIEW_SOON", daysLeft, progress };
  return { stage: "ON_TRACK", daysLeft, progress };
}

export interface EvaluationInput {
  role: "MANAGER" | "SELF";
  status: string;
  rating: number | null;
  recommendation: "CONFIRM" | "EXTEND" | "NOT_CONFIRM" | null;
}

/**
 * The state of one review round: whether the manager has spoken, what they
 * recommend, and the average rating across submitted reviews.
 */
export function probationReviewSummary(evaluations: EvaluationInput[]) {
  const submitted = evaluations.filter((e) => e.status === "SUBMITTED");
  const manager = submitted.find((e) => e.role === "MANAGER") ?? null;
  const ratings = submitted.map((e) => e.rating).filter((r): r is number => typeof r === "number");
  const avg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  return {
    submitted: submitted.length,
    pending: evaluations.filter((e) => e.status === "PENDING").length,
    managerDone: !!manager,
    recommendation: manager?.recommendation ?? null,
    averageRating: avg,
  };
}

/** Field-level checks for a submitted evaluation. */
export function validateEvaluation(
  role: "MANAGER" | "SELF",
  input: { rating: number | null; recommendation: string | null; comments: string | null },
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (input.rating === null || !Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    issues.push({ field: "rating", message: "Rate from 1 to 5." });
  }
  if (role === "MANAGER") {
    if (!input.recommendation || !["CONFIRM", "EXTEND", "NOT_CONFIRM"].includes(input.recommendation)) {
      issues.push({ field: "recommendation", message: "Recommend confirm, extend or not confirm." });
    } else if (input.recommendation !== "CONFIRM" && !input.comments) {
      issues.push({ field: "comments", message: "Explain why you are not recommending confirmation." });
    }
  }
  return issues;
}
