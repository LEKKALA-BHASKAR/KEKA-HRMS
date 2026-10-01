import { prisma, Prisma } from "@keka/db";
import { DEFAULT_CHART, checkEntry, normalSide, payrollJournal, invoiceJournal, settlementJournal, statements, type AccountClass, type TbRow } from "./accounting-math";

/**
 * The general ledger. Every posting is a balanced entry with a sequential
 * number; posted entries are never edited or deleted — a mistake is undone by
 * a contra entry. Payroll months, salary payments, invoices and receipts post
 * themselves, each exactly once, keyed by the record that produced them.
 */

type Result = { ok: boolean; message: string; entryId?: string };
type Source = "MANUAL" | "PAYROLL" | "EXPENSE" | "INVOICE" | "PAYMENT" | "OPENING_BALANCE" | "LOAN";
type Tx = Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;
const SKIPPED = new Set(["VOID_SALARY_PROCESSING", "HOLD_SALARY_PROCESSING"]);

export interface EntryLine { accountId?: string; accountCode?: string; debit: number; credit: number; narration?: string | null; employeeId?: string | null; departmentId?: string | null; projectId?: string | null }
export interface JournalInput { tenantId: string; date: Date; narration: string; source: Source; ref?: { type: string; id: string }; lines: EntryLine[]; postedBy?: string | null }

/** Create any missing accounts of the default chart; returns code → id. */
export async function ensureChart(tenantId: string): Promise<Map<string, string>> {
  const existing = await prisma.account.findMany({ where: { tenantId }, select: { id: true, code: true } });
  const ids = new Map(existing.map((a) => [a.code, a.id]));
  for (const a of DEFAULT_CHART) {
    if (ids.has(a.code)) continue;
    const created = await prisma.account.create({
      data: { tenantId, code: a.code, name: a.name, accountClass: a.accountClass, isGroup: !!a.isGroup, isBankAccount: !!a.isBankAccount, normalSide: normalSide(a.accountClass), isSystem: true, parentId: a.parent ? ids.get(a.parent) ?? null : null },
    });
    ids.set(a.code, created.id);
  }
  return ids;
}

/** The closed accounting period a date falls in, if any. */
async function closedPeriod(tenantId: string, date: Date, db: Tx | typeof prisma = prisma) {
  return db.accountingPeriod.findFirst({ where: { tenantId, isClosed: true, startDate: { lte: date }, endDate: { gte: date } }, select: { code: true } });
}

/**
 * Post a balanced entry. With a `ref`, posting is idempotent: the same
 * record never reaches the ledger twice while its entry stands.
 */
export async function postEntry(input: JournalInput): Promise<Result> {
  const issues = checkEntry(input.lines);
  if (issues.length) return { ok: false, message: issues.join(" ") };
  if (input.ref) {
    const prior = await prisma.ledgerEntry.findFirst({ where: { tenantId: input.tenantId, sourceRefType: input.ref.type, sourceRefId: input.ref.id, status: "POSTED" }, select: { id: true, entryNumber: true } });
    if (prior) return { ok: true, message: `Already in the ledger as ${prior.entryNumber}.`, entryId: prior.id };
  }
  const closed = await closedPeriod(input.tenantId, input.date);
  if (closed) return { ok: false, message: `${closed.code} is closed. Reopen it, or date the entry in an open period.` };

  const codes = input.lines.filter((l) => !l.accountId && l.accountCode).map((l) => l.accountCode!);
  const chart = codes.length ? await ensureChart(input.tenantId) : new Map<string, string>();
  const lines = input.lines.map((l) => ({ ...l, accountId: l.accountId ?? chart.get(l.accountCode ?? "") ?? "" }));
  const accounts = await prisma.account.findMany({ where: { tenantId: input.tenantId, id: { in: [...new Set(lines.map((l) => l.accountId))] } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a) return { ok: false, message: "An account on the entry was not found." };
    if (a.isGroup) return { ok: false, message: `${a.code} ${a.name} is a group heading; post to one of its accounts.` };
    if (!a.isActive) return { ok: false, message: `${a.code} ${a.name} is inactive.` };
  }

  const entry = await prisma.$transaction(async (tx) => {
    // Numbering is per tenant and per year, without gaps or collisions.
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${input.tenantId} FOR UPDATE`;
    const year = input.date.getUTCFullYear();
    const n = await tx.ledgerEntry.count({ where: { tenantId: input.tenantId, entryNumber: { startsWith: `JV/${year}/` } } });
    const total = r2(lines.reduce((s, l) => s + l.debit, 0));
    const e = await tx.ledgerEntry.create({
      data: {
        tenantId: input.tenantId, entryNumber: `JV/${year}/${String(n + 1).padStart(5, "0")}`, entryDate: input.date, narration: input.narration,
        status: "POSTED", source: input.source, sourceRefType: input.ref?.type ?? null, sourceRefId: input.ref?.id ?? null,
        totalDebit: total, totalCredit: total, isBalanced: true, postedAt: new Date(), postedBy: input.postedBy ?? null, createdBy: input.postedBy ?? null,
        lines: { create: lines.map((l, i) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, narration: l.narration ?? null, employeeId: l.employeeId ?? null, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null, sequence: i })) },
      },
    });
    await applyBalances(tx, lines.map((l) => ({ account: byId.get(l.accountId)!, debit: l.debit, credit: l.credit })));
    return e;
  });
  return { ok: true, message: `Posted ${entry.entryNumber}.`, entryId: entry.id };
}

async function applyBalances(tx: Tx, legs: Array<{ account: { id: string; accountClass: string }; debit: number; credit: number }>) {
  const delta = new Map<string, number>();
  for (const l of legs) {
    const d = normalSide(l.account.accountClass as AccountClass) === "DEBIT" ? l.debit - l.credit : l.credit - l.debit;
    delta.set(l.account.id, r2((delta.get(l.account.id) ?? 0) + d));
  }
  for (const [id, d] of delta) await tx.account.update({ where: { id }, data: { currentBalance: { increment: d } } });
}

/** Undo a posted entry with its mirror image, dated today. */
export async function reverseEntry(opts: { tenantId: string; entryId: string; reason: string; byUserId?: string | null; date?: Date }): Promise<Result> {
  if (!opts.reason.trim()) return { ok: false, message: "Say why it is being reversed." };
  const e = await prisma.ledgerEntry.findFirst({ where: { id: opts.entryId, tenantId: opts.tenantId }, include: { lines: { include: { account: true } } } });
  if (!e) return { ok: false, message: "Entry not found." };
  if (e.status !== "POSTED") return { ok: false, message: `${e.entryNumber} is ${e.status.toLowerCase()} and cannot be reversed.` };
  if (e.sourceRefType === "Reversal") return { ok: false, message: "A reversal is not reversed again; post the original entry afresh instead." };
  const date = opts.date ?? new Date();
  const closed = await closedPeriod(opts.tenantId, date);
  if (closed) return { ok: false, message: `${closed.code} is closed.` };
  const contra = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${opts.tenantId} FOR UPDATE`;
    const year = date.getUTCFullYear();
    const n = await tx.ledgerEntry.count({ where: { tenantId: opts.tenantId, entryNumber: { startsWith: `JV/${year}/` } } });
    const c = await tx.ledgerEntry.create({
      data: {
        tenantId: opts.tenantId, entryNumber: `JV/${year}/${String(n + 1).padStart(5, "0")}`, entryDate: date, narration: `Reversal of ${e.entryNumber}: ${opts.reason}`,
        status: "POSTED", source: e.source, sourceRefType: "Reversal", sourceRefId: e.id,
        totalDebit: e.totalCredit, totalCredit: e.totalDebit, isBalanced: true, postedAt: new Date(), postedBy: opts.byUserId ?? null, createdBy: opts.byUserId ?? null,
        lines: { create: e.lines.map((l, i) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, narration: l.narration, employeeId: l.employeeId, departmentId: l.departmentId, projectId: l.projectId, sequence: i })) },
      },
    });
    await tx.ledgerEntry.update({ where: { id: e.id }, data: { status: "REVERSED", reversedById: c.id, reversedAt: new Date(), reversalReason: opts.reason } });
    await applyBalances(tx, e.lines.map((l) => ({ account: l.account, debit: Number(l.credit), credit: Number(l.debit) })));
    return c;
  });
  return { ok: true, message: `Reversed by ${contra.entryNumber}.`, entryId: contra.id };
}

/** The month's payroll as one accrual entry, from the finalised payslip lines. */
export async function postPayrollRun(runId: string, byUserId?: string | null): Promise<Result> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, include: { payGroup: { select: { tenantId: true, name: true } }, lines: { include: { lines: true } } } });
  if (!run) return { ok: false, message: "Payroll run not found." };
  if (run.status !== "FINALIZED") return { ok: false, message: "Only a finalised payroll reaches the ledger." };
  const processed = run.lines.filter((l) => !SKIPPED.has(l.payAction));
  // Ad-hoc lines carry their origin: a reimbursement is not salary, and an
  // advance recovery reduces an asset rather than creating a liability.
  const adhoc = await prisma.adhocTransaction.findMany({ where: { runId }, select: { employeeId: true, name: true, amount: true, sourceType: true } });
  const sourceOf = (employeeId: string, name: string, amount: number) => adhoc.find((a) => a.employeeId === employeeId && a.name === name && Math.abs(Number(a.amount) - amount) < 0.005)?.sourceType ?? null;
  const interest = await prisma.loanInstallment.aggregate({ where: { runId, status: "DEDUCTED" }, _sum: { interestPart: true } });
  const pay = payrollJournal(
    processed.flatMap((e) => e.lines.map((l) => ({ type: l.type, code: l.code, amount: Number(l.amount), source: /^ADHOC_/.test(l.code) ? sourceOf(e.employeeId, l.name, Number(l.amount)) : null }))),
    { loanInterest: Number(interest._sum.interestPart ?? 0) },
  );
  const expectedNet = r2(processed.reduce((s, e) => s + Number(e.netPay), 0));
  if (Math.abs(pay.netPay - expectedNet) > 0.005) return { ok: false, message: `The payslip lines give net pay ₹${pay.netPay} but the run says ₹${expectedNet}; not posted.` };
  const label = `${run.periodStart.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}`;
  return postEntry({
    tenantId: run.payGroup.tenantId, date: run.periodEnd, source: "PAYROLL", ref: { type: "PayrollRun", id: run.id }, postedBy: byUserId,
    narration: `Payroll ${label} — ${run.payGroup.name}, ${processed.length} employees`,
    lines: pay.postings.map((p) => ({ accountCode: p.accountCode, debit: p.debit, credit: p.credit, narration: p.narration })),
  });
}

/** Net pay leaving the bank: clears salaries payable. */
export async function recordSalaryPayment(runId: string, opts: { byUserId?: string | null; date?: Date; reference?: string | null } = {}): Promise<Result> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, include: { payGroup: { select: { tenantId: true, name: true } } } });
  if (!run || run.status !== "FINALIZED") return { ok: false, message: "Only a finalised payroll can be paid." };
  const accrued = await prisma.ledgerEntry.findFirst({ where: { tenantId: run.payGroup.tenantId, sourceRefType: "PayrollRun", sourceRefId: runId, status: "POSTED" } });
  if (!accrued) return { ok: false, message: "Post the payroll to the ledger first." };
  const net = r2(Number(run.totalNetPay));
  return postEntry({
    tenantId: run.payGroup.tenantId, date: opts.date ?? run.payDate ?? new Date(), source: "PAYMENT", ref: { type: "PayrollRunPayment", id: runId }, postedBy: opts.byUserId,
    narration: `Salaries paid — ${run.payGroup.name} ${run.month}/${run.year}${opts.reference ? ` (${opts.reference})` : ""}`,
    lines: [{ accountCode: "2100", debit: net, credit: 0, narration: "Net pay" }, { accountCode: "1100", debit: 0, credit: net, narration: "Bank transfer" }],
  });
}

/** Money lent to an employee leaves the bank and becomes a receivable. */
export async function postLoanDisbursement(loanId: string, byUserId?: string | null): Promise<Result> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { employee: { select: { tenantId: true, displayName: true, id: true } }, category: { select: { name: true } } } });
  if (!loan?.disbursedAt) return { ok: false, message: "The loan has not been disbursed." };
  const amt = r2(Number(loan.principal));
  return postEntry({
    tenantId: loan.employee.tenantId, date: loan.disbursedAt, source: "LOAN", ref: { type: "LoanDisbursement", id: loan.id }, postedBy: byUserId,
    narration: `${loan.category.name} disbursed to ${loan.employee.displayName}`,
    lines: [{ accountCode: "1310", debit: amt, credit: 0, employeeId: loan.employee.id }, { accountCode: "1100", debit: 0, credit: amt }],
  });
}

/** A foreclosure: the employee repays the remaining principal directly. */
export async function postLoanForeclosure(loanId: string, amount: number, byUserId?: string | null): Promise<Result> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { employee: { select: { tenantId: true, displayName: true, id: true } } } });
  if (!loan || !(amount > 0)) return { ok: false, message: "Nothing to post." };
  return postEntry({
    tenantId: loan.employee.tenantId, date: new Date(), source: "LOAN", ref: { type: "LoanForeclosure", id: loan.id }, postedBy: byUserId,
    narration: `Loan foreclosed by ${loan.employee.displayName}`,
    lines: [{ accountCode: "1100", debit: r2(amount), credit: 0 }, { accountCode: "1310", debit: 0, credit: r2(amount), employeeId: loan.employee.id }],
  });
}

/** A finalised full and final settlement, paid the day it is finalised. */
export async function postSettlement(settlementId: string, byUserId?: string | null): Promise<Result> {
  const s = await prisma.fnfSettlement.findUnique({ where: { id: settlementId }, include: { employee: { select: { id: true, tenantId: true, displayName: true } } } });
  if (!s || s.status !== "FINALIZED") return { ok: false, message: "Only a finalised settlement reaches the ledger." };
  const n = (v: unknown) => Number(v ?? 0);
  const j = settlementJournal({
    leaveEncashment: n(s.leaveEncashment), lopReversal: n(s.lopReversal), salaryArrears: n(s.salaryArrears), pendingSalary: n(s.pendingSalary), bonusPayable: n(s.bonusPayable),
    gratuity: n(s.gratuity), noticeBuyoutPay: n(s.noticeBuyoutPay), reimbursements: n(s.reimbursements), overtimeAndShift: n(s.overtimeAndShift),
    noticeShortfallRecovery: n(s.noticeShortfallRecovery), loanRecovery: n(s.loanRecovery), assetDamageRecovery: n(s.assetDamageRecovery), advanceRecovery: n(s.advanceRecovery),
    otherDeductions: n(s.otherDeductions), pfDeduction: n(s.pfDeduction), esiDeduction: n(s.esiDeduction), ptDeduction: n(s.ptDeduction), lwfDeduction: n(s.lwfDeduction), tdsDeduction: n(s.tdsDeduction),
  });
  if (Math.abs(j.net - n(s.netSettlement)) > 0.5) return { ok: false, message: `The settlement's parts give ₹${j.net} but its net is ₹${n(s.netSettlement)}; not posted.` };
  return postEntry({
    tenantId: s.employee.tenantId, date: s.finalizedAt ?? new Date(), source: "PAYROLL", ref: { type: "FnfSettlement", id: s.id }, postedBy: byUserId,
    narration: `Full and final settlement — ${s.employee.displayName}`,
    lines: j.postings.map((p) => ({ ...p, employeeId: s.employee.id })),
  });
}

/** A payroll rollback takes its accrual and payment out of the books. */
export async function reversePayrollPostings(runId: string, reason: string, byUserId?: string | null): Promise<string[]> {
  const entries = await prisma.ledgerEntry.findMany({ where: { sourceRefType: { in: ["PayrollRun", "PayrollRunPayment"] }, sourceRefId: runId, status: "POSTED" }, orderBy: { createdAt: "desc" } });
  const out: string[] = [];
  for (const e of entries) out.push((await reverseEntry({ tenantId: e.tenantId, entryId: e.id, reason: `Payroll rolled back: ${reason}`, byUserId })).message);
  return out;
}

/** A sent invoice: the receivable, the revenue and the output tax. */
export async function postInvoice(invoiceId: string, split: { cgst: number; sgst: number; igst: number }, byUserId?: string | null): Promise<Result> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { client: { select: { name: true } } } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  const postings = invoiceJournal({ subtotal: Number(inv.subtotal), ...split });
  if (Math.abs(postings.find((p) => p.accountCode === "1200")!.debit - Number(inv.total)) > 0.005) return { ok: false, message: "The tax split does not add up to the invoice total." };
  return postEntry({
    tenantId: inv.tenantId, date: inv.issueDate, source: "INVOICE", ref: { type: "Invoice", id: inv.id }, postedBy: byUserId,
    narration: `${inv.invoiceNumber} — ${inv.client.name}`,
    lines: postings.map((p) => ({ accountCode: p.accountCode, debit: p.debit, credit: p.credit, narration: p.narration, projectId: inv.projectId })),
  });
}

/** Money received against an invoice. */
export async function postInvoicePayment(paymentId: string, byUserId?: string | null): Promise<Result> {
  const p = await prisma.invoicePayment.findUnique({ where: { id: paymentId }, include: { invoice: { include: { client: { select: { name: true } } } } } });
  if (!p) return { ok: false, message: "Payment not found." };
  const amt = r2(Number(p.amount));
  return postEntry({
    tenantId: p.invoice.tenantId, date: p.paidOn, source: "PAYMENT", ref: { type: "InvoicePayment", id: p.id }, postedBy: byUserId,
    narration: `Receipt from ${p.invoice.client.name} against ${p.invoice.invoiceNumber}${p.reference ? ` (${p.reference})` : ""}`,
    lines: [{ accountCode: "1100", debit: amt, credit: 0, narration: "Bank" }, { accountCode: "1200", debit: 0, credit: amt, narration: p.invoice.invoiceNumber, projectId: p.invoice.projectId }],
  });
}

/**
 * Debit and credit totals per account over a window. Reversed entries stay
 * in, alongside their contras, so the pair nets to nothing — the books show
 * that it happened and was undone.
 */
export async function trialBalance(tenantId: string, opts: { from?: Date; to?: Date } = {}): Promise<{ rows: Array<TbRow & { id: string; balance: number }>; debit: number; credit: number }> {
  const sums = await prisma.ledgerLine.groupBy({
    by: ["accountId"],
    where: { entry: { tenantId, status: { in: ["POSTED", "REVERSED"] }, entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } },
    _sum: { debit: true, credit: true },
  });
  const accounts = await prisma.account.findMany({ where: { tenantId, isGroup: false }, orderBy: { code: "asc" } });
  const by = new Map(sums.map((s) => [s.accountId, s._sum]));
  const rows = accounts.map((a) => {
    const s = by.get(a.id);
    const dr = Number(s?.debit ?? 0), cr = Number(s?.credit ?? 0);
    // Shown as a single net balance on its natural side.
    const net = r2(dr - cr);
    return { id: a.id, code: a.code, name: a.name, accountClass: a.accountClass as AccountClass, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0, balance: net };
  }).filter((r) => r.debit !== 0 || r.credit !== 0);
  return { rows, debit: r2(rows.reduce((s, r) => s + r.debit, 0)), credit: r2(rows.reduce((s, r) => s + r.credit, 0)) };
}

/** Profit and loss for a period, and the balance sheet at its end. */
export async function financialStatements(tenantId: string, from: Date, to: Date) {
  const period = await trialBalance(tenantId, { from, to });
  const cumulative = await trialBalance(tenantId, { to });
  const pl = statements(period.rows);
  const bs = statements(cumulative.rows);
  return { pl: { income: pl.income, expenses: pl.expenses, totals: pl.totals, profit: pl.profit }, bs: { assets: bs.assets, liabilities: bs.liabilities, equity: bs.equity, totals: bs.totals, profitToDate: bs.profit, balances: bs.balances } };
}

/** One account's postings with a running balance, in its own sense. */
export async function accountLedger(tenantId: string, accountId: string, from: Date, to: Date) {
  const a = await prisma.account.findFirst({ where: { id: accountId, tenantId } });
  if (!a) return null;
  const sign = normalSide(a.accountClass as AccountClass) === "DEBIT" ? 1 : -1;
  const before = await prisma.ledgerLine.aggregate({ where: { accountId, entry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lt: from } } }, _sum: { debit: true, credit: true } });
  const opening = r2(sign * (Number(before._sum.debit ?? 0) - Number(before._sum.credit ?? 0)));
  const lines = await prisma.ledgerLine.findMany({
    where: { accountId, entry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { gte: from, lte: to } } },
    include: { entry: { select: { id: true, entryNumber: true, entryDate: true, narration: true, source: true, status: true } } },
    orderBy: [{ entry: { entryDate: "asc" } }, { entry: { entryNumber: "asc" } }],
  });
  let running = opening;
  const rows = lines.map((l) => {
    running = r2(running + sign * (Number(l.debit) - Number(l.credit)));
    return { id: l.id, entry: l.entry, narration: l.narration, debit: Number(l.debit), credit: Number(l.credit), balance: running };
  });
  return { account: a, opening, closing: running, rows };
}

/** Close or reopen a month: closed months take no postings. */
export async function setPeriodClosed(tenantId: string, code: string, closed: boolean, byUserId?: string | null): Promise<Result> {
  const m = /^(\d{4})-(\d{2})$/.exec(code);
  if (!m) return { ok: false, message: "Use a month like 2026-06." };
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)), end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0, 23, 59, 59));
  const existing = await prisma.accountingPeriod.findFirst({ where: { tenantId, code, legalEntityId: null } });
  if (existing) await prisma.accountingPeriod.update({ where: { id: existing.id }, data: { isClosed: closed, closedAt: closed ? new Date() : null, closedBy: closed ? byUserId ?? null : null } });
  else await prisma.accountingPeriod.create({ data: { tenantId, code, startDate: start, endDate: end, isClosed: closed, closedAt: closed ? new Date() : null, closedBy: closed ? byUserId ?? null : null } });
  return { ok: true, message: closed ? `${code} closed. Nothing more can be posted into it.` : `${code} reopened.` };
}

/**
 * Recompute every account's running balance from its lines. The ledger lines
 * are the truth; the stored balance is a cache of them.
 */
export async function rebuildAccountBalances(tenantId: string): Promise<number> {
  const accounts = await prisma.account.findMany({ where: { tenantId } });
  const sums = await prisma.ledgerLine.groupBy({ by: ["accountId"], where: { account: { tenantId }, entry: { status: { in: ["POSTED", "REVERSED"] } } }, _sum: { debit: true, credit: true } });
  const by = new Map(sums.map((s) => [s.accountId, s._sum]));
  let changed = 0;
  for (const a of accounts) {
    const s = by.get(a.id);
    const net = Number(s?.debit ?? 0) - Number(s?.credit ?? 0);
    const balance = r2(normalSide(a.accountClass as AccountClass) === "DEBIT" ? net : -net);
    if (Math.abs(balance - Number(a.currentBalance)) > 0.005) {
      await prisma.account.update({ where: { id: a.id }, data: { currentBalance: balance } });
      changed++;
    }
  }
  return changed;
}

/** Remove entries outright — for test fixtures only, never from the app. */
export async function purgeEntriesForTests(tenantId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const contras = await prisma.ledgerEntry.findMany({ where: { tenantId, sourceRefType: "Reversal", sourceRefId: { in: entryIds } }, select: { id: true } });
  const all = [...entryIds, ...contras.map((c) => c.id)];
  await prisma.ledgerEntry.updateMany({ where: { tenantId, id: { in: all } }, data: { reversedById: null } });
  await prisma.ledgerEntry.deleteMany({ where: { tenantId, id: { in: all } } });
  await rebuildAccountBalances(tenantId);
}
