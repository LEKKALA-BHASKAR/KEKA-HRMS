import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bandProblems, tierOf, nineBoxCell, questionApplies, checkFormAnswers, stageWindowProblem, stageOrderProblem,
  tenureMonths, promotionEligibility, feedbackAllowed, asStringList, candidateScore, pickApprovalRule, chainApprovers,
  parseGrowthItems, growthItemsOf, cleanSlots, countGroups, isHexColor,
} from "../src/talent-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Calibration bands", () => {
  const ok = [
    { name: "Low", minRating: 0, maxRating: 2.5, targetPercent: 10 },
    { name: "Mid", minRating: 2.5, maxRating: 4, targetPercent: 70 },
    { name: "High", minRating: 4, maxRating: 5, targetPercent: 20 },
  ];
  test("contiguous bands with targets adding to 100 pass", () => assert.equal(bandProblems(ok), null));
  test("overlaps, gaps, bad ranges and wrong totals are refused", () => {
    assert.match(bandProblems([ok[0], { ...ok[1], minRating: 2 }, ok[2]])!, /overlap/);
    assert.match(bandProblems([ok[0], { ...ok[1], minRating: 3 }, ok[2]])!, /gap/);
    assert.match(bandProblems([{ ...ok[0], minRating: 3 }, ok[1], ok[2]])!, /lower bound/);
    assert.match(bandProblems([ok[0], ok[1], { ...ok[2], targetPercent: 30 }])!, /110%/);
    assert.match(bandProblems([ok[0], { ...ok[1], name: "low" }, ok[2]])!, /unique/);
    assert.match(bandProblems([ok[0]])!, /two bands/);
  });
  test("targets are optional when any band leaves them blank", () => assert.equal(bandProblems([ok[0], { ...ok[1], targetPercent: null }, ok[2]]), null));
});

describe("9-box", () => {
  test("tiers split the scale into low, moderate and high", () => {
    assert.deepEqual([1, 2.4, 2.5, 3.7, 3.75, 5].map((r) => tierOf(r)), [0, 0, 1, 1, 2, 2]);
  });
  test("cells are labelled by performance and potential", () => {
    assert.equal(nineBoxCell(5, 5).label, "Star");
    assert.equal(nineBoxCell(1, 1).label, "Talent risk");
    assert.equal(nineBoxCell(1, 5).label, "Rough diamond");
    assert.equal(nineBoxCell(5, 1).label, "Trusted professional");
    assert.equal(nineBoxCell(3, 3).label, "Core player");
  });
});

describe("Review form answers", () => {
  const qs = [
    { id: "r", kind: "RATING", prompt: "Delivery", isRequired: true, appliesTo: null },
    { id: "t", kind: "TEXT", prompt: "Highlights", isRequired: false, appliesTo: ["SELF"] },
    { id: "c", kind: "COMPETENCY", prompt: "Ownership", isRequired: true, appliesTo: ["MANAGER"] },
  ];
  test("questions apply to everyone unless restricted", () => {
    assert.equal(questionApplies({ appliesTo: null }, "PEER"), true);
    assert.equal(questionApplies({ appliesTo: ["SELF"] }, "MANAGER"), false);
  });
  test("required questions for this reviewer must be answered, ratings 1..5", () => {
    assert.deepEqual(checkFormAnswers(qs, "SELF", { r: "4", t: " Shipped X " }), { ok: true, answers: { r: 4, t: "Shipped X" } });
    const missing = checkFormAnswers(qs, "MANAGER", { r: "4" });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.questionId, "c");
    assert.equal(checkFormAnswers(qs, "SELF", { r: "6" }).ok, false);
    assert.equal(checkFormAnswers(qs, "SELF", { r: "2.5" }).ok, false);
  });
});

describe("Cycle stage dates", () => {
  const stage = { selfStartsAt: d("2026-10-01"), selfEndsAt: d("2026-10-10"), managerStartsAt: d("2026-10-11"), managerEndsAt: d("2026-10-20") };
  test("reviews are refused outside their window; the end day is included", () => {
    assert.match(stageWindowProblem(stage, "SELF", d("2026-09-30"))!, /open on 2026-10-01/);
    assert.equal(stageWindowProblem(stage, "SELF", new Date("2026-10-10T23:00:00Z")), null);
    assert.match(stageWindowProblem(stage, "SELF", d("2026-10-11"))!, /closed/);
    assert.equal(stageWindowProblem(stage, "PEER", d("2027-01-01")), null);
    assert.equal(stageWindowProblem(null, "SELF"), null);
  });
  test("stages must run in order", () => {
    assert.equal(stageOrderProblem({ ...stage, calibrationStartsAt: d("2026-10-21"), calibrationEndsAt: d("2026-10-25"), publishOn: d("2026-10-26") }), null);
    assert.match(stageOrderProblem({ ...stage, managerStartsAt: d("2026-09-01") })!, /follow each other/);
    assert.match(stageOrderProblem({ selfStartsAt: d("2026-10-05"), selfEndsAt: d("2026-10-01") })!, /end after/);
    assert.match(stageOrderProblem({ calibrationEndsAt: d("2026-10-25"), publishOn: d("2026-10-24") })!, /Publish/);
  });
});

describe("Promotion eligibility", () => {
  const rules = { minTenureMonths: 12, minMonthsSinceLastPromotion: 12, minRating: 4, excludeOnPip: true };
  test("tenure counts whole months", () => {
    assert.equal(tenureMonths(d("2025-10-05"), d("2026-10-04")), 11);
    assert.equal(tenureMonths(d("2025-10-04"), d("2026-10-04")), 12);
  });
  test("every unmet rule is a reason", () => {
    assert.deepEqual(promotionEligibility({ dateOfJoining: d("2020-01-01"), lastPromotionAt: null, rating: 4.5, onPip: false }, rules, d("2026-10-04")), { eligible: true, reasons: [] });
    const r = promotionEligibility({ dateOfJoining: d("2026-01-01"), lastPromotionAt: d("2026-06-01"), rating: 3, onPip: true }, rules, d("2026-10-04"));
    assert.equal(r.eligible, false);
    assert.equal(r.reasons.length, 4);
    assert.match(promotionEligibility({ dateOfJoining: d("2020-01-01"), lastPromotionAt: null, rating: null, onPip: false }, rules, d("2026-10-04")).reasons[0], /no final rating/);
  });
});

describe("Feedback rules", () => {
  const giver = { id: "g", departmentId: "eng" };
  const subject = { id: "s", departmentId: "sales", managerChain: ["m"] };
  test("never yourself; managers up the line always may", () => {
    assert.match(feedbackAllowed({ whoCanGive: "EVERYONE", allowAnonymous: true }, giver, { ...subject, id: "g" })!, /yourself/);
    assert.equal(feedbackAllowed({ whoCanGive: "REPORTING_LINE", allowAnonymous: false }, { id: "m", departmentId: null }, subject), null);
  });
  test("department and reporting-line settings restrict others", () => {
    assert.equal(feedbackAllowed({ whoCanGive: "EVERYONE", allowAnonymous: false }, giver, subject), null);
    assert.match(feedbackAllowed({ whoCanGive: "SAME_DEPARTMENT", allowAnonymous: false }, giver, subject)!, /department/);
    assert.equal(feedbackAllowed({ whoCanGive: "SAME_DEPARTMENT", allowAnonymous: false }, giver, { ...subject, departmentId: "eng" }), null);
    assert.match(feedbackAllowed({ whoCanGive: "REPORTING_LINE", allowAnonymous: false }, giver, subject)!, /reporting line/);
  });
});

describe("Candidate profile score", () => {
  const w = { skillsWeight: 50, experienceWeight: 30, educationWeight: 20, skillKeywords: [], educationKeywords: ["b.tech", "computer science"], idealExperienceYears: 5 };
  test("string lists are normalised and de-duplicated", () => assert.deepEqual(asStringList("React, react ,  Node\nSQL"), ["react", "node", "sql"]));
  test("weights skills matched, experience against the job's minimum, and education keywords", () => {
    const full = candidateScore({ skills: ["React", "Node.js", "SQL"], experienceYears: 6, education: "B.Tech Computer Science" }, { skills: ["react", "node", "sql"], minExperienceYears: 4 }, w);
    assert.equal(full.score, 100);
    const half = candidateScore({ skills: ["react"], experienceYears: 2, education: "BA History" }, { skills: ["react", "sql"], minExperienceYears: 4 }, w);
    assert.deepEqual([half.skills, half.experience, half.education, half.score], [50, 50, 0, 40]);
    assert.equal(candidateScore({ skills: [], experienceYears: null, education: null }, { skills: ["go"], minExperienceYears: null }, w).score, 0);
  });
});

describe("Approval chains", () => {
  const rules = [
    { id: "any", departmentId: null, minAmount: null, approverUserIds: ["a"], priority: 100, isActive: true },
    { id: "eng-big", departmentId: "eng", minAmount: 2_000_000, approverUserIds: ["b", "c"], priority: 10, isActive: true },
    { id: "off", departmentId: null, minAmount: null, approverUserIds: ["z"], priority: 1, isActive: false },
  ];
  test("the first active rule by order whose department and amount match wins", () => {
    assert.equal(pickApprovalRule(rules, { departmentId: "eng", amount: 2_500_000 })?.id, "eng-big");
    assert.equal(pickApprovalRule(rules, { departmentId: "eng", amount: 1_000_000 })?.id, "any");
    assert.equal(pickApprovalRule(rules, { departmentId: "sales", amount: null })?.id, "any");
    assert.equal(pickApprovalRule(rules.slice(1), { departmentId: "sales", amount: 9e9 }), null);
  });
  test("approvers never include the requester and never repeat", () => assert.deepEqual(chainApprovers(["a", "b", "a", "r", ""], "r"), ["a", "b"]));
});

describe("Growth plan items", () => {
  test("parses title | kind | days lines", () => {
    assert.deepEqual(parseGrowthItems("Learn SQL | course | 30\nShip a feature\n\nPair with lead | MENTORING").items, [
      { title: "Learn SQL", kind: "COURSE", dueInDays: 30 }, { title: "Ship a feature", kind: "MILESTONE", dueInDays: null }, { title: "Pair with lead", kind: "MENTORING", dueInDays: null },
    ]);
    assert.match(parseGrowthItems("X | DANCE")!.error!, /kind/);
    assert.match(parseGrowthItems("X | SKILL | -1")!.error!, /days/);
    assert.match(parseGrowthItems("  ")!.error!, /at least one/);
    assert.deepEqual(growthItemsOf([{ title: "A", kind: "SKILL", dueInDays: null }, null, { nope: 1 }]).length, 1);
  });
});

describe("Interview slots", () => {
  const now = new Date("2026-10-04T10:00:00Z");
  test("datetime-local values are UTC, de-duplicated and sorted", () => {
    const r = cleanSlots(["2026-10-06T09:00", "2026-10-05T15:30", "2026-10-06T09:00"], now);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.slots.map((s) => s.toISOString()), ["2026-10-05T15:30:00.000Z", "2026-10-06T09:00:00.000Z"]);
  });
  test("slots must be at least 30 minutes ahead, valid, and 1 to 10", () => {
    assert.match(cleanSlots(["2026-10-04T10:15"], now).error!, /30 minutes/);
    assert.match(cleanSlots(["soon"], now).error!, /valid/);
    assert.match(cleanSlots([""], now).error!, /at least one/);
    assert.match(cleanSlots(Array.from({ length: 11 }, (_, i) => `2026-10-${String(10 + i).padStart(2, "0")}T09:00`), now).error!, /up to 10/);
  });
});

describe("Reports", () => {
  test("small groups are folded together", () => {
    const rows = [...Array(6).fill("A"), ...Array(2).fill("B"), "C"];
    assert.deepEqual(countGroups(rows, (x) => x, 5), [{ key: "A", count: 6, percent: 66.67 }, { key: "Other (groups under 5)", count: 3, percent: 33.33 }]);
    assert.equal(countGroups(rows, (x) => x).length, 3);
  });
  test("colours are six-digit hex", () => {
    assert.equal(isHexColor("#1266a8"), true);
    assert.equal(isHexColor("red"), false);
    assert.equal(isHexColor("#fff"), false);
  });
});
