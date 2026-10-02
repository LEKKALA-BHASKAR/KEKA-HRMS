/**
 * Periodic statutory returns and full-and-final depth, through the real
 * routes, server actions and pages:
 *
 * - PF Form 3A/6A, ESI half-yearly, PT and LWF returns from finalised payroll,
 *   reconciled to the runs, downloadable as CSV and PDF only with statutory rights.
 * - A settlement on a real employee: choosing its month, the statement PDF and
 *   email, adjustments paid through an off-cycle payroll, voiding (blocked while
 *   an adjustment is paid, then undoing what finalising did), and the report.
 *
 * Everything created is removed and the employee put back as they were.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT|NEXT_NOT_FOUND/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
  const mailDir = await mkdtemp(path.join(os.tmpdir(), "keka-fnf-mail-"));
  process.env.MAIL_DIR = mailDir;

  const svc = await import("@keka/services");
  const fnf = await import("../apps/web/src/app/actions/fnf");
  const life = await import("../apps/web/src/app/actions/lifecycle");
  const { GET: returnsGet } = await import("../apps/web/src/app/(app)/payroll/filings/returns/route");
  const { GET: statementGet } = await import("../apps/web/src/app/(app)/exits/[id]/statement/route");
  const { GET: reportCsvGet } = await import("../apps/web/src/app/(app)/exits/settlements/export/route");
  const { GET: fileGet } = await import("../apps/web/src/app/files/[id]/route");
  const FilingsPage = (await import("../apps/web/src/app/(app)/payroll/filings/page")).default;
  const ExitPage = (await import("../apps/web/src/app/(app)/exits/[id]/page")).default;
  const ReportPage = (await import("../apps/web/src/app/(app)/exits/settlements/page")).default;
  const { fileTransport } = await import("../apps/web/src/lib/mail");
  const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const started = new Date();
  const get = (url: string) => new Request(`http://localhost${url}`) as never;
  const ret = (q: string) => returnsGet(get(`/payroll/filings/returns?${q}`));
  const body = async (res: Response) => Buffer.from(await res.arrayBuffer());
  const finalisedRuns = await prisma.payrollRun.findMany({ where: { tenantId: tenant.id, status: "FINALIZED", rolledBackAt: null, OR: [{ year: 2026, month: { gte: 4 } }, { year: 2027, month: { lte: 3 } }] }, select: { id: true, year: true, month: true } });
  const aug = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId: tenant.id, year: 2026, month: 8, type: "REGULAR", status: "FINALIZED" } });

  // The employee whose exit this suite runs, and what it will touch.
  const tanvi = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0026" }, include: { user: true } });
  const before = { status: tanvi.status, lastWorkingDay: tanvi.lastWorkingDay, exitInitiatedAt: tanvi.exitInitiatedAt, loginDisabled: tanvi.user?.loginDisabled ?? false };
  const category = await prisma.loanCategory.findFirstOrThrow({ where: { tenantId: tenant.id } });
  let loanId: string | null = null;
  let offCycleId: string | null = null;
  let settlementId: string | null = null;

  console.log("\nStatutory returns and full & final\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------
    section("Who can download returns");
    await signInAs("meera.krishnan@acme.test");
    check("An employee gets nothing (404, not 403)", (await ret("form=PF_6A&fy=2026&format=csv")).status === 404);
    await signInAs("ramesh.iyer@acme.test");
    check("An unknown form is refused", (await ret("form=FORM_99&fy=2026")).status === 400);
    check("A monthly PT return needs its month", (await ret("form=PT_MONTHLY&fy=2026")).status === 400);
    check("A year with no finalised payroll says so", (await ret("form=PF_6A&fy=2019")).status === 422);

    // -----------------------------------------------------------------
    section("PF Form 6A and 3A");
    const pfAgg = await prisma.payrollRunEmployee.aggregate({ where: { runId: { in: finalisedRuns.map((r) => r.id) }, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] } }, _sum: { pfEmployee: true, vpf: true, pfEmployer: true, epsEmployer: true, pfWage: true } });
    const r6a = await ret("form=PF_6A&fy=2026&format=csv");
    const csv6a = (await body(r6a)).toString("utf8");
    check("Payroll downloads Form 6A as CSV", r6a.status === 200 && /Form6A-FY2026\.csv/.test(r6a.headers.get("content-disposition") ?? ""));
    check("…which says to check it against the portal", csv6a.includes("Check every figure against the current portal format"));
    const ret6a = await svc.buildStatutoryReturn(tenant.id, { form: "PF_6A", fy: 2026 });
    const t = ret6a.sections[0].totals!;
    const wantWorker = Math.round((Number(pfAgg._sum.pfEmployee ?? 0) + Number(pfAgg._sum.vpf ?? 0)) * 100) / 100;
    check("Worker contributions equal the finalised runs', to the paisa", Math.abs(Number(t[4]) - wantWorker) < 0.01, `${t[4]} vs ${wantWorker}`);
    check("…and so do employer EPF and EPS", Math.abs(Number(t[5]) - Number(pfAgg._sum.pfEmployer ?? 0)) < 0.01 && Math.abs(Number(t[6]) - Number(pfAgg._sum.epsEmployer ?? 0)) < 0.01);
    check("Month-wise remittance adds up to the member totals", Math.abs(Number(ret6a.sections[1].totals![6]) - (Number(t[4]) + Number(t[5]) + Number(t[6]))) < 0.01);
    check("Months not finalised are listed as left out", ret6a.issues.some((i) => /Not finalised/.test(i) && i.includes("Sep 2026")), ret6a.issues.at(-1));
    const r3a = await ret("form=PF_3A&fy=2026&format=pdf");
    const pdf3a = await body(r3a);
    check("Form 3A downloads as a PDF", r3a.status === 200 && pdf3a.subarray(0, 5).toString() === "%PDF-" && r3a.headers.get("content-type") === "application/pdf");
    const ret3a = await svc.buildStatutoryReturn(tenant.id, { form: "PF_3A", fy: 2026 });
    check("One member card per PF member, twelve months each", ret3a.sections.length === new Set((await prisma.payrollRunEmployee.findMany({ where: { runId: { in: finalisedRuns.map((r) => r.id) }, pfEmployee: { gt: 0 } }, select: { employeeId: true } })).map((x) => x.employeeId)).size && ret3a.sections.every((s) => s.rows.length === 12), `${ret3a.sections.length} cards`);

    // -----------------------------------------------------------------
    section("ESI, PT and LWF");
    const esi = await ret("form=ESI_HALF&fy=2026&half=1&format=csv");
    const esiRet = await svc.buildStatutoryReturn(tenant.id, { form: "ESI_HALF", fy: 2026, half: 1 });
    const esiAgg = await prisma.payrollRunEmployee.aggregate({ where: { runId: { in: finalisedRuns.map((r) => r.id) }, esiGross: { gt: 0 } }, _sum: { esiEmployee: true, esiEmployer: true } });
    check("The ESI half-yearly summary downloads and reconciles", esi.status === 200 && Math.abs(Number(esiRet.sections[0].totals!.at(-2) ?? 0) - Number(esiAgg._sum.esiEmployee ?? 0) - Number(esiAgg._sum.esiEmployer ?? 0)) < 0.01, esiRet.summary);
    const ptAug = await svc.buildStatutoryReturn(tenant.id, { form: "PT_MONTHLY", fy: 2026, month: 8 });
    const ptAugAgg = await prisma.payrollRunEmployee.aggregate({ where: { run: { tenantId: tenant.id, year: 2026, month: 8, status: "FINALIZED", rolledBackAt: null } }, _sum: { professionalTax: true } });
    const ptSlabTotal = ptAug.sections.filter((s) => !s.heading.includes("employee detail")).reduce((s, x) => s + Number(x.totals?.[3] ?? 0), 0);
    const regs = await prisma.ptStateRegistration.count({ where: { payGroup: { tenantId: tenant.id }, isActive: true } });
    check("August PT: a slab table and an employee list per registration", ptAug.sections.length === regs * 2, `${ptAug.sections.length} sections for ${regs} registrations`);
    check("…and the registrations' totals plus anything unmapped equal the run's PT", ptSlabTotal === Number(ptAugAgg._sum.professionalTax ?? 0) || ptAug.issues.some((i) => /no registration/.test(i)), `${ptSlabTotal} vs ${ptAugAgg._sum.professionalTax}`);
    const ptPdf = await ret("form=PT_MONTHLY&fy=2026&month=8&format=pdf");
    check("The monthly PT return downloads as a PDF", ptPdf.status === 200 && (await body(ptPdf)).subarray(0, 5).toString() === "%PDF-");
    const ptYear = await svc.buildStatutoryReturn(tenant.id, { form: "PT_ANNUAL", fy: 2026 });
    check("The annual PT return has twelve months per registration", ptYear.sections.every((s) => s.rows.length === 12));
    const lwf = await ret("form=LWF&fy=2026&format=csv");
    check("The LWF returns download", lwf.status === 200 && (await body(lwf)).toString("utf8").includes("Labour Welfare Fund"));

    const filings = html(await FilingsPage({ searchParams: Promise.resolve({ fy: "2026" }) }));
    check("The filings page offers the periodic returns with the portal warning", filings.includes("Annual and periodic returns") && filings.includes("Check against the portal before filing") && filings.includes("form=PF_3A&amp;fy=2026&amp;format=pdf"));

    // -----------------------------------------------------------------
    section("Settlement month and statement");
    const loan = await prisma.loan.create({
      data: {
        employeeId: tanvi.id, categoryId: category.id, principal: 12000, installments: 4, emiAmount: 3050, status: "ACTIVE", outstanding: 12000,
        disbursedAt: new Date(Date.UTC(2026, 6, 1)), purpose: "Smoke test loan",
        schedule: { create: [10, 11, 12, 13].map((m, i) => ({ sequence: i + 1, year: m > 12 ? 2027 : 2026, month: m > 12 ? m - 12 : m, principalPart: 3000, interestPart: 50, totalAmount: 3050, balanceAfter: 12000 - 3000 * (i + 1) })) },
      },
    });
    loanId = loan.id;
    await prisma.employee.update({ where: { id: tanvi.id }, data: { status: "NOTICE_PERIOD", lastWorkingDay: new Date(Date.UTC(2026, 7, 31)) } });
    const exit = await prisma.exitRecord.create({ data: { employeeId: tanvi.id, type: "RESIGNATION", status: "APPROVED", noticeDate: new Date(Date.UTC(2026, 5, 1)), lastWorkingDay: new Date(Date.UTC(2026, 7, 31)), reason: "Smoke test exit" } });

    const early = await life.draftSettlementAction({}, fd({ employeeId: tanvi.id, period: "2026-07" }));
    check("A settlement cannot be booked before the last working day's month", early.ok === false && /before the last working day/.test(early.message ?? ""), early.message);
    const drafted = await life.draftSettlementAction({}, fd({ employeeId: tanvi.id, period: "2026-09" }));
    let s = await prisma.fnfSettlement.findUniqueOrThrow({ where: { employeeId: tanvi.id } });
    settlementId = s.id;
    check("Payroll drafts it, booked in September", drafted.ok === true && s.settlementYear === 2026 && s.settlementMonth === 9, drafted.message);
    await life.draftSettlementAction({}, fd({ employeeId: tanvi.id }));
    s = await prisma.fnfSettlement.findUniqueOrThrow({ where: { id: s.id } });
    check("Recomputing keeps the chosen month", s.settlementMonth === 9);
    const loanLine = (s.breakdown as { lines: Array<{ group: string; amount: number }> }).lines.find((l) => l.group === "Loans");
    check("The outstanding loan principal is recovered in it", loanLine?.amount === 12000, String(loanLine?.amount));

    const draftPdf = await statementGet(get(`/exits/${exit.id}/statement`), { params: Promise.resolve({ id: exit.id }) });
    const draftText = (await body(draftPdf)).toString("latin1");
    check("The draft statement downloads, marked as a draft", draftPdf.status === 200 && draftText.startsWith("%PDF-") && draftText.includes("DRAFT"));
    const early2 = await fnf.emailFnfStatementAction({}, fd({ employeeId: tanvi.id }));
    check("A draft is not emailed", early2.ok === false, early2.message);
    const earlyAdj = await fnf.addFnfAdjustmentAction({}, fd({ employeeId: tanvi.id, type: "PAYMENT", name: "x", amount: 100, target: "month:2026-09" }));
    check("No adjustments before the settlement is final", earlyAdj.ok === false, earlyAdj.message);
    const earlyVoid = await fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "Testing a void" }));
    check("A draft cannot be voided", earlyVoid.ok === false && /Only a finalised/.test(earlyVoid.message ?? ""), earlyVoid.message);

    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot download someone's statement", (await statementGet(get(`/exits/${exit.id}/statement`), { params: Promise.resolve({ id: exit.id }) })).status === 404);
    check("…nor email it", await denied(() => fnf.emailFnfStatementAction({}, fd({ employeeId: tanvi.id }))));
    check("…nor void a settlement", await denied(() => fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "Testing a void" }))));

    await signInAs("ramesh.iyer@acme.test");
    const fin = await life.finalizeSettlementAction({}, fd({ employeeId: tanvi.id }));
    s = await prisma.fnfSettlement.findUniqueOrThrow({ where: { id: s.id } });
    const effects = (s.breakdown as { effects?: { installments: unknown[]; loans: Array<{ status: string }>; employeeStatus: string } }).effects;
    check("Finalising records what it changes", fin.ok === true && effects?.installments.length === 4 && effects.loans[0]?.status === "ACTIVE" && effects.employeeStatus === "NOTICE_PERIOD", fin.message);
    check("…and forecloses the loan", (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status === "FORECLOSED");
    const finalPdf = (await body(await statementGet(get(`/exits/${exit.id}/statement`), { params: Promise.resolve({ id: exit.id }) }))).toString("latin1");
    check("The final statement shows it is final and the net in words", finalPdf.includes("FINALISED") && finalPdf.includes("Rupees"));

    const mailed = await fnf.emailFnfStatementAction({}, fd({ employeeId: tanvi.id }));
    const outbox = await prisma.emailOutbox.findFirst({ where: { tenantId: tenant.id, relatedType: "FnfSettlement", relatedId: s.id }, orderBy: { createdAt: "desc" } });
    check("Emailing queues it to the employee's personal address with the PDF attached", mailed.ok === true && outbox?.toAddress === tanvi.personalEmail && outbox?.attachmentFileIds.length === 1, mailed.message);
    if (outbox) {
      await fileTransport.send({ to: outbox.toAddress, subject: outbox.subject, text: outbox.textBody, attachmentFileIds: outbox.attachmentFileIds });
      const eml = await readFile(path.join(mailDir, (await readdir(mailDir))[0]), "utf8");
      check("The delivered mail carries the PDF as a base64 attachment", eml.includes("multipart/mixed") && eml.includes("Content-Disposition: attachment") && eml.includes("JVBERi0"));
      const kept = await fileGet(get("/files/x"), { params: Promise.resolve({ id: outbox.attachmentFileIds[0] }) });
      check("A copy is kept on file for payroll to open", kept.status === 200);
    }

    // -----------------------------------------------------------------
    section("Adjustments after settlement");
    const bad = await fnf.addFnfAdjustmentAction({}, fd({ employeeId: tanvi.id, type: "PAYMENT", name: "Late claim", amount: 0, target: "month:2026-09" }));
    check("An adjustment needs an amount", bad.ok === false, bad.message);
    const held = await fnf.addFnfAdjustmentAction({}, fd({ employeeId: tanvi.id, type: "PAYMENT", name: "Late travel reimbursement", amount: 2500, target: "month:2026-09", taxable: false }));
    const adj = await prisma.adhocTransaction.findFirstOrThrow({ where: { sourceType: "FnfSettlement", sourceId: s.id } });
    check("A payment found later is held for September", held.ok === true && adj.year === 2026 && adj.month === 9 && adj.runId === null && !adj.isProcessed, held.message);
    const start = await svc.startOffCycleRun({ tenantId: tenant.id, baseRunId: aug.id, employeeIds: [tanvi.id], reason: "Smoke: F&F adjustment" });
    offCycleId = start.runId ?? null;
    check("An off-cycle payroll is started against her last month", start.ok === true, start.message);
    const moved = await fnf.attachFnfAdjustmentAction({}, fd({ adjustmentId: adj.id, runId: offCycleId! }));
    const rec = await fnf.addFnfAdjustmentAction({}, fd({ employeeId: tanvi.id, type: "DEDUCTION", name: "Canteen dues", amount: 400, target: `run:${offCycleId}` }));
    const line = await prisma.payrollRunEmployee.findFirstOrThrow({ where: { runId: offCycleId!, employeeId: tanvi.id } });
    check("Both go onto the off-cycle payroll, which nets them", moved.ok === true && rec.ok === true && Number(line.grossEarnings) === 2500 && Number(line.netPay) === 2100, `gross ${line.grossEarnings}, net ${line.netPay}`);

    const exitHtml = html(await ExitPage({ params: Promise.resolve({ id: exit.id }) }));
    check("The exit page shows the settlement month, the statement, the void and the adjustments", exitHtml.includes("booked in September 2026") && exitHtml.includes("Download statement (PDF)") && exitHtml.includes("Void settlement") && exitHtml.includes("Canteen dues"));

    const finOff = await svc.finalizeOffCycleRun(offCycleId!, tenant.id, (await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } })).id);
    check("The off-cycle payroll pays them", finOff.ok === true && (await prisma.adhocTransaction.count({ where: { sourceId: s.id, isProcessed: true } })) === 2, finOff.message);

    // -----------------------------------------------------------------
    section("Void");
    const blocked = await fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "Gratuity basis was wrong" }));
    check("A settlement whose adjustment is paid cannot be voided", blocked.ok === false && /Roll that payroll back/.test(blocked.message ?? ""), blocked.message);
    const rb = await svc.rollbackOffCycleRun(offCycleId!, tenant.id, "Smoke: undo the adjustment");
    check("Rolling the off-cycle payroll back un-pays them", rb.ok === true);
    const noReason = await fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "" }));
    check("A void needs a reason", noReason.ok === false && !!noReason.errors?.reason, noReason.message);
    const voided = await fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "Gratuity basis was wrong" }));
    s = await prisma.fnfSettlement.findUniqueOrThrow({ where: { id: s.id } });
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: tanvi.id }, include: { exitRecord: true, user: true } });
    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id }, include: { schedule: true } });
    check("Payroll voids it, with the reason kept", voided.ok === true && s.status === "VOIDED" && s.voidReason === "Gratuity basis was wrong" && !!s.voidedAt, voided.message);
    check("The loan is active again with its schedule and interest restored", loanAfter.status === "ACTIVE" && loanAfter.schedule.every((i) => i.status === "SCHEDULED" && Number(i.interestPart) === 50));
    check("The employee is back on notice, the exit back in clearance, sign-in still off", after.status === "NOTICE_PERIOD" && after.exitRecord?.status === "IN_CLEARANCE" && (after.user?.loginDisabled ?? true) === true);
    check("Its unpaid adjustments are gone", (await prisma.adhocTransaction.count({ where: { sourceId: s.id } })) === 0);
    const fnfEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefType: "FnfSettlement", sourceRefId: s.id } });
    check("Its ledger entry is reversed", fnfEntries.length === 0 || fnfEntries.every((e) => e.status === "REVERSED"), `${fnfEntries.length} entr(ies)`);
    const again = await fnf.voidSettlementAction({}, fd({ employeeId: tanvi.id, reason: "Gratuity basis was wrong" }));
    check("It cannot be voided twice", again.ok === false && /already voided/.test(again.message ?? ""));

    // -----------------------------------------------------------------
    section("Settlements report");
    const rows = await svc.fnfReport(tenant.id, { fy: 2026 });
    const mine = rows.find((r) => r.settlementId === s.id);
    check("The report lists the voided settlement with its month and amounts", mine?.status === "VOIDED" && mine.settlementPeriod === "September 2026" && mine.totalRecovery > 0);
    const page = html(await ReportPage({ searchParams: Promise.resolve({ fy: "2026", status: "VOIDED" }) }));
    check("The report page renders it under its status", page.includes("Settlements report") && page.includes("Gratuity basis was wrong"));
    const csv = (await body(await reportCsvGet(get("/exits/settlements/export?fy=2026")))).toString("utf8");
    check("…and exports it as CSV", csv.includes("ACM0026") && csv.includes("VOIDED") && csv.includes("Net settlement"));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot export the report", (await reportCsvGet(get("/exits/settlements/export"))).status === 404);

    await signInAs("ramesh.iyer@acme.test");
    const redraft = await life.draftSettlementAction({}, fd({ employeeId: tanvi.id }));
    check("A voided settlement can be drafted afresh", redraft.ok === true && (await prisma.fnfSettlement.findUniqueOrThrow({ where: { id: s.id } })).status === "IN_REVIEW", redraft.message);
  } finally {
    // -----------------------------------------------------------------
    // Put everything back.
    const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefId: { in: [settlementId, offCycleId].filter((x): x is string => !!x) } }, select: { id: true } });
    const reversals = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, sourceRefType: "Reversal", sourceRefId: { in: entries.map((e) => e.id) } }, select: { id: true } });
    if (entries.length + reversals.length) await svc.purgeEntriesForTests(tenant.id, [...reversals, ...entries].map((e) => e.id));
    if (offCycleId) {
      await prisma.payslip.deleteMany({ where: { runId: offCycleId } });
      await prisma.payrollRun.deleteMany({ where: { id: offCycleId } });
    }
    if (settlementId) await prisma.adhocTransaction.deleteMany({ where: { sourceType: "FnfSettlement", sourceId: settlementId } });
    await prisma.fnfSettlement.deleteMany({ where: { employeeId: tanvi.id } });
    await prisma.exitRecord.deleteMany({ where: { employeeId: tanvi.id } });
    if (loanId) await prisma.loan.deleteMany({ where: { id: loanId } });
    await prisma.employee.update({ where: { id: tanvi.id }, data: { status: before.status, lastWorkingDay: before.lastWorkingDay, exitInitiatedAt: before.exitInitiatedAt } });
    if (tanvi.userId) await prisma.user.update({ where: { id: tanvi.userId }, data: { loginDisabled: before.loginDisabled } });
    await svc.trueUpExitAccrual(tanvi.id);
    const files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, relatedType: "FnfStatement", createdAt: { gte: started } } });
    for (const f of files) await unlink(path.join(STORAGE_DIR, f.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, relatedType: "FnfSettlement", createdAt: { gte: started } } });
    await rm(mailDir, { recursive: true, force: true });
  }
  report("Statutory returns and full & final");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
