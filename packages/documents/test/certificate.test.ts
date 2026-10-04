import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderCertificate } from "../src";

describe("Certificate of completion", () => {
  test("a landscape one-page PDF naming the learner, course and number", () => {
    const pdf = renderCertificate({ company: "Acme", learner: "Meera Krishnan", course: "Secure coding", number: "CERT-2026-000001", issuedOn: "4 Oct 2026", expiresOn: "4 Oct 2027", score: 90, credits: 2 });
    const s = pdf.toString("latin1");
    assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
    assert.match(s, /\/MediaBox \[0 0 841\.89 595\.28\]/);
    assert.match(s, /\/Count 1/);
    assert.match(s, /\(Meera Krishnan\) Tj/);
    assert.match(s, /\(CERT-2026-000001\) Tj/);
    assert.match(s, /Valid until 4 Oct 2027/);
  });
  test("without an expiry it says so", () => {
    const s = renderCertificate({ company: "Acme", learner: "A", course: "B", number: "N", issuedOn: "x" }).toString("latin1");
    assert.match(s, /Does not expire/);
  });
});
