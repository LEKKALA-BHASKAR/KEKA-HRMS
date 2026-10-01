import { prisma } from "@keka/db";
import { goalProgress, goalHealth, weightedRating, bandFor, DEFAULT_REVIEWERS, REVIEWER_LABEL, type MetricType, type ReviewerWeight, type ReviewerType } from "./performance-math";
import { notify } from "./lifecycle";

/**
 * Goals and reviews. A goal's status is derived from its progress against
 * time unless someone deliberately overrides it; a review's rating is derived
 * from the submitted responses until calibration sets a final one.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

async function userOf(employeeId: string | null | undefined) {
  if (!employeeId) return null;
  return (await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } }))?.userId ?? null;
}

/** Recompute a goal's progress and status, then its parent's. */
export async function refreshGoal(goalId: string, today = new Date()): Promise<void> {
  const g = await prisma.goal.findUnique({ where: { id: goalId }, include: { childGoals: { where: { status: { not: "CANCELLED" } } } } });
  if (!g) return;
  let progress: number;
  // MANUAL: the goal keeps its own measure; aligned goals contribute to it
  // in spirit, not arithmetic.
  if (g.childGoals.length > 0 && g.rollupMethod !== "MANUAL") {
    const kids = g.childGoals.map((c) => ({ progress: Number(c.progressPercent), weight: Number(c.weight) }));
    const total = kids.reduce((s, k) => s + k.weight, 0);
    progress = g.rollupMethod === "WEIGHTED" && total > 0
      ? r2(kids.reduce((s, k) => s + k.progress * k.weight, 0) / total)
      : r2(kids.reduce((s, k) => s + k.progress, 0) / kids.length);
  } else {
    progress = goalProgress(g.metricType as MetricType, Number(g.startValue), Number(g.targetValue), Number(g.currentValue));
  }
  const status = g.status === "DRAFT" || g.status === "CANCELLED" ? g.status : g.statusOverride ?? goalHealth(progress, g.startDate, g.dueDate, today);
  await prisma.goal.update({ where: { id: g.id }, data: { progressPercent: progress, status } });
  if (g.parentGoalId) await refreshGoal(g.parentGoalId, today);
}

export async function checkInGoal(opts: { goalId: string; value: number; note?: string | null; byEmployeeId?: string | null }): Promise<{ ok: boolean; message: string; progress?: number }> {
  const g = await prisma.goal.findUnique({ where: { id: opts.goalId }, include: { _count: { select: { childGoals: true } } } });
  if (!g) return { ok: false, message: "Goal not found." };
  if (g._count.childGoals > 0 && g.rollupMethod !== "MANUAL") return { ok: false, message: "This goal rolls up from its aligned goals; check in on those instead." };
  if (["COMPLETED", "MISSED", "CANCELLED"].includes(g.status) && !g.statusOverride) {
    return { ok: false, message: `This goal is ${g.status.toLowerCase()}. Reopen it to record more progress.` };
  }
  const progress = goalProgress(g.metricType as MetricType, Number(g.startValue), Number(g.targetValue), opts.value);
  await prisma.$transaction([
    prisma.goalCheckIn.create({ data: { goalId: g.id, value: opts.value, progressPercent: progress, note: opts.note ?? null, recordedBy: opts.byEmployeeId ?? null } }),
    prisma.goal.update({ where: { id: g.id }, data: { currentValue: opts.value, ...(g.status === "DRAFT" ? { status: "ON_TRACK" } : {}) } }),
  ]);
  await refreshGoal(g.id);
  const after = await prisma.goal.findUniqueOrThrow({ where: { id: g.id } });
  return { ok: true, message: `Progress ${progress}% — ${after.status.toLowerCase().replace(/_/g, " ")}.`, progress };
}

// ---------------------------------------------------------------------------
//  Review cycles
// ---------------------------------------------------------------------------

function reviewersOf(json: unknown): ReviewerWeight[] {
  return Array.isArray(json) && json.length ? (json as ReviewerWeight[]) : DEFAULT_REVIEWERS;
}

/**
 * Launch: one review per eligible employee, with a response slot for each
 * reviewer type the cycle uses: themselves, their manager, their manager's
 * manager, and their direct reports. Peers are nominated once the cycle is
 * running. Eligible means employed for the whole of the cycle's last 90 days
 * and not already exited.
 */
const MAX_SUBORDINATES = 8;
export async function launchCycle(cycleId: string): Promise<{ ok: boolean; message: string; reviews?: number }> {
  const c = await prisma.reviewCycle.findUnique({ where: { id: cycleId }, include: { bands: true } });
  if (!c) return { ok: false, message: "Cycle not found." };
  if (c.status !== "DRAFT") return { ok: false, message: "This cycle is already launched." };
  if (c.bands.length === 0) return { ok: false, message: "Add rating bands before launching, so ratings can be calibrated." };
  const cutoff = new Date(c.periodEnd.getTime() - 90 * 86_400_000);
  const emps = await prisma.employee.findMany({
    where: { tenantId: c.tenantId, status: { notIn: ["EXITED", "PREBOARDING", "ONBOARDING"] }, dateOfJoining: { lte: cutoff } },
    select: { id: true, reportingManagerId: true, userId: true, reportingManager: { select: { reportingManagerId: true } } },
  });
  const active = await prisma.employee.findMany({ where: { tenantId: c.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, reportingManagerId: true } });
  const reportsOf = new Map<string, string[]>();
  for (const e of active) if (e.reportingManagerId) reportsOf.set(e.reportingManagerId, [...(reportsOf.get(e.reportingManagerId) ?? []), e.id]);
  const types = reviewersOf(c.reviewerTypes).filter((r) => r.type !== "PEER");
  let made = 0;
  for (const e of emps) {
    const review = await prisma.employeeReview.upsert({
      where: { cycleId_employeeId: { cycleId, employeeId: e.id } },
      create: { cycleId, employeeId: e.id, status: types.some((t) => t.type === "SELF") ? "SELF_PENDING" : "MANAGER_PENDING" },
      update: {},
    });
    for (const t of types) {
      const ids = t.type === "SELF" ? [e.id]
        : t.type === "MANAGER" ? [e.reportingManagerId]
        : t.type === "SKIP_LEVEL" ? [e.reportingManager?.reportingManagerId]
        : t.type === "SUBORDINATE" ? (reportsOf.get(e.id) ?? []).slice(0, MAX_SUBORDINATES)
        : [];
      for (const reviewerId of ids) {
        if (!reviewerId || (reviewerId === e.id && t.type !== "SELF")) continue;
        await prisma.reviewResponse.upsert({
          where: { reviewId_reviewerId_reviewerType: { reviewId: review.id, reviewerId, reviewerType: t.type } },
          create: { reviewId: review.id, reviewerId, reviewerType: t.type, weight: t.weight },
          update: {},
        });
      }
    }
    made++;
  }
  await prisma.reviewCycle.update({ where: { id: cycleId }, data: { status: "IN_PROGRESS", launchedAt: new Date() } });
  const peers = types.length !== reviewersOf(c.reviewerTypes).length;
  await notify({
    tenantId: c.tenantId, userIds: emps.map((e) => e.userId), kind: "PERFORMANCE",
    title: `${c.name} has started`, body: `Write your self review${peers ? " and choose the peers you would like feedback from" : ""}, then your manager will add theirs.`, link: "/performance?tab=reviews", email: true,
  });
  return { ok: true, message: `Launched for ${made} employee(s).`, reviews: made };
}

const OPEN_REVIEW = ["NOT_STARTED", "SELF_PENDING", "MANAGER_PENDING", "PENDING_CALIBRATION"];

/**
 * Peers giving feedback. The employee proposes and their manager approves;
 * a manager's own nominations are active straight away. A peer cannot be
 * the employee, their manager, or someone already reviewing them.
 */
export async function nominatePeers(input: { reviewId: string; byEmployeeId: string; peerIds: string[] }): Promise<{ ok: boolean; message: string }> {
  const review = await prisma.employeeReview.findUnique({
    where: { id: input.reviewId },
    include: { cycle: true, responses: { where: { status: { in: ["PROPOSED", "ACTIVE"] } } }, employee: { select: { id: true, displayName: true, reportingManagerId: true, tenantId: true } } },
  });
  if (!review) return { ok: false, message: "Review not found." };
  if (!reviewersOf(review.cycle.reviewerTypes).some((t) => t.type === "PEER")) return { ok: false, message: "This cycle does not collect peer feedback." };
  if (!["IN_PROGRESS", "LAUNCHED"].includes(review.cycle.status) || !OPEN_REVIEW.includes(review.status)) return { ok: false, message: "This review is no longer taking feedback." };
  const byManager = input.byEmployeeId === review.employee.reportingManagerId;
  if (input.byEmployeeId !== review.employeeId && !byManager) return { ok: false, message: "Only the employee or their manager can choose peers." };
  const ids = [...new Set(input.peerIds.filter(Boolean))];
  if (ids.length === 0) return { ok: false, message: "Choose at least one peer." };
  const taken = new Set(review.responses.map((r) => r.reviewerId));
  if (ids.some((id) => id === review.employeeId || id === review.employee.reportingManagerId || taken.has(id))) return { ok: false, message: "A peer cannot be the employee, their manager, or someone already giving feedback." };
  const peersNow = review.responses.filter((r) => r.reviewerType === "PEER").length;
  if (peersNow + ids.length > review.cycle.maxPeers) return { ok: false, message: `Up to ${review.cycle.maxPeers} peers can give feedback; ${peersNow} already chosen.` };
  const found = await prisma.employee.findMany({ where: { id: { in: ids }, tenantId: review.employee.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, userId: true } });
  if (found.length !== ids.length) return { ok: false, message: "A chosen peer was not found." };
  const weight = reviewersOf(review.cycle.reviewerTypes).find((t) => t.type === "PEER")?.weight ?? 0;
  for (const id of ids) {
    await prisma.reviewResponse.upsert({
      where: { reviewId_reviewerId_reviewerType: { reviewId: review.id, reviewerId: id, reviewerType: "PEER" } },
      create: { reviewId: review.id, reviewerId: id, reviewerType: "PEER", weight, status: byManager ? "ACTIVE" : "PROPOSED", nominatedBy: input.byEmployeeId },
      update: { status: byManager ? "ACTIVE" : "PROPOSED", nominatedBy: input.byEmployeeId },
    });
  }
  const tenantId = review.employee.tenantId;
  if (byManager) {
    await notify({ tenantId, userIds: found.map((f) => f.userId), kind: "PERFORMANCE", title: `Feedback requested for ${review.employee.displayName}`, link: `/performance/reviews/${review.id}` });
    return { ok: true, message: `${ids.length} peer${ids.length === 1 ? "" : "s"} asked for feedback.` };
  }
  await notify({ tenantId, userIds: [await userOf(review.employee.reportingManagerId)], kind: "PERFORMANCE", title: `${review.employee.displayName} chose peers for feedback`, body: "Approve or decline them on the review.", link: `/performance/reviews/${review.id}` });
  return { ok: true, message: `Sent ${ids.length} peer${ids.length === 1 ? "" : "s"} to your manager to approve.` };
}

export async function decidePeerNomination(input: { responseId: string; byEmployeeId: string; approve: boolean }): Promise<{ ok: boolean; message: string }> {
  const slot = await prisma.reviewResponse.findUnique({ where: { id: input.responseId }, include: { reviewer: { select: { displayName: true, userId: true } }, review: { include: { employee: { select: { displayName: true, reportingManagerId: true, tenantId: true } } } } } });
  if (!slot || slot.reviewerType !== "PEER") return { ok: false, message: "Nomination not found." };
  if (slot.review.employee.reportingManagerId !== input.byEmployeeId) return { ok: false, message: "Only the employee's manager can decide peer nominations." };
  if (slot.status !== "PROPOSED") return { ok: false, message: "This nomination is already decided." };
  await prisma.reviewResponse.update({ where: { id: slot.id }, data: { status: input.approve ? "ACTIVE" : "DECLINED" } });
  if (input.approve) await notify({ tenantId: slot.review.employee.tenantId, userIds: [slot.reviewer.userId], kind: "PERFORMANCE", title: `Feedback requested for ${slot.review.employee.displayName}`, link: `/performance/reviews/${slot.reviewId}` });
  return { ok: true, message: input.approve ? `${slot.reviewer.displayName} will give feedback.` : `Declined ${slot.reviewer.displayName}.` };
}

export interface ResponseInput {
  reviewId: string;
  reviewerEmployeeId: string;
  reviewerType: ReviewerType;
  overallRating: number;
  strengths?: string | null;
  improvements?: string | null;
  indicatorRatings?: Array<{ indicatorId: string; rating: number; comment?: string | null }>;
}

export async function submitReviewResponse(input: ResponseInput): Promise<{ ok: boolean; message: string }> {
  const review = await prisma.employeeReview.findUnique({
    where: { id: input.reviewId },
    include: { cycle: true, responses: true, employee: { select: { reportingManagerId: true, displayName: true, userId: true } } },
  });
  if (!review) return { ok: false, message: "Review not found." };
  if (!["IN_PROGRESS", "LAUNCHED"].includes(review.cycle.status)) return { ok: false, message: "This cycle is not accepting reviews." };
  const slot = review.responses.find((r) => r.reviewerId === input.reviewerEmployeeId && r.reviewerType === input.reviewerType && r.status === "ACTIVE");
  if (!slot) return { ok: false, message: "You are not a reviewer on this review." };
  if (!OPEN_REVIEW.includes(review.status)) return { ok: false, message: "This review has been calibrated; feedback is closed." };
  if (slot.submittedAt) return { ok: false, message: "Already submitted." };
  if (input.reviewerType === "MANAGER" && review.status === "SELF_PENDING") {
    return { ok: false, message: `${review.employee.displayName} has not submitted their self review yet.` };
  }
  const scale = (review.cycle.ratingScale as { max?: number } | null)?.max ?? 5;
  if (!(input.overallRating >= 1 && input.overallRating <= scale)) return { ok: false, message: `Rate from 1 to ${scale}.` };
  if (input.reviewerType === "MANAGER" && !(input.strengths && input.improvements)) {
    return { ok: false, message: "Managers must write both strengths and areas to improve." };
  }
  if (input.reviewerType !== "SELF" && input.reviewerType !== "MANAGER" && !(input.strengths || input.improvements)) {
    return { ok: false, message: "Write what they do well or what they could improve." };
  }

  // Indicator ids arrive as form keys; rate only the tenant's own indicators.
  const asked = [...new Set((input.indicatorRatings ?? []).map((r) => r.indicatorId))];
  const known = new Set((await prisma.performanceIndicator.findMany({ where: { id: { in: asked }, category: { tenantId: review.cycle.tenantId } }, select: { id: true } })).map((i) => i.id));
  if (known.size !== asked.length) return { ok: false, message: "A rated indicator was not found." };

  await prisma.$transaction(async (tx) => {
    await tx.reviewResponse.update({
      where: { id: slot.id },
      data: { overallRating: input.overallRating, strengths: input.strengths ?? null, improvements: input.improvements ?? null, submittedAt: new Date() },
    });
    for (const ir of input.indicatorRatings ?? []) {
      await tx.indicatorRating.create({ data: { reviewId: review.id, indicatorId: ir.indicatorId, reviewerId: input.reviewerEmployeeId, rating: ir.rating, comment: ir.comment ?? null } });
    }
  });

  // Self and manager reviews move the review along; other feedback adds to
  // the rating whenever it arrives, until calibration closes it.
  const responses = await prisma.reviewResponse.findMany({ where: { reviewId: review.id, status: "ACTIVE" } });
  const open = (type: string) => responses.some((r) => r.reviewerType === type && !r.submittedAt);
  const raw = weightedRating(responses.map((r) => ({ type: r.reviewerType, rating: r.submittedAt ? Number(r.overallRating) : null })), reviewersOf(review.cycle.reviewerTypes));
  const nextStatus = open("SELF") ? "SELF_PENDING" : open("MANAGER") ? "MANAGER_PENDING" : "PENDING_CALIBRATION";
  await prisma.employeeReview.update({ where: { id: review.id }, data: { status: nextStatus, rawRating: raw } });
  if (input.reviewerType === "SELF") {
    await notify({ tenantId: review.cycle.tenantId, userIds: [await userOf(review.employee.reportingManagerId)], kind: "PERFORMANCE", title: `${review.employee.displayName} submitted their self review`, link: `/performance/reviews/${review.id}` });
  }
  const label = REVIEWER_LABEL[input.reviewerType] ?? "";
  if (input.reviewerType !== "SELF" && input.reviewerType !== "MANAGER") return { ok: true, message: `Thank you. Your ${label.toLowerCase()} feedback is submitted.` };
  return { ok: true, message: nextStatus === "PENDING_CALIBRATION" && review.status !== "PENDING_CALIBRATION" ? "Submitted. The review now goes to calibration." : "Submitted." };
}

/**
 * Calibration sets the final rating. Moving it from the raw rating needs a
 * reason, because that is the decision people will later ask about.
 */
export async function calibrateReview(opts: { reviewId: string; finalRating: number; reason?: string | null; byUserId: string }): Promise<{ ok: boolean; message: string }> {
  const review = await prisma.employeeReview.findUnique({ where: { id: opts.reviewId }, include: { cycle: { include: { bands: true } } } });
  if (!review) return { ok: false, message: "Review not found." };
  if (!["PENDING_CALIBRATION", "CALIBRATED"].includes(review.status)) return { ok: false, message: "Only reviews with every response submitted can be calibrated." };
  const raw = review.rawRating === null ? null : Number(review.rawRating);
  if (raw !== null && Math.abs(opts.finalRating - raw) > 0.001 && !opts.reason?.trim()) {
    return { ok: false, message: "Changing the rating needs a reason." };
  }
  const band = bandFor(opts.finalRating, review.cycle.bands.map((b) => ({ id: b.id, name: b.name, minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null ? null : Number(b.targetPercent) })));
  await prisma.employeeReview.update({
    where: { id: review.id },
    data: { finalRating: opts.finalRating, bandId: band?.id ?? null, status: "CALIBRATED", calibrationReason: opts.reason ?? null, calibratedBy: opts.byUserId, calibratedAt: new Date() },
  });
  // Feedback still outstanding no longer counts.
  await prisma.reviewResponse.updateMany({ where: { reviewId: review.id, submittedAt: null, status: { in: ["ACTIVE", "PROPOSED"] } }, data: { status: "EXPIRED" } });
  return { ok: true, message: `Calibrated at ${opts.finalRating}${band ? ` — ${band.name}` : ""}.` };
}

/** Release calibrated reviews to employees and close the cycle. */
export async function shareCycle(cycleId: string): Promise<{ ok: boolean; message: string }> {
  const c = await prisma.reviewCycle.findUnique({ where: { id: cycleId }, include: { reviews: { select: { status: true } } } });
  if (!c) return { ok: false, message: "Cycle not found." };
  const open = c.reviews.filter((r) => !["CALIBRATED", "SHARED", "ACKNOWLEDGED"].includes(r.status)).length;
  if (open > 0) return { ok: false, message: `${open} review(s) are not calibrated yet.` };
  const shared = await prisma.employeeReview.updateMany({ where: { cycleId, status: "CALIBRATED" }, data: { status: "SHARED", sharedAt: new Date() } });
  await prisma.reviewCycle.update({ where: { id: cycleId }, data: { status: "COMPLETED" } });
  const people = await prisma.employeeReview.findMany({ where: { cycleId }, select: { employee: { select: { userId: true } } } });
  await notify({ tenantId: c.tenantId, userIds: people.map((p) => p.employee.userId), kind: "PERFORMANCE", title: `Your ${c.name} review is ready`, link: "/performance?tab=reviews", email: true });
  return { ok: true, message: `Shared ${shared.count} review(s); the cycle is complete.` };
}

export async function acknowledgeReview(reviewId: string, employeeId: string, comments?: string | null): Promise<{ ok: boolean; message: string }> {
  const r = await prisma.employeeReview.findUnique({ where: { id: reviewId } });
  if (!r || r.employeeId !== employeeId) return { ok: false, message: "Review not found." };
  if (r.status !== "SHARED") return { ok: false, message: "This review has not been shared with you yet." };
  await prisma.employeeReview.update({ where: { id: reviewId }, data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), employeeComments: comments ?? null } });
  return { ok: true, message: "Acknowledged." };
}
