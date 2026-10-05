import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { widgetVisible, shareLive } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { dashboardAccess } from "@/lib/insight/datasets";
import { employeeOptions, roleOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { Bars } from "@/components/keka";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Pill } from "@/components/gov-ui";
import { ExportLinks, fmtCell } from "@/components/insight-table";
import {
  updateDashboardAction, deleteDashboardAction, addWidgetAction, updateWidgetAction, removeWidgetAction, refreshDashboardAction, shareDashboardAction,
  unshareDashboardAction, addDashboardNoteAction, deleteDashboardNoteAction, publishDashboardAction, unpublishDashboardAction,
} from "@/app/actions/insight-analytics";

export const metadata = { title: "Dashboard" };

/** One dashboard: its widgets, refresh status, notes, sharing and publishing. */
export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "risk") redirect("/insights/people?tab=talent-risk");
  if (id === "attrition") redirect("/analytics/attrition");
  const viewer = await requireViewer();
  const d = await prisma.insightDashboard.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { widgets: { orderBy: { position: "asc" } }, shares: true, notes: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } } });
  if (!d) notFound();
  const access = await dashboardAccess(viewer, d);
  if (!access.view) notFound();
  const me = { roleNames: viewer.roleNames, isManager: viewer.allReportIds.size > 0, isEmployee: !!viewer.employee };
  const widgets = access.edit ? d.widgets : d.widgets.filter((w) => widgetVisible(w.roles, me));
  const [metrics, kpis, roles, emps, names] = await Promise.all([
    prisma.insightMetric.findMany({ where: { tenantId: viewer.tenantId, status: "APPROVED" }, orderBy: { name: "asc" } }),
    prisma.insightKpi.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    roleOptions(viewer.tenantId),
    access.owner ? employeeOptions(viewer.tenantId) : Promise.resolve([]),
    userNames(viewer.tenantId, [...d.notes.map((n) => n.authorId), ...d.shares.map((s) => s.userId), d.ownerUserId]),
  ]);
  const roleOpts = [{ value: "MANAGER", label: "Managers" }, { value: "EMPLOYEE", label: "Employees" }, ...roles.map((r) => ({ value: r.label, label: r.label }))];
  const now = new Date();
  return (
    <>
      <PageHead title={d.name} subtitle={<>{d.description ?? "Dashboard"} · owner {names.get(d.ownerUserId) ?? ""} · <Pill s={d.status} /></>}
        actions={<span className="row gap-2"><ActButton action={refreshDashboardAction} hidden={{ id: d.id }} label="Refresh" /><ExportLinks ds={`dashboard:${d.id}`} /><Link className="btn sm" href="/storyboards">All dashboards</Link></span>} />
      <div className="text-sm muted" style={{ marginBottom: 10 }}>
        Refresh status: {d.refreshedAt ? <>{fmtWhen(d.refreshedAt)} · {d.refreshStatus ? <Pill s={d.refreshStatus} /> : null} · {d.refreshMs} ms{d.refreshError ? ` · ${d.refreshError}` : ""}</> : "never refreshed"}
      </div>
      {widgets.length ? (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          {widgets.map((w, i) => {
            const series = (Array.isArray(w.series) ? w.series : []) as Array<{ label: string; value: number | null }>;
            const notes = d.notes.filter((n) => n.widgetId === w.id);
            return (
              <Card key={w.id} title={w.title} description={<>{w.source === "METRIC" ? "Metric" : "KPI"}{w.roles.length ? ` · for ${w.roles.join(", ")}` : ""}</>}
                action={access.edit ? <span className="row gap-1"><ActButton action={updateWidgetAction} hidden={{ id: w.id, move: "up" }} label="↑" variant="ghost" />{i < widgets.length - 1 ? <ActButton action={updateWidgetAction} hidden={{ id: w.id, move: "down" }} label="↓" variant="ghost" /> : null}<ActButton action={removeWidgetAction} hidden={{ id: w.id }} label="×" variant="ghost" confirmText="Remove this widget?" /></span> : null}>
                <div style={{ fontSize: 28, fontWeight: 600 }}>{w.error ? <span className="neg text-sm">{w.error}</span> : fmtCell(w.value === null ? null : Number(w.value), "num")}</div>
                {w.viz === "TREND" && series.length ? <Bars data={series.map((s) => ({ label: s.label.slice(2), value: s.value ?? 0 }))} height={60} /> : null}
                <div className="text-xs muted">computed {fmtWhen(w.computedAt)}</div>
                {notes.map((n) => <div key={n.id} className="text-xs" style={{ marginTop: 4 }}><strong>Note:</strong> {n.body} <span className="muted">— {names.get(n.authorId) ?? ""}</span></div>)}
                {access.edit ? (
                  <details style={{ marginTop: 6 }}><summary className="text-xs">Edit widget</summary>
                    <SpecForm action={updateWidgetAction} hidden={{ id: w.id, rolesSet: "1" }} columns={1} fields={[
                      { name: "title", label: "Title", defaultValue: w.title },
                      { name: "viz", label: "Show", type: "select", options: [{ value: "NUMBER", label: "Number" }, { value: "TREND", label: "Number and trend" }], defaultValue: w.viz },
                      { name: "roles", label: "Visible to (none = everyone who can open the dashboard)", type: "multiselect", options: roleOpts, defaultValue: w.roles },
                    ]} />
                  </details>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : <Card><div className="muted">No widgets {access.edit ? "yet — add one below." : "for your role."}</div></Card>}
      <div className="grid grid-2">
        {access.edit ? (
          <Card title="Add a widget">
            <SpecForm action={addWidgetAction} hidden={{ dashboardId: d.id }} columns={1} submitLabel="Add" fields={[
              { name: "ref", label: "Shows", type: "select", required: true, options: [...metrics.map((m) => ({ value: `METRIC:${m.key}`, label: `Metric: ${m.name}` })), ...kpis.map((k) => ({ value: `KPI:${k.id}`, label: `KPI: ${k.name}` }))] },
              { name: "title", label: "Title", hint: "Defaults to the metric's or KPI's name" },
              { name: "viz", label: "Show", type: "select", options: [{ value: "NUMBER", label: "Number" }, { value: "TREND", label: "Number and trend" }], defaultValue: "NUMBER" },
              { name: "roles", label: "Visible to", type: "multiselect", options: roleOpts },
            ]} />
          </Card>
        ) : null}
        <Card title="Notes" description="Annotate the dashboard or a widget for whoever reads it.">
          {d.notes.length ? (
            <ul className="stack gap-1 text-sm" style={{ marginBottom: 10 }}>
              {d.notes.map((n) => <li key={n.id} className="row gap-2"><span>{n.widgetId ? <Badge>{widgets.find((w) => w.id === n.widgetId)?.title ?? "widget"}</Badge> : null} {n.body} <span className="muted">— {names.get(n.authorId) ?? ""}, {fmtDate(n.createdAt)}</span></span>{n.authorId === viewer.user.id || access.owner ? <ActButton action={deleteDashboardNoteAction} hidden={{ id: n.id }} label="×" variant="ghost" /> : null}</li>)}
            </ul>
          ) : null}
          <SpecForm action={addDashboardNoteAction} hidden={{ dashboardId: d.id }} columns={1} submitLabel="Add note" fields={[
            { name: "body", label: "Note", type: "textarea", required: true },
            { name: "widgetId", label: "About widget", type: "select", options: widgets.map((w) => ({ value: w.id, label: w.title })) },
          ]} />
        </Card>
        {access.owner ? (
          <Card title="Sharing" description="Share with a colleague, optionally until a date; the share ends on its own.">
            {d.shares.length ? (
              <ul className="stack gap-1 text-sm" style={{ marginBottom: 10 }}>
                {d.shares.map((s) => <li key={s.id} className="row gap-2">{names.get(s.userId) ?? s.userId} · {s.canEdit ? "can edit" : "view only"} · {s.expiresAt ? `${shareLive(s, now) ? "until" : "expired"} ${fmtDate(s.expiresAt)}` : "no expiry"} <ActButton action={unshareDashboardAction} hidden={{ id: s.id }} label="Stop" variant="ghost" /></li>)}
              </ul>
            ) : null}
            <SpecForm action={shareDashboardAction} hidden={{ dashboardId: d.id }} columns={1} submitLabel="Share" fields={[
              { name: "employeeId", label: "Colleague", type: "select", options: emps, required: true },
              { name: "expiresAt", label: "Until", type: "date" },
              { name: "canEdit", label: "Can edit", type: "checkbox" },
            ]} />
          </Card>
        ) : null}
        {access.owner ? (
          <Card title="Publishing and settings">
            <div className="row gap-2" style={{ marginBottom: 10 }}>
              {d.status === "PUBLISHED" ? <ActButton action={unpublishDashboardAction} hidden={{ id: d.id }} label="Unpublish" /> : d.status !== "PENDING_APPROVAL" ? <ActButton action={publishDashboardAction} hidden={{ id: d.id }} label="Publish company-wide" variant="primary" /> : <Badge tone="warning">waiting for approval</Badge>}
              <ActButton action={deleteDashboardAction} hidden={{ id: d.id }} label="Delete" variant="danger" confirmText="Delete this dashboard?" />
            </div>
            <SpecForm action={updateDashboardAction} hidden={{ id: d.id }} columns={1} fields={[
              { name: "name", label: "Name", required: true, defaultValue: d.name },
              { name: "description", label: "Description", defaultValue: d.description },
            ]} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
