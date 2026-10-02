import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkTimesheet } from "../src/projects-math";
import {
  DEFAULT_TIMESHEET_POLICY as D, roundHours, policyIssues, checkPolicy, firstApprover, nextApprover, autoApproves, chaseDue, daysAfterWeek,
  onIncrement, incrementLabel, type TimesheetPolicy,
} from "../src/timesheet-policy-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const wk = d("2026-09-28"), today = d("2026-10-01");
const P = (patch: Partial<TimesheetPolicy>): TimesheetPolicy => ({ ...D, ...patch });

describe("Default policy is the old hardcoded rules", () => {
  test("quarter hours and 24 hours a day, with the same messages", () => {
    const issues = checkTimesheet([
      { projectId: "p", date: d("2026-09-29"), hours: 20 }, { projectId: "q", date: d("2026-09-29"), hours: 6 },
      { projectId: "p", date: d("2026-09-30"), hours: 1.1 },
    ], wk, today);
    assert.ok(issues.includes("2026-09-29 has 26 hours — a day has 24."));
    assert.ok(issues.includes("1.1 h — log in quarter hours."));
    assert.equal(issues.length, 2);
  });
  test("defaults never round, never auto-approve and never chase", () => {
    assert.equal(roundHours(1.1, D), 1.1);
    assert.equal(autoApproves(D, 10, [true]), false);
    assert.deepEqual(chaseDue(D, d("2026-09-14"), today), { remind: false, escalate: false });
    assert.equal(firstApprover(D.approvalChain), "EITHER");
    assert.deepEqual(checkPolicy(D), []);
  });
  test("weekly limits are off by default, even on submission", () => {
    assert.deepEqual(checkTimesheet([{ projectId: "p", date: d("2026-09-28"), hours: 0.25 }], wk, today, D, { submit: true }), []);
  });
});

describe("Increments and rounding", () => {
  test("increment checks work on minutes, not floating hours", () => {
    assert.ok(onIncrement(1.1, 6));
    assert.ok(!onIncrement(1.1, 15));
    assert.ok(onIncrement(0.5, 30) && !onIncrement(0.75, 30));
    assert.equal(incrementLabel(30), "half hours");
    assert.equal(incrementLabel(10), "steps of 10 minutes");
  });
  test("nearest and up", () => {
    assert.equal(roundHours(1.1, P({ rounding: "NEAREST" })), 1);
    assert.equal(roundHours(1.15, P({ rounding: "NEAREST" })), 1.25);
    assert.equal(roundHours(1.01, P({ rounding: "UP" })), 1.25);
    assert.equal(roundHours(1.25, P({ rounding: "UP" })), 1.25);
    assert.equal(roundHours(7.4, P({ rounding: "NEAREST", incrementMinutes: 30 })), 7.5);
  });
  test("a coarser increment is enforced with its own wording", () => {
    assert.deepEqual(policyIssues([{ date: wk, hours: 0.75 }], P({ incrementMinutes: 30 })), ["0.75 h — log in half hours."]);
  });
});

describe("Day and week limits", () => {
  const p = P({ maxHoursPerDay: 10, minHoursPerDay: 4, maxHoursPerWeek: 45, minHoursPerWeek: 20 });
  test("daily cap and the floor on days with time", () => {
    const issues = policyIssues([{ date: d("2026-09-28"), hours: 11 }, { date: d("2026-09-29"), hours: 2 }], p);
    assert.ok(issues.some((i) => /limit is 10 a day/.test(i)));
    assert.ok(issues.some((i) => /at least 4/.test(i)));
  });
  test("weekly floor and cap only on submission", () => {
    const light = [{ date: d("2026-09-28"), hours: 8 }];
    assert.deepEqual(policyIssues(light, p), []);
    assert.ok(policyIssues(light, p, { submit: true }).some((i) => /under the 20 hours/.test(i)));
    const heavy = Array.from({ length: 5 }, (_, i) => ({ date: new Date(wk.getTime() + i * 86_400_000), hours: 10 }));
    assert.ok(policyIssues(heavy, p, { submit: true }).some((i) => /over the 45-hour/.test(i)));
  });
  test("a policy that contradicts itself is refused", () => {
    assert.ok(checkPolicy(P({ minHoursPerDay: 12, maxHoursPerDay: 10 })).length > 0);
    assert.ok(checkPolicy(P({ minHoursPerWeek: 50, maxHoursPerWeek: 40 })).length > 0);
    assert.ok(checkPolicy(P({ incrementMinutes: 7 })).length > 0);
    assert.ok(checkPolicy(P({ remindersEnabled: true, escalationEnabled: true, reminderAfterDays: 3, escalateAfterDays: 1 })).length > 0);
  });
});

describe("Approval chain and auto-approval", () => {
  test("two levels: line manager, then project manager, then done", () => {
    assert.equal(firstApprover("LINE_THEN_PROJECT"), "LINE_MANAGER");
    assert.equal(nextApprover("LINE_THEN_PROJECT", "LINE_MANAGER", 0), "PROJECT_MANAGER");
    assert.equal(nextApprover("LINE_THEN_PROJECT", "PROJECT_MANAGER", 1), null);
    assert.equal(nextApprover("EITHER", "EITHER", 0), null);
    assert.equal(firstApprover("PROJECT_MANAGER"), "PROJECT_MANAGER");
  });
  test("auto-approve within the ceiling, or when no project needs approval", () => {
    assert.equal(autoApproves(P({ autoApprove: true, autoApproveMaxHours: 40 }), 40, [true]), true);
    assert.equal(autoApproves(P({ autoApprove: true, autoApproveMaxHours: 40 }), 41, [true]), false);
    assert.equal(autoApproves(D, 60, [false, false]), true);
    assert.equal(autoApproves(D, 60, [false, true]), false);
  });
});

describe("Reminders", () => {
  test("days are counted from the Sunday the week ends", () => {
    assert.equal(daysAfterWeek(d("2026-09-21"), d("2026-09-27")), 0);
    assert.equal(daysAfterWeek(d("2026-09-21"), d("2026-09-28")), 1);
  });
  test("remind, then escalate", () => {
    const p = P({ remindersEnabled: true, reminderAfterDays: 1, escalationEnabled: true, escalateAfterDays: 3 });
    assert.deepEqual(chaseDue(p, d("2026-09-21"), d("2026-09-27")), { remind: false, escalate: false });
    assert.deepEqual(chaseDue(p, d("2026-09-21"), d("2026-09-28")), { remind: true, escalate: false });
    assert.deepEqual(chaseDue(p, d("2026-09-21"), d("2026-09-30")), { remind: true, escalate: true });
  });
});
