import { prisma, Prisma } from "@keka/db";
import {
  capacityOf, estCost, estRevenue, funnel, marginPct, psaPctChange as pctChange, plannedHours, recognisedRevenue, retainerPeriods,
  utilisationBreakdown, type FinAllocation, type FunnelStage, type RecognitionMethod,
} from "./psa-math";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Read models for the PSA boards (Business overview, Financial overview and
 * the Resources summary) and the analytics tables, plus each user's widget
 * layout and the deterministic insights shown with or without AI.
 */

const DAY = 86_400_000;
const utc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ---- Project financials -------------------------------------------------------------

export interface ProjectFinancials {
  projectId: string; name: string; code: string | null; clientName: string | null; billingModel: string; status: string; health: string;
  estRevenue: number; estCost: number; estMargin: number | null; invoiced: number; incomeToDate: number; recognised: number;
  costToDate: number; unbilled: number; loggedHours: number; estimatedHours: number | null; method: RecognitionMethod;
}

/**
 * Estimated revenue, cost and margin, invoiced and recognised revenue, cost
 * to date and what is approved but unbilled, for every project matching
 * `where` (always within the tenant).
 */
export async function projectFinancials(tenantId: string, where: Prisma.ProjectWhereInput = {}, today = new Date()): Promise<ProjectFinancials[]> {
  const projects = await prisma.project.findMany({
    where: { ...where, tenantId },
    include: {
      client: { select: { name: true } },
      milestones: { select: { amount: true, status: true } },
      allocations: { select: { startDate: true, endDate: true, allocationPercent: true, billRate: true, costRate: true, isBillable: true, kind: true, employee: { select: { resourceProfile: { select: { capacity: true } } } } } },
    },
    orderBy: { name: "asc" },
  });
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const [entries, invoices, credits, claims] = await Promise.all([
    prisma.timeEntry.findMany({ where: { projectId: { in: ids } }, select: { projectId: true, hours: true, billRate: true, costRate: true, isBillable: true, isInvoiced: true, timesheet: { select: { status: true } } } }),
    prisma.invoice.findMany({ where: { tenantId, projectId: { in: ids }, kind: "TAX", status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { projectId: true, subtotal: true } }),
    prisma.creditNote.findMany({ where: { tenantId, status: "APPLIED", invoice: { projectId: { in: ids } } }, select: { amount: true, invoice: { select: { projectId: true } } } }),
    prisma.expenseClaim.findMany({ where: { tenantId, projectId: { in: ids }, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } }, select: { projectId: true, approvedTotal: true } }),
  ]);
  const sum = <T>(list: T[], key: (t: T) => string | null | undefined, val: (t: T) => number) => {
    const m = new Map<string, number>();
    for (const x of list) { const k = key(x); if (k) m.set(k, r2((m.get(k) ?? 0) + val(x))); }
    return m;
  };
  const approved = (e: (typeof entries)[number]) => ["APPROVED", "LOCKED"].includes(e.timesheet?.status ?? "");
  const logged = sum(entries, (e) => e.projectId, (e) => Number(e.hours));
  const costToDate = sum(entries, (e) => e.projectId, (e) => Number(e.hours) * Number(e.costRate ?? 0));
  const billedTime = sum(entries.filter((e) => e.isBillable && approved(e)), (e) => e.projectId, (e) => Number(e.hours) * Number(e.billRate ?? 0));
  const unbilledTime = sum(entries.filter((e) => e.isBillable && approved(e) && !e.isInvoiced), (e) => e.projectId, (e) => Number(e.hours) * Number(e.billRate ?? 0));
  const invoiced = sum(invoices, (i) => i.projectId, (i) => Number(i.subtotal));
  const credited = sum(credits, (c) => c.invoice?.projectId, (c) => Number(c.amount));
  const expenses = sum(claims, (c) => c.projectId, (c) => Number(c.approvedTotal));

  return projects.map((p) => {
    const fp = { billingModel: p.billingModel, startDate: p.startDate, endDate: p.endDate, budget: p.budget === null ? null : Number(p.budget), retainerFee: p.retainerFee === null ? null : Number(p.retainerFee), retainerFrequency: p.retainerFrequency, estimatedHours: p.estimatedHours === null ? null : Number(p.estimatedHours) };
    const allocs: FinAllocation[] = p.allocations.map((a) => ({ startDate: a.startDate, endDate: a.endDate, allocationPercent: Number(a.allocationPercent), billRate: a.billRate === null ? null : Number(a.billRate), costRate: a.costRate === null ? null : Number(a.costRate), isBillable: a.isBillable, kind: a.kind, capacity: capacityOf(a.employee.resourceProfile?.capacity) }));
    const rev = estRevenue(fp, allocs, p.milestones.map((m) => Number(m.amount ?? 0)));
    const cost = estCost(fp, allocs, expenses.get(p.id) ?? 0);
    const inv = r2((invoiced.get(p.id) ?? 0) - (credited.get(p.id) ?? 0));
    const done = p.milestones.filter((m) => ["COMPLETED", "INVOICED"].includes(m.status)).reduce((s, m) => s + Number(m.amount ?? 0), 0);
    const income = p.billingModel === "MILESTONE" ? done
      : p.billingModel === "RETAINER" ? (p.startDate ? (p.retainerFee ? Number(p.retainerFee) : 0) * retainerPeriods(p.startDate, new Date(Math.min(utc(today).getTime(), (p.endDate ?? today).getTime())), p.retainerFrequency) : 0)
      : p.billingModel === "NON_BILLABLE" ? 0 : billedTime.get(p.id) ?? 0;
    const unbilledMs = p.milestones.filter((m) => m.status === "COMPLETED").reduce((s, m) => s + Number(m.amount ?? 0), 0);
    const ctd = r2((costToDate.get(p.id) ?? 0) + (expenses.get(p.id) ?? 0));
    const hours = logged.get(p.id) ?? 0;
    return {
      projectId: p.id, name: p.name, code: p.code, clientName: p.client?.name ?? null, billingModel: p.billingModel, status: p.status, health: p.health,
      estRevenue: rev, estCost: cost, estMargin: marginPct(rev, cost), invoiced: inv, incomeToDate: r2(income),
      recognised: recognisedRevenue(p.revenueRecognition, { estRevenue: rev, estCost: cost, incomeToDate: income, invoiced: inv, costToDate: ctd, loggedHours: hours, estimatedHours: fp.estimatedHours }),
      costToDate: ctd, unbilled: r2((unbilledTime.get(p.id) ?? 0) + unbilledMs), loggedHours: hours, estimatedHours: fp.estimatedHours, method: p.revenueRecognition,
    };
  });
}

/** The four figures across the top of every PSA board. */
export function kpiStrip(fins: ProjectFinancials[]) {
  const live = fins.filter((f) => f.billingModel !== "NON_BILLABLE" && f.status !== "CANCELLED");
  const revenue = r2(live.reduce((s, f) => s + f.estRevenue, 0));
  const cost = r2(fins.filter((f) => f.status !== "CANCELLED").reduce((s, f) => s + f.estCost, 0));
  return { estRevenue: revenue, estCost: cost, invoiced: r2(fins.reduce((s, f) => s + f.invoiced, 0)), estMargin: marginPct(revenue, cost) };
}

// ---- Pipeline ---------------------------------------------------------------------------

export async function pipelineFunnel(tenantId: string, opts: { by?: "AMOUNT" | "COUNT"; sourceId?: string | null } = {}) {
  const [stages, opps] = await Promise.all([
    prisma.opportunityStage.findMany({ where: { tenantId, isActive: true }, orderBy: { sequence: "asc" } }),
    prisma.opportunity.findMany({ where: { tenantId, archivedAt: null, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) }, select: { stageId: true, estimatedRevenue: true, fxRate: true, sourceId: true } }),
  ]);
  return funnel(stages as FunnelStage[], opps.map((o) => ({ stageId: o.stageId, estimatedRevenue: Number(o.estimatedRevenue), fxRate: Number(o.fxRate) })), opts.by ?? "AMOUNT", true);
}

/** Open pipeline per client or prospect. */
export async function opportunityBreakup(tenantId: string, opts: { by?: "AMOUNT" | "COUNT"; of?: "CLIENT" | "PROSPECT"; sourceId?: string | null } = {}) {
  const opps = await prisma.opportunity.findMany({
    where: { tenantId, archivedAt: null, status: "OPEN", ...(opts.of === "PROSPECT" ? { prospectId: { not: null } } : { clientId: { not: null } }), ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) },
    select: { estimatedRevenue: true, fxRate: true, client: { select: { name: true } }, prospect: { select: { name: true } } },
  });
  const m = new Map<string, { amount: number; count: number }>();
  for (const o of opps) {
    const k = o.client?.name ?? o.prospect?.name ?? "—";
    const v = m.get(k) ?? { amount: 0, count: 0 };
    v.amount = r2(v.amount + Number(o.estimatedRevenue) * Number(o.fxRate)); v.count++;
    m.set(k, v);
  }
  return [...m].map(([name, v]) => ({ name, ...v, value: opts.by === "COUNT" ? v.count : v.amount })).sort((a, b) => b.value - a.value);
}

// ---- People ------------------------------------------------------------------------------

/** People on a live project (any allocation overlapping today or later). */
async function projectPeople(tenantId: string, today: Date) {
  const allocs = await prisma.resourceAllocation.findMany({
    where: { project: { tenantId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, kind: "HARD", OR: [{ endDate: null }, { endDate: { gte: today } }] },
    select: { employeeId: true, startDate: true, projectId: true },
  });
  return allocs;
}

/** Project members on approved leave in the next fortnight. */
export async function employeesOnLeave(tenantId: string, today = new Date(), days = 14) {
  const from = utc(today), to = new Date(from.getTime() + days * DAY);
  const ids = [...new Set((await projectPeople(tenantId, from)).map((a) => a.employeeId))];
  const leave = await prisma.leaveRequest.findMany({ where: { tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } }, select: { employeeId: true, fromDate: true, toDate: true }, orderBy: { fromDate: "asc" } });
  const people = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(leave.map((l) => l.employeeId))] } }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true } })).map((e) => [e.id, e]));
  return leave.flatMap((l) => { const e = people.get(l.employeeId); return e ? [{ id: `${e.id}:${l.fromDate.toISOString()}`, employeeId: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, title: e.jobTitleName, photoUrl: e.photoUrl, from: l.fromDate, to: l.toDate }] : []; });
}

/** Weeks not yet submitted (missing, draft or sent back) over the last eight, per allocated person. */
export async function pendingTimesheets(tenantId: string, today = new Date(), weeks = 8) {
  const t = utc(today);
  const thisMonday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY);
  const mondays = Array.from({ length: weeks }, (_, i) => new Date(thisMonday.getTime() - (weeks - i) * 7 * DAY));
  const allocs = await prisma.resourceAllocation.findMany({
    where: { project: { tenantId, status: { notIn: ["CANCELLED"] } }, kind: "HARD", startDate: { lte: thisMonday }, OR: [{ endDate: null }, { endDate: { gte: mondays[0] } }] },
    select: { employeeId: true, startDate: true, endDate: true },
  });
  const ids = [...new Set(allocs.map((a) => a.employeeId))];
  const sheets = await prisma.timesheet.findMany({ where: { tenantId, employeeId: { in: ids }, periodStart: { gte: mondays[0] } }, select: { employeeId: true, periodStart: true, status: true } });
  const done = new Set(sheets.filter((s) => ["SUBMITTED", "APPROVED", "LOCKED"].includes(s.status)).map((s) => `${s.employeeId}:${s.periodStart.getTime()}`));
  const people = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: ids }, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true } })).map((e) => [e.id, e]));
  const rows = ids.flatMap((id) => {
    const e = people.get(id);
    if (!e) return [];
    const mine = allocs.filter((a) => a.employeeId === id);
    const owed = mondays.filter((m) => mine.some((a) => a.startDate.getTime() <= m.getTime() + 6 * DAY && (!a.endDate || a.endDate >= m)) && !done.has(`${id}:${m.getTime()}`)).length;
    return owed ? [{ employeeId: id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, title: e.jobTitleName, photoUrl: e.photoUrl, count: owed }] : [];
  });
  return rows.sort((a, b) => b.count - a.count);
}

/** Who is holding what: submitted timesheets by their project manager, and raised project requests. */
export async function pendingApprovals(tenantId: string) {
  const sheets = await prisma.timesheet.findMany({ where: { tenantId, status: "SUBMITTED" }, select: { entries: { select: { hours: true, project: { select: { projectManagerId: true } } } } } });
  const byPm = new Map<string, number>();
  for (const s of sheets) {
    const hours = new Map<string, number>();
    for (const e of s.entries) if (e.project.projectManagerId) hours.set(e.project.projectManagerId, (hours.get(e.project.projectManagerId) ?? 0) + Number(e.hours));
    const top = [...hours].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top) byPm.set(top, (byPm.get(top) ?? 0) + 1);
  }
  const pms = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...byPm.keys()] } }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true } })).map((e) => [e.id, e]));
  const rows: Array<{ key: string; name: string; title: string | null; photoUrl: string | null; type: string; count: number }> = [...byPm].flatMap(([id, n]) => {
    const e = pms.get(id);
    return e ? [{ key: `ts:${id}`, name: e.displayName ?? `${e.firstName} ${e.lastName}`, title: e.jobTitleName, photoUrl: e.photoUrl, type: "Timesheet", count: n }] : [];
  });
  const requests = await prisma.projectRequest.count({ where: { tenantId, status: { in: ["NEW", "PENDING"] } } });
  if (requests) rows.push({ key: "pr", name: "Project admins", title: "Project requests", photoUrl: null, type: "Project Request", count: requests });
  return rows.sort((a, b) => b.count - a.count);
}

// ---- Utilisation -------------------------------------------------------------------------

export interface UtilBucket { label: string; from: Date; to: Date; capacity: number; planned: number; billable: number; nonBillable: number; leave: number; notLogged: number; pct: number }

/** Planned, billable, non-billable, leave and unlogged hours per week or month, for people on projects. */
export async function utilisationSeries(tenantId: string, from: Date, to: Date, bucket: "WEEK" | "MONTH" = "MONTH"): Promise<UtilBucket[]> {
  const a = utc(from), b = utc(to);
  const buckets: Array<{ label: string; from: Date; to: Date }> = [];
  if (bucket === "MONTH") {
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); ; m++) {
      const s = new Date(Date.UTC(y, m, 1));
      if (s > b) break;
      const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
      buckets.push({ label: s.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }), from: s < a ? a : s, to: e > b ? b : e });
    }
  } else {
    let s = new Date(a.getTime() - ((a.getUTCDay() + 6) % 7) * DAY);
    while (s <= b) {
      const e = new Date(s.getTime() + 6 * DAY);
      buckets.push({ label: s.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }), from: s, to: e > b ? b : e });
      s = new Date(s.getTime() + 7 * DAY);
    }
  }
  const allocs = await prisma.resourceAllocation.findMany({
    where: { project: { tenantId }, kind: "HARD", startDate: { lte: b }, OR: [{ endDate: null }, { endDate: { gte: a } }] },
    select: { employeeId: true, startDate: true, endDate: true, allocationPercent: true, employee: { select: { resourceProfile: { select: { capacity: true } } } } },
  });
  const people = new Map<string, { cap: number[]; allocs: typeof allocs }>();
  for (const x of allocs) {
    const p = people.get(x.employeeId) ?? { cap: capacityOf(x.employee.resourceProfile?.capacity), allocs: [] };
    p.allocs.push(x); people.set(x.employeeId, p);
  }
  const ids = [...people.keys()];
  const [entries, leaves] = await Promise.all([
    prisma.timeEntry.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: a, lte: b } }, select: { date: true, hours: true, isBillable: true } }),
    prisma.leaveRequestDay.findMany({ where: { request: { tenantId, employeeId: { in: ids }, status: "APPROVED" }, date: { gte: a, lte: b } }, select: { date: true, dayValue: true, request: { select: { employeeId: true } } } }),
  ]);
  return buckets.map((k) => {
    let capacity = 0, planned = 0;
    for (const p of people.values()) {
      const span = p.allocs.filter((x) => x.startDate <= k.to && (!x.endDate || x.endDate >= k.from));
      if (span.length === 0) continue;
      capacity += plannedHours(p.cap, k.from, k.to, 100);
      for (const x of span) {
        const s = x.startDate > k.from ? x.startDate : k.from, e = x.endDate && x.endDate < k.to ? x.endDate : k.to;
        planned += plannedHours(p.cap, s, e, Number(x.allocationPercent));
      }
    }
    const inK = (d: Date) => d >= k.from && d <= k.to;
    const billable = r2(entries.filter((e) => inK(e.date) && e.isBillable).reduce((s, e) => s + Number(e.hours), 0));
    const nonBillable = r2(entries.filter((e) => inK(e.date) && !e.isBillable).reduce((s, e) => s + Number(e.hours), 0));
    const leave = r2(leaves.filter((l) => inK(l.date)).reduce((s, l) => s + Number(l.dayValue) * 8, 0));
    const u = utilisationBreakdown({ capacity: r2(capacity), planned: r2(planned), billable, nonBillable, leave });
    return { label: k.label, from: k.from, to: k.to, ...u };
  });
}

/** Billable and non-billable hours against the plan, per project or per client. */
export async function utilisationByProject(tenantId: string, from: Date, to: Date, by: "PROJECT" | "CLIENT" = "PROJECT") {
  const entries = await prisma.timeEntry.findMany({ where: { tenantId, date: { gte: utc(from), lte: utc(to) } }, select: { hours: true, isBillable: true, project: { select: { name: true, client: { select: { name: true } } } } } });
  const m = new Map<string, { billable: number; nonBillable: number }>();
  for (const e of entries) {
    const k = by === "CLIENT" ? e.project.client?.name ?? "Internal" : e.project.name;
    const v = m.get(k) ?? { billable: 0, nonBillable: 0 };
    if (e.isBillable) v.billable = r2(v.billable + Number(e.hours)); else v.nonBillable = r2(v.nonBillable + Number(e.hours));
    m.set(k, v);
  }
  return [...m].map(([name, v]) => ({ name, ...v, total: r2(v.billable + v.nonBillable) })).sort((a, b) => b.total - a.total);
}

// ---- Finance -----------------------------------------------------------------------------

/** Approved project expenses by project (or client) and category over a window. */
export async function expensesByCategory(tenantId: string, from: Date, to: Date, by: "PROJECT" | "CLIENT" = "PROJECT") {
  const lines = await prisma.expenseClaimLine.findMany({
    where: { claim: { tenantId, projectId: { not: null }, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID", "PARTIALLY_APPROVED"] } }, expenseDate: { gte: utc(from), lte: utc(to) } },
    select: { amount: true, approvedAmount: true, category: { select: { name: true } }, claim: { select: { projectId: true } } },
  });
  const projects = new Map((await prisma.project.findMany({ where: { tenantId, id: { in: [...new Set(lines.map((l) => l.claim.projectId!))] } }, select: { id: true, name: true, client: { select: { name: true } } } })).map((p) => [p.id, p]));
  const cats = [...new Set(lines.map((l) => l.category.name))].sort();
  const groups = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const p = projects.get(l.claim.projectId!);
    if (!p) continue;
    const k = by === "CLIENT" ? p.client?.name ?? "Internal" : p.name;
    const g = groups.get(k) ?? new Map<string, number>();
    g.set(l.category.name, r2((g.get(l.category.name) ?? 0) + Number(l.approvedAmount ?? l.amount)));
    groups.set(k, g);
  }
  return { categories: cats, rows: [...groups].map(([name, g]) => ({ name, values: Object.fromEntries(g), total: r2([...g.values()].reduce((s, v) => s + v, 0)) })).sort((a, b) => b.total - a.total) };
}

export async function overdueInvoices(tenantId: string, take = 50) {
  return prisma.invoice.findMany({
    where: { tenantId, kind: "TAX", status: { in: ["OVERDUE", "SENT", "PARTIALLY_PAID"] }, dueDate: { lt: utc(new Date()) } },
    select: { id: true, invoiceNumber: true, issueDate: true, dueDate: true, amountDue: true, client: { select: { name: true } }, project: { select: { name: true } } },
    orderBy: { dueDate: "asc" }, take,
  });
}

// ---- Insights ------------------------------------------------------------------------------

export interface Insight { text: string; detail: string; tone: "info" | "watch" | "act"; href?: string }

const fmtRange = (a: Date, b: Date) => `${a.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })} to ${b.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })}`;

/**
 * Week-over-week changes that need no model: leave and billable hours,
 * overdue receivables, pipeline movement and urgent staffing requests.
 */
export async function deterministicInsights(tenantId: string, board: "BUSINESS" | "FINANCE" | "RESOURCES", today = new Date()): Promise<Insight[]> {
  const t = utc(today);
  const lastMonday = new Date(t.getTime() - (((t.getUTCDay() + 6) % 7) + 7) * DAY);
  const prevMonday = new Date(lastMonday.getTime() - 7 * DAY);
  const lastSunday = new Date(lastMonday.getTime() + 6 * DAY), prevSunday = new Date(prevMonday.getTime() + 6 * DAY);
  const period = `From previous to last week (${fmtRange(prevMonday, prevSunday)}) to last week (${fmtRange(lastMonday, lastSunday)})`;
  const out: Insight[] = [];
  const hours = async (from: Date, to: Date, billable: boolean) => Number((await prisma.timeEntry.aggregate({ where: { tenantId, isBillable: billable, date: { gte: from, lte: to } }, _sum: { hours: true } }))._sum.hours ?? 0);
  const leaveHours = async (from: Date, to: Date) => Number((await prisma.leaveRequestDay.aggregate({ where: { request: { tenantId, status: "APPROVED" }, date: { gte: from, lte: to } }, _sum: { dayValue: true } }))._sum.dayValue ?? 0) * 8;
  const change = (label: string, a: number, b: number, href?: string) => {
    const c = pctChange(a, b);
    if (c === null || Math.abs(c) < 5) return;
    out.push({ text: `${label} ${c > 0 ? "increased" : "decreased"} by ${Math.abs(c)}% since last week.`, detail: period, tone: Math.abs(c) >= 25 ? "watch" : "info", href });
  };
  if (board !== "FINANCE") {
    change("Leave Hours", await leaveHours(prevMonday, prevSunday), await leaveHours(lastMonday, lastSunday));
    change("Billable Hours", await hours(prevMonday, prevSunday, true), await hours(lastMonday, lastSunday, true));
    const setting = await prisma.psaSetting.findUnique({ where: { tenantId } });
    const critical = await prisma.resourceRequest.count({ where: { tenantId, status: "OPEN", startDate: { lte: new Date(t.getTime() + (setting?.criticalRequestDays ?? 10) * DAY) } } });
    if (critical) out.push({ text: `${critical} resource request${critical === 1 ? "" : "s"} must be staffed within ${setting?.criticalRequestDays ?? 10} days.`, detail: "Critical requests are open requests whose start is near.", tone: "act", href: "/projects/resources/requests?view=critical" });
  }
  if (board !== "RESOURCES") {
    const overdue = await prisma.invoice.aggregate({ where: { tenantId, kind: "TAX", status: { in: ["OVERDUE", "SENT", "PARTIALLY_PAID"] }, dueDate: { lt: t } }, _sum: { amountDue: true }, _count: true });
    if (overdue._count) out.push({ text: `₹${Number(overdue._sum.amountDue ?? 0).toLocaleString("en-IN")} is overdue across ${overdue._count} invoice${overdue._count === 1 ? "" : "s"}.`, detail: "Receivables past their due date.", tone: "act", href: "/projects/finances/invoices?view=due" });
    const [won, created] = await Promise.all([
      prisma.opportunity.count({ where: { tenantId, status: "WON", closedAt: { gte: new Date(t.getTime() - 30 * DAY) } } }),
      prisma.opportunity.count({ where: { tenantId, createdAt: { gte: new Date(t.getTime() - 30 * DAY) } } }),
    ]);
    if (won || created) out.push({ text: `${created} new opportunit${created === 1 ? "y" : "ies"} and ${won} won in the last 30 days.`, detail: "Pipeline movement.", tone: "info", href: "/projects/opportunities" });
  }
  return out;
}

// ---- Layouts ------------------------------------------------------------------------------

export type PsaBoard = "BUSINESS" | "FINANCE" | "RESOURCES";

export const PSA_WIDGETS: Record<PsaBoard, Array<{ id: string; title: string; column: "main" | "side" }>> = {
  BUSINESS: [
    { id: "counters", title: "Clients, projects and opportunities", column: "main" },
    { id: "funnel", title: "Opportunity funnel by amount / count", column: "main" },
    { id: "breakup", title: "Opportunity breakup by client or prospect", column: "main" },
    { id: "kpis", title: "Est. margin, revenue and cost", column: "side" },
    { id: "leave", title: "Employees on leave", column: "side" },
    { id: "timesheets", title: "Timesheets pending for submission", column: "side" },
    { id: "approvals", title: "Pending approvals", column: "side" },
    { id: "insights", title: "Insights", column: "side" },
  ],
  FINANCE: [
    { id: "expenses", title: "Expenses by project/client and category", column: "main" },
    { id: "funnel", title: "Opportunity funnel by stage", column: "main" },
    { id: "profitability", title: "Project profitability", column: "main" },
    { id: "kpis", title: "Est. margin, revenue and cost", column: "side" },
    { id: "overdue", title: "Overdue invoices", column: "side" },
    { id: "insights", title: "Insights", column: "side" },
  ],
  RESOURCES: [
    { id: "utilisation", title: "Utilisation & time spent over time", column: "main" },
    { id: "byproject", title: "Utilisation & time spent by project / client", column: "main" },
    { id: "actions", title: "Actions pending", column: "side" },
    { id: "insights", title: "Insights", column: "side" },
  ],
};

export interface WidgetState { id: string; settings?: Record<string, string | null> }

/** A user's widgets for a board, in order; the full default set when they have none. */
export async function boardLayout(tenantId: string, userId: string, board: PsaBoard): Promise<WidgetState[]> {
  const known = new Set(PSA_WIDGETS[board].map((w) => w.id));
  const row = await prisma.psaDashboardLayout.findUnique({ where: { userId_board: { userId, board } } });
  if (row && row.tenantId === tenantId && Array.isArray(row.widgets)) {
    const list = (row.widgets as unknown[]).flatMap((w) => (w && typeof w === "object" && typeof (w as WidgetState).id === "string" && known.has((w as WidgetState).id) ? [w as WidgetState] : []));
    return list.filter((w, i) => list.findIndex((x) => x.id === w.id) === i);
  }
  return PSA_WIDGETS[board].map((w) => ({ id: w.id }));
}

export async function saveBoardLayout(tenantId: string, userId: string, board: PsaBoard, widgets: WidgetState[]): Promise<{ ok: boolean; message: string }> {
  const known = new Set(PSA_WIDGETS[board].map((w) => w.id));
  const clean = widgets.filter((w, i) => known.has(w.id) && widgets.findIndex((x) => x.id === w.id) === i).map((w) => ({ id: w.id, ...(w.settings ? { settings: w.settings } : {}) }));
  await prisma.psaDashboardLayout.upsert({
    where: { userId_board: { userId, board } },
    create: { tenantId, userId, board, widgets: clean as Prisma.InputJsonValue },
    update: { widgets: clean as Prisma.InputJsonValue },
  });
  return { ok: true, message: "Dashboard saved." };
}
