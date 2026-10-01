/**
 * The general ledger through the actions and the payroll close: manual
 * entries balance or are refused, closed months stay closed, reversals undo
 * without deleting, a payroll month posts exactly once and comes back out on
 * rollback, and the stored balances always equal the lines beneath them.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function journal(date: string, narration: string, lines: Array<{ account: string; debit?: number; credit?: number }>) {
  const f = new FormData();
  f.set("date", date); f.set("narration", narration);
  lines.forEach((l, i) => { f.set(`account_${i}`, l.account); f.set(`debit_${i}`, String(l.debit ?? "")); f.set(`credit_${i}`, String(l.credit ?? "")); });
  return f;
}
async function attempt<T extends { ok?: boolean; message?: string }>(fn: () => Promise<T>): Promise<T | { ok: false; message: string }> {
  try { return await fn(); } catch (e) { return { ok: false, message: String((e as { digest?: string }).digest ?? e) }; }
}

async function main() {
  const a = await import("../apps/web/src/app/actions/accounting");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const acct = async (code: string) => prisma.account.findFirstOrThrow({ where: { tenantId: tenant.id, code } });
  const bal = async (code: string) => Number((await acct(code)).currentBalance);
  const [bank, rent, revenue, group] = await Promise.all([acct("1100"), acct("5900"), acct("4100"), acct("5000")]);
  const created: string[] = [];
  let runId = "";
  const consistent = async () => (await svc.rebuildAccountBalances(tenant.id)) === 0;
  const today = new Date().toISOString().slice(0, 10);

  console.log("\nAccounting\n" + "=".repeat(72));
  try {
    section("Who can post");
    await signInAs("meera.krishnan@acme.test");
    const nope = await attempt(() => a.postJournalAction({}, journal(today, "Smoke", [{ account: rent.id, debit: 100 }, { account: bank.id, credit: 100 }])));
    check("An employee cannot post to the ledger", nope.ok === false, nope.message);

    section("Manual entries");
    await signInAs("ramesh.iyer@acme.test"); // Payroll Admin: posts and reverses
    const unbalanced = await a.postJournalAction({}, journal(today, "Smoke unbalanced", [{ account: rent.id, debit: 100 }, { account: bank.id, credit: 90 }]));
    check("An entry that does not balance is refused", unbalanced.ok === false && /differ by 10\.00/.test(unbalanced.message ?? ""), unbalanced.message);
    const toGroup = await a.postJournalAction({}, journal(today, "Smoke group", [{ account: group.id, debit: 100 }, { account: bank.id, credit: 100 }]));
    check("A group heading cannot be posted to", toGroup.ok === false && /group/.test(toGroup.message ?? ""), toGroup.message);
    const closed = await a.postJournalAction({}, journal("2026-05-10", "Smoke closed", [{ account: rent.id, debit: 100 }, { account: bank.id, credit: 100 }]));
    check("A closed month takes no postings", closed.ok === false && /2026-05 is closed/.test(closed.message ?? ""), closed.message);
    const bankBefore = await bal("1100"), costBefore = await bal("5900");
    const posted = await a.postJournalAction({}, journal(today, "Smoke office supplies", [{ account: rent.id, debit: 1234.5 }, { account: bank.id, credit: 1234.5 }]));
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { tenantId: tenant.id, narration: "Smoke office supplies" }, include: { lines: true } });
    created.push(entry.id);
    check("A balanced entry posts with the next number", posted.ok === true && /^JV\/\d{4}\/\d{5}$/.test(entry.entryNumber) && entry.lines.length === 2, posted.message);
    check("Balances move on each account's own side", (await bal("1100")) === Math.round((bankBefore - 1234.5) * 100) / 100 && (await bal("5900")) === Math.round((costBefore + 1234.5) * 100) / 100);

    section("Reversal");
    const rev = await a.reverseEntryAction({}, fd({ entryId: entry.id, reason: "Smoke: wrong account" }));
    const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } });
    check("Reversing posts a contra and keeps the original", rev.ok === true && after.status === "REVERSED" && !!after.reversedById, rev.message);
    check("…and the balances are back where they were", (await bal("1100")) === bankBefore && (await bal("5900")) === costBefore);
    const twice = await a.reverseEntryAction({}, fd({ entryId: entry.id, reason: "again" }));
    check("An entry is reversed only once", twice.ok === false, twice.message);
    const contra = await a.reverseEntryAction({}, fd({ entryId: after.reversedById!, reason: "undo the undo" }));
    check("A reversal is not itself reversed", contra.ok === false, contra.message);
    const noReason = await a.reverseEntryAction({}, fd({ entryId: entry.id, reason: "" }));
    check("A reversal needs a reason", noReason.ok === false);

    section("Payroll posts itself");
    const pg = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const y = 2027, m = 2;
    await prisma.payrollRun.deleteMany({ where: { payGroupId: pg.id, year: y, month: m } });
    runId = await svc.createRun({ tenantId: tenant.id, payGroupId: pg.id, year: y, month: m });
    await svc.calculateRun(runId);
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "LOCKED" } });
    const salariesBefore = await bal("2100"), tdsBefore = await bal("2230");
    const actor = await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } });
    const fin = await svc.finalizePayrollRun(runId, actor.id);
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { lines: true } });
    const accrual = await prisma.ledgerEntry.findFirst({ where: { tenantId: tenant.id, sourceRefType: "PayrollRun", sourceRefId: runId }, include: { lines: { include: { account: true } } } });
    if (accrual) created.push(accrual.id);
    const sumOf = (code: string, side: "debit" | "credit") => Math.round((accrual?.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l[side]), 0) ?? 0) * 100) / 100;
    check("Finalising the month posts its accrual", fin.ok === true && !!accrual && /Posted JV/.test(fin.message), fin.message);
    check("Cost = gross + employer contributions", Number(accrual?.totalDebit) === Math.round((Number(run.totalGross) + Number(run.totalEmployerCost)) * 100) / 100, `${accrual?.totalDebit} vs ${Number(run.totalGross) + Number(run.totalEmployerCost)}`);
    check("Salaries payable = the run's net pay", sumOf("2100", "credit") === Number(run.totalNetPay) && (await bal("2100")) === Math.round((salariesBefore + Number(run.totalNetPay)) * 100) / 100);
    check("TDS payable = the TDS deducted", sumOf("2230", "credit") === Math.round(run.lines.reduce((s, l) => s + Number(l.tds), 0) * 100) / 100);
    const again = await svc.postPayrollRun(runId, actor.id);
    check("Posting the same month again changes nothing", again.ok === true && /Already in the ledger/.test(again.message), again.message);
    const pay = await a.salaryPaymentAction({}, fd({ runId, date: today, reference: "Smoke NEFT" }));
    const payEntry = await prisma.ledgerEntry.findFirst({ where: { tenantId: tenant.id, sourceRefType: "PayrollRunPayment", sourceRefId: runId } });
    if (payEntry) created.push(payEntry.id);
    check("Paying salaries clears what was accrued", pay.ok === true && (await bal("2100")) === salariesBefore, pay.message);
    const payAgain = await a.salaryPaymentAction({}, fd({ runId, date: today }));
    check("…once", payAgain.ok === true && /Already/.test(payAgain.message ?? ""), payAgain.message);
    await svc.rollbackPayrollRun(runId, "Smoke rollback");
    const gone = await prisma.ledgerEntry.count({ where: { tenantId: tenant.id, sourceRefId: runId, status: "POSTED" } });
    check("Rolling the month back reverses its accrual and payment", gone === 0 && (await bal("2100")) === salariesBefore && (await bal("2230")) === tdsBefore);

    section("Integrity");
    const tb = await svc.trialBalance(tenant.id);
    check("The trial balance balances", tb.debit === tb.credit && tb.debit > 0, `${tb.debit} / ${tb.credit}`);
    check("Every stored balance equals its lines", await consistent());
    const st = await svc.financialStatements(tenant.id, new Date("2026-04-01T00:00:00Z"), new Date());
    check("The balance sheet balances", st.bs.balances);
    const loans = await prisma.loan.findMany({ where: { employee: { tenantId: tenant.id }, status: { in: ["ACTIVE", "DISBURSED"] } } });
    check("Staff loans in the books equal the loans module", (await bal("1310")) === loans.reduce((s, l) => s + Number(l.outstanding), 0), `${await bal("1310")}`);
    const inv = await prisma.invoice.aggregate({ where: { tenantId: tenant.id, status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] } }, _sum: { amountDue: true } });
    check("Receivables in the books equal the open invoices", (await bal("1200")) === Number(inv._sum.amountDue ?? 0), `${await bal("1200")} vs ${inv._sum.amountDue}`);
    const advances = await prisma.cashAdvance.aggregate({ where: { tenantId: tenant.id, status: { in: ["DISBURSED", "PARTIALLY_SETTLED"] } }, _sum: { outstanding: true } });
    check("Employee advances in the books equal the open advances", (await bal("1300")) === Number(advances._sum.outstanding ?? 0), `${await bal("1300")} vs ${advances._sum.outstanding}`);
    void revenue;
  } finally {
    // Remove what this run added; the pairs net to nothing, so balances return.
    const fromRun = runId ? await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefId: runId }, select: { id: true } }) : [];
    await svc.purgeEntriesForTests(tenant.id, [...new Set([...created, ...fromRun.map((e) => e.id)])]);
    if (runId) await prisma.payrollRun.deleteMany({ where: { id: runId } });
  }
  report("Accounting");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
