import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { goalProgress, goalHealth, rollupProgress, weightedRating, bandFor, distribution, type Band } from "../src/performance-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Goal progress", () => {
  test("by metric type", () => {
    assert.equal(goalProgress("PERCENTAGE", 0, 100, 42), 42);
    assert.equal(goalProgress("COMPLETION", 0, 1, 0), 0);
    assert.equal(goalProgress("COMPLETION", 0, 1, 1), 100);
    assert.equal(goalProgress("NUMBER_INCREASE", 50, 150, 100), 50);
    assert.equal(goalProgress("CURRENCY", 0, 2000000, 500000), 25);
    // Bringing defects down from 40 to 10: at 25 we are halfway.
    assert.equal(goalProgress("NUMBER_DECREASE", 40, 10, 25), 50);
  });
  test("is clamped to 0–100", () => {
    assert.equal(goalProgress("NUMBER_INCREASE", 0, 10, 15), 100);
    assert.equal(goalProgress("NUMBER_INCREASE", 10, 20, 5), 0);
    assert.equal(goalProgress("NUMBER_DECREASE", 40, 10, 50), 0);
  });
});

describe("Goal health", () => {
  const s = d("2026-04-01"), due = d("2027-03-31");
  test("is measured against the time already spent", () => {
    // Half-way through the year.
    const mid = d("2026-09-30");
    assert.equal(goalHealth(45, s, due, mid), "ON_TRACK");
    assert.equal(goalHealth(30, s, due, mid), "NEEDS_ATTENTION");
    assert.equal(goalHealth(10, s, due, mid), "AT_RISK");
  });
  test("completed and missed win over pace", () => {
    assert.equal(goalHealth(100, s, due, d("2026-05-01")), "COMPLETED");
    assert.equal(goalHealth(90, s, due, d("2027-04-02")), "MISSED");
  });
});

describe("Ratings", () => {
  test("roll-up averages or weights children", () => {
    const kids = [{ progress: 100, weight: 1 }, { progress: 0, weight: 3 }];
    assert.equal(rollupProgress(kids, "AVERAGE"), 50);
    assert.equal(rollupProgress(kids, "WEIGHTED"), 25);
    assert.equal(rollupProgress([], "AVERAGE"), 0);
  });
  test("weighted rating rescales when a reviewer has not submitted", () => {
    const w = [{ type: "SELF", weight: 20 }, { type: "MANAGER", weight: 80 }];
    assert.equal(weightedRating([{ type: "SELF", rating: 5 }, { type: "MANAGER", rating: 3 }], w), 3.4);
    assert.equal(weightedRating([{ type: "SELF", rating: 5 }, { type: "MANAGER", rating: null }], w), 5);
    assert.equal(weightedRating([{ type: "SELF", rating: 4 }], [{ type: "SELF", weight: 0 }, { type: "MANAGER", weight: 100 }]), null);
  });
  const bands: Band[] = [
    { id: "1", name: "Needs improvement", minRating: 1, maxRating: 2, targetPercent: 10 },
    { id: "2", name: "Meets", minRating: 2, maxRating: 3.5, targetPercent: 50 },
    { id: "3", name: "Exceeds", minRating: 3.5, maxRating: 4.5, targetPercent: 30 },
    { id: "4", name: "Outstanding", minRating: 4.5, maxRating: 5, targetPercent: 10 },
  ];
  test("bands are lower-inclusive, and the top band includes its ceiling", () => {
    assert.equal(bandFor(2, bands)?.name, "Meets");
    assert.equal(bandFor(3.49, bands)?.name, "Meets");
    assert.equal(bandFor(3.5, bands)?.name, "Exceeds");
    assert.equal(bandFor(5, bands)?.name, "Outstanding");
    assert.equal(bandFor(0.5, bands), null);
  });
  test("distribution shows actual against target", () => {
    const dist = distribution([4.8, 4.0, 3.0, 3.0, 2.5, 1.5, 3.9, 3.2, 2.8, 4.6], bands);
    const out = dist.find((x) => x.band === "Outstanding")!;
    assert.equal(out.count, 2);
    assert.equal(out.actual, 20);
    assert.equal(out.variance, 10);
    assert.equal(dist.reduce((s, x) => s + x.count, 0), 10);
  });
});
