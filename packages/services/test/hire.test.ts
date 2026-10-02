import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  annualise, annualBudget, nextRequisitionCode, requisitionProblems, totalPositions, requisitionStatus,
  normaliseDecision, decisionLabel, parseKit, kitOf, DEFAULT_SCORECARD, parseRatings, cleanRatings, ratingsAverage,
  decisionTally, validateQuestionSet, validateSummary, plainText, type RequisitionDraft,
} from "../src/hire-math";

const today = new Date(Date.UTC(2026, 9, 1));
const draft = (over: Partial<RequisitionDraft> = {}): RequisitionDraft => ({
  title: "Software Engineer", departmentId: "d1", newHire: true, newPositions: 1, backfills: [], currency: "INR",
  salaryMin: null, salaryMax: null, salaryFrequency: null, description: "Build and run the services behind payroll, end to end.", targetStartDate: null, ...over,
});

describe("Requisition budget", () => {
  test("a quoted range becomes an annual figure by its frequency", () => {
    assert.equal(annualise(100, "HOURLY"), 208000);
    assert.equal(annualise(50000, "BIWEEKLY"), 1300000);
    assert.equal(annualise(150000, "MONTHLY"), 1800000);
    assert.equal(annualise(2400000, "ANNUAL"), 2400000);
    assert.equal(annualise(100, null), null);
    assert.equal(annualise(100, "WEEKLY"), null);
  });
  test("only an INR range with a frequency sets the offer ceiling", () => {
    assert.deepEqual(annualBudget({ currency: "INR", salaryMin: 150000, salaryMax: 220000, salaryFrequency: "MONTHLY" }), { minAnnualCtc: 1800000, maxAnnualCtc: 2640000 });
    assert.deepEqual(annualBudget({ currency: "USD", salaryMin: 5000, salaryMax: 7000, salaryFrequency: "MONTHLY" }), { minAnnualCtc: null, maxAnnualCtc: null });
    assert.deepEqual(annualBudget({ currency: "INR", salaryMin: 100, salaryMax: 200, salaryFrequency: null }), { minAnnualCtc: null, maxAnnualCtc: null });
    assert.deepEqual(annualBudget({ currency: "INR", salaryMin: null, salaryMax: 3600000, salaryFrequency: "ANNUAL" }), { minAnnualCtc: null, maxAnnualCtc: 3600000 });
  });
});

describe("Requisition codes and positions", () => {
  test("codes continue from the highest used, ignoring others", () => {
    assert.equal(nextRequisitionCode([]), "REQ-0001");
    assert.equal(nextRequisitionCode(["REQ-0003", null, "REQ-0010", "HY04363QL"]), "REQ-0011");
    assert.equal(nextRequisitionCode(["REQ-9999"]), "REQ-10000");
  });
  test("total positions are new hires plus one per backfilled employee", () => {
    assert.equal(totalPositions({ newHire: true, newPositions: 2, backfills: [{}, {}] }), 4);
    assert.equal(totalPositions({ newHire: false, newPositions: 5, backfills: [{}] }), 1);
  });
});

describe("Requisition validation", () => {
  test("a complete requisition has no problems", () => {
    assert.deepEqual(requisitionProblems(draft(), today), {});
  });
  test("it must be a new hire, a backfill or both", () => {
    assert.ok(requisitionProblems(draft({ newHire: false }), today).positions);
    assert.deepEqual(requisitionProblems(draft({ newHire: false, backfills: [{ employeeId: "e1", reason: "RELIEVED" }] }), today), {});
  });
  test("every backfill needs a known reason, and no one twice", () => {
    assert.ok(requisitionProblems(draft({ backfills: [{ employeeId: "e1", reason: "" }] }), today).backfills);
    assert.ok(requisitionProblems(draft({ backfills: [{ employeeId: "e1", reason: "FIRED" }] }), today).backfills);
    assert.ok(requisitionProblems(draft({ backfills: [{ employeeId: "e1", reason: "RELIEVED" }, { employeeId: "e1", reason: "PROMOTION" }] }), today).backfills);
  });
  test("salary: min not above max, and a frequency once an amount is given", () => {
    assert.ok(requisitionProblems(draft({ salaryMin: 20, salaryMax: 10, salaryFrequency: "ANNUAL" }), today).salaryMax);
    assert.ok(requisitionProblems(draft({ salaryMin: 10 }), today).salaryFrequency);
    assert.ok(requisitionProblems(draft({ salaryMin: -1, salaryFrequency: "ANNUAL" }), today).salaryMin);
    assert.ok(requisitionProblems(draft({ currency: "XYZ" }), today).currency);
  });
  test("title, department, positions bounds, description and a future date", () => {
    const e = requisitionProblems(draft({ title: " ", departmentId: null, newPositions: 101, description: "short", targetStartDate: new Date(Date.UTC(2026, 8, 30)) }), today);
    assert.ok(e.title && e.departmentId && e.newPositions && e.description && e.targetStartDate);
    assert.equal(requisitionProblems(draft({ targetStartDate: today }), today).targetStartDate, undefined);
  });
});

describe("Requisition status as Keka shows it", () => {
  test("approved with a job is hiring in progress; archived wins", () => {
    assert.equal(requisitionStatus({ status: "APPROVED", archivedAt: null, jobCount: 1 }).label, "Hiring in Progress");
    assert.equal(requisitionStatus({ status: "APPROVED", archivedAt: null, jobCount: 0 }).label, "Approved");
    assert.equal(requisitionStatus({ status: "PENDING_APPROVAL", archivedAt: null, jobCount: 0 }).label, "Pending");
    assert.equal(requisitionStatus({ status: "REJECTED", archivedAt: new Date(), jobCount: 0 }).label, "Archived");
  });
});

describe("Scorecard decisions", () => {
  test("legacy recommendations map to Keka's five levels", () => {
    assert.equal(normaliseDecision("STRONG_YES"), "MUST_HIRE");
    assert.equal(normaliseDecision("YES"), "HIRE");
    assert.equal(normaliseDecision("NO"), "NO_HIRE");
    assert.equal(normaliseDecision("STRONG_NO"), "NO_HIRE");
    assert.equal(normaliseDecision("AVERAGE"), "AVERAGE");
    assert.equal(normaliseDecision("MAYBE"), null);
    assert.equal(decisionLabel("YES"), "Hire");
  });
  test("the tally counts decisions, most common first", () => {
    const t = decisionTally(["HIRE", "YES", "NO_HIRE", null, "MUST_HIRE"]);
    assert.deepEqual(t.map((x) => [x.decision, x.count]), [["HIRE", 2], ["MUST_HIRE", 1], ["NO_HIRE", 1]]);
  });
});

describe("Interview kit and ratings", () => {
  const kit = [{ section: "Technical", skills: [{ name: "Design" }, { name: "Testing" }] }, { section: "Soft", skills: [{ name: "Communication" }] }];
  test("a usable kit is kept, an empty one falls back to the default", () => {
    assert.equal(parseKit(kit)?.length, 2);
    assert.equal(parseKit([{ section: " ", skills: [{ name: "x" }] }]), null);
    assert.equal(parseKit("nope"), null);
    assert.deepEqual(kitOf(null), DEFAULT_SCORECARD);
  });
  test("legacy ratings are read and rescaled to five stars", () => {
    const r = parseRatings([{ competency: "Design", rating: 8, maxRating: 10, comment: "ok" }]);
    assert.deepEqual(r, [{ section: "Overall", skill: "Design", rating: 4, comment: "ok" }]);
  });
  test("only the kit's skills survive, with whole 1-5 stars or N/A", () => {
    const r = cleanRatings([
      { section: "Technical", skill: "Design", rating: 5, comment: null },
      { section: "Technical", skill: "Design", rating: 1, comment: null },
      { section: "Technical", skill: "Testing", rating: 7, comment: "too high" },
      { section: "Technical", skill: "Invented", rating: 5, comment: null },
      { section: "Soft", skill: "Communication", rating: 3.5, comment: null },
    ], kit);
    assert.deepEqual(r.map((x) => [x.skill, x.rating]), [["Design", 5], ["Testing", null]]);
  });
  test("the scorecard average is the mean of rated skills", () => {
    assert.equal(ratingsAverage([{ section: "a", skill: "x", rating: 4, comment: null }, { section: "a", skill: "y", rating: 5, comment: null }, { section: "a", skill: "z", rating: null, comment: "n/a" }]), 4.5);
    assert.equal(ratingsAverage([]), null);
  });
});

describe("AI answers are checked before use", () => {
  test("a question set must answer every requested skill with enough distinct questions", () => {
    const good = { skills: [{ skill: "Communication", questions: ["Tell us about a time you explained a trade-off?", "How do you keep stakeholders informed?", "Describe feedback you acted on recently?"] }] };
    assert.equal(validateQuestionSet(good, ["Communication"])?.[0].questions.length, 3);
    assert.equal(validateQuestionSet(good, ["Communication", "Ownership"]), null);
    assert.equal(validateQuestionSet({ skills: [{ skill: "Communication", questions: ["short", "short", "short"] }] }, ["Communication"]), null);
    assert.equal(validateQuestionSet("text", ["Communication"]), null);
  });
  test("a summary may only name the interviewers it was given", () => {
    assert.ok(validateSummary({ summary: "The panel agrees the candidate is strong.", individual: [{ ref: "Interviewer 1", text: "Positive." }] }, ["Interviewer 1"]));
    assert.equal(validateSummary({ summary: "The panel agrees the candidate is strong.", individual: [{ ref: "Priya", text: "x" }] }, ["Interviewer 1"]), null);
    assert.equal(validateSummary({ summary: "short" }, []), null);
  });
  test("plain text strips the markdown the editor writes", () => {
    assert.equal(plainText("**Bold** and *it*  [link](x)"), "Bold and it linkx");
  });
});
