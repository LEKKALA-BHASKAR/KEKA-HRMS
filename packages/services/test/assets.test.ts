import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assetAvailabilityBucket, assetBookValue, assetWarrantyStatus, formatAssetTag, planAssetApprovals, decideAssetLevels,
  parseAssetCsv, autoMapAssetHeaders, validateAssetImport, parseAssetImportDate, assetInitialAckStatus, parseAssetChain,
  type AssetLevelState, type AssetImportRefs,
} from "../src/assets-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Asset vocabulary", () => {
  test("statuses fall into Keka's three buckets, retired out of the count", () => {
    assert.equal(assetAvailabilityBucket("AVAILABLE"), "AVAILABLE");
    assert.equal(assetAvailabilityBucket("ASSIGNED"), "ASSIGNED");
    for (const s of ["IN_REPAIR", "LOST", "UNAVAILABLE"] as const) assert.equal(assetAvailabilityBucket(s), "NOT_AVAILABLE");
    assert.equal(assetAvailabilityBucket("RETIRED"), "RETIRED");
  });
  test("acknowledgement follows the type's setting", () => {
    assert.equal(assetInitialAckStatus(true), "PENDING");
    assert.equal(assetInitialAckStatus(false), "NOT_APPLICABLE");
  });
  test("ID series pads the number between prefix and suffix", () => {
    assert.equal(formatAssetTag({ prefix: "ACM-AST-", digits: 5, suffix: "" }, 83), "ACM-AST-00083");
    assert.equal(formatAssetTag({ prefix: "LAP", digits: 2, suffix: "-B" }, 123), "LAP123-B");
  });
});

describe("Warranty and book value", () => {
  const today = d("2026-10-01");
  test("expired, expiring within the alert window, active and none", () => {
    assert.equal(assetWarrantyStatus(d("2026-09-30"), today), "EXPIRED");
    assert.equal(assetWarrantyStatus(d("2026-10-01"), today), "EXPIRING");
    assert.equal(assetWarrantyStatus(d("2026-10-31"), today, 30), "EXPIRING");
    assert.equal(assetWarrantyStatus(d("2026-11-01"), today, 30), "ACTIVE");
    assert.equal(assetWarrantyStatus(null, today), "NONE");
  });
  test("straight-line over the category's useful life, floored at zero", () => {
    assert.equal(assetBookValue(120000, d("2025-10-01"), 36, today), 80000);
    assert.equal(assetBookValue(120000, d("2025-10-15"), 36, today), 83333); // 11 whole months
    assert.equal(assetBookValue(120000, d("2020-01-01"), 36, today), 0);
    assert.equal(assetBookValue(120000, d("2025-10-01"), null, today), 120000);
    assert.equal(assetBookValue(null, d("2025-10-01"), 36, today), null);
  });
});

describe("Request approvals", () => {
  const chain = parseAssetChain(["REPORTING_MANAGER", "ASSET_MANAGER", "bogus"]);
  test("the stored chain drops unknown entries", () => {
    assert.deepEqual(chain, ["REPORTING_MANAGER", "ASSET_MANAGER"]);
    assert.deepEqual(parseAssetChain(null), ["REPORTING_MANAGER", "ASSET_MANAGER"]);
  });
  test("a manager level resolves to the manager, and is dropped without one", () => {
    assert.deepEqual(planAssetApprovals(chain, { requesterId: "e1", managerId: "m1" }), [
      { level: 1, approverKind: "REPORTING_MANAGER", approverId: "m1" },
      { level: 2, approverKind: "ASSET_MANAGER", approverId: null },
    ]);
    assert.deepEqual(planAssetApprovals(chain, { requesterId: "ceo", managerId: null }), [{ level: 1, approverKind: "ASSET_MANAGER", approverId: null }]);
    assert.deepEqual(planAssetApprovals(["EMPLOYEE:e1"], { requesterId: "e1", managerId: null }), []);
  });

  const levels = (): AssetLevelState[] => [
    { level: 1, approverKind: "REPORTING_MANAGER", approverId: "m1", status: "PENDING" },
    { level: 2, approverKind: "ASSET_MANAGER", approverId: null, status: "PENDING" },
  ];
  test("only the current approver (or an asset manager) may decide", () => {
    const r = decideAssetLevels(levels(), { employeeId: "x", canManage: false }, "approve", true);
    assert.equal(r.ok, false);
  });
  test("the manager approves level 1 and the request moves to the asset manager", () => {
    const r = decideAssetLevels(levels(), { employeeId: "m1", canManage: false }, "approve", true);
    assert.ok(r.ok);
    assert.deepEqual(r.updates, [{ level: 1, status: "APPROVED" }]);
    assert.equal(r.outcome, "PENDING");
    assert.equal(r.nextLevel, 2);
  });
  test("a manager who is also an asset manager skips the second level", () => {
    const r = decideAssetLevels(levels(), { employeeId: "m1", canManage: true }, "approve", true);
    assert.ok(r.ok);
    assert.deepEqual(r.updates, [{ level: 1, status: "APPROVED" }, { level: 2, status: "SKIPPED" }]);
    assert.equal(r.outcome, "APPROVED");
  });
  test("without the skip rule they decide each level in turn", () => {
    const r = decideAssetLevels(levels(), { employeeId: "m1", canManage: true }, "approve", false);
    assert.ok(r.ok);
    assert.equal(r.outcome, "PENDING");
  });
  test("a rejection closes the request", () => {
    const r = decideAssetLevels(levels(), { employeeId: "m1", canManage: false }, "reject", true);
    assert.ok(r.ok);
    assert.equal(r.outcome, "REJECTED");
  });
  test("an asset-manager level is not decided by the line manager", () => {
    const l = levels(); l[0].status = "APPROVED";
    assert.equal(decideAssetLevels(l, { employeeId: "m1", canManage: false }, "approve", true).ok, false);
    const r = decideAssetLevels(l, { employeeId: "am", canManage: true }, "approve", true);
    assert.ok(r.ok);
    assert.equal(r.outcome, "APPROVED");
  });
});

describe("Bulk import", () => {
  test("CSV with quotes, commas and CRLF", () => {
    assert.deepEqual(parseAssetCsv('Asset ID,Asset Name\r\n"L-1","Laptop, 14"""\r\n\r\nL-2,Phone\n'), [["Asset ID", "Asset Name"], ["L-1", 'Laptop, 14"'], ["L-2", "Phone"]]);
  });
  test("headers map by name", () => {
    const m = autoMapAssetHeaders(["Asset ID", "asset name", "Location", "Asset Category", "Asset Type", "Condition", "Asset Status", "Notes"]);
    assert.equal(m["Asset ID"], "assetTag");
    assert.equal(m["asset name"], "name");
    assert.equal(m["Location"], "location");
    assert.equal(m["Condition"], "condition");
    assert.equal(m["Notes"], "");
  });
  test("dates in three formats", () => {
    assert.equal(parseAssetImportDate("2026-09-14")?.toISOString().slice(0, 10), "2026-09-14");
    assert.equal(parseAssetImportDate("14/09/2026")?.toISOString().slice(0, 10), "2026-09-14");
    assert.equal(parseAssetImportDate("14 Sep 2026")?.toISOString().slice(0, 10), "2026-09-14");
    assert.equal(parseAssetImportDate("31/02/2026"), null);
  });

  const refs: AssetImportRefs = {
    locations: new Map([["bengaluru hq", "loc1"]]),
    categories: new Map([["computing", { id: "c1", types: new Map([["thinkpad t14", "t1"]]) }]]),
    existingTags: new Set(["acm-ast-00001"]),
  };
  const headers = ["Asset ID", "Asset Name", "Asset Location", "Asset Category", "Asset Type", "Asset Condition", "Asset Status", "Purchase Cost"];
  const mapping = autoMapAssetHeaders(headers);
  test("a clean row validates; reference data must exist", () => {
    const { valid, issues } = validateAssetImport([
      ["L-9", "ThinkPad", "Bengaluru HQ", "Computing", "ThinkPad T14", "Good", "Available", "1,18,000"],
      ["L-10", "ThinkPad", "Pune", "Computing", "MacBook", "Shiny", "Assigned", "abc"],
    ], headers, mapping, refs, "ADD");
    assert.equal(valid.length, 1);
    assert.equal(valid[0].purchaseCost, 118000);
    assert.deepEqual(issues.map((i) => i.field).sort(), ["Asset Condition", "Asset Location", "Asset Status", "Asset Type", "Purchase Cost"]);
    assert.ok(issues.every((i) => i.row === 3));
  });
  test("ADD needs a new ID, UPDATE an existing one, and no duplicates in the file", () => {
    const row = ["ACM-AST-00001", "ThinkPad", "Bengaluru HQ", "Computing", "ThinkPad T14", "Fair", "In repair", ""];
    assert.equal(validateAssetImport([row], headers, mapping, refs, "ADD").issues[0].field, "Asset ID");
    assert.equal(validateAssetImport([row], headers, mapping, refs, "UPDATE").valid.length, 1);
    assert.match(validateAssetImport([["N1", ...row.slice(1)], ["N1", ...row.slice(1)]], headers, mapping, refs, "ADD").issues[0].message, /more than once/);
  });
  test("an unmapped required column stops the import", () => {
    const { issues } = validateAssetImport([], headers.slice(0, 3), autoMapAssetHeaders(headers.slice(0, 3)), refs, "ADD");
    assert.ok(issues.length >= 4);
  });
});
