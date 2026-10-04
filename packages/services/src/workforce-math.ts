/**
 * Pure helpers for positions, workforce planning and the contingent
 * workforce. No database access: everything here is unit-tested directly.
 */

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Codes and dates
// ---------------------------------------------------------------------------

/** Next "PREFIX-0001" style code after the highest existing one. */
export function nextWorkforceCode(prefix: string, codes: Array<string | null | undefined>, width = 4): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = codes.reduce<number>((m, c) => {
    const n = re.exec(c ?? "")?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

/** Indian fiscal year (April–March) named by its starting calendar year. */
export function fiscalYearOf(d: Date): number {
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export function fiscalYearRange(fy: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(fy, 3, 1)), end: new Date(Date.UTC(fy + 1, 2, 31)) };
}

export function fiscalYearLabel(fy: number): string {
  return `FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Fiscal month 1 = April of `fy` … 12 = March of `fy + 1`. */
export function fiscalMonthLabel(fy: number, fiscalMonth: number): string {
  const calMonth = (fiscalMonth + 2) % 12; // 1 → 3 (Apr)
  const year = fiscalMonth <= 9 ? fy : fy + 1;
  return `${MONTHS[calMonth]} ${year}`;
}

/** The calendar (year, month 1-12) pairs of a fiscal year, in order. */
export function fiscalMonths(fy: number): Array<{ year: number; month: number }> {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((i + 3) % 12) + 1;
    return { year: i < 9 ? fy : fy + 1, month: m };
  });
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / DAY);
}

// ---------------------------------------------------------------------------
//  Positions
// ---------------------------------------------------------------------------

export const VACANCY_REASONS = ["NEW", "RESIGNATION", "TERMINATION", "TRANSFER", "PROMOTION", "RETIREMENT"] as const;
export const CRITICALITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const WORK_MODES = ["ONSITE", "HYBRID", "REMOTE"] as const;

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

export function vacancyAgingBucket(days: number): AgingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** Group vacancies into aging buckets, with the average age. */
export function vacancyAging(vacantSince: Array<Date | null>, today: Date): { buckets: Record<AgingBucket, number>; averageDays: number; oldestDays: number } {
  const buckets: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const ages = vacantSince.filter((d): d is Date => !!d).map((d) => Math.max(0, daysBetween(d, today)));
  for (const a of ages) buckets[vacancyAgingBucket(a)]++;
  return {
    buckets,
    averageDays: ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : 0,
    oldestDays: ages.length ? Math.max(...ages) : 0,
  };
}

export interface ReadinessInput {
  status: string;
  jobStatus: string | null;
  hasDescription: boolean;
  budgetedAnnualSalary: number | null;
  budgetStatus: string;
  payGradeId: string | null;
  skills: string[];
  locationId: string | null;
  departmentId: string | null;
  requisitionId: string | null;
}

/** Job posting readiness: what must be true before a seat can be advertised. */
export function postingReadiness(p: ReadinessInput): { items: Array<{ key: string; label: string; done: boolean }>; ready: boolean } {
  const items = [
    { key: "open", label: "Position is approved and vacant", done: p.status === "VACANT" },
    { key: "job", label: "Linked to an approved job", done: p.jobStatus === "ACTIVE" },
    { key: "jd", label: "Job description written", done: p.hasDescription },
    { key: "budget", label: "Salary budgeted", done: p.budgetStatus === "BUDGETED" && (p.budgetedAnnualSalary ?? 0) > 0 },
    { key: "range", label: "Compensation range (pay grade) assigned", done: !!p.payGradeId },
    { key: "skills", label: "Skill requirements defined", done: p.skills.length > 0 },
    { key: "org", label: "Department and location set", done: !!p.departmentId && !!p.locationId },
  ];
  return { items, ready: items.every((i) => i.done) && !p.requisitionId };
}

/** A salary is within the pay grade's range (inclusive); no range = no constraint. */
export function withinRange(salary: number | null, min: number | null, max: number | null): boolean {
  if (salary === null) return true;
  if (min !== null && salary < min) return false;
  if (max !== null && salary > max) return false;
  return true;
}

/** Whether an employee's location may fill the seat. */
export function locationAllowed(positionLocationId: string | null, allowed: string[], employeeLocationId: string | null, workMode: string): boolean {
  if (workMode === "REMOTE") return true;
  if (!positionLocationId && allowed.length === 0) return true;
  if (!employeeLocationId) return false;
  return employeeLocationId === positionLocationId || allowed.includes(employeeLocationId);
}

/** Parse a comma/newline separated tag list into unique, trimmed tags. */
export function parseTags(raw: string | null | undefined, max = 30): string[] {
  const seen = new Map<string, string>();
  for (const t of (raw ?? "").split(/[,\n]/)) {
    const v = t.trim().slice(0, 60);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].slice(0, max);
}

export interface ReconRow { departmentId: string | null; filledPositions: number; vacantPositions: number; activeEmployees: number }

/** Position-to-headcount reconciliation per department. */
export function reconcile(rows: ReconRow[]): Array<ReconRow & { unpositioned: number; status: "MATCHED" | "EMPLOYEES_WITHOUT_SEATS" | "SEATS_WITHOUT_EMPLOYEES" }> {
  return rows.map((r) => {
    const unpositioned = r.activeEmployees - r.filledPositions;
    return { ...r, unpositioned, status: unpositioned === 0 ? "MATCHED" : unpositioned > 0 ? "EMPLOYEES_WITHOUT_SEATS" : "SEATS_WITHOUT_EMPLOYEES" };
  });
}

// ---------------------------------------------------------------------------
//  Workforce planning
// ---------------------------------------------------------------------------

export interface HeadcountActuals { planned: number; active: number; preJoining: number; exiting: number; openRequisitions: number }

/** Planned vs live headcount: where the department will land, and the gap to plan. */
export function headcountPosition(a: HeadcountActuals): HeadcountActuals & { projected: number; gap: number; status: "UNDER_PLAN" | "ON_PLAN" | "OVER_PLAN" } {
  const projected = a.active + a.preJoining - a.exiting + a.openRequisitions;
  const gap = a.planned - projected;
  return { ...a, projected, gap, status: gap === 0 ? "ON_PLAN" : gap > 0 ? "UNDER_PLAN" : "OVER_PLAN" };
}

/** Room left under the active plan for a department; negative = beyond plan. */
export function planHeadroom(planned: number, committed: number): number {
  return planned - committed;
}

export interface PlanAssumptions { attritionPct: number; salaryIncreasePct: number; benefitsLoadPct: number; overtimePct: number; contractorCost: number }
export interface PlanLineInput { plannedHeadcount: number; newHires: number; replacementHires: number; avgAnnualSalary: number; hireMonth: number }

/**
 * Annual cost of a plan. Existing seats cost a full year at the increased
 * salary; new hires only from their start month. Benefits and overtime load
 * on salary; contractor spend is added flat. Expected attrition is the
 * planned headcount × attrition rate.
 */
export function planCost(lines: PlanLineInput[], a: PlanAssumptions): { salary: number; benefits: number; overtime: number; contractor: number; total: number; headcount: number; hires: number; expectedAttrition: number } {
  const inc = 1 + a.salaryIncreasePct / 100;
  let salary = 0, headcount = 0, hires = 0;
  for (const l of lines) {
    const existing = Math.max(0, l.plannedHeadcount - l.newHires);
    const months = 12 - Math.min(12, Math.max(1, l.hireMonth)) + 1;
    salary += existing * l.avgAnnualSalary * inc + l.newHires * l.avgAnnualSalary * inc * (months / 12);
    headcount += l.plannedHeadcount;
    hires += l.newHires + l.replacementHires;
  }
  const benefits = salary * (a.benefitsLoadPct / 100);
  const overtime = salary * (a.overtimePct / 100);
  return {
    salary: round2(salary), benefits: round2(benefits), overtime: round2(overtime), contractor: round2(a.contractorCost),
    total: round2(salary + benefits + overtime + a.contractorCost), headcount, hires,
    expectedAttrition: Math.round(headcount * (a.attritionPct / 100)),
  };
}

/** Replacement hires needed to hold headcount against attrition. */
export function replacementHiresFor(headcount: number, attritionPct: number): number {
  return Math.round(headcount * (attritionPct / 100));
}

/** Side-by-side: scenario minus base, absolute and percentage. */
export function compareCosts(base: { total: number; headcount: number }, scenario: { total: number; headcount: number }): { costDelta: number; costDeltaPct: number; headcountDelta: number } {
  const costDelta = round2(scenario.total - base.total);
  return { costDelta, costDeltaPct: base.total ? round2((costDelta / base.total) * 100) : 0, headcountDelta: scenario.headcount - base.headcount };
}

/** Budget vs actual. Utilisation in percent; OVER once actual passes budget. */
export function budgetVariance(budget: number, actual: number): { variance: number; utilisationPct: number; status: "UNDER" | "ON_TRACK" | "OVER" } {
  const variance = round2(budget - actual);
  const utilisationPct = budget > 0 ? round2((actual / budget) * 100) : actual > 0 ? 100 : 0;
  return { variance, utilisationPct, status: actual > budget ? "OVER" : utilisationPct >= 90 ? "ON_TRACK" : "UNDER" };
}

/** Capacity: FTE demand vs supply. */
export function capacityGap(demandFte: number, supplyFte: number): { gap: number; coveragePct: number; status: "SHORTFALL" | "BALANCED" | "SURPLUS" } {
  const gap = round2(demandFte - supplyFte);
  return { gap, coveragePct: demandFte > 0 ? round2((supplyFte / demandFte) * 100) : 100, status: gap > 0 ? "SHORTFALL" : gap < 0 ? "SURPLUS" : "BALANCED" };
}

/**
 * Workforce risk for a department, from its vacancy rate, the share of the
 * team leaving, and how many critical seats are empty.
 */
export function workforceRisk(input: { planned: number; active: number; exiting: number; vacant: number; criticalVacant: number }): { score: number; level: "LOW" | "MEDIUM" | "HIGH" } {
  const base = Math.max(1, input.planned, input.active);
  const vacancyRate = input.vacant / base;
  const exitRate = input.exiting / Math.max(1, input.active);
  const score = Math.min(100, Math.round(vacancyRate * 120 + exitRate * 150 + input.criticalVacant * 20));
  return { score, level: score >= 50 ? "HIGH" : score >= 20 ? "MEDIUM" : "LOW" };
}

/** Month-by-month projected headcount over the fiscal year (hires land in their month). */
export function headcountCalendar(startHeadcount: number, lines: Array<{ newHires: number; hireMonth: number }>, exitsByMonth: number[] = []): number[] {
  const out: number[] = [];
  let hc = startHeadcount;
  for (let m = 1; m <= 12; m++) {
    hc += lines.filter((l) => Math.min(12, Math.max(1, l.hireMonth)) === m).reduce((s, l) => s + l.newHires, 0);
    hc -= exitsByMonth[m - 1] ?? 0;
    out.push(hc);
  }
  return out;
}

/** Apply scenario changes to plan lines: scale headcount by %, override increment. */
export function scaleLines<T extends PlanLineInput>(lines: T[], headcountChangePct: number): T[] {
  const f = 1 + headcountChangePct / 100;
  return lines.map((l) => {
    const plannedHeadcount = Math.max(0, Math.round(l.plannedHeadcount * f));
    const delta = plannedHeadcount - l.plannedHeadcount;
    return { ...l, plannedHeadcount, newHires: Math.max(0, l.newHires + delta) };
  });
}

/** Ready-made plan templates. */
export const PLAN_TEMPLATES: Record<string, { label: string; assumptions: PlanAssumptions }> = {
  STEADY: { label: "Steady state", assumptions: { attritionPct: 12, salaryIncreasePct: 8, benefitsLoadPct: 12, overtimePct: 2, contractorCost: 0 } },
  GROWTH: { label: "High growth", assumptions: { attritionPct: 15, salaryIncreasePct: 10, benefitsLoadPct: 12, overtimePct: 4, contractorCost: 0 } },
  CONSERVATIVE: { label: "Hiring freeze", assumptions: { attritionPct: 10, salaryIncreasePct: 5, benefitsLoadPct: 10, overtimePct: 1, contractorCost: 0 } },
};

// ---------------------------------------------------------------------------
//  Contingent workforce
// ---------------------------------------------------------------------------

export type ExpiryState = "EXPIRED" | "EXPIRING_7" | "EXPIRING_30" | "ACTIVE";

export function contractExpiry(endDate: Date, today: Date): { days: number; state: ExpiryState } {
  const days = daysBetween(today, endDate);
  return { days, state: days < 0 ? "EXPIRED" : days <= 7 ? "EXPIRING_7" : days <= 30 ? "EXPIRING_30" : "ACTIVE" };
}

/** What a timesheet bills for its period under the assignment's rate type. */
export function timesheetAmount(rateType: string, rate: number, hours: number, days: number, workingDaysInPeriod = 22): number {
  switch (rateType) {
    case "HOURLY": return round2(rate * hours);
    case "DAILY": return round2(rate * days);
    case "MONTHLY": return round2(rate * Math.min(1, days / Math.max(1, workingDaysInPeriod)));
    default: return 0;
  }
}

/** GST added on top, TDS withheld: what the contractor is actually paid. */
export function contractorPayout(amount: number, profile: { gstRegistered: boolean; gstRatePct: number; tdsRatePct: number }): { gst: number; tds: number; payable: number } {
  const gst = profile.gstRegistered ? round2(amount * (profile.gstRatePct / 100)) : 0;
  const tds = round2(amount * (profile.tdsRatePct / 100));
  return { gst, tds, payable: round2(amount + gst - tds) };
}

export interface RateCardRow { id: string; vendorId: string | null; role: string; rate: number; rateType: string; effectiveFrom: Date; effectiveTo: Date | null }

/** The rate card in force on a date: vendor-specific beats generic, latest start wins. */
export function rateCardOn(cards: RateCardRow[], role: string, vendorId: string | null, on: Date): RateCardRow | null {
  const live = cards.filter((c) => c.role.toLowerCase() === role.toLowerCase() && c.effectiveFrom <= on && (!c.effectiveTo || c.effectiveTo >= on));
  const pick = (xs: RateCardRow[]) => xs.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
  return (vendorId ? pick(live.filter((c) => c.vendorId === vendorId)) : null) ?? pick(live.filter((c) => !c.vendorId));
}

/** Overlapping effective-dated rate cards for the same role and vendor are not allowed. */
export function rateCardOverlaps(existing: Array<{ effectiveFrom: Date; effectiveTo: Date | null }>, from: Date, to: Date | null): boolean {
  const end = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);
  return existing.some((c) => c.effectiveFrom.getTime() <= end(to) && from.getTime() <= end(c.effectiveTo));
}

export const VENDOR_CHECKLIST: Array<{ key: string; label: string }> = [
  { key: "MSA", label: "Master services agreement signed" },
  { key: "GST", label: "GST registration verified" },
  { key: "PAN", label: "PAN verified" },
  { key: "BANK", label: "Bank account verified" },
  { key: "INSURANCE", label: "Insurance certificate received" },
  { key: "LABOUR", label: "Labour licence / CLRA compliance checked" },
];

export const REQUIRED_VENDOR_DOCS = ["MSA", "GST_CERT", "PAN", "INSURANCE"] as const;

/** Compliance of a vendor's documents today. */
export function vendorCompliance(docs: Array<{ docType: string; validUntil: Date | null }>, today: Date): { missing: string[]; expired: string[]; expiringSoon: string[]; compliant: boolean } {
  const valid = (d: { validUntil: Date | null }) => !d.validUntil || d.validUntil >= today;
  const missing = REQUIRED_VENDOR_DOCS.filter((t) => !docs.some((d) => d.docType === t));
  const expired = REQUIRED_VENDOR_DOCS.filter((t) => docs.some((d) => d.docType === t) && !docs.some((d) => d.docType === t && valid(d)));
  const expiringSoon = docs.filter((d) => d.validUntil && valid(d) && daysBetween(today, d.validUntil) <= 30).map((d) => d.docType);
  return { missing: [...missing], expired: [...expired], expiringSoon, compliant: missing.length === 0 && expired.length === 0 };
}

/** Vendor scorecard out of 100: feedback quality, compliance and onboarding completeness. */
export function vendorScore(input: { ratings: number[]; compliant: boolean; checklistDone: number; checklistTotal: number }): { score: number; grade: "A" | "B" | "C" | "D"; avgRating: number | null } {
  const avgRating = input.ratings.length ? round2(input.ratings.reduce((s, r) => s + r, 0) / input.ratings.length) : null;
  const quality = avgRating === null ? 30 : (avgRating / 5) * 50;
  const compliance = input.compliant ? 30 : 0;
  const onboarding = input.checklistTotal ? (input.checklistDone / input.checklistTotal) * 20 : 0;
  const score = Math.round(quality + compliance + onboarding);
  return { score, grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D", avgRating };
}

export function validGstin(v: string): boolean {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase());
}

export function validIfsc(v: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase());
}

/** Spend roll-up by a key (vendor, department …). */
export function contingentSpendBy<T>(rows: T[], key: (r: T) => string, amount: (r: T) => number): Array<{ key: string; amount: number }> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + amount(r));
  return [...m.entries()].map(([k, v]) => ({ key: k, amount: round2(v) })).sort((a, b) => b.amount - a.amount);
}
