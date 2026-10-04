import type { StructureComponentSpec } from "@keka/payroll";
import { payrollJournal, DEFAULT_CHART, type PayLine } from "./accounting-math";
import { parseCsv } from "./import-math";

/**
 * Pure rules behind the payroll depth features: component overrides, wages
 * paid by units, the customisable pay register, variance and reconciliation,
 * the journal voucher, statutory bonus, tax-window overrides, declaration
 * imports, contractor TDS, loan-policy assignment, budget projections and
 * the compliance checks. No database here, so every rule is unit-tested.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const ym = (y: number, m: number) => y * 12 + (m - 1);

// ---------------------------------------------------------------------------
//  1. Per-employee component overrides
// ---------------------------------------------------------------------------

export interface OverrideRow {
  id: string;
  componentId: string;
  monthlyAmount: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** The override in force for each component in a pay period: the latest one that started on or before the period's end. */
export function activeOverrides<T extends OverrideRow>(rows: T[], periodStart: Date, periodEnd: Date): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    if (r.effectiveFrom > periodEnd) continue;
    if (r.effectiveTo && r.effectiveTo < periodStart) continue;
    const cur = out.get(r.componentId);
    if (!cur || r.effectiveFrom > cur.effectiveFrom) out.set(r.componentId, r);
  }
  return out;
}

export interface OverrideComponent {
  code: string; name: string; type: StructureComponentSpec["type"]; displayOrder: number;
  isOutsideCtc: boolean; isLopApplicable: boolean; affectsPfWage: boolean; affectsEsiGross: boolean; showOnPayslip: boolean; isPartOfFbp: boolean;
}

/**
 * Apply fixed monthly overrides to a structure: a component already in the
 * structure becomes FIXED at the override; one that is not is added.
 */
export function applyComponentOverrides(specs: StructureComponentSpec[], overrides: Array<{ component: OverrideComponent; monthlyAmount: number }>): StructureComponentSpec[] {
  const out = specs.map((s) => ({ ...s }));
  for (const o of overrides) {
    const i = out.findIndex((s) => s.code.toUpperCase() === o.component.code.toUpperCase());
    if (i >= 0) {
      out[i] = { ...out[i], calculationType: "FIXED", fixedAmount: o.monthlyAmount, formula: null, percentage: null, percentageOf: null, minAmount: null, maxAmount: null };
    } else {
      const c = o.component;
      out.push({
        code: c.code, name: c.name, type: c.type, calculationType: "FIXED", fixedAmount: o.monthlyAmount, sequence: c.displayOrder,
        isOutsideCtc: c.isOutsideCtc, isLopApplicable: c.isLopApplicable, affectsPfWage: c.affectsPfWage, affectsEsiGross: c.affectsEsiGross,
        showOnPayslip: c.showOnPayslip, isPartOfFbp: c.isPartOfFbp,
      });
    }
  }
  return out;
}

/** First and last day of a "YYYY-MM" month, or null when it is not one. */
export function monthBounds(value: string): { start: Date; end: Date; year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 0)), year, month };
}

// ---------------------------------------------------------------------------
//  3. Wages paid by units
// ---------------------------------------------------------------------------

export type WageType = "DAILY" | "HOURLY" | "PIECE_RATE";

/** The remuneration type a revision pays on, or null for monthly salary. */
export function wageTypeOf(revision: { remunerationType: string; rate: number | null; structureType?: string | null } | null | undefined): WageType | null {
  if (!revision || !revision.rate || revision.rate <= 0) return null;
  if (revision.remunerationType === "DAILY" || revision.remunerationType === "HOURLY" || revision.remunerationType === "PIECE_RATE") return revision.remunerationType;
  if (revision.structureType === "DAILY_WAGE") return "DAILY";
  return null;
}

const PAYABLE_DAY_STATUSES = new Set(["PRESENT", "HALF_DAY", "ON_LEAVE", "ON_DUTY", "WORK_FROM_HOME"]);

/**
 * Units from attendance: payable days for daily wages (days worked or on
 * paid leave, never weekly offs or gaps) and effective hours for hourly
 * pay. Piece-rate units are always entered by hand.
 */
export function unitsFromAttendance(type: WageType, records: Array<{ status: string; payableValue: number; lopValue: number; effectiveHours: number }>): number {
  if (type === "PIECE_RATE") return 0;
  if (type === "HOURLY") return r2(records.reduce((s, r) => s + (r.effectiveHours > 0 ? r.effectiveHours : 0), 0));
  return r2(records.reduce((s, r) => s + (PAYABLE_DAY_STATUSES.has(r.status) ? Math.max(0, Math.min(1, r.payableValue - r.lopValue)) : 0), 0));
}

/** Split a run of no-attendance days between the leave balance and loss of pay. */
export function splitDeduction(days: number, available: number): { leave: number; lop: number } {
  const leave = Math.max(0, Math.min(days, Math.floor(Math.max(0, available) * 2) / 2));
  return { leave, lop: r2(days - leave) };
}

// ---------------------------------------------------------------------------
//  4. Pay register columns
// ---------------------------------------------------------------------------

/** Optional columns an administrator may show, hide and order. */
export const REGISTER_COLUMNS: Array<{ key: string; label: string; group: string }> = [
  { key: "department", label: "Department", group: "Employee" },
  { key: "designation", label: "Designation", group: "Employee" },
  { key: "location", label: "Location", group: "Employee" },
  { key: "state", label: "State", group: "Employee" },
  { key: "doj", label: "Date of joining", group: "Employee" },
  { key: "pan", label: "PAN", group: "Employee" },
  { key: "uan", label: "UAN", group: "Employee" },
  { key: "bank", label: "Bank account", group: "Employee" },
  { key: "ctc", label: "Annual CTC", group: "Pay" },
  { key: "totalDays", label: "Total days", group: "Attendance" },
  { key: "lopDays", label: "LOP days", group: "Attendance" },
  { key: "earnings", label: "Earnings (each component)", group: "Pay" },
  { key: "gross", label: "Gross earnings", group: "Pay" },
  { key: "deductions", label: "Deductions (each component)", group: "Pay" },
  { key: "totalDeductions", label: "Total deductions", group: "Pay" },
  { key: "net", label: "Net pay", group: "Pay" },
  { key: "pfWage", label: "PF wage", group: "Statutory" },
  { key: "pfEmployee", label: "PF employee", group: "Statutory" },
  { key: "pfEmployer", label: "PF employer", group: "Statutory" },
  { key: "eps", label: "EPS", group: "Statutory" },
  { key: "esiGross", label: "ESI gross", group: "Statutory" },
  { key: "esiEmployee", label: "ESI employee", group: "Statutory" },
  { key: "esiEmployer", label: "ESI employer", group: "Statutory" },
  { key: "pt", label: "Professional tax", group: "Statutory" },
  { key: "lwf", label: "LWF employee", group: "Statutory" },
  { key: "tds", label: "TDS", group: "Statutory" },
  { key: "employerCost", label: "Employer cost", group: "Pay" },
  { key: "payAction", label: "Pay action", group: "Pay" },
];

export const DEFAULT_REGISTER_LAYOUT = ["department", "state", "totalDays", "lopDays", "earnings", "gross", "deductions", "totalDeductions", "net", "pfWage", "pfEmployee", "pfEmployer", "eps", "esiGross", "esiEmployee", "esiEmployer", "pt", "lwf", "tds", "employerCost", "payAction"];

const KNOWN = new Set(REGISTER_COLUMNS.map((c) => c.key));

/** A saved layout, cleaned: known keys only, no repeats; the default when empty. Payable days and the components cannot be removed. */
export function registerLayout(saved: unknown): string[] {
  const list = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string" && KNOWN.has(k)) : [];
  const unique = [...new Set(list)];
  if (unique.length === 0) return [...DEFAULT_REGISTER_LAYOUT];
  for (const fixed of ["earnings", "deductions"]) if (!unique.includes(fixed)) unique.push(fixed);
  return unique;
}

export interface RegisterColumn { key: string; label: string; numeric: boolean; code?: string }

/** The register's columns in order: employee number and name, payable days, then the layout with components expanded. */
export function registerColumns(layout: string[], earnings: Array<[string, string]>, deductions: Array<[string, string]>): RegisterColumn[] {
  const label = new Map(REGISTER_COLUMNS.map((c) => [c.key, c.label]));
  const textKeys = new Set(["department", "designation", "location", "state", "doj", "pan", "uan", "bank", "payAction"]);
  const out: RegisterColumn[] = [
    { key: "employeeNumber", label: "Employee Number", numeric: false },
    { key: "name", label: "Employee Name", numeric: false },
    { key: "payableDays", label: "Payable Days", numeric: true },
  ];
  for (const k of layout) {
    if (k === "earnings") for (const [code, name] of earnings) out.push({ key: `c:${code}`, label: name, numeric: true, code });
    else if (k === "deductions") for (const [code, name] of deductions) out.push({ key: `c:${code}`, label: name, numeric: true, code });
    else out.push({ key: k, label: label.get(k) ?? k, numeric: !textKeys.has(k) });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  5. Variance, reconciliation, journal voucher
// ---------------------------------------------------------------------------

export interface PeriodLine {
  employeeId: string; employeeNumber: string; name: string; department: string;
  gross: number; deductions: number; net: number; employerCost: number;
  components: Array<{ code: string; name: string; type: string; amount: number }>;
}

/** Percentage change, as a fraction; null when there is no base. */
export function variancePct(prev: number, curr: number): number | null {
  if (Math.abs(prev) < 0.005) return Math.abs(curr) < 0.005 ? 0 : null;
  return (curr - prev) / Math.abs(prev);
}

export interface EmployeeVariance {
  employeeId: string; employeeNumber: string; name: string; department: string; status: "JOINED" | "LEFT" | "CONTINUING";
  prevGross: number; currGross: number; grossChange: number; grossPct: number | null;
  prevNet: number; currNet: number; netChange: number; netPct: number | null;
  /** Components that moved, biggest first. */
  movers: Array<{ code: string; name: string; prev: number; curr: number; change: number; pct: number | null }>;
}

export function employeeVariance(prev: PeriodLine[], curr: PeriodLine[]): EmployeeVariance[] {
  const p = new Map(prev.map((l) => [l.employeeId, l]));
  const c = new Map(curr.map((l) => [l.employeeId, l]));
  const ids = [...new Set([...p.keys(), ...c.keys()])];
  const rows = ids.map((id) => {
    const a = p.get(id), b = c.get(id);
    const who = (b ?? a)!;
    const codes = new Map<string, string>();
    for (const x of [...(a?.components ?? []), ...(b?.components ?? [])]) if (x.type !== "EMPLOYER_CONTRIBUTION" && x.type !== "PERK") codes.set(x.code, x.name);
    const amt = (l: PeriodLine | undefined, code: string) => (l?.components ?? []).filter((x) => x.code === code).reduce((s, x) => s + x.amount, 0);
    const movers = [...codes.entries()]
      .map(([code, name]) => { const pv = amt(a, code), cv = amt(b, code); return { code, name, prev: r2(pv), curr: r2(cv), change: r2(cv - pv), pct: variancePct(pv, cv) }; })
      .filter((m) => Math.abs(m.change) >= 0.01)
      .sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
    const prevGross = a?.gross ?? 0, currGross = b?.gross ?? 0, prevNet = a?.net ?? 0, currNet = b?.net ?? 0;
    return {
      employeeId: id, employeeNumber: who.employeeNumber, name: who.name, department: who.department,
      status: (!a ? "JOINED" : !b ? "LEFT" : "CONTINUING") as EmployeeVariance["status"],
      prevGross: r2(prevGross), currGross: r2(currGross), grossChange: r2(currGross - prevGross), grossPct: variancePct(prevGross, currGross),
      prevNet: r2(prevNet), currNet: r2(currNet), netChange: r2(currNet - prevNet), netPct: variancePct(prevNet, currNet),
      movers,
    };
  });
  return rows.sort((x, y) => Math.abs(y.grossChange) - Math.abs(x.grossChange) || x.employeeNumber.localeCompare(y.employeeNumber));
}

export interface ComponentVariance { code: string; name: string; type: string; prev: number; curr: number; change: number; pct: number | null; prevCount: number; currCount: number }

export function componentVariance(prev: PeriodLine[], curr: PeriodLine[]): ComponentVariance[] {
  const by = new Map<string, ComponentVariance>();
  const add = (lines: PeriodLine[], side: "prev" | "curr") => {
    for (const l of lines) for (const x of l.components) {
      const r = by.get(x.code) ?? { code: x.code, name: x.name, type: x.type, prev: 0, curr: 0, change: 0, pct: null, prevCount: 0, currCount: 0 };
      r[side] += x.amount;
      if (side === "prev") r.prevCount++; else r.currCount++;
      by.set(x.code, r);
    }
  };
  add(prev, "prev"); add(curr, "curr");
  const order = { EARNING: 0, REIMBURSEMENT: 1, DEDUCTION: 2, EMPLOYER_CONTRIBUTION: 3, PERK: 4 } as Record<string, number>;
  return [...by.values()]
    .map((r) => ({ ...r, prev: r2(r.prev), curr: r2(r.curr), change: r2(r.curr - r.prev), pct: variancePct(r.prev, r.curr) }))
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || Math.abs(b.change) - Math.abs(a.change));
}

export interface ReconStep { label: string; count: number; amount: number; kind: "opening" | "movement" | "closing" | "check" }

/**
 * Reconcile last month's gross to this month's: opening, what joiners add,
 * what leavers take away, the movement on each component for people in
 * both months, closing — and the closing must equal this month's total.
 */
export function grossReconciliation(prev: PeriodLine[], curr: PeriodLine[]): { steps: ReconStep[]; difference: number } {
  const p = new Map(prev.map((l) => [l.employeeId, l]));
  const c = new Map(curr.map((l) => [l.employeeId, l]));
  const opening = prev.reduce((s, l) => s + l.gross, 0);
  const joiners = curr.filter((l) => !p.has(l.employeeId));
  const leavers = prev.filter((l) => !c.has(l.employeeId));
  const steps: ReconStep[] = [{ label: "Previous month gross", count: prev.length, amount: r2(opening), kind: "opening" }];
  steps.push({ label: "Add: new joiners", count: joiners.length, amount: r2(joiners.reduce((s, l) => s + l.gross, 0)), kind: "movement" });
  steps.push({ label: "Less: exits", count: leavers.length, amount: r2(-leavers.reduce((s, l) => s + l.gross, 0)), kind: "movement" });
  const both = curr.filter((l) => p.has(l.employeeId));
  const grossTypes = new Set(["EARNING", "REIMBURSEMENT"]);
  const comp = componentVariance(both.map((l) => p.get(l.employeeId)!), both).filter((v) => grossTypes.has(v.type) && Math.abs(v.change) >= 0.01);
  for (const v of comp) steps.push({ label: `Change in ${v.name}`, count: Math.max(v.prevCount, v.currCount), amount: v.change, kind: "movement" });
  const computed = steps.reduce((s, x) => s + x.amount, 0);
  const actual = curr.reduce((s, l) => s + l.gross, 0);
  steps.push({ label: "This month gross", count: curr.length, amount: r2(actual), kind: "closing" });
  return { steps, difference: r2(actual - computed) };
}

/** Integrity checks inside one run: header totals against employee rows, and rows against their payslip lines. */
export function runIntegrity(run: { gross: number; deductions: number; net: number }, rows: Array<{ employeeNumber: string; gross: number; deductions: number; net: number; lines: Array<{ type: string; amount: number }>; skipped: boolean }>): ReconStep[] {
  const live = rows.filter((r) => !r.skipped);
  const sum = (f: (r: (typeof live)[number]) => number) => r2(live.reduce((s, r) => s + f(r), 0));
  const out: ReconStep[] = [
    { label: "Run gross vs employee rows", count: live.length, amount: r2(run.gross - sum((r) => r.gross)), kind: "check" },
    { label: "Run deductions vs employee rows", count: live.length, amount: r2(run.deductions - sum((r) => r.deductions)), kind: "check" },
    { label: "Run net vs employee rows", count: live.length, amount: r2(run.net - sum((r) => r.net)), kind: "check" },
  ];
  const bad = live.filter((r) => {
    const g = r.lines.filter((l) => l.type === "EARNING" || l.type === "REIMBURSEMENT").reduce((s, l) => s + l.amount, 0);
    const d = r.lines.filter((l) => l.type === "DEDUCTION").reduce((s, l) => s + l.amount, 0);
    return Math.abs(g - r.gross) > 0.01 || Math.abs(d - r.deductions) > 0.01 || Math.abs(r.gross - r.deductions - r.net) > 0.01;
  });
  out.push({ label: "Employees whose payslip lines do not add up", count: bad.length, amount: 0, kind: "check" });
  return out;
}

export interface JvRow { accountCode: string; accountName: string; debit: number; credit: number; narration: string; costCenter: string }

/**
 * The payroll journal voucher: the same postings the ledger uses, with any
 * component mapped to its own GL account moved there, optionally split by
 * cost centre (department).
 */
export function journalVoucher(groups: Array<{ costCenter: string; lines: PayLine[] }>, mappings: Array<{ componentCode: string; accountCode: string; accountName: string }>): { rows: JvRow[]; debit: number; credit: number; balanced: boolean } {
  const chart = new Map(DEFAULT_CHART.map((a) => [a.code, a.name]));
  const map = new Map(mappings.map((m) => [m.componentCode.toUpperCase(), m]));
  const rows: JvRow[] = [];
  for (const g of groups) {
    const base = payrollJournal(g.lines).postings.map((p) => ({ ...p }));
    const byCode = new Map<string, { type: string; amount: number }>();
    for (const l of g.lines) {
      const m = map.get(l.code.toUpperCase());
      if (!m || !(l.amount > 0) || (l.type !== "EARNING" && l.type !== "REIMBURSEMENT" && l.type !== "DEDUCTION")) continue;
      const cur = byCode.get(l.code.toUpperCase()) ?? { type: l.type, amount: 0 };
      cur.amount += l.amount;
      byCode.set(l.code.toUpperCase(), cur);
    }
    const extra: Array<{ accountCode: string; accountName: string; debit: number; credit: number; narration: string }> = [];
    for (const [code, v] of byCode) {
      const m = map.get(code)!;
      const solo = payrollJournal([{ type: v.type, code, amount: v.amount }]).postings.find((p) => p.accountCode !== "2100");
      if (!solo) continue;
      const target = base.find((p) => p.accountCode === solo.accountCode);
      if (!target) continue;
      if (v.type === "DEDUCTION") { target.credit = r2(target.credit - v.amount); extra.push({ accountCode: m.accountCode, accountName: m.accountName, debit: 0, credit: r2(v.amount), narration: code }); }
      else { target.debit = r2(target.debit - v.amount); extra.push({ accountCode: m.accountCode, accountName: m.accountName, debit: r2(v.amount), credit: 0, narration: code }); }
    }
    for (const p of base) if (p.debit > 0.004 || p.credit > 0.004) rows.push({ accountCode: p.accountCode, accountName: chart.get(p.accountCode) ?? p.narration ?? p.accountCode, debit: r2(p.debit), credit: r2(p.credit), narration: p.narration ?? "", costCenter: g.costCenter });
    for (const e of extra) rows.push({ ...e, costCenter: g.costCenter });
  }
  const debit = r2(rows.reduce((s, r) => s + r.debit, 0)), credit = r2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, debit, credit, balanced: Math.abs(debit - credit) < 0.01 };
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** CSV with a BOM, so spreadsheet tools (Excel included) open it with the right encoding. */
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
//  6. Statutory bonus and gratuity settings
// ---------------------------------------------------------------------------

export interface BonusConfig {
  eligibilityCeiling: number; calculationCeiling: number; minimumWage: number | null; percent: number; minWorkingDays: number;
}

export function bonusConfigIssues(c: BonusConfig): string[] {
  const out: string[] = [];
  if (!(c.percent >= 8.33 && c.percent <= 20)) out.push("The bonus rate must be between 8.33% and 20% under the Payment of Bonus Act");
  if (!(c.eligibilityCeiling > 0)) out.push("Enter the eligibility wage ceiling");
  if (!(c.calculationCeiling > 0)) out.push("Enter the calculation ceiling");
  if (c.minimumWage !== null && c.minimumWage < 0) out.push("The minimum wage cannot be negative");
  if (!(c.minWorkingDays >= 0 && c.minWorkingDays <= 366)) out.push("Minimum working days must be between 0 and 366");
  return out;
}

export interface BonusMonth { year: number; month: number; wage: number; payableDays: number }
export interface BonusResult {
  eligible: boolean; reason: string | null; daysWorked: number; eligibleMonths: number;
  bonusWage: number; bonus: number; maxBonus: number; months: Array<BonusMonth & { counted: number; bonus: number; eligible: boolean }>;
}

/**
 * Bonus under the Payment of Bonus Act for one employee and accounting year:
 * months in which the wage (basic + DA) is at or under the eligibility
 * ceiling count; the wage counted is capped at the higher of the calculation
 * ceiling and the minimum wage; the bonus is the rate on that. The employee
 * must have worked the minimum days in the year. The maximum (20%) is shown
 * so the allocable-surplus decision can be made.
 */
export function statutoryBonus(months: BonusMonth[], c: BonusConfig): BonusResult {
  const cap = Math.max(c.calculationCeiling, c.minimumWage ?? 0);
  const daysWorked = r2(months.reduce((s, m) => s + m.payableDays, 0));
  const rows = months.map((m) => {
    const eligible = m.wage > 0 && m.wage <= c.eligibilityCeiling;
    const counted = eligible ? Math.min(m.wage, cap) : 0;
    return { ...m, eligible, counted: r2(counted), bonus: r2(counted * c.percent / 100) };
  });
  const bonusWage = r2(rows.reduce((s, m) => s + m.counted, 0));
  const eligibleMonths = rows.filter((m) => m.eligible).length;
  let reason: string | null = null;
  if (eligibleMonths === 0) reason = months.length ? `Wage above ₹${c.eligibilityCeiling.toLocaleString("en-IN")} a month all year` : "No finalised payroll in the year";
  else if (daysWorked < c.minWorkingDays) reason = `Worked ${daysWorked} day(s), under the ${c.minWorkingDays}-day minimum`;
  const eligible = reason === null;
  return {
    eligible, reason, daysWorked, eligibleMonths, bonusWage,
    bonus: eligible ? Math.round(bonusWage * c.percent / 100) : 0,
    maxBonus: eligible ? Math.round(bonusWage * 0.2) : 0,
    months: rows,
  };
}

export interface GratuityConfig { eligibilityYears: number; daysPerYear: number; divisor: number; cap: number }

export function gratuityConfigIssues(c: GratuityConfig): string[] {
  const out: string[] = [];
  if (!(c.eligibilityYears >= 0 && c.eligibilityYears <= 10)) out.push("Eligibility must be between 0 and 10 years");
  if (!(c.daysPerYear >= 15 && c.daysPerYear <= 30)) out.push("Days' wages per year must be between 15 and 30 (15 is the statutory minimum)");
  if (![26, 30].includes(c.divisor)) out.push("The divisor must be 26 (covered by the Act) or 30");
  if (!(c.cap > 0)) out.push("Enter the gratuity cap");
  return out;
}

// ---------------------------------------------------------------------------
//  7. Tax windows, declaration import, contractor TDS
// ---------------------------------------------------------------------------

export interface WindowView { open: boolean; till: Date | null; note: string; rows?: Array<[string, string]> }
export interface WindowOverride { employeeId: string | null; state: "OPEN" | "LOCKED"; until: Date | null; createdAt: Date }

/** The override that decides a window: the employee's own (latest) over everyone's (latest). Expired reopenings do not count. */
export function effectiveWindowOverride(rows: WindowOverride[], employeeId: string, now: Date): WindowOverride | null {
  const live = rows.filter((r) => !(r.state === "OPEN" && r.until && dayStart(r.until) < dayStart(now)));
  const latest = (list: WindowOverride[]) => list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  return latest(live.filter((r) => r.employeeId === employeeId)) ?? latest(live.filter((r) => r.employeeId === null));
}
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const fmtDay = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function applyWindowOverride<T extends WindowView>(w: T, o: WindowOverride | null, what: string): T {
  if (!o) return w;
  if (o.state === "LOCKED") return { ...w, open: false, till: null, note: `Your payroll team has locked ${what}.`, rows: undefined };
  const till = o.until ?? w.till;
  return { ...w, open: true, till, note: till ? `Your payroll team has reopened ${what} until ${fmtDay(till)}.` : `Your payroll team has reopened ${what}.`, rows: till ? [["Current Window", `Till ${fmtDay(till)}`]] : w.rows };
}

export interface DeclarationImportRow { line: number; employeeNumber: string; section: string; category: string; amount: number }

/**
 * A bulk declaration file: header row with Employee Number, Section,
 * Category (or Description) and Amount, one line per declared item.
 */
export function parseDeclarationCsv(text: string, validSections: Set<string>): { rows: DeclarationImportRow[]; errors: string[] } {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (grid.length < 2) return { rows: [], errors: ["The file has no data rows."] };
  const head = grid[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iEmp = col("employeenumber", "employeeno", "empno", "employeeid"), iSec = col("section"), iCat = col("category", "description", "investment"), iAmt = col("amount", "declaredamount");
  const missing = [[iEmp, "Employee Number"], [iSec, "Section"], [iAmt, "Amount"]].filter(([i]) => (i as number) < 0).map(([, n]) => n);
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(", ")}.`] };
  const rows: DeclarationImportRow[] = [], errors: string[] = [];
  grid.slice(1).forEach((r, k) => {
    const line = k + 2;
    const employeeNumber = (r[iEmp] ?? "").trim(), section = (r[iSec] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const amount = Number(String(r[iAmt] ?? "").replace(/[,₹\s]/g, ""));
    const category = (iCat >= 0 ? r[iCat] ?? "" : "").trim() || section;
    if (!employeeNumber) return void errors.push(`Line ${line}: no employee number.`);
    if (!validSections.has(section)) return void errors.push(`Line ${line}: "${r[iSec] ?? ""}" is not a section this payroll knows.`);
    if (!(amount > 0) || amount > 1_00_00_000) return void errors.push(`Line ${line}: enter an amount between 1 and 1,00,00,000.`);
    rows.push({ line, employeeNumber, section, category: category.slice(0, 120), amount: r2(amount) });
  });
  return { rows, errors };
}

/** TDS sections for payments to contractors and professionals, with default rates. */
export const CONTRACTOR_SECTIONS: Record<string, { label: string; individual: number; other: number; threshold: number }> = {
  "194C": { label: "194C — Contractors", individual: 1, other: 2, threshold: 30000 },
  "194J": { label: "194J — Professional / technical fees", individual: 10, other: 10, threshold: 30000 },
  "194H": { label: "194H — Commission or brokerage", individual: 2, other: 2, threshold: 20000 },
  "194I": { label: "194I — Rent", individual: 10, other: 10, threshold: 50000 },
};

export function defaultContractorRate(section: string, deducteeType: string): number {
  const s = CONTRACTOR_SECTIONS[section];
  if (!s) return 0;
  return deducteeType === "INDIVIDUAL" ? s.individual : s.other;
}

/** TDS on a payment. Without a PAN, s.206AA's 20% applies when it is higher. */
export function contractorTds(amount: number, rate: number, hasPan: boolean): { rate: number; tds: number; note: string | null } {
  const effective = hasPan ? rate : Math.max(rate, 20);
  return { rate: effective, tds: Math.round(amount * effective / 100), note: hasPan ? null : "No PAN — deducted at 20% under s.206AA" };
}

export const quarterOfMonth = (month: number) => (month >= 4 && month <= 6 ? 1 : month >= 7 && month <= 9 ? 2 : month >= 10 && month <= 12 ? 3 : 4);
export function quarterRange(fy: number, q: number): { start: Date; end: Date } {
  const startMonth = [4, 7, 10, 1][q - 1], year = q === 4 ? fy + 1 : fy;
  return { start: new Date(Date.UTC(year, startMonth - 1, 1)), end: new Date(Date.UTC(year, startMonth + 2, 0)) };
}

export interface Form26qRow {
  contractor: string; pan: string | null; section: string; paymentDate: Date; amount: number; tdsRate: number; tds: number;
  bsrCode: string | null; challanNumber: string | null; depositDate: Date | null;
}

/** The quarter's 26Q deductee rows as CSV, with per-section totals and what is not yet deposited. */
export function form26qCsv(meta: { deductor: string; tan: string | null; fy: number; quarter: number }, rows: Form26qRow[]): { csv: string; issues: string[]; total: number; tds: number } {
  const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : "");
  const issues: string[] = [];
  if (!meta.tan) issues.push("No TAN on the legal entity — add it before filing");
  for (const r of rows) {
    if (!r.pan) issues.push(`${r.contractor}: no PAN`);
    if (!r.challanNumber || !r.bsrCode) issues.push(`${r.contractor} (${d(r.paymentDate)}): TDS not yet matched to a challan`);
  }
  const total = r2(rows.reduce((s, r) => s + r.amount, 0)), tds = r2(rows.reduce((s, r) => s + r.tds, 0));
  const sections = [...new Set(rows.map((r) => r.section))].sort();
  const grid: unknown[][] = [
    ["Form 26Q — TDS on payments other than salary"],
    ["Deductor", meta.deductor], ["TAN", meta.tan ?? ""], ["Financial year", `${meta.fy}-${String((meta.fy + 1) % 100).padStart(2, "0")}`], ["Quarter", `Q${meta.quarter}`],
    [],
    ["Deductee", "PAN", "Section", "Date of payment", "Amount paid", "TDS rate %", "TDS", "BSR code", "Challan serial", "Date of deposit"],
    ...rows.map((r) => [r.contractor, r.pan ?? "PANNOTAVBL", r.section, d(r.paymentDate), r.amount.toFixed(2), r.tdsRate.toFixed(2), r.tds.toFixed(2), r.bsrCode ?? "", r.challanNumber ?? "", d(r.depositDate)]),
    [],
    ["Section", "Payments", "Amount paid", "TDS"],
    ...sections.map((s) => { const l = rows.filter((r) => r.section === s); return [s, l.length, l.reduce((a, r) => a + r.amount, 0).toFixed(2), l.reduce((a, r) => a + r.tds, 0).toFixed(2)]; }),
    ["Total", rows.length, total.toFixed(2), tds.toFixed(2)],
    [],
    ["This is the quarter's data for the Return Preparation Utility, not an FVU file. Validate the prepared return with the official FVU before upload."],
  ];
  return { csv: toCsv(grid), issues: [...new Set(issues)], total, tds };
}

// ---------------------------------------------------------------------------
//  8. Loan policy assignment
// ---------------------------------------------------------------------------

/** The policy that applies: the employee's own assignment, else their pay group's, else a policy assigned to no one. */
export function resolveLoanPolicy(
  employee: { id: string; payGroupId: string | null },
  assignments: Array<{ policyId: string; employeeId: string | null; payGroupId: string | null }>,
  candidates: string[],
): string | null {
  const ok = new Set(candidates);
  const own = assignments.find((a) => a.employeeId === employee.id && ok.has(a.policyId));
  if (own) return own.policyId;
  const group = employee.payGroupId ? assignments.find((a) => !a.employeeId && a.payGroupId === employee.payGroupId && ok.has(a.policyId)) : undefined;
  if (group) return group.policyId;
  const assigned = new Set(assignments.map((a) => a.policyId));
  return candidates.find((id) => !assigned.has(id)) ?? null;
}

// ---------------------------------------------------------------------------
//  9. Budget projections
// ---------------------------------------------------------------------------

export interface ProjectionEmployee {
  employeeId: string; department: string; annualCtc: number; lastWorkingDay: Date | null;
  /** Approved revisions not yet in force, by effective date. */
  upcoming: Array<{ effectiveFrom: Date; annualCtc: number }>;
}

/**
 * Projected monthly cost (CTC / 12) for the next months from current
 * salaries, switching to an approved revision from its effective month and
 * dropping anyone whose last working day has passed.
 */
export function projectPayroll(emps: ProjectionEmployee[], months: Array<{ year: number; month: number }>): Array<{ year: number; month: number; headcount: number; cost: number; revisionImpact: number }> {
  return months.map(({ year, month }) => {
    const start = new Date(Date.UTC(year, month - 1, 1)), end = new Date(Date.UTC(year, month, 0));
    let headcount = 0, cost = 0, impact = 0;
    for (const e of emps) {
      if (e.lastWorkingDay && e.lastWorkingDay < start) continue;
      const rev = e.upcoming.filter((u) => u.effectiveFrom <= end).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
      const ctc = rev ? rev.annualCtc : e.annualCtc;
      headcount++;
      cost += ctc / 12;
      if (rev) impact += (rev.annualCtc - e.annualCtc) / 12;
    }
    return { year, month, headcount, cost: r2(cost), revisionImpact: r2(impact) };
  });
}

export function nextMonths(from: Date, n: number): Array<{ year: number; month: number }> {
  const base = ym(from.getUTCFullYear(), from.getUTCMonth() + 1);
  return Array.from({ length: n }, (_, i) => ({ year: Math.floor((base + 1 + i) / 12), month: ((base + 1 + i) % 12) + 1 }));
}

/**
 * An increment scenario priced by department: each department's % (or the
 * default) on its annual CTC, and the in-year cost from the effective month
 * to the end of the financial year.
 */
export function scenarioCost(
  emps: Array<{ departmentId: string | null; department: string; annualCtc: number }>,
  s: { defaultPercent: number; departmentPercents: Record<string, number>; effectiveYear: number; effectiveMonth: number; fyStartMonth?: number },
): { rows: Array<{ departmentId: string | null; department: string; headcount: number; currentCtc: number; percent: number; increase: number; newCtc: number; inYearCost: number }>; totals: { headcount: number; currentCtc: number; increase: number; newCtc: number; inYearCost: number }; monthsInYear: number } {
  const fyStart = s.fyStartMonth ?? 4;
  const monthsInYear = Math.max(0, Math.min(12, ((fyStart - 1) - (s.effectiveMonth - 1) + 12) % 12 || 12));
  const by = new Map<string, { departmentId: string | null; department: string; headcount: number; currentCtc: number }>();
  for (const e of emps) {
    const k = e.departmentId ?? "_none";
    const r = by.get(k) ?? { departmentId: e.departmentId, department: e.department, headcount: 0, currentCtc: 0 };
    r.headcount++; r.currentCtc += e.annualCtc;
    by.set(k, r);
  }
  const rows = [...by.values()].sort((a, b) => a.department.localeCompare(b.department)).map((r) => {
    const pct = r.departmentId && s.departmentPercents[r.departmentId] !== undefined ? s.departmentPercents[r.departmentId] : s.defaultPercent;
    const increase = r2(r.currentCtc * pct / 100);
    return { ...r, currentCtc: r2(r.currentCtc), percent: pct, increase, newCtc: r2(r.currentCtc + increase), inYearCost: r2(increase / 12 * monthsInYear) };
  });
  const t = (k: "headcount" | "currentCtc" | "increase" | "newCtc" | "inYearCost") => r2(rows.reduce((a, r) => a + r[k], 0));
  return { rows, totals: { headcount: t("headcount"), currentCtc: t("currentCtc"), increase: t("increase"), newCtc: t("newCtc"), inYearCost: t("inYearCost") }, monthsInYear };
}

// ---------------------------------------------------------------------------
//  10. Compliance checks
// ---------------------------------------------------------------------------

/** Minimum wage check: monthly gross at full attendance against the state's rate. */
export function minimumWageCheck(gross: number, rate: number | null): { status: "OK" | "BELOW" | "NO_RATE"; shortfall: number } {
  if (rate === null) return { status: "NO_RATE", shortfall: 0 };
  return gross + 0.005 >= rate ? { status: "OK", shortfall: 0 } : { status: "BELOW", shortfall: r2(rate - gross) };
}

export interface CoverageInput {
  pfEnabled: boolean; esiEnabled: boolean; uan: string | null; esicNumber: string | null;
  pfWage: number; pfEmployee: number; esiGross: number; esiEmployee: number; grossFullMonth: number;
  pfWageCeiling: number; esiWageLimit: number; payGroupPf: boolean; payGroupEsi: boolean;
}

/** PF and ESI coverage exceptions for one employee in one run. */
export function coverageExceptions(e: CoverageInput): string[] {
  const out: string[] = [];
  if (e.payGroupPf) {
    if (!e.pfEnabled && e.pfWage > 0 && e.pfWage <= e.pfWageCeiling) out.push(`PF off but PF wage ₹${e.pfWage.toFixed(0)} is within the ₹${e.pfWageCeiling.toFixed(0)} ceiling — membership is mandatory`);
    if (e.pfEnabled && e.pfEmployee > 0 && !e.uan) out.push("PF deducted but no UAN on record");
    if (e.pfEnabled && e.pfWage > 0 && e.pfEmployee === 0) out.push("PF applicable but nothing deducted this month");
  }
  if (e.payGroupEsi) {
    if (e.grossFullMonth > 0 && e.grossFullMonth <= e.esiWageLimit && !e.esiEnabled) out.push(`ESI off but gross ₹${e.grossFullMonth.toFixed(0)} is within the ₹${e.esiWageLimit.toFixed(0)} limit`);
    if (e.esiEnabled && e.esiEmployee > 0 && !e.esicNumber) out.push("ESI deducted but no ESIC number on record");
    if (e.esiEnabled && e.grossFullMonth > 0 && e.grossFullMonth <= e.esiWageLimit && e.esiEmployee === 0 && e.esiGross > 0) out.push("Within the ESI limit but no ESI deducted");
  }
  return out;
}

/** PT and LWF applicability for one employee. */
export function ptLwfStatus(e: { stateCode: string | null; ptStates: Set<string>; lwfStates: Set<string>; ptRegistered: boolean; lwfRegistered: boolean; ptDeducted: number; lwfDeducted: number; ptEnabled: boolean; lwfEnabled: boolean }): { pt: string; lwf: string; issues: string[] } {
  const issues: string[] = [];
  const ptApplies = !!e.stateCode && e.ptStates.has(e.stateCode);
  const lwfApplies = !!e.stateCode && e.lwfStates.has(e.stateCode);
  if (!e.stateCode) issues.push("No work location state — PT and LWF cannot be worked out");
  if (ptApplies && !e.ptRegistered) issues.push(`PT applies in ${e.stateCode} but the location is not linked to a PT registration`);
  if (lwfApplies && !e.lwfRegistered) issues.push(`LWF applies in ${e.stateCode} but the location is not linked to an LWF registration`);
  if (!ptApplies && e.ptDeducted > 0) issues.push("PT deducted in a state without PT");
  if (ptApplies && e.ptRegistered && !e.ptEnabled) issues.push("PT switched off for this employee");
  return {
    pt: !ptApplies ? "Not applicable" : e.ptDeducted > 0 ? `Deducted ₹${e.ptDeducted.toFixed(0)}` : "Applicable, nil this month",
    lwf: !lwfApplies ? "Not applicable" : e.lwfDeducted > 0 ? `Deducted ₹${e.lwfDeducted.toFixed(0)}` : "Applicable, not due this month",
    issues,
  };
}
