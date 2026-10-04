import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { employeeNames, fmtTime, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Badge } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { joinChannelAction, leaveChannelAction, postToChannelAction, moderateChannelAction, reportContentAction, saveChannelAction } from "@/app/actions/engage-comms";

/** One channel: threads with replies, pinned posts, report and moderation, members and settings. */
export default async function ChannelPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const sp = await searchParams;
  const ch = await prisma.communityChannel.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!ch) notFound();
  const me = viewer.employee?.id ?? null;
  const mine = me ? await prisma.communityMember.findUnique({ where: { channelId_employeeId: { channelId: ch.id, employeeId: me } } }) : null;
  const active = mine?.status === "ACTIVE";
  const mod = can(viewer, PERMISSIONS.ANNOUNCEMENT_MANAGE) || (active && (mine!.role === "OWNER" || mine!.role === "MODERATOR"));
  const canRead = ch.visibility === "OPEN" || active || mod;
  const [posts, members] = await Promise.all([
    canRead ? prisma.communityPost.findMany({ where: { channelId: ch.id, ...(mod ? {} : { hiddenAt: null }) }, orderBy: { createdAt: "asc" }, take: 500 }) : Promise.resolve([]),
    prisma.communityMember.findMany({ where: { channelId: ch.id, status: { in: ["ACTIVE", "PENDING"] } }, orderBy: [{ role: "asc" }, { joinedAt: "asc" }] }),
  ]);
  const names = await employeeNames(viewer.tenantId, [...posts.map((p) => p.authorId), ...members.map((m) => m.employeeId)]);
  const roots = posts.filter((p) => !p.parentId).sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.createdAt.getTime() - a.createdAt.getTime());
  const replies = (pid: string) => posts.filter((p) => p.parentId === pid);
  const archived = !!ch.archivedAt;
  const postRow = (p: (typeof posts)[number], isReply = false) => (
    <div key={p.id} style={{ padding: "10px 0", borderTop: isReply ? undefined : "1px solid var(--border)", marginLeft: isReply ? 24 : 0, opacity: p.hiddenAt ? 0.55 : 1 }}>
      <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
        <strong className="text-sm">{names.get(p.authorId) ?? "Former employee"}</strong>
        <span className="text-xs muted">{fmtTime(p.createdAt)}</span>
        {p.isPinned ? <Badge tone="brand">Pinned</Badge> : null}
        {p.hiddenAt ? <Badge tone="danger">Hidden: {p.hideReason}</Badge> : null}
      </div>
      <div className="text-sm" style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{p.body}</div>
      <div className="row gap-2 wrap">
        {active && !archived && !isReply && !p.hiddenAt ? <ActButton action={postToChannelAction} hidden={{ channelId: ch.id, parentId: p.id }} label="Reply" input={{ name: "body", placeholder: "Write a reply…", required: true }} /> : null}
        {me && p.authorId !== me && !p.hiddenAt ? <ActButton action={reportContentAction} hidden={{ targetType: "CHANNEL_POST", targetId: p.id }} label="Report" variant="ghost" input={{ name: "reason", placeholder: "What is wrong?", required: true }} /> : null}
        {mod && !isReply && !p.hiddenAt ? <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, postId: p.id, op: p.isPinned ? "unpin" : "pin" }} label={p.isPinned ? "Unpin" : "Pin"} variant="ghost" /> : null}
        {mod && !p.hiddenAt ? <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, postId: p.id, op: "hide" }} label="Hide" variant="danger" input={{ name: "reason", placeholder: "Reason", required: true }} /> : null}
        {mod && p.hiddenAt ? <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, postId: p.id, op: "restore" }} label="Restore" variant="ghost" /> : null}
      </div>
    </div>
  );
  return (
    <>
      <PageHead title={ch.name} subtitle={`${pretty(ch.kind)} · ${ch.visibility === "PRIVATE" ? "private" : "open"}${ch.postingRestricted ? " · owners start threads" : ""}${archived ? " · archived (read only)" : ""}`}
        actions={<div className="row gap-2"><Link className="btn" href="/engage/communities">All channels</Link>
          {!active && me && !archived && mine?.status !== "PENDING" ? <ActButton action={joinChannelAction} hidden={{ channelId: ch.id }} label={ch.visibility === "PRIVATE" ? "Ask to join" : "Join"} variant="primary" /> : null}
          {active ? <ActButton action={leaveChannelAction} hidden={{ channelId: ch.id }} label="Leave" variant="ghost" confirmText="Leave this channel?" /> : null}</div>} />
      {ch.description ? <p className="muted" style={{ marginBottom: 12 }}>{ch.description}</p> : null}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 16 }}>
        <div className="stack gap-4">
          {!canRead ? <Callout title="Private channel">Ask to join to read and post.</Callout> : null}
          {active && !archived && (!ch.postingRestricted || mod) ? (
            <Card title="Start a thread"><SpecForm action={postToChannelAction} hidden={{ channelId: ch.id }} submitLabel="Post" columns={1} fields={[{ name: "body", label: "Message", type: "textarea", required: true }]} /></Card>
          ) : null}
          {canRead ? (
            <Card title="Threads" tight>
              {roots.length === 0 ? <div className="muted text-sm">No posts yet.</div> : roots.map((p) => <div key={p.id}>{postRow(p)}{replies(p.id).map((r) => postRow(r, true))}</div>)}
            </Card>
          ) : null}
        </div>
        <div className="stack gap-4">
          <Card tight title={`Members (${members.filter((m) => m.status === "ACTIVE").length})`}>
            <Table head={["Member", "Role", ""]} empty={members.length === 0}>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{names.get(m.employeeId)}{m.status === "PENDING" ? <div><Pill s="PENDING" /></div> : null}</td><td>{pretty(m.role)}</td>
                  <td className="row gap-2">{mod && m.status === "ACTIVE" && m.employeeId !== me ? <>
                    {m.role !== "OWNER" ? <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, memberId: m.id, op: "promote" }} label="Promote" variant="ghost" /> : null}
                    {m.role !== "MEMBER" ? <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, memberId: m.id, op: "demote" }} label="Demote" variant="ghost" /> : null}
                    <ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, memberId: m.id, op: "remove" }} label="Remove" variant="danger" confirmText="Remove this member?" />
                  </> : null}</td>
                </tr>
              ))}
            </Table>
            {members.some((m) => m.status === "PENDING") && mod ? <div className="text-xs muted" style={{ marginTop: 8 }}>Join requests are approved in Inbox › Approvals.</div> : null}
          </Card>
          {mod ? (
            <Card title="Channel settings" key={sp.saved ?? "s"}>
              <SpecForm action={saveChannelAction} hidden={{ id: ch.id, kind: ch.kind, ...(ch.departmentId ? { departmentId: ch.departmentId } : {}) }} submitLabel="Save" columns={1} fields={[
                { name: "name", label: "Name", required: true, defaultValue: ch.name },
                { name: "visibility", label: "Who can join", type: "select", required: true, defaultValue: ch.visibility, options: [{ value: "OPEN", label: "Anyone" }, { value: "PRIVATE", label: "Private — owner approves" }] },
                { name: "postingRestricted", label: "Posting", type: "checkbox", defaultValue: ch.postingRestricted, placeholder: "Only owners and moderators start threads" },
                { name: "description", label: "Description", type: "textarea", defaultValue: ch.description },
              ]} />
              <div style={{ marginTop: 10 }}><ActButton action={moderateChannelAction} hidden={{ channelId: ch.id, op: archived ? "unarchive" : "archive" }} label={archived ? "Reopen channel" : "Archive channel"} variant="ghost" confirmText={archived ? undefined : "Archive this channel? It becomes read only."} /></div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
