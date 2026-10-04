/**
 * Pure rules for Core HR depth: change-request diffs and validation, fiscal
 * years, tenure, delegation windows, span of control, ID card numbers,
 * checklists and mass updates. No database access, so each is unit-tested
 * directly; core-hr-depth.ts gathers the inputs and persists the results.
 */

const DAY = 86_400_000;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
//  Change requests
// ---------------------------------------------------------------------------

export const CHANGE_CATEGORIES = ["CONFIG", "ORG", "PROFILE", "CORRECTION"] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/**
 * Every kind of thing a change request can change, with its category, a
 * label, and the fields a request may set. Anything else in a request is
 * dropped before it is stored, so an applier only ever writes known columns.
 */
export const CHANGE_TARGETS = {
  COMPANY_PROFILE: { category: "CONFIG", label: "Company profile", fields: ["legalName", "brandName", "industry", "website", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "foundedYear", "about", "brandColor", "locale", "dateFormat"] },
  ORGANISATION: { category: "CONFIG", label: "Organisation settings", fields: ["name", "timezone", "fyStartMonth"] },
  FISCAL_YEAR: { category: "CONFIG", label: "Fiscal year", fields: ["name", "calendarSet", "startDate", "endDate", "status", "isCurrent", "note"] },
  WORKING_RULES: { category: "CONFIG", label: "Working rules", fields: ["workDays", "weekStartsOn", "standardHoursPerDay", "standardHoursPerWeek", "halfDayMinHours", "maxConsecutiveWorkDays", "overtimeAfterHours", "maxSpanOfControl"] },
  VISIBILITY: { category: "CONFIG", label: "Directory visibility", fields: ["restrictByLegalEntity", "restrictByBusinessUnit", "managerReporteeOverride"] },
  DEPARTMENT: { category: "ORG", label: "Department", fields: ["name", "code", "description", "businessUnitId", "divisionId", "headId", "isActive"] },
  DIVISION: { category: "ORG", label: "Division", fields: ["name", "code", "description", "businessUnitId", "headId", "isActive"] },
  TEAM: { category: "ORG", label: "Team", fields: ["name", "code", "description", "departmentId", "divisionId", "leadId", "isActive"] },
  COST_CENTRE: { category: "ORG", label: "Cost centre", fields: ["name", "code"] },
  LEGAL_ENTITY: { category: "ORG", label: "Legal entity", fields: ["name", "legalName", "cin", "businessType", "sector", "natureOfBusiness", "addressLine1", "addressLine2", "city", "state", "postalCode", "isActive"] },
  BUSINESS_UNIT: { category: "ORG", label: "Business unit", fields: ["name", "code", "description", "headId", "isActive"] },
  LOCATION: { category: "ORG", label: "Location", fields: ["name", "code", "addressLine1", "addressLine2", "city", "state", "postalCode", "timezone", "isActive"] },
  PERSONAL: { category: "PROFILE", label: "Personal details", fields: ["firstName", "middleName", "lastName", "displayName", "dateOfBirth", "gender", "maritalStatus", "bloodGroup", "nationality"] },
  CONTACT: { category: "PROFILE", label: "Contact details", fields: ["personalEmail", "mobile", "alternatePhone"] },
  ADDRESS: { category: "PROFILE", label: "Address", fields: ["type", "line1", "line2", "city", "state", "postalCode"] },
  BANK: { category: "PROFILE", label: "Bank account", fields: ["bankName", "accountNumber", "ifsc", "branch", "accountHolder"] },
  DEPENDENT: { category: "PROFILE", label: "Dependent", fields: ["name", "relationship", "dateOfBirth", "isNominee"] },
  EMERGENCY_CONTACT: { category: "PROFILE", label: "Emergency contact", fields: ["name", "relationship", "phone", "email", "isPrimary"] },
  EDUCATION: { category: "PROFILE", label: "Education", fields: ["institution", "degree", "specialization", "fromYear", "toYear", "grade"] },
  EXPERIENCE: { category: "PROFILE", label: "Experience", fields: ["companyName", "jobTitle", "fromDate", "toDate", "description"] },
  DATA_CORRECTION: { category: "CORRECTION", label: "Data correction", fields: ["field", "currentValue", "correctValue"] },
} as const satisfies Record<string, { category: ChangeCategory; label: string; fields: readonly string[] }>;
export type ChangeTarget = keyof typeof CHANGE_TARGETS;

export const isChangeTarget = (t: string): t is ChangeTarget => t in CHANGE_TARGETS;

/** Keep only the fields this target allows, dropping empty strings to null. */
export function cleanChanges(target: ChangeTarget, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>(CHANGE_TARGETS[target].fields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    out[k] = typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v;
  }
  return out;
}

export interface FieldDiff { field: string; from: unknown; to: unknown }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields a request actually changes, old → new, for the reviewer. */
export function diffChanges(previous: Record<string, unknown> | null | undefined, changes: Record<string, unknown>): FieldDiff[] {
  return Object.entries(changes)
    .filter(([k, v]) => !same(previous?.[k], v))
    .map(([field, to]) => ({ field, from: previous?.[field] ?? null, to }));
}

/** "dateOfBirth" → "Date of birth". */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/Id$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * May this person decide a request? Never their own; HR requests need HR;
 * manager requests need the employee's manager (direct, dotted-line, or
 * acting for one of them) — or HR, who can always move a request along.
 */
export function canDecideChange(req: { requestedBy: string; approverType: string; employeeId: string | null }, actor: {
  userId: string; isHr: boolean; managerOf: (employeeId: string) => boolean;
}): { ok: boolean; reason?: string } {
  if (req.requestedBy === actor.userId) return { ok: false, reason: "Someone other than the requester must decide it." };
  if (actor.isHr) return { ok: true };
  if (req.approverType === "MANAGER" && req.employeeId && actor.managerOf(req.employeeId)) return { ok: true };
  return { ok: false, reason: req.approverType === "MANAGER" ? "Only the employee's manager or HR can decide it." : "Only HR can decide it." };
}

/** Status a request moves to once approved. */
export function statusOnApproval(effectiveDate: Date | null | undefined, today: Date = new Date()): "SCHEDULED" | "APPLIED" {
  return effectiveDate && utcMidnight(effectiveDate) > utcMidnight(today) ? "SCHEDULED" : "APPLIED";
}

// ---------------------------------------------------------------------------
//  Fiscal years
// ---------------------------------------------------------------------------

export const CALENDAR_SETS = ["STATUTORY", "REPORTING", "LEAVE", "PERFORMANCE"] as const;

/** "FY 2026-27" running from the start month in `year` for twelve months. */
export function suggestFiscalYear(startMonth: number, year: number): { name: string; startDate: Date; endDate: Date } {
  const startDate = new Date(Date.UTC(year, startMonth - 1, 1));
  const endDate = new Date(Date.UTC(year + 1, startMonth - 1, 1) - DAY);
  const name = startMonth === 1 ? `FY ${year}` : `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  return { name, startDate, endDate };
}

/** Problems with a fiscal year against the others in its calendar set. */
export function fiscalYearIssues(
  candidate: { id?: string | null; calendarSet: string; startDate: Date; endDate: Date },
  existing: Array<{ id: string; name: string; calendarSet: string; startDate: Date; endDate: Date }>,
): string[] {
  const issues: string[] = [];
  if (candidate.endDate <= candidate.startDate) issues.push("The end date must be after the start date.");
  const days = (candidate.endDate.getTime() - candidate.startDate.getTime()) / DAY + 1;
  if (days > 549) issues.push("A fiscal year cannot run longer than 18 months.");
  if (days < 28) issues.push("A fiscal year must run at least four weeks.");
  for (const o of existing) {
    if (o.id === candidate.id || o.calendarSet !== candidate.calendarSet) continue;
    if (candidate.startDate <= o.endDate && candidate.endDate >= o.startDate) issues.push(`It overlaps ${o.name} (${iso(o.startDate)} to ${iso(o.endDate)}).`);
  }
  return issues;
}

/** The year containing a date, in one calendar set. */
export function fiscalYearOn<T extends { startDate: Date; endDate: Date }>(years: T[], on: Date): T | null {
  const d = utcMidnight(on);
  return years.find((y) => y.startDate <= d && y.endDate >= d) ?? null;
}

// ---------------------------------------------------------------------------
//  Tenure
// ---------------------------------------------------------------------------

/** Completed years and months of service on a date. */
export function tenure(joined: Date, on: Date = new Date()): { years: number; months: number; days: number; label: string } {
  const a = utcMidnight(joined), b = utcMidnight(on);
  if (b < a) return { years: 0, months: 0, days: 0, label: "Not joined yet" };
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  const anchor = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + months, a.getUTCDate()));
  const days = Math.round((b.getTime() - anchor.getTime()) / DAY);
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts = [years ? `${years} yr${years === 1 ? "" : "s"}` : "", rest ? `${rest} mo` : ""].filter(Boolean);
  return { years, months: rest, days, label: parts.length ? parts.join(" ") : `${days} day${days === 1 ? "" : "s"}` };
}

export const DIRECTORY_TENURE_BANDS = [
  { key: "lt1", label: "Under 1 year", min: 0, max: 1 },
  { key: "1to3", label: "1–3 years", min: 1, max: 3 },
  { key: "3to5", label: "3–5 years", min: 3, max: 5 },
  { key: "5to10", label: "5–10 years", min: 5, max: 10 },
  { key: "10plus", label: "10+ years", min: 10, max: null },
] as const;

/** The joining-date range for a tenure band: joined after `gt`, on or before `lte`. */
export function tenureRange(key: string, on: Date = new Date()): { gt?: Date; lte?: Date } | null {
  const band = DIRECTORY_TENURE_BANDS.find((b) => b.key === key);
  if (!band) return null;
  const d = utcMidnight(on);
  const yearsAgo = (n: number) => new Date(Date.UTC(d.getUTCFullYear() - n, d.getUTCMonth(), d.getUTCDate()));
  return { ...(band.max !== null ? { gt: yearsAgo(band.max) } : {}), lte: yearsAgo(band.min) };
}

// ---------------------------------------------------------------------------
//  Delegation, dotted lines and span of control
// ---------------------------------------------------------------------------

/** Is a delegation in force on a date? (Both ends inclusive, unless revoked.) */
export function delegationActive(d: { startDate: Date; endDate: Date; revokedAt?: Date | null }, on: Date = new Date()): boolean {
  if (d.revokedAt) return false;
  const day = utcMidnight(on);
  return utcMidnight(d.startDate) <= day && utcMidnight(d.endDate) >= day;
}

export function delegationIssues(d: { delegatorId: string; delegateId: string; startDate: Date; endDate: Date }, existing: Array<{ delegatorId: string; delegateId: string; startDate: Date; endDate: Date; revokedAt?: Date | null }>): string[] {
  const issues: string[] = [];
  if (d.delegatorId === d.delegateId) issues.push("Choose someone other than the manager.");
  if (d.endDate < d.startDate) issues.push("The end date must be on or after the start date.");
  if ((d.endDate.getTime() - d.startDate.getTime()) / DAY > 366) issues.push("A delegation can run for at most a year.");
  for (const o of existing) {
    if (o.revokedAt || o.delegatorId !== d.delegatorId) continue;
    if (d.startDate <= o.endDate && d.endDate >= o.startDate) issues.push(`It overlaps an existing delegation (${iso(o.startDate)} to ${iso(o.endDate)}).`);
  }
  // A chain A→B while B→A would bounce approvals between the two.
  if (existing.some((o) => !o.revokedAt && o.delegatorId === d.delegateId && o.delegateId === d.delegatorId && d.startDate <= o.endDate && d.endDate >= o.startDate)) {
    issues.push("They have delegated to this manager for the same dates.");
  }
  return issues;
}

/**
 * Would naming `managerId` as a manager of `employeeId` create a loop? Walks
 * up the reporting chain from the proposed manager.
 */
export function wouldCreateCycle(employeeId: string, managerId: string, managerOf: Map<string, string | null>): boolean {
  if (employeeId === managerId) return true;
  let cur: string | null | undefined = managerId;
  for (let i = 0; i < 50 && cur; i++) {
    if (cur === employeeId) return true;
    cur = managerOf.get(cur);
  }
  return false;
}

export function spanOfControl(reportCounts: Array<{ managerId: string; name: string; reports: number }>, max: number): Array<{ managerId: string; name: string; reports: number; over: boolean }> {
  return reportCounts.map((r) => ({ ...r, over: r.reports > max })).sort((a, b) => b.reports - a.reports);
}

// ---------------------------------------------------------------------------
//  ID cards
// ---------------------------------------------------------------------------

/** "ACME-EMP0042-7K3Q": tenant, employee number, and a short random suffix. */
export function idCardNumber(subdomain: string, employeeNumber: string, random: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${clean(subdomain).slice(0, 6)}-${clean(employeeNumber).slice(0, 12)}-${clean(random).slice(0, 4)}`;
}

export function idCardValidity(issuedAt: Date, years = 2): Date {
  return new Date(Date.UTC(issuedAt.getUTCFullYear() + years, issuedAt.getUTCMonth(), issuedAt.getUTCDate()));
}

export function idCardStatus(card: { status: string; validUntil: Date }, on: Date = new Date()): "VALID" | "EXPIRED" | "REVOKED" {
  if (card.status === "REVOKED") return "REVOKED";
  return utcMidnight(card.validUntil) < utcMidnight(on) ? "EXPIRED" : "VALID";
}

// ---------------------------------------------------------------------------
//  Checklists and mass updates
// ---------------------------------------------------------------------------

export const CHECKLIST_OWNERS = ["HR", "MANAGER", "EMPLOYEE"] as const;

/** "Collect PAN | HR" lines → template items; blank lines dropped. */
export function parseChecklistItems(text: string): Array<{ title: string; owner: string }> {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40).map((line) => {
    const [title, owner] = line.split("|").map((p) => p.trim());
    const o = (owner ?? "").toUpperCase();
    return { title: title.slice(0, 200), owner: (CHECKLIST_OWNERS as readonly string[]).includes(o) ? o : "HR" };
  }).filter((i) => i.title.length > 0);
}

export function checklistProgress(items: Array<{ done: boolean }>): { done: number; total: number; percent: number; complete: boolean } {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0, complete: items.length > 0 && done === items.length };
}

export const MASS_UPDATE_KINDS = {
  STATUS: "Employment status",
  MANAGER: "Reporting manager",
  LOCATION: "Location",
  DEPARTMENT: "Department",
  WORKER_TYPE: "Employment type",
} as const;
export type MassUpdateKind = keyof typeof MASS_UPDATE_KINDS;

/** Statuses a mass update may set; exits and joiners have their own flows. */
export const MASS_STATUSES = ["PROBATION", "CONFIRMED", "INACTIVE"] as const;

export interface MassUpdateRow { employeeId: string; label: string; current: string | null; status: string }

/**
 * What a mass update would do to each employee: apply, or skip with why.
 * The preview and the real run use the same plan.
 */
export function planMassUpdate(kind: MassUpdateKind, value: string, people: Array<{ id: string; label: string; status: string; current: string | null }>): Array<MassUpdateRow & { action: "APPLY" | "SKIP"; reason?: string }> {
  return people.map((p) => {
    const base = { employeeId: p.id, label: p.label, current: p.current, status: p.status };
    if (p.status === "EXITED") return { ...base, action: "SKIP", reason: "Has left the company" };
    if (kind === "MANAGER" && p.id === value) return { ...base, action: "SKIP", reason: "Cannot report to themselves" };
    if (p.current === value) return { ...base, action: "SKIP", reason: "Already set" };
    if (kind === "STATUS" && p.status === "NOTICE_PERIOD") return { ...base, action: "SKIP", reason: "Serving notice; use the exit flow" };
    return { ...base, action: "APPLY" };
  });
}

// ---------------------------------------------------------------------------
//  Directory
// ---------------------------------------------------------------------------

/** A saved search keeps only the directory's own filter keys. */
export const DIRECTORY_KEYS = ["q", "bu", "dept", "loc", "cc", "le", "mgr", "wt", "tenure", "skill", "team", "div", "shift"] as const;

export function cleanDirectoryQuery(raw: string): string {
  const p = new URLSearchParams(raw.replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const k of DIRECTORY_KEYS) {
    const v = p.get(k)?.trim();
    if (v) out.set(k, v.slice(0, 100));
  }
  return out.toString();
}

/** How fresh a profile is: days since its last update, as a label. */
export function freshness(updatedAt: Date, on: Date = new Date()): { days: number; label: string; stale: boolean } {
  const days = Math.max(0, Math.floor((utcMidnight(on).getTime() - utcMidnight(updatedAt).getTime()) / DAY));
  const label = days === 0 ? "Updated today" : days < 30 ? `Updated ${days} day${days === 1 ? "" : "s"} ago` : days < 365 ? `Updated ${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago` : "Not updated in over a year";
  return { days, label, stale: days > 180 };
}
