import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  reviewStep, csvField, toCsv, pathProgress, sessionSeat, sessionOpen, attemptsLeft, certificateNumber, addMonths,
  certificateStatus, toQuizQuestion, nineBox, ratingBand, boxCounts, reviewReady, isReadyNow, successionCoverage,
  planRisk, fullMonthsBetween, internalEligibility, competencyGap, skillFreshness, parseLevels, pipRisk, actionStep,
  actionsProgress, NINE_BOX_DEFAULTS, DEFAULT_READINESS,
} from "../src/growth-math";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("Review workflow", () => {
  test("draft → submitted → approved, by someone else", () => {
    assert.deepEqual(reviewStep("DRAFT", "submit", { actor: "a" }), { ok: true, next: "SUBMITTED" });
    assert.deepEqual(reviewStep("SUBMITTED", "approve", { actor: "b", submittedBy: "a" }), { ok: true, next: "APPROVED" });
  });
  test("nobody approves or rejects their own submission", () => {
    assert.equal(reviewStep("SUBMITTED", "approve", { actor: "a", submittedBy: "a" }).ok, false);
    assert.equal(reviewStep("SUBMITTED", "reject", { actor: "a", submittedBy: "a", note: "x" }).ok, false);
  });
  test("a rejection needs a reason and returns to the submitter, who can resubmit", () => {
    assert.equal(reviewStep("SUBMITTED", "reject", { actor: "b", submittedBy: "a" }).ok, false);
    assert.deepEqual(reviewStep("SUBMITTED", "reject", { actor: "b", submittedBy: "a", note: "Too long" }), { ok: true, next: "REJECTED" });
    assert.deepEqual(reviewStep("REJECTED", "submit", { actor: "a" }), { ok: true, next: "SUBMITTED" });
  });
  test("only the submitter withdraws; approved items reopen to draft", () => {
    assert.equal(reviewStep("SUBMITTED", "withdraw", { actor: "b", submittedBy: "a" }).ok, false);
    assert.deepEqual(reviewStep("SUBMITTED", "withdraw", { actor: "a", submittedBy: "a" }), { ok: true, next: "DRAFT" });
    assert.deepEqual(reviewStep("APPROVED", "reopen", { actor: "a" }), { ok: true, next: "DRAFT" });
    assert.equal(reviewStep("APPROVED", "submit", { actor: "a" }).ok, false);
    assert.equal(reviewStep("DRAFT", "nonsense", { actor: "a" }).ok, false);
  });
});

describe("CSV", () => {
  test("quotes commas and quotes, neutralises formulas but not negative numbers", () => {
    assert.equal(csvField('a,"b"'), '"a,""b"""');
    assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvField("-12.5"), "-12.5");
    assert.equal(csvField(null), "");
    assert.equal(csvField(utc(2026, 3, 4)), "2026-03-04");
  });
  test("a file has a BOM, a header and CRLF rows", () => {
    assert.equal(toCsv(["A", "B"], [[1, "x"], [2, "y"]]), "﻿A,B\r\n1,x\r\n2,y");
  });
});

describe("Learning paths", () => {
  const courses = [{ courseId: "a", isOptional: false }, { courseId: "b", isOptional: false }, { courseId: "c", isOptional: true }];
  test("progress counts required courses only", () => {
    const p = pathProgress(courses, [{ courseId: "a", status: "COMPLETED" }, { courseId: "c", status: "COMPLETED" }]);
    assert.deepEqual(p, { percent: 50, done: 1, required: 2, status: "IN_PROGRESS" });
  });
  test("complete when every required course is complete", () => {
    assert.equal(pathProgress(courses, [{ courseId: "a", status: "COMPLETED" }, { courseId: "b", status: "COMPLETED" }]).status, "COMPLETED");
  });
  test("untouched is assigned; an all-optional path completes with any one", () => {
    assert.equal(pathProgress(courses, [{ courseId: "a", status: "ASSIGNED", progressPercent: 0 }]).status, "ASSIGNED");
    assert.equal(pathProgress([{ courseId: "x", isOptional: true }, { courseId: "y", isOptional: true }], [{ courseId: "y", status: "COMPLETED" }]).status, "COMPLETED");
    assert.equal(pathProgress([], []).percent, 0);
  });
});

describe("Sessions, attempts and certificates", () => {
  test("a full session waitlists; no capacity never does", () => {
    assert.equal(sessionSeat(2, 1), "REGISTERED");
    assert.equal(sessionSeat(2, 2), "WAITLISTED");
    assert.equal(sessionSeat(null, 500), "REGISTERED");
  });
  test("a session is open until it starts, unless cancelled", () => {
    const now = utc(2026, 5, 1);
    assert.equal(sessionOpen({ status: "SCHEDULED", startsAt: utc(2026, 5, 2) }, now), true);
    assert.equal(sessionOpen({ status: "SCHEDULED", startsAt: utc(2026, 4, 30) }, now), false);
    assert.equal(sessionOpen({ status: "CANCELLED", startsAt: utc(2026, 5, 2) }, now), false);
  });
  test("attempts: unlimited without a limit; approved retakes add one each", () => {
    assert.equal(attemptsLeft(null, 9), null);
    assert.equal(attemptsLeft(2, 2), 0);
    assert.equal(attemptsLeft(2, 2, 1), 1);
  });
  test("certificate numbers and expiry", () => {
    assert.equal(certificateNumber(utc(2026, 2, 1), 42), "CERT-2026-000042");
    assert.deepEqual(addMonths(utc(2026, 1, 31), 1), utc(2026, 2, 28));
    assert.deepEqual(addMonths(utc(2026, 3, 15), 12), utc(2027, 3, 15));
    const today = utc(2026, 6, 1);
    assert.equal(certificateStatus({ expiresAt: null, revokedAt: null }, today), "VALID");
    assert.equal(certificateStatus({ expiresAt: utc(2026, 6, 20), revokedAt: null }, today), "EXPIRING");
    assert.equal(certificateStatus({ expiresAt: utc(2026, 5, 20), revokedAt: null }, today), "EXPIRED");
    assert.equal(certificateStatus({ expiresAt: null, revokedAt: utc(2026, 1, 1) }, today), "REVOKED");
  });
  test("bulk-uploaded questions become quiz questions; multiple-answer ones are refused", () => {
    const ok = toQuizQuestion({ type: "SINGLE_CHOICE", prompt: " 2+2? ", options: [{ id: "o1", text: "3" }, { id: "o2", text: "4" }], correctOptionIds: ["o2"] });
    assert.deepEqual(ok, { ok: true, prompt: "2+2?", options: ["3", "4"], correctIndex: 1 });
    assert.equal(toQuizQuestion({ type: "MULTIPLE_CHOICE", prompt: "x", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }], correctOptionIds: ["o1", "o2"] }).ok, false);
  });
});

describe("9-box", () => {
  test("boxes run 1 (low/low) to 9 (high/high)", () => {
    assert.equal(nineBox(1, 1), 1);
    assert.equal(nineBox(3, 1), 3);
    assert.equal(nineBox(1, 3), 7);
    assert.equal(nineBox(3, 3), 9);
    assert.equal(nineBox(2, null), null);
    assert.equal(nineBox(4, 1), null);
    assert.equal(NINE_BOX_DEFAULTS[9].label, "Star");
  });
  test("review ratings map to bands", () => {
    assert.equal(ratingBand(2.5, 5), 1);
    assert.equal(ratingBand(3.5, 5), 2);
    assert.equal(ratingBand(4, 5), 3);
    assert.equal(ratingBand(null), null);
  });
  test("counts and readiness to submit", () => {
    assert.deepEqual(boxCounts([{ box: 9 }, { box: 9 }, { box: null }, { box: 1 }])[9], 2);
    assert.deepEqual(reviewReady([{ performance: 3, potential: 2 }, { performance: null, potential: 1 }]), { ok: false, unrated: 1 });
    assert.equal(reviewReady([]).ok, false);
  });
});

describe("Succession", () => {
  test("ready now is no time to readiness", () => {
    assert.equal(isReadyNow(DEFAULT_READINESS[0]), true);
    assert.equal(isReadyNow(DEFAULT_READINESS[1]), false);
  });
  test("coverage counts positions with an approved ready-now successor", () => {
    const r = successionCoverage([
      { criticality: "HIGH", successors: [{ status: "APPROVED", readyNow: true, isEmergency: true }, { status: "APPROVED", readyNow: false }] },
      { criticality: "HIGH", successors: [{ status: "NOMINATED", readyNow: true }] },
    ]);
    assert.deepEqual(r, { positions: 2, covered: 1, coverage: 50, benchStrength: 1, noSuccessor: 1, noEmergency: 1 });
    assert.equal(successionCoverage([]).coverage, 0);
  });
  test("risk", () => {
    assert.equal(planRisk({ criticality: "HIGH", riskOfLoss: "LOW", successors: [] }), "AT_RISK");
    assert.equal(planRisk({ criticality: "LOW", riskOfLoss: "LOW", successors: [{ status: "APPROVED", readyNow: false }] }), "WATCH");
    assert.equal(planRisk({ criticality: "HIGH", riskOfLoss: "HIGH", successors: [{ status: "APPROVED", readyNow: true }] }), "COVERED");
  });
});

describe("Internal mobility", () => {
  const job = { allowInternal: true, status: "OPEN", internalClosesAt: utc(2026, 7, 31), internalMinTenureMonths: 12 };
  const today = utc(2026, 7, 1);
  test("months of service", () => {
    assert.equal(fullMonthsBetween(utc(2025, 7, 1), today), 12);
    assert.equal(fullMonthsBetween(utc(2025, 7, 2), today), 11);
  });
  test("eligibility: open posting, tenure, status, no active plan", () => {
    assert.deepEqual(internalEligibility(job, { dateOfJoining: utc(2024, 1, 1), status: "CONFIRMED" }, today), { ok: true });
    assert.equal(internalEligibility(job, { dateOfJoining: utc(2026, 1, 1), status: "CONFIRMED" }, today).ok, false);
    assert.equal(internalEligibility({ ...job, allowInternal: false }, { dateOfJoining: utc(2024, 1, 1), status: "CONFIRMED" }, today).ok, false);
    assert.equal(internalEligibility(job, { dateOfJoining: utc(2024, 1, 1), status: "NOTICE_PERIOD" }, today).ok, false);
    assert.equal(internalEligibility(job, { dateOfJoining: utc(2024, 1, 1), status: "CONFIRMED", onActivePip: true }, today).ok, false);
    assert.equal(internalEligibility(job, { dateOfJoining: utc(2024, 1, 1), status: "CONFIRMED" }, utc(2026, 8, 2)).ok, false);
  });
});

describe("Competencies", () => {
  test("weighted readiness; a missed critical skill keeps it below 100", () => {
    const g = competencyGap(
      [{ skillId: "a", requiredLevel: 2, weight: 3 }, { skillId: "b", requiredLevel: 1, weight: 1, isCritical: true }],
      [{ skillId: "a", level: 2, isApproved: true }, { skillId: "b", level: 3, isApproved: false }],
    );
    assert.equal(g.readiness, 75);
    assert.equal(g.criticalGaps, 1);
    assert.equal(g.rows[1].gap, 2);
    const full = competencyGap([{ skillId: "a", requiredLevel: 1 }], [{ skillId: "a", level: 3, isApproved: true }]);
    assert.equal(full.readiness, 100);
    assert.equal(competencyGap([], []).readiness, 100);
  });
  test("freshness", () => {
    assert.equal(skillFreshness(null, 12), "UNCONFIRMED");
    assert.equal(skillFreshness(utc(2024, 1, 1), null), "FRESH");
    assert.equal(skillFreshness(utc(2024, 1, 1), 12, utc(2026, 1, 1)), "STALE");
    assert.equal(skillFreshness(utc(2025, 6, 1), 12, utc(2026, 1, 1)), "FRESH");
  });
  test("levels", () => {
    assert.deepEqual(parseLevels("Novice, Working\nExpert"), { ok: true, levels: ["Novice", "Working", "Expert"] });
    assert.equal(parseLevels("One").ok, false);
    assert.equal(parseLevels("a,A").ok, false);
  });
});

describe("Improvement plans and development actions", () => {
  test("risk from check-ins and milestones", () => {
    const c = (d: number, progress: string) => ({ heldOn: utc(2026, 1, d), progress });
    assert.equal(pipRisk([c(1, "OFF_TRACK"), c(8, "OFF_TRACK")]), "HIGH");
    assert.equal(pipRisk([c(1, "OFF_TRACK"), c(8, "ON_TRACK")]), "LOW");
    assert.equal(pipRisk([c(1, "ON_TRACK"), c(8, "AT_RISK")]), "MEDIUM");
    assert.equal(pipRisk([], 2), "HIGH");
  });
  test("owner submits with evidence; someone else verifies or returns", () => {
    assert.equal(actionStep("OPEN", "submit", { isOwner: true, isReviewer: false }).ok, false);
    assert.deepEqual(actionStep("OPEN", "submit", { isOwner: true, isReviewer: false, evidence: "Did it" }), { ok: true, next: "SUBMITTED" });
    assert.equal(actionStep("SUBMITTED", "verify", { isOwner: true, isReviewer: true }).ok, false);
    assert.deepEqual(actionStep("SUBMITTED", "verify", { isOwner: false, isReviewer: true }), { ok: true, next: "VERIFIED" });
    assert.equal(actionStep("SUBMITTED", "return", { isOwner: false, isReviewer: true }).ok, false);
    assert.deepEqual(actionStep("SUBMITTED", "return", { isOwner: false, isReviewer: true, note: "Add the link" }), { ok: true, next: "IN_PROGRESS" });
    assert.equal(actionStep("VERIFIED", "cancel", { isOwner: false, isReviewer: true }).ok, false);
  });
  test("progress ignores cancelled actions", () => {
    assert.equal(actionsProgress([{ status: "VERIFIED" }, { status: "OPEN" }, { status: "CANCELLED" }]), 50);
    assert.equal(actionsProgress([]), 0);
  });
});
