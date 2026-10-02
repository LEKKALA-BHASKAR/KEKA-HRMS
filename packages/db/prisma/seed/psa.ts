import type { PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES } from "../../../rbac/src/roles";

/**
 * PSA seed: the Project hub on top of the projects seed. Opportunity stages
 * and sources, prospects and a pipeline across every stage (with estimates,
 * comments and won deals at each step of the hand-off to delivery), billing
 * roles, rate cards, cost and capacity, resource requests (critical, named,
 * with hiring, allocated and rejected), soft allocations on a new project,
 * an archived project, charges, proforma invoices, credit notes and a
 * written-off and a cancelled invoice.
 *
 * Idempotent: it removes what it made before (and only that) and runs alone
 * against a seeded database. Documents in a terminal state (written off,
 * cancelled) are stored as history without ledger postings, so the books
 * and the open receivables still agree.
 */

const DAY = 86_400_000;
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const SEEDED_PROJECTS = ["Saffron Stays Booking Engine", "Legacy HRMS Migration"];
const SEEDED_INVOICES = ["INV-2026-0004", "INV-2026-0005"];
const RATE_CARDS = ["Standard INR", "Northwind rate card", "USD Rate Card"];

export async function seedPsa(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber?: Map<string, string> }) {
  const svc = await import("@keka/services");
  const t = ctx.tenantId;
  const emps = ctx.empIdByNumber ?? new Map((await prisma.employee.findMany({ where: { tenantId: t }, select: { id: true, employeeNumber: true } })).map((e) => [e.employeeNumber, e.id]));
  const id = (n: string) => { const v = emps.get(n); if (!v) throw new Error(`PSA seed: no employee ${n}`); return v; };
  const userOf = async (n: string) => (await prisma.employee.findUniqueOrThrow({ where: { id: id(n) }, select: { userId: true } })).userId!;

  // ---- Permissions on the current database (system roles only, PSA keys only) ----
  let grants = 0;
  for (const def of SYSTEM_ROLES) {
    const role = await prisma.role.findFirst({ where: { tenantId: t, key: def.key } });
    if (!role) continue;
    const r = await prisma.rolePermission.createMany({ data: def.permissions.filter((p) => p.startsWith("psa.")).map((permission) => ({ roleId: role.id, permission })), skipDuplicates: true });
    grants += r.count;
  }

  // ---- Clear what this seed made before --------------------------------------------
  const seededProjects = await prisma.project.findMany({ where: { tenantId: t, name: { in: SEEDED_PROJECTS } }, select: { id: true } });
  await prisma.invoice.deleteMany({ where: { tenantId: t, OR: [{ invoiceNumber: { in: SEEDED_INVOICES } }, { kind: "PROFORMA" }, { projectId: { in: seededProjects.map((p) => p.id) } }] } });
  await prisma.project.deleteMany({ where: { id: { in: seededProjects.map((p) => p.id) } } });
  await prisma.resourceAllocation.deleteMany({ where: { project: { tenantId: t }, OR: [{ kind: "SOFT" }, { requestId: { not: null } }] } });
  await prisma.psaInsightCache.deleteMany({ where: { tenantId: t } });
  await prisma.psaDashboardLayout.deleteMany({ where: { tenantId: t } });
  await prisma.psaSetting.deleteMany({ where: { tenantId: t } });
  await prisma.billingEntitySetting.deleteMany({ where: { tenantId: t } });
  await prisma.creditNote.deleteMany({ where: { tenantId: t } });
  await prisma.projectCharge.deleteMany({ where: { tenantId: t } });
  await prisma.resourceRequest.deleteMany({ where: { tenantId: t } });
  await prisma.projectRequest.deleteMany({ where: { tenantId: t } });
  await prisma.project.updateMany({ where: { tenantId: t }, data: { opportunityId: null, rateCardId: null } });
  await prisma.opportunity.deleteMany({ where: { tenantId: t } });
  await prisma.prospect.deleteMany({ where: { tenantId: t } });
  await prisma.opportunitySource.deleteMany({ where: { tenantId: t } });
  await prisma.opportunityStage.deleteMany({ where: { tenantId: t } });
  await prisma.resourceProfile.deleteMany({ where: { tenantId: t } });
  await prisma.rateCard.deleteMany({ where: { tenantId: t, name: { in: RATE_CARDS } } });
  await prisma.billingRole.deleteMany({ where: { tenantId: t } });
  await prisma.client.deleteMany({ where: { tenantId: t, name: "Saffron Stays Hospitality", projects: { none: {} }, invoices: { none: {} } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: t, module: "PROJECTS", entityType: "Opportunity" } });

  // ---- Settings ------------------------------------------------------------------
  await prisma.psaSetting.create({ data: { tenantId: t, criticalRequestDays: 10, projectCreationNeedsApproval: false, defaultRevenueRecognition: "INCOME_TO_DATE" } });
  const entities = await prisma.legalEntity.findMany({ where: { tenantId: t }, orderBy: { createdAt: "asc" } });
  if (entities[0]) {
    await prisma.billingEntitySetting.create({
      data: {
        tenantId: t, legalEntityId: entities[0].id, invoicePrefix: "ACT/26-27/", nextInvoiceNumber: 1, proformaPrefix: "PINV-", nextProformaNumber: 1, creditNotePrefix: "CRN-", nextCreditNoteNumber: 1, defaultPaymentTermDays: 30,
        bankDetails: "HDFC Bank, Koramangala branch · A/c 50200012345678 · IFSC HDFC0000123", footer: "Thank you for your business. Please quote the invoice number with your payment.",
      },
    });
  }

  // ---- Billing roles and rate cards ----------------------------------------------
  const ROLES: Array<[string, string | null]> = [
    ["Architect", "Owns the solution design across a programme"], ["Tech lead", "Leads a delivery team day to day"], ["Senior engineer", null], ["Engineer", null],
    ["QA engineer", "Manual and automated testing"], ["Designer", "Product and interaction design"], ["Business analyst", "Requirements and workshops"],
    ["Project manager", "Plans, reports and runs the client relationship"], ["Support lead", null], ["Support engineer", "L2/L3 support"], ["Consultant", null],
  ];
  const roleId = new Map<string, string>();
  for (const [name, description] of ROLES) roleId.set(name, (await prisma.billingRole.create({ data: { tenantId: t, name, description } })).id);

  const northwind = await prisma.client.findFirstOrThrow({ where: { tenantId: t, name: "Northwind Retail" } });
  const bluefin = await prisma.client.findFirstOrThrow({ where: { tenantId: t, name: "Bluefin Logistics" } });
  const helix = await prisma.client.findFirstOrThrow({ where: { tenantId: t, name: "Helix Health Inc" } });
  const card = async (name: string, currency: string, clientId: string | null, rates: Array<[string, number, number | null, string?]>) => {
    const c = await prisma.rateCard.create({ data: { tenantId: t, name, currency, rateUnit: "HOURLY", clientId } });
    await prisma.billingRate.createMany({ data: rates.map(([billingRole, billRate, suggestedCost, rateCategory]) => ({ rateCardId: c.id, billingRole, billRate, suggestedCost, rateCategory: rateCategory ?? "STANDARD" })) });
    return c;
  };
  const standard = await card("Standard INR", "INR", null, [
    ["Architect", 4200, 1800], ["Tech lead", 3500, 1600], ["Senior engineer", 3000, 1100], ["Senior engineer", 3600, 1250, "On Site"], ["Engineer", 2200, 700], ["Engineer", 2600, 800, "On Site"],
    ["QA engineer", 1800, 600], ["Designer", 2400, 900], ["Business analyst", 2000, 800], ["Project manager", 3200, 1500], ["Support lead", 1900, 750], ["Support engineer", 1500, 650],
  ]);
  const nwCard = await card("Northwind rate card", "INR", northwind.id, [["Tech lead", 3500, 1600], ["Senior engineer", 3000, 1100], ["Engineer", 2200, 700], ["QA engineer", 1800, 600]]);
  await card("USD Rate Card", "USD", null, [["Senior engineer", 60, 18], ["Engineer", 40, 12], ["Tech lead", 75, 24]]);

  // ---- Cost and capacity ---------------------------------------------------------
  const FT = [0, 8, 8, 8, 8, 8, 0], PT = [0, 4, 4, 4, 4, 4, 0];
  const profiles: Array<[string, "HOURLY" | "MONTHLY" | "ANNUAL", number, number, number[]]> = [
    ["ACM0004", "ANNUAL", 4500000, 40, FT], ["ACM0005", "ANNUAL", 3200000, 50, FT], ["ACM0006", "HOURLY", 1600, 75, FT], ["ACM0007", "HOURLY", 1000, 80, FT],
    ["ACM0008", "HOURLY", 950, 80, FT], ["ACM0009", "HOURLY", 700, 85, FT], ["ACM0010", "HOURLY", 650, 85, FT], ["ACM0011", "HOURLY", 600, 85, FT], ["ACM0012", "HOURLY", 500, 85, FT],
    ["ACM0013", "MONTHLY", 140000, 70, FT], ["ACM0014", "ANNUAL", 2600000, 50, FT], ["ACM0017", "HOURLY", 750, 80, FT], ["ACM0023", "MONTHLY", 180000, 60, FT],
    ["ACM0024", "HOURLY", 550, 85, FT], ["ACM0025", "HOURLY", 550, 85, FT], ["ACM0026", "MONTHLY", 25000, 60, PT], ["ACM0027", "HOURLY", 600, 85, FT],
    ["ACM0028", "HOURLY", 650, 80, FT], ["ACM0029", "HOURLY", 1100, 80, FT], ["ACM0030", "HOURLY", 1050, 80, FT],
  ];
  for (const [num, costType, amount, target, capacity] of profiles) {
    await prisma.resourceProfile.create({ data: { tenantId: t, employeeId: id(num), capacity, costType, costAmount: amount, currency: "INR", hourlyCost: svc.hourlyCost(costType, amount, capacity), targetUtilization: target } });
  }

  // ---- Existing projects: org units, recognition, rate cards ---------------------
  const bu = new Map((await prisma.businessUnit.findMany({ where: { tenantId: t } })).map((x) => [x.name, x.id]));
  const dept = new Map((await prisma.department.findMany({ where: { tenantId: t } })).map((x) => [x.code ?? x.name, x.id]));
  const loc = new Map((await prisma.location.findMany({ where: { tenantId: t } })).map((x) => [x.name, x.id]));
  const pos = await prisma.project.findFirstOrThrow({ where: { tenantId: t, name: "Northwind POS Modernisation" } });
  const fleet = await prisma.project.findFirstOrThrow({ where: { tenantId: t, name: "Bluefin Fleet Portal" } });
  const support = await prisma.project.findFirstOrThrow({ where: { tenantId: t, name: "Helix Support Retainer" } });
  const internal = await prisma.project.findFirstOrThrow({ where: { tenantId: t, name: "Platform Upgrade" } });
  await prisma.project.update({ where: { id: pos.id }, data: { businessUnitId: bu.get("Engineering"), departmentId: dept.get("PROD"), locationId: loc.get("Bengaluru HQ"), revenueRecognition: "INCOME_TO_DATE", priority: "High", csat: "4.6", tags: ["Retail", "Strategic"], rateCardId: nwCard.id } });
  await prisma.project.update({ where: { id: fleet.id }, data: { businessUnitId: bu.get("Engineering"), departmentId: dept.get("PLAT"), locationId: loc.get("Mumbai Office"), revenueRecognition: "INVOICED_AMOUNT", priority: "Medium", csat: "4.2", tags: ["Logistics"], rateCardId: standard.id } });
  await prisma.project.update({ where: { id: support.id }, data: { businessUnitId: bu.get("Managed Services"), departmentId: dept.get("SD"), locationId: loc.get("Chennai Delivery Centre"), revenueRecognition: "INCOME_TO_DATE", priority: "Medium", csat: "4.8", tags: ["Healthcare", "Export"], rateCardId: standard.id, retainerFrom: d("2026-09-01") } });
  await prisma.project.update({ where: { id: internal.id }, data: { businessUnitId: bu.get("Engineering"), departmentId: dept.get("PLAT"), locationId: loc.get("Bengaluru HQ"), priority: "Low", tags: ["Internal"] } });
  await prisma.project.create({
    data: {
      tenantId: t, name: "Legacy HRMS Migration", code: "INT-03", billingModel: "NON_BILLABLE", status: "COMPLETED", health: "GREEN", projectManagerId: id("ACM0004"),
      startDate: d("2025-06-01"), endDate: d("2026-01-31"), estimatedHours: 900, archivedAt: d("2026-02-15"), description: "Moved employee records off the old on-premise HRMS.",
      businessUnitId: bu.get("Corporate"), departmentId: dept.get("IT"), locationId: loc.get("Bengaluru HQ"), tags: ["Internal"],
    },
  });

  // ---- Pipeline ------------------------------------------------------------------
  const STAGES: Array<[string, string, number, "OPEN" | "WON" | "LOST"]> = [
    ["Prospecting", "#4a90e2", 10, "OPEN"], ["Qualification", "#ef6f6f", 25, "OPEN"], ["Proposal", "#9b7ede", 50, "OPEN"],
    ["Negotiation", "#f5b83d", 75, "OPEN"], ["Closed Won", "#8bc34a", 100, "WON"], ["Closed Lost", "#ef5350", 0, "LOST"],
  ];
  const stage = new Map<string, string>();
  for (const [i, [name, color, p, kind]] of STAGES.entries()) stage.set(name, (await prisma.opportunityStage.create({ data: { tenantId: t, name, color, winProbability: p, kind, sequence: i + 1 } })).id);
  const source = new Map<string, string>();
  for (const name of ["Website", "Referral", "Partner", "Outbound", "Existing account"]) source.set(name, (await prisma.opportunitySource.create({ data: { tenantId: t, name } })).id);

  const saffron = await prisma.prospect.create({ data: { tenantId: t, name: "Saffron Stays Hospitality", contactName: "Ritika Fernandes", contactEmail: "ritika@saffronstays.example", contactPhone: "+91 98220 41123", city: "Panaji", state: "Goa", ownerId: id("ACM0015") } });
  const orbit = await prisma.prospect.create({ data: { tenantId: t, name: "Orbit Fintech Pte Ltd", contactName: "Daniel Tan", contactEmail: "daniel.tan@orbitfin.example", city: "Singapore", countryCode: "SG", currency: "USD", ownerId: id("ACM0015") } });
  const kaveri = await prisma.prospect.create({ data: { tenantId: t, name: "Kaveri Agro Foods", contactName: "Manjunath Gowda", contactEmail: "it@kaveriagro.example", city: "Mysuru", state: "Karnataka", ownerId: id("ACM0016") } });

  const sales = await userOf("ACM0015");
  let n = 0;
  const opp = async (o: {
    name: string; party: { clientId?: string; prospectId?: string }; source: string; stage: string; owner: string; managers?: string[]; billing: "TIME_AND_MATERIAL" | "MILESTONE" | "RETAINER";
    revenue: number; currency?: string; fx?: number; start: string; close: string; pStart: string; pEnd?: string; bu?: string; dept?: string; lost?: string; archived?: string; created: string; description?: string;
  }) => {
    const st = STAGES.find((s) => s[0] === o.stage)!;
    n++;
    return prisma.opportunity.create({
      data: {
        tenantId: t, number: `OPP-${String(n).padStart(4, "0")}`, name: o.name, description: o.description ?? null, clientId: o.party.clientId ?? null, prospectId: o.party.prospectId ?? null,
        sourceId: source.get(o.source)!, stageId: stage.get(o.stage)!, status: o.archived ? "ARCHIVED" : st[3] === "OPEN" ? "OPEN" : st[3], winProbability: st[2],
        ownerId: id(o.owner), managerIds: [...new Set([id(o.owner), ...(o.managers ?? []).map(id)])], billingModel: o.billing, currency: o.currency ?? "INR",
        estimatedRevenue: o.revenue, fxRate: o.fx ?? 1, startDate: d(o.start), closeDate: d(o.close), expectedProjectStart: d(o.pStart), expectedProjectEnd: o.pEnd ? d(o.pEnd) : null,
        businessUnitId: bu.get(o.bu ?? "Revenue") ?? null, departmentId: o.dept ? dept.get(o.dept) ?? null : dept.get("SALES") ?? null, locationId: loc.get("Bengaluru HQ") ?? null,
        closedAt: st[3] === "OPEN" ? null : d(o.close), lostReason: o.lost ?? null, archivedAt: o.archived ? d(o.archived) : null, updatedById: sales, createdAt: d(o.created),
      },
    });
  };
  const oPos = await opp({ name: "Northwind POS Modernisation", party: { clientId: northwind.id }, source: "Existing account", stage: "Closed Won", owner: "ACM0015", managers: ["ACM0005"], billing: "TIME_AND_MATERIAL", revenue: 6500000, start: "2026-04-10", close: "2026-06-20", pStart: "2026-07-01", pEnd: "2026-12-31", bu: "Engineering", dept: "PROD", created: "2026-04-10", description: "Cloud POS for 140 stores with offline-first tills." });
  const oLoyalty = await opp({ name: "Northwind Loyalty App", party: { clientId: northwind.id }, source: "Existing account", stage: "Proposal", owner: "ACM0015", managers: ["ACM0005"], billing: "TIME_AND_MATERIAL", revenue: 3850000, start: "2026-09-01", close: "2026-10-31", pStart: "2026-11-16", pEnd: "2027-04-30", bu: "Engineering", dept: "PROD", created: "2026-09-01", description: "Points, tiers and offers across the POS and a new mobile app." });
  const oDriver = await opp({ name: "Bluefin Driver App — Phase 2", party: { clientId: bluefin.id }, source: "Existing account", stage: "Negotiation", owner: "ACM0014", managers: ["ACM0016"], billing: "MILESTONE", revenue: 2400000, start: "2026-08-18", close: "2026-10-20", pStart: "2026-12-01", pEnd: "2027-05-31", bu: "Engineering", dept: "PLAT", created: "2026-08-18" });
  await opp({ name: "Helix Analytics Add-on", party: { clientId: helix.id }, source: "Referral", stage: "Qualification", owner: "ACM0016", billing: "TIME_AND_MATERIAL", revenue: 1200000, start: "2026-09-15", close: "2026-11-30", pStart: "2027-01-04", pEnd: "2027-03-31", created: "2026-09-15" });
  await opp({ name: "Helix Data Migration", party: { clientId: helix.id }, source: "Existing account", stage: "Negotiation", owner: "ACM0023", managers: ["ACM0016"], billing: "MILESTONE", revenue: 850000, start: "2026-08-25", close: "2026-10-15", pStart: "2026-11-02", pEnd: "2027-01-29", bu: "Managed Services", dept: "SD", created: "2026-08-25" });
  const oSaffron = await opp({ name: "Saffron Stays Booking Engine", party: { prospectId: saffron.id }, source: "Website", stage: "Closed Won", owner: "ACM0015", managers: ["ACM0005"], billing: "TIME_AND_MATERIAL", revenue: 1875000, start: "2026-08-04", close: "2026-09-25", pStart: "2026-10-15", pEnd: "2027-03-31", bu: "Engineering", dept: "PROD", created: "2026-08-04" });
  await opp({ name: "Kaveri Agro Supply Chain Portal", party: { prospectId: kaveri.id }, source: "Outbound", stage: "Prospecting", owner: "ACM0016", billing: "MILESTONE", revenue: 960000, start: "2026-09-22", close: "2026-12-15", pStart: "2027-01-11", pEnd: "2027-06-30", created: "2026-09-22" });
  await opp({ name: "Kaveri Mobile Ordering", party: { prospectId: kaveri.id }, source: "Outbound", stage: "Prospecting", owner: "ACM0016", billing: "TIME_AND_MATERIAL", revenue: 640000, start: "2026-09-29", close: "2027-01-15", pStart: "2027-02-01", created: "2026-09-29" });
  await opp({ name: "Orbit Fintech KYC Platform", party: { prospectId: orbit.id }, source: "Partner", stage: "Qualification", owner: "ACM0015", billing: "TIME_AND_MATERIAL", revenue: 120000, currency: "USD", fx: 83.2, start: "2026-09-08", close: "2026-11-28", pStart: "2027-01-04", pEnd: "2027-06-30", created: "2026-09-08" });
  await opp({ name: "Northwind Price Engine", party: { clientId: northwind.id }, source: "Referral", stage: "Prospecting", owner: "ACM0015", billing: "TIME_AND_MATERIAL", revenue: 1450000, start: "2026-09-25", close: "2026-12-20", pStart: "2027-01-18", created: "2026-09-25" });
  const oKiosk = await opp({ name: "Bluefin Warehouse Kiosk", party: { clientId: bluefin.id }, source: "Referral", stage: "Closed Won", owner: "ACM0014", billing: "MILESTONE", revenue: 1100000, start: "2026-08-10", close: "2026-09-29", pStart: "2026-10-26", pEnd: "2027-02-26", bu: "Engineering", dept: "PLAT", created: "2026-08-10" });
  const oMobile = await opp({ name: "Helix Mobile Refresh", party: { clientId: helix.id }, source: "Website", stage: "Closed Won", owner: "ACM0023", billing: "RETAINER", revenue: 1800000, start: "2026-07-20", close: "2026-09-18", pStart: "2026-11-02", pEnd: "2027-04-30", bu: "Managed Services", dept: "SD", created: "2026-07-20" });
  await opp({ name: "Northwind Kiosk Pilot", party: { clientId: northwind.id }, source: "Existing account", stage: "Closed Lost", owner: "ACM0015", billing: "MILESTONE", revenue: 700000, start: "2026-06-15", close: "2026-08-14", pStart: "2026-09-01", created: "2026-06-15", lost: "The client chose to build the kiosk with its in-house team." });
  await opp({ name: "Orbit Payments Gateway", party: { prospectId: orbit.id }, source: "Partner", stage: "Prospecting", owner: "ACM0015", billing: "TIME_AND_MATERIAL", revenue: 60000, currency: "USD", fx: 83.2, start: "2026-05-04", close: "2026-07-31", pStart: "2026-08-17", created: "2026-05-04", archived: "2026-08-05" });
  await prisma.project.update({ where: { id: pos.id }, data: { opportunityId: oPos.id } });

  // Estimates on the loyalty app: a draft task plan and a published resource plan.
  const kavya = await userOf("ACM0014"), sneha = await userOf("ACM0005");
  const taskEst = await prisma.opportunityEstimate.create({ data: { opportunityId: oLoyalty.id, name: "Estimation 1", type: "TASK", updatedById: sneha, createdAt: d("2026-09-08") } });
  const phase = async (name: string, start: string, end: string, seq: number) => (await prisma.estimateLine.create({ data: { estimateId: taskEst.id, kind: "PHASE", name, startDate: d(start), endDate: d(end), sequence: seq } })).id;
  const discovery = await phase("Discovery & design", "2026-11-16", "2026-12-18", 0);
  const build = await phase("Build", "2026-12-21", "2027-04-16", 4);
  const task = (parentId: string, name: string, role: string, hours: number, bill: number, cost: number, start: string, end: string, seq: number) =>
    prisma.estimateLine.create({ data: { estimateId: taskEst.id, kind: "TASK", parentId, name, billingRoleId: roleId.get(role), hours, billRate: bill, costRate: cost, startDate: d(start), endDate: d(end), sequence: seq } });
  await task(discovery, "Loyalty workshops", "Business analyst", 40, 2000, 800, "2026-11-16", "2026-11-27", 1);
  await task(discovery, "UX research & wireframes", "Designer", 80, 2400, 900, "2026-11-23", "2026-12-18", 2);
  await prisma.estimateLine.create({ data: { estimateId: taskEst.id, kind: "MILESTONE", parentId: discovery, name: "Design sign-off", endDate: d("2026-12-18"), amount: 300000, sequence: 3 } });
  await task(build, "Points & tiers APIs", "Senior engineer", 320, 3000, 1100, "2026-12-21", "2027-02-26", 5);
  await task(build, "Mobile app (iOS & Android)", "Engineer", 480, 2200, 700, "2027-01-04", "2027-04-09", 6);
  await task(build, "Regression & UAT support", "QA engineer", 160, 1800, 600, "2027-02-15", "2027-04-16", 7);
  await prisma.estimateLine.create({ data: { estimateId: taskEst.id, kind: "MILESTONE", parentId: build, name: "Go-live in 20 stores", endDate: d("2027-04-16"), amount: 500000, sequence: 8 } });
  await svc.recomputeEstimate(taskEst.id);

  const resEst = await prisma.opportunityEstimate.create({ data: { opportunityId: oLoyalty.id, name: "Estimation 2", type: "RESOURCE", rateCardId: standard.id, updatedById: sneha, createdAt: d("2026-09-14") } });
  const role = (name: string, roleName: string, headcount: number, pct: number, bill: number, cost: number, start: string, end: string, seq: number, employee?: string) =>
    prisma.estimateLine.create({ data: { estimateId: resEst.id, kind: "ROLE", name, billingRoleId: roleId.get(roleName), employeeId: employee ? id(employee) : null, headcount, allocationPercent: pct, billRate: bill, costRate: cost, startDate: d(start), endDate: d(end), sequence: seq } });
  await role("Karthik Subramanian", "Tech lead", 1, 50, 3500, 1600, "2026-11-16", "2027-04-30", 0, "ACM0006");
  await role("Senior engineer", "Senior engineer", 2, 100, 3000, 1100, "2026-12-01", "2027-04-16", 1);
  await role("Engineer", "Engineer", 2, 100, 2200, 700, "2027-01-04", "2027-04-16", 2);
  await role("QA engineer", "QA engineer", 1, 100, 1800, 600, "2027-02-01", "2027-04-30", 3);
  await role("Designer", "Designer", 1, 50, 2400, 900, "2026-11-16", "2027-01-29", 4);
  await svc.recomputeEstimate(resEst.id);
  await prisma.opportunityEstimate.update({ where: { id: resEst.id }, data: { status: "PUBLISHED", publishedAt: d("2026-09-18") } });
  const driverEst = await prisma.opportunityEstimate.create({ data: { opportunityId: oDriver.id, name: "Estimation 1", type: "RESOURCE", rateCardId: standard.id, updatedById: kavya, createdAt: d("2026-09-02") } });
  await prisma.estimateLine.createMany({ data: [
    { estimateId: driverEst.id, kind: "ROLE", name: "Senior engineer", billingRoleId: roleId.get("Senior engineer"), headcount: 1, allocationPercent: 100, billRate: 3000, costRate: 1100, startDate: d("2026-12-01"), endDate: d("2027-05-28"), sequence: 0 },
    { estimateId: driverEst.id, kind: "ROLE", name: "Engineer", billingRoleId: roleId.get("Engineer"), headcount: 2, allocationPercent: 100, billRate: 2200, costRate: 700, startDate: d("2026-12-01"), endDate: d("2027-05-28"), sequence: 1 },
  ] });
  await svc.recomputeEstimate(driverEst.id);

  await prisma.opportunityComment.createMany({ data: [
    { opportunityId: oLoyalty.id, authorId: sales, body: "Farah wants the tiers live before the Diwali 2027 campaign; they are open to a phased rollout.", createdAt: d("2026-09-10") },
    { opportunityId: oLoyalty.id, authorId: sneha, body: "Resource estimate published. Karthik can lead at 50% once the POS pilot is through.", createdAt: d("2026-09-18") },
    { opportunityId: oDriver.id, authorId: kavya, body: "Procurement asked for milestone billing in three tranches.", createdAt: d("2026-09-21") },
  ] });
  await prisma.auditLog.createMany({ data: [
    { tenantId: t, module: "PROJECTS", action: "UPDATE", entityType: "Opportunity", entityId: oLoyalty.id, summary: "updated opportunity stage to Proposal", actorId: sales, actorLabel: "rahul.kapoor@acme.test", createdAt: d("2026-09-19") },
    { tenantId: t, module: "PROJECTS", action: "CREATE", entityType: "Opportunity", entityId: oLoyalty.id, summary: "created resource estimation", actorId: sneha, actorLabel: "sneha.reddy@acme.test", createdAt: d("2026-09-14") },
    { tenantId: t, module: "PROJECTS", action: "UPDATE", entityType: "Opportunity", entityId: oDriver.id, summary: "updated opportunity stage to Negotiation", actorId: kavya, actorLabel: "kavya.bhat@acme.test", createdAt: d("2026-09-24") },
  ] });

  // ---- Won deals at each step of the hand-off ---------------------------------------
  await prisma.projectRequest.create({ data: { tenantId: t, source: "OPPORTUNITY", opportunityId: oPos.id, name: oPos.name, clientId: northwind.id, billingModel: "TIME_AND_MATERIAL", estimatedRevenue: 6500000, status: "APPROVED", requestedById: sales, requestedAt: d("2026-06-20"), decidedById: await userOf("ACM0001"), decidedAt: d("2026-06-24"), projectId: pos.id } });
  await prisma.projectRequest.create({ data: { tenantId: t, source: "OPPORTUNITY", opportunityId: oKiosk.id, name: oKiosk.name, clientId: bluefin.id, billingModel: "MILESTONE", estimatedRevenue: 1100000, status: "NEW", requestedById: kavya, requestedAt: d("2026-09-29") } });
  await prisma.projectRequest.create({
    data: {
      tenantId: t, source: "OPPORTUNITY", opportunityId: oMobile.id, name: "Helix Mobile Refresh", clientId: helix.id, billingModel: "RETAINER", estimatedRevenue: 1800000, status: "PENDING",
      requestedById: await userOf("ACM0023"), requestedAt: d("2026-09-21"),
      payload: { name: "Helix Mobile Refresh", code: "HLX-MR", clientId: helix.id, billingModel: "RETAINER", startDate: "2026-11-02T00:00:00.000Z", endDate: "2027-04-30T00:00:00.000Z", projectManagerId: id("ACM0023"), retainerFee: 300000, retainerFrequency: "MONTHLY", revenueRecognition: "INCOME_TO_DATE", businessUnitId: bu.get("Managed Services") ?? null, departmentId: dept.get("SD") ?? null, priority: "Medium", tags: ["Healthcare", "Mobile"] },
    },
  });
  await prisma.projectRequest.create({ data: { tenantId: t, source: "PROJECT", name: "Acme Intranet Revamp", billingModel: "NON_BILLABLE", status: "REJECTED", requestedById: await userOf("ACM0004"), requestedAt: d("2026-08-28"), decidedById: await userOf("ACM0001"), decidedAt: d("2026-09-02"), rejectReason: "Fold it into the Platform Upgrade budget next quarter." } });

  // Saffron: approved and created — the prospect becomes a client.
  const saffronClient = await prisma.client.create({ data: { tenantId: t, name: saffron.name, contactName: saffron.contactName, contactEmail: saffron.contactEmail, contactPhone: saffron.contactPhone, city: saffron.city, state: saffron.state, countryCode: "IN", accountManagerId: id("ACM0015") } });
  await prisma.prospect.update({ where: { id: saffron.id }, data: { clientId: saffronClient.id } });
  await prisma.opportunity.update({ where: { id: oSaffron.id }, data: { clientId: saffronClient.id, prospectId: null } });
  const saffronProject = await prisma.project.create({
    data: {
      tenantId: t, name: "Saffron Stays Booking Engine", code: "SSH-01", clientId: saffronClient.id, billingModel: "TIME_AND_MATERIAL", status: "ACTIVE", projectManagerId: id("ACM0005"),
      startDate: d("2026-10-15"), endDate: d("2027-03-31"), estimatedHours: 1800, opportunityId: oSaffron.id, revenueRecognition: "TIME_EXPENDED", rateCardId: standard.id,
      businessUnitId: bu.get("Engineering"), departmentId: dept.get("PROD"), locationId: loc.get("Bengaluru HQ"), priority: "High", tags: ["Hospitality"],
      description: "Direct-booking engine with channel-manager sync for 38 boutique properties.",
    },
  });
  await prisma.projectRequest.create({ data: { tenantId: t, source: "OPPORTUNITY", opportunityId: oSaffron.id, name: saffronProject.name, clientId: saffronClient.id, billingModel: "TIME_AND_MATERIAL", estimatedRevenue: 1875000, status: "APPROVED", requestedById: sales, requestedAt: d("2026-09-25"), decidedById: await userOf("ACM0001"), decidedAt: d("2026-09-28"), projectId: saffronProject.id } });
  await prisma.resourceAllocation.createMany({ data: [
    { projectId: saffronProject.id, employeeId: id("ACM0024"), billingRole: "Engineer", allocationPercent: 100, billRate: 2200, costRate: 550, isBillable: true, startDate: d("2026-10-15"), endDate: d("2027-03-31"), kind: "HARD" },
    { projectId: saffronProject.id, employeeId: id("ACM0008"), billingRole: "Senior engineer", allocationPercent: 100, billRate: 3000, costRate: 950, isBillable: true, startDate: d("2026-10-15"), endDate: d("2027-03-31"), kind: "SOFT" },
    { projectId: saffronProject.id, employeeId: id("ACM0025"), billingRole: "Engineer", allocationPercent: 100, billRate: 2200, costRate: 550, isBillable: true, startDate: d("2026-11-02"), endDate: d("2027-03-31"), kind: "SOFT" },
    { projectId: fleet.id, employeeId: id("ACM0013"), billingRole: "Designer", allocationPercent: 50, billRate: 2400, costRate: 808, isBillable: true, startDate: d("2026-12-01"), endDate: d("2027-02-26"), kind: "SOFT" },
  ] });

  // ---- Resource requests -----------------------------------------------------------
  const rr = (data: Record<string, unknown>) => prisma.resourceRequest.create({ data: { tenantId: t, requestedById: sneha, ...data } as never });
  await rr({ projectId: pos.id, type: "ROLE", billingRoleId: roleId.get("Senior engineer"), count: 1, allocationPercent: 100, startDate: d("2026-10-06"), endDate: d("2026-12-31"), skills: ["React Native", "Node.js"], businessUnitIds: [bu.get("Engineering")], departmentIds: [dept.get("PROD")], minExperienceYears: 4, priority: "HIGH", notes: "Store rollout needs a second senior on the tills.", createdAt: d("2026-09-24") });
  await rr({ projectId: saffronProject.id, type: "ROLE", billingRoleId: roleId.get("Engineer"), count: 2, allocationPercent: 100, startDate: d("2026-10-08"), endDate: d("2027-03-31"), skills: ["Next.js", "PostgreSQL"], businessUnitIds: [bu.get("Engineering")], minExperienceYears: 2, priority: "URGENT", createdAt: d("2026-09-28") });
  await rr({ projectId: fleet.id, type: "RESOURCE", billingRoleId: roleId.get("Architect"), employeeId: id("ACM0006"), count: 1, allocationPercent: 30, startDate: d("2026-10-20"), endDate: d("2026-11-30"), skills: ["AWS", "Event-driven design"], minExperienceYears: 8, priority: "MEDIUM", requestedById: kavya, createdAt: d("2026-09-26") });
  await rr({ opportunityId: oLoyalty.id, type: "ROLE", billingRoleId: roleId.get("Designer"), count: 1, allocationPercent: 50, startDate: d("2026-11-16"), endDate: d("2027-01-29"), skills: ["Figma", "Mobile UX"], minExperienceYears: 3, priority: "MEDIUM", createdAt: d("2026-09-18") });
  const requisition = await prisma.requisition.findFirst({ where: { tenantId: t, status: { in: ["APPROVED", "PENDING_APPROVAL"] } }, orderBy: { createdAt: "asc" } });
  await rr({ projectId: pos.id, type: "ROLE", billingRoleId: roleId.get("QA engineer"), count: 1, allocationPercent: 100, startDate: d("2026-11-02"), endDate: d("2026-12-31"), skills: ["Appium", "POS hardware"], departmentIds: [dept.get("QA")], minExperienceYears: 3, priority: "HIGH", status: "HIRING", requisitionId: requisition?.id ?? null, createdAt: d("2026-09-12") });
  const qaReq = await rr({ projectId: fleet.id, type: "ROLE", billingRoleId: roleId.get("QA engineer"), count: 1, allocationPercent: 40, startDate: d("2026-09-14"), endDate: d("2026-11-30"), skills: ["Cypress"], minExperienceYears: 2, priority: "MEDIUM", status: "ALLOCATED", requestedById: kavya, closedAt: d("2026-09-10"), closedById: await userOf("ACM0001"), closeReason: "Allocated", createdAt: d("2026-09-02") });
  await prisma.resourceAllocation.create({ data: { projectId: fleet.id, employeeId: id("ACM0012"), billingRole: "QA engineer", allocationPercent: 40, billRate: 1800, costRate: 500, isBillable: true, startDate: d("2026-09-14"), endDate: d("2026-11-30"), kind: "HARD", requestId: (qaReq as { id: string }).id } });
  await rr({ projectId: support.id, type: "ROLE", billingRoleId: roleId.get("Support engineer"), count: 1, allocationPercent: 50, startDate: d("2026-09-21"), skills: ["HL7"], priority: "LOW", status: "REJECTED", requestedById: await userOf("ACM0023"), closedAt: d("2026-09-15"), closedById: await userOf("ACM0001"), closeReason: "Covered by the existing support pair until Q4.", createdAt: d("2026-09-08") });

  // ---- Project expenses billable to the client --------------------------------------
  const tag = async (claimNumber: string, projectId: string) => prisma.expenseClaim.updateMany({ where: { tenantId: t, claimNumber }, data: { projectId } });
  await tag("EXP-1003", pos.id); await tag("EXP-1004", pos.id); await tag("EXP-1007", pos.id); await tag("EXP-1002", internal.id);

  // ---- Charges: every invoice line already billed, then what is ready to bill --------
  const invoices = await prisma.invoice.findMany({ where: { tenantId: t, kind: "TAX", projectId: { not: null } }, include: { lines: { orderBy: { sequence: "asc" } } }, orderBy: { issueDate: "asc" } });
  let chr = 0;
  for (const inv of invoices) {
    for (const l of inv.lines) {
      await prisma.projectCharge.create({
        data: {
          tenantId: t, projectId: inv.projectId!, number: `CHR${++chr}`, name: l.description, kind: l.lineType === "MILESTONE" ? "MILESTONE" : l.lineType === "RETAINER" ? "RETAINER" : "TIME",
          template: l.lineType === "HOURS" ? "EMPLOYEE" : "NONE", periodStart: inv.periodStart, periodEnd: inv.periodEnd, quantity: l.quantity, amount: l.amount, currency: inv.currency,
          status: "INVOICED", invoiceId: inv.id, sourceRefs: { key: `LINE:${l.id}` }, createdAt: inv.issueDate,
        },
      });
    }
  }
  const generated = await svc.generateAllCharges(t, d("2026-10-01"));
  const adhoc = await svc.addAdhocCharge(t, pos.id, { name: "POS till hardware — 5 pilot stores", amount: 185000, date: d("2026-09-25") });

  // ---- Documents: two proformas, credit notes, a written-off and a cancelled invoice ----
  const posTime = await prisma.projectCharge.findMany({ where: { tenantId: t, projectId: pos.id, status: "UNBILLED", kind: "TIME" }, orderBy: { periodStart: "asc" } });
  let proformas = 0;
  if (posTime.length) {
    const pf = await svc.draftInvoiceFromCharges(t, [posTime[0].id], { invoiceDate: d("2026-09-28"), paymentTermDays: 15, poNumber: "NW-PO-55821", attentionName: "Farah Khan", attentionEmail: "ap@northwind.example", billingEntityId: entities[0]?.id }, { proforma: true });
    if (pf.ok) { await prisma.invoice.update({ where: { id: pf.id! }, data: { status: "SENT", sentAt: d("2026-09-28") } }); proformas++; }
  }
  if (adhoc.ok) {
    const pf2 = await svc.draftInvoiceFromCharges(t, [adhoc.id!], { invoiceDate: d("2026-09-30"), paymentTermDays: 30, attentionName: "Farah Khan", billingEntityId: entities[0]?.id }, { proforma: true });
    if (pf2.ok) proformas++;
  }
  const history = async (o: { number: string; projectId: string; clientId: string; issue: string; due: string; from: string; to: string; subtotal: number; tax: number; line: string; lineType: string; qty: number; rate: number; status: "WRITTEN_OFF" | "CANCELLED"; extra: Record<string, unknown> }) => {
    const total = o.subtotal + o.tax;
    return prisma.invoice.create({
      data: {
        tenantId: t, clientId: o.clientId, projectId: o.projectId, invoiceNumber: o.number, status: o.status, issueDate: d(o.issue), dueDate: d(o.due), periodStart: d(o.from), periodEnd: d(o.to),
        subtotal: o.subtotal, taxTotal: o.tax, total, amountPaid: 0, amountDue: 0, sentAt: d(o.issue), billingEntityId: entities[0]?.id ?? null, paymentTermDays: 30,
        notes: o.tax ? `CGST 9% ₹${o.tax / 2} + SGST 9% ₹${o.tax / 2}` : "Export of services — zero-rated under LUT", ...o.extra,
        lines: { create: [{ description: o.line, lineType: o.lineType, quantity: o.qty, unitRate: o.rate, amount: o.subtotal, taxPercent: o.tax ? 18 : 0, taxAmount: o.tax, sequence: 0 }] },
      },
    });
  };
  const wo = await history({ number: "INV-2026-0004", projectId: pos.id, clientId: northwind.id, issue: "2026-07-03", due: "2026-08-02", from: "2026-06-01", to: "2026-06-30", subtotal: 100000, tax: 18000, line: "Discovery workshops — store visits", lineType: "HOURS", qty: 40, rate: 2500, status: "WRITTEN_OFF", extra: { writtenOffAt: d("2026-09-18"), writeOffAmount: 118000, writeOffReason: "Disputed pilot hours; settled with the client at the June steering committee." } });
  const cx = await history({ number: "INV-2026-0005", projectId: support.id, clientId: helix.id, issue: "2026-08-31", due: "2026-09-30", from: "2026-08-01", to: "2026-08-31", subtotal: 450000, tax: 0, line: "Retainer 2026-08", lineType: "RETAINER", qty: 1, rate: 450000, status: "CANCELLED", extra: { cancelledAt: d("2026-09-02"), cancelReason: "Raised before the retainer start was moved to September." } });
  for (const inv of [wo, cx]) {
    const l = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } });
    await prisma.projectCharge.create({ data: { tenantId: t, projectId: inv.projectId!, number: `CHR${(await prisma.projectCharge.count({ where: { tenantId: t } })) + 1}`, name: l.description, kind: l.lineType === "RETAINER" ? "RETAINER" : "TIME", template: l.lineType === "HOURS" ? "EMPLOYEE" : "NONE", periodStart: inv.periodStart, periodEnd: inv.periodEnd, quantity: l.quantity, amount: l.amount, status: inv.status === "CANCELLED" ? "CANCELLED" : "INVOICED", invoiceId: inv.id, sourceRefs: { key: `LINE:${l.id}` }, createdAt: inv.issueDate } });
  }
  const overdueInv = await prisma.invoice.findFirst({ where: { tenantId: t, projectId: pos.id, kind: "TAX", status: { in: ["OVERDUE", "PARTIALLY_PAID"] } } });
  const cn1 = await svc.raiseCreditNote(t, { clientId: northwind.id, invoiceId: overdueInv?.id ?? null, amount: 25000, taxAmount: 4500, reason: "Goodwill discount for the delayed pilot in five stores", issueDate: d("2026-09-26") }, sales);
  await svc.raiseCreditNote(t, { clientId: bluefin.id, amount: 10000, taxAmount: 1800, reason: "Two days of rework on the tracking map", issueDate: d("2026-08-21") }, kavya);
  const cn3 = await svc.raiseCreditNote(t, { clientId: helix.id, amount: 15000, reason: "Service credit: SLA breach on 12 Sep", issueDate: d("2026-09-16") }, await userOf("ACM0023"));
  if (cn3.ok) await svc.voidCreditNote(t, cn3.id!);

  return {
    grants, roles: ROLES.length, rateCards: RATE_CARDS.length, profiles: profiles.length, opportunities: n, prospects: 3,
    requests: 4, resourceRequests: 7, charges: chr + generated + (adhoc.ok ? 1 : 0) + 2, proformas, creditNotes: cn1.ok ? 3 : 2,
  };
}
