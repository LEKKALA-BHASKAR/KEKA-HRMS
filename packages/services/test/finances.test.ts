import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  previousIncomeApplies, claimEntitlement, claimRemaining, itrCalendar, firstOpenPayrollMonth, payrollMonths,
  compareMonths, bonusStatus, interestLabel, loanEligibilityLines, scheduleTotals, marginalSaving,
} from "../src/finances-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Previous-employer income", () => {
  test("counts only in the financial year the employee joined", () => {
    const joined = d("2026-06-15");
    assert.equal(previousIncomeApplies(joined, 2026), true);
    assert.equal(previousIncomeApplies(joined, 2027), false, "the next year is a new year with this employer only");
    assert.equal(previousIncomeApplies(joined, 2025), false, "nothing before joining");
  });
  test("a January joiner belongs to the FY that began the April before", () => {
    assert.equal(previousIncomeApplies(d("2027-01-10"), 2026), true);
    assert.equal(previousIncomeApplies(d("2027-01-10"), 2027), false);
  });
  test("joining on the first day of the FY still counts for that FY", () => {
    assert.equal(previousIncomeApplies(d("2026-04-01"), 2026), true);
    assert.equal(previousIncomeApplies(d("2026-03-31"), 2026), false);
  });
  test("respects a non-April financial year", () => {
    assert.equal(previousIncomeApplies(d("2026-02-01"), 2026, 1), true);
    assert.equal(previousIncomeApplies(d("2026-02-01"), 2025, 4), true);
  });
});

describe("Flexible-benefit claim entitlement", () => {
  test("a full-year employee accrues a twelfth a month", () => {
    const e = claimEntitlement({ annualLimit: 28800, joinedOn: d("2022-08-01"), fy: 2026, today: d("2026-10-01") });
    assert.equal(e.monthly, 2400);
    assert.equal(e.monthsInFy, 12);
    assert.equal(e.annual, 28800);
    assert.equal(e.monthsAccrued, 7, "April to October inclusive");
    assert.equal(e.accrued, 16800);
  });
  test("a mid-year joiner accrues from the joining month", () => {
    const e = claimEntitlement({ annualLimit: 24000, joinedOn: d("2026-06-15"), fy: 2026, today: d("2026-10-01") });
    assert.equal(e.monthsInFy, 10, "June to March");
    assert.equal(e.annual, 20000);
    assert.equal(e.accrued, 10000, "June to October");
  });
  test("a leaver stops accruing after the last working month", () => {
    const e = claimEntitlement({ annualLimit: 12000, joinedOn: d("2020-01-01"), lastWorkingDay: d("2026-07-10"), fy: 2026, today: d("2026-12-01") });
    assert.equal(e.monthsInFy, 4);
    assert.equal(e.accrued, 4000);
  });
  test("a past year is fully accrued and a future one not at all", () => {
    assert.equal(claimEntitlement({ annualLimit: 12000, joinedOn: d("2020-01-01"), fy: 2025, today: d("2026-10-01") }).accrued, 12000);
    assert.equal(claimEntitlement({ annualLimit: 12000, joinedOn: d("2020-01-01"), fy: 2027, today: d("2026-10-01") }).accrued, 0);
  });
  test("what remains never goes below zero", () => {
    assert.equal(claimRemaining(16800, 6000, 4800), 6000);
    assert.equal(claimRemaining(1000, 900, 500), 0);
  });
});

describe("ITR calendar", () => {
  test("in October the due date for the last FY has passed and the belated window is open", () => {
    const c = itrCalendar(d("2026-10-01"));
    assert.equal(c.fy, 2025);
    assert.equal(c.label, "FY 2025 - 2026 (AY 2026 - 2027)");
    assert.equal(c.due.toISOString().slice(0, 10), "2026-07-31");
    assert.equal(c.belatedTill.toISOString().slice(0, 10), "2026-12-31");
    assert.equal(c.passed, true);
  });
  test("in May the due date is still ahead", () => {
    const c = itrCalendar(d("2026-05-10"));
    assert.equal(c.fy, 2025);
    assert.equal(c.passed, false);
    assert.equal(itrCalendar(d("2026-07-31")).passed, false, "the due date itself is still on time");
  });
});

describe("Payroll months for a loan request", () => {
  test("the first open month is after the last closed run, never before today", () => {
    assert.deepEqual(firstOpenPayrollMonth(d("2026-10-01"), [{ year: 2026, month: 8 }]), { year: 2026, month: 10 });
    assert.deepEqual(firstOpenPayrollMonth(d("2026-10-01"), [{ year: 2026, month: 10 }]), { year: 2026, month: 11 });
    assert.deepEqual(firstOpenPayrollMonth(d("2026-12-20"), [{ year: 2026, month: 12 }]), { year: 2027, month: 1 });
  });
  test("twelve consecutive months roll over the year", () => {
    const ms = payrollMonths({ year: 2026, month: 11 }, 12);
    assert.equal(ms.length, 12);
    assert.deepEqual(ms[0], { year: 2026, month: 11 });
    assert.deepEqual(ms[2], { year: 2027, month: 1 });
    assert.deepEqual(ms[11], { year: 2027, month: 10 });
    assert.ok(compareMonths({ year: 2027, month: 1 }, { year: 2026, month: 12 }) > 0);
  });
});

describe("Labels", () => {
  test("bonus status follows the pay action", () => {
    assert.equal(bonusStatus({ isProcessed: true, payAction: "PAY" }), "Paid");
    assert.equal(bonusStatus({ isProcessed: false, payAction: "PAY" }), "Pending");
    assert.equal(bonusStatus({ isProcessed: false, payAction: "ON_HOLD" }), "On Hold");
    assert.equal(bonusStatus({ isProcessed: false, payAction: "VOID" }), "Void");
  });
  test("interest shows as Keka shows it", () => {
    assert.deepEqual(interestLabel("FLAT", 8), { rate: "8 %", kind: "Flat Rate" });
    assert.deepEqual(interestLabel("REDUCING", 9.5), { rate: "9.50 %", kind: "Reducing Balance" });
    assert.deepEqual(interestLabel("NONE", 0), { rate: "0 %", kind: "Flat Rate" });
  });
  test("eligibility sentences come from the policy", () => {
    const lines = loanEligibilityLines({ minDaysFromJoining: 180, minAnnualSalary: 500000, maxAnnualSalary: null, blockOnNoticePeriod: true, requireProbationComplete: true, approvalRequired: true });
    assert.deepEqual(lines, [
      "Employees are eligible for loans after 180 days after joining.",
      "Annual salary of at least 500000.",
      "Employees in notice period are not eligible for loan.",
      "Employees on probation are not eligible for loan.",
      "Approval is required.",
    ]);
  });
});

describe("Loan totals and tax saving", () => {
  test("a schedule splits into paid and left, principal and interest", () => {
    const t = scheduleTotals([
      { principalPart: 5000, interestPart: 150, totalAmount: 5150, status: "DEDUCTED" },
      { principalPart: 5000, interestPart: 150, totalAmount: 5150, status: "SCHEDULED" },
    ]);
    assert.deepEqual(t, { total: 10300, paid: 5150, left: 5150, principal: 10000, interest: 300 });
  });
  test("a deduction saves the marginal rate plus cess", () => {
    assert.equal(marginalSaving(50000, 30), 15600);
    assert.equal(marginalSaving(0, 30), 0);
  });
});
