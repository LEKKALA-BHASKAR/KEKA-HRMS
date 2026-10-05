import { test } from "node:test";
import assert from "node:assert/strict";
import {
  core2BuiltInRoute, isCore2WorkflowEntityType, validateConfigPayload, configSummary, diffConfigPayloads, parameterHistory, setupCompleteness, entityReadiness,
  hierarchyCycle, ancestorsOf, flattenTree, descendantsOf, resolveInherited, inheritLocationFields, recordAsOf, compareOrgSnapshots, normaliseReorgMoves, reorgImpact,
  matchTransferRule, transferRuleIssues, taxRegistrationIssue, proposePayrollCalendar, nextDeadline, normaliseRelationship, dependentRelationIssue,
  findDuplicatePeople, completenessGaps, nomineeShareIssues, privacyDueDate, notificationAudience, hrAgingBucket, slaState, pickQcSample, buildVCard,
  coworkerSuggestions, dataFreshness, formatCompanyDate, formatCompanyNumber, serviceTimeline, referenceTemplateCsv, validateReferenceRows,
  APPROVAL_POLICY_LIBRARY, type ConfigPayload, type SetupFacts, type TransferRuleLike, type OrgSnapshotPayload,
} from "../src/core2-math";
import { encodeQr, qrSvg, qrByteCapacity } from "../src/core2-qr";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const cfg = (sections: ConfigPayload["sections"]): ConfigPayload => ({ format: "boos-hr-config", version: 1, exportedAt: "2026-10-01T00:00:00Z", sections });

test("core HR requests route to the right approvers by default", () => {
  assert.ok(isCore2WorkflowEntityType("PRIVACY_REQUEST"));
  assert.equal(isCore2WorkflowEntityType("LEAVE"), false);
  assert.equal(core2BuiltInRoute("LEAVE"), null);
  assert.equal(core2BuiltInRoute("PRIVACY_REQUEST")![0]!.approverPermission, "admin.compliance.manage");
  assert.equal(core2BuiltInRoute("REORG_PLAN")![0]!.approverPermission, "org.structure.manage");
  assert.equal(core2BuiltInRoute("INTERCOMPANY_ASSIGNMENT")![0]!.approverPermission, "org.legal_entity.manage");
  for (const p of APPROVAL_POLICY_LIBRARY) assert.ok(p.steps.length > 0 && p.steps.every((s, i) => s.order === i + 1), p.key);
});

test("a configuration file is checked before it is applied", () => {
  assert.equal(validateConfigPayload(null).ok, false);
  assert.equal(validateConfigPayload({ format: "other", version: 1, sections: {} }).ok, false);
  const newer = validateConfigPayload({ format: "boos-hr-config", version: 99, sections: {} });
  assert.ok(!newer.ok && newer.issues.some((i) => i.includes("newer")));
  const bad = validateConfigPayload(cfg({ countries: "x" as unknown as [], organisation: { fyStartMonth: 13 }, workingRules: { workDays: [] } }));
  assert.ok(!bad.ok && bad.issues.length === 3);
  const unknown = validateConfigPayload({ ...cfg({}), sections: { secrets: [] } });
  assert.ok(!unknown.ok && unknown.issues[0]!.includes("secrets"));
  const ok = validateConfigPayload(cfg({ organisation: { fyStartMonth: 4 }, countries: [{ countryCode: "IN" }] }));
  assert.ok(ok.ok);
  assert.deepEqual(configSummary(cfg({ organisation: { a: 1, b: 2 }, countries: [{}, {}, {}] })), { organisation: 2, countries: 3 });
});

test("two configuration copies are compared setting by setting", () => {
  const a = cfg({ organisation: { name: "Acme", fyStartMonth: 4 }, countries: [{ countryCode: "IN", isActive: true }, { countryCode: "US", isActive: true }] });
  const b = cfg({ organisation: { name: "Acme", fyStartMonth: 1 }, countries: [{ countryCode: "IN", isActive: false }, { countryCode: "SG", isActive: true }] });
  const diff = diffConfigPayloads(a, b);
  assert.deepEqual(diff.filter((x) => x.section === "organisation").map((x) => [x.key, x.from, x.to]), [["fyStartMonth", "4", "1"]]);
  const countries = diff.filter((x) => x.section === "countries").map((x) => x.key).sort();
  assert.deepEqual(countries, ["IN", "SG", "US"]);
  assert.equal(diff.find((x) => x.key === "US")!.to, null);
  assert.equal(diff.find((x) => x.key === "SG")!.from, null);
  assert.deepEqual(diffConfigPayloads(a, a), []);
  const hist = parameterHistory([
    { id: "3", name: "c", createdAt: d("2026-03-01"), payload: b },
    { id: "1", name: "a", createdAt: d("2026-01-01"), payload: a },
    { id: "2", name: "b", createdAt: d("2026-02-01"), payload: a },
  ], "organisation", "fyStartMonth");
  assert.deepEqual(hist.map((h) => [h.snapshotId, h.value]), [["1", "4"], ["3", "1"]]);
});

test("setup completeness and entity readiness score what is done", () => {
  const empty: SetupFacts = { companyProfile: false, legalEntities: 0, entitiesWithAddress: 0, businessUnits: 0, departments: 0, locations: 0, locationsWithState: 0, holidayCalendars: 0, payGroups: 0, payGroupsWithFiling: 0, leaveTypes: 0, shifts: 0, workingRules: false, fiscalYears: 0, employees: 0, employeesWithManager: 0, employeesWithDepartment: 0, numberSeries: 0, workflowDefinitions: 0, documentTemplates: 0 };
  assert.equal(setupCompleteness(empty).score, 0);
  const full: SetupFacts = { companyProfile: true, legalEntities: 1, entitiesWithAddress: 1, businessUnits: 1, departments: 3, locations: 2, locationsWithState: 2, holidayCalendars: 1, payGroups: 1, payGroupsWithFiling: 1, leaveTypes: 4, shifts: 1, workingRules: true, fiscalYears: 1, employees: 10, employeesWithManager: 9, employeesWithDepartment: 10, numberSeries: 1, workflowDefinitions: 1, documentTemplates: 1 };
  assert.equal(setupCompleteness(full).score, 100);
  const partial = setupCompleteness({ ...full, locationsWithState: 1 });
  assert.ok(partial.score < 100 && partial.items.find((i) => i.key === "locations")!.done === false);
  const r = entityReadiness({ hasAddress: true, hasCin: true, signatories: 1, bankAccounts: 1, payGroups: 1, payGroupsWithFiling: 1, taxTypes: ["PAN", "TAN"], holidayCalendars: 1, payrollMonthsAhead: 3, businessUnits: 1, employees: 5, overdueDeadlines: 0 });
  assert.equal(r.score, 100);
  const late = entityReadiness({ hasAddress: true, hasCin: true, signatories: 1, bankAccounts: 1, payGroups: 1, payGroupsWithFiling: 1, taxTypes: ["PAN"], holidayCalendars: 1, payrollMonthsAhead: 1, businessUnits: 1, employees: 5, overdueDeadlines: 2 });
  assert.equal(late.score, 70);
  assert.equal(late.items.find((i) => i.key === "deadlines")!.detail, "2 overdue");
});

test("hierarchies refuse loops and flatten in order", () => {
  const parentOf = new Map<string, string | null>([["a", null], ["b", "a"], ["c", "b"]]);
  assert.equal(hierarchyCycle("a", "c", parentOf), true);
  assert.equal(hierarchyCycle("a", "a", parentOf), true);
  assert.equal(hierarchyCycle("c", "a", parentOf), false);
  assert.equal(hierarchyCycle("c", null, parentOf), false);
  assert.deepEqual(ancestorsOf("c", parentOf), ["c", "b", "a"]);
  const nodes = [{ id: "c", parentId: "b", name: "Payables" }, { id: "a", parentId: null, name: "Finance" }, { id: "b", parentId: "a", name: "Accounts" }, { id: "x", parentId: null, name: "Admin" }];
  const tree = flattenTree(nodes);
  assert.deepEqual(tree.map((r) => [r.node.id, r.depth]), [["x", 0], ["a", 0], ["b", 1], ["c", 2]]);
  assert.equal(tree[3]!.path, "Finance › Accounts › Payables");
  assert.deepEqual(descendantsOf("a", nodes).sort(), ["b", "c"]);
  const looped = flattenTree([{ id: "p", parentId: "q", name: "P" }, { id: "q", parentId: "p", name: "Q" }]);
  assert.equal(looped.length, 2);
});

test("values are inherited from the nearest unit up the chain", () => {
  const chain = [{ unitType: "DEPARTMENT", unitId: "d" }, { unitType: "BUSINESS_UNIT", unitId: "b" }, { unitType: "LEGAL_ENTITY", unitId: "e" }];
  const vals: Record<string, string> = { b: "BU value", e: "Entity value" };
  const hit = resolveInherited(chain, (u) => vals[u.unitId]);
  assert.deepEqual([hit!.value, hit!.from.unitId, hit!.inherited], ["BU value", "b", true]);
  assert.equal(resolveInherited(chain, () => undefined), null);
  const locs = [{ id: "hq", parentId: null, city: "Bengaluru", timezone: "Asia/Kolkata" }, { id: "fl", parentId: "hq", city: null, timezone: null }];
  const by = new Map(locs.map((l) => [l.id, l]));
  const eff = inheritLocationFields(locs[1]!, by, ["city", "timezone"]);
  assert.deepEqual(eff.city, { value: "Bengaluru", from: "hq" });
});

test("org snapshots show what changed between two dates", () => {
  const recs = [{ effectiveFrom: d("2025-01-01"), effectiveTo: d("2026-01-01"), dept: "A" }, { effectiveFrom: d("2026-01-01"), effectiveTo: null, dept: "B" }];
  assert.equal(recordAsOf(recs, d("2025-06-01"))!.dept, "A");
  assert.equal(recordAsOf(recs, d("2026-02-01"))!.dept, "B");
  assert.equal(recordAsOf(recs, d("2024-01-01")), null);
  const person = (id: string, dept: string, mgr: string | null) => ({ id, number: id, name: id, departmentId: dept, managerId: mgr, locationId: null, legalEntityId: null, businessUnitId: null, title: null });
  const a: OrgSnapshotPayload = { asOf: "2026-01-01", units: [{ id: "u1", type: "DEPARTMENT", name: "Sales", parentId: null, headId: null, isActive: true }], people: [person("p1", "u1", null), person("p2", "u1", "p1")] };
  const b: OrgSnapshotPayload = { asOf: "2026-06-01", units: [{ id: "u1", type: "DEPARTMENT", name: "Revenue", parentId: null, headId: "p1", isActive: true }, { id: "u2", type: "DEPARTMENT", name: "Ops", parentId: null, headId: null, isActive: true }], people: [person("p1", "u1", null), person("p3", "u2", "p1")] };
  const c = compareOrgSnapshots(a, b);
  assert.deepEqual([c.joined.map((p) => p.id), c.left.map((p) => p.id), c.unitsAdded.map((u) => u.id)], [["p3"], ["p2"], ["u2"]]);
  assert.deepEqual(c.unitChanges.map((x) => x.field).sort(), ["head", "name"]);
});

test("a reorganisation shows its impact and catches reporting loops", () => {
  assert.deepEqual(normaliseReorgMoves([{ employeeId: "a", departmentId: "x" }, { employeeId: "a", reportingManagerId: "a" }, { employeeId: "b" }]), [{ employeeId: "a", departmentId: "x" }]);
  const people = [{ id: "m", departmentId: "d1", managerId: null }, { id: "a", departmentId: "d1", managerId: "m" }, { id: "b", departmentId: "d1", managerId: "a" }];
  const impact = reorgImpact(people, [{ employeeId: "b", departmentId: "d2" }, { employeeId: "m", reportingManagerId: "b" }], 1);
  assert.equal(impact.changed, 2);
  assert.deepEqual(impact.headcount.find((h) => h.id === "d2"), { id: "d2", before: 0, after: 1 });
  assert.deepEqual(impact.cycles, ["m"]);
});

test("transfer rules: the most specific rule applies and notice is enforced", () => {
  const rule = (id: string, from: string | null, to: string | null, minNoticeDays = 0): TransferRuleLike => ({ id, fromEntityId: from, toEntityId: to, requiresApproval: true, minNoticeDays, carryForwardLeave: true, restartProbation: false, newEmployeeNumber: false });
  const rules = [rule("any", null, null), rule("fromA", "A", null), rule("AB", "A", "B", 30)];
  assert.equal(matchTransferRule(rules, "A", "B")!.id, "AB");
  assert.equal(matchTransferRule(rules, "A", "C")!.id, "fromA");
  assert.equal(matchTransferRule(rules, "C", "D")!.id, "any");
  assert.equal(matchTransferRule([rule("AB", "A", "B")], "C", "B"), null);
  assert.equal(transferRuleIssues(rules[2]!, d("2026-10-10"), d("2026-10-01")).length, 1);
  assert.deepEqual(transferRuleIssues(rules[2]!, d("2026-12-01"), d("2026-10-01")), []);
  assert.deepEqual(transferRuleIssues(null, d("2026-10-01"), d("2026-10-01")), []);
});

test("entity registrations, payroll calendars and recurring deadlines", () => {
  assert.equal(taxRegistrationIssue("PAN", "abcde1234f"), null);
  assert.ok(taxRegistrationIssue("PAN", "ABC123"));
  assert.ok(taxRegistrationIssue("TAN", "ABCDE1234F"));
  assert.equal(taxRegistrationIssue("GSTIN", "29ABCDE1234F1Z5"), null);
  assert.ok(taxRegistrationIssue("PF", " "));
  const cal = proposePayrollCalendar(2027, { cutoffDay: 25, payDay: 31 });
  assert.equal(cal.length, 12);
  assert.equal(cal[1]!.payDate.toISOString().slice(0, 10), "2027-02-28");
  assert.equal(cal[0]!.inputCutoff.toISOString().slice(0, 10), "2027-01-25");
  assert.equal(nextDeadline(d("2026-01-15"), "QUARTERLY")!.toISOString().slice(0, 10), "2026-04-15");
  assert.equal(nextDeadline(d("2026-01-15"), "ONCE"), null);
});

test("dependents must be a plausible relationship", () => {
  assert.equal(normaliseRelationship("Mother-in-law"), "MOTHER_IN_LAW");
  assert.equal(normaliseRelationship("wife"), "SPOUSE");
  assert.equal(normaliseRelationship("neighbour"), null);
  const dob = d("1990-01-01");
  assert.ok(dependentRelationIssue({ relationship: "neighbour", dateOfBirth: null }, dob, []));
  assert.ok(dependentRelationIssue({ relationship: "Son", dateOfBirth: d("1995-01-01") }, dob, []));
  assert.equal(dependentRelationIssue({ relationship: "Son", dateOfBirth: d("2020-01-01") }, dob, []), null);
  assert.ok(dependentRelationIssue({ relationship: "Father", dateOfBirth: d("1985-01-01") }, dob, []));
  assert.ok(dependentRelationIssue({ relationship: "Husband", dateOfBirth: null }, dob, [{ relationship: "SPOUSE" }]));
});

test("duplicates, completeness gaps and nominee shares", () => {
  const p = (id: string, first: string, extra: Partial<{ dateOfBirth: Date; personalEmail: string; mobile: string; pan: string }> = {}) => ({ id, firstName: first, lastName: "Rao", dateOfBirth: null, personalEmail: null, mobile: null, ...extra });
  const dups = findDuplicatePeople([p("1", "Asha", { dateOfBirth: d("1990-01-01"), pan: "ABCDE1234F" }), p("2", "Asha", { dateOfBirth: d("1990-01-01") }), p("3", "Ravi", { mobile: "+91 98450 12345" }), p("4", "Kiran", { mobile: "9845012345", pan: "abcde1234f" }), p("5", "Asha")]);
  assert.deepEqual(dups.map((x) => [`${x.a}${x.b}`, x.score]), [["14", 80], ["12", 75], ["34", 40]]);
  assert.deepEqual(dups[0]!.reasons, ["Same PAN"]);
  assert.ok(!dups.some((x) => x.a === "1" && x.b === "5"), "a shared name alone is not a duplicate");
  const rules = [{ field: "pan", workerTypeId: null, severity: "ERROR" }, { field: "bandId", workerTypeId: "FT", severity: "WARNING" }, { field: "mobile", workerTypeId: null, severity: "ERROR", isActive: false }];
  assert.deepEqual(completenessGaps({ pan: null, workerTypeId: "FT", bandId: "" }, rules).map((g) => g.field), ["pan", "bandId"]);
  assert.deepEqual(completenessGaps({ pan: "X", workerTypeId: "CT" }, rules), []);
  assert.deepEqual(nomineeShareIssues([{ benefit: "PF", sharePct: 60 }, { benefit: "PF", sharePct: 40 }]), []);
  assert.equal(nomineeShareIssues([{ benefit: "PF", sharePct: 60 }]).length, 1);
  assert.equal(nomineeShareIssues([{ benefit: "XYZ", sharePct: 100 }]).length, 1);
  assert.equal(nomineeShareIssues([{ benefit: "EPS", sharePct: 50.5 }]).length, 1);
});

test("privacy deadlines and notification preferences", () => {
  assert.equal(privacyDueDate("ACCESS", d("2026-10-01")).toISOString().slice(0, 10), "2026-10-31");
  assert.equal(privacyDueDate("DIRECTORY_HIDE", d("2026-10-01")).toISOString().slice(0, 10), "2026-10-08");
  const prefs = [{ userId: "u1", inAppMuted: ["LEAVE"], emailMuted: [], preferredChannel: "BOTH" }, { userId: "u2", inAppMuted: [], emailMuted: [], preferredChannel: "IN_APP" }];
  const leave = notificationAudience("leave", ["u1", "u2", "u3"], prefs);
  assert.deepEqual(leave.inApp, ["u2", "u3"]);
  assert.deepEqual([...leave.emailBlocked], ["u2"]);
  const wf = notificationAudience("WORKFLOW", ["u1", "u2"], prefs);
  assert.deepEqual([wf.inApp.length, wf.emailBlocked.size], [2, 0]);
});

test("HR queue ageing, SLAs and QC sampling", () => {
  const now = d("2026-10-20");
  assert.equal(hrAgingBucket(d("2026-10-19"), now), "0–2 days");
  assert.equal(hrAgingBucket(d("2026-10-10"), now), "8–14 days");
  assert.equal(hrAgingBucket(d("2026-08-01"), now), "Over 30 days");
  const s = slaState(d("2026-10-19"), 48, now);
  assert.deepEqual([s.breached, s.hoursLeft], [false, 24]);
  assert.equal(slaState(d("2026-10-10"), 48, now).breached, true);
  assert.equal(pickQcSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, () => 0.5).length, 1);
  assert.equal(pickQcSample([1, 2, 3], 50).length, 2);
  assert.deepEqual(pickQcSample([], 50), []);
  assert.deepEqual(pickQcSample([1], 0), []);
});

test("contact cards, coworker suggestions and freshness", () => {
  const v = buildVCard({ firstName: "Asha", lastName: "Rao", title: "Engineer, Platform", org: "Acme", department: "Tech", workEmail: "asha@acme.test", note: "Pronouns: she/her" });
  assert.ok(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\nN:Rao;Asha;;;\r\nFN:Asha Rao\r\n"));
  assert.ok(v.includes("TITLE:Engineer\\, Platform") && v.includes("ORG:Acme;Tech") && v.endsWith("END:VCARD\r\n"));
  const me = { id: "me", departmentId: "d", locationId: "l", managerId: "boss", skills: ["ts", "sql"], teams: [], projects: ["p"] };
  const others = [
    { id: "boss", departmentId: "d", locationId: "l", managerId: null, skills: [], teams: [], projects: [] },
    { id: "peer", departmentId: "d", locationId: "l", managerId: "boss", skills: ["ts"], teams: [], projects: [] },
    { id: "far", departmentId: "x", locationId: "l", managerId: "y", skills: [], teams: [], projects: [] },
    { id: "proj", departmentId: "x", locationId: null, managerId: "y", skills: [], teams: [], projects: ["p"] },
  ];
  assert.deepEqual(coworkerSuggestions(me, others).map((s) => s.id), ["peer", "proj"]);
  assert.equal(dataFreshness(d("2026-10-01"), d("2026-10-01")).label, "Updated today");
  assert.equal(dataFreshness(d("2025-01-01"), d("2026-10-01")).level, "STALE");
  assert.equal(dataFreshness(d("2026-03-01"), d("2026-10-01")).level, "AGING");
});

test("company date and number formats, and the service timeline", () => {
  const day = d("2026-03-07");
  assert.equal(formatCompanyDate(day), "07/03/2026");
  assert.equal(formatCompanyDate(day, "MM/DD/YYYY"), "03/07/2026");
  assert.equal(formatCompanyDate(day, "YYYY-MM-DD"), "2026-03-07");
  assert.equal(formatCompanyDate(day, "DD MMM YYYY"), "07 Mar 2026");
  assert.equal(formatCompanyDate(null), "—");
  assert.equal(formatCompanyNumber(1234567), "12,34,567");
  assert.equal(formatCompanyNumber(1234567, "en-US"), "1,234,567");
  const tl = serviceTimeline(d("2023-05-10"), d("2026-01-01"), [{ date: d("2024-07-01"), kind: "PROMOTION", label: "Promoted" }]);
  assert.deepEqual(tl.map((e) => e.kind), ["ANNIVERSARY", "ANNIVERSARY", "PROMOTION", "ANNIVERSARY", "JOINED"]);
  assert.equal(tl[0]!.future, true);
  assert.equal(tl[0]!.label, "3-year work anniversary");
});

test("reference data imports are checked row by row", () => {
  assert.ok(referenceTemplateCsv("DEPARTMENT").startsWith("name,code,parent,business_unit,description\n"));
  const ctx = { existing: new Set(["finance"]), refs: { business_unit: new Set(["corporate"]), parent: new Set<string>() } };
  const res = validateReferenceRows("DEPARTMENT", [["Name", "Code", "Parent", "Business unit"], ["Payables", "AP", "Finance", "Corporate"], ["Payables", "", "", ""], ["Tax", "", "Payables", "Nowhere"], ["Finance", "", "", ""], ["", "", "", ""]], ctx);
  assert.equal(res.headerError, null);
  assert.deepEqual(res.rows.map((r) => [r.name, r.action, r.errors.length]), [["Payables", "CREATE", 0], ["Payables", "CREATE", 1], ["Tax", "CREATE", 1], ["Finance", "UPDATE", 0]]);
  assert.ok(validateReferenceRows("DEPARTMENT", [["code", "name"]], ctx).headerError);
  assert.ok(validateReferenceRows("DEPARTMENT", [["name", "colour"]], ctx).headerError);
  assert.equal(validateReferenceRows("LOCATION", [["name", "state_code"], ["Pune", "MAH"]], ctx).rows[0]!.errors.length, 1);
});

test("the ID card QR code matches a known-good encoding", () => {
  const expected = ["111111100001101111111", "100000100000101000001", "101110101001001011101", "101110101001001011101", "101110101100101011101", "100000101001001000001", "111111101010101111111", "000000001100000000000", "101111100001001111100", "000100010001111101001", "111010110110101101010", "101000001111111111101", "000110110100100100000", "000000001110100001000", "111111100111010001010", "100000101000000101111", "101110101101010111110", "101110101101111100100", "101110101000101001000", "100000100101111000100", "111111101010100010010"];
  const qr = encodeQr("BooS-HR", { mask: 2 });
  assert.deepEqual([qr.version, qr.mask, qr.size], [1, 2, 21]);
  assert.deepEqual(qr.modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")), expected);
  assert.equal(qrByteCapacity(1), 14);
  const long = encodeQr("https://acme.boos-hr.test/verify/id/ACME-ID-2026-00042");
  assert.ok(long.version >= 3 && long.size === 17 + 4 * long.version);
  const svg = qrSvg("BooS-HR");
  assert.ok(svg.startsWith("<svg") && svg.includes("</svg>"));
});
