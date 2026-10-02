/**
 * The payroll gaps a pilot company hits first, end to end on the seeded
 * acme data:
 *   1. the attendance cut-off (LOP after it rolls into the next run; LOP
 *      recorded or reversed after a month closed is carried as LOP/arrears),
 *   2. salary holds released into the same run, a later run or off-cycle,
 *      per-employee payslip release and the payslip ZIP,
 *   3. payment batches with paid / failed outcomes, re-batching failures and
 *      hand-verified bank accounts,
 *   4. TDS challans and the quarterly 24Q statement.
 *
 * It runs on January and February 2027 so the seeded months are untouched:
 * January is finalised for the test and rolled back at the end, and every
 * run, record and posting it creates is removed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { inflateRawSync } from "node:zlib";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

/** File names inside a ZIP, read through its central directory. */
function zipNames(buf: Buffer): { names: string[]; firstPdf: boolean } {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  let firstPdf = false;
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    if (i === 0) {
      const ln = buf.readUInt16LE(off + 26);
      const body = buf.subarray(off + 30 + ln, off + 30 + ln + size);
      firstPdf = (method === 8 ? inflateRawSync(body) : body).subarray(0, 5).toString() === "%PDF-";
    }
    p += 46 + nameLen;
  }
  return { names, firstPdf };
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
  const svc = await import("@keka/services");
  const act = await import("../apps/web/src/app/actions/payroll-payout");
  const payrollAct = await import("../apps/web/src/app/actions/payroll");
  const { Step1 } = await import("../apps/web/src/app/(app)/payroll/runs/[id]/steps");
  const PayoutsPage = (await import("../apps/web/src/app/(app)/payroll/runs/[id]/payouts/page")).default;
  const Form24qPage = (await import("../apps/web/src/app/(app)/payroll/filings/24q/page")).default;
  const { GET: zipGet } = await import("../apps/web/src/app/(app)/payroll/runs/[id]/payslips-zip/route");
  const { GET: batchFileGet } = await import("../apps/web/src/app/(app)/payroll/runs/[id]/payouts/file/route");
  const { GET: exportGet } = await import("../apps/web/src/app/(app)/payroll/filings/24q/export/route");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "vikram.menon@acme.test" } });
  const byEmail = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } } });
  const meera = await byEmail("meera.krishnan@acme.test"), ramesh = await byEmail("ramesh.iyer@acme.test"), priya = await byEmail("priya.sharma@acme.test");
  const payGroup = await prisma.payGroup.findUniqueOrThrow({ where: { id: meera.payGroupId! } });
  const since = new Date();
  const ids = { runs: [] as string[], attendance: [] as string[], challans: [] as string[] };
  const meeraAcct = await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId: meera.id, isPrimary: true } });
  const nextUrl = (u: string) => { const r = new Request(u) as Request & { nextUrl: URL }; r.nextUrl = new URL(u); return r as never; };
  const runLine = (runId: string, employeeId: string) => prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId } } });
  const lopRecord = async (employeeId: string, date: Date, lopValue: number) => {
    const existing = await prisma.attendanceRecord.findFirst({ where: { employeeId, date } });
    if (existing) throw new Error(`attendance already exists on ${date.toISOString()}`);
    const r = await prisma.attendanceRecord.create({ data: { tenantId: tenant.id, employeeId, date, status: "ABSENT", lopValue, payableValue: 1 - lopValue } });
    ids.attendance.push(r.id);
    return r;
  };

  console.log("\nPayroll for a pilot company\n" + "=".repeat(72));
  try {
    if (await prisma.payrollRun.count({ where: { payGroupId: payGroup.id, year: 2027, month: { in: [1, 2] } } })) throw new Error("January/February 2027 runs already exist; clean them up first.");

    // ------------------------------------------------------------------
    section("1. Attendance cut-off");
    // Cut-off is day 25. Meera: absent on 12 Jan (reversed after January closes),
    // 28 Jan (after the cut-off, so February's), and 10 Jan recorded only after closing.
    const jan12 = await lopRecord(meera.id, d(2027, 1, 12), 1);
    await lopRecord(meera.id, d(2027, 1, 28), 1);
    const janId = await svc.createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2027, month: 1 });
    ids.runs.push(janId);
    await svc.calculateRun(janId);
    const jan = await prisma.payrollRun.findUniqueOrThrow({ where: { id: janId }, include: { payGroup: { include: { filingDetail: true } } } });
    check("January's window ends on the cut-off day", jan.attendanceTo?.toISOString().slice(0, 10) === "2027-01-25", `${jan.attendanceFrom?.toISOString().slice(0, 10)} to ${jan.attendanceTo?.toISOString().slice(0, 10)}`);
    const mJan = await runLine(janId, meera.id);
    check("LOP after the cut-off is not counted in January", Number(mJan.attendanceLopDays) === 1 && Number(mJan.lopDays) === 1, `window LOP ${mJan.attendanceLopDays}, total ${mJan.lopDays}`);

    // Hold Priya's payout before finalising: finalising turns it into a hold record.
    await prisma.payrollRunEmployee.update({ where: { runId_employeeId: { runId: janId, employeeId: priya.id } }, data: { payAction: "HOLD_PAYOUT", comment: "Smoke: documents pending" } });
    await svc.calculateRun(janId);
    await prisma.payrollRun.update({ where: { id: janId }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: admin.id } });
    const fin = await svc.finalizePayrollRun(janId, admin.id);
    check("January finalises", fin.ok, fin.message);

    // After closing: 12 Jan is regularised (LOP reversed); 10 Jan is marked absent late.
    await prisma.attendanceRecord.update({ where: { id: jan12.id }, data: { lopValue: 0 } });
    await lopRecord(meera.id, d(2027, 1, 10), 1);
    const febId = await svc.createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2027, month: 2 });
    ids.runs.push(febId);
    await svc.calculateRun(febId);
    const feb = await prisma.payrollRun.findUniqueOrThrow({ where: { id: febId }, include: { payGroup: { include: { filingDetail: true } } } });
    const mFeb = await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: febId, employeeId: meera.id } }, include: { lines: true } });
    check("February's window starts the day after January's", feb.attendanceFrom?.toISOString().slice(0, 10) === "2027-01-26" && feb.attendanceTo?.toISOString().slice(0, 10) === "2027-02-25");
    check("LOP after January's cut-off is counted in February", Number(mFeb.attendanceLopDays) === 1, String(mFeb.attendanceLopDays));
    const carries = await prisma.lopAdjustment.findMany({ where: { runId: febId, reversalForYear: 2027, reversalForMonth: 1, employeeId: meera.id } });
    // 10 Jan added (+1) and 12 Jan removed (−1) net to zero LOP days for January,
    // so nothing is carried yet; prove each direction separately.
    check("Equal late and reversed LOP in one month net to nothing", carries.length === 0 && Number(mFeb.carriedLopDays) === 0, `${carries.length} carry row(s)`);
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: meera.id, date: d(2027, 1, 10) } });
    await svc.calculateRun(febId);
    const rev = await prisma.lopAdjustment.findFirst({ where: { runId: febId, reversalForYear: 2027, reversalForMonth: 1, employeeId: meera.id } });
    const mFeb2 = await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: febId, employeeId: meera.id } }, include: { lines: true } });
    const arrears = mFeb2.lines.find((l) => l.code === "ARREARS");
    check("LOP reversed after January closed is paid back as arrears", !!rev && Number(rev.days) === -1 && Number(rev.amount) > 0 && Math.abs(Number(arrears?.amount ?? 0) - Number(rev.amount)) < 1, `days ${rev?.days} amount ${rev?.amount} arrears ${arrears?.amount}`);
    check("…recorded as reversal days on the line", Number(mFeb2.lopReversalDays) === 1);
    await lopRecord(meera.id, d(2027, 1, 14), 1);
    await lopRecord(meera.id, d(2027, 1, 15), 1);
    await svc.calculateRun(febId);
    const late = await prisma.lopAdjustment.findFirst({ where: { runId: febId, reversalForYear: 2027, reversalForMonth: 1, employeeId: meera.id } });
    const mFeb3 = await runLine(febId, meera.id);
    check("LOP recorded after January closed is deducted in February", Number(late?.days) === 1 && Number(mFeb3.carriedLopDays) === 1 && Number(mFeb3.lopDays) === 2, `carry ${late?.days}, line carried ${mFeb3.carriedLopDays}, total ${mFeb3.lopDays}`);
    check("Recalculating does not stack carry rows", (await prisma.lopAdjustment.count({ where: { runId: febId, reversalForYear: { not: null } } })) === 1);
    await signInAs("vikram.menon@acme.test");
    const lines = await prisma.payrollRunEmployee.findMany({ where: { runId: febId }, include: { employee: { include: { department: true, location: true } }, lines: true } });
    const step1 = html(await Step1({ run: feb as never, lines: lines as never, editable: true }));
    check("Step 1 shows the window and what was carried", step1.includes("26 Jan 2027") && step1.includes("Carried from closed months (1)") && step1.includes("LOP recorded late"));

    // ------------------------------------------------------------------
    section("2. Salary holds and payslip release");
    const priyaHold = await prisma.salaryHold.findFirst({ where: { runId: janId, employeeId: priya.id } });
    check("A payout hold set during the run becomes a hold record on finalising", !!priyaHold && priyaHold.status === "HELD" && Number(priyaHold.amount) > 0);
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot hold salaries", await denied(() => act.holdSalaryAction({}, fd({ runId: janId, employeeId: ramesh.id, reason: "x" }))));
    await signInAs("vikram.menon@acme.test");
    const h1 = await act.holdSalaryAction({}, fd({ runId: janId, employeeId: meera.id, reason: "Smoke: bank details query" }));
    check("A finalised run's payout can be held per employee", h1.ok === true && (await runLine(janId, meera.id)).payAction === "HOLD_PAYOUT", h1.message);
    const advice1 = await svc.buildBankAdvice(janId, tenant.id);
    check("Held pay is left out of the bank file", !advice1.content.toString().includes(meeraAcct.accountNumber) && /2 salary hold\(s\) left out/.test(advice1.summary), advice1.summary);
    const meeraHold = await prisma.salaryHold.findFirstOrThrow({ where: { runId: janId, employeeId: meera.id } });
    const r1 = await act.releaseHoldAction({}, fd({ holdId: meeraHold.id, targetRunId: janId }));
    const advice2 = await svc.buildBankAdvice(janId, tenant.id);
    check("Released into the same run, it is back in that run's bank file", r1.ok === true && advice2.content.toString().includes(meeraAcct.accountNumber) && advice2.content.toString().includes("HOLD REL"), r1.message);
    const r2 = await act.releaseHoldAction({}, fd({ holdId: priyaHold!.id, targetRunId: febId }));
    check("A hold can be released into a later run", r2.ok === true && (await svc.payablesForRun(febId)).some((p) => p.holdId === priyaHold!.id), r2.message);
    const u = await act.undoReleaseAction({}, fd({ holdId: priyaHold!.id }));
    check("…and taken back while unpaid", u.ok === true && (await prisma.salaryHold.findUniqueOrThrow({ where: { id: priyaHold!.id } })).status === "HELD", u.message);
    const off = await svc.startOffCycleRun({ tenantId: tenant.id, baseRunId: janId, employeeIds: [ramesh.id], reason: "Smoke off-cycle" });
    ids.runs.push(off.runId!);
    await svc.addOffCycleItem({ runId: off.runId!, tenantId: tenant.id, employeeId: ramesh.id, type: "PAYMENT", name: "Smoke correction", amount: 1000, taxable: false, byUserId: admin.id });
    await svc.finalizeOffCycleRun(off.runId!, tenant.id, admin.id);
    const r3 = await act.releaseHoldAction({}, fd({ holdId: priyaHold!.id, targetRunId: off.runId! }));
    const offAdvice = await svc.buildBankAdvice(off.runId!, tenant.id);
    check("…or into an off-cycle run, whose bank file then carries it", r3.ok === true && offAdvice.content.toString().includes("HOLD REL") && /incl\. 1 released hold/.test(offAdvice.summary), `${r3.message} / ${offAdvice.summary}`);

    const slip = await prisma.payslip.findFirstOrThrow({ where: { runId: janId, employeeId: meera.id } });
    const w = await act.payslipReleaseAction({}, fd({ runId: janId, employeeId: meera.id, release: "0" }));
    await payrollAct.releasePayslips(fd({ runId: janId }));
    const afterAll = await prisma.payslip.findUniqueOrThrow({ where: { id: slip.id } });
    const others = await prisma.payslip.count({ where: { runId: janId, status: "RELEASED" } });
    check("A withheld payslip stays back when the rest are released", w.ok === true && afterAll.status === "HELD" && others === (await prisma.payslip.count({ where: { runId: janId } })) - 1, `${afterAll.status}, ${others} released`);
    const rel = await act.payslipReleaseAction({}, fd({ runId: janId, employeeId: meera.id, release: "1" }));
    check("…and is released on its own", rel.ok === true && (await prisma.payslip.findUniqueOrThrow({ where: { id: slip.id } })).status === "RELEASED");
    const zipRes = await zipGet(new Request("http://localhost/x") as never, { params: Promise.resolve({ id: janId }) });
    const zip = Buffer.from(await zipRes.arrayBuffer());
    const z = zipNames(zip);
    check("All payslips download as one ZIP of PDFs", zipRes.status === 200 && z.names.length === (await prisma.payslip.count({ where: { runId: janId } })) && z.firstPdf && z.names.every((n) => n.endsWith(".pdf")), `${z.names.length} file(s)`);
    await signInAs("meera.krishnan@acme.test");
    const zipDenied = await zipGet(new Request("http://localhost/x") as never, { params: Promise.resolve({ id: janId }) });
    check("An employee cannot download the bundle", zipDenied.status === 404);

    // ------------------------------------------------------------------
    section("3. Payment batches and bank verification");
    await signInAs("vikram.menon@acme.test");
    const unv = await act.verifyBankAccountAction({}, fd({ accountId: meeraAcct.id, verified: "0" }));
    check("A bank account can be marked unverified / verified by hand", unv.ok === true && !(await prisma.employeeBankAccount.findUniqueOrThrow({ where: { id: meeraAcct.id } })).isVerified, unv.message);
    const advice3 = await svc.buildBankAdvice(janId, tenant.id);
    check("The bank file warns about the unverified account", advice3.issues.some((i) => i.includes("not verified") && i.includes(meeraAcct.accountNumber.slice(-4))) && advice3.content.toString().includes(meeraAcct.accountNumber));
    const b1 = await act.createBatchAction({}, fd({ runId: janId, mode: "UNBATCHED" }));
    const sum1 = await svc.runPayoutSummary(janId);
    const batch1 = await prisma.paymentBatch.findFirstOrThrow({ where: { runId: janId, number: 1 }, include: { items: true } });
    check("A batch takes every unbatched transfer, incl. a released hold", b1.ok === true && sum1.state.unbatched.length === 0 && batch1.items.length === sum1.payables.length && batch1.items.some((i) => i.salaryHoldId === meeraHold.id), b1.message);
    check("…flagging the unverified account", /unverified/.test(b1.message ?? "") && batch1.items.some((i) => i.employeeId === meera.id && !i.accountVerified));
    const again = await act.createBatchAction({}, fd({ runId: janId, mode: "UNBATCHED" }));
    check("Nobody is batched twice", again.ok === false, again.message);
    const fileRes = await batchFileGet(nextUrl(`http://localhost/x?batch=${batch1.id}`), { params: Promise.resolve({ id: janId }) });
    const fileText = Buffer.from(await fileRes.arrayBuffer()).toString();
    check("The batch downloads as a bank file", fileRes.status === 200 && fileText.includes("Beneficiary Name") && fileText.split("\n").length >= batch1.items.length);
    const failIds = batch1.items.filter((i) => i.employeeId === ramesh.id || (i.employeeId === meera.id && !i.salaryHoldId)).map((i) => i.id);
    const noReason = await act.markItemsAction({}, fd({ batchId: batch1.id, status: "FAILED", itemIds: failIds[0] }));
    check("A failure needs the bank's reason", noReason.ok === false);
    const failForm = fd({ batchId: batch1.id, status: "FAILED", failureReason: "Smoke: account closed" });
    failIds.forEach((x) => failForm.append("itemIds", x));
    const f1 = await act.markItemsAction({}, failForm);
    const paidForm = fd({ batchId: batch1.id, status: "PAID", reference: "UTRSMOKE1" });
    batch1.items.filter((i) => !failIds.includes(i.id)).forEach((i) => paidForm.append("itemIds", i.id));
    const p1 = await act.markItemsAction({}, paidForm);
    const sum2 = await svc.runPayoutSummary(janId);
    check("Outcomes are recorded per transfer and the batch closes", f1.ok === true && p1.ok === true && (await prisma.paymentBatch.findUniqueOrThrow({ where: { id: batch1.id } })).status === "CLOSED" && sum2.state.failed.length === failIds.length, `${f1.message} / ${p1.message}`);
    const paidEmployee = batch1.items.find((i) => !failIds.includes(i.id) && !i.salaryHoldId)!.employeeId;
    const paidHold = await act.holdSalaryAction({}, fd({ runId: janId, employeeId: paidEmployee, reason: "late" }));
    check("A salary already paid cannot be held", paidHold.ok === false, paidHold.message);
    await act.verifyBankAccountAction({}, fd({ accountId: meeraAcct.id, verified: "1" }));
    const b2 = await act.createBatchAction({}, fd({ runId: janId, mode: "FAILED" }));
    const batch2 = await prisma.paymentBatch.findFirstOrThrow({ where: { runId: janId, number: 2 }, include: { items: true } });
    check("Failed transfers re-batch, with the account as it stands now", b2.ok === true && batch2.items.length === failIds.length && batch2.items.every((i) => i.accountVerified), b2.message);
    const p2 = fd({ batchId: batch2.id, status: "PAID" });
    batch2.items.forEach((i) => p2.append("itemIds", i.id));
    await act.markItemsAction({}, p2);
    const sum3 = await svc.runPayoutSummary(janId);
    check("Everything is paid after the re-batch", sum3.state.failed.length === 0 && sum3.state.pending.length === 0 && Math.abs(sum3.totals.paid - sum3.totals.all) < 0.01, `paid ${sum3.totals.paid} of ${sum3.totals.all}`);
    // The off-cycle run sits on top of January; take it away first.
    const offRb = await svc.rollbackOffCycleRun(off.runId!, tenant.id, "smoke");
    const rb = await svc.rollbackPayrollRun(janId, "smoke");
    check("A run with paid transfers cannot be rolled back", offRb.ok && rb.ok === false && /marked paid/.test(rb.message), rb.message);
    const page = html(await PayoutsPage({ params: Promise.resolve({ id: janId }) }));
    check("The payouts screen renders batches, holds and payslips", page.includes("Batch 2") && page.includes("Salary holds (2)") && page.includes("Download all payslips"));

    // ------------------------------------------------------------------
    section("4. TDS challans and Form 24Q");
    const janTds = Math.round((await prisma.payrollRunEmployee.aggregate({ where: { runId: janId }, _sum: { tds: true } }))._sum.tds?.toNumber() ?? 0);
    const offTds = Math.round((await prisma.payrollRunEmployee.aggregate({ where: { runId: off.runId! }, _sum: { tds: true } }))._sum.tds?.toNumber() ?? 0);
    const bad = await act.recordChallanAction({}, fd({ period: "2027-01", payGroupId: payGroup.id, bsrCode: "12345", challanNumber: "1", paymentDate: "2027-02-07", tdsAmount: String(janTds) }));
    check("A malformed BSR code is refused", bad.ok === false && !!bad.errors?.bsrCode);
    const c1 = await act.recordChallanAction({}, fd({ period: "2027-01", payGroupId: payGroup.id, bsrCode: "0510308", challanNumber: "90001", paymentDate: "2027-02-07", tdsAmount: String(janTds + offTds), cess: "0" }));
    const challan = await prisma.tdsChallan.findFirst({ where: { tenantId: tenant.id, bsrCode: "0510308", challanNumber: "90001" } });
    if (challan) ids.challans.push(challan.id);
    check("A challan is recorded against the salary month", c1.ok === true && challan?.month === 1 && challan.year === 2027, c1.message);
    const dup = await act.recordChallanAction({}, fd({ period: "2027-01", payGroupId: payGroup.id, bsrCode: "0510308", challanNumber: "90001", paymentDate: "2027-02-07", tdsAmount: "1" }));
    check("The same counterfoil cannot be keyed twice", dup.ok === false, dup.message);
    const q = await svc.form24qQuarter(tenant.id, 2026, 4);
    const janRow = q.statement.months.find((m) => m.year === 2027 && m.month === 1);
    check("January reconciles: TDS deducted equals the challan", !!janRow && Math.abs(janRow.deducted - janRow.deposited) < 1 && !q.issues.some((i) => i.startsWith("01/2027:")), JSON.stringify(janRow));
    check("Every January deductee row is booked against the challan", q.statement.allocations.filter((a) => a.year === 2027 && a.month === 1 && a.tds > 0).every((a) => a.challanSerial === "90001"));
    check("Unfinalised months are reported", q.issues.some((i) => /February 2027 payroll is not finalised/.test(i)));
    const ex = await exportGet(nextUrl("http://localhost/x?fy=2026&q=4"));
    const csv = Buffer.from(await ex.arrayBuffer()).toString();
    check("The quarter exports as a structured CSV, labelled as not an FVU file", ex.status === 200 && csv.includes("DEDUCTOR") && csv.includes("not an FVU file") && csv.includes("CHALLAN,90001,0510308") && /DEDUCTEE,90001,0510308,07\/02\/2027,192,/.test(csv));
    const page24 = html(await Form24qPage({ searchParams: Promise.resolve({ fy: "2026", q: "4" }) }));
    check("The 24Q screen renders challans, deductees and the FVU warning", page24.includes("This is not an FVU file") && page24.includes("90001") && page24.includes("Deductee rows"));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot record challans", await denied(() => act.recordChallanAction({}, fd({}))));
    await signInAs("vikram.menon@acme.test");
    const del = await act.deleteChallanAction({}, fd({ id: challan!.id }));
    check("A challan can be removed before filing", del.ok === true && (await prisma.tdsChallan.count({ where: { id: challan!.id } })) === 0);
  } finally {
    // Batches go first (a paid transfer blocks rollback), then the runs are
    // rolled back so consumed inputs are released, then everything is removed.
    const runs = await prisma.payrollRun.findMany({ where: { OR: [{ id: { in: ids.runs } }, { payGroupId: payGroup.id, year: 2027, month: { in: [1, 2] }, createdAt: { gte: since } }] } });
    const runIds = runs.map((r) => r.id);
    await prisma.paymentBatch.deleteMany({ where: { runId: { in: runIds } } });
    for (const r of runs.filter((x) => x.status === "FINALIZED")) {
      if (r.type === "OFF_CYCLE") await svc.rollbackOffCycleRun(r.id, tenant.id, "smoke cleanup");
    }
    for (const r of runs.filter((x) => x.status === "FINALIZED" && x.type === "REGULAR")) await svc.rollbackPayrollRun(r.id, "smoke cleanup");
    await prisma.salaryHold.deleteMany({ where: { OR: [{ runId: { in: runIds } }, { releaseRunId: { in: runIds } }] } });
    await prisma.lopAdjustment.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.adhocTransaction.deleteMany({ where: { runId: { in: runIds }, name: { startsWith: "Smoke" } } });
    await prisma.attendanceRecord.deleteMany({ where: { id: { in: ids.attendance } } });
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: meera.id, date: { in: [d(2027, 1, 10), d(2027, 1, 12), d(2027, 1, 14), d(2027, 1, 15), d(2027, 1, 28)] } } });
    await prisma.tdsChallan.deleteMany({ where: { OR: [{ id: { in: ids.challans } }, { tenantId: tenant.id, bsrCode: "0510308", challanNumber: "90001" }] } });
    const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefId: { in: runIds } }, select: { id: true, reversedById: true } });
    const entryIds = [...entries.map((e) => e.id), ...entries.map((e) => e.reversedById).filter((x): x is string => !!x)];
    await prisma.ledgerEntry.updateMany({ where: { id: { in: entryIds } }, data: { reversedById: null } });
    await prisma.ledgerEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.employeeBankAccount.update({ where: { id: meeraAcct.id }, data: { isVerified: meeraAcct.isVerified, verifiedAt: meeraAcct.verifiedAt, verifiedBy: meeraAcct.verifiedBy } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, OR: [{ entityId: { in: [...runIds, meeraAcct.id, ...ids.challans] } }, { entityType: { in: ["PaymentBatch", "SalaryHold", "TdsChallan"] } }, { entityType: "Payslip", entityId: { startsWith: runIds[0] ?? "-" } }, { summary: { contains: "FY2026" }, entityType: "StatutoryFiling" }] } });
  }
  report("Payroll for a pilot company");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
