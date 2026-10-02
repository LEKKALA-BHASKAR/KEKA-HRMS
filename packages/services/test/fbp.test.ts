import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkFbpSplit, fbpCarveSpecs, unclaimedFbp } from "../src/fbp-math";
import { resolveStructure } from "@keka/payroll";

const components = [
  { id: "fuel", code: "FUEL_REIMB", name: "Fuel", limit: 28800 },
  { id: "phone", code: "TELEPHONE_REIMB", name: "Telephone", limit: 24000 },
];

describe("FBP split", () => {
  test("amounts within each cap and the pool are accepted; zeros dropped", () => {
    const r = checkFbpSplit({ pool: 50000, components, amounts: { fuel: 24000, phone: 0 } });
    assert.deepEqual(r, { lines: [{ componentId: "fuel", amount: 24000 }], total: 24000 });
  });
  test("a component above its cap is refused, naming it", () => {
    const r = checkFbpSplit({ pool: 99999, components, amounts: { fuel: 30000 } });
    assert.ok("error" in r && /Fuel/.test(r.error) && r.field === "fuel");
  });
  test("a total above the pool is refused", () => {
    const r = checkFbpSplit({ pool: 40000, components, amounts: { fuel: 24000, phone: 24000 } });
    assert.ok("error" in r && /more than/.test(r.error));
  });
  test("nothing allotted, negatives and unknown components are refused", () => {
    assert.ok("error" in checkFbpSplit({ pool: 1, components, amounts: {} }));
    assert.ok("error" in checkFbpSplit({ pool: 99999, components, amounts: { fuel: -5 } }));
    assert.ok("error" in checkFbpSplit({ pool: 99999, components, amounts: { other: 100 } }));
  });
});

describe("FBP carve-out", () => {
  test("declared amounts shrink the balancing component by the same monthly amount", () => {
    const base = [
      { code: "BASIC", name: "Basic", type: "EARNING" as const, calculationType: "PERCENTAGE" as const, percentage: 50, percentageOf: "CTC_MONTHLY" },
      { code: "SPECIAL", name: "Special Allowance", type: "EARNING" as const, calculationType: "BALANCE" as const },
    ];
    const before = resolveStructure({ annualCtc: 1200000, components: base });
    const after = resolveStructure({ annualCtc: 1200000, components: [...base, ...fbpCarveSpecs([{ code: "FUEL_REIMB", name: "Fuel", annual: 24000 }])] });
    assert.equal(Number(before.byCode.get("SPECIAL")!.monthly) - Number(after.byCode.get("SPECIAL")!.monthly), 2000);
    assert.equal(Number(after.byCode.get("FUEL_REIMB")!.monthly), 2000);
  });
  test("unclaimed balance counts only what accrued and was not claimed", () => {
    assert.equal(unclaimedFbp([{ accrued: 24000, claimed: 10000 }, { accrued: 6000, claimed: 6500 }]), 14000);
  });
});
