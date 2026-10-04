/**
 * Talent depth — pure rules for performance and hiring parity features:
 * calibration bands and the 9-box, review form answers and stage windows,
 * promotion eligibility, feedback rules, candidate profile scoring,
 * approval-chain rule matching, growth plan items and interview slots.
 * No database access here, so every rule is unit tested.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Calibration bands
// ---------------------------------------------------------------------------

export interface BandRow { name: string; minRating: number; maxRating: number; targetPercent: number | null; color?: string | null }

/**
 * Bands must not overlap, must each have min < max, must sit inside the
 * rating scale, and the target distribution (when every band has one) must
 * add up to 100.
 */
export function bandProblems(rows: BandRow[], scaleMax = 5): string | null {
  if (rows.length < 2) return "Keep at least two bands.";
  const names = rows.map((r) => r.name.trim().toLowerCase());
  if (names.some((n) => !n)) return "Every band needs a name.";
  if (new Set(names).size !== names.length) return "Band names must be unique.";
  for (const r of rows) {
    if (![r.minRating, r.maxRating].every(Number.isFinite)) return `Enter the range for ${r.name}.`;
    if (r.minRating < 0 || r.maxRating > scaleMax) return `${r.name} must sit within 0 to ${scaleMax}.`;
    if (!(r.minRating < r.maxRating)) return `${r.name}: the lower bound must be below the upper.`;
    if (r.targetPercent !== null && (r.targetPercent < 0 || r.targetPercent > 100)) return `${r.name}: the target must be 0 to 100%.`;
  }
  const sorted = [...rows].sort((a, b) => a.minRating - b.minRating);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minRating < sorted[i - 1].maxRating - 1e-9) return `${sorted[i - 1].name} and ${sorted[i].name} overlap.`;
    if (sorted[i].minRating > sorted[i - 1].maxRating + 1e-9) return `There is a gap between ${sorted[i - 1].name} and ${sorted[i].name}.`;
  }
  const targets = rows.map((r) => r.targetPercent);
  if (targets.every((t) => t !== null)) {
    const total = r2(targets.reduce((s, t) => s + (t ?? 0), 0));
    if (Math.abs(total - 100) > 0.01) return `Target distribution adds up to ${total}%, not 100%.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  9-box grid
// ---------------------------------------------------------------------------

/** 0 = low, 1 = moderate, 2 = high, on a 1–5 scale. */
export function tierOf(rating: number, scaleMax = 5): 0 | 1 | 2 {
  const x = (rating / scaleMax) * 5;
  return x < 2.5 ? 0 : x < 3.75 ? 1 : 2;
}

/** [potential][performance] */
export const NINE_BOX: string[][] = [
  ["Talent risk", "Effective performer", "Trusted professional"],
  ["Inconsistent performer", "Core player", "High performer"],
  ["Rough diamond", "Future star", "Star"],
];

export function nineBoxCell(performance: number, potential: number, scaleMax = 5): { perf: 0 | 1 | 2; pot: 0 | 1 | 2; label: string } {
  const perf = tierOf(performance, scaleMax);
  const pot = tierOf(potential, scaleMax);
  return { perf, pot, label: NINE_BOX[pot][perf] };
}

// ---------------------------------------------------------------------------
//  Review form answers and stage windows
// ---------------------------------------------------------------------------

export interface FormQuestion { id: string; kind: string; prompt: string; isRequired: boolean; appliesTo: string[] | null }

export function questionApplies(q: { appliesTo: unknown }, reviewerType: string): boolean {
  const list = Array.isArray(q.appliesTo) ? (q.appliesTo as unknown[]).map(String) : [];
  return list.length === 0 || list.includes(reviewerType);
}

/**
 * Check one reviewer's answers to the cycle's form. Ratings are 1..scaleMax,
 * text is trimmed and capped. Returns cleaned answers keyed by question id.
 */
export function checkFormAnswers(questions: FormQuestion[], reviewerType: string, raw: Record<string, string | undefined>, scaleMax = 5):
  { ok: true; answers: Record<string, string | number> } | { ok: false; message: string; questionId: string } {
  const answers: Record<string, string | number> = {};
  for (const q of questions) {
    if (!questionApplies(q, reviewerType)) continue;
    const v = (raw[q.id] ?? "").trim();
    if (!v) {
      if (q.isRequired) return { ok: false, message: `Answer “${q.prompt}”.`, questionId: q.id };
      continue;
    }
    if (q.kind === "RATING" || q.kind === "COMPETENCY") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > scaleMax) return { ok: false, message: `Rate “${q.prompt}” from 1 to ${scaleMax}.`, questionId: q.id };
      answers[q.id] = n;
    } else {
      answers[q.id] = v.slice(0, 4000);
    }
  }
  return { ok: true, answers };
}

export interface StageDates {
  selfStartsAt?: Date | null; selfEndsAt?: Date | null; managerStartsAt?: Date | null; managerEndsAt?: Date | null;
  calibrationStartsAt?: Date | null; calibrationEndsAt?: Date | null; publishOn?: Date | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Why this reviewer cannot submit now, or null. End dates include the whole day. */
export function stageWindowProblem(stage: StageDates | null | undefined, reviewerType: string, now = new Date()): string | null {
  if (!stage) return null;
  const [from, to, what] = reviewerType === "SELF" ? [stage.selfStartsAt, stage.selfEndsAt, "Self reviews"]
    : reviewerType === "MANAGER" ? [stage.managerStartsAt, stage.managerEndsAt, "Manager reviews"]
    : [null, null, ""];
  if (from && day(now) < day(from)) return `${what} open on ${day(from)}.`;
  if (to && day(now) > day(to)) return `${what} closed on ${day(to)}.`;
  return null;
}

/** Stage dates must run in order: self ≤ manager ≤ calibration ≤ publish, each start before its end. */
export function stageOrderProblem(s: StageDates): string | null {
  const pairs: Array<[Date | null | undefined, Date | null | undefined, string]> = [
    [s.selfStartsAt, s.selfEndsAt, "Self review"], [s.managerStartsAt, s.managerEndsAt, "Manager review"], [s.calibrationStartsAt, s.calibrationEndsAt, "Calibration"],
  ];
  for (const [a, b, n] of pairs) if (a && b && a > b) return `${n} must end after it starts.`;
  const seq = [s.selfStartsAt, s.managerStartsAt, s.calibrationStartsAt, s.publishOn].filter((d): d is Date => !!d);
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return "Stages must follow each other: self, manager, calibration, then publish.";
  if (s.calibrationEndsAt && s.publishOn && s.publishOn < s.calibrationEndsAt) return "Publish on or after calibration ends.";
  return null;
}

// ---------------------------------------------------------------------------
//  Promotion eligibility
// ---------------------------------------------------------------------------

export interface PromotionRules { minTenureMonths: number; minMonthsSinceLastPromotion: number; minRating: number; excludeOnPip: boolean }

export function tenureMonths(from: Date, to: Date): number {
  let m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

export function promotionEligibility(p: { dateOfJoining: Date; lastPromotionAt: Date | null; rating: number | null; onPip: boolean }, rules: PromotionRules, today = new Date()): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const tenure = tenureMonths(p.dateOfJoining, today);
  if (tenure < rules.minTenureMonths) reasons.push(`${tenure} month(s) of tenure; ${rules.minTenureMonths} needed`);
  if (p.lastPromotionAt) {
    const since = tenureMonths(p.lastPromotionAt, today);
    if (since < rules.minMonthsSinceLastPromotion) reasons.push(`promoted ${since} month(s) ago; ${rules.minMonthsSinceLastPromotion} needed`);
  }
  if (p.rating === null) reasons.push("no final rating yet");
  else if (p.rating < rules.minRating) reasons.push(`rated ${p.rating}; ${rules.minRating} needed`);
  if (rules.excludeOnPip && p.onPip) reasons.push("on an active improvement plan");
  return { eligible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
//  Feedback rules
// ---------------------------------------------------------------------------

export interface FeedbackRules { whoCanGive: string; allowAnonymous: boolean }

/**
 * Whether the giver may give feedback about the subject under the company's
 * setting. Managers up the line can always give feedback to their reports.
 */
export function feedbackAllowed(rules: FeedbackRules, giver: { id: string; departmentId: string | null }, subject: { id: string; departmentId: string | null; managerChain: string[] }): string | null {
  if (giver.id === subject.id) return "Choose a colleague other than yourself.";
  if (subject.managerChain.includes(giver.id)) return null;
  if (rules.whoCanGive === "SAME_DEPARTMENT" && (!giver.departmentId || giver.departmentId !== subject.departmentId)) return "Your company allows feedback only within your department.";
  if (rules.whoCanGive === "REPORTING_LINE") return "Your company allows feedback only from managers in the reporting line.";
  return null;
}

// ---------------------------------------------------------------------------
//  Candidate profile score
// ---------------------------------------------------------------------------

export interface ScoreWeights { skillsWeight: number; experienceWeight: number; educationWeight: number; skillKeywords: string[]; educationKeywords: string[]; idealExperienceYears: number }

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function asStringList(json: unknown): string[] {
  if (Array.isArray(json)) return [...new Set(json.map((x) => norm(String(x))).filter(Boolean))];
  if (typeof json === "string") return [...new Set(json.split(/[\n,]/).map(norm).filter(Boolean))];
  return [];
}

/**
 * A 0–100 profile score. Skills: share of the wanted skills (the job's plus
 * the company's keywords) the candidate lists. Experience: years against the
 * job's minimum (or the ideal), capped at full marks. Education: full marks
 * when any education keyword appears in what they wrote.
 */
export function candidateScore(c: { skills: unknown; experienceYears: number | null; education: string | null }, job: { skills: unknown; minExperienceYears: number | null }, w: ScoreWeights): { score: number; skills: number; experience: number; education: number; matched: string[] } {
  const total = w.skillsWeight + w.experienceWeight + w.educationWeight || 1;
  const wanted = [...new Set([...asStringList(job.skills), ...w.skillKeywords.map(norm)])];
  const has = asStringList(c.skills);
  const matched = wanted.filter((k) => has.some((h) => h === k || h.includes(k) || k.includes(h)));
  const skills = wanted.length ? matched.length / wanted.length : has.length ? 1 : 0;
  const target = job.minExperienceYears && job.minExperienceYears > 0 ? job.minExperienceYears : w.idealExperienceYears;
  const experience = c.experienceYears === null ? 0 : target > 0 ? Math.min(1, c.experienceYears / target) : 1;
  const edu = norm(c.education ?? "");
  const education = !edu ? 0 : w.educationKeywords.length === 0 ? 1 : w.educationKeywords.some((k) => edu.includes(norm(k))) ? 1 : 0;
  const score = Math.round(((skills * w.skillsWeight + experience * w.experienceWeight + education * w.educationWeight) / total) * 100);
  return { score, skills: Math.round(skills * 100), experience: Math.round(experience * 100), education: education * 100, matched };
}

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

export interface ApprovalRuleShape { id: string; departmentId: string | null; minAmount: number | null; approverUserIds: string[]; priority: number; isActive: boolean }

/** The first active rule (by priority) whose department and amount match. */
export function pickApprovalRule<T extends ApprovalRuleShape>(rules: T[], ctx: { departmentId: string | null; amount: number | null }): T | null {
  return [...rules].filter((r) => r.isActive && r.approverUserIds.length > 0).sort((a, b) => a.priority - b.priority).find((r) =>
    (!r.departmentId || r.departmentId === ctx.departmentId) && (r.minAmount === null || (ctx.amount !== null && ctx.amount >= r.minAmount)),
  ) ?? null;
}

/** The chain's approvers in order, never the requester, never twice. */
export function chainApprovers(ids: string[], requester: string | null): string[] {
  return [...new Set(ids.filter((u) => u && u !== requester))];
}

// ---------------------------------------------------------------------------
//  Growth plans
// ---------------------------------------------------------------------------

export const GROWTH_KINDS = ["SKILL", "COURSE", "MILESTONE", "MENTORING"] as const;
export interface GrowthItem { title: string; kind: string; dueInDays: number | null }

/** One item per line: "Title | KIND | days". Kind and days are optional. */
export function parseGrowthItems(text: string): { items: GrowthItem[]; error?: string } {
  const items: GrowthItem[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const [title, kindRaw, daysRaw] = line.split("|").map((s) => s.trim());
    if (!title) return { items, error: `Line ${i + 1} needs a title.` };
    const kind = (kindRaw || "MILESTONE").toUpperCase();
    if (!(GROWTH_KINDS as readonly string[]).includes(kind)) return { items, error: `Line ${i + 1}: kind must be one of ${GROWTH_KINDS.join(", ")}.` };
    const days = daysRaw ? Number(daysRaw) : null;
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 730)) return { items, error: `Line ${i + 1}: days must be a whole number up to 730.` };
    items.push({ title: title.slice(0, 200), kind, dueInDays: days });
  }
  if (items.length === 0) return { items, error: "Add at least one item." };
  if (items.length > 40) return { items, error: "Up to 40 items." };
  return { items };
}

export function growthItemsOf(json: unknown): GrowthItem[] {
  return Array.isArray(json) ? (json as GrowthItem[]).filter((x) => x && typeof x.title === "string") : [];
}

// ---------------------------------------------------------------------------
//  Interview slots
// ---------------------------------------------------------------------------

/** Distinct future slots, sorted, 1 to 10 of them. */
export function cleanSlots(raw: string[], now = new Date()): { slots: Date[]; error?: string } {
  // A datetime-local value ("2026-10-05T10:00") is read as UTC, like the rest of Hire.
  const asUtc = (s: string) => (/[zZ]$|[+-]\d\d:\d\d$/.test(s) ? s : /T\d\d:\d\d$/.test(s) ? `${s}:00Z` : `${s}Z`);
  const dates = [...new Set(raw.map((s) => s.trim()).filter(Boolean))].map((s) => new Date(asUtc(s)));
  if (dates.some((d) => Number.isNaN(d.getTime()))) return { slots: [], error: "A slot is not a valid date and time." };
  const future = dates.filter((d) => d.getTime() > now.getTime() + 30 * 60_000);
  if (future.length !== dates.length) return { slots: [], error: "Offer only slots at least 30 minutes from now." };
  if (future.length === 0) return { slots: [], error: "Offer at least one slot." };
  if (future.length > 10) return { slots: [], error: "Offer up to 10 slots." };
  return { slots: future.sort((a, b) => a.getTime() - b.getTime()) };
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

/** Count rows by a key, hiding groups smaller than `min` (privacy for EEO). */
export function countGroups<T>(rows: T[], key: (r: T) => string, min = 1): Array<{ key: string; count: number; percent: number }> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  const n = rows.length || 1;
  const out = [...m].map(([k, count]) => ({ key: k, count, percent: r2((count / n) * 100) })).sort((a, b) => b.count - a.count);
  if (min <= 1) return out;
  const shown = out.filter((x) => x.count >= min);
  const hidden = out.filter((x) => x.count < min).reduce((s, x) => s + x.count, 0);
  return hidden ? [...shown, { key: `Other (groups under ${min})`, count: hidden, percent: r2((hidden / n) * 100) }] : shown;
}

export const EEO_OPTIONS = {
  gender: ["Female", "Male", "Non-binary", "Prefer to self-describe"],
  ethnicity: ["Asian", "Black or African", "Hispanic or Latino", "Middle Eastern or North African", "White", "Two or more", "Other"],
  veteranStatus: ["Not a veteran", "Veteran"],
  disabilityStatus: ["No disability", "Has a disability"],
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (s: string) => HEX.test(s);
