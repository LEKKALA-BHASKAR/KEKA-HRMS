import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { HR_TRANSACTION_TYPES, HR_AGING_BUCKETS, hrAgingBucket, slaState, type HrTransactionType } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { hrPendingItems, hrCalendarEvents } from "@/lib/core2";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { runHrOpsChecksAction, resolveHrOpsAlertAction } from "@/app/actions/core2-people";
import { saveSlaPolicyAction } from "@/app/actions/core2-setup";

export const metadata = { title: "HR desk — BooS-HR" };

const P = PERMISSIONS;
const TABS = { queue: "Queue & SLAs", calendar: "Operations calendar", workload: "Workload", alerts: "Exception alerts" } as const;
type Tab = keyof typeof TABS;
const DAY = 86_400_000;

/**
 * The HR operations desk: every open HR transaction aged and measured
 * against its SLA, a calendar of what HR has coming up, who is carrying the
 * approval load, and exception alerts (no manager, inactive units with
 * people, expiring work permits, overdue requests).
 */
export default async function HrDeskPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const sp = await searchParams;
  const tab: Tab = sp.tab && sp.tab in TABS ? (sp.tab as Tab) : "queue";
  const t = viewer.tenantId;
  const now = new Date();
  const [items, policies] = await Promise.all([hrPendingItems(t), prisma.hrSlaPolicy.findMany({ where: { tenantId: t } })]);
  const target = (type: HrTransactionType) => policies.find((p) => p.transactionType === type)?.targetHours ?? HR_TRANSACTION_TYPES[type].defaultHours;
  const breached = items.filter((i) => slaState(i.createdAt, target(i.type), now).breached).length;
  return (
    <>
      <PageHead title="HR desk" subtitle="Open HR work, its age and SLA, the calendar ahead and exceptions" actions={<><Link className="btn" href="/hr-ops">HR operations</Link><Link className="btn" href="/hr-ops/quality">Data quality</Link><Link className="btn" href="/hr-ops/movements">Movements</Link><a className="btn" href="/exports/core2/hr-desk">Export queue</a></>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Open HR items" value={items.length} />
        <Stat label="Past their SLA" value={breached} tone={breached ? "neg" : undefined} />
        <Stat label="Older than 14 days" value={items.filter((i) => now.getTime() - i.createdAt.getTime() > 14 * DAY).length} />
        <Stat label="Open alerts" value={await prisma.hrOpsAlert.count({ where: { tenantId: t, status: "OPEN" } })} />
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/hr-ops/desk?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "queue" ? <Queue items={items} target={target} now={now} /> : null}
      {tab === "calendar" ? <Calendar tenantId={t} now={now} /> : null}
      {tab === "workload" ? <Workload tenantId={t} items={items} /> : null}
      {tab === "alerts" ? <Alerts tenantId={t} /> : null}
    </>
  );
}

function Queue({ items, target, now }: { items: Awaited<ReturnType<typeof hrPendingItems>>; target: (t: HrTransactionType) => number; now: Date }) {
  const types = Object.keys(HR_TRANSACTION_TYPES) as HrTransactionType[];
  const grid = types.map((type) => ({ type, buckets: HR_AGING_BUCKETS.map((b) => items.filter((i) => i.type === type && hrAgingBucket(i.createdAt, now) === b).length) }));
  return (
    <>
      <Card title="Ageing by type" description="How long open items have been waiting.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Type</th><th>SLA</th>{HR_AGING_BUCKETS.map((b) => <th key={b}>{b}</th>)}<th>Set SLA (hours)</th></tr></thead>
          <tbody>{grid.map((g) => (
            <tr key={g.type}>
              <td>{HR_TRANSACTION_TYPES[g.type].label}</td><td>{target(g.type)}h</td>
              {g.buckets.map((n, i) => <td key={i}>{n ? <strong>{n}</strong> : <span className="muted">0</span>}</td>)}
              <td><SpecForm compact action={saveSlaPolicyAction} hidden={{ transactionType: g.type }} submitLabel="Save" fields={[{ name: "targetHours", label: "Hours", kind: "number", required: true, defaultValue: target(g.type) }]} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
      <Card title="Open items, oldest first">
        {items.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Item</th><th>Type</th><th>Raised</th><th>SLA</th><th /></tr></thead>
            <tbody>{items.slice(0, 200).map((i) => {
              const s = slaState(i.createdAt, target(i.type), now);
              return <tr key={`${i.type}${i.id}`}><td>{i.title}</td><td className="text-sm">{HR_TRANSACTION_TYPES[i.type].label}</td><td className="text-sm">{formatDate(i.createdAt)} <span className="muted">({hrAgingBucket(i.createdAt, now)})</span></td><td>{s.breached ? <Badge tone="danger">{-s.hoursLeft}h over</Badge> : <Badge tone={s.hoursLeft < 8 ? "warning" : "neutral"}>{s.hoursLeft}h left</Badge>}</td><td><Link href={i.link}>Open</Link></td></tr>;
            })}</tbody>
          </table></div>
        ) : <Empty title="Nothing open" />}
      </Card>
    </>
  );
}

async function Calendar({ tenantId, now }: { tenantId: string; now: Date }) {
  const events = await hrCalendarEvents(tenantId, now);
  return (
    <Card title="The next 60 days" description="Joinings, probation ends, last days, scheduled moves, filings, payroll cut-offs and expiring documents." action={<a className="btn sm" href="/exports/core2/hr-calendar">Export</a>}>
      {events.length ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Date</th><th>What</th><th>Who / detail</th></tr></thead>
          <tbody>{events.map((e, i) => <tr key={i}><td>{formatDate(e.date)}</td><td><Badge tone={e.kind === "Overdue filing" ? "danger" : "neutral"}>{e.kind}</Badge></td><td>{e.text}</td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="A quiet two months" />}
    </Card>
  );
}

async function Workload({ tenantId, items }: { tenantId: string; items: Awaited<ReturnType<typeof hrPendingItems>> }) {
  const tasks = await prisma.workflowTask.groupBy({ by: ["approverUserId"], where: { tenantId, status: "PENDING" }, _count: true });
  const overdue = await prisma.workflowTask.groupBy({ by: ["approverUserId"], where: { tenantId, status: "PENDING", dueAt: { lt: new Date() } }, _count: true });
  const users = await prisma.user.findMany({ where: { id: { in: tasks.map((t) => t.approverUserId) } }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
  const name = new Map(users.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const byType = (Object.keys(HR_TRANSACTION_TYPES) as HrTransactionType[]).map((t) => ({ t, n: items.filter((i) => i.type === t).length }));
  return (
    <div className="grid grid-2">
      <Card title="Open work by type">
        <div className="table-wrap"><table className="data"><tbody>{byType.map((b) => <tr key={b.t}><td>{HR_TRANSACTION_TYPES[b.t].label}</td><td>{b.n}</td></tr>)}</tbody></table></div>
      </Card>
      <Card title="Approvals waiting, by approver" description="Who is holding the queue.">
        {tasks.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Approver</th><th>Waiting</th><th>Overdue</th></tr></thead>
            <tbody>{tasks.sort((a, b) => b._count - a._count).map((t) => <tr key={t.approverUserId}><td>{name.get(t.approverUserId) ?? "—"}</td><td>{t._count}</td><td>{overdue.find((o) => o.approverUserId === t.approverUserId)?._count ?? 0}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No approvals waiting" />}
      </Card>
    </div>
  );
}

async function Alerts({ tenantId }: { tenantId: string }) {
  const alerts = await prisma.hrOpsAlert.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { severity: "asc" }, { createdAt: "desc" }], take: 200 });
  return (
    <Card title="Exception alerts" description="Checked every run: people without a manager or department, inactive units holding people, work permits and documents expiring, requests stuck past their SLA, vacant and orphaned units." action={<ActionButton action={runHrOpsChecksAction} hidden={{}} label="Run checks now" variant="primary" />}>
      {alerts.length ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Alert</th><th>Kind</th><th>Severity</th><th>Since</th><th /></tr></thead>
          <tbody>{alerts.map((a) => <tr key={a.id}><td>{a.link ? <Link href={a.link}>{a.message}</Link> : a.message}</td><td className="text-sm">{a.kind.toLowerCase().replace(/_/g, " ")}</td><td><Badge tone={a.severity === "HIGH" ? "danger" : a.severity === "MEDIUM" ? "warning" : "neutral"}>{a.severity.toLowerCase()}</Badge></td><td className="text-sm">{formatDate(a.createdAt)}</td><td>{a.status === "OPEN" ? <ActionButton action={resolveHrOpsAlertAction} hidden={{ id: a.id }} label="Resolve" /> : <Badge tone="success">resolved</Badge>}</td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="No alerts">Run the checks to look for exceptions.</Empty>}
    </Card>
  );
}
