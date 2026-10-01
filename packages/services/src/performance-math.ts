/**
 * Pure performance arithmetic — no database. Goal progress by metric type,
 * goal health against elapsed time, weighted ratings, bands and the
 * distribution calibration compares against.
 */

export type MetricType = "PERCENTAGE" | "COMPLETION" | "NUMBER_INCREASE" | "NUMBER_DECREASE" | "CURRENCY";
export type GoalHealth = "ON_TRACK" | "NEEDS_ATTENTION" | "AT_RISK" | "COMPLETED" | "MISSED";

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Progress 0–100 for a goal's current value. */
export function goalProgress(metric: MetricType, start: number, target: number, current: number): number {
  switch (metric) {
    case "PERCENTAGE": return r2(clamp(current));
    case "COMPLETION": return current >= 1 ? 100 : 0;
    case "NUMBER_DECREASE":
      return start === target ? (current <= target ? 100 : 0) : r2(clamp(((start - current) / (start - target)) * 100));
    default: // increases and currency
      return start === target ? (current >= target ? 100 : 0) : r2(clamp(((current - start) / (target - start)) * 100));
  }
}

/**
 * Health compares progress with the share of the goal's time already spent.
 * Ten points behind is normal noise; twenty-five is a conversation.
 */
export function goalHealth(progress: number, start: Date, due: Date, today = new Date()): GoalHealth {
  if (progress >= 100) return "COMPLETED";
  if (today.getTime() > due.getTime()) return "MISSED";
  const span = Math.max(1, due.getTime() - start.getTime());
  const expected = clamp(((today.getTime() - start.getTime()) / span) * 100);
  const gap = expected - progress;
  return gap <= 10 ? "ON_TRACK" : gap <= 25 ? "NEEDS_ATTENTION" : "AT_RISK";
}

/** A parent goal's progress from its children. */
export function rollupProgress(children: Array<{ progress: number; weight: number }>, method: "AVERAGE" | "WEIGHTED"): number {
  if (children.length === 0) return 0;
  if (method === "WEIGHTED") {
    const w = children.reduce((s, c) => s + c.weight, 0);
    if (w > 0) return r2(children.reduce((s, c) => s + c.progress * c.weight, 0) / w);
  }
  return r2(children.reduce((s, c) => s + c.progress, 0) / children.length);
}

export interface ReviewerWeight { type: string; weight: number }
export const DEFAULT_REVIEWERS: ReviewerWeight[] = [{ type: "SELF", weight: 0 }, { type: "MANAGER", weight: 100 }];

/**
 * The review's raw rating: a weighted average of the submitted ratings.
 * A reviewer type that is weighted but has not submitted is left out and the
 * remaining weights rescale, rather than dragging the score to zero.
 */
export function weightedRating(responses: Array<{ type: string; rating: number | null }>, weights: ReviewerWeight[]): number | null {
  const parts = responses.filter((r) => r.rating !== null).map((r) => ({ rating: r.rating!, weight: weights.find((w) => w.type === r.type)?.weight ?? 0 }));
  const total = parts.reduce((s, p) => s + p.weight, 0);
  if (total === 0) return null;
  return r2(parts.reduce((s, p) => s + p.rating * p.weight, 0) / total);
}

export interface Band { id: string; name: string; minRating: number; maxRating: number; targetPercent: number | null }

export function bandFor(rating: number, bands: Band[]): Band | null {
  // Inclusive lower bound, and the top band includes its upper bound.
  const sorted = [...bands].sort((a, b) => a.minRating - b.minRating);
  return sorted.find((b, i) => rating >= b.minRating && (rating < b.maxRating || (i === sorted.length - 1 && rating <= b.maxRating))) ?? null;
}

/** Actual spread of ratings across bands, next to the target spread. */
export function distribution(ratings: number[], bands: Band[]) {
  const n = ratings.length || 1;
  return [...bands].sort((a, b) => b.minRating - a.minRating).map((b) => {
    const count = ratings.filter((r) => bandFor(r, bands)?.id === b.id).length;
    const actual = r2((count / n) * 100);
    return { band: b.name, count, actual, target: b.targetPercent, variance: b.targetPercent === null ? null : r2(actual - b.targetPercent) };
  });
}
