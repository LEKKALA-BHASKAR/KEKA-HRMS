/**
 * My Finances through its actions, services and download routes:
 * flexible-benefit claims (limits, bills, withdrawal and who may touch them),
 * loan requests with the expected and EMI-start months, the previous-employer
 * rule in payroll, the salary timeline and breakup, the payslip bundle,
 * Form 12BB, the income-tax sheet, and loan category codes for admins.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const bill = (name = "bill.pdf") => new File([PDF], name, { type: "application/pdf" });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ym = (m: { year: number; month: number }) => `${m.year}-${String(m.month).padStart(2, "0")}`;

async function main() {
  const fin = await import("../apps/web/src/app/actions/finances");
  const loansA = await import("../apps/web/src/app/actions/loans");
  const tax = await import("../apps/web/src/app/actions/tax");
  const svc = await import("@keka/services");
  const docs = await import("@keka/documents");
  const { GET: bundleGet } = await import("../apps/web/src/app/(app)/finances/pay/payslips/download/route");
  const { GET: sheetGet } = await import("../apps/web/src/app/(app)/finances/pay/tax/sheet/route");
  const { GET: bbGet } = await import("../apps/web/src/app/(app)/finances/tax/forms/12bb/route");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n }, include: { user: { select: { email: true } } } });
  const [meera, ananya, aditya, borrower] = await Promise.all([emp("ACM0009"), emp("ACM0007"), emp("ACM0010"), emp("ACM0013")]);
  const started = new Date();
  const made = { claims: [] as string[], loans: [] as string[], files: [] as string[], categories: [] as string[] };
  const today = new Date();

  console.log("\nMy Finances\n" + "=".repeat(72));
  try {
    // -------------------------------------------------------------------------
    section("Component claims");
    const fy = svc.fyStartYear(today, tenant.fyStartMonth);
    const before = await svc.componentClaimSummary(meera.id, fy, today);
    const fuel = before.rows.find((r) => r.code === "FUEL_REIMB");
    check("Claimable components are the pay group's flexible-benefit reimbursements", before.rows.length > 0 && !!fuel && before.rows.every((r) => r.typeLabel === "Reimbursement"), before.rows.map((r) => r.code).join(", "));
    check("Each accrues a twelfth of its limit per month employed", !!fuel && fuel.monthly === 2400 && fuel.accrued === 2400 * (((today.getUTCMonth() + 12 - (tenant.fyStartMonth - 1)) % 12) + 1), `${fuel?.accrued}`);
    check("Remaining = accrued − claimed − pending", before.rows.every((r) => Math.abs(r.remaining - Math.max(0, r.accrued - r.claimed - r.pending)) < 0.01));

    await signInAs(meera.user!.email);
    const base = { componentId: fuel!.componentId, billDate: iso(new Date(today.getTime() - 3 * 86_400_000)), billNumber: "SMOKE-1", note: "Smoke fuel claim" };
    const withFile = (v: Record<string, string | number>, file: File | null = bill()) => { const f = fd(v); if (file) f.set("file", file); return f; };
    const over = await fin.submitComponentClaimAction({}, withFile({ ...base, amount: fuel!.remaining + 1 }));
    check("Claiming more than is left is refused", over.ok === false && /up to/i.test(over.message ?? ""), over.message);
    const future = await fin.submitComponentClaimAction({}, withFile({ ...base, amount: 500, billDate: iso(new Date(today.getTime() + 5 * 86_400_000)) }));
    check("A bill dated in the future is refused", future.ok === false && !!future.errors?.billDate, future.message);
    const noFile = await fin.submitComponentClaimAction({}, withFile({ ...base, amount: 500 }, null));
    check("A claim without its bill is refused", noFile.ok === false && !!noFile.errors?.file, noFile.message);
    const notPdf = await fin.submitComponentClaimAction({}, withFile({ ...base, amount: 500 }, new File([Buffer.from("hello")], "x.pdf", { type: "application/pdf" })));
    check("A file that is not really a PDF or image is refused", notPdf.ok === false, notPdf.message);
    const basic = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "BASIC" } });
    const wrong = await fin.submitComponentClaimAction({}, withFile({ ...base, componentId: basic.id, amount: 500 }));
    check("Basic salary is not a claimable component", wrong.ok === false, wrong.message);
    const filesBefore = await prisma.storedFile.count({ where: { tenantId: tenant.id, relatedType: "ComponentClaim", employeeId: meera.id } });
    const ok = await fin.submitComponentClaimAction({}, withFile({ ...base, amount: 750 }));
    const claim = await prisma.componentClaim.findFirst({ where: { employeeId: meera.id, comment: "Smoke fuel claim" } });
    if (claim) made.claims.push(claim.id);
    const stored = claim?.attachmentUrl ? await prisma.storedFile.findFirst({ where: { id: claim.attachmentUrl.replace("/files/", "") } }) : null;
    if (stored) made.files.push(stored.id);
    check("A valid claim is submitted with its bill attached", ok.ok === true && claim?.status === "SUBMITTED" && Number(claim.claimedAmount) === 750 && stored?.relatedId === claim.id && stored.employeeId === meera.id, ok.message);
    check("Refused claims leave no stored files behind", (await prisma.storedFile.count({ where: { tenantId: tenant.id, relatedType: "ComponentClaim", employeeId: meera.id } })) === filesBefore + 1);
    check("…and the claim is audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "ComponentClaim", entityId: claim?.id, createdAt: { gte: started } } })) === 1);
    const after = await svc.componentClaimSummary(meera.id, fy, today);
    check("The pending amount reduces what is left", Math.abs(after.rows.find((r) => r.code === "FUEL_REIMB")!.remaining - (fuel!.remaining - 750)) < 0.01);
    check("…and the claim shows under Pending Claims", after.pending.some((c) => c.id === claim?.id));

    await signInAs(aditya.user!.email);
    const theirs = await fin.withdrawComponentClaimAction({}, fd({ claimId: claim!.id }));
    check("Another employee cannot withdraw it", theirs.ok === false && !!(await prisma.componentClaim.findUnique({ where: { id: claim!.id } })), theirs.message);
    await signInAs(meera.user!.email);
    const withdrawn = await fin.withdrawComponentClaimAction({}, fd({ claimId: claim!.id }));
    check("The owner can withdraw a pending claim", withdrawn.ok === true && !(await prisma.componentClaim.findUnique({ where: { id: claim!.id } })), withdrawn.message);
    const processed = await prisma.componentClaim.findFirst({ where: { employeeId: meera.id, status: { in: ["APPROVED", "PAID"] } } });
    if (processed) {
      const late = await fin.withdrawComponentClaimAction({}, fd({ claimId: processed.id }));
      check("An approved claim cannot be withdrawn", late.ok === false, late.message);
    }

    // -------------------------------------------------------------------------
    section("Loan requests with payroll months");
    const open = await svc.openPayrollMonthFor(borrower.id);
    const lastClosed = await prisma.payrollRun.findFirst({ where: { payGroupId: borrower.payGroupId!, status: { in: ["LOCKED", "FINALIZED"] } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    check("The first open payroll month is after the last closed run", !lastClosed || svc.compareMonths(open, { year: lastClosed.year, month: lastClosed.month }) > 0, ym(open));
    const months = svc.payrollMonths(open, 4);
    const cats = await prisma.loanCategory.findMany({ where: { tenantId: tenant.id, policyRules: { some: {} } }, include: { policyRules: true } });
    const cat = cats.find((c) => c.policyRules[0]?.interestType === "NONE" && !c.name.toLowerCase().includes("emergency")) ?? cats[0];
    await signInAs(borrower.user!.email);
    const pv = await fin.previewLoanAction({ categoryId: cat.id, amount: 60000, installments: 6, start: ym(months[1]) });
    check("The drawer's preview shows the EMI and the schedule from the chosen month", pv.schedule.length === 6 && pv.schedule[0].year === months[1].year && pv.schedule[0].month === months[1].month && Math.abs(pv.total - 60000 - pv.interest) < 0.01, `${pv.emi} × ${pv.schedule.length}`);
    const flat = cats.find((c) => c.policyRules[0]?.interestType === "FLAT");
    if (flat) {
      const f = await fin.previewLoanAction({ categoryId: flat.id, amount: 120000, installments: 12, start: ym(months[0]) });
      const rate = Number(flat.policyRules[0].interestRate);
      check("Flat interest is charged on the full principal for the whole term", Math.abs(f.interest - 120000 * rate / 100) < 1 && Math.abs(f.total - (120000 + 120000 * rate / 100)) < 1, `${f.total}`);
    }
    const early = await loansA.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, expectedMonth: `${open.year - 1}-${String(open.month).padStart(2, "0")}`, startMonth: ym(months[1]) }));
    check("An expected month in a closed payroll is refused", early.ok === false && /expected month/i.test(early.message ?? ""), early.message);
    const backwards = await loansA.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, expectedMonth: ym(months[2]), startMonth: ym(months[1]) }));
    check("EMIs cannot start before the loan is paid out", backwards.ok === false && /cannot start/i.test(backwards.message ?? ""), backwards.message);
    const bad = await loansA.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, expectedMonth: "2026-13", startMonth: ym(months[1]) }));
    check("A malformed month is refused", bad.ok === false && !!bad.errors?.expectedMonth, bad.message);
    const applied = await loansA.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, expectedMonth: ym(months[1]), startMonth: ym(months[2]), purpose: "Smoke finances loan" }));
    const loan = await prisma.loan.findFirst({ where: { employeeId: borrower.id, purpose: "Smoke finances loan" } });
    if (loan) made.loans.push(loan.id);
    check("A request keeps its expected and EMI-start months", applied.ok === true && loan?.status === "PENDING_APPROVAL" && loan.expectedYear === months[1].year && loan.expectedMonth === months[1].month && loan.startYear === months[2].year && loan.startMonth === months[2].month, applied.message);
    await signInAs(meera.user!.email);
    const notMine = await fin.withdrawLoanAction({}, fd({ loanId: loan!.id }));
    check("Someone else cannot withdraw it", notMine.ok === false && (await prisma.loan.findUniqueOrThrow({ where: { id: loan!.id } })).status === "PENDING_APPROVAL", notMine.message);
    await signInAs("ramesh.iyer@acme.test");
    const decided = await loansA.decideLoanAction({}, fd({ loanId: loan!.id, decision: "approve" }));
    const sched = await prisma.loanInstallment.findMany({ where: { loanId: loan!.id }, orderBy: { sequence: "asc" } });
    check("Approval schedules EMIs from the month the employee asked for", decided.ok === true && sched[0]?.year === months[2].year && sched[0]?.month === months[2].month, decided.message);
    const applied2 = await (async () => { await signInAs(borrower.user!.email); return loansA.applyLoanAction({}, fd({ categoryId: cats.find((c) => c.id !== cat.id && c.policyRules.length)!.id, amount: 20000, installments: 4, expectedMonth: ym(months[0]), startMonth: ym(months[0]), purpose: "Smoke finances withdraw" })); })();
    const loan2 = await prisma.loan.findFirst({ where: { employeeId: borrower.id, purpose: "Smoke finances withdraw" } });
    if (loan2) made.loans.push(loan2.id);
    const w = loan2 ? await fin.withdrawLoanAction({}, fd({ loanId: loan2.id })) : { ok: false, message: applied2.message };
    check("The owner can withdraw a pending request", w.ok === true && (await prisma.loan.findUniqueOrThrow({ where: { id: loan2!.id } })).status === "WITHDRAWN", w.message);
    const again = await fin.withdrawLoanAction({}, fd({ loanId: loan2!.id }));
    check("…but not twice", again.ok === false, again.message);
    const approvedOne = await fin.withdrawLoanAction({}, fd({ loanId: loan!.id }));
    check("An approved loan cannot be withdrawn", approvedOne.ok === false, approvedOne.message);

    const summary = await svc.loanSummaryFor(meera.id);
    const meeraLoans = await prisma.loan.findMany({ where: { employeeId: meera.id, status: { in: ["DISBURSED", "ACTIVE", "CLOSED", "FORECLOSED"] } } });
    check("Loan Summary counts issued and ongoing loans", summary.issuedCount === meeraLoans.length && summary.ongoingCount === meeraLoans.filter((l) => ["ACTIVE", "DISBURSED"].includes(l.status)).length);
    const policy = await svc.loanPolicyView(tenant.id, (x) => String(x));
    check("The policy explanation lists eligibility and every category with a rule", !!policy && policy.eligibility.length >= 2 && policy.categories.length === cats.filter((c) => c.isActive).length, `${policy?.categories.length} categories`);
    const otherLoan = await prisma.loan.findFirst({ where: { employeeId: { not: meera.id }, employee: { tenantId: tenant.id } } });
    if (otherLoan) check("A loan's detail is only for its owner", (await svc.loanDetailFor(meera.id, otherLoan.id)) === null);

    // -------------------------------------------------------------------------
    section("Loan category codes (admin)");
    await signInAs("ramesh.iyer@acme.test");
    const c1 = await loansA.saveLoanCategoryAction({}, fd({ name: "Smoke Category", code: "smk-1", description: "Smoke" }));
    const cat1 = await prisma.loanCategory.findFirst({ where: { tenantId: tenant.id, name: "Smoke Category" } });
    if (cat1) made.categories.push(cat1.id);
    check("A category takes a code, stored in capitals", c1.ok === true && cat1?.code === "SMK-1", c1.message);
    const c2 = await loansA.saveLoanCategoryAction({}, fd({ name: "Smoke Category Two", code: "SMK-1" }));
    check("Codes are unique in the tenant", c2.ok === false && !!c2.errors?.code, c2.message);
    const c3 = await loansA.saveLoanCategoryAction({}, fd({ name: "Smoke Category Three", code: "bad code!" }));
    check("A malformed code is refused", c3.ok === false, c3.message);
    await signInAs(meera.user!.email);
    check("An employee cannot manage loan categories", await denied(() => loansA.saveLoanCategoryAction({}, fd({ name: "Nope", code: "NOPE" }))));

    // -------------------------------------------------------------------------
    section("Previous-employer income counts only in the year of joining");
    check("Meera joined before this FY", !svc.previousIncomeApplies(meera.dateOfJoining, fy, tenant.fyStartMonth));
    const refused = await tax.savePreviousIncomeAction({}, fd({ previousEmployerIncome: 100000, previousEmployerTds: 5000, previousEmployerPf: 0, previousEmployerPt: 0 }));
    check("…so she cannot declare previous income for it", refused.ok === false && /not required/i.test(refused.message ?? ""), refused.message);
    const run = await prisma.payrollRun.findFirst({ where: { tenantId: tenant.id, payGroupId: meera.payGroupId!, status: "IN_PROGRESS" } });
    if (run) {
      const tdsOf = async () => { await svc.calculateRun(run.id); return Number((await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: run.id, employeeId: meera.id } } })).tds); };
      const profile = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId: meera.id } });
      const tdsBefore = await tdsOf();
      await prisma.employeeStatutoryProfile.update({ where: { employeeId: meera.id }, data: { previousEmployerIncome: 900000, previousEmployerTds: 90000 } });
      const tdsWith = await tdsOf();
      await prisma.employeeStatutoryProfile.update({ where: { employeeId: meera.id }, data: { previousEmployerIncome: profile?.previousEmployerIncome ?? null, previousEmployerTds: profile?.previousEmployerTds ?? null } });
      await tdsOf();
      check("A stale previous-employer figure does not move this year's TDS", tdsBefore === tdsWith, `${tdsBefore} → ${tdsWith}`);
      const swati = await prisma.employee.findFirst({ where: { tenantId: tenant.id, firstName: "Swati", lastName: "Kulkarni" } });
      if (swati && svc.previousIncomeApplies(swati.dateOfJoining, fy, tenant.fyStartMonth) && (await prisma.payrollRunEmployee.findUnique({ where: { runId_employeeId: { runId: run.id, employeeId: swati.id } } }))) {
        const sp = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId: swati.id } });
        const swatiTds = async () => { await svc.calculateRun(run.id); return Number((await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: run.id, employeeId: swati.id } } })).tds); };
        await prisma.employeeStatutoryProfile.upsert({ where: { employeeId: swati.id }, create: { employeeId: swati.id, previousEmployerIncome: 0, previousEmployerTds: 0 }, update: { previousEmployerIncome: 0, previousEmployerTds: 0 } });
        const without = await swatiTds();
        await prisma.employeeStatutoryProfile.update({ where: { employeeId: swati.id }, data: { previousEmployerIncome: 1500000, previousEmployerTds: 0 } });
        const withPrev = await swatiTds();
        await prisma.employeeStatutoryProfile.update({ where: { employeeId: swati.id }, data: { previousEmployerIncome: sp?.previousEmployerIncome ?? null, previousEmployerTds: sp?.previousEmployerTds ?? null } });
        await swatiTds();
        check("…while a joiner's previous income this year raises her TDS", withPrev > without, `${without} → ${withPrev}`);
      }
    }

    // -------------------------------------------------------------------------
    section("Salary timeline and breakup");
    const timeline = await svc.salaryTimeline(meera.id);
    check("Every revision sums Regular + Other + Bonus = Total", timeline.length > 0 && timeline.every((t) => Math.abs(t.total - (t.regular + t.other + t.bonus)) < 0.01), `${timeline.length} revisions`);
    check("Exactly one revision is current", timeline.filter((t) => t.isCurrent).length === 1);
    const cur = timeline.find((t) => t.isCurrent)!;
    const b = cur.breakup!;
    check("The breakup's net pay is earnings less deductions", !!b && Math.abs(b.totals.net[1] - (b.totals.earnings[1] - b.totals.deductions[1])) < 0.01 && b.earnings.length > 0);
    check("Earnings plus employer contributions come to the CTC", !!b && Math.abs(b.totals.earnings[1] + b.totals.employer[1] - cur.regular) < 24, `${b.totals.earnings[1] + b.totals.employer[1]} vs ${cur.regular}`);
    check("Provident Fund is among the deductions", b.deductions.some((l) => l.code === "PF_EMPLOYEE"));
    const theirRev = await prisma.salaryRevision.findFirst({ where: { employeeId: ananya.id } });
    check("Another employee's revision has no breakup for Meera", !!theirRev && (await svc.salaryBreakup(meera.id, theirRev.id)) === null);
    const own = await svc.salaryBreakup(meera.id, cur.revisionId);
    check("…and her own does, with a current version in its history", !!own?.breakup && own.versions.some((v) => v.current));

    // -------------------------------------------------------------------------
    section("Downloads");
    await signInAs(meera.user!.email);
    const released = await prisma.payslip.count({ where: { employeeId: meera.id, status: "RELEASED", isSegregated: false } });
    const pan = (await prisma.employeeIdentity.findFirst({ where: { employeeId: meera.id, type: "PAN" } }))?.number.toUpperCase();
    const bundle = await svc.payslipBundlePdf(meera.id, 3);
    check("The 3-month bundle holds the latest released payslips", bundle.count === Math.min(3, released) && bundle.content.subarray(0, 5).toString() === "%PDF-", bundle.summary);
    check("…and opens only with the PAN", !!pan && docs.opensWith(bundle.content, pan) && !docs.opensWith(bundle.content, "WRONGPAN1"));
    const res = await bundleGet(new NextRequest("http://localhost/finances/pay/payslips/download?last=6"));
    check("The bundle route serves the signed-in employee a PDF", res.status === 200 && res.headers.get("content-type") === "application/pdf");
    const badLast = await bundleGet(new NextRequest("http://localhost/finances/pay/payslips/download?last=5"));
    check("…and only for 3, 6 or 12 months", badLast.status === 400);
    const sheet = await sheetGet(new NextRequest(`http://localhost/finances/pay/tax/sheet?fy=${fy}`));
    const csv = await sheet.text();
    check("The income-tax sheet downloads as CSV with every section", sheet.status === 200 && /text\/csv/.test(sheet.headers.get("content-type") ?? "") && /Gross Earnings/.test(csv) && /G\. Monthly TDS/.test(csv));
    const anyDecl = await prisma.investmentDeclaration.findFirst({ where: { employeeId: ananya.id }, select: { fyStartYear: true } });
    if (anyDecl) {
      const bb = await svc.form12bbPdf(ananya.id, anyDecl.fyStartYear);
      check("Form 12BB is generated from the declaration", bb.content.subarray(0, 5).toString() === "%PDF-" && /Form12BB/.test(bb.filename));
      await signInAs(ananya.user!.email);
      const bbRes = await bbGet(new NextRequest(`http://localhost/finances/tax/forms/12bb?fy=${anyDecl.fyStartYear}`));
      check("…and served to its owner", bbRes.status === 200);
    }
    await signInAs(meera.user!.email);
    const none = await bbGet(new NextRequest("http://localhost/finances/tax/forms/12bb?fy=2019"));
    check("A year without a declaration has no Form 12BB", none.status === 404);
    const exportAudit = await prisma.auditLog.count({ where: { tenantId: tenant.id, action: "EXPORT", createdAt: { gte: started }, entityType: { in: ["Payslip", "IncomeTaxComputation", "InvestmentDeclaration"] } } });
    check("Every download is audited", exportAudit >= 3, `${exportAudit}`);
  } finally {
    await prisma.componentClaim.deleteMany({ where: { id: { in: made.claims } } });
    await prisma.loan.deleteMany({ where: { id: { in: made.loans } } });
    await prisma.loanCategory.deleteMany({ where: { id: { in: made.categories } } });
    const files = await prisma.storedFile.findMany({ where: { OR: [{ id: { in: made.files } }, { tenantId: tenant.id, relatedType: "ComponentClaim", createdAt: { gte: started } }] } });
    const dir = process.env.STORAGE_DIR ?? path.join(process.cwd(), ".storage");
    for (const f of files) await unlink(path.join(dir, f.storageKey)).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await purgeLedgerSince(prisma, tenant.id, started);
  }
  report("My Finances");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
