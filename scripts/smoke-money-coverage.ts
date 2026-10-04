/**
 * Money coverage: flows that already existed but had no test, end to end.
 *   1. Expense claims: cancelling a draft and marking an out-of-payroll claim
 *      paid, both audited and in the reimbursement export.
 *   2. Cash advances: request, approve, disburse, recover, with the audit
 *      entries and the advances report.
 *   3. Loans: category saves audited, request, approval, disbursal, a skipped
 *      EMI, the loans-outstanding report, foreclosure and the audit trail.
 *   4. Trips: cancelling before approval, the travel dashboard (calendar and
 *      who is travelling today).
 *   5. Dependents kept on the profile: add, view, remove, and who may.
 *   6. Benefits: waiting period on coverage, enrolment audit.
 *   7. Compensation: prorated increases for a mid-period joiner, settings
 *      changes and exports in the plan's audit history.
 *
 * Everything it creates is tagged "Smoke cover" and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (n: number) => iso(new Date(Date.now() + n * DAY));
const TAG = "Smoke cover";

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { const r = await fn(); return (r as { ok?: boolean })?.ok === false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}
const pdf = (name = "doc.pdf") => new File([new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"))], name, { type: "application/pdf" });
function multi(values: Record<string, string | number | boolean | File | null | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === false) continue;
    f.append(k, v === true ? "on" : v instanceof File ? v : String(v));
  }
  return f;
}

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (node instanceof Promise) return resolve(await node);
    if (!React.isValidElement(node)) return node;
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    let children: unknown = undefined;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "children") children = await resolve(v);
      else props[k] = React.isValidElement(v) ? await resolve(v) : v;
    }
    if (children === undefined) return React.cloneElement(el, props as never);
    return Array.isArray(children) ? React.cloneElement(el, props as never, ...(children as React.ReactNode[])) : React.cloneElement(el, props as never, children as React.ReactNode);
  }
  const html = async (page: Promise<unknown>) => renderToStaticMarkup((await resolve(await page)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = <T extends Record<string, string>>(o: T = {} as T) => Promise.resolve(o);
  const pr = (id: string) => Promise.resolve({ id });

  const wfAct = await import("../apps/web/src/app/actions/workflows");
  const ex = await import("../apps/web/src/app/actions/expenses");
  const ln = await import("../apps/web/src/app/actions/loans");
  const ben = await import("../apps/web/src/app/actions/benefits");
  const comp = await import("../apps/web/src/app/actions/compensation");
  const emp = await import("../apps/web/src/app/actions/employee");
  const svc = await import("@keka/services");
  const { NextRequest } = await import("next/server");
  const page = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}`)).default;
  const route = async (p: string) => await import(`../apps/web/src/app/(app)/${p}`);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email }, include: { employee: true } });
  const manish = await user("manish.tiwari@acme.test");
  const meera = await user("meera.krishnan@acme.test");
  const nikhil = await user("nikhil.joshi@acme.test");
  const ananya = await user("ananya.ghosh@acme.test");
  const priya = await user("priya.sharma@acme.test");
  const meeraEmp = meera.employee!, nikhilEmp = nikhil.employee!;
  const emails = new Map((await prisma.user.findMany({ where: { tenantId: t }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
  const started = new Date();
  const expenseRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "EXPENSE_MANAGER" } });
  const travelRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "TRAVEL_DESK_MANAGER" } });
  const grants = [expenseRole.id, travelRole.id];
  const created = { loans: [] as string[], claims: [] as string[], trips: [] as string[], advances: [] as string[] };

  async function settle(entityType: string, entityId: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const req = await prisma.workflowRequest.findFirst({ where: { tenantId: t, entityType, entityId }, orderBy: { createdAt: "desc" } });
      if (!req || req.status !== "PENDING") return req?.status ?? "NONE";
      const task = await prisma.workflowTask.findFirst({ where: { requestId: req.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
      if (!task) return req.status;
      await signInAs(emails.get(task.approverUserId)!);
      const r = await wfAct.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: "approve", comment: "" }));
      if (!r.ok) return `ERROR ${r.message}`;
    }
    return "LOOP";
  }
  const csvGet = async (mod: { GET: (...a: never[]) => Promise<Response> }, url: string, params?: Record<string, string>) => {
    const res = await (mod.GET as (r: unknown, c?: unknown) => Promise<Response>)(new NextRequest(`http://acme.localhost${url}`), params ? { params: Promise.resolve(params) } : undefined);
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  };
  const auditFor = (entityType: string, entityId: string) => prisma.auditLog.findMany({ where: { tenantId: t, entityType, entityId } });

  async function cleanup(since: Date) {
    const steps: Array<() => Promise<unknown>> = [
      () => prisma.userRoleAssignment.deleteMany({ where: { userId: manish.id, roleId: { in: grants } } }),
      () => prisma.workflowRequest.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      () => prisma.adhocTransaction.deleteMany({ where: { createdAt: { gte: since }, employee: { tenantId: t } } }),
      () => prisma.expenseClaim.deleteMany({ where: { tenantId: t, OR: [{ id: { in: created.claims } }, { title: { startsWith: TAG } }] } }),
      () => prisma.cashAdvance.deleteMany({ where: { tenantId: t, OR: [{ id: { in: created.advances } }, { purpose: { startsWith: TAG } }] } }),
      async () => {
        const trips = await prisma.travelRequest.findMany({ where: { tenantId: t, OR: [{ id: { in: created.trips } }, { purpose: { startsWith: TAG } }] }, select: { id: true } });
        const ids = trips.map((x) => x.id);
        await prisma.tripChecklistItem.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.tripChange.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.travelRequest.deleteMany({ where: { id: { in: ids } } });
      },
      async () => {
        const loans = await prisma.loan.findMany({ where: { employee: { tenantId: t }, OR: [{ id: { in: created.loans } }, { purpose: { startsWith: TAG } }] }, select: { id: true } });
        const ids = loans.map((l) => l.id);
        await prisma.loanAdjustment.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loanTranche.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loanInstallment.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loan.deleteMany({ where: { id: { in: ids } } });
      },
      () => prisma.loanCategory.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      async () => {
        const plans = await prisma.benefitPlan.findMany({ where: { tenantId: t, code: { startsWith: "SMC" } }, select: { id: true } });
        const ids = plans.map((p) => p.id);
        await prisma.benefitDeduction.deleteMany({ where: { enrollmentId: { in: (await prisma.benefitEnrollment.findMany({ where: { planId: { in: ids } }, select: { id: true } })).map((e) => e.id) } } });
        await prisma.benefitEnrollment.deleteMany({ where: { planId: { in: ids } } });
        await prisma.benefitPlan.deleteMany({ where: { id: { in: ids } } });
      },
      () => prisma.benefitEnrollmentWindow.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.dependent.deleteMany({ where: { employee: { tenantId: t }, name: { startsWith: TAG } } }),
      async () => {
        const plans = await prisma.compPlan.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        const ids = plans.map((p) => p.id);
        await prisma.compStatement.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compDecisionLog.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compBudgetPool.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compPlan.deleteMany({ where: { id: { in: ids } } });
      },
      async () => {
        const files = await prisma.storedFile.findMany({ where: { tenantId: t, createdAt: { gte: since } }, select: { id: true } });
        await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
      },
      () => prisma.notification.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      () => prisma.emailOutbox.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      () => purgeLedgerSince(prisma, t, since),
    ];
    for (const step of steps) await step().catch((err) => console.error("  cleanup:", err instanceof Error ? err.message.split("\n").slice(-2).join(" ") : err));
  }
  await cleanup(new Date());
  for (const roleId of grants) await prisma.userRoleAssignment.create({ data: { userId: manish.id, roleId } });

  console.log("\nMoney coverage: existing expense, travel, loan, benefit and pay flows\n" + "=".repeat(72));
  try {
    // =======================================================================
    section("Expense claims: cancel and mark paid, audited");
    const cat = (await prisma.expenseCategory.findMany({ where: { tenantId: t, isActive: true, kind: "STANDARD" }, orderBy: { name: "asc" } }))[0]!;
    await signInAs("meera.krishnan@acme.test");
    const draft = await ex.submitClaimAction({}, multi({ title: `${TAG} draft`, intent: "draft", categoryId_0: cat.id, expenseDate_0: plus(-3), amount_0: 220, receipt_0: pdf() }));
    const draftRow = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} draft` } });
    created.claims.push(draftRow.id);
    check("A claim is saved as a draft", draft.ok && draftRow.stage === "DRAFT", draft.message);
    const cancel = await ex.claimOpAction({}, fd({ claimId: draftRow.id, op: "cancel" }));
    check("…and cancelled by its owner", cancel.ok && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: draftRow.id } })).stage === "CANCELLED", cancel.message);
    check("…which is audited", (await auditFor("ExpenseClaim", draftRow.id)).some((a) => a.action === "DELETE" && /cancel/.test(a.summary ?? "")));
    const bank = await svc.createClaim({ employeeId: meeraEmp.id, title: `${TAG} bank paid`, payViaPayroll: false, submit: true, lines: [{ categoryId: cat.id, expenseDate: new Date(Date.now() - 2 * DAY), amount: 340, receiptUrl: "/files/smoke-receipt.pdf" }] });
    created.claims.push(bank.claimId!);
    await signInAs("ananya.ghosh@acme.test");
    const appr = await ex.decideClaimAction({}, fd({ claimId: bank.claimId!, decision: "approve" }));
    check("A claim paid outside payroll is approved by the manager", bank.ok && appr.ok && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: bank.claimId! } })).stage === "APPROVED", appr.message);
    await signInAs("meera.krishnan@acme.test");
    check("The claimant cannot mark it paid", (await ex.claimOpAction({}, fd({ claimId: bank.claimId!, op: "paid" }))).ok === false);
    await signInAs("manish.tiwari@acme.test");
    const paid = await ex.claimOpAction({}, fd({ claimId: bank.claimId!, op: "paid" }));
    check("Finance marks it paid", paid.ok && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: bank.claimId! } })).stage === "PAID", paid.message);
    check("…audited with the claim number", (await auditFor("ExpenseClaim", bank.claimId!)).some((a) => / paid: /.test(a.summary ?? "")));
    const reimb = await csvGet(await route("expenses/reports/export/route"), "/expenses/reports/export?kind=reimbursements");
    const bankRow = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: bank.claimId! } });
    check("The reimbursement export shows it paid", reimb.status === 200 && reimb.body.split("\n").some((l) => l.includes(bankRow.claimNumber) && /PAID/i.test(l)));

    // =======================================================================
    section("Cash advances: approve, disburse, recover");
    await signInAs("meera.krishnan@acme.test");
    const adv = await ex.requestAdvanceAction({}, fd({ amount: 2500, purpose: `${TAG} advance`, neededBy: plus(5) }));
    const advRow = await prisma.cashAdvance.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} advance` } });
    created.advances.push(advRow.id);
    check("An advance is requested", adv.ok && advRow.status === "REQUESTED", adv.message);
    check("She cannot approve her own", (await ex.advanceOpAction({}, fd({ advanceId: advRow.id, op: "approve" }))).ok === false);
    await signInAs("priya.sharma@acme.test");
    check("HR approves it", (await ex.advanceOpAction({}, fd({ advanceId: advRow.id, op: "approve" }))).ok);
    await signInAs("manish.tiwari@acme.test");
    check("Finance pays it out", (await ex.advanceOpAction({}, fd({ advanceId: advRow.id, op: "disburse" }))).ok && (await prisma.cashAdvance.findUniqueOrThrow({ where: { id: advRow.id } })).status === "DISBURSED");
    const rec = await ex.advanceOpAction({}, fd({ advanceId: advRow.id, op: "recover" }));
    check("…and recovers it from salary", rec.ok && (await prisma.adhocTransaction.count({ where: { sourceType: "CashAdvanceRecovery", sourceId: advRow.id } })) === 1, rec.message);
    const advAudit = await auditFor("CashAdvance", advRow.id);
    check("Each step is audited", ["approve", "disburse", "recover"].every((op) => advAudit.some((a) => a.summary?.startsWith(`${op}:`))), advAudit.map((a) => a.summary).join(" | "));
    await signInAs("ramesh.iyer@acme.test");
    const advRep = await csvGet(await route("payroll/loans/portfolio/export/route"), "/payroll/loans/portfolio/export?report=advances");
    check("The advances report lists it", advRep.status === 200 && advRep.body.includes(meeraEmp.employeeNumber) && advRep.body.includes("2500"));

    // =======================================================================
    section("Loans: category, request, skip, outstanding report, foreclosure");
    await signInAs("ramesh.iyer@acme.test");
    const lc = await ln.saveLoanCategoryAction({}, fd({ name: `${TAG} Vehicle`, code: "SMC-VEH", description: "Two-wheeler loan" }));
    const lcRow = await prisma.loanCategory.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Vehicle` } });
    check("A loan type is saved and audited", lc.ok && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "LoanCategory", entityId: lcRow.id } })) >= 1, lc.message);
    const loanCat = (await prisma.loanCategory.findMany({ where: { tenantId: t, policyRules: { some: {} } } })).find((c) => !/salary/i.test(c.name))!;
    await signInAs("nikhil.joshi@acme.test");
    const app = await ln.applyLoanAction({}, multi({ categoryId: loanCat.id, amount: 30000, installments: 3, purpose: `${TAG} loan`, document: pdf("quote.pdf") }));
    const loan = await prisma.loan.findFirstOrThrow({ where: { employeeId: nikhilEmp.id, purpose: `${TAG} loan` } });
    created.loans.push(loan.id);
    check("A loan is requested", app.ok, app.message);
    await signInAs("ramesh.iyer@acme.test");
    check("…approved", (await ln.decideLoanAction({}, fd({ loanId: loan.id, decision: "approve" }))).ok);
    check("…and disbursed", (await ln.loanOperationAction({}, fd({ loanId: loan.id, op: "disburse" }))).ok);
    const first = await prisma.loanInstallment.findFirstOrThrow({ where: { loanId: loan.id, status: "SCHEDULED" }, orderBy: { sequence: "asc" } });
    const skip = await ln.loanOperationAction({}, fd({ loanId: loan.id, op: "skip", period: `${first.year}-${first.month}` }));
    check("An EMI is skipped", skip.ok, skip.message);
    const out = await csvGet(await route("reports/export/route"), "/reports/export?r=loans-outstanding");
    check("The loans-outstanding report lists the loan", out.status === 200 && out.body.includes(nikhilEmp.displayName ?? "") && out.body.includes("30000.00"), out.body.split("\n").filter((l) => l.includes("Nikhil")).join(" / ") || out.body.slice(0, 200));
    await signInAs("nikhil.joshi@acme.test");
    check("Borrowers cannot run it", (await csvGet(await route("reports/export/route"), "/reports/export?r=loans-outstanding")).status === 403);
    await signInAs("ramesh.iyer@acme.test");
    const fc = await ln.loanOperationAction({}, fd({ loanId: loan.id, op: "foreclose" }));
    check("The loan is foreclosed", fc.ok && (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status === "FORECLOSED", fc.message);
    const la = await auditFor("Loan", loan.id);
    check("Skip and foreclosure are in the audit trail", ["skip:", "foreclose:"].every((p) => la.some((a) => a.summary?.startsWith(p))));
    check("…shown on the loan page", (await html((await page("payroll/loans/[id]/page"))({ params: pr(loan.id) }))).includes("foreclose:"));
    check("The settlements report has the foreclosure", (await csvGet(await route("payroll/loans/portfolio/export/route"), "/payroll/loans/portfolio/export?report=settlements")).body.split("\n").some((l) => l.includes("FORECLOSURE") && l.includes(nikhilEmp.displayName ?? "")));

    // =======================================================================
    section("Trips: cancel before approval, dashboard");
    await signInAs("meera.krishnan@acme.test");
    await ex.requestTripAction({}, fd({ purpose: `${TAG} Pune`, fromCity: "Bengaluru", toCity: "Pune", departDate: plus(20), returnDate: plus(21), travelType: "DOMESTIC" }));
    const trip = await prisma.travelRequest.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} Pune` } });
    created.trips.push(trip.id);
    const tc = await ex.tripOpAction({}, fd({ tripId: trip.id, op: "cancel", reason: "Plans changed" }));
    check("A trip not yet approved is cancelled straight away", tc.ok && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).status === "CANCELLED", tc.message);
    check("…audited", (await auditFor("TravelRequest", trip.id)).some((a) => /cancel/.test(a.summary ?? "")));
    await signInAs("aditya.verma@acme.test");
    check("A colleague cannot cancel someone else's trip", (await ex.tripOpAction({}, fd({ tripId: trip.id, op: "cancel" }))).ok === false);
    await signInAs("meera.krishnan@acme.test");
    await ex.requestTripAction({}, fd({ purpose: `${TAG} Mysuru today`, fromCity: "Bengaluru", toCity: "Mysuru", departDate: plus(0), returnDate: plus(1), travelType: "DOMESTIC" }));
    const today = await prisma.travelRequest.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} Mysuru today` } });
    created.trips.push(today.id);
    await signInAs("ananya.ghosh@acme.test");
    await ex.tripOpAction({}, fd({ tripId: today.id, op: "approve" }));
    check("A trip leaving today is approved", (await prisma.travelRequest.findUniqueOrThrow({ where: { id: today.id } })).status === "APPROVED");
    await signInAs("manish.tiwari@acme.test");
    const dash = await html((await page("expenses/travel/dashboard/page"))({ searchParams: sp() }));
    check("The dashboard shows her travelling today", dash.includes("Travelling today") && dash.includes(meeraEmp.employeeNumber) && dash.includes("Mysuru"));
    check("…and the trip on the calendar", dash.includes("Business trip calendar") && (dash.includes(today.requestNumber) || dash.includes("Mysuru")));
    await signInAs("meera.krishnan@acme.test");
    check("Employees cannot open the travel dashboard", await denied(async () => html((await page("expenses/travel/dashboard/page"))({ searchParams: sp() }))));

    // =======================================================================
    section("Dependents on the profile");
    await signInAs("priya.sharma@acme.test");
    const add = await emp.addDependent({}, fd({ employeeId: meeraEmp.id, name: `${TAG} Child`, relationship: "CHILD", dateOfBirth: "2018-06-01", isNominee: true }));
    const dep = await prisma.dependent.findFirstOrThrow({ where: { employeeId: meeraEmp.id, name: `${TAG} Child` } });
    check("HR adds a dependent to the profile", add.ok && dep.isNominee, add.message);
    await signInAs("meera.krishnan@acme.test");
    check("The employee sees it with her benefits", (await html((await page("finances/benefits/page"))())).includes(`${TAG} Child`));
    await signInAs("aditya.verma@acme.test");
    check("A colleague cannot add dependents to her profile", await denied(() => emp.addDependent({}, fd({ employeeId: meeraEmp.id, name: `${TAG} Intruder`, relationship: "CHILD" }))));
    await signInAs("priya.sharma@acme.test");
    const rm = await emp.deleteSubRecord({}, fd({ kind: "dependent", id: dep.id, employeeId: meeraEmp.id }));
    check("HR removes it", rm.ok && !(await prisma.dependent.findUnique({ where: { id: dep.id } })), rm.message);

    // =======================================================================
    section("Benefits: waiting period and enrolment audit");
    const tanvi = await user("tanvi.shah@acme.test");
    const joined = tanvi.employee!.dateOfJoining;
    const waitDays = Math.ceil((Date.now() - joined.getTime()) / DAY) + 30;
    await signInAs("priya.sharma@acme.test");
    const bp = await ben.saveBenefitPlanAction({}, fd({ code: "SMCWAIT", name: `${TAG} Accident`, type: "ACCIDENT", monthlyPremium: 200, employerRule: "PERCENT_OF_PREMIUM", employerValue: 100, waitingPeriodDays: waitDays, maxDependents: 0 }));
    const plan = await prisma.benefitPlan.findFirstOrThrow({ where: { tenantId: t, code: "SMCWAIT" } });
    await ben.benefitPlanOpAction({}, fd({ id: plan.id, op: "submit" }));
    check("A plan with a waiting period is approved", waitDays <= 365 && bp.ok && (await settle("BENEFIT_PLAN", plan.id)) === "APPROVED");
    await signInAs("priya.sharma@acme.test");
    const wf = new FormData();
    for (const [k, v] of Object.entries({ name: `${TAG} window`, kind: "NEW_HIRE", opensOn: plus(0), closesOn: plus(7), planIds: plan.id })) wf.append(k, v);
    const w = await ben.createEnrollmentWindowAction({}, wf);
    check("A new-hire window is opened", w.ok, w.message);
    await signInAs("tanvi.shah@acme.test");
    const en = await ben.enrollBenefitAction({}, fd({ planId: plan.id, tier: "EMPLOYEE" }));
    const enr = await prisma.benefitEnrollment.findFirstOrThrow({ where: { planId: plan.id, employeeId: tanvi.employee!.id } });
    check("She enrols; the company pays it all", en.ok && Number(enr.employeeMonthly) === 0 && Number(enr.employerMonthly) === 200, en.message);
    await settle("BENEFIT_ENROLLMENT", enr.id);
    const after = await prisma.benefitEnrollment.findUniqueOrThrow({ where: { id: enr.id } });
    check("Cover starts only once the waiting period ends", !!after.coverageStart && iso(after.coverageStart) === iso(svc.coverageStart(joined, waitDays, enr.createdAt)) && after.coverageStart.getTime() > Date.now() + 25 * DAY, after.coverageStart ? iso(after.coverageStart) : "none");
    check("The days left are counted", svc.waitingDaysLeft(joined, waitDays) >= 29);
    const ea = await auditFor("BenefitEnrollment", enr.id);
    check("Enrolment and its approval are audited", ea.length >= 2, String(ea.length));

    // =======================================================================
    section("Compensation: proration and plan audit history");
    await signInAs("priya.sharma@acme.test");
    const mJoined = meeraEmp.dateOfJoining;
    const pStart = iso(new Date(mJoined.getTime() - 100 * DAY)), eff = iso(new Date(mJoined.getTime() + 100 * DAY));
    const cp = await comp.createCompPlanAction({}, fd({ name: `${TAG} proration`, periodStart: pStart, effectiveDate: eff, meritMatrix: "1-5:10", defaultPct: 10, budgetPct: 20, maxPct: 50, prorate: true }));
    const cplan = await prisma.compPlan.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} proration` } });
    check("A plan is created for a period she joined halfway through", cp.ok, cp.message);
    const built = await svc.buildCompPlanItems(t, cplan.id, priya.id, { id: { in: [meeraEmp.id, ananya.employee!.id] } });
    const item = await prisma.compPlanItem.findFirstOrThrow({ where: { planId: cplan.id, employeeId: meeraEmp.id } });
    check("Her merit is prorated to half", built.ok && Math.abs(Number(item.prorationFactor) - 0.5) < 0.01 && Math.abs(Number(item.totalPct) - Number(item.meritPct) * 0.5) < 0.02, `${item.prorationFactor} ${item.meritPct} ${item.totalPct}`);
    const anItem = await prisma.compPlanItem.findFirst({ where: { planId: cplan.id, employeeId: ananya.employee!.id } });
    check("Someone there all period is not", !anItem || Number(anItem.prorationFactor) === 1 || anItem.employeeId !== ananya.employee!.id || ananya.employee!.dateOfJoining > new Date(pStart));
    const set = await comp.compPlanSettingsAction({}, fd({ planId: cplan.id, meritMatrix: "1-5:10", defaultPct: 8, budgetPct: 20, maxPct: 50, prorate: true }));
    check("Settings are changed", set.ok, set.message);
    const ex1 = await csvGet(await route("payroll/compensation/[id]/export/route"), `/payroll/compensation/${cplan.id}/export`, { id: cplan.id });
    check("The worksheet is exported", ex1.status === 200);
    const ca = await prisma.auditLog.findMany({ where: { tenantId: t, OR: [{ entityType: "CompPlan", entityId: cplan.id }, { summary: { contains: `${TAG} proration` } }] } });
    check("The plan's audit history has creation, settings and the export", ca.length >= 3 && ca.some((a) => a.action === "EXPORT"), ca.map((a) => `${a.action}:${a.summary}`).join(" | "));
    await signInAs("meera.krishnan@acme.test");
    check("Employees cannot export it", (await csvGet(await route("payroll/compensation/[id]/export/route"), `/payroll/compensation/${cplan.id}/export`, { id: cplan.id })).status === 403);
  } catch (err) {
    check("suite ran without throwing", false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await cleanup(started);
    await prisma.$disconnect();
  }
  report("smoke-money-coverage");
}

main();
