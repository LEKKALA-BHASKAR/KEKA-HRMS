import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractMentions, mentionSegments, wallPlainText, sanitiseMentions, validatePollOptions, tallyPoll, wishWindowOpen, defaultWish, safeLinkUrl,
} from "../src/home-wall";

const A = "cmupoqikk00prrslqihv5p6pn";
const B = "cmupoqikn00q4rslqv3tag8nx";

describe("Mentions", () => {
  test("extracts distinct ids in order", () => {
    const body = `Thanks @[Meera Krishnan](${A}) and @[Aditya Verma](${B}) — and again @[Meera](${A})!`;
    assert.deepEqual(extractMentions(body), [A, B]);
  });
  test("splits a body into text and mention segments", () => {
    const segs = mentionSegments(`Hi @[Meera Krishnan](${A}), welcome`);
    assert.deepEqual(segs, [{ text: "Hi " }, { id: A, name: "Meera Krishnan" }, { text: ", welcome" }]);
    assert.deepEqual(mentionSegments("no mentions"), [{ text: "no mentions" }]);
  });
  test("ignores malformed tokens", () => {
    assert.deepEqual(extractMentions("@[x](short) @[](abc) @Meera"), []);
  });
  test("plain text drops the ids", () => {
    assert.equal(wallPlainText(`Hi @[Meera Krishnan](${A})`), "Hi @Meera Krishnan");
  });
  test("sanitising keeps known ids with their real names and strips the rest", () => {
    const out = sanitiseMentions(`@[Fake Name](${A}) @[Ghost](${B})`, new Map([[A, "Meera Krishnan"]]));
    assert.equal(out, `@[Meera Krishnan](${A}) @Ghost`);
  });
});

describe("Poll options", () => {
  test("trims, drops blanks and needs two", () => {
    assert.deepEqual(validatePollOptions(["  Goa ", "", "Coorg"]), { ok: true, options: ["Goa", "Coorg"] });
    assert.equal(validatePollOptions(["Only one", " "]).ok, false);
  });
  test("refuses duplicates case-insensitively", () => {
    const r = validatePollOptions(["Goa", "goa"]);
    assert.equal(r.ok, false);
  });
  test("caps the count and length", () => {
    assert.equal(validatePollOptions(Array.from({ length: 11 }, (_, i) => `O${i}`)).ok, false);
    assert.equal(validatePollOptions(["x".repeat(121), "y"]).ok, false);
  });
});

describe("Poll tally", () => {
  const options = [
    { id: "o2", label: "Coorg", position: 1 },
    { id: "o1", label: "Goa", position: 0 },
    { id: "o3", label: "Pondicherry", position: 2 },
  ];
  test("percentages add up to exactly 100", () => {
    const votes = [
      { optionId: "o1", employeeId: "e1", voterName: "Asha" },
      { optionId: "o2", employeeId: "e2", voterName: "Ravi" },
      { optionId: "o3", employeeId: "e3", voterName: "Zoya" },
    ];
    const t = tallyPoll(options, votes, "e2", false, null);
    assert.equal(t.total, 3);
    assert.equal(t.rows.reduce((a, r) => a + r.pct, 0), 100);
    assert.deepEqual(t.rows.map((r) => r.label), ["Goa", "Coorg", "Pondicherry"]);
    assert.equal(t.mine, "o2");
    assert.deepEqual(t.rows[0].voters, ["Asha"]);
  });
  test("an anonymous poll never carries voter names", () => {
    const t = tallyPoll(options, [{ optionId: "o1", employeeId: "e1", voterName: "Asha" }], null, true, null);
    assert.equal(t.rows[0].voters, undefined);
    assert.equal(t.rows[0].pct, 100);
    assert.equal(t.rows[1].pct, 0);
  });
  test("no votes means zero everywhere", () => {
    const t = tallyPoll(options, [], null, false, null);
    assert.equal(t.total, 0);
    assert.ok(t.rows.every((r) => r.pct === 0));
  });
  test("closes at the expiry instant", () => {
    const at = new Date("2026-10-11T00:00:00Z");
    assert.equal(tallyPoll(options, [], null, false, at, new Date("2026-10-10T23:59:00Z")).closed, false);
    assert.equal(tallyPoll(options, [], null, false, at, new Date("2026-10-11T00:00:00Z")).closed, true);
  });
  test("ignores votes for options not on the poll", () => {
    const t = tallyPoll(options, [{ optionId: "zz", employeeId: "e1" }], null, false, null);
    assert.equal(t.total, 0);
  });
});

describe("Wish window", () => {
  const today = new Date(Date.UTC(2026, 9, 1));
  test("birthday only on the day", () => {
    assert.equal(wishWindowOpen("BIRTHDAY", { dateOfBirth: new Date(Date.UTC(1991, 9, 1)), dateOfJoining: new Date(Date.UTC(2020, 4, 4)) }, today), true);
    assert.equal(wishWindowOpen("BIRTHDAY", { dateOfBirth: new Date(Date.UTC(1991, 9, 2)), dateOfJoining: new Date(Date.UTC(2020, 4, 4)) }, today), false);
    assert.equal(wishWindowOpen("BIRTHDAY", { dateOfBirth: null, dateOfJoining: new Date(Date.UTC(2020, 4, 4)) }, today), false);
  });
  test("29 February birthdays fall on 28 February in other years", () => {
    assert.equal(wishWindowOpen("BIRTHDAY", { dateOfBirth: new Date(Date.UTC(1996, 1, 29)), dateOfJoining: new Date(Date.UTC(2020, 0, 1)) }, new Date(Date.UTC(2027, 1, 28))), true);
  });
  test("an anniversary needs at least a year", () => {
    assert.equal(wishWindowOpen("WORK_ANNIVERSARY", { dateOfBirth: null, dateOfJoining: new Date(Date.UTC(2020, 9, 1)) }, today), true);
    assert.equal(wishWindowOpen("WORK_ANNIVERSARY", { dateOfBirth: null, dateOfJoining: new Date(Date.UTC(2026, 9, 1)) }, today), false);
  });
  test("new joinees for 90 days", () => {
    assert.equal(wishWindowOpen("NEW_JOINEE", { dateOfBirth: null, dateOfJoining: new Date(Date.UTC(2026, 6, 3)) }, today), true);
    assert.equal(wishWindowOpen("NEW_JOINEE", { dateOfBirth: null, dateOfJoining: new Date(Date.UTC(2026, 5, 1)) }, today), false);
  });
  test("default wording", () => {
    assert.equal(defaultWish("BIRTHDAY", "Neha Agarwal"), "Happy birthday Neha Agarwal 🎉");
  });
});

describe("Quick link URLs", () => {
  test("https and app-relative only", () => {
    assert.equal(safeLinkUrl("/documents"), "/documents");
    assert.equal(safeLinkUrl("https://acme.test/handbook"), "https://acme.test/handbook");
    assert.equal(safeLinkUrl("http://acme.test"), null);
    assert.equal(safeLinkUrl("javascript:alert(1)"), null);
    assert.equal(safeLinkUrl("//evil.example"), null);
  });
});
