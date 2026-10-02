import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderOfferLetter } from "@keka/documents";
import {
  parseManualBreakup, breakupTableHtml, renderOfferHtml, htmlToParagraphs, offerPdfBlocks, newOfferToken, hashOfferToken,
  offerTokenSigned, linkExpiry, offerLinkState, sameName, DEFAULT_OFFER_TEMPLATE,
} from "../src/offers-math";

const SECRET = "test-secret-that-is-long-enough-for-hmac-0123456789";

describe("salary breakup", () => {
  test("typed lines in annual rupees, with commas and a currency mark", () => {
    const r = parseManualBreakup("Basic: 6,00,000\nHRA = ₹2,40,000\nSpecial allowance - 3,60,000", 1_200_000);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.rows!.map((x) => [x.name, x.annual, x.monthly]), [["Basic", 600000, 50000], ["HRA", 240000, 20000], ["Special allowance", 360000, 30000]]);
  });
  test("a breakup that does not add up to the CTC is refused", () => {
    assert.match(parseManualBreakup("Basic: 600000\nHRA: 200000", 1_200_000).error!, /add up to/);
  });
  test("a line without an amount is pointed out by number", () => {
    assert.match(parseManualBreakup("Basic: 600000\nHRA", 600000).error!, /Line 2/);
  });
  test("the table escapes component names and totals both columns", () => {
    const html = breakupTableHtml([{ name: "<b>Basic</b>", monthly: 50000, annual: 600000 }, { name: "HRA", monthly: 20000, annual: 240000 }]);
    assert.ok(html.includes("&lt;b&gt;Basic&lt;/b&gt;") && !html.includes("<b>Basic"));
    assert.ok(html.includes("₹70,000") && html.includes("₹8,40,000"));
  });
});

describe("offer letter rendering", () => {
  const values = { candidate_name: "Asha <Pillai>", candidate_first_name: "Asha", job_title: "SRE", annual_ctc: "₹12,00,000", joining_date: "01/12/2026" };
  const rows = [{ name: "Basic", monthly: 50000, annual: 600000 }, { name: "Flexi", monthly: 50000, annual: 600000 }];
  test("values are escaped and the salary table is spliced in where the template puts it", () => {
    const r = renderOfferHtml("<p>Dear {{candidate_name}}, CTC {{annual_ctc}}</p>{{ salary_breakup }}<p>Join {{joining_date}}</p>", values, rows);
    assert.ok(r.html.includes("Asha &lt;Pillai&gt;"));
    assert.ok(r.html.indexOf("<table") > r.html.indexOf("CTC") && r.html.indexOf("<table") < r.html.indexOf("Join"));
    assert.deepEqual(r.missing, []);
  });
  test("an unknown value and a missing breakup are both reported", () => {
    const r = renderOfferHtml("{{location}} {{salary_breakup}}", values, []);
    assert.deepEqual(r.missing.sort(), ["location", "salary_breakup"]);
    assert.ok(r.html.includes("[LOCATION NOT AVAILABLE]") && r.html.includes("[SALARY_BREAKUP NOT AVAILABLE]"));
  });
  test("HTML becomes plain paragraphs: breaks, list items and entities", () => {
    assert.deepEqual(htmlToParagraphs("<p>A &amp; B<br/>C</p><ul><li>one</li><li>two</li></ul><p>&#8377; 5</p>"), ["A & B", "C", "• one", "• two", "₹ 5"]);
  });
  test("PDF blocks put the table between the paragraphs around it", () => {
    const b = offerPdfBlocks(DEFAULT_OFFER_TEMPLATE, values, rows);
    const t = b.findIndex((x) => x.kind === "table");
    assert.ok(t > 0 && b.slice(0, t).some((x) => x.kind === "p" && /made up as follows/.test(x.text)) && b.slice(t).some((x) => x.kind === "p" && /joining/.test(x.text)));
  });
  test("a long letter flows onto a second page and carries the signing record", () => {
    const blocks = Array.from({ length: 60 }, (_, i) => ({ kind: "p" as const, text: `Clause ${i + 1}. ${"The employee shall observe the policies of the company. ".repeat(3)}` }));
    const pdf = renderOfferLetter({ company: { name: "Acme" }, date: "1 Oct 2026", to: ["Asha"], subject: "Offer", blocks: [...blocks, { kind: "table", rows }], signed: { name: "Asha Pillai", at: "2026-10-02 10:00 UTC", fingerprint: "ab".repeat(32) } });
    const s = pdf.toString("latin1");
    assert.ok(/\/Count [2-9]/.test(s), "more than one page");
    assert.ok(s.includes("Accepted and signed electronically") && s.includes("Asha Pillai"));
  });
});

describe("offer link tokens", () => {
  test("a fresh token is signed, and its hash is what is stored", () => {
    const { token, hash } = newOfferToken(SECRET);
    assert.ok(offerTokenSigned(token, SECRET));
    assert.equal(hash, hashOfferToken(token));
    assert.ok(!hash.includes(token.split(".")[0]!));
  });
  test("tokens are not repeated", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newOfferToken(SECRET).token));
    assert.equal(seen.size, 200);
  });
  test("a forged, altered or foreign-secret token fails the signature check", () => {
    const { token } = newOfferToken(SECRET);
    const [rand, sig] = token.split(".") as [string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    assert.equal(offerTokenSigned(`${flip(rand)}.${sig}`, SECRET), false);
    assert.equal(offerTokenSigned(`${rand}.${flip(sig)}`, SECRET), false);
    assert.equal(offerTokenSigned(token, `${SECRET}x`), false);
    assert.equal(offerTokenSigned("not-a-token", SECRET), false);
    assert.equal(offerTokenSigned(`${token}'; drop table offers;--`, SECRET), false);
  });
  test("a link lasts to the end of the offer's expiry day, never beyond 30 days", () => {
    const now = new Date("2026-10-02T10:00:00Z");
    assert.equal(linkExpiry(new Date("2026-10-09T00:00:00Z"), now).toISOString(), "2026-10-09T23:59:59.000Z");
    assert.equal(linkExpiry(new Date("2027-03-01T00:00:00Z"), now).toISOString(), "2026-11-01T10:00:00.000Z");
  });
  test("link state: revoked and expired win; a decided offer shows its outcome", () => {
    const now = new Date("2026-10-02T10:00:00Z");
    const live = { expiresAt: new Date("2026-10-05T00:00:00Z"), revokedAt: null };
    assert.equal(offerLinkState(live, "EXTENDED", now), "OPEN");
    assert.equal(offerLinkState(live, "ACCEPTED", now), "ACCEPTED");
    assert.equal(offerLinkState(live, "WITHDRAWN", now), "CLOSED");
    assert.equal(offerLinkState({ ...live, revokedAt: now }, "EXTENDED", now), "REVOKED");
    assert.equal(offerLinkState({ ...live, expiresAt: now }, "EXTENDED", now), "EXPIRED");
  });
  test("the typed name matches ignoring case and punctuation", () => {
    assert.ok(sameName("  asha   PILLAI. ", "Asha Pillai"));
    assert.ok(!sameName("Asha", "Asha Pillai"));
    assert.ok(!sameName("", "Asha Pillai"));
  });
});
