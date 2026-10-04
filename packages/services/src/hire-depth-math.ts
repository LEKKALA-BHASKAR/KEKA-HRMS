/**
 * Hire depth — pure rules, no database: boolean sourcing search, tagging,
 * attribution and segment rules, recommendations, source analytics,
 * workload balancing, time zones, panel rules, weighted scores, bias
 * prompts, calibration, offer clauses and comparisons, career-site
 * accessibility and link checks, structured job data. Unit tested in
 * test/hire-depth.test.ts.
 */

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const list = (json: unknown): string[] => (Array.isArray(json) ? json.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
export const hireStringList = list;

// ---------------------------------------------------------------------------
//  Boolean search: java AND (spring OR "micro services") NOT intern
// ---------------------------------------------------------------------------

export type BoolNode = { t: "term"; v: string } | { t: "and" | "or"; a: BoolNode; b: BoolNode } | { t: "not"; a: BoolNode };

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /\s*("([^"]*)"|\(|\)|[^\s()"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) out.push(`"${m[2]}`);
    else out.push(m[1]);
  }
  return out;
}

/** Parse a boolean query. Adjacent terms mean AND; NOT binds tightest, then AND, then OR. */
export function parseBooleanQuery(q: string): { node: BoolNode | null; error?: string } {
  const toks = tokenize(q.trim());
  if (toks.length === 0) return { node: null };
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t: string | undefined, op: string) => !!t && t.toUpperCase() === op && !t.startsWith('"');
  function primary(): BoolNode {
    const t = toks[i++];
    if (t === undefined) throw new Error("The query ends too early.");
    if (t === "(") {
      const n = or();
      if (toks[i++] !== ")") throw new Error("A bracket is not closed.");
      return n;
    }
    if (t === ")") throw new Error("There is a closing bracket without an opening one.");
    if (isOp(t, "AND") || isOp(t, "OR")) throw new Error(`“${t}” needs a term before it.`);
    if (isOp(t, "NOT")) return { t: "not", a: primary() };
    const v = t.startsWith('"') ? t.slice(1) : t;
    if (!v.trim()) throw new Error("An empty quoted phrase.");
    return { t: "term", v: norm(v) };
  }
  function and(): BoolNode {
    let n = primary();
    for (;;) {
      const t = peek();
      if (t === undefined || t === ")" || isOp(t, "OR")) return n;
      if (isOp(t, "AND")) i++;
      n = { t: "and", a: n, b: primary() };
    }
  }
  function or(): BoolNode {
    let n = and();
    while (isOp(peek(), "OR")) { i++; n = { t: "or", a: n, b: and() }; }
    return n;
  }
  try {
    const node = or();
    if (i < toks.length) throw new Error(`Unexpected “${toks[i]}”.`);
    return { node };
  } catch (e) {
    return { node: null, error: (e as Error).message };
  }
}

export function matchesBoolean(node: BoolNode | null, haystack: string): boolean {
  if (!node) return true;
  const h = norm(haystack);
  const ev = (n: BoolNode): boolean => {
    switch (n.t) {
      case "term": return h.includes(n.v);
      case "and": return ev(n.a) && ev(n.b);
      case "or": return ev(n.a) || ev(n.b);
      case "not": return !ev(n.a);
    }
  };
  return ev(node);
}

/** Every searchable word about a candidate, in one string. */
export function candidateHaystack(c: {
  firstName: string; lastName: string; email?: string | null; currentTitle?: string | null; currentEmployer?: string | null;
  city?: string | null; education?: string | null; skills?: unknown; tags?: unknown; headline?: string | null;
}): string {
  return [c.firstName, c.lastName, c.email, c.currentTitle, c.currentEmployer, c.city, c.education, c.headline, ...list(c.skills), ...list(c.tags)].filter(Boolean).join(" | ");
}

// ---------------------------------------------------------------------------
//  Prospect tagging, attribution and pool segment rules
// ---------------------------------------------------------------------------

export interface ProspectFacts {
  skills: unknown; currentTitle: string | null; currentEmployer: string | null; city: string | null;
  source: string; experienceYears: number | null; education: string | null;
}
export interface TagRule { tag: string; field: string; value: string; isActive?: boolean }
export const TAG_RULE_FIELDS = { SKILL: "Has skill", TITLE: "Title contains", EMPLOYER: "Employer contains", CITY: "City is", SOURCE: "Source is", MIN_EXPERIENCE: "Experience at least (years)", EDUCATION: "Education contains" } as const;

export function tagRuleMatches(r: TagRule, c: ProspectFacts): boolean {
  const v = norm(r.value);
  switch (r.field) {
    case "SKILL": return list(c.skills).some((s) => norm(s) === v);
    case "TITLE": return norm(c.currentTitle).includes(v);
    case "EMPLOYER": return norm(c.currentEmployer).includes(v);
    case "CITY": return norm(c.city) === v;
    case "SOURCE": return norm(c.source) === v;
    case "MIN_EXPERIENCE": return c.experienceYears !== null && Number.isFinite(Number(r.value)) && c.experienceYears >= Number(r.value);
    case "EDUCATION": return norm(c.education).includes(v);
    default: return false;
  }
}

/** Tags the rules give a candidate, merged with the tags they already have (deduped, sorted). */
export function tagsFor(rules: TagRule[], c: ProspectFacts, existing: unknown = []): string[] {
  const out = new Set(list(existing).map((t) => t.toLowerCase()));
  for (const r of rules) if (r.isActive !== false && tagRuleMatches(r, c)) out.add(r.tag.trim().toLowerCase());
  return [...out].sort();
}

/** "*" matches anything; otherwise a case-insensitive whole match. */
export function wildcardMatch(pattern: string, value: string | null | undefined): boolean {
  if (!value) return false;
  const re = new RegExp(`^${pattern.trim().toLowerCase().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(value.trim().toLowerCase());
}

export interface AttributionRule { id: string; matchField: string; pattern: string; source: string; channelId: string | null; priority: number; isActive: boolean }
/** The first active rule (by priority) that matches how the applicant arrived. */
export function attributeSource<T extends AttributionRule>(rules: T[], ctx: { utmSource?: string | null; email?: string | null; campaignCode?: string | null }): T | null {
  const domain = ctx.email?.split("@")[1] ?? null;
  for (const r of [...rules].filter((x) => x.isActive).sort((a, b) => a.priority - b.priority)) {
    const value = r.matchField === "UTM_SOURCE" ? ctx.utmSource : r.matchField === "EMAIL_DOMAIN" ? domain : r.matchField === "CAMPAIGN_CODE" ? ctx.campaignCode : null;
    if (wildcardMatch(r.pattern, value)) return r;
  }
  return null;
}

export interface SegmentRules { skills?: string[]; city?: string | null; minExperience?: number | null; tags?: string[]; source?: string | null; highPotential?: boolean }
export function parseSegmentRules(json: unknown): SegmentRules | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  const out: SegmentRules = {
    skills: list(r.skills).map((s) => s.toLowerCase()), tags: list(r.tags).map((s) => s.toLowerCase()),
    city: typeof r.city === "string" && r.city.trim() ? r.city.trim() : null,
    minExperience: typeof r.minExperience === "number" && Number.isFinite(r.minExperience) ? r.minExperience : null,
    source: typeof r.source === "string" && r.source ? r.source : null,
    highPotential: r.highPotential === true,
  };
  const empty = !out.skills!.length && !out.tags!.length && !out.city && out.minExperience === null && !out.source && !out.highPotential;
  return empty ? null : out;
}

/** A candidate fits a segment when every rule set holds (skills: any of them). */
export function segmentMatches(rules: SegmentRules, c: ProspectFacts & { tags?: unknown; highPotential?: boolean }): boolean {
  if (rules.skills?.length && !list(c.skills).some((s) => rules.skills!.includes(s.toLowerCase()))) return false;
  if (rules.tags?.length && !list(c.tags).some((t) => rules.tags!.includes(t.toLowerCase()))) return false;
  if (rules.city && norm(c.city) !== norm(rules.city)) return false;
  if (rules.minExperience !== null && rules.minExperience !== undefined && (c.experienceYears === null || c.experienceYears < rules.minExperience)) return false;
  if (rules.source && c.source !== rules.source) return false;
  if (rules.highPotential && !c.highPotential) return false;
  return true;
}

// ---------------------------------------------------------------------------
//  Recommendations: pooled candidates for an open job
// ---------------------------------------------------------------------------

export function recommendationScore(job: { title: string; skills: unknown; minExperienceYears: number | null }, c: { skills: unknown; experienceYears: number | null; currentTitle: string | null }): { score: number; matched: string[] } {
  const jobSkills = list(job.skills).map((s) => s.toLowerCase());
  const mine = new Set(list(c.skills).map((s) => s.toLowerCase()));
  const matched = jobSkills.filter((s) => mine.has(s));
  const skillPart = jobSkills.length ? matched.length / jobSkills.length : 0;
  const need = job.minExperienceYears ?? 0;
  const expPart = need <= 0 ? (c.experienceYears !== null ? 1 : 0.5) : c.experienceYears === null ? 0 : Math.min(1, c.experienceYears / need);
  const words = norm(job.title).split(" ").filter((w) => w.length > 2);
  const titlePart = words.length ? words.filter((w) => norm(c.currentTitle).includes(w)).length / words.length : 0;
  const score = Math.round((skillPart * 0.6 + expPart * 0.25 + titlePart * 0.15) * 100);
  return { score, matched };
}

// ---------------------------------------------------------------------------
//  Source analytics: scoring, benchmarks and ROI
// ---------------------------------------------------------------------------

export interface SourceRow { key: string; label: string; applicants: number; interviewed: number; offered: number; hired: number; avgScore: number | null; cost: number }
export interface SourceStats extends SourceRow { interviewRate: number; offerRate: number; hireRate: number; costPerHire: number | null; costPerApplicant: number | null; quality: number; vsBenchmark: number; roi: number | null }

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Per-source rates, a 0–100 quality score (hire rate, interview rate and
 * interview scores), the gap to the company-wide hire rate, and ROI
 * against an assumed value per hire.
 */
export function sourceAnalytics(rows: SourceRow[], valuePerHire = 0): { rows: SourceStats[]; benchmarkHireRate: number } {
  const total = rows.reduce((a, r) => ({ applicants: a.applicants + r.applicants, hired: a.hired + r.hired }), { applicants: 0, hired: 0 });
  const benchmarkHireRate = pct(total.hired, total.applicants);
  const out = rows.map((r) => {
    const interviewRate = pct(r.interviewed, r.applicants), offerRate = pct(r.offered, r.applicants), hireRate = pct(r.hired, r.applicants);
    const scorePart = r.avgScore === null ? 0.5 : Math.max(0, Math.min(1, (r.avgScore - 1) / 4));
    const quality = r.applicants === 0 ? 0 : Math.round(Math.min(1, hireRate / 20) * 50 + Math.min(1, interviewRate / 50) * 25 + scorePart * 25);
    return {
      ...r, interviewRate, offerRate, hireRate, quality,
      costPerHire: r.hired > 0 ? Math.round(r.cost / r.hired) : null,
      costPerApplicant: r.applicants > 0 ? Math.round(r.cost / r.applicants) : null,
      vsBenchmark: Math.round((hireRate - benchmarkHireRate) * 10) / 10,
      roi: r.cost > 0 && valuePerHire > 0 ? Math.round(((r.hired * valuePerHire - r.cost) / r.cost) * 1000) / 10 : null,
    };
  });
  out.sort((a, b) => b.quality - a.quality || b.applicants - a.applicants);
  return { rows: out, benchmarkHireRate };
}

/** Months a channel cost runs over a window, for prorating a monthly cost. */
export function hireMonthsBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / (30.4375 * 86_400_000));
}

// ---------------------------------------------------------------------------
//  Recruiter workload balancing
// ---------------------------------------------------------------------------

/**
 * Even out open applications between recruiters: anything unowned, or above
 * a recruiter's fair share, moves to whoever has least. Returns the moves.
 */
export function balanceAssignments(items: Array<{ id: string; ownerId: string | null }>, recruiters: string[]): Array<{ id: string; from: string | null; to: string }> {
  if (recruiters.length === 0) return [];
  const load = new Map(recruiters.map((r) => [r, 0]));
  for (const it of items) if (it.ownerId && load.has(it.ownerId)) load.set(it.ownerId, load.get(it.ownerId)! + 1);
  const target = Math.ceil(items.length / recruiters.length);
  const moves: Array<{ id: string; from: string | null; to: string }> = [];
  const least = () => [...load.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]!;
  // Unowned (or owned by someone no longer a recruiter) first.
  for (const it of items.filter((x) => !x.ownerId || !load.has(x.ownerId))) {
    const [to] = least();
    moves.push({ id: it.id, from: it.ownerId, to });
    load.set(to, load.get(to)! + 1);
  }
  for (const r of recruiters) {
    const mine = items.filter((x) => x.ownerId === r);
    let over = load.get(r)! - target;
    for (const it of mine) {
      if (over <= 0) break;
      const [to, n] = least();
      if (to === r || n + 1 > target) break;
      moves.push({ id: it.id, from: r, to });
      load.set(to, n + 1); load.set(r, load.get(r)! - 1); over--;
    }
  }
  return moves;
}

// ---------------------------------------------------------------------------
//  Time zones
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Offset of a zone from UTC at an instant, in minutes (IST = +330). */
export function hireTzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "2026-11-02" + "15:30" in a zone → the UTC instant. */
export function zonedLocalToUtc(date: string, time: string, tz: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !isValidTimeZone(tz)) return null;
  const naive = new Date(`${date}T${time}:00.000Z`);
  if (Number.isNaN(naive.getTime())) return null;
  let guess = new Date(naive.getTime() - hireTzOffsetMinutes(naive, tz) * 60_000);
  guess = new Date(naive.getTime() - hireTzOffsetMinutes(guess, tz) * 60_000);
  return guess;
}

/** "Mon, 2 Nov 2026, 15:30 (Asia/Kolkata)". */
export function formatInZone(d: Date, tz: string | null | undefined): string {
  const zone = tz && isValidTimeZone(tz) ? tz : "Asia/Kolkata";
  return `${d.toLocaleString("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} (${zone})`;
}

// ---------------------------------------------------------------------------
//  Interview panels, weighted scores, bias prompts, calibration
// ---------------------------------------------------------------------------

export interface PanelRules { minPanel?: number | null; maxPanel?: number | null; requireHiringManager?: boolean; requireOtherDepartment?: boolean }
export function parsePanelRules(json: unknown): PanelRules {
  const r = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return { minPanel: n(r.minPanel), maxPanel: n(r.maxPanel), requireHiringManager: r.requireHiringManager === true, requireOtherDepartment: r.requireOtherDepartment === true };
}

/** What is wrong with a panel under the job's composition rules. */
export function panelProblems(rules: PanelRules, panel: Array<{ employeeId: string; departmentId: string | null }>, ctx: { hiringManagerId: string | null; jobDepartmentId: string | null }): string[] {
  const out: string[] = [];
  if (rules.minPanel && panel.length < rules.minPanel) out.push(`The panel needs at least ${rules.minPanel} interviewers.`);
  if (rules.maxPanel && panel.length > rules.maxPanel) out.push(`The panel can have at most ${rules.maxPanel} interviewers.`);
  if (rules.requireHiringManager && ctx.hiringManagerId && !panel.some((p) => p.employeeId === ctx.hiringManagerId)) out.push("The hiring manager must be on the panel.");
  if (rules.requireOtherDepartment && ctx.jobDepartmentId && !panel.some((p) => p.departmentId && p.departmentId !== ctx.jobDepartmentId)) out.push("At least one interviewer must come from outside the hiring department.");
  return out;
}

export function parseSkillWeights(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!json || typeof json !== "object") return out;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === "number" && v > 0 && v <= 10) out[k.toLowerCase()] = v;
  return out;
}

/** Weighted mean of the rated skills (unlisted skills weigh 1), to two places. */
export function weightedRatingsAverage(ratings: Array<{ skill: string; rating: number | null }>, weights: Record<string, number>): number | null {
  let sum = 0, w = 0;
  for (const r of ratings) {
    if (r.rating === null || !Number.isFinite(r.rating)) continue;
    const k = weights[r.skill.toLowerCase()] ?? 1;
    sum += r.rating * k; w += k;
  }
  return w ? Math.round((sum / w) * 100) / 100 : null;
}

const BIAS_TERMS: Array<[RegExp, string]> = [
  [/\bculture fit\b/i, "Say which value or behaviour you saw, rather than “culture fit”."],
  [/\b(too )?(young|old|elderly|mature)\b/i, "Age is not a hiring criterion; describe the skill or experience instead."],
  [/\b(pregnan\w*|maternity|kids|children|married|family plans?)\b/i, "Family status must not influence the decision."],
  [/\b(aggressive|bossy|emotional|abrasive)\b/i, "These words are often applied unevenly; describe the specific behaviour."],
  [/\b(accent|native speaker)\b/i, "Assess clarity of communication, not accent or origin."],
  [/\b(gut feel(ing)?|just didn'?t like|vibe)\b/i, "Ground the decision in evidence from the interview."],
  [/\b(religio\w*|caste|church|temple|mosque)\b/i, "Religion and caste must not appear in feedback."],
  [/\b(he|she) (is|seems) (a )?(girl|guy|lady)\b/i, "Refer to the candidate's answers, not their gender."],
];

/** Phrases in feedback worth a second look, with what to write instead. */
export function biasFlags(text: string | null | undefined, extra: string[] = []): Array<{ term: string; suggestion: string }> {
  const t = text ?? "";
  const out: Array<{ term: string; suggestion: string }> = [];
  for (const [re, suggestion] of BIAS_TERMS) { const m = re.exec(t); if (m) out.push({ term: m[0], suggestion }); }
  for (const w of extra) {
    const term = w.trim();
    if (term && t.toLowerCase().includes(term.toLowerCase()) && !out.some((o) => o.term.toLowerCase() === term.toLowerCase())) out.push({ term, suggestion: "Your company asked interviewers to avoid this term." });
  }
  return out;
}

export interface CalibrationCard { panelistId: string; interviewId: string; score: number | null; recommendation: string | null }
/**
 * Per interviewer: how many scorecards, their mean, how far they sit from
 * the rest of the panel on the same interviews (+ lenient, − strict) and
 * how often they recommend hiring.
 */
export function calibration(cards: CalibrationCard[]): Array<{ panelistId: string; count: number; mean: number | null; delta: number | null; hireRate: number; label: string }> {
  const byInterview = new Map<string, CalibrationCard[]>();
  for (const c of cards) byInterview.set(c.interviewId, [...(byInterview.get(c.interviewId) ?? []), c]);
  const per = new Map<string, { scores: number[]; deltas: number[]; hires: number; n: number }>();
  for (const c of cards) {
    const p = per.get(c.panelistId) ?? { scores: [], deltas: [], hires: 0, n: 0 };
    p.n++;
    if (c.recommendation === "HIRE" || c.recommendation === "MUST_HIRE") p.hires++;
    if (c.score !== null) {
      p.scores.push(c.score);
      const others = (byInterview.get(c.interviewId) ?? []).filter((o) => o.panelistId !== c.panelistId && o.score !== null).map((o) => o.score!);
      if (others.length) p.deltas.push(c.score - others.reduce((a, b) => a + b, 0) / others.length);
    }
    per.set(c.panelistId, p);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  return [...per.entries()].map(([panelistId, p]) => {
    const delta = avg(p.deltas);
    return { panelistId, count: p.n, mean: avg(p.scores), delta, hireRate: pct(p.hires, p.n), label: delta === null ? "No peers to compare" : delta >= 0.75 ? "Lenient" : delta <= -0.75 ? "Strict" : "Calibrated" };
  }).sort((a, b) => b.count - a.count);
}

/** Interviews per interviewer this week against their capacity. */
export function capacityStatus(scheduled: number, today: number, cap: { maxPerWeek: number; maxPerDay: number } | null): { label: string; over: boolean; free: number } {
  const c = cap ?? { maxPerWeek: 5, maxPerDay: 2 };
  const over = scheduled > c.maxPerWeek || today > c.maxPerDay;
  return { over, free: Math.max(0, c.maxPerWeek - scheduled), label: over ? "Over capacity" : scheduled >= c.maxPerWeek ? "Full" : `${c.maxPerWeek - scheduled} slot(s) free` };
}

/** Panel suggestions: those with the most free capacity first, never anyone over it. */
export function suggestInterviewers<T extends { id: string; scheduled: number; maxPerWeek: number }>(people: T[], n: number, exclude: string[] = []): T[] {
  return people.filter((p) => !exclude.includes(p.id) && p.scheduled < p.maxPerWeek).sort((a, b) => (b.maxPerWeek - b.scheduled) - (a.maxPerWeek - a.scheduled) || a.scheduled - b.scheduled).slice(0, n);
}

// ---------------------------------------------------------------------------
//  Stages
// ---------------------------------------------------------------------------

/** Why a candidate may not enter a stage yet. */
export function stageEntryProblem(stage: { name: string; entryMinScore: number | null; entryRequiresResume: boolean }, app: { averageScore: number | null; hasResume: boolean }): string | null {
  if (stage.entryRequiresResume && !app.hasResume) return `${stage.name} needs a résumé on file first.`;
  if (stage.entryMinScore !== null && (app.averageScore === null || app.averageScore < stage.entryMinScore)) return `${stage.name} needs an average interview score of at least ${stage.entryMinScore}${app.averageScore === null ? " (no scores yet)" : ` (currently ${app.averageScore})`}.`;
  return null;
}

/** Per stage: how many entered, how many moved further, and the mean days spent. */
export function stageConversion(stages: Array<{ id: string; name: string; sequence: number }>, history: Array<{ applicationId: string; stageId: string; enteredAt: Date; exitedAt: Date | null }>, now = new Date()) {
  const seq = new Map(stages.map((s) => [s.id, s.sequence]));
  const furthest = new Map<string, number>();
  for (const h of history) furthest.set(h.applicationId, Math.max(furthest.get(h.applicationId) ?? 0, seq.get(h.stageId) ?? 0));
  return [...stages].sort((a, b) => a.sequence - b.sequence).map((s) => {
    const rows = history.filter((h) => h.stageId === s.id);
    const apps = new Set(rows.map((h) => h.applicationId));
    const advanced = [...apps].filter((a) => (furthest.get(a) ?? 0) > s.sequence).length;
    const days = rows.map((h) => ((h.exitedAt ?? now).getTime() - h.enteredAt.getTime()) / 86_400_000);
    return { stageId: s.id, name: s.name, entered: apps.size, advanced, conversion: pct(advanced, apps.size), avgDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null };
  });
}

// ---------------------------------------------------------------------------
//  Duplicates and merges
// ---------------------------------------------------------------------------

export const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

/** Groups of candidates that look like the same person: same phone, or same name and employer. */
export function duplicateGroups<T extends { id: string; firstName: string; lastName: string; phone: string | null; currentEmployer: string | null; email: string }>(cands: T[]): Array<{ reason: string; members: T[] }> {
  const groups = new Map<string, { reason: string; members: T[] }>();
  const add = (key: string, reason: string, c: T) => {
    const g = groups.get(key) ?? { reason, members: [] };
    if (!g.members.includes(c)) g.members.push(c);
    groups.set(key, g);
  };
  for (const c of cands) {
    const phone = normPhone(c.phone);
    if (phone.length === 10) add(`p:${phone}`, "Same phone number", c);
    const name = `${norm(c.firstName)} ${norm(c.lastName)}`;
    if (c.currentEmployer) add(`n:${name}|${norm(c.currentEmployer)}`, "Same name and employer", c);
    const local = c.email.split("@")[0]!.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (local.length >= 6) add(`e:${local}`, "Same email name at different providers", c);
  }
  const seen = new Set<string>();
  return [...groups.values()].filter((g) => g.members.length > 1).filter((g) => {
    const k = g.members.map((m) => m.id).sort().join(",");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export interface ClauseShape { id: string; title: string; kind: string; body: string; locale: string; minCtc: number | null; departmentId: string | null; employmentType: string | null; amount: number | null; sortOrder: number; isActive: boolean }
/** Clauses that apply to an offer, in letter order. Falls back to English when none exist in the locale. */
export function applicableClauses<T extends ClauseShape>(clauses: T[], ctx: { ctc: number; departmentId: string | null; employmentType: string | null; locale: string }): T[] {
  const fits = (c: T) => c.isActive && (c.minCtc === null || ctx.ctc >= c.minCtc) && (!c.departmentId || c.departmentId === ctx.departmentId) && (!c.employmentType || c.employmentType === ctx.employmentType);
  let pick = clauses.filter((c) => fits(c) && c.locale === ctx.locale);
  if (pick.length === 0 && ctx.locale !== "en") pick = clauses.filter((c) => fits(c) && c.locale === "en");
  const order = { COMPONENT: 0, CONDITIONAL: 1, GENERAL: 2, TAX_DISCLAIMER: 3 } as Record<string, number>;
  return pick.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The clauses as letter HTML: headed sections, components with their amount. */
export function clausesToHtml(clauses: ClauseShape[]): string {
  if (!clauses.length) return "";
  return clauses.map((c) => {
    const amount = c.kind === "COMPONENT" && c.amount !== null ? ` — ₹${c.amount.toLocaleString("en-IN")}` : "";
    return `<p><strong>${escapeHtml(c.title)}${amount}</strong></p><p>${escapeHtml(c.body).replace(/\n/g, "<br/>")}</p>`;
  }).join("");
}

/** Where an offer sits in a pay grade: inside, below or above, and its compa-ratio. */
export function bandCheck(ctc: number, grade: { name: string; minAnnual: number | null; maxAnnual: number | null; midAnnual: number | null } | null): { ok: boolean; message: string; compaRatio: number | null } {
  if (!grade) return { ok: true, message: "No pay grade set; nothing to check against.", compaRatio: null };
  const mid = grade.midAnnual ?? (grade.minAnnual !== null && grade.maxAnnual !== null ? (grade.minAnnual + grade.maxAnnual) / 2 : null);
  const compaRatio = mid ? Math.round((ctc / mid) * 100) / 100 : null;
  if (grade.minAnnual !== null && ctc < grade.minAnnual) return { ok: false, message: `Below the ${grade.name} band minimum of ₹${grade.minAnnual.toLocaleString("en-IN")}.`, compaRatio };
  if (grade.maxAnnual !== null && ctc > grade.maxAnnual) return { ok: false, message: `Above the ${grade.name} band maximum of ₹${grade.maxAnnual.toLocaleString("en-IN")}.`, compaRatio };
  return { ok: true, message: `Within the ${grade.name} band${compaRatio ? ` (compa-ratio ${compaRatio})` : ""}.`, compaRatio };
}

/** The offer against what the candidate earns, asked for, and any competing offer. */
export function offerComparison(o: { offered: number; current: number | null; expected: number | null; competitor: number | null; budgetMax: number | null }): Array<{ label: string; amount: number | null; delta: number | null; note: string }> {
  const d = (x: number | null) => (x && x > 0 ? Math.round(((o.offered - x) / x) * 1000) / 10 : null);
  const row = (label: string, amount: number | null, good: string, bad: string) => {
    const delta = d(amount);
    return { label, amount, delta, note: delta === null ? "—" : delta >= 0 ? good.replace("%", `${delta}%`) : bad.replace("%", `${Math.abs(delta)}%`) };
  };
  return [
    row("Current CTC", o.current, "A % hike", "% below what they earn now"),
    row("Expected CTC", o.expected, "% above their ask", "% short of their ask"),
    row("Competing offer", o.competitor, "% above the competing offer", "% below the competing offer"),
    row("Budget ceiling", o.budgetMax, "% over budget", "% under budget"),
  ];
}

/** Days between offer milestones; null where a milestone has not happened. */
export function offerTurnaround(o: { createdAt: Date; approvedAt: Date | null; extendedAt: Date | null; respondedAt: Date | null }) {
  const days = (a: Date | null, b: Date | null) => (a && b ? Math.round(((b.getTime() - a.getTime()) / 86_400_000) * 10) / 10 : null);
  return { toApprove: days(o.createdAt, o.approvedAt), toExtend: days(o.approvedAt ?? o.createdAt, o.extendedAt), toRespond: days(o.extendedAt, o.respondedAt), total: days(o.createdAt, o.respondedAt) };
}

export function hireMedian(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : Math.round(((v[m - 1]! + v[m]!) / 2) * 10) / 10;
}

// ---------------------------------------------------------------------------
//  Career site: accessibility, links, structured data, alerts, profiles
// ---------------------------------------------------------------------------

function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** WCAG contrast ratio of two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
}

/** Accessibility problems on the career site: colour contrast, alt text, link text, shouting. */
export function accessibilityIssues(site: { primaryColor: string; accentColor: string }, contents: Array<{ id: string; title: string; body: string; imageFileId: string | null; imageAlt: string | null }>): Array<{ where: string; issue: string }> {
  const out: Array<{ where: string; issue: string }> = [];
  for (const [name, c] of [["Primary colour", site.primaryColor], ["Accent colour", site.accentColor]] as const) {
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c)) {
      const r = contrastRatio(c, "#ffffff");
      if (r < 4.5) out.push({ where: name, issue: `Contrast with white is ${r}:1; WCAG AA needs 4.5:1 for text and buttons.` });
    }
  }
  for (const c of contents) {
    if (c.imageFileId && !c.imageAlt?.trim()) out.push({ where: c.title, issue: "The image has no alt text." });
    if (/\[(click here|here|read more|link)\]\(/i.test(c.body)) out.push({ where: c.title, issue: "A link says “click here”; link text should say where it goes." });
    if (c.title.length > 8 && c.title === c.title.toUpperCase() && /[A-Z]/.test(c.title)) out.push({ where: c.title, issue: "The title is in capitals, which screen readers may spell out." });
  }
  return out;
}

/** Links in markdown/plain text: [text](url) and bare URLs/paths. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(?:^|\s)(https?:\/\/[^\s)]+|\/careers\/[^\s)]*)/g)) out.add(m[1]!);
  return [...out];
}

/** Career-site links that lead nowhere: closed jobs, unpublished landing pages, malformed URLs. */
export function brokenCareerLinks(links: Array<{ from: string; url: string }>, known: { openJobIds: Set<string>; publishedSlugs: Set<string> }): Array<{ from: string; url: string; why: string }> {
  const out: Array<{ from: string; url: string; why: string }> = [];
  for (const l of links) {
    const u = l.url.trim();
    let path = u;
    if (/^https?:\/\//i.test(u)) {
      try { const p = new URL(u); path = p.pathname; if (!p.hostname.includes(".")) { out.push({ ...l, why: "The address has no valid host." }); continue; } } catch { out.push({ ...l, why: "The address is not a valid URL." }); continue; }
      if (!path.startsWith("/careers")) continue; // external: not checked here
    }
    if (!path.startsWith("/careers")) { if (path.startsWith("/")) out.push({ ...l, why: "Points into the app, which visitors cannot open." }); continue; }
    const job = /^\/careers\/([a-z0-9]{20,})$/i.exec(path);
    if (job && !known.openJobIds.has(job[1]!)) { out.push({ ...l, why: "The job is closed or unpublished." }); continue; }
    const page = /^\/careers\/p\/([a-z0-9-]+)$/i.exec(path);
    if (page) { if (!known.publishedSlugs.has(page[1]!)) out.push({ ...l, why: "The landing page is not published." }); continue; }
    if (job) continue;
    if (!/^\/careers\/?(?:$|[?#])|^\/careers\/(?:faq|alerts|community)\/?(?:$|[?#])|^\/careers\/(?:status|alerts|asset)\/[^/]+$/i.test(path)) out.push({ ...l, why: "There is no such careers page." });
  }
  return out;
}

const SCHEMA_TYPE: Record<string, string> = { FULL_TIME: "FULL_TIME", PART_TIME: "PART_TIME", CONTRACT: "CONTRACTOR", INTERNSHIP: "INTERN" };
/** schema.org JobPosting for a public job page. */
export function jobPostingJsonLd(job: { title: string; description: string | null; employmentType: string; workMode: string; publishedAt: Date | null; closesAt: Date | null; minAnnualCtc: number | null; maxAnnualCtc: number | null; hideSalary: boolean; url: string }, org: { name: string; city: string | null; country?: string }): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org/", "@type": "JobPosting", title: job.title,
    description: job.description ?? job.title, datePosted: (job.publishedAt ?? new Date()).toISOString().slice(0, 10),
    employmentType: SCHEMA_TYPE[job.employmentType] ?? "OTHER", hiringOrganization: { "@type": "Organization", name: org.name }, url: job.url,
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: org.city ?? undefined, addressCountry: org.country ?? "IN" } },
  };
  if (job.closesAt) ld.validThrough = job.closesAt.toISOString();
  if (job.workMode === "REMOTE") ld.jobLocationType = "TELECOMMUTE";
  if (!job.hideSalary && job.minAnnualCtc && job.maxAnnualCtc) ld.baseSalary = { "@type": "MonetaryAmount", currency: "INR", value: { "@type": "QuantitativeValue", minValue: job.minAnnualCtc, maxValue: job.maxAnnualCtc, unitText: "YEAR" } };
  return ld;
}

export function jobAlertMatches(sub: { keywords: string | null; departmentId: string | null; locationId: string | null }, job: { title: string; description: string | null; departmentId: string | null; locationId: string | null }): boolean {
  if (sub.departmentId && sub.departmentId !== job.departmentId) return false;
  if (sub.locationId && sub.locationId !== job.locationId) return false;
  const words = norm(sub.keywords).split(/[ ,]+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(`${job.title} ${job.description ?? ""}`);
  return words.some((w) => hay.includes(w));
}

/** Pick the visitor's language: ?lang, else the first offered Accept-Language. */
export function pickLocale(requested: string | null | undefined, acceptLanguage: string | null | undefined, offered: string[]): string {
  const ok = new Set(["en", ...offered]);
  if (requested && ok.has(requested)) return requested;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const code = part.split(";")[0]!.trim().slice(0, 2).toLowerCase();
    if (ok.has(code)) return code;
  }
  return "en";
}

export const LOCALE_NAMES: Record<string, string> = { en: "English", hi: "हिन्दी", ta: "தமிழ்", te: "తెలుగు", kn: "ಕನ್ನಡ", mr: "मराठी", bn: "বাংলা", fr: "Français", de: "Deutsch", es: "Español", ar: "العربية" };

/** A pasted public profile: headline (first line), skills (a "Skills:" line), summary (the rest). */
export function parseLinkedProfile(text: string, url: string | null): { url: string | null; headline: string | null; skills: string[]; summary: string | null; title: string | null; employer: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headline = lines[0]?.slice(0, 200) ?? null;
  const skillLine = lines.find((l) => /^skills?\s*[:\-]/i.test(l));
  const skills = skillLine ? skillLine.replace(/^skills?\s*[:\-]\s*/i, "").split(/[,;•|]/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 30) : [];
  const summary = lines.filter((l) => l !== lines[0] && l !== skillLine).join(" ").slice(0, 1500) || null;
  const at = headline ? /^(.*?)\s+(?:at|@)\s+(.+?)(?:\s*[|·-].*)?$/i.exec(headline) : null;
  return { url: url && /^https?:\/\//i.test(url) ? url : null, headline, skills, summary, title: at?.[1]?.trim() ?? null, employer: at?.[2]?.trim() ?? null };
}

/** Steps of a cadence as due dates from its start. */
export function parseCadenceSteps(text: string): { steps?: Array<{ day: number; channel: string; action: string }>; error?: string } {
  const steps: Array<{ day: number; channel: string; action: string }> = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^day\s*(\d{1,3})\s*[:\-]\s*(email|call|sms|linkedin)\s*[:\-]\s*(.+)$/i.exec(line);
    if (!m) return { error: `Write each step as “Day 3: email: follow up on the role” — “${line}” is not.` };
    steps.push({ day: Number(m[1]), channel: m[2]!.toUpperCase(), action: m[3]!.slice(0, 200) });
  }
  if (!steps.length) return { error: "Add at least one step." };
  return { steps: steps.sort((a, b) => a.day - b.day) };
}

export function cadenceStepsOf(json: unknown): Array<{ day: number; channel: string; action: string }> {
  return Array.isArray(json) ? json.filter((s): s is { day: number; channel: string; action: string } => !!s && typeof s === "object" && typeof (s as { day: unknown }).day === "number") : [];
}

/** Map an imported CSV row to candidate fields with a header → field mapping. */
export const CANDIDATE_IMPORT_FIELDS = ["firstName", "lastName", "email", "phone", "currentTitle", "currentEmployer", "city", "totalExperienceYears", "skills", "linkedinUrl", "source"] as const;
export type CandidateImportField = (typeof CANDIDATE_IMPORT_FIELDS)[number];
export function mapImportRow(headers: string[], row: string[], mapping: Record<string, string>): { values: Partial<Record<CandidateImportField, string>>; error?: string } {
  const values: Partial<Record<CandidateImportField, string>> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (!(CANDIDATE_IMPORT_FIELDS as readonly string[]).includes(field)) continue;
    const i = headers.findIndex((h) => norm(h) === norm(header));
    if (i >= 0 && row[i]?.trim()) values[field as CandidateImportField] = row[i]!.trim();
  }
  if (!values.firstName || !values.email) return { values, error: "First name and email are required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) return { values, error: `“${values.email}” is not an email address.` };
  return { values };
}

/** Questions for the requisition intake, one per line. */
export function intakeQuestionsFrom(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim().replace(/^[-*\d.)\s]+/, "")).filter(Boolean).slice(0, 20).map((q) => q.slice(0, 300));
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Hours since a moment, rounded down. */
export const hoursSince = (d: Date, now = new Date()) => Math.floor((now.getTime() - d.getTime()) / 3_600_000);
