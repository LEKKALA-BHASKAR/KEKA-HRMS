import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { usersWithPermission } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { RaiseTicketForm, CategoryForm } from "../_lifecycle/forms";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const STATUS_TONE: Record<string, "warning" | "info" | "success" | "neutral" | "danger"> = {
  OPEN: "warning", IN_PROGRESS: "info", WAITING_ON_EMPLOYEE: "neutral", RESOLVED: "success", CLOSED: "neutral",
};
const PRIORITY_TONE: Record<string, "danger" | "warning" | "neutral" | "info"> = { URGENT: "danger", HIGH: "warning", MEDIUM: "info", LOW: "neutral" };

function sla(dueAt: Date, status: string, resolvedAt: Date | null) {
  if (status === "RESOLVED" || status === "CLOSED") {
    return resolvedAt && resolvedAt > dueAt ? <span className="text-xs neg">missed SLA</span> : <span className="text-xs pos">within SLA</span>;
  }
  const h = Math.round((dueAt.getTime() - Date.now()) / 3_600_000);
  return h < 0 ? <span className="text-xs neg strong">{-h}h overdue</span> : <span className={`text-xs ${h < 8 ? "" : "muted"}`} style={h < 8 ? { color: "var(--warning)" } : undefined}>due in {h}h</span>;
}

export default async function HelpdeskPage({ searchParams }: { searchParams: Promise<{ view?: string; status?: string }> }) {
  const viewer = await requireAuth(P.HELPDESK_VIEW);
  const sp = await searchParams;
  const agent = can(viewer, P.HELPDESK_MANAGE);
  const view = agent && sp.view !== "mine" ? (sp.view === "settings" && can(viewer, P.HELPDESK_SETTINGS) ? "settings" : "queue") : "mine";

  const categories = await prisma.helpdeskCategory.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } });

  return (
    <>
      <PageHead title="Helpdesk" subtitle={agent ? "Employee questions, routed by category with a response target" : "Ask HR, payroll or IT — and track the answer"} />
      {agent ? (
        <div className="tabs">
          <Link href="/helpdesk" className={`tab${view === "queue" ? " active" : ""}`}>Queue</Link>
          <Link href="/helpdesk?view=mine" className={`tab${view === "mine" ? " active" : ""}`}>My tickets</Link>
          {can(viewer, P.HELPDESK_SETTINGS) ? <Link href="/helpdesk?view=settings" className={`tab${view === "settings" ? " active" : ""}`}>Categories</Link> : null}
        </div>
      ) : null}
      {view === "queue" ? <Queue tenantId={viewer.tenantId} userId={viewer.user.id} status={sp.status} /> : null}
      {view === "mine" ? <Mine employeeId={viewer.employee?.id} categories={categories.filter((c) => c.isActive)} /> : null}
      {view === "settings" ? <Settings tenantId={viewer.tenantId} categories={categories} /> : null}
    </>
  );
}

async function Queue({ tenantId, userId, status }: { tenantId: string; userId: string; status?: string }) {
  const filter = status === "all" ? undefined : status === "mine" ? "mine" : status === "overdue" ? "overdue" : "open";
  const tickets = await prisma.helpdeskTicket.findMany({
    where: {
      tenantId,
      ...(filter === "open" ? { status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"] } } : {}),
      ...(filter === "mine" ? { assigneeUserId: userId, status: { notIn: ["CLOSED"] } } : {}),
      ...(filter === "overdue" ? { status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: new Date() } } : {}),
    },
    include: { employee: { select: { displayName: true, employeeNumber: true } }, category: { select: { name: true } } },
    orderBy: [{ dueAt: "asc" }],
    take: 100,
  });
  const all = await prisma.helpdeskTicket.findMany({ where: { tenantId }, select: { status: true, dueAt: true, resolvedAt: true, createdAt: true, firstResponseAt: true, satisfaction: true } });
  const open = all.filter((t) => ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"].includes(t.status));
  const resolved = all.filter((t) => t.resolvedAt);
  const inSla = resolved.filter((t) => t.resolvedAt! <= t.dueAt).length;
  const rated = all.filter((t) => t.satisfaction);
  const agentIds = [...new Set(tickets.map((t) => t.assigneeUserId).filter((x): x is string => !!x))];
  const agents = new Map((await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, email: true, employee: { select: { displayName: true } } } })).map((u) => [u.id, u.employee?.displayName ?? u.email]));

  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Open" value={String(open.length)} meta={`${open.filter((t) => t.dueAt < new Date() && t.status !== "WAITING_ON_EMPLOYEE").length} past target`} />
        <Stat label="Resolved within SLA" value={resolved.length ? `${Math.round((inSla / resolved.length) * 100)}%` : "—"} meta={`${resolved.length} resolved`} />
        <Stat label="Median first response" value={(() => {
          const ts = all.filter((t) => t.firstResponseAt).map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 3_600_000).sort((a, b) => a - b);
          return ts.length ? `${ts[Math.floor(ts.length / 2)].toFixed(1)}h` : "—";
        })()} meta="from raising to first reply" />
        <Stat label="Satisfaction" value={rated.length ? `${(rated.reduce((s, t) => s + (t.satisfaction ?? 0), 0) / rated.length).toFixed(1)} / 5` : "—"} meta={`${rated.length} rating(s)`} />
      </div>
      <Card tight title="Tickets" action={
        <div className="row gap-2">
          {[["open", "Open"], ["mine", "Assigned to me"], ["overdue", "Overdue"], ["all", "All"]].map(([k, l]) => (
            <Link key={k} href={`/helpdesk?status=${k}`} className={`btn sm${(filter ?? "all") === k ? " primary" : ""}`}>{l}</Link>
          ))}
        </div>
      }>
        {tickets.length === 0 ? <Empty title="Nothing in this view" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Ticket</th><th>From</th><th>Category</th><th>Priority</th><th>Status</th><th>Target</th><th>Agent</th></tr></thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/helpdesk/${t.id}`} className="strong text-sm">HD-{t.number}</Link><div className="text-sm">{t.subject}</div></td>
                    <td><Person name={t.employee.displayName ?? ""} meta={t.employee.employeeNumber} /></td>
                    <td className="text-sm">{t.category.name}</td>
                    <td><Badge tone={PRIORITY_TONE[t.priority]}>{t.priority.toLowerCase()}</Badge></td>
                    <td><Badge tone={STATUS_TONE[t.status]}>{t.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td className="nowrap">{sla(t.dueAt, t.status, t.resolvedAt)}</td>
                    <td className="text-sm muted">{t.assigneeUserId ? agents.get(t.assigneeUserId) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function Mine({ employeeId, categories }: { employeeId?: string; categories: Array<{ id: string; name: string; slaHours: number }> }) {
  const tickets = employeeId ? await prisma.helpdeskTicket.findMany({
    where: { employeeId }, include: { category: { select: { name: true } }, _count: { select: { comments: { where: { isInternal: false } } } } },
    orderBy: { createdAt: "desc" },
  }) : [];
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Raise a ticket" description="Only you and the helpdesk team can see it.">
        {employeeId ? <RaiseTicketForm categories={categories.map((c) => ({ value: c.id, label: `${c.name} — answer within ${c.slaHours}h` }))} /> : <Empty title="No employee record" />}
      </Card>
      <Card tight title="My tickets">
        {tickets.length === 0 ? <Empty title="No tickets yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/helpdesk/${t.id}`} className="strong text-sm">HD-{t.number} · {t.subject}</Link>
                      <div className="text-xs subtle">{t.category.name} · {formatDate(t.createdAt)} · {t._count.comments} repl{t._count.comments === 1 ? "y" : "ies"}</div>
                    </td>
                    <td className="right"><Badge tone={STATUS_TONE[t.status]}>{t.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function Settings({ tenantId, categories }: { tenantId: string; categories: Array<{ id: string; name: string; description: string | null; slaHours: number; defaultAssigneeUserId: string | null; isActive: boolean }> }) {
  const agentIds = await usersWithPermission(tenantId, PERMISSIONS.HELPDESK_MANAGE);
  const agents = (await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }))
    .map((u) => ({ value: u.id, label: u.employee?.displayName ?? u.email }));
  return (
    <div className="stack gap-4">
      <Card title="New category"><Disclosure label="Add a category"><CategoryForm agents={agents} /></Disclosure></Card>
      {categories.map((c) => (
        <Card key={c.id} title={c.name} description={`${c.slaHours}h target${c.isActive ? "" : " · inactive"}`}>
          <CategoryForm key={c.id} agents={agents} category={c} />
        </Card>
      ))}
    </div>
  );
}
