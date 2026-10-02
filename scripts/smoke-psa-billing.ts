/**
 * PSA billing, pipeline and timesheet policy: billing-entity numbering, rate
 * cards (reference and per client), a retainer and an approved expense
 * charged to a project, an invoice drafted from those charges, then sent,
 * credited, part paid and written off; a cancelled invoice freeing its
 * charge; a proforma converted to a tax invoice; the sales pipeline from an
 * opportunity through a resource estimate to a won deal converted into a
 * project; and a timesheet policy that rounds, approves in two levels and
 * chases an unsubmitted week. Every screen renders for an admin and is
 * refused to an employee. Fixtures are named "Smoke …" and removed, along
 * with the ledger entries they posted.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** A form with several values under one name (checkboxes). */
const fdMany = (values: Record<string, string>, name: string, many: string[]) => { const f = fd(values); for (const v of many) f.append(name, v); return f; };

async function render(fn: () => Promise<unknown>): Promise<"ok" | "denied"> {
  try { await fn(); return "ok"; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return "denied";
    throw err;
  }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = async (p: Promise<unknown>) => renderToStaticMarkup((await p) as Parameters<typeof renderToStaticMarkup>[0]);
  const bill = await import("../apps/web/src/app/actions/psa-billing");
  const pipe = await import("../apps/web/src/app/actions/psa-pipeline");
  const pol = await import("../apps/web/src/app/actions/timesheet-policy");
  const proj = await import("../apps/web/src/app/actions/projects");
  const svc = await import("@keka/services");
  const psa = await import("../packages/services/src/psa");
  const page = async (path: string) => (await import(`../apps/web/src/app/(app)/projects/${path}/page`)).default as (props: unknown) => Promise<unknown>;
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

  const started = new Date();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const T = tenant.id;
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: T, name: "Acme Services" } });
  const hadEntitySetting = await prisma.billingEntitySetting.findUnique({ where: { legalEntityId: entity.id } });
  const hadPsaSetting = await prisma.psaSetting.findUnique({ where: { tenantId: T } });
  const policyBefore = await svc.getTimesheetPolicy(T);
  const emp = async (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: T, employeeNumber: n }, select: { id: true, userId: true } });
  const pooja = await emp("ACM0016"), sneha = await emp("ACM0005");
  const monthStart = new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth() - 2, 1));

  const cleanup = async () => {
    const client = await prisma.client.findFirst({ where: { tenantId: T, name: "Smoke Billing Client" } });
    const invoices = client ? await prisma.invoice.findMany({ where: { clientId: client.id }, select: { id: true, payments: { select: { id: true } } } }) : [];
    const notes = client ? await prisma.creditNote.findMany({ where: { clientId: client.id }, select: { id: true } }) : [];
    const refs = [...invoices.flatMap((i) => [i.id, ...i.payments.map((p) => p.id)]), ...notes.map((n) => n.id)];
    const entries = refs.length ? await prisma.ledgerEntry.findMany({ where: { tenantId: T, sourceRefId: { in: refs } }, select: { id: true } }) : [];
    await svc.purgeEntriesForTests(T, entries.map((e) => e.id));
    const opps = await prisma.opportunity.findMany({ where: { tenantId: T, name: { startsWith: "Smoke " } }, select: { id: true } });
    const projects = await prisma.project.findMany({ where: { tenantId: T, name: { startsWith: "Smoke " } }, select: { id: true } });
    await prisma.resourceRequest.deleteMany({ where: { projectId: { in: projects.map((p) => p.id) } } });
    await prisma.projectRequest.deleteMany({ where: { tenantId: T, OR: [{ opportunityId: { in: opps.map((o) => o.id) } }, { name: { startsWith: "Smoke " } }] } });
    await prisma.timesheet.deleteMany({ where: { tenantId: T, entries: { some: { projectId: { in: projects.map((p) => p.id) } } } } });
    await prisma.expenseClaim.deleteMany({ where: { tenantId: T, claimNumber: "SMOKE-EXP-1" } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoices.map((i) => i.id) } } });
    await prisma.project.deleteMany({ where: { id: { in: projects.map((p) => p.id) } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opps.map((o) => o.id) } } });
    await prisma.rateCard.deleteMany({ where: { tenantId: T, name: { startsWith: "Smoke " } } });
    if (client) await prisma.client.deleteMany({ where: { id: client.id } });
    await prisma.billingRole.deleteMany({ where: { tenantId: T, name: "Smoke Billing Role" } });
    await prisma.timesheetReminder.deleteMany({ where: { tenantId: T, employeeId: pooja.id, periodStart: { in: [new Date("2025-01-06T00:00:00Z"), new Date("2025-01-13T00:00:00Z")] } } });
    await prisma.notification.deleteMany({ where: { tenantId: T, createdAt: { gte: started }, OR: [{ title: { contains: "Smoke " } }, { title: { contains: "week of 2025-01-06" } }, { title: { contains: "week of 2025-01-13" } }] } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: T, createdAt: { gte: started }, subject: { contains: "week of 2025-01-06" } } });
    if (hadEntitySetting) {
      const { id: _i, updatedAt: _u, tenantId: _t, legalEntityId: _l, ...rest } = hadEntitySetting;
      await prisma.billingEntitySetting.update({ where: { legalEntityId: entity.id }, data: rest });
    } else await prisma.billingEntitySetting.deleteMany({ where: { legalEntityId: entity.id } });
    if (hadPsaSetting) await svc.saveTimesheetPolicy(T, policyBefore); else await prisma.psaSetting.deleteMany({ where: { tenantId: T } });
  };
  await cleanup();

  try {
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot cancel an invoice", await render(() => bill.invoiceOpAction({}, fd({ op: "cancel", invoiceId: "x", reason: "x" }))) === "denied");
    check("…or save a rate card", await render(() => bill.rateCardAction({}, fd({ name: "Smoke Card" }))) === "denied");
    check("…or add an opportunity", await render(() => pipe.saveOpportunityAction({}, fd({ name: "Smoke Opp" }))) === "denied");
    check("…or change the timesheet policy", await render(() => pol.saveTimesheetPolicyAction({}, fd({}))) === "denied");
    for (const p of ["billing", "billing/charges", "billing/credit-notes", "billing/payments", "settings/rate-cards", "settings/billing-entities", "settings/timesheets", "pipeline", "pipeline/requests"]) {
      check(`…or open ${p}`, await render(async () => (await page(p))({ searchParams: sp() })) === "denied");
    }

    section("Set-up: billing entity, rate cards");
    await signInAs("vikram.menon@acme.test");
    const ent = await bill.billingEntityAction({}, fd({ legalEntityId: entity.id, invoicePrefix: "SMK-", nextInvoiceNumber: 900, proformaPrefix: "SMKP-", nextProformaNumber: 40, creditNotePrefix: "SMKC-", nextCreditNoteNumber: 7, defaultPaymentTermDays: 15 }));
    check("A billing entity is set up for project billing", ent.ok === true, ent.message);
    const client = await prisma.client.create({ data: { tenantId: T, name: "Smoke Billing Client", countryCode: "IN", state: "Karnataka", contactEmail: "ap@smoke-client.test" } });
    await prisma.billingRole.create({ data: { tenantId: T, name: "Smoke Billing Role" } });
    const card = await bill.rateCardAction({}, fd({ name: "Smoke Card", currency: "INR", rateUnit: "HOURLY" }));
    check("An organisation rate card is added", card.ok === true, card.message);
    check("…and a duplicate name is refused", (await bill.rateCardAction({}, fd({ name: "Smoke Card" }))).ok === false);
    const cardRow = await prisma.rateCard.findFirstOrThrow({ where: { tenantId: T, name: "Smoke Card" } });
    const rate = await bill.roleRateAction({}, fd({ rateCardId: cardRow.id, billingRole: "Smoke Billing Role", billRate: 2000, suggestedCost: 1200 }));
    check("A role rate is added with its markup", rate.ok === true && /markup 66.67%/.test(rate.message ?? ""), rate.message);
    const clientCard = await bill.rateCardAction({}, fd({ name: "Smoke Client Card", currency: "INR", rateUnit: "HOURLY", clientId: client.id }));
    check("A client rate card is added", clientCard.ok === true && !!(await prisma.rateCard.findFirst({ where: { name: "Smoke Client Card", clientId: client.id } })), clientCard.message);

    section("Retainer and project expenses");
    const project = await prisma.project.create({ data: { tenantId: T, name: "Smoke Retainer Project", clientId: client.id, billingModel: "TIME_AND_MATERIAL", status: "ACTIVE", startDate: monthStart } });
    const ret = await bill.retainerAction({}, fd({ projectId: project.id, fee: 10000, from: iso(monthStart) }));
    check("A retainer is set up from two months back", ret.ok === true && /3 period/.test(ret.message ?? ""), ret.message);
    const sched = await psa.retainerSchedule(T, project.id);
    check("…its schedule shows three periods ready to bill", sched.filter((r) => r.state === "UNBILLED").length === 3, JSON.stringify(sched.map((r) => r.state)));
    const claim = await prisma.expenseClaim.create({ data: { tenantId: T, employeeId: pooja.id, claimNumber: "SMOKE-EXP-1", title: "Smoke client travel", stage: "APPROVED", claimedTotal: 4200, approvedTotal: 4200, submittedAt: new Date() } });
    const charged = await bill.expenseChargeAction({}, fd({ op: "charge", claimId: claim.id, projectId: project.id }));
    check("An approved expense claim is charged to the project", charged.ok === true, charged.message);
    const expCharge = (await prisma.projectCharge.findMany({ where: { projectId: project.id, kind: "EXPENSE" } }))[0];
    check("…as an unbilled expense charge", !!expCharge && Number(expCharge.amount) === 4200 && expCharge.status === "UNBILLED");
    check("The project billing page renders", (await html((await page("[id]/billing"))({ params: Promise.resolve({ id: project.id }) }))).includes("SMOKE-EXP-1"));

    section("Invoice from charges: send, credit, pay, write off");
    const charges = await prisma.projectCharge.findMany({ where: { projectId: project.id, status: "UNBILLED" } });
    const draft = await bill.chargeAction({}, fdMany({ op: "draft", invoiceDate: iso(new Date()), billingEntityId: entity.id, poNumber: "PO-77" }, "chargeId", charges.map((c) => c.id)));
    const inv = await prisma.invoice.findFirstOrThrow({ where: { clientId: client.id, kind: "TAX" }, include: { lines: true } });
    check("A draft invoice is raised from the charges, numbered by the entity", draft.ok === true && inv.invoiceNumber === "SMK-900", `${draft.message} ${inv.invoiceNumber}`);
    check("…for the retainers and the expense, with GST", Number(inv.subtotal) === 34200 && Number(inv.total) === 40356 && inv.lines.length === 4, `${inv.subtotal} ${inv.total}`);
    check("…on the entity's payment term", inv.paymentTermDays === 15);
    check("The invoice view renders", (await html((await page("billing/[id]"))({ params: Promise.resolve({ id: inv.id }) }))).includes("SMK-900"));
    const sent = await bill.invoiceOpAction({}, fd({ op: "markSent", invoiceId: inv.id }));
    check("Marking it sent posts the receivable", sent.ok === true && (await prisma.ledgerEntry.count({ where: { tenantId: T, sourceRefType: "Invoice", sourceRefId: inv.id } })) === 1, sent.message);
    const cn = await bill.creditNoteAction({}, fd({ op: "raise", clientId: client.id, invoiceId: inv.id, amount: 1000, taxAmount: 180, reason: "Smoke goodwill credit", issueDate: iso(new Date()), applyNow: "on" }));
    const afterCn = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    check("A credit note raised from the invoice is applied at once", cn.ok === true && /applied/.test(cn.message ?? "") && Number(afterCn.amountDue) === 39176 && afterCn.status === "PARTIALLY_PAID", `${cn.message} ${afterCn.amountDue}`);
    check("…numbered by the entity", !!(await prisma.creditNote.findFirst({ where: { clientId: client.id, number: "SMKC-7" } })));
    const pay = await proj.invoiceAction({}, fd({ op: "payment", invoiceId: inv.id, amount: 20000, reference: "Smoke UTR 1" }));
    check("A part payment leaves the credited balance due", pay.ok === true && Number((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).amountDue) === 19176, pay.message);
    check("Cancelling a part-paid invoice is refused", (await bill.invoiceOpAction({}, fd({ op: "cancel", invoiceId: inv.id, reason: "x" }))).ok === false);
    check("A write off needs a reason", (await bill.invoiceOpAction({}, fd({ op: "writeOff", invoiceId: inv.id, reason: "" }))).ok === false);
    const wo = await bill.invoiceOpAction({}, fd({ op: "writeOff", invoiceId: inv.id, reason: "Smoke client insolvent", date: iso(new Date()) }));
    const afterWo = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    check("Writing off the rest closes the invoice to bad debts", wo.ok === true && afterWo.status === "WRITTEN_OFF" && Number(afterWo.writeOffAmount) === 19176 && Number(afterWo.amountDue) === 0, wo.message);
    check("…posting against the receivable", (await prisma.ledgerEntry.count({ where: { tenantId: T, sourceRefType: "InvoiceWriteOff", sourceRefId: inv.id } })) === 1);

    section("Cancel and proforma");
    const adhoc = await bill.chargeAction({}, fd({ op: "adhoc", projectId: project.id, name: "Smoke licence pass-through", amount: 5000, date: iso(new Date()) }));
    check("An ad hoc charge is added", adhoc.ok === true, adhoc.message);
    const adhocRow = await prisma.projectCharge.findFirstOrThrow({ where: { projectId: project.id, kind: "ADHOC" } });
    await bill.chargeAction({}, fd({ op: "draft", invoiceDate: iso(new Date()), chargeId: adhocRow.id }));
    const inv2 = await prisma.invoice.findFirstOrThrow({ where: { clientId: client.id, kind: "TAX", NOT: { id: inv.id } } });
    check("Cancelling needs a reason", (await bill.invoiceOpAction({}, fd({ op: "cancel", invoiceId: inv2.id, reason: "" }))).ok === false);
    const cancel = await bill.invoiceOpAction({}, fd({ op: "cancel", invoiceId: inv2.id, reason: "Smoke wrong PO" }));
    check("An unpaid invoice is cancelled and its charge is billable again", cancel.ok === true && (await prisma.invoice.findUniqueOrThrow({ where: { id: inv2.id } })).status === "CANCELLED" && (await prisma.projectCharge.findUniqueOrThrow({ where: { id: adhocRow.id } })).status === "UNBILLED", cancel.message);
    await bill.chargeAction({}, fd({ op: "draft", invoiceDate: iso(new Date()), billingEntityId: entity.id, chargeId: adhocRow.id, proforma: "on" }));
    const pf = await prisma.invoice.findFirstOrThrow({ where: { clientId: client.id, kind: "PROFORMA" } });
    check("A proforma is raised with the entity's proforma number and nothing due", pf.invoiceNumber === "SMKP-40" && Number(pf.amountDue) === 0, pf.invoiceNumber);
    const conv = await bill.invoiceOpAction({}, fd({ op: "convert", invoiceId: pf.id }));
    const taxFromPf = await prisma.invoice.findFirst({ where: { convertedFromId: pf.id } });
    check("Converting it raises the tax invoice for the same charge", conv.ok === true && !!taxFromPf && /^SMK-\d+$/.test(taxFromPf.invoiceNumber) && (await prisma.projectCharge.findUniqueOrThrow({ where: { id: adhocRow.id } })).status === "INVOICED", conv.message);
    check("…and it cannot be converted twice", (await bill.invoiceOpAction({}, fd({ op: "convert", invoiceId: pf.id }))).ok === false);
    const loose = await bill.creditNoteAction({}, fd({ op: "raise", clientId: client.id, amount: 500, reason: "Smoke open credit", issueDate: iso(new Date()) }));
    const looseRow = await prisma.creditNote.findFirstOrThrow({ where: { clientId: client.id, status: "OPEN" } });
    const voided = await bill.creditNoteAction({}, fd({ op: "void", creditNoteId: looseRow.id }));
    check("An open credit note can be voided", loose.ok === true && voided.ok === true && (await prisma.creditNote.findUniqueOrThrow({ where: { id: looseRow.id } })).status === "VOID", voided.message);

    section("Billing screens");
    check("The invoice list renders with the written-off invoice", (await html((await page("billing"))({ searchParams: sp({ client: client.id }) }))).includes("SMK-900"));
    check("Charges render", (await render(async () => html((await page("billing/charges"))({ searchParams: sp() })))) === "ok");
    check("Credit notes render", (await html((await page("billing/credit-notes"))({ searchParams: sp() }))).includes("SMKC-7"));
    check("Payments list the receipt", (await html((await page("billing/payments"))({ searchParams: sp({ client: client.id }) }))).includes("Smoke UTR 1"));
    check("Rate cards render", (await html((await page("settings/rate-cards"))({ searchParams: sp({ card: cardRow.id }) }))).includes("Smoke Card"));
    check("Billing entities render", (await html((await page("settings/billing-entities"))({}))).includes("SMK-"));

    section("Sales pipeline");
    check("The pipeline board renders and seeds the default stages", (await html((await page("pipeline"))({ searchParams: sp() }))).includes("Closed Won"));
    const stages = await prisma.opportunityStage.findMany({ where: { tenantId: T }, orderBy: { sequence: "asc" } });
    const first = stages.find((s) => s.kind === "OPEN")!, wonStage = stages.find((s) => s.kind === "WON")!, lostStage = stages.find((s) => s.kind === "LOST")!;
    const adminEmp = await prisma.employee.findFirstOrThrow({ where: { tenantId: T, user: { email: "vikram.menon@acme.test" } }, select: { id: true } });
    const opp = await pipe.saveOpportunityAction({}, fd({ name: "Smoke Opp", clientId: client.id, stageId: first.id, ownerId: adminEmp.id, billingModel: "TIME_AND_MATERIAL", estimatedRevenue: 500000, startDate: iso(new Date()), closeDate: iso(new Date(Date.now() + 30 * DAY)), expectedProjectStart: iso(new Date(Date.now() + 40 * DAY)) }));
    const oppRow = await prisma.opportunity.findFirstOrThrow({ where: { tenantId: T, name: "Smoke Opp" } });
    check("An opportunity is added to the pipeline", opp.ok === true && oppRow.status === "OPEN" && oppRow.winProbability === first.winProbability, opp.message);
    check("Losing it needs a reason", (await pipe.moveStageAction({}, fd({ id: oppRow.id, stageId: lostStage.id }))).ok === false);
    const est = await pipe.estimateAction({}, fd({ op: "create", opportunityId: oppRow.id, name: "Smoke estimate", type: "RESOURCE" }));
    const estRow = await prisma.opportunityEstimate.findFirstOrThrow({ where: { opportunityId: oppRow.id } });
    const role = await prisma.billingRole.findFirstOrThrow({ where: { tenantId: T, name: "Smoke Billing Role" } });
    const line = (extra: Record<string, string>) => pipe.estimateAction({}, fd({ op: "line", estimateId: estRow.id, kind: "ROLE", billingRoleId: role.id, headcount: 1, allocationPercent: 100, startDate: "2031-01-06", endDate: "2031-01-17", ...extra }));
    check("A resource estimate is created", est.ok === true, est.message);
    check("…and needs a rate card before resources", (await line({})).ok === false);
    await pipe.estimateAction({}, fd({ op: "header", estimateId: estRow.id, name: "Smoke estimate", rateCardId: cardRow.id }));
    const added = await line({});
    const estAfter = await prisma.opportunityEstimate.findUniqueOrThrow({ where: { id: estRow.id } });
    check("A role line prices ten working days from the card", added.ok === true && Number(estAfter.hours) === 80 && Number(estAfter.billingAmount) === 160000 && Number(estAfter.cost) === 96000, `${added.message} ${estAfter.hours} ${estAfter.billingAmount} ${estAfter.cost}`);
    const pub = await pipe.estimateAction({}, fd({ op: "publish", estimateId: estRow.id }));
    check("The estimate is published", pub.ok === true && (await prisma.opportunityEstimate.findUniqueOrThrow({ where: { id: estRow.id } })).status === "PUBLISHED", pub.message);
    const won = await pipe.moveStageAction({}, fd({ id: oppRow.id, stageId: wonStage.id }));
    check("Moving it to Closed Won marks it won", won.ok === true && (await prisma.opportunity.findUniqueOrThrow({ where: { id: oppRow.id } })).status === "WON", won.message);
    const convert = await pipe.opportunityOpAction({}, fd({ id: oppRow.id, op: "convert" }));
    const req = await prisma.projectRequest.findFirstOrThrow({ where: { opportunityId: oppRow.id } });
    check("Converting it opens a project request", convert.ok === true && req.status === "NEW", convert.message);
    check("…only once", (await pipe.opportunityOpAction({}, fd({ id: oppRow.id, op: "convert" }))).ok === false);
    check("The opportunity page renders with the project form", (await html((await page("pipeline/[id]"))({ params: Promise.resolve({ id: oppRow.id }), searchParams: sp() }))).includes("Create project"));
    const raised = await pipe.projectRequestAction({}, fd({ op: "raise", requestId: req.id, name: "Smoke Won Project", clientId: client.id, billingModel: "TIME_AND_MATERIAL", startDate: "2031-01-06", rateCardId: cardRow.id, approveNow: "on" }));
    const wonProject = await prisma.project.findFirst({ where: { tenantId: T, name: "Smoke Won Project" } });
    check("A project admin raises and approves it in one step", raised.ok === true && !!wonProject && wonProject.opportunityId === oppRow.id && wonProject.rateCardId === cardRow.id, raised.message);
    check("…and the estimate's role becomes a resource request", !!wonProject && (await prisma.resourceRequest.count({ where: { projectId: wonProject.id, billingRoleId: role.id } })) === 1);
    check("The requests page lists it as approved", (await html((await page("pipeline/requests"))({}))).includes("Smoke Won Project"));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot approve project requests", await render(() => pipe.projectRequestAction({}, fd({ op: "approve", id: req.id }))) === "denied");

    section("Timesheet policy");
    await signInAs("vikram.menon@acme.test");
    check("The policy page renders with the defaults", (await html((await page("settings/timesheets"))({}))).includes("quarter hours"));
    const bad = await pol.saveTimesheetPolicyAction({}, fd({ maxHoursPerDay: 10, minHoursPerDay: 12, incrementMinutes: 15, flagWeeklyHoursAbove: 50, reminderAfterDays: 1, escalateAfterDays: 3 }));
    check("A floor above the cap is refused", bad.ok === false, bad.message);
    const saved = await pol.saveTimesheetPolicyAction({}, fd({ maxHoursPerDay: 12, incrementMinutes: 30, rounding: "NEAREST", approvalChain: "LINE_THEN_PROJECT", flagWeeklyHoursAbove: 45, remindersEnabled: "on", reminderAfterDays: 1, escalationEnabled: "on", escalateAfterDays: 3 }));
    check("A two-level, rounding policy with reminders is saved", saved.ok === true, saved.message);
    const tsProject = await prisma.project.create({ data: { tenantId: T, name: "Smoke TS Project", billingModel: "NON_BILLABLE", status: "ACTIVE", projectManagerId: sneha.id } });
    await prisma.resourceAllocation.create({ data: { projectId: tsProject.id, employeeId: pooja.id, allocationPercent: 10, isBillable: false, startDate: new Date("2025-01-01T00:00:00Z"), endDate: new Date("2025-01-31T00:00:00Z") } });
    const week = new Date("2025-01-06T00:00:00Z");
    const r1 = await svc.runTimesheetReminders(T, new Date("2025-01-14T09:00:00Z"), { weeks: 1, employeeIds: [pooja.id] });
    const r1b = await svc.runTimesheetReminders(T, new Date("2025-01-14T09:00:00Z"), { weeks: 1, employeeIds: [pooja.id] });
    check("An unsubmitted week is reminded once, not yet escalated", r1.reminded === 1 && r1.escalated === 0 && r1b.reminded === 0, JSON.stringify([r1, r1b]));
    const r2 = await svc.runTimesheetReminders(T, new Date("2025-01-16T09:00:00Z"), { weeks: 1, employeeIds: [pooja.id] });
    check("…then escalated to the line manager", r2.reminded === 0 && r2.escalated === 1, JSON.stringify(r2));
    check("Over the daily cap is refused", (await svc.saveTimesheet({ employeeId: pooja.id, week, entries: [{ projectId: tsProject.id, date: week, hours: 13 }], submit: false })).ok === false);
    const ts = await svc.saveTimesheet({ employeeId: pooja.id, week, entries: [{ projectId: tsProject.id, date: week, hours: 7.4 }], submit: true });
    const sheet = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.timesheetId! } });
    check("Time is rounded to the half hour and waits on the line manager", ts.ok === true && Number(sheet.totalHours) === 7.5 && sheet.status === "SUBMITTED" && sheet.awaiting === "LINE_MANAGER", `${ts.message} ${sheet.awaiting}`);
    await prisma.timesheetReminder.deleteMany({ where: { employeeId: pooja.id, periodStart: week } });
    const r3 = await svc.runTimesheetReminders(T, new Date("2025-01-16T09:00:00Z"), { weeks: 1, employeeIds: [pooja.id] });
    check("A submitted week is not chased", r3.reminded === 0 && r3.escalated === 0, JSON.stringify(r3));
    await signInAs("sneha.reddy@acme.test");
    check("The project manager cannot approve the first level", (await proj.decideTimesheetAction({}, fd({ timesheetId: sheet.id, decision: "approve" }))).ok === false);
    await signInAs("rahul.kapoor@acme.test");
    const l1 = await proj.decideTimesheetAction({}, fd({ timesheetId: sheet.id, decision: "approve" }));
    const mid = await prisma.timesheet.findUniqueOrThrow({ where: { id: sheet.id } });
    check("The line manager approves the first level", l1.ok === true && mid.status === "SUBMITTED" && mid.awaiting === "PROJECT_MANAGER" && mid.approvalStep === 1, l1.message);
    check("…and cannot approve the second", (await proj.decideTimesheetAction({}, fd({ timesheetId: sheet.id, decision: "approve" }))).ok === false);
    await signInAs("sneha.reddy@acme.test");
    const l2 = await proj.decideTimesheetAction({}, fd({ timesheetId: sheet.id, decision: "approve" }));
    check("The project manager's approval completes it", l2.ok === true && (await prisma.timesheet.findUniqueOrThrow({ where: { id: sheet.id } })).status === "APPROVED", l2.message);
    await signInAs("vikram.menon@acme.test");
    await pol.saveTimesheetPolicyAction({}, fd({ maxHoursPerDay: 24, incrementMinutes: 15, rounding: "REJECT", approvalChain: "EITHER", autoApprove: "on", autoApproveMaxHours: 10, flagWeeklyHoursAbove: 50, reminderAfterDays: 1, escalateAfterDays: 3 }));
    const week2 = new Date("2025-01-13T00:00:00Z");
    const odd = await svc.saveTimesheet({ employeeId: pooja.id, week: week2, entries: [{ projectId: tsProject.id, date: week2, hours: 1.1 }], submit: false });
    check("Back on quarter hours, odd time is refused again", odd.ok === false && /quarter hours/.test(odd.message), odd.message);
    const auto = await svc.saveTimesheet({ employeeId: pooja.id, week: week2, entries: [{ projectId: tsProject.id, date: week2, hours: 6 }], submit: true });
    const autoRow = await prisma.timesheet.findUniqueOrThrow({ where: { id: auto.timesheetId! } });
    check("A week under the ceiling approves itself", auto.ok === true && autoRow.status === "APPROVED" && autoRow.autoApproved === true, auto.message);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  report("PSA billing, pipeline and timesheet policy");
}

main().catch((e) => { console.error(e); process.exit(1); });
