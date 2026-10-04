import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { departmentOptions } from "@/lib/governance";
import { employeeNames, fmtDay, fmtTime, matches, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat, Badge } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveChannelAction, joinChannelAction, decideReportAction } from "@/app/actions/engage-comms";
import { withdrawWorkflowAction } from "@/app/actions/workflows";

const P = PERMISSIONS;
const ALL_TABS = { directory: "Discover", mine: "My channels", create: "Create", moderation: "Moderation", reports: "Reports" };
type Tab = keyof typeof ALL_TABS;
const KINDS = ["CHANNEL", "INTEREST_GROUP", "DEPARTMENT", "LEADERSHIP"];

/** Discussion channels and interest groups: discover, join (private ones need the owner's approval), create, moderate reported posts, and activity reports. */
export default async function CommunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const comms = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => comms || !["moderation", "reports"].includes(k))) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "directory";
  const t = viewer.tenantId;
  const me = viewer.employee?.id ?? null;
  return (
    <>
      <PageHead title="Communities" subtitle="Channels, interest groups, department news and leadership updates" />
      <Tabs base="/engage/communities" tabs={tabs} active={tab} />
      {tab === "directory" ? <Directory tenantId={t} me={me} q={sp.q} kind={sp.kind} /> : null}
      {tab === "mine" ? <Mine tenantId={t} me={me} /> : null}
      {tab === "create" ? <Create tenantId={t} comms={comms} /> : null}
      {tab === "moderation" && comms ? <Moderation tenantId={t} /> : null}
      {tab === "reports" && comms ? <Reports tenantId={t} /> : null}
    </>
  );
}

async function Directory({ tenantId, me, q, kind }: { tenantId: string; me: string | null; q?: string; kind?: string }) {
  const rows = await prisma.communityChannel.findMany({
    where: { tenantId, archivedAt: null, ...(kind && KINDS.includes(kind) ? { kind } : {}) },
    orderBy: { name: "asc" },
    include: { _count: { select: { members: { where: { status: "ACTIVE" } }, posts: { where: { hiddenAt: null } } } }, members: { where: { employeeId: me ?? "__none__" }, select: { status: true, workflowRequestId: true } } },
  });
  const shown = rows.filter((c) => matches(q, c.name, c.description));
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2"><input className="input" name="q" defaultValue={q ?? ""} placeholder="Find a channel or group…" />
        <select className="select" name="kind" defaultValue={kind ?? ""} style={{ width: 180 }}><option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select>
        <button className="btn sm">Search</button></form>
      {shown.length === 0 ? <Callout title="No channels yet">Start one from the Create tab.</Callout> : (
        <div className="grid grid-3">
          {shown.map((c) => {
            const m = c.members[0];
            return (
              <div key={c.id} className="card"><div className="card-body">
                <div className="row gap-2" style={{ marginBottom: 4 }}><Badge>{pretty(c.kind)}</Badge>{c.visibility === "PRIVATE" ? <Badge tone="warning">Private</Badge> : null}</div>
                <Link className="strong" href={`/engage/communities/${c.id}`}>{c.name}</Link>
                {c.description ? <div className="text-sm muted" style={{ margin: "4px 0" }}>{c.description}</div> : null}
                <div className="text-xs muted" style={{ marginBottom: 8 }}>{c._count.members} members · {c._count.posts} posts</div>
                {m?.status === "ACTIVE" ? <Link className="btn sm" href={`/engage/communities/${c.id}`}>Open</Link>
                  : m?.status === "PENDING" ? <div className="row gap-2"><span className="text-xs">Request pending</span>{m.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: m.workflowRequestId }} label="Withdraw" variant="ghost" /> : null}</div>
                  : me ? <ActButton action={joinChannelAction} hidden={{ channelId: c.id }} label={c.visibility === "PRIVATE" ? "Ask to join" : "Join"} variant="primary" /> : null}
              </div></div>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function Mine({ tenantId, me }: { tenantId: string; me: string | null }) {
  if (!me) return <Callout title="No employee record">Channels are for employees.</Callout>;
  const rows = await prisma.communityMember.findMany({ where: { employeeId: me, status: "ACTIVE", channel: { tenantId } }, include: { channel: { include: { posts: { where: { hiddenAt: null }, orderBy: { createdAt: "desc" }, take: 1 } } } } });
  return (
    <Card tight title="Channels you are in">
      <Table head={["Channel", "Kind", "Your role", "Latest activity", ""]} empty={rows.length === 0}>
        {rows.map((m) => <tr key={m.id}><td><strong>{m.channel.name}</strong>{m.channel.archivedAt ? <span className="text-xs muted"> (archived)</span> : null}</td><td>{pretty(m.channel.kind)}</td><td>{pretty(m.role)}</td><td className="text-xs">{m.channel.posts[0] ? fmtTime(m.channel.posts[0].createdAt) : "No posts yet"}</td><td><Link className="btn sm" href={`/engage/communities/${m.channelId}`}>Open</Link></td></tr>)}
      </Table>
    </Card>
  );
}

async function Create({ tenantId, comms }: { tenantId: string; comms: boolean }) {
  const depts = await departmentOptions(tenantId);
  return (
    <Card title="Start a channel or group" description={comms ? "Department news channels add the whole department and only owners post; leadership channels are owner-post only." : "Anyone can start a channel or interest group. Department news and leadership channels are set up by communications."}>
      <SpecForm action={saveChannelAction} submitLabel="Create" fields={[
        { name: "name", label: "Name", required: true },
        { name: "kind", label: "Kind", type: "select", required: true, defaultValue: "CHANNEL", options: (comms ? KINDS : KINDS.slice(0, 2)).map((k) => ({ value: k, label: pretty(k) })) },
        { name: "visibility", label: "Who can join", type: "select", required: true, defaultValue: "OPEN", options: [{ value: "OPEN", label: "Anyone" }, { value: "PRIVATE", label: "Private — owner approves" }] },
        ...(comms ? [{ name: "departmentId", label: "Department (department news)", type: "select" as const, options: depts }] : []),
        { name: "postingRestricted", label: "Posting", type: "checkbox", placeholder: "Only owners and moderators start threads" },
        { name: "description", label: "What is it for?", type: "textarea", wide: true },
      ]} />
    </Card>
  );
}

async function Moderation({ tenantId }: { tenantId: string }) {
  const reports = await prisma.contentReport.findMany({ where: { tenantId, status: "OPEN" }, orderBy: { createdAt: "asc" } });
  const wall = await prisma.wallPost.findMany({ where: { tenantId, id: { in: reports.filter((r) => r.targetType === "WALL_POST").map((r) => r.targetId) } }, select: { id: true, body: true, authorId: true } });
  const chan = await prisma.communityPost.findMany({ where: { channel: { tenantId }, id: { in: reports.filter((r) => r.targetType === "CHANNEL_POST").map((r) => r.targetId) } }, select: { id: true, body: true, authorId: true, channel: { select: { name: true } } } });
  const body = new Map<string, { text: string; author: string; where: string }>();
  for (const w of wall) body.set(w.id, { text: w.body, author: w.authorId, where: "Wall" });
  for (const c of chan) body.set(c.id, { text: c.body, author: c.authorId, where: c.channel.name });
  const names = await employeeNames(tenantId, [...reports.map((r) => r.reporterId), ...[...body.values()].map((b) => b.author)]);
  const recent = await prisma.contentReport.findMany({ where: { tenantId, status: { not: "OPEN" } }, orderBy: { decidedAt: "desc" }, take: 20 });
  return (
    <div className="stack gap-4">
      <Card tight title="Reported posts" description="Remove hides the post everywhere; dismiss keeps it. All reports on the same post are settled together.">
        <Table head={["Reported", "Where", "Post", "Author", "Reason", "By", ""]} empty={reports.length === 0}>
          {reports.map((r) => {
            const b = body.get(r.targetId);
            return (
              <tr key={r.id}>
                <td>{fmtDay(r.createdAt)}</td><td>{b?.where ?? pretty(r.targetType)}</td><td className="text-xs" style={{ maxWidth: 320 }}>{b?.text.slice(0, 240) ?? "(gone)"}</td><td>{b ? names.get(b.author) : ""}</td><td className="text-xs">{r.reason}</td><td>{names.get(r.reporterId)}</td>
                <td className="row gap-2"><ActButton action={decideReportAction} hidden={{ id: r.id, decision: "remove" }} label="Remove" variant="danger" /><ActButton action={decideReportAction} hidden={{ id: r.id, decision: "dismiss" }} label="Dismiss" variant="ghost" /></td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <Card tight title="Recent decisions">
        <Table head={["Decided", "Type", "Reason", "Outcome"]} empty={recent.length === 0}>
          {recent.map((r) => <tr key={r.id}><td>{fmtDay(r.decidedAt)}</td><td>{pretty(r.targetType)}</td><td className="text-xs">{r.reason}</td><td><Pill s={r.status} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Reports({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const channels = await prisma.communityChannel.findMany({ where: { tenantId }, include: { _count: { select: { members: { where: { status: "ACTIVE" } } } }, posts: { where: { createdAt: { gte: since } }, select: { authorId: true, hiddenAt: true } } }, orderBy: { name: "asc" } });
  const openReports = await prisma.contentReport.count({ where: { tenantId, status: "OPEN" } });
  const posts = channels.reduce((s, c) => s + c.posts.length, 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Channels" value={channels.filter((c) => !c.archivedAt).length} />
        <Stat label="Posts (30 days)" value={posts} />
        <Stat label="Active posters (30 days)" value={new Set(channels.flatMap((c) => c.posts.map((p) => p.authorId))).size} />
        <Stat label="Open reports" value={openReports} tone={openReports ? "neg" : undefined} />
      </div>
      <Card tight title="Activity by channel (30 days)" action={<a className="btn sm" href="/engage/export?report=channels">Export CSV</a>}>
        <Table head={["Channel", "Kind", "Members", "Posts", "Posters", "Hidden", "Status"]} empty={channels.length === 0}>
          {channels.map((c) => <tr key={c.id}><td><Link href={`/engage/communities/${c.id}`}>{c.name}</Link></td><td>{pretty(c.kind)}</td><td>{c._count.members}</td><td>{c.posts.length}</td><td>{new Set(c.posts.map((p) => p.authorId)).size}</td><td>{c.posts.filter((p) => p.hiddenAt).length}</td><td><Pill s={c.archivedAt ? "ARCHIVED" : "ACTIVE"} /></td></tr>)}
        </Table>
      </Card>
      <Card tight title="Wall and polls exports"><div className="row gap-2"><a className="btn sm" href="/engage/export?report=feed">News feed CSV</a><a className="btn sm" href="/engage/export?report=polls">Polls CSV</a></div></Card>
    </div>
  );
}
