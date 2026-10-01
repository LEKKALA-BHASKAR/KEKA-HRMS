import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  probationEndDate, reviewOpensOn, confirmationEffectiveDate, extensionCheck, extendedEndDate,
  probationDue, probationStage, probationReviewSummary, validateEvaluation,
} from "../src/probation-math";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const policy = { durationDays: 90, maxExtensions: 1, completion: "EVALUATION" as const, reviewLeadDays: 15 };

describe("Probation dates", () => {
  test("90 days from 1 Aug ends 29 Oct — the start day counts", () => {
    assert.equal(iso(probationEndDate(utc(2026, 8, 1), 90)), "2026-10-29");
  });
  test("a one-day probation ends the day it starts", () => {
    assert.equal(iso(probationEndDate(utc(2026, 8, 1), 1)), "2026-08-01");
  });
  test("time of day on the joining date does not move the end", () => {
    assert.equal(iso(probationEndDate(new Date("2026-08-01T18:30:00Z"), 90)), "2026-10-29");
  });
  test("the review opens the lead days before the end", () => {
    assert.equal(iso(reviewOpensOn(utc(2026, 8, 1), utc(2026, 10, 29), 15)), "2026-10-14");
  });
  test("…but never before probation starts", () => {
    assert.equal(iso(reviewOpensOn(utc(2026, 8, 1), utc(2026, 8, 10), 30)), "2026-08-01");
  });
});

describe("Confirmation date", () => {
  test("decided in the last days: effective the day after the end", () => {
    assert.equal(iso(confirmationEffectiveDate(utc(2026, 10, 29), utc(2026, 10, 30))), "2026-10-30");
  });
  test("decided late: backdated to the day after the end", () => {
    assert.equal(iso(confirmationEffectiveDate(utc(2026, 9, 12), utc(2026, 10, 1))), "2026-09-13");
  });
  test("confirmed early: effective the day of the decision", () => {
    assert.equal(iso(confirmationEffectiveDate(utc(2026, 10, 29), utc(2026, 10, 1))), "2026-10-01");
  });
});

describe("Extensions", () => {
  test("allowed within the policy's limit", () => assert.deepEqual(extensionCheck(0, 1, 30), { ok: true }));
  test("refused once the limit is used", () => {
    const r = extensionCheck(1, 1, 30);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : "", /already been extended 1 time,/);
  });
  test("a policy without extensions says so", () => {
    const r = extensionCheck(0, 0, 30);
    assert.match(!r.ok ? r.message : "", /does not allow/);
  });
  test("zero, fractional and absurd lengths are refused", () => {
    assert.equal(extensionCheck(0, 2, 0).ok, false);
    assert.equal(extensionCheck(0, 2, 1.5).ok, false);
    assert.equal(extensionCheck(0, 2, 400).ok, false);
  });
  test("extends from the current end", () => {
    assert.equal(iso(extendedEndDate(utc(2026, 10, 29), 30, utc(2026, 10, 20))), "2026-11-28");
  });
  test("an overdue probation extends from today, never into the past", () => {
    assert.equal(iso(extendedEndDate(utc(2026, 9, 12), 30, utc(2026, 10, 1))), "2026-10-31");
  });
});

describe("What the nightly job does", () => {
  const p = { status: "ACTIVE", startDate: utc(2026, 8, 1), endDate: utc(2026, 10, 29) };
  test("nothing before the review window", () => assert.equal(probationDue(p, policy, utc(2026, 10, 13)), "NOTHING"));
  test("opens the review on the first day of the window", () => assert.equal(probationDue(p, policy, utc(2026, 10, 14)), "OPEN_REVIEW"));
  test("still opens it if the job missed the window", () => assert.equal(probationDue(p, policy, utc(2026, 11, 5)), "OPEN_REVIEW"));
  test("a review already open is left alone", () => assert.equal(probationDue({ ...p, status: "IN_REVIEW" }, policy, utc(2026, 10, 20)), "NOTHING"));
  test("decided probations are left alone", () => assert.equal(probationDue({ ...p, status: "CONFIRMED" }, policy, utc(2026, 11, 5)), "NOTHING"));
  const auto = { ...policy, completion: "AUTO_CONFIRM" as const };
  test("auto-confirm waits through the last day…", () => assert.equal(probationDue(p, auto, utc(2026, 10, 29)), "NOTHING"));
  test("…and confirms the day after", () => assert.equal(probationDue(p, auto, utc(2026, 10, 30)), "AUTO_CONFIRM"));
});

describe("Stage on the list", () => {
  const p = { status: "ACTIVE", startDate: utc(2026, 8, 1), endDate: utc(2026, 10, 29) };
  test("on track early on, with progress through the period", () => {
    const s = probationStage(p, 15, utc(2026, 9, 14));
    assert.equal(s.stage, "ON_TRACK");
    assert.equal(s.daysLeft, 45);
    assert.equal(s.progress, 50); // day 45 of 90
  });
  test("review soon once inside the window", () => assert.equal(probationStage(p, 15, utc(2026, 10, 20)).stage, "REVIEW_SOON"));
  test("in review once a review is open", () => assert.equal(probationStage({ ...p, status: "IN_REVIEW" }, 15, utc(2026, 10, 20)).stage, "IN_REVIEW"));
  test("overdue after the end without a decision, whatever the review state", () => {
    const s = probationStage({ ...p, status: "IN_REVIEW" }, 15, utc(2026, 11, 2));
    assert.equal(s.stage, "OVERDUE");
    assert.equal(s.daysLeft, -4);
    assert.equal(s.progress, 100);
  });
  test("the last day is not overdue", () => assert.equal(probationStage(p, 15, utc(2026, 10, 29)).daysLeft, 0));
});

describe("Review round", () => {
  test("the manager's recommendation and the average of submitted ratings", () => {
    const s = probationReviewSummary([
      { role: "MANAGER", status: "SUBMITTED", rating: 4, recommendation: "CONFIRM" },
      { role: "SELF", status: "SUBMITTED", rating: 5, recommendation: null },
    ]);
    assert.deepEqual(s, { submitted: 2, pending: 0, managerDone: true, recommendation: "CONFIRM", averageRating: 4.5 });
  });
  test("pending and skipped reviews do not count towards the rating", () => {
    const s = probationReviewSummary([
      { role: "MANAGER", status: "PENDING", rating: null, recommendation: null },
      { role: "SELF", status: "SUBMITTED", rating: 3, recommendation: null },
      { role: "MANAGER", status: "SKIPPED", rating: 1, recommendation: "EXTEND" },
    ]);
    assert.equal(s.managerDone, false);
    assert.equal(s.recommendation, null);
    assert.equal(s.averageRating, 3);
    assert.equal(s.pending, 1);
  });
  test("no reviews: no average rather than NaN", () => assert.equal(probationReviewSummary([]).averageRating, null));
});

describe("Evaluation checks", () => {
  test("a rating from 1 to 5 is required", () => {
    assert.deepEqual(validateEvaluation("SELF", { rating: null, recommendation: null, comments: null }).map((i) => i.field), ["rating"]);
    assert.deepEqual(validateEvaluation("SELF", { rating: 6, recommendation: null, comments: null }).map((i) => i.field), ["rating"]);
    assert.deepEqual(validateEvaluation("SELF", { rating: 4, recommendation: null, comments: null }), []);
  });
  test("a manager must recommend", () => {
    assert.deepEqual(validateEvaluation("MANAGER", { rating: 4, recommendation: null, comments: null }).map((i) => i.field), ["recommendation"]);
  });
  test("…and explain anything short of confirmation", () => {
    assert.deepEqual(validateEvaluation("MANAGER", { rating: 2, recommendation: "EXTEND", comments: null }).map((i) => i.field), ["comments"]);
    assert.deepEqual(validateEvaluation("MANAGER", { rating: 2, recommendation: "EXTEND", comments: "Needs another month on the release process" }), []);
    assert.deepEqual(validateEvaluation("MANAGER", { rating: 4, recommendation: "CONFIRM", comments: null }), []);
  });
});
