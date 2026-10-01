import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateDay, DEFAULT_RULES, type ShiftSpec } from "../src/attendance";

/**
 * Half-day work from home / on duty: the remote half is attended, the other
 * half is judged on punches exactly like the remainder after a half-day leave.
 */
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const ist = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m) - 330 * 60_000);
};
const shift: ShiftSpec = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, isFlexible: false };
const day = (over: Partial<Parameters<typeof evaluateDay>[0]> = {}) => evaluateDay({
  date: d("2026-10-06"), kind: "WORKING", shift, rules: DEFAULT_RULES, logs: [], ...over,
});
const punches = (date: string, ...times: string[]) =>
  times.map((t, i) => ({ timestamp: ist(date, t), direction: (i % 2) as 0 | 1 }));

describe("Remote work by the half day", () => {
  test("a full-day WFH is attended with no punches", () => {
    const r = day({ remote: "WORK_FROM_HOME" });
    assert.equal(r.status, "WORK_FROM_HOME");
    assert.equal(r.payableValue, 1);
    assert.equal(r.lopValue, 0);
  });

  test("an unspecified portion still covers the whole day", () => {
    assert.equal(day({ remote: "ON_DUTY", remotePortion: "FULL_DAY" }).status, "ON_DUTY");
  });

  test("half-day WFH with the other half worked in the office is a full, present day", () => {
    const r = day({ remote: "WORK_FROM_HOME", remotePortion: "FIRST_HALF", logs: punches("2026-10-06", "14:00", "18:35") });
    assert.equal(r.status, "PRESENT");
    assert.equal(r.payableValue, 1);
    assert.equal(r.lopValue, 0);
    // Arriving at 14:00 after a first-half WFH is on time, not late.
    assert.equal(r.isLate, false);
  });

  test("half-day WFH with no punches for the other half costs that half", () => {
    const r = day({ remote: "WORK_FROM_HOME", remotePortion: "SECOND_HALF" });
    assert.equal(r.status, "HALF_DAY");
    assert.equal(r.lopValue, 0.5);
    assert.equal(r.payableValue, 0.5);
  });

  test("half-day on duty plus half-day leave covers the day", () => {
    const r = day({ remote: "ON_DUTY", remotePortion: "FIRST_HALF", leave: { portion: "SECOND_HALF", isPaid: true } });
    assert.equal(r.status, "ON_DUTY");
    assert.equal(r.lopValue, 0);
  });

  test("a regularised half-remote day with no punches is waived", () => {
    const r = day({ remote: "WORK_FROM_HOME", remotePortion: "FIRST_HALF", regularised: true });
    assert.equal(r.lopValue, 0);
  });
});
