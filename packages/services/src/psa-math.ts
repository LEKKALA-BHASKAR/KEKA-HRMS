/**
 * PSA arithmetic, without a database: capacity and planned hours, project
 * financials (estimated revenue, cost, margin and recognised revenue), rate
 * card markup, estimates, the opportunity funnel, utilisation, bench
 * availability, invoice status labels and CSV parsing for bulk import.
 *
 * Every definition here is the one written in the PSA spec, so the dashboard,
 * the project page and the reports all compute the same number.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Hours available Sunday..Saturday when a person has no resource profile. */
export const DEFAULT_CAPACITY = [0, 8, 8, 8, 8, 8, 0];

/** A stored capacity (JSON) as seven numbers, falling back to Mon–Fri 8h. */
export function capacityOf(raw: unknown): number[] {
  if (Array.isArray(raw) && raw.length === 7 && raw.every((h) => typeof h === "number" && h >= 0 && h <= 24)) return raw as number[];
  return DEFAULT_CAPACITY;
}

const utc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Hours of capacity between two dates (inclusive), at an allocation share,
 * skipping holidays. `to` null means open-ended, which plans nothing.
 */
export function plannedHours(capacity: number[], from: Date, to: Date | null, pct = 100, holidays: Set<string> = new Set()): number {
  if (!to) return 0;
  const a = utc(from), b = utc(to);
  if (b < a) return 0;
  let h = 0;
  for (let t = a; t <= b; t += DAY) {
    if (holidays.has(iso(t))) continue;
    h += capacity[new Date(t).getUTCDay()] ?? 0;
  }
  return r2((h * pct) / 100);
}

/** Working days (capacity > 0) between two dates, inclusive. */
export function workdays(from: Date, to: Date, capacity = DEFAULT_CAPACITY): number {
  const a = utc(from), b = utc(to);
  let n = 0;
  for (let t = a; t <= b; t += DAY) if ((capacity[new Date(t).getUTCDay()] ?? 0) > 0) n++;
  return n;
}

/** Overlap of [from, to] with a window, or null when they do not meet. */
export function clip(from: Date, to: Date | null, winFrom: Date, winTo: Date): { from: Date; to: Date } | null {
  const a = Math.max(utc(from), utc(winFrom)), b = Math.min(to ? utc(to) : utc(winTo), utc(winTo));
  return b < a ? null : { from: new Date(a), to: new Date(b) };
}

// ---- Project financials ----------------------------------------------------

export type BillingModelKey = "TIME_AND_MATERIAL" | "MILESTONE" | "RETAINER" | "NON_BILLABLE";

/** Retainer periods between two dates for a frequency (whole or partial). */
export function retainerPeriods(from: Date, to: Date, frequency: string | null | undefined): number {
  const days = Math.max(0, Math.round((utc(to) - utc(from)) / DAY) + 1);
  switch ((frequency ?? "MONTHLY").toUpperCase()) {
    case "DAILY": return days;
    case "WEEKLY": return Math.ceil(days / 7);
    case "BI_WEEKLY": return Math.ceil(days / 14);
    default: {
      const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
      return Math.max(0, months);
    }
  }
}

export interface FinAllocation { startDate: Date; endDate: Date | null; allocationPercent: number; billRate: number | null; costRate: number | null; isBillable: boolean; capacity?: number[]; kind?: "SOFT" | "HARD" }
export interface FinProject {
  billingModel: BillingModelKey; startDate: Date | null; endDate: Date | null; budget: number | null;
  retainerFee: number | null; retainerFrequency?: string | null; estimatedHours?: number | null;
}

/**
 * Estimated revenue: the budget when one is set; otherwise, by billing model,
 * planned hours × bill rate (T&M), the milestones' amounts (fixed fee), or
 * the retainer fee × periods.
 */
export function estRevenue(p: FinProject, allocations: FinAllocation[], milestoneAmounts: number[]): number {
  if (p.billingModel === "NON_BILLABLE") return 0;
  if (p.budget && p.budget > 0) return r2(p.budget);
  if (p.billingModel === "MILESTONE") return r2(milestoneAmounts.reduce((s, a) => s + a, 0));
  if (p.billingModel === "RETAINER") return p.startDate && p.endDate ? r2((p.retainerFee ?? 0) * retainerPeriods(p.startDate, p.endDate, p.retainerFrequency)) : 0;
  return r2(allocations.filter((a) => a.isBillable && (a.kind ?? "HARD") === "HARD").reduce((s, a) => {
    const end = a.endDate ?? p.endDate;
    return s + plannedHours(a.capacity ?? DEFAULT_CAPACITY, a.startDate, end, a.allocationPercent) * (a.billRate ?? 0);
  }, 0));
}

/** Estimated cost: planned hours × cost rate over the project, plus project expenses. */
export function estCost(p: FinProject, allocations: FinAllocation[], expenses = 0): number {
  return r2(allocations.filter((a) => (a.kind ?? "HARD") === "HARD").reduce((s, a) => {
    const end = a.endDate ?? p.endDate;
    return s + plannedHours(a.capacity ?? DEFAULT_CAPACITY, a.startDate, end, a.allocationPercent) * (a.costRate ?? 0);
  }, 0) + expenses);
}

/** Margin as a percentage of revenue; null without revenue. */
export function marginPct(revenue: number, cost: number): number | null {
  return revenue > 0 ? r2(((revenue - cost) / revenue) * 100) : null;
}

/** Rate card markup: what the bill rate adds over the suggested cost. */
export function markupPct(billRate: number, cost: number | null | undefined): number | null {
  return cost && cost > 0 ? r2(((billRate - cost) / cost) * 100) : null;
}

export type RecognitionMethod = "INCOME_TO_DATE" | "INVOICED_AMOUNT" | "COST_TO_COST" | "TIME_EXPENDED";

/**
 * Revenue recognised to date under the project's method, capped at the
 * estimated revenue (when there is one).
 */
export function recognisedRevenue(method: RecognitionMethod, a: {
  estRevenue: number; estCost: number; incomeToDate: number; invoiced: number; costToDate: number; loggedHours: number; estimatedHours: number | null;
}): number {
  let v: number;
  switch (method) {
    case "INVOICED_AMOUNT": v = a.invoiced; break;
    case "COST_TO_COST": v = a.estCost > 0 ? a.estRevenue * (a.costToDate / a.estCost) : 0; break;
    case "TIME_EXPENDED": v = a.estimatedHours && a.estimatedHours > 0 ? a.estRevenue * (a.loggedHours / a.estimatedHours) : 0; break;
    default: v = a.incomeToDate;
  }
  return r2(a.estRevenue > 0 ? Math.min(v, a.estRevenue) : v);
}

export const RECOGNITION_LABEL: Record<RecognitionMethod, string> = {
  INCOME_TO_DATE: "Income to date",
  INVOICED_AMOUNT: "Invoiced amount",
  COST_TO_COST: "Revenue based on cost (cost-to-cost method)",
  TIME_EXPENDED: "Revenue based on time (time-expended method)",
};

export const BILLING_LABEL: Record<string, string> = {
  TIME_AND_MATERIAL: "Time And Materials", MILESTONE: "Fixed Fee", RETAINER: "Retainer", NON_BILLABLE: "Non Billable",
};

// ---- Estimates -------------------------------------------------------------

export interface EstimateLineInput {
  kind: "PHASE" | "TASK" | "MILESTONE" | "ROLE"; startDate: Date | null; endDate: Date | null;
  headcount: number; allocationPercent: number; hours: number; billRate: number; costRate: number; amount: number;
}

/**
 * A line's hours, billing and cost. A role line's hours come from its dates
 * (workdays × 8 × allocation × headcount); a task carries its own hours; a
 * milestone bills its amount; a phase is a heading.
 */
export function estimateLine(l: EstimateLineInput): { hours: number; amount: number; cost: number } {
  if (l.kind === "PHASE") return { hours: 0, amount: 0, cost: 0 };
  if (l.kind === "MILESTONE") return { hours: 0, amount: r2(l.amount), cost: 0 };
  const hours = l.kind === "ROLE"
    ? (l.startDate && l.endDate ? r2(workdays(l.startDate, l.endDate) * 8 * (l.allocationPercent / 100) * Math.max(1, l.headcount)) : 0)
    : r2(l.hours);
  return { hours, amount: r2(hours * l.billRate), cost: r2(hours * l.costRate) };
}

export function estimateTotals(lines: EstimateLineInput[]): { hours: number; billing: number; cost: number; margin: number | null; start: Date | null; end: Date | null } {
  let hours = 0, billing = 0, cost = 0, start: number | null = null, end: number | null = null;
  for (const l of lines) {
    const v = estimateLine(l);
    hours += v.hours; billing += v.amount; cost += v.cost;
    if (l.startDate) start = start === null ? utc(l.startDate) : Math.min(start, utc(l.startDate));
    if (l.endDate) end = end === null ? utc(l.endDate) : Math.max(end, utc(l.endDate));
  }
  return { hours: r2(hours), billing: r2(billing), cost: r2(cost), margin: marginPct(billing, cost), start: start === null ? null : new Date(start), end: end === null ? null : new Date(end) };
}

// ---- Pipeline --------------------------------------------------------------

export interface FunnelStage { id: string; name: string; color: string; kind: "OPEN" | "WON" | "LOST"; sequence: number; winProbability: number }
export interface FunnelOpp { stageId: string; estimatedRevenue: number; fxRate: number; sourceId?: string | null }

/** Value or count per stage in sequence order, with the probability-weighted value. */
export function funnel(stages: FunnelStage[], opps: FunnelOpp[], by: "AMOUNT" | "COUNT" = "AMOUNT", includeLost = false) {
  return [...stages].sort((a, b) => a.sequence - b.sequence).filter((s) => includeLost || s.kind !== "LOST").map((s) => {
    const mine = opps.filter((o) => o.stageId === s.id);
    const amount = r2(mine.reduce((t, o) => t + o.estimatedRevenue * o.fxRate, 0));
    return { stageId: s.id, name: s.name, color: s.color, kind: s.kind, count: mine.length, amount, value: by === "COUNT" ? mine.length : amount, weighted: r2((amount * s.winProbability) / 100) };
  });
}

/** Expected project start may not precede the opportunity's start, and the close follows the start. */
export function checkOpportunityDates(o: { startDate: Date; closeDate: Date; expectedProjectStart: Date; expectedProjectEnd: Date | null }): string[] {
  const out: string[] = [];
  if (utc(o.closeDate) < utc(o.startDate)) out.push("The close date is before the opportunity start date.");
  if (utc(o.expectedProjectStart) < utc(o.startDate)) out.push("Expected project start date cannot be smaller than opportunity start date.");
  if (o.expectedProjectEnd && utc(o.expectedProjectEnd) < utc(o.expectedProjectStart)) out.push("The expected project end is before its start.");
  return out;
}

// ---- Resourcing ------------------------------------------------------------

/**
 * The highest total HARD allocation on any working day in a window, per
 * person; the bench is everyone below 100%, available by the difference.
 */
export function peakLoad(allocs: Array<{ startDate: Date; endDate: Date | null; allocationPercent: number; kind?: string }>, from: Date, to: Date, capacity = DEFAULT_CAPACITY): number {
  let peak = 0;
  for (let t = utc(from); t <= utc(to); t += DAY) {
    if ((capacity[new Date(t).getUTCDay()] ?? 0) === 0) continue;
    const load = allocs.filter((a) => (a.kind ?? "HARD") === "HARD" && utc(a.startDate) <= t && (!a.endDate || utc(a.endDate) >= t)).reduce((s, a) => s + a.allocationPercent, 0);
    peak = Math.max(peak, load);
  }
  return r2(peak);
}

/** A request is critical when still open and wanted within the window. */
export function isCritical(r: { status: string; startDate: Date }, today: Date, windowDays = 10): boolean {
  return r.status === "OPEN" && utc(r.startDate) <= utc(today) + windowDays * DAY;
}

/** Whole years between two dates. */
export function wholeYearsBetween(from: Date, to: Date): number {
  let y = to.getUTCFullYear() - from.getUTCFullYear();
  if (to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())) y--;
  return Math.max(0, y);
}

/** An hourly cost from what the cost-and-capacity screen stores. */
export function hourlyCost(costType: string | null | undefined, amount: number | null | undefined, capacity = DEFAULT_CAPACITY): number | null {
  if (!amount || amount <= 0) return null;
  const weekly = capacity.reduce((s, h) => s + h, 0);
  if (costType === "HOURLY") return r2(amount);
  if (weekly <= 0) return null;
  if (costType === "MONTHLY") return r2((amount * 12) / (weekly * 52));
  if (costType === "ANNUAL") return r2(amount / (weekly * 52));
  return null;
}

/**
 * Utilisation over a window: billable hours over the hours a person was
 * available (capacity less leave); "not logged" is what remains.
 */
export function utilisationBreakdown(a: { capacity: number; planned: number; billable: number; nonBillable: number; leave: number }) {
  const available = Math.max(0, a.capacity - a.leave);
  const notLogged = Math.max(0, r2(available - a.billable - a.nonBillable));
  return { ...a, notLogged, pct: available > 0 ? r2((a.billable / available) * 100) : 0 };
}

// ---- Invoices ----------------------------------------------------------------

export function daysBetweenUtc(a: Date, b: Date): number {
  return Math.round((utc(b) - utc(a)) / DAY);
}

/** Keka's invoice status line: "Overdue 57 days", "Due in 16 days", "Partially Paid", "Paid (Write Off)", "Cancelled". */
export function invoiceStatusLabel(inv: { status: string; dueDate: Date; amountDue: number; kind?: string }, today: Date): { text: string; tone: "danger" | "success" | "warning" | "neutral" | "info" } {
  if (inv.kind === "PROFORMA") return { text: inv.status === "DRAFT" ? "Draft" : inv.status === "CANCELLED" ? "Cancelled" : "Sent", tone: inv.status === "DRAFT" ? "neutral" : "info" };
  switch (inv.status) {
    case "PAID": return { text: "Paid", tone: "success" };
    case "WRITTEN_OFF": return { text: "Paid (Write Off)", tone: "success" };
    case "CANCELLED": return { text: "Cancelled", tone: "danger" };
    case "DRAFT": return { text: "Draft", tone: "neutral" };
    case "PARTIALLY_PAID": {
      const late = daysBetweenUtc(inv.dueDate, today);
      return late > 0 ? { text: `Overdue ${late} days`, tone: "danger" } : { text: "Partially Paid", tone: "warning" };
    }
    default: {
      const late = daysBetweenUtc(inv.dueDate, today);
      if (late > 0) return { text: `Overdue ${late} days`, tone: "danger" };
      if (late === 0) return { text: "Due today", tone: "warning" };
      return { text: `Due in ${-late} days`, tone: "neutral" };
    }
  }
}

/** Percentage change, for the deterministic insights. Null without a base. */
export function psaPctChange(prev: number, cur: number): number | null {
  return prev > 0 ? r2(((cur - prev) / prev) * 100) : null;
}

// ---- CSV --------------------------------------------------------------------

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row.map((v) => v.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row.map((v) => v.trim()));
  return rows;
}

/** A CSV field, quoted when it needs to be. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** dd/mm/yyyy, dd-mm-yyyy or yyyy-mm-dd as a UTC date. */
export function parseLooseDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s.trim());
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}
