import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { thresholdState } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { runDataset } from "@/lib/insight/datasets";
import { PageHead, Card, Stat, Badge } from "@/components/ui";
import { InsightTableView, fmtCell } from "@/components/insight-table";
import { InsightsNav } from "./_nav";

export const metadata = { title: "Insights" };

/**
 * Org › Insights: the executive and department HR scorecards, the approved
 * metrics with their threshold state, and recent alerts.
 */
export default async function InsightsPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.ANALYTICS_VIEW, P.REPORT_VIEW])) forbidden();
  const t = viewer.tenantId;
  const [metrics, alerts, card] = await Promise.all([
    prisma.insightMetric.findMany({ where: { tenantId: t, status: "APPROVED" }, orderBy: { name: "asc" } }),
    prisma.insightAlert.findMany({ where: { tenantId: t, OR: [{ userId: viewer.user.id }, ...(can(viewer, P.REPORT_BUILD) ? [{ kind: { in: ["METRIC_THRESHOLD", "KPI_THRESHOLD"] } }] : [])] }, orderBy: { createdAt: "desc" }, take: 10 }),
    can(viewer, P.ANALYTICS_VIEW) ? runDataset(viewer, "scorecard") : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHead title="Insights" subtitle="Scorecards, governed metrics, KPIs, report operations and people analytics" actions={<Link className="btn" href="/storyboards">Dashboards</Link>} />
      <InsightsNav />
      {metrics.length ? (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          {metrics.slice(0, 8).map((m) => {
            const v = m.lastValue === null ? null : Number(m.lastValue);
            const st = thresholdState(v, m.warnAt === null ? null : Number(m.warnAt), m.alertAt === null ? null : Number(m.alertAt), m.direction);
            return <Stat key={m.id} label={m.name} meta={st !== "OK" ? <Badge tone={st === "ALERT" ? "danger" : "warning"}>{st.toLowerCase()}</Badge> : `v${m.version}`} value={fmtCell(v, m.unit === "PERCENT" ? "pct" : m.unit === "INR" ? "inr" : "num")} />;
          })}
        </div>
      ) : null}
      <Card title="Executive and department HR scorecard" description="Company-wide first, then each department, from the same metric calculators.">
        {card ? <InsightTableView table={card} ds="scorecard" /> : <div className="muted text-sm">Scorecards need the workforce dashboards permission.</div>}
      </Card>
      <Card title="Recent alerts" description="Metric and KPI thresholds, check-ins, reminders.">
        {alerts.length ? (
          <ul className="stack gap-1 text-sm">{alerts.map((a) => <li key={a.id}><span className="muted">{a.createdAt.toISOString().slice(0, 10)}</span> · <Badge tone="warning">{a.kind.replace(/_/g, " ").toLowerCase()}</Badge> {a.title}</li>)}</ul>
        ) : <div className="muted text-sm">No alerts.</div>}
      </Card>
    </>
  );
}
