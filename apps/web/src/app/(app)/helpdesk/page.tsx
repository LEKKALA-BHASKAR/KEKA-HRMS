import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  helpdeskScope, hasHelpdeskScope, helpdeskDashboard, helpdeskScopeWhere, helpdeskCategoryPath,
  HELPDESK_PERIODS, TICKET_OPEN_STATUSES, type HelpdeskPeriod,
} from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { BarChart, HBars } from "@/components/charts";
import { requireHelpdeskAgent } from "./_ui/access";
import { HelpdeskTabs } from "./_ui/tabs";
import { loadMyTickets, MyTicketsView, type MyTicketsSearch } from "./_ui/my-tickets";
import { PeriodSelect } from "./_ui/period-select";
import { PriorityPill, StatusPill } from "./_ui/bits";
import { ago } from "./_ui/format";
import s from "./_ui/hd.module.css";

/**
 * Org › Helpdesk › Summary for agents: today's queue at a glance, the
 * period's analysis (incoming, closed, response and resolution times,
 * satisfaction), the trend and the busiest categories, and what is assigned
 * to me. Employees who work no tickets get their own tickets here instead.
 */
export default async function HelpdeskPage({ searchParams }: { searchParams: Promise<MyTicketsSearch & { period?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const scope = await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, PERMISSIONS.HELPDESK_MANAGE));
  if (!hasHelpdeskScope(scope) && !can(viewer, PERMISSIONS.HELPDESK_SETTINGS)) {
    return <MyTicketsView data={await loadMyTickets(viewer, sp)} basePath="/helpdesk" />;
  }
  const { canSettings } = await requireHelpdeskAgent();
  const period: HelpdeskPeriod = sp.period && sp.period in HELPDESK_PERIODS ? (sp.period as HelpdeskPeriod) : "30d";
  const d = await helpdeskDashboard({ tenantId: viewer.tenantId, scope, period });
  const mine = await prisma.helpdeskTicket.findMany({
    where: { tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope), assigneeUserId: viewer.user.id, status: { in: TICKET_OPEN_STATUSES } },
    orderBy: { dueAt: "asc" }, take: 6,
    select: { id: true, number: true, subject: true, priority: true, status: true, createdAt: true, category: { select: { name: true, parent: { select: { name: true } } } } },
  });
  const overdue = await prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope), status: { in: TICKET_OPEN_STATUSES }, missedResolution: true } });
  const unassigned = await prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope), status: { in: TICKET_OPEN_STATUSES }, assigneeUserId: null } });
  const delta = (a: number, b: number) => (a === b ? null : a > b ? <span className={s.up}>▲ {a - b}</span> : <span className={s.down}>▼ {b - a}</span>);

  const tile = (label: string, value: string | number, rule: string, extra?: { caption: string; value: ReactNode }, href?: string) => {
    const body = (
      <div className={s.tile} style={{ ["--rule" as string]: rule }}>
        <div><div className={s.tileLabel}>{label}</div><div className={s.tileValue}>{value}</div></div>
        {extra ? <div className={s.tileDelta}>{extra.caption}<b>{extra.value}</b></div> : null}
      </div>
    );
    return href ? <Link key={label} href={href}>{body}</Link> : <div key={label}>{body}</div>;
  };

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings={canSettings} active="/helpdesk" />
      <div className={s.sectionRow}>
        <div className={s.h2}>Today</div>
        <Link href="/me/helpdesk" className={s.link}>My own tickets →</Link>
      </div>
      <div className={`${s.tiles} ${s.tiles5}`}>
        {tile("Open tickets", d.today.open, "#ef6f6f", { caption: "Unassigned", value: unassigned }, "/helpdesk/tickets")}
        {tile("Overdue", overdue, "#c94848", undefined, "/helpdesk/tickets?esc=RESOLUTION")}
        {tile("Incoming today", d.today.incomingToday, "#7c8ce0", { caption: "vs yesterday", value: delta(d.today.incomingToday, d.today.incomingYesterday) ?? "—" })}
        {tile("Closed today", d.today.closedToday, "#4caf7a", { caption: "vs yesterday", value: delta(d.today.closedToday, d.today.closedYesterday) ?? "—" })}
        {tile("On hold", d.today.onHold, "#8d97a8", undefined, "/helpdesk/tickets?status=ON_HOLD")}
      </div>

      <div className={s.sectionRow}>
        <div className={s.h2}>Analysis</div>
        <PeriodSelect value={period} options={Object.entries(HELPDESK_PERIODS).map(([value, p]) => ({ value, label: p.label }))} />
      </div>
      <div className={`${s.tiles} ${s.tiles5}`}>
        {tile("Incoming", d.analysis.incoming, "#7c8ce0")}
        {tile("Closed", d.analysis.closed, "#4caf7a")}
        {tile("Avg first response", d.analysis.firstResponse, "#f2b23a")}
        {tile("Avg resolution", d.analysis.resolution, "#4fb6c9")}
        {tile("Satisfaction", `${d.analysis.csat} / 5`, "#d87aa8")}
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className={s.panel}>
          <div className={s.chartHead}>Incoming vs closed</div>
          <div className={s.chartBody}>
            {d.series.some((x) => x.open || x.closed)
              ? <BarChart rows={d.series.map((x) => ({ label: x.label, value: x.open }))} series={[{ label: "Incoming", values: d.series.map((x) => x.open) }, { label: "Closed", values: d.series.map((x) => x.closed) }]} height={300} title="Incoming vs closed tickets" />
              : <div className={s.noData}>No tickets in this period.</div>}
          </div>
        </div>
        <div className={s.panel}>
          <div className={s.chartHead}>Open tickets by category</div>
          <div className={s.chartBody}>
            {d.topCategories.length ? <HBars rows={d.topCategories} color="#7c8ce0" /> : <div className={s.noData}>No open tickets.</div>}
          </div>
        </div>
      </div>

      <div className={s.panel}>
        <div className={s.chartHead}>
          <span>Assigned to me</span>
          <Link href="/helpdesk/tickets?assignee=me" className={s.link} style={{ fontSize: 14 }}>View all</Link>
        </div>
        {mine.length === 0 ? <div className={s.emptySmall}>Nothing is waiting on you.</div> : (
          <table className={s.table}>
            <tbody>
              {mine.map((t) => (
                <tr key={t.id}>
                  <td className={s.titleCell}><Link href={`/helpdesk/tickets/${t.id}`} className={s.link}>#{t.number} {t.subject}</Link><div className={s.sub}>{helpdeskCategoryPath(t.category)}</div></td>
                  <td><PriorityPill p={t.priority} /></td>
                  <td><StatusPill status={t.status} /></td>
                  <td className={`${s.nowrap} ${s.muted}`}>{ago(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
