import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseHhmm, formatHhmm, overtimeRate, overtimeAmount, encashmentFormulaParts, encashmentEstimate,
  encashableDays, compOffCreditFor,
} from "../src/time-math";

describe("Overtime hours and pay", () => {
  test("hh:mm parses to minutes and back", () => {
    assert.equal(parseHhmm("05:00"), 300);
    assert.equal(parseHhmm("1:30"), 90);
    assert.equal(formatHhmm(330), "05:30");
    assert.equal(formatHhmm(0), "00:00");
  });

  test("malformed, zero and over-a-day values are refused", () => {
    for (const bad of ["", "5", "05:60", "abc", "00:00", "24:01", "25:00", null, undefined]) {
      assert.equal(parseHhmm(bad as string), null, String(bad));
    }
    assert.equal(parseHhmm("24:00"), 1440);
  });

  test("the hourly rate is annual basic over 2,920 hours", () => {
    assert.equal(overtimeRate(584000), 200);
    assert.equal(overtimeRate(0), 0);
    assert.equal(overtimeRate(-10), 0);
  });

  test("pay is hours at the rate, to the paisa", () => {
    assert.equal(overtimeAmount(300, 200), 1000);
    assert.equal(overtimeAmount(90, 123.4567), 185.19);
  });
});

describe("Leave encashment", () => {
  test("the formula names the component and divisor", () => {
    assert.deepEqual(encashmentFormulaParts("[BASIC] / 30"), { code: "BASIC", divisor: 30 });
    assert.deepEqual(encashmentFormulaParts("[GROSS]/26"), { code: "GROSS", divisor: 26 });
  });

  test("an unreadable or zero-divisor formula falls back to basic over 30", () => {
    assert.deepEqual(encashmentFormulaParts(null), { code: "BASIC", divisor: 30 });
    assert.deepEqual(encashmentFormulaParts("BASIC*2"), { code: "BASIC", divisor: 30 });
    assert.deepEqual(encashmentFormulaParts("[BASIC] / 0"), { code: "BASIC", divisor: 30 });
  });

  test("the estimate is days at the per-day wage, to the rupee", () => {
    assert.equal(encashmentEstimate(5, 30000, 30), 5000);
    assert.equal(encashmentEstimate(2.5, 25000, 30), 2083);
    assert.equal(encashmentEstimate(0, 30000, 30), 0);
    assert.equal(encashmentEstimate(3, 0, 30), 0);
  });

  test("encashable days are the free balance, capped by the yearly limit, in half days", () => {
    assert.equal(encashableDays({ freeBalance: 12, maxPerYear: 10, encashedThisYear: 0 }), 10);
    assert.equal(encashableDays({ freeBalance: 12, maxPerYear: 10, encashedThisYear: 4 }), 6);
    assert.equal(encashableDays({ freeBalance: 3.75, maxPerYear: null, encashedThisYear: 0 }), 3.5);
    assert.equal(encashableDays({ freeBalance: -2, maxPerYear: 10, encashedThisYear: 0 }), 0);
    assert.equal(encashableDays({ freeBalance: 8, maxPerYear: 10, encashedThisYear: 12 }), 0);
  });
});

describe("Compensatory off credit", () => {
  test("a full day for hours at the full-day threshold, half at the half-day one", () => {
    assert.equal(compOffCreditFor(8, 8, 90, 50), 1);
    assert.equal(compOffCreditFor(7.2, 8, 90, 50), 1);
    assert.equal(compOffCreditFor(5, 8, 90, 50), 0.5);
    assert.equal(compOffCreditFor(3, 8, 90, 50), 0);
    assert.equal(compOffCreditFor(0, 8, 90, 50), 0);
  });
});
