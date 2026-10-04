/**
 * Pure arithmetic for the engage depth modules — no database. Survey
 * branching and randomisation, the engagement heat map (with the anonymity
 * minimum), recurring schedules, recognition eligibility and budgets, the
 * points ledger, wellbeing aggregation, announcement audiences, event RSVP
 * capacity, recognition fairness and action-plan state.
 */

/** Approval types the engage modules add to the workflow engine. */
export const ENGAGE_WORKFLOW_TYPES = {
  SURVEY_PUBLISH: "Survey and poll publication",
  ANNOUNCEMENT_PUBLISH: "Announcement publication",
  RECOGNITION_PROGRAM: "Recognition programme launch",
  AWARD_NOMINATION: "Award nominations",
  REWARD_REDEMPTION: "Reward redemptions",
  SERVICE_REQUEST: "Employee service requests",
  WELLNESS_PROGRAM: "Wellness programme launch",
  SUPPORT_RESOURCE: "Support resource publication",
  COMPANY_EVENT: "Company event publication",
  CHANNEL_JOIN: "Private channel membership",
} as const;
export type EngageWorkflowType = keyof typeof ENGAGE_WORKFLOW_TYPES;
export const isEngageWorkflowType = (v: string): v is EngageWorkflowType => v in ENGAGE_WORKFLOW_TYPES;

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ---------------------------------------------------------------------------
//  Survey branching and randomisation
// ---------------------------------------------------------------------------

export interface BranchQuestion {
  id: string;
  type: string;
  options?: string[];
  showIfQuestionId?: string | null;
  showIfValues?: number[];
}
export interface BranchAnswer { score?: number | null; choices?: number[] }

/** Does an answer satisfy a branch condition (a score, or any chosen option, in `values`)? */
export function answerMatches(answer: BranchAnswer | undefined, values: number[]): boolean {
  if (!answer) return false;
  if (answer.score !== null && answer.score !== undefined && values.includes(answer.score)) return true;
  return (answer.choices ?? []).some((c) => values.includes(c));
}

/**
 * The questions a respondent is actually asked, given their answers so far.
 * Questions are taken in order; a conditional question is asked only when
 * the question it depends on was itself asked and its answer matches.
 */
export function visibleQuestionIds(questions: BranchQuestion[], answers: Map<string, BranchAnswer>): Set<string> {
  const visible = new Set<string>();
  for (const q of questions) {
    if (!q.showIfQuestionId) { visible.add(q.id); continue; }
    if (visible.has(q.showIfQuestionId) && answerMatches(answers.get(q.showIfQuestionId), q.showIfValues ?? [])) visible.add(q.id);
  }
  return visible;
}

/** Validate a branch rule for a question being added after `earlier`. Null when fine. */
export function branchRuleError(earlier: BranchQuestion[], rule: { questionId: string; values: number[] }): string | null {
  const parent = earlier.find((q) => q.id === rule.questionId);
  if (!parent) return "Branch on an earlier question of this survey.";
  if (parent.type === "TEXT") return "A free-text question cannot drive a branch.";
  if (rule.values.length === 0) return "Pick at least one answer that shows the question.";
  const max = parent.type === "RATING" ? 5 : parent.type === "NPS" ? 10 : (parent.options?.length ?? 0) - 1;
  const min = parent.type === "RATING" ? 1 : 0;
  if (rule.values.some((v) => !Number.isInteger(v) || v < min || v > max)) return `Answers must be between ${min} and ${max}.`;
  return null;
}

/** A small, stable string hash (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * A deterministic shuffle for question randomisation: the same respondent
 * always sees the same order (so a reload does not reshuffle), different
 * respondents see different orders. Conditional questions stay right after
 * the question they depend on, so branching still reads naturally.
 */
export function seededOrder<T extends { id: string; showIfQuestionId?: string | null }>(items: T[], seed: string): T[] {
  const roots = items.filter((q) => !q.showIfQuestionId);
  const keyed = roots.map((q) => ({ q, k: hashString(`${seed}:${q.id}`) })).sort((a, b) => a.k - b.k || a.q.id.localeCompare(b.q.id)).map((x) => x.q);
  const out: T[] = [];
  const placed = new Set<string>();
  const place = (q: T) => {
    out.push(q); placed.add(q.id);
    for (const child of items) if (child.showIfQuestionId === q.id && !placed.has(child.id)) place(child);
  };
  for (const q of keyed) place(q);
  for (const q of items) if (!placed.has(q.id)) out.push(q);
  return out;
}

// ---------------------------------------------------------------------------
//  Heat map and trends
// ---------------------------------------------------------------------------

export interface HeatResponse { group: string; answers: Array<{ driver: string | null; score: number | null }> }

/**
 * Favourable share (4–5 on a 1–5 scale) per group × driver. A whole group
 * smaller than the minimum is withheld (null cells), as is any cell with no
 * rating answers. Groups are sorted by size, drivers alphabetically.
 */
export function heatmap(responses: HeatResponse[], minGroupSize: number) {
  const groups = new Map<string, HeatResponse[]>();
  for (const r of responses) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const drivers = [...new Set(responses.flatMap((r) => r.answers.map((a) => a.driver).filter((d): d is string => !!d)))].sort();
  const min = Math.max(1, minGroupSize);
  const rows = [...groups.entries()].map(([group, rs]) => {
    const hidden = rs.length < min;
    const cells = drivers.map((driver) => {
      if (hidden) return null;
      const scores = rs.flatMap((r) => r.answers.filter((a) => a.driver === driver && a.score !== null).map((a) => a.score!));
      if (scores.length === 0) return null;
      return Math.round((scores.filter((s) => s >= 4).length / scores.length) * 100);
    });
    const all = hidden ? [] : rs.flatMap((r) => r.answers.filter((a) => a.driver && a.score !== null).map((a) => a.score!));
    return { group, respondents: rs.length, hidden, cells, overall: all.length ? Math.round((all.filter((s) => s >= 4).length / all.length) * 100) : null };
  }).sort((a, b) => b.respondents - a.respondents || a.group.localeCompare(b.group));
  return { drivers, rows };
}

/** Colour band for a favourable %, for the heat map cells. */
export function heatBand(pct: number | null): "none" | "low" | "mid" | "high" {
  if (pct === null) return "none";
  return pct >= 70 ? "high" : pct >= 50 ? "mid" : "low";
}

/** Change between consecutive points of a series (null for the first). */
export function trendDeltas(points: Array<{ value: number | null }>): Array<number | null> {
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1]!.value : null;
    return p.value === null || prev === null ? null : p.value - prev;
  });
}

/** When a recurring schedule runs next after `ranOn`. */
export function nextRunOn(ranOn: Date, everyDays: number): Date {
  return new Date(startOfDay(ranOn).getTime() + Math.max(1, everyDays) * DAY);
}

/** Should an automatic reminder go out now? */
export function reminderDue(opts: { everyDays: number | null; launchedAt: Date | null; lastReminderAt: Date | null; now: Date }): boolean {
  if (!opts.everyDays || opts.everyDays < 1 || !opts.launchedAt) return false;
  const since = opts.lastReminderAt ?? opts.launchedAt;
  return opts.now.getTime() - since.getTime() >= opts.everyDays * DAY;
}

/** Action plan state: OVERDUE when not finished and past its due date. */
export function actionPlanState(status: string, dueOn: Date, today: Date): string {
  if (status === "DONE" || status === "CANCELLED") return status;
  return startOfDay(dueOn) < startOfDay(today) ? "OVERDUE" : status;
}

// ---------------------------------------------------------------------------
//  Recognition: eligibility, budget, points
// ---------------------------------------------------------------------------

export interface ProgramLike {
  status: string; startsOn: Date; endsOn: Date | null; departmentIds: string[]; minTenureDays: number;
  budgetPoints: number | null; pointsPerAward: number; cooldownDays: number;
}

/** Can this employee be recognised under the programme today? */
export function programEligibility(p: ProgramLike, e: { departmentId: string | null; dateOfJoining: Date | null }, today: Date, lastAwardedOn?: Date | null): { ok: true } | { ok: false; reason: string } {
  if (p.status !== "ACTIVE") return { ok: false, reason: "The programme is not active." };
  const d = startOfDay(today);
  if (startOfDay(p.startsOn) > d) return { ok: false, reason: "The programme has not started yet." };
  if (p.endsOn && startOfDay(p.endsOn) < d) return { ok: false, reason: "The programme has ended." };
  if (p.departmentIds.length && !p.departmentIds.includes(e.departmentId ?? "")) return { ok: false, reason: "The nominee's department is not part of this programme." };
  if (p.minTenureDays > 0) {
    const tenure = e.dateOfJoining ? Math.floor((d.getTime() - startOfDay(e.dateOfJoining).getTime()) / DAY) : 0;
    if (tenure < p.minTenureDays) return { ok: false, reason: `The nominee needs ${p.minTenureDays} days of service (has ${Math.max(0, tenure)}).` };
  }
  if (p.cooldownDays > 0 && lastAwardedOn && d.getTime() - startOfDay(lastAwardedOn).getTime() < p.cooldownDays * DAY) {
    return { ok: false, reason: `They were recognised under this programme in the last ${p.cooldownDays} days.` };
  }
  return { ok: true };
}

/** Budget headroom: points still available, and whether `points` more fits. */
export function budgetCheck(budget: number | null, used: number, points: number): { fits: boolean; remaining: number | null; utilisation: number | null } {
  if (budget === null) return { fits: true, remaining: null, utilisation: null };
  const remaining = budget - used;
  return { fits: points <= remaining, remaining, utilisation: budget === 0 ? 100 : Math.round((used / budget) * 100) };
}

/** Points balance from ledger deltas. */
export function pointsBalance(entries: Array<{ delta: number }>): number {
  return entries.reduce((s, e) => s + e.delta, 0);
}

/** Validate a redemption request against balance and stock. */
export function redemptionCheck(opts: { balance: number; cost: number; quantity: number; stock: number | null; active: boolean }): string | null {
  if (!opts.active) return "This reward is not available.";
  if (!Number.isInteger(opts.quantity) || opts.quantity < 1 || opts.quantity > 10) return "Redeem between 1 and 10 at a time.";
  if (opts.stock !== null && opts.stock < opts.quantity) return opts.stock === 0 ? "This reward is out of stock." : `Only ${opts.stock} left.`;
  const total = opts.cost * opts.quantity;
  if (total > opts.balance) return `You need ${total} points; your balance is ${opts.balance}.`;
  return null;
}

/** Completed years of service when `today` is the work anniversary; 0 otherwise. */
export function anniversaryYears(dateOfJoining: Date | null, today: Date): number {
  if (!dateOfJoining) return 0;
  const j = startOfDay(dateOfJoining), t = startOfDay(today);
  if (j.getUTCMonth() !== t.getUTCMonth() || j.getUTCDate() !== t.getUTCDate()) return 0;
  return Math.max(0, t.getUTCFullYear() - j.getUTCFullYear());
}

/**
 * Recognition fairness: recognitions per 10 people in each group against
 * the organisation's rate. A group below half the organisation's rate (and
 * with at least 3 people) is flagged as under-recognised.
 */
export function recognitionFairness(groups: Array<{ group: string; headcount: number; recognitions: number }>) {
  const people = groups.reduce((s, g) => s + g.headcount, 0);
  const total = groups.reduce((s, g) => s + g.recognitions, 0);
  const orgRate = people === 0 ? 0 : (total / people) * 10;
  return {
    orgRate: Math.round(orgRate * 10) / 10,
    rows: groups.map((g) => {
      const rate = g.headcount === 0 ? 0 : (g.recognitions / g.headcount) * 10;
      return { ...g, rate: Math.round(rate * 10) / 10, index: orgRate === 0 ? null : Math.round((rate / orgRate) * 100), underRecognised: g.headcount >= 3 && orgRate > 0 && rate < orgRate / 2 };
    }).sort((a, b) => a.rate - b.rate),
  };
}

// ---------------------------------------------------------------------------
//  Wellness and wellbeing
// ---------------------------------------------------------------------------

/** Monday 00:00 UTC of the week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getUTCDay() + 6) % 7;
  return new Date(s.getTime() - dow * DAY);
}

/** Challenge progress against its goal. */
export function challengeProgress(total: number, goal: number | null): { pct: number; completed: boolean } {
  if (!goal || goal <= 0) return { pct: 0, completed: false };
  return { pct: Math.min(100, Math.round((total / goal) * 100)), completed: total >= goal };
}

/**
 * Wellbeing check-ins summarised per group: averages and the share
 * reporting low mood (1–2) or high stress (4–5). A group smaller than the
 * minimum is withheld entirely.
 */
export function wellbeingSummary(rows: Array<{ group: string; mood: number; stress: number; wantsSupport?: boolean }>, minGroupSize: number) {
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.group, [...(by.get(r.group) ?? []), r]);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const summarise = (rs: typeof rows) => ({
    n: rs.length,
    avgMood: r1(rs.reduce((s, r) => s + r.mood, 0) / rs.length),
    avgStress: r1(rs.reduce((s, r) => s + r.stress, 0) / rs.length),
    lowMoodPct: Math.round((rs.filter((r) => r.mood <= 2).length / rs.length) * 100),
    highStressPct: Math.round((rs.filter((r) => r.stress >= 4).length / rs.length) * 100),
    supportRequests: rs.filter((r) => r.wantsSupport).length,
  });
  const min = Math.max(1, minGroupSize);
  return {
    overall: rows.length >= min ? summarise(rows) : null,
    groups: [...by.entries()].map(([group, rs]) => (rs.length >= min ? { group, hidden: false as const, ...summarise(rs) } : { group, hidden: true as const, n: rs.length }))
      .sort((a, b) => b.n - a.n),
  };
}

// ---------------------------------------------------------------------------
//  Communication: audiences, RSVP
// ---------------------------------------------------------------------------

export interface Audience { departmentIds?: string[]; locationIds?: string[]; businessUnitIds?: string[]; excludeOnNotice?: boolean }
export interface AudienceMember { departmentId: string | null; locationId: string | null; businessUnitId?: string | null; status?: string | null }

/** Is an employee in an announcement's audience? Empty filters mean everyone. */
export function inAudience(a: Audience | null | undefined, e: AudienceMember): boolean {
  if (!a) return true;
  if (a.departmentIds?.length && !a.departmentIds.includes(e.departmentId ?? "")) return false;
  if (a.locationIds?.length && !a.locationIds.includes(e.locationId ?? "")) return false;
  if (a.businessUnitIds?.length && !a.businessUnitIds.includes(e.businessUnitId ?? "")) return false;
  if (a.excludeOnNotice && e.status === "NOTICE_PERIOD") return false;
  return true;
}

/** An RSVP of GOING becomes WAITLIST when the event is full. */
export function rsvpOutcome(response: "GOING" | "MAYBE" | "DECLINED", capacity: number | null, goingOthers: number): "GOING" | "MAYBE" | "DECLINED" | "WAITLIST" {
  if (response !== "GOING" || capacity === null) return response;
  return goingOthers >= capacity ? "WAITLIST" : "GOING";
}

/** Who moves up from the waitlist when places free up (earliest first). */
export function promoteFromWaitlist<T extends { response: string; createdAt: Date }>(rsvps: T[], capacity: number | null): T[] {
  if (capacity === null) return rsvps.filter((r) => r.response === "WAITLIST");
  const going = rsvps.filter((r) => r.response === "GOING").length;
  const free = Math.max(0, capacity - going);
  return rsvps.filter((r) => r.response === "WAITLIST").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, free);
}

/** Reach and acknowledgement rates for an announcement. */
export function reachStats(audience: number, viewed: number, acknowledged: number) {
  const pct = (n: number) => (audience === 0 ? 0 : Math.min(100, Math.round((n / audience) * 100)));
  return { audience, viewed, acknowledged, viewedPct: pct(viewed), ackPct: pct(acknowledged), pending: Math.max(0, audience - acknowledged) };
}
