import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLoanSchedule, concessionalLoanPerquisite } from "../src/loans";

const sum = (xs: Array<{ toNumber(): number }>) => Math.round(xs.reduce((s, x) => s + x.toNumber(), 0) * 100) / 100;

describe("Loan schedules", () => {
  test("an interest-free loan repays exactly the principal, rounding in the last EMI", () => {
    const s = buildLoanSchedule({ principal: 100000, installments: 12, interestType: "NONE", startYear: 2026, startMonth: 10 });
    assert.equal(s.installments.length, 12);
    assert.equal(sum(s.installments.map((i) => i.principalPart)), 100000);
    assert.equal(s.installments[0].principalPart.toNumber(), 8333);
    assert.equal(s.installments[11].principalPart.toNumber(), 8337);
    assert.equal(s.installments[11].balanceAfter.toNumber(), 0);
    assert.equal(s.totalInterest.toNumber(), 0);
  });

  test("instalments run across the year boundary", () => {
    const s = buildLoanSchedule({ principal: 30000, installments: 4, interestType: "NONE", startYear: 2026, startMonth: 11 });
    assert.deepEqual(s.installments.map((i) => `${i.year}-${i.month}`), ["2026-11", "2026-12", "2027-1", "2027-2"]);
  });

  test("flat interest is charged on the original principal", () => {
    // ₹1,20,000 at 10% flat for 12 months = ₹12,000 interest.
    const s = buildLoanSchedule({ principal: 120000, installments: 12, interestType: "FLAT", annualRate: 10, startYear: 2026, startMonth: 4 });
    assert.equal(s.totalInterest.toNumber(), 12000);
    assert.equal(s.emi.toNumber(), 11000);
    assert.equal(sum(s.installments.map((i) => i.principalPart)), 120000);
  });

  test("reducing balance matches the standard EMI formula", () => {
    // ₹5,00,000 at 9% for 24 months: EMI ≈ ₹22,842.
    const s = buildLoanSchedule({ principal: 500000, installments: 24, interestType: "REDUCING", annualRate: 9, startYear: 2026, startMonth: 4 });
    assert.equal(s.emi.toNumber(), 22842);
    assert.equal(s.installments[0].interestPart.toNumber(), 3750);
    assert.equal(sum(s.installments.map((i) => i.principalPart)), 500000);
    assert.equal(s.installments[23].balanceAfter.toNumber(), 0);
    // Interest falls as the balance does.
    assert.ok(s.installments[12].interestPart.lt(s.installments[1].interestPart));
  });

  test("a zero rate is interest-free whatever the type says", () => {
    const s = buildLoanSchedule({ principal: 10000, installments: 5, interestType: "REDUCING", annualRate: 0, startYear: 2026, startMonth: 1 });
    assert.equal(s.totalInterest.toNumber(), 0);
    assert.equal(s.emi.toNumber(), 2000);
  });

  test("nonsense inputs are refused", () => {
    assert.throws(() => buildLoanSchedule({ principal: 0, installments: 12, interestType: "NONE", startYear: 2026, startMonth: 1 }));
    assert.throws(() => buildLoanSchedule({ principal: 1000, installments: 0, interestType: "NONE", startYear: 2026, startMonth: 1 }));
  });
});

describe("Concessional loan perquisite", () => {
  test("interest-free loan above ₹20,000 is taxed at the benchmark", () => {
    // ₹2,40,000 outstanding at a 9% benchmark, nothing charged: ₹1,800 a month.
    const r = concessionalLoanPerquisite({ outstanding: 240000, benchmarkRate: 9, chargedRate: 0, aggregateOutstanding: 240000 });
    assert.equal(r.monthly.toNumber(), 1800);
  });

  test("small and medical loans are exempt", () => {
    assert.equal(concessionalLoanPerquisite({ outstanding: 18000, benchmarkRate: 9, chargedRate: 0, aggregateOutstanding: 18000 }).monthly.toNumber(), 0);
    assert.equal(concessionalLoanPerquisite({ outstanding: 200000, benchmarkRate: 9, chargedRate: 0, aggregateOutstanding: 200000, isMedical: true }).monthly.toNumber(), 0);
  });

  test("charging the benchmark rate leaves nothing taxable", () => {
    assert.equal(concessionalLoanPerquisite({ outstanding: 200000, benchmarkRate: 9, chargedRate: 9.5, aggregateOutstanding: 200000 }).monthly.toNumber(), 0);
  });
});
