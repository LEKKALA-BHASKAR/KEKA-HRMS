import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseBooleanQuery, matchesBoolean, candidateHaystack, tagsFor, wildcardMatch, attributeSource, parseSegmentRules, segmentMatches,
  recommendationScore, sourceAnalytics, balanceAssignments, isValidTimeZone, zonedLocalToUtc, formatInZone, parsePanelRules, panelProblems,
  parseSkillWeights, weightedRatingsAverage, biasFlags, calibration, capacityStatus, suggestInterviewers, stageEntryProblem, stageConversion,
  duplicateGroups, applicableClauses, clausesToHtml, bandCheck, offerComparison, offerTurnaround, hireMedian, contrastRatio, accessibilityIssues,
  extractLinks, brokenCareerLinks, jobPostingJsonLd, jobAlertMatches, pickLocale, parseLinkedProfile, parseCadenceSteps, mapImportRow,
  intakeQuestionsFrom, slugify, hireMonthsBetween, type ProspectFacts, type ClauseShape,
} from "../src/hire-depth-math";
import { HIRE_REQUEST_KINDS, hireRequestPermission, isHireRequestKind } from "../src/hire-depth-core";

const facts = (o: Partial<ProspectFacts> = {}): ProspectFacts => ({ skills: ["java", "spring"], currentTitle: "Senior Engineer", currentEmployer: "Acme Rival", city: "Pune", source: "JOB_BOARD", experienceYears: 6, education: "B.Tech", ...o });

describe("Boolean sourcing search", () => {
  test("AND / OR / NOT with phrases and brackets", () => {
    const { node, error } = parseBooleanQuery('java AND (spring OR "micro services") NOT intern');
    assert.equal(error, undefined);
    assert.equal(matchesBoolean(node, "Java developer | spring boot"), true);
    assert.equal(matchesBoolean(node, "java | micro services"), true);
    assert.equal(matchesBoolean(node, "java | spring | intern"), false);
    assert.equal(matchesBoolean(node, "python | spring"), false);
  });
  test("adjacent terms mean AND; an empty query matches everything", () => {
    const { node } = parseBooleanQuery("react node");
    assert.equal(matchesBoolean(node, "react and node"), true);
    assert.equal(matchesBoolean(node, "react only"), false);
    assert.equal(matchesBoolean(parseBooleanQuery("  ").node, "anything"), true);
  });
  test("malformed queries explain themselves", () => {
    assert.match(parseBooleanQuery("(java OR go").error ?? "", /bracket/);
    assert.match(parseBooleanQuery("AND java").error ?? "", /needs a term/);
    assert.match(parseBooleanQuery("java )").error ?? "", /Unexpected|closing/);
  });
  test("the haystack covers profile, skills and tags", () => {
    const h = candidateHaystack({ firstName: "Asha", lastName: "Rao", currentTitle: "SRE", skills: ["kubernetes"], tags: ["hipo"], city: "Pune" });
    assert.ok(h.includes("kubernetes") && h.includes("hipo") && h.includes("Pune"));
  });
});

describe("Tagging, attribution and segments", () => {
  test("tag rules add tags and keep existing ones", () => {
    const rules = [{ tag: "Java", field: "SKILL", value: "java" }, { tag: "senior", field: "MIN_EXPERIENCE", value: "5" }, { tag: "mumbai", field: "CITY", value: "Mumbai" }];
    assert.deepEqual(tagsFor(rules, facts(), ["keep"]), ["java", "keep", "senior"]);
    assert.deepEqual(tagsFor([{ tag: "x", field: "SKILL", value: "java", isActive: false }], facts()), []);
  });
  test("wildcards match whole values case-insensitively", () => {
    assert.equal(wildcardMatch("linked*", "LinkedIn"), true);
    assert.equal(wildcardMatch("naukri", "naukri.com"), false);
    assert.equal(wildcardMatch("*", null), false);
  });
  test("attribution picks the first matching rule by priority", () => {
    const rules = [
      { id: "a", matchField: "UTM_SOURCE", pattern: "*", source: "JOB_BOARD", channelId: null, priority: 200, isActive: true },
      { id: "b", matchField: "UTM_SOURCE", pattern: "linkedin", source: "DIRECT_SOURCING", channelId: "ch", priority: 10, isActive: true },
      { id: "c", matchField: "EMAIL_DOMAIN", pattern: "*.edu", source: "WALK_IN", channelId: null, priority: 5, isActive: true },
    ];
    assert.equal(attributeSource(rules, { utmSource: "LinkedIn" })?.id, "b");
    assert.equal(attributeSource(rules, { utmSource: "naukri" })?.id, "a");
    assert.equal(attributeSource(rules, { email: "x@iit.edu" })?.id, "c");
    assert.equal(attributeSource(rules, {}), null);
  });
  test("segments need every rule; skills match any", () => {
    const r = parseSegmentRules({ skills: ["Go", "Java"], city: "pune", minExperience: 5 })!;
    assert.equal(segmentMatches(r, facts()), true);
    assert.equal(segmentMatches(r, facts({ city: "Delhi" })), false);
    assert.equal(segmentMatches(r, facts({ experienceYears: 2 })), false);
    assert.equal(parseSegmentRules({}), null);
    assert.equal(segmentMatches(parseSegmentRules({ highPotential: true })!, { ...facts(), highPotential: false }), false);
  });
});

describe("Recommendations and source analytics", () => {
  test("skills dominate the recommendation score", () => {
    const job = { title: "Senior Java Engineer", skills: ["java", "spring", "kafka"], minExperienceYears: 5 };
    const strong = recommendationScore(job, { skills: ["Java", "Spring", "Kafka"], experienceYears: 7, currentTitle: "Senior Java Engineer" });
    const weak = recommendationScore(job, { skills: ["python"], experienceYears: 1, currentTitle: "Analyst" });
    assert.equal(strong.score, 100);
    assert.deepEqual(strong.matched, ["java", "spring", "kafka"]);
    assert.ok(weak.score < 20);
  });
  test("rates, quality, benchmark gap and ROI per source", () => {
    const { rows, benchmarkHireRate } = sourceAnalytics([
      { key: "REFERRAL", label: "Referral", applicants: 10, interviewed: 6, offered: 3, hired: 2, avgScore: 4, cost: 20000 },
      { key: "JOB_BOARD", label: "Job board", applicants: 40, interviewed: 8, offered: 2, hired: 1, avgScore: 3, cost: 60000 },
    ], 100000);
    assert.equal(benchmarkHireRate, 6);
    const ref = rows.find((r) => r.key === "REFERRAL")!;
    assert.equal(ref.hireRate, 20);
    assert.equal(ref.costPerHire, 10000);
    assert.equal(ref.vsBenchmark, 14);
    assert.equal(ref.roi, 900);
    assert.equal(rows[0]!.key, "REFERRAL");
    assert.equal(rows.find((r) => r.key === "JOB_BOARD")!.costPerApplicant, 1500);
  });
  test("months between dates", () => assert.equal(Math.round(hireMonthsBetween(new Date("2026-01-01"), new Date("2026-07-01"))), 6));
});

describe("Workload balancing", () => {
  test("unowned work goes to the least loaded and overload is shed", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, ownerId: "A" })),
      { id: "b0", ownerId: "B" }, { id: "u0", ownerId: null }, { id: "x0", ownerId: "gone" },
    ];
    const moves = balanceAssignments(items, ["A", "B", "C"]);
    const after = new Map<string, number>([["A", 6], ["B", 1], ["C", 0]]);
    for (const m of moves) { if (m.from && after.has(m.from)) after.set(m.from, after.get(m.from)! - 1); after.set(m.to, after.get(m.to)! + 1); }
    assert.ok([...after.values()].every((n) => n <= 3), JSON.stringify([...after]));
    assert.ok(moves.some((m) => m.id === "u0") && moves.some((m) => m.id === "x0"));
    assert.deepEqual(balanceAssignments(items, []), []);
  });
});

describe("Time zones", () => {
  test("local time in a zone converts to UTC", () => {
    assert.equal(zonedLocalToUtc("2026-11-02", "15:30", "Asia/Kolkata")?.toISOString(), "2026-11-02T10:00:00.000Z");
    assert.equal(zonedLocalToUtc("2026-07-01", "09:00", "America/New_York")?.toISOString(), "2026-07-01T13:00:00.000Z");
    assert.equal(zonedLocalToUtc("2026-07-01", "09:00", "Mars/Base"), null);
    assert.equal(isValidTimeZone("Europe/London"), true);
  });
  test("formatting names the zone", () => {
    assert.match(formatInZone(new Date("2026-11-02T10:00:00Z"), "Europe/London"), /10:00 \(Europe\/London\)/);
    assert.match(formatInZone(new Date("2026-11-02T10:00:00Z"), null), /15:30 \(Asia\/Kolkata\)/);
  });
});

describe("Panels, weights, bias prompts and calibration", () => {
  test("panel composition rules", () => {
    const rules = parsePanelRules({ minPanel: 2, maxPanel: 3, requireHiringManager: true, requireOtherDepartment: true });
    const ctx = { hiringManagerId: "hm", jobDepartmentId: "eng" };
    assert.equal(panelProblems(rules, [{ employeeId: "x", departmentId: "eng" }], ctx).length, 3);
    assert.deepEqual(panelProblems(rules, [{ employeeId: "hm", departmentId: "eng" }, { employeeId: "y", departmentId: "hr" }], ctx), []);
    assert.deepEqual(parsePanelRules("junk"), { minPanel: null, maxPanel: null, requireHiringManager: false, requireOtherDepartment: false });
  });
  test("weighted average", () => {
    const w = parseSkillWeights({ Design: 3, "Code quality": 1, bad: 0 });
    assert.deepEqual(w, { design: 3, "code quality": 1 });
    assert.equal(weightedRatingsAverage([{ skill: "Design", rating: 5 }, { skill: "Code quality", rating: 1 }, { skill: "Other", rating: null }], w), 4);
    assert.equal(weightedRatingsAverage([], w), null);
  });
  test("bias prompts catch loaded language and company terms", () => {
    const flags = biasFlags("Great culture fit but seems too young; gut feeling says no. Rockstar.", ["rockstar"]);
    assert.deepEqual(flags.map((f) => f.term.toLowerCase()), ["culture fit", "too young", "gut feeling", "rockstar"]);
    assert.deepEqual(biasFlags("Clear system design answers with trade-offs."), []);
  });
  test("calibration finds lenient and strict interviewers", () => {
    const cards = [
      { panelistId: "L", interviewId: "1", score: 5, recommendation: "MUST_HIRE" }, { panelistId: "S", interviewId: "1", score: 2, recommendation: "NO_HIRE" }, { panelistId: "M", interviewId: "1", score: 3.5, recommendation: "HIRE" },
      { panelistId: "L", interviewId: "2", score: 4.5, recommendation: "HIRE" }, { panelistId: "S", interviewId: "2", score: 2.5, recommendation: "NOT_SURE" },
    ];
    const c = new Map(calibration(cards).map((x) => [x.panelistId, x]));
    assert.equal(c.get("L")!.label, "Lenient");
    assert.equal(c.get("S")!.label, "Strict");
    assert.equal(c.get("L")!.hireRate, 100);
    assert.equal(c.get("M")!.count, 1);
  });
  test("capacity and suggestions", () => {
    assert.equal(capacityStatus(6, 1, { maxPerWeek: 5, maxPerDay: 2 }).over, true);
    assert.equal(capacityStatus(2, 1, null).free, 3);
    const s = suggestInterviewers([{ id: "a", scheduled: 4, maxPerWeek: 5 }, { id: "b", scheduled: 1, maxPerWeek: 5 }, { id: "c", scheduled: 5, maxPerWeek: 5 }], 2);
    assert.deepEqual(s.map((x) => x.id), ["b", "a"]);
  });
});

describe("Stages", () => {
  test("entry criteria", () => {
    const st = { name: "Offer", entryMinScore: 3.5, entryRequiresResume: true };
    assert.match(stageEntryProblem(st, { averageScore: 4, hasResume: false }) ?? "", /résumé/);
    assert.match(stageEntryProblem(st, { averageScore: null, hasResume: true }) ?? "", /no scores yet/);
    assert.equal(stageEntryProblem(st, { averageScore: 3.5, hasResume: true }), null);
  });
  test("conversion and time in stage", () => {
    const stages = [{ id: "s1", name: "Applied", sequence: 1 }, { id: "s2", name: "Interview", sequence: 2 }];
    const d = (n: number) => new Date(Date.UTC(2026, 0, n));
    const rows = stageConversion(stages, [
      { applicationId: "a", stageId: "s1", enteredAt: d(1), exitedAt: d(3) }, { applicationId: "a", stageId: "s2", enteredAt: d(3), exitedAt: null },
      { applicationId: "b", stageId: "s1", enteredAt: d(1), exitedAt: d(5) },
    ], d(5));
    assert.deepEqual(rows[0], { stageId: "s1", name: "Applied", entered: 2, advanced: 1, conversion: 50, avgDays: 3 });
    assert.equal(rows[1]!.avgDays, 2);
  });
});

describe("Duplicates", () => {
  test("same phone or same name and employer", () => {
    const c = (id: string, o: Partial<{ firstName: string; lastName: string; phone: string | null; currentEmployer: string | null; email: string }>) => ({ id, firstName: "Ravi", lastName: "Kumar", phone: null, currentEmployer: null, email: `${id}@x.test`, ...o });
    const groups = duplicateGroups([c("1", { phone: "+91 98450 12345" }), c("2", { phone: "9845012345" }), c("3", { currentEmployer: "Infosys" }), c("4", { currentEmployer: "infosys " }), c("5", { firstName: "Other" })]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.members.map((m) => m.id).join(",")).sort(), ["1,2", "3,4"]);
  });
});

describe("Offers", () => {
  const clause = (o: Partial<ClauseShape>): ClauseShape => ({ id: "x", title: "T", kind: "GENERAL", body: "B", locale: "en", minCtc: null, departmentId: null, employmentType: null, amount: null, sortOrder: 0, isActive: true, ...o });
  test("clauses apply by CTC, department, type and locale, in letter order", () => {
    const all = [
      clause({ id: "tax", kind: "TAX_DISCLAIMER", title: "Tax" }), clause({ id: "esop", kind: "CONDITIONAL", minCtc: 3000000, title: "ESOP" }),
      clause({ id: "hi", locale: "hi", title: "Hindi" }), clause({ id: "dept", departmentId: "d2", title: "Sales" }), clause({ id: "bonus", kind: "COMPONENT", amount: 50000, title: "Relocation" }),
    ];
    assert.deepEqual(applicableClauses(all, { ctc: 3500000, departmentId: "d1", employmentType: "FULL_TIME", locale: "en" }).map((c) => c.id), ["bonus", "esop", "tax"]);
    assert.deepEqual(applicableClauses(all, { ctc: 100, departmentId: "d2", employmentType: null, locale: "en" }).map((c) => c.id), ["bonus", "dept", "tax"]);
    assert.deepEqual(applicableClauses(all, { ctc: 100, departmentId: null, employmentType: null, locale: "hi" }).map((c) => c.id), ["hi"]);
    assert.deepEqual(applicableClauses(all, { ctc: 100, departmentId: null, employmentType: null, locale: "fr" }).map((c) => c.id), ["bonus", "tax"]);
  });
  test("clauses render escaped, with component amounts", () => {
    const html = clausesToHtml([clause({ title: "Bonus <b>", kind: "COMPONENT", amount: 100000, body: "Paid\nonce" })]);
    assert.equal(html, "<p><strong>Bonus &lt;b&gt; — ₹1,00,000</strong></p><p>Paid<br/>once</p>");
    assert.equal(clausesToHtml([]), "");
  });
  test("band validation and compa-ratio", () => {
    const g = { name: "L3", minAnnual: 1000000, maxAnnual: 2000000, midAnnual: null };
    assert.equal(bandCheck(2500000, g).ok, false);
    assert.equal(bandCheck(1500000, g).compaRatio, 1);
    assert.match(bandCheck(900000, g).message, /Below/);
    assert.equal(bandCheck(1, null).ok, true);
  });
  test("comparison against current, expected and competing offers", () => {
    const rows = offerComparison({ offered: 1200000, current: 1000000, expected: 1500000, competitor: null, budgetMax: 1200000 });
    assert.equal(rows[0]!.delta, 20);
    assert.match(rows[1]!.note, /20% short/);
    assert.equal(rows[2]!.note, "—");
    assert.equal(rows[3]!.delta, 0);
  });
  test("turnaround and median", () => {
    const t = offerTurnaround({ createdAt: new Date("2026-01-01"), approvedAt: new Date("2026-01-02"), extendedAt: new Date("2026-01-04"), respondedAt: new Date("2026-01-09") });
    assert.deepEqual(t, { toApprove: 1, toExtend: 2, toRespond: 5, total: 8 });
    assert.equal(hireMedian([3, null, 1, 2]), 2);
    assert.equal(hireMedian([1, 2, 3, 4]), 2.5);
    assert.equal(hireMedian([]), null);
  });
});

describe("Career site", () => {
  test("contrast and accessibility issues", () => {
    assert.equal(contrastRatio("#000000", "#ffffff"), 21);
    const issues = accessibilityIssues({ primaryColor: "#ffff00", accentColor: "#1266a8" }, [{ id: "1", title: "OUR CULTURE ROCKS", body: "[click here](/careers)", imageFileId: "f", imageAlt: "" }]);
    assert.deepEqual(issues.map((i) => i.where), ["Primary colour", "OUR CULTURE ROCKS", "OUR CULTURE ROCKS", "OUR CULTURE ROCKS"]);
  });
  test("link extraction and broken-link checks", () => {
    const links = extractLinks("See [the role](/careers/abcdefghijklmnopqrstu) and https://example.com/x or /careers/p/campus and /hiring/jobs");
    assert.deepEqual(links.sort(), ["/careers/abcdefghijklmnopqrstu", "/careers/p/campus", "https://example.com/x"].sort());
    const broken = brokenCareerLinks([
      { from: "A", url: "/careers/abcdefghijklmnopqrstu" }, { from: "B", url: "/careers/p/campus" }, { from: "C", url: "/hiring/jobs" },
      { from: "D", url: "https://acme.example.com/careers/p/live" }, { from: "E", url: "https://nohost/x" }, { from: "F", url: "https://example.com/x" },
    ], { openJobIds: new Set(), publishedSlugs: new Set(["live"]) });
    assert.deepEqual(broken.map((b) => b.from), ["A", "B", "C", "E"]);
    const pages = brokenCareerLinks([
      { from: "G", url: "/careers/doesnotexist" }, { from: "H", url: "/careers/faq" }, { from: "I", url: "/careers" }, { from: "J", url: "/careers/alerts" }, { from: "K", url: "/careers/status/tok123" },
    ], { openJobIds: new Set(), publishedSlugs: new Set() });
    assert.deepEqual(pages.map((b) => b.from), ["G"]);
  });
  test("JobPosting structured data", () => {
    const ld = jobPostingJsonLd({ title: "SRE", description: "Run things", employmentType: "CONTRACT", workMode: "REMOTE", publishedAt: new Date("2026-10-01"), closesAt: null, minAnnualCtc: 10, maxAnnualCtc: 20, hideSalary: false, url: "https://x/careers/1" }, { name: "Acme", city: "Pune" });
    assert.equal(ld["@type"], "JobPosting");
    assert.equal(ld.employmentType, "CONTRACTOR");
    assert.equal(ld.jobLocationType, "TELECOMMUTE");
    assert.equal(ld.datePosted, "2026-10-01");
    assert.ok(ld.baseSalary);
  });
  test("job alerts match keywords, team and place", () => {
    const job = { title: "Backend Engineer", description: "Go and Postgres", departmentId: "eng", locationId: "blr" };
    assert.equal(jobAlertMatches({ keywords: "golang, postgres", departmentId: null, locationId: null }, job), true);
    assert.equal(jobAlertMatches({ keywords: "designer", departmentId: null, locationId: null }, job), false);
    assert.equal(jobAlertMatches({ keywords: null, departmentId: "hr", locationId: null }, job), false);
    assert.equal(jobAlertMatches({ keywords: "", departmentId: "eng", locationId: "blr" }, job), true);
  });
  test("locale choice", () => {
    assert.equal(pickLocale("hi", null, ["hi"]), "hi");
    assert.equal(pickLocale("fr", "ta-IN,ta;q=0.9,en;q=0.8", ["ta"]), "ta");
    assert.equal(pickLocale(null, "de", ["hi"]), "en");
  });
  test("profile capture, cadences, import mapping, intake, slugs", () => {
    const p = parseLinkedProfile("Staff Engineer at Globex | Payments\nSkills: Go, Kafka; AWS\nBuilt payment rails.", "https://profiles.example/asha");
    assert.equal(p.title, "Staff Engineer");
    assert.equal(p.employer, "Globex");
    assert.deepEqual(p.skills, ["go", "kafka", "aws"]);
    assert.equal(p.summary, "Built payment rails.");
    assert.equal(parseLinkedProfile("x", "javascript:alert(1)").url, null);
    assert.deepEqual(parseCadenceSteps("Day 3: call: check in\nday 0 - email - intro").steps?.map((s) => s.day), [0, 3]);
    assert.match(parseCadenceSteps("tomorrow ping").error ?? "", /Day 3/);
    const m = mapImportRow(["Name", "Mail", "Org"], ["Asha", "asha@x.test", "Globex"], { Name: "firstName", Mail: "email", Org: "currentEmployer", Junk: "salary" });
    assert.deepEqual(m.values, { firstName: "Asha", email: "asha@x.test", currentEmployer: "Globex" });
    assert.match(mapImportRow(["Name"], ["Asha"], { Name: "firstName" }).error ?? "", /required/);
    assert.deepEqual(intakeQuestionsFrom("1. Why now?\n- Must-have skills?\n\n"), ["Why now?", "Must-have skills?"]);
    assert.equal(slugify("Campus Hiring 2026 — IIT!"), "campus-hiring-2026-iit");
  });
});

describe("Hiring request kinds", () => {
  test("each kind has an approver permission", () => {
    assert.equal(hireRequestPermission("OFFER_REVISION"), "hire.offer.approve");
    assert.equal(hireRequestPermission("nope"), "hire.job.manage");
    assert.equal(isHireRequestKind("CONTENT_PUBLISH"), true);
    assert.ok(Object.values(HIRE_REQUEST_KINDS).every((k) => k.permission.startsWith("hire.")));
  });
});
