import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkLine, defaultApproved, settleAgainstAdvance } from "../src/expense-math";

const today = new Date("2026-10-01T10:00:00Z");
const rules = { cap: 3000, receiptRequiredAbove: 500, allowFutureDated: false, maxAgeDays: 60 };

describe("Expense lines", () => {
  test("a clean line has no issues", () => {
    assert.deepEqual(checkLine({ amount: 400, expenseDate: new Date("2026-09-28"), hasReceipt: false }, rules, today), []);
  });
  test("future-dated, stale and zero lines are errors", () => {
    assert.equal(checkLine({ amount: 100, expenseDate: new Date("2026-10-05"), hasReceipt: true }, rules, today)[0].level, "error");
    assert.match(checkLine({ amount: 100, expenseDate: new Date("2026-07-01"), hasReceipt: true }, rules, today)[0].message, /older than 60/);
    assert.match(checkLine({ amount: 0, expenseDate: new Date("2026-09-28"), hasReceipt: true }, rules, today)[0].message, /more than zero/);
  });
  test("a receipt is required above the threshold", () => {
    const i = checkLine({ amount: 900, expenseDate: new Date("2026-09-28"), hasReceipt: false }, rules, today);
    assert.equal(i.length, 1);
    assert.equal(i[0].level, "error");
  });
  test("over the cap is a warning, and approval defaults to the cap", () => {
    const i = checkLine({ amount: 4200, expenseDate: new Date("2026-09-28"), hasReceipt: true }, rules, today);
    assert.equal(i[0].level, "warning");
    assert.equal(defaultApproved(4200, 3000), 3000);
    assert.equal(defaultApproved(4200, null), 4200);
  });
});

describe("Advance settlement", () => {
  test("a claim larger than the advance clears it and pays the rest", () => {
    assert.deepEqual(settleAgainstAdvance(12000, 10000), { settles: 10000, payable: 2000, stillOutstanding: 0 });
  });
  test("a smaller claim pays nothing and leaves the advance part-open", () => {
    assert.deepEqual(settleAgainstAdvance(6000, 10000), { settles: 6000, payable: 0, stillOutstanding: 4000 });
  });
  test("with no advance, everything is payable", () => {
    assert.deepEqual(settleAgainstAdvance(2500.5, 0), { settles: 0, payable: 2500.5, stillOutstanding: 0 });
  });
});
