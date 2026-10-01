/**
 * Pure double-entry arithmetic — no database. The default chart of accounts,
 * the checks every journal entry must pass, how a payroll month and a sales
 * invoice turn into balanced postings, and the statements a trial balance
 * produces.
 */

export type AccountClass = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export interface ChartAccount { code: string; name: string; accountClass: AccountClass; parent?: string; isGroup?: boolean; isBankAccount?: boolean }
export interface Posting { accountCode: string; debit: number; credit: number; narration?: string }

const r2 = (n: number) => Math.round(n * 100) / 100;
const paise = (n: number) => Math.round(n * 100);

/** A chart for an Indian services company that runs payroll and bills clients. */
export const DEFAULT_CHART: ChartAccount[] = [
  { code: "1000", name: "Assets", accountClass: "ASSET", isGroup: true },
  { code: "1100", name: "Bank — current account", accountClass: "ASSET", parent: "1000", isBankAccount: true },
  { code: "1200", name: "Trade receivables", accountClass: "ASSET", parent: "1000" },
  { code: "1300", name: "Employee advances", accountClass: "ASSET", parent: "1000" },
  { code: "1310", name: "Employee loans", accountClass: "ASSET", parent: "1000" },
  { code: "2000", name: "Liabilities", accountClass: "LIABILITY", isGroup: true },
  { code: "2100", name: "Salaries payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2200", name: "Provident fund payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2210", name: "ESI payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2220", name: "Professional tax payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2230", name: "TDS payable — salaries", accountClass: "LIABILITY", parent: "2000" },
  { code: "2240", name: "Labour welfare fund payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2250", name: "Other payroll deductions payable", accountClass: "LIABILITY", parent: "2000" },
  { code: "2300", name: "Output CGST", accountClass: "LIABILITY", parent: "2000" },
  { code: "2310", name: "Output SGST", accountClass: "LIABILITY", parent: "2000" },
  { code: "2320", name: "Output IGST", accountClass: "LIABILITY", parent: "2000" },
  { code: "2400", name: "Provision for gratuity", accountClass: "LIABILITY", parent: "2000" },
  { code: "3000", name: "Equity", accountClass: "EQUITY", isGroup: true },
  { code: "3100", name: "Share capital", accountClass: "EQUITY", parent: "3000" },
  { code: "3200", name: "Retained earnings", accountClass: "EQUITY", parent: "3000" },
  { code: "4000", name: "Income", accountClass: "INCOME", isGroup: true },
  { code: "4100", name: "Revenue from services", accountClass: "INCOME", parent: "4000" },
  { code: "4200", name: "Interest income — staff loans", accountClass: "INCOME", parent: "4000" },
  { code: "4300", name: "Recoveries from employees", accountClass: "INCOME", parent: "4000" },
  { code: "5000", name: "Expenses", accountClass: "EXPENSE", isGroup: true },
  { code: "5100", name: "Salaries and wages", accountClass: "EXPENSE", parent: "5000" },
  { code: "5110", name: "Employer PF and EPS", accountClass: "EXPENSE", parent: "5000" },
  { code: "5115", name: "PF admin and EDLI charges", accountClass: "EXPENSE", parent: "5000" },
  { code: "5120", name: "Employer ESI", accountClass: "EXPENSE", parent: "5000" },
  { code: "5130", name: "Employer LWF", accountClass: "EXPENSE", parent: "5000" },
  { code: "5140", name: "Gratuity", accountClass: "EXPENSE", parent: "5000" },
  { code: "5200", name: "Employee reimbursements", accountClass: "EXPENSE", parent: "5000" },
  { code: "5900", name: "Other employee costs", accountClass: "EXPENSE", parent: "5000" },
];

/** Assets and expenses grow with debits; liabilities, equity and income with credits. */
export function normalSide(c: AccountClass): "DEBIT" | "CREDIT" {
  return c === "ASSET" || c === "EXPENSE" ? "DEBIT" : "CREDIT";
}

/** A balance in the account's own sense: positive is normal. */
export function signedBalance(c: AccountClass, debit: number, credit: number): number {
  return r2(normalSide(c) === "DEBIT" ? debit - credit : credit - debit);
}

/** Everything wrong with an entry; empty when it can post. */
export function checkEntry(lines: Array<{ debit: number; credit: number }>): string[] {
  const issues: string[] = [];
  if (lines.length < 2) issues.push("An entry needs at least two lines.");
  for (const [i, l] of lines.entries()) {
    if (l.debit < 0 || l.credit < 0) issues.push(`Line ${i + 1} has a negative amount.`);
    if ((l.debit > 0) === (l.credit > 0)) issues.push(`Line ${i + 1} must have either a debit or a credit.`);
    if ([l.debit, l.credit].some((v) => Math.abs(v * 100 - paise(v)) > 1e-6)) issues.push(`Line ${i + 1} has fractions of a paisa.`);
  }
  const dr = lines.reduce((s, l) => s + paise(l.debit), 0), cr = lines.reduce((s, l) => s + paise(l.credit), 0);
  if (dr !== cr) issues.push(`Debits (${(dr / 100).toFixed(2)}) and credits (${(cr / 100).toFixed(2)}) differ by ${(Math.abs(dr - cr) / 100).toFixed(2)}.`);
  return [...new Set(issues)];
}

/** Merge postings to the same account and side, dropping zeros. */
export function consolidate(postings: Posting[]): Posting[] {
  const by = new Map<string, Posting>();
  for (const p of postings) {
    if (!(p.debit > 0 || p.credit > 0)) continue;
    const k = `${p.accountCode}:${p.debit > 0 ? "D" : "C"}`;
    const cur = by.get(k) ?? { accountCode: p.accountCode, debit: 0, credit: 0, narration: p.narration };
    cur.debit = r2(cur.debit + p.debit); cur.credit = r2(cur.credit + p.credit);
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => (b.debit > 0 ? 1 : 0) - (a.debit > 0 ? 1 : 0) || a.accountCode.localeCompare(b.accountCode));
}

export interface PayLine { type: string; code: string; amount: number; source?: string | null }

/**
 * A payroll month as one accrual: cost on the left, what is owed to whom on
 * the right. Gross earnings and employer contributions are expenses; each
 * deduction is owed to the authority that collects it (or recovers an asset
 * like a loan); what is left is owed to the employees as net pay.
 */
export function payrollJournal(lines: PayLine[], opts: { loanInterest?: number } = {}): { postings: Posting[]; netPay: number; unmapped: string[] } {
  const out: Posting[] = [];
  const unmapped: string[] = [];
  const dr = (accountCode: string, amount: number, narration: string) => out.push({ accountCode, debit: r2(amount), credit: 0, narration });
  const cr = (accountCode: string, amount: number, narration: string) => out.push({ accountCode, debit: 0, credit: r2(amount), narration });
  let gross = 0, deductions = 0;
  for (const l of lines) {
    if (!(l.amount > 0)) continue;
    const code = l.code.toUpperCase();
    if (l.type === "EARNING" || l.type === "REIMBURSEMENT") {
      gross += l.amount;
      dr(l.type === "REIMBURSEMENT" || l.source === "ExpenseClaim" ? "5200" : "5100", l.amount, l.type === "REIMBURSEMENT" || l.source === "ExpenseClaim" ? "Reimbursements" : "Gross salaries");
    } else if (l.type === "EMPLOYER_CONTRIBUTION") {
      if (/^(PF_EMPLOYER|EPS)$/.test(code)) { dr("5110", l.amount, "Employer PF and EPS"); cr("2200", l.amount, "PF payable"); }
      else if (/^(PF_ADMIN|EDLI|EDLI_ADMIN)$/.test(code)) { dr("5115", l.amount, "PF admin and EDLI"); cr("2200", l.amount, "PF payable"); }
      else if (/^ESI/.test(code)) { dr("5120", l.amount, "Employer ESI"); cr("2210", l.amount, "ESI payable"); }
      else if (/^LWF/.test(code)) { dr("5130", l.amount, "Employer LWF"); cr("2240", l.amount, "LWF payable"); }
      else if (/GRATUITY/.test(code)) { dr("5140", l.amount, "Gratuity provision"); cr("2400", l.amount, "Gratuity provision"); }
      else { dr("5900", l.amount, code); cr("2250", l.amount, code); unmapped.push(code); }
    } else if (l.type === "DEDUCTION") {
      deductions += l.amount;
      if (/^(PF_EMPLOYEE|VPF)$/.test(code)) cr("2200", l.amount, "PF payable");
      else if (/^ESI/.test(code)) cr("2210", l.amount, "ESI payable");
      else if (/^PT$/.test(code)) cr("2220", l.amount, "Professional tax payable");
      else if (/^TDS$/.test(code)) cr("2230", l.amount, "TDS payable");
      else if (/^LWF/.test(code)) cr("2240", l.amount, "LWF payable");
      else if (/^LOAN_EMI/.test(code)) cr("1310", l.amount, "Loan recoveries");
      else if (l.source === "CashAdvanceRecovery") cr("1300", l.amount, "Advance recoveries");
      else { cr("2250", l.amount, code); if (!/^ADHOC_DED/.test(code)) unmapped.push(code); }
    }
    // PERK lines are taxable value, not cash: they never reach the ledger.
  }
  // An EMI is principal and interest: only the principal repays the loan;
  // the interest is the company's income.
  const interest = r2(opts.loanInterest ?? 0);
  if (interest > 0) {
    const emi = r2(out.filter((p) => p.accountCode === "1310").reduce((s, p) => s + p.credit, 0));
    if (interest > emi + 0.005) throw new Error(`Loan interest ${interest} exceeds the EMIs recovered (${emi}).`);
    for (let i = out.length - 1; i >= 0; i--) if (out[i].accountCode === "1310") out.splice(i, 1);
    cr("1310", emi - interest, "Loan principal recovered");
    cr("4200", interest, "Interest on staff loans");
  }
  const netPay = r2(gross - deductions);
  if (netPay > 0) cr("2100", netPay, "Net pay");
  else if (netPay < 0) dr("2100", -netPay, "Recoverable from employees");
  return { postings: consolidate(out), netPay, unmapped: [...new Set(unmapped)] };
}

export interface Settlement {
  leaveEncashment: number; lopReversal: number; salaryArrears: number; pendingSalary: number; bonusPayable: number; gratuity: number;
  noticeBuyoutPay: number; reimbursements: number; overtimeAndShift: number;
  noticeShortfallRecovery: number; loanRecovery: number; assetDamageRecovery: number; advanceRecovery: number; otherDeductions: number;
  pfDeduction: number; esiDeduction: number; ptDeduction: number; lwfDeduction: number; tdsDeduction: number;
}

/**
 * A full and final settlement, paid out of the bank on the day it is
 * finalised. Gratuity draws down the provision built up month by month;
 * recoveries reduce what the employee owes or count as income; what is left
 * goes to them — or, if they owe more than is due, becomes a receivable.
 */
export function settlementJournal(s: Settlement): { postings: Posting[]; net: number } {
  const out: Posting[] = [];
  const dr = (accountCode: string, amount: number, narration: string) => { if (amount > 0) out.push({ accountCode, debit: r2(amount), credit: 0, narration }); };
  const cr = (accountCode: string, amount: number, narration: string) => { if (amount > 0) out.push({ accountCode, debit: 0, credit: r2(amount), narration }); };
  dr("5100", s.pendingSalary + s.salaryArrears + s.lopReversal + s.bonusPayable + s.overtimeAndShift + s.noticeBuyoutPay + s.leaveEncashment, "Final salary, encashment and dues");
  dr("2400", s.gratuity, "Gratuity paid from the provision");
  dr("5200", s.reimbursements, "Reimbursements");
  cr("4300", s.noticeShortfallRecovery + s.assetDamageRecovery, "Notice and asset recoveries");
  cr("1310", s.loanRecovery, "Loan closed");
  cr("1300", s.advanceRecovery, "Advance recovered");
  cr("2250", s.otherDeductions, "Other deductions");
  cr("2200", s.pfDeduction, "PF"); cr("2210", s.esiDeduction, "ESI"); cr("2220", s.ptDeduction, "PT"); cr("2240", s.lwfDeduction, "LWF"); cr("2230", s.tdsDeduction, "TDS");
  const debits = out.reduce((t, p) => t + p.debit, 0), credits = out.reduce((t, p) => t + p.credit, 0);
  const net = r2(debits - credits);
  if (net > 0) cr("1100", net, "Settlement paid");
  else if (net < 0) dr("1300", -net, "Owed by the employee");
  return { postings: consolidate(out), net };
}

/** A sales invoice as revenue, output GST and a receivable. */
export function invoiceJournal(i: { subtotal: number; cgst: number; sgst: number; igst: number }): Posting[] {
  const total = r2(i.subtotal + i.cgst + i.sgst + i.igst);
  return consolidate([
    { accountCode: "1200", debit: total, credit: 0, narration: "Receivable" },
    { accountCode: "4100", debit: 0, credit: r2(i.subtotal), narration: "Services" },
    { accountCode: "2300", debit: 0, credit: r2(i.cgst), narration: "CGST" },
    { accountCode: "2310", debit: 0, credit: r2(i.sgst), narration: "SGST" },
    { accountCode: "2320", debit: 0, credit: r2(i.igst), narration: "IGST" },
  ]);
}

export interface TbRow { code: string; name: string; accountClass: AccountClass; debit: number; credit: number }

/**
 * Statements from a trial balance. Profit is income less expenses; the
 * balance sheet balances only when assets equal liabilities, equity and the
 * period's profit — which a correct ledger always gives.
 */
export function statements(tb: TbRow[]) {
  const bal = (c: AccountClass) => tb.filter((r) => r.accountClass === c).map((r) => ({ code: r.code, name: r.name, amount: signedBalance(c, r.debit, r.credit) })).filter((r) => r.amount !== 0);
  const sum = (rows: Array<{ amount: number }>) => r2(rows.reduce((s, r) => s + r.amount, 0));
  const income = bal("INCOME"), expenses = bal("EXPENSE"), assets = bal("ASSET"), liabilities = bal("LIABILITY"), equity = bal("EQUITY");
  const profit = r2(sum(income) - sum(expenses));
  return {
    income, expenses, profit,
    assets, liabilities, equity,
    totals: { income: sum(income), expenses: sum(expenses), assets: sum(assets), liabilities: sum(liabilities), equity: sum(equity) },
    balances: Math.abs(sum(assets) - (sum(liabilities) + sum(equity) + profit)) < 0.005,
  };
}
