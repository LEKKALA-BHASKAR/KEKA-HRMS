import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS, WORKFLOW_ENTITY_TYPES, parseActions } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { userNames, userOptions, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { ActButton, SpecForm } from "@/components/gov-forms";
import { toggleWorkflowAction, retryWorkflowAction, automationRuleOpAction, retryAutomationRunAction, runAutomationsNowAction, createDelegationAction, revokeDelegationAction } from "@/app/actions/workflows";

const TABS = { definitions: "Workflows", requests: "Requests", automation: "Automation rules", notifications: "Notification rules", runs: "Execution log", delegations: "Delegations", report: "Report" };
type Tab = keyof typeof TABS;
const typeLabel = (t: string) => WORKFLOW_ENTITY_TYPES[t as keyof typeof WORKFLOW_ENTITY_TYPES] ?? t;

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.WORKFLOW_MANAGE);
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "definitions";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="Workflows & automation" subtitle="Approval routes for every request type, automation and notification rules, delegations and the execution history"
        actions={<><Link className="btn" href="/admin/workflows/new">New workflow</Link><Link className="btn primary" href="/admin/workflows/rules/new">New rule</Link></>} />
      <Tabs base="/admin/workflows" tabs={TABS} active={tab} />
      {tab === "definitions" ? <Definitions tenantId={t} q={sp.q} /> : null}
      {tab === "requests" ? <Requests tenantId={t} q={sp.q} status={sp.status} type={sp.type} /> : null}
      {tab === "automation" ? <Rules tenantId={t} q={sp.q} notifyOnly={false} /> : null}
      {tab === "notifications" ? <Rules tenantId={t} q={sp.q} notifyOnly /> : null}
      {tab === "runs" ? <Runs tenantId={t} status={sp.status} /> : null}
      {tab === "delegations" ? <Delegations tenantId={t} /> : null}
      {tab === "report" ? <Report tenantId={t} /> : null}
    </>
  );
}

async function Definitions({ tenantId, q }: { tenantId: string; q?: string }) {
  const defs = await prisma.workflowDefinition.findMany({
    where: { tenantId, isCurrent: true, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { entityType: { contains: q.toUpperCase() } }] } : {}) },
    include: { _count: { select: { steps: true, requests: true } } }, orderBy: [{ entityType: "asc" }, { priority: "desc" }],
  });
  const configured = new Set(defs.map((d) => d.entityType));
  return (
    <div className="stack gap-4">
      <Card tight title={`Configured workflows (${defs.length})`} description="The most specific active workflow for a request's department and location routes it; request types without one use the built-in route.">
        <SearchBar action="/admin/workflows" tab="definitions" q={q} />
        <Table head={["Workflow", "Approves", "Applies to", "Steps", "Version", "Requests", "Status", ""]} empty={defs.length === 0}>
          {defs.map((d) => (
            <tr key={d.id}>
              <td><Link href={`/admin/workflows/${d.id}`}><strong>{d.name}</strong></Link>{d.description ? <div className="text-xs muted">{d.description}</div> : null}</td>
              <td className="text-sm">{typeLabel(d.entityType)}</td>
              <td className="text-xs">{d.matchDepartmentId || d.matchLocationId ? "Filtered" : "Everyone"}{d.priority ? ` · priority ${d.priority}` : ""}</td>
              <td className="num">{d._count.steps}</td>
              <td>v{d.version}</td>
              <td className="num">{d._count.requests}</td>
              <td><Pill s={d.isActive ? "ACTIVE" : "PAUSED"} /></td>
              <td><ActButton action={toggleWorkflowAction} hidden={{ id: d.id }} label={d.isActive ? "Pause" : "Resume"} variant="ghost" /></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card tight title="Request types" description="Every request type the engine routes, and how it is routed today.">
        <Table head={["Request type", "Route"]}>
          {Object.entries(WORKFLOW_ENTITY_TYPES).map(([k, v]) => <tr key={k}><td>{v}</td><td>{configured.has(k) ? <Pill s="ACTIVE" /> : <span className="text-xs muted">Built-in route</span>}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Requests({ tenantId, q, status, type }: { tenantId: string; q?: string; status?: string; type?: string }) {
  const where: Prisma.WorkflowRequestWhereInput = {
    tenantId, ...(status ? { status } : {}), ...(type ? { entityType: type } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { details: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const rows = await prisma.workflowRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { definition: { select: { name: true, version: true } }, tasks: { where: { status: "PENDING" }, select: { approverUserId: true } } } });
  const names = await userNames(tenantId, [...rows.map((r) => r.requesterUserId), ...rows.flatMap((r) => r.tasks.map((x) => x.approverUserId))]);
  const qs = new URLSearchParams(Object.entries({ report: "workflow-requests", q, status, type }).filter(([, v]) => !!v) as [string, string][]).toString();
  return (
    <Card tight title={`Requests (${rows.length})`} action={<a className="btn sm" href={`/admin/governance/export?${qs}`}>Export CSV</a>}>
      <SearchBar action="/admin/workflows" tab="requests" q={q}>
        <select className="select" name="status" defaultValue={status ?? ""}><option value="">Any status</option>{["PENDING", "APPROVED", "REJECTED", "WITHDRAWN", "ERROR"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select>
        <select className="select" name="type" defaultValue={type ?? ""}><option value="">Any type</option>{Object.entries(WORKFLOW_ENTITY_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </SearchBar>
      <Table head={["Request", "Type", "Requested by", "Route", "Waiting on", "Status", "Submitted", ""]} empty={rows.length === 0}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/me/requests/${r.id}`}>{r.title}</Link>{r.lastError ? <div className="text-xs neg">{r.lastError}</div> : null}</td>
            <td className="text-xs">{typeLabel(r.entityType)}</td>
            <td className="text-sm">{names.get(r.requesterUserId)}</td>
            <td className="text-xs">{r.definition ? `${r.definition.name} v${r.definition.version}` : "Built-in"}</td>
            <td className="text-xs">{r.tasks.map((x) => names.get(x.approverUserId)).join(", ") || "—"}</td>
            <td><Pill s={r.status} /></td>
            <td className="text-xs">{fmtWhen(r.createdAt)}</td>
            <td>{r.status === "ERROR" ? <ActButton action={retryWorkflowAction} hidden={{ requestId: r.id }} label="Retry" /> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Rules({ tenantId, q, notifyOnly }: { tenantId: string; q?: string; notifyOnly: boolean }) {
  const all = await prisma.automationRule.findMany({ where: { tenantId, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, orderBy: { createdAt: "desc" }, include: { _count: { select: { runs: true } } } });
  const rules = notifyOnly ? all.filter((r) => parseActions(r.actions).every((a) => a.type === "EMAIL" || a.type === "NOTIFY")) : all;
  return (
    <div className="stack gap-4">
      {notifyOnly ? <Callout title="Notification rules">Rules whose actions only send email or in-app notifications. Per-event email settings for built-in events are under <Link href="/admin/settings?tab=notifications">Settings › Notifications</Link>.</Callout> : null}
      <Card tight title={`${notifyOnly ? "Notification" : "Automation"} rules (${rules.length})`} description="New and edited rules start as drafts and are activated through approval."
        action={<div className="row gap-2"><ActButton action={runAutomationsNowAction} hidden={{}} label="Run due rules now" /><Link className="btn sm primary" href="/admin/workflows/rules/new">New rule</Link></div>}>
        <SearchBar action="/admin/workflows" tab={notifyOnly ? "notifications" : "automation"} q={q} />
        <Table head={["Rule", "When", "Then", "Status", "Runs", "Last run", ""]} empty={rules.length === 0}>
          {rules.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/admin/workflows/rules/${r.id}`}><strong>{r.name}</strong></Link></td>
              <td className="text-sm">{AUTOMATION_TRIGGERS[r.trigger as keyof typeof AUTOMATION_TRIGGERS] ?? r.trigger}{r.offsetDays ? ` (${r.offsetDays} days)` : ""}</td>
              <td className="text-xs">{parseActions(r.actions).map((a) => AUTOMATION_ACTIONS[a.type]).join(", ")}</td>
              <td><Pill s={r.status} /></td>
              <td className="num">{r._count.runs}</td>
              <td className="text-xs">{fmtWhen(r.lastRunAt)}</td>
              <td className="row gap-2">
                {r.status === "DRAFT" || r.status === "PAUSED" ? <ActButton action={automationRuleOpAction} hidden={{ id: r.id, op: "submit" }} label="Submit for activation" /> : null}
                {r.status === "ACTIVE" ? <ActButton action={automationRuleOpAction} hidden={{ id: r.id, op: "pause" }} label="Pause" variant="ghost" /> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Runs({ tenantId, status }: { tenantId: string; status?: string }) {
  const runs = await prisma.automationRun.findMany({ where: { tenantId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 200, include: { rule: { select: { name: true } } } });
  const events = await prisma.workflowEvent.findMany({ where: { tenantId, kind: { in: ["ERROR", "ESCALATED", "AUTO_APPROVED", "RETRIED"] } }, orderBy: { createdAt: "desc" }, take: 50, include: { request: { select: { title: true } } } });
  return (
    <div className="stack gap-4">
      <Card tight title="Automation runs" description="Each firing, once per rule, subject and occasion. Failed runs can be retried." action={<a className="btn sm" href="/admin/governance/export?report=automation-runs">Export CSV</a>}>
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="runs" /><select className="select" name="status" defaultValue={status ?? ""}><option value="">Any</option><option>SUCCESS</option><option>PARTIAL</option><option>FAILED</option></select><button className="btn sm">Filter</button></form>
        <Table head={["When", "Rule", "Subject", "Status", "Actions", "Detail", ""]} empty={runs.length === 0}>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="text-xs">{fmtWhen(r.createdAt)}</td><td>{r.rule.name}</td><td className="text-xs mono">{r.subjectType} {r.subjectId.slice(-6)}</td>
              <td><Pill s={r.status} /></td><td className="num">{r.actionsRun}</td><td className="text-xs">{r.error ?? ((r.detail as { done?: string[] } | null)?.done ?? []).join(", ")}</td>
              <td>{r.status === "FAILED" || r.status === "PARTIAL" ? <ActButton action={retryAutomationRunAction} hidden={{ id: r.id }} label="Retry" /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card tight title="Workflow exceptions" description="Escalations, automatic passes, errors and retries.">
        <Table head={["When", "Request", "Event", "Note"]} empty={events.length === 0}>
          {events.map((e) => <tr key={e.id}><td className="text-xs">{fmtWhen(e.createdAt)}</td><td><Link href={`/me/requests/${e.requestId}`}>{e.request.title}</Link></td><td><Pill s={e.kind} /></td><td className="text-xs">{e.note}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Delegations({ tenantId }: { tenantId: string }) {
  const [rows, users] = await Promise.all([prisma.approverDelegation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 }), userOptions(tenantId)]);
  const names = await userNames(tenantId, rows.flatMap((r) => [r.delegatorUserId, r.delegateUserId]));
  const now = new Date();
  return (
    <div className="stack gap-4">
      <Card tight title="Delegations">
        <Table head={["Away", "Delegate", "From", "To", "Covers", "Status", ""]} empty={rows.length === 0}>
          {rows.map((d) => {
            const live = !d.revokedAt && d.startsOn <= now && d.endsOn >= now;
            return (
              <tr key={d.id}>
                <td>{names.get(d.delegatorUserId)}</td><td>{names.get(d.delegateUserId)}</td><td>{fmtDate(d.startsOn)}</td><td>{fmtDate(d.endsOn)}</td>
                <td className="text-xs">{d.entityTypes.length ? d.entityTypes.map(typeLabel).join(", ") : "All requests"}</td>
                <td><Pill s={d.revokedAt ? "REVOKED" : live ? "ACTIVE" : d.endsOn < now ? "EXPIRED" : "PENDING"} /></td>
                <td>{!d.revokedAt && d.endsOn >= now ? <ActButton action={revokeDelegationAction} hidden={{ id: d.id }} label="End" variant="ghost" /> : null}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <Card title="Delegate someone's approvals">
        <SpecForm action={createDelegationAction} submitLabel="Save delegation" fields={[
          { name: "delegatorUserId", label: "Approver who is away", type: "select", options: users, required: true },
          { name: "delegateUserId", label: "Delegate", type: "select", options: users, required: true },
          { name: "startsOn", label: "From", type: "date", required: true }, { name: "endsOn", label: "To", type: "date", required: true },
          { name: "entityTypes", label: "Only these request types (none: all)", type: "multiselect", options: Object.entries(WORKFLOW_ENTITY_TYPES).map(([value, l]) => ({ value, label: l })) },
          { name: "handOver", label: "Pending approvals", type: "checkbox", placeholder: "Hand over approvals already waiting", defaultValue: true },
          { name: "reason", label: "Reason", wide: true },
        ]} />
      </Card>
    </div>
  );
}

async function Report({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [byStatus, byType, done, overdue, escalations, rules, runs] = await Promise.all([
    prisma.workflowRequest.groupBy({ by: ["status"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.workflowRequest.groupBy({ by: ["entityType"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.workflowRequest.findMany({ where: { tenantId, createdAt: { gte: since }, completedAt: { not: null } }, select: { createdAt: true, completedAt: true } }),
    prisma.workflowTask.count({ where: { tenantId, status: "PENDING", dueAt: { lt: new Date() } } }),
    prisma.workflowEvent.count({ where: { tenantId, kind: "ESCALATED", createdAt: { gte: since } } }),
    prisma.automationRule.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
    prisma.automationRun.groupBy({ by: ["status"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const hours = done.map((d) => (d.completedAt!.getTime() - d.createdAt.getTime()) / 3_600_000);
  const avg = hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null;
  const count = (rows: Array<{ _count: { _all: number } }>) => rows.reduce((a, r) => a + r._count._all, 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Requests (90 days)" value={count(byStatus)} />
        <Stat label="Average cycle time" value={avg === null ? "—" : `${avg} h`} />
        <Stat label="Approvals past SLA" value={overdue} tone={overdue ? "neg" : undefined} />
        <Stat label="Escalations (90 days)" value={escalations} />
      </div>
      <div className="grid grid-3">
        <Card tight title="By status"><Table head={["Status", "Requests"]}>{byStatus.map((r) => <tr key={r.status}><td><Pill s={r.status} /></td><td className="num">{r._count._all}</td></tr>)}</Table></Card>
        <Card tight title="By type"><Table head={["Type", "Requests"]}>{byType.map((r) => <tr key={r.entityType}><td className="text-sm">{typeLabel(r.entityType)}</td><td className="num">{r._count._all}</td></tr>)}</Table></Card>
        <Card tight title="Automation"><Table head={["", "Count"]}>
          {rules.map((r) => <tr key={`r${r.status}`}><td>Rules <Pill s={r.status} /></td><td className="num">{r._count._all}</td></tr>)}
          {runs.map((r) => <tr key={`x${r.status}`}><td>Runs <Pill s={r.status} /></td><td className="num">{r._count._all}</td></tr>)}
        </Table></Card>
      </div>
      <Card title="Exports"><div className="row gap-2"><a className="btn" href="/admin/governance/export?report=workflow-requests">Requests CSV</a><a className="btn" href="/admin/governance/export?report=workflow-events">Execution history CSV</a><a className="btn" href="/admin/governance/export?report=automation-runs">Automation runs CSV</a></div></Card>
    </div>
  );
}
