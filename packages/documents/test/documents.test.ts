import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PdfDoc, rc4, securityKeys, objectKey, opensWith, textWidth, toWinAnsi, renderPayslip, renderForm16, rupeesInWords,
  pfEcr, esiContribution, bankAdvice, form24qAnnexure,
} from "../src";

/** Every xref entry must point at the start of its "N 0 obj". */
function checkXref(pdf: Buffer) {
  const s = pdf.toString("latin1");
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.equal(s.slice(start, start + 4), "xref");
  const [, count] = /xref\n0 (\d+)/.exec(s.slice(start))!;
  const lines = s.slice(start).split("\n").slice(2, 2 + Number(count));
  for (const [i, l] of lines.entries()) {
    assert.equal(l.length, 19, `xref line ${i} must be 20 bytes with its EOL`);
    if (i === 0) continue;
    const off = Number(l.slice(0, 10));
    assert.equal(s.slice(off, off + `${i} 0 obj`.length), `${i} 0 obj`, `object ${i} offset`);
  }
}

describe("PDF writer", () => {
  test("writes a well-formed file whose cross-reference table is exact", () => {
    const doc = new PdfDoc({ title: "Test (with) brackets \\ and rupees ₹" });
    const p = doc.page();
    p.text(40, 40, "Hello (world) ₹1,000", { bold: true });
    p.rect(40, 60, 100, 20, { fill: [0.9, 0.9, 0.9] });
    doc.page().text(40, 40, "Second page");
    const pdf = doc.toBuffer();
    assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
    assert.match(pdf.toString("latin1"), /\/Count 2/);
    assert.match(pdf.toString("latin1"), /\(Hello \\\(world\\\) Rs\. 1,000\) Tj/);
    checkXref(pdf);
  });

  test("text width uses the font metrics", () => {
    assert.equal(textWidth("iiii", 10), 8.88);
    assert.ok(textWidth("rrrr", 10, true) > textWidth("rrrr", 10)); // r is 333 regular, 389 bold
    assert.deepEqual([...toWinAnsi("é€")], [233, 63]);
  });

  test("RC4 matches the published test vector", () => {
    // RFC 6229-style vector: key "Key", plaintext "Plaintext".
    assert.equal(rc4(Buffer.from("Key"), Buffer.from("Plaintext")).toString("hex"), "bbf316e8d940af0ad3");
  });

  test("an encrypted PDF only yields its content to the right key", () => {
    const doc = new PdfDoc({ title: "Secret" });
    doc.page().text(40, 40, "Net pay 81,229");
    const pdf = doc.toBuffer({ userPassword: "ABCDE1234F", ownerPassword: "owner" });
    const s = pdf.toString("latin1");
    checkXref(pdf);
    assert.match(s, /\/Filter \/Standard \/V 2 \/R 3 \/Length 128/);
    assert.ok(!s.includes("Net pay"), "content must not be readable");
    // Recompute the keys from the ID and confirm the stored U matches.
    const id = Buffer.from(/\/ID \[<([0-9a-f]+)>/.exec(s)![1], "hex");
    const right = securityKeys("ABCDE1234F", "owner", id);
    const storedU = /\/U <([0-9a-f]+)>/.exec(s)![1];
    assert.equal(right.u.subarray(0, 16).toString("hex"), storedU.slice(0, 32));
    // Decrypt the page content (object 6) and find the text.
    const m = /6 0 obj\n<< \/Length (\d+) >>\nstream\n/.exec(s)!;
    const start = m.index + m[0].length;
    const plain = rc4(objectKey(right.key, 6), pdf.subarray(start, start + Number(m[1]))).toString("latin1");
    assert.match(plain, /Net pay 81,229/);
    assert.ok(opensWith(pdf, "ABCDE1234F"), "the user password opens it");
    assert.ok(!opensWith(pdf, "abcde1234f"), "case matters");
    // A wrong password derives a different U.
    assert.notEqual(securityKeys("WRONGPAN1X", "owner", id).u.subarray(0, 16).toString("hex"), storedU.slice(0, 32));
  });
});

describe("Payslip and Form 16", () => {
  const data = {
    company: { name: "Acme Technologies Pvt Ltd", address: "Bengaluru" },
    period: "August 2026",
    employee: { name: "Meera Krishnan", number: "ACM0009", designation: "Software Engineer", pan: "ABCDE1234F", uan: "100200300400" },
    days: { inMonth: 31, paid: 30, lop: 1 },
    earnings: [{ name: "Basic", full: 40000, actual: 38710 }, { name: "HRA", full: 20000, actual: 19355 }],
    deductions: [{ name: "Provident Fund", amount: 1742 }, { name: "Professional Tax", amount: 200 }],
    netPay: 56123,
  };

  test("renders a payslip that is valid and protected by the PAN", () => {
    const pdf = renderPayslip(data, { password: "ABCDE1234F" });
    checkXref(pdf);
    assert.match(pdf.toString("latin1"), /\/Encrypt/);
    assert.ok(pdf.length > 1500);
  });

  test("an unprotected payslip shows its figures", () => {
    const s = renderPayslip(data).toString("latin1");
    assert.match(s, /Meera Krishnan/);
    assert.match(s, /56,123\.00/);
    assert.match(s, /Fifty Six Thousand One Hundred Twenty Three Rupees Only/);
  });

  test("Form 16 Part B renders", () => {
    const pdf = renderForm16({
      company: { name: "Acme", tan: "BLRA12345B" }, employee: { name: "Meera", number: "ACM0009", pan: "ABCDE1234F" },
      fy: "2026-27", assessmentYear: "2027-28", regime: "NEW",
      rows: [{ label: "Gross salary", amount: 1200000, bold: true }, { label: "Standard deduction", amount: 75000, indent: 1 }],
      quarters: [{ quarter: "Q1", amountPaid: 300000, tds: 12000 }],
    });
    checkXref(pdf);
  });

  test("amounts in words use lakh and crore", () => {
    assert.equal(rupeesInWords(0), "Zero Rupees Only");
    assert.equal(rupeesInWords(1050), "One Thousand Fifty Rupees Only");
    assert.equal(rupeesInWords(1234567.5), "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Fifty Paise Only");
    assert.equal(rupeesInWords(25000000), "Two Crore Fifty Lakh Rupees Only");
  });
});

describe("Statutory files", () => {
  test("PF ECR is #~# separated, whole rupees, cleaned names, bad UANs reported", () => {
    const r = pfEcr([
      { uan: "100200300400", name: "Meera K. Krishnan-Iyer", grossWages: 58065.4, epfWages: 15000, epsWages: 15000, edliWages: 15000, epfContribution: 1800, epsContribution: 1250, epfEpsDiff: 550, ncpDays: 1 },
      { uan: "12345", name: "Bad Uan", grossWages: 1, epfWages: 1, epsWages: 1, edliWages: 1, epfContribution: 0, epsContribution: 0, epfEpsDiff: 0, ncpDays: 0 },
    ]);
    assert.equal(r.content, "100200300400#~#MEERA K. KRISHNANIYER#~#58065#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#1#~#0\n");
    assert.equal(r.issues.length, 1);
  });

  test("ESI file carries a reason code only for zero-day members", () => {
    const r = esiContribution([
      { ipNumber: "1234567890", name: "A", days: 30, wages: 18000 },
      { ipNumber: "1234567891", name: "B", days: 0, wages: 0, reasonCode: 2, lastWorkingDay: "18/09/2026" },
    ]);
    const lines = r.content.trim().split("\r\n");
    assert.equal(lines[1], "1234567890,A,30,18000,0,");
    assert.equal(lines[2], "1234567891,B,0,0,2,18/09/2026");
  });

  test("bank advice refuses bad IFSCs and totals what it includes", () => {
    const r = bankAdvice([
      { name: "A", accountNumber: "123456789012", ifsc: "HDFC0001234", amount: 50000, narration: "SALARY AUG 2026" },
      { name: "B", accountNumber: "123456789013", ifsc: "BAD", amount: 40000, narration: "SALARY AUG 2026" },
    ]);
    assert.equal(r.total, 50000);
    assert.equal(r.issues.length, 1);
    assert.match(r.content, /^Beneficiary Name/);
  });

  test("CSV cells cannot smuggle spreadsheet formulas", () => {
    const r = bankAdvice([{ name: "=HYPERLINK(\"x\")", accountNumber: "123456789012", ifsc: "HDFC0001234", amount: 1, narration: "x" }]);
    assert.match(r.content, /"'=HYPERLINK\(""x""\)"/);
  });

  test("24Q flags a missing PAN as PANNOTAVBL", () => {
    const r = form24qAnnexure([{ pan: null, name: "No Pan", paymentDate: "01/09/2026", amountPaid: 50000, tds: 10000 }], "Q2");
    assert.match(r.content, /PANNOTAVBL/);
    assert.equal(r.issues.length, 1);
    assert.deepEqual(r.totals, { paid: 50000, tds: 10000 });
  });
});
