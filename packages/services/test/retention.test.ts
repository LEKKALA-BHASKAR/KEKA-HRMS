import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { PopMember } from "../src/analytics-math";
import {
  monthlyFlow, annualisedRate, exitKind, isRegretted, attritionByGroup, newHireRetention, newHireRetentionByMonth,
  probeDay, tenureAtExitMonths, REGRET_RATING,
} from "../src/retention-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
type P = PopMember & { dept: string };
const p = (id: string, doj: string, leftOn: string | null, dept = "Eng", status = leftOn ? "EXITED" : "CONFIRMED"): P =>
  ({ id, dateOfJoining: d(doj), status, leftOn: leftOn ? d(leftOn) : null, dept });

describe("Monthly flow", () => {
  const pop = [
    p("a", "2020-01-01", null), p("b", "2020-01-01", null), p("c", "2020-01-01", null), p("e", "2020-01-01", null),
    p("x", "2021-01-01", "2026-01-20"),
    p("j", "2026-02-10", null),
    p("pre", "2026-02-01", null, "Eng", "PREBOARDING"),
  ];
  const w = { from: d("2026-01-01"), to: d("2026-02-28") };

  test("opening, closing, joiners and leavers per month; preboarding never counts", () => {
    const f = monthlyFlow(pop, w);
    assert.deepEqual(f.map((m) => [m.label, m.opening, m.closing, m.joiners, m.leavers]), [["Jan-2026", 5, 4, 0, 1], ["Feb-2026", 4, 5, 1, 0]]);
  });

  test("monthly attrition is leavers over the average of opening and closing; retention follows the opening cohort", () => {
    const [jan, feb] = monthlyFlow(pop, w);
    assert.equal(jan.attritionPct, 22.2); // 1 ÷ 4.5
    assert.equal(jan.retentionPct, 80);
    assert.equal(feb.attritionPct, 0);
    assert.equal(feb.retentionPct, 100, "a joiner does not lift retention");
  });

  test("annualising scales by twelve over the months; no headcount means no rate", () => {
    assert.equal(annualisedRate(3, 50, 6), 12);
    assert.equal(annualisedRate(3, 50, 12), 6);
    assert.equal(annualisedRate(3, 0, 12), 0);
    assert.equal(annualisedRate(1, 3, 1), 400);
  });
});

describe("Exit kinds and regretted exits", () => {
  test("a structured reason decides, else the exit type", () => {
    assert.equal(exitKind({ exitType: "RESIGNATION" }), "Voluntary");
    assert.equal(exitKind({ exitType: "TERMINATION" }), "Involuntary");
    assert.equal(exitKind({ exitType: "ABSCONDING" }), "Involuntary");
    assert.equal(exitKind({ exitType: "RETIREMENT" }), "Other");
    assert.equal(exitKind({ exitType: null }), "Other");
    assert.equal(exitKind({ exitType: "RESIGNATION", exitReasonKind: "INVOLUNTARY" }), "Involuntary", "a resignation asked for is not voluntary");
    assert.equal(exitKind({ exitType: "TERMINATION", exitReasonKind: "VOLUNTARY" }), "Voluntary");
  });

  test("regretted means voluntary and highly rated; no rating is not counted", () => {
    assert.equal(isRegretted({ exitType: "RESIGNATION" }, REGRET_RATING), true);
    assert.equal(isRegretted({ exitType: "RESIGNATION" }, 3.9), false);
    assert.equal(isRegretted({ exitType: "RESIGNATION" }, null), false);
    assert.equal(isRegretted({ exitType: "TERMINATION" }, 5), false);
  });
});

describe("Attrition by group", () => {
  test("headcount, leavers and an annualised rate per group, everyone on the books in the window counted once", () => {
    const pop = [
      p("a", "2020-01-01", null, "Eng"), p("b", "2020-01-01", null, "Eng"), p("c", "2020-01-01", "2026-03-15", "Eng"), p("d", "2020-01-01", null, "Eng"),
      p("s", "2020-01-01", null, "Sales"), p("t", "2020-01-01", "2026-06-30", "Sales"),
      p("old", "2019-01-01", "2025-06-30", "Sales"),
    ];
    const w = { from: d("2026-01-01"), to: d("2026-06-30") };
    const leavers = pop.filter((e) => e.leftOn && e.leftOn >= w.from && e.leftOn <= w.to);
    const rows = attritionByGroup(pop, leavers, w, (e) => e.dept);
    const eng = rows.find((r) => r.label === "Eng")!, sales = rows.find((r) => r.label === "Sales")!;
    assert.equal(eng.leavers, 1);
    assert.equal(sales.leavers, 1);
    assert.equal(sales.headcount, 2, "someone gone before the window is not in it");
    // Eng: opening 4 and month ends 4,4,3,3,3,3 → average 24 ÷ 7 ≈ 3.43; 1 ÷ 3.43 × 2 = 58.3%.
    assert.equal(eng.ratePct, 58.3);
    assert.equal(rows[0].label, "Sales", "ties on leavers go to the higher rate");
  });

  test("a fixed order wins over sorting by leavers", () => {
    const pop = [p("a", "2020-01-01", "2026-02-01", "B"), p("b", "2020-01-01", null, "A")];
    const w = { from: d("2026-01-01"), to: d("2026-03-31") };
    assert.deepEqual(attritionByGroup(pop, [pop[0]], w, (e) => e.dept, ["A", "B"]).map((r) => r.label), ["A", "B"]);
  });
});

describe("New-hire retention", () => {
  const w = { from: d("2026-01-01"), to: d("2026-06-30") };
  const pop = [
    p("stay", "2026-01-05", null),
    p("quit", "2026-01-10", "2026-02-20"),
    p("edge", "2026-02-01", "2026-05-02"), // day 90 is 2 May: still here on it
    p("late", "2026-03-20", "2026-07-01"), // left after day 90
    p("new", "2026-06-15", null),
    p("before", "2025-12-01", "2026-01-15"),
  ];
  const asOf = d("2026-07-01");

  test("only hires whose first ninety days are over are judged", () => {
    assert.equal(probeDay(d("2026-02-01")).toISOString().slice(0, 10), "2026-05-02");
    const r = newHireRetention(pop, w, asOf);
    assert.deepEqual({ ...r }, { hires: 5, matured: 4, retained: 3, left: 1, pending: 1, ratePct: 75 });
  });

  test("nobody judged yet gives no rate rather than zero", () => {
    assert.equal(newHireRetention(pop, { from: d("2026-06-01"), to: d("2026-06-30") }, asOf).ratePct, null);
  });

  test("by joining month", () => {
    const m = newHireRetentionByMonth(pop, w, asOf);
    assert.deepEqual(m.slice(0, 3).map((x) => [x.label, x.retained, x.left]), [["Jan-2026", 1, 1], ["Feb-2026", 1, 0], ["Mar-2026", 1, 0]]);
  });

  test("tenure at exit in whole months", () => {
    assert.equal(tenureAtExitMonths(pop[1]), 1);
    assert.equal(tenureAtExitMonths(pop[0]), null);
  });
});
