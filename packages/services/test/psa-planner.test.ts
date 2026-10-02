import { test } from "node:test";
import assert from "node:assert/strict";
import { planWeeks, weeklyLoad, loadTone, benchFor } from "../src/psa-planner";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

test("weeks start on Monday", () => {
  assert.deepEqual(planWeeks(D("2026-10-01"), 3).map((d) => d.toISOString().slice(0, 10)), ["2026-09-28", "2026-10-05", "2026-10-12"]);
});

test("weekly hard and soft load", () => {
  const weeks = planWeeks(D("2026-09-28"), 3);
  const load = weeklyLoad([
    { startDate: D("2026-09-28"), endDate: D("2026-10-09"), allocationPercent: 60, kind: "HARD" },
    { startDate: D("2026-10-05"), endDate: null, allocationPercent: 40, kind: "HARD" },
    { startDate: D("2026-10-12"), endDate: D("2026-10-16"), allocationPercent: 50, kind: "SOFT" },
  ], weeks);
  assert.deepEqual(load, [{ hard: 60, soft: 0 }, { hard: 100, soft: 0 }, { hard: 40, soft: 50 }]);
  // A weekend-only allocation adds nothing.
  assert.deepEqual(weeklyLoad([{ startDate: D("2026-10-03"), endDate: D("2026-10-04"), allocationPercent: 100, kind: "HARD" }], weeks.slice(0, 1)), [{ hard: 0, soft: 0 }]);
  assert.deepEqual([0, 30, 100, 120].map(loadTone), ["free", "part", "full", "over"]);
});

test("bench lists people with room, most free first", () => {
  const people = [
    { id: "a", allocations: [{ startDate: D("2026-10-01"), endDate: null, allocationPercent: 80, kind: "HARD" as const }] },
    { id: "b", allocations: [] },
    { id: "c", allocations: [{ startDate: D("2026-10-01"), endDate: null, allocationPercent: 50, kind: "HARD" as const }] },
    { id: "d", allocations: [{ startDate: D("2026-10-01"), endDate: null, allocationPercent: 100, kind: "SOFT" as const }] },
  ];
  assert.deepEqual(benchFor(people, 50, D("2026-10-05"), null).map((p) => [p.id, p.free]), [["b", 100], ["d", 100], ["c", 50]]);
  assert.deepEqual(benchFor(people, 50, D("2026-10-05"), null, ["b"]).map((p) => p.id), ["d", "c"]);
});
