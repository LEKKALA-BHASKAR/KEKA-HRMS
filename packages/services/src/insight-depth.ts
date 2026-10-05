import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { refreshGoal } from "./performance";
import { loadPopulation } from "./analytics";
import { averageHeadcount, leaversIn, joinersIn, onBooks, trailingWindow } from "./analytics-math";
import type { StepSpec } from "./governance-math";
import {
  INSIGHT_CALCULATORS, thresholdState, kpiRag, targetInForce, kpiPeriodOf, medianOf, refreshOutcome, classifySentiment,
  escalationRuleMatches, checkInOverdue, reviewReminderDue, coachingFollowUpDue, closeoutStatus, closeoutSummary, reviewExceptionKinds,
  type InsightWorkflowType, type ThresholdState,
} from "./insight-math";

/**
 * Insight depth over the database: governed metrics and their calculators,
 * KPI readings, dashboard refreshes, OKR close-out and snapshots, feedback
 * classification and escalation, the performance exception queue, the jobs
 * that send reminders and alerts, and — for the generic workflow engine —
 * who approves each insight request by default and what an outcome does.
 * Every read is bound to the tenant passed in.
 */

const DAY = 86_400_000;
type Outcome = "APPROVED" | "REJECTED" | "WITHDRAWN";

// ---------------------------------------------------------------------------
//  Workflow routes and effects
// ---------------------------------------------------------------------------

const perm = (name: string, permission: string, order = 1): StepSpec => ({ order, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS" });

/** Built-in route of an insight request (changeKind narrows goals and PIP requests). */
export function insightBuiltInRoute(entityType: string, opts: { changeKind?: string | null } = {}): StepSpec[] | null {
  switch (entityType as InsightWorkflowType) {
    case "INSIGHT_METRIC": return [perm("Metric governance", "admin.report.build")];
    case "INSIGHT_KRA": return [perm("Performance administrator", "performance.review.manage")];
    case "INSIGHT_DASHBOARD":
    case "REPORT_PUBLISH":
    case "REPORT_SCHEDULE":
    case "REPORT_ACCESS":
    case "REPORT_EXPORT": return [perm("Report administrator", "admin.report.build")];
    case "GOAL_APPROVAL": return opts.changeKind === "INDIVIDUAL"
      ? [{ order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 72, escalateTo: "MANAGER_OF_APPROVER" }]
      : [perm("Goal administrator", "performance.goals.manage")];
    case "OKR_CLOSEOUT": return [perm("Goal administrator", "performance.goals.manage")];
    case "REVIEW_REOPEN": return [perm("Performance administrator", "performance.review.manage")];
    case "PIP_REQUEST": return opts.changeKind === "ESCALATION"
      ? [{ order: 1, name: "Manager's manager", approverType: "SKIP_MANAGER", mode: "ANY", slaHours: 72, escalateTo: "ADMINS" }, perm("HR (improvement plans)", "performance.pip.manage", 2)]
      : [perm("HR (improvement plans)", "performance.pip.manage")];
    default: return null;
  }
}

async function audit(tenantId: string, actor: string | null, entityType: string, entityId: string, action: "APPROVE" | "REJECT" | "UPDATE" | "CREATE", summary: string, module: "ANALYTICS" | "REPORT" | "EMPLOYEE" = "EMPLOYEE") {
  const who = actor ? await prisma.user.findFirst({ where: { id: actor, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({ data: { tenantId, module, action, entityType, entityId, summary, actorId: who ? actor : null, actorLabel: who?.email ?? "system" } });
}

/** Apply a finished insight approval. Throws to leave the request in ERROR. */
export async function applyInsightEffect(req: { id: string; tenantId: string; entityType: string; entityId: string | null }, outcome: Outcome, actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  const ok = outcome === "APPROVED";
  const back = outcome === "WITHDRAWN";
  const now = new Date();
  switch (req.entityType as InsightWorkflowType) {
    case "INSIGHT_METRIC": {
      const m = await prisma.insightMetric.findFirst({ where: { id, tenantId: t } });
      if (!m || m.status !== "PENDING_APPROVAL") return;
      if (ok) {
        await prisma.$transaction([
          prisma.insightMetric.updateMany({ where: { tenantId: t, key: m.key, status: "APPROVED", NOT: { id } }, data: { status: "RETIRED" } }),
          prisma.insightMetric.update({ where: { id }, data: { status: "APPROVED", decidedBy: actorUserId, decidedAt: now } }),
        ]);
        await computeAndStoreMetric(t, id);
      } else await prisma.insightMetric.update({ where: { id }, data: { status: back ? "DRAFT" : "REJECTED", decidedBy: back ? null : actorUserId, decidedAt: back ? null : now } });
      await audit(t, actorUserId, "InsightMetric", id, ok ? "APPROVE" : "REJECT", `Metric ${m.name} v${m.version} ${ok ? "approved" : outcome.toLowerCase()}`, "ANALYTICS");
      if (m.createdBy && !back) await notify({ tenantId: t, userIds: [m.createdBy], kind: "ANALYTICS", title: `Metric ${m.name} ${ok ? "approved" : "rejected"}`, link: "/insights/metrics" });
      return;
    }
    case "INSIGHT_KRA": {
      const k = await prisma.insightKra.findFirst({ where: { id, tenantId: t } });
      if (!k || k.status !== "PENDING_APPROVAL") return;
      if (ok) {
        await prisma.$transaction([
          prisma.insightKra.updateMany({ where: { tenantId: t, name: k.name, status: "APPROVED", NOT: { id } }, data: { status: "RETIRED" } }),
          prisma.insightKra.update({ where: { id }, data: { status: "APPROVED", decidedBy: actorUserId, decidedAt: now } }),
        ]);
      } else await prisma.insightKra.update({ where: { id }, data: { status: back ? "DRAFT" : "REJECTED", decidedBy: back ? null : actorUserId, decidedAt: back ? null : now } });
      await audit(t, actorUserId, "InsightKra", id, ok ? "APPROVE" : "REJECT", `KRA ${k.name} v${k.version} ${ok ? "approved" : outcome.toLowerCase()}`);
      return;
    }
    case "INSIGHT_DASHBOARD": {
      const d = await prisma.insightDashboard.findFirst({ where: { id, tenantId: t } });
      if (!d || d.status !== "PENDING_APPROVAL") return;
      await prisma.insightDashboard.update({ where: { id }, data: ok ? { status: "PUBLISHED", visibility: "ORG" } : { status: back ? "DRAFT" : "REJECTED" } });
      await audit(t, actorUserId, "InsightDashboard", id, ok ? "APPROVE" : "REJECT", `Dashboard ${d.name} ${ok ? "published company-wide" : outcome.toLowerCase()}`, "ANALYTICS");
      if (!back) await notify({ tenantId: t, userIds: [d.ownerUserId], kind: "ANALYTICS", title: `Dashboard ${d.name} ${ok ? "published" : "not published"}`, link: `/storyboards/${d.id}` });
      return;
    }
    case "REPORT_ACCESS": {
      const g = await prisma.insightReportGrant.findFirst({ where: { id, tenantId: t } });
      if (!g || g.status !== "PENDING") return;
      await prisma.insightReportGrant.update({ where: { id }, data: ok ? { status: "APPROVED", decidedAt: now, expiresAt: new Date(now.getTime() + g.days * DAY) } : { status: outcome, decidedAt: now } });
      await audit(t, actorUserId, "InsightReportGrant", id, ok ? "APPROVE" : "REJECT", `Access to ${g.title} ${ok ? `granted for ${g.days} day(s)` : outcome.toLowerCase()}`, "REPORT");
      if (!back) await notify({ tenantId: t, userIds: [g.userId], kind: "REPORT", title: `Access to ${g.title} ${ok ? "granted" : "refused"}`, link: "/insights/reports?tab=access" });
      return;
    }
    case "REPORT_EXPORT": {
      const x = await prisma.insightExportRequest.findFirst({ where: { id, tenantId: t } });
      if (!x || x.status !== "PENDING") return;
      await prisma.insightExportRequest.update({ where: { id }, data: ok ? { status: "APPROVED", expiresAt: new Date(now.getTime() + 7 * DAY) } : { status: outcome } });
      await audit(t, actorUserId, "InsightExportRequest", id, ok ? "APPROVE" : "REJECT", `Sensitive export ${ok ? "approved for 7 days" : outcome.toLowerCase()}`, "REPORT");
      if (!back) await notify({ tenantId: t, userIds: [x.requesterUserId], kind: "REPORT", title: `Export request ${ok ? "approved" : "refused"}`, link: "/insights/reports?tab=exports" });
      return;
    }
    case "REPORT_PUBLISH": {
      const s = await prisma.savedReport.findFirst({ where: { id, tenantId: t } });
      if (!s || s.publishStatus !== "PENDING") return;
      await prisma.savedReport.update({ where: { id }, data: ok ? { shared: true, publishStatus: "APPROVED" } : { shared: false, publishStatus: back ? null : "REJECTED" } });
      await audit(t, actorUserId, "SavedReport", id, ok ? "APPROVE" : "REJECT", `Custom report ${s.name} ${ok ? "published company-wide" : outcome.toLowerCase()}`, "REPORT");
      if (!back) await notify({ tenantId: t, userIds: [s.createdBy], kind: "REPORT", title: `Custom report ${s.name} ${ok ? "published" : "not published"}`, link: "/reports/builder" });
      return;
    }
    case "REPORT_SCHEDULE": {
      const s = await prisma.scheduledReport.findFirst({ where: { id, tenantId: t } });
      if (!s || s.approvalStatus !== "PENDING") return;
      await prisma.scheduledReport.update({ where: { id }, data: ok ? { approvalStatus: "APPROVED", isActive: true } : { approvalStatus: back ? "WITHDRAWN" : "REJECTED", isActive: false } });
      await audit(t, actorUserId, "ScheduledReport", id, ok ? "APPROVE" : "REJECT", `Schedule ${s.name} ${ok ? "approved to mail outside the company" : outcome.toLowerCase()}`, "REPORT");
      if (!back && s.createdBy) await notify({ tenantId: t, userIds: [s.createdBy], kind: "REPORT", title: `Schedule ${s.name} ${ok ? "approved" : "refused"}`, link: "/insights/reports?tab=schedules" });
      return;
    }
    case "GOAL_APPROVAL": {
      const g = await prisma.goal.findFirst({ where: { id, tenantId: t } });
      if (!g || g.approvalStatus !== "PENDING") return;
      if (ok) {
        await prisma.goal.update({ where: { id }, data: { approvalStatus: "APPROVED", status: "ON_TRACK" } });
        await refreshGoal(id);
      } else await prisma.goal.update({ where: { id }, data: { approvalStatus: back ? null : "REJECTED", approvalRequestId: back ? null : g.approvalRequestId } });
      await audit(t, actorUserId, "Goal", id, ok ? "APPROVE" : "REJECT", `Goal “${g.title}” ${ok ? "approved and live" : outcome.toLowerCase()}`);
      if (!back && g.createdBy) await notify({ tenantId: t, userIds: [g.createdBy], kind: "PERFORMANCE", title: `Goal ${ok ? "approved" : "sent back"}: ${g.title}`, link: "/performance/okr?tab=approvals" });
      return;
    }
    case "OKR_CLOSEOUT": {
      const c = await prisma.insightOkrCloseout.findFirst({ where: { id, tenantId: t } });
      if (!c || c.status !== "PENDING") return;
      if (ok) await closeOutTimeframe(t, c.id, actorUserId);
      else await prisma.insightOkrCloseout.update({ where: { id }, data: { status: outcome } });
      await audit(t, actorUserId, "InsightOkrCloseout", id, ok ? "APPROVE" : "REJECT", `Close-out of ${c.timeframe} ${ok ? "approved: goals scored and snapshotted" : outcome.toLowerCase()}`);
      return;
    }
    case "REVIEW_REOPEN": {
      const r = await prisma.insightReviewReopen.findFirst({ where: { id, tenantId: t } });
      if (!r || r.status !== "PENDING") return;
      if (ok) {
        const review = await prisma.employeeReview.findFirst({ where: { id: r.reviewId, cycle: { tenantId: t } } });
        if (!review) throw new Error("The review no longer exists.");
        await prisma.$transaction([
          prisma.employeeReview.update({ where: { id: review.id }, data: { status: "MANAGER_PENDING", finalRating: null, bandId: null, calibratedAt: null, calibratedBy: null, sharedAt: null, acknowledgedAt: null } }),
          prisma.reviewResponse.updateMany({ where: { reviewId: review.id, reviewerType: "MANAGER" }, data: { submittedAt: null, status: "ACTIVE" } }),
          prisma.reviewCycle.updateMany({ where: { id: review.cycleId, tenantId: t, status: "COMPLETED" }, data: { status: "IN_PROGRESS" } }),
          prisma.insightReviewReopen.update({ where: { id }, data: { status: "APPROVED", decidedAt: now } }),
        ]);
      } else await prisma.insightReviewReopen.update({ where: { id }, data: { status: outcome, decidedAt: now } });
      await audit(t, actorUserId, "EmployeeReview", r.reviewId, ok ? "APPROVE" : "REJECT", `Reopening the review ${ok ? "approved: back with the manager" : outcome.toLowerCase()}`);
      if (!back) await notify({ tenantId: t, userIds: [r.requestedBy], kind: "PERFORMANCE", title: `Review reopening ${ok ? "approved" : "refused"}`, link: `/performance/reviews/${r.reviewId}` });
      return;
    }
    case "PIP_REQUEST": {
      const q = await prisma.insightPipRequest.findFirst({ where: { id, tenantId: t } });
      if (!q || q.status !== "PENDING") return;
      const pip = await prisma.improvementPlan.findFirst({ where: { id: q.pipId, tenantId: t }, include: { employee: { select: { userId: true, displayName: true } } } });
      if (!pip) throw new Error("The improvement plan no longer exists.");
      if (ok) {
        if (q.kind === "EXTENSION") {
          if (pip.status !== "ACTIVE") throw new Error("Only an active plan can be extended.");
          const endDate = new Date(pip.endDate.getTime() + (q.days ?? 0) * DAY);
          await prisma.improvementPlan.update({ where: { id: pip.id }, data: { endDate, status: "ACTIVE", outcomeNote: `Extended ${q.days} day(s): ${q.reason}` } });
          await notify({ tenantId: t, userIds: [pip.employee.userId], kind: "PERFORMANCE", title: `Your improvement plan is extended to ${endDate.toISOString().slice(0, 10)}`, link: "/performance/plans" });
        } else if (q.kind === "ESCALATION") {
          await prisma.insightPipEvidence.create({ data: { tenantId: t, pipId: pip.id, title: "Escalation approved", note: q.reason, kind: "OBSERVATION", addedBy: actorUserId } });
          await notify({ tenantId: t, userIds: await usersWithPermission(t, "performance.pip.manage"), kind: "PERFORMANCE", title: `Escalated improvement plan: ${pip.employee.displayName}`, body: q.reason, link: `/performance/plans/${pip.id}` });
        } else if (q.kind === "CHECKIN_SIGNOFF" && q.checkInId) {
          await prisma.pipCheckIn.updateMany({ where: { id: q.checkInId, pipId: pip.id }, data: { signoffStatus: "APPROVED" } });
        }
      } else if (q.kind === "CHECKIN_SIGNOFF" && q.checkInId) {
        await prisma.pipCheckIn.updateMany({ where: { id: q.checkInId, pipId: pip.id }, data: { signoffStatus: back ? null : "REJECTED" } });
      }
      await prisma.insightPipRequest.update({ where: { id }, data: { status: outcome, decidedAt: now } });
      await audit(t, actorUserId, "ImprovementPlan", pip.id, ok ? "APPROVE" : "REJECT", `${q.kind.toLowerCase().replace("_", " ")} request on ${pip.employee.displayName}'s plan ${outcome.toLowerCase()}`);
      if (!back) await notify({ tenantId: t, userIds: [q.requestedBy], kind: "PERFORMANCE", title: `Improvement plan ${q.kind.toLowerCase().replace("_", " ")} ${ok ? "approved" : "refused"}`, link: `/performance/plans/${pip.id}` });
      return;
    }
    default: return;
  }
}

// ---------------------------------------------------------------------------
//  Metric calculators
// ---------------------------------------------------------------------------

export interface MetricParams { departmentId?: string | null; months?: number | null }

export function metricParamsOf(json: unknown): MetricParams {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const months = Number(o.months);
  return { departmentId: typeof o.departmentId === "string" && o.departmentId ? o.departmentId : null, months: Number.isInteger(months) && months >= 1 && months <= 36 ? months : null };
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Latest applied CTC per employee on a date. */
export async function currentCtcs(tenantId: string, employeeIds: string[], asOf = new Date()): Promise<Map<string, number>> {
  const revs = await prisma.salaryRevision.findMany({
    where: { employeeId: { in: employeeIds }, employee: { tenantId }, status: "APPLIED", effectiveFrom: { lte: asOf } },
    select: { employeeId: true, annualCtc: true, effectiveFrom: true }, orderBy: { effectiveFrom: "asc" },
  });
  const out = new Map<string, number>();
  for (const r of revs) out.set(r.employeeId, Number(r.annualCtc));
  return out;
}

/** Compute one calculator for the tenant (optionally one department) as of a date. */
export async function computeInsightMetric(tenantId: string, calculator: string, params: MetricParams = {}, asOf = new Date()): Promise<number | null> {
  if (!(calculator in INSIGHT_CALCULATORS)) throw new Error(`Unknown calculator ${calculator}`);
  const months = params.months ?? 12;
  const w = trailingWindow(asOf, months);
  const empWhere: Prisma.EmployeeWhereInput = { tenantId, ...(params.departmentId ? { departmentId: params.departmentId } : {}) };
  const needsPop = ["HEADCOUNT", "NEW_HIRES", "FEMALE_SHARE", "ATTRITION_RATE", "VOLUNTARY_ATTRITION", "LEAVE_DAYS_PER_HEAD", "AVERAGE_CTC"].includes(calculator);
  const pop = needsPop ? await loadPopulation(empWhere) : [];
  const active = pop.filter((e) => onBooks(e, asOf));
  switch (calculator) {
    case "HEADCOUNT": return active.length;
    case "NEW_HIRES": return joinersIn(pop, w).length;
    case "FEMALE_SHARE": return active.length ? r2((active.filter((e) => e.gender === "FEMALE").length / active.length) * 100) : null;
    case "ATTRITION_RATE":
    case "VOLUNTARY_ATTRITION": {
      const avg = averageHeadcount(pop, w);
      if (!avg) return null;
      const leavers = leaversIn(pop, w).filter((e) => calculator === "ATTRITION_RATE" || e.exitType === "RESIGNATION" || e.exitReasonKind === "VOLUNTARY");
      return r2((leavers.length / avg) * (12 / months) * 100);
    }
    case "ABSENCE_RATE": {
      const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, date: { gte: w.from, lte: w.to }, status: { notIn: ["WEEKLY_OFF", "HOLIDAY"] }, ...(params.departmentId ? { employeeId: { in: (await prisma.employee.findMany({ where: empWhere, select: { id: true } })).map((e) => e.id) } } : {}) }, select: { status: true } });
      if (!recs.length) return null;
      return r2((recs.filter((r) => r.status === "ABSENT" || r.status === "NO_ATTENDANCE").length / recs.length) * 100);
    }
    case "LEAVE_DAYS_PER_HEAD": {
      if (!active.length) return null;
      const lr = await prisma.leaveRequest.findMany({ where: { tenantId, status: "APPROVED", fromDate: { gte: w.from, lte: w.to }, employeeId: { in: active.map((e) => e.id) } }, select: { totalDays: true } });
      return r2(sum(lr.map((l) => Number(l.totalDays))) / active.length);
    }
    case "AVERAGE_CTC": {
      const ctc = await currentCtcs(tenantId, active.map((e) => e.id), asOf);
      const v = [...ctc.values()];
      return v.length ? Math.round(sum(v) / v.length) : null;
    }
    case "PAYROLL_COST": {
      const run = await prisma.payrollRun.findFirst({ where: { tenantId, status: { in: ["FINALIZED", "LOCKED"] }, type: "REGULAR" }, orderBy: [{ year: "desc" }, { month: "desc" }] });
      if (!run) return null;
      const runs = await prisma.payrollRun.findMany({ where: { tenantId, year: run.year, month: run.month, status: { in: ["FINALIZED", "LOCKED"] } }, select: { totalEmployerCost: true } });
      return Math.round(sum(runs.map((x) => Number(x.totalEmployerCost))));
    }
    case "OVERTIME_COST": {
      const ids = params.departmentId ? (await prisma.employee.findMany({ where: empWhere, select: { id: true } })).map((e) => e.id) : null;
      const from = w.from.getUTCFullYear() * 12 + w.from.getUTCMonth(), to = w.to.getUTCFullYear() * 12 + w.to.getUTCMonth();
      const rows = await prisma.overtimeEntry.findMany({ where: { tenantId, payAction: { not: "VOID" }, ...(ids ? { employeeId: { in: ids } } : {}) }, select: { year: true, month: true, amount: true } });
      return Math.round(sum(rows.filter((r) => { const k = r.year * 12 + r.month - 1; return k >= from && k <= to; }).map((r) => Number(r.amount))));
    }
    case "HIGH_RISK_SHARE": {
      const latest = await prisma.attritionRiskScore.findFirst({ where: { tenantId }, orderBy: { asOf: "desc" }, select: { asOf: true } });
      if (!latest) return null;
      const rows = await prisma.attritionRiskScore.findMany({ where: { tenantId, asOf: latest.asOf, ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}) }, select: { band: true } });
      return rows.length ? r2((rows.filter((r) => r.band === "HIGH").length / rows.length) * 100) : null;
    }
    case "AVERAGE_RATING": {
      const rows = await prisma.employeeReview.findMany({ where: { cycle: { tenantId }, finalRating: { not: null }, OR: [{ sharedAt: { gte: w.from, lte: w.to } }, { cycle: { periodEnd: { gte: w.from, lte: w.to } } }], ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}) }, select: { finalRating: true } });
      return rows.length ? r2(sum(rows.map((r) => Number(r.finalRating))) / rows.length) : null;
    }
    case "GOALS_AT_RISK": {
      const goals = await prisma.goal.findMany({ where: { tenantId, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] }, ...(params.departmentId ? { OR: [{ departmentId: params.departmentId }, { employee: { departmentId: params.departmentId } }] } : {}) }, select: { status: true } });
      return goals.length ? r2((goals.filter((g) => g.status !== "ON_TRACK").length / goals.length) * 100) : null;
    }
    case "TIME_TO_FILL": {
      const days = await timeToFillDays(tenantId, params.departmentId ?? null, w.from);
      return medianOf(days);
    }
    case "COST_PER_HIRE": {
      const fromKey = w.from.toISOString().slice(0, 7), toKey = w.to.toISOString().slice(0, 7);
      const costs = await prisma.insightHiringCost.findMany({ where: { tenantId, month: { gte: fromKey, lte: toKey } }, select: { amount: true } });
      const hires = await prisma.employee.count({ where: { ...empWhere, dateOfJoining: { gte: w.from, lte: w.to }, status: { not: "PREBOARDING" } } });
      return hires ? Math.round(sum(costs.map((c) => Number(c.amount))) / hires) : null;
    }
    case "POSITIVE_FEEDBACK_SHARE": {
      const fb = await prisma.feedback.findMany({ where: { tenantId, kind: "FEEDBACK", deletedAt: null, createdAt: { gte: w.from, lte: w.to }, ...(params.departmentId ? { aboutEmployee: { departmentId: params.departmentId } } : {}) }, select: { sentiment: true, message: true } });
      if (!fb.length) return null;
      return r2((fb.filter((f) => (f.sentiment ?? classifySentiment(f.message).sentiment) === "POSITIVE").length / fb.length) * 100);
    }
    case "LEARNING_COMPLETION": {
      const en = await prisma.courseEnrolment.findMany({ where: { tenantId, assignedAt: { gte: w.from, lte: w.to }, ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}) }, select: { status: true } });
      return en.length ? r2((en.filter((e) => e.status === "COMPLETED").length / en.length) * 100) : null;
    }
    default: return null;
  }
}

/** Days from requisition approval to the first hire against it, for requisitions approved since `from`. */
export async function timeToFillDays(tenantId: string, departmentId: string | null, from: Date): Promise<number[]> {
  const reqs = await prisma.requisition.findMany({
    where: { tenantId, approvedAt: { not: null, gte: from }, ...(departmentId ? { departmentId } : {}) },
    select: { approvedAt: true, jobs: { select: { applications: { where: { status: "HIRED" }, select: { updatedAt: true } } } } },
  });
  const out: number[] = [];
  for (const r of reqs) {
    const hired = r.jobs.flatMap((j) => j.applications.map((a) => a.updatedAt)).sort((a, b) => a.getTime() - b.getTime())[0];
    if (hired && r.approvedAt) out.push(Math.max(0, Math.round((hired.getTime() - r.approvedAt.getTime()) / DAY)));
  }
  return out;
}

/** Compute a metric definition now, store the value, and alert its owner on a threshold breach. */
export async function computeAndStoreMetric(tenantId: string, metricId: string, now = new Date()): Promise<{ value: number | null; state: ThresholdState }> {
  const m = await prisma.insightMetric.findFirst({ where: { id: metricId, tenantId } });
  if (!m) throw new Error("Metric not found.");
  const value = await computeInsightMetric(tenantId, m.calculator, metricParamsOf(m.params), now);
  await prisma.insightMetric.update({ where: { id: m.id }, data: { lastValue: value, lastComputedAt: now } });
  const state = thresholdState(value, m.warnAt === null ? null : Number(m.warnAt), m.alertAt === null ? null : Number(m.alertAt), m.direction);
  if (state === "ALERT" && m.status === "APPROVED") {
    const recent = await prisma.insightAlert.findFirst({ where: { tenantId, kind: "METRIC_THRESHOLD", entityId: m.id, createdAt: { gte: new Date(now.getTime() - DAY) } } });
    if (!recent) {
      const to = m.ownerUserId ? [m.ownerUserId] : await usersWithPermission(tenantId, "admin.report.build");
      const title = `${m.name} is ${value} — past its alert level of ${Number(m.alertAt)}`;
      await prisma.insightAlert.create({ data: { tenantId, kind: "METRIC_THRESHOLD", entityType: "InsightMetric", entityId: m.id, userId: to[0] ?? null, title } });
      await notify({ tenantId, userIds: to, kind: "ANALYTICS", title, link: "/insights/metrics", email: true });
    }
  }
  return { value, state };
}

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

/** Record (or replace) a KPI reading, judge it against the target in force, and alert on red. */
export async function recordKpiReading(tenantId: string, kpiId: string, period: string, value: number, opts: { note?: string | null; byUserId?: string | null } = {}): Promise<{ ok: boolean; message: string; rag?: string }> {
  const kpi = await prisma.insightKpi.findFirst({ where: { id: kpiId, tenantId }, include: { targets: true } });
  if (!kpi) return { ok: false, message: "KPI not found." };
  const target = targetInForce(kpi.targets, period);
  const judged = target ? kpiRag(value, Number(target.target), kpi.direction, Number(kpi.greenAt), Number(kpi.amberAt)) : null;
  const reading = await prisma.insightKpiReading.upsert({
    where: { kpiId_period: { kpiId, period } },
    create: { tenantId, kpiId, period, value, note: opts.note ?? null, rag: judged?.rag ?? null, targetVersion: target?.version ?? null, recordedBy: opts.byUserId ?? null },
    update: { value, note: opts.note ?? null, rag: judged?.rag ?? null, targetVersion: target?.version ?? null, recordedBy: opts.byUserId ?? null, alertedAt: null },
  });
  if (judged?.rag === "RED") {
    const owner = kpi.ownerEmployeeId ? await prisma.employee.findFirst({ where: { id: kpi.ownerEmployeeId, tenantId }, select: { userId: true } }) : null;
    const to = [owner?.userId ?? null, kpi.createdBy].filter((u): u is string => !!u);
    const title = `KPI ${kpi.name} is red for ${period}: ${value} against a target of ${Number(target!.target)} (${judged.achievement}%)`;
    await prisma.insightAlert.create({ data: { tenantId, kind: "KPI_THRESHOLD", entityType: "InsightKpi", entityId: kpi.id, userId: to[0] ?? null, title } });
    await prisma.insightKpiReading.update({ where: { id: reading.id }, data: { alertedAt: new Date() } });
    await notify({ tenantId, userIds: to, kind: "ANALYTICS", title, link: "/insights/kpis", email: true });
  }
  return { ok: true, message: judged ? `Recorded — ${judged.rag.toLowerCase()} (${judged.achievement}% of target v${target!.version}).` : "Recorded; the KPI has no target yet.", rag: judged?.rag };
}

/** KPIs computed from a metric: take this period's reading from the approved metric. */
export async function computeKpiFromMetric(tenantId: string, kpiId: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const kpi = await prisma.insightKpi.findFirst({ where: { id: kpiId, tenantId } });
  if (!kpi || kpi.calcKind !== "METRIC" || !kpi.metricKey) return { ok: false, message: "This KPI is not computed from a metric." };
  const m = await prisma.insightMetric.findFirst({ where: { tenantId, key: kpi.metricKey, status: "APPROVED" } });
  if (!m) return { ok: false, message: "The metric behind this KPI is not approved." };
  const v = await computeInsightMetric(tenantId, m.calculator, metricParamsOf(m.params), now);
  if (v === null) return { ok: false, message: "The metric has no value yet." };
  return recordKpiReading(tenantId, kpi.id, kpiPeriodOf(now, kpi.frequency), v, { note: `Computed from ${m.name}` });
}

// ---------------------------------------------------------------------------
//  Dashboards
// ---------------------------------------------------------------------------

/** Recompute every widget of a dashboard and record how the refresh went. */
export async function refreshInsightDashboard(tenantId: string, dashboardId: string, now = new Date()): Promise<{ status: string; ms: number }> {
  const d = await prisma.insightDashboard.findFirst({ where: { id: dashboardId, tenantId }, include: { widgets: true } });
  if (!d) throw new Error("Dashboard not found.");
  const started = Date.now();
  const results: Array<{ error: string | null }> = [];
  for (const w of d.widgets) {
    let value: number | null = null, series: Array<{ label: string; value: number | null }> | null = null, error: string | null = null;
    try {
      if (w.source === "METRIC") {
        const m = await prisma.insightMetric.findFirst({ where: { tenantId, key: w.refKey, status: "APPROVED" } });
        if (!m) throw new Error("No approved metric with this key.");
        const params = metricParamsOf(m.params);
        value = await computeInsightMetric(tenantId, m.calculator, params, now);
        if (w.viz !== "NUMBER") {
          series = [];
          for (let i = 5; i >= 0; i--) {
            const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
            series.push({ label: at.toISOString().slice(0, 7), value: i === 0 ? value : await computeInsightMetric(tenantId, m.calculator, params, at) });
          }
        }
      } else if (w.source === "KPI") {
        const kpi = await prisma.insightKpi.findFirst({ where: { id: w.refKey, tenantId }, include: { readings: { orderBy: { period: "asc" } } } });
        if (!kpi) throw new Error("The KPI was deleted.");
        const last = kpi.readings[kpi.readings.length - 1];
        value = last ? Number(last.value) : null;
        series = kpi.readings.slice(-6).map((r) => ({ label: r.period, value: Number(r.value) }));
      } else throw new Error(`Unknown widget source ${w.source}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await prisma.insightDashboardWidget.update({ where: { id: w.id }, data: { value, series: series ?? undefined, computedAt: now, error } });
    results.push({ error });
  }
  const ms = Date.now() - started;
  const status = refreshOutcome(results);
  await prisma.insightDashboard.update({ where: { id: d.id }, data: { refreshedAt: now, refreshStatus: status, refreshMs: ms, refreshError: results.find((r) => r.error)?.error ?? null } });
  return { status, ms };
}

// ---------------------------------------------------------------------------
//  OKR close-out and snapshots
// ---------------------------------------------------------------------------

export async function snapshotGoals(tenantId: string, label: string, where: Prisma.GoalWhereInput, closeoutId: string | null = null): Promise<number> {
  const goals = await prisma.goal.findMany({ where: { ...where, tenantId }, include: { employee: { select: { displayName: true } } } });
  if (!goals.length) return 0;
  await prisma.insightGoalSnapshot.createMany({
    data: goals.map((g) => ({
      tenantId, closeoutId, label, goalId: g.id, title: g.title, level: g.level, ownerName: g.employee?.displayName ?? null,
      progress: g.progressPercent, status: g.status, targetValue: g.targetValue, currentValue: g.currentValue,
    })),
  });
  return goals.length;
}

/** Score every goal of the timeframe final, snapshot it, and close the period. */
export async function closeOutTimeframe(tenantId: string, closeoutId: string, actorUserId: string | null): Promise<void> {
  const c = await prisma.insightOkrCloseout.findFirst({ where: { id: closeoutId, tenantId } });
  if (!c) throw new Error("Close-out not found.");
  const goals = await prisma.goal.findMany({ where: { tenantId, timeframe: c.timeframe, closedOutAt: null } });
  const now = new Date();
  for (const g of goals) {
    const final = closeoutStatus(g.status, Number(g.progressPercent));
    await prisma.goal.update({ where: { id: g.id }, data: { status: final, statusOverride: final === "COMPLETED" || final === "MISSED" ? final : g.statusOverride, closedOutAt: now } });
  }
  await snapshotGoals(tenantId, `Close-out ${c.timeframe}`, { timeframe: c.timeframe }, c.id);
  const summary = closeoutSummary(goals.map((g) => ({ status: g.status, progress: Number(g.progressPercent) })));
  await prisma.insightOkrCloseout.update({ where: { id: c.id }, data: { status: "APPROVED", closedAt: now, summary } });
  const owners = await prisma.employee.findMany({ where: { tenantId, id: { in: goals.map((g) => g.employeeId).filter((x): x is string => !!x) } }, select: { userId: true } });
  await notify({ tenantId, userIds: owners.map((o) => o.userId), kind: "PERFORMANCE", title: `${c.timeframe} goals are closed out`, link: "/performance/okr?tab=snapshots" });
  void actorUserId;
}

// ---------------------------------------------------------------------------
//  Feedback: classification and escalation
// ---------------------------------------------------------------------------

/** Classify a new (or edited) feedback and raise any escalations its rules call for. */
export async function processFeedback(tenantId: string, feedbackId: string): Promise<{ sentiment: string; escalations: number }> {
  const f = await prisma.feedback.findFirst({ where: { id: feedbackId, tenantId }, include: { aboutEmployee: { select: { displayName: true, reportingManager: { select: { userId: true, reportingManager: { select: { userId: true } } } } } } } });
  if (!f) throw new Error("Feedback not found.");
  const s = classifySentiment(f.message);
  await prisma.feedback.update({ where: { id: f.id }, data: { sentiment: s.sentiment, sentimentScore: s.score } });
  if (f.kind !== "FEEDBACK") return { sentiment: s.sentiment, escalations: 0 };
  const rules = await prisma.insightFeedbackRule.findMany({ where: { tenantId, isActive: true } });
  let n = 0;
  for (const rule of rules) {
    if (!escalationRuleMatches(rule, { message: f.message, sentiment: s.sentiment, topicId: f.topicId })) continue;
    if (await prisma.insightFeedbackEscalation.findUnique({ where: { ruleId_feedbackId: { ruleId: rule.id, feedbackId: f.id } } })) continue;
    const to = rule.notify === "MANAGER" ? [f.aboutEmployee.reportingManager?.userId ?? null]
      : rule.notify === "SKIP_MANAGER" ? [f.aboutEmployee.reportingManager?.reportingManager?.userId ?? null]
      : await usersWithPermission(tenantId, "performance.review.manage");
    const ids = to.filter((u): u is string => !!u);
    await prisma.insightFeedbackEscalation.create({ data: { tenantId, ruleId: rule.id, feedbackId: f.id, notifiedUserIds: ids } });
    await notify({ tenantId, userIds: ids, kind: "PERFORMANCE", title: `Feedback about ${f.aboutEmployee.displayName} matched “${rule.name}”`, link: "/performance/feedback-hub?tab=escalations" });
    n++;
  }
  return { sentiment: s.sentiment, escalations: n };
}

// ---------------------------------------------------------------------------
//  Performance exception queue
// ---------------------------------------------------------------------------

/** Rebuild the open exceptions of a cycle; resolved or dismissed ones stay as they are. */
export async function refreshPerfExceptions(tenantId: string, cycleId: string, now = new Date()): Promise<number> {
  const cycle = await prisma.reviewCycle.findFirst({ where: { id: cycleId, tenantId }, include: { bands: true, stageDates: true, reviews: { include: { responses: true } } } });
  if (!cycle) throw new Error("Cycle not found.");
  const closesAt = cycle.stageDates?.managerEndsAt ?? cycle.reviewClosesAt;
  const goalCounts = await prisma.goal.groupBy({ by: ["employeeId"], where: { tenantId, countsInReview: true, employeeId: { in: cycle.reviews.map((r) => r.employeeId) }, dueDate: { gte: cycle.periodStart }, startDate: { lte: cycle.periodEnd }, status: { not: "CANCELLED" } }, _count: true });
  const goalsOf = new Map(goalCounts.map((g) => [g.employeeId, g._count]));
  let raised = 0;
  const wanted = new Set<string>();
  for (const r of cycle.reviews) {
    const self = r.responses.find((x) => x.reviewerType === "SELF" && x.submittedAt);
    const mgr = r.responses.find((x) => x.reviewerType === "MANAGER" && x.submittedAt);
    const final = r.finalRating === null ? null : Number(r.finalRating);
    const inBand = final === null || !cycle.bands.length ? null : cycle.bands.some((b) => final >= Number(b.minRating) && final <= Number(b.maxRating));
    const kinds = reviewExceptionKinds({
      status: r.status, closesAt, selfRating: self?.overallRating === null || !self ? null : Number(self.overallRating), managerRating: mgr?.overallRating === null || !mgr ? null : Number(mgr.overallRating),
      rawRating: r.rawRating === null ? null : Number(r.rawRating), finalRating: final, calibrationReason: r.calibrationReason,
      goalCount: goalsOf.get(r.employeeId) ?? 0, inBand, hasManagerSlot: r.responses.some((x) => x.reviewerType === "MANAGER" && x.status !== "DECLINED"),
    }, now);
    for (const k of kinds) {
      wanted.add(`${r.id}:${k.kind}`);
      const existing = await prisma.insightPerfException.findUnique({ where: { reviewId_kind: { reviewId: r.id, kind: k.kind } } });
      if (existing) { if (existing.status === "OPEN") await prisma.insightPerfException.update({ where: { id: existing.id }, data: { detail: k.detail } }); continue; }
      await prisma.insightPerfException.create({ data: { tenantId, cycleId, reviewId: r.id, employeeId: r.employeeId, kind: k.kind, detail: k.detail } });
      raised++;
    }
  }
  // Open exceptions whose condition no longer holds resolve themselves.
  const open = await prisma.insightPerfException.findMany({ where: { tenantId, cycleId, status: "OPEN" } });
  for (const e of open) if (!wanted.has(`${e.reviewId}:${e.kind}`)) await prisma.insightPerfException.update({ where: { id: e.id }, data: { status: "RESOLVED", note: "Condition cleared", resolvedAt: now } });
  return raised;
}

// ---------------------------------------------------------------------------
//  Jobs: reminders, alerts and digests
// ---------------------------------------------------------------------------

async function alertOnce(tenantId: string, kind: string, entityType: string, entityId: string, userId: string | null, title: string, sinceMs: number, now: Date): Promise<boolean> {
  const recent = await prisma.insightAlert.findFirst({ where: { tenantId, kind, entityId, ...(userId ? { userId } : {}), createdAt: { gte: new Date(now.getTime() - sinceMs) } } });
  if (recent) return false;
  await prisma.insightAlert.create({ data: { tenantId, kind, entityType, entityId, userId, title } });
  return true;
}

/** Remind reviewers whose review is still due as the window closes. */
export async function sendReviewReminders(tenantId: string, now = new Date()): Promise<number> {
  const slots = await prisma.reviewResponse.findMany({
    where: { review: { cycle: { tenantId, status: { in: ["LAUNCHED", "IN_PROGRESS"] } }, status: { in: ["NOT_STARTED", "SELF_PENDING", "MANAGER_PENDING", "PENDING_CALIBRATION"] } }, submittedAt: null, status: "ACTIVE" },
    include: { reviewer: { select: { userId: true } }, review: { include: { employee: { select: { displayName: true } }, cycle: { include: { stageDates: true } } } } },
  });
  let n = 0;
  for (const s of slots) {
    const closes = s.reviewerType === "SELF" ? s.review.cycle.stageDates?.selfEndsAt ?? s.review.cycle.reviewClosesAt : s.review.cycle.stageDates?.managerEndsAt ?? s.review.cycle.reviewClosesAt;
    if (!reviewReminderDue(s, closes, now)) continue;
    const peer = ["PEER", "SUBORDINATE", "SKIP_LEVEL"].includes(s.reviewerType);
    const title = peer ? `Reminder: 360 feedback for ${s.review.employee.displayName} is waiting` : s.reviewerType === "SELF" ? "Reminder: your self review is due" : `Reminder: ${s.review.employee.displayName}'s review is due`;
    await prisma.reviewResponse.update({ where: { id: s.id }, data: { remindedAt: now } });
    await prisma.insightAlert.create({ data: { tenantId, kind: peer ? "THREE_SIXTY" : "REVIEW_DUE", entityType: "ReviewResponse", entityId: s.id, userId: s.reviewer.userId, title } });
    await notify({ tenantId, userIds: [s.reviewer.userId], kind: "PERFORMANCE", title, link: `/performance/reviews/${s.reviewId}`, email: true });
    n++;
  }
  // Feedback requests close to (or past) their due date.
  const reqs = await prisma.feedbackRequest.findMany({ where: { tenantId, status: "PENDING", dueDate: { not: null, lte: new Date(now.getTime() + 3 * DAY) } }, include: { asked: { select: { userId: true } }, requester: { select: { displayName: true } } } });
  for (const r of reqs) {
    if (r.remindedAt && now.getTime() - r.remindedAt.getTime() < 3 * DAY) continue;
    const title = `Reminder: ${r.requester.displayName} asked for your feedback`;
    await prisma.feedbackRequest.update({ where: { id: r.id }, data: { remindedAt: now } });
    await prisma.insightAlert.create({ data: { tenantId, kind: "FEEDBACK_REQUEST", entityType: "FeedbackRequest", entityId: r.id, userId: r.asked.userId, title } });
    await notify({ tenantId, userIds: [r.asked.userId], kind: "FEEDBACK", title, link: "/me/performance", email: true });
    n++;
  }
  return n;
}

/** Owners of goals whose check-in is overdue for their cadence. */
export async function sendCheckInAlerts(tenantId: string, now = new Date()): Promise<number> {
  const setting = await prisma.insightOkrSetting.findUnique({ where: { tenantId } });
  const goals = await prisma.goal.findMany({
    where: { tenantId, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] }, employeeId: { not: null }, startDate: { lte: now }, closedOutAt: null },
    include: { employee: { select: { userId: true } }, checkIns: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  let n = 0;
  for (const g of goals) {
    const o = checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, g.checkInCadence ?? setting?.defaultCadence ?? "MONTHLY", setting?.graceDays ?? 3, now);
    if (!o.overdue) continue;
    const title = `Check-in overdue on “${g.title}” (${o.daysLate} day(s) late)`;
    if (!(await alertOnce(tenantId, "CHECKIN_OVERDUE", "Goal", g.id, g.employee?.userId ?? null, title, 7 * DAY, now))) continue;
    await notify({ tenantId, userIds: [g.employee?.userId], kind: "PERFORMANCE", title, link: "/performance/okr?tab=checkins" });
    n++;
  }
  return n;
}

/** Coaches with no session logged for the configured number of days. */
export async function sendCoachingReminders(tenantId: string, now = new Date()): Promise<number> {
  const setting = await prisma.insightPipSetting.findUnique({ where: { tenantId } });
  const days = setting?.coachingReminderDays ?? 14;
  const plans = await prisma.coachingPlan.findMany({ where: { tenantId, status: "ACTIVE", startDate: { lte: now } }, include: { coach: { select: { userId: true } }, employee: { select: { displayName: true } }, sessions: { orderBy: { heldOn: "desc" }, take: 1 } } });
  let n = 0;
  for (const p of plans) {
    if (!coachingFollowUpDue(p.sessions[0]?.heldOn ?? null, p.startDate, days, now)) continue;
    const title = `Coaching follow-up: no session with ${p.employee.displayName} on “${p.focusArea}” for ${days}+ days`;
    if (!(await alertOnce(tenantId, "COACHING_FOLLOWUP", "CoachingPlan", p.id, p.coach.userId, title, days * DAY, now))) continue;
    await notify({ tenantId, userIds: [p.coach.userId], kind: "PERFORMANCE", title, link: "/performance/development" });
    n++;
  }
  return n;
}

/** A weekly digest for each manager: feedback their team received and gave. */
export async function sendFeedbackDigests(tenantId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * DAY);
  const fb = await prisma.feedback.findMany({ where: { tenantId, kind: "FEEDBACK", deletedAt: null, createdAt: { gte: since } }, include: { aboutEmployee: { select: { reportingManagerId: true } } } });
  const byMgr = new Map<string, typeof fb>();
  for (const f of fb) if (f.aboutEmployee.reportingManagerId) byMgr.set(f.aboutEmployee.reportingManagerId, [...(byMgr.get(f.aboutEmployee.reportingManagerId) ?? []), f]);
  let n = 0;
  for (const [mgrId, items] of byMgr) {
    const mgr = await prisma.employee.findFirst({ where: { id: mgrId, tenantId }, select: { userId: true } });
    if (!mgr?.userId) continue;
    const week = `${since.toISOString().slice(0, 10)}`;
    const pos = items.filter((i) => i.sentiment === "POSITIVE").length, neg = items.filter((i) => i.sentiment === "NEGATIVE").length;
    const title = `Your team received ${items.length} feedback this week (${pos} positive, ${neg} negative)`;
    if (!(await alertOnce(tenantId, "FEEDBACK_DIGEST", "Employee", mgrId, mgr.userId, title, 6 * DAY, now))) continue;
    await notify({ tenantId, userIds: [mgr.userId], kind: "FEEDBACK", title, body: `Week from ${week}.`, link: "/performance/feedback-hub?tab=digest", email: true });
    n++;
  }
  return n;
}

/** Expire report grants, export approvals and dashboard shares past their date. */
export async function expireInsightAccess(tenantId: string, now = new Date()): Promise<{ grants: number; exports: number; shares: number }> {
  const grants = await prisma.insightReportGrant.updateMany({ where: { tenantId, status: "APPROVED", expiresAt: { lte: now } }, data: { status: "REVOKED" } });
  const exports = await prisma.insightExportRequest.updateMany({ where: { tenantId, status: "APPROVED", expiresAt: { lte: now } }, data: { status: "WITHDRAWN" } });
  const shares = await prisma.insightDashboardShare.deleteMany({ where: { dashboard: { tenantId }, expiresAt: { lte: now } } });
  return { grants: grants.count, exports: exports.count, shares: shares.count };
}

/** Everything insight runs on a schedule. */
export async function runInsightJobs(tenantId: string, now = new Date()) {
  const metrics = await prisma.insightMetric.findMany({ where: { tenantId, status: "APPROVED" }, select: { id: true } });
  let alerts = 0;
  for (const m of metrics) if ((await computeAndStoreMetric(tenantId, m.id, now)).state === "ALERT") alerts++;
  const kpis = await prisma.insightKpi.findMany({ where: { tenantId, isActive: true, calcKind: "METRIC" }, select: { id: true } });
  for (const k of kpis) await computeKpiFromMetric(tenantId, k.id, now);
  const cycles = await prisma.reviewCycle.findMany({ where: { tenantId, status: { in: ["LAUNCHED", "IN_PROGRESS", "CALIBRATION"] } }, select: { id: true } });
  let exceptions = 0;
  for (const c of cycles) exceptions += await refreshPerfExceptions(tenantId, c.id, now);
  const dashboards = await prisma.insightDashboard.findMany({ where: { tenantId }, select: { id: true } });
  for (const d of dashboards) await refreshInsightDashboard(tenantId, d.id, now);
  return {
    metrics: metrics.length, metricAlerts: alerts, kpis: kpis.length, exceptions, dashboards: dashboards.length,
    reviewReminders: await sendReviewReminders(tenantId, now),
    checkInAlerts: await sendCheckInAlerts(tenantId, now),
    coachingReminders: await sendCoachingReminders(tenantId, now),
    digests: now.getUTCDay() === 1 ? await sendFeedbackDigests(tenantId, now) : 0,
    expired: await expireInsightAccess(tenantId, now),
  };
}
