import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  nextWorkforceCode, fiscalYearOf, fiscalYearRange, fiscalYearLabel, fiscalMonthLabel, fiscalMonths,
  vacancyAgingBucket, vacancyAging, postingReadiness, withinRange, locationAllowed, parseTags, reconcile,
  headcountPosition, planHeadroom, planCost, replacementHiresFor, compareCosts, budgetVariance, capacityGap, workforceRisk,
  headcountCalendar, scaleLines, contractExpiry, timesheetAmount, contractorPayout, rateCardOn, rateCardOverlaps,
  vendorCompliance, vendorScore, validGstin, validIfsc, contingentSpendBy,
} from "../src/workforce-math";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("Codes and fiscal years", () => {
  test("codes continue after the highest, ignoring other prefixes", () => {
    assert.equal(nextWorkforceCode("POS", []), "POS-0001");
    assert.equal(nextWorkforceCode("POS", ["POS-0007", "POS-0002", "JOB-0099", null]), "POS-0008");
    assert.equal(nextWorkforceCode("CW", ["CW-0010"]), "CW-0011");
  });
  test("April starts the fiscal year", () => {
    assert.equal(fiscalYearOf(utc(2026, 3, 31)), 2025);
    assert.equal(fiscalYearOf(utc(2026, 4, 1)), 2026);
    assert.equal(fiscalYearRange(2026).start.toISOString().slice(0, 10), "2026-04-01");
    assert.equal(fiscalYearRange(2026).end.toISOString().slice(0, 10), "2027-03-31");
    assert.equal(fiscalYearLabel(2026), "FY 2026-27");
    assert.equal(fiscalMonthLabel(2026, 1), "Apr 2026");
    assert.equal(fiscalMonthLabel(2026, 12), "Mar 2027");
    assert.deepEqual(fiscalMonths(2026)[0], { year: 2026, month: 4 });
    assert.deepEqual(fiscalMonths(2026)[11], { year: 2027, month: 3 });
  });
});

describe("Positions", () => {
  test("vacancy aging buckets and averages", () => {
    assert.equal(vacancyAgingBucket(0), "0-30");
    assert.equal(vacancyAgingBucket(31), "31-60");
    assert.equal(vacancyAgingBucket(90), "61-90");
    assert.equal(vacancyAgingBucket(91), "90+");
    const a = vacancyAging([utc(2026, 9, 24), utc(2026, 6, 1), null], utc(2026, 10, 4));
    assert.equal(a.buckets["0-30"], 1);
    assert.equal(a.buckets["90+"], 1);
    assert.equal(a.oldestDays, 125);
    assert.equal(a.averageDays, 68);
  });
  test("posting readiness needs every item and no open requisition", () => {
    const ok = { status: "VACANT", jobStatus: "ACTIVE", hasDescription: true, budgetedAnnualSalary: 1_200_000, budgetStatus: "BUDGETED", payGradeId: "g", skills: ["SQL"], locationId: "l", departmentId: "d", requisitionId: null };
    assert.equal(postingReadiness(ok).ready, true);
    assert.equal(postingReadiness({ ...ok, skills: [] }).ready, false);
    assert.equal(postingReadiness({ ...ok, status: "FROZEN" }).ready, false);
    assert.equal(postingReadiness({ ...ok, requisitionId: "r" }).ready, false);
    assert.equal(postingReadiness({ ...ok, budgetStatus: "UNBUDGETED" }).items.find((i) => i.key === "budget")!.done, false);
  });
  test("compensation range and location constraints", () => {
    assert.equal(withinRange(10, 5, 20), true);
    assert.equal(withinRange(25, 5, 20), false);
    assert.equal(withinRange(null, 5, 20), true);
    assert.equal(withinRange(1, null, null), true);
    assert.equal(locationAllowed("blr", [], "blr", "ONSITE"), true);
    assert.equal(locationAllowed("blr", [], "che", "ONSITE"), false);
    assert.equal(locationAllowed("blr", ["che"], "che", "HYBRID"), true);
    assert.equal(locationAllowed("blr", [], "che", "REMOTE"), true);
  });
  test("tags are trimmed and de-duplicated", () => {
    assert.deepEqual(parseTags(" SQL, sql ,Python\n\nLeadership,"), ["SQL", "Python", "Leadership"]);
    assert.deepEqual(parseTags(null), []);
  });
  test("reconciliation classifies departments", () => {
    const r = reconcile([
      { departmentId: "a", filledPositions: 3, vacantPositions: 1, activeEmployees: 3 },
      { departmentId: "b", filledPositions: 1, vacantPositions: 0, activeEmployees: 4 },
      { departmentId: "c", filledPositions: 2, vacantPositions: 0, activeEmployees: 1 },
    ]);
    assert.deepEqual(r.map((x) => x.status), ["MATCHED", "EMPLOYEES_WITHOUT_SEATS", "SEATS_WITHOUT_EMPLOYEES"]);
    assert.equal(r[1].unpositioned, 3);
  });
});

describe("Workforce planning", () => {
  test("headcount projection and gap", () => {
    const h = headcountPosition({ planned: 20, active: 15, preJoining: 2, exiting: 1, openRequisitions: 3 });
    assert.equal(h.projected, 19);
    assert.equal(h.gap, 1);
    assert.equal(h.status, "UNDER_PLAN");
    assert.equal(headcountPosition({ planned: 10, active: 12, preJoining: 0, exiting: 0, openRequisitions: 0 }).status, "OVER_PLAN");
    assert.equal(planHeadroom(10, 11), -1);
  });
  test("plan cost prorates new hires from their month and loads benefits", () => {
    const c = planCost([{ plannedHeadcount: 10, newHires: 2, replacementHires: 1, avgAnnualSalary: 1_200_000, hireMonth: 7 }], { attritionPct: 10, salaryIncreasePct: 10, benefitsLoadPct: 10, overtimePct: 0, contractorCost: 50_000 });
    // 8 existing × 13.2L = 1.056 Cr; 2 new × 13.2L × 6/12 = 13.2L.
    assert.equal(c.salary, 11_880_000);
    assert.equal(c.benefits, 1_188_000);
    assert.equal(c.total, 11_880_000 + 1_188_000 + 50_000);
    assert.equal(c.headcount, 10);
    assert.equal(c.hires, 3);
    assert.equal(c.expectedAttrition, 1);
    assert.equal(replacementHiresFor(40, 12.5), 5);
  });
  test("scenario comparison and scaling", () => {
    assert.deepEqual(compareCosts({ total: 100, headcount: 10 }, { total: 120, headcount: 12 }), { costDelta: 20, costDeltaPct: 20, headcountDelta: 2 });
    const s = scaleLines([{ plannedHeadcount: 10, newHires: 1, replacementHires: 0, avgAnnualSalary: 1, hireMonth: 1 }], 20);
    assert.equal(s[0].plannedHeadcount, 12);
    assert.equal(s[0].newHires, 3);
    assert.equal(scaleLines([{ plannedHeadcount: 10, newHires: 1, replacementHires: 0, avgAnnualSalary: 1, hireMonth: 1 }], -50)[0].newHires, 0);
  });
  test("budget variance, capacity gaps and risk", () => {
    assert.deepEqual(budgetVariance(100, 50), { variance: 50, utilisationPct: 50, status: "UNDER" });
    assert.equal(budgetVariance(100, 95).status, "ON_TRACK");
    assert.equal(budgetVariance(100, 120).status, "OVER");
    assert.deepEqual(capacityGap(5, 3), { gap: 2, coveragePct: 60, status: "SHORTFALL" });
    assert.equal(capacityGap(2, 3).status, "SURPLUS");
    assert.equal(workforceRisk({ planned: 10, active: 10, exiting: 0, vacant: 0, criticalVacant: 0 }).level, "LOW");
    assert.equal(workforceRisk({ planned: 10, active: 10, exiting: 3, vacant: 2, criticalVacant: 1 }).level, "HIGH");
  });
  test("headcount calendar adds hires in their month", () => {
    const cal = headcountCalendar(10, [{ newHires: 2, hireMonth: 3 }, { newHires: 1, hireMonth: 12 }], [0, 1]);
    assert.deepEqual(cal, [10, 9, 11, 11, 11, 11, 11, 11, 11, 11, 11, 12]);
  });
});

describe("Contingent workforce", () => {
  test("contract expiry states", () => {
    const today = utc(2026, 10, 4);
    assert.equal(contractExpiry(utc(2026, 10, 1), today).state, "EXPIRED");
    assert.equal(contractExpiry(utc(2026, 10, 10), today).state, "EXPIRING_7");
    assert.equal(contractExpiry(utc(2026, 10, 30), today).state, "EXPIRING_30");
    assert.equal(contractExpiry(utc(2026, 12, 30), today).state, "ACTIVE");
    assert.equal(contractExpiry(utc(2026, 10, 14), today).days, 10);
  });
  test("timesheet amounts and payouts", () => {
    assert.equal(timesheetAmount("HOURLY", 1500, 40, 5), 60_000);
    assert.equal(timesheetAmount("DAILY", 8000, 0, 5), 40_000);
    assert.equal(timesheetAmount("MONTHLY", 220_000, 0, 11), 110_000);
    assert.equal(timesheetAmount("MONTHLY", 220_000, 0, 30), 220_000);
    assert.equal(timesheetAmount("FIXED", 1, 1, 1), 0);
    assert.deepEqual(contractorPayout(100_000, { gstRegistered: true, gstRatePct: 18, tdsRatePct: 10 }), { gst: 18_000, tds: 10_000, payable: 108_000 });
    assert.deepEqual(contractorPayout(100_000, { gstRegistered: false, gstRatePct: 18, tdsRatePct: 2 }), { gst: 0, tds: 2_000, payable: 98_000 });
  });
  test("effective-dated rate cards prefer the vendor's own rate", () => {
    const cards = [
      { id: "g1", vendorId: null, role: "Developer", rate: 1000, rateType: "HOURLY", effectiveFrom: utc(2026, 1, 1), effectiveTo: utc(2026, 6, 30) },
      { id: "g2", vendorId: null, role: "Developer", rate: 1100, rateType: "HOURLY", effectiveFrom: utc(2026, 7, 1), effectiveTo: null },
      { id: "v1", vendorId: "v", role: "developer", rate: 1200, rateType: "HOURLY", effectiveFrom: utc(2026, 4, 1), effectiveTo: null },
    ];
    assert.equal(rateCardOn(cards, "Developer", null, utc(2026, 5, 1))?.id, "g1");
    assert.equal(rateCardOn(cards, "Developer", null, utc(2026, 8, 1))?.id, "g2");
    assert.equal(rateCardOn(cards, "Developer", "v", utc(2026, 8, 1))?.id, "v1");
    assert.equal(rateCardOn(cards, "Developer", "v", utc(2026, 2, 1))?.id, "g1");
    assert.equal(rateCardOn(cards, "Tester", null, utc(2026, 8, 1)), null);
    assert.equal(rateCardOverlaps([{ effectiveFrom: utc(2026, 1, 1), effectiveTo: utc(2026, 6, 30) }], utc(2026, 7, 1), null), false);
    assert.equal(rateCardOverlaps([{ effectiveFrom: utc(2026, 1, 1), effectiveTo: null }], utc(2026, 7, 1), null), true);
  });
  test("vendor compliance and scorecards", () => {
    const today = utc(2026, 10, 4);
    const docs = [
      { docType: "MSA", validUntil: null }, { docType: "GST_CERT", validUntil: utc(2027, 1, 1) },
      { docType: "PAN", validUntil: null }, { docType: "INSURANCE", validUntil: utc(2026, 9, 1) },
    ];
    const c = vendorCompliance(docs, today);
    assert.equal(c.compliant, false);
    assert.deepEqual(c.expired, ["INSURANCE"]);
    assert.deepEqual(vendorCompliance(docs.slice(0, 2), today).missing, ["PAN", "INSURANCE"]);
    assert.equal(vendorCompliance([...docs, { docType: "INSURANCE", validUntil: utc(2026, 10, 20) }], today).compliant, true);
    assert.deepEqual(vendorCompliance([...docs, { docType: "INSURANCE", validUntil: utc(2026, 10, 20) }], today).expiringSoon, ["INSURANCE"]);
    const s = vendorScore({ ratings: [5, 4], compliant: true, checklistDone: 6, checklistTotal: 6 });
    assert.equal(s.score, 95);
    assert.equal(s.grade, "A");
    assert.equal(vendorScore({ ratings: [], compliant: false, checklistDone: 0, checklistTotal: 6 }).grade, "D");
  });
  test("GSTIN and IFSC validation, spend roll-up", () => {
    assert.equal(validGstin("29ABCDE1234F1Z5"), true);
    assert.equal(validGstin("29ABCDE1234F1X5"), false);
    assert.equal(validIfsc("HDFC0001234"), true);
    assert.equal(validIfsc("HDFC1001234"), false);
    assert.deepEqual(contingentSpendBy([{ k: "a", v: 1 }, { k: "b", v: 5 }, { k: "a", v: 2 }], (r) => r.k, (r) => r.v), [{ key: "b", amount: 5 }, { key: "a", amount: 3 }]);
  });
});
