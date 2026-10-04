import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stepApplies, nextApplicableStep, pickDefinition, validateWorkflowSubmission, finalApprovers, stepOutcome, dueAtFor, parseActions, renderTemplate,
  dateTriggerOccurrence, normaliseCidr, ipInCidr, ipAllowed, canonicalJson, auditEntryHash, verifyChain, GENESIS_HASH, retentionCutoff, isInactive,
  orphanReason, nextDueDate, complianceStatus, complianceScore, daysUntil, seededSample, type StepSpec, type AuditLike, type AccountLike,
} from "../src/governance-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Workflow routing", () => {
  const step = (o: number, extra: Partial<StepSpec> = {}): StepSpec => ({ order: o, name: `S${o}`, approverType: "MANAGER", ...extra });

  test("amount conditions", () => {
    const s = { conditionField: "amount", conditionOp: "GT", conditionValue: "50000" };
    assert.equal(stepApplies(s, { amount: 60000 }), true);
    assert.equal(stepApplies(s, { amount: 50000 }), false);
    assert.equal(stepApplies({ ...s, conditionOp: "GTE" }, { amount: 50000 }), true);
    assert.equal(stepApplies({ ...s, conditionOp: "LT" }, { amount: null }), true);
    assert.equal(stepApplies({ ...s, conditionValue: "abc" }, { amount: 1 }), false);
  });

  test("equality conditions and no condition", () => {
    assert.equal(stepApplies({ conditionField: null, conditionOp: null, conditionValue: null }, {}), true);
    assert.equal(stepApplies({ conditionField: "department", conditionOp: "EQ", conditionValue: "d1" }, { departmentId: "d1" }), true);
    assert.equal(stepApplies({ conditionField: "department", conditionOp: "NEQ", conditionValue: "d1" }, { departmentId: "d1" }), false);
    assert.equal(stepApplies({ conditionField: "privileged", conditionOp: "EQ", conditionValue: "true" }, { privileged: true }), true);
    assert.equal(stepApplies({ conditionField: "category", conditionOp: "GT", conditionValue: "x" }, { category: "x" }), false);
    assert.equal(stepApplies({ conditionField: "bogus", conditionOp: "EQ", conditionValue: "" }, {}), false);
  });

  test("skips steps whose condition fails", () => {
    const steps = [step(0), step(1, { conditionField: "amount", conditionOp: "GT", conditionValue: "1000" }), step(2)];
    assert.equal(nextApplicableStep(steps, 1, { amount: 10 }), 2);
    assert.equal(nextApplicableStep(steps, 1, { amount: 5000 }), 1);
    assert.equal(nextApplicableStep(steps, 3, {}), -1);
  });

  test("picks the most specific definition", () => {
    const base = { priority: 0, createdAt: d("2026-01-01") };
    const defs = [
      { id: "any", matchDepartmentId: null, matchLocationId: null, ...base },
      { id: "dept", matchDepartmentId: "d1", matchLocationId: null, ...base },
      { id: "both", matchDepartmentId: "d1", matchLocationId: "l1", ...base },
      { id: "other", matchDepartmentId: "d2", matchLocationId: null, ...base, priority: 99 },
    ];
    assert.equal(pickDefinition(defs, { departmentId: "d1", locationId: "l1" })?.id, "both");
    assert.equal(pickDefinition(defs, { departmentId: "d1", locationId: "l9" })?.id, "dept");
    assert.equal(pickDefinition(defs, { departmentId: "d9" })?.id, "any");
    assert.equal(pickDefinition([], {}), null);
  });

  test("submission validation", () => {
    const rules = [{ field: "amount" as const, op: "MAX" as const, value: 100 }, { field: "details" as const, op: "MIN_LENGTH" as const, value: 5, message: "Say more." }];
    assert.deepEqual(validateWorkflowSubmission(rules, { amount: 50, details: "enough detail" }), []);
    assert.deepEqual(validateWorkflowSubmission(rules, { amount: 500, details: "no" }), ["amount cannot exceed 100.", "Say more."]);
    assert.deepEqual(validateWorkflowSubmission([{ field: "amount", op: "REQUIRED" }], { amount: null }), ["amount is required."]);
    assert.deepEqual(validateWorkflowSubmission(null, {}), []);
  });

  test("approvers exclude the requester, follow delegation, dedupe", () => {
    const del = new Map([["boss", "deputy"], ["x", "req"]]);
    assert.deepEqual(finalApprovers(["req", "boss", "deputy", "x", ""], "req", del), [{ approver: "deputy", delegatedFrom: "boss" }, { approver: "x", delegatedFrom: null }]);
  });

  test("parallel any / all", () => {
    assert.equal(stepOutcome("ANY", ["PENDING", "APPROVED"]), "APPROVED");
    assert.equal(stepOutcome("ALL", ["PENDING", "APPROVED"]), "PENDING");
    assert.equal(stepOutcome("ALL", ["APPROVED", "APPROVED", "ESCALATED"]), "APPROVED");
    assert.equal(stepOutcome("ALL", ["APPROVED", "REJECTED"]), "REJECTED");
    assert.equal(stepOutcome("ALL", ["CANCELLED"]), "PENDING");
  });

  test("SLA due dates", () => {
    assert.equal(dueAtFor(24, d("2026-01-01"))?.toISOString(), "2026-01-02T00:00:00.000Z");
    assert.equal(dueAtFor(0, d("2026-01-01")), null);
    assert.equal(dueAtFor(null, d("2026-01-01")), null);
  });
});

describe("Automation", () => {
  test("parses only known actions", () => {
    assert.deepEqual(parseActions([{ type: "EMAIL", to: "HR" }, { type: "NUKE" }, null, "x"]), [{ type: "EMAIL", to: "HR" }]);
    assert.deepEqual(parseActions("nope"), []);
  });
  test("templates", () => {
    assert.equal(renderTemplate("Hi {{ name }}, due {{date}}{{missing}}", { name: "Asha", date: "2026-01-02" }), "Hi Asha, due 2026-01-02");
  });
  test("date triggers", () => {
    assert.equal(dateTriggerOccurrence("PROBATION_END", d("2026-03-10"), d("2026-03-03"), 7)?.toISOString().slice(0, 10), "2026-03-10");
    assert.equal(dateTriggerOccurrence("PROBATION_END", d("2026-03-10"), d("2026-03-04"), 7), null);
    assert.equal(dateTriggerOccurrence("BIRTHDAY", d("1990-05-20"), d("2026-05-20"), 0)?.toISOString().slice(0, 10), "2026-05-20");
    assert.equal(dateTriggerOccurrence("BIRTHDAY", d("1992-02-29"), d("2026-02-28"), 0)?.toISOString().slice(0, 10), "2026-02-28");
    assert.equal(dateTriggerOccurrence("WORK_ANNIVERSARY", d("2026-04-01"), d("2026-04-01"), 0), null, "joining day is not an anniversary");
    assert.equal(dateTriggerOccurrence("WORK_ANNIVERSARY", d("2024-04-01"), d("2026-03-31"), 1)?.toISOString().slice(0, 10), "2026-04-01");
    assert.equal(dateTriggerOccurrence("CONTRACT_END", null, d("2026-01-01"), 0), null);
  });
});

describe("IP allowlist", () => {
  test("normalises", () => {
    assert.equal(normaliseCidr(" 10.0.0.1 "), "10.0.0.1/32");
    assert.equal(normaliseCidr("2001:DB8::/32"), "2001:db8::/32");
    assert.equal(normaliseCidr("10.0.0.0/33"), null);
    assert.equal(normaliseCidr("300.1.1.1"), null);
    assert.equal(normaliseCidr("office"), null);
  });
  test("matches IPv4, IPv6 and mapped addresses", () => {
    assert.equal(ipInCidr("203.0.113.77", "203.0.113.0/24"), true);
    assert.equal(ipInCidr("203.0.114.1", "203.0.113.0/24"), false);
    assert.equal(ipInCidr("::ffff:203.0.113.5", "203.0.113.0/24"), true);
    assert.equal(ipInCidr("2001:db8:1::5", "2001:db8::/32"), true);
    assert.equal(ipInCidr("2001:db9::5", "2001:db8::/32"), false);
    assert.equal(ipInCidr("1.2.3.4", "0.0.0.0/0"), true);
    assert.equal(ipInCidr("::1", "::1/128"), true);
  });
  test("enforcement", () => {
    assert.equal(ipAllowed("9.9.9.9", ["10.0.0.0/8"], false), true);
    assert.equal(ipAllowed("9.9.9.9", [], true), true, "an empty list never locks everyone out");
    assert.equal(ipAllowed(null, ["10.0.0.0/8"], true), false);
    assert.equal(ipAllowed("10.1.2.3", ["192.168.0.0/16", "10.0.0.0/8"], true), true);
  });
});

describe("Audit hash chain", () => {
  const row = (id: string, summary: string): AuditLike => ({ id, createdAt: d("2026-01-01"), module: "SYSTEM", action: "CREATE", entityType: "X", entityId: null, summary, actorId: null, actorLabel: "system", oldValue: null, newValue: { b: 1, a: [1, { z: 2, y: 1 }] } });
  const chain = (rows: AuditLike[]) => {
    let prev = GENESIS_HASH;
    return rows.map((r, i) => { const hash = auditEntryHash(prev, r); const s = { seq: i + 1, auditLogId: r.id, prevHash: prev, hash }; prev = hash; return s; });
  };
  test("canonical JSON sorts keys", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: null, c: [2, 1] } }), '{"a":{"c":[2,1],"d":null},"b":1}');
  });
  test("intact chain verifies", () => {
    const rows = [row("a", "one"), row("b", "two"), row("c", "three")];
    assert.deepEqual(verifyChain(chain(rows), new Map(rows.map((r) => [r.id, r]))), { checked: 3, problems: [] });
  });
  test("detects altered, missing and relinked entries", () => {
    const rows = [row("a", "one"), row("b", "two"), row("c", "three")];
    const seals = chain(rows);
    const altered = new Map(rows.map((r) => [r.id, r.id === "b" ? { ...r, summary: "edited" } : r]));
    assert.deepEqual(verifyChain(seals, altered).problems, [{ seq: 2, auditLogId: "b", problem: "ALTERED" }]);
    const missing = new Map(rows.filter((r) => r.id !== "c").map((r) => [r.id, r]));
    assert.deepEqual(verifyChain(seals, missing).problems, [{ seq: 3, auditLogId: "c", problem: "MISSING" }]);
    const dropped = [seals[0]!, seals[2]!];
    assert.equal(verifyChain(dropped, new Map(rows.map((r) => [r.id, r]))).problems[0]?.problem, "BROKEN_LINK");
  });
});

describe("Retention, accounts, compliance", () => {
  const acct = (x: Partial<AccountLike>): AccountLike => ({ userId: "u", email: "e", loginDisabled: false, isDeactivated: false, lastLoginAt: null, createdAt: d("2026-01-01"), employeeStatus: "CONFIRMED", roleCount: 0, ...x });
  test("retention cutoff is whole days back from today", () => {
    assert.equal(retentionCutoff(new Date("2026-10-04T15:00:00Z"), 30).toISOString(), "2026-09-04T00:00:00.000Z");
  });
  test("inactive accounts", () => {
    const now = d("2026-10-01");
    assert.equal(isInactive(acct({ lastLoginAt: d("2026-06-01") }), now, 90), true);
    assert.equal(isInactive(acct({ lastLoginAt: d("2026-09-01") }), now, 90), false);
    assert.equal(isInactive(acct({ createdAt: d("2026-09-20") }), now, 90), false, "a new login is not inactive");
    assert.equal(isInactive(acct({ lastLoginAt: d("2020-01-01"), loginDisabled: true }), now, 90), false);
  });
  test("orphan accounts", () => {
    assert.equal(orphanReason(acct({ employeeStatus: null, roleCount: 2 })), "No employee record, holds roles");
    assert.equal(orphanReason(acct({ employeeStatus: "EXITED" })), "Employee has exited");
    assert.equal(orphanReason(acct({})), null);
    assert.equal(orphanReason(acct({ employeeStatus: "EXITED", loginDisabled: true })), null);
  });
  test("recurring due dates clamp to month end", () => {
    assert.equal(nextDueDate("MONTHLY", d("2026-01-31"))?.toISOString().slice(0, 10), "2026-02-28");
    assert.equal(nextDueDate("QUARTERLY", d("2026-11-15"))?.toISOString().slice(0, 10), "2027-02-15");
    assert.equal(nextDueDate("ANNUAL", d("2028-02-29"))?.toISOString().slice(0, 10), "2029-02-28");
    assert.equal(nextDueDate("ONE_TIME", d("2026-01-01")), null);
  });
  test("display status and score", () => {
    const now = d("2026-10-04");
    assert.equal(complianceStatus("OPEN", d("2026-10-01"), now), "OVERDUE");
    assert.equal(complianceStatus("IN_PROGRESS", d("2026-10-10"), now), "DUE_SOON");
    assert.equal(complianceStatus("IN_PROGRESS", d("2026-12-10"), now), "IN_PROGRESS");
    assert.equal(complianceStatus("COMPLETED", d("2026-01-01"), now), "COMPLETED");
    assert.equal(complianceScore([], now), null);
    assert.equal(complianceScore([
      { status: "COMPLETED", dueOn: d("2026-09-01"), completedAt: d("2026-08-30") },
      { status: "OPEN", dueOn: d("2026-09-15"), completedAt: null },
      { status: "OPEN", dueOn: d("2026-12-15"), completedAt: null },
    ], now), 50);
    assert.equal(daysUntil(d("2026-10-01"), now), -3);
  });
  test("seeded sample is reproducible", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(seededSample(xs, 5, "audit-2026"), seededSample(xs, 5, "audit-2026"));
    assert.notDeepEqual(seededSample(xs, 5, "audit-2026"), seededSample(xs, 5, "other"));
    assert.equal(seededSample(xs, 100, "s").length, 50);
  });
});
