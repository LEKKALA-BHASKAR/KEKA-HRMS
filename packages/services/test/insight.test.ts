import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  metricKeyOf, thresholdState, thresholdProblem, kpiAchievement, kpiRag, kpiPeriodOf, isPeriodKey, targetInForce, kraWeightProblem,
  parseCalculatedField, evalCalculatedField, rowMatchesRule, exceptionRows, joinRowSets, compareSnapshots, pickColumns, grantLive, externalRecipients,
  quantilesOf, histogramOf, payEquity, promotionVelocity, cohortSurvival, inCohort, cohortFiltersOf, seriesAnomalies, engagementDriverScores, managerEffectiveness,
  widgetVisible, refreshOutcome, shareLive, parseScalePoints, describeRating, weightedCompetencyScore, sectionShows, normalizeRatings, performanceSummary,
  reviewExceptionKinds, ratingTrend, reviewReminderDue, checkInOverdue, stretchProgress, stretchProblem, confidenceLabel, dependencyLoop, closeoutSummary, closeoutStatus,
  classifySentiment, parseTagList, feedbackQualityPrompts, escalationRuleMatches, feedbackTrend, anonymityMet, feedbackEditable, templateMessage,
  pipEligibility, pipCompletionProblems, milestonesFromTemplate, parseMilestoneLines, behaviourTrend, performanceRisk, coachingFollowUpDue, extensionProblem, mergeTimeline,
  INSIGHT_WORKFLOW_TYPES,
} from "../src/insight-math";
import { insightBuiltInRoute } from "../src/insight-depth";
import { WORKFLOW_ENTITY_TYPES } from "../src/governance-math";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const DAY = 86_400_000;

describe("Metric catalog and KPIs", () => {
  test("metric keys are stable slugs", () => {
    assert.equal(metricKeyOf("Voluntary attrition (Eng)"), "voluntary-attrition-eng");
    assert.equal(metricKeyOf("!!!"), "metric");
  });
  test("thresholds follow the metric's direction", () => {
    assert.equal(thresholdState(12, 10, 15, "DOWN_GOOD"), "WARN");
    assert.equal(thresholdState(16, 10, 15, "DOWN_GOOD"), "ALERT");
    assert.equal(thresholdState(9, 10, 15, "DOWN_GOOD"), "OK");
    assert.equal(thresholdState(70, 80, 60, "UP_GOOD"), "WARN");
    assert.equal(thresholdState(null, 80, 60, "UP_GOOD"), "OK");
    assert.ok(thresholdProblem(10, 5, "DOWN_GOOD"));
    assert.ok(thresholdProblem(60, 80, "UP_GOOD"));
    assert.equal(thresholdProblem(10, 15, "DOWN_GOOD"), null);
  });
  test("KPI achievement and RAG", () => {
    assert.equal(kpiAchievement(90, 100, "UP_GOOD"), 90);
    assert.equal(kpiAchievement(5, 10, "DOWN_GOOD"), 200);
    assert.deepEqual(kpiRag(85, 100, "UP_GOOD"), { rag: "AMBER", achievement: 85 });
    assert.equal(kpiRag(100, 100, "UP_GOOD").rag, "GREEN");
    assert.equal(kpiRag(50, 100, "UP_GOOD").rag, "RED");
  });
  test("periods and versioned targets", () => {
    assert.equal(kpiPeriodOf(D("2026-08-15"), "MONTHLY"), "2026-08");
    assert.equal(kpiPeriodOf(D("2026-08-15"), "QUARTERLY"), "2026-07");
    assert.ok(isPeriodKey("2026-12"));
    assert.ok(!isPeriodKey("2026-13"));
    const ts = [{ version: 1, effectiveFrom: D("2026-01-01") }, { version: 2, effectiveFrom: D("2026-06-01") }];
    assert.equal(targetInForce(ts, "2026-05")?.version, 1);
    assert.equal(targetInForce(ts, "2026-06")?.version, 2);
    assert.equal(targetInForce(ts, "2025-12"), null);
  });
  test("KRA weights stay at or under 100", () => {
    assert.equal(kraWeightProblem([40, 60]), null);
    assert.ok(kraWeightProblem([60, 50]));
  });
});

describe("Report operations", () => {
  test("calculated fields parse and evaluate safely", () => {
    const p = parseCalculatedField("[gross] / [employees] * 100");
    assert.deepEqual(p, { ok: true, refs: ["gross", "employees"] });
    assert.equal(parseCalculatedField("[a] +").ok, false);
    assert.equal(parseCalculatedField("alert(1)").ok, false);
    assert.equal(parseCalculatedField("([a] + 1").ok, false);
    assert.equal(evalCalculatedField("([a] + [b]) / 2", { a: 4, b: "6" }), 5);
    assert.equal(evalCalculatedField("[a] / [b]", { a: 4, b: 0 }), null);
    assert.equal(evalCalculatedField("[a] * 2", { a: "x" }), null);
    assert.equal(evalCalculatedField("-[a] + 3", { a: 1 }), 2);
  });
  test("exception rules", () => {
    const rows = [{ id: 1, ctc: 100, dept: "Eng", mgr: "" }, { id: 2, ctc: 300, dept: "Sales", mgr: "A" }];
    assert.ok(rowMatchesRule(rows[0]!, { column: "mgr", op: "EMPTY" }));
    assert.ok(rowMatchesRule(rows[1]!, { column: "dept", op: "CONTAINS", value: "sal" }));
    assert.ok(rowMatchesRule(rows[1]!, { column: "dept", op: "EQ", value: "sales" }));
    assert.deepEqual(exceptionRows(rows, [{ column: "ctc", op: "GT", value: "200" }]).map((r) => r.id), [2]);
    assert.deepEqual(exceptionRows(rows, [{ column: "ctc", op: "GT", value: "50" }, { column: "mgr", op: "EMPTY" }], "ALL").map((r) => r.id), [1]);
    assert.deepEqual(exceptionRows(rows, []), []);
  });
  test("joins, snapshot comparison and column profiles", () => {
    const j = joinRowSets([{ id: "a", x: 1 }, { id: "b", x: 2 }], [{ id: "a", y: 9 }], "id", "r_");
    assert.deepEqual(j, [{ id: "a", x: 1, r_y: 9 }, { id: "b", x: 2 }]);
    assert.deepEqual(compareSnapshots([{ k: 1, v: 1 }, { k: 2, v: 2 }], [{ k: 1, v: 1 }, { k: 2, v: 3 }, { k: 4, v: 4 }], "k"), { added: 1, removed: 0, changed: 1, unchanged: 1 });
    assert.deepEqual(pickColumns([{ key: "a" }, { key: "b" }, { key: "c" }], ["c", "a", "zz"]).map((c) => c.key), ["c", "a"]);
    assert.equal(pickColumns([{ key: "a" }], []).length, 1);
  });
  test("grants expire and outside recipients are found", () => {
    const now = D("2026-10-01");
    assert.ok(grantLive({ status: "APPROVED", expiresAt: D("2026-10-02") }, now));
    assert.ok(!grantLive({ status: "APPROVED", expiresAt: D("2026-09-30") }, now));
    assert.ok(!grantLive({ status: "PENDING", expiresAt: D("2026-10-02") }, now));
    assert.deepEqual(externalRecipients(["a@acme.test", "b@gmail.com", "C@ACME.TEST"], ["acme.test"]), ["b@gmail.com"]);
  });
});

describe("People analytics", () => {
  test("quantiles and histograms", () => {
    assert.deepEqual(quantilesOf([4, 1, 3, 2]), { n: 4, min: 1, max: 4, mean: 2.5, p25: 1.75, median: 2.5, p75: 3.25 });
    assert.equal(quantilesOf([]), null);
    const h = histogramOf([0, 1, 2, 3, 4, 5], 5);
    assert.equal(h.length, 5);
    assert.equal(h.reduce((s, b) => s + b.count, 0), 6);
  });
  test("pay equity compares like with like", () => {
    const r = payEquity([
      { group: "Engineer", gender: "MALE", pay: 100 }, { group: "Engineer", gender: "FEMALE", pay: 90 },
      { group: "Manager", gender: "MALE", pay: 200 }, { group: "Manager", gender: "FEMALE", pay: 200 },
    ]);
    assert.equal(r.groups.find((g) => g.group === "Engineer")?.gapPercent, 10);
    assert.equal(r.groups.find((g) => g.group === "Manager")?.gapPercent, 0);
    assert.equal(r.adjustedGapPercent, 5);
  });
  test("promotion velocity and cohort survival", () => {
    const v = promotionVelocity([{ joinedOn: D("2024-01-01"), promotions: [D("2025-01-01"), D("2026-01-01")] }, { joinedOn: D("2024-01-01"), promotions: [] }]);
    assert.equal(v.promoted, 1);
    assert.ok(Math.abs((v.avgMonthsToFirst ?? 0) - 12) < 0.2);
    const s = cohortSurvival([{ joinedOn: D("2025-01-10"), leftOn: null }, { joinedOn: D("2025-02-10"), leftOn: D("2025-04-01") }], D("2026-10-01"), [3, 12]);
    assert.equal(s[0]!.cohort, "2025-Q1");
    assert.deepEqual(s[0]!.retained.map((x) => x.percent), [50, 50]);
  });
  test("cohort filters", () => {
    const f = cohortFiltersOf({ departmentIds: ["d1"], minTenureYears: "1", includeExited: false });
    const p = { departmentId: "d1", locationId: null, gender: "FEMALE", dateOfJoining: D("2024-01-01"), leftOn: null };
    assert.ok(inCohort(p, f, D("2026-01-01")));
    assert.ok(!inCohort({ ...p, departmentId: "d2" }, f, D("2026-01-01")));
    assert.ok(!inCohort(p, f, D("2024-06-01")));
  });
  test("anomalies, drivers and manager effectiveness", () => {
    const a = seriesAnomalies([{ label: "1", value: 10 }, { label: "2", value: 11 }, { label: "3", value: 10 }, { label: "4", value: 40 }, { label: "5", value: 11 }]);
    assert.ok(a.some((x) => x.label === "4"));
    const d = engagementDriverScores([{ driver: "Pay", score: 2 }, { driver: "Pay", score: 2 }, { driver: "Team", score: 5 }, { driver: "Team", score: 5 }]);
    assert.equal(d[0]!.driver, "Pay");
    assert.equal(d[1]!.favourable, 100);
    const m = managerEffectiveness({ teamSize: 4, leavers12m: 1, avgTeamRating: 4, feedbackGiven90d: 8, oneOnOnes90d: 12, ratingScaleMax: 5 });
    assert.equal(m.signals.length, 4);
    assert.equal(m.score, Math.round((75 + 100 + 100 + 80) / 4));
  });
});

describe("Dashboards", () => {
  test("role-based widgets, refresh outcomes and share expiry", () => {
    const v = { roleNames: ["HR Manager"], isManager: false, isEmployee: true };
    assert.ok(widgetVisible([], v));
    assert.ok(widgetVisible(["HR Manager"], v));
    assert.ok(!widgetVisible(["MANAGER"], v));
    assert.equal(refreshOutcome([{ error: null }, { error: "x" }]), "PARTIAL");
    assert.equal(refreshOutcome([{ error: "x" }]), "FAILED");
    assert.ok(shareLive({ expiresAt: null }));
    assert.ok(!shareLive({ expiresAt: D("2020-01-01") }));
  });
});

describe("Performance management", () => {
  test("rating scales and their description library", () => {
    const p = parseScalePoints("1 | Below | Misses most\n2 | Meets | On target\n3 | Exceeds");
    assert.ok(p.ok);
    if (p.ok) assert.equal(describeRating(p.points, 2.4)?.label, "Meets");
    assert.equal(parseScalePoints("1 | A\n3 | C").ok, false);
    assert.equal(parseScalePoints("1 | A").ok, false);
  });
  test("weighted competencies and conditional sections", () => {
    const qs = [{ id: "a", kind: "COMPETENCY", weight: 3 }, { id: "b", kind: "COMPETENCY", weight: 1 }, { id: "c", kind: "TEXT", weight: null }];
    assert.equal(weightedCompetencyScore(qs, { a: 4, b: 2, c: "x" }), 3.5);
    assert.equal(weightedCompetencyScore(qs, {}), null);
    const s = { conditionQuestionId: "a", conditionOp: "LTE", conditionValue: 2 };
    assert.ok(sectionShows(s, { a: 2 }));
    assert.ok(!sectionShows(s, { a: 4 }));
    assert.ok(!sectionShows(s, {}));
    assert.ok(sectionShows({ conditionQuestionId: null, conditionOp: null, conditionValue: null }, {}));
  });
  test("normalisation evens out a lenient manager", () => {
    const rows = [{ id: "1", manager: "A", rating: 5 }, { id: "2", manager: "A", rating: 5 }, { id: "3", manager: "B", rating: 3 }, { id: "4", manager: "B", rating: 3 }];
    const n = normalizeRatings(rows);
    assert.equal(n[0]!.normalized, 4);
    assert.equal(n[2]!.normalized, 4);
    assert.equal(n[0]!.delta, -1);
  });
  test("summaries, exceptions, trend and reminders", () => {
    const s = performanceSummary({ name: "Meera", cycle: "H1", rating: 4, scaleMax: 5, band: "Strong", ratingLabel: "Exceeds", goalsTotal: 2, goalsCompleted: 1, avgGoalProgress: 70, strengths: ["Great owner. More."], improvements: [], peerCount: 2, competencyScore: null, previousRating: 3 });
    assert.match(s, /rated 4 of 5 \(Exceeds\)/);
    assert.match(s, /up 1 on the previous cycle/);
    assert.match(s, /Strengths noted: Great owner\./);
    const ex = reviewExceptionKinds({ status: "MANAGER_PENDING", closesAt: D("2026-01-01"), selfRating: 5, managerRating: 2, rawRating: 3, finalRating: 4, calibrationReason: null, goalCount: 0, inBand: false, hasManagerSlot: true }, D("2026-02-01")).map((e) => e.kind);
    assert.deepEqual(ex, ["OVERDUE", "SELF_GAP", "NO_REASON", "NO_GOALS", "OUT_OF_BAND"]);
    const t = ratingTrend([{ name: "B", end: D("2026-06-30"), ratings: [4, 2] }, { name: "A", end: D("2025-12-31"), ratings: [3] }]);
    assert.deepEqual(t.map((x) => x.cycle), ["A", "B"]);
    assert.equal(t[1]!.average, 3);
    const now = D("2026-06-25");
    assert.ok(reviewReminderDue({ submittedAt: null, remindedAt: null }, D("2026-06-30"), now));
    assert.ok(!reviewReminderDue({ submittedAt: null, remindedAt: D("2026-06-24") }, D("2026-06-30"), now));
    assert.ok(!reviewReminderDue({ submittedAt: now, remindedAt: null }, D("2026-06-30"), now));
  });
});

describe("OKRs", () => {
  test("check-in cadence and overdue", () => {
    const o = checkInOverdue(D("2026-09-01"), D("2026-07-01"), "WEEKLY", 2, D("2026-09-15"));
    assert.deepEqual([o.overdue, o.daysLate], [true, 7]);
    assert.equal(checkInOverdue(D("2026-09-01"), D("2026-07-01"), "MONTHLY", 3, D("2026-09-15")).overdue, false);
  });
  test("stretch targets and confidence", () => {
    assert.deepEqual(stretchProgress(0, 100, 150, 120), { committed: 120, stretch: 80 });
    assert.deepEqual(stretchProgress(0, 100, null, 50), { committed: 50, stretch: null });
    assert.ok(stretchProblem(0, 100, 90));
    assert.ok(stretchProblem(100, 50, 60));
    assert.equal(stretchProblem(100, 50, 40), null);
    assert.equal(confidenceLabel(8), "HIGH");
    assert.equal(confidenceLabel(5), "MEDIUM");
    assert.equal(confidenceLabel(1), "LOW");
    assert.equal(confidenceLabel(null), null);
  });
  test("dependency loops are refused", () => {
    const links = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
    assert.ok(dependencyLoop(links, "c", "a"));
    assert.ok(dependencyLoop(links, "a", "a"));
    assert.ok(!dependencyLoop(links, "a", "c"));
  });
  test("close-out", () => {
    assert.deepEqual(closeoutSummary([{ status: "COMPLETED", progress: 100 }, { status: "AT_RISK", progress: 40 }, { status: "CANCELLED", progress: 0 }]), { goals: 2, completed: 1, missed: 1, averageProgress: 70 });
    assert.equal(closeoutStatus("ON_TRACK", 100), "COMPLETED");
    assert.equal(closeoutStatus("ON_TRACK", 60), "MISSED");
    assert.equal(closeoutStatus("CANCELLED", 60), "CANCELLED");
  });
});

describe("Continuous feedback", () => {
  test("sentiment, with negation", () => {
    assert.equal(classifySentiment("Great demo, really clear and helpful").sentiment, "POSITIVE");
    assert.equal(classifySentiment("The report was late and full of errors").sentiment, "NEGATIVE");
    assert.equal(classifySentiment("It was not helpful").sentiment, "NEGATIVE");
    assert.equal(classifySentiment("We met on Tuesday").sentiment, "NEUTRAL");
  });
  test("tags, quality prompts and escalation rules", () => {
    assert.deepEqual(parseTagList("Customer Focus, #ownership; x, customer focus"), ["customer-focus", "ownership"]);
    assert.ok(feedbackQualityPrompts("Good job").length >= 2);
    assert.deepEqual(feedbackQualityPrompts("In the release review meeting you walked the team through every risk calmly. Keep doing that in future sprint reviews, it helped the whole team."), []);
    assert.ok(feedbackQualityPrompts("You are always lazy in every meeting and project, try harder next time please okay now").some((p) => /absolutes/.test(p)));
    const rule = { id: "r", trigger: "KEYWORD", keyword: "harass", topicId: null, isActive: true };
    assert.ok(escalationRuleMatches(rule, { message: "This felt like HARASSment", sentiment: "NEUTRAL", topicId: null }));
    assert.ok(!escalationRuleMatches({ ...rule, isActive: false }, { message: "harass", sentiment: null, topicId: null }));
    assert.ok(escalationRuleMatches({ ...rule, trigger: "NEGATIVE" }, { message: "", sentiment: "NEGATIVE", topicId: null }));
    assert.ok(escalationRuleMatches({ ...rule, trigger: "TOPIC", topicId: "t" }, { message: "", sentiment: null, topicId: "t" }));
  });
  test("trend, anonymity, edit window and templates", () => {
    const t = feedbackTrend([{ createdAt: D("2026-08-02"), sentiment: "POSITIVE" }, { createdAt: D("2026-08-09"), sentiment: "NEGATIVE" }, { createdAt: D("2026-07-01"), sentiment: null }]);
    assert.deepEqual(t.map((m) => [m.month, m.total, m.positiveShare]), [["2026-07", 1, 0], ["2026-08", 2, 50]]);
    assert.ok(!anonymityMet(2, 3));
    assert.ok(anonymityMet(3, 3));
    assert.ok(feedbackEditable(new Date(Date.now() - 47 * 3_600_000)));
    assert.ok(!feedbackEditable(new Date(Date.now() - 49 * 3_600_000)));
    assert.deepEqual(templateMessage(["What went well?", "What next?"], ["The demo", "More tests"]), { ok: true, message: "What went well?\nThe demo\n\nWhat next?\nMore tests" });
    assert.equal(templateMessage(["Q1"], [" "]).ok, false);
  });
});

describe("PIPs and coaching", () => {
  const rules = { minTenureDays: 90, maxRating: 2.5, blockProbation: true, blockNotice: true };
  test("eligibility", () => {
    const today = D("2026-10-01");
    assert.deepEqual(pipEligibility({ dateOfJoining: D("2025-01-01"), status: "ACTIVE", lastRating: 2, activePip: false }, rules, today), []);
    assert.equal(pipEligibility({ dateOfJoining: D("2026-09-01"), status: "PROBATION", lastRating: 4, activePip: true }, rules, today).length, 4);
  });
  test("completion criteria", () => {
    const base = { objectives: [{ status: "MET" }], checklist: [{ required: true, doneAt: D("2026-01-01"), label: "HR review" }], milestones: [{ status: "MET" }], checkIns: 1, requireChecklist: true, outcome: "SUCCESSFUL" };
    assert.deepEqual(pipCompletionProblems(base), []);
    const bad = pipCompletionProblems({ ...base, objectives: [{ status: "OPEN" }, { status: "NOT_MET" }], checklist: [{ required: true, doneAt: null, label: "HR review" }, { required: false, doneAt: null, label: "Opt" }], checkIns: 0 });
    assert.equal(bad.length, 4);
    assert.ok(bad.some((b) => b.includes("HR review") && !b.includes("Opt")));
  });
  test("templates, milestones and behaviour trend", () => {
    const p = parseMilestoneLines("First review @ 30\nFinal @ 60");
    assert.deepEqual(p, { ok: true, milestones: [{ title: "First review", offsetDays: 30 }, { title: "Final", offsetDays: 60 }] });
    assert.equal(parseMilestoneLines("No day").ok, false);
    const ms = milestonesFromTemplate([{ title: "A", offsetDays: 10 }, { title: "B", offsetDays: 99 }], D("2026-01-01"), D("2026-03-01"));
    assert.deepEqual(ms.map((m) => m.dueDate.toISOString().slice(0, 10)), ["2026-01-11", "2026-03-01"]);
    assert.deepEqual(behaviourTrend([{ observedOn: D("2026-01-01"), rating: 2 }, { observedOn: D("2026-01-08"), rating: 2 }, { observedOn: D("2026-01-15"), rating: 4 }, { observedOn: D("2026-01-22"), rating: 4 }]), { average: 3, trend: "IMPROVING" });
    assert.deepEqual(behaviourTrend([]), { average: null, trend: null });
  });
  test("performance risk, coaching follow-up and extensions", () => {
    const r = performanceRisk({ lastRating: 2, ratingDrop: 1, goalsAtRisk: 2, goals: 3, activePip: false, negativeFeedback90d: 0, overdueCheckIns: 0 });
    assert.deepEqual([r.score, r.band], [65, "HIGH"]);
    assert.equal(performanceRisk({ lastRating: 4, ratingDrop: null, goalsAtRisk: 0, goals: 2, activePip: false, negativeFeedback90d: 0, overdueCheckIns: 0 }).band, "LOW");
    assert.ok(coachingFollowUpDue(null, D("2026-01-01"), 14, D("2026-01-20")));
    assert.ok(!coachingFollowUpDue(D("2026-01-15"), D("2026-01-01"), 14, D("2026-01-20")));
    assert.ok(extensionProblem({ startDate: D("2026-01-01"), endDate: D("2026-03-02") }, 5));
    assert.equal(extensionProblem({ startDate: D("2026-01-01"), endDate: D("2026-03-02") }, 30), null);
    assert.ok(extensionProblem({ startDate: D("2026-01-01"), endDate: new Date(D("2026-01-01").getTime() + 170 * DAY) }, 30));
  });
  test("timelines merge newest first", () => {
    const t = mergeTimeline([{ at: D("2026-01-01"), kind: "a", title: "x" }], [{ at: D("2026-02-01"), kind: "b", title: "y" }]);
    assert.deepEqual(t.map((e) => e.kind), ["b", "a"]);
  });
});

describe("Insight approvals", () => {
  test("every insight request type has a built-in route and is a workflow entity type", () => {
    for (const k of Object.keys(INSIGHT_WORKFLOW_TYPES)) {
      assert.ok(insightBuiltInRoute(k)?.length, k);
      assert.ok(k in WORKFLOW_ENTITY_TYPES, k);
    }
    assert.equal(insightBuiltInRoute("GOAL_APPROVAL", { changeKind: "INDIVIDUAL" })![0]!.approverType, "REPORTING_MANAGER");
    assert.equal(insightBuiltInRoute("PIP_REQUEST", { changeKind: "ESCALATION" })!.length, 2);
    assert.equal(insightBuiltInRoute("SOMETHING_ELSE"), null);
  });
});
