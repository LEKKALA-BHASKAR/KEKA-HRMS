import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Projects seed: three clients, one per GST treatment (same state, another
 * state, abroad); a project for each billing model; allocations with rates;
 * tasks; six weeks of timesheets through the services — approved, waiting,
 * sent back and a draft this week; and invoices sent, part-paid and overdue.
 */
const DAY = 86_400_000;
const today = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const d = (s: string) => new Date(`${s}T00:00:00Z`);

export async function seedProjects(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const svc = await import("@keka/services");
  const t = ctx.tenantId, id = (n: string) => ctx.empIdByNumber.get(n)!;
  const userOf = async (n: string) => (await prisma.employee.findUniqueOrThrow({ where: { id: id(n) }, select: { userId: true } })).userId!;

  const northwind = await prisma.client.create({ data: { tenantId: t, name: "Northwind Retail", code: "NWR", state: "Karnataka", city: "Bengaluru", gstin: "29AABCN1234F1Z5", contactName: "Farah Khan", contactEmail: "ap@northwind.example" } });
  const bluefin = await prisma.client.create({ data: { tenantId: t, name: "Bluefin Logistics", code: "BFL", state: "Maharashtra", city: "Mumbai", gstin: "27AACCB5678K1Z2", contactName: "Rohan Mehta", contactEmail: "finance@bluefin.example" } });
  const helix = await prisma.client.create({ data: { tenantId: t, name: "Helix Health Inc", code: "HLX", countryCode: "US", city: "Boston", currency: "INR", contactName: "Dana Wright", contactEmail: "payables@helix.example" } });

  const project = (data: Record<string, unknown>) => prisma.project.create({ data: { tenantId: t, status: "ACTIVE", ...data } as never });
  const pos = await project({ name: "Northwind POS Modernisation", code: "NWR-01", clientId: northwind.id, billingModel: "TIME_AND_MATERIAL", projectManagerId: id("ACM0005"), startDate: d("2026-07-01"), endDate: d("2026-12-31"), estimatedHours: 2400, budget: 6500000, description: "Replacing 140 stores' point-of-sale with a cloud system; offline-first tills." });
  const fleet = await project({ name: "Bluefin Fleet Portal", code: "BFL-02", clientId: bluefin.id, billingModel: "MILESTONE", projectManagerId: id("ACM0014"), startDate: d("2026-06-01"), endDate: d("2026-11-30"), estimatedHours: 1400, budget: 2500000, description: "Customer portal for shipment tracking and proof of delivery." });
  const support = await project({ name: "Helix Support Retainer", code: "HLX-RT", clientId: helix.id, billingModel: "RETAINER", projectManagerId: id("ACM0023"), startDate: d("2026-04-01"), endDate: d("2027-03-31"), retainerFee: 450000, retainerFrequency: "MONTHLY", description: "L2/L3 support for Helix's clinic scheduling platform." });
  const internal = await project({ name: "Platform Upgrade", code: "INT-07", billingModel: "NON_BILLABLE", projectManagerId: id("ACM0004"), startDate: d("2026-08-01"), endDate: d("2026-10-31"), estimatedHours: 600, description: "Postgres 17, Node 24 and the build pipeline." });

  // Who works where, at what rate. Concurrent allocations stay within 100%.
  const alloc: Array<[string, string, string, number, number | null, number, boolean]> = [
    [pos.id, "ACM0006", "Tech lead", 60, 3500, 1600, true],
    [pos.id, "ACM0009", "Engineer", 100, 2200, 700, true],
    [pos.id, "ACM0029", "Senior engineer", 50, 3000, 1100, true],
    [pos.id, "ACM0011", "QA engineer", 50, 1800, 600, true],
    [fleet.id, "ACM0030", "Senior engineer", 50, 3000, 1050, true],
    [fleet.id, "ACM0010", "Engineer", 100, 2200, 650, true],
    [fleet.id, "ACM0029", "Senior engineer", 50, 3000, 1100, true],
    [support.id, "ACM0017", "Support lead", 50, null, 750, true],
    [support.id, "ACM0028", "Support engineer", 50, null, 650, true],
    [internal.id, "ACM0006", "Architect", 40, null, 1600, false],
    [internal.id, "ACM0012", "QA engineer", 50, null, 500, false],
    [internal.id, "ACM0007", "Engineer", 50, null, 1000, false],
  ];
  for (const [projectId, num, role, pct, bill, cost, billable] of alloc) {
    await prisma.resourceAllocation.create({ data: { projectId, employeeId: id(num), billingRole: role, allocationPercent: pct, billRate: bill, costRate: cost, isBillable: billable, startDate: d("2026-06-01") } });
  }

  const tasks: Record<string, string> = {};
  const task = async (projectId: string, title: string, num: string | null, status: string, est: number, due: string, priority = "MEDIUM") => {
    tasks[title] = (await prisma.task.create({ data: { tenantId: t, projectId, title, assigneeId: num ? id(num) : null, status: status as never, priority: priority as never, estimatedHours: est, dueDate: d(due), isBillable: projectId !== internal.id, completedAt: status === "DONE" ? d(due) : null, progressPercent: status === "DONE" ? 100 : 0 } })).id;
  };
  await task(pos.id, "Offline sync engine", "ACM0006", "IN_PROGRESS", 320, "2026-10-20", "HIGH");
  await task(pos.id, "Till UI — checkout flow", "ACM0009", "IN_PROGRESS", 240, "2026-10-15");
  await task(pos.id, "Payments gateway integration", "ACM0029", "TODO", 160, "2026-11-05", "HIGH");
  await task(pos.id, "Regression suite for tills", "ACM0011", "IN_PROGRESS", 120, "2026-10-30");
  await task(pos.id, "Store rollout runbook", null, "TODO", 40, "2026-11-20", "LOW");
  await task(pos.id, "Discovery workshops", "ACM0006", "DONE", 60, "2026-07-20");
  await task(fleet.id, "Shipment tracking map", "ACM0010", "IN_REVIEW", 120, "2026-09-25");
  await task(fleet.id, "Proof-of-delivery upload", "ACM0030", "IN_PROGRESS", 90, "2026-10-10");
  await task(fleet.id, "SSO with Bluefin AD", "ACM0029", "BLOCKED", 40, "2026-09-30", "URGENT");
  await task(support.id, "Monthly patch window", "ACM0017", "TODO", 16, "2026-10-12");
  await task(internal.id, "Postgres 17 upgrade", "ACM0006", "IN_PROGRESS", 80, "2026-10-15");
  await task(internal.id, "CI pipeline migration", "ACM0007", "TODO", 60, "2026-10-25");

  await prisma.milestone.createMany({ data: [
    { projectId: fleet.id, name: "Discovery & design sign-off", dueDate: d("2026-07-15"), status: "COMPLETED", completedOn: d("2026-07-14"), amount: 400000 },
    { projectId: fleet.id, name: "Beta with 3 depots", dueDate: d("2026-09-15"), status: "PENDING", amount: 900000 },
    { projectId: fleet.id, name: "Production launch", dueDate: d("2026-11-30"), status: "PENDING", amount: 1200000 },
    { projectId: pos.id, name: "Pilot in 5 stores", dueDate: d("2026-10-31"), status: "IN_PROGRESS" },
  ] });

  // Six weeks of time. Each person fills their allocation share of a 40-hour
  // week across the projects they are on, a little uneven day to day.
  const thisWeek = svc.weekStart(today());
  const weeks = Array.from({ length: 6 }, (_, i) => new Date(thisWeek.getTime() - (6 - i) * 7 * DAY));
  const people = [...new Set(alloc.map((a) => a[1]))];
  const pattern = [8, 8.5, 7.5, 8, 8];
  let sheets = 0;
  for (const num of people) {
    const mine = alloc.filter((a) => a[1] === num);
    for (const [w, week] of weeks.entries()) {
      const entries = [];
      for (const [projectId, , , pct] of mine) {
        const ownTask = (await prisma.task.findFirst({ where: { projectId, assigneeId: id(num), status: { not: "DONE" } }, select: { id: true } }))?.id ?? null;
        for (let day = 0; day < 5; day++) {
          const hours = Math.round(((pattern[(day + w) % 5] * pct) / 100) * 4) / 4;
          if (hours > 0) entries.push({ projectId, taskId: ownTask, date: new Date(week.getTime() + day * DAY), hours, description: null });
        }
      }
      if (entries.length === 0) continue;
      const last = w === weeks.length - 1;
      const r = await svc.saveTimesheet({ employeeId: id(num), week, entries, submit: true });
      if (!r.ok) throw new Error(`Timesheet for ${num}: ${r.message}`);
      sheets++;
      const managerOf = mine[0][0] === pos.id ? "ACM0005" : mine[0][0] === fleet.id ? "ACM0014" : mine[0][0] === support.id ? "ACM0023" : "ACM0004";
      if (last && ["ACM0009", "ACM0011", "ACM0030", "ACM0010"].includes(num)) continue; // waiting for the PM
      if (last && num === "ACM0029") {
        await svc.decideTimesheet({ timesheetId: r.timesheetId!, approve: false, byUserId: await userOf("ACM0005"), reason: "Split Friday between the POS and Fleet projects — it is all on POS." });
        continue;
      }
      await svc.decideTimesheet({ timesheetId: r.timesheetId!, approve: true, byUserId: await userOf(managerOf) });
    }
  }
  // Meera has started this week: a draft up to yesterday.
  const draftDays = Math.min(5, Math.max(0, Math.round((today().getTime() - thisWeek.getTime()) / DAY)));
  if (draftDays > 0) {
    await svc.saveTimesheet({ employeeId: id("ACM0009"), week: thisWeek, submit: false, entries: Array.from({ length: draftDays }, (_, i) => ({ projectId: pos.id, taskId: tasks["Till UI — checkout flow"], date: new Date(thisWeek.getTime() + i * DAY), hours: 8, description: "Checkout flow" })) });
    sheets++;
  }
  for (const p of [pos, fleet, support, internal]) await svc.refreshProjectHealth(p.id);

  // Invoices: rendered and filed the way the app does it.
  const storageDir = process.env.STORAGE_DIR ?? path.resolve(__dirname, "../../../../.storage");
  const save = (invoiceId: string) => async (pdf: Buffer, filename: string) => {
    const key = `${t}/${new Date().toISOString().slice(0, 7)}/${randomBytes(12).toString("hex")}`;
    mkdirSync(path.join(storageDir, path.dirname(key)), { recursive: true });
    writeFileSync(path.join(storageDir, key), pdf);
    const f = await prisma.storedFile.create({ data: { tenantId: t, filename, mimeType: "application/pdf", sizeBytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), storageKey: key, relatedType: "Invoice", relatedId: invoiceId } });
    return `/files/${f.id}`;
  };
  const firstWeek = weeks[0], midpoint = new Date(weeks[3].getTime() - DAY);
  // Dates are set before sending, because sending is what posts to the ledger.
  const issue = async (projectId: string, from: Date, to: Date, dated?: { issue: Date; due: Date }) => {
    const r = await svc.draftInvoice({ projectId, periodStart: from, periodEnd: to });
    if (!r.ok) throw new Error(`Invoice: ${r.message}`);
    if (dated) await prisma.invoice.update({ where: { id: r.invoiceId! }, data: { issueDate: dated.issue, dueDate: dated.due } });
    await svc.sendInvoice(r.invoiceId!, save(r.invoiceId!));
    return r.invoiceId!;
  };
  // Northwind: the first three weeks billed, half paid, now overdue.
  const nw = await issue(pos.id, firstWeek, midpoint, { issue: new Date(today().getTime() - 40 * DAY), due: new Date(today().getTime() - 10 * DAY) });
  const nwInv = await prisma.invoice.findUniqueOrThrow({ where: { id: nw } });
  await svc.recordInvoicePayment({ invoiceId: nw, amount: Math.round(Number(nwInv.total) / 2), paidOn: new Date(today().getTime() - 5 * DAY), reference: "UTR 4471 2209" });
  // Bluefin: the design milestone, paid in full.
  const bf = await issue(fleet.id, d("2026-07-01"), d("2026-07-31"), { issue: d("2026-07-20"), due: d("2026-08-19") });
  const bfInv = await prisma.invoice.findUniqueOrThrow({ where: { id: bf } });
  await svc.recordInvoicePayment({ invoiceId: bf, amount: Number(bfInv.total), paidOn: d("2026-08-14"), reference: "NEFT BFL-8812" });
  // Helix: September's retainer, an export — no GST.
  await issue(support.id, d("2026-09-01"), d("2026-09-30"), { issue: d("2026-09-30"), due: d("2026-10-30") });
  const overdue = await svc.markOverdueInvoices(t);

  return { clients: 3, projects: 4, allocations: alloc.length, timesheets: sheets, invoices: 3, overdue };
}
