/**
 * Expenses, advances and travel through the actions — and through payroll:
 * an approved claim must ride in the next payroll month as a non-taxable
 * payment, be marked paid when that month is finalised, and go back to
 * pending if the month is rolled back.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (n: number) => iso(new Date(Date.now() - n * DAY));

function claimForm(title: string, lines: Array<{ cat: string; date: string; amount: number; receipt?: boolean }>) {
  const f = new FormData();
  f.set("title", title);
  lines.forEach((l, i) => {
    f.set(`categoryId_${i}`, l.cat); f.set(`expenseDate_${i}`, l.date); f.set(`amount_${i}`, String(l.amount));
    if (l.receipt) f.set(`receipt_${i}`, new File([new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF"))], "r.pdf", { type: "application/pdf" }));
  });
  return f;
}

async function main() {
  const a = await import("../apps/web/src/app/actions/expenses");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const cat = async (n: string) => (await prisma.expenseCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: n } })).id;
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0009" } });
  const started = new Date();
  const created = { claims: [] as string[], runId: "" };

  console.log("\nExpenses\n" + "=".repeat(72));
  try {
    section("Policy checks on entry");
    await signInAs("meera.krishnan@acme.test");
    const conv = await cat("Local conveyance"), meals = await cat("Meals"), hotel = await cat("Hotel");
    const future = await a.submitClaimAction({}, claimForm("Smoke future", [{ cat: conv, date: iso(new Date(Date.now() + 3 * DAY)), amount: 200 }]));
    check("A future-dated expense is refused", future.ok === false && /future/.test(future.message ?? ""), future.message);
    const stale = await a.submitClaimAction({}, claimForm("Smoke stale", [{ cat: conv, date: ago(90), amount: 200 }]));
    check("An expense older than 60 days is refused", stale.ok === false && /older than 60/.test(stale.message ?? ""), stale.message);
    const noReceipt = await a.submitClaimAction({}, claimForm("Smoke no receipt", [{ cat: meals, date: ago(2), amount: 900 }]));
    check("A meal over ₹500 without a receipt is refused", noReceipt.ok === false && /receipt/.test(noReceipt.message ?? ""), noReceipt.message);
    const ok = await a.submitClaimAction({}, claimForm("Smoke trip", [{ cat: meals, date: ago(2), amount: 900, receipt: true }, { cat: hotel, date: ago(3), amount: 6500, receipt: true }]));
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke trip" }, include: { lines: true } });
    created.claims.push(claim.id);
    check("A valid claim is submitted, warning about the hotel limit", ok.ok === true && claim.stage === "SUBMITTED" && /limit/.test(ok.message ?? ""), ok.message);
    check("Receipts were stored and attached", claim.lines.every((l) => l.receiptUrl?.startsWith("/files/")));

    section("Approval");
    const self = await a.decideClaimAction({}, fd({ claimId: claim.id, decision: "approve" }));
    check("Nobody approves their own claim", self.ok === false);
    // Payroll admins hold unscoped expense approval by design; a finance
    // analyst with no expense rights is the real outsider.
    await signInAs("manish.tiwari@acme.test");
    const outside = await a.decideClaimAction({}, fd({ claimId: claim.id, decision: "approve" }));
    check("Someone without expense approval over her cannot approve it", outside.ok === false, outside.message);
    await signInAs("ananya.ghosh@acme.test");
    const hotelLine = claim.lines.find((l) => l.categoryId === hotel)!;
    const approved = await a.decideClaimAction({}, fd({ claimId: claim.id, decision: "approve", [`approved_${hotelLine.id}`]: "4500" }));
    const after = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
    check("Her manager approves, reducing the hotel to ₹4,500", approved.ok === true && Number(after.approvedTotal) === 5400, `${after.approvedTotal}`);
    const pay = await prisma.adhocTransaction.findFirst({ where: { sourceType: "ExpenseClaim", sourceId: claim.id } });
    check("…and ₹5,400 is queued as a non-taxable payment in the next payroll month", after.stage === "PAYMENT_PENDING" && Number(pay?.amount) === 5400 && pay?.taxTreatment === "NON_TAXABLE");

    section("Escalation to finance");
    await signInAs("meera.krishnan@acme.test");
    await a.submitClaimAction({}, claimForm("Smoke big", [{ cat: await cat("Flights"), date: ago(4), amount: 24000, receipt: true }, { cat: await cat("Client entertainment"), date: ago(4), amount: 6000, receipt: true }]));
    const big = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke big" } });
    created.claims.push(big.id);
    await signInAs("ananya.ghosh@acme.test");
    const lvl1 = await a.decideClaimAction({}, fd({ claimId: big.id, decision: "approve" }));
    check("Over ₹25,000 the manager's approval sends it to finance", lvl1.ok === true && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: big.id } })).stage === "PARTIALLY_APPROVED", lvl1.message);
    const again = await a.decideClaimAction({}, fd({ claimId: big.id, decision: "approve" }));
    check("…and the manager cannot approve the finance step too", again.ok === false, again.message);
    await signInAs("vikram.menon@acme.test");
    const fin = await a.decideClaimAction({}, fd({ claimId: big.id, decision: "approve" }));
    check("Finance completes the approval", fin.ok === true && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: big.id } })).stage === "PAYMENT_PENDING", fin.message);

    section("Paid with the salary");
    const { year, month } = { year: pay!.year, month: pay!.month };
    const group = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const existing = await prisma.payrollRun.findFirst({ where: { payGroupId: group.id, year, month } });
    if (!existing) {
      const runId = await svc.createRun({ tenantId: tenant.id, payGroupId: group.id, year, month });
      created.runId = runId;
      await svc.calculateRun(runId);
      const line = await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: meera.id } }, include: { lines: true } });
      const reimb = line.lines.filter((l) => l.name.startsWith("Expense reimbursement"));
      check(`The ${month}/${year} run pays both reimbursements to Meera`, reimb.reduce((s, l) => s + Number(l.amount), 0) === 5400 + 30000, reimb.map((l) => `${l.name} ${l.amount}`).join(", "));
      await prisma.payrollRun.update({ where: { id: runId }, data: { status: "LOCKED" } });
      const actor = await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } });
      await svc.finalizePayrollRun(runId, actor.id);
      const paid = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
      check("Finalising the month marks the claims paid", paid.stage === "PAID" && paid.paidInRunId === runId);
      await svc.rollbackPayrollRun(runId, "Smoke test");
      check("Rolling it back returns them to pending", (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).stage === "PAYMENT_PENDING");
    } else {
      console.log(`  (skipped: a ${month}/${year} run already exists)`);
    }

    section("Advances");
    await signInAs("meera.krishnan@acme.test");
    const req = await a.requestAdvanceAction({}, fd({ amount: 10000, purpose: "Smoke advance" }));
    const adv = await prisma.cashAdvance.findFirstOrThrow({ where: { employeeId: meera.id, purpose: "Smoke advance" } });
    check("An employee requests an advance", req.ok === true);
    const twice = await a.requestAdvanceAction({}, fd({ amount: 500, purpose: "Smoke second" }));
    check("…but not a second while one is open", twice.ok === false);
    await signInAs("vikram.menon@acme.test");
    await a.advanceOpAction({}, fd({ advanceId: adv.id, op: "approve" }));
    await a.advanceOpAction({}, fd({ advanceId: adv.id, op: "disburse" }));
    await signInAs("meera.krishnan@acme.test");
    const f = claimForm("Smoke settle", [{ cat: conv, date: ago(1), amount: 400 }]);
    f.set("advanceId", adv.id);
    await a.submitClaimAction({}, f);
    const settle = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke settle" } });
    created.claims.push(settle.id);
    await signInAs("ananya.ghosh@acme.test");
    await a.decideClaimAction({}, fd({ claimId: settle.id, decision: "approve" }));
    const adv2 = await prisma.cashAdvance.findUniqueOrThrow({ where: { id: adv.id } });
    const settled = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: settle.id } });
    check("A ₹400 claim against a ₹10,000 advance pays nothing and leaves ₹9,600 open", Number(adv2.outstanding) === 9600 && adv2.status === "PARTIALLY_SETTLED" && settled.stage === "PAID");
    await signInAs("vikram.menon@acme.test");
    const rec = await a.advanceOpAction({}, fd({ advanceId: adv.id, op: "recover" }));
    const recovery = await prisma.adhocTransaction.findFirst({ where: { sourceType: "CashAdvanceRecovery", sourceId: adv.id } });
    check("The rest is recovered through payroll", rec.ok === true && Number(recovery?.amount) === 9600 && recovery?.type === "DEDUCTION", rec.message);

    section("Travel");
    await signInAs("meera.krishnan@acme.test");
    const trip = await a.requestTripAction({}, fd({ purpose: "Smoke trip", fromCity: "Bengaluru", toCity: "Chennai", departDate: iso(new Date(Date.now() + 5 * DAY)), returnDate: iso(new Date(Date.now() + 6 * DAY)), travelType: "DOMESTIC" }));
    const t = await prisma.travelRequest.findFirstOrThrow({ where: { employeeId: meera.id, purpose: "Smoke trip" } });
    check("A trip is requested", trip.ok === true);
    await signInAs("manish.tiwari@acme.test");
    check("Someone without approval over her cannot approve it", (await a.tripOpAction({}, fd({ tripId: t.id, op: "approve" }))).ok === false);
    await signInAs("ananya.ghosh@acme.test");
    check("Her manager approves", (await a.tripOpAction({}, fd({ tripId: t.id, op: "approve" }))).ok === true);
    const book = await a.tripOpAction({}, fd({ tripId: t.id, op: "book", bookingRef: "X" }));
    check("…but only the travel desk books", book.ok === false, book.message);
    await signInAs("vikram.menon@acme.test");
    const booked = await a.tripOpAction({}, fd({ tripId: t.id, op: "book", bookingRef: "6E-123", actualCost: 4200 }));
    check("The travel desk books it", booked.ok === true && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: t.id } })).status === "BOOKED");
  } finally {
    await purgeLedgerSince(prisma, tenant.id, started);
    if (created.runId) {
      await prisma.adhocTransaction.updateMany({ where: { runId: created.runId }, data: { runId: null, isProcessed: false } });
      await prisma.payrollRun.delete({ where: { id: created.runId } }).catch(() => {});
    }
    await prisma.adhocTransaction.deleteMany({ where: { sourceType: { in: ["ExpenseClaim", "CashAdvanceRecovery"] }, createdAt: { gte: started } } });
    await prisma.expenseClaim.deleteMany({ where: { id: { in: created.claims } } });
    await prisma.cashAdvance.deleteMany({ where: { tenantId: tenant.id, purpose: { startsWith: "Smoke" } } });
    await prisma.travelRequest.deleteMany({ where: { tenantId: tenant.id, purpose: "Smoke trip" } });
    const files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, relatedType: "ExpenseReceipt", createdAt: { gte: started } } });
    const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");
    const { unlink } = await import("node:fs/promises");
    for (const x of files) await unlink(`${STORAGE_DIR}/${x.storageKey}`).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((x) => x.id) } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
    // Loan instalments the test month touched go back to scheduled.
    await prisma.loanInstallment.updateMany({ where: { deductedAt: { gte: started } }, data: { status: "SCHEDULED", runId: null, deductedAt: null } });
    for (const l of await prisma.loan.findMany({ where: { employee: { tenantId: tenant.id } } })) await svc.syncLoanBalance(l.id);
  }
  report("Expenses");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
