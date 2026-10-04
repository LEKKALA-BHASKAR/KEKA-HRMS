import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanChanges, diffChanges, fieldLabel, canDecideChange, statusOnApproval, suggestFiscalYear, fiscalYearIssues, fiscalYearOn,
  tenure, tenureRange, delegationActive, delegationIssues, wouldCreateCycle, spanOfControl, idCardNumber, idCardValidity, idCardStatus,
  parseChecklistItems, checklistProgress, planMassUpdate, cleanDirectoryQuery, freshness, CHANGE_TARGETS,
} from "../src/core-hr-depth-math";
import { typedChanges, correctionIssue } from "../src/core-hr-depth";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test("a change request keeps only the fields its target allows", () => {
  const c = cleanChanges("CONTACT", { mobile: " 98450 12345 ", personalEmail: "", salary: 1_000_000, tenantId: "other" });
  assert.deepEqual(c, { mobile: "98450 12345", personalEmail: null });
  assert.ok(Object.values(CHANGE_TARGETS).every((t) => t.fields.length > 0));
});

test("the diff lists only fields that change, old to new", () => {
  assert.deepEqual(diffChanges({ mobile: "1", city: "Pune" }, { mobile: "2", city: "Pune", line1: "MG Road" }), [
    { field: "mobile", from: "1", to: "2" },
    { field: "line1", from: null, to: "MG Road" },
  ]);
  assert.equal(fieldLabel("dateOfBirth"), "Date of birth");
  assert.equal(fieldLabel("headId"), "Head");
});

test("nobody decides their own request; managers decide manager requests; HR decides all", () => {
  const req = { requestedBy: "u1", approverType: "MANAGER", employeeId: "e1" };
  const mgr = (ids: string[]) => (id: string) => ids.includes(id);
  assert.equal(canDecideChange(req, { userId: "u1", isHr: true, managerOf: mgr(["e1"]) }).ok, false);
  assert.equal(canDecideChange(req, { userId: "u2", isHr: false, managerOf: mgr(["e1"]) }).ok, true);
  assert.equal(canDecideChange(req, { userId: "u2", isHr: false, managerOf: mgr(["e9"]) }).ok, false);
  assert.equal(canDecideChange({ ...req, approverType: "HR" }, { userId: "u2", isHr: false, managerOf: mgr(["e1"]) }).ok, false);
  assert.equal(canDecideChange({ ...req, approverType: "HR" }, { userId: "u3", isHr: true, managerOf: mgr([]) }).ok, true);
});

test("an approved change waits for a future effective date", () => {
  assert.equal(statusOnApproval(null, d("2026-10-04")), "APPLIED");
  assert.equal(statusOnApproval(d("2026-10-04"), new Date("2026-10-04T15:00:00Z")), "APPLIED");
  assert.equal(statusOnApproval(d("2026-11-01"), d("2026-10-04")), "SCHEDULED");
});

test("fiscal years: suggested names and dates, and overlap checks within a calendar set", () => {
  const fy = suggestFiscalYear(4, 2026);
  assert.equal(fy.name, "FY 2026-27");
  assert.equal(fy.startDate.toISOString().slice(0, 10), "2026-04-01");
  assert.equal(fy.endDate.toISOString().slice(0, 10), "2027-03-31");
  assert.equal(suggestFiscalYear(1, 2026).name, "FY 2026");
  const existing = [{ id: "a", name: "FY 2026-27", calendarSet: "STATUTORY", startDate: d("2026-04-01"), endDate: d("2027-03-31") }];
  assert.match(fiscalYearIssues({ calendarSet: "STATUTORY", startDate: d("2027-01-01"), endDate: d("2027-12-31") }, existing).join(" "), /overlaps FY 2026-27/);
  assert.deepEqual(fiscalYearIssues({ calendarSet: "LEAVE", startDate: d("2027-01-01"), endDate: d("2027-12-31") }, existing), []);
  assert.deepEqual(fiscalYearIssues({ id: "a", calendarSet: "STATUTORY", startDate: d("2026-04-01"), endDate: d("2027-03-31") }, existing), []);
  assert.match(fiscalYearIssues({ calendarSet: "STATUTORY", startDate: d("2028-04-01"), endDate: d("2028-03-31") }, existing).join(" "), /after the start/);
  assert.match(fiscalYearIssues({ calendarSet: "STATUTORY", startDate: d("2028-04-01"), endDate: d("2030-03-31") }, existing).join(" "), /18 months/);
  assert.equal(fiscalYearOn(existing, d("2026-12-25"))?.id, "a");
  assert.equal(fiscalYearOn(existing, d("2027-04-01")), null);
});

test("tenure in years and months, and tenure bands as joining-date ranges", () => {
  assert.deepEqual(tenure(d("2020-04-15"), d("2026-10-04")), { years: 6, months: 5, days: 19, label: "6 yrs 5 mo" });
  assert.equal(tenure(d("2026-09-30"), d("2026-10-04")).label, "4 days");
  assert.equal(tenure(d("2027-01-01"), d("2026-10-04")).label, "Not joined yet");
  const r = tenureRange("1to3", d("2026-10-04"))!;
  assert.equal(r.gt!.toISOString().slice(0, 10), "2023-10-04");
  assert.equal(r.lte!.toISOString().slice(0, 10), "2025-10-04");
  assert.equal(tenureRange("10plus", d("2026-10-04"))!.gt, undefined);
  assert.equal(tenureRange("bogus"), null);
});

test("delegations: active window, overlaps, ping-pong and self", () => {
  const del = { delegatorId: "m", delegateId: "x", startDate: d("2026-10-01"), endDate: d("2026-10-10") };
  assert.equal(delegationActive(del, new Date("2026-10-10T20:00:00Z")), true);
  assert.equal(delegationActive(del, d("2026-10-11")), false);
  assert.equal(delegationActive({ ...del, revokedAt: d("2026-10-02") }, d("2026-10-05")), false);
  assert.deepEqual(delegationIssues({ ...del, startDate: d("2026-11-01"), endDate: d("2026-11-02") }, [del]), []);
  assert.match(delegationIssues({ ...del, startDate: d("2026-10-05"), endDate: d("2026-10-20") }, [del]).join(" "), /overlaps/);
  assert.match(delegationIssues({ delegatorId: "x", delegateId: "m", startDate: d("2026-10-05"), endDate: d("2026-10-06") }, [del]).join(" "), /same dates/);
  assert.match(delegationIssues({ ...del, delegateId: "m" }, []).join(" "), /someone other/);
});

test("reporting-line cycles are caught", () => {
  const managerOf = new Map<string, string | null>([["a", null], ["b", "a"], ["c", "b"]]);
  assert.equal(wouldCreateCycle("a", "c", managerOf), true);
  assert.equal(wouldCreateCycle("c", "a", managerOf), false);
  assert.equal(wouldCreateCycle("b", "b", managerOf), true);
});

test("span of control flags managers above the limit, widest first", () => {
  const s = spanOfControl([{ managerId: "a", name: "A", reports: 3 }, { managerId: "b", name: "B", reports: 14 }], 12);
  assert.deepEqual(s.map((x) => [x.managerId, x.over]), [["b", true], ["a", false]]);
});

test("ID card numbers, validity and status", () => {
  assert.equal(idCardNumber("acme", "EMP-0042", "7k3q9"), "ACME-EMP0042-7K3Q");
  const issued = d("2026-10-04");
  assert.equal(idCardValidity(issued).toISOString().slice(0, 10), "2028-10-04");
  assert.equal(idCardStatus({ status: "ACTIVE", validUntil: d("2028-10-04") }, issued), "VALID");
  assert.equal(idCardStatus({ status: "ACTIVE", validUntil: d("2026-10-03") }, issued), "EXPIRED");
  assert.equal(idCardStatus({ status: "REVOKED", validUntil: d("2028-10-04") }, issued), "REVOKED");
});

test("checklist items parse with owners and progress counts", () => {
  assert.deepEqual(parseChecklistItems("Collect PAN | hr\n\nIssue laptop|MANAGER\nSign NDA | someone"), [
    { title: "Collect PAN", owner: "HR" }, { title: "Issue laptop", owner: "MANAGER" }, { title: "Sign NDA", owner: "HR" },
  ]);
  assert.deepEqual(checklistProgress([{ done: true }, { done: false }]), { done: 1, total: 2, percent: 50, complete: false });
  assert.equal(checklistProgress([]).complete, false);
});

test("a mass update plan skips leavers, no-ops, self-reporting and people on notice", () => {
  const plan = planMassUpdate("STATUS", "INACTIVE", [
    { id: "1", label: "A", status: "CONFIRMED", current: "CONFIRMED" },
    { id: "2", label: "B", status: "EXITED", current: "EXITED" },
    { id: "3", label: "C", status: "INACTIVE", current: "INACTIVE" },
    { id: "4", label: "D", status: "NOTICE_PERIOD", current: "NOTICE_PERIOD" },
  ]);
  assert.deepEqual(plan.map((p) => p.action), ["APPLY", "SKIP", "SKIP", "SKIP"]);
  assert.equal(planMassUpdate("MANAGER", "9", [{ id: "9", label: "M", status: "CONFIRMED", current: "1" }])[0].reason, "Cannot report to themselves");
});

test("saved directory searches keep only directory filters", () => {
  assert.equal(cleanDirectoryQuery("?q=ana&dept=d1&evil=1&mgr=&tenure=1to3"), "q=ana&dept=d1&tenure=1to3");
  assert.equal(freshness(d("2026-10-04"), d("2026-10-04")).label, "Updated today");
  assert.equal(freshness(d("2026-01-01"), d("2026-10-04")).stale, true);
});

test("JSON changes come back as dates, numbers and booleans", () => {
  const t = typedChanges({ dateOfBirth: "1990-05-01", fromYear: "2010", isNominee: "true", name: "Ravi", city: "" });
  assert.equal((t.dateOfBirth as Date).toISOString().slice(0, 10), "1990-05-01");
  assert.equal(t.fromYear, 2010);
  assert.equal(t.isNominee, true);
  assert.equal(t.city, null);
});

test("data corrections validate the field and the value", () => {
  assert.equal(correctionIssue("salary", "1"), "That field cannot be corrected through a request.");
  assert.equal(correctionIssue("dateOfBirth", "01/05/1990"), "Use a date like 2026-04-01.");
  assert.equal(correctionIssue("gender", "MALE"), null);
  assert.match(correctionIssue("personalEmail", "nope")!, /email/);
  assert.equal(correctionIssue("mobile", "+91 98450 12345"), null);
});
