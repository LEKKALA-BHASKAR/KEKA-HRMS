import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pickExpensePolicy, findDuplicateLines, receiptQuality, receiptImageSize, reimbursementMonth, splitTaxable, sampleForAudit, mileageAmount, rateOn,
  checkTripPolicy, checkBookingPolicy, needsSecondTravelApproval, passportIssue, destinationRisk, perDiemDays, travelSettlementNet, tripMonthGrid, onTripOn, nightsBetween,
  loanProcessingFee, emergencyAdvanceCap, trancheSchedule, overdueInstallments, loanAging,
  benefitEligibilityGaps, coverageStart, waitingDaysLeft, benefitPremium, dependentCoverageIssues, premiumMonthsDue, benefitForecast, reconcileCarrier, enrollmentCompletion,
  meritPctFor, prorationFactor, compaRatio, rangePenetration, adjustedRange, marketAdjustmentPct, compIncrease, compGuardrailBreaches, compIneligibility, poolUsage, payEquityGap,
  moneyBuiltInRoute, isExpenseReasonCode, parseMeritMatrix,
} from "../src/money-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w); v.setUint32(20, h);
  return b;
}

describe("Expense policies and claims", () => {
  const base = { isActive: true, status: "ACTIVE", isDefault: false, departmentId: null as string | null, locationId: null as string | null, bandId: null as string | null };
  test("the most specific active policy wins, the default otherwise", () => {
    const all = [{ ...base, id: "def", isDefault: true }, { ...base, id: "loc", locationId: "L1" }, { ...base, id: "dept", departmentId: "D1" }, { ...base, id: "draft", departmentId: "D1", bandId: "B1", status: "DRAFT" }];
    assert.equal(pickExpensePolicy(all, { departmentId: "D1", locationId: "L1", bandId: "B1" })?.id, "dept");
    assert.equal(pickExpensePolicy(all, { departmentId: "D2", locationId: "L1", bandId: null })?.id, "loc");
    assert.equal(pickExpensePolicy(all, { departmentId: "D2", locationId: "L2", bandId: null })?.id, "def");
  });
  test("duplicates: same category, day and amount, against other claims and earlier lines", () => {
    const existing = [{ id: "x1", categoryId: "c", expenseDate: d("2026-09-01"), amount: 450, merchant: "Cafe" }];
    const r = findDuplicateLines([
      { categoryId: "c", expenseDate: d("2026-09-01"), amount: 450, merchant: "cafe " },
      { categoryId: "c", expenseDate: d("2026-09-01"), amount: 450, merchant: "Other" },
      { categoryId: "c", expenseDate: d("2026-09-02"), amount: 99 },
      { categoryId: "c", expenseDate: d("2026-09-02"), amount: 99 },
    ], existing);
    assert.deepEqual(r, ["x1", null, null, "line 3"]);
  });
  test("receipt quality: tiny images are refused, low resolution and truncated PDFs flagged", () => {
    assert.deepEqual(receiptImageSize(png(800, 1200)), { width: 800, height: 1200 });
    assert.equal(receiptQuality(png(120, 80), "image/png").blocking, true);
    const low = receiptQuality(png(500, 400, 5000), "image/png");
    assert.equal(low.blocking, false);
    assert.match(low.issues.join(" "), /Low resolution/);
    assert.equal(receiptQuality(png(1200, 1600, 5000), "image/png").ok, true);
    assert.equal(receiptQuality(new TextEncoder().encode("%PDF-1.4 body"), "application/pdf").ok, false);
    assert.equal(receiptQuality(new TextEncoder().encode("%PDF-1.4 body\n%%EOF"), "application/pdf").ok, true);
  });
  test("reimbursement cutoff moves a late approval to the next month", () => {
    assert.deepEqual(reimbursementMonth(d("2026-10-10"), 20, { year: 2026, month: 10 }), { year: 2026, month: 10 });
    assert.deepEqual(reimbursementMonth(d("2026-10-25"), 20, { year: 2026, month: 10 }), { year: 2026, month: 11 });
    assert.deepEqual(reimbursementMonth(d("2026-12-25"), 20, { year: 2026, month: 12 }), { year: 2027, month: 1 });
    assert.deepEqual(reimbursementMonth(d("2026-10-25"), null, { year: 2026, month: 10 }), { year: 2026, month: 10 });
  });
  test("taxable split, with an advance settled out of the non-taxable part first", () => {
    assert.deepEqual(splitTaxable([{ approved: 1000, taxable: true }, { approved: 500, taxable: false }]), { taxable: 1000, nonTaxable: 500 });
    assert.deepEqual(splitTaxable([{ approved: 1000, taxable: true }, { approved: 500, taxable: false }], 700), { taxable: 800, nonTaxable: 0 });
  });
  test("audit sampling is reproducible and always includes high-value claims", () => {
    const claims = Array.from({ length: 20 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, amount: i === 7 ? 90000 : 1000 }));
    const a = sampleForAudit(claims, 10, 42, 50000), b = sampleForAudit(claims, 10, 42, 50000);
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
    assert.ok(a.includes("c07"));
    assert.notDeepEqual(sampleForAudit(claims, 50, 1), sampleForAudit(claims, 50, 2));
    assert.deepEqual(sampleForAudit([], 10, 1), []);
  });
  test("mileage and the rate in force on a date", () => {
    assert.equal(mileageAmount(42.5, 9), 382.5);
    assert.equal(mileageAmount(-1, 9), 0);
    const rates = [{ key: "CAR", amount: 8, effectiveFrom: d("2026-01-01"), status: "ACTIVE" }, { key: "CAR", amount: 10, effectiveFrom: d("2026-07-01"), status: "ACTIVE" }, { key: "CAR", amount: 12, effectiveFrom: d("2026-08-01"), status: "PENDING_APPROVAL" }];
    assert.equal(rateOn(rates, "CAR", d("2026-06-30"))?.amount, 8);
    assert.equal(rateOn(rates, "CAR", d("2026-09-01"))?.amount, 10);
    assert.equal(rateOn(rates, "BIKE", d("2026-09-01")), null);
  });
  test("reason codes are a closed list", () => {
    assert.equal(isExpenseReasonCode("OVER_LIMIT"), true);
    assert.equal(isExpenseReasonCode("whatever"), false);
  });
});

describe("Travel", () => {
  const policy = { domesticFlightClass: "ECONOMY", internationalFlightClass: "PREMIUM_ECONOMY", hotelCapPerNight: 6000, groundDailyCap: 1500, minAdvanceDays: 7, secondApprovalAbove: 100000, internationalNeedsSecondApproval: true, requireInsuranceInternational: true, passportValidityMonths: 6 };
  test("trip policy: late request warns, cost and international need a second approval", () => {
    const v = checkTripPolicy({ travelType: "INTERNATIONAL", departDate: d("2026-10-05"), returnDate: d("2026-10-10"), estimatedCost: 150000, requestedOn: d("2026-10-01") }, policy);
    assert.deepEqual(v.map((x) => x.code).sort(), ["COST_ABOVE_LIMIT", "INTERNATIONAL", "LATE_REQUEST"]);
    assert.equal(needsSecondTravelApproval(v), true);
    assert.equal(needsSecondTravelApproval(checkTripPolicy({ travelType: "DOMESTIC", departDate: d("2026-10-05"), returnDate: null, estimatedCost: 5000, requestedOn: d("2026-10-01") }, policy)), false);
    assert.deepEqual(checkTripPolicy({ travelType: "DOMESTIC", departDate: d("2026-10-05"), returnDate: null, estimatedCost: 5000, requestedOn: d("2026-10-01") }, null), []);
  });
  test("booking policy: flight class, hotel per night and ground transport per day", () => {
    assert.equal(checkBookingPolicy({ kind: "FLIGHT", travelClass: "BUSINESS", cost: 1, startsAt: d("2026-10-05") }, "DOMESTIC", policy)[0]?.code, "FLIGHT_CLASS");
    assert.equal(checkBookingPolicy({ kind: "FLIGHT", travelClass: "PREMIUM_ECONOMY", cost: 1, startsAt: d("2026-10-05") }, "INTERNATIONAL", policy).length, 0);
    assert.equal(checkBookingPolicy({ kind: "HOTEL", cost: 15000, startsAt: d("2026-10-05"), endsAt: d("2026-10-07") }, "DOMESTIC", policy)[0]?.code, "HOTEL_CAP");
    assert.equal(checkBookingPolicy({ kind: "HOTEL", cost: 11000, startsAt: d("2026-10-05"), endsAt: d("2026-10-07") }, "DOMESTIC", policy).length, 0);
    assert.equal(checkBookingPolicy({ kind: "CAB", cost: 4000, startsAt: d("2026-10-05"), endsAt: d("2026-10-06") }, "DOMESTIC", policy)[0]?.code, "GROUND_CAP");
    assert.equal(nightsBetween(d("2026-10-05"), null), 1);
  });
  test("passport validity, destination risk and per-diem days", () => {
    assert.equal(passportIssue(null, d("2026-10-10"), 6), "No passport on file.");
    assert.match(passportIssue(d("2027-01-01"), d("2026-10-10"), 6) ?? "", /must be valid until 2027-04-10/);
    assert.equal(passportIssue(d("2028-01-01"), d("2026-10-10"), 6), null);
    const risks = [{ destination: "Kabul", level: "CRITICAL", blockTravel: true }, { destination: "Afghanistan", level: "HIGH", blockTravel: false }];
    assert.equal(destinationRisk(risks, "kabul ", "Afghanistan")?.level, "CRITICAL");
    assert.equal(destinationRisk(risks, "Pune", "India"), null);
    assert.equal(perDiemDays(d("2026-10-05"), d("2026-10-08")), 3.5);
    assert.equal(perDiemDays(d("2026-10-05"), d("2026-10-05")), 1);
  });
  test("settlement clears the advance first", () => {
    assert.deepEqual(travelSettlementNet({ perDiemAmount: 7000, advanceOutstanding: 5000 }), { settlesAdvance: 5000, payable: 2000, recover: 0, net: 2000 });
    assert.deepEqual(travelSettlementNet({ perDiemAmount: 3000, advanceOutstanding: 5000 }), { settlesAdvance: 3000, payable: 0, recover: 2000, net: -2000 });
  });
  test("trip calendar grid and who is away on a day", () => {
    const g = tripMonthGrid(2026, 10);
    assert.equal(g[0]!.filter(Boolean)[0]!.toISOString().slice(0, 10), "2026-10-01");
    assert.equal(g[0]![3]!.getUTCDate(), 1);
    assert.ok(g.every((w) => w.length === 7));
    assert.equal(onTripOn({ departDate: d("2026-10-05"), returnDate: d("2026-10-07") }, d("2026-10-06")), true);
    assert.equal(onTripOn({ departDate: d("2026-10-05"), returnDate: null }, d("2026-10-06")), false);
  });
});

describe("Loans", () => {
  test("processing fee, emergency cap and tranches", () => {
    assert.equal(loanProcessingFee(100000, 1.5, 250), 1750);
    assert.equal(loanProcessingFee(100000, null, null), 0);
    assert.equal(emergencyAdvanceCap(60000, 2), 120000);
    assert.equal(emergencyAdvanceCap(60000, null), null);
    const t = trancheSchedule(100000, 3, d("2026-10-15"), 2);
    assert.deepEqual(t.map((x) => x.amount), [33333.33, 33333.33, 33333.34]);
    assert.equal(t[2]!.plannedOn.toISOString().slice(0, 10), "2027-02-15");
  });
  test("overdue EMIs and the aging buckets", () => {
    const rows = [{ year: 2026, month: 8, status: "SCHEDULED" }, { year: 2026, month: 9, status: "DEDUCTED" }, { year: 2026, month: 10, status: "SCHEDULED" }];
    assert.equal(overdueInstallments(rows, { year: 2026, month: 9 }).length, 1);
    assert.equal(overdueInstallments(rows, null).length, 0);
    assert.deepEqual(loanAging([{ outstanding: 100, overdueMonths: 0 }, { outstanding: 50, overdueMonths: 2 }, { outstanding: 30, overdueMonths: 4 }, { outstanding: 20, overdueMonths: 9 }]), { current: 100, "1-2": 50, "3-5": 30, "6+": 20 });
  });
});

describe("Benefits", () => {
  const emp = { dateOfJoining: d("2026-09-01"), status: "PROBATION", bandId: "B1", locationId: "L1", departmentId: "D1", workerTypeId: "W1" };
  test("eligibility gaps", () => {
    assert.deepEqual(benefitEligibilityGaps(null, emp, d("2026-10-01")), []);
    const gaps = benefitEligibilityGaps({ minTenureDays: 90, excludeProbation: true, bandIds: ["B2"], locationIds: ["L1"] }, emp, d("2026-10-01"));
    assert.equal(gaps.length, 3);
    assert.match(gaps.join(" "), /Needs 90 days of service \(has 30\)/);
  });
  test("coverage starts after the waiting period and the plan year", () => {
    assert.equal(coverageStart(d("2026-09-01"), 30, d("2026-09-05")).toISOString().slice(0, 10), "2026-10-01");
    assert.equal(coverageStart(d("2020-01-01"), 30, d("2026-09-05"), d("2026-10-01")).toISOString().slice(0, 10), "2026-10-01");
    assert.equal(waitingDaysLeft(d("2026-09-01"), 30, d("2026-09-21")), 10);
    assert.equal(waitingDaysLeft(d("2026-09-01"), 30, d("2026-12-21")), 0);
  });
  test("premium split by tier and employer rule; retirement matches a % of basic", () => {
    const plan = { monthlyPremium: 1000, tierFactors: { EMPLOYEE: 1, EMPLOYEE_SPOUSE: 1.8, FAMILY: 2.5 }, employerRule: "PERCENT_OF_PREMIUM", employerValue: 80, employerCap: 1500, type: "HEALTH" };
    assert.deepEqual(benefitPremium(plan, "EMPLOYEE"), { total: 1000, employer: 800, employee: 200 });
    assert.deepEqual(benefitPremium(plan, "FAMILY"), { total: 2500, employer: 1500, employee: 1000 });
    assert.deepEqual(benefitPremium({ ...plan, employerRule: "FLAT", employerValue: 600, employerCap: null }, "EMPLOYEE_SPOUSE"), { total: 1800, employer: 600, employee: 1200 });
    assert.deepEqual(benefitPremium({ ...plan, type: "RETIREMENT", employerRule: "MATCH_PERCENT_OF_BASIC", employerValue: 5, employerCap: null }, "EMPLOYEE", { monthlyBasic: 50000, contributionPct: 8 }), { total: 6500, employer: 2500, employee: 4000 });
  });
  test("dependents against the plan's rules", () => {
    const plan = { allowedRelations: ["SPOUSE", "CHILD"], maxDependents: 2, childMaxAge: 25, requiresDependentProof: true };
    const kid = { id: "k", name: "Kid", relationship: "CHILD", dateOfBirth: d("1998-01-01"), verified: true };
    const mum = { id: "m", name: "Mum", relationship: "PARENT", dateOfBirth: null, verified: false };
    const issues = dependentCoverageIssues(plan, "FAMILY", [kid, mum], d("2026-10-01"));
    assert.match(issues.join(" "), /children are covered up to 25/);
    assert.match(issues.join(" "), /parent is not covered/);
    assert.match(issues.join(" "), /not been verified/);
    assert.match(dependentCoverageIssues(plan, "EMPLOYEE", [kid], d("2026-10-01")).join(" "), /cannot include dependents/);
  });
  test("premium months due, with arrears", () => {
    const due = premiumMonthsDue(d("2026-08-01"), null, { year: 2026, month: 10 });
    assert.deepEqual(due.map((m) => [m.month, m.arrears]), [[8, true], [9, true], [10, false]]);
    assert.equal(premiumMonthsDue(d("2026-08-01"), 2026 * 12 + 8, { year: 2026, month: 10 }).length, 1);
    assert.equal(premiumMonthsDue(d("2026-08-01"), null, { year: 2026, month: 10 }, d("2026-08-31")).length, 1);
  });
  test("forecast, carrier reconciliation and completion", () => {
    const f = benefitForecast([{ planId: "p", employer: 800, employee: 200 }, { planId: "p", employer: 800, employee: 200 }], 12, 10);
    assert.deepEqual(f[0], { planId: "p", members: 2, employerAnnual: 19200, employeeAnnual: 4800, projectedEmployer: 21120, projectedTotal: 26400 });
    const r = reconcileCarrier([{ memberId: "A1", name: "a", tier: "EMPLOYEE", premium: 1000 }, { memberId: "A2", name: "b", tier: "FAMILY", premium: 2500 }, { memberId: "A3", name: "c", tier: "EMPLOYEE", premium: 1000 }], [{ memberId: "a1", name: "a", tier: "employee", premium: 1000 }, { memberId: "A2", name: "b", tier: "FAMILY", premium: 2000 }, { memberId: "Z9", name: "z", tier: "EMPLOYEE", premium: 1000 }]);
    assert.equal(r.matched, 1);
    assert.deepEqual(r.missingAtCarrier.map((x) => x.memberId), ["A3"]);
    assert.deepEqual(r.extraAtCarrier.map((x) => x.memberId), ["Z9"]);
    assert.equal(r.mismatches[0]?.theirs, 2000);
    assert.deepEqual(enrollmentCompletion(10, 6, 2), { decided: 8, pending: 2, pct: 80 });
  });
});

describe("Compensation planning", () => {
  const matrix = parseMeritMatrix([{ minRating: 1, maxRating: 2.99, pct: 2 }, { minRating: 3, maxRating: 3.99, pct: 6 }, { minRating: 4, maxRating: 5, pct: 10 }, { bad: true }]);
  test("merit matrix and proration", () => {
    assert.equal(matrix.length, 3);
    assert.equal(meritPctFor(matrix, 3, 4.5), 10);
    assert.equal(meritPctFor(matrix, 3, null), 3);
    assert.equal(prorationFactor(d("2026-01-01"), d("2026-04-01"), d("2027-04-01")), 1);
    assert.equal(prorationFactor(d("2026-10-01"), d("2026-04-01"), d("2027-04-01")), 0.4986);
    assert.equal(prorationFactor(d("2027-05-01"), d("2026-04-01"), d("2027-04-01")), 0);
  });
  test("compa-ratio, penetration, location ranges and market adjustment", () => {
    assert.equal(compaRatio(900000, 1000000), 0.9);
    assert.equal(compaRatio(900000, null), null);
    assert.equal(rangePenetration(900000, 800000, 1200000), 0.25);
    assert.deepEqual(adjustedRange({ min: 800000, mid: 1000000, max: 1200000 }, 10), { min: 880000, mid: 1100000, max: 1320000 });
    assert.equal(marketAdjustmentPct(840000, 800000, 880000), 5);
    assert.equal(marketAdjustmentPct(900000, 800000, 880000), 0);
  });
  test("increase, guardrails and eligibility", () => {
    assert.deepEqual(compIncrease(1000000, 10, 0.5, 5, 2), { totalPct: 12, newCtc: 1120000 });
    const g = { minPct: 2, maxPct: 15, reasonAbovePct: 10, maxPromotionPct: 8 };
    assert.equal(compGuardrailBreaches(g, { totalPct: 12, promotionPct: 0, note: "Top performer" }).length, 0);
    assert.match(compGuardrailBreaches(g, { totalPct: 12, promotionPct: 0, note: null }).join(" "), /needs a reason/);
    assert.equal(compGuardrailBreaches(g, { totalPct: 18, promotionPct: 10, note: "x" }).length, 2);
    assert.equal(compIneligibility({ excludeNotice: true }, { dateOfJoining: d("2020-01-01"), status: "NOTICE_PERIOD", lastIncreaseOn: null }, d("2027-04-01")), "Serving notice.");
    assert.match(compIneligibility({ monthsSinceLastIncrease: 12 }, { dateOfJoining: d("2020-01-01"), status: "CONFIRMED", lastIncreaseOn: d("2026-10-01") }, d("2027-04-01")) ?? "", /6 month/);
    assert.equal(compIneligibility({ minTenureDays: 90 }, { dateOfJoining: d("2020-01-01"), status: "CONFIRMED", lastIncreaseOn: null }, d("2027-04-01")), null);
  });
  test("pool usage and pay equity gap", () => {
    const u = poolUsage([{ id: "p", ownerEmployeeId: "m", amount: 100000 }], [{ ownerEmployeeId: "m", currentCtc: 1000000, newCtc: 1080000, status: "DRAFT" }, { ownerEmployeeId: "m", currentCtc: 500000, newCtc: 540000, status: "DRAFT" }, { ownerEmployeeId: "m", currentCtc: 500000, newCtc: 600000, status: "SKIPPED" }]);
    assert.deepEqual(u[0], { poolId: "p", ownerEmployeeId: "m", amount: 100000, used: 120000, left: -20000, over: true });
    const gap = payEquityGap([{ gender: "MALE", ctc: 1000000 }, { gender: "MALE", ctc: 1200000 }, { gender: "FEMALE", ctc: 990000 }, { gender: null, ctc: 1 }]);
    assert.equal(gap.meanGapPct, 10);
    assert.equal(gap.counts.UNSPECIFIED, 1);
  });
  test("money requests have built-in approval routes", () => {
    assert.equal(moneyBuiltInRoute("COMP_PLAN")?.[0]?.approverPermission, "payroll.salary.approve");
    assert.equal(moneyBuiltInRoute("ALLOWANCE_CHANGE")?.length, 2);
    assert.equal(moneyBuiltInRoute("LEAVE"), null);
  });
});
