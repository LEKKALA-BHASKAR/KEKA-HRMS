/**
 * Keka Wall — the pure parts: mention tokens, poll tallies and the option
 * rules a poll must satisfy. No database access here, so it is unit-tested
 * directly and shared by the actions and the pages that render the feed.
 *
 * A mention is stored inside the text as `@[Display Name](employeeId)`; the
 * id is what the server trusts (and re-checks against the directory), the
 * name is only what was shown when it was typed.
 */

export const MENTION_RE = /@\[([^\]\n]{1,80})\]\(([a-z0-9]{20,40})\)/g;

/** The distinct employee ids mentioned in a body, in order of appearance. */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export type MentionSegment = { text: string } | { id: string; name: string };

/** Split a body into plain text and mention segments for rendering. */
export function mentionSegments(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: body.slice(last, at) });
    out.push({ id: m[2], name: m[1] });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/** A body with its mention tokens replaced by the plain names — for notifications and previews. */
export function wallPlainText(body: string): string {
  return body.replace(MENTION_RE, (_all, name: string) => `@${name}`);
}

/**
 * Rewrite mention tokens so that only ids the caller vouches for remain
 * links; any other token degrades to plain "@Name" text. The display name
 * of a kept mention is replaced with the directory's current name.
 */
export function sanitiseMentions(body: string, known: Map<string, string>): string {
  return body.replace(MENTION_RE, (_all, name: string, id: string) => {
    const real = known.get(id);
    return real ? `@[${real.replace(/[\]\n]/g, " ").slice(0, 80)}](${id})` : `@${name}`;
  });
}

// ---------------------------------------------------------------------------
//  Polls
// ---------------------------------------------------------------------------

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_OPTION_MAX = 120;
export const POLL_MAX_DAYS = 90;

/** Clean and check a poll's options. Returns the labels to store, or an error. */
export function validatePollOptions(raw: string[]): { ok: true; options: string[] } | { ok: false; error: string } {
  const options = raw.map((o) => o.replace(/\s+/g, " ").trim()).filter((o) => o.length > 0);
  if (options.length < POLL_MIN_OPTIONS) return { ok: false, error: `Add at least ${POLL_MIN_OPTIONS} options.` };
  if (options.length > POLL_MAX_OPTIONS) return { ok: false, error: `A poll can have at most ${POLL_MAX_OPTIONS} options.` };
  if (options.some((o) => o.length > POLL_OPTION_MAX)) return { ok: false, error: `Keep each option under ${POLL_OPTION_MAX} characters.` };
  const seen = new Set<string>();
  for (const o of options) {
    const k = o.toLowerCase();
    if (seen.has(k)) return { ok: false, error: `"${o}" appears twice. Each option must be different.` };
    seen.add(k);
  }
  return { ok: true, options };
}

export interface PollTallyRow { id: string; label: string; count: number; pct: number; voters?: string[] }
export interface PollTally { total: number; closed: boolean; mine: string | null; rows: PollTallyRow[] }

/**
 * Count a poll. Percentages are whole numbers that add up to exactly 100
 * (largest-remainder rounding) whenever anyone has voted. Voter names are
 * included only for a named poll.
 */
export function tallyPoll(
  options: Array<{ id: string; label: string; position: number }>,
  votes: Array<{ optionId: string; employeeId: string; voterName?: string }>,
  viewerEmployeeId: string | null,
  anonymous: boolean,
  expiresAt: Date | null,
  now: Date = new Date(),
): PollTally {
  const ordered = [...options].sort((a, b) => a.position - b.position);
  const counts = new Map<string, number>(ordered.map((o) => [o.id, 0]));
  const names = new Map<string, string[]>(ordered.map((o) => [o.id, []]));
  let total = 0;
  let mine: string | null = null;
  for (const v of votes) {
    if (!counts.has(v.optionId)) continue;
    counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1);
    if (v.voterName) names.get(v.optionId)!.push(v.voterName);
    total++;
    if (viewerEmployeeId && v.employeeId === viewerEmployeeId) mine = v.optionId;
  }
  const pcts = largestRemainder(ordered.map((o) => counts.get(o.id) ?? 0), total);
  return {
    total, mine,
    closed: !!expiresAt && expiresAt.getTime() <= now.getTime(),
    rows: ordered.map((o, i) => ({
      id: o.id, label: o.label, count: counts.get(o.id) ?? 0, pct: pcts[i],
      ...(anonymous ? {} : { voters: names.get(o.id)!.slice().sort((a, b) => a.localeCompare(b)) }),
    })),
  };
}

function largestRemainder(counts: number[], total: number): number[] {
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (counts[i] === 0) continue;
    floors[i]++; left--;
  }
  return floors;
}

// ---------------------------------------------------------------------------
//  Celebrations
// ---------------------------------------------------------------------------

/**
 * Whether a wish for this occasion may be sent today: on the birthday or
 * work anniversary itself (29 Feb celebrated on 28 Feb in other years), or
 * within 90 days of joining for a new joinee. Dates are UTC-midnight days.
 */
export function wishWindowOpen(
  occasion: "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE",
  person: { dateOfBirth: Date | null; dateOfJoining: Date },
  today: Date,
): boolean {
  const sameDay = (d: Date) => {
    const y = today.getUTCFullYear();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const m = d.getUTCMonth(), day = d.getUTCDate();
    const target = m === 1 && day === 29 && !leap ? 28 : day;
    return today.getUTCMonth() === m && today.getUTCDate() === target;
  };
  if (occasion === "BIRTHDAY") return !!person.dateOfBirth && sameDay(person.dateOfBirth);
  if (occasion === "WORK_ANNIVERSARY") {
    return person.dateOfJoining.getUTCFullYear() < today.getUTCFullYear() && sameDay(person.dateOfJoining);
  }
  const days = Math.round((today.getTime() - person.dateOfJoining.getTime()) / 86_400_000);
  return days >= 0 && days <= 90;
}

/** "Happy birthday Neha 🎉" — the text the Wish box starts with. */
export function defaultWish(occasion: "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE", name: string): string {
  if (occasion === "BIRTHDAY") return `Happy birthday ${name} 🎉`;
  if (occasion === "WORK_ANNIVERSARY") return `Happy work anniversary ${name} 🎉`;
  return `Welcome to the team ${name} 👋`;
}

/** Keep a user-supplied URL only if it is https or an app-relative path. */
export function safeLinkUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^\/(?!\/)[^\s]*$/.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
