import { weeklyOffPortion, DEFAULT_WEEKLY_OFF, type WeeklyOffConfig } from "@keka/time";

/**
 * Pure helpers for the joining & time depth: preboarding plans and scores,
 * onboarding milestones and analytics, background verification SLAs and
 * vendor statistics, roster checks (rest periods, staffing, swaps), holiday
 * calendar checks and the overtime calculator. No database access here, so
 * the unit tests cover them directly.
 */

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoKey = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
//  Workflow entity types (applied by join-depth.ts)
// ---------------------------------------------------------------------------

export const JOIN_WORKFLOW_TYPES = {
  PREBOARDING_TASK: "Preboarding task review",
  NEW_HIRE_FORM: "New-hire form review",
  PREJOIN_MESSAGE: "Pre-joining communication approval",
  JOURNEY_TASK: "Onboarding task sign-off",
  ONBOARDING_PLAN: "Onboarding plan approval",
  BUDDY_ASSIGNMENT: "Buddy assignments (the buddy accepts)",
  ORIENTATION_SESSION: "Orientation and onboarding meetings",
  BGV_RESULT: "Background verification results",
  BGV_CHECK_ITEM: "Adverse verification check review",
  ROSTER_PUBLISH: "Roster publication",
  SHIFT_SWAP: "Shift swaps",
  TIME_CONFIG_CHANGE: "Workweek, shift cycle and calendar assignment changes",
  HOLIDAY_CALENDAR: "Holiday calendar publication",
  HOLIDAY_RULE: "Holiday rules",
  OVERTIME_RULE: "Overtime rules",
  OVERTIME_EXCEPTION: "Overtime above the cap",
} as const;
export type JoinWorkflowType = keyof typeof JOIN_WORKFLOW_TYPES;
export const isJoinWorkflowType = (v: string): v is JoinWorkflowType => v in JOIN_WORKFLOW_TYPES;

// ---------------------------------------------------------------------------
//  Preboarding
// ---------------------------------------------------------------------------

export const PREBOARDING_KINDS = ["FORM", "DOCUMENT", "POLICY", "BANK", "TAX", "BENEFITS", "EMERGENCY", "TRAINING", "LOCATION", "CUSTOM"] as const;
export type PreboardingKind = (typeof PREBOARDING_KINDS)[number];
/** Kinds the system can verify from the hire's own data. */
export const PREBOARDING_AUTO_KINDS: PreboardingKind[] = ["BANK", "TAX", "BENEFITS", "EMERGENCY", "DOCUMENT", "TRAINING"];
export const PREBOARDING_OPEN = ["PENDING", "REJECTED"];
export const PREBOARDING_FINISHED = ["DONE", "APPROVED", "WAIVED"];

export interface TemplateScope { departmentId: string | null; locationId: string | null; jobTitle: string | null; isActive: boolean }

/** The most specific active template: job title beats department beats location. */
export function pickScopedTemplate<T extends TemplateScope>(templates: T[], hire: { departmentId: string | null; locationId: string | null; jobTitle: string | null }): T | null {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const fits = templates.filter((t) => t.isActive
    && (!t.departmentId || t.departmentId === hire.departmentId)
    && (!t.locationId || t.locationId === hire.locationId)
    && (!t.jobTitle || norm(t.jobTitle) === norm(hire.jobTitle)));
  const score = (t: T) => (t.jobTitle ? 4 : 0) + (t.departmentId ? 2 : 0) + (t.locationId ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The due date of a task N days before joining, never before today. */
export function preboardingDueDate(joining: Date, daysBefore: number, today: Date): Date {
  const due = new Date(utcDay(joining).getTime() - Math.max(0, daysBefore) * DAY);
  return due < utcDay(today) ? utcDay(today) : due;
}

/** Readiness items computed from the hire's record. */
export interface ReadinessItem { key: string; label: string; ok: boolean }

/** Preboarding completion score: tasks finished plus readiness items, as a percentage. */
export function preboardingScore(tasks: Array<{ status: string }>, readiness: ReadinessItem[]): { pct: number; done: number; total: number } {
  const done = tasks.filter((t) => PREBOARDING_FINISHED.includes(t.status)).length + readiness.filter((r) => r.ok).length;
  const total = tasks.length + readiness.length;
  return { pct: total ? Math.round((done / total) * 100) : 100, done, total };
}

/** Whether a pending task should get another reminder now. */
export function preboardReminderDue(task: { status: string; remindersSent: number; lastRemindedAt: Date | null; createdAt: Date }, cadenceDays: number, max: number, now: Date): boolean {
  if (cadenceDays <= 0 || !PREBOARDING_OPEN.includes(task.status) || task.remindersSent >= max) return false;
  const since = task.lastRemindedAt ?? task.createdAt;
  return now.getTime() - since.getTime() >= cadenceDays * DAY;
}

/** Fill {{placeholders}} in a pre-joining message. Unknown keys are left blank. */
export function renderPrejoinText(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}

/** A scheduled message goes out once the hire is within its window and before joining. */
export function prejoinSendDue(joining: Date, daysBefore: number, today: Date): boolean {
  const j = utcDay(joining).getTime(), t = utcDay(today).getTime();
  return t >= j - daysBefore * DAY && t <= j;
}

export interface PreboardingHireFacts {
  daysToJoin: number;
  overdueTasks: number;
  rejectedItems: number;
  bgvStatus: string | null;
  signedIn: boolean;
  readinessGaps: string[];
  score: number;
}

/** Exceptions that need HR's attention for a hire about to join. */
export function preboardingExceptions(h: PreboardingHireFacts): string[] {
  const out: string[] = [];
  if (h.daysToJoin < 0) out.push(`Joining date passed ${-h.daysToJoin} day(s) ago — mark joined or no-show`);
  if (h.overdueTasks > 0) out.push(`${h.overdueTasks} overdue task(s)`);
  if (h.rejectedItems > 0) out.push(`${h.rejectedItems} item(s) sent back to the hire`);
  if (h.bgvStatus === "DISCREPANCY" || h.bgvStatus === "FAILED") out.push(`Background check ${h.bgvStatus.toLowerCase()}`);
  if (!h.bgvStatus && h.daysToJoin <= 7) out.push("No background check started");
  if (!h.signedIn && h.daysToJoin <= 7) out.push("Has not signed in to the portal");
  if (h.daysToJoin <= 3 && h.readinessGaps.length) out.push(`Not ready: ${h.readinessGaps.join(", ")}`);
  if (h.daysToJoin <= 3 && h.score < 80) out.push(`Only ${h.score}% complete`);
  return out;
}

// --- New-hire forms ---------------------------------------------------------

export const FORM_FIELD_TYPES = ["TEXT", "NUMBER", "DATE", "SELECT", "YESNO"] as const;
export interface NewHireField { key: string; label: string; type: (typeof FORM_FIELD_TYPES)[number]; required: boolean; options: string[] }

/**
 * Parse the form designer's text: one field per line,
 * "Label | TYPE | required | option a, option b".
 */
export function parseNewHireFields(text: string): { fields: NewHireField[]; errors: string[] } {
  const fields: NewHireField[] = [];
  const errors: string[] = [];
  const keys = new Set<string>();
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    const [label = "", typeRaw = "TEXT", req = "", opts = ""] = line.split("|").map((p) => p.trim());
    const type = (typeRaw || "TEXT").toUpperCase() as NewHireField["type"];
    if (!label) { errors.push(`Line ${i + 1}: a label is required.`); return; }
    if (!(FORM_FIELD_TYPES as readonly string[]).includes(type)) { errors.push(`Line ${i + 1}: unknown type "${typeRaw}".`); return; }
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `field_${i + 1}`;
    while (keys.has(key)) key = `${key}_${i + 1}`;
    keys.add(key);
    const options = opts.split(",").map((o) => o.trim()).filter(Boolean);
    if (type === "SELECT" && options.length < 2) { errors.push(`Line ${i + 1}: a choice field needs at least two options.`); return; }
    fields.push({ key, label, type, required: /^(required|yes|y|true|\*)$/i.test(req), options });
  });
  if (!fields.length && !errors.length) errors.push("Add at least one field.");
  return { fields, errors };
}

export function newHireFieldsText(fields: NewHireField[]): string {
  return fields.map((f) => [f.label, f.type, f.required ? "required" : "", f.options.join(", ")].join(" | ").replace(/(\s\|\s)+$/, "")).join("\n");
}

/** Validate answers against a form's fields. */
export function checkNewHireAnswers(fields: NewHireField[], answers: Record<string, string>): { values: Record<string, string>; errors: Record<string, string> } {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = (answers[f.key] ?? "").trim();
    if (!v) { if (f.required) errors[f.key] = "Required"; continue; }
    if (f.type === "NUMBER" && !Number.isFinite(Number(v))) errors[f.key] = "Enter a number";
    else if (f.type === "DATE" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.key] = "Enter a date";
    else if (f.type === "SELECT" && !f.options.includes(v)) errors[f.key] = "Pick one of the options";
    else if (f.type === "YESNO" && !["Yes", "No"].includes(v)) errors[f.key] = "Yes or No";
    values[f.key] = v.slice(0, 1000);
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export const MILESTONE_KINDS = { WEEK_1: 7, DAY_30: 30, DAY_60: 60, DAY_90: 90 } as const;
export type MilestoneKind = keyof typeof MILESTONE_KINDS;

/** First week and 30/60/90-day checkpoints for a joining date. */
export function milestonePlan(joining: Date): Array<{ kind: MilestoneKind; dueDate: Date }> {
  return (Object.entries(MILESTONE_KINDS) as Array<[MilestoneKind, number]>).map(([kind, d]) => ({ kind, dueDate: new Date(utcDay(joining).getTime() + d * DAY) }));
}

export const ONBOARDING_PHASES = {
  PRE_JOINING: "Before joining",
  DAY_ONE: "Day one",
  FIRST_WEEK: "First week",
  FIRST_30: "Days 8–30",
  FIRST_60: "Days 31–60",
  FIRST_90: "Days 61–90",
  LATER: "After 90 days",
} as const;
export type OnboardingPhase = keyof typeof ONBOARDING_PHASES;

/** Which phase a task offset (days from joining) falls in. */
export function onboardingPhase(offsetDays: number): OnboardingPhase {
  if (offsetDays < 0) return "PRE_JOINING";
  if (offsetDays === 0) return "DAY_ONE";
  if (offsetDays <= 7) return "FIRST_WEEK";
  if (offsetDays <= 30) return "FIRST_30";
  if (offsetDays <= 60) return "FIRST_60";
  if (offsetDays <= 90) return "FIRST_90";
  return "LATER";
}

/** The offset a task gets when the designer moves it into a phase. */
export function phaseDefaultOffset(phase: OnboardingPhase): number {
  return { PRE_JOINING: -3, DAY_ONE: 0, FIRST_WEEK: 5, FIRST_30: 30, FIRST_60: 60, FIRST_90: 90, LATER: 120 }[phase];
}

/** Escalation level for an overdue task: one level per `everyDays` overdue, at most 3. */
export function escalationLevelFor(dueDate: Date, today: Date, everyDays: number): number {
  const over = Math.floor((utcDay(today).getTime() - utcDay(dueDate).getTime()) / DAY);
  if (over <= 0 || everyDays <= 0) return 0;
  return Math.min(3, Math.floor(over / everyDays));
}

export interface ScoreTask { ownerEmployeeId: string | null; status: string; dueDate: Date; completedAt: Date | null }

/** Per-owner onboarding scorecard: tasks owned, done, on time, overdue. */
export function onboardingScorecard(tasks: ScoreTask[], today: Date) {
  const by = new Map<string, { owned: number; done: number; onTime: number; overdue: number }>();
  for (const t of tasks) {
    if (!t.ownerEmployeeId) continue;
    const r = by.get(t.ownerEmployeeId) ?? { owned: 0, done: 0, onTime: 0, overdue: 0 };
    r.owned++;
    if (t.status === "DONE") {
      r.done++;
      if (t.completedAt && utcDay(t.completedAt) <= utcDay(t.dueDate)) r.onTime++;
    } else if (t.status === "PENDING" && utcDay(t.dueDate) < utcDay(today)) r.overdue++;
    by.set(t.ownerEmployeeId, r);
  }
  return [...by.entries()].map(([ownerEmployeeId, r]) => ({ ownerEmployeeId, ...r, onTimePct: r.done ? Math.round((r.onTime / r.done) * 100) : 0 }))
    .sort((a, b) => b.overdue - a.overdue || b.owned - a.owned);
}

export interface CohortHire { joined: Date; status: string; journeyPct: number | null; exitedOn: Date | null; daysToComplete: number | null }

/** Onboarding by joining-month cohort. */
export function onboardingCohorts(hires: CohortHire[]) {
  const by = new Map<string, CohortHire[]>();
  for (const h of hires) {
    const k = h.joined.toISOString().slice(0, 7);
    by.set(k, [...(by.get(k) ?? []), h]);
  }
  return [...by.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([cohort, rows]) => {
    const pcts = rows.map((r) => r.journeyPct).filter((p): p is number => p !== null);
    const days = rows.map((r) => r.daysToComplete).filter((p): p is number => p !== null);
    const early = rows.filter((r) => r.exitedOn && r.exitedOn.getTime() - r.joined.getTime() <= 90 * DAY).length;
    return {
      cohort, hires: rows.length,
      avgCompletion: pcts.length ? Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length) : 0,
      completed: days.length,
      avgDaysToComplete: days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null,
      earlyExits: early,
      retention90: rows.length ? Math.round(((rows.length - early) / rows.length) * 100) : 100,
    };
  });
}

/** Where hires drop off between offer acceptance and 90 days in. */
export function onboardingDropOff(rows: Array<{ joined: boolean; noShow: boolean; exitedWithinDays: number | null; tenureDays: number }>) {
  const offered = rows.length;
  const joined = rows.filter((r) => r.joined).length;
  const noShow = rows.filter((r) => r.noShow).length;
  const stayed = (d: number) => rows.filter((r) => r.joined && r.tenureDays >= d && (r.exitedWithinDays === null || r.exitedWithinDays > d)).length;
  const reached = (d: number) => rows.filter((r) => r.joined && r.tenureDays >= d).length;
  const stages = [
    { stage: "Offer accepted", count: offered },
    { stage: "Joined", count: joined },
    { stage: "Still here at 30 days", count: stayed(30), eligible: reached(30) },
    { stage: "Still here at 90 days", count: stayed(90), eligible: reached(90) },
  ];
  return { stages, noShow, noShowPct: offered ? Math.round((noShow / offered) * 100) : 0 };
}

export interface TemplateSnapshotTask { title: string; owner: string; offsetDays: number; category: string; isRequired: boolean; needsApproval?: boolean }
export interface TemplateSnapshot { name: string; trigger: string; departmentId: string | null; locationId: string | null; jobTitle: string | null; isActive: boolean; tasks: TemplateSnapshotTask[] }

/** What changed between two template snapshots. */
export function templateRevisionDiff(a: TemplateSnapshot, b: TemplateSnapshot): string[] {
  const out: string[] = [];
  for (const k of ["name", "trigger", "departmentId", "locationId", "jobTitle", "isActive"] as const) {
    if ((a[k] ?? null) !== (b[k] ?? null)) out.push(`${k}: ${a[k] ?? "—"} → ${b[k] ?? "—"}`);
  }
  const key = (t: TemplateSnapshotTask) => t.title.toLowerCase();
  const am = new Map(a.tasks.map((t) => [key(t), t])), bm = new Map(b.tasks.map((t) => [key(t), t]));
  for (const [k, t] of bm) if (!am.has(k)) out.push(`Added task "${t.title}" (day ${t.offsetDays})`);
  for (const [k, t] of am) if (!bm.has(k)) out.push(`Removed task "${t.title}"`);
  for (const [k, t] of bm) {
    const o = am.get(k);
    if (!o) continue;
    if (o.offsetDays !== t.offsetDays) out.push(`"${t.title}" moved from day ${o.offsetDays} to day ${t.offsetDays}`);
    if (o.owner !== t.owner) out.push(`"${t.title}" owner ${o.owner} → ${t.owner}`);
    if (!!o.needsApproval !== !!t.needsApproval) out.push(`"${t.title}" ${t.needsApproval ? "now needs" : "no longer needs"} approval`);
    if (o.isRequired !== t.isRequired) out.push(`"${t.title}" is now ${t.isRequired ? "required" : "optional"}`);
  }
  return out;
}

/** Whether someone can be a buddy: not the hire, active, and not over capacity. */
export function buddyCheck(input: { hireId: string; buddyId: string; buddyStatus: string; activeBuddyCount: number; maxPerBuddy?: number }): { ok: boolean; message: string } {
  if (input.hireId === input.buddyId) return { ok: false, message: "A hire cannot be their own buddy." };
  if (["EXITED", "PREBOARDING", "NOTICE_PERIOD", "INACTIVE"].includes(input.buddyStatus)) return { ok: false, message: "Pick a buddy who is currently working here." };
  const max = input.maxPerBuddy ?? 2;
  if (input.activeBuddyCount >= max) return { ok: false, message: `That person is already buddy to ${input.activeBuddyCount} hire(s) (limit ${max}).` };
  return { ok: true, message: "ok" };
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export const BGV_ITEM_STATUSES = ["PENDING", "IN_PROGRESS", "PENDING_REVIEW", "VERIFIED", "DISCREPANCY", "FAILED", "UNABLE_TO_VERIFY", "WAIVED"] as const;
export const BGV_ITEM_OPEN = ["PENDING", "IN_PROGRESS", "PENDING_REVIEW"];
export const BGV_ADVERSE = ["DISCREPANCY", "FAILED", "UNABLE_TO_VERIFY"];
export const BGV_SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;
export const BGV_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

/** Reason codes for verification results, with the severity each implies by default. */
export const BGV_REASON_CODES: Record<string, { label: string; severity: (typeof BGV_SEVERITIES)[number] }> = {
  NAME_MISMATCH: { label: "Name mismatch across documents", severity: "MINOR" },
  DOB_MISMATCH: { label: "Date of birth mismatch", severity: "MAJOR" },
  DOCUMENT_FORGED: { label: "Document appears forged", severity: "CRITICAL" },
  ADDRESS_NOT_FOUND: { label: "Address could not be located", severity: "MAJOR" },
  TENURE_MISMATCH: { label: "Employment dates differ", severity: "MINOR" },
  DESIGNATION_MISMATCH: { label: "Designation differs", severity: "MINOR" },
  EMPLOYER_UNRESPONSIVE: { label: "Employer did not respond", severity: "MINOR" },
  DEGREE_NOT_CONFIRMED: { label: "Degree not confirmed by the institution", severity: "MAJOR" },
  INSTITUTION_UNRECOGNISED: { label: "Institution not recognised", severity: "CRITICAL" },
  CRIMINAL_RECORD: { label: "Criminal record found", severity: "CRITICAL" },
  CREDIT_DEFAULT: { label: "Credit default", severity: "MAJOR" },
  REFERENCE_NEGATIVE: { label: "Negative reference", severity: "MAJOR" },
  OTHER: { label: "Other", severity: "MINOR" },
};

/** Check-specific fields captured on each verification request. */
export const BGV_CHECK_FIELDS: Record<string, Array<{ key: string; label: string }>> = {
  IDENTITY: [{ key: "documentType", label: "Document (PAN, passport…)" }, { key: "documentRef", label: "Last 4 characters" }],
  ADDRESS: [{ key: "address", label: "Address to verify" }, { key: "since", label: "Living there since" }],
  EMPLOYMENT: [{ key: "employer", label: "Employer" }, { key: "period", label: "Period (from – to)" }, { key: "designation", label: "Designation" }],
  EDUCATION: [{ key: "institution", label: "Institution" }, { key: "degree", label: "Degree" }, { key: "year", label: "Year of passing" }],
  CRIMINAL: [{ key: "jurisdiction", label: "Jurisdiction / police station" }],
  CREDIT: [{ key: "bureau", label: "Bureau" }],
  REFERENCE: [{ key: "referee", label: "Referee" }, { key: "contact", label: "Contact" }, { key: "relationship", label: "Relationship" }],
};

/** Default severity for a reason code. */
export function bgvSeverityFor(reasonCode: string | null | undefined): (typeof BGV_SEVERITIES)[number] | null {
  return reasonCode ? BGV_REASON_CODES[reasonCode]?.severity ?? "MINOR" : null;
}

export type SlaState = "ON_TRACK" | "DUE_SOON" | "BREACHED" | "MET" | "MISSED" | "NONE";

/** SLA state of a case or a check. */
export function bgvSlaState(slaDueAt: Date | null, completedAt: Date | null, now: Date): SlaState {
  if (!slaDueAt) return "NONE";
  if (completedAt) return completedAt <= slaDueAt ? "MET" : "MISSED";
  if (now > slaDueAt) return "BREACHED";
  return slaDueAt.getTime() - now.getTime() <= 2 * DAY ? "DUE_SOON" : "ON_TRACK";
}

/** What the case outcome should be from its checks. */
export function bgvRollup(items: Array<{ status: string }>): "IN_PROGRESS" | "CLEAR" | "DISCREPANCY" | "FAILED" {
  if (items.some((i) => BGV_ITEM_OPEN.includes(i.status))) return "IN_PROGRESS";
  if (items.some((i) => i.status === "FAILED")) return "FAILED";
  if (items.some((i) => i.status === "DISCREPANCY" || i.status === "UNABLE_TO_VERIFY")) return "DISCREPANCY";
  return "CLEAR";
}

/** Queue order: priority first, then the nearest SLA, then the nearest joining date. */
export function bgvQueueScore(c: { priority: string; slaDueAt: Date | null; joiningDate: Date | null }, now: Date): number {
  const w = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 }[c.priority as "LOW"] ?? 2;
  const sla = c.slaDueAt ? (c.slaDueAt.getTime() - now.getTime()) / DAY : 999;
  const join = c.joiningDate ? (c.joiningDate.getTime() - now.getTime()) / DAY : 999;
  return w * 10_000 + Math.min(sla, join, 999) + 1000;
}

export type ConsentState = "MISSING" | "REQUESTED" | "VALID" | "EXPIRING" | "EXPIRED";
export function bgvConsentState(c: { consentRequestedAt: Date | null; consentGivenAt: Date | null; consentExpiresAt: Date | null }, now: Date): ConsentState {
  if (!c.consentGivenAt) return c.consentRequestedAt ? "REQUESTED" : "MISSING";
  if (c.consentExpiresAt && now > c.consentExpiresAt) return "EXPIRED";
  if (c.consentExpiresAt && c.consentExpiresAt.getTime() - now.getTime() <= 14 * DAY) return "EXPIRING";
  return "VALID";
}

/** Cost of a set of checks at a vendor's rates. */
export function bgvCostFor(costPerCheck: unknown, checkTypes: string[]): number {
  const rates = costPerCheck && typeof costPerCheck === "object" ? (costPerCheck as Record<string, unknown>) : {};
  return checkTypes.reduce((s, t) => s + (Number(rates[t]) || 0), 0);
}

export interface VendorCase { vendor: string; initiatedAt: Date; completedAt: Date | null; slaDueAt: Date | null; status: string; cost: number }

/** Turnaround, SLA adherence, adverse rate and cost per vendor. */
export function bgvVendorStats(cases: VendorCase[]) {
  const by = new Map<string, VendorCase[]>();
  for (const c of cases) by.set(c.vendor || "In-house", [...(by.get(c.vendor || "In-house") ?? []), c]);
  return [...by.entries()].map(([vendor, rows]) => {
    const closed = rows.filter((r) => r.completedAt);
    const tat = closed.map((r) => (r.completedAt!.getTime() - r.initiatedAt.getTime()) / DAY);
    const withSla = closed.filter((r) => r.slaDueAt);
    const adverse = closed.filter((r) => r.status === "DISCREPANCY" || r.status === "FAILED").length;
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    return {
      vendor, cases: rows.length, completed: closed.length,
      avgTatDays: tat.length ? Math.round((tat.reduce((s, d) => s + d, 0) / tat.length) * 10) / 10 : null,
      slaMetPct: withSla.length ? Math.round((withSla.filter((r) => r.completedAt! <= r.slaDueAt!).length / withSla.length) * 100) : null,
      adversePct: closed.length ? Math.round((adverse / closed.length) * 100) : 0,
      totalCost: Math.round(cost * 100) / 100,
      costPerCase: rows.length ? Math.round((cost / rows.length) * 100) / 100 : 0,
    };
  }).sort((a, b) => b.cases - a.cases);
}

// ---------------------------------------------------------------------------
//  Shift & roster
// ---------------------------------------------------------------------------

/** Ready-made shifts HR can add in one click. */
export const SHIFT_TEMPLATE_LIBRARY = [
  { code: "GEN", name: "General (9:30–18:30)", startTime: "09:30", endTime: "18:30", breakMinutes: 60, crossesMidnight: false, segments: null },
  { code: "MOR", name: "Morning (06:00–14:00)", startTime: "06:00", endTime: "14:00", breakMinutes: 30, crossesMidnight: false, segments: null },
  { code: "EVE", name: "Evening (14:00–22:00)", startTime: "14:00", endTime: "22:00", breakMinutes: 30, crossesMidnight: false, segments: null },
  { code: "NGT", name: "Night (22:00–06:00)", startTime: "22:00", endTime: "06:00", breakMinutes: 30, crossesMidnight: true, segments: null },
  { code: "SPL", name: "Split (08:00–12:00, 16:00–20:00)", startTime: "08:00", endTime: "12:00", breakMinutes: 0, crossesMidnight: false, segments: [{ start: "16:00", end: "20:00" }] },
  { code: "HLF", name: "Half day (09:00–13:00)", startTime: "09:00", endTime: "13:00", breakMinutes: 0, crossesMidnight: false, segments: null },
] as const;

const hhmm = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export const isHhmm = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

export interface ShiftSegment { start: string; end: string }
export function parseShiftSegments(json: unknown): ShiftSegment[] {
  return Array.isArray(json) ? json.filter((s): s is ShiftSegment => !!s && typeof s === "object" && isHhmm((s as ShiftSegment).start) && isHhmm((s as ShiftSegment).end)) : [];
}

/** Validate split-shift segments against the main shift: in order, no overlap, same day. */
export function checkSplitSegments(main: { startTime: string; endTime: string; crossesMidnight: boolean }, segs: ShiftSegment[]): string | null {
  if (main.crossesMidnight && segs.length) return "A night shift that crosses midnight cannot be split.";
  let prevEnd = hhmm(main.endTime);
  for (const s of segs) {
    const a = hhmm(s.start), b = hhmm(s.end);
    if (!(b > a)) return `The segment ${s.start}–${s.end} ends before it starts.`;
    if (a < prevEnd) return `The segment ${s.start}–${s.end} overlaps the one before it.`;
    prevEnd = b;
  }
  return null;
}

/** Planned working minutes of a shift, split segments included. */
export function shiftPlannedMinutes(s: { startTime: string; endTime: string; breakMinutes: number; crossesMidnight?: boolean; segments?: unknown }): number {
  let span = hhmm(s.endTime) - hhmm(s.startTime);
  if (span <= 0) span += 1440;
  const extra = parseShiftSegments(s.segments).reduce((sum, g) => sum + Math.max(0, hhmm(g.end) - hhmm(g.start)), 0);
  return Math.max(0, span - (s.breakMinutes ?? 0)) + extra;
}

/** Start and end of a rostered shift on a date, in minutes from that day's midnight (end may pass 1440). */
export function shiftWindow(s: { startTime: string; endTime: string; crossesMidnight?: boolean; segments?: unknown }): { start: number; end: number } {
  const start = hhmm(s.startTime);
  let end = hhmm(s.endTime);
  if (end <= start) end += 1440;
  const segs = parseShiftSegments(s.segments);
  if (segs.length) end = Math.max(end, hhmm(segs[segs.length - 1]!.end));
  return { start, end };
}

/** Hours of rest between one rostered day and the next. */
export function restHoursBetween(prev: { date: Date; start: number; end: number }, next: { date: Date; start: number; end: number }): number {
  const prevEnd = utcDay(prev.date).getTime() + prev.end * 60_000;
  const nextStart = utcDay(next.date).getTime() + next.start * 60_000;
  return (nextStart - prevEnd) / 3_600_000;
}

export interface RosterAssignment { employeeId: string; date: Date; shiftId: string | null; off: boolean }
export interface RosterShift { id: string; name: string; startTime: string; endTime: string; crossesMidnight?: boolean; segments?: unknown }
export interface StaffingRuleSpec { id: string; name: string; shiftId: string | null; departmentId: string | null; locationId: string | null; weekdays: number[]; minStaff: number; maxStaff: number | null }
export interface RosterViolation { key: string; kind: "REST" | "UNDERSTAFFED" | "OVERSTAFFED" | "ON_LEAVE" | "PREFERENCE"; date: string; employeeId?: string; message: string }

/** Rest-period, staffing, leave and preference conflicts in a roster. */
export function rosterViolations(input: {
  assignments: RosterAssignment[];
  shifts: RosterShift[];
  rules: StaffingRuleSpec[];
  minRestHours: number;
  employees: Map<string, { departmentId: string | null; locationId: string | null; name: string }>;
  leave?: Set<string>; // `${employeeId}:${yyyy-mm-dd}`
  avoid?: Map<string, number[]>; // employeeId → weekdays to avoid
}): RosterViolation[] {
  const out: RosterViolation[] = [];
  const shiftById = new Map(input.shifts.map((s) => [s.id, s]));
  const byEmp = new Map<string, RosterAssignment[]>();
  for (const a of input.assignments) byEmp.set(a.employeeId, [...(byEmp.get(a.employeeId) ?? []), a]);
  for (const [emp, rows] of byEmp) {
    const sorted = rows.filter((r) => !r.off && r.shiftId && shiftById.has(r.shiftId)).sort((a, b) => a.date.getTime() - b.date.getTime());
    const name = input.employees.get(emp)?.name ?? emp;
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!, n = sorted[i]!;
      if (n.date.getTime() - p.date.getTime() > DAY) continue;
      const rest = restHoursBetween({ date: p.date, ...shiftWindow(shiftById.get(p.shiftId!)!) }, { date: n.date, ...shiftWindow(shiftById.get(n.shiftId!)!) });
      if (rest < input.minRestHours) out.push({ key: `REST:${emp}:${isoKey(n.date)}`, kind: "REST", date: isoKey(n.date), employeeId: emp, message: `${name}: only ${Math.round(rest * 10) / 10} h rest before ${isoKey(n.date)} (minimum ${input.minRestHours} h)` });
    }
    for (const r of rows) {
      if (r.off || !r.shiftId) continue;
      if (input.leave?.has(`${emp}:${isoKey(r.date)}`)) out.push({ key: `LEAVE:${emp}:${isoKey(r.date)}`, kind: "ON_LEAVE", date: isoKey(r.date), employeeId: emp, message: `${name} is rostered on ${isoKey(r.date)} but on approved leave` });
      if (input.avoid?.get(emp)?.includes(r.date.getUTCDay())) out.push({ key: `PREF:${emp}:${isoKey(r.date)}`, kind: "PREFERENCE", date: isoKey(r.date), employeeId: emp, message: `${name} asked not to work ${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][r.date.getUTCDay()]}` });
    }
  }
  const dates = [...new Set(input.assignments.map((a) => isoKey(a.date)))].sort();
  for (const rule of input.rules) {
    for (const d of dates) {
      const date = new Date(`${d}T00:00:00Z`);
      if (rule.weekdays.length && !rule.weekdays.includes(date.getUTCDay())) continue;
      const n = input.assignments.filter((a) => isoKey(a.date) === d && !a.off && a.shiftId && (!rule.shiftId || a.shiftId === rule.shiftId)).filter((a) => {
        const e = input.employees.get(a.employeeId);
        return (!rule.departmentId || e?.departmentId === rule.departmentId) && (!rule.locationId || e?.locationId === rule.locationId);
      }).length;
      if (n < rule.minStaff) out.push({ key: `UNDER:${rule.id}:${d}`, kind: "UNDERSTAFFED", date: d, message: `${rule.name}: ${n} rostered on ${d}, minimum ${rule.minStaff}` });
      if (rule.maxStaff !== null && n > rule.maxStaff) out.push({ key: `OVER:${rule.id}:${d}`, kind: "OVERSTAFFED", date: d, message: `${rule.name}: ${n} rostered on ${d}, maximum ${rule.maxStaff}` });
    }
  }
  return out;
}

/** Headcount per date per shift, for the coverage heat map. */
export function rosterCoverage(assignments: RosterAssignment[], dates: string[], shiftIds: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of shiftIds) out[s] = Object.fromEntries(dates.map((d) => [d, 0]));
  for (const a of assignments) {
    if (a.off || !a.shiftId || !out[a.shiftId]) continue;
    const k = isoKey(a.date);
    if (k in out[a.shiftId]!) out[a.shiftId]![k]!++;
  }
  return out;
}

/** Heat level 0–4 against a staffing minimum. */
export function coverageLevel(count: number, min: number | null): number {
  if (min === null || min <= 0) return count === 0 ? 0 : Math.min(4, count);
  const r = count / min;
  return r === 0 ? 0 : r < 0.75 ? 1 : r < 1 ? 2 : r <= 1.5 ? 3 : 4;
}

export interface SwapSettings { swapMinNoticeHours: number; swapSameDepartmentOnly: boolean; swapMaxPerMonth: number }

/** Whether two people may trade shifts. */
export function shiftTradeEligibility(input: {
  requester: { id: string; departmentId: string | null; status: string };
  counterpart: { id: string; departmentId: string | null; status: string } | null;
  settings: SwapSettings;
  hoursUntilShift: number;
  swapsThisMonth: number;
  counterpartOnLeave?: boolean;
  restOk?: boolean;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.hoursUntilShift < input.settings.swapMinNoticeHours) reasons.push(`Swaps need ${input.settings.swapMinNoticeHours} hours' notice.`);
  if (input.swapsThisMonth >= input.settings.swapMaxPerMonth) reasons.push(`You have used your ${input.settings.swapMaxPerMonth} swaps this month.`);
  const c = input.counterpart;
  if (c) {
    if (c.id === input.requester.id) reasons.push("You cannot swap with yourself.");
    if (["EXITED", "PREBOARDING", "INACTIVE"].includes(c.status)) reasons.push("That colleague is not working.");
    if (input.settings.swapSameDepartmentOnly && c.departmentId !== input.requester.departmentId) reasons.push("Swaps are only allowed within your department.");
    if (input.counterpartOnLeave) reasons.push("That colleague is on leave that day.");
  }
  if (input.restOk === false) reasons.push("The swap would break the minimum rest period.");
  return { ok: reasons.length === 0, reasons };
}

export interface SnapshotRow { employeeId: string; date: string; shiftId: string | null; off: boolean }

/** Changes between two published rosters. */
export function rosterSnapshotDiff(prev: SnapshotRow[], next: SnapshotRow[]): Array<{ employeeId: string; date: string; from: string; to: string }> {
  const label = (r: SnapshotRow | undefined) => (!r ? "—" : r.off ? "OFF" : r.shiftId ?? "default");
  const pm = new Map(prev.map((r) => [`${r.employeeId}:${r.date}`, r]));
  const nm = new Map(next.map((r) => [`${r.employeeId}:${r.date}`, r]));
  const out: Array<{ employeeId: string; date: string; from: string; to: string }> = [];
  for (const k of new Set([...pm.keys(), ...nm.keys()])) {
    const a = label(pm.get(k)), b = label(nm.get(k));
    if (a !== b) { const [employeeId, date] = k.split(":"); out.push({ employeeId: employeeId!, date: date!, from: a, to: b }); }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.employeeId.localeCompare(y.employeeId));
}

/** Shift cost: planned hours × hourly rate plus the shift allowance. */
export function shiftCostForecast(rows: Array<{ employeeId: string; shiftId: string }>, shifts: Map<string, { minutes: number; allowancePerDay: number }>, hourlyRate: Map<string, number>) {
  const byShift = new Map<string, { days: number; hours: number; wages: number; allowance: number }>();
  for (const r of rows) {
    const s = shifts.get(r.shiftId);
    if (!s) continue;
    const x = byShift.get(r.shiftId) ?? { days: 0, hours: 0, wages: 0, allowance: 0 };
    x.days++;
    x.hours += s.minutes / 60;
    x.wages += (s.minutes / 60) * (hourlyRate.get(r.employeeId) ?? 0);
    x.allowance += s.allowancePerDay;
    byShift.set(r.shiftId, x);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...byShift.entries()].map(([shiftId, x]) => ({ shiftId, days: x.days, hours: r2(x.hours), wages: r2(x.wages), allowance: r2(x.allowance), total: r2(x.wages + x.allowance) }));
}

/** Planned vs actual for one rostered day. */
export function shiftAdherence(plan: { start: number; end: number } | null, actual: { firstIn: number | null; lastOut: number | null; status: string }, graceMinutes = 0) {
  if (!plan) return { status: "UNPLANNED", lateMinutes: 0, earlyMinutes: 0 };
  if (actual.firstIn === null) return { status: ["LEAVE", "HOLIDAY", "WEEKLY_OFF"].includes(actual.status) ? actual.status : "ABSENT", lateMinutes: 0, earlyMinutes: 0 };
  const late = Math.max(0, actual.firstIn - plan.start - graceMinutes);
  const early = actual.lastOut === null ? 0 : Math.max(0, plan.end - actual.lastOut);
  return { status: late > 0 ? "LATE" : early > 0 ? "EARLY_EXIT" : "ON_TIME", lateMinutes: late, earlyMinutes: early };
}

// ---------------------------------------------------------------------------
//  Holidays & calendars
// ---------------------------------------------------------------------------

export interface CalHoliday { name: string; date: string; isOptional: boolean; dayType?: string | null }

/** Parse a holiday CSV: Name,Date(YYYY-MM-DD or DD/MM/YYYY),Optional(Yes/No),DayType. */
export function parseHolidayCsv(text: string): { rows: CalHoliday[]; errors: string[] } {
  const rows: CalHoliday[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && /^name$/i.test(cells[0] ?? "")) return;
    const [name = "", rawDate = "", opt = "", dayType = ""] = cells;
    let date = rawDate;
    const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(rawDate);
    if (dmy) date = `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
    if (!name) { errors.push(`Line ${i + 1}: name is missing.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) { errors.push(`Line ${i + 1}: "${rawDate}" is not a date.`); return; }
    rows.push({ name: name.slice(0, 80), date, isOptional: /^(y|yes|true|1|optional)$/i.test(opt), dayType: dayType ? dayType.toUpperCase().slice(0, 30) : null });
  });
  return { rows, errors };
}

/** Holidays added, removed, moved or retagged between two versions. */
export function calendarDiff(a: CalHoliday[], b: CalHoliday[]): Array<{ change: "ADDED" | "REMOVED" | "MOVED" | "CHANGED"; name: string; from?: string; to?: string }> {
  const out: Array<{ change: "ADDED" | "REMOVED" | "MOVED" | "CHANGED"; name: string; from?: string; to?: string }> = [];
  const key = (h: CalHoliday) => h.name.trim().toLowerCase();
  const am = new Map(a.map((h) => [key(h), h])), bm = new Map(b.map((h) => [key(h), h]));
  for (const [k, h] of bm) {
    const o = am.get(k);
    if (!o) out.push({ change: "ADDED", name: h.name, to: h.date });
    else if (o.date !== h.date) out.push({ change: "MOVED", name: h.name, from: o.date, to: h.date });
    else if (o.isOptional !== h.isOptional || (o.dayType ?? null) !== (h.dayType ?? null)) out.push({ change: "CHANGED", name: h.name, from: `${o.isOptional ? "optional" : "public"}${o.dayType ? ` · ${o.dayType}` : ""}`, to: `${h.isOptional ? "optional" : "public"}${h.dayType ? ` · ${h.dayType}` : ""}` });
  }
  for (const [k, h] of am) if (!bm.has(k)) out.push({ change: "REMOVED", name: h.name, from: h.date });
  return out.sort((x, y) => (x.to ?? x.from ?? "").localeCompare(y.to ?? y.from ?? ""));
}

/** The live calendar after a revision publishes: kept as-is before the effective date, replaced from it on. */
export function mergeCalendarRevision(live: CalHoliday[], revision: CalHoliday[], effectiveFrom: string | null): CalHoliday[] {
  if (!effectiveFrom) return [...revision].sort((a, b) => a.date.localeCompare(b.date));
  return [...live.filter((h) => h.date < effectiveFrom), ...revision.filter((h) => h.date >= effectiveFrom)].sort((a, b) => a.date.localeCompare(b.date));
}

export const isWeeklyOffDay = (d: Date, config?: WeeklyOffConfig | null) => weeklyOffPortion(d, config ?? DEFAULT_WEEKLY_OFF) === "FULL_DAY";

/** Substitute holidays for public holidays that fall on a weekly off. */
export function weekendSubstitutes(holidays: CalHoliday[], config: WeeklyOffConfig | null, direction: "NEXT" | "PREVIOUS" = "NEXT"): CalHoliday[] {
  const taken = new Set(holidays.map((h) => h.date));
  const out: CalHoliday[] = [];
  for (const h of holidays) {
    if (h.isOptional) continue;
    const d = new Date(`${h.date}T00:00:00Z`);
    if (!isWeeklyOffDay(d, config)) continue;
    let c = d;
    for (let i = 0; i < 14; i++) {
      c = new Date(c.getTime() + (direction === "NEXT" ? DAY : -DAY));
      if (!isWeeklyOffDay(c, config) && !taken.has(isoKey(c))) break;
    }
    if (c.getUTCFullYear() !== d.getUTCFullYear()) continue;
    taken.add(isoKey(c));
    out.push({ name: `${h.name} (substitute)`, date: isoKey(c), isOptional: false, dayType: "SUBSTITUTE" });
  }
  return out;
}

/** Holiday count validation against the tenant limits and COUNT_LIMIT rules. */
export function holidayCountCheck(holidays: CalHoliday[], limits: { min: number; max: number; maxOptional?: number | null }): string[] {
  const pub = holidays.filter((h) => !h.isOptional).length, opt = holidays.length - pub;
  const out: string[] = [];
  if (limits.min > 0 && pub < limits.min) out.push(`Only ${pub} public holiday(s); at least ${limits.min} are required.`);
  if (limits.max > 0 && pub > limits.max) out.push(`${pub} public holidays is more than the limit of ${limits.max}.`);
  if (limits.maxOptional != null && limits.maxOptional >= 0 && opt > limits.maxOptional) out.push(`${opt} optional holidays is more than the limit of ${limits.maxOptional}.`);
  const dup = holidays.map((h) => h.date).filter((d, i, all) => all.indexOf(d) !== i);
  if (dup.length) out.push(`More than one holiday on ${[...new Set(dup)].join(", ")}.`);
  return out;
}

/** Working days a shutdown removes (its days that are not already weekly offs or holidays). */
export function shutdownWorkingDays(from: Date, to: Date, config: WeeklyOffConfig | null, existing: Set<string>): string[] {
  const out: string[] = [];
  for (let d = utcDay(from); d <= utcDay(to); d = new Date(d.getTime() + DAY)) {
    if (!isWeeklyOffDay(d, config) && !existing.has(isoKey(d))) out.push(isoKey(d));
  }
  return out;
}

/** What a calendar does to working time in its year. */
export function holidayImpact(holidays: CalHoliday[], year: number, config: WeeklyOffConfig | null) {
  let weekly = 0;
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d = new Date(d.getTime() + DAY)) if (isWeeklyOffDay(d, config)) weekly++;
  const days = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  const pub = holidays.filter((h) => !h.isOptional && h.date.startsWith(String(year)));
  const onWorking = pub.filter((h) => !isWeeklyOffDay(new Date(`${h.date}T00:00:00Z`), config)).length;
  return {
    publicHolidays: pub.length, optionalHolidays: holidays.filter((h) => h.isOptional).length,
    onWorkingDays: onWorking, onWeeklyOffs: pub.length - onWorking,
    weeklyOffs: weekly, workingDays: days - weekly - onWorking,
  };
}

export interface CalendarFacts { id: string; name: string; year: number; isDefault: boolean; locationIds: string[]; holidays: CalHoliday[] }

/** Conflicts across calendars: holidays on weekly offs, duplicates, overlapping regions, gaps. */
export function calendarConflicts(input: { calendars: CalendarFacts[]; weeklyOff: WeeklyOffConfig | null; locations: Array<{ id: string; name: string }>; year: number; unassignedEmployees: number }): Array<{ key: string; kind: string; summary: string }> {
  const out: Array<{ key: string; kind: string; summary: string }> = [];
  const thisYear = input.calendars.filter((c) => c.year === input.year);
  for (const c of thisYear) {
    for (const h of c.holidays) {
      if (!h.isOptional && isWeeklyOffDay(new Date(`${h.date}T00:00:00Z`), input.weeklyOff)) out.push({ key: `WEEKEND:${c.id}:${h.date}`, kind: "HOLIDAY_ON_WEEKLY_OFF", summary: `${c.name}: ${h.name} on ${h.date} falls on a weekly off` });
    }
    const seen = new Map<string, string>();
    for (const h of c.holidays) {
      if (seen.has(h.date)) out.push({ key: `DUP:${c.id}:${h.date}`, kind: "DUPLICATE_DATE", summary: `${c.name}: ${seen.get(h.date)} and ${h.name} are both on ${h.date}` });
      seen.set(h.date, h.name);
    }
    if (c.holidays.length === 0) out.push({ key: `EMPTY:${c.id}`, kind: "EMPTY_CALENDAR", summary: `${c.name} (${c.year}) has no holidays` });
  }
  for (const l of input.locations) {
    const covering = thisYear.filter((c) => c.locationIds.includes(l.id));
    if (covering.length > 1) out.push({ key: `OVERLAP:${input.year}:${l.id}`, kind: "OVERLAPPING_REGION", summary: `${l.name} is covered by ${covering.length} calendars in ${input.year}: ${covering.map((c) => c.name).join(", ")}` });
  }
  if (!thisYear.some((c) => c.isDefault)) out.push({ key: `NODEFAULT:${input.year}`, kind: "NO_DEFAULT", summary: `No default holiday calendar for ${input.year}` });
  if (!input.calendars.some((c) => c.year === input.year + 1)) out.push({ key: `NEXTYEAR:${input.year + 1}`, kind: "NEXT_YEAR_MISSING", summary: `No holiday calendar for ${input.year + 1} yet` });
  if (input.unassignedEmployees > 0) out.push({ key: `UNASSIGNED:${input.year}`, kind: "NO_CALENDAR", summary: `${input.unassignedEmployees} employee(s) resolve to no holiday calendar` });
  return out;
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

export const OT_DAY_TYPES = ["WORKDAY", "WEEKLY_OFF", "HOLIDAY"] as const;
export type OtDayType = (typeof OT_DAY_TYPES)[number];
export interface OtTier { upTo: number | null; multiplier: number }
export type OtTierTable = Record<OtDayType, OtTier[]>;
export interface OtWindow { start: string; end: string; multiplier: number }

/** "120:1.5, :2" → [{ upTo: 120, multiplier: 1.5 }, { upTo: null, multiplier: 2 }] */
export function parseOtTiers(text: string): { tiers: OtTier[]; error: string | null } {
  const tiers: OtTier[] = [];
  const parts = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { tiers: [{ upTo: null, multiplier: 1 }], error: null };
  let last = 0;
  for (const p of parts) {
    const m = /^(\d*)\s*:\s*(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) return { tiers: [], error: `"${p}" is not minutes:multiplier.` };
    const upTo = m[1] ? Number(m[1]) : null, mult = Number(m[2]);
    if (mult <= 0 || mult > 5) return { tiers: [], error: "Multipliers must be between 0 and 5." };
    if (upTo !== null && upTo <= last) return { tiers: [], error: "Tier limits must increase." };
    if (tiers.length && tiers[tiers.length - 1]!.upTo === null) return { tiers: [], error: "Nothing can follow the open-ended tier." };
    tiers.push({ upTo, multiplier: mult });
    if (upTo !== null) last = upTo;
  }
  if (tiers[tiers.length - 1]!.upTo !== null) tiers.push({ upTo: null, multiplier: tiers[tiers.length - 1]!.multiplier });
  return { tiers, error: null };
}
export const otTiersText = (t: OtTier[] | undefined) => (t ?? []).map((x) => `${x.upTo ?? ""}:${x.multiplier}`).join(", ");

export function otTierTable(json: unknown): OtTierTable {
  const j = (json && typeof json === "object" ? json : {}) as Partial<Record<OtDayType, OtTier[]>>;
  const ok = (v: unknown): v is OtTier[] => Array.isArray(v) && v.length > 0;
  const base: OtTier[] = ok(j.WORKDAY) ? j.WORKDAY : [{ upTo: null, multiplier: 1 }];
  return { WORKDAY: base, WEEKLY_OFF: ok(j.WEEKLY_OFF) ? j.WEEKLY_OFF : base, HOLIDAY: ok(j.HOLIDAY) ? j.HOLIDAY : ok(j.WEEKLY_OFF) ? j.WEEKLY_OFF : base };
}

/** Weighted minutes for a day's overtime through a tier table: Σ minutes in tier × multiplier. */
export function tieredOtMinutes(minutes: number, tiers: OtTier[]): number {
  let left = Math.max(0, minutes), from = 0, total = 0;
  for (const t of tiers) {
    if (left <= 0) break;
    const cap = t.upTo === null ? left : Math.max(0, t.upTo - from);
    const take = Math.min(left, cap);
    total += take * t.multiplier;
    left -= take;
    if (t.upTo !== null) from = t.upTo;
  }
  return total + left; // anything past a closed last tier at 1×
}

/** Extra weighted minutes for overtime worked inside premium windows (e.g. night), assuming overtime is the last minutes before clock-out. */
export function otWindowPremium(overtimeMinutes: number, outMinute: number | null, windows: OtWindow[]): number {
  if (outMinute === null || overtimeMinutes <= 0) return 0;
  const start = outMinute - overtimeMinutes;
  let extra = 0;
  for (const w of windows) {
    let a = hhmm(w.start), b = hhmm(w.end);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    if (b <= a) b += 1440;
    for (const shift of [0, -1440, 1440]) {
      const lo = Math.max(start, a + shift), hi = Math.min(outMinute, b + shift);
      if (hi > lo) extra += (hi - lo) * w.multiplier;
    }
  }
  return extra;
}

export interface OtRuleSpec {
  tiers: unknown; windows?: unknown; weeklyThresholdMinutes: number | null; dailyCapMinutes: number | null;
  weeklyCapMinutes: number | null; monthlyCapMinutes: number | null; minMinutes: number;
}
export interface OtDay { date: Date; dayType: OtDayType; overtimeMinutes: number; workedMinutes: number; outMinute: number | null }

/**
 * Overtime for a month under a rule: per-day overtime after the minimum and
 * the daily cap, weekly overtime above the weekly threshold (on top of what
 * daily overtime already counted), then weekly and monthly caps. Returns
 * payable minutes, the tier- and window-weighted minutes (payable hours ×
 * multiplier), and minutes cut by caps (which need exception approval).
 */
export function computeOvertime(days: OtDay[], rule: OtRuleSpec) {
  const table = otTierTable(rule.tiers);
  const windows = (Array.isArray(rule.windows) ? rule.windows : []) as OtWindow[];
  let excess = 0;
  const perDay = days.map((d) => {
    let m = d.overtimeMinutes >= rule.minMinutes ? d.overtimeMinutes : 0;
    if (rule.dailyCapMinutes !== null && m > rule.dailyCapMinutes) { excess += m - rule.dailyCapMinutes; m = rule.dailyCapMinutes; }
    return { date: d.date, dayType: d.dayType, minutes: m, worked: d.workedMinutes, outMinute: d.outMinute };
  });
  // ISO weeks (Monday start).
  const weekOf = (d: Date) => { const x = utcDay(d); const dow = (x.getUTCDay() + 6) % 7; return isoKey(new Date(x.getTime() - dow * DAY)); };
  const weeks = new Map<string, typeof perDay>();
  for (const d of perDay) weeks.set(weekOf(d.date), [...(weeks.get(weekOf(d.date)) ?? []), d]);
  let weeklyRaw = 0, payable = 0;
  const weekRows: Array<{ week: string; daily: number; weekly: number; capped: number }> = [];
  for (const [week, rows] of weeks) {
    const daily = rows.reduce((s, r) => s + r.minutes, 0);
    const weekly = rule.weeklyThresholdMinutes === null ? 0 : Math.max(0, rows.reduce((s, r) => s + r.worked, 0) - rule.weeklyThresholdMinutes - daily);
    let total = daily + weekly, capped = 0;
    if (rule.weeklyCapMinutes !== null && total > rule.weeklyCapMinutes) { capped = total - rule.weeklyCapMinutes; total = rule.weeklyCapMinutes; }
    excess += capped;
    weeklyRaw += weekly;
    payable += total;
    weekRows.push({ week, daily, weekly, capped });
  }
  if (rule.monthlyCapMinutes !== null && payable > rule.monthlyCapMinutes) { excess += payable - rule.monthlyCapMinutes; payable = rule.monthlyCapMinutes; }
  // Weighting: each day through its tier table plus window premium, weekly
  // overtime at the first workday rate; caps scale the weighted total down.
  const raw = perDay.reduce((s, r) => s + r.minutes, 0) + weeklyRaw;
  const scale = raw > 0 ? payable / raw : 0;
  const weightedDaily = perDay.reduce((s, r) => s + tieredOtMinutes(r.minutes, table[r.dayType]) + otWindowPremium(r.minutes, r.outMinute, windows), 0);
  const weighted = (weightedDaily + weeklyRaw * (table.WORKDAY[0]?.multiplier ?? 1)) * scale;
  const weeklyExtra = weeklyRaw;
  return {
    payableMinutes: Math.round(payable), weightedMinutes: Math.round(weighted), excessMinutes: Math.round(excess),
    weeklyMinutes: Math.round(weeklyExtra), days: perDay.filter((d) => d.minutes > 0).length, weeks: weekRows,
  };
}

export interface OtRuleEligibility { id: string; priority: number; status: string; bandIds: string[]; payGradeIds: string[]; shiftIds: string[]; locationIds: string[] }

/** The overtime rule covering an employee: the highest-priority active rule whose lists include them. */
export function overtimeRuleFor<T extends OtRuleEligibility>(rules: T[], emp: { bandId: string | null; payGradeId: string | null; shiftId: string | null; locationId: string | null }): T | null {
  const fit = (list: string[], v: string | null) => list.length === 0 || (!!v && list.includes(v));
  return rules.filter((r) => r.status === "ACTIVE" && fit(r.bandIds, emp.bandId) && fit(r.payGradeIds, emp.payGradeId) && fit(r.shiftIds, emp.shiftId) && fit(r.locationIds, emp.locationId))
    .sort((a, b) => b.priority - a.priority)[0] ?? null;
}

/** Pre-approval (ask before the day) and post-facto window rules for an overtime request. */
export function overtimeTimingCheck(rule: { name: string; requirePreApproval: boolean; postFactoDays: number | null } | null, workDate: Date, today: Date): { ok: boolean; message: string } {
  if (!rule) return { ok: true, message: "" };
  const w = utcDay(workDate).getTime(), t = utcDay(today).getTime();
  if (rule.requirePreApproval && w < t) return { ok: false, message: `${rule.name} needs overtime to be approved in advance — request it before the day.` };
  if (!rule.requirePreApproval && rule.postFactoDays !== null && w < t - rule.postFactoDays * DAY) return { ok: false, message: `${rule.name} allows overtime to be claimed up to ${rule.postFactoDays} day(s) after it was worked.` };
  return { ok: true, message: "" };
}

/** Requested vs logged vs paid overtime for a month. */
export function overtimeReconciliation(r: { requestedMinutes: number; approvedMinutes: number; loggedMinutes: number; paidMinutes: number }) {
  const variance = r.paidMinutes - r.approvedMinutes;
  const unclaimed = Math.max(0, r.loggedMinutes - r.requestedMinutes);
  const status = variance > 0 ? "OVERPAID" : variance < 0 ? "UNPAID_APPROVED" : r.requestedMinutes > r.loggedMinutes + 30 ? "CLAIM_EXCEEDS_LOG" : unclaimed > 60 ? "UNCLAIMED_LOGGED" : "MATCHED";
  return { variance, unclaimed, status };
}

/** Anomaly flags in a month of daily overtime. */
export function overtimeAnomalies(days: Array<{ date: Date; overtimeMinutes: number }>, opts: { dailyLimit: number; previousMonthMinutes: number | null; requestedMinutes: number }): Array<{ kind: string; periodKey: string; detail: string }> {
  const out: Array<{ kind: string; periodKey: string; detail: string }> = [];
  for (const d of days) {
    if (d.overtimeMinutes > opts.dailyLimit) out.push({ kind: "ANOMALY_DAILY", periodKey: isoKey(d.date), detail: `${Math.round(d.overtimeMinutes / 6) / 10} h of overtime on ${isoKey(d.date)} (limit ${opts.dailyLimit / 60} h)` });
  }
  const total = days.reduce((s, d) => s + d.overtimeMinutes, 0);
  const month = days[0] ? isoKey(days[0].date).slice(0, 7) : "";
  if (opts.previousMonthMinutes !== null && opts.previousMonthMinutes >= 120 && total > opts.previousMonthMinutes * 2) out.push({ kind: "ANOMALY_SPIKE", periodKey: month, detail: `Overtime more than doubled: ${Math.round(total / 60)} h against ${Math.round(opts.previousMonthMinutes / 60)} h last month` });
  if (total >= 240 && opts.requestedMinutes === 0) out.push({ kind: "ANOMALY_NO_REQUEST", periodKey: month, detail: `${Math.round(total / 60)} h of overtime logged with no overtime request` });
  return out;
}

/** Comp-off credits lapsing within the reminder window. */
export function compOffExpiringSoon(credits: Array<{ id: string; employeeId: string; days: number; expiresOn: Date | null }>, today: Date, withinDays: number) {
  const t = utcDay(today).getTime();
  return credits.filter((c) => c.expiresOn && c.days > 0 && c.expiresOn.getTime() >= t && c.expiresOn.getTime() - t <= withinDays * DAY);
}
