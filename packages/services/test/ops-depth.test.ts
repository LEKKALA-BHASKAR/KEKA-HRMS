import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  OPS_CONFIG_KINDS, opsParseField, opsConfigDiff, opsDescribeDiff, opsVersionAt, opsCutoffDate, opsNextCutoff, opsCutoffAlertDue, opsLockFor, opsLockIssue,
  opsClassifyDay, opsEarlyDeparturePenalties, opsDeviceHealth, opsSourceComparison, opsHeatLevel, opsReconcileMonth, opsAttendanceIcs, opsBreakOutcome, opsBreakStartIssue,
  opsEntryRuleIssues, opsTaskBudgetCheck, opsTimesheetCutoffPassed, opsAllocateOvertime, opsProjectVariance, opsUtilisation, opsTimeLeakage, opsExportColumns,
  opsBlackoutIssues, opsWithdrawalOpen, opsEscalationDue, opsLeaveVisible, opsLiabilityForecast, opsAbsenceCanMove, opsReturnBlockers, opsAssignmentCanMove, opsAssignmentIssues,
  opsConfirmationEligibility, opsFteConversion, opsContractMilestonesDue, opsLifecycleConflicts, opsRoundNet, opsRecurringDue, opsComponentTree, opsTreeCycle,
  opsVarianceBreaches, opsValidatePayrollInputs, opsLwfReconcile, opsStructureStatutoryIssues, OPS_WORKFLOW_TYPES, isOpsWorkflowType, type OpsAnomalyDay, type OpsBlackout,
} from "../src/ops-math";
import { WORKFLOW_ENTITY_TYPES } from "../src/governance-math";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const T = (s: string) => new Date(s);

describe("Configuration changes", () => {
  const spec = { key: "graceMinutes", label: "Grace", type: "int" as const, min: 0, max: 120 };
  test("fields parse with bounds and types", () => {
    assert.deepEqual(opsParseField(spec, "15"), { value: 15 });
    assert.ok("error" in opsParseField(spec, "1.5"));
    assert.ok("error" in opsParseField(spec, "500"));
    assert.deepEqual(opsParseField(spec, ""), { value: null });
    assert.deepEqual(opsParseField({ key: "x", label: "X", type: "bool" }, "on"), { value: true });
    assert.ok("error" in opsParseField({ key: "m", label: "Mode", type: "enum", options: ["A", "B"] }, "C"));
  });
  test("a diff lists only changed fields and reads as before → after", () => {
    const fields = [spec, { key: "name", label: "Name", type: "text" as const }];
    const diff = opsConfigDiff(fields, { graceMinutes: 10, name: "Std" }, { graceMinutes: 15, name: "Std" });
    assert.deepEqual(diff.map((d) => d.key), ["graceMinutes"]);
    assert.equal(opsDescribeDiff(diff), "Grace: 10 → 15");
  });
  test("the version in force is the latest effective on the date", () => {
    const vs = [{ version: 1, effectiveFrom: D("2026-01-01") }, { version: 3, effectiveFrom: D("2026-12-01") }, { version: 2, effectiveFrom: D("2026-06-01") }];
    assert.equal(opsVersionAt(vs, D("2026-07-15"))?.version, 2);
    assert.equal(opsVersionAt(vs, D("2025-07-15")), null);
  });
  test("every governed kind names a permission and fields", () => {
    for (const k of Object.values(OPS_CONFIG_KINDS)) { assert.ok(k.permission.includes(".")); assert.ok(k.fields.length > 0); }
  });
});

describe("Cut-off on the 25th and period locks", () => {
  test("cut-off date, clamped to short months", () => {
    assert.equal(opsCutoffDate(2026, 10, 25).toISOString().slice(0, 10), "2026-10-25");
    assert.equal(opsCutoffDate(2026, 2, 31).toISOString().slice(0, 10), "2026-02-28");
  });
  test("next cut-off rolls into the next month (and year) once passed", () => {
    assert.deepEqual(opsNextCutoff(D("2026-10-05"), 25), { date: D("2026-10-25"), daysLeft: 20 });
    assert.equal(opsNextCutoff(D("2026-12-26"), 25).date.toISOString().slice(0, 10), "2027-01-25");
    assert.equal(opsCutoffAlertDue(D("2026-10-22"), 25, 3), true);
    assert.equal(opsCutoffAlertDue(D("2026-10-20"), 25, 3), false);
  });
  test("locks cover their days and refuse overlaps", () => {
    const locks = [{ periodStart: D("2026-09-01"), periodEnd: D("2026-09-30"), status: "LOCKED" }, { periodStart: D("2026-08-01"), periodEnd: D("2026-08-31"), status: "REOPENED" }];
    assert.ok(opsLockFor(locks, D("2026-09-15")));
    assert.equal(opsLockFor(locks, D("2026-08-15")), null);
    assert.match(opsLockIssue(D("2026-09-20"), D("2026-10-10"), locks)!, /overlaps/);
    assert.match(opsLockIssue(D("2026-01-01"), D("2026-06-30"), [])!, /three months/);
    assert.equal(opsLockIssue(D("2026-10-01"), D("2026-10-31"), locks), null);
  });
});

describe("Attendance exceptions and analytics", () => {
  const base: OpsAnomalyDay = { status: "PRESENT", isWorkingDay: true, onLeave: false, firstIn: T("2026-10-05T04:00:00Z"), lastOut: T("2026-10-05T12:30:00Z"), shiftStart: T("2026-10-05T03:30:00Z"), shiftEnd: T("2026-10-05T12:30:00Z"), effectiveHours: 8.5, shiftHours: 9, validPunches: 2, graceMinutes: 10, earlyGraceMinutes: 10 };
  test("classifies late arrival, early departure, absence and off-day work", () => {
    assert.deepEqual(opsClassifyDay(base).map((a) => a.kind), ["LATE_ARRIVAL"]);
    assert.deepEqual(opsClassifyDay({ ...base, firstIn: base.shiftStart, lastOut: T("2026-10-05T10:00:00Z"), effectiveHours: 6.5 }).map((a) => a.kind), ["EARLY_DEPARTURE"]);
    assert.deepEqual(opsClassifyDay({ ...base, validPunches: 0, firstIn: null, lastOut: null }).map((a) => a.kind), ["ABSENT_NO_LEAVE"]);
    assert.deepEqual(opsClassifyDay({ ...base, lastOut: null, validPunches: 1 }).map((a) => a.kind), ["MISSING_PUNCH", "LATE_ARRIVAL"]);
    assert.deepEqual(opsClassifyDay({ ...base, isWorkingDay: false }).map((a) => a.kind), ["OFF_DAY_WORK"]);
    assert.deepEqual(opsClassifyDay({ ...base, onLeave: true }), []);
  });
  test("early-departure penalties start after the monthly exemptions", () => {
    const r = opsEarlyDeparturePenalties([{ date: D("2026-10-01"), minutes: 30 }, { date: D("2026-10-02"), minutes: 5 }, { date: D("2026-10-03"), minutes: 40 }, { date: D("2026-10-04"), minutes: 50 }], { graceMinutes: 15, exemptPerMonth: 2, penaltyDays: 0.5 });
    assert.deepEqual(r.map((x) => x.penalty), [0, 0, 0.5]);
  });
  test("device health, source comparison and heatmap shades", () => {
    const now = T("2026-10-05T12:00:00Z");
    assert.equal(opsDeviceHealth({ isActive: true, lastPunchAt: T("2026-10-05T11:00:00Z"), createdAt: D("2026-01-01") }, now), "HEALTHY");
    assert.equal(opsDeviceHealth({ isActive: true, lastPunchAt: T("2026-10-05T06:00:00Z"), createdAt: D("2026-01-01") }, now), "STALE");
    assert.equal(opsDeviceHealth({ isActive: true, lastPunchAt: T("2026-10-03T06:00:00Z"), createdAt: D("2026-01-01") }, now), "OFFLINE");
    assert.equal(opsDeviceHealth({ isActive: false, lastPunchAt: null, createdAt: D("2026-01-01") }, now), "INACTIVE");
    const c = opsSourceComparison([{ source: "BIOMETRIC", timestamp: T("2026-10-05T03:30:00Z"), direction: 0 }, { source: "MOBILE", timestamp: T("2026-10-05T04:10:00Z"), direction: 0 }], 15);
    assert.equal(c.mismatch, true); assert.equal(c.spreadMinutes, 40);
    assert.deepEqual([opsHeatLevel(10, 10), opsHeatLevel(8, 10), opsHeatLevel(6, 10), opsHeatLevel(1, 10), opsHeatLevel(0, 10), opsHeatLevel(0, 0)], [4, 3, 2, 1, 0, 0]);
  });
  test("reconciliation is ready only with nothing open", () => {
    const days = [{ status: "PRESENT", payableValue: 1, lopValue: 0, onLeave: false, anomalies: 0 }, { status: "ABSENT", payableValue: 0, lopValue: 1, onLeave: false, anomalies: 1 }];
    const r = opsReconcileMonth("e1", days, 0);
    assert.equal(r.present, 1); assert.equal(r.absent, 1); assert.equal(r.lop, 1); assert.equal(r.balanced, false);
    assert.equal(opsReconcileMonth("e1", days.slice(0, 1), 0).balanced, true);
    assert.equal(opsReconcileMonth("e1", days.slice(0, 1), 2).balanced, false);
  });
  test("the .ics export is a valid all-day calendar", () => {
    const ics = opsAttendanceIcs("Meera, attendance", [{ date: D("2026-10-05"), summary: "Present 09:30–18:30" }], T("2026-10-05T12:00:00Z"));
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006/);
    assert.match(ics, /X-WR-CALNAME:Meera\\, attendance/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
  });
  test("breaks: one at a time, a daily cap, and over-limit flagged", () => {
    assert.equal(opsBreakOutcome(35, { maxMinutes: 30 }), "EXCEEDED");
    assert.equal(opsBreakOutcome(30, { maxMinutes: 30 }), "OK");
    assert.match(opsBreakStartIssue([{ ruleId: "r", endAt: null }], { id: "r", maxPerDay: 2, name: "Tea" })!, /End the break/);
    assert.match(opsBreakStartIssue([{ ruleId: "r", endAt: D("2026-10-05") }], { id: "r", maxPerDay: 1, name: "Tea" })!, /most allowed/);
    assert.equal(opsBreakStartIssue([], { id: "r", maxPerDay: 1, name: "Tea" }), null);
  });
});

describe("Project time", () => {
  const codes = [{ code: "DEV", label: "Development", billable: true, requiresTask: true, requiresComment: false, isActive: true }, { code: "OLD", label: "Old", billable: null, requiresTask: false, requiresComment: false, isActive: false }];
  test("entry rules: comments, codes, task and billing", () => {
    const rules = { requireComment: true, minLength: 5, requireTimeCode: true, codes };
    assert.deepEqual(opsEntryRuleIssues([{ projectId: "p", hours: 2, description: "Built the API", timeCode: "DEV", taskId: "t", isBillable: true }], rules), []);
    const bad = opsEntryRuleIssues([{ projectId: "p", hours: 2, description: "x", timeCode: "DEV", isBillable: false }, { projectId: "p", hours: 1, description: "Something", timeCode: "OLD" }, { projectId: "p", hours: 1, description: "Something" }], rules);
    assert.ok(bad.some((m) => /at least 5/.test(m)));
    assert.ok(bad.some((m) => /against a task/.test(m)));
    assert.ok(bad.some((m) => /only for billable/.test(m)));
    assert.ok(bad.some((m) => /not an active/.test(m)));
    assert.ok(bad.some((m) => /needs an activity code/.test(m)));
  });
  test("task budgets warn or block past the tolerance", () => {
    assert.deepEqual(opsTaskBudgetCheck({ title: "T", estimated: 10, loggedElsewhere: 9, adding: 2 }, "OFF", 0), { block: false, warning: null });
    assert.equal(opsTaskBudgetCheck({ title: "T", estimated: 10, loggedElsewhere: 9, adding: 2 }, "WARN", 0).block, false);
    assert.equal(opsTaskBudgetCheck({ title: "T", estimated: 10, loggedElsewhere: 9, adding: 2 }, "BLOCK", 0).block, true);
    assert.equal(opsTaskBudgetCheck({ title: "T", estimated: 10, loggedElsewhere: 9, adding: 2 }, "BLOCK", 20).block, false);
  });
  test("timesheet edit window closes N days after the week", () => {
    assert.equal(opsTimesheetCutoffPassed(D("2026-09-28"), 3, D("2026-10-07")), false);
    assert.equal(opsTimesheetCutoffPassed(D("2026-09-28"), 3, D("2026-10-08")), true);
    assert.equal(opsTimesheetCutoffPassed(D("2026-09-28"), null, D("2027-01-01")), false);
  });
  test("overtime allocation is proportional and sums exactly", () => {
    const r = opsAllocateOvertime(10, 1000, [{ projectId: "a", hours: 1 }, { projectId: "b", hours: 2 }, { projectId: "c", hours: 0 }]);
    assert.equal(r.length, 2);
    assert.equal(Math.round(r.reduce((s, x) => s + x.amount, 0) * 100) / 100, 1000);
    assert.equal(Math.round(r.reduce((s, x) => s + x.hours, 0) * 100) / 100, 10);
    assert.deepEqual(opsAllocateOvertime(5, 100, []), []);
  });
  test("variance, utilisation, leakage and export columns", () => {
    const v = opsProjectVariance({ budgetHours: 100, actualHours: 80, start: D("2026-01-01"), end: D("2026-12-31") }, D("2026-04-01"), 10);
    assert.equal(v.alert, true);
    assert.equal(opsProjectVariance({ budgetHours: null, actualHours: 10, start: null, end: null }, D("2026-04-01")).alert, false);
    assert.deepEqual(opsUtilisation(30, 40, 40, 80), { billablePct: 75, loggedPct: 100, gap: -5, onTarget: false });
    assert.deepEqual(opsTimeLeakage({ scheduled: 40, attended: 38, logged: 30, idle: 3 }), { attendancePct: 95, leakageHours: 8, leakagePct: 21.05, unexplained: 5 });
    assert.deepEqual(opsExportColumns(["hours", "bogus", "date", "hours"]), ["hours", "date"]);
    assert.deepEqual(opsExportColumns([]), ["date", "employee", "project", "hours", "billable"]);
  });
});

describe("Leave controls", () => {
  const w = (x: Partial<OpsBlackout>): OpsBlackout => ({ id: "w", name: "Year end", kind: "BLACKOUT", startDate: D("2026-12-20"), endDate: D("2026-12-31"), departmentId: null, locationId: null, leaveTypeIds: [], maxConcurrent: null, maxConcurrentPct: null, isActive: true, ...x });
  const req = { from: D("2026-12-22"), to: D("2026-12-23"), leaveTypeId: "PL", departmentId: "d1", locationId: null };
  test("blackouts refuse, peaks cap, scope and type filter", () => {
    assert.equal(opsBlackoutIssues(req, [w({})], () => ({ away: 0, group: 10 })).length, 1);
    assert.equal(opsBlackoutIssues(req, [w({ departmentId: "d2" })], () => ({ away: 0, group: 10 })).length, 0);
    assert.equal(opsBlackoutIssues(req, [w({ leaveTypeIds: ["SL"] })], () => ({ away: 0, group: 10 })).length, 0);
    assert.equal(opsBlackoutIssues(req, [w({ kind: "PEAK", maxConcurrent: 2 })], () => ({ away: 1, group: 10 })).length, 0);
    assert.match(opsBlackoutIssues(req, [w({ kind: "PEAK", maxConcurrentPct: 20 })], () => ({ away: 2, group: 10 }))[0]!, /at most 2/);
  });
  test("withdrawal window, escalation and calendar visibility", () => {
    assert.equal(opsWithdrawalOpen(D("2026-10-20"), D("2026-10-10"), 7), true);
    assert.equal(opsWithdrawalOpen(D("2026-10-20"), D("2026-10-15"), 7), false);
    assert.equal(opsWithdrawalOpen(D("2026-10-20"), D("2026-10-19"), null), true);
    assert.equal(opsEscalationDue(T("2026-10-01T00:00:00Z"), T("2026-10-03T00:00:00Z"), 48), true);
    assert.equal(opsEscalationDue(T("2026-10-01T00:00:00Z"), T("2026-10-03T00:00:00Z"), null), false);
    const viewer = { employeeId: "me", managerId: "boss", departmentId: "d1", isManager: false };
    assert.equal(opsLeaveVisible("TEAM", viewer, { employeeId: "peer", managerId: "boss", departmentId: "d2" }), true);
    assert.equal(opsLeaveVisible("TEAM", viewer, { employeeId: "x", managerId: "other", departmentId: "d1" }), false);
    assert.equal(opsLeaveVisible("DEPARTMENT", viewer, { employeeId: "x", managerId: "other", departmentId: "d1" }), true);
    assert.equal(opsLeaveVisible("MANAGERS", viewer, { employeeId: "peer", managerId: "boss", departmentId: "d1" }), false);
  });
  test("liability forecast grows by accrual up to the cap; non-encashable counts nothing", () => {
    const f = opsLiabilityForecast([{ balance: 10, monthlyAccrual: 1.5, perDay: 1000, cap: 12, encashable: true }, { balance: 5, monthlyAccrual: 1, perDay: 1000, cap: null, encashable: false }], 3);
    assert.equal(f.today, 10000);
    assert.deepEqual(f.forecast, [11500, 12000, 12000]);
  });
  test("long absences move in order and return needs the certificate and checklist", () => {
    assert.equal(opsAbsenceCanMove("REQUESTED", "APPROVED"), true);
    assert.equal(opsAbsenceCanMove("REQUESTED", "ON_LEAVE"), false);
    assert.equal(opsAbsenceCanMove("ON_LEAVE", "RETURNED"), true);
    assert.equal(opsReturnBlockers({ rtwRequired: true, rtwCertifiedAt: null, fitForWork: null, checklist: [{ item: "a", done: false }] }).length, 2);
    assert.deepEqual(opsReturnBlockers({ rtwRequired: true, rtwCertifiedAt: D("2026-10-01"), fitForWork: true, checklist: [{ item: "a", done: true }] }), []);
  });
});

describe("Lifecycle", () => {
  test("assignments: state machine and validation", () => {
    assert.equal(opsAssignmentCanMove("APPROVED", "ACTIVE"), true);
    assert.equal(opsAssignmentCanMove("REQUESTED", "COMPLETED"), false);
    assert.ok(opsAssignmentIssues({ kind: "SECONDMENT", startDate: D("2026-10-01"), endDate: D("2026-12-01"), hostDepartmentId: null, hostOrganisation: null, costSharePct: null }).some((m) => /host/.test(m)));
    assert.ok(opsAssignmentIssues({ kind: "TEMPORARY", startDate: D("2026-10-01"), endDate: D("2026-09-01"), hostDepartmentId: "d", hostOrganisation: null, costSharePct: 150 }).length >= 2);
    assert.deepEqual(opsAssignmentIssues({ kind: "TEMPORARY", startDate: D("2026-10-01"), endDate: D("2026-12-01"), hostDepartmentId: "d", hostOrganisation: null, costSharePct: 50 }), []);
  });
  test("confirmation rules", () => {
    const rule = { minServiceDays: 90, maxLopDays: 2, maxLateMarks: 3, noWarningsMonths: 6, requireEvaluation: true, minRating: 3 };
    assert.deepEqual(opsConfirmationEligibility({ serviceDays: 100, lopDays: 0, lateMarks: 1, warningsInWindow: 0, evaluationDone: true, rating: 4 }, rule), { eligible: true, reasons: [] });
    assert.equal(opsConfirmationEligibility({ serviceDays: 30, lopDays: 5, lateMarks: 9, warningsInWindow: 1, evaluationDone: false, rating: null }, rule).reasons.length, 6);
  });
  test("FTE conversion scales hours and CTC", () => {
    assert.deepEqual(opsFteConversion({ fte: 1, weeklyHours: 40, ctc: 1_200_000 }, 0.6), { toWeeklyHours: 24, toCtc: 720_000, direction: "FT_TO_PT" });
    assert.deepEqual(opsFteConversion({ fte: 0.5, weeklyHours: 20, ctc: 600_000 }, 1), { toWeeklyHours: 40, toCtc: 1_200_000, direction: "PT_TO_FT" });
    assert.ok("error" in opsFteConversion({ fte: 1, weeklyHours: 40, ctc: 1 }, 1.2));
    assert.ok("error" in opsFteConversion({ fte: 1, weeklyHours: 40, ctc: 1 }, 1));
  });
  test("contract milestones: only the nearest reached one, once", () => {
    assert.deepEqual(opsContractMilestonesDue(D("2026-11-04"), [60, 30, 7], D("2026-10-05"), new Set()), [30]);
    assert.deepEqual(opsContractMilestonesDue(D("2026-11-04"), [60, 30, 7], D("2026-10-05"), new Set([30])), []);
    assert.deepEqual(opsContractMilestonesDue(D("2026-09-04"), [60, 30, 7], D("2026-10-05"), new Set()), []);
  });
  test("lifecycle dependencies", () => {
    const ok = { status: "CONFIRMED", onLongAbsence: false, activeAssignment: null, pendingJobChange: false, pendingFte: false, openExit: false };
    assert.deepEqual(opsLifecycleConflicts(ok, "PROMOTION"), []);
    assert.deepEqual(opsLifecycleConflicts({ ...ok, status: "PROBATION" }, "PROMOTION"), []);
    assert.ok(opsLifecycleConflicts({ ...ok, status: "NOTICE_PERIOD" }, "PROMOTION").length > 0);
    assert.ok(opsLifecycleConflicts({ ...ok, openExit: true }, "JOB_CHANGE").length > 0);
    assert.ok(opsLifecycleConflicts({ ...ok, onLongAbsence: true }, "ASSIGNMENT").length > 0);
    assert.ok(opsLifecycleConflicts(ok, "CONFIRMATION").length > 0);
    assert.deepEqual(opsLifecycleConflicts({ ...ok, status: "PROBATION" }, "CONFIRMATION"), []);
  });
});

describe("Payroll controls", () => {
  test("net pay rounding", () => {
    assert.deepEqual(opsRoundNet(12345.67, 10, "NEAREST"), { rounded: 12350, adjustment: 4.33 });
    assert.deepEqual(opsRoundNet(12345.67, 10, "DOWN"), { rounded: 12340, adjustment: -5.67 });
    assert.deepEqual(opsRoundNet(12341, 10, "UP"), { rounded: 12350, adjustment: 9 });
    assert.deepEqual(opsRoundNet(12345.67, 1, "NEAREST"), { rounded: 12346, adjustment: 0.33 });
  });
  test("recurring rules fall due by frequency and named months", () => {
    const r = { frequency: "QUARTERLY", months: [] as number[], startDate: D("2026-04-01"), endDate: null, isActive: true };
    assert.deepEqual([4, 5, 7, 10].map((m) => opsRecurringDue(r, 2026, m)), [true, false, true, true]);
    assert.equal(opsRecurringDue({ ...r, frequency: "ANNUAL", months: [3] }, 2027, 3), true);
    assert.equal(opsRecurringDue({ ...r, frequency: "MONTHLY" }, 2026, 3), false);
    assert.equal(opsRecurringDue({ ...r, frequency: "MONTHLY", isActive: false }, 2026, 6), false);
  });
  test("component tree ordering and cycle check", () => {
    const g = [{ id: "a", parentId: null, sortOrder: 1, name: "Allowances" }, { id: "b", parentId: null, sortOrder: 0, name: "Basic" }, { id: "c", parentId: "a", sortOrder: 0, name: "HRA" }];
    assert.deepEqual(opsComponentTree(g).map((x) => `${x.depth}:${x.path}`), ["0:Basic", "0:Allowances", "1:Allowances › HRA"]);
    assert.equal(opsTreeCycle(g, "a", "c"), true);
    assert.equal(opsTreeCycle(g, "c", "b"), false);
  });
  test("variance breaches against the previous month", () => {
    const rules = [{ id: "r1", name: "Net ±10%", metric: "NET", componentCode: null, thresholdPct: 10, thresholdAmount: null, severity: "BLOCK", isActive: true }, { id: "r2", name: "Basic ±1000", metric: "COMPONENT", componentCode: "BASIC", thresholdPct: null, thresholdAmount: 1000, severity: "WARN", isActive: true }];
    const prev = { net: 50000, gross: 60000, deductions: 10000, components: { BASIC: 30000 } };
    assert.deepEqual(opsVarianceBreaches(rules, prev, { net: 52000, gross: 62000, deductions: 10000, components: { BASIC: 30500 } }), []);
    const b = opsVarianceBreaches(rules, prev, { net: 60000, gross: 70000, deductions: 10000, components: { BASIC: 32000 } });
    assert.deepEqual(b.map((x) => x.ruleId), ["r1", "r2"]);
    assert.equal(b[0]!.pct, 20);
    assert.deepEqual(opsVarianceBreaches(rules, null, prev), []);
  });
  test("input validation", () => {
    const row = { employeeId: "e", employee: "E", status: "CONFIRMED", hasBank: true, hasPan: true, ctc: 600000, hasStructure: true, pfEnabled: true, hasUan: true, esiApplies: false, hasEsiIp: false, lopDays: 0, periodDays: 31, net: 40000, onHold: false, exitedBeforePeriod: false, stateCode: "KA" };
    assert.deepEqual(opsValidatePayrollInputs([row], { negativeNetAction: "WARN" }), []);
    const issues = opsValidatePayrollInputs([{ ...row, hasBank: false, hasPan: false, net: -10, lopDays: 40 }], { negativeNetAction: "BLOCK" });
    assert.deepEqual(issues.map((i) => `${i.severity}:${i.code}`).sort(), ["ERROR:LOP_EXCEEDS", "ERROR:NEGATIVE_NET", "ERROR:NO_BANK", "WARNING:NO_PAN"]);
  });
  test("LWF reconciliation and structure statutory checks", () => {
    const r = opsLwfReconcile([{ employeeId: "a", employee: "A", stateCode: "KA", expectedEmployee: 20, expectedEmployer: 40, deductedEmployee: 20, deductedEmployer: 40 }, { employeeId: "b", employee: "B", stateCode: "MH", expectedEmployee: 25, expectedEmployer: 75, deductedEmployee: 0, deductedEmployer: 0 }]);
    assert.deepEqual(r.map((x) => x.status), ["MATCHED", "SHORT"]);
    assert.equal(r[1]!.difference, -100);
    assert.ok(opsStructureStatutoryIssues({ annualCtc: 240000, monthlyBasic: 8000, monthlyGross: 19000, pfEnabled: false, esiEnabled: false, minimumWage: 20000 }).filter((i) => i.severity === "ERROR").length >= 3);
    assert.deepEqual(opsStructureStatutoryIssues({ annualCtc: 1200000, monthlyBasic: 50000, monthlyGross: 95000, pfEnabled: true, esiEnabled: false, minimumWage: 15000 }), []);
  });
});

describe("Workflow wiring", () => {
  test("every ops request type is a workflow entity type", () => {
    for (const k of Object.keys(OPS_WORKFLOW_TYPES)) { assert.ok(isOpsWorkflowType(k)); assert.ok(k in WORKFLOW_ENTITY_TYPES, `${k} is registered`); }
    assert.equal(isOpsWorkflowType("LEAVE"), false);
  });
});
