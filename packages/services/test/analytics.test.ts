import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  leavingDate, onBooks, headcountAt, averageHeadcount, leaversIn, growthKpis, monthsIn, presetWindow, previousWindow,
  windowMonths, attritionTenureBand, attritionAgeBand, sinceRaiseBand, perfBin, countBy, scoreRisk, riskBand, riskFeaturesAt, riskEligible,
  suppressSmall, ungroundedNumbers, redactQuestion, namesSomeone, monthsBetween, RISK_FACTORS,
  type PopMember, type RiskFeatures, type RiskInputs,
} from "../src/analytics-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Leavers and headcount", () => {
  test("a leaver is someone whose exit is approved or who has exited, on their last working day", () => {
    assert.equal(leavingDate({ status: "CONFIRMED", lastWorkingDay: null, exitRecord: { status: "PENDING_APPROVAL", lastWorkingDay: d("2026-11-24") } }), null);
    assert.equal(leavingDate({ status: "NOTICE_PERIOD", lastWorkingDay: null, exitRecord: { status: "APPROVED", lastWorkingDay: d("2026-10-31") } })?.toISOString().slice(0, 10), "2026-10-31");
    assert.equal(leavingDate({ status: "EXITED", lastWorkingDay: d("2025-03-14"), exitRecord: null })?.toISOString().slice(0, 10), "2025-03-14");
    assert.equal(leavingDate({ status: "CONFIRMED", lastWorkingDay: null, exitRecord: { status: "RETAINED", lastWorkingDay: d("2026-01-01") } }), null);
  });

  const pop: PopMember[] = [
    { id: "a", dateOfJoining: d("2020-01-01"), status: "CONFIRMED", leftOn: null },
    { id: "b", dateOfJoining: d("2021-06-01"), status: "EXITED", leftOn: d("2026-02-15") },
    { id: "c", dateOfJoining: d("2026-03-10"), status: "PROBATION", leftOn: null },
    { id: "d", dateOfJoining: d("2026-09-01"), status: "PREBOARDING", leftOn: null },
  ];

  test("someone is on the books from joining to their last day, inclusive", () => {
    assert.equal(onBooks(pop[1], d("2026-02-15")), true);
    assert.equal(onBooks(pop[1], d("2026-02-16")), false);
    assert.equal(onBooks(pop[2], d("2026-03-09")), false);
    assert.equal(onBooks(pop[3], d("2026-09-30")), false, "preboarding never counts");
    assert.equal(headcountAt(pop, d("2026-01-31")), 2);
    assert.equal(headcountAt(pop, d("2026-03-31")), 2);
  });

  test("windows, rates and growth", () => {
    const w = { from: d("2026-01-01"), to: d("2026-03-31") };
    assert.deepEqual(monthsIn(w).map((m) => m.label), ["Jan-2026", "Feb-2026", "Mar-2026"]);
    assert.equal(windowMonths(w), 3);
    assert.equal(leaversIn(pop, w).length, 1);
    // Opening 2, Jan-end 2, Feb-end 1, Mar-end 2.
    assert.equal(averageHeadcount(pop, w), 7 / 4);
    const k = growthKpis(pop, w);
    assert.equal(k.opening, 2);
    assert.equal(k.closing, 2);
    assert.equal(k.joiners, 1);
    assert.equal(k.retained, 1);
    assert.equal(k.retentionRate, 0.5);
    assert.equal(k.growthRate, 0);
  });

  test("'last N months' is the last N full months, and the previous window matches its length", () => {
    const w = presetWindow(d("2026-10-01"), 3);
    assert.equal(w.from.toISOString().slice(0, 10), "2026-07-01");
    assert.equal(w.to.toISOString().slice(0, 10), "2026-09-30");
    const p = previousWindow(w);
    assert.equal(p.from.toISOString().slice(0, 10), "2026-04-01");
    assert.equal(p.to.toISOString().slice(0, 10), "2026-06-30");
    const y = presetWindow(d("2026-10-15"), 12);
    assert.equal(y.from.toISOString().slice(0, 10), "2025-10-01");
  });
});

describe("Bands", () => {
  test("each value lands in exactly one band", () => {
    assert.equal(attritionTenureBand(0.5), "<1");
    assert.equal(attritionTenureBand(1), "1-2");
    assert.equal(attritionTenureBand(4.99), "3-5");
    assert.equal(attritionTenureBand(12), "10+");
    assert.equal(attritionAgeBand(21), "<22");
    assert.equal(attritionAgeBand(25), "22-25");
    assert.equal(attritionAgeBand(56), "55+");
    assert.equal(sinceRaiseBand(null), "Never");
    assert.equal(sinceRaiseBand(12), "12-18");
    assert.equal(sinceRaiseBand(30), "24+");
    assert.equal(perfBin(null), "Not rated");
    assert.equal(perfBin(3.99), "3-4");
    assert.equal(perfBin(5), "4-5");
    assert.equal(monthsBetween(d("2025-04-01"), d("2026-10-01")), 18);
    assert.equal(monthsBetween(d("2025-04-15"), d("2026-10-01")), 17);
  });
  test("countBy keeps the band order and can drop empty bins", () => {
    const rows = countBy([1, 25, 25, 40], (n) => attritionAgeBand(n), ["<22", "22-25", "26-30", "31-40"], true);
    assert.deepEqual(rows, [{ label: "<22", value: 1 }, { label: "22-25", value: 2 }, { label: "31-40", value: 1 }]);
  });
});

describe("Attrition risk (risk-v1)", () => {
  const base: RiskFeatures = {
    tenureMonths: 60, monthsSinceRaise: 6, lastRaisePct: 0.1, compaRatio: 1, latestRating: 3.4, previousRating: 3.4,
    activePip: false, managerChanges12m: 0, managerLeaving: false, peerExits6m: 0, shortNoticeLeaves90d: 0,
    unexplainedAbsences60d: 0, hoursDropPct: 0, praise180d: 1, priorResignation: false,
  };

  test("the weights add up to 100", () => {
    assert.equal(RISK_FACTORS.reduce((s, f) => s + f.max, 0), 100);
  });

  test("a settled, recently raised employee is low risk", () => {
    const r = scoreRisk(base);
    assert.equal(r.score, 2);
    assert.equal(r.band, "LOW");
    assert.equal(r.coverage, 14);
  });

  test("an unrewarded top performer whose team is leaving is high risk, and every point is explained", () => {
    const r = scoreRisk({ ...base, tenureMonths: 55, monthsSinceRaise: 55, lastRaisePct: null, compaRatio: 0.78, latestRating: 4, managerChanges12m: 2, peerExits6m: 3, praise180d: 0 });
    // 5 tenure + 18 raise + 8 pay + 10 perf + 7 manager + 6 peers + 2 praise
    assert.equal(r.score, 56);
    assert.equal(r.band, "HIGH");
    assert.equal(r.factors.find((f) => f.key === "last_raise_small")!.hasData, false);
    assert.equal(r.coverage, 13);
    assert.ok(r.factors.every((f) => !/₹|\bRs\b|\d{5,}/.test(f.detail)), "evidence never carries amounts");
  });

  test("bands and missing data", () => {
    assert.equal(riskBand(49), "MEDIUM");
    assert.equal(riskBand(50), "HIGH");
    assert.equal(riskBand(29), "LOW");
    const r = scoreRisk({ ...base, latestRating: null, previousRating: null, shortNoticeLeaves90d: null, unexplainedAbsences60d: null, praise180d: null, compaRatio: null });
    assert.equal(r.coverage, 8);
  });

  test("nobody is scored before their first review is due", () => {
    const r = scoreRisk({ ...base, tenureMonths: 7, monthsSinceRaise: 7, lastRaisePct: null });
    assert.equal(r.factors.find((f) => f.key === "months_since_raise")!.points, 0);
  });

  const input: RiskInputs = {
    employees: [
      { id: "mgr", status: "CONFIRMED", dateOfJoining: d("2018-01-01"), reportingManagerId: null, gradeMid: null, exit: null, lastWorkingDay: null },
      { id: "e1", status: "CONFIRMED", dateOfJoining: d("2022-02-14"), reportingManagerId: "mgr", gradeMid: 1600000, exit: null, lastWorkingDay: null },
      { id: "p1", status: "EXITED", dateOfJoining: d("2023-01-01"), reportingManagerId: "mgr", gradeMid: null, exit: { status: "COMPLETED", noticeDate: d("2026-05-01"), lastWorkingDay: d("2026-06-30"), type: "RESIGNATION" }, lastWorkingDay: d("2026-06-30") },
      { id: "p2", status: "CONFIRMED", dateOfJoining: d("2023-01-01"), reportingManagerId: "mgr", gradeMid: null, exit: { status: "PENDING_APPROVAL", noticeDate: d("2026-09-20"), lastWorkingDay: d("2026-11-20"), type: "RESIGNATION" }, lastWorkingDay: null },
    ],
    revisions: [
      { employeeId: "e1", effectiveFrom: d("2022-02-14"), annualCtc: 1250000, previousCtc: null },
      { employeeId: "e1", effectiveFrom: d("2025-04-01"), annualCtc: 1350000, previousCtc: 1300000 },
    ],
    ratings: [
      { employeeId: "e1", at: d("2025-05-10"), rating: 3.8 },
      { employeeId: "e1", at: d("2026-05-10"), rating: 2.6 },
    ],
    pips: [],
    jobRecords: [
      { employeeId: "e1", effectiveFrom: d("2022-02-14"), reportingManagerId: "x", reason: "NEW_HIRE" },
      { employeeId: "e1", effectiveFrom: d("2026-03-01"), reportingManagerId: "mgr", reason: "MANAGER_CHANGE" },
    ],
    leaves: [
      { employeeId: "e1", fromDate: d("2026-09-04"), createdAt: d("2026-09-03"), totalDays: 1, status: "APPROVED" },
      { employeeId: "e1", fromDate: d("2026-09-14"), createdAt: d("2026-09-14"), totalDays: 1, status: "APPROVED" },
      { employeeId: "e1", fromDate: d("2026-08-20"), createdAt: d("2026-08-01"), totalDays: 1, status: "APPROVED" },
    ],
    attendance: [],
    praise: [{ toEmployeeId: "mgr", createdAt: d("2026-08-01") }],
  };

  test("features are read as at a date, so the past can be replayed", () => {
    const now = riskFeaturesAt(input, "e1", d("2026-10-01"));
    assert.equal(now.monthsSinceRaise, 18);
    assert.equal(Math.round(now.lastRaisePct! * 1000), 38);
    assert.equal(now.compaRatio, 1350000 / 1600000);
    assert.equal(now.latestRating, 2.6);
    assert.equal(now.previousRating, 3.8);
    assert.equal(now.managerChanges12m, 1);
    assert.equal(now.peerExits6m, 2, "a teammate who left and one who has resigned");
    assert.equal(now.shortNoticeLeaves90d, 2, "the leave planned three weeks ahead does not count");
    assert.equal(now.unexplainedAbsences60d, null, "no attendance history");
    assert.equal(now.praise180d, 0);
    const then = riskFeaturesAt(input, "e1", d("2025-06-01"));
    assert.equal(then.latestRating, 3.8);
    assert.equal(then.previousRating, null);
    assert.equal(then.peerExits6m, 0);
    assert.equal(then.managerChanges12m, 0);
  });

  test("people already resigning, gone or not yet joined are not scored", () => {
    assert.equal(riskEligible(input.employees[1], d("2026-10-01")), true);
    assert.equal(riskEligible(input.employees[2], d("2026-10-01")), false);
    assert.equal(riskEligible(input.employees[3], d("2026-10-01")), false);
    assert.equal(riskEligible(input.employees[3], d("2026-06-01")), true);
    assert.equal(riskEligible(input.employees[1], d("2021-01-01")), false);
  });
});

describe("AI guards", () => {
  test("small groups are merged before anything leaves the building", () => {
    const rows = suppressSmall([{ label: "Sales", headcount: 8, leavers: 4 }, { label: "Legal", headcount: 2, leavers: 1 }, { label: "IT", headcount: 1, leavers: 0 }]);
    assert.deepEqual(rows.map((r) => r.label), ["Sales", "Other"]);
    assert.equal(rows[1].headcount, 3);
    assert.equal(rows[0].ratePct, 50);
  });
  test("an answer may only cite numbers it was given", () => {
    const payload = { kpis: { leavers: 42, attritionPct: 15.24 }, breakdowns: [{ label: "1-3y", ratePct: 25 }] };
    assert.deepEqual(ungroundedNumbers("42 people left (15.2%); 1-3 year tenure saw 25%.", payload), []);
    assert.deepEqual(ungroundedNumbers("Attrition rose to 18% in 2026, 3 months running.", payload), [18]);
    assert.deepEqual(ungroundedNumbers("About 1,240 people", payload), [1240]);
  });
  test("questions lose contact details and employee numbers, and naming a person is caught", () => {
    assert.equal(redactQuestion("Why did ACM0016 (pooja@acme.test, 9876543210) leave?", "ACM"), "Why did [employee] ([email], [phone]) leave?");
    assert.equal(namesSomeone("Is Pooja Malhotra likely to leave?", ["Pooja Malhotra", "Rahul Kapoor"]), true);
    assert.equal(namesSomeone("Why is Sales attrition high?", ["Pooja Malhotra"]), false);
  });
});
