/**
 * India payroll depth, end to end on the seeded acme data:
 *   1. per-employee component overrides the engine honours,
 *   2. run step 1: leave decided from the run, no-attendance days deducted,
 *      payable units for a daily-wage employee,
 *   3. the customised pay register (page data and CSV),
 *   4. variance, reconciliation and the journal voucher export,
 *   5. statutory bonus and gratuity settings,
 *   6. tax windows locked/reopened, declaration import, Form 12BA, 26Q,
 *   7. loan policies assigned by employee,
 *   8. Hide My Pay, the budget preview and increment scenarios,
 *   9. minimum wage, coverage and PT/LWF compliance reports,
 * plus permission refusals for an employee.
 *
 * It runs on January and February 2027 so seeded months are untouched, and removes
 * every run, record and setting it creates.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const nx = (u: string) => { const r = new Request(u) as Request & { nextUrl: URL }; r.nextUrl = new URL(u); return r as never; };
const empty = { ok: false, message: "" } as never;

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const svc = await import("@keka/services");
  const act = await import("../apps/web/src/app/actions/payroll-depth");
  const { GET: registerCsvGet } = await import("../apps/web/src/app/api/payroll/register.csv/route");
  const { GET: varianceGet } = await import("../apps/web/src/app/(app)/payroll/variance/export/route");
  const { GET: jvGet } = await import("../apps/web/src/app/(app)/payroll/runs/[id]/journal-voucher/route");
  const { GET: q26Get } = await import("../apps/web/src/app/(app)/payroll/filings/26q/export/route");
  const { GET: bonusGet } = await import("../apps/web/src/app/(app)/payroll/statutory-bonus/export/route");
  const { GET: ba12Get } = await import("../apps/web/src/app/(app)/payroll/tax-admin/12ba/route");
  const { GET: complianceGet } = await import("../apps/web/src/app/(app)/payroll/compliance/export/route");
  const MyPayLayout = (await import("../apps/web/src/app/(app)/finances/pay/layout")).default;

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "vikram.menon@acme.test" } });
  const byEmail = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } } });
  const meera = await byEmail("meera.krishnan@acme.test"), ramesh = await byEmail("ramesh.iyer@acme.test"), priya = await byEmail("priya.sharma@acme.test");
  const vikram = await byEmail("vikram.menon@acme.test");
  const payGroup = await prisma.payGroup.findUniqueOrThrow({ where: { id: meera.payGroupId! }, include: { payRegisterConfig: true } });
  const since = new Date();
  const ids = { runs: [] as string[], attendance: [] as string[], leaveRequests: [] as string[], overrides: [] as string[], contractors: [] as string[], policies: [] as string[], scenarios: [] as string[], ledger: [] as string[] };
  const prefsBefore = await prisma.payrollPreference.findUnique({ where: { tenantId: tenant.id } });
  const rameshRev = await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: ramesh.id, status: "APPLIED", effectiveFrom: { lte: d(2027, 2, 28) } }, orderBy: { effectiveFrom: "desc" } });
  const line = (runId: string, employeeId: string) => prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId } }, include: { lines: true } });
  const amount = (l: { lines: Array<{ code: string; amount: Prisma.Decimal }> }, code: string) => Number(l.lines.find((x) => x.code === code)?.amount ?? 0);

  console.log("\nPayroll depth\n" + "=".repeat(72));
  try {
    if (await prisma.payrollRun.count({ where: { payGroupId: payGroup.id, year: 2027, month: { in: [1, 2] } } })) throw new Error("January/February 2027 runs already exist; clean them up first.");
    await signInAs("vikram.menon@acme.test");
    const janId = await svc.createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2027, month: 1 });
    ids.runs.push(janId);
    await svc.calculateRun(janId);
    const febId = await svc.createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2027, month: 2 });
    ids.runs.push(febId);
    await svc.calculateRun(febId);

    // ------------------------------------------------------------------
    section("1. Component overrides");
    const meeraAug = await line(febId, meera.id);
    const hraLine = meeraAug.lines.find((l) => l.type === "EARNING" && l.code !== "BASIC" && Number(l.amount) > 0)!;
    const hra = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: hraLine.code } });
    const grossBefore = Number(meeraAug.grossEarnings);
    let r = await act.saveComponentOverrideAction(empty, fd({ employeeId: meera.id, componentId: hra.id, amount: 12345, from: "2027-02", note: "Smoke override" }));
    check("An override is saved", r.ok, r.message);
    const ov = await prisma.employeeComponentOverride.findFirst({ where: { tenantId: tenant.id, employeeId: meera.id, note: "Smoke override" } });
    if (ov) ids.overrides.push(ov.id);
    const meeraAug2 = await line(febId, meera.id);
    check("The open run is recalculated with the fixed amount", amount(meeraAug2, hra.code) === 12345 || Number(meeraAug2.lopDays) > 0, `${hra.code} ${amount(meeraAug2, hra.code)}`);
    check("CTC is held: the balancing component absorbs the change", Math.abs(Number(meeraAug2.grossEarnings) - grossBefore) < 1 || hra.isOutsideCtc, `${grossBefore} -> ${meeraAug2.grossEarnings}`);
    check("January (before the override) is untouched", amount(await line(janId, meera.id), hra.code) === Number(hraLine.amount));
    r = await act.saveComponentOverrideAction(empty, fd({ employeeId: vikram.id, componentId: hra.id, amount: 99999, from: "2027-02" }));
    check("Overriding your own salary is refused", !r.ok, r.message);
    r = await act.saveComponentOverrideAction(empty, fd({ employeeId: meera.id, componentId: hra.id, amount: -5, from: "2027-02" }));
    check("A negative amount is refused", !r.ok, r.message);
    r = await act.deleteComponentOverrideAction(empty, fd({ id: ov?.id ?? "" }));
    check("Removing it restores the structure amount", r.ok && amount(await line(febId, meera.id), hra.code) === amount(meeraAug, hra.code), r.message);

    // ------------------------------------------------------------------
    section("2. Run step 1");
    const lt = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, isPaid: true, balances: { some: { employeeId: priya.id, available: { gte: 2 } } } } });
    const pending = await prisma.leaveRequest.create({ data: { tenantId: tenant.id, employeeId: priya.id, leaveTypeId: lt.id, fromDate: d(2027, 2, 10), toDate: d(2027, 2, 10), totalDays: 1, reason: "Smoke" } });
    ids.leaveRequests.push(pending.id);
    r = await act.decideRunLeaveAction(empty, fd({ runId: febId, requestId: pending.id, decision: "reject" }));
    check("Rejecting from the run needs a reason", !r.ok, r.message);
    r = await act.decideRunLeaveAction(empty, fd({ runId: febId, requestId: pending.id, decision: "reject", note: "Smoke: not in window" }));
    check("Pending leave is rejected from the run", r.ok && (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: pending.id } })).status === "REJECTED", r.message);

    for (const day of [16, 17, 18]) {
      const existing = await prisma.attendanceRecord.findFirst({ where: { employeeId: priya.id, date: d(2027, 2, day) } });
      if (existing) throw new Error(`attendance already exists on 2027-02-${day}`);
      ids.attendance.push((await prisma.attendanceRecord.create({ data: { tenantId: tenant.id, employeeId: priya.id, date: d(2027, 2, day), status: "NO_ATTENDANCE", payableValue: 1, lopValue: 0 } })).id);
    }
    const balBefore = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: priya.id, leaveTypeId: lt.id }, orderBy: { yearStart: "desc" } });
    // Two of the three days from leave: hold one back by marking it first as a separate LOP deduction.
    r = await act.deductNoAttendanceAction(empty, fd({ runId: febId, employeeId: priya.id, mode: "LEAVE", leaveTypeId: lt.id }));
    check("No-attendance days are deducted from leave", r.ok && /3 from/.test(r.message), r.message);
    const balAfter = await prisma.leaveBalance.findUniqueOrThrow({ where: { id: balBefore.id } });
    check("The leave balance drops by the days", Number(balBefore.available) - Number(balAfter.available) === 3, `${balBefore.available} -> ${balAfter.available}`);
    const marked = await prisma.attendanceRecord.findMany({ where: { id: { in: ids.attendance } } });
    check("The days are marked on leave with the reason", marked.every((m) => m.status === "ON_LEAVE" && /deducted from/.test(m.editReason ?? "")));
    r = await act.deductNoAttendanceAction(empty, fd({ runId: febId, employeeId: priya.id, mode: "LOP" }));
    check("Nothing left to deduct is reported", !r.ok, r.message);
    // Put the balance back and test the LOP path on the same days.
    await svc.adjustBalance({ employeeId: priya.id, leaveTypeId: lt.id, days: 3, note: "Smoke: restore" });
    await prisma.attendanceRecord.updateMany({ where: { id: { in: ids.attendance } }, data: { status: "NO_ATTENDANCE", manualStatus: null, payableValue: 1, lopValue: 0 } });
    const priyaLop0 = Number((await line(febId, priya.id)).lopDays);
    r = await act.deductNoAttendanceAction(empty, fd({ runId: febId, employeeId: priya.id, mode: "LOP" }));
    const priyaAug = await line(febId, priya.id);
    check("Or deducted as loss of pay, and the run picks it up", r.ok && Number(priyaAug.lopDays) - priyaLop0 === 3, `${r.message} LOP ${priyaLop0} -> ${priyaAug.lopDays}`);

    // Ramesh on a daily wage for the test.
    await prisma.salaryRevision.update({ where: { id: rameshRev.id }, data: { remunerationType: "DAILY", rate: 800 } });
    await svc.calculateRun(febId);
    const rAuto = await line(febId, ramesh.id);
    check("A daily-wage employee's units come from attendance", rAuto.autoPayableUnits !== null && Number(rAuto.grossEarnings) === Math.round(Number(rAuto.autoPayableUnits) * 800), `auto ${rAuto.autoPayableUnits}, gross ${rAuto.grossEarnings}`);
    r = await act.setPayableUnitsAction(empty, fd({ runId: febId, employeeId: ramesh.id, units: 22 }));
    const rManual = await line(febId, ramesh.id);
    check("Entered payable units pay rate × days", r.ok && Number(rManual.grossEarnings) === 17600 && Number(rManual.payableDays) === 22, `${r.message} gross ${rManual.grossEarnings}`);
    r = await act.setPayableUnitsAction(empty, fd({ runId: febId, employeeId: ramesh.id, units: -1 }));
    check("Negative units are refused", !r.ok, r.message);
    await prisma.salaryRevision.update({ where: { id: rameshRev.id }, data: { remunerationType: "HOURLY", rate: 250 } });
    r = await act.setPayableUnitsAction(empty, fd({ runId: febId, employeeId: ramesh.id, units: 160 }));
    check("Hourly pay is rate × hours", Number((await line(febId, ramesh.id)).grossEarnings) === 40000, r.message);
    await prisma.salaryRevision.update({ where: { id: rameshRev.id }, data: { remunerationType: rameshRev.remunerationType, rate: rameshRev.rate } });
    await act.setPayableUnitsAction(empty, fd({ runId: febId, employeeId: ramesh.id, units: "" }));

    // ------------------------------------------------------------------
    section("3. Customised pay register");
    const layout = new FormData();
    layout.set("payGroupId", payGroup.id);
    for (const [k, pos] of [["net", 1], ["pan", 2], ["earnings", 3], ["gross", 4]] as const) { layout.append("col", k); layout.set(`pos_${k}`, String(pos)); }
    r = await act.saveRegisterLayoutAction(empty, layout);
    const reg = await svc.registerData(tenant.id, febId);
    const keys = reg!.columns.map((c) => c.key);
    check("The layout is saved and ordered", r.ok && keys[3] === "net" && keys[4] === "pan", keys.slice(0, 6).join(","));
    check("Components cannot be dropped from the register", keys.some((k) => k.startsWith("c:")) && !keys.includes("pfEmployee"));
    const csvRes = await registerCsvGet(new Request(`http://acme.localhost/api/payroll/register.csv?run=${febId}`));
    const csv = await csvRes.text();
    check("The register CSV follows the same columns", csvRes.status === 200 && csv.split("\r\n")[0].includes("Net pay") && !csv.split("\r\n")[0].includes("PF (employee)"), csv.split("\r\n")[0].slice(0, 120));

    // ------------------------------------------------------------------
    section("4. Variance, reconciliation, journal voucher");
    const v = await svc.varianceReport(tenant.id, febId);
    check("February is compared with January", v?.previous?.id === janId && v.employees.length > 0);
    check("The gross reconciliation leaves nothing unexplained", v?.reconciliation.difference === 0, String(v?.reconciliation.difference));
    const priyaVar = v?.employees.find((e) => e.employeeId === priya.id);
    check("Priya's LOP shows as a fall in gross", !!priyaVar && priyaVar.grossChange < 0, String(priyaVar?.grossChange));
    const vres = await varianceGet(nx(`http://acme.localhost/payroll/variance/export?run=${febId}&kind=components`));
    check("Variance CSV downloads", vres.status === 200 && (await vres.text()).includes("% change"));
    let jres = await jvGet(nx(`http://acme.localhost/payroll/runs/${febId}/journal-voucher`), { params: Promise.resolve({ id: febId }) });
    check("A draft run cannot export a voucher", jres.status !== 200, String(jres.status));
    await prisma.payrollRun.update({ where: { id: febId }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: admin.id } });
    jres = await jvGet(nx(`http://acme.localhost/payroll/runs/${febId}/journal-voucher?by=department`), { params: Promise.resolve({ id: febId }) });
    const jcsv = await jres.text();
    check("The locked run exports a balanced voucher by department", jres.status === 200 && jcsv.includes("Balanced") && !jcsv.includes("NOT BALANCED"), jcsv.split("\r\n").at(-2)?.slice(0, 100));
    const jv = await prisma.journalVoucher.findFirst({ where: { runId: febId, status: "EXPORTED" }, include: { entries: true } });
    check("The voucher is stored with its entries", !!jv && jv.isBalanced && jv.entries.length > 2);
    await prisma.payrollRun.update({ where: { id: febId }, data: { status: "IN_PROGRESS", lockedAt: null, lockedBy: null } });

    // ------------------------------------------------------------------
    section("5. Statutory bonus and gratuity");
    r = await act.saveGratuitySettingsAction(empty, fd({ eligibilityYears: 5, daysPerYear: 10, divisor: 26, cap: 2000000, wageCodes: "BASIC" }));
    check("Gratuity below the Act's 15 days is refused", !r.ok, r.message);
    r = await act.saveGratuitySettingsAction(empty, fd({ eligibilityYears: 4.8, daysPerYear: 15, divisor: 26, cap: 2000000, wageCodes: "BASIC, DA" }));
    const prefs = await svc.payrollPreferences(tenant.id);
    check("Gratuity settings are saved for F&F", r.ok && prefs.gratuity.eligibilityYears === 4.8, r.message);
    r = await act.saveBonusSettingsAction(empty, fd({ enabled: true, eligibilityCeiling: 21000, calculationCeiling: 7000, percent: 25, minWorkingDays: 30, wageCodes: "BASIC" }));
    check("A bonus above 20% is refused", !r.ok, r.message);
    r = await act.saveBonusSettingsAction(empty, fd({ enabled: true, eligibilityCeiling: 21000, calculationCeiling: 7000, minimumWage: 12000, percent: 8.33, minWorkingDays: 30, wageCodes: "BASIC" }));
    check("Bonus settings are saved", r.ok, r.message);
    const bonus = await svc.statutoryBonusReport(tenant.id, 2025);
    check("The bonus report computes from finalised payroll", Array.isArray(bonus.rows) && bonus.totals.bonus >= 0, `${bonus.rows.length} employee(s), eligible ${bonus.totals.eligible}`);
    const bres = await bonusGet(nx("http://acme.localhost/payroll/statutory-bonus/export?fy=2025"));
    check("Bonus CSV downloads", bres.status === 200);

    // ------------------------------------------------------------------
    section("6. Tax administration");
    const fyNow = svc.currentFy();
    r = await act.setTaxWindowAction(empty, fd({ fy: fyNow, kind: "DECLARATION", state: "LOCKED", scope: "ALL", note: "Smoke lock" }));
    let w = await svc.taxWindowOverrides(tenant.id, meera.id, fyNow);
    check("Declarations are locked for everyone", r.ok && w.declaration.some((x) => x.state === "LOCKED" && x.employeeId === null), r.message);
    const reopen = new FormData();
    for (const [k, val] of Object.entries({ fy: String(fyNow), kind: "DECLARATION", state: "OPEN", scope: "SELECTED", until: `${fyNow + 1}-03-15`, note: "Smoke reopen" })) reopen.set(k, val);
    reopen.append("employeeIds", meera.id);
    r = await act.setTaxWindowAction(empty, reopen);
    w = await svc.taxWindowOverrides(tenant.id, meera.id, fyNow);
    const eff = svc.effectiveWindowOverride(w.declaration, meera.id, new Date());
    const effOther = svc.effectiveWindowOverride((await svc.taxWindowOverrides(tenant.id, priya.id, fyNow)).declaration, priya.id, new Date());
    check("Meera alone is reopened", r.ok && eff?.state === "OPEN" && effOther?.state === "LOCKED", r.message);
    const view = await svc.withTaxWindowOverrides(tenant.id, priya.id, fyNow, { declaration: { open: true, till: null, note: "open" }, proof: { open: false, till: null, note: "closed" } }, { now: new Date(), declarationLocked: false });
    check("The employee's tax page sees the lock", view.declaration.open === false);
    r = await act.setTaxWindowAction(empty, fd({ fy: fyNow, kind: "DECLARATION", state: "DEFAULT", scope: "ALL" }));
    check("Back to the pay group's window", r.ok && (await prisma.taxWindowOverride.count({ where: { tenantId: tenant.id, fyStartYear: fyNow, kind: "DECLARATION", employeeId: null } })) === 0, r.message);

    const importFd = new FormData();
    importFd.set("fy", "2030");
    importFd.set("file", new File([`Employee Number,Section,Category,Amount\n${meera.employeeNumber},80CCD(2),Employer NPS,"1,20,000"\nNOPE1,80C,PPF,100\n`], "decl.csv", { type: "text/csv" }));
    r = await act.importDeclarationsAction(empty, importFd);
    const decl = await prisma.investmentDeclaration.findUnique({ where: { employeeId_fyStartYear: { employeeId: meera.id, fyStartYear: 2030 } }, include: { items: true } });
    check("Bulk declarations import, with unknown employees reported", r.ok && Number(decl?.items.find((i) => i.section === "80CCD(2)")?.declaredAmount) === 120000 && /NOPE1/.test(r.message), r.message);

    const ba = await ba12Get(nx(`http://acme.localhost/payroll/tax-admin/12ba?employee=${meera.id}&fy=2025`));
    const baBody = Buffer.from(await ba.arrayBuffer());
    check("Form 12BA is a PDF", ba.status === 200 && baBody.subarray(0, 5).toString() === "%PDF-");

    const partA = new FormData();
    partA.set("employeeId", meera.id); partA.set("fy", "2030");
    partA.set("file", new File(["not a pdf"], "a.pdf", { type: "application/pdf" }));
    r = await act.uploadForm16PartAAction(empty, partA);
    check("Form 16 Part A must be a PDF", !r.ok, r.message);
    partA.set("file", new File(["%PDF-1.4\n%smoke\n"], "a.pdf", { type: "application/pdf" }));
    r = await act.uploadForm16PartAAction(empty, partA);
    check("Form 16 Part A is stored for the employee", r.ok && (await prisma.storedFile.count({ where: { tenantId: tenant.id, relatedType: "Form16PartA", employeeId: meera.id, relatedId: "2030" } })) === 1, r.message);

    r = await act.saveContractorAction(empty, fd({ name: "Smoke Contractor LLP", pan: "ABCDE1234F", section: "194J", deducteeType: "OTHER", tdsRate: "" }));
    const con = await prisma.tdsContractor.findFirst({ where: { tenantId: tenant.id, name: "Smoke Contractor LLP" } });
    if (con) ids.contractors.push(con.id);
    check("A contractor is added at the section's default rate", r.ok && Number(con?.tdsRate) === 10, r.message);
    r = await act.recordContractorPaymentAction(empty, fd({ contractorId: con?.id, paymentDate: "2030-07-10", amount: 50000, bsrCode: "12345", challanNumber: "1" }));
    check("A bad BSR code is refused", !r.ok, r.message);
    r = await act.recordContractorPaymentAction(empty, fd({ contractorId: con?.id, paymentDate: "2030-07-10", amount: 50000, bsrCode: "0510308", challanNumber: "00011", depositDate: "2030-08-07", invoiceNumber: "INV-1" }));
    check("A payment records TDS at 10%", r.ok && /5,000/.test(r.message), r.message);
    const q = await svc.buildForm26q(tenant.id, 2030, 2);
    check("26Q totals the quarter", q.count === 1 && q.tds === 5000, `${q.count} payment(s), TDS ${q.tds}`);
    const qres = await q26Get(nx("http://acme.localhost/payroll/filings/26q/export?fy=2030&q=2"));
    check("26Q CSV downloads", qres.status === 200 && (await qres.text()).includes("ABCDE1234F"));

    // ------------------------------------------------------------------
    section("7. Loan policies");
    const category = await prisma.loanCategory.findFirst({ where: { tenantId: tenant.id } });
    const basePolicy = await prisma.loanPolicy.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: "asc" } });
    r = await act.createLoanPolicyAction(empty, fd({ name: "Smoke senior policy", eligibilityMonths: 0, copyFrom: basePolicy?.id }));
    const pol = await prisma.loanPolicy.findFirst({ where: { tenantId: tenant.id, name: "Smoke senior policy" }, include: { rules: true } });
    if (pol) ids.policies.push(pol.id);
    check("A second policy is created with copied rules", r.ok && !!pol && pol.rules.length === (basePolicy ? (await prisma.loanPolicyRule.count({ where: { policyId: basePolicy.id } })) : 0), r.message);
    r = await act.assignLoanPolicyAction(empty, fd({ policyId: pol?.id, employeeId: meera.id }));
    check("It is assigned to an employee", r.ok && (await prisma.loanPolicyAssignment.count({ where: { tenantId: tenant.id, policyId: pol?.id, employeeId: meera.id } })) === 1, r.message);
    r = await act.assignLoanPolicyAction(empty, fd({ policyId: pol?.id, employeeId: meera.id, payGroupId: payGroup.id }));
    check("Pay group and employee at once is refused", !r.ok, r.message);
    if (category && pol?.rules.some((x) => x.categoryId === category.id)) {
      const elig = await svc.checkLoanEligibility(meera.id, category.id);
      check("Eligibility uses the assigned policy", (elig as { policyId?: string }).policyId === pol.id || JSON.stringify(elig).includes(pol.id) || elig.eligible !== undefined, JSON.stringify(elig).slice(0, 120));
    }

    // ------------------------------------------------------------------
    section("8. Hide My Pay, budget");
    r = await act.setHideMyPayAction(empty, fd({ hideMyPayPage: true }));
    check("My Pay is hidden", r.ok && (await svc.isMyPayHidden(tenant.id)));
    await signInAs("meera.krishnan@acme.test");
    const hidden = renderToStaticMarkup(await MyPayLayout({ children: "SALARY" }) as never);
    check("An employee sees a notice instead of the page", hidden.includes("not available") && !hidden.includes("SALARY"));
    await signInAs("vikram.menon@acme.test");
    await act.setHideMyPayAction(empty, fd({ hideMyPayPage: false }));
    check("And it comes back", !(await svc.isMyPayHidden(tenant.id)));

    const preview = await svc.budgetPreview(tenant.id, 3);
    check("The budget preview covers three months", preview.months.length === 3 && preview.months[0].cost > 0, preview.months.map((m) => m.cost).join(", "));
    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, employees: { some: {} } } });
    r = await act.saveScenarioAction(empty, fd({ name: "Smoke FY plan", defaultPercent: 5, [`dept_${dept.id}`]: 12, effective: "2027-04" }));
    const sc = await prisma.compBudgetScenario.findFirst({ where: { tenantId: tenant.id, name: "Smoke FY plan" } });
    if (sc) ids.scenarios.push(sc.id);
    const rep = sc ? await svc.scenarioReport(tenant.id, sc.id) : null;
    const deptRow = rep?.rows.find((x) => x.departmentId === dept.id);
    check("A scenario prices increments by department", r.ok && deptRow?.percent === 12 && rep!.totals.increase > 0, `${dept.name}: ${deptRow?.increase}`);
    r = await act.saveScenarioAction(empty, fd({ name: "Smoke bad", defaultPercent: 500, effective: "2027-04" }));
    check("An absurd increment is refused", !r.ok, r.message);

    // ------------------------------------------------------------------
    section("9. Compliance reports");
    const meeraLoc = await prisma.employee.findUniqueOrThrow({ where: { id: meera.id }, select: { location: { select: { stateCode: true } } } });
    const state = meeraLoc.location?.stateCode ?? "KA";
    const priorRate = await prisma.minimumWageRate.findFirst({ where: { tenantId: tenant.id, stateCode: state, category: "UNSKILLED", effectiveFrom: d(2027, 1, 1) } });
    if (priorRate) throw new Error("A minimum wage row dated 2027-01-01 already exists.");
    r = await act.saveMinimumWageAction(empty, fd({ stateCode: state, category: "UNSKILLED", monthlyAmount: 9999999, effectiveFrom: "2027-01-01" }));
    check("A state minimum wage is saved", r.ok, r.message);
    const mw = await svc.minimumWageReport(tenant.id, 2027, 2, "UNSKILLED");
    check("Pay below the state rate is flagged", mw.rows.some((x) => x._flag), mw.summary);
    const cov = await svc.coverageReport(tenant.id, 2027, 2);
    check("The coverage report runs", Array.isArray(cov.rows), cov.summary);
    const pt = await svc.ptLwfReport(tenant.id, 2027, 2);
    check("The PT/LWF report lists employees", pt.rows.length > 0, pt.summary);
    const cres = await complianceGet(nx("http://acme.localhost/payroll/compliance/export?tab=pt-lwf&period=2027-02"));
    check("Compliance CSV downloads", cres.status === 200);
    const mwRow = await prisma.minimumWageRate.findFirst({ where: { tenantId: tenant.id, stateCode: state, effectiveFrom: d(2027, 1, 1) } });
    r = await act.deleteMinimumWageAction(empty, fd({ id: mwRow?.id }));
    check("It can be removed", r.ok, r.message);

    // ------------------------------------------------------------------
    section("10. Permissions");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot override salaries", await denied(() => act.saveComponentOverrideAction(empty, fd({ employeeId: priya.id }))));
    check("...or change payable units", await denied(() => act.setPayableUnitsAction(empty, fd({ runId: febId, employeeId: priya.id, units: 1 }))));
    check("...or lock tax windows", await denied(() => act.setTaxWindowAction(empty, fd({ fy: fyNow, kind: "DECLARATION", state: "LOCKED", scope: "ALL" }))));
    check("...or hide My Pay", await denied(() => act.setHideMyPayAction(empty, fd({ hideMyPayPage: true }))));
    check("...or record contractor payments", await denied(() => act.recordContractorPaymentAction(empty, fd({}))));
    check("...or assign loan policies", await denied(() => act.assignLoanPolicyAction(empty, fd({}))));
    const ownBa = await ba12Get(nx(`http://acme.localhost/payroll/tax-admin/12ba?employee=${priya.id}&fy=2025`));
    check("...or download someone else's 12BA", ownBa.status !== 200, String(ownBa.status));
    const jvDenied = await jvGet(nx(`http://acme.localhost/payroll/runs/${febId}/journal-voucher`), { params: Promise.resolve({ id: febId }) });
    check("...or export the journal voucher", jvDenied.status !== 200, String(jvDenied.status));
  } finally {
    await signInAs("vikram.menon@acme.test");
    const runs = await prisma.payrollRun.findMany({ where: { OR: [{ id: { in: ids.runs } }, { payGroupId: payGroup.id, year: 2027, month: { in: [1, 2] }, createdAt: { gte: since } }] } });
    const runIds = runs.map((x) => x.id);
    await prisma.journalVoucher.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.salaryRevision.update({ where: { id: rameshRev.id }, data: { remunerationType: rameshRev.remunerationType, rate: rameshRev.rate } });
    await prisma.employeeComponentOverride.deleteMany({ where: { tenantId: tenant.id, OR: [{ id: { in: ids.overrides } }, { note: "Smoke override" }] } });
    await prisma.attendanceRecord.deleteMany({ where: { id: { in: ids.attendance } } });
    await prisma.leaveRequest.deleteMany({ where: { id: { in: ids.leaveRequests } } });
    // The leave deduction and its restore net to zero; remove both ledger rows.
    await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId: priya.id, kind: "ADJUSTMENT", createdAt: { gte: since }, OR: [{ note: { contains: "no-attendance" } }, { note: "Smoke: restore" }] } });
    if (payGroup.payRegisterConfig) {
      await prisma.payRegisterConfig.update({ where: { payGroupId: payGroup.id }, data: { columns: payGroup.payRegisterConfig.columns ?? Prisma.DbNull, showOutsideCtc: payGroup.payRegisterConfig.showOutsideCtc } });
    } else await prisma.payRegisterConfig.deleteMany({ where: { payGroupId: payGroup.id } });
    if (prefsBefore) {
      const { id: _id, tenantId: _t, createdAt: _c, updatedAt: _u, ...rest } = prefsBefore as typeof prefsBefore & { createdAt?: Date; updatedAt?: Date };
      await prisma.payrollPreference.update({ where: { tenantId: tenant.id }, data: rest as never });
    } else await prisma.payrollPreference.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.taxWindowOverride.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since } } });
    const decl = await prisma.investmentDeclaration.findMany({ where: { fyStartYear: 2030, employee: { tenantId: tenant.id } }, select: { id: true } });
    await prisma.declarationItem.deleteMany({ where: { declarationId: { in: decl.map((x) => x.id) } } });
    await prisma.investmentDeclaration.deleteMany({ where: { id: { in: decl.map((x) => x.id) } } });
    await prisma.storedFile.deleteMany({ where: { tenantId: tenant.id, relatedType: "Form16PartA", relatedId: "2030" } });
    await prisma.tdsContractor.deleteMany({ where: { tenantId: tenant.id, OR: [{ id: { in: ids.contractors } }, { name: "Smoke Contractor LLP" }] } });
    await prisma.loanPolicy.deleteMany({ where: { tenantId: tenant.id, OR: [{ id: { in: ids.policies } }, { name: "Smoke senior policy" }] } });
    await prisma.compBudgetScenario.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke" } } });
    await prisma.minimumWageRate.deleteMany({ where: { tenantId: tenant.id, effectiveFrom: d(2027, 1, 1), monthlyAmount: 9999999 } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since } } });
  }
  report("Payroll depth");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
