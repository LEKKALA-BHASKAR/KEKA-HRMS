import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hourlyLeaveIssues, hoursToDayValue, portionForDayValue, advanceAllowance, advancePortion, advanceRecovered,
  encashmentWindowIssue, encashableUnderPolicy, compOffCreditFromHours, overtimeToCompOffDays,
  remoteWorkIssues, regularisationIssue, awolKeys, autoClockOutAt, shiftForDate, parseDaySchedule,
  weeklyOffConfigFrom, weekdayRuleOf, parseRosterCsv, weekStartOf, workLogIssues,
  evaluateDay, DEFAULT_RULES, weeklyOffPortion, type ShiftSpec,
} from "../src/index";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Hourly leave", () => {
  const rules = { name: "Permission", hoursPerDay: 8, minHoursPerRequest: 1, maxHoursPerDay: 4, hourIncrementMinutes: 30 };
  test("accepts hours inside the limits and steps", () => {
    assert.deepEqual(hourlyLeaveIssues(rules, 2.5, "10:00"), []);
  });
  test("rejects too few, too many and off-step hours", () => {
    assert.match(hourlyLeaveIssues(rules, 0.5)[0].message, /at least 1/);
    assert.match(hourlyLeaveIssues(rules, 5)[0].message, /At most 4/);
    assert.match(hourlyLeaveIssues(rules, 1.25)[0].message, /steps of 30/);
    assert.match(hourlyLeaveIssues(rules, null)[0].message, /how many hours/);
    assert.match(hourlyLeaveIssues(rules, 2, "9am")[0].message, /HH:MM/);
  });
  test("converts hours to a share of the day", () => {
    assert.equal(hoursToDayValue(4, 8), 0.5);
    assert.equal(hoursToDayValue(2, null), 0.25);
    assert.equal(hoursToDayValue(12, 8), 1);
    assert.equal(portionForDayValue(0.25), "QUARTER");
    assert.equal(portionForDayValue(0.5), "FIRST_HALF");
    assert.equal(portionForDayValue(1), "FULL_DAY");
  });
});

describe("Advance leave", () => {
  test("allowance is the smaller of the cap and accrual still to come", () => {
    assert.equal(advanceAllowance({ allow: true, maxDays: 5, annualQuota: 12, creditedThisYear: 4 }), 5);
    assert.equal(advanceAllowance({ allow: true, maxDays: 5, annualQuota: 12, creditedThisYear: 10 }), 2);
    assert.equal(advanceAllowance({ allow: false, maxDays: 5, annualQuota: 12, creditedThisYear: 0 }), 0);
  });
  test("the advance part is what goes beyond the balance held", () => {
    assert.equal(advancePortion(2, 3, 5), 1);
    assert.equal(advancePortion(5, 3, 5), 0);
    assert.equal(advancePortion(-1, 2, 3), 2);
    assert.equal(advancePortion(0, 4, 3), 3);
  });
  test("accrual recovers a negative balance first", () => {
    assert.equal(advanceRecovered(-2, 1), 1);
    assert.equal(advanceRecovered(-0.5, 1), 0.5);
    assert.equal(advanceRecovered(3, 1), 0);
  });
});

describe("Encashment policy", () => {
  test("window months", () => {
    assert.equal(encashmentWindowIssue([], 5), null);
    assert.equal(encashmentWindowIssue([3, 12], 12), null);
    assert.match(encashmentWindowIssue([3, 12], 5)!, /March, December/);
  });
  test("minimum balance and yearly cap", () => {
    assert.equal(encashableUnderPolicy({ freeBalance: 10, minBalance: 4, maxPerYear: null, encashedThisYear: 0 }), 6);
    assert.equal(encashableUnderPolicy({ freeBalance: 10, minBalance: 4, maxPerYear: 5, encashedThisYear: 2 }), 3);
    assert.equal(encashableUnderPolicy({ freeBalance: 3, minBalance: 4, maxPerYear: null, encashedThisYear: 0 }), 0);
    assert.equal(encashableUnderPolicy({ freeBalance: 5.7, minBalance: null, maxPerYear: null, encashedThisYear: 0 }), 5.5);
  });
});

describe("Comp-off", () => {
  test("minimum hours decide when configured", () => {
    const base = { requiredHours: 8, fullPct: 90, halfPct: 50, halfDayMinHours: 4, fullDayMinHours: 7 };
    assert.equal(compOffCreditFromHours({ ...base, hours: 7.5 }), 1);
    assert.equal(compOffCreditFromHours({ ...base, hours: 5 }), 0.5);
    assert.equal(compOffCreditFromHours({ ...base, hours: 3 }), 0);
  });
  test("otherwise the share of the shift", () => {
    assert.equal(compOffCreditFromHours({ hours: 7.5, requiredHours: 8, fullPct: 90, halfPct: 50 }), 1);
    assert.equal(compOffCreditFromHours({ hours: 4, requiredHours: 8, fullPct: 90, halfPct: 50 }), 0.5);
  });
  test("overtime converts in half days", () => {
    assert.equal(overtimeToCompOffDays(8 * 60, 8), 1);
    assert.equal(overtimeToCompOffDays(10 * 60, 8), 1);
    assert.equal(overtimeToCompOffDays(13 * 60, 8), 1.5);
    assert.equal(overtimeToCompOffDays(3 * 60, 8), 0);
  });
});

describe("Remote work rules", () => {
  const rules = { monthlyLimit: 2, noticeDays: 2, allowedOnHolidays: false, allowedOnWeeklyOffs: false, attachmentRequired: true };
  test("notice, off days, attachment and monthly limit", () => {
    const issues = remoteWorkIssues({
      label: "Work from home", rules, from: d("2026-10-05"), to: d("2026-10-06"), today: d("2026-10-04"),
      days: [{ date: d("2026-10-05"), kind: "WORKING" }, { date: d("2026-10-06"), kind: "WEEKLY_OFF" }],
      usedByMonth: new Map([["2026-10", 2]]), unit: 1, hasAttachment: false,
    });
    assert.equal(issues.length, 4);
    assert.ok(issues.some((i) => /notice/.test(i)));
    assert.ok(issues.some((i) => /weekly off/.test(i)));
    assert.ok(issues.some((i) => /document/.test(i)));
    assert.ok(issues.some((i) => /2 day\(s\) a month/.test(i)));
  });
  test("a request inside every rule passes", () => {
    assert.deepEqual(remoteWorkIssues({
      label: "On duty", rules: { ...rules, attachmentRequired: false }, from: d("2026-10-07"), to: d("2026-10-07"), today: d("2026-10-04"),
      days: [{ date: d("2026-10-07"), kind: "WORKING" }], usedByMonth: new Map([["2026-10", 1.5]]), unit: 0.5, hasAttachment: false,
    }), []);
  });
});

describe("Regularisation limits", () => {
  test("cut-off day of the next month", () => {
    assert.equal(regularisationIssue({ date: d("2026-09-20"), today: d("2026-10-03"), cutoffDay: 3, monthlyLimit: null, usedInMonth: 0 }), null);
    assert.match(regularisationIssue({ date: d("2026-09-20"), today: d("2026-10-04"), cutoffDay: 3, monthlyLimit: null, usedInMonth: 0 })!, /closed/);
  });
  test("monthly limit", () => {
    assert.match(regularisationIssue({ date: d("2026-10-01"), today: d("2026-10-04"), cutoffDay: null, monthlyLimit: 2, usedInMonth: 2 })!, /all 2/);
    assert.equal(regularisationIssue({ date: d("2026-10-01"), today: d("2026-10-04"), cutoffDay: null, monthlyLimit: 2, usedInMonth: 1 }), null);
  });
});

describe("Absent without leave", () => {
  test("a run of no-shows across a weekend", () => {
    const keys = awolKeys([
      { key: "2026-10-01", status: "PRESENT" },
      { key: "2026-10-02", status: "NO_ATTENDANCE" },
      { key: "2026-10-03", status: "WEEKLY_OFF" },
      { key: "2026-10-04", status: "WEEKLY_OFF" },
      { key: "2026-10-05", status: "NO_ATTENDANCE" },
      { key: "2026-10-06", status: "NO_ATTENDANCE" },
      { key: "2026-10-07", status: "PRESENT" },
      { key: "2026-10-08", status: "NO_ATTENDANCE" },
    ], 3);
    assert.deepEqual([...keys].sort(), ["2026-10-02", "2026-10-05", "2026-10-06"]);
  });
});

describe("Auto clock-out and shift timings", () => {
  test("closes a slot past the limit only", () => {
    const inAt = new Date("2026-10-01T04:00:00Z");
    assert.equal(autoClockOutAt(inAt, 600, new Date("2026-10-01T12:00:00Z")), null);
    assert.deepEqual(autoClockOutAt(inAt, 600, new Date("2026-10-01T20:00:00Z")), new Date("2026-10-01T14:00:00Z"));
    assert.equal(autoClockOutAt(inAt, null, new Date("2026-10-05T00:00:00Z")), null);
  });
  test("a weekday's own timings replace the shift's", () => {
    const base: ShiftSpec = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, isFlexible: false };
    const sched = { SAT: { startTime: "09:30", endTime: "13:30", breakMinutes: 0 }, MON: { startTime: "bad", endTime: "x" } };
    assert.deepEqual(Object.keys(parseDaySchedule(sched)), ["SAT"]);
    const sat = shiftForDate(base, sched, d("2026-10-03"));
    assert.equal(sat.endTime, "13:30");
    assert.equal(sat.breakMinutes, 0);
    assert.equal(shiftForDate(base, sched, d("2026-10-05")).endTime, "18:30");
  });
});

describe("Weekly-off patterns", () => {
  test("alternate Saturdays", () => {
    const cfg = weeklyOffConfigFrom({ SUN: { rule: "ALL" }, SAT: { rule: "ALT_2_4" }, FRI: { rule: "CUSTOM", instances: [5], portion: "SECOND_HALF" } });
    assert.equal(weeklyOffPortion(d("2026-10-10"), cfg), "FULL_DAY"); // 2nd Saturday
    assert.equal(weeklyOffPortion(d("2026-10-03"), cfg), null); // 1st Saturday
    assert.equal(weeklyOffPortion(d("2026-10-30"), cfg), "SECOND_HALF"); // 5th Friday
    assert.equal(weekdayRuleOf(cfg, "SAT").rule, "ALT_2_4");
    assert.equal(weekdayRuleOf(cfg, "MON").rule, "WORKING");
  });
});

describe("Roster CSV and work log", () => {
  test("parses rows, skips a header, reports bad dates", () => {
    const r = parseRosterCsv("Employee Number,Date,Shift\nE001,2026-10-05,GEN\nE002,05/10/2026,wo\nE003,2026-02-30,GEN\nE004,2026-10-05");
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[1].date, "2026-10-05");
    assert.equal(r.rows[1].shiftCode, "WO");
    assert.equal(r.errors.length, 2);
  });
  test("week start and hours", () => {
    assert.equal(weekStartOf(d("2026-10-04")).toISOString().slice(0, 10), "2026-09-28");
    assert.equal(weekStartOf(d("2026-10-05")).toISOString().slice(0, 10), "2026-10-05");
    assert.equal(workLogIssues([{ key: "a", hours: 8.25 }]).length, 0);
    assert.equal(workLogIssues([{ key: "a", hours: 25 }, { key: "b", hours: 1.1 }]).length, 2);
  });
});

describe("Gross hours basis", () => {
  test("a day with a long unpunched gap counts on gross hours", () => {
    const shift: ShiftSpec = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, isFlexible: false };
    const ist = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 6, h, m) - 330 * 60_000);
    const logs = [
      { timestamp: ist(9, 30), direction: 0 as const }, { timestamp: ist(12, 0), direction: 1 as const },
      { timestamp: ist(15, 0), direction: 0 as const }, { timestamp: ist(18, 30), direction: 1 as const },
    ];
    const eff = evaluateDay({ date: d("2026-10-06"), kind: "WORKING", shift, rules: DEFAULT_RULES, logs });
    const gross = evaluateDay({ date: d("2026-10-06"), kind: "WORKING", shift, rules: { ...DEFAULT_RULES, hoursBasis: "GROSS" }, logs });
    assert.equal(eff.status, "HALF_DAY");
    assert.equal(gross.status, "PRESENT");
  });
});
