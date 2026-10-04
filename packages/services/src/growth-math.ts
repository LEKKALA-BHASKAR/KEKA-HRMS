/**
 * Pure rules for the growth modules — learning paths, sessions, certificates,
 * talent reviews and the 9-box, succession, internal mobility, development
 * plans, competencies and coaching. No database here, so every rule is unit
 * tested on its own.
 */

import type { QuestionInput } from "./performance-learning-math";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
//  Review workflow for definitions that need sign-off
// ---------------------------------------------------------------------------

export type GrowthReviewStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "ARCHIVED";
export type GrowthReviewOp = "submit" | "withdraw" | "approve" | "reject" | "reopen" | "archive";

/**
 * One step of the shared DRAFT → SUBMITTED → APPROVED flow. Whoever submitted
 * cannot approve or reject their own submission — that is the point of a
 * second pair of eyes. A rejection needs a reason.
 */
export function reviewStep(
  current: string, op: string, opts: { actor: string; submittedBy?: string | null; note?: string | null },
): { ok: true; next: GrowthReviewStatus } | { ok: false; message: string } {
  const own = !!opts.submittedBy && opts.submittedBy === opts.actor;
  switch (op) {
    case "submit":
      return current === "DRAFT" || current === "REJECTED" ? { ok: true, next: "SUBMITTED" } : { ok: false, message: "Only a draft can be submitted for approval." };
    case "withdraw":
      if (current !== "SUBMITTED") return { ok: false, message: "Only a submission waiting for approval can be withdrawn." };
      return own ? { ok: true, next: "DRAFT" } : { ok: false, message: "Only the person who submitted it can withdraw it." };
    case "approve":
      if (current !== "SUBMITTED") return { ok: false, message: "Only a submitted item can be approved." };
      return own ? { ok: false, message: "You submitted this — someone else has to approve it." } : { ok: true, next: "APPROVED" };
    case "reject":
      if (current !== "SUBMITTED") return { ok: false, message: "Only a submitted item can be rejected." };
      if (own) return { ok: false, message: "You submitted this — withdraw it instead." };
      return opts.note?.trim() ? { ok: true, next: "REJECTED" } : { ok: false, message: "Say why it is being sent back." };
    case "reopen":
      return current === "APPROVED" || current === "REJECTED" || current === "ARCHIVED" ? { ok: true, next: "DRAFT" } : { ok: false, message: "It is already open for changes." };
    case "archive":
      return current === "APPROVED" || current === "DRAFT" ? { ok: true, next: "ARCHIVED" } : { ok: false, message: "Only an approved or draft item can be archived." };
    default:
      return { ok: false, message: "Unknown action." };
  }
}

// ---------------------------------------------------------------------------
//  CSV
// ---------------------------------------------------------------------------

/** One CSV cell, with spreadsheet formulas neutralised (= + - @ at the start). */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A whole CSV file: header row, then one row per record, CRLF line ends and a BOM for Excel. */
export function toCsv(head: string[], rows: unknown[][]): string {
  return "﻿" + [head, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
}

// ---------------------------------------------------------------------------
//  Learning paths, sessions, attempts and certificates
// ---------------------------------------------------------------------------

/**
 * Progress through a path: the share of its required courses completed.
 * Optional courses never hold a path back. A path with only optional courses
 * is complete once any one of them is.
 */
export function pathProgress(
  courses: Array<{ courseId: string; isOptional: boolean }>,
  enrolments: Array<{ courseId: string; status: string; progressPercent?: number }>,
): { percent: number; done: number; required: number; status: "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" } {
  const byCourse = new Map(enrolments.map((e) => [e.courseId, e]));
  const required = courses.filter((c) => !c.isOptional);
  const pool = required.length ? required : courses;
  const done = pool.filter((c) => byCourse.get(c.courseId)?.status === "COMPLETED").length;
  const target = required.length ? required.length : Math.min(1, courses.length);
  const doneCapped = Math.min(done, target);
  const percent = target === 0 ? 0 : Math.floor((doneCapped / target) * 100);
  const touched = courses.some((c) => { const e = byCourse.get(c.courseId); return !!e && (e.status !== "ASSIGNED" || (e.progressPercent ?? 0) > 0); });
  return { percent, done: doneCapped, required: target, status: target > 0 && doneCapped >= target ? "COMPLETED" : touched ? "IN_PROGRESS" : "ASSIGNED" };
}

/** Which seat a new registration gets: a place while there is room, otherwise the waitlist. */
export function sessionSeat(capacity: number | null | undefined, taken: number): "REGISTERED" | "WAITLISTED" {
  return capacity && capacity > 0 && taken >= capacity ? "WAITLISTED" : "REGISTERED";
}

/** Can a session still be changed or registered for? */
export function sessionOpen(s: { status: string; startsAt: Date }, now = new Date()): boolean {
  return s.status === "SCHEDULED" && s.startsAt.getTime() > now.getTime();
}

/** Attempts left on a quiz: unlimited (null) without a limit; each approved retake adds one. */
export function attemptsLeft(maxAttempts: number | null | undefined, used: number, approvedRetakes = 0): number | null {
  if (!maxAttempts || maxAttempts <= 0) return null;
  return Math.max(0, maxAttempts + approvedRetakes - used);
}

/** CERT-2026-000042 — readable, sortable, unique per company with the sequence. */
export function certificateNumber(issued: Date, seq: number): string {
  return `CERT-${issued.getUTCFullYear()}-${String(seq).padStart(6, "0")}`;
}

/** Expiry a whole number of months after issue (clamped to the month's last day). */
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes()));
}

export type CertificateStatus = "VALID" | "EXPIRING" | "EXPIRED" | "REVOKED";

/** Expiring means within 30 days. */
export function certificateStatus(c: { expiresAt: Date | null; revokedAt: Date | null }, today = new Date()): CertificateStatus {
  if (c.revokedAt) return "REVOKED";
  if (!c.expiresAt) return "VALID";
  const days = (c.expiresAt.getTime() - today.getTime()) / DAY;
  if (days < 0) return "EXPIRED";
  return days <= 30 ? "EXPIRING" : "VALID";
}

/**
 * A quiz question from the bulk-upload format (shared with the course
 * builder). Simple-course quizzes take single-choice and true/false only.
 */
export function toQuizQuestion(q: QuestionInput): { ok: true; prompt: string; options: string[]; correctIndex: number } | { ok: false; message: string } {
  if (q.type === "MULTIPLE_CHOICE") return { ok: false, message: `"${q.prompt.slice(0, 40)}" has several correct answers; quizzes take one.` };
  const options = q.options.map((o) => o.text.trim());
  const correctIndex = q.options.findIndex((o) => o.id === q.correctOptionIds[0]);
  if (correctIndex < 0) return { ok: false, message: `"${q.prompt.slice(0, 40)}" has no correct answer.` };
  return { ok: true, prompt: q.prompt.trim(), options, correctIndex };
}

// ---------------------------------------------------------------------------
//  Talent reviews and the 9-box
// ---------------------------------------------------------------------------

export const NINE_BOX_DEFAULTS: Record<number, { label: string; description: string }> = {
  9: { label: "Star", description: "High performance, high potential. Stretch and retain." },
  8: { label: "Future star", description: "Solid performance, high potential. Accelerate." },
  7: { label: "Rough diamond", description: "High potential not yet showing in results. Coach." },
  6: { label: "High performer", description: "High performance, moderate potential. Reward and broaden." },
  5: { label: "Core player", description: "The dependable middle. Develop." },
  4: { label: "Inconsistent player", description: "Moderate potential, low results. Find the blocker." },
  3: { label: "Trusted professional", description: "High performance in the current role. Recognise." },
  2: { label: "Effective", description: "Meets expectations in the current role." },
  1: { label: "Talent risk", description: "Low performance and potential. Improvement plan or move." },
};

/** Box 1–9: rows are potential (1 low … 3 high), columns performance. */
export function nineBox(performance: number | null | undefined, potential: number | null | undefined): number | null {
  if (!performance || !potential) return null;
  const p = Math.round(performance), q = Math.round(potential);
  if (p < 1 || p > 3 || q < 1 || q > 3) return null;
  return (q - 1) * 3 + p;
}

/** A review rating on any scale, as a 9-box band: bottom 40% low, top quarter high. */
export function ratingBand(rating: number | null | undefined, max = 5): 1 | 2 | 3 | null {
  if (rating === null || rating === undefined || !Number.isFinite(rating) || max <= 0) return null;
  const share = rating / max;
  return share <= 0.5 ? 1 : share < 0.8 ? 2 : 3;
}

/** How many people sit in each box, for the grid. */
export function boxCounts(entries: Array<{ box: number | null }>): Record<number, number> {
  const out: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
  for (const e of entries) if (e.box && out[e.box] !== undefined) out[e.box]++;
  return out;
}

/** A talent review can be submitted once everyone in it is placed. */
export function reviewReady(entries: Array<{ performance: number | null; potential: number | null }>): { ok: boolean; unrated: number } {
  const unrated = entries.filter((e) => !e.performance || !e.potential).length;
  return { ok: entries.length > 0 && unrated === 0, unrated };
}

// ---------------------------------------------------------------------------
//  Succession
// ---------------------------------------------------------------------------

export const DEFAULT_READINESS = [
  { code: "READY_NOW", name: "Ready now", description: "Could step in today.", minMonths: 0, maxMonths: 0, displayOrder: 1 },
  { code: "READY_1_2", name: "Ready in 1–2 years", description: "Needs one or two development moves.", minMonths: 12, maxMonths: 24, displayOrder: 2 },
  { code: "READY_3_PLUS", name: "Ready in 3+ years", description: "A longer-term successor.", minMonths: 36, maxMonths: null, displayOrder: 3 },
] as const;

/** Is a readiness level "ready now"? (No time to readiness.) */
export const isReadyNow = (r: { minMonths: number; maxMonths: number | null }) => r.minMonths === 0 && (r.maxMonths ?? 0) === 0;

export interface PlanForCoverage {
  criticality: string;
  successors: Array<{ status: string; readyNow: boolean; isEmergency?: boolean }>;
}

/**
 * Coverage across critical positions: a position is covered when it has an
 * approved ready-now successor. Bench strength is approved successors per
 * position.
 */
export function successionCoverage(plans: PlanForCoverage[]) {
  const approved = plans.map((p) => p.successors.filter((s) => s.status === "APPROVED"));
  const covered = approved.filter((a) => a.some((s) => s.readyNow)).length;
  const total = approved.reduce((s, a) => s + a.length, 0);
  return {
    positions: plans.length,
    covered,
    coverage: plans.length ? Math.round((covered / plans.length) * 100) : 0,
    benchStrength: plans.length ? Math.round((total / plans.length) * 10) / 10 : 0,
    noSuccessor: approved.filter((a) => a.length === 0).length,
    noEmergency: plans.filter((p, i) => !approved[i].some((s) => s.isEmergency)).length,
  };
}

/** A plan's risk: a high-criticality position without a ready-now successor is at risk. */
export function planRisk(p: PlanForCoverage & { riskOfLoss: string }): "AT_RISK" | "WATCH" | "COVERED" {
  const approved = p.successors.filter((s) => s.status === "APPROVED");
  if (approved.some((s) => s.readyNow)) return "COVERED";
  return p.criticality === "HIGH" || p.riskOfLoss === "HIGH" ? "AT_RISK" : "WATCH";
}

// ---------------------------------------------------------------------------
//  Internal mobility
// ---------------------------------------------------------------------------

/** Whole months between two dates. */
export function fullMonthsBetween(from: Date, to: Date): number {
  let m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) m--;
  return Math.max(0, m);
}

/** May this employee apply to this internal posting? */
export function internalEligibility(
  job: { allowInternal: boolean; status: string; internalClosesAt: Date | null; internalMinTenureMonths: number | null; departmentId?: string | null },
  emp: { dateOfJoining: Date; status: string; onActivePip?: boolean },
  today = new Date(),
): { ok: true } | { ok: false; message: string } {
  if (!job.allowInternal || job.status !== "OPEN") return { ok: false, message: "This job is not open to internal applicants." };
  if (job.internalClosesAt && job.internalClosesAt.getTime() < today.getTime() - DAY + 1) return { ok: false, message: "Internal applications for this job have closed." };
  if (["EXITED", "NOTICE_PERIOD", "INACTIVE"].includes(emp.status)) return { ok: false, message: "Internal moves are open to active employees only." };
  if (emp.onActivePip) return { ok: false, message: "Internal moves are paused while an improvement plan is open." };
  const need = job.internalMinTenureMonths ?? 0;
  if (need > 0 && fullMonthsBetween(emp.dateOfJoining, today) < need) return { ok: false, message: `You need ${need} months with the company to apply.` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
//  Skills and competencies
// ---------------------------------------------------------------------------

/**
 * Gap against a competency profile. Readiness is weighted; a critical
 * requirement not met caps readiness below 100 even when everything else is.
 */
export function competencyGap(
  items: Array<{ skillId: string; requiredLevel: number; weight?: number; isCritical?: boolean }>,
  held: Array<{ skillId: string; level: number; isApproved: boolean }>,
) {
  const mine = new Map(held.filter((h) => h.isApproved).map((h) => [h.skillId, h.level]));
  const rows = items.map((r) => {
    const level = mine.get(r.skillId) ?? null;
    return { skillId: r.skillId, required: r.requiredLevel, held: level, gap: Math.max(0, r.requiredLevel - (level ?? -1)), met: level !== null && level >= r.requiredLevel, critical: !!r.isCritical, weight: Math.max(1, r.weight ?? 1) };
  });
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const met = rows.filter((r) => r.met).reduce((s, r) => s + r.weight, 0);
  let readiness = total === 0 ? 100 : Math.floor((met / total) * 100);
  const criticalGaps = rows.filter((r) => r.critical && !r.met).length;
  if (criticalGaps && readiness === 100) readiness = 99;
  return { rows, readiness, gaps: rows.filter((r) => !r.met).length, criticalGaps };
}

/** A confirmed skill goes stale after the skill's validity window. */
export function skillFreshness(approvedAt: Date | null, validityMonths: number | null | undefined, today = new Date()): "FRESH" | "STALE" | "UNCONFIRMED" {
  if (!approvedAt) return "UNCONFIRMED";
  if (!validityMonths) return "FRESH";
  return addMonths(approvedAt, validityMonths).getTime() < today.getTime() ? "STALE" : "FRESH";
}

/** Proficiency levels typed one per line or comma separated: 2–10 distinct names. */
export function parseLevels(raw: string): { ok: true; levels: string[] } | { ok: false; message: string } {
  const levels = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (levels.length < 2) return { ok: false, message: "Give at least two levels." };
  if (levels.length > 10) return { ok: false, message: "Use at most ten levels." };
  if (new Set(levels.map((l) => l.toLowerCase())).size !== levels.length) return { ok: false, message: "Two levels have the same name." };
  if (levels.some((l) => l.length > 60)) return { ok: false, message: "Keep each level under 60 characters." };
  return { ok: true, levels };
}

// ---------------------------------------------------------------------------
//  Improvement plans, coaching and development actions
// ---------------------------------------------------------------------------

/** A performance risk signal from the latest check-ins: two off-track in a row is high. */
export function pipRisk(checkIns: Array<{ heldOn: Date; progress: string }>, missedMilestones = 0): "HIGH" | "MEDIUM" | "LOW" {
  const recent = [...checkIns].sort((a, b) => b.heldOn.getTime() - a.heldOn.getTime()).slice(0, 2);
  if ((recent.length === 2 && recent.every((c) => c.progress === "OFF_TRACK")) || missedMilestones >= 2) return "HIGH";
  if (recent[0]?.progress === "OFF_TRACK" || recent[0]?.progress === "AT_RISK" || missedMilestones === 1) return "MEDIUM";
  return "LOW";
}

export type ActionStatus = "OPEN" | "IN_PROGRESS" | "SUBMITTED" | "VERIFIED" | "CANCELLED";

/**
 * Development actions: the owner starts and submits (with evidence); someone
 * else — the manager, coach or plan owner — verifies or sends back.
 */
export function actionStep(
  current: string, op: string, opts: { isOwner: boolean; isReviewer: boolean; evidence?: string | null; note?: string | null },
): { ok: true; next: ActionStatus } | { ok: false; message: string } {
  switch (op) {
    case "start":
      if (!opts.isOwner) return { ok: false, message: "Only the person it belongs to can start it." };
      return current === "OPEN" ? { ok: true, next: "IN_PROGRESS" } : { ok: false, message: "It has already started." };
    case "submit":
      if (!opts.isOwner) return { ok: false, message: "Only the person it belongs to can mark it done." };
      if (current !== "OPEN" && current !== "IN_PROGRESS") return { ok: false, message: "It is not open." };
      return opts.evidence?.trim() ? { ok: true, next: "SUBMITTED" } : { ok: false, message: "Say what was done, or link the evidence." };
    case "verify":
      if (!opts.isReviewer || opts.isOwner) return { ok: false, message: "Someone else has to verify it." };
      return current === "SUBMITTED" ? { ok: true, next: "VERIFIED" } : { ok: false, message: "It has not been submitted." };
    case "return":
      if (!opts.isReviewer || opts.isOwner) return { ok: false, message: "Someone else has to review it." };
      if (current !== "SUBMITTED") return { ok: false, message: "It has not been submitted." };
      return opts.note?.trim() ? { ok: true, next: "IN_PROGRESS" } : { ok: false, message: "Say what is still missing." };
    case "cancel":
      if (!opts.isReviewer) return { ok: false, message: "Only the reviewer can cancel it." };
      return current === "VERIFIED" || current === "CANCELLED" ? { ok: false, message: "It is already closed." } : { ok: true, next: "CANCELLED" };
    default:
      return { ok: false, message: "Unknown action." };
  }
}

/** Share of a plan's live actions verified. */
export function actionsProgress(actions: Array<{ status: string }>): number {
  const live = actions.filter((a) => a.status !== "CANCELLED");
  return live.length ? Math.floor((live.filter((a) => a.status === "VERIFIED").length / live.length) * 100) : 0;
}
