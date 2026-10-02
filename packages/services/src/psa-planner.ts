import { peakLoad, DEFAULT_CAPACITY } from "./psa-math";

/**
 * The resource planner's grid: per person per week, the peak hard load (the
 * figure the 100% rule checks) and the soft load pencilled on top, plus who
 * on the bench can take a request.
 */

const DAY = 86_400_000;
const utc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export interface PlanAlloc { startDate: Date; endDate: Date | null; allocationPercent: number; kind: "SOFT" | "HARD" }

/** `n` Mondays starting with the week holding `from`. */
export function planWeeks(from: Date, n: number): Date[] {
  const start = utc(from) - ((new Date(utc(from)).getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: n }, (_, i) => new Date(start + i * 7 * DAY));
}

/** Per week: peak hard load and peak soft load on working days. */
export function weeklyLoad(allocs: PlanAlloc[], weeks: Date[], capacity = DEFAULT_CAPACITY): Array<{ hard: number; soft: number }> {
  const soft = allocs.filter((a) => a.kind === "SOFT").map((a) => ({ ...a, kind: "HARD" as const }));
  return weeks.map((w) => {
    const end = new Date(w.getTime() + 6 * DAY);
    return { hard: peakLoad(allocs, w, end, capacity), soft: peakLoad(soft, w, end, capacity) };
  });
}

/** A cell's tone: free, part, full or over. */
export function loadTone(pct: number): "free" | "part" | "full" | "over" {
  return pct <= 0 ? "free" : pct < 100 ? "part" : pct === 100 ? "full" : "over";
}

/**
 * People who can take `percent` from `start` (to `end`, or 12 weeks), most
 * free first; `exclude` are already on the request.
 */
export function benchFor<T extends { id: string; allocations: PlanAlloc[]; capacity?: number[] }>(people: T[], percent: number, start: Date, end: Date | null, exclude: string[] = []): Array<T & { free: number }> {
  const to = end ?? new Date(start.getTime() + 84 * DAY);
  return people
    .filter((p) => !exclude.includes(p.id))
    .map((p) => ({ ...p, free: Math.max(0, 100 - peakLoad(p.allocations, start, to, p.capacity ?? DEFAULT_CAPACITY)) }))
    .filter((p) => p.free >= percent)
    .sort((a, b) => b.free - a.free);
}
