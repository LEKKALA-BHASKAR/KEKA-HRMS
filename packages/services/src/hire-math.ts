/**
 * Hire: the pure rules behind requisitions and interview scorecards — no
 * database, so they are unit-tested directly and shared by the server
 * actions, the seed and the screens.
 */

export const BACKFILL_REASONS = [
  ["INTERNAL_MOVEMENT", "Internal movement"],
  ["MATERNITY_LEAVE", "Maternity leave"],
  ["PROMOTION", "Promotion"],
  ["RELIEVED", "Relieved"],
  ["RELOCATED", "Relocated"],
  ["RETIRED", "Retired"],
  ["OTHERS", "Others"],
] as const;
export type BackfillReasonKey = (typeof BACKFILL_REASONS)[number][0];
export const backfillReasonLabel = (k: string) => BACKFILL_REASONS.find(([v]) => v === k)?.[1] ?? k;

export const SALARY_FREQUENCIES = [
  ["HOURLY", "Hourly"],
  ["BIWEEKLY", "Bi Weekly"],
  ["MONTHLY", "Monthly"],
  ["ANNUAL", "Annual"],
] as const;
export type SalaryFrequency = (typeof SALARY_FREQUENCIES)[number][0];
export const salaryFrequencyLabel = (k: string | null | undefined) => SALARY_FREQUENCIES.find(([v]) => v === k)?.[1] ?? "NA";

export const JOB_TYPES = [["FULL_TIME", "Full Time"], ["PART_TIME", "Part Time"]] as const;
export const jobTypeLabel = (k: string | null | undefined) => JOB_TYPES.find(([v]) => v === k)?.[1] ?? "—";

export const EMPLOYMENT_TYPES = [["PERMANENT", "Permanent"], ["CONTRACT", "Contract"], ["INTERN", "Intern"], ["CONSULTANT", "Consultant"]] as const;
export const employmentTypeLabel = (k: string | null | undefined) => EMPLOYMENT_TYPES.find(([v]) => v === k)?.[1] ?? "—";

export const CURRENCIES = [
  ["INR", "India Rupee"], ["USD", "United States Dollar"], ["EUR", "Euro"], ["GBP", "British Pound"],
  ["AED", "UAE Dirham"], ["SGD", "Singapore Dollar"], ["AUD", "Australian Dollar"], ["CAD", "Canadian Dollar"],
] as const;
export const currencyLabel = (k: string) => {
  const c = CURRENCIES.find(([v]) => v === k);
  return c ? `${c[0]} - ${c[1]}` : k;
};

/** Hours, pay periods and months in a year — how a quoted range becomes an annual budget. */
const PER_YEAR: Record<SalaryFrequency, number> = { HOURLY: 2080, BIWEEKLY: 26, MONTHLY: 12, ANNUAL: 1 };

export function annualise(amount: number, frequency: string | null | undefined): number | null {
  if (!frequency || !(frequency in PER_YEAR)) return null;
  return Math.round(amount * PER_YEAR[frequency as SalaryFrequency] * 100) / 100;
}

/**
 * The INR annual budget a requisition approves, which later caps an offer.
 * A range in another currency, or one without a frequency, sets no ceiling:
 * there is no exchange-rate source to convert it honestly.
 */
export function annualBudget(r: { currency: string; salaryMin: number | null; salaryMax: number | null; salaryFrequency: string | null }): { minAnnualCtc: number | null; maxAnnualCtc: number | null } {
  if (r.currency !== "INR" || !r.salaryFrequency) return { minAnnualCtc: null, maxAnnualCtc: null };
  return {
    minAnnualCtc: r.salaryMin === null ? null : annualise(r.salaryMin, r.salaryFrequency),
    maxAnnualCtc: r.salaryMax === null ? null : annualise(r.salaryMax, r.salaryFrequency),
  };
}

/** REQ-0001, REQ-0002… continuing from the highest code a tenant has used. */
export function nextRequisitionCode(codes: Array<string | null>): string {
  const max = codes.reduce((m, c) => {
    const n = /^REQ-(\d+)$/.exec(c ?? "")?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);
  return `REQ-${String(max + 1).padStart(4, "0")}`;
}

export interface RequisitionDraft {
  title: string;
  departmentId: string | null;
  newHire: boolean;
  newPositions: number;
  backfills: Array<{ employeeId: string; reason: string }>;
  currency: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryFrequency: string | null;
  description: string;
  targetStartDate: Date | null;
}

/** Field-level problems with a requisition, keyed by form field; empty when it is valid. */
export function requisitionProblems(d: RequisitionDraft, today: Date): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.title.trim()) e.title = "Select or enter a job title";
  if (!d.departmentId) e.departmentId = "Select a department";
  if (!d.newHire && d.backfills.length === 0) e.positions = "Choose New Hire, Backfill or both";
  if (d.newHire && !(d.newPositions >= 1 && d.newPositions <= 100)) e.newPositions = "Between 1 and 100 positions";
  const seen = new Set<string>();
  for (const b of d.backfills) {
    if (seen.has(b.employeeId)) e.backfills = "Each employee can be backfilled once";
    seen.add(b.employeeId);
    if (!BACKFILL_REASONS.some(([k]) => k === b.reason)) e.backfills = "Select a backfill reason for every employee";
  }
  if (!CURRENCIES.some(([c]) => c === d.currency)) e.currency = "Unknown currency";
  if (d.salaryMin !== null && d.salaryMin < 0) e.salaryMin = "Cannot be negative";
  if (d.salaryMax !== null && d.salaryMax < 0) e.salaryMax = "Cannot be negative";
  if (d.salaryMin !== null && d.salaryMax !== null && d.salaryMin > d.salaryMax) e.salaryMax = "Max range is below min range";
  if ((d.salaryMin !== null || d.salaryMax !== null) && !d.salaryFrequency) e.salaryFrequency = "Choose how often";
  if (d.salaryFrequency && !SALARY_FREQUENCIES.some(([f]) => f === d.salaryFrequency)) e.salaryFrequency = "Unknown frequency";
  if (d.description.trim().length < 30) e.description = "Add a job description (at least 30 characters)";
  if (d.targetStartDate) {
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (d.targetStartDate.getTime() < t) e.targetStartDate = "The target hiring date has passed";
  }
  return e;
}

/** Total positions = new hires plus one per backfilled employee. */
export function totalPositions(d: { newHire: boolean; newPositions: number; backfills: unknown[] }): number {
  return (d.newHire ? d.newPositions : 0) + d.backfills.length;
}

export type RequisitionTone = "pending" | "approved" | "progress" | "rejected" | "done" | "archived";

/** The two-line status Keka shows in the list: "Pending / on X", "Hiring in Progress / View Job". */
export function requisitionStatus(r: { status: string; archivedAt: Date | null; jobCount: number }): { label: string; tone: RequisitionTone } {
  if (r.archivedAt) return { label: "Archived", tone: "archived" };
  switch (r.status) {
    case "PENDING_APPROVAL": return { label: "Pending", tone: "pending" };
    case "APPROVED": return r.jobCount > 0 ? { label: "Hiring in Progress", tone: "progress" } : { label: "Approved", tone: "approved" };
    case "REJECTED": return { label: "Rejected", tone: "rejected" };
    case "FULFILLED": return { label: "Fulfilled", tone: "done" };
    case "CANCELLED": return { label: "Cancelled", tone: "archived" };
    case "ON_HOLD": return { label: "On Hold", tone: "pending" };
    default: return { label: "Draft", tone: "pending" };
  }
}

// --- Scorecards -----------------------------------------------------------------

export const DECISIONS = [
  ["NO_HIRE", "No Hire"],
  ["NOT_SURE", "Not Sure"],
  ["AVERAGE", "Average"],
  ["HIRE", "Hire"],
  ["MUST_HIRE", "Must Hire"],
] as const;
export type Decision = (typeof DECISIONS)[number][0];

const LEGACY: Record<string, Decision> = { STRONG_YES: "MUST_HIRE", YES: "HIRE", NO: "NO_HIRE", STRONG_NO: "NO_HIRE" };

/** A recommendation in Keka's five levels, mapping the four legacy values. */
export function normaliseDecision(v: string | null | undefined): Decision | null {
  if (!v) return null;
  if (DECISIONS.some(([k]) => k === v)) return v as Decision;
  return LEGACY[v] ?? null;
}
export const decisionLabel = (v: string | null | undefined) => {
  const d = normaliseDecision(v);
  return d ? DECISIONS.find(([k]) => k === d)![1] : "—";
};
export const isPositiveDecision = (d: Decision | null) => d === "HIRE" || d === "MUST_HIRE";

export interface KitSkill { name: string; description?: string | null }
export interface KitSection { section: string; skills: KitSkill[] }

/** The interview kit a job uses when none has been set. */
export const DEFAULT_SCORECARD: KitSection[] = [
  {
    section: "Soft Skills",
    skills: [
      { name: "Communication", description: "Explains ideas clearly and listens; adapts to the audience." },
      { name: "Collaboration", description: "Works well with others, shares credit and resolves disagreement constructively." },
      { name: "Critical Thinking", description: "Breaks problems down, weighs trade-offs and reasons from evidence." },
      { name: "Ownership", description: "Takes responsibility for outcomes and follows through without being chased." },
      { name: "Adaptability", description: "Learns quickly and stays effective when plans change." },
    ],
  },
];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A job's scorecard template, validated; null when the stored value is unusable. */
export function parseKit(json: unknown): KitSection[] | null {
  if (!Array.isArray(json)) return null;
  const out: KitSection[] = [];
  for (const s of json) {
    const section = str((s as KitSection)?.section, 80);
    const skills = Array.isArray((s as KitSection)?.skills) ? (s as KitSection).skills : [];
    const clean = skills.map((k) => ({ name: str(k?.name, 80), description: str(k?.description, 400) || null })).filter((k) => k.name);
    if (section && clean.length) out.push({ section, skills: clean.slice(0, 20) });
  }
  return out.length ? out.slice(0, 10) : null;
}
export const kitOf = (json: unknown): KitSection[] => parseKit(json) ?? DEFAULT_SCORECARD;

export interface SkillRating { section: string; skill: string; rating: number | null; comment: string | null }

/**
 * Ratings as stored. Reads both shapes: Keka's `[{section, skill, rating,
 * comment}]` and the legacy `[{competency, rating, maxRating, comment}]`,
 * which is rescaled to five stars under an "Overall" section.
 */
export function parseRatings(json: unknown): SkillRating[] {
  if (!Array.isArray(json)) return [];
  const out: SkillRating[] = [];
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const raw = typeof o.rating === "number" ? o.rating : null;
    if ("competency" in o) {
      const max = typeof o.maxRating === "number" && o.maxRating > 0 ? o.maxRating : 5;
      out.push({ section: "Overall", skill: str(o.competency, 80), rating: raw === null ? null : Math.round((raw / max) * 5 * 10) / 10, comment: str(o.comment, 1000) || null });
    } else {
      out.push({ section: str(o.section, 80), skill: str(o.skill, 80), rating: raw, comment: str(o.comment, 1000) || null });
    }
  }
  return out.filter((r) => r.skill);
}

/**
 * Keep only ratings for skills the kit actually has, each a whole 1–5 star
 * count or N/A — a form cannot invent skills or scores.
 */
export function cleanRatings(input: unknown, kit: KitSection[]): SkillRating[] {
  const allowed = new Set(kit.flatMap((s) => s.skills.map((k) => `${s.section}\u0000${k.name}`)));
  const seen = new Set<string>();
  const out: SkillRating[] = [];
  for (const r of parseRatings(input)) {
    const key = `${r.section}\u0000${r.skill}`;
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const rating = r.rating !== null && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : null;
    if (rating === null && !r.comment) continue;
    out.push({ ...r, rating });
  }
  return out;
}

/** "Scorecard average": the mean of the rated skills, to two places; null when nothing is rated. */
export function ratingsAverage(ratings: SkillRating[]): number | null {
  const rated = ratings.filter((r) => r.rating !== null) as Array<SkillRating & { rating: number }>;
  if (rated.length === 0) return null;
  return Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 100) / 100;
}

/** How the panel decided: each decision with its count, most common first. */
export function decisionTally(values: Array<string | null | undefined>): Array<{ decision: Decision; label: string; count: number }> {
  const counts = new Map<Decision, number>();
  for (const v of values) {
    const d = normaliseDecision(v);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const order = (d: Decision) => DECISIONS.findIndex(([k]) => k === d);
  return [...counts.entries()]
    .map(([decision, count]) => ({ decision, label: DECISIONS[order(decision)][1], count }))
    .sort((a, b) => b.count - a.count || order(b.decision) - order(a.decision));
}

/** Plain text of a markdown-ish note, for length rules and previews. */
export function plainText(s: string | null | undefined): string {
  return (s ?? "").replace(/[*_`#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

/** Validate an AI question set: every requested skill answered with 3–6 distinct, bounded questions. */
export function validateQuestionSet(value: unknown, skills: string[]): Array<{ skill: string; questions: string[] }> | null {
  const list = (value as { skills?: unknown })?.skills;
  if (!Array.isArray(list)) return null;
  const out: Array<{ skill: string; questions: string[] }> = [];
  for (const skill of skills) {
    const hit = list.find((x) => typeof x?.skill === "string" && x.skill.trim().toLowerCase() === skill.toLowerCase());
    if (!hit || !Array.isArray(hit.questions)) return null;
    const qs = [...new Set((hit.questions as unknown[]).filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter((q) => q.length > 10 && q.length <= 300))];
    if (qs.length < 3) return null;
    out.push({ skill, questions: qs.slice(0, 6) });
  }
  return out;
}

/** Validate an AI feedback summary: refs must be ones we sent. */
export function validateSummary(value: unknown, refs: string[]): { summary: string; individual: Array<{ ref: string; text: string }> } | null {
  const v = value as { summary?: unknown; individual?: unknown };
  if (typeof v?.summary !== "string" || v.summary.trim().length < 20) return null;
  const individual: Array<{ ref: string; text: string }> = [];
  if (Array.isArray(v.individual)) {
    for (const i of v.individual) {
      if (typeof i?.ref !== "string" || typeof i?.text !== "string") return null;
      if (!refs.includes(i.ref)) return null;
      individual.push({ ref: i.ref, text: i.text.trim().slice(0, 400) });
    }
  }
  return { summary: v.summary.trim().slice(0, 3000), individual };
}
