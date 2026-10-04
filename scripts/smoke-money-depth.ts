/**
 * Money depth: expenses, travel, loans, benefits and compensation planning,
 * through the server actions, the workflow engine, the pages and the CSV
 * exports.
 *   1. Expense policies (templates, scope, caps, approval, revision), rates,
 *      pre-approval, mileage, duplicates, receipt quality, recall and edit,
 *      reason codes, delegation, taxable split, audit sampling, reports.
 *   2. Travel policy, purposes, destination risk, traveller profile, the
 *      approval matrix, bookings in and out of policy, itinerary, checklist,
 *      insurance, advance link, change and cancellation, settlement.
 *   3. Loans: product approval, fees, documents, edits, delegation, tranches,
 *      prepayment, reschedule, balance, settlement, overdue alerts, statement,
 *      portfolio and reports.
 *   4. Benefits: plans with approval, eligibility and exceptions, windows,
 *      dependents with proof, enrolment, life events, payroll deductions and
 *      arrears, insurer census and reconciliation, renewal, coverage end.
 *   5. Compensation: templates, worksheets, pools, guardrails and exceptions,
 *      calibration, approval, apply, statements, ranges, equity, allowances.
 *
 * Everything it creates is tagged "Smoke money" (or made after it started)
 * and removed at the end; settings it changes are restored.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (n: number) => iso(new Date(Date.now() + n * DAY));
const TAG = "Smoke money";

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

function multi(values: Record<string, string | number | boolean | File | Array<string> | null | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === false) continue;
    if (v === true) f.append(k, "on");
    else if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else if (v instanceof File) f.append(k, v);
    else f.append(k, String(v));
  }
  return f;
}

const pdf = (name = "doc.pdf") => new File([new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"))], name, { type: "application/pdf" });
function png(w: number, h: number): File {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w); v.setUint32(20, h);
  return new File([b], "receipt.png", { type: "image/png" });
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
  const exd = await import("../apps/web/src/app/actions/expense-depth");
  const tr = await import("../apps/web/src/app/actions/travel-depth");
  const ln = await import("../apps/web/src/app/actions/loans");
  const lnd = await import("../apps/web/src/app/actions/loan-depth");
  const ben = await import("../apps/web/src/app/actions/benefits");
  const comp = await import("../apps/web/src/app/actions/compensation");
  const svc = await import("@keka/services");
  const { NextRequest } = await import("next/server");
  const page = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}`)).default;
  const route = async (p: string) => await import(`../apps/web/src/app/(app)/${p}`);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email }, include: { employee: true } });
  const vikram = await user("vikram.menon@acme.test");
  const priya = await user("priya.sharma@acme.test");
  const ramesh = await user("ramesh.iyer@acme.test");
  const lakshmi = await user("lakshmi.narayanan@acme.test");
  const manish = await user("manish.tiwari@acme.test");
  const meera = await user("meera.krishnan@acme.test");
  const ananya = await user("ananya.ghosh@acme.test");
  const aditya = await user("aditya.verma@acme.test");
  const nikhil = await user("nikhil.joshi@acme.test");
  const sneha = await user("sneha.reddy@acme.test");
  const emails = new Map((await prisma.user.findMany({ where: { tenantId: t }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
  const meeraEmp = meera.employee!, nikhilEmp = nikhil.employee!;
  const started = new Date();

  // Finance and the travel desk: grant the seeded system roles for the run.
  const expenseRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "EXPENSE_MANAGER" } });
  const travelRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "TRAVEL_DESK_MANAGER" } });
  const grants = [expenseRole.id, travelRole.id];

  // Settings restored at the end.
  const loanPolicyBefore = await prisma.loanPolicy.findMany({ where: { tenantId: t }, select: { id: true, requireChangeApproval: true } });
  const loanRulesBefore = await prisma.loanPolicyRule.findMany({ where: { policy: { tenantId: t } } });
  const loanCatsBefore = await prisma.loanCategory.findMany({ where: { tenantId: t }, select: { id: true, isEmergency: true, emergencyMaxMonthsSalary: true } });
  const gradesBefore = await prisma.payGrade.findMany({ where: { tenantId: t }, select: { id: true, minAnnual: true, midAnnual: true, maxAnnual: true } });
  const empGradesBefore = await prisma.employee.findMany({ where: { tenantId: t }, select: { id: true, payGradeId: true } });
  const created = { claims: [] as string[], trips: [] as string[], loans: [] as string[], advances: [] as string[] };

  /** Walk a workflow request to its end, each pending step decided by its first approver. */
  async function settle(entityType: string, entityId: string, approve = true): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const req = await prisma.workflowRequest.findFirst({ where: { tenantId: t, entityType, entityId }, orderBy: { createdAt: "desc" } });
      if (!req) return "NONE";
      if (req.status !== "PENDING") return req.status;
      const task = await prisma.workflowTask.findFirst({ where: { requestId: req.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
      if (!task) return req.status;
      await signInAs(emails.get(task.approverUserId)!);
      const r = await wfAct.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: approve ? "approve" : "reject", comment: approve ? "" : `${TAG}: declined` }));
      if (!r.ok) return `ERROR ${r.message}`;
    }
    return "LOOP";
  }
  const csvGet = async (mod: { GET: (...a: never[]) => Promise<Response> }, url: string, params?: Record<string, string>) => {
    const res = await (mod.GET as (r: unknown, c?: unknown) => Promise<Response>)(new NextRequest(`http://acme.localhost${url}`), params ? { params: Promise.resolve(params) } : undefined);
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  };
  const audits = (entityType: string, since = started) => prisma.auditLog.count({ where: { tenantId: t, entityType, createdAt: { gte: since } } });

  async function cleanup(since: Date) {
    const steps: Array<() => Promise<unknown>> = [
      () => prisma.userRoleAssignment.deleteMany({ where: { userId: manish.id, roleId: { in: grants } } }),
      async () => {
        const reqs = await prisma.workflowRequest.findMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { title: { contains: TAG } }] }, select: { id: true } });
        await prisma.workflowRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
      },
      () => prisma.approverDelegation.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { reason: { startsWith: TAG } }] } }),
      // Expenses
      () => prisma.expenseAuditSample.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.adhocTransaction.deleteMany({ where: { createdAt: { gte: since }, employee: { tenantId: t } } }),
      async () => {
        const claims = await prisma.expenseClaim.findMany({ where: { tenantId: t, OR: [{ id: { in: created.claims } }, { title: { startsWith: TAG } }] }, select: { id: true } });
        await prisma.expenseClaim.deleteMany({ where: { id: { in: claims.map((c) => c.id) } } });
      },
      () => prisma.expensePreApproval.deleteMany({ where: { tenantId: t, purpose: { startsWith: TAG } } }),
      () => prisma.expenseRate.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { note: { startsWith: TAG } }] } }),
      async () => {
        const pols = await prisma.expensePolicy.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        await prisma.expensePolicyCategory.deleteMany({ where: { policyId: { in: pols.map((p) => p.id) } } });
        await prisma.expensePolicy.deleteMany({ where: { id: { in: pols.map((p) => p.id) } } });
      },
      () => prisma.expenseCategory.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      // Travel
      async () => {
        const trips = await prisma.travelRequest.findMany({ where: { tenantId: t, OR: [{ id: { in: created.trips } }, { purpose: { startsWith: TAG } }] }, select: { id: true } });
        const ids = trips.map((x) => x.id);
        await prisma.travelSettlement.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.travelBooking.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.tripChecklistItem.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.tripChange.deleteMany({ where: { tripId: { in: ids } } });
        await prisma.travelRequest.deleteMany({ where: { id: { in: ids } } });
      },
      () => prisma.cashAdvance.deleteMany({ where: { tenantId: t, OR: [{ id: { in: created.advances } }, { purpose: { startsWith: TAG } }] } }),
      () => prisma.travelPolicy.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.tripPurpose.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.destinationRisk.deleteMany({ where: { tenantId: t, destination: { in: ["Smoketown", "Riskville"] } } }),
      () => prisma.travelerProfile.deleteMany({ where: { tenantId: t, notes: { startsWith: TAG } } }),
      // Loans
      async () => {
        const loans = await prisma.loan.findMany({ where: { employee: { tenantId: t }, OR: [{ id: { in: created.loans } }, { purpose: { startsWith: TAG } }] }, select: { id: true } });
        const ids = loans.map((l) => l.id);
        await prisma.loanAdjustment.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loanTranche.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loanInstallment.deleteMany({ where: { loanId: { in: ids } } });
        await prisma.loan.deleteMany({ where: { id: { in: ids } } });
      },
      () => prisma.loanProductChange.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      async () => { for (const p of loanPolicyBefore) await prisma.loanPolicy.update({ where: { id: p.id }, data: { requireChangeApproval: p.requireChangeApproval } }); },
      async () => {
        for (const r of loanRulesBefore) {
          const { id: _id, policyId, categoryId, ...rest } = r as typeof r & Record<string, unknown>;
          await prisma.loanPolicyRule.update({ where: { policyId_categoryId: { policyId, categoryId } }, data: rest as never });
        }
      },
      async () => { for (const c of loanCatsBefore) await prisma.loanCategory.update({ where: { id: c.id }, data: { isEmergency: c.isEmergency, emergencyMaxMonthsSalary: c.emergencyMaxMonthsSalary } }); },
      // Benefits
      async () => {
        const plans = await prisma.benefitPlan.findMany({ where: { tenantId: t, OR: [{ name: { startsWith: TAG } }, { code: { startsWith: "SMK" } }] }, select: { id: true } });
        const enr = await prisma.benefitEnrollment.findMany({ where: { planId: { in: plans.map((p) => p.id) } }, select: { id: true } });
        await prisma.benefitDeduction.deleteMany({ where: { enrollmentId: { in: enr.map((e) => e.id) } } });
        await prisma.benefitCarrierFile.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
        await prisma.benefitEligibilityException.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
        await prisma.benefitEnrollment.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
        await prisma.benefitPlan.deleteMany({ where: { id: { in: plans.map((p) => p.id) } } });
      },
      () => prisma.benefitEnrollmentWindow.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { name: { startsWith: TAG } }] } }),
      () => prisma.benefitLifeEvent.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      () => prisma.dependentRequest.deleteMany({ where: { tenantId: t, createdAt: { gte: since } } }),
      () => prisma.dependent.deleteMany({ where: { employee: { tenantId: t }, name: { startsWith: "Smoke " } } }),
      // Compensation
      async () => {
        const plans = await prisma.compPlan.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        const ids = plans.map((p) => p.id);
        const items = await prisma.compPlanItem.findMany({ where: { planId: { in: ids } }, select: { salaryRevisionId: true } });
        await prisma.arrear.deleteMany({ where: { createdAt: { gte: since }, employee: { tenantId: t } } });
        await prisma.salaryRevision.deleteMany({ where: { id: { in: items.map((i) => i.salaryRevisionId).filter((x): x is string => !!x) } } });
        await prisma.compStatement.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compDecisionLog.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compCalibrationSession.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compPoolTransfer.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compBudgetPool.deleteMany({ where: { planId: { in: ids } } });
        await prisma.compPlan.deleteMany({ where: { id: { in: ids } } });
      },
      () => prisma.compPlanTemplate.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.payEquityCohort.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.payRangeChange.deleteMany({ where: { tenantId: t, reason: { startsWith: TAG } } }),
      () => prisma.locationPayDifferential.deleteMany({ where: { tenantId: t, updatedAt: { gte: since } } }),
      async () => {
        const reqs = await prisma.allowanceChangeRequest.findMany({ where: { tenantId: t, reason: { startsWith: TAG } }, select: { id: true, overrideId: true } });
        await prisma.employeeComponentOverride.deleteMany({ where: { id: { in: reqs.map((r) => r.overrideId).filter((x): x is string => !!x) } } });
        await prisma.allowanceChangeRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
      },
      async () => { for (const g of gradesBefore) await prisma.payGrade.update({ where: { id: g.id }, data: { minAnnual: g.minAnnual, midAnnual: g.midAnnual, maxAnnual: g.maxAnnual } }); },
      async () => {
        const now = await prisma.employee.findMany({ where: { tenantId: t }, select: { id: true, payGradeId: true } });
        const before = new Map(empGradesBefore.map((e) => [e.id, e.payGradeId]));
        for (const e of now) if (before.has(e.id) && before.get(e.id) !== e.payGradeId) await prisma.employee.update({ where: { id: e.id }, data: { payGradeId: before.get(e.id) ?? null } });
      },
      // Shared
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

  console.log("\nMoney depth: expenses, travel, loans, benefits, compensation\n" + "=".repeat(72));
  try {
    // =======================================================================
    section("Expense policies");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create an expense policy", await denied(() => exd.saveExpensePolicyAction({}, fd({ name: `${TAG} nope` }))));
    await signInAs("manish.tiwari@acme.test");
    const cats = await prisma.expenseCategory.findMany({ where: { tenantId: t, isActive: true } });
    const meals = cats.find((c) => /meal/i.test(c.name)) ?? cats[0]!;
    const tmpl = await exd.expensePolicyTemplateAction({}, fd({ templateKey: "FIELD_SALES", name: `${TAG} field` }));
    check("A policy is created from a template", tmpl.ok === true, tmpl.message);
    const pol = await exd.saveExpensePolicyAction({}, multi({ name: `${TAG} policy`, escalationAboveAmount: 20000, payrollCutoffDay: 20, departmentId: meeraEmp.departmentId, [`cap_${meals.id}`]: 1500 }));
    check("Finance saves a scoped policy with a category cap", pol.ok === true, pol.message);
    const policy = await prisma.expensePolicy.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} policy` }, include: { categories: true } });
    check("…as a draft with the cap", policy.status === "DRAFT" && policy.categories.some((c) => c.categoryId === meals.id && Number(c.maxAmount) === 1500));
    const edit = await exd.saveExpensePolicyAction({}, multi({ id: policy.id, name: `${TAG} policy`, description: "Edited", escalationAboveAmount: 25000, payrollCutoffDay: 20, departmentId: meeraEmp.departmentId, [`cap_${meals.id}`]: 1800 }));
    check("The draft is edited", edit.ok === true && Number((await prisma.expensePolicy.findUniqueOrThrow({ where: { id: policy.id } })).escalationAboveAmount) === 25000);
    const sub = await exd.expensePolicyOpAction({}, fd({ id: policy.id, op: "submit" }));
    check("Submitting sends it for approval", sub.ok === true && (await prisma.expensePolicy.findUniqueOrThrow({ where: { id: policy.id } })).status === "PENDING_APPROVAL", sub.message);
    check("Approval puts it in force", (await settle("EXPENSE_POLICY", policy.id)) === "APPROVED" && (await prisma.expensePolicy.findUniqueOrThrow({ where: { id: policy.id } })).status === "ACTIVE");
    check("It governs the department", svc.pickExpensePolicy(await prisma.expensePolicy.findMany({ where: { tenantId: t } }), { departmentId: meeraEmp.departmentId, locationId: meeraEmp.locationId, bandId: meeraEmp.bandId })?.id === policy.id);
    await signInAs("manish.tiwari@acme.test");
    const rev = await exd.expensePolicyOpAction({}, fd({ id: policy.id, op: "revise" }));
    const revision = await prisma.expensePolicy.findFirstOrThrow({ where: { tenantId: t, supersedesId: policy.id } });
    check("An active policy is revised as a draft copy", rev.ok === true && revision.status === "DRAFT");
    await exd.expensePolicyOpAction({}, fd({ id: revision.id, op: "submit" }));
    check("Approving the revision retires the original", (await settle("EXPENSE_POLICY", revision.id)) === "APPROVED" && (await prisma.expensePolicy.findUniqueOrThrow({ where: { id: policy.id } })).status === "RETIRED");
    await signInAs("manish.tiwari@acme.test");
    const polPage = await html((await page("expenses/policies/page"))({ searchParams: sp({ q: TAG }) }));
    check("The policies page lists and searches them", polPage.includes(`${TAG} policy (revision)`) && polPage.includes(`${TAG} field`));
    check("Policy changes are audited", (await audits("ExpensePolicy")) >= 4);

    // =======================================================================
    section("Mileage and per-diem rates");
    const mil = await exd.proposeExpenseRateAction({}, fd({ kind: "MILEAGE", key: "CAR", amount: 9, effectiveFrom: "2020-01-01", note: `${TAG} car` }));
    const pd1 = await exd.proposeExpenseRateAction({}, fd({ kind: "PER_DIEM", key: "TIER_1", amount: 2500, effectiveFrom: "2020-01-01", note: `${TAG} tier 1` }));
    const pdIntl = await exd.proposeExpenseRateAction({}, fd({ kind: "PER_DIEM", key: "INTERNATIONAL", amount: 6000, effectiveFrom: "2020-01-01", note: `${TAG} intl` }));
    check("Rates are proposed", mil.ok && pd1.ok && pdIntl.ok, mil.message);
    const rates = await prisma.expenseRate.findMany({ where: { tenantId: t, note: { startsWith: TAG } } });
    for (const r of rates) await settle("EXPENSE_RATE", r.id);
    check("…and apply once approved", (await svc.expenseRateOn(t, "MILEAGE", "CAR", new Date())) === 9 && (await svc.expenseRateOn(t, "PER_DIEM", "TIER_1", new Date())) === 2500);
    await signInAs("manish.tiwari@acme.test");
    const bump = await exd.proposeExpenseRateAction({}, fd({ kind: "PER_DIEM", key: "TIER_1", amount: 2800, effectiveFrom: plus(400), note: `${TAG} next year` }));
    await settle("EXPENSE_RATE", (await prisma.expenseRate.findFirstOrThrow({ where: { tenantId: t, note: `${TAG} next year` } })).id);
    check("A later rate applies from its date only", bump.ok && (await svc.expenseRateOn(t, "PER_DIEM", "TIER_1", new Date())) === 2500 && (await svc.expenseRateOn(t, "PER_DIEM", "TIER_1", new Date(Date.now() + 401 * DAY))) === 2800);
    await signInAs("manish.tiwari@acme.test");
    check("The rates page shows them", (await html((await page("expenses/rates/page"))({ searchParams: sp() }))).includes("2,500"));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot propose a rate", await denied(() => exd.proposeExpenseRateAction({}, fd({ kind: "MILEAGE", key: "CAR", amount: 99, effectiveFrom: "2026-01-01" }))));

    // =======================================================================
    section("Claims: categories, pre-approval, mileage, duplicates, receipts");
    await signInAs("manish.tiwari@acme.test");
    check("Finance adds a mileage category", (await ex.saveExpenseCategoryAction({}, fd({ name: `${TAG} Mileage`, kind: "MILEAGE" }))).ok);
    check("…and a taxable one", (await ex.saveExpenseCategoryAction({}, fd({ name: `${TAG} Gift`, isTaxable: true, maxAmount: 50000 }))).ok);
    const mileage = await prisma.expenseCategory.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Mileage` } });
    const gift = await prisma.expenseCategory.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Gift` } });
    check("The category is taxable", gift.isTaxable && mileage.kind === "MILEAGE");

    await signInAs("meera.krishnan@acme.test");
    const pre = await exd.requestPreApprovalAction({}, fd({ purpose: `${TAG} conference`, estimatedAmount: 3000, categoryId: gift.id, expectedDate: plus(3) }));
    const preRow = await prisma.expensePreApproval.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} conference` } });
    check("A pre-approval is requested", pre.ok && preRow.status === "PENDING", pre.message);
    check("…and approved by her manager", (await settle("EXPENSE_PREAPPROVAL", preRow.id)) === "APPROVED" && (await prisma.expensePreApproval.findUniqueOrThrow({ where: { id: preRow.id } })).status === "APPROVED");

    await signInAs("meera.krishnan@acme.test");
    const tiny = await ex.submitClaimAction({}, multi({ title: `${TAG} tiny`, categoryId_0: meals.id, expenseDate_0: plus(-2), amount_0: 300, receipt_0: png(120, 90) }));
    check("An unreadable receipt image is refused", tiny.ok === false && /too small to read/.test(tiny.message), tiny.message);
    const claimRes = await ex.submitClaimAction({}, multi({
      title: `${TAG} client visit`, preApprovalId: preRow.id,
      categoryId_0: mileage.id, expenseDate_0: plus(-2), distanceKm_0: 40, vehicleType_0: "CAR", amount_0: 0,
      categoryId_1: meals.id, expenseDate_1: plus(-2), amount_1: 450, merchant_1: "Cafe Smoke", receipt_1: pdf(),
      categoryId_2: meals.id, expenseDate_2: plus(-2), amount_2: 450, merchant_2: "Cafe Smoke", receipt_2: pdf(),
      categoryId_3: gift.id, expenseDate_3: plus(-1), amount_3: 2000, receipt_3: pdf(),
    }));
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} client visit` }, include: { lines: { orderBy: { id: "asc" } } } });
    created.claims.push(claim.id);
    check("A claim with mileage, meals and a gift is submitted", claimRes.ok === true, claimRes.message);
    const mLine = claim.lines.find((l) => l.categoryId === mileage.id)!;
    check("Mileage is distance × the approved rate", Number(mLine.amount) === 360 && Number(mLine.distanceKm) === 40, String(mLine.amount));
    check("The repeated meal is flagged as a duplicate", /Line 3 looks like a duplicate of line 2/.test(claimRes.message));
    check("Receipts carry their quality check", claim.lines.filter((l) => l.receiptUrl).every((l) => !!l.receiptCheck));
    check("The pre-approval is used by the claim", (await prisma.expensePreApproval.findUniqueOrThrow({ where: { id: preRow.id } })).status === "USED" && claim.preApprovalId === preRow.id);

    const recall = await ex.claimOpAction({}, fd({ claimId: claim.id, op: "recall" }));
    check("She recalls it before anyone decides", recall.ok && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).stage === "DRAFT", recall.message);
    const dup = claim.lines.filter((l) => l.categoryId === meals.id)[1]!;
    const editForm = multi({ claimId: claim.id, title: `${TAG} client visit (edited)` });
    claim.lines.forEach((l, i) => {
      editForm.set(`id_${i}`, l.id); editForm.set(`categoryId_${i}`, l.categoryId); editForm.set(`expenseDate_${i}`, iso(l.expenseDate)); editForm.set(`amount_${i}`, String(Number(l.amount)));
      if (l.id === dup.id) editForm.set(`delete_${i}`, "on");
    });
    const upd = await exd.updateDraftClaimAction({}, editForm);
    const afterEdit = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id }, include: { lines: true } });
    check("…removes the duplicate and renames it", upd.ok && afterEdit.lines.length === 3 && afterEdit.title.endsWith("(edited)"), upd.message);
    const giftLine = afterEdit.lines.find((l) => l.categoryId === gift.id)!;
    const rep = await exd.replaceReceiptAction({}, multi({ claimId: claim.id, lineId: giftLine.id, receipt: pdf("better.pdf") }));
    check("…replaces a receipt", rep.ok && (await prisma.expenseClaimLine.findUniqueOrThrow({ where: { id: giftLine.id } })).receiptUpdatedAt !== null, rep.message);
    check("…and submits it again", (await ex.claimOpAction({}, fd({ claimId: claim.id, op: "submit" }))).ok && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).stage === "SUBMITTED");

    section("Claims: delegation, reason codes, taxable split");
    await signInAs("ananya.ghosh@acme.test");
    const del = await exd.delegateMoneyApprovalsAction({}, fd({ type: "EXPENSE_CLAIM", delegateEmployeeId: aditya.employee!.id, startsOn: iso(new Date()), endsOn: plus(7), reason: `${TAG} on leave` }));
    check("A manager delegates her claim approvals", del.ok === true, del.message);
    await signInAs("aditya.verma@acme.test");
    check("The delegate sees the claim waiting on her", (await html((await page("expenses/page"))({ searchParams: sp({ tab: "approvals" }) }))).includes(claim.claimNumber));
    const decided = await ex.decideClaimAction({}, multi({ claimId: claim.id, decision: "approve", [`approved_${giftLine.id}`]: 1500, [`code_${giftLine.id}`]: "OVER_LIMIT" }));
    const paidClaim = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id }, include: { lines: true } });
    check("…and approves it, cutting a line with a reason code", decided.ok && Number(paidClaim.lines.find((l) => l.id === giftLine.id)!.approvedAmount) === 1500 && paidClaim.lines.find((l) => l.id === giftLine.id)!.reasonCode === "OVER_LIMIT", decided.message);
    check("The decision is audited as a delegate", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "ExpenseClaim", entityId: claim.id, summary: { contains: "as delegate" } } })) === 1);
    const adhoc = await prisma.adhocTransaction.findMany({ where: { sourceType: "ExpenseClaim", sourceId: claim.id } });
    check("The taxable gift is paid separately as taxable", adhoc.some((a) => a.taxTreatment === "TAXABLE" && Number(a.amount) === 1500) && adhoc.some((a) => a.taxTreatment === "NON_TAXABLE" && Number(a.amount) === 810), adhoc.map((a) => `${a.taxTreatment} ${a.amount}`).join(", "));

    section("Expense audit sampling and reports");
    await signInAs("manish.tiwari@acme.test");
    const draw = await exd.drawAuditSampleAction({}, fd({ name: `${TAG} sample`, from: plus(-1), to: plus(1), ratePct: 100, seed: 7 }));
    const sample = await prisma.expenseAuditSample.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} sample` }, include: { items: true } });
    check("An audit sample is drawn", draw.ok && sample.items.some((i) => i.claimId === claim.id), draw.message);
    const item = sample.items.find((i) => i.claimId === claim.id)!;
    const review = await exd.reviewAuditItemAction({}, fd({ itemId: item.id, outcome: "ISSUE", finding: "Gift receipt is a quote", recoverAmount: 200 }));
    check("A finding books a salary recovery", review.ok && (await prisma.adhocTransaction.count({ where: { sourceType: "ExpenseAuditRecovery", sourceId: item.id } })) === 1, review.message);
    for (const i of sample.items.filter((x) => x.id !== item.id)) await exd.reviewAuditItemAction({}, fd({ itemId: i.id, outcome: "OK" }));
    check("The sample closes once reviewed", (await exd.closeAuditSampleAction({}, fd({ id: sample.id }))).ok);
    check("The audit page shows it", (await html((await page("expenses/audit/page"))({ searchParams: sp({ sample: sample.id }) }))).includes("Gift receipt is a quote"));
    const exRoute = await route("expenses/reports/export/route");
    for (const kind of ["reimbursements", "receipts", "projects", "finance", "audit"]) {
      const r = await csvGet(exRoute, `/expenses/reports/export?kind=${kind}`);
      check(`The ${kind} export downloads`, r.status === 200 && r.body.split("\n").length >= 2, `${r.status}`);
    }
    check("The reimbursement export carries the claim", (await csvGet(exRoute, "/expenses/reports/export?kind=reimbursements")).body.includes(claim.claimNumber));
    check("The reports page renders", (await html((await page("expenses/reports/page"))({ searchParams: sp({ kind: "finance" }) }))).includes("Download CSV"));
    await signInAs("meera.krishnan@acme.test");
    check("Employees cannot export expense reports", (await csvGet(exRoute, "/expenses/reports/export?kind=finance")).status === 403);
    const claimPage = await html((await page("expenses/[id]/page"))({ params: pr(claim.id) }));
    check("The claim page shows its audit history and reason code", claimPage.includes("Reduced: Over the policy limit"));

    // =======================================================================
    section("Travel policy, purposes, destinations, profile");
    await signInAs("manish.tiwari@acme.test");
    const tpol = await tr.saveTravelPolicyAction({}, fd({ name: `${TAG} travel`, domesticFlightClass: "ECONOMY", internationalFlightClass: "PREMIUM_ECONOMY", hotelCapPerNight: 6000, groundDailyCap: 1500, minAdvanceDays: 3, secondApprovalAbove: 100000, internationalNeedsSecondApproval: true, requireInsuranceInternational: true, passportValidityMonths: 6 }));
    const travelPolicy = await prisma.travelPolicy.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} travel` } });
    check("The travel desk drafts a travel policy", tpol.ok && travelPolicy.status === "DRAFT", tpol.message);
    check("…edits it", (await tr.saveTravelPolicyAction({}, fd({ id: travelPolicy.id, name: `${TAG} travel`, domesticFlightClass: "ECONOMY", internationalFlightClass: "PREMIUM_ECONOMY", hotelCapPerNight: 6000, groundDailyCap: 1500, minAdvanceDays: 2, secondApprovalAbove: 100000, internationalNeedsSecondApproval: true, requireInsuranceInternational: true, passportValidityMonths: 6 }))).ok);
    await tr.travelPolicyOpAction({}, fd({ id: travelPolicy.id, op: "submit" }));
    check("…and it is approved into force", (await settle("TRAVEL_POLICY", travelPolicy.id)) === "APPROVED" && (await prisma.travelPolicy.findUniqueOrThrow({ where: { id: travelPolicy.id } })).status === "ACTIVE");
    await signInAs("manish.tiwari@acme.test");
    check("A trip purpose is added", (await tr.saveTripPurposeAction({}, fd({ code: "SMKCLT", name: `${TAG} client`, isBillable: true, isActive: true }))).ok);
    check("Destination advisories are set", (await tr.saveDestinationRiskAction({}, fd({ destination: "Smoketown", level: "CRITICAL", advisory: "Civil unrest", blockTravel: true }))).ok && (await tr.saveDestinationRiskAction({}, fd({ destination: "Riskville", level: "HIGH", advisory: "Monsoon flooding" }))).ok);
    const purpose = await prisma.tripPurpose.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} client` } });
    await signInAs("meera.krishnan@acme.test");
    const prof = await tr.saveTravelerProfileAction({}, fd({ seatPreference: "Aisle", mealPreference: "Vegetarian", passportNumber: "Z1234567", passportExpiry: plus(60), passportCountry: "India", notes: `${TAG} profile` }));
    check("The traveller saves her preferences and passport", prof.ok && !!(await prisma.travelerProfile.findFirst({ where: { employeeId: meeraEmp.id, seatPreference: "Aisle" } })), prof.message);

    section("Trips: matrix, bookings, itinerary, advance, settlement");
    const domestic = await ex.requestTripAction({}, fd({ purpose: `${TAG} Chennai visit`, purposeId: purpose.id, fromCity: "Bengaluru", toCity: "Chennai", departDate: plus(10), returnDate: plus(12), travelType: "DOMESTIC", estimatedCost: 20000, needsAccommodation: true }));
    const trip = await prisma.travelRequest.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} Chennai visit` } });
    created.trips.push(trip.id);
    check("A domestic trip is requested with a purpose", domestic.ok && trip.purposeId === purpose.id, domestic.message);
    const tedit = await tr.editTripAction({}, fd({ tripId: trip.id, purpose: `${TAG} Chennai visit`, purposeId: purpose.id, fromCity: "Bengaluru", toCity: "Chennai", departDate: plus(10), returnDate: plus(12), travelType: "DOMESTIC", estimatedCost: 18000, needsAccommodation: true }));
    check("…edited before approval", tedit.ok && Number((await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).estimatedCost) === 18000);
    const adv = await ex.requestAdvanceAction({}, fd({ amount: 3000, purpose: `${TAG} trip advance`, tripId: trip.id }));
    const advance = await prisma.cashAdvance.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} trip advance` } });
    created.advances.push(advance.id);
    check("An advance is requested against the trip", adv.ok, adv.message);
    await signInAs("ananya.ghosh@acme.test");
    check("Her manager approves the trip; within policy it needs nothing more", (await ex.tripOpAction({}, fd({ tripId: trip.id, op: "approve" }))).ok && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).status === "APPROVED");
    await signInAs("priya.sharma@acme.test");
    const advOk = await ex.advanceOpAction({}, fd({ advanceId: advance.id, op: "approve" }));
    check("HR approves the advance", advOk.ok, advOk.message);
    await signInAs("manish.tiwari@acme.test");
    const disb = await ex.advanceOpAction({}, fd({ advanceId: advance.id, op: "disburse" }));
    check("The advance is approved and paid out", disb.ok && (await prisma.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } })).status === "DISBURSED", disb.message);
    check("…and linked to the trip", (await tr.linkTripAdvanceAction({}, fd({ tripId: trip.id, advanceId: advance.id }))).ok && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).advanceId === advance.id);
    const biz = await tr.saveBookingAction({}, multi({ tripId: trip.id, kind: "FLIGHT", vendor: "Air Smoke", reference: "SM-101", travelClass: "BUSINESS", startsAt: plus(10), cost: 15000 }));
    const bizRow = await prisma.travelBooking.findFirstOrThrow({ where: { tripId: trip.id, reference: "SM-101" } });
    check("A business-class flight breaks the domestic entitlement and waits for approval", biz.ok && bizRow.status === "PENDING_APPROVAL" && !bizRow.inPolicy, biz.message);
    check("…the approval confirms it", (await settle("TRAVEL_BOOKING", bizRow.id)) === "APPROVED" && (await prisma.travelBooking.findUniqueOrThrow({ where: { id: bizRow.id } })).status === "CONFIRMED");
    await signInAs("manish.tiwari@acme.test");
    const hotel = await tr.saveBookingAction({}, multi({ tripId: trip.id, kind: "HOTEL", vendor: "Smoke Inn", reference: "HTL-9", startsAt: plus(10), endsAt: plus(12), cost: 9000, itinerary: pdf("hotel.pdf") }));
    const hotelRow = await prisma.travelBooking.findFirstOrThrow({ where: { tripId: trip.id, reference: "HTL-9" } });
    check("A hotel within the cap is confirmed with its voucher", hotel.ok && hotelRow.status === "CONFIRMED" && !!hotelRow.itineraryUrl, hotel.message);
    check("The trip is booked", (await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).status === "BOOKED");
    const amend = await tr.saveBookingAction({}, multi({ tripId: trip.id, bookingId: hotelRow.id, kind: "HOTEL", vendor: "Smoke Inn", reference: "HTL-10", startsAt: plus(10), endsAt: plus(12), cost: 10000 }));
    check("Amending a booking replaces it", amend.ok && (await prisma.travelBooking.findUniqueOrThrow({ where: { id: hotelRow.id } })).status === "AMENDED", amend.message);
    const cab = await tr.saveBookingAction({}, multi({ tripId: trip.id, kind: "CAB", vendor: "Smoke Cabs", reference: "CAB-1", startsAt: plus(10), cost: 4000 }));
    const cabRow = await prisma.travelBooking.findFirstOrThrow({ where: { tripId: trip.id, reference: "CAB-1" } });
    check("A cab above the ground limit is held", cab.ok && cabRow.status === "PENDING_APPROVAL");
    check("…and can be cancelled", (await tr.cancelBookingAction({}, fd({ bookingId: cabRow.id }))).ok && (await prisma.travelBooking.findUniqueOrThrow({ where: { id: cabRow.id } })).status === "CANCELLED");
    const it = await tr.uploadItineraryAction({}, multi({ bookingId: bizRow.id, itinerary: pdf("eticket.pdf") }));
    check("An e-ticket is filed against the flight", it.ok && !!(await prisma.travelBooking.findUniqueOrThrow({ where: { id: bizRow.id } })).itineraryUrl, it.message);
    await signInAs("meera.krishnan@acme.test");
    const settleRes = await tr.travelSettlementAction({}, fd({ tripId: trip.id, perDiemTier: "TIER_1", intent: "submit" }));
    const settlement = await prisma.travelSettlement.findFirstOrThrow({ where: { tripId: trip.id } });
    check("The traveller settles: 2.5 days of per diem against the advance", settleRes.ok && Number(settlement.perDiemAmount) === 6250 && Number(settlement.advanceAmount) === 3000 && Number(settlement.netAmount) === 3250, settleRes.message);
    check("Finance approves the settlement", (await settle("TRAVEL_SETTLEMENT", settlement.id)) === "APPROVED");
    check("…which clears the advance and pays the balance", (await prisma.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } })).status === "SETTLED" && (await prisma.adhocTransaction.count({ where: { sourceType: "TravelSettlement", sourceId: settlement.id } })) === 1);
    check("…and completes the trip", (await prisma.travelRequest.findUniqueOrThrow({ where: { id: trip.id } })).status === "COMPLETED");

    section("Trips: international, risk, checklist, insurance, change, cancel, block");
    await signInAs("meera.krishnan@acme.test");
    await ex.requestTripAction({}, fd({ purpose: `${TAG} Riskville summit`, fromCity: "Bengaluru", toCity: "Riskville", destinationCountry: "Riskland", departDate: plus(20), returnDate: plus(25), travelType: "INTERNATIONAL", estimatedCost: 150000 }));
    const intl = await prisma.travelRequest.findFirstOrThrow({ where: { tenantId: t, purpose: `${TAG} Riskville summit` } });
    created.trips.push(intl.id);
    await signInAs("ananya.ghosh@acme.test");
    const mgr = await ex.tripOpAction({}, fd({ tripId: intl.id, op: "approve" }));
    const intlAfter = await prisma.travelRequest.findUniqueOrThrow({ where: { id: intl.id } });
    const codes = ((intlAfter.violations ?? []) as Array<{ code: string }>).map((v) => v.code);
    check("International, costly and high-risk: the matrix asks for a second approval", mgr.ok && intlAfter.status === "REQUESTED" && !!intlAfter.workflowRequestId, mgr.message);
    check("…flagging cost, international travel, risk and the passport", ["COST_ABOVE_LIMIT", "INTERNATIONAL", "DESTINATION_RISK", "PASSPORT"].every((c) => codes.includes(c)), codes.join(","));
    const checklist = await prisma.tripChecklistItem.findMany({ where: { tripId: intl.id } });
    check("A visa, passport and insurance checklist is opened", ["VISA", "PASSPORT", "INSURANCE"].every((k) => checklist.some((c) => c.kind === k)));
    check("The travel desk approves the second level", (await settle("TRAVEL_APPROVAL", intl.id)) === "APPROVED" && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: intl.id } })).status === "APPROVED");
    await signInAs("meera.krishnan@acme.test");
    const ins = await tr.tripInsuranceAction({}, fd({ tripId: intl.id, provider: "Smoke Assure", policyNo: "TRV-77", validTo: plus(30) }));
    check("Insurance is recorded and ticks the checklist", ins.ok && (await prisma.tripChecklistItem.findFirstOrThrow({ where: { tripId: intl.id, kind: "INSURANCE" } })).done);
    const visa = checklist.find((c) => c.kind === "VISA")!;
    check("The visa is ticked with the document", (await tr.checklistAction({}, multi({ tripId: intl.id, itemId: visa.id, done: "true", file: pdf("visa.pdf") }))).ok && !!(await prisma.tripChecklistItem.findUniqueOrThrow({ where: { id: visa.id } })).fileUrl);
    check("…and an item is added", (await tr.checklistAction({}, fd({ tripId: intl.id, op: "add", kind: "FOREX", label: "Forex card loaded" }))).ok);
    const change = await tr.requestTripChangeAction({}, fd({ tripId: intl.id, kind: "CHANGE", reason: "Summit extended", returnDate: plus(26) }));
    const ch = await prisma.tripChange.findFirstOrThrow({ where: { tripId: intl.id, kind: "CHANGE" } });
    check("A change to an approved trip goes for approval", change.ok && ch.status === "PENDING", change.message);
    check("…and applies once approved", (await settle("TRIP_CHANGE", ch.id)) === "APPROVED" && iso((await prisma.travelRequest.findUniqueOrThrow({ where: { id: intl.id } })).returnDate!) === plus(26));
    await signInAs("meera.krishnan@acme.test");
    const cancel = await ex.tripOpAction({}, fd({ tripId: intl.id, op: "cancel", reason: "Summit called off" }));
    const cc = await prisma.tripChange.findFirstOrThrow({ where: { tripId: intl.id, kind: "CANCEL" } });
    check("Cancelling an approved trip is a request too", cancel.ok && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: intl.id } })).status === "APPROVED");
    check("…approved, it cancels the trip", (await settle("TRIP_CHANGE", cc.id)) === "APPROVED" && (await prisma.travelRequest.findUniqueOrThrow({ where: { id: intl.id } })).status === "CANCELLED");
    await signInAs("meera.krishnan@acme.test");
    const blkReq = await ex.requestTripAction({}, fd({ purpose: `${TAG} Smoketown`, fromCity: "Bengaluru", toCity: "Smoketown", departDate: plus(15), returnDate: plus(16), travelType: "DOMESTIC" }));
    check("Travel to a blocked destination is refused", blkReq.ok === false && /blocked/.test(blkReq.message), blkReq.message);
    check("…and nothing is saved", (await prisma.travelRequest.count({ where: { tenantId: t, purpose: `${TAG} Smoketown` } })) === 0);

    section("Travel pages, reports and audit");
    await signInAs("manish.tiwari@acme.test");
    const travelPage = await html((await page("expenses/travel/page"))({ searchParams: sp({ q: "Chennai" }) }));
    check("The travel desk searches trips", travelPage.includes(trip.requestNumber) && !travelPage.includes("Riskville"));
    const tripPage = await html((await page("expenses/travel/[id]/page"))({ params: pr(trip.id) }));
    check("The trip page shows bookings, settlement and history", tripPage.includes("SM-101") && tripPage.includes("6,250"));
    check("The policy page lists policies, purposes and advisories", (await html((await page("expenses/travel/policies/page"))({ searchParams: sp() }))).includes("Smoketown"));
    check("The travel dashboard renders spend and who is away", (await html((await page("expenses/travel/dashboard/page"))({ searchParams: sp() }))).length > 500);
    const trRoute = await route("expenses/travel/export/route");
    for (const kind of ["trips", "bookings", "settlements", "per-diem"]) {
      const r = await csvGet(trRoute, `/expenses/travel/export?kind=${kind}`);
      check(`The ${kind} report downloads`, r.status === 200 && r.body.length > 20);
    }
    check("The bookings report has the flight", (await csvGet(trRoute, "/expenses/travel/export?kind=bookings")).body.includes("SM-101"));
    check("Trips, bookings and settlements are audited", (await audits("TravelRequest")) >= 4 && (await audits("TravelBooking")) >= 2 && (await audits("TravelSettlement")) >= 2);
    await signInAs("aditya.verma@acme.test");
    check("A colleague cannot open someone else's trip", await denied(async () => html((await page("expenses/travel/[id]/page"))({ params: pr(trip.id) }))));

    // =======================================================================
    section("Loan products: fees, documents, approval of changes");
    const cat = (await prisma.loanCategory.findMany({ where: { tenantId: t, policyRules: { some: {} } }, include: { policyRules: true } })).find((c) => !/salary/i.test(c.name))!;
    const elig0 = await svc.checkLoanEligibility(nikhilEmp.id, cat.id);
    const policyId = elig0.policyId!;
    const rule = loanRulesBefore.find((r) => r.policyId === policyId && r.categoryId === cat.id)!;
    await signInAs("ramesh.iyer@acme.test");
    const lp = await ln.saveLoanPolicyAction({}, fd({ id: policyId, requireChangeApproval: true, requireProbationComplete: true }));
    check("The loan desk requires approval for product changes", lp.ok, lp.message);
    const ruleForm = { policyId, categoryId: cat.id, interestType: rule.interestType, interestRate: rule.interestRate === null ? undefined : Number(rule.interestRate), maxInstallments: rule.maxInstallments, commencementMonths: rule.commencementMonths, maxAmount: rule.maxAmount === null ? undefined : Number(rule.maxAmount), maxPercentOfSalary: rule.maxPercentOfSalary === null ? undefined : Number(rule.maxPercentOfSalary), requiresDocuments: true, processingFeePct: 1, processingFeeFlat: 250 };
    const rr = await ln.saveLoanRuleAction({}, fd(ruleForm));
    const change1 = await prisma.loanProductChange.findFirstOrThrow({ where: { tenantId: t, policyId, categoryId: cat.id, status: "PENDING" } });
    check("A fee and document rule waits for approval", rr.ok && !(await prisma.loanPolicyRule.findUniqueOrThrow({ where: { policyId_categoryId: { policyId, categoryId: cat.id } } })).requiresDocuments, rr.message);
    check("…and applies once a loan approver agrees", (await settle("LOAN_PRODUCT", change1.id)) === "APPLIED" || (await prisma.loanProductChange.findUniqueOrThrow({ where: { id: change1.id } })).status === "APPLIED");
    const newRule = await prisma.loanPolicyRule.findUniqueOrThrow({ where: { policyId_categoryId: { policyId, categoryId: cat.id } } });
    check("The rule now asks for a document and a fee", newRule.requiresDocuments && Number(newRule.processingFeePct) === 1 && Number(newRule.processingFeeFlat) === 250);

    section("Loan requests: document, edit, delegation, tranches");
    await signInAs("nikhil.joshi@acme.test");
    const noDoc = await ln.applyLoanAction({}, fd({ categoryId: cat.id, amount: 60000, installments: 6, purpose: `${TAG} loan` }));
    check("Applying without the document is refused", noDoc.ok === false && /document/i.test(noDoc.message), noDoc.message);
    const applied = await ln.applyLoanAction({}, multi({ categoryId: cat.id, amount: 60000, installments: 6, purpose: `${TAG} loan`, document: pdf("quote.pdf") }));
    const loan = await prisma.loan.findFirstOrThrow({ where: { employeeId: nikhilEmp.id, purpose: `${TAG} loan` } });
    created.loans.push(loan.id);
    check("With it the loan is requested, document attached", applied.ok && !!loan.documentUrl, applied.message);
    const ed = await lnd.updateLoanRequestAction({}, fd({ loanId: loan.id, amount: 80000, installments: 5, purpose: `${TAG} loan` }));
    check("He changes the request before a decision", ed.ok && Number((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).principal) === 80000, ed.message);
    await signInAs("priya.sharma@acme.test");
    check("Someone without loan approval cannot decide it", await denied(() => ln.decideLoanAction({}, fd({ loanId: loan.id, decision: "approve" }))));
    await signInAs("lakshmi.narayanan@acme.test");
    const ld = await exd.delegateMoneyApprovalsAction({}, fd({ type: "LOAN_REQUEST", delegateEmployeeId: priya.employee!.id, startsOn: iso(new Date()), endsOn: plus(5), reason: `${TAG} away` }));
    check("A loan approver delegates to a colleague", ld.ok, ld.message);
    await signInAs("priya.sharma@acme.test");
    check("The delegate sees and opens the loan", (await html((await page("payroll/loans/[id]/page"))({ params: pr(loan.id) }))).includes("deciding as a delegate"));
    const dec = await ln.decideLoanAction({}, fd({ loanId: loan.id, decision: "approve" }));
    check("…and approves it on the approver's behalf", dec.ok && (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status === "APPROVED", dec.message);
    check("The processing fee is worked out from the rule", Number((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).processingFee) === 1050);
    await signInAs("ramesh.iyer@acme.test");
    const plan = await lnd.planTranchesAction({}, fd({ loanId: loan.id, count: 2, gapMonths: 1, firstOn: iso(new Date()) }));
    check("The desk plans two tranches", plan.ok && (await prisma.loanTranche.count({ where: { loanId: loan.id } })) === 2, plan.message);
    await ln.loanOperationAction({}, fd({ loanId: loan.id, op: "disburse" }));
    const tranches = await prisma.loanTranche.findMany({ where: { loanId: loan.id }, orderBy: { sequence: "asc" } });
    check("Disbursal releases the first", tranches[0]!.status === "PAID" && tranches[1]!.status === "PLANNED");
    check("…the second is released later", (await lnd.releaseTrancheAction({}, fd({ trancheId: tranches[1]!.id }))).ok && (await prisma.loanTranche.findUniqueOrThrow({ where: { id: tranches[1]!.id } })).status === "PAID");

    section("Loan adjustments: prepay, reschedule, write-down, settle");
    await signInAs("nikhil.joshi@acme.test");
    const pp = await lnd.requestLoanAdjustmentAction({}, fd({ loanId: loan.id, kind: "PREPAYMENT", amount: 10000, keep: "TENURE", reason: "Bonus came in" }));
    const ppRow = await prisma.loanAdjustment.findFirstOrThrow({ where: { loanId: loan.id, kind: "PREPAYMENT" } });
    check("He asks to prepay; it waits for the loan approver", pp.ok && ppRow.status === "PENDING", pp.message);
    check("…approved, the balance drops", (await settle("LOAN_ADJUSTMENT", ppRow.id)) === "APPROVED" && Number((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).outstanding) === 70000);
    await signInAs("nikhil.joshi@acme.test");
    const rs = await lnd.requestLoanAdjustmentAction({}, fd({ loanId: loan.id, kind: "RESCHEDULE", installments: 10, reason: "Lower EMI please" }));
    const rsRow = await prisma.loanAdjustment.findFirstOrThrow({ where: { loanId: loan.id, kind: "RESCHEDULE" } });
    check("A reschedule spreads what is left over new months", rs.ok && (await settle("LOAN_ADJUSTMENT", rsRow.id)) === "APPROVED" && (await prisma.loanInstallment.count({ where: { loanId: loan.id, status: "SCHEDULED" } })) === 10);
    await signInAs("ramesh.iyer@acme.test");
    const bal = await lnd.adminLoanAdjustmentAction({}, fd({ loanId: loan.id, kind: "BALANCE", amount: 2000, reason: "Goodwill write-down" }));
    check("The desk writes the balance down", bal.ok && Number((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).outstanding) === 68000, bal.message);
    const statement = await csvGet(await route("payroll/loans/[id]/statement/route"), `/payroll/loans/${loan.id}/statement`, { id: loan.id });
    check("A statement is generated with every movement", statement.status === 200 && statement.body.includes("PREPAID") && statement.body.includes("WAIVED"));
    await signInAs("nikhil.joshi@acme.test");
    check("The borrower downloads his statement too", (await csvGet(await route("payroll/loans/[id]/statement/route"), `/payroll/loans/${loan.id}/statement`, { id: loan.id })).status === 200);
    check("His loan page shows it", (await html((await page("finances/loans/[id]/page"))({ params: pr(loan.id) }))).includes("Changes to repayment"));
    await signInAs("meera.krishnan@acme.test");
    check("Nobody else gets the statement", (await csvGet(await route("payroll/loans/[id]/statement/route"), `/payroll/loans/${loan.id}/statement`, { id: loan.id })).status === 403);
    check("…or the page", await denied(() => html((async () => (await page("finances/loans/[id]/page"))({ params: pr(loan.id) }))())));

    // Overdue: put one EMI in a payroll month that has closed.
    const closedRun = await prisma.payrollRun.findFirst({ where: { payGroupId: nikhilEmp.payGroupId ?? "__", type: "REGULAR", status: { in: ["FINALIZED", "LOCKED"] }, rolledBackAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    if (closedRun) {
      const first = await prisma.loanInstallment.findFirstOrThrow({ where: { loanId: loan.id, status: "SCHEDULED" }, orderBy: { sequence: "asc" } });
      await prisma.loanInstallment.update({ where: { id: first.id }, data: { year: closedRun.year, month: closedRun.month } });
    }
    await signInAs("ramesh.iyer@acme.test");
    const od = await lnd.runLoanOverdueAlertsAction({}, fd({}));
    check("Overdue EMIs are alerted once", od.ok && (closedRun ? /Alerted/.test(od.message) : true), od.message);
    check("…not twice", (await lnd.runLoanOverdueAlertsAction({}, fd({}))).message === "No new overdue EMIs." || !closedRun);
    const portfolio = await html((await page("payroll/loans/portfolio/page"))({ searchParams: sp({ report: "adjustments" }) }));
    check("The portfolio shows the book and the adjustments", portfolio.includes("Loan portfolio") && portfolio.includes("Goodwill write-down"));
    const pRoute = await route("payroll/loans/portfolio/export/route");
    for (const r of ["outstanding", "advances", "settlements", "adjustments"]) check(`The ${r} report downloads`, (await csvGet(pRoute, `/payroll/loans/portfolio/export?report=${r}`)).status === 200);
    check("The outstanding report lists the loan", (await csvGet(pRoute, "/payroll/loans/portfolio/export?report=outstanding")).body.includes("68000"));
    await signInAs("nikhil.joshi@acme.test");
    const st = await lnd.requestLoanAdjustmentAction({}, fd({ loanId: loan.id, kind: "SETTLEMENT", reason: "Paying it off" }));
    const stRow = await prisma.loanAdjustment.findFirstOrThrow({ where: { loanId: loan.id, kind: "SETTLEMENT" } });
    check("Settling in full is approved and closes the loan", st.ok && (await settle("LOAN_ADJUSTMENT", stRow.id)) === "APPROVED" && (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status === "FORECLOSED");
    await signInAs("ramesh.iyer@acme.test");
    check("The settlement report has it", (await csvGet(pRoute, "/payroll/loans/portfolio/export?report=settlements")).body.includes("Paying it off"));
    check("The loan page keeps the audit trail", (await html((await page("payroll/loans/[id]/page"))({ params: pr(loan.id) }))).includes("Audit trail") && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "Loan", entityId: loan.id } })) >= 5);

    section("Emergency salary advance");
    await signInAs("ramesh.iyer@acme.test");
    const emer = await ln.saveLoanCategoryAction({}, fd({ id: cat.id, name: cat.name, code: cat.code ?? undefined, description: cat.description ?? undefined, isConcessional: cat.isConcessional, isEmergency: true, emergencyMaxMonthsSalary: 0.5 }));
    const gross = await svc.monthlyGrossOf(nikhilEmp.id);
    const big = await svc.checkLoanEligibility(nikhilEmp.id, cat.id, Math.ceil(gross * 0.5) + 1000, 3);
    check("An emergency advance is capped at months of salary", emer.ok && !big.eligible && /most you can borrow/.test(big.reasons.join(" ")), big.reasons.join(" "));

    // =======================================================================
    section("Benefit plans and approval");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot set up benefit plans", await denied(() => ben.saveBenefitPlanAction({}, fd({ code: "SMKX", name: "x" }))));
    await signInAs("priya.sharma@acme.test");
    const bands = await prisma.band.findMany({ where: { tenantId: t } });
    const otherBand = bands.find((b) => b.id !== meeraEmp.bandId);
    const health = await ben.saveBenefitPlanAction({}, multi({ code: "SMKHLTH", name: `${TAG} Health`, type: "HEALTH", provider: "Smoke Insure", coverageAmount: 500000, monthlyPremium: 1000, factorSpouse: 1.8, factorFamily: 2.5, employerRule: "PERCENT_OF_PREMIUM", employerValue: 80, waitingPeriodDays: 0, maxDependents: 3, childMaxAge: 25, requiresDependentProof: true, deductionName: "Health premium", allowedRelations: ["SPOUSE", "CHILD"], planYearStart: iso(new Date(Date.now() - 200 * DAY)), planYearEnd: plus(165) }));
    check("HR sets up a health plan", health.ok, health.message);
    const hPlan = await prisma.benefitPlan.findFirstOrThrow({ where: { tenantId: t, code: "SMKHLTH" } });
    check("…and edits the draft", (await ben.saveBenefitPlanAction({}, multi({ id: hPlan.id, code: "SMKHLTH", name: `${TAG} Health`, type: "HEALTH", provider: "Smoke Insure", coverageAmount: 500000, monthlyPremium: 1000, factorSpouse: 1.8, factorFamily: 2.5, employerRule: "PERCENT_OF_PREMIUM", employerValue: 80, waitingPeriodDays: 0, maxDependents: 4, childMaxAge: 25, requiresDependentProof: true, deductionName: "Health premium", allowedRelations: ["SPOUSE", "CHILD"], planYearStart: iso(new Date(Date.now() - 200 * DAY)), planYearEnd: plus(165) }))).ok && (await prisma.benefitPlan.findUniqueOrThrow({ where: { id: hPlan.id } })).maxDependents === 4);
    await ben.saveBenefitPlanAction({}, fd({ code: "SMKNPS", name: `${TAG} NPS`, type: "RETIREMENT", monthlyPremium: 0, employerRule: "MATCH_PERCENT_OF_BASIC", employerValue: 5, waitingPeriodDays: 0, maxDependents: 0 }));
    await ben.saveBenefitPlanAction({}, multi({ code: "SMKEXEC", name: `${TAG} Executive cover`, type: "LIFE", monthlyPremium: 500, employerRule: "FLAT", employerValue: 500, waitingPeriodDays: 0, maxDependents: 0, bandIds: otherBand ? [otherBand.id] : [] }));
    const nps = await prisma.benefitPlan.findFirstOrThrow({ where: { tenantId: t, code: "SMKNPS" } });
    const exec = await prisma.benefitPlan.findFirstOrThrow({ where: { tenantId: t, code: "SMKEXEC" } });
    for (const p of [hPlan, nps, exec]) await ben.benefitPlanOpAction({}, fd({ id: p.id, op: "submit" }));
    check("Plans wait for approval before they open", (await prisma.benefitPlan.findUniqueOrThrow({ where: { id: hPlan.id } })).status === "PENDING_APPROVAL");
    for (const p of [hPlan, nps, exec]) await settle("BENEFIT_PLAN", p.id);
    check("…and open once approved", (await prisma.benefitPlan.count({ where: { id: { in: [hPlan.id, nps.id, exec.id] }, status: "ACTIVE" } })) === 3);
    await signInAs("priya.sharma@acme.test");
    const catalog = await html((await page("payroll/benefits/page"))({ searchParams: sp() }));
    check("The catalogue compares the cost per tier", catalog.includes(`${TAG} Health`) && catalog.includes("200") && catalog.includes("+ Spouse"));

    section("Eligibility, exceptions and windows");
    const matrix = await svc.eligibilityMatrix(t, { id: meeraEmp.id });
    const execCell = matrix.rows[0]!.cells[matrix.plans.findIndex((p) => p.id === exec.id)]!;
    check("The matrix shows who each plan is open to", matrix.rows.length === 1 && (!otherBand || (!execCell.eligible && /Band/.test(execCell.gaps.join(" ")))));
    const win = await ben.createEnrollmentWindowAction({}, multi({ name: `${TAG} open enrolment`, kind: "OPEN", opensOn: iso(new Date()), closesOn: plus(14), planIds: [hPlan.id, nps.id, exec.id] }));
    const window = await prisma.benefitEnrollmentWindow.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} open enrolment` } });
    check("An open enrolment window is opened", win.ok, win.message);
    const ann = await ben.windowOpAction({}, fd({ id: window.id, op: "announce" }));
    check("…announced to everyone eligible", ann.ok && (await prisma.notification.count({ where: { tenantId: t, kind: "BENEFITS", createdAt: { gte: started } } })) > 5, ann.message);
    if (otherBand) {
      await signInAs("meera.krishnan@acme.test");
      const exc = await ben.benefitExceptionAction({}, fd({ planId: exec.id, reason: "I lead client escalations" }));
      const excRow = await prisma.benefitEligibilityException.findFirstOrThrow({ where: { planId: exec.id, employeeId: meeraEmp.id } });
      check("Someone outside the rules asks for an exception", exc.ok && excRow.status === "PENDING", exc.message);
      check("…her manager and HR approve it", (await settle("BENEFIT_EXCEPTION", excRow.id)) === "APPROVED" && (await svc.benefitEligibility(exec.id, meeraEmp.id)).eligible);
    }

    section("Dependents with proof");
    await signInAs("meera.krishnan@acme.test");
    const noProof = await ben.dependentRequestAction({}, fd({ action: "ADD", name: "Smoke Spouse", relationship: "SPOUSE", dateOfBirth: "1990-05-01" }));
    check("Adding a dependent needs proof", noProof.ok === false && /proof/i.test(noProof.message));
    await ben.dependentRequestAction({}, multi({ action: "ADD", name: "Smoke Spouse", relationship: "SPOUSE", dateOfBirth: "1990-05-01", proof: pdf("marriage.pdf") }));
    await ben.dependentRequestAction({}, multi({ action: "ADD", name: "Smoke Elder Child", relationship: "CHILD", dateOfBirth: "1996-01-01", proof: pdf("birth.pdf") }));
    const dreqs = await prisma.dependentRequest.findMany({ where: { employeeId: meeraEmp.id, createdAt: { gte: started } } });
    check("Requests wait for HR to check the proof", dreqs.length === 2 && dreqs.every((d) => d.status === "PENDING"));
    for (const d of dreqs) await settle("DEPENDENT_CHANGE", d.id);
    const spouse = await prisma.dependent.findFirstOrThrow({ where: { employeeId: meeraEmp.id, name: "Smoke Spouse" } });
    const elder = await prisma.dependent.findFirstOrThrow({ where: { employeeId: meeraEmp.id, name: "Smoke Elder Child" } });
    check("…approved, they are on file and verified", !!spouse.verifiedAt && !!spouse.proofUrl);
    await signInAs("meera.krishnan@acme.test");
    const updReq = await ben.dependentRequestAction({}, fd({ action: "UPDATE", dependentId: spouse.id, name: "Smoke Spouse Renamed", relationship: "SPOUSE", dateOfBirth: "1990-05-01" }));
    const updRow = await prisma.dependentRequest.findFirstOrThrow({ where: { employeeId: meeraEmp.id, action: "UPDATE" } });
    check("A correction is approved and applied", updReq.ok && (await settle("DEPENDENT_CHANGE", updRow.id)) === "APPROVED" && (await prisma.dependent.findUniqueOrThrow({ where: { id: spouse.id } })).name === "Smoke Spouse Renamed");
    const legacy = await prisma.dependent.create({ data: { employeeId: meeraEmp.id, name: "Smoke Parent", relationship: "PARENT" } });
    await signInAs("priya.sharma@acme.test");
    check("HR verifies a dependent already on file with the document", (await ben.verifyDependentAction({}, multi({ dependentId: legacy.id, proof: pdf("id.pdf") }))).ok && !!(await prisma.dependent.findUniqueOrThrow({ where: { id: legacy.id } })).verifiedAt);

    section("Enrolment, waiver and completion");
    await signInAs("meera.krishnan@acme.test");
    const tooOld = await ben.enrollBenefitAction({}, multi({ planId: hPlan.id, tier: "FAMILY", dependentIds: [spouse.id, elder.id] }));
    check("A child over the age limit cannot be covered", tooOld.ok === false && /covered up to 25/.test(tooOld.message), tooOld.message);
    const parent = await ben.enrollBenefitAction({}, multi({ planId: hPlan.id, tier: "FAMILY", dependentIds: [spouse.id, legacy.id] }));
    check("…nor a relation the plan excludes", parent.ok === false && /parent is not covered/.test(parent.message), parent.message);
    const enrol = await ben.enrollBenefitAction({}, multi({ planId: hPlan.id, tier: "EMPLOYEE_SPOUSE", dependentIds: [spouse.id] }));
    const hEnr = await prisma.benefitEnrollment.findFirstOrThrow({ where: { employeeId: meeraEmp.id, planId: hPlan.id, status: { not: "WAIVED" } } });
    check("Employee + spouse cover is requested at the right cost", enrol.ok && Number(hEnr.employeeMonthly) === 360 && Number(hEnr.employerMonthly) === 1440, enrol.message);
    check("…and approved by benefits", (await settle("BENEFIT_ENROLLMENT", hEnr.id)) === "APPROVED" && (await prisma.benefitEnrollment.findUniqueOrThrow({ where: { id: hEnr.id } })).status === "ACTIVE");
    await signInAs("meera.krishnan@acme.test");
    const npsNo = await ben.enrollBenefitAction({}, fd({ planId: nps.id }));
    check("Retirement needs a contribution", npsNo.ok === false);
    const npsOk = await ben.enrollBenefitAction({}, fd({ planId: nps.id, contributionPct: 8 }));
    const nEnr = await prisma.benefitEnrollment.findFirstOrThrow({ where: { employeeId: meeraEmp.id, planId: nps.id } });
    check("…with it the company matches up to 5% of basic", npsOk.ok && Number(nEnr.employerMonthly) > 0 && Number(nEnr.employerMonthly) < Number(nEnr.employeeMonthly), `${nEnr.employeeMonthly}/${nEnr.employerMonthly}`);
    await settle("BENEFIT_ENROLLMENT", nEnr.id);
    await signInAs("aditya.verma@acme.test");
    check("A colleague waives cover", (await ben.enrollBenefitAction({}, fd({ planId: hPlan.id, intent: "waive" }))).ok);
    const done = await svc.windowCompletion(t, window.id);
    check("The completion dashboard counts the decided", !!done && done.enrolled >= 1 && done.waived >= 1 && done.pending < done.eligible);
    await signInAs("priya.sharma@acme.test");
    check("…and reminds the rest", (await ben.windowOpAction({}, fd({ id: window.id, op: "remind" }))).ok);
    await signInAs("meera.krishnan@acme.test");
    const myBen = await html((await page("finances/benefits/page"))());
    check("The employee sees open plans, her cover and dependents", myBen.includes(`${TAG} Health`) && myBen.includes("Smoke Spouse Renamed") && myBen.includes("you pay"));

    section("Life events");
    const le = await ben.lifeEventAction({}, multi({ kind: "BIRTH", eventDate: plus(-5), notes: "Twins", proof: pdf("birth2.pdf") }));
    const leRow = await prisma.benefitLifeEvent.findFirstOrThrow({ where: { employeeId: meeraEmp.id, createdAt: { gte: started } } });
    check("A birth is reported", le.ok && leRow.status === "PENDING", le.message);
    check("…approved, it opens her own 30-day window", (await settle("LIFE_EVENT", leRow.id)) === "APPROVED" && (await prisma.benefitEnrollmentWindow.count({ where: { tenantId: t, employeeId: meeraEmp.id, kind: "LIFE_EVENT" } })) === 1);

    section("Payroll deductions, arrears and insurer files");
    await prisma.benefitEnrollment.update({ where: { id: hEnr.id }, data: { coverageStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1)) } });
    await signInAs("priya.sharma@acme.test");
    const now = new Date();
    const push = await ben.pushBenefitDeductionsAction({}, fd({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }));
    check("Premiums go to payroll with two months of arrears", push.ok && (await prisma.adhocTransaction.count({ where: { sourceType: "BenefitEnrollment", sourceId: hEnr.id } })) === 1 && (await prisma.benefitDeduction.count({ where: { enrollmentId: hEnr.id, kind: "ARREARS" } })) === 2, push.message);
    await ben.pushBenefitDeductionsAction({}, fd({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }));
    check("…and not twice", (await prisma.benefitDeduction.count({ where: { enrollmentId: hEnr.id } })) === 3);
    const census = await csvGet(await route("payroll/benefits/census/route"), `/payroll/benefits/census?planId=${hPlan.id}`);
    check("The insurer census lists the member and her spouse", census.status === 200 && census.body.includes(meeraEmp.employeeNumber) && census.body.includes("Smoke Spouse Renamed"));
    const carrierCsv = `Member ID,Name,Tier,Premium\n${meeraEmp.employeeNumber},Meera,EMPLOYEE_SPOUSE,1700\nZZ999,Ghost,EMPLOYEE,1000\n`;
    const rec = await ben.reconcileCarrierAction({}, multi({ planId: hPlan.id, file: new File([carrierCsv], "insurer.csv", { type: "text/csv" }) }));
    check("Reconciling the insurer's file finds the mismatch and the extra member", rec.ok && /1 extra at the insurer, 1 premium\/tier mismatch/.test(rec.message), rec.message);
    check("The enrolment page shows coverage and the reconciliation", (await html((await page("payroll/benefits/enrolment/page"))({ searchParams: sp({ plan: hPlan.id }) }))).includes("ZZ999"));

    section("Renewal, coverage end and reports");
    const renew = await ben.benefitPlanOpAction({}, fd({ id: hPlan.id, op: "renew", premiumChangePct: 10, planYearStart: plus(166), planYearEnd: plus(530) }));
    const renewal = await prisma.benefitPlan.findFirstOrThrow({ where: { tenantId: t, previousPlanId: hPlan.id } });
    check("Next year's plan is drafted 10% dearer", renew.ok && Number(renewal.monthlyPremium) === 1100, renew.message);
    await ben.benefitPlanOpAction({}, fd({ id: renewal.id, op: "submit" }));
    await settle("BENEFIT_PLAN", renewal.id);
    const moved = await prisma.benefitEnrollment.findUniqueOrThrow({ where: { id: hEnr.id } });
    check("Approved, members move onto it at the new premium", moved.planId === renewal.id && Number(moved.employeeMonthly) === 396 && (await prisma.benefitPlan.findUniqueOrThrow({ where: { id: hPlan.id } })).status === "RETIRED");
    await signInAs("priya.sharma@acme.test");
    check("Cover is ended by the administrator", (await ben.endCoverageAction({}, fd({ enrollmentId: nEnr.id, endOn: iso(new Date()), reason: "Opted out mid-year" }))).ok && (await prisma.benefitEnrollment.findUniqueOrThrow({ where: { id: nEnr.id } })).status === "ENDED");
    check("Coverage-end processing runs", (await ben.runCoverageEndAction({}, fd({}))).ok);
    const benRoute = await route("payroll/benefits/reports/export/route");
    for (const r of ["enrollments", "plans", "dependents", "deductions", "eligibility"]) check(`The ${r} report downloads`, (await csvGet(benRoute, `/payroll/benefits/reports/export?report=${r}`)).status === 200);
    check("The enrolment report has her cover", (await csvGet(benRoute, "/payroll/benefits/reports/export?report=enrollments")).body.includes(meeraEmp.employeeNumber));
    const benReports = await html((await page("payroll/benefits/reports/page"))({ searchParams: sp({ inflation: "12" }) }));
    check("Reports show the cost forecast and the audit trail", benReports.includes("Cost forecast") && benReports.includes("Audit trail"));
    check("Plans and enrolments are audited", (await audits("BenefitPlan")) >= 4 && (await audits("BenefitEnrollment")) >= 2 && (await audits("Dependent")) >= 1);
    await signInAs("meera.krishnan@acme.test");
    check("Employees cannot export benefit reports", (await csvGet(benRoute, "/payroll/benefits/reports/export?report=plans")).status === 403);

    // =======================================================================
    section("Compensation planning: template, plan, worksheet");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a compensation plan", await denied(() => comp.createCompPlanAction({}, fd({ name: "x" }))));
    await signInAs("priya.sharma@acme.test");
    const ct = await comp.saveCompTemplateAction({}, fd({ name: `${TAG} template`, meritMatrix: "1-2.99:3, 3-3.99:6, 4-5:10", defaultPct: 5, budgetPct: 8, maxPct: 15, reasonAbovePct: 10, maxPromotionPct: 12, minTenureDays: 90, excludeProbation: true, excludeNotice: true, prorate: true }));
    const template = await prisma.compPlanTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} template` } });
    check("HR saves a cycle template", ct.ok, ct.message);
    check("A bad matrix is refused", (await comp.saveCompTemplateAction({}, fd({ name: `${TAG} bad`, meritMatrix: "high:10", defaultPct: 1, budgetPct: 1 }))).ok === false);
    const cp = await comp.createCompPlanAction({}, fd({ name: `${TAG} plan`, templateId: template.id, periodStart: plus(-180), effectiveDate: plus(200) }));
    const cplan = await prisma.compPlan.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} plan` } });
    check("A plan starts from the template", cp.ok && Number(cplan.budgetPct) === 8, cp.message);
    const built = await svc.buildCompPlanItems(t, cplan.id, priya.id, { reportingManagerId: { in: [ananya.employee!.id, sneha.employee!.id] } });
    const items = await prisma.compPlanItem.findMany({ where: { planId: cplan.id }, include: { employee: { select: { employeeNumber: true, status: true } } } });
    check("The worksheet brings in two teams", built.ok && items.length >= 6, built.message);
    check("Probation and notice are not eligible", items.filter((i) => ["PROBATION", "NOTICE_PERIOD"].includes(i.employee.status)).every((i) => !i.eligible && !!i.ineligibleReason));
    const pools = await svc.compPoolStatus(t, cplan.id);
    const anPool = pools.find((p) => p.ownerEmployeeId === ananya.employee!.id)!, snPool = pools.find((p) => p.ownerEmployeeId === sneha.employee!.id)!;
    check("Each manager gets a pool", !!anPool && !!snPool && anPool.amount > 0);
    const mItem = items.find((i) => i.employeeId === meeraEmp.id)!;
    const aItem = items.find((i) => i.employeeId === aditya.employee!.id)!;
    await signInAs("ananya.ghosh@acme.test");
    check("The manager sees her worksheet", (await html((await page("team/compensation/page"))())).includes("Team compensation"));
    const mEdit = await comp.updateCompItemAction({}, fd({ itemId: mItem.id, meritPct: 7, note: "Strong year" }));
    check("…and proposes a merit increase", mEdit.ok && Number((await prisma.compPlanItem.findUniqueOrThrow({ where: { id: mItem.id } })).meritPct) === 7, mEdit.message);
    await signInAs("aditya.verma@acme.test");
    check("Someone else's worksheet is off limits", (await comp.updateCompItemAction({}, fd({ itemId: mItem.id, meritPct: 50 }))).ok === false);

    section("Pools, promotion, market, guardrails and exceptions");
    await signInAs("priya.sharma@acme.test");
    await comp.poolAction({}, fd({ planId: cplan.id, poolId: anPool.poolId, op: "set", amount: 1000 }));
    await signInAs("ananya.ghosh@acme.test");
    const over = await comp.updateCompItemAction({}, fd({ itemId: aItem.id, meritPct: 9 }));
    check("A manager cannot go over her pool", over.ok === false && /over budget/.test(over.message), over.message);
    await signInAs("priya.sharma@acme.test");
    const xfer = await comp.poolAction({}, fd({ planId: cplan.id, op: "transfer", fromPoolId: snPool.poolId, toPoolId: anPool.poolId, amount: 230000, reason: "Ananya's team is under market" }));
    check("HR moves budget between pools", xfer.ok && (await prisma.compPoolTransfer.count({ where: { planId: cplan.id } })) === 1, xfer.message);
    await signInAs("ananya.ghosh@acme.test");
    check("…then the increase fits", (await comp.updateCompItemAction({}, fd({ itemId: aItem.id, meritPct: 9 }))).ok);
    await signInAs("priya.sharma@acme.test");
    const grade = await prisma.payGrade.findFirst({ where: { tenantId: t, isActive: true } });
    const promo = await comp.updateCompItemAction({}, fd({ itemId: aItem.id, meritPct: 3, promotionPct: 8, newPayGradeId: grade?.id, marketPct: 2, note: "Promoted to lead" }));
    const aAfter = await prisma.compPlanItem.findUniqueOrThrow({ where: { id: aItem.id } });
    check("Promotion and market increases are planned", promo.ok && Number(aAfter.totalPct) === Number((3 * Number(aAfter.prorationFactor) + 8 + 2).toFixed(2)), `${promo.message} ${aAfter.totalPct}`);
    const breach = await comp.updateCompItemAction({}, fd({ itemId: mItem.id, meritPct: 18, note: "Retention risk" }));
    check("A line over the ceiling is flagged", breach.ok && /guardrails/.test(breach.message), breach.message);
    check("…and blocks submission", (await comp.compPlanOpAction({}, fd({ planId: cplan.id, op: "submit" }))).ok === false);
    const exq = await comp.compItemOpAction({}, fd({ itemId: mItem.id, op: "exception", reason: "Counter-offer from a competitor" }));
    check("An exception is requested", exq.ok && (await prisma.compPlanItem.findUniqueOrThrow({ where: { id: mItem.id } })).exceptionStatus === "PENDING", exq.message);
    check("…and approved", (await settle("COMP_EXCEPTION", mItem.id)) === "APPROVED" && (await prisma.compPlanItem.findUniqueOrThrow({ where: { id: mItem.id } })).exceptionStatus === "APPROVED");
    await signInAs("priya.sharma@acme.test");
    const skipTarget = items.find((i) => i.eligible && ![mItem.id, aItem.id].includes(i.id))!;
    check("An employee is left out of the round", (await comp.compItemOpAction({}, fd({ itemId: skipTarget.id, op: "skip", reason: "Moved to a new plan" }))).ok);

    section("Calibration, approval, apply and statements");
    check("Calibration starts", (await comp.compPlanOpAction({}, fd({ planId: cplan.id, op: "calibrate" }))).ok && (await prisma.compPlan.findUniqueOrThrow({ where: { id: cplan.id } })).status === "CALIBRATION");
    await signInAs("ananya.ghosh@acme.test");
    check("Managers can no longer edit", (await comp.updateCompItemAction({}, fd({ itemId: aItem.id, meritPct: 5 }))).ok === false);
    await signInAs("priya.sharma@acme.test");
    await comp.calibrationSessionAction({}, fd({ planId: cplan.id, name: `${TAG} session`, scheduledAt: iso(new Date()) }));
    const sess = await prisma.compCalibrationSession.findFirstOrThrow({ where: { planId: cplan.id } });
    const cal = await comp.updateCompItemAction({}, fd({ itemId: aItem.id, meritPct: 2, promotionPct: 8, newPayGradeId: grade?.id, marketPct: 2, note: "Calibrated down", sessionId: sess.id }));
    check("A change in the session is logged against it", cal.ok && (await prisma.compDecisionLog.count({ where: { sessionId: sess.id } })) === 1, cal.message);
    check("The session closes", (await comp.calibrationSessionAction({}, fd({ op: "close", sessionId: sess.id, notes: "Agreed" }))).ok);
    const submit = await comp.compPlanOpAction({}, fd({ planId: cplan.id, op: "submit" }));
    check("The plan goes for approval", submit.ok && (await prisma.compPlan.findUniqueOrThrow({ where: { id: cplan.id } })).status === "PENDING_APPROVAL", submit.message);
    check("…and is approved", (await settle("COMP_PLAN", cplan.id)) === "APPROVED" && (await prisma.compPlan.findUniqueOrThrow({ where: { id: cplan.id } })).status === "APPROVED");
    await signInAs("priya.sharma@acme.test");
    const apply = await comp.compPlanOpAction({}, fd({ planId: cplan.id, op: "apply" }));
    const mApplied = await prisma.compPlanItem.findUniqueOrThrow({ where: { id: mItem.id } });
    check("Applying creates the salary revisions", apply.ok && mApplied.status === "APPLIED" && !!mApplied.salaryRevisionId, apply.message);
    check("…moves the promoted to the new grade", !grade || (await prisma.employee.findUniqueOrThrow({ where: { id: aditya.employee!.id } })).payGradeId === grade.id);
    const stmts = await prisma.compStatement.findMany({ where: { planId: cplan.id } });
    check("Statements are ready to preview", stmts.length >= 2 && stmts.every((s) => !s.publishedAt));
    check("The plan page previews them", (await html((await page("payroll/compensation/[id]/page"))({ params: pr(cplan.id), searchParams: sp() }))).includes("Preview"));
    check("They are published", (await comp.compPlanOpAction({}, fd({ planId: cplan.id, op: "publish" }))).ok && (await prisma.compStatement.count({ where: { planId: cplan.id, publishedAt: null } })) === 0);
    await signInAs("meera.krishnan@acme.test");
    const mine = await prisma.compStatement.findFirstOrThrow({ where: { planId: cplan.id, employeeId: meeraEmp.id } });
    check("The employee reads her statement", (await html((await page("finances/compensation/page"))())).includes(`${TAG} plan`));
    check("…and acknowledges it", (await comp.acknowledgeStatementAction({}, fd({ statementId: mine.id }))).ok && !!(await prisma.compStatement.findUniqueOrThrow({ where: { id: mine.id } })).acknowledgedAt);
    await signInAs("priya.sharma@acme.test");
    const wsCsv = await csvGet(await route("payroll/compensation/[id]/export/route"), `/payroll/compensation/${cplan.id}/export`, { id: cplan.id });
    check("The worksheet exports", wsCsv.status === 200 && wsCsv.body.includes(meeraEmp.employeeNumber));
    const log = await prisma.compDecisionLog.findMany({ where: { planId: cplan.id } });
    check("The decision log has every step", ["PLAN_CREATED", "LINE_EDITED", "CALIBRATED", "EXCEPTION_REQUESTED", "APPLIED"].every((a) => log.some((l) => l.action === a)), [...new Set(log.map((l) => l.action))].join(","));
    check("…and the audit history the plan's actions", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "CompPlan", entityId: cplan.id } })) >= 4);

    section("Pay ranges, compa-ratio, location, equity, allowances");
    if (meeraEmp.locationId) check("A location differential is set", (await comp.locationDifferentialAction({}, fd({ locationId: meeraEmp.locationId, pct: 10 }))).ok);
    const rows = await svc.compaRatioRows(t);
    check("Compa-ratio and penetration are worked out", rows.length > 0 && rows.some((r) => r.compa !== null));
    if (grade) {
      const pr1 = await comp.proposePayRangeAction({}, fd({ payGradeId: grade.id, minAnnual: 500000, midAnnual: 750000, maxAnnual: 1000000, reason: `${TAG} market survey` }));
      const rc = await prisma.payRangeChange.findFirstOrThrow({ where: { tenantId: t, reason: `${TAG} market survey` } });
      check("A new pay range goes for approval", pr1.ok && rc.status === "PENDING", pr1.message);
      check("…and applies to the grade", (await settle("PAY_RANGE", rc.id)) === "APPROVED" && Number((await prisma.payGrade.findUniqueOrThrow({ where: { id: grade.id } })).midAnnual) === 750000);
    }
    await signInAs("priya.sharma@acme.test");
    check("The ranges page shows compa-ratios", (await html((await page("payroll/compensation/ranges/page"))({ searchParams: sp() }))).includes("Compa-ratio"));
    const cr = await csvGet(await route("payroll/compensation/ranges/export/route"), "/payroll/compensation/ranges/export");
    check("…and exports them", cr.status === 200 && cr.body.includes("Compa-ratio"));
    if (meeraEmp.departmentId) {
      const coh = await comp.payEquityCohortAction({}, fd({ name: `${TAG} cohort`, departmentId: meeraEmp.departmentId, thresholdPct: 5 }));
      const analysis = await svc.payEquityAnalysis(t);
      check("A pay equity cohort is analysed", coh.ok && analysis.some((a) => a.cohort.name === `${TAG} cohort` && a.size > 0), coh.message);
      check("The equity page shows the gap", (await html((await page("payroll/compensation/equity/page"))({ searchParams: sp() }))).includes(`${TAG} cohort`));
    }
    const comp1 = await prisma.salaryComponent.findFirst({ where: { tenantId: t, type: "EARNING", isActive: true, NOT: { code: { in: ["BASIC", "BASIC_PAY"] } } } });
    if (comp1) {
      const al = await comp.allowanceChangeAction({}, fd({ employeeId: meeraEmp.id, componentId: comp1.id, newMonthly: 4321, effectiveFrom: plus(40), reason: `${TAG} new role allowance` }));
      const ar = await prisma.allowanceChangeRequest.findFirstOrThrow({ where: { tenantId: t, reason: `${TAG} new role allowance` } });
      check("An allowance change is requested", al.ok && ar.status === "PENDING", al.message);
      check("…approved by the manager and compensation, it becomes an override", (await settle("ALLOWANCE_CHANGE", ar.id)) === "APPROVED" && !!(await prisma.allowanceChangeRequest.findUniqueOrThrow({ where: { id: ar.id } })).overrideId);
    }
    await signInAs("meera.krishnan@acme.test");
    check("Employees cannot see pay ranges", await denied(() => html((async () => (await page("payroll/compensation/ranges/page"))({ searchParams: sp() }))())));
  } catch (err) {
    check("suite ran without throwing", false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await cleanup(started);
    await prisma.$disconnect();
  }
  report("smoke-money-depth");
}

main();
