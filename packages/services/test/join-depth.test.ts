import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  JOIN_WORKFLOW_TYPES, isJoinWorkflowType, pickScopedTemplate, preboardingDueDate, preboardingScore, preboardReminderDue,
  renderPrejoinText, prejoinSendDue, preboardingExceptions, parseNewHireFields, checkNewHireAnswers, newHireFieldsText,
  milestonePlan, onboardingPhase, phaseDefaultOffset, escalationLevelFor, onboardingScorecard, onboardingCohorts, onboardingDropOff,
  templateRevisionDiff, buddyCheck, bgvSeverityFor, bgvSlaState, bgvRollup, bgvQueueScore, bgvConsentState, bgvCostFor, bgvVendorStats,
  shiftPlannedMinutes, checkSplitSegments, shiftWindow, restHoursBetween, rosterViolations, rosterCoverage, coverageLevel,
  shiftTradeEligibility, rosterSnapshotDiff, shiftCostForecast, shiftAdherence, parseHolidayCsv, calendarDiff, mergeCalendarRevision,
  weekendSubstitutes, holidayCountCheck, shutdownWorkingDays, holidayImpact, calendarConflicts, parseOtTiers, tieredOtMinutes,
  otWindowPremium, computeOvertime, overtimeRuleFor, overtimeTimingCheck, overtimeReconciliation, overtimeAnomalies, compOffExpiringSoon,
  SHIFT_TEMPLATE_LIBRARY,
} from "../src/join-depth-math";
import { WORKFLOW_ENTITY_TYPES } from "../src/governance-math";
import { builtInRoute } from "../src/workflow-engine";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Workflow wiring", () => {
  test("every join workflow type is a workflow entity type with a built-in route", () => {
    for (const k of Object.keys(JOIN_WORKFLOW_TYPES)) {
      assert.ok(k in WORKFLOW_ENTITY_TYPES, k);
      assert.ok(isJoinWorkflowType(k));
      assert.ok(builtInRoute(k as never).length > 0, `route for ${k}`);
    }
    assert.equal(isJoinWorkflowType("SURVEY_PUBLISH"), false);
    assert.equal(builtInRoute("SHIFT_SWAP" as never)[0]?.approverType, "REPORTING_MANAGER");
    assert.equal(builtInRoute("BUDDY_ASSIGNMENT" as never, { reviewerUserId: "u1" })[0]?.approverUserId, "u1");
    assert.equal(builtInRoute("OVERTIME_EXCEPTION" as never).length, 2);
  });
});

describe("Preboarding", () => {
  const tpl = (id: string, o: Partial<{ departmentId: string; locationId: string; jobTitle: string; isActive: boolean }>) => ({ id, departmentId: o.departmentId ?? null, locationId: o.locationId ?? null, jobTitle: o.jobTitle ?? null, isActive: o.isActive ?? true });
  test("the most specific template wins: job title, then department, then location", () => {
    const ts = [tpl("all", {}), tpl("dept", { departmentId: "D" }), tpl("loc", { locationId: "L" }), tpl("role", { jobTitle: "Sales Executive" }), tpl("off", { departmentId: "D", isActive: false })];
    assert.equal(pickScopedTemplate(ts, { departmentId: "D", locationId: "L", jobTitle: "sales executive" })?.id, "role");
    assert.equal(pickScopedTemplate(ts, { departmentId: "D", locationId: "L", jobTitle: "Engineer" })?.id, "dept");
    assert.equal(pickScopedTemplate(ts, { departmentId: "X", locationId: "L", jobTitle: null })?.id, "loc");
    assert.equal(pickScopedTemplate(ts, { departmentId: "X", locationId: "Y", jobTitle: null })?.id, "all");
    assert.equal(pickScopedTemplate([tpl("dept", { departmentId: "D" })], { departmentId: "X", locationId: null, jobTitle: null }), null);
  });
  test("due dates count back from joining and never fall in the past", () => {
    assert.equal(preboardingDueDate(d("2026-11-20"), 7, d("2026-11-01")).toISOString().slice(0, 10), "2026-11-13");
    assert.equal(preboardingDueDate(d("2026-11-05"), 7, d("2026-11-01")).toISOString().slice(0, 10), "2026-11-01");
  });
  test("completion score counts finished tasks and readiness", () => {
    const s = preboardingScore([{ status: "DONE" }, { status: "PENDING" }, { status: "APPROVED" }, { status: "WAIVED" }], [{ key: "BANK", label: "", ok: true }, { key: "TAX", label: "", ok: false }]);
    assert.deepEqual(s, { pct: 67, done: 4, total: 6 });
    assert.equal(preboardingScore([], []).pct, 100);
  });
  test("reminders follow the cadence and stop at the maximum", () => {
    const base = { status: "PENDING", remindersSent: 0, lastRemindedAt: null, createdAt: d("2026-10-01") };
    assert.equal(preboardReminderDue(base, 3, 3, d("2026-10-02")), false);
    assert.equal(preboardReminderDue(base, 3, 3, d("2026-10-04")), true);
    assert.equal(preboardReminderDue({ ...base, remindersSent: 3 }, 3, 3, d("2026-10-20")), false);
    assert.equal(preboardReminderDue({ ...base, status: "DONE" }, 3, 3, d("2026-10-20")), false);
    assert.equal(preboardReminderDue({ ...base, lastRemindedAt: d("2026-10-05") }, 3, 3, d("2026-10-06")), false);
    assert.equal(preboardReminderDue(base, 0, 3, d("2026-10-20")), false);
  });
  test("messages render placeholders and send inside their window", () => {
    assert.equal(renderPrejoinText("Hi {{first_name}}, see you on {{ joining_date }} {{unknown}}", { first_name: "Asha", joining_date: "2026-11-02" }), "Hi Asha, see you on 2026-11-02 ");
    assert.equal(prejoinSendDue(d("2026-11-10"), 7, d("2026-11-02")), false);
    assert.equal(prejoinSendDue(d("2026-11-10"), 7, d("2026-11-03")), true);
    assert.equal(prejoinSendDue(d("2026-11-10"), 7, d("2026-11-11")), false);
  });
  test("exceptions flag what needs attention close to joining", () => {
    const ex = preboardingExceptions({ daysToJoin: 2, overdueTasks: 1, rejectedItems: 0, bgvStatus: "DISCREPANCY", signedIn: false, readinessGaps: ["Bank details"], score: 40 });
    assert.equal(ex.length, 5);
    assert.deepEqual(preboardingExceptions({ daysToJoin: 20, overdueTasks: 0, rejectedItems: 0, bgvStatus: "CLEAR", signedIn: true, readinessGaps: [], score: 100 }), []);
    assert.match(preboardingExceptions({ daysToJoin: -1, overdueTasks: 0, rejectedItems: 0, bgvStatus: "CLEAR", signedIn: true, readinessGaps: [], score: 100 })[0]!, /passed/);
  });
  test("new-hire form fields parse, round-trip and validate answers", () => {
    const { fields, errors } = parseNewHireFields("T-shirt size | SELECT | required | S, M, L\nBlood group | TEXT\nJoining from | DATE | required\nNeeds parking | YESNO");
    assert.deepEqual(errors, []);
    assert.equal(fields.length, 4);
    assert.equal(fields[0]!.key, "t_shirt_size");
    assert.equal(parseNewHireFields(newHireFieldsText(fields)).fields.length, 4);
    assert.ok(parseNewHireFields("Bad | SELECT | | only").errors.length > 0);
    assert.ok(parseNewHireFields("X | WEIRD").errors.length > 0);
    const r = checkNewHireAnswers(fields, { t_shirt_size: "XL", joining_from: "2026-11-01", needs_parking: "Yes" });
    assert.equal(r.errors.t_shirt_size, "Pick one of the options");
    const ok = checkNewHireAnswers(fields, { t_shirt_size: "M", joining_from: "2026-11-01" });
    assert.deepEqual(ok.errors, {});
    assert.equal(checkNewHireAnswers(fields, {}).errors.joining_from, "Required");
  });
});

describe("Onboarding", () => {
  test("milestones and phases", () => {
    const m = milestonePlan(d("2026-10-01"));
    assert.deepEqual(m.map((x) => x.dueDate.toISOString().slice(0, 10)), ["2026-10-08", "2026-10-31", "2026-11-30", "2026-12-30"]);
    assert.deepEqual([-2, 0, 3, 20, 45, 80, 200].map(onboardingPhase), ["PRE_JOINING", "DAY_ONE", "FIRST_WEEK", "FIRST_30", "FIRST_60", "FIRST_90", "LATER"]);
    assert.equal(onboardingPhase(phaseDefaultOffset("FIRST_60")), "FIRST_60");
  });
  test("escalation climbs one level per period overdue, capped at 3", () => {
    assert.equal(escalationLevelFor(d("2026-10-10"), d("2026-10-10"), 2), 0);
    assert.equal(escalationLevelFor(d("2026-10-10"), d("2026-10-12"), 2), 1);
    assert.equal(escalationLevelFor(d("2026-10-10"), d("2026-10-14"), 2), 2);
    assert.equal(escalationLevelFor(d("2026-10-01"), d("2026-10-30"), 2), 3);
  });
  test("manager scorecard", () => {
    const s = onboardingScorecard([
      { ownerEmployeeId: "m1", status: "DONE", dueDate: d("2026-10-05"), completedAt: d("2026-10-04") },
      { ownerEmployeeId: "m1", status: "DONE", dueDate: d("2026-10-05"), completedAt: d("2026-10-07") },
      { ownerEmployeeId: "m1", status: "PENDING", dueDate: d("2026-10-01"), completedAt: null },
      { ownerEmployeeId: null, status: "PENDING", dueDate: d("2026-10-01"), completedAt: null },
    ], d("2026-10-10"));
    assert.deepEqual(s[0], { ownerEmployeeId: "m1", owned: 3, done: 2, onTime: 1, overdue: 1, onTimePct: 50 });
  });
  test("cohorts and drop-off", () => {
    const c = onboardingCohorts([
      { joined: d("2026-08-03"), status: "CONFIRMED", journeyPct: 100, exitedOn: null, daysToComplete: 20 },
      { joined: d("2026-08-10"), status: "EXITED", journeyPct: 50, exitedOn: d("2026-09-01"), daysToComplete: null },
      { joined: d("2026-09-01"), status: "PROBATION", journeyPct: 80, exitedOn: null, daysToComplete: null },
    ]);
    assert.equal(c[0]!.cohort, "2026-09");
    assert.deepEqual({ ...c[1]!, cohort: undefined }, { cohort: undefined, hires: 2, avgCompletion: 75, completed: 1, avgDaysToComplete: 20, earlyExits: 1, retention90: 50 });
    const f = onboardingDropOff([
      { joined: true, noShow: false, exitedWithinDays: null, tenureDays: 100 },
      { joined: true, noShow: false, exitedWithinDays: 20, tenureDays: 100 },
      { joined: false, noShow: true, exitedWithinDays: null, tenureDays: 0 },
    ]);
    assert.deepEqual(f.stages.map((s) => s.count), [3, 2, 1, 1]);
    assert.equal(f.noShowPct, 33);
  });
  test("template revision diff", () => {
    const a = { name: "Joiner", trigger: "JOINING", departmentId: null, locationId: null, jobTitle: null, isActive: true, tasks: [{ title: "Laptop", owner: "IT", offsetDays: -2, category: "ASSETS", isRequired: true }, { title: "Lunch", owner: "MANAGER", offsetDays: 0, category: "OTHER", isRequired: false }] };
    const b = { ...a, jobTitle: "Engineer", tasks: [{ title: "Laptop", owner: "IT", offsetDays: -5, category: "ASSETS", isRequired: true, needsApproval: true }, { title: "Buddy", owner: "HR", offsetDays: 1, category: "OTHER", isRequired: true }] };
    const diff = templateRevisionDiff(a, b);
    assert.ok(diff.some((x) => x.startsWith("jobTitle")));
    assert.ok(diff.includes('Added task "Buddy" (day 1)'));
    assert.ok(diff.includes('Removed task "Lunch"'));
    assert.ok(diff.includes('"Laptop" moved from day -2 to day -5'));
    assert.ok(diff.includes('"Laptop" now needs approval'));
  });
  test("buddy eligibility", () => {
    assert.equal(buddyCheck({ hireId: "a", buddyId: "a", buddyStatus: "CONFIRMED", activeBuddyCount: 0 }).ok, false);
    assert.equal(buddyCheck({ hireId: "a", buddyId: "b", buddyStatus: "EXITED", activeBuddyCount: 0 }).ok, false);
    assert.equal(buddyCheck({ hireId: "a", buddyId: "b", buddyStatus: "CONFIRMED", activeBuddyCount: 2 }).ok, false);
    assert.equal(buddyCheck({ hireId: "a", buddyId: "b", buddyStatus: "CONFIRMED", activeBuddyCount: 1 }).ok, true);
  });
});

describe("Background verification", () => {
  const now = d("2026-10-10");
  test("severity, SLA, rollup, consent and cost", () => {
    assert.equal(bgvSeverityFor("DOCUMENT_FORGED"), "CRITICAL");
    assert.equal(bgvSeverityFor("NOPE"), "MINOR");
    assert.equal(bgvSeverityFor(null), null);
    assert.equal(bgvSlaState(d("2026-10-20"), null, now), "ON_TRACK");
    assert.equal(bgvSlaState(d("2026-10-11"), null, now), "DUE_SOON");
    assert.equal(bgvSlaState(d("2026-10-05"), null, now), "BREACHED");
    assert.equal(bgvSlaState(d("2026-10-05"), d("2026-10-04"), now), "MET");
    assert.equal(bgvSlaState(d("2026-10-05"), d("2026-10-06"), now), "MISSED");
    assert.equal(bgvRollup([{ status: "VERIFIED" }, { status: "IN_PROGRESS" }]), "IN_PROGRESS");
    assert.equal(bgvRollup([{ status: "VERIFIED" }, { status: "WAIVED" }]), "CLEAR");
    assert.equal(bgvRollup([{ status: "VERIFIED" }, { status: "UNABLE_TO_VERIFY" }]), "DISCREPANCY");
    assert.equal(bgvRollup([{ status: "DISCREPANCY" }, { status: "FAILED" }]), "FAILED");
    assert.equal(bgvConsentState({ consentRequestedAt: null, consentGivenAt: null, consentExpiresAt: null }, now), "MISSING");
    assert.equal(bgvConsentState({ consentRequestedAt: now, consentGivenAt: null, consentExpiresAt: null }, now), "REQUESTED");
    assert.equal(bgvConsentState({ consentRequestedAt: null, consentGivenAt: d("2026-07-01"), consentExpiresAt: d("2026-10-01") }, now), "EXPIRED");
    assert.equal(bgvConsentState({ consentRequestedAt: null, consentGivenAt: d("2026-09-01"), consentExpiresAt: d("2026-10-15") }, now), "EXPIRING");
    assert.equal(bgvCostFor({ IDENTITY: 300, EMPLOYMENT: "900" }, ["IDENTITY", "EMPLOYMENT", "CRIMINAL"]), 1200);
  });
  test("queue order puts urgent and near-SLA cases first", () => {
    const urgent = bgvQueueScore({ priority: "URGENT", slaDueAt: d("2026-10-30"), joiningDate: null }, now);
    const normalSoon = bgvQueueScore({ priority: "NORMAL", slaDueAt: d("2026-10-11"), joiningDate: null }, now);
    const normalLater = bgvQueueScore({ priority: "NORMAL", slaDueAt: d("2026-10-25"), joiningDate: null }, now);
    assert.ok(urgent < normalSoon && normalSoon < normalLater);
  });
  test("vendor statistics", () => {
    const s = bgvVendorStats([
      { vendor: "A", initiatedAt: d("2026-09-01"), completedAt: d("2026-09-06"), slaDueAt: d("2026-09-08"), status: "CLEAR", cost: 1000 },
      { vendor: "A", initiatedAt: d("2026-09-01"), completedAt: d("2026-09-11"), slaDueAt: d("2026-09-08"), status: "DISCREPANCY", cost: 1500 },
      { vendor: "B", initiatedAt: d("2026-09-01"), completedAt: null, slaDueAt: d("2026-09-08"), status: "IN_PROGRESS", cost: 500 },
    ]);
    const a = s.find((x) => x.vendor === "A")!;
    assert.deepEqual({ tat: a.avgTatDays, sla: a.slaMetPct, adverse: a.adversePct, cost: a.totalCost, per: a.costPerCase }, { tat: 7.5, sla: 50, adverse: 50, cost: 2500, per: 1250 });
    assert.equal(s.find((x) => x.vendor === "B")!.avgTatDays, null);
  });
});

describe("Shift & roster", () => {
  test("planned minutes, split segments and windows", () => {
    assert.equal(shiftPlannedMinutes({ startTime: "09:30", endTime: "18:30", breakMinutes: 60 }), 480);
    assert.equal(shiftPlannedMinutes({ startTime: "22:00", endTime: "06:00", breakMinutes: 30, crossesMidnight: true }), 450);
    const split = SHIFT_TEMPLATE_LIBRARY.find((s) => s.code === "SPL")!;
    assert.equal(shiftPlannedMinutes(split), 480);
    assert.deepEqual(shiftWindow(split), { start: 480, end: 1200 });
    assert.equal(checkSplitSegments({ startTime: "08:00", endTime: "12:00", crossesMidnight: false }, [{ start: "11:00", end: "14:00" }]), "The segment 11:00–14:00 overlaps the one before it.");
    assert.equal(checkSplitSegments({ startTime: "08:00", endTime: "12:00", crossesMidnight: false }, [{ start: "16:00", end: "20:00" }]), null);
    assert.ok(checkSplitSegments({ startTime: "22:00", endTime: "06:00", crossesMidnight: true }, [{ start: "07:00", end: "08:00" }]));
  });
  test("rest periods, staffing, leave and preferences", () => {
    const night = { id: "N", name: "Night", startTime: "22:00", endTime: "06:00", crossesMidnight: true };
    const morning = { id: "M", name: "Morning", startTime: "06:00", endTime: "14:00" };
    assert.equal(restHoursBetween({ date: d("2026-10-05"), ...shiftWindow(night) }, { date: d("2026-10-06"), ...shiftWindow(morning) }), 0);
    const employees = new Map([["a", { departmentId: "D", locationId: null, name: "A" }], ["b", { departmentId: "D", locationId: null, name: "B" }]]);
    const v = rosterViolations({
      assignments: [
        { employeeId: "a", date: d("2026-10-05"), shiftId: "N", off: false },
        { employeeId: "a", date: d("2026-10-06"), shiftId: "M", off: false },
        { employeeId: "b", date: d("2026-10-06"), shiftId: "M", off: false },
        { employeeId: "b", date: d("2026-10-05"), shiftId: null, off: true },
      ],
      shifts: [night, morning], minRestHours: 11, employees,
      rules: [{ id: "r", name: "Morning cover", shiftId: "M", departmentId: "D", locationId: null, weekdays: [], minStaff: 1, maxStaff: 1 }],
      leave: new Set(["b:2026-10-06"]), avoid: new Map([["a", [1]]]),
    });
    const kinds = v.map((x) => x.kind).sort();
    assert.deepEqual(kinds, ["ON_LEAVE", "OVERSTAFFED", "PREFERENCE", "REST", "UNDERSTAFFED"]);
  });
  test("coverage grid and heat levels", () => {
    const cov = rosterCoverage([{ employeeId: "a", date: d("2026-10-05"), shiftId: "M", off: false }, { employeeId: "b", date: d("2026-10-05"), shiftId: "M", off: false }, { employeeId: "c", date: d("2026-10-05"), shiftId: "M", off: true }], ["2026-10-05", "2026-10-06"], ["M"]);
    assert.deepEqual(cov.M, { "2026-10-05": 2, "2026-10-06": 0 });
    assert.deepEqual([0, 1, 2, 3, 5].map((c) => coverageLevel(c, 2)), [0, 1, 3, 3, 4]);
  });
  test("trade eligibility", () => {
    const settings = { swapMinNoticeHours: 24, swapSameDepartmentOnly: true, swapMaxPerMonth: 2 };
    const me = { id: "a", departmentId: "D", status: "CONFIRMED" };
    assert.equal(shiftTradeEligibility({ requester: me, counterpart: { id: "b", departmentId: "D", status: "CONFIRMED" }, settings, hoursUntilShift: 48, swapsThisMonth: 0 }).ok, true);
    const bad = shiftTradeEligibility({ requester: me, counterpart: { id: "b", departmentId: "X", status: "CONFIRMED" }, settings, hoursUntilShift: 2, swapsThisMonth: 2, counterpartOnLeave: true, restOk: false });
    assert.equal(bad.reasons.length, 5);
    assert.equal(shiftTradeEligibility({ requester: me, counterpart: null, settings, hoursUntilShift: 48, swapsThisMonth: 0 }).ok, true);
  });
  test("roster diff, cost forecast and adherence", () => {
    const diff = rosterSnapshotDiff([{ employeeId: "a", date: "2026-10-05", shiftId: "M", off: false }], [{ employeeId: "a", date: "2026-10-05", shiftId: null, off: true }, { employeeId: "b", date: "2026-10-05", shiftId: "N", off: false }]);
    assert.deepEqual(diff, [{ employeeId: "a", date: "2026-10-05", from: "M", to: "OFF" }, { employeeId: "b", date: "2026-10-05", from: "—", to: "N" }]);
    const cost = shiftCostForecast([{ employeeId: "a", shiftId: "M" }, { employeeId: "a", shiftId: "M" }], new Map([["M", { minutes: 480, allowancePerDay: 100 }]]), new Map([["a", 250]]));
    assert.deepEqual(cost[0], { shiftId: "M", days: 2, hours: 16, wages: 4000, allowance: 200, total: 4200 });
    assert.equal(shiftAdherence({ start: 540, end: 1080 }, { firstIn: 560, lastOut: 1080, status: "PRESENT" }, 10).status, "LATE");
    assert.equal(shiftAdherence({ start: 540, end: 1080 }, { firstIn: 545, lastOut: 1000, status: "PRESENT" }, 10).earlyMinutes, 80);
    assert.equal(shiftAdherence({ start: 540, end: 1080 }, { firstIn: null, lastOut: null, status: "ABSENT" }).status, "ABSENT");
    assert.equal(shiftAdherence(null, { firstIn: 1, lastOut: 2, status: "PRESENT" }).status, "UNPLANNED");
  });
});

describe("Holidays & calendars", () => {
  test("CSV import accepts both date styles and reports bad lines", () => {
    const r = parseHolidayCsv("Name,Date,Optional,Type\nRepublic Day,2027-01-26,No,National\nHoli,22/03/2027,yes,festival\nBad,2027-02-30\n,2027-01-01");
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[1], { name: "Holi", date: "2027-03-22", isOptional: true, dayType: "FESTIVAL" });
    assert.equal(r.errors.length, 2);
  });
  test("version comparison and effective-dated merge", () => {
    const a = [{ name: "Diwali", date: "2026-11-08", isOptional: false }, { name: "Onam", date: "2026-08-26", isOptional: true }];
    const b = [{ name: "Diwali", date: "2026-11-09", isOptional: false }, { name: "Christmas", date: "2026-12-25", isOptional: false }];
    assert.deepEqual(calendarDiff(a, b).map((x) => x.change).sort(), ["ADDED", "MOVED", "REMOVED"]);
    const merged = mergeCalendarRevision([{ name: "Republic Day", date: "2026-01-26", isOptional: false }, { name: "Diwali", date: "2026-11-08", isOptional: false }], b, "2026-07-01");
    assert.deepEqual(merged.map((h) => h.name), ["Republic Day", "Diwali", "Christmas"]);
    assert.equal(mergeCalendarRevision(a, b, null).length, 2);
  });
  test("weekend substitution, count validation, shutdown and impact", () => {
    // 2026-10-03 is a Saturday.
    const subs = weekendSubstitutes([{ name: "Festival", date: "2026-10-03", isOptional: false }, { name: "Opt", date: "2026-10-04", isOptional: true }], null);
    assert.deepEqual(subs, [{ name: "Festival (substitute)", date: "2026-10-05", isOptional: false, dayType: "SUBSTITUTE" }]);
    assert.equal(holidayCountCheck([{ name: "A", date: "2026-01-01", isOptional: false }, { name: "B", date: "2026-01-01", isOptional: true }], { min: 2, max: 0, maxOptional: 0 }).length, 3);
    assert.deepEqual(holidayCountCheck([{ name: "A", date: "2026-01-01", isOptional: false }], { min: 1, max: 10 }), []);
    assert.deepEqual(shutdownWorkingDays(d("2026-12-24"), d("2026-12-31"), null, new Set(["2026-12-25"])), ["2026-12-24", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"]);
    const imp = holidayImpact([{ name: "A", date: "2026-10-02", isOptional: false }, { name: "B", date: "2026-10-03", isOptional: false }], 2026, null);
    assert.deepEqual({ on: imp.onWorkingDays, off: imp.onWeeklyOffs, wk: imp.weeklyOffs, work: imp.workingDays }, { on: 1, off: 1, wk: 104, work: 260 });
  });
  test("conflict detection", () => {
    const c = calendarConflicts({
      calendars: [
        { id: "c1", name: "India", year: 2026, isDefault: true, locationIds: ["L1"], holidays: [{ name: "X", date: "2026-10-03", isOptional: false }, { name: "Y", date: "2026-10-05", isOptional: false }, { name: "Z", date: "2026-10-05", isOptional: false }] },
        { id: "c2", name: "Karnataka", year: 2026, isDefault: false, locationIds: ["L1"], holidays: [] },
      ],
      weeklyOff: null, locations: [{ id: "L1", name: "Bengaluru" }], year: 2026, unassignedEmployees: 3,
    });
    assert.deepEqual(c.map((x) => x.kind).sort(), ["DUPLICATE_DATE", "EMPTY_CALENDAR", "HOLIDAY_ON_WEEKLY_OFF", "NEXT_YEAR_MISSING", "NO_CALENDAR", "OVERLAPPING_REGION"]);
  });
});

describe("Overtime", () => {
  test("tiers parse and weight minutes", () => {
    const { tiers, error } = parseOtTiers("120:1.5, :2");
    assert.equal(error, null);
    assert.deepEqual(tiers, [{ upTo: 120, multiplier: 1.5 }, { upTo: null, multiplier: 2 }]);
    assert.equal(tieredOtMinutes(180, tiers), 120 * 1.5 + 60 * 2);
    assert.equal(tieredOtMinutes(60, tiers), 90);
    assert.ok(parseOtTiers("120:1.5, 60:2").error);
    assert.ok(parseOtTiers("x").error);
    assert.deepEqual(parseOtTiers("60:1.25").tiers, [{ upTo: 60, multiplier: 1.25 }, { upTo: null, multiplier: 1.25 }]);
  });
  test("night window premium", () => {
    // Out at 23:00 (1380) after 120 minutes of overtime: 60 minutes inside 22:00–06:00.
    assert.equal(otWindowPremium(120, 1380, [{ start: "22:00", end: "06:00", multiplier: 0.5 }]), 30);
    assert.equal(otWindowPremium(120, 1200, [{ start: "22:00", end: "06:00", multiplier: 0.5 }]), 0);
  });
  test("daily, weekly and monthly caps; holiday tiers; weekly threshold", () => {
    const rule = { tiers: { WORKDAY: [{ upTo: 60, multiplier: 1.5 }, { upTo: null, multiplier: 2 }], HOLIDAY: [{ upTo: null, multiplier: 3 }] }, windows: null, weeklyThresholdMinutes: null, dailyCapMinutes: 120, weeklyCapMinutes: null, monthlyCapMinutes: null, minMinutes: 30 };
    const days = [
      { date: d("2026-10-05"), dayType: "WORKDAY" as const, overtimeMinutes: 180, workedMinutes: 660, outMinute: null },
      { date: d("2026-10-06"), dayType: "WORKDAY" as const, overtimeMinutes: 20, workedMinutes: 500, outMinute: null },
      { date: d("2026-10-11"), dayType: "HOLIDAY" as const, overtimeMinutes: 60, workedMinutes: 60, outMinute: null },
    ];
    const r = computeOvertime(days, rule);
    assert.equal(r.payableMinutes, 180);
    assert.equal(r.excessMinutes, 60);
    assert.equal(r.weightedMinutes, 60 * 1.5 + 60 * 2 + 60 * 3);
    const capped = computeOvertime(days, { ...rule, monthlyCapMinutes: 90 });
    assert.equal(capped.payableMinutes, 90);
    assert.equal(capped.excessMinutes, 60 + 90);
    const weekly = computeOvertime([
      { date: d("2026-10-05"), dayType: "WORKDAY" as const, overtimeMinutes: 0, workedMinutes: 3000, outMinute: null },
    ], { ...rule, weeklyThresholdMinutes: 2880 });
    assert.equal(weekly.weeklyMinutes, 120);
    assert.equal(weekly.payableMinutes, 120);
  });
  test("eligibility by grade, band, shift and location; timing rules", () => {
    const rules = [
      { id: "all", priority: 0, status: "ACTIVE", bandIds: [], payGradeIds: [], shiftIds: [], locationIds: [] },
      { id: "night", priority: 5, status: "ACTIVE", bandIds: [], payGradeIds: [], shiftIds: ["N"], locationIds: [] },
      { id: "g1", priority: 3, status: "ACTIVE", bandIds: [], payGradeIds: ["G1"], shiftIds: [], locationIds: [] },
      { id: "draft", priority: 9, status: "DRAFT", bandIds: [], payGradeIds: [], shiftIds: [], locationIds: [] },
    ];
    assert.equal(overtimeRuleFor(rules, { bandId: null, payGradeId: "G1", shiftId: "N", locationId: null })?.id, "night");
    assert.equal(overtimeRuleFor(rules, { bandId: null, payGradeId: "G1", shiftId: "M", locationId: null })?.id, "g1");
    assert.equal(overtimeRuleFor(rules, { bandId: null, payGradeId: null, shiftId: null, locationId: null })?.id, "all");
    assert.equal(overtimeTimingCheck({ name: "Pre", requirePreApproval: true, postFactoDays: null }, d("2026-10-01"), d("2026-10-02")).ok, false);
    assert.equal(overtimeTimingCheck({ name: "Pre", requirePreApproval: true, postFactoDays: null }, d("2026-10-03"), d("2026-10-02")).ok, true);
    assert.equal(overtimeTimingCheck({ name: "Post", requirePreApproval: false, postFactoDays: 3 }, d("2026-09-25"), d("2026-10-02")).ok, false);
    assert.equal(overtimeTimingCheck({ name: "Post", requirePreApproval: false, postFactoDays: 3 }, d("2026-09-30"), d("2026-10-02")).ok, true);
    assert.equal(overtimeTimingCheck(null, d("2020-01-01"), d("2026-10-02")).ok, true);
  });
  test("reconciliation, anomalies and comp-off expiry", () => {
    assert.equal(overtimeReconciliation({ requestedMinutes: 120, approvedMinutes: 120, loggedMinutes: 130, paidMinutes: 120 }).status, "MATCHED");
    assert.equal(overtimeReconciliation({ requestedMinutes: 120, approvedMinutes: 120, loggedMinutes: 130, paidMinutes: 60 }).status, "UNPAID_APPROVED");
    assert.equal(overtimeReconciliation({ requestedMinutes: 300, approvedMinutes: 0, loggedMinutes: 60, paidMinutes: 0 }).status, "CLAIM_EXCEEDS_LOG");
    assert.equal(overtimeReconciliation({ requestedMinutes: 0, approvedMinutes: 0, loggedMinutes: 200, paidMinutes: 0 }).status, "UNCLAIMED_LOGGED");
    const a = overtimeAnomalies([{ date: d("2026-10-01"), overtimeMinutes: 400 }, { date: d("2026-10-02"), overtimeMinutes: 100 }], { dailyLimit: 360, previousMonthMinutes: 120, requestedMinutes: 0 });
    assert.deepEqual(a.map((x) => x.kind), ["ANOMALY_DAILY", "ANOMALY_SPIKE", "ANOMALY_NO_REQUEST"]);
    const soon = compOffExpiringSoon([{ id: "1", employeeId: "e", days: 1, expiresOn: d("2026-10-05") }, { id: "2", employeeId: "e", days: 1, expiresOn: d("2026-11-30") }, { id: "3", employeeId: "e", days: 1, expiresOn: d("2026-09-30") }], d("2026-10-01"), 7);
    assert.deepEqual(soon.map((c) => c.id), ["1"]);
  });
});
