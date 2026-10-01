import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { yearEndSplit, expiredCarryLapse, nextLeaveYear } from "../src/leave-year-end-math";

const open = { carryMax: null, payMax: null, payEnabled: true };

describe("Leave year-end split", () => {
  test("reset lapses everything", () => {
    assert.deepEqual(yearEndSplit(7.5, "RESET", open), { carry: 0, pay: 0, lapse: 7.5 });
  });
  test("carry forward up to the cap, the rest lapses", () => {
    assert.deepEqual(yearEndSplit(18, "CARRY_FORWARD_ALL", { ...open, carryMax: 15 }), { carry: 15, pay: 0, lapse: 3 });
    assert.deepEqual(yearEndSplit(4, "CARRY_FORWARD_ALL", { ...open, carryMax: 15 }), { carry: 4, pay: 0, lapse: 0 });
  });
  test("pay then carry, and carry then pay, take their caps in order", () => {
    assert.deepEqual(yearEndSplit(20, "PAY_THEN_CARRY_FORWARD", { carryMax: 10, payMax: 5, payEnabled: true }), { carry: 10, pay: 5, lapse: 5 });
    assert.deepEqual(yearEndSplit(20, "CARRY_FORWARD_THEN_PAY", { carryMax: 10, payMax: 5, payEnabled: true }), { carry: 10, pay: 5, lapse: 5 });
    assert.deepEqual(yearEndSplit(12, "CARRY_FORWARD_THEN_PAY", { carryMax: 10, payMax: 5, payEnabled: true }), { carry: 10, pay: 2, lapse: 0 });
  });
  test("without encashment the paid share falls through", () => {
    assert.deepEqual(yearEndSplit(8, "PAY_ALL", { ...open, payEnabled: false }), { carry: 0, pay: 0, lapse: 8 });
    assert.deepEqual(yearEndSplit(8, "PAY_THEN_CARRY_FORWARD", { carryMax: 6, payMax: null, payEnabled: false }), { carry: 6, pay: 0, lapse: 2 });
  });
  test("a deficit is carried, never written off or paid", () => {
    assert.deepEqual(yearEndSplit(-2, "PAY_ALL", open), { carry: -2, pay: 0, lapse: 0 });
  });
  test("half days survive rounding", () => {
    assert.deepEqual(yearEndSplit(10.5, "CARRY_FORWARD_ALL", { ...open, carryMax: 7.5 }), { carry: 7.5, pay: 0, lapse: 3 });
  });
});

describe("Expiring carried-forward days", () => {
  test("days already used come out of the carried credit first", () => {
    assert.equal(expiredCarryLapse(10, 4, 20), 6);
    assert.equal(expiredCarryLapse(10, 12, 20), 0);
  });
  test("never more than the balance left", () => {
    assert.equal(expiredCarryLapse(10, 0, 3), 3);
  });
  test("the next leave year starts a year on", () => {
    assert.equal(nextLeaveYear(new Date(Date.UTC(2025, 3, 1))).toISOString().slice(0, 10), "2026-04-01");
  });
});
