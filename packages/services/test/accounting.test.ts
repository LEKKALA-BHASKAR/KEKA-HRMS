import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHART, normalSide, signedBalance, checkEntry, consolidate, payrollJournal, invoiceJournal, settlementJournal, statements, type TbRow, type Settlement } from "../src/accounting-math";

const sum = (xs: Array<{ debit: number; credit: number }>, k: "debit" | "credit") => Math.round(xs.reduce((s, x) => s + x[k], 0) * 100) / 100;

describe("Chart of accounts", () => {
  test("codes are unique and every parent is a group that exists", () => {
    const codes = DEFAULT_CHART.map((a) => a.code);
    assert.equal(new Set(codes).size, codes.length);
    for (const a of DEFAULT_CHART.filter((x) => x.parent)) {
      const p = DEFAULT_CHART.find((x) => x.code === a.parent);
      assert.ok(p?.isGroup, `${a.code}'s parent ${a.parent} is a group`);
      assert.equal(p!.accountClass, a.accountClass, `${a.code} sits under a group of its own class`);
    }
  });
  test("every account the postings use exists and is postable", () => {
    const leaves = new Set(DEFAULT_CHART.filter((a) => !a.isGroup).map((a) => a.code));
    const used = [
      ...payrollJournal([{ type: "EARNING", code: "BASIC", amount: 1 }, { type: "REIMBURSEMENT", code: "FUEL", amount: 1 }, { type: "EMPLOYER_CONTRIBUTION", code: "PF_EMPLOYER", amount: 1 }, { type: "EMPLOYER_CONTRIBUTION", code: "EDLI", amount: 1 },
        { type: "EMPLOYER_CONTRIBUTION", code: "ESI_EMPLOYER", amount: 1 }, { type: "EMPLOYER_CONTRIBUTION", code: "LWF_EMPLOYER", amount: 1 }, { type: "EMPLOYER_CONTRIBUTION", code: "GRATUITY_PROVISION", amount: 1 },
        { type: "DEDUCTION", code: "PF_EMPLOYEE", amount: 0.1 }, { type: "DEDUCTION", code: "ESI_EMPLOYEE", amount: 0.1 }, { type: "DEDUCTION", code: "PT", amount: 0.1 }, { type: "DEDUCTION", code: "TDS", amount: 0.1 },
        { type: "DEDUCTION", code: "LWF_EMPLOYEE", amount: 0.1 }, { type: "DEDUCTION", code: "LOAN_EMI_1", amount: 0.1 }, { type: "DEDUCTION", code: "ADHOC_DED_1", amount: 0.1, source: "CashAdvanceRecovery" }]).postings,
      ...invoiceJournal({ subtotal: 100, cgst: 9, sgst: 9, igst: 0 }), ...invoiceJournal({ subtotal: 100, cgst: 0, sgst: 0, igst: 18 }),
    ].map((p) => p.accountCode);
    for (const c of new Set(used)) assert.ok(leaves.has(c), `${c} is a leaf account`);
  });
  test("normal sides follow the accounting equation", () => {
    assert.equal(normalSide("ASSET"), "DEBIT"); assert.equal(normalSide("EXPENSE"), "DEBIT");
    assert.equal(normalSide("LIABILITY"), "CREDIT"); assert.equal(normalSide("EQUITY"), "CREDIT"); assert.equal(normalSide("INCOME"), "CREDIT");
    assert.equal(signedBalance("LIABILITY", 100, 250), 150);
    assert.equal(signedBalance("ASSET", 100, 250), -150);
  });
});

describe("Journal entries", () => {
  test("a balanced two-line entry passes", () => {
    assert.deepEqual(checkEntry([{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }]), []);
  });
  test("unbalanced, one-sided, two-sided, negative and sub-paisa lines are refused", () => {
    assert.match(checkEntry([{ debit: 100, credit: 0 }, { debit: 0, credit: 99.99 }]).join(), /differ by 0\.01/);
    assert.match(checkEntry([{ debit: 100, credit: 0 }]).join(), /at least two/);
    assert.match(checkEntry([{ debit: 100, credit: 100 }, { debit: 0, credit: 0 }]).join(), /either a debit or a credit/);
    assert.match(checkEntry([{ debit: -5, credit: 0 }, { debit: 0, credit: -5 }]).join(), /negative/);
    assert.match(checkEntry([{ debit: 0.001, credit: 0 }, { debit: 0, credit: 0.001 }]).join(), /paisa/);
  });
  test("floating-point sums do not fake an imbalance", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in paise it is exact.
    assert.deepEqual(checkEntry([{ debit: 0.1, credit: 0 }, { debit: 0.2, credit: 0 }, { debit: 0, credit: 0.3 }]), []);
  });
  test("consolidate merges by account and side and drops zeros", () => {
    const c = consolidate([{ accountCode: "2200", debit: 0, credit: 10 }, { accountCode: "2200", debit: 0, credit: 5.5 }, { accountCode: "5100", debit: 15.5, credit: 0 }, { accountCode: "2210", debit: 0, credit: 0 }]);
    assert.deepEqual(c.map((p) => [p.accountCode, p.debit, p.credit]), [["5100", 15.5, 0], ["2200", 0, 15.5]]);
  });
});

describe("Payroll journal", () => {
  // The August run of the seeded tenant, by component.
  const august = [
    { type: "EARNING", code: "BASIC", amount: 1648312 }, { type: "EARNING", code: "HRA", amount: 824163 }, { type: "EARNING", code: "SPECIAL", amount: 1539571 },
    { type: "EARNING", code: "LTA", amount: 137307 }, { type: "EARNING", code: "CONVEYANCE", amount: 46758 }, { type: "EARNING", code: "MEDICAL", amount: 36534 },
    { type: "EMPLOYER_CONTRIBUTION", code: "PF_EMPLOYER", amount: 15550 }, { type: "EMPLOYER_CONTRIBUTION", code: "EPS", amount: 35316 },
    { type: "EMPLOYER_CONTRIBUTION", code: "PF_ADMIN", amount: 2123 }, { type: "EMPLOYER_CONTRIBUTION", code: "EDLI", amount: 2123 },
    { type: "EMPLOYER_CONTRIBUTION", code: "GRATUITY_PROVISION", amount: 79286 },
    { type: "DEDUCTION", code: "PF_EMPLOYEE", amount: 50866 }, { type: "DEDUCTION", code: "VPF", amount: 24516 }, { type: "DEDUCTION", code: "TDS", amount: 617815 },
    { type: "DEDUCTION", code: "PT", amount: 5000 }, { type: "DEDUCTION", code: "LOAN_EMI_1", amount: 10000 },
  ];
  const j = payrollJournal(august);
  const at = (code: string) => j.postings.find((p) => p.accountCode === code);
  test("it balances, and net pay is gross less deductions", () => {
    assert.deepEqual(checkEntry(j.postings), []);
    assert.equal(j.netPay, 3524448);
    assert.equal(at("2100")!.credit, 3524448);
  });
  test("cost is gross plus employer contributions", () => {
    assert.equal(sum(j.postings, "debit"), 4232645 + 134398);
    assert.equal(at("5100")!.debit, 4232645);
  });
  test("each deduction is owed to whoever collects it", () => {
    assert.equal(at("2200")!.credit, 50866 + 24516 + 15550 + 35316 + 2123 + 2123); // the whole ECR challan
    assert.equal(at("2230")!.credit, 617815);
    assert.equal(at("2220")!.credit, 5000);
    assert.equal(at("1310")!.credit, 10000); // a loan repaid reduces the asset
    assert.equal(at("2400")!.credit, 79286);
    assert.deepEqual(j.unmapped, []);
  });
  test("reimbursements and advance recoveries go to their own accounts", () => {
    const k = payrollJournal([
      { type: "EARNING", code: "BASIC", amount: 50000 },
      { type: "EARNING", code: "ADHOC_PAY_1", amount: 3200, source: "ExpenseClaim" },
      { type: "REIMBURSEMENT", code: "FUEL", amount: 1500 },
      { type: "DEDUCTION", code: "ADHOC_DED_1", amount: 5000, source: "CashAdvanceRecovery" },
      { type: "DEDUCTION", code: "ADHOC_DED_2", amount: 700 },
      { type: "PERK", code: "CAR_PERK", amount: 2400 },
    ]);
    assert.deepEqual(checkEntry(k.postings), []);
    assert.equal(k.postings.find((p) => p.accountCode === "5200")!.debit, 4700);
    assert.equal(k.postings.find((p) => p.accountCode === "1300")!.credit, 5000);
    assert.equal(k.postings.find((p) => p.accountCode === "2250")!.credit, 700);
    assert.equal(k.netPay, 50000 + 3200 + 1500 - 5000 - 700); // perquisites are not cash
  });
  test("an EMI repays principal and earns interest", () => {
    const k = payrollJournal([{ type: "EARNING", code: "BASIC", amount: 60000 }, { type: "DEDUCTION", code: "LOAN_EMI_1", amount: 10000 }, { type: "DEDUCTION", code: "LOAN_EMI_2", amount: 2500 }], { loanInterest: 1240.5 });
    assert.deepEqual(checkEntry(k.postings), []);
    assert.equal(k.postings.find((p) => p.accountCode === "1310")!.credit, 11259.5);
    assert.equal(k.postings.find((p) => p.accountCode === "4200")!.credit, 1240.5);
    assert.equal(k.netPay, 47500);
    assert.throws(() => payrollJournal([{ type: "DEDUCTION", code: "LOAN_EMI_1", amount: 100 }], { loanInterest: 200 }), /exceeds/);
  });
  test("an unknown employer component is flagged, not lost", () => {
    const k = payrollJournal([{ type: "EARNING", code: "BASIC", amount: 100 }, { type: "EMPLOYER_CONTRIBUTION", code: "NPS_EMPLOYER", amount: 10 }]);
    assert.deepEqual(checkEntry(k.postings), []);
    assert.deepEqual(k.unmapped, ["NPS_EMPLOYER"]);
  });
});

describe("Full and final settlement", () => {
  const zero: Settlement = { leaveEncashment: 0, lopReversal: 0, salaryArrears: 0, pendingSalary: 0, bonusPayable: 0, gratuity: 0, noticeBuyoutPay: 0, reimbursements: 0, overtimeAndShift: 0,
    noticeShortfallRecovery: 0, loanRecovery: 0, assetDamageRecovery: 0, advanceRecovery: 0, otherDeductions: 0, pfDeduction: 0, esiDeduction: 0, ptDeduction: 0, lwfDeduction: 0, tdsDeduction: 0 };
  test("dues paid out of the bank, gratuity out of the provision", () => {
    const j = settlementJournal({ ...zero, pendingSalary: 45000, leaveEncashment: 11013, gratuity: 120000, loanRecovery: 30000, pfDeduction: 2700, ptDeduction: 200, tdsDeduction: 8000 });
    assert.deepEqual(checkEntry(j.postings), []);
    assert.equal(j.net, 45000 + 11013 + 120000 - 30000 - 2700 - 200 - 8000);
    assert.equal(j.postings.find((p) => p.accountCode === "2400")!.debit, 120000);
    assert.equal(j.postings.find((p) => p.accountCode === "1100")!.credit, j.net);
  });
  test("an employee who owes more than is due leaves a receivable", () => {
    const j = settlementJournal({ ...zero, pendingSalary: 10000, noticeShortfallRecovery: 25000 });
    assert.deepEqual(checkEntry(j.postings), []);
    assert.equal(j.net, -15000);
    assert.equal(j.postings.find((p) => p.accountCode === "1300")!.debit, 15000);
    assert.equal(j.postings.find((p) => p.accountCode === "4300")!.credit, 25000);
  });
});

describe("Invoices and statements", () => {
  test("an intra-state invoice splits tax into CGST and SGST", () => {
    const p = invoiceJournal({ subtotal: 64000, cgst: 5760, sgst: 5760, igst: 0 });
    assert.deepEqual(checkEntry(p), []);
    assert.deepEqual(p.map((x) => [x.accountCode, x.debit || -x.credit]), [["1200", 75520], ["2300", -5760], ["2310", -5760], ["4100", -64000]]);
  });
  test("an export carries no tax lines", () => {
    assert.deepEqual(invoiceJournal({ subtotal: 450000, cgst: 0, sgst: 0, igst: 0 }).map((x) => x.accountCode), ["1200", "4100"]);
  });
  test("the balance sheet balances once profit is included", () => {
    const tb: TbRow[] = [
      { code: "1100", name: "Bank", accountClass: "ASSET", debit: 4_000_000, credit: 0 },
      { code: "1200", name: "Receivables", accountClass: "ASSET", debit: 75520, credit: 0 },
      { code: "2100", name: "Salaries payable", accountClass: "LIABILITY", debit: 0, credit: 300000 },
      { code: "2300", name: "CGST", accountClass: "LIABILITY", debit: 0, credit: 5760 },
      { code: "2310", name: "SGST", accountClass: "LIABILITY", debit: 0, credit: 5760 },
      { code: "3100", name: "Capital", accountClass: "EQUITY", debit: 0, credit: 4_000_000 },
      { code: "4100", name: "Revenue", accountClass: "INCOME", debit: 0, credit: 64000 },
      { code: "5100", name: "Salaries", accountClass: "EXPENSE", debit: 300000, credit: 0 },
    ];
    const s = statements(tb);
    assert.equal(s.profit, 64000 - 300000);
    assert.equal(s.totals.assets, 4_075_520);
    assert.ok(s.balances);
    assert.ok(!statements(tb.slice(1)).balances, "dropping the bank breaks it");
  });
});
