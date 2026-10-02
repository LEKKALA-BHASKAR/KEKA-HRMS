import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enps, ratingSummary, choiceTally, driverScores, canReveal, validateSubmission, participation, type QuestionDef } from "../src/engagement-math";
import { gradeQuiz, courseProgress, courseScore, enrolmentStanding, formatMinutes } from "../src/learning-math";
import { monthlySeries, annualAttrition, tenureBand, ageBand, tally, averageTenure, activeOn, pctChange, type WorkforceRow } from "../src/analytics-math";
import { encashmentFormulaParts as parseEncashmentFormula } from "../src/time-math";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("eNPS", () => {
  test("promoters minus detractors, as a percentage of everyone", () => {
    // 4 promoters, 3 passives, 3 detractors of 10 → 40 − 30 = 10
    const r = enps([10, 9, 9, 10, 8, 7, 7, 6, 0, 3]);
    assert.deepEqual({ ...r }, { score: 10, promoters: 4, passives: 3, detractors: 3, n: 10 });
  });
  test("7 and 8 are passive, 6 is a detractor — the boundaries", () => {
    assert.equal(enps([7, 8]).score, 0);
    assert.equal(enps([6]).score, -100);
    assert.equal(enps([9]).score, 100);
  });
  test("no responses is zero, not NaN", () => assert.equal(enps([]).score, 0));
});

describe("Rating summary", () => {
  test("favourable is 4s and 5s; the three shares add to 100", () => {
    const s = ratingSummary([5, 4, 4, 3, 2, 1, 5, 4]);
    assert.equal(s.favourable, 63); // 5/8
    assert.equal(s.unfavourable, 25);
    assert.equal(s.favourable + s.neutral + s.unfavourable, 100);
    assert.deepEqual(s.distribution, [1, 1, 1, 3, 2]);
    assert.equal(s.mean, 3.5);
  });
});

describe("Choice tally", () => {
  test("multi-choice counts each option once per respondent; percentages are of respondents", () => {
    const t = choiceTally(["A", "B", "C"], [{ choices: [0, 1] }, { choices: [1, 1] }, { choices: [] }, { choices: [7] }]);
    assert.deepEqual(t.map((x) => x.count), [1, 2, 0]);
    assert.deepEqual(t.map((x) => x.percent), [50, 100, 0]);
  });
});

describe("Drivers and anonymity", () => {
  const qs: QuestionDef[] = [
    { id: "q1", type: "RATING", prompt: "", driver: "Growth", options: [], required: true },
    { id: "q2", type: "RATING", prompt: "", driver: "Manager", options: [], required: true },
    { id: "q3", type: "TEXT", prompt: "", driver: "Growth", options: [], required: false },
  ];
  test("each driver pools the rating questions tagged with it; text is ignored", () => {
    const d = driverScores(qs, [
      { questionId: "q1", score: 5, choices: [], text: null }, { questionId: "q1", score: 2, choices: [], text: null },
      { questionId: "q2", score: 4, choices: [], text: null }, { questionId: "q3", score: null, choices: [], text: "hi" },
    ]);
    assert.deepEqual(d.map((x) => [x.driver, x.favourable, x.n]), [["Manager", 100, 1], ["Growth", 50, 2]]);
  });
  test("a group below the minimum size is withheld", () => {
    assert.equal(canReveal(2, 3), false);
    assert.equal(canReveal(3, 3), true);
    assert.equal(canReveal(1, 0), true, "a minimum of zero still means one person");
  });
  test("participation is a share of those invited", () => assert.equal(participation(7, 28), 25));
});

describe("Submission validation", () => {
  const qs: QuestionDef[] = [
    { id: "r", type: "RATING", prompt: "", driver: null, options: [], required: true },
    { id: "n", type: "NPS", prompt: "", driver: null, options: [], required: true },
    { id: "s", type: "SINGLE_CHOICE", prompt: "", driver: null, options: ["x", "y"], required: true },
    { id: "m", type: "MULTI_CHOICE", prompt: "", driver: null, options: ["x", "y", "z"], required: false },
    { id: "t", type: "TEXT", prompt: "", driver: null, options: [], required: false },
  ];
  test("a complete, valid submission is cleaned and accepted", () => {
    const v = validateSubmission(qs, [
      { questionId: "r", score: 4 }, { questionId: "n", score: 0 }, { questionId: "s", choices: [1] },
      { questionId: "m", choices: [2, 0, 2] }, { questionId: "t", text: "  more coffee  " },
    ]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.answers.find((a) => a.questionId === "m")!.choices, [0, 2]);
    assert.equal(v.answers.find((a) => a.questionId === "t")!.text, "more coffee");
  });
  test("out-of-range scores, two single choices and missing required answers are refused", () => {
    const v = validateSubmission(qs, [{ questionId: "r", score: 6 }, { questionId: "n", score: 11 }, { questionId: "s", choices: [0, 1] }]);
    assert.equal(v.ok, false);
    assert.deepEqual(Object.keys(v.errors).sort(), ["n", "r", "s"]);
  });
  test("optional questions may be skipped", () => {
    const v = validateSubmission(qs, [{ questionId: "r", score: 1 }, { questionId: "n", score: 10 }, { questionId: "s", choices: [0] }]);
    assert.equal(v.ok, true);
    assert.equal(v.answers.length, 3);
  });
});

describe("Quizzes and course progress", () => {
  const qs = [{ id: "a", correctIndex: 1, options: ["", ""] }, { id: "b", correctIndex: 0, options: ["", ""] }, { id: "c", correctIndex: 2, options: ["", "", ""] }];
  test("unanswered is wrong, and the score rounds down so 66.7% fails a 67% bar", () => {
    const g = gradeQuiz(qs, { a: 1, b: 0 }, 67);
    assert.equal(g.score, 66);
    assert.equal(g.passed, false);
    assert.equal(gradeQuiz(qs, { a: 1, b: 0, c: 2 }, 67).passed, true);
  });
  test("progress rounds down — 2 of 3 lessons is 66%, and only all lessons is 100", () => {
    assert.equal(courseProgress(3, 2), 66);
    assert.equal(courseProgress(3, 3), 100);
    assert.equal(courseProgress(0, 0), 0);
  });
  test("the course score averages quiz lessons only", () => {
    assert.equal(courseScore([80, null, 100]), 90);
    assert.equal(courseScore([null]), null);
  });
  test("standing against the due date", () => {
    const today = utc(2026, 10, 1);
    assert.equal(enrolmentStanding({ status: "IN_PROGRESS", dueDate: utc(2026, 9, 30), progressPercent: 40 }, today), "OVERDUE");
    assert.equal(enrolmentStanding({ status: "ASSIGNED", dueDate: utc(2026, 10, 5), progressPercent: 0 }, today), "DUE_SOON");
    assert.equal(enrolmentStanding({ status: "COMPLETED", dueDate: utc(2026, 9, 1), progressPercent: 100 }, today), "COMPLETED");
    assert.equal(enrolmentStanding({ status: "ASSIGNED", dueDate: null, progressPercent: 0 }, today), "NOT_STARTED");
  });
  test("minutes format", () => {
    assert.equal(formatMinutes(45), "45m");
    assert.equal(formatMinutes(120), "2h");
    assert.equal(formatMinutes(85), "1h 25m");
  });
});

describe("Workforce analytics", () => {
  const rows: WorkforceRow[] = [
    { id: "a", dateOfJoining: utc(2024, 1, 10), lastWorkingDay: null, exited: false, dateOfBirth: utc(1990, 6, 1) },
    { id: "b", dateOfJoining: utc(2026, 5, 15), lastWorkingDay: null, exited: false, dateOfBirth: utc(2003, 1, 1) },
    { id: "c", dateOfJoining: utc(2023, 3, 1), lastWorkingDay: utc(2026, 7, 31), exited: true },
    // On notice: still employed until the last day, which is in the future.
    { id: "d", dateOfJoining: utc(2025, 1, 1), lastWorkingDay: utc(2026, 11, 15), exited: false },
  ];
  const asOf = utc(2026, 10, 1);
  test("someone who left is counted until their last day, not by today's status", () => {
    assert.equal(activeOn(rows[2], utc(2026, 7, 31)), true);
    assert.equal(activeOn(rows[2], utc(2026, 8, 1)), false);
    assert.equal(activeOn(rows[3], asOf), true);
  });
  test("the monthly series counts joiners, leavers and month-end headcount", () => {
    const s = monthlySeries(rows, asOf, 6);
    assert.deepEqual(s.map((p) => p.key), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const may = s[0], jul = s[2], aug = s[3];
    assert.deepEqual([may.joiners, may.headcount], [1, 4]);
    assert.deepEqual([jul.leavers, jul.headcount], [1, 4], "a leaver on the 31st is still on July's books");
    assert.equal(aug.headcount, 3);
    assert.equal(jul.attritionPct, 25); // 1 ÷ avg(4, 4)
  });
  test("annual attrition annualises a shorter window", () => {
    const s = monthlySeries(rows, asOf, 6);
    // 1 leaver over 6 months, average headcount (4+4+4+3+3+3)/6 = 3.5 → 28.6% × 2
    assert.equal(annualAttrition(s), 57.1);
  });
  test("bands", () => {
    assert.equal(tenureBand(utc(2026, 5, 15), asOf), "< 6 months");
    assert.equal(tenureBand(utc(2024, 1, 10), asOf), "2–5 years");
    assert.equal(ageBand(utc(2003, 1, 1), asOf), "Under 25");
    assert.equal(ageBand(null, asOf), "Not recorded");
    assert.deepEqual(tally(["x", "y", "x"], (v) => v), [{ label: "x", value: 2 }, { label: "y", value: 1 }]);
    assert.deepEqual(tally([] as string[], (v) => v, ["a", "b"]).map((x) => x.value), [0, 0], "fixed order keeps empty bands");
  });
  test("average tenure counts only people still employed", () => {
    assert.equal(averageTenure(rows, asOf), 1.6);
  });
  test("percentage change", () => {
    assert.equal(pctChange(20, 25), 25);
    assert.equal(pctChange(0, 5), null);
  });
});

describe("Encashment formula", () => {
  test("component and divisor are read from the leave type's formula", () => {
    assert.deepEqual(parseEncashmentFormula("[BASIC] / 26"), { code: "BASIC", divisor: 26 });
    assert.deepEqual(parseEncashmentFormula("[GROSS]/30"), { code: "GROSS", divisor: 30 });
    assert.deepEqual(parseEncashmentFormula(null), { code: "BASIC", divisor: 30 });
  });
});

import { careerGap, placeOnPath } from "../src/learning-math";
describe("Career readiness", () => {
  test("a requirement is met only by an approved skill at or above the level", () => {
    const g = careerGap(
      [{ skillId: "ts", level: 2 }, { skillId: "sql", level: 1 }, { skillId: "lead", level: 1 }],
      [{ skillId: "ts", level: 3, isApproved: true }, { skillId: "sql", level: 0, isApproved: true }, { skillId: "lead", level: 2, isApproved: false }],
    );
    assert.deepEqual(g.rows.map((r) => r.met), [true, false, false]);
    assert.equal(g.rows[2].held, null, "an unapproved self-rating is not counted");
    assert.equal(g.readiness, 33);
  });
  test("no requirements means ready", () => assert.equal(careerGap([], []).readiness, 100));
  test("placing someone on a ladder by job title", () => {
    const steps = [{ title: "Software Engineer", sequence: 1 }, { title: "Senior Software Engineer", sequence: 2 }];
    assert.equal(placeOnPath(steps, "senior  software engineer")?.sequence, 2);
    assert.equal(placeOnPath(steps, "Designer"), null);
  });
});
