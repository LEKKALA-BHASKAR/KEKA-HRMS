import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { weekStart, checkTimesheet, gst, projectHealth, utilisation } from "../src/projects-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Timesheets", () => {
  test("weeks start on Monday", () => {
    assert.equal(weekStart(d("2026-10-01")).toISOString().slice(0, 10), "2026-09-28"); // a Thursday
    assert.equal(weekStart(d("2026-09-28")).toISOString().slice(0, 10), "2026-09-28");
    assert.equal(weekStart(d("2026-10-04")).toISOString().slice(0, 10), "2026-09-28"); // Sunday belongs to the week before
  });
  const wk = d("2026-09-28"), today = d("2026-10-01");
  test("a normal week passes", () => {
    assert.deepEqual(checkTimesheet([{ projectId: "p", date: d("2026-09-28"), hours: 8 }, { projectId: "q", date: d("2026-09-28"), hours: 0.75 }], wk, today), []);
  });
  test("impossible, imprecise, future and out-of-week entries are caught", () => {
    const issues = checkTimesheet([
      { projectId: "p", date: d("2026-09-29"), hours: 20 }, { projectId: "q", date: d("2026-09-29"), hours: 6 },
      { projectId: "p", date: d("2026-09-30"), hours: 1.1 },
      { projectId: "p", date: d("2026-10-02"), hours: 2 },
      { projectId: "p", date: d("2026-10-06"), hours: 2 },
    ], wk, today);
    assert.ok(issues.some((i) => /24/.test(i)));
    assert.ok(issues.some((i) => /quarter/.test(i)));
    assert.ok(issues.some((i) => /cannot be logged/.test(i)));
    assert.ok(issues.some((i) => /outside/.test(i)));
  });
});

describe("GST", () => {
  test("same state: CGST and SGST at 9% each", () => assert.deepEqual(gst(100000, "KA", "KA"), { cgst: 9000, sgst: 9000, igst: 0, total: 18000, kind: "INTRA" }));
  test("different state: IGST at 18%", () => assert.deepEqual(gst(100000, "KA", "MH"), { cgst: 0, sgst: 0, igst: 18000, total: 18000, kind: "INTER" }));
  test("export of services: zero-rated", () => assert.equal(gst(100000, "KA", null).total, 0));
});

describe("Project health and utilisation", () => {
  const p = { start: d("2026-07-01"), end: d("2026-12-31"), budgetHours: 1000, overdueMilestones: 0 };
  const today = d("2026-09-30"); // about half-way
  test("on plan is green, ahead is amber, far ahead or over is red", () => {
    assert.equal(projectHealth({ ...p, hoursUsed: 480 }, today).health, "GREEN");
    assert.equal(projectHealth({ ...p, hoursUsed: 640 }, today).health, "AMBER");
    assert.equal(projectHealth({ ...p, hoursUsed: 760 }, today).health, "RED");
    assert.equal(projectHealth({ ...p, hoursUsed: 1100 }, today).health, "RED");
  });
  test("a missed milestone is red whatever the hours", () => assert.equal(projectHealth({ ...p, hoursUsed: 10, overdueMilestones: 1 }, today).health, "RED"));
  test("utilisation is billable over capacity", () => {
    assert.equal(utilisation(120, 20), 75);
    assert.equal(utilisation(80, 20, 50), 100);
  });
});
