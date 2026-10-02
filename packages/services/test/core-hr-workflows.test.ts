import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobChangeDue, dayBefore, planEmail, cleanEmails, invalidEmails, nextReportRun, safeCsvCell, safeCsv, summariseExitSurvey,
} from "../src/core-hr-workflows-math";
import { NOTIFICATION_EVENTS } from "../src/notification-events";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test("a job change is due from the start of its effective day", () => {
  assert.equal(jobChangeDue(d("2026-10-02"), new Date("2026-10-02T00:00:01Z")), true);
  assert.equal(jobChangeDue(d("2026-10-01"), d("2026-10-02")), true);
  assert.equal(jobChangeDue(d("2026-10-03"), new Date("2026-10-02T23:59:59Z")), false);
  assert.equal(dayBefore(d("2026-03-01")).toISOString().slice(0, 10), "2026-02-28");
});

test("no setting keeps the event's own recipients", () => {
  assert.deepEqual(planEmail(null, ["EMPLOYEE"], true), { send: true, useCallSite: true, groups: [], customEmails: [] });
});

test("switching an event off stops the email", () => {
  assert.deepEqual(planEmail({ emailEnabled: false, recipients: ["EMPLOYEE"], customEmails: [] }, ["EMPLOYEE"], true), { send: false });
});

test("default recipients plus a custom address keeps the call site and copies the address", () => {
  const p = planEmail({ emailEnabled: true, recipients: ["HR", "MANAGER"], customEmails: ["HR@Acme.test", "bad"] }, ["MANAGER", "HR"], true);
  assert.deepEqual(p, { send: true, useCallSite: true, groups: [], customEmails: ["hr@acme.test"] });
});

test("changed recipients resolve groups; unknown groups are dropped", () => {
  const p = planEmail({ emailEnabled: true, recipients: ["EMPLOYEE", "BOSS"], customEmails: [] }, ["MANAGER", "HR"], true);
  assert.deepEqual(p, { send: true, useCallSite: false, groups: ["EMPLOYEE"], customEmails: [] });
});

test("events that are not about one employee are never re-targeted", () => {
  const p = planEmail({ emailEnabled: true, recipients: ["HR"], customEmails: [] }, ["EMPLOYEE"], false);
  assert.equal(p.send && p.useCallSite, true);
});

test("every notification event has a unique key and sane defaults", () => {
  const keys = NOTIFICATION_EVENTS.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const e of NOTIFICATION_EVENTS) for (const g of e.defaults) assert.ok(["EMPLOYEE", "MANAGER", "HR"].includes(g), e.key);
});

test("email lists are split, lower-cased, de-duplicated and checked", () => {
  assert.deepEqual(cleanEmails("A@x.io; b@x.io, a@x.io  nope"), ["a@x.io", "b@x.io"]);
  assert.deepEqual(invalidEmails("a@x.io, nope, c@d"), ["nope", "c@d"]);
});

test("next report run: daily, weekly and monthly, always after today", () => {
  const thu = new Date("2026-10-01T10:00:00Z"); // a Thursday
  assert.equal(nextReportRun("DAILY", null, null, thu).toISOString(), "2026-10-02T03:30:00.000Z");
  assert.equal(nextReportRun("WEEKLY", 1, null, thu).toISOString(), "2026-10-05T03:30:00.000Z");
  assert.equal(nextReportRun("WEEKLY", 4, null, thu).toISOString(), "2026-10-08T03:30:00.000Z");
  assert.equal(nextReportRun("WEEKLY", 7, null, thu).toISOString(), "2026-10-04T03:30:00.000Z"); // 7 = Sunday
  assert.equal(nextReportRun("MONTHLY", null, 1, thu).toISOString(), "2026-11-01T03:30:00.000Z");
  assert.equal(nextReportRun("MONTHLY", null, 15, thu).toISOString(), "2026-10-15T03:30:00.000Z");
  assert.equal(nextReportRun("MONTHLY", null, 31, new Date("2026-12-30T00:00:00Z")).toISOString(), "2027-01-28T03:30:00.000Z");
});

test("CSV cells are quoted and spreadsheet formulas neutralised", () => {
  assert.equal(safeCsvCell('He said "hi", then left'), '"He said ""hi"", then left"');
  assert.equal(safeCsvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(safeCsvCell("-42"), "-42");
  assert.equal(safeCsvCell(null), "");
  assert.equal(safeCsv(["a", "b"], [[1, "x\ny"]]), 'a,b\r\n1,"x\ny"');
});

test("exit survey roll-up: averages, NPS, choice counts and comments", () => {
  const qs = [
    { id: "r", prompt: "Manager", type: "RATING", options: [] },
    { id: "n", prompt: "Recommend", type: "NPS", options: [] },
    { id: "c", prompt: "Reason", type: "SINGLE_CHOICE", options: ["Pay", "Growth"] },
    { id: "t", prompt: "Anything else", type: "TEXT", options: [] },
  ];
  const a = (questionId: string, v: { score?: number; choices?: number[]; text?: string }) => ({ questionId, score: v.score ?? null, choices: v.choices ?? [], text: v.text ?? null });
  const s = summariseExitSurvey(qs, [
    a("r", { score: 4 }), a("r", { score: 2 }), a("n", { score: 10 }), a("n", { score: 3 }), a("n", { score: 8 }),
    a("c", { choices: [1] }), a("c", { choices: [1] }), a("t", { text: "  thanks " }), a("t", { text: "" }),
  ]);
  assert.deepEqual(s[0], { id: "r", prompt: "Manager", type: "RATING", responses: 2, average: 3, nps: null });
  assert.equal(s[1].type === "NPS" && s[1].nps, 0);
  assert.deepEqual(s[2].type === "SINGLE_CHOICE" && s[2].counts, [{ option: "Pay", count: 0 }, { option: "Growth", count: 2 }]);
  assert.deepEqual(s[3].type === "TEXT" && s[3].texts, ["thanks"]);
});
