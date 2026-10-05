import Link from "next/link";
import type { ReactNode } from "react";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { shareLive } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm } from "@/components/gov-forms";
import { Table, Pill } from "@/components/gov-ui";
import { createDashboardAction } from "@/app/actions/insight-analytics";

export const metadata = { title: "Storyboards" };

/**
 * Home › Storyboard: the dashboard builder. People build dashboards from
 * approved metrics and KPIs, share them (with an expiry), annotate them, and
 * publish them company-wide through approval.
 */
export default async function StoryboardsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const now = new Date();
  const shares = await prisma.insightDashboardShare.findMany({ where: { userId: viewer.user.id, dashboard: { tenantId: viewer.tenantId } }, include: { dashboard: { include: { widgets: { select: { id: true } } } } } });
  const liveShares = shares.filter((s) => shareLive(s, now));
  const [mine, published] = await Promise.all([
    prisma.insightDashboard.findMany({ where: { tenantId: viewer.tenantId, ownerUserId: viewer.user.id, ...(sp.kind === "KPI" ? { kind: "KPI" } : {}) }, include: { widgets: { select: { id: true } }, shares: true }, orderBy: { updatedAt: "desc" } }),
    prisma.insightDashboard.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED", visibility: "ORG", NOT: { ownerUserId: viewer.user.id } }, include: { widgets: { select: { id: true } } }, orderBy: { name: "asc" } }),
  ]);
  if (!canAny(viewer, [P.ANALYTICS_VIEW, P.REPORT_VIEW]) && !liveShares.length && !published.length) forbidden();
  const owners = await userNames(viewer.tenantId, [...liveShares.map((s) => s.dashboard.ownerUserId), ...published.map((d) => d.ownerUserId)]);
  const row = (d: { id: string; name: string; kind: string; status: string; refreshedAt: Date | null; refreshStatus: string | null; widgets: unknown[] }, extra?: ReactNode) => (
    <tr key={d.id}>
      <td><Link href={`/storyboards/${d.id}`}><strong>{d.name}</strong></Link>{d.kind === "KPI" ? <> <Badge tone="info">KPI</Badge></> : null}</td>
      <td className="num">{d.widgets.length}</td><td><Pill s={d.status} /></td>
      <td className="text-sm">{d.refreshedAt ? <>{fmtWhen(d.refreshedAt)} {d.refreshStatus && d.refreshStatus !== "OK" ? <Pill s={d.refreshStatus} /> : null}</> : "never"}</td>
      <td className="text-sm">{extra}</td>
    </tr>
  );
  return (
    <>
      <PageHead title="Storyboards" subtitle="Dashboards built from governed metrics and KPIs" actions={canAny(viewer, [P.ANALYTICS_VIEW, P.REPORT_VIEW]) ? <Link className="btn" href="/insights">Insights</Link> : null} />
      <Card title={sp.kind === "KPI" ? "My KPI dashboards" : "My dashboards"}>
        <Table head={["Dashboard", "Widgets", "Status", "Refreshed", "Shared with"]} empty={!mine.length}>
          {mine.map((d) => row(d, `${d.shares.filter((s) => shareLive(s, now)).length} people`))}
        </Table>
      </Card>
      {liveShares.length ? (
        <Card title="Shared with me">
          <Table head={["Dashboard", "Widgets", "Status", "Refreshed", "Owner · access"]}>
            {liveShares.map((s) => row(s.dashboard, `${owners.get(s.dashboard.ownerUserId) ?? ""} · ${s.canEdit ? "can edit" : "view"}${s.expiresAt ? ` until ${fmtDate(s.expiresAt)}` : ""}`))}
          </Table>
        </Card>
      ) : null}
      {published.length ? (
        <Card title="Published to the company">
          <Table head={["Dashboard", "Widgets", "Status", "Refreshed", "Owner"]}>{published.map((d) => row(d, owners.get(d.ownerUserId) ?? ""))}</Table>
        </Card>
      ) : null}
      {canAny(viewer, [P.ANALYTICS_VIEW, P.REPORT_VIEW]) ? (
        <Card title="New dashboard" description="A KPI dashboard starts with every active KPI; a custom one starts empty.">
          <SpecForm action={createDashboardAction} columns={3} submitLabel="Create" fields={[
            { name: "name", label: "Name", required: true },
            { name: "kind", label: "Kind", type: "select", options: [{ value: "CUSTOM", label: "Custom" }, { value: "KPI", label: "KPI dashboard" }], defaultValue: sp.kind === "KPI" ? "KPI" : "CUSTOM", required: true },
            { name: "description", label: "Description" },
          ]} />
        </Card>
      ) : null}
    </>
  );
}
