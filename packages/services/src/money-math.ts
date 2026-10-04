/**
 * Pure rules for the money modules — expenses, travel, loans, benefits and
 * compensation planning. No database here, so every rule is unit-tested.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
export const moneyMonthIndex = (y: number, m: number) => y * 12 + (m - 1);
export const moneyFromMonthIndex = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

// ===========================================================================
//  Expenses
// ===========================================================================

/** Reason codes for rejecting a claim or reducing a line. */
export const EXPENSE_REASON_CODES = {
  NO_RECEIPT: "Receipt missing or unreadable",
  OVER_LIMIT: "Over the policy limit",
  NOT_BUSINESS: "Not a business expense",
  DUPLICATE: "Duplicate of an earlier claim",
  OUT_OF_PERIOD: "Outside the claim window",
  WRONG_CATEGORY: "Wrong category",
  NO_PRE_APPROVAL: "Needed pre-approval",
  PERSONAL: "Personal expense",
  OTHER: "Other",
} as const;
export type ExpenseReasonCode = keyof typeof EXPENSE_REASON_CODES;
export const isExpenseReasonCode = (v: string): v is ExpenseReasonCode => v in EXPENSE_REASON_CODES;

/** Starting points for a new expense policy. Caps are by category name. */
export const EXPENSE_POLICY_TEMPLATES = {
  STANDARD: { name: "Standard staff", description: "Everyday travel and meals for most employees.", escalationAboveAmount: 25000, allowFutureDated: false, payrollCutoffDay: 20, caps: { Meals: 1500, Hotel: 4000, "Local conveyance": 1500, Flights: 15000 } },
  FIELD_SALES: { name: "Field sales", description: "Higher daily conveyance and client meals for the field force.", escalationAboveAmount: 40000, allowFutureDated: false, payrollCutoffDay: 25, caps: { Meals: 2500, Hotel: 5000, "Local conveyance": 4000, "Client entertainment": 10000 } },
  LEADERSHIP: { name: "Leadership", description: "Senior leadership: higher hotel and flight limits, finance review above ₹1 lakh.", escalationAboveAmount: 100000, allowFutureDated: true, payrollCutoffDay: 25, caps: { Meals: 4000, Hotel: 12000, Flights: 60000, "Client entertainment": 25000 } },
} as const;
export type ExpensePolicyTemplateKey = keyof typeof EXPENSE_POLICY_TEMPLATES;

export interface PolicyScope { id: string; departmentId: string | null; locationId: string | null; bandId: string | null; isDefault: boolean; status: string; isActive: boolean }

/**
 * The policy that governs an employee: among active policies whose scope
 * fits, the most specific (department, then band, then location); the
 * default policy otherwise.
 */
export function pickExpensePolicy<T extends PolicyScope>(policies: T[], emp: { departmentId: string | null; locationId: string | null; bandId: string | null }): T | null {
  const live = policies.filter((p) => p.isActive && p.status === "ACTIVE");
  const fits = live.filter((p) => (!p.departmentId || p.departmentId === emp.departmentId) && (!p.locationId || p.locationId === emp.locationId) && (!p.bandId || p.bandId === emp.bandId));
  const score = (p: T) => (p.departmentId ? 4 : 0) + (p.bandId ? 2 : 0) + (p.locationId ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a) || Number(b.isDefault) - Number(a.isDefault))[0] ?? null;
}

export interface DupLine { id?: string; categoryId: string; expenseDate: Date; amount: number; merchant?: string | null }

/**
 * Likely duplicates: same category, same day and same amount as a line on
 * another live claim (and the same merchant when both name one), or as an
 * earlier line on the same claim. Returns, per new line, the line it repeats.
 */
export function findDuplicateLines(lines: DupLine[], existing: DupLine[]): Array<string | null> {
  const key = (l: DupLine) => `${l.categoryId}|${dayOf(l.expenseDate)}|${r2(l.amount)}`;
  const sameMerchant = (a: DupLine, b: DupLine) => !a.merchant || !b.merchant || a.merchant.trim().toLowerCase() === b.merchant.trim().toLowerCase();
  return lines.map((l, i) => {
    const hit = existing.find((e) => key(e) === key(l) && sameMerchant(e, l));
    if (hit) return hit.id ?? "earlier";
    const inClaim = lines.slice(0, i).find((e) => key(e) === key(l) && sameMerchant(e, l));
    return inClaim ? `line ${lines.indexOf(inClaim) + 1}` : null;
  });
}

/** Image size from a PNG or JPEG header, without decoding it. */
export function receiptImageSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1]!;
      const len = (data[i + 2]! << 8) + data[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (data[i + 5]! << 8) + data[i + 6]!, width: (data[i + 7]! << 8) + data[i + 8]! };
      }
      i += 2 + len;
    }
  }
  return null;
}

export interface ReceiptQuality { ok: boolean; blocking: boolean; issues: string[] }

/**
 * Quality checks on a receipt: images too small to read are refused; very
 * small files, low-resolution images and PDFs without an end marker are
 * flagged for the approver.
 */
export function receiptQuality(data: Uint8Array, mimeType: string): ReceiptQuality {
  const issues: string[] = [];
  let blocking = false;
  if (mimeType.startsWith("image/")) {
    const size = receiptImageSize(data);
    if (size) {
      if (size.width < 200 || size.height < 200) { issues.push(`The image is ${size.width}×${size.height} px — too small to read.`); blocking = true; }
      else if (size.width < 600 && size.height < 600) issues.push(`Low resolution (${size.width}×${size.height} px).`);
      const ratio = Math.max(size.width, size.height) / Math.max(1, Math.min(size.width, size.height));
      if (ratio > 6) issues.push("Unusual shape — check the whole receipt is captured.");
    }
    if (data.length < 4096) issues.push("Very small file — it may be blank.");
  } else if (mimeType === "application/pdf") {
    const tail = new TextDecoder("latin1").decode(data.slice(Math.max(0, data.length - 1024)));
    if (!tail.includes("%%EOF")) issues.push("The PDF looks truncated.");
  }
  return { ok: issues.length === 0, blocking, issues };
}

/**
 * The payroll month a reimbursement rides in: the first open month, or the
 * one after when approval lands after the policy's cutoff day.
 */
export function reimbursementMonth(approvedOn: Date, cutoffDay: number | null, firstOpen: { year: number; month: number }): { year: number; month: number } {
  let idx = moneyMonthIndex(firstOpen.year, firstOpen.month);
  const approvedIdx = moneyMonthIndex(approvedOn.getUTCFullYear(), approvedOn.getUTCMonth() + 1);
  if (cutoffDay && approvedIdx === idx && approvedOn.getUTCDate() > cutoffDay) idx += 1;
  return moneyFromMonthIndex(Math.max(idx, approvedIdx));
}

/** Approved lines split into taxable and non-taxable amounts, after an advance takes its share. */
export function splitTaxable(lines: Array<{ approved: number; taxable: boolean }>, settledByAdvance = 0): { taxable: number; nonTaxable: number } {
  let taxable = r2(lines.filter((l) => l.taxable).reduce((s, l) => s + l.approved, 0));
  let nonTaxable = r2(lines.filter((l) => !l.taxable).reduce((s, l) => s + l.approved, 0));
  // The advance is settled out of the non-taxable part first.
  let left = Math.max(0, settledByAdvance);
  const fromNon = Math.min(left, nonTaxable); nonTaxable = r2(nonTaxable - fromNon); left -= fromNon;
  taxable = r2(Math.max(0, taxable - left));
  return { taxable, nonTaxable };
}

/** A small deterministic PRNG, so a sample can be re-drawn exactly. */
export function auditRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick ⌈rate% of n⌉ ids (at least one), reproducibly from the seed. High-value claims are always in. */
export function sampleForAudit(claims: Array<{ id: string; amount: number }>, ratePct: number, seed: number, alwaysAbove: number | null = null): string[] {
  if (claims.length === 0) return [];
  const must = alwaysAbove === null ? [] : claims.filter((c) => c.amount > alwaysAbove).map((c) => c.id);
  const want = Math.max(1, Math.ceil((claims.length * Math.max(0, Math.min(100, ratePct))) / 100));
  const rnd = auditRandom(seed);
  const pool = claims.map((c) => c.id).filter((id) => !must.includes(id)).sort();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return [...must, ...pool.slice(0, Math.max(0, want - must.length))];
}

/** Mileage claim amount: distance × the rate in force on the day. */
export function mileageAmount(km: number, ratePerKm: number): number {
  return km > 0 && ratePerKm > 0 ? r2(km * ratePerKm) : 0;
}

/** The rate in force on a date: latest ACTIVE row effective on or before it. */
export function rateOn<T extends { key: string; amount: number | { toString(): string }; effectiveFrom: Date; status: string }>(rates: T[], key: string, on: Date): T | null {
  return rates.filter((r) => r.key === key && r.status === "ACTIVE" && r.effectiveFrom.getTime() <= on.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
}

// ===========================================================================
//  Travel
// ===========================================================================

export const FLIGHT_CLASSES = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
export const TRIP_CHECKLIST_KINDS = { VISA: "Visa", INSURANCE: "Travel insurance", PASSPORT: "Passport validity", FOREX: "Forex card", OTHER: "Other" } as const;
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export interface TravelPolicyRules {
  domesticFlightClass: string; internationalFlightClass: string;
  hotelCapPerNight: number | null; groundDailyCap: number | null; minAdvanceDays: number;
  secondApprovalAbove: number | null; internationalNeedsSecondApproval: boolean; requireInsuranceInternational: boolean; passportValidityMonths: number;
}
export interface TripFacts { travelType: string; departDate: Date; returnDate: Date | null; estimatedCost: number | null; requestedOn: Date }
export interface BookingFacts { kind: string; travelClass?: string | null; cost: number; startsAt: Date; endsAt?: Date | null }
export interface Violation { code: string; message: string; severity: "warning" | "approval" | "block" }

/** Nights between two dates (at least one for a stay). */
export const nightsBetween = (a: Date, b: Date | null | undefined) => Math.max(1, Math.round(((b ? dayOf(b) : dayOf(a) + DAY) - dayOf(a)) / DAY));

/** Breaches of the travel policy by a trip as requested. */
export function checkTripPolicy(trip: TripFacts, policy: TravelPolicyRules | null): Violation[] {
  if (!policy) return [];
  const out: Violation[] = [];
  const lead = Math.floor((dayOf(trip.departDate) - dayOf(trip.requestedOn)) / DAY);
  if (policy.minAdvanceDays > 0 && lead < policy.minAdvanceDays) out.push({ code: "LATE_REQUEST", severity: "warning", message: `Requested ${lead} day(s) ahead; the policy asks for ${policy.minAdvanceDays}.` });
  if (policy.secondApprovalAbove !== null && (trip.estimatedCost ?? 0) > policy.secondApprovalAbove) out.push({ code: "COST_ABOVE_LIMIT", severity: "approval", message: `Estimated ₹${(trip.estimatedCost ?? 0).toLocaleString("en-IN")} is above ₹${policy.secondApprovalAbove.toLocaleString("en-IN")}; a second approval is needed.` });
  if (trip.travelType === "INTERNATIONAL" && policy.internationalNeedsSecondApproval) out.push({ code: "INTERNATIONAL", severity: "approval", message: "International travel needs a second approval." });
  return out;
}

/** Breaches of the travel policy by a booking. */
export function checkBookingPolicy(b: BookingFacts, travelType: string, policy: TravelPolicyRules | null): Violation[] {
  if (!policy) return [];
  const out: Violation[] = [];
  if (b.kind === "FLIGHT" && b.travelClass) {
    const allowed = travelType === "INTERNATIONAL" ? policy.internationalFlightClass : policy.domesticFlightClass;
    const rank = (c: string) => FLIGHT_CLASSES.indexOf(c as (typeof FLIGHT_CLASSES)[number]);
    if (rank(b.travelClass) > rank(allowed)) out.push({ code: "FLIGHT_CLASS", severity: "approval", message: `${b.travelClass.replace(/_/g, " ").toLowerCase()} is above the ${allowed.replace(/_/g, " ").toLowerCase()} entitlement.` });
  }
  if (b.kind === "HOTEL" && policy.hotelCapPerNight !== null) {
    const nights = nightsBetween(b.startsAt, b.endsAt);
    const perNight = r2(b.cost / nights);
    if (perNight > policy.hotelCapPerNight) out.push({ code: "HOTEL_CAP", severity: "approval", message: `₹${perNight.toLocaleString("en-IN")} a night is above the ₹${policy.hotelCapPerNight.toLocaleString("en-IN")} cap.` });
  }
  if (b.kind === "CAB" && policy.groundDailyCap !== null) {
    const days = b.endsAt ? Math.max(1, Math.round((dayOf(b.endsAt) - dayOf(b.startsAt)) / DAY) + 1) : 1;
    if (b.cost / days > policy.groundDailyCap) out.push({ code: "GROUND_CAP", severity: "approval", message: `Ground transport of ₹${r2(b.cost / days).toLocaleString("en-IN")} a day is above the ₹${policy.groundDailyCap.toLocaleString("en-IN")} limit.` });
  }
  return out;
}

/** Whether the trip needs the second-level travel approval. */
export const needsSecondTravelApproval = (v: Violation[]) => v.some((x) => x.severity === "approval");

/** Passport validity for a trip: must run the policy's months past the return. */
export function passportIssue(expiry: Date | null | undefined, returnDate: Date, months: number): string | null {
  if (!expiry) return "No passport on file.";
  const need = new Date(returnDate);
  need.setUTCMonth(need.getUTCMonth() + months);
  return expiry.getTime() < need.getTime() ? `The passport expires ${expiry.toISOString().slice(0, 10)}; it must be valid until ${need.toISOString().slice(0, 10)}.` : null;
}

/** The highest advisory that applies to a destination (city or country, case-insensitive). */
export function destinationRisk<T extends { destination: string; level: string; blockTravel: boolean }>(risks: T[], city: string, country?: string | null): T | null {
  const names = [city, country].filter(Boolean).map((s) => s!.trim().toLowerCase());
  const hits = risks.filter((r) => names.includes(r.destination.trim().toLowerCase()));
  return hits.sort((a, b) => RISK_LEVELS.indexOf(b.level as never) - RISK_LEVELS.indexOf(a.level as never))[0] ?? null;
}

/** Per-diem days: each calendar day away, the return day counting half. */
export function perDiemDays(depart: Date, ret: Date | null): number {
  if (!ret) return 1;
  const days = Math.round((dayOf(ret) - dayOf(depart)) / DAY);
  return days <= 0 ? 1 : days + 0.5;
}

/**
 * Settlement of a trip: per diem first clears the open advance; any per diem
 * left is paid to the employee, any advance left is recovered.
 */
export function travelSettlementNet(input: { perDiemAmount: number; advanceOutstanding: number }): { settlesAdvance: number; payable: number; recover: number; net: number } {
  const settles = Math.min(Math.max(0, input.perDiemAmount), Math.max(0, input.advanceOutstanding));
  const payable = r2(input.perDiemAmount - settles);
  const recover = r2(input.advanceOutstanding - settles);
  return { settlesAdvance: r2(settles), payable, recover, net: r2(payable - recover) };
}

/** The weeks of a month for a calendar, Monday first; null pads the edges. */
export function tripMonthGrid(year: number, month: number): Array<Array<Date | null>> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Array<Date | null> = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(Date.UTC(year, month - 1, i + 1)))];
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<Date | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Is someone travelling on this day? */
export const onTripOn = (t: { departDate: Date; returnDate: Date | null }, d: Date) => dayOf(t.departDate) <= dayOf(d) && dayOf(t.returnDate ?? t.departDate) >= dayOf(d);

// ===========================================================================
//  Loans
// ===========================================================================

/** Processing fee: a % of the principal plus any flat amount. */
export function loanProcessingFee(principal: number, pct: number | null, flat: number | null): number {
  return r2(Math.max(0, (principal * (pct ?? 0)) / 100 + (flat ?? 0)));
}

/** The most an emergency advance can be: N months of gross pay. */
export function emergencyAdvanceCap(monthlyGross: number, months: number | null): number | null {
  return months && monthlyGross > 0 ? r2(monthlyGross * months) : null;
}

/** Equal tranches (the last absorbs rounding), a fixed number of months apart. */
export function trancheSchedule(principal: number, count: number, first: Date, gapMonths: number): Array<{ sequence: number; amount: number; plannedOn: Date }> {
  const n = Math.max(1, Math.floor(count));
  const base = Math.floor((principal / n) * 100) / 100;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(first);
    d.setUTCMonth(d.getUTCMonth() + i * Math.max(1, gapMonths));
    return { sequence: i + 1, amount: i === n - 1 ? r2(principal - base * (n - 1)) : base, plannedOn: d };
  });
}

/** Scheduled instalments whose payroll month has closed without a deduction. */
export function overdueInstallments<T extends { year: number; month: number; status: string }>(rows: T[], closedThrough: { year: number; month: number } | null): T[] {
  if (!closedThrough) return [];
  const last = moneyMonthIndex(closedThrough.year, closedThrough.month);
  return rows.filter((r) => r.status === "SCHEDULED" && moneyMonthIndex(r.year, r.month) <= last);
}

/** Outstanding by how many months overdue. */
export function loanAging(rows: Array<{ outstanding: number; overdueMonths: number }>): Record<"current" | "1-2" | "3-5" | "6+", number> {
  const out = { current: 0, "1-2": 0, "3-5": 0, "6+": 0 };
  for (const r of rows) {
    const k = r.overdueMonths <= 0 ? "current" : r.overdueMonths <= 2 ? "1-2" : r.overdueMonths <= 5 ? "3-5" : "6+";
    out[k] = r2(out[k] + r.outstanding);
  }
  return out;
}

// ===========================================================================
//  Benefits
// ===========================================================================

export const BENEFIT_TYPES = { HEALTH: "Health insurance", LIFE: "Life insurance", ACCIDENT: "Personal accident", DENTAL: "Dental", VISION: "Vision", RETIREMENT: "Retirement (NPS / superannuation)", WELLNESS: "Wellness", OTHER: "Other" } as const;
export const COVERAGE_TIERS = { EMPLOYEE: "Employee only", EMPLOYEE_SPOUSE: "Employee + spouse", FAMILY: "Family" } as const;
export const LIFE_EVENT_KINDS = { MARRIAGE: "Marriage", BIRTH: "Birth of a child", ADOPTION: "Adoption", DIVORCE: "Divorce", DEATH_OF_DEPENDENT: "Death of a dependent", OTHER: "Other" } as const;
export const DEPENDENT_RELATIONS = ["SPOUSE", "CHILD", "PARENT", "PARENT_IN_LAW", "SIBLING"] as const;

export interface BenefitEligibilityRules { minTenureDays?: number | null; bandIds?: string[]; locationIds?: string[]; departmentIds?: string[]; workerTypeIds?: string[]; excludeProbation?: boolean }
export interface BenefitEmployee { dateOfJoining: Date; status: string; bandId: string | null; locationId: string | null; departmentId: string | null; workerTypeId: string | null }

/** Why the rules keep an employee out of a plan (empty: eligible). */
export function benefitEligibilityGaps(rules: BenefitEligibilityRules | null | undefined, e: BenefitEmployee, today = new Date()): string[] {
  const r = rules ?? {};
  const gaps: string[] = [];
  if (["EXITED", "INACTIVE"].includes(e.status)) gaps.push("Not an active employee.");
  if (r.excludeProbation && e.status === "PROBATION") gaps.push("Not open during probation.");
  if (r.minTenureDays) {
    const days = Math.floor((dayOf(today) - dayOf(e.dateOfJoining)) / DAY);
    if (days < r.minTenureDays) gaps.push(`Needs ${r.minTenureDays} days of service (has ${days}).`);
  }
  if (r.bandIds?.length && !(e.bandId && r.bandIds.includes(e.bandId))) gaps.push("Band not covered.");
  if (r.locationIds?.length && !(e.locationId && r.locationIds.includes(e.locationId))) gaps.push("Location not covered.");
  if (r.departmentIds?.length && !(e.departmentId && r.departmentIds.includes(e.departmentId))) gaps.push("Department not covered.");
  if (r.workerTypeIds?.length && !(e.workerTypeId && r.workerTypeIds.includes(e.workerTypeId))) gaps.push("Worker type not covered.");
  return gaps;
}

/** Cover starts after the waiting period from joining, and never before the enrolment or plan year. */
export function coverageStart(joined: Date, waitingDays: number, enrolledOn: Date, planYearStart?: Date | null): Date {
  const afterWait = dayOf(joined) + Math.max(0, waitingDays) * DAY;
  return new Date(Math.max(afterWait, dayOf(enrolledOn), planYearStart ? dayOf(planYearStart) : 0));
}

/** Days left in the waiting period (0 once it has passed). */
export function waitingDaysLeft(joined: Date, waitingDays: number, today = new Date()): number {
  return Math.max(0, Math.ceil((dayOf(joined) + waitingDays * DAY - dayOf(today)) / DAY));
}

export interface PremiumPlan { monthlyPremium: number; tierFactors?: Record<string, number> | null; employerRule: string; employerValue: number; employerCap: number | null; type: string }

/**
 * Monthly cost split. Insurance: premium × tier factor, the employer paying a
 * flat amount or a % of it. Retirement: the employee contributes a % of
 * basic and the employer matches up to its %.
 */
export function benefitPremium(plan: PremiumPlan, tier: string, opts: { monthlyBasic?: number; contributionPct?: number | null } = {}): { total: number; employer: number; employee: number } {
  if (plan.type === "RETIREMENT" || plan.employerRule === "MATCH_PERCENT_OF_BASIC") {
    const basic = Math.max(0, opts.monthlyBasic ?? 0);
    const emp = r2((basic * Math.max(0, opts.contributionPct ?? 0)) / 100);
    let er = r2((basic * Math.min(Math.max(0, opts.contributionPct ?? 0), plan.employerValue)) / 100);
    if (plan.employerCap !== null) er = Math.min(er, plan.employerCap);
    return { total: r2(emp + er), employer: er, employee: emp };
  }
  const factor = Number(plan.tierFactors?.[tier] ?? (tier === "EMPLOYEE" ? 1 : tier === "EMPLOYEE_SPOUSE" ? 1.8 : 2.5));
  const total = r2(plan.monthlyPremium * factor);
  let employer = plan.employerRule === "FLAT" ? plan.employerValue : r2((total * plan.employerValue) / 100);
  if (plan.employerCap !== null) employer = Math.min(employer, plan.employerCap);
  employer = Math.min(employer, total);
  return { total, employer: r2(employer), employee: r2(total - employer) };
}

export interface DependentFacts { id: string; name: string; relationship: string; dateOfBirth: Date | null; verified: boolean }

/** Problems with covering these dependents under a plan and tier. */
export function dependentCoverageIssues(plan: { allowedRelations: string[]; maxDependents: number; childMaxAge: number | null; requiresDependentProof: boolean }, tier: string, deps: DependentFacts[], today = new Date()): string[] {
  const issues: string[] = [];
  if (tier === "EMPLOYEE" && deps.length) issues.push("Employee-only cover cannot include dependents.");
  if (tier === "EMPLOYEE_SPOUSE" && deps.some((d) => d.relationship.toUpperCase() !== "SPOUSE")) issues.push("Employee + spouse cover takes only a spouse.");
  if (deps.length > plan.maxDependents) issues.push(`The plan covers at most ${plan.maxDependents} dependent(s).`);
  for (const d of deps) {
    const rel = d.relationship.toUpperCase();
    if (plan.allowedRelations.length && !plan.allowedRelations.includes(rel)) issues.push(`${d.name}: ${rel.toLowerCase()} is not covered by this plan.`);
    if (rel === "CHILD" && plan.childMaxAge !== null && d.dateOfBirth) {
      const age = dependentAgeOn(d.dateOfBirth, today);
      if (age > plan.childMaxAge) issues.push(`${d.name}: children are covered up to ${plan.childMaxAge} (is ${age}).`);
    }
    if (plan.requiresDependentProof && !d.verified) issues.push(`${d.name}: proof of relationship has not been verified.`);
  }
  return issues;
}

export function dependentAgeOn(dob: Date, on: Date): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  if (on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Months of employee premium still to deduct, from the month cover started
 * (or after the last month already deducted) through the payroll month.
 * Months before the payroll month are arrears.
 */
export function premiumMonthsDue(coverageStartOn: Date, deductedThrough: number | null, payroll: { year: number; month: number }, coverageEndOn?: Date | null): Array<{ year: number; month: number; arrears: boolean }> {
  const from = deductedThrough !== null ? deductedThrough + 1 : moneyMonthIndex(coverageStartOn.getUTCFullYear(), coverageStartOn.getUTCMonth() + 1);
  const target = moneyMonthIndex(payroll.year, payroll.month);
  const end = coverageEndOn ? Math.min(target, moneyMonthIndex(coverageEndOn.getUTCFullYear(), coverageEndOn.getUTCMonth() + 1)) : target;
  const out: Array<{ year: number; month: number; arrears: boolean }> = [];
  for (let i = from; i <= end; i++) out.push({ ...moneyFromMonthIndex(i), arrears: i < target });
  return out;
}

/** Annual cost projection with a premium inflation assumption. */
export function benefitForecast(rows: Array<{ planId: string; employer: number; employee: number }>, months: number, inflationPct: number): Array<{ planId: string; members: number; employerAnnual: number; employeeAnnual: number; projectedEmployer: number; projectedTotal: number }> {
  const by = new Map<string, { members: number; employer: number; employee: number }>();
  for (const r of rows) {
    const b = by.get(r.planId) ?? { members: 0, employer: 0, employee: 0 };
    b.members++; b.employer += r.employer; b.employee += r.employee;
    by.set(r.planId, b);
  }
  const f = 1 + inflationPct / 100;
  return [...by.entries()].map(([planId, b]) => ({
    planId, members: b.members, employerAnnual: r2(b.employer * months), employeeAnnual: r2(b.employee * months),
    projectedEmployer: r2(b.employer * months * f), projectedTotal: r2((b.employer + b.employee) * months * f),
  }));
}

export interface CarrierRow { memberId: string; name: string; tier: string; premium: number }

/** Compare our enrolment census with the carrier's: who is missing on either side, and premium mismatches. */
export function reconcileCarrier(ours: CarrierRow[], theirs: CarrierRow[]): { matched: number; missingAtCarrier: CarrierRow[]; extraAtCarrier: CarrierRow[]; mismatches: Array<{ memberId: string; ours: number; theirs: number; tierOurs: string; tierTheirs: string }> } {
  const t = new Map(theirs.map((r) => [r.memberId.trim().toUpperCase(), r]));
  const o = new Map(ours.map((r) => [r.memberId.trim().toUpperCase(), r]));
  const mismatches: Array<{ memberId: string; ours: number; theirs: number; tierOurs: string; tierTheirs: string }> = [];
  let matched = 0;
  for (const [k, r] of o) {
    const x = t.get(k);
    if (!x) continue;
    if (Math.abs(r.premium - x.premium) > 0.5 || r.tier.toUpperCase() !== x.tier.toUpperCase()) mismatches.push({ memberId: r.memberId, ours: r.premium, theirs: x.premium, tierOurs: r.tier, tierTheirs: x.tier });
    else matched++;
  }
  return { matched, missingAtCarrier: ours.filter((r) => !t.has(r.memberId.trim().toUpperCase())), extraAtCarrier: theirs.filter((r) => !o.has(r.memberId.trim().toUpperCase())), mismatches };
}

/** Open-enrolment completion. */
export function enrollmentCompletion(eligible: number, enrolled: number, waived: number): { decided: number; pending: number; pct: number } {
  const decided = enrolled + waived;
  return { decided, pending: Math.max(0, eligible - decided), pct: eligible ? Math.round((decided / eligible) * 1000) / 10 : 0 };
}

// ===========================================================================
//  Compensation planning
// ===========================================================================

export interface MeritBand { minRating: number; maxRating: number; pct: number }
export interface CompGuardrails { minPct?: number | null; maxPct?: number | null; reasonAbovePct?: number | null; maxPromotionPct?: number | null }
export interface CompEligibility { minTenureDays?: number | null; excludeProbation?: boolean; excludeNotice?: boolean; monthsSinceLastIncrease?: number | null }

export function parseMeritMatrix(json: unknown): MeritBand[] {
  return Array.isArray(json) ? (json as MeritBand[]).filter((b) => b && Number.isFinite(Number(b.minRating)) && Number.isFinite(Number(b.pct))).map((b) => ({ minRating: Number(b.minRating), maxRating: Number(b.maxRating), pct: Number(b.pct) })) : [];
}

/** Merit % for a rating: the band it falls in, else the default for the unrated. */
export function meritPctFor(matrix: MeritBand[], defaultPct: number, rating: number | null): number {
  if (rating === null) return defaultPct;
  const b = matrix.find((m) => rating >= m.minRating && rating <= m.maxRating);
  return b ? b.pct : defaultPct;
}

/** Share of the period in service, for a joiner after it started (0–1, 4 dp). */
export function prorationFactor(joined: Date, periodStart: Date, effective: Date): number {
  const total = dayOf(effective) - dayOf(periodStart);
  if (total <= 0 || dayOf(joined) <= dayOf(periodStart)) return 1;
  if (dayOf(joined) >= dayOf(effective)) return 0;
  return Math.round(((dayOf(effective) - dayOf(joined)) / total) * 10000) / 10000;
}

/** Salary ÷ range midpoint (3 dp). */
export const compaRatio = (salary: number, mid: number | null) => (mid && mid > 0 ? Math.round((salary / mid) * 1000) / 1000 : null);
/** Where in the range the salary sits: 0 at the minimum, 1 at the maximum. */
export const rangePenetration = (salary: number, min: number | null, max: number | null) => (min !== null && max !== null && max > min ? Math.round(((salary - min) / (max - min)) * 1000) / 1000 : null);

/** A grade's range moved by a location differential. */
export function adjustedRange(r: { min: number | null; mid: number | null; max: number | null }, diffPct: number): { min: number | null; mid: number | null; max: number | null } {
  const f = 1 + diffPct / 100;
  const m = (v: number | null) => (v === null ? null : Math.round(v * f));
  return { min: m(r.min), mid: m(r.mid), max: m(r.max) };
}

/** The % that lifts a salary (after the other increases) to the range minimum. */
export function marketAdjustmentPct(salaryAfterOther: number, currentCtc: number, rangeMin: number | null): number {
  if (rangeMin === null || currentCtc <= 0 || salaryAfterOther >= rangeMin) return 0;
  return Math.round(((rangeMin - salaryAfterOther) / currentCtc) * 10000) / 100;
}

/** Total increase and the new CTC: merit is prorated; promotion and market are not. */
export function compIncrease(currentCtc: number, merit: number, proration: number, promotion: number, market: number): { totalPct: number; newCtc: number } {
  const totalPct = Math.round((merit * proration + promotion + market) * 100) / 100;
  return { totalPct, newCtc: Math.round(currentCtc * (1 + totalPct / 100)) };
}

/** Guardrail breaches for a line. A breach needs an approved exception (or, for the reason rule, a note). */
export function compGuardrailBreaches(g: CompGuardrails | null | undefined, line: { totalPct: number; promotionPct: number; note: string | null }): string[] {
  const out: string[] = [];
  if (!g) return out;
  if (g.maxPct !== null && g.maxPct !== undefined && line.totalPct > g.maxPct) out.push(`${line.totalPct}% is above the ${g.maxPct}% ceiling.`);
  if (g.minPct !== null && g.minPct !== undefined && line.totalPct > 0 && line.totalPct < g.minPct) out.push(`${line.totalPct}% is below the ${g.minPct}% floor.`);
  if (g.maxPromotionPct !== null && g.maxPromotionPct !== undefined && line.promotionPct > g.maxPromotionPct) out.push(`A ${line.promotionPct}% promotion increase is above the ${g.maxPromotionPct}% limit.`);
  if (g.reasonAbovePct !== null && g.reasonAbovePct !== undefined && line.totalPct > g.reasonAbovePct && !line.note?.trim()) out.push(`Above ${g.reasonAbovePct}% needs a reason.`);
  return out;
}

/** Why an employee is not eligible for an increase in this plan (null: eligible). */
export function compIneligibility(rules: CompEligibility | null | undefined, e: { dateOfJoining: Date; status: string; lastIncreaseOn: Date | null }, effective: Date): string | null {
  const r = rules ?? {};
  if (["EXITED", "INACTIVE"].includes(e.status)) return "Not active.";
  if (r.excludeNotice && e.status === "NOTICE_PERIOD") return "Serving notice.";
  if (r.excludeProbation && e.status === "PROBATION") return "On probation.";
  if (r.minTenureDays && Math.floor((dayOf(effective) - dayOf(e.dateOfJoining)) / DAY) < r.minTenureDays) return `Less than ${r.minTenureDays} days of service by the effective date.`;
  if (r.monthsSinceLastIncrease && e.lastIncreaseOn) {
    const months = (effective.getUTCFullYear() - e.lastIncreaseOn.getUTCFullYear()) * 12 + (effective.getUTCMonth() - e.lastIncreaseOn.getUTCMonth());
    if (months < r.monthsSinceLastIncrease) return `Last increase ${months} month(s) ago; needs ${r.monthsSinceLastIncrease}.`;
  }
  return null;
}

/** Pool spend by owner against each pool's amount. */
export function poolUsage(pools: Array<{ id: string; ownerEmployeeId: string; amount: number }>, items: Array<{ ownerEmployeeId: string | null; currentCtc: number; newCtc: number; status: string }>): Array<{ poolId: string; ownerEmployeeId: string; amount: number; used: number; left: number; over: boolean }> {
  return pools.map((p) => {
    const used = items.filter((i) => i.ownerEmployeeId === p.ownerEmployeeId && i.status !== "SKIPPED").reduce((s, i) => s + (i.newCtc - i.currentCtc), 0);
    return { poolId: p.id, ownerEmployeeId: p.ownerEmployeeId, amount: p.amount, used: r2(used), left: r2(p.amount - used), over: used > p.amount + 0.5 };
  });
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Gender pay gap in a cohort: means and medians, gaps as % of the male figure. */
export function payEquityGap(rows: Array<{ gender: string | null; ctc: number }>): { counts: Record<string, number>; meanMale: number | null; meanFemale: number | null; medianMale: number | null; medianFemale: number | null; meanGapPct: number | null; medianGapPct: number | null } {
  const m = rows.filter((r) => r.gender === "MALE").map((r) => r.ctc);
  const f = rows.filter((r) => r.gender === "FEMALE").map((r) => r.ctc);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  const gap = (a: number | null, b: number | null) => (a && b !== null ? Math.round(((a - b) / a) * 1000) / 10 : null);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.gender ?? "UNSPECIFIED"] = (counts[r.gender ?? "UNSPECIFIED"] ?? 0) + 1;
  const mm = mean(m), mf = mean(f), dm = median(m), df = median(f);
  return { counts, meanMale: mm, meanFemale: mf, medianMale: dm, medianFemale: df, meanGapPct: gap(mm, mf), medianGapPct: gap(dm, df) };
}

// ===========================================================================
//  Approvals on the generic workflow engine
// ===========================================================================

/** Request types the money modules route through the workflow engine. */
export const MONEY_WORKFLOW_ENTITY_TYPES = {
  EXPENSE_POLICY: "Expense policy publication and revisions",
  EXPENSE_PREAPPROVAL: "Expense pre-approvals",
  EXPENSE_RATE: "Mileage and per-diem rates",
  TRAVEL_POLICY: "Travel policy publication and revisions",
  TRAVEL_APPROVAL: "Travel approval matrix (second-level trip approval)",
  TRAVEL_BOOKING: "Out-of-policy travel bookings",
  TRIP_CHANGE: "Trip changes and cancellations",
  TRAVEL_SETTLEMENT: "Travel settlements",
  LOAN_PRODUCT: "Loan product (policy rule) changes",
  LOAN_ADJUSTMENT: "Loan reschedules, skips and settlements",
  BENEFIT_PLAN: "Benefit plan publication and renewals",
  BENEFIT_ENROLLMENT: "Benefit enrolments",
  BENEFIT_EXCEPTION: "Benefit eligibility exceptions",
  DEPENDENT_CHANGE: "Dependent additions and changes",
  LIFE_EVENT: "Life events (special enrolment)",
  COMP_PLAN: "Compensation plan approval",
  COMP_EXCEPTION: "Compensation guardrail exceptions",
  PAY_RANGE: "Pay range changes",
  ALLOWANCE_CHANGE: "Allowance changes",
} as const;
export type MoneyWorkflowEntityType = keyof typeof MONEY_WORKFLOW_ENTITY_TYPES;
export const isMoneyWorkflowEntityType = (v: string): v is MoneyWorkflowEntityType => v in MONEY_WORKFLOW_ENTITY_TYPES;

interface MoneyStep { order: number; name: string; approverType: string; approverPermission?: string | null; mode?: string | null; slaHours?: number | null; escalateTo?: string | null; conditionField?: string | null; conditionOp?: string | null; conditionValue?: string | null }

/** Built-in routes for the money request types (used until a tenant configures its own). */
export function moneyBuiltInRoute(entityType: string): MoneyStep[] | null {
  if (!isMoneyWorkflowEntityType(entityType)) return null;
  const perm = (order: number, name: string, permission: string, extra: Partial<MoneyStep> = {}): MoneyStep => ({ order, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS", ...extra });
  const manager = (order = 1): MoneyStep => ({ order, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" });
  switch (entityType) {
    case "EXPENSE_POLICY": return [perm(1, "Finance (expense policy owner)", "expense.policy.manage")];
    case "EXPENSE_PREAPPROVAL": return [manager(), perm(2, "Finance, above ₹50,000", "expense.policy.manage", { conditionField: "amount", conditionOp: "GT", conditionValue: "50000" })];
    case "EXPENSE_RATE": return [perm(1, "Finance", "expense.policy.manage")];
    case "TRAVEL_POLICY": return [perm(1, "Finance", "expense.policy.manage")];
    case "TRAVEL_APPROVAL": return [perm(1, "Travel desk", "expense.travel.manage"), perm(2, "Finance, above ₹1 lakh", "expense.policy.manage", { conditionField: "amount", conditionOp: "GT", conditionValue: "100000" })];
    case "TRAVEL_BOOKING": return [manager(), perm(2, "Finance", "expense.policy.manage")];
    case "TRIP_CHANGE": return [manager()];
    case "TRAVEL_SETTLEMENT": return [perm(1, "Finance", "expense.policy.manage")];
    case "LOAN_PRODUCT": return [perm(1, "Loan approver", "payroll.loan.approve")];
    case "LOAN_ADJUSTMENT": return [perm(1, "Loan approver", "payroll.loan.approve")];
    case "BENEFIT_PLAN": return [perm(1, "Benefits administrator", "payroll.benefit.manage")];
    case "BENEFIT_ENROLLMENT": return [perm(1, "Benefits administrator", "payroll.benefit.manage")];
    case "BENEFIT_EXCEPTION": return [manager(), perm(2, "Benefits administrator", "payroll.benefit.manage")];
    case "DEPENDENT_CHANGE": return [perm(1, "Benefits administrator (verifies proof)", "payroll.benefit.manage")];
    case "LIFE_EVENT": return [perm(1, "Benefits administrator", "payroll.benefit.manage")];
    case "COMP_PLAN": return [perm(1, "Compensation approver", "payroll.salary.approve")];
    case "COMP_EXCEPTION": return [perm(1, "Compensation approver", "payroll.salary.approve")];
    case "PAY_RANGE": return [perm(1, "Compensation approver", "payroll.salary.approve")];
    case "ALLOWANCE_CHANGE": return [manager(), perm(2, "Compensation approver", "payroll.salary.approve")];
  }
}
