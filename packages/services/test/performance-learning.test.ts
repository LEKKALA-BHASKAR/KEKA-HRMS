import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  timeframeFor, timeframeOptions, timeframeOfDates, parseTimeframe, goalBucket, progressSeries,
  formatCourseDuration, courseCompletionPct, gradeAttempt, validateQuestion, parseQuestionCsv,
  parseAgendaItems, parseMeetingSummary, parseGoalSuggestions, parseGeneratedQuestions,
} from "../src/performance-learning-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe("Goal timeframes", () => {
  test("follow the April financial year", () => {
    const q = timeframeFor("QUARTER", d("2026-10-01"));
    assert.equal(q.label, "Q3 2026-27");
    assert.equal(iso(q.start), "2026-10-01");
    assert.equal(iso(q.end), "2026-12-31");
    const q4 = timeframeFor("QUARTER", d("2027-02-14"));
    assert.equal(q4.label, "Q4 2026-27");
    assert.equal(iso(q4.end), "2027-03-31");
    const h = timeframeFor("HALF_YEAR", d("2026-05-20"));
    assert.equal(h.label, "H1 2026-27");
    assert.equal(iso(h.end), "2026-09-30");
    const y = timeframeFor("YEAR", d("2026-10-01"));
    assert.equal(y.label, "FY 2026-27");
    assert.deepEqual([iso(y.start), iso(y.end)], ["2026-04-01", "2027-03-31"]);
  });
  test("a January-start year", () => {
    const q = timeframeFor("QUARTER", d("2026-10-01"), 1);
    assert.equal(q.label, "Q4 2026-27");
    assert.equal(iso(q.start), "2026-10-01");
  });
  test("options cover this year and next, in order", () => {
    const opts = timeframeOptions(d("2026-10-01"));
    assert.equal(opts.length, 14);
    assert.equal(opts[0].label, "FY 2026-27");
    assert.ok(opts.some((o) => o.label === "Q1 2027-28"));
    for (let i = 1; i < opts.length; i++) assert.ok(opts[i].start >= opts[i - 1].start);
  });
  test("dates map back to their period, and labels parse", () => {
    assert.equal(timeframeOfDates(d("2026-10-01"), d("2026-12-31")), "Q3 2026-27");
    assert.equal(timeframeOfDates(d("2026-04-01"), d("2027-03-31")), "FY 2026-27");
    assert.equal(timeframeOfDates(d("2026-05-03"), d("2026-11-30")), "FY 2026-27");
    assert.equal(iso(parseTimeframe("H2 2026-27")!.start), "2026-10-01");
    assert.equal(parseTimeframe("Next year"), null);
  });
});

describe("Goals page buckets and line", () => {
  test("Keka's status buckets", () => {
    assert.equal(goalBucket({ status: "DRAFT", progressPercent: 0, checkIns: 0 }), "DRAFT");
    assert.equal(goalBucket({ status: "ON_TRACK", progressPercent: 0, checkIns: 0 }), "NOT_STARTED");
    assert.equal(goalBucket({ status: "AT_RISK", progressPercent: 0, checkIns: 1 }), "AT_RISK");
    assert.equal(goalBucket({ status: "MISSED", progressPercent: 30, checkIns: 2 }), "CLOSED");
    assert.equal(goalBucket({ status: "ON_TRACK", progressPercent: 40, checkIns: 2 }), "ON_TRACK");
  });
  test("average progress uses the latest check-in at each point", () => {
    const s = progressSeries([
      { checkIns: [{ at: d("2026-05-01"), progress: 20 }, { at: d("2026-08-01"), progress: 60 }] },
      { checkIns: [] },
    ], d("2026-04-01"), d("2026-09-01"), 3);
    assert.deepEqual(s.map((p) => p.value), [0, 10, 30]);
  });
});

describe("Learn arithmetic", () => {
  test("durations and progress", () => {
    assert.equal(formatCourseDuration(0), "0h 00m");
    assert.equal(formatCourseDuration(169), "2h 49m");
    assert.equal(courseCompletionPct(0, 0), 0);
    assert.equal(courseCompletionPct(3, 1), 33);
    assert.equal(courseCompletionPct(3, 5), 100);
  });
  test("an answer counts only when it is exactly the correct set", () => {
    const qs = [{ id: "a", correctOptionIds: ["o2"] }, { id: "b", correctOptionIds: ["o1", "o3"] }, { id: "c", correctOptionIds: ["o1"] }];
    assert.deepEqual(gradeAttempt(qs, { a: ["o2"], b: ["o1", "o3"], c: ["o2"] }), { correct: 2, total: 3, percent: 66.67 });
    assert.equal(gradeAttempt(qs, { b: ["o1", "o2", "o3"] }).correct, 0);
    assert.equal(gradeAttempt([], {}).percent, 0);
  });
  test("question checks", () => {
    const ok = { type: "SINGLE_CHOICE" as const, prompt: "Which?", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }], correctOptionIds: ["o2"] };
    assert.equal(validateQuestion(ok), null);
    assert.match(validateQuestion({ ...ok, correctOptionIds: [] })!, /correct/);
    assert.match(validateQuestion({ ...ok, correctOptionIds: ["o1", "o2"] })!, /exactly one/);
    assert.equal(validateQuestion({ ...ok, type: "MULTIPLE_CHOICE", correctOptionIds: ["o1", "o2"] }), null);
    assert.match(validateQuestion({ ...ok, options: [{ id: "o1", text: "A" }] })!, /two options/);
    assert.match(validateQuestion({ ...ok, options: [{ id: "o1", text: "A" }, { id: "o2", text: "a" }] })!, /same/);
    assert.match(validateQuestion({ ...ok, prompt: " " })!, /Type/);
  });
  test("bulk CSV", () => {
    const { questions, errors } = parseQuestionCsv(
      'question,type,option 1,option 2,option 3,correct\n"What is PF, really?",single,Tax,Retirement saving,Bonus,2\nPick two,multiple,A,B,C,1;3\nBroken,single,Only one,1\n',
    );
    assert.equal(questions.length, 2);
    assert.equal(questions[0].prompt, "What is PF, really?");
    assert.deepEqual(questions[1].correctOptionIds, ["o1", "o3"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Line 4/);
  });
});

describe("AI answer shapes", () => {
  test("agenda items are trimmed and bounded", () => {
    assert.deepEqual(parseAgendaItems(["- Wins", "2. Blockers", "Goals", "", 4]), ["Wins", "Blockers", "Goals"]);
    assert.equal(parseAgendaItems(["only one"]), null);
    assert.equal(parseAgendaItems("not a list"), null);
    assert.equal(parseAgendaItems(Array.from({ length: 12 }, (_, i) => `Item ${i}`))!.length, 8);
  });
  test("a meeting summary", () => {
    const s = parseMeetingSummary({ summary: "Talked growth.", decisions: ["Ship v2"], actionItems: [{ description: "Draft plan", owner: "REPORT", dueInDays: 7 }, { description: "", owner: "X" }, { description: "Review", owner: "boss", dueInDays: 400 }] });
    assert.equal(s!.actionItems.length, 2);
    assert.equal(s!.actionItems[1].owner, "MANAGER");
    assert.equal(s!.actionItems[1].dueInDays, null);
    assert.equal(parseMeetingSummary({ decisions: [] }), null);
  });
  test("goal suggestions fall back to a percentage when the numbers do not add up", () => {
    const g = parseGoalSuggestions([
      { title: "Increase deployment frequency", metricType: "NUMBER_INCREASE", startValue: 10, targetValue: 15, metricName: "deploys/month", alignsTo: 0 },
      { title: "Reduce deployment failures", metricType: "NUMBER_DECREASE", startValue: 2, targetValue: 8 },
      { title: "increase deployment frequency" },
      { title: "Implement CI/CD pipeline", metricType: "COMPLETION", alignsTo: 9 },
    ], 1)!;
    assert.equal(g.length, 3);
    assert.equal(g[0].alignsTo, 0);
    assert.equal(g[1].metricType, "PERCENTAGE");
    assert.equal(g[2].alignsTo, null);
  });
  test("generated questions must be answerable", () => {
    const q = parseGeneratedQuestions({ questions: [
      { prompt: "What is a job analysis for?", options: ["Salaries", "Skills needed for a job", "Attendance", "Appraisals"], correct: [2] },
      { prompt: "Broken", options: ["A", "B"], correct: [5] },
    ] }, "SINGLE_CHOICE", 5)!;
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].correctOptionIds, ["o2"]);
    const tf = parseGeneratedQuestions([{ prompt: "PF is optional for everyone.", correct: 2 }], "TRUE_FALSE", 1)!;
    assert.deepEqual(tf[0].options.map((o) => o.text), ["True", "False"]);
  });
});
