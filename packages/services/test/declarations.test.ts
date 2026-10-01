import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cappedDeductions, roomLeft, effectiveAmount, sectionAllowed } from "../src/declarations";

const item = (section: string, declaredAmount: number, proofStatus = "NOT_SUBMITTED", approvedAmount = 0) => ({ section, declaredAmount, approvedAmount, proofStatus });

describe("Investment declarations", () => {
  test("a line counts as declared until its proof is ruled on, then as accepted", () => {
    assert.equal(effectiveAmount(item("80C", 60000)), 60000);
    assert.equal(effectiveAmount(item("80C", 60000, "SUBMITTED")), 60000);
    assert.equal(effectiveAmount(item("80C", 60000, "APPROVED", 50000)), 50000);
    assert.equal(effectiveAmount(item("80C", 60000, "REJECTED", 0)), 0);
  });

  test("the 80C family shares one ₹1.5 lakh ceiling, filling from 80C first", () => {
    const t = cappedDeductions([item("80C", 120000), item("80CCC", 50000), item("80CCD(1)", 30000)], 35);
    assert.equal(t.chapterVia, 150000);
    assert.deepEqual(t.bySection.map((s) => [s.section, s.allowed]), [["80C", 120000], ["80CCC", 30000], ["80CCD(1)", 0]]);
  });

  test("each section keeps its own ceiling, with the senior limit for 80D", () => {
    assert.equal(cappedDeductions([item("80D", 40000)], 40).chapterVia, 25000);
    assert.equal(cappedDeductions([item("80D", 40000)], 62).chapterVia, 40000);
    assert.equal(cappedDeductions([item("80CCD(1B)", 80000)], 40).chapterVia, 50000);
  });

  test("employer NPS is kept apart — it is the one deduction the new regime allows", () => {
    const t = cappedDeductions([item("80CCD(2)", 90000), item("80C", 10000)], 30);
    assert.equal(t.employerNps, 90000);
    assert.equal(t.chapterVia, 10000);
    assert.ok(sectionAllowed("80CCD(2)", "NEW"));
    assert.ok(!sectionAllowed("80C", "NEW"));
  });

  test("home-loan interest becomes a house-property loss capped at ₹2 lakh", () => {
    assert.equal(cappedDeductions([item("24B", 260000)], 40).houseProperty, -200000);
  });

  test("other income and the tax already deducted on it are carried, not deducted", () => {
    const t = cappedDeductions([item("OTHER_INCOME", 42000), item("OTHER_TDS", 4200)], 40);
    assert.equal(t.otherIncome, 42000);
    assert.equal(t.otherTds, 4200);
    assert.equal(t.chapterVia, 0);
  });

  test("the room left for a new line respects both its own and the shared ceiling", () => {
    assert.equal(roomLeft("80CCC", [item("80C", 140000)], 30), 10000);
    assert.equal(roomLeft("80D", [item("80D", 20000)], 30), 5000);
    assert.equal(roomLeft("80E", [], 30), null);
  });
});
