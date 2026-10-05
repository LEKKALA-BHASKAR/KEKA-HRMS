import "server-only";
import { prisma } from "@keka/db";
import { mergeTimeline, type TimelineEvent } from "@keka/services";

/**
 * Timelines for one person: their performance history (reviews, goals,
 * plans), the feedback they received, and their coaching history. Callers
 * decide who may see whose; internal notes and anonymous givers never show.
 */

export async function performanceTimeline(tenantId: string, employeeId: string): Promise<TimelineEvent[]> {
  const [reviews, goals, pips] = await Promise.all([
    prisma.employeeReview.findMany({ where: { employeeId, cycle: { tenantId } }, include: { cycle: { select: { name: true, periodEnd: true } }, band: { select: { name: true } } } }),
    prisma.goal.findMany({ where: { tenantId, employeeId, status: { in: ["COMPLETED", "MISSED"] } }, select: { title: true, status: true, dueDate: true, progressPercent: true } }),
    prisma.improvementPlan.findMany({ where: { tenantId, employeeId }, select: { startDate: true, decidedAt: true, outcome: true, status: true } }),
  ]);
  return mergeTimeline(
    reviews.map((r) => ({ at: r.sharedAt ?? r.calibratedAt ?? r.cycle.periodEnd, kind: "Review", title: `${r.cycle.name}: ${r.finalRating !== null ? `rated ${Number(r.finalRating)}` : r.status.toLowerCase().replace(/_/g, " ")}`, detail: r.band?.name ?? null })),
    goals.map((g) => ({ at: g.dueDate, kind: "Goal", title: `${g.status === "COMPLETED" ? "Completed" : "Missed"}: ${g.title}`, detail: `${Number(g.progressPercent)}%` })),
    pips.flatMap((p) => [{ at: p.startDate, kind: "Plan", title: "Improvement plan started" }, ...(p.decidedAt ? [{ at: p.decidedAt, kind: "Plan", title: `Improvement plan closed: ${String(p.outcome ?? "").toLowerCase()}` }] : [])]),
  );
}

export async function feedbackTimeline(tenantId: string, employeeId: string): Promise<TimelineEvent[]> {
  const [fb, praise] = await Promise.all([
    prisma.feedback.findMany({ where: { tenantId, aboutEmployeeId: employeeId, kind: "FEEDBACK", deletedAt: null }, include: { fromEmployee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.praise.findMany({ where: { tenantId, toEmployeeId: employeeId }, include: { fromEmployee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return mergeTimeline(
    fb.map((f) => ({ at: f.createdAt, kind: f.sentiment ? `Feedback · ${f.sentiment.toLowerCase()}` : "Feedback", title: `${f.isAnonymous ? "A colleague" : f.fromEmployee.displayName}${f.topic ? ` on ${f.topic}` : ""}`, detail: f.message.slice(0, 200) })),
    praise.map((p) => ({ at: p.createdAt, kind: "Praise", title: p.fromEmployee.displayName ?? "A colleague", detail: p.message.slice(0, 200) })),
  );
}

export async function coachingTimeline(tenantId: string, employeeId: string): Promise<TimelineEvent[]> {
  const [plans, logs, pipCheckIns] = await Promise.all([
    prisma.coachingPlan.findMany({ where: { tenantId, employeeId }, include: { coach: { select: { displayName: true } }, sessions: true } }),
    prisma.insightBehaviorLog.findMany({ where: { tenantId, employeeId } }),
    prisma.pipCheckIn.findMany({ where: { pip: { tenantId, employeeId } } }),
  ]);
  return mergeTimeline(
    plans.map((p) => ({ at: p.startDate, kind: "Coaching", title: `Coaching on ${p.focusArea} with ${p.coach.displayName}`, detail: p.status.toLowerCase() })),
    plans.flatMap((p) => p.sessions.map((s) => ({ at: s.heldOn, kind: "Session", title: `${p.focusArea}: ${s.progress.toLowerCase()}`, detail: s.notes.slice(0, 200) }))),
    logs.map((l) => ({ at: l.observedOn, kind: "Behaviour", title: `${l.behaviour}: ${l.rating}/5`, detail: l.note })),
    pipCheckIns.map((c) => ({ at: c.heldOn, kind: "Plan check-in", title: c.progress.toLowerCase().replace("_", " "), detail: c.notes.slice(0, 200) })),
  );
}
