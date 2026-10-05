import Link from "next/link";
import { prisma } from "@keka/db";
import { feedbackTrend, confidenceLabel, stretchProgress } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { performanceTimeline, feedbackTimeline } from "@/lib/insight/timeline";
import { PageHead, Card, Stat, Empty } from "@/components/ui";
import { Bars } from "@/components/keka";
import { Timeline } from "@/components/timeline";

export const metadata = { title: "My insights" };
const DAY = 86_400_000;

/**
 * Me › My Insights: personal analytics — goals and confidence, ratings over
 * time, the feedback received and its trend, leave and learning, and the
 * historical performance and feedback timelines.
 */
export default async function MyInsightsPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <Empty title="No employee record is linked to this login." />;
  const me = viewer.employee.id, t = viewer.tenantId;
  const yearAgo = new Date(Date.now() - 365 * DAY);
  const [goals, reviews, fb, leave, learning, perf, fbt] = await Promise.all([
    prisma.goal.findMany({ where: { tenantId: t, employeeId: me, status: { not: "CANCELLED" } }, orderBy: { dueDate: "asc" } }),
    prisma.employeeReview.findMany({ where: { employeeId: me, finalRating: { not: null }, sharedAt: { not: null }, cycle: { tenantId: t } }, include: { cycle: { select: { name: true, periodEnd: true } } }, orderBy: { cycle: { periodEnd: "asc" } } }),
    prisma.feedback.findMany({ where: { tenantId: t, aboutEmployeeId: me, kind: "FEEDBACK", deletedAt: null, createdAt: { gte: yearAgo } }, select: { createdAt: true, sentiment: true } }),
    prisma.leaveRequest.findMany({ where: { tenantId: t, employeeId: me, status: "APPROVED", fromDate: { gte: yearAgo } }, select: { totalDays: true } }),
    prisma.courseEnrolment.findMany({ where: { tenantId: t, employeeId: me }, select: { status: true } }),
    performanceTimeline(t, me),
    feedbackTimeline(t, me),
  ]);
  const live = goals.filter((g) => ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"].includes(g.status));
  const trend = feedbackTrend(fb);
  return (
    <>
      <PageHead title="My insights" subtitle="Your own numbers: goals, ratings, feedback, leave and learning" actions={<span className="row gap-2"><Link className="btn" href="/performance/okr">My OKRs</Link><Link className="btn" href="/performance/feedback-hub">Feedback</Link></span>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Live goals" value={live.length} meta={`${live.filter((g) => g.status !== "ON_TRACK").length} need attention`} />
        <Stat label="Latest rating" value={reviews.length ? Number(reviews[reviews.length - 1]!.finalRating) : "—"} meta={reviews.length ? reviews[reviews.length - 1]!.cycle.name : undefined} />
        <Stat label="Feedback this year" value={fb.length} meta={fb.length ? `${Math.round((fb.filter((f) => f.sentiment === "POSITIVE").length / fb.length) * 100)}% positive` : undefined} />
        <Stat label="Leave taken (12 months)" value={Math.round(leave.reduce((s, l) => s + Number(l.totalDays), 0) * 10) / 10} meta={`${learning.filter((l) => l.status === "COMPLETED").length} course(s) completed`} />
      </div>
      <div className="grid grid-2">
        <Card title="My goals">
          {live.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Goal</th><th className="num">Progress</th><th className="num">Stretch</th><th>Confidence</th><th>Status</th></tr></thead>
              <tbody>{live.map((g) => { const s = stretchProgress(Number(g.startValue), Number(g.targetValue), g.stretchValue === null ? null : Number(g.stretchValue), Number(g.currentValue)); return <tr key={g.id}><td>{g.title}</td><td className="num">{Number(g.progressPercent)}%</td><td className="num">{s.stretch === null ? "—" : `${s.stretch}%`}</td><td>{g.confidence === null ? "—" : `${g.confidence}/10 ${confidenceLabel(g.confidence)?.toLowerCase()}`}</td><td>{g.status.toLowerCase().replace("_", " ")}</td></tr>; })}</tbody>
            </table></div>
          ) : <div className="muted text-sm">No live goals.</div>}
        </Card>
        <Card title="Ratings over time">
          {reviews.length ? <Bars data={reviews.map((r) => ({ label: r.cycle.name.slice(0, 10), value: Number(r.finalRating) }))} /> : <div className="muted text-sm">No shared reviews yet.</div>}
          {trend.length ? <><div className="text-sm" style={{ marginTop: 12 }}><strong>Feedback received by month</strong></div><Bars data={trend.map((m) => ({ label: m.month.slice(2), value: m.total }))} height={50} /></> : null}
        </Card>
        <Card title="Performance history"><Timeline events={perf} /></Card>
        <Card title="Feedback history"><Timeline events={fbt.slice(0, 50)} /></Card>
      </div>
    </>
  );
}
