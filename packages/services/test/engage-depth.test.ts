import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  answerMatches, visibleQuestionIds, branchRuleError, seededOrder, heatmap, heatBand, trendDeltas, nextRunOn, reminderDue, actionPlanState,
  programEligibility, budgetCheck, pointsBalance, redemptionCheck, anniversaryYears, recognitionFairness, isoWeekStart, challengeProgress,
  wellbeingSummary, inAudience, rsvpOutcome, promoteFromWaitlist, reachStats, ENGAGE_WORKFLOW_TYPES, isEngageWorkflowType,
} from "../src/engage-depth-math";
import { WORKFLOW_ENTITY_TYPES } from "../src/governance-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Survey branching", () => {
  const qs = [
    { id: "a", type: "RATING" },
    { id: "b", type: "TEXT", showIfQuestionId: "a", showIfValues: [1, 2] },
    { id: "c", type: "SINGLE_CHOICE", options: ["Yes", "No"] },
    { id: "d", type: "TEXT", showIfQuestionId: "c", showIfValues: [1] },
    { id: "e", type: "TEXT", showIfQuestionId: "d", showIfValues: [0] },
  ];
  test("a follow-up appears only for matching answers", () => {
    assert.deepEqual([...visibleQuestionIds(qs, new Map([["a", { score: 2 }], ["c", { choices: [0] }]]))], ["a", "b", "c"]);
    assert.deepEqual([...visibleQuestionIds(qs, new Map([["a", { score: 5 }], ["c", { choices: [1] }]]))], ["a", "c", "d"]);
  });
  test("a question hanging off a hidden question stays hidden", () => {
    assert.equal(visibleQuestionIds(qs, new Map([["c", { choices: [0] }], ["d", { choices: [0] }]])).has("e"), false);
  });
  test("answerMatches handles scores and choices", () => {
    assert.equal(answerMatches({ score: 0 }, [0]), true);
    assert.equal(answerMatches({ choices: [2, 3] }, [3]), true);
    assert.equal(answerMatches(undefined, [1]), false);
  });
  test("branch rules are validated", () => {
    assert.match(branchRuleError(qs, { questionId: "zz", values: [1] })!, /earlier question/);
    assert.match(branchRuleError(qs, { questionId: "b", values: [1] })!, /free-text/);
    assert.match(branchRuleError(qs, { questionId: "a", values: [] })!, /at least one/);
    assert.match(branchRuleError(qs, { questionId: "a", values: [6] })!, /between 1 and 5/);
    assert.match(branchRuleError(qs, { questionId: "c", values: [2] })!, /between 0 and 1/);
    assert.equal(branchRuleError(qs, { questionId: "a", values: [1, 2] }), null);
  });
  test("randomised order is stable per respondent and keeps follow-ups attached", () => {
    const one = seededOrder(qs, "emp-1").map((q) => q.id);
    assert.deepEqual(seededOrder(qs, "emp-1").map((q) => q.id), one);
    assert.equal(one.length, 5);
    assert.equal(one[one.indexOf("a") + 1], "b");
    assert.equal(one[one.indexOf("c") + 1], "d");
    assert.equal(one[one.indexOf("d") + 1], "e");
    const orders = new Set(Array.from({ length: 20 }, (_, i) => seededOrder(qs, `p${i}`).map((q) => q.id).join()));
    assert.ok(orders.size > 1, "different respondents see different orders");
  });
});

describe("Heat map and trends", () => {
  const r = (group: string, scores: Array<[string, number]>) => ({ group, answers: scores.map(([driver, score]) => ({ driver, score })) });
  test("favourable % per group and driver, small groups withheld", () => {
    const h = heatmap([
      r("Eng", [["Growth", 5], ["Manager", 2]]), r("Eng", [["Growth", 4], ["Manager", 4]]), r("Eng", [["Growth", 1], ["Manager", 5]]),
      r("Sales", [["Growth", 5]]),
    ], 3);
    assert.deepEqual(h.drivers, ["Growth", "Manager"]);
    const eng = h.rows.find((x) => x.group === "Eng")!;
    assert.deepEqual(eng.cells, [67, 67]);
    assert.equal(eng.overall, 67);
    const sales = h.rows.find((x) => x.group === "Sales")!;
    assert.equal(sales.hidden, true);
    assert.deepEqual(sales.cells, [null, null]);
    assert.equal(h.rows[0]!.group, "Eng");
  });
  test("bands and deltas", () => {
    assert.equal(heatBand(null), "none");
    assert.equal(heatBand(80), "high");
    assert.equal(heatBand(55), "mid");
    assert.equal(heatBand(10), "low");
    assert.deepEqual(trendDeltas([{ value: 50 }, { value: 60 }, { value: null }, { value: 40 }]), [null, 10, null, null]);
  });
  test("schedules, reminders and action plans", () => {
    assert.equal(nextRunOn(new Date("2026-10-04T15:00:00Z"), 14).toISOString().slice(0, 10), "2026-10-18");
    assert.equal(reminderDue({ everyDays: 3, launchedAt: d("2026-10-01"), lastReminderAt: null, now: d("2026-10-04") }), true);
    assert.equal(reminderDue({ everyDays: 3, launchedAt: d("2026-10-01"), lastReminderAt: d("2026-10-03"), now: d("2026-10-04") }), false);
    assert.equal(reminderDue({ everyDays: null, launchedAt: d("2026-10-01"), lastReminderAt: null, now: d("2026-10-30") }), false);
    assert.equal(actionPlanState("OPEN", d("2026-10-01"), d("2026-10-04")), "OVERDUE");
    assert.equal(actionPlanState("DONE", d("2026-10-01"), d("2026-10-04")), "DONE");
    assert.equal(actionPlanState("IN_PROGRESS", d("2026-10-04"), d("2026-10-04")), "IN_PROGRESS");
  });
});

describe("Recognition", () => {
  const program = { status: "ACTIVE", startsOn: d("2026-01-01"), endsOn: d("2026-12-31"), departmentIds: ["eng"], minTenureDays: 90, budgetPoints: 1000, pointsPerAward: 100, cooldownDays: 30 };
  test("eligibility: status, dates, department, tenure, cooldown", () => {
    const e = { departmentId: "eng", dateOfJoining: d("2025-01-01") };
    assert.deepEqual(programEligibility(program, e, d("2026-06-01")), { ok: true });
    assert.equal(programEligibility({ ...program, status: "DRAFT" }, e, d("2026-06-01")).ok, false);
    assert.equal(programEligibility(program, e, d("2027-01-02")).ok, false);
    assert.equal(programEligibility(program, { ...e, departmentId: "sales" }, d("2026-06-01")).ok, false);
    const fresh = programEligibility(program, { ...e, dateOfJoining: d("2026-05-01") }, d("2026-06-01"));
    assert.equal(fresh.ok, false);
    assert.match((fresh as { reason: string }).reason, /90 days/);
    assert.equal(programEligibility(program, e, d("2026-06-01"), d("2026-05-20")).ok, false);
    assert.equal(programEligibility(program, e, d("2026-06-01"), d("2026-04-20")).ok, true);
  });
  test("budget headroom", () => {
    assert.deepEqual(budgetCheck(null, 500, 100), { fits: true, remaining: null, utilisation: null });
    assert.deepEqual(budgetCheck(1000, 950, 100), { fits: false, remaining: 50, utilisation: 95 });
    assert.equal(budgetCheck(1000, 900, 100).fits, true);
  });
  test("points and redemption checks", () => {
    assert.equal(pointsBalance([{ delta: 100 }, { delta: -40 }, { delta: 10 }]), 70);
    assert.equal(redemptionCheck({ balance: 100, cost: 50, quantity: 2, stock: null, active: true }), null);
    assert.match(redemptionCheck({ balance: 90, cost: 50, quantity: 2, stock: null, active: true })!, /need 100/);
    assert.match(redemptionCheck({ balance: 900, cost: 50, quantity: 2, stock: 1, active: true })!, /Only 1 left/);
    assert.match(redemptionCheck({ balance: 900, cost: 50, quantity: 1, stock: 0, active: true })!, /out of stock/);
    assert.match(redemptionCheck({ balance: 900, cost: 50, quantity: 1, stock: 5, active: false })!, /not available/);
    assert.match(redemptionCheck({ balance: 900, cost: 50, quantity: 0, stock: 5, active: true })!, /between 1 and 10/);
  });
  test("work anniversaries", () => {
    assert.equal(anniversaryYears(d("2021-10-04"), d("2026-10-04")), 5);
    assert.equal(anniversaryYears(d("2021-10-05"), d("2026-10-04")), 0);
    assert.equal(anniversaryYears(d("2026-10-04"), d("2026-10-04")), 0);
    assert.equal(anniversaryYears(null, d("2026-10-04")), 0);
  });
  test("fairness flags under-recognised groups", () => {
    const f = recognitionFairness([{ group: "Eng", headcount: 10, recognitions: 20 }, { group: "Ops", headcount: 10, recognitions: 2 }, { group: "Tiny", headcount: 2, recognitions: 0 }]);
    assert.equal(f.orgRate, 10);
    const ops = f.rows.find((r) => r.group === "Ops")!;
    assert.equal(ops.underRecognised, true);
    assert.equal(f.rows.find((r) => r.group === "Tiny")!.underRecognised, false, "groups under 3 are not flagged");
    assert.equal(f.rows.find((r) => r.group === "Eng")!.underRecognised, false);
  });
});

describe("Wellness", () => {
  test("ISO week start is Monday", () => {
    assert.equal(isoWeekStart(d("2026-10-04")).toISOString().slice(0, 10), "2026-09-28");
    assert.equal(isoWeekStart(d("2026-09-28")).toISOString().slice(0, 10), "2026-09-28");
  });
  test("challenge progress", () => {
    assert.deepEqual(challengeProgress(50, 200), { pct: 25, completed: false });
    assert.deepEqual(challengeProgress(250, 200), { pct: 100, completed: true });
    assert.deepEqual(challengeProgress(10, null), { pct: 0, completed: false });
  });
  test("wellbeing is aggregated with a minimum group", () => {
    const rows = [
      { group: "Eng", mood: 2, stress: 5, wantsSupport: true }, { group: "Eng", mood: 4, stress: 2 }, { group: "Eng", mood: 3, stress: 4 },
      { group: "Sales", mood: 5, stress: 1 },
    ];
    const s = wellbeingSummary(rows, 3);
    assert.equal(s.overall!.n, 4);
    const eng = s.groups.find((g) => g.group === "Eng")!;
    assert.equal(eng.hidden, false);
    if (!eng.hidden) { assert.equal(eng.avgMood, 3); assert.equal(eng.lowMoodPct, 33); assert.equal(eng.highStressPct, 67); assert.equal(eng.supportRequests, 1); }
    assert.equal(s.groups.find((g) => g.group === "Sales")!.hidden, true);
    assert.equal(wellbeingSummary(rows.slice(0, 2), 3).overall, null);
  });
});

describe("Communication", () => {
  const e = { departmentId: "eng", locationId: "blr", businessUnitId: "bu1", status: "CONFIRMED" };
  test("audience filters", () => {
    assert.equal(inAudience(null, e), true);
    assert.equal(inAudience({}, e), true);
    assert.equal(inAudience({ departmentIds: ["eng"] }, e), true);
    assert.equal(inAudience({ departmentIds: ["sales"] }, e), false);
    assert.equal(inAudience({ locationIds: ["blr"], departmentIds: ["eng"] }, e), true);
    assert.equal(inAudience({ locationIds: ["mum"] }, e), false);
    assert.equal(inAudience({ businessUnitIds: ["bu2"] }, e), false);
    assert.equal(inAudience({ excludeOnNotice: true }, { ...e, status: "NOTICE_PERIOD" }), false);
  });
  test("RSVP capacity and the waitlist", () => {
    assert.equal(rsvpOutcome("GOING", 2, 1), "GOING");
    assert.equal(rsvpOutcome("GOING", 2, 2), "WAITLIST");
    assert.equal(rsvpOutcome("MAYBE", 2, 5), "MAYBE");
    assert.equal(rsvpOutcome("GOING", null, 500), "GOING");
    const rs = [
      { id: "1", response: "GOING", createdAt: d("2026-10-01") },
      { id: "2", response: "WAITLIST", createdAt: d("2026-10-03") },
      { id: "3", response: "WAITLIST", createdAt: d("2026-10-02") },
    ];
    assert.deepEqual(promoteFromWaitlist(rs, 2).map((r) => r.id), ["3"]);
    assert.deepEqual(promoteFromWaitlist(rs, 1), []);
  });
  test("reach statistics", () => {
    assert.deepEqual(reachStats(10, 8, 5), { audience: 10, viewed: 8, acknowledged: 5, viewedPct: 80, ackPct: 50, pending: 5 });
    assert.equal(reachStats(0, 0, 0).ackPct, 0);
  });
  test("engage approvals are workflow entity types", () => {
    for (const k of Object.keys(ENGAGE_WORKFLOW_TYPES)) {
      assert.ok(k in WORKFLOW_ENTITY_TYPES, k);
      assert.equal(isEngageWorkflowType(k), true);
    }
    assert.equal(isEngageWorkflowType("ACCESS_REQUEST"), false);
  });
});
