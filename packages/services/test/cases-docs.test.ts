import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cdAddMonths, kbTokens, suggestArticles, slaTargets, triage, dueEscalation, leastLoaded, agingBucket,
  erCanMove, disciplinaryLadder, appealOpen, suspensionDays, erCanView, activeRecipients, envelopeOutcome, reminderDue,
  expiryStage, employeeNumberFromFilename, documentCompleteness, folderAllows, formatLetterNumber, nextSeriesNumber,
  applyConditionals, issueDateProblem, parseChecklistItems, checklistMissing, reservationOverlaps, stockShortfalls, reconciliationSummary,
} from "../src/cases-docs-math";
import { CASES_DOCS_ROUTES } from "../src/cases-docs-effects";
import { WORKFLOW_ENTITY_TYPES, RETENTION_DATA_TYPES } from "../src/governance-math";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const H = 3_600_000;

describe("Knowledge base search", () => {
  const arts = [
    { id: "a", title: "How to reset your password", body: "Use the sign-in page", keywords: "login, password", helpdeskCategoryId: "it" },
    { id: "b", title: "Payslip explained", body: "Your payslip shows deductions and password protection", keywords: "salary", helpdeskCategoryId: "pay" },
    { id: "c", title: "Leave policy", body: "Annual leave", keywords: null, helpdeskCategoryId: null },
  ];
  test("drops stop words and duplicates", () => assert.deepEqual(kbTokens("How do I reset my password password?"), ["reset", "password"]));
  test("title and keyword hits rank above body hits", () => assert.deepEqual(suggestArticles(arts, "password").map((a) => a.id), ["a", "b"]));
  test("same category breaks towards the ticket's category", () => assert.equal(suggestArticles(arts, "payslip password", "pay")[0]!.id, "b"));
  test("nothing relevant gives nothing", () => assert.deepEqual(suggestArticles(arts, "parking"), []));
});

describe("Helpdesk SLA, triage, escalation", () => {
  const cat = { id: "c1", parentId: "p1", firstResponseHours: 8, slaHours: 48 };
  test("category+priority policy beats all-category, which beats category hours", () => {
    const pols = [{ categoryId: null, priority: "HIGH", firstResponseHours: 2, resolutionHours: 12 }, { categoryId: "p1", priority: "HIGH", firstResponseHours: 1, resolutionHours: 6 }];
    assert.equal(slaTargets(pols, cat, "URGENT").resolutionHours, 6);
    assert.equal(slaTargets(pols.slice(0, 1), cat, "HIGH").source, "priority");
    assert.equal(slaTargets(pols, cat, "LOW").resolutionHours, 48);
  });
  test("triage takes the highest priority and the most severe severity", () => {
    const rules = [
      { id: "1", name: "Payroll", keywords: "salary, payslip", categoryId: null, setPriority: "MEDIUM", setSeverity: "S3", sortOrder: 1, isActive: true },
      { id: "2", name: "Harassment", keywords: "harass", categoryId: null, setPriority: "HIGH", setSeverity: "S1", sortOrder: 2, isActive: true },
      { id: "3", name: "Other cat", keywords: "salary", categoryId: "zz", setPriority: "URGENT", setSeverity: null, sortOrder: 0, isActive: true },
    ];
    const r = triage(rules, "My salary is wrong and my manager harassed me", "c1", null);
    assert.deepEqual([r.priority, r.severity, r.matched], ["HIGH", "S1", ["Payroll", "Harassment"]]);
  });
  test("escalation fires the highest due level once its hours have passed", () => {
    const t = { createdAt: D("2026-01-01"), firstResponseAt: null, firstResponseDueAt: D("2026-01-02"), dueAt: D("2026-01-05"), assigneeUserId: "u", lastRespondedAt: null, escalationLevel: 0, priority: "HIGH", categoryId: "c1", parentCategoryId: null };
    const rules = [
      { id: "l1", categoryId: null, priority: null, trigger: "FIRST_RESPONSE_BREACH", afterHours: 0, level: 1, isActive: true },
      { id: "l2", categoryId: null, priority: "HIGH", trigger: "FIRST_RESPONSE_BREACH", afterHours: 24, level: 2, isActive: true },
    ];
    assert.equal(dueEscalation(rules, t, new Date(D("2026-01-02").getTime() + H))?.id, "l1");
    assert.equal(dueEscalation(rules, t, D("2026-01-03"))?.id, "l2");
    assert.equal(dueEscalation(rules, { ...t, escalationLevel: 2 }, D("2026-01-09")), null);
    assert.equal(dueEscalation(rules, { ...t, firstResponseAt: D("2026-01-01") }, D("2026-01-09")), null);
  });
  test("least loaded agent, ties rotate", () => {
    assert.equal(leastLoaded(["a", "b", "c"], new Map([["a", 3], ["b", 1], ["c", 1]]), "b"), "c");
    assert.equal(leastLoaded([], new Map(), null), null);
  });
  test("aging buckets", () => assert.equal(agingBucket(D("2026-01-01"), D("2026-01-06")), "4-7 days"));
});

describe("Employee relations", () => {
  test("status flow", () => {
    assert.ok(erCanMove("NEW", "INVESTIGATION"));
    assert.ok(!erCanMove("NEW", "CLOSED"));
    assert.ok(!erCanMove("CLOSED", "NEW"));
  });
  test("progressive discipline flags skipped steps", () => {
    const now = D("2026-06-01");
    assert.equal(disciplinaryLadder([], "FINAL_WARNING", now).skipped, true);
    assert.equal(disciplinaryLadder([{ actionType: "WRITTEN_WARNING", status: "ISSUED", effectiveOn: D("2026-01-01"), expiresOn: D("2026-12-31") }], "FINAL_WARNING", now).skipped, false);
    // An expired written warning does not count.
    assert.equal(disciplinaryLadder([{ actionType: "WRITTEN_WARNING", status: "ISSUED", effectiveOn: D("2025-01-01"), expiresOn: D("2025-06-30") }], "FINAL_WARNING", now).skipped, true);
    assert.equal(disciplinaryLadder([], "TERMINATION", now).skipped, true);
    assert.equal(disciplinaryLadder([], "VERBAL_WARNING", now).skipped, false);
  });
  test("appeal window", () => {
    const a = { status: "ISSUED", issuedAt: D("2026-01-01"), actionType: "WRITTEN_WARNING" };
    assert.ok(appealOpen(a, 15, D("2026-01-10")));
    assert.ok(!appealOpen(a, 15, D("2026-01-20")));
    assert.ok(!appealOpen({ ...a, actionType: "COUNSELLING" }, 15, D("2026-01-02")));
  });
  test("suspension days are inclusive", () => assert.equal(suspensionDays(D("2026-01-01"), D("2026-01-05")), 5));
  test("the subject never sees the case; confidential needs approve or access", () => {
    const c = { isConfidential: true, subjectEmployeeId: "e1", ownerUserId: "own" };
    const v = { userId: "u", employeeId: "e2", canManage: true, canApprove: false, onAccessList: false };
    assert.equal(erCanView(c, v), false);
    assert.equal(erCanView(c, { ...v, onAccessList: true }), true);
    assert.equal(erCanView({ ...c, isConfidential: false }, v), true);
    assert.equal(erCanView(c, { ...v, employeeId: "e1", canApprove: true, onAccessList: true }), false);
  });
});

describe("E-signature", () => {
  const rs = [
    { id: "1", order: 1, role: "SIGNER", status: "SIGNED" },
    { id: "2", order: 2, role: "SIGNER", status: "WAITING" },
    { id: "3", order: 2, role: "APPROVER", status: "WAITING" },
    { id: "4", order: 3, role: "SIGNER", status: "WAITING" },
    { id: "5", order: 1, role: "CC", status: "WAITING" },
  ];
  test("sequential signing activates the earliest unfinished order (ties in parallel)", () => assert.deepEqual(activeRecipients(rs, true).map((r) => r.id), ["2", "3"]));
  test("parallel signing activates everyone open", () => assert.deepEqual(activeRecipients(rs, false).map((r) => r.id), ["2", "3", "4"]));
  test("outcome", () => {
    assert.equal(envelopeOutcome(rs), "IN_PROGRESS");
    assert.equal(envelopeOutcome(rs.map((r) => (r.role === "CC" ? r : { ...r, status: "SIGNED" }))), "COMPLETED");
    assert.equal(envelopeOutcome([...rs, { id: "6", order: 4, role: "SIGNER", status: "DECLINED" }]), "DECLINED");
  });
  test("reminders follow the cadence from the last reminder", () => {
    const r = { status: "PENDING", remindedAt: null, createdAt: D("2026-01-01") };
    assert.ok(!reminderDue(r, D("2026-01-01"), 3, D("2026-01-03")));
    assert.ok(reminderDue(r, D("2026-01-01"), 3, D("2026-01-04")));
    assert.ok(!reminderDue({ ...r, remindedAt: D("2026-01-04") }, D("2026-01-01"), 3, D("2026-01-05")));
    assert.ok(!reminderDue(r, D("2026-01-01"), null, D("2026-02-01")));
  });
});

describe("Documents", () => {
  test("expiry stages", () => {
    const now = D("2026-01-01");
    assert.deepEqual([expiryStage(null, now), expiryStage(D("2026-03-01"), now), expiryStage(D("2026-01-20"), now), expiryStage(D("2026-01-05"), now), expiryStage(D("2025-12-31"), now)], [0, 0, 1, 2, 3]);
  });
  test("employee number from a bulk-upload filename", () => {
    assert.equal(employeeNumberFromFilename("acm0009_passport.pdf"), "ACM0009");
    assert.equal(employeeNumberFromFilename("ACM0012-visa.png"), "ACM0012");
    assert.equal(employeeNumberFromFilename("passport scan.pdf"), null);
  });
  test("completeness ignores not-applicable", () => assert.deepEqual(documentCompleteness([{ mandatory: true, status: "VERIFIED" }, { mandatory: true, status: "PENDING" }, { mandatory: true, status: "NOT_APPLICABLE" }, { mandatory: false, status: "PENDING" }]), { required: 2, done: 1, percent: 50 }));
  test("confidential folders need a role or a grant", () => {
    const f = { isConfidential: true, viewRoles: ["HR_MANAGER"], editRoles: [] };
    const v = { roleNames: ["HR_EXECUTIVE"], isOwnDocument: false, hasGrant: false, grantCanEdit: false, canManageAll: true };
    assert.equal(folderAllows(f, v, "view"), false);
    assert.equal(folderAllows(f, { ...v, hasGrant: true }, "view"), true);
    assert.equal(folderAllows(f, { ...v, hasGrant: true, canManageAll: false }, "edit"), false);
    assert.equal(folderAllows(f, { ...v, roleNames: ["HR_MANAGER"] }, "view"), true);
    assert.equal(folderAllows(f, { ...v, isOwnDocument: true }, "view"), true);
    assert.equal(folderAllows({ ...f, isConfidential: false, viewRoles: [] }, v, "view"), true);
  });
});

describe("HR letters", () => {
  test("number format tokens", () => assert.equal(formatLetterNumber("HR/{YYYY}/{CAT}/", 4, 42, D("2026-03-05"), "offer"), "HR/2026/OFFE/0042"));
  test("yearly reset", () => {
    assert.deepEqual(nextSeriesNumber({ nextNumber: 57, yearlyReset: true, lastYear: 2025 }, D("2026-01-02")), { use: 1, next: 2, year: 2026 });
    assert.equal(nextSeriesNumber({ nextNumber: 57, yearlyReset: false, lastYear: 2025 }, D("2026-01-02")).use, 57);
  });
  test("conditional sections", () => {
    const body = "Dear X,{{#if bonus}} bonus {{bonus}}{{else}} no bonus{{/if}}.{{#unless notice}} No notice.{{/unless}}";
    assert.equal(applyConditionals(body, { bonus: "5000" }), "Dear X, bonus {{bonus}}. No notice.");
    assert.equal(applyConditionals(body, { notice: "30" }), "Dear X, no bonus.");
  });
  test("issue date limits", () => {
    assert.equal(issueDateProblem(D("2026-01-01"), D("2026-01-10"), 30), null);
    assert.match(issueDateProblem(D("2025-11-01"), D("2026-01-10"), 30) ?? "", /backdated/);
    assert.match(issueDateProblem(D("2026-03-01"), D("2026-01-10"), 30) ?? "", /ahead/);
  });
});

describe("Assets", () => {
  test("checklists report missing required items", () => {
    const items = parseChecklistItems([{ label: "Charger", required: true, done: true }, { label: "Data wiped", required: true }, { label: "Bag", required: false }, { nope: 1 }]);
    assert.equal(items.length, 3);
    assert.deepEqual(checklistMissing(items), ["Data wiped"]);
  });
  test("reservation overlaps ignore cancelled bookings", () => {
    const ex = [{ fromDate: D("2026-01-05"), toDate: D("2026-01-07"), status: "APPROVED" }, { fromDate: D("2026-01-10"), toDate: D("2026-01-12"), status: "CANCELLED" }];
    assert.ok(reservationOverlaps(ex, D("2026-01-07"), D("2026-01-08")));
    assert.ok(!reservationOverlaps(ex, D("2026-01-10"), D("2026-01-11")));
  });
  test("stock shortfalls", () => assert.deepEqual(stockShortfalls([{ assetTypeId: "t1", minAvailable: 3 }, { assetTypeId: "t2", minAvailable: 1 }], new Map([["t1", 1], ["t2", 4]])).map((s) => [s.assetTypeId, s.short]), [["t1", 2]]));
  test("reconciliation summary", () => assert.deepEqual(reconciliationSummary([
    { found: true, expectedLocation: "BLR", foundLocation: "BLR", expectedStatus: "AVAILABLE", foundCondition: "GOOD" },
    { found: true, expectedLocation: "BLR", foundLocation: "HYD", expectedStatus: "AVAILABLE", foundCondition: "GOOD" },
    { found: false, expectedLocation: "BLR", foundLocation: null, expectedStatus: "ASSIGNED", foundCondition: null },
    { found: null, expectedLocation: null, foundLocation: null, expectedStatus: "AVAILABLE", foundCondition: null },
  ]), { total: 4, checked: 3, found: 2, missing: 1, misplaced: 1, unchecked: 1 }));
  test("month arithmetic clamps to the month's end", () => assert.equal(cdAddMonths(D("2026-01-31"), 1).toISOString().slice(0, 10), "2026-02-28"));
});

describe("Workflow and retention registration", () => {
  test("every cases/docs route is a known workflow entity type", () => {
    for (const k of Object.keys(CASES_DOCS_ROUTES)) assert.ok(k in WORKFLOW_ENTITY_TYPES, k);
  });
  test("retention covers ER cases and document versions", () => {
    assert.ok("ER_CASES" in RETENTION_DATA_TYPES);
    assert.ok("DOCUMENT_VERSIONS" in RETENTION_DATA_TYPES);
  });
});
