import Link from "next/link";
import { prisma } from "@keka/db";
import { GENERIC_REQUEST_CATEGORIES, WORKFLOW_ENTITY_TYPES } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { roleOptions, userOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { submitGeneralRequestAction, withdrawWorkflowAction, createDelegationAction, revokeDelegationAction, completeWorkTaskAction } from "@/app/actions/workflows";
import { requestAccessAction, withdrawAccessRequestAction, decideAccessReviewAction } from "@/app/actions/security";

const TABS = { requests: "My requests", access: "Access", tasks: "Tasks", reviews: "Access reviews", away: "Out of office" };
type Tab = keyof typeof TABS;
const typeLabel = (t: string) => WORKFLOW_ENTITY_TYPES[t as keyof typeof WORKFLOW_ENTITY_TYPES] ?? t;

/** Self-service: general requests, access requests, tasks, access reviews assigned to me, delegation. */
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "requests";
  const t = viewer.tenantId, me = viewer.user.id;
  return (
    <>
      <PageHead title="Requests" subtitle="Ask for something, ask for access, and work the tasks and reviews assigned to you" />
      <Tabs base="/me/requests" tabs={TABS} active={tab} />
      {tab === "requests" ? <MyWorkflowRequests tenantId={t} userId={me} q={sp.q} /> : null}
      {tab === "access" ? <Access tenantId={t} userId={me} /> : null}
      {tab === "tasks" ? <Tasks tenantId={t} userId={me} /> : null}
      {tab === "reviews" ? <Reviews tenantId={t} userId={me} /> : null}
      {tab === "away" ? <Away tenantId={t} userId={me} /> : null}
    </>
  );
}

async function MyWorkflowRequests({ tenantId, userId, q }: { tenantId: string; userId: string; q?: string }) {
  const rows = await prisma.workflowRequest.findMany({
    where: { tenantId, requesterUserId: userId, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) }, orderBy: { createdAt: "desc" }, take: 100,
    include: { tasks: { where: { status: "PENDING" }, select: { approverUserId: true, stepName: true } } },
  });
  const names = await userNames(tenantId, rows.flatMap((r) => r.tasks.map((x) => x.approverUserId)));
  return (
    <div className="stack gap-4">
      <Card tight title="My requests">
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="requests" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search…" /><button className="btn sm">Search</button></form>
        <Table head={["Request", "Type", "Status", "Waiting on", "Submitted", ""]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/me/requests/${r.id}`}>{r.title}</Link>{r.category ? <div className="text-xs muted">{GENERIC_REQUEST_CATEGORIES[r.category as keyof typeof GENERIC_REQUEST_CATEGORIES] ?? r.category}</div> : null}</td>
              <td className="text-xs">{typeLabel(r.entityType)}</td><td><Pill s={r.status} /></td>
              <td className="text-xs">{r.tasks.map((x) => `${names.get(x.approverUserId)} (${x.stepName})`).join(", ") || "—"}</td>
              <td className="text-xs">{fmtWhen(r.createdAt)}</td>
              <td>{r.status === "PENDING" ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: r.id }} label="Withdraw" variant="ghost" /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="New request" description="Goes to your reporting manager unless your company has set up a different route.">
        <SpecForm action={submitGeneralRequestAction} submitLabel="Submit request" fields={[
          { name: "category", label: "What for", type: "select", required: true, options: Object.entries(GENERIC_REQUEST_CATEGORIES).map(([value, label]) => ({ value, label })) },
          { name: "title", label: "Title", required: true, placeholder: "e.g. Address proof letter for bank" },
          { name: "amount", label: "Amount (if any)", type: "number" },
          { name: "details", label: "Details", type: "textarea", required: true, wide: true },
        ]} />
      </Card>
    </div>
  );
}

async function Access({ tenantId, userId }: { tenantId: string; userId: string }) {
  const [held, reqs, roles] = await Promise.all([
    prisma.userRoleAssignment.findMany({ where: { userId }, include: { role: { select: { name: true } } } }),
    prisma.accessRequest.findMany({ where: { tenantId, OR: [{ requesterUserId: userId }, { targetUserId: userId }] }, orderBy: { createdAt: "desc" }, take: 50 }),
    roleOptions(tenantId),
  ]);
  const roleName = new Map(roles.map((r) => [r.value, r.label]));
  return (
    <div className="stack gap-4">
      <Card tight title="Roles I hold">
        <Table head={["Role", "Granted", "Expires", "Note"]} empty={held.length === 0}>
          {held.map((a) => <tr key={a.id}><td>{a.role.name}</td><td className="text-xs">{fmtDate(a.grantedAt)}</td><td>{a.expiresAt ? <><Pill s={a.expiresAt > new Date() ? "ACTIVE" : "EXPIRED"} /> {fmtDate(a.expiresAt)}</> : "Permanent"}</td><td className="text-xs">{a.grantNote ?? ""}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="My access requests">
        <Table head={["Role", "Duration", "Status", "Requested", "Expires", ""]} empty={reqs.length === 0}>
          {reqs.map((r) => <tr key={r.id}><td>{roleName.get(r.roleId) ?? "Removed role"}{r.privileged ? <> <Pill s="HIGH" /></> : null}</td><td>{r.durationDays ? `${r.durationDays} days` : "Permanent"}</td><td><Pill s={r.status} /></td><td className="text-xs">{fmtWhen(r.createdAt)}</td><td className="text-xs">{fmtDate(r.expiresAt)}</td>
            <td className="row gap-2">{r.workflowRequestId ? <Link className="btn sm ghost" href={`/me/requests/${r.workflowRequestId}`}>Track</Link> : null}{r.status === "PENDING" && r.requesterUserId === userId ? <ActButton action={withdrawAccessRequestAction} hidden={{ id: r.id }} label="Withdraw" variant="ghost" /> : null}</td></tr>)}
        </Table>
      </Card>
      <Card title="Request access" description="Your manager and a security administrator approve. Time-bound access is removed automatically when it ends.">
        <SpecForm action={requestAccessAction} submitLabel="Request access" fields={[
          { name: "roleId", label: "Role", type: "select", options: roles, required: true },
          { name: "durationDays", label: "For how many days", type: "number", placeholder: "blank = permanent", hint: "1–365; leave blank for permanent" },
          { name: "justification", label: "Why you need it", type: "textarea", required: true, wide: true },
        ]} />
      </Card>
    </div>
  );
}

async function Tasks({ tenantId, userId }: { tenantId: string; userId: string }) {
  const tasks = await prisma.workTask.findMany({ where: { tenantId, assigneeUserId: userId }, orderBy: [{ status: "desc" }, { dueOn: "asc" }], take: 100 });
  return (
    <Card tight title="My tasks" description="Created by automation rules and workflows.">
      <Table head={["Task", "Due", "Status", ""]} empty={tasks.length === 0}>
        {tasks.map((x) => <tr key={x.id}><td><strong>{x.title}</strong>{x.description && x.description !== x.title ? <div className="text-xs muted">{x.description}</div> : null}</td><td>{fmtDate(x.dueOn)}</td><td><Pill s={x.status} /></td><td>{x.status === "OPEN" ? <ActButton action={completeWorkTaskAction} hidden={{ id: x.id }} label="Mark done" /> : null}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Reviews({ tenantId, userId }: { tenantId: string; userId: string }) {
  const items = await prisma.accessReviewItem.findMany({ where: { tenantId, reviewerUserId: userId, campaign: { status: "ACTIVE" } }, include: { campaign: { select: { name: true, dueOn: true } } }, orderBy: [{ decision: "asc" }] });
  const names = await userNames(tenantId, items.map((i) => i.userId));
  return (
    <Card tight title="Access reviews assigned to me" description="Confirm that each person still needs the role, or revoke it.">
      <Table head={["Review", "Person", "Role", "Due", "Decision", ""]} empty={items.length === 0}>
        {items.map((i) => (
          <tr key={i.id}>
            <td>{i.campaign.name}</td><td>{names.get(i.userId)}</td><td>{i.roleName}</td><td>{fmtDate(i.campaign.dueOn)}</td><td><Pill s={i.decision} /></td>
            <td className="row gap-2">{i.decision === "PENDING" ? <><ActButton action={decideAccessReviewAction} hidden={{ itemId: i.id, decision: "CONFIRMED" }} label="Confirm" variant="primary" /><ActButton action={decideAccessReviewAction} hidden={{ itemId: i.id, decision: "REVOKED" }} label="Revoke" variant="danger" confirmText="Revoke this role now?" /></> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Away({ tenantId, userId }: { tenantId: string; userId: string }) {
  const [rows, users] = await Promise.all([prisma.approverDelegation.findMany({ where: { tenantId, delegatorUserId: userId }, orderBy: { createdAt: "desc" } }), userOptions(tenantId)]);
  const names = await userNames(tenantId, rows.map((r) => r.delegateUserId));
  const now = new Date();
  return (
    <div className="stack gap-4">
      <Callout title="Out of office">While a delegation is in force, approvals that would come to you go to your delegate. Optionally hand over what is already waiting.</Callout>
      <Card tight title="My delegations">
        <Table head={["Delegate", "From", "To", "Status", ""]} empty={rows.length === 0}>
          {rows.map((d) => <tr key={d.id}><td>{names.get(d.delegateUserId)}</td><td>{fmtDate(d.startsOn)}</td><td>{fmtDate(d.endsOn)}</td><td><Pill s={d.revokedAt ? "REVOKED" : d.endsOn < now ? "EXPIRED" : d.startsOn <= now ? "ACTIVE" : "PENDING"} /></td><td>{!d.revokedAt && d.endsOn >= now ? <ActButton action={revokeDelegationAction} hidden={{ id: d.id }} label="End" variant="ghost" /> : null}</td></tr>)}
        </Table>
      </Card>
      <Card title="Delegate my approvals">
        <SpecForm action={createDelegationAction} submitLabel="Save" fields={[
          { name: "delegateUserId", label: "Delegate to", type: "select", options: users.filter((u) => u.value !== userId), required: true },
          { name: "startsOn", label: "From", type: "date", required: true }, { name: "endsOn", label: "To", type: "date", required: true },
          { name: "handOver", label: "Waiting approvals", type: "checkbox", placeholder: "Hand over approvals already waiting", defaultValue: true },
          { name: "reason", label: "Reason", placeholder: "Annual leave" },
        ]} />
      </Card>
    </div>
  );
}
