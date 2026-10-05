import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { feedbackTrend, checkInOverdue } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { runDataset } from "@/lib/insight/datasets";
import { PageHead, Card, Stat } from "@/components/ui";
import { Bars } from "@/components/keka";
import { InsightTableView } from "@/components/insight-table";

export const metadata = { title: "Team insights" };
const DAY = 86_400_000;

/**
 * My Team › Insights: the manager's HR dashboard over everyone in their
 * reporting line — headcount, ratings, goals at risk and overdue check-ins,
 * leave, feedback received, and performance risk indicators.
 */
export default async function TeamInsightsPage() {
  const viewer = await requireViewer();
  const ids = [...viewer.allReportIds];
  if (!ids.length) forbidden();
  const t = viewer.tenantId;
  const since90 = new Date(Date.now() - 90 * DAY);
  const [team, goals, leave, reviews, fb, risk, setting] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: t, id: { in: ids }, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, reportingManagerId: true, status: true } }),
    prisma.goal.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] } }, select: { status: true, startDate: true, checkInCadence: true, checkIns: { orderBy: { recordedAt: "desc" }, take: 1, select: { recordedAt: true } } } }),
    prisma.leaveRequest.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: "APPROVED", fromDate: { gte: since90 } }, select: { totalDays: true } }),
    prisma.employeeReview.findMany({ where: { employeeId: { in: ids }, finalRating: { not: null }, cycle: { tenantId: t } }, orderBy: { cycle: { periodEnd: "desc" } }, select: { employeeId: true, finalRating: true } }),
    prisma.feedback.findMany({ where: { tenantId: t, aboutEmployeeId: { in: ids }, kind: "FEEDBACK", deletedAt: null, createdAt: { gte: new Date(Date.now() - 365 * DAY) } }, select: { createdAt: true, sentiment: true } }),
    runDataset(viewer, "perf-risk"),
    prisma.insightOkrSetting.findUnique({ where: { tenantId: t } }),
  ]);
  const latest = new Map<string, number>();
  for (const r of reviews) if (!latest.has(r.employeeId)) latest.set(r.employeeId, Number(r.finalRating));
  const avg = latest.size ? Math.round(([...latest.values()].reduce((s, x) => s + x, 0) / latest.size) * 100) / 100 : null;
  const overdue = goals.filter((g) => checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, g.checkInCadence ?? setting?.defaultCadence ?? "MONTHLY", setting?.graceDays ?? 3).overdue).length;
  const trend = feedbackTrend(fb);
  return (
    <>
      <PageHead title="Team insights" subtitle="Your reporting line at a glance" actions={<Link className="btn" href="/performance/okr?tab=risk">At-risk goals</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="People" value={team.length} meta={`${team.filter((e) => e.reportingManagerId === viewer.employee?.id).length} direct`} />
        <Stat label="Average latest rating" value={avg ?? "—"} meta={`${latest.size} rated`} />
        <Stat label="Live goals at risk" value={goals.filter((g) => g.status !== "ON_TRACK").length} meta={`of ${goals.length}; ${overdue} check-ins overdue`} tone={goals.some((g) => g.status === "AT_RISK") ? "neg" : undefined} />
        <Stat label="Leave days (90 days)" value={Math.round(leave.reduce((s, l) => s + Number(l.totalDays), 0) * 10) / 10} meta={team.length ? `${Math.round((leave.reduce((s, l) => s + Number(l.totalDays), 0) / team.length) * 10) / 10} per person` : undefined} />
      </div>
      <Card title="Feedback your team received" description="Monthly count and positive share over the last year.">
        {trend.length ? <Bars data={trend.map((m) => ({ label: m.month.slice(2), value: m.total, title: `${m.positive} positive, ${m.negative} negative` }))} /> : <div className="muted text-sm">No feedback yet.</div>}
      </Card>
      <Card title="Performance risk indicators">
        <InsightTableView table={risk} ds="perf-risk" />
      </Card>
    </>
  );
}
