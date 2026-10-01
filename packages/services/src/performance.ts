import { prisma } from "@keka/db";
import { goalProgress, goalHealth, weightedRating, bandFor, DEFAULT_REVIEWERS, type MetricType, type ReviewerWeight } from "./performance-math";
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
 * reviewer type the cycle uses. Eligible means employed for the whole of the
 * cycle's last 90 days and not already exited.
 */
export async function launchCycle(cycleId: string): Promise<{ ok: boolean; message: string; reviews?: number }> {
  const c = await prisma.reviewCycle.findUnique({ where: { id: cycleId }, include: { bands: true } });
  if (!c) return { ok: false, message: "Cycle not found." };
  if (c.status !== "DRAFT") return { ok: false, message: "This cycle is already launched." };
  if (c.bands.length === 0) return { ok: false, message: "Add rating bands before launching, so ratings can be calibrated." };
  const cutoff = new Date(c.periodEnd.getTime() - 90 * 86_400_000);
  const emps = await prisma.employee.findMany({
    where: { tenantId: c.tenantId, status: { notIn: ["EXITED", "PREBOARDING", "ONBOARDING"] }, dateOfJoining: { lte: cutoff } },
    select: { id: true, reportingManagerId: true, userId: true },
  });
  const types = reviewersOf(c.reviewerTypes).filter((r) => r.type === "SELF" || r.type === "MANAGER");
  let made = 0;
  for (const e of emps) {
    const review = await prisma.employeeReview.upsert({
      where: { cycleId_employeeId: { cycleId, employeeId: e.id } },
      create: { cycleId, employeeId: e.id, status: types.some((t) => t.type === "SELF") ? "SELF_PENDING" : "MANAGER_PENDING" },
      update: {},
    });
    for (const t of types) {
      const reviewerId = t.type === "SELF" ? e.id : e.reportingManagerId;
      if (!reviewerId) continue;
      await prisma.reviewResponse.upsert({
        where: { reviewId_reviewerId_reviewerType: { reviewId: review.id, reviewerId, reviewerType: t.type } },
        create: { reviewId: review.id, reviewerId, reviewerType: t.type, weight: t.weight },
        update: {},
      });
    }
    made++;
  }
  await prisma.reviewCycle.update({ where: { id: cycleId }, data: { status: "IN_PROGRESS", launchedAt: new Date() } });
  await notify({
    tenantId: c.tenantId, userIds: emps.map((e) => e.userId), kind: "PERFORMANCE",
    title: `${c.name} has started`, body: "Write your self review, then your manager will add theirs.", link: "/performance?tab=reviews", email: true,
  });
  return { ok: true, message: `Launched for ${made} employee(s).`, reviews: made };
}

export interface ResponseInput {
  reviewId: string;
  reviewerEmployeeId: string;
  reviewerType: "SELF" | "MANAGER";
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
  const slot = review.responses.find((r) => r.reviewerId === input.reviewerEmployeeId && r.reviewerType === input.reviewerType);
  if (!slot) return { ok: false, message: "You are not a reviewer on this review." };
  if (slot.submittedAt) return { ok: false, message: "Already submitted." };
  if (input.reviewerType === "MANAGER" && review.status === "SELF_PENDING") {
    return { ok: false, message: `${review.employee.displayName} has not submitted their self review yet.` };
  }
  const scale = (review.cycle.ratingScale as { max?: number } | null)?.max ?? 5;
  if (!(input.overallRating >= 1 && input.overallRating <= scale)) return { ok: false, message: `Rate from 1 to ${scale}.` };
  if (input.reviewerType === "MANAGER" && !(input.strengths && input.improvements)) {
    return { ok: false, message: "Managers must write both strengths and areas to improve." };
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

  const responses = await prisma.reviewResponse.findMany({ where: { reviewId: review.id } });
  const pending = responses.filter((r) => !r.submittedAt);
  const raw = weightedRating(responses.map((r) => ({ type: r.reviewerType, rating: r.submittedAt ? Number(r.overallRating) : null })), reviewersOf(review.cycle.reviewerTypes));
  const nextStatus = pending.length === 0 ? "PENDING_CALIBRATION" : pending.every((p) => p.reviewerType === "MANAGER") ? "MANAGER_PENDING" : review.status;
  await prisma.employeeReview.update({ where: { id: review.id }, data: { status: nextStatus, rawRating: raw } });
  if (input.reviewerType === "SELF") {
    await notify({ tenantId: review.cycle.tenantId, userIds: [await userOf(review.employee.reportingManagerId)], kind: "PERFORMANCE", title: `${review.employee.displayName} submitted their self review`, link: `/performance/reviews/${review.id}` });
  }
  return { ok: true, message: nextStatus === "PENDING_CALIBRATION" ? "Submitted. The review now goes to calibration." : "Submitted." };
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
