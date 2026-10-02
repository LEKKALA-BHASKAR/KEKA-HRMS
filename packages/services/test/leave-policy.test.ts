import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseApprovalChain, effectiveChain, resolveApprovalSteps, canActOnStep, approveStep, autoApproveSteps, autoApproveDue,
  usageLimitIssues, optionalHolidayPickIssue, manualDayValues, parseLopCsv, shiftAllowanceLines, allowanceDayValue,
  roundOvertimeMinutes, overtimePay, type LeaveSpan,
} from "../src/leave-policy-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const span = (from: string, to: string, value = 1): LeaveSpan => {
  const days = [];
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += 86_400_000) days.push({ key: new Date(t).toISOString().slice(0, 10), value });
  return { from: d(from), to: d(to), days };
};
const people = { employeeId: "e", managerId: "m", skipManagerId: "s", departmentHeadId: "h" };

describe("Approval chain configuration", () => {
  test("no chain, an empty one, or rubbish means the single-decision default", () => {
    assert.equal(parseApprovalChain(null), null);
    assert.equal(parseApprovalChain({ levels: [] }), null);
    assert.equal(parseApprovalChain({ levels: ["CEO"] }), null);
    assert.equal(parseApprovalChain([1, 2]), null);
  });

  test("levels are kept in order, unknown roles dropped, skipSamePerson defaults on", () => {
    const c = parseApprovalChain({ levels: ["REPORTING_MANAGER", "BOSS", "HR"], autoApproveAfterDays: "3" });
    assert.deepEqual(c, { levels: ["REPORTING_MANAGER", "HR"], skipSamePerson: true, autoApproveAfterDays: 3 });
  });

  test("auto-approve alone wraps today's single decision", () => {
    assert.deepEqual(parseApprovalChain({ autoApproveAfterDays: 2 }), { levels: ["ANY"], skipSamePerson: true, autoApproveAfterDays: 2 });
  });

  test("a leave type's chain overrides its plan's", () => {
    assert.deepEqual(effectiveChain({ levels: ["HR"] }, { levels: ["REPORTING_MANAGER"] })?.levels, ["HR"]);
    assert.deepEqual(effectiveChain(null, { levels: ["REPORTING_MANAGER"] })?.levels, ["REPORTING_MANAGER"]);
    assert.equal(effectiveChain(null, null), null);
  });
});

describe("Resolving a chain for an employee", () => {
  const cfg = (levels: string[], skipSamePerson = true) => parseApprovalChain({ levels, skipSamePerson })!;

  test("manager then HR resolves to the manager, then the HR role", () => {
    const steps = resolveApprovalSteps(cfg(["REPORTING_MANAGER", "HR"]), people);
    assert.deepEqual(steps.map((s) => [s.role, s.approverId, s.status]), [["REPORTING_MANAGER", "m", "PENDING"], ["HR", null, "PENDING"]]);
  });

  test("an empty seat, or the employee in it, drops the level", () => {
    const steps = resolveApprovalSteps(cfg(["REPORTING_MANAGER", "DEPARTMENT_HEAD", "HR"]), { ...people, managerId: null, departmentHeadId: "e" });
    assert.deepEqual(steps.map((s) => s.role), ["HR"]);
  });

  test("the same person on consecutive levels is asked once", () => {
    const same = { ...people, departmentHeadId: "m" };
    assert.equal(resolveApprovalSteps(cfg(["REPORTING_MANAGER", "DEPARTMENT_HEAD"]), same).length, 1);
    assert.equal(resolveApprovalSteps(cfg(["REPORTING_MANAGER", "DEPARTMENT_HEAD"], false), same).length, 2);
  });

  test("a chain that resolves to nobody still has one approver", () => {
    const steps = resolveApprovalSteps(cfg(["REPORTING_MANAGER"]), { ...people, managerId: null });
    assert.deepEqual(steps.map((s) => s.role), ["ANY"]);
  });
});

describe("Deciding along a chain", () => {
  const steps = resolveApprovalSteps(parseApprovalChain({ levels: ["REPORTING_MANAGER", "HR"] })!, people);
  const manager = { employeeId: "m", isHr: false, canApprove: true };
  const hr = { employeeId: "hr1", isHr: true, canApprove: true };
  const other = { employeeId: "x", isHr: false, canApprove: true };

  test("only the named manager (or HR) acts at the manager level; only HR at the HR level", () => {
    assert.equal(canActOnStep(steps[0], manager), true);
    assert.equal(canActOnStep(steps[0], other), false);
    assert.equal(canActOnStep(steps[0], hr), true);
    assert.equal(canActOnStep(steps[1], manager), false);
    assert.equal(canActOnStep(steps[1], hr), true);
  });

  test("the manager's approval moves the request to HR", () => {
    const r = approveStep(steps, 0, manager, d("2026-10-02"), null, true);
    assert.equal(r.nextLevel, 1);
    assert.equal(r.steps[0].status, "APPROVED");
    assert.equal(r.steps[0].by, "m");
    assert.equal(r.steps[1].status, "PENDING");
  });

  test("HR approving at the manager level also clears its own level when skipping the same person", () => {
    const r = approveStep(steps, 0, hr, d("2026-10-02"), null, true);
    assert.equal(r.nextLevel, null);
    assert.equal(r.steps[1].status, "SKIPPED");
    assert.equal(approveStep(steps, 0, hr, d("2026-10-02"), null, false).nextLevel, 1);
  });

  test("the last approval completes the chain", () => {
    const r1 = approveStep(steps, 0, manager, d("2026-10-02"), null, true);
    const r2 = approveStep(r1.steps, 1, hr, d("2026-10-03"), "ok", true);
    assert.equal(r2.nextLevel, null);
    assert.equal(r2.steps[1].note, "ok");
  });

  test("auto-approval clears what is left, after the window and not before", () => {
    const auto = autoApproveSteps(approveStep(steps, 0, manager, d("2026-10-02"), null, true).steps, 1, d("2026-10-05"));
    assert.deepEqual(auto.map((s) => s.status), ["APPROVED", "AUTO"]);
    assert.equal(autoApproveDue(d("2026-10-01"), 3, d("2026-10-03")), false);
    assert.equal(autoApproveDue(d("2026-10-01"), 3, d("2026-10-04")), true);
    assert.equal(autoApproveDue(d("2026-10-01"), null, d("2027-01-01")), false);
  });
});

describe("Leave usage limits", () => {
  const limits = { name: "Casual Leave", maxDaysPerMonth: null, minGapDays: null, maxConsecutiveDays: null };

  test("no limits, no issues", () => {
    assert.deepEqual(usageLimitIssues({ limits, request: span("2026-10-05", "2026-10-09"), others: [span("2026-10-12", "2026-10-12")] }), []);
  });

  test("days per month count other requests in the same month", () => {
    const issues = usageLimitIssues({
      limits: { ...limits, maxDaysPerMonth: 3 }, request: span("2026-10-20", "2026-10-21"), others: [span("2026-10-05", "2026-10-06")],
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /At most 3 day\(s\) of Casual Leave can be taken in a month; October 2026 would have 4 \(2 already taken or pending\)/);
    assert.deepEqual(usageLimitIssues({ limits: { ...limits, maxDaysPerMonth: 3 }, request: span("2026-10-20", "2026-10-21"), others: [span("2026-09-05", "2026-09-06")] }), []);
  });

  test("a request spanning two months is checked per month", () => {
    const issues = usageLimitIssues({ limits: { ...limits, maxDaysPerMonth: 2 }, request: span("2026-10-30", "2026-11-03"), others: [] });
    assert.match(issues[0].message, /November 2026 would have 3/);
  });

  test("the minimum gap counts clear days either side", () => {
    const l = { ...limits, minGapDays: 7 };
    const before = usageLimitIssues({ limits: l, request: span("2026-10-12", "2026-10-12"), others: [span("2026-10-06", "2026-10-07")] });
    assert.match(before[0].message, /gap of at least 7 day\(s\) between two Casual Leave requests; this is 4 day\(s\) from your Casual Leave on 2026-10-06 to 2026-10-07/);
    const after = usageLimitIssues({ limits: l, request: span("2026-10-12", "2026-10-12"), others: [span("2026-10-15", "2026-10-15")] });
    assert.match(after[0].message, /this is 2 day\(s\)/);
    assert.deepEqual(usageLimitIssues({ limits: l, request: span("2026-10-12", "2026-10-12"), others: [span("2026-10-20", "2026-10-20")] }), []);
  });

  test("an adjoining request across a weekend makes the consecutive run too long", () => {
    const weekend = (k: string) => [0, 6].includes(new Date(`${k}T00:00:00Z`).getUTCDay());
    // Fri 9 Oct + Mon 12–Tue 13 Oct, weekend between.
    const issues = usageLimitIssues({
      limits: { ...limits, maxConsecutiveDays: 2 }, request: span("2026-10-12", "2026-10-13"), others: [span("2026-10-09", "2026-10-09")], isOffDay: weekend,
    });
    assert.match(issues[0].message, /Together with your adjoining Casual Leave \(2026-10-09\) this makes 3 consecutive day\(s\); at most 2/);
    // A working day in between breaks the run.
    assert.deepEqual(usageLimitIssues({
      limits: { ...limits, maxConsecutiveDays: 2 }, request: span("2026-10-14", "2026-10-15"), others: [span("2026-10-12", "2026-10-12")], isOffDay: weekend,
    }), []);
  });
});

describe("Optional holidays", () => {
  const base = { isOptional: true, quota: 2, pickedThisCalendar: 0, alreadyPicked: false, date: d("2026-11-10"), today: d("2026-10-02"), hasLeaveThatDay: false };
  test("a future optional holiday within the quota can be picked", () => {
    assert.equal(optionalHolidayPickIssue(base), null);
  });
  test("refusals say why", () => {
    assert.match(optionalHolidayPickIssue({ ...base, isOptional: false })!, /public holiday/);
    assert.match(optionalHolidayPickIssue({ ...base, pickedThisCalendar: 2 })!, /already picked 2 of 2/);
    assert.match(optionalHolidayPickIssue({ ...base, date: d("2026-09-01") })!, /still to come/);
    assert.match(optionalHolidayPickIssue({ ...base, quota: 0 })!, /does not allow/);
    assert.match(optionalHolidayPickIssue({ ...base, alreadyPicked: true })!, /already picked this/);
    assert.match(optionalHolidayPickIssue({ ...base, hasLeaveThatDay: true })!, /leave on that day/);
  });
});

describe("Admin day override", () => {
  test("a pinned status pays and docks as the status says", () => {
    assert.deepEqual(manualDayValues("PRESENT"), { payableValue: 1, lopValue: 0 });
    assert.deepEqual(manualDayValues("HALF_DAY"), { payableValue: 0.5, lopValue: 0.5 });
    assert.deepEqual(manualDayValues("ABSENT"), { payableValue: 0, lopValue: 1 });
    assert.deepEqual(manualDayValues("NO_ATTENDANCE", false), { payableValue: 1, lopValue: 0 });
    assert.deepEqual(manualDayValues("HOLIDAY"), { payableValue: 1, lopValue: 0 });
  });
});

describe("LOP import file", () => {
  test("reads employee, month and days in any column order", () => {
    const r = parseLopCsv("Month,Employee Number,LOP Days,Note\n2026-10,ACME001,2,late joiner\n10/2026,acme002,0.5,\n");
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.employeeNumber, x.year, x.month, x.days, x.note]), [["ACME001", 2026, 10, 2, "late joiner"], ["acme002", 2026, 10, 0.5, null]]);
  });
  test("separate month and year columns work too", () => {
    const r = parseLopCsv("employee_code,month,year,days\nA1,9,2026,1\n");
    assert.deepEqual([r.rows[0].year, r.rows[0].month], [2026, 9]);
  });
  test("bad rows are reported by line; missing columns stop the import", () => {
    const r = parseLopCsv("employee number,month,lop days\nA1,2026-13,1\nA2,2026-10,40\n,2026-10,1\nA3,2026-10,1.255\nA4,2026-10,1\na4,2026-10,2\n");
    assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4, 5, 7]);
    assert.match(r.errors[4].message, /already has a row for 2026-10 on line 6/);
    assert.equal(r.rows.length, 1);
    assert.match(parseLopCsv("name,days\nX,1").errors[0].message, /Missing column\(s\): employee number, month/);
  });
});

describe("Shift allowance", () => {
  const shifts = new Map([
    ["night", { code: "NIGHT", allowanceCode: "NSA", perDay: 250 }],
    ["gen", { code: "GEN", allowanceCode: null, perDay: null }],
  ]);
  test("worked days on an allowance shift are paid per day; off days and other shifts are not", () => {
    const lines = shiftAllowanceLines([
      { employeeId: "a", shiftId: "night", status: "PRESENT", payableValue: 1 },
      { employeeId: "a", shiftId: "night", status: "HALF_DAY", payableValue: 0.5 },
      { employeeId: "a", shiftId: "night", status: "WEEKLY_OFF", payableValue: 1 },
      { employeeId: "a", shiftId: "night", status: "ON_LEAVE", payableValue: 1 },
      { employeeId: "a", shiftId: "gen", status: "PRESENT", payableValue: 1 },
      { employeeId: "b", shiftId: "night", status: "WORK_FROM_HOME", payableValue: 1 },
    ], shifts);
    assert.deepEqual(lines, [
      { employeeId: "a", shiftCode: "NIGHT", allowanceCode: "NSA", days: 1.5, amount: 375 },
      { employeeId: "b", shiftCode: "NIGHT", allowanceCode: "NSA", days: 1, amount: 250 },
    ]);
    assert.equal(allowanceDayValue("ABSENT", 0), 0);
  });
});

describe("Overtime policy", () => {
  test("minutes round down to the block; pay applies the multiplier", () => {
    assert.equal(roundOvertimeMinutes(95, 30), 90);
    assert.equal(roundOvertimeMinutes(95, 0), 95);
    assert.equal(roundOvertimeMinutes(20, 30), 0);
    assert.equal(overtimePay(90, 200, 2), 600);
    assert.equal(overtimePay(90, 200, 0), 300);
  });
});
