import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { aiEnabled } from "@/lib/ai";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { loadOneOnOne } from "../../_parts/access";
import { AgendaEditor, AddTalkingPoint, TalkingPointToggle, NotesEditor, AddActionItem, ActionItemToggle, MeetingOps, AiSummary } from "../forms";

const when = (d: Date) => `${formatDate(d)} ${d.toISOString().slice(11, 16)} UTC`;

/** One 1:1: the shared workspace for its two people; a skip-level manager sees only that it happened. */
export default async function OneOnOnePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const r = await loadOneOnOne(viewer, id);
  if (!r) notFound();
  const me = viewer.employee!.id;
  const m = r.meeting;
  const people = await prisma.employee.findMany({ where: { id: { in: [m.organiserId, ...m.attendees.map((a) => a.employeeId)].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  const name = (pid: string | null) => people.find((p) => p.id === pid)?.displayName ?? "—";
  const room = m.roomId ? await prisma.meetingRoom.findUnique({ where: { id: m.roomId }, select: { name: true } }) : null;
  const head = (
    <PageHead
      title={m.title}
      subtitle={`${when(m.startsAt)} – ${m.endsAt.toISOString().slice(11, 16)} · ${m.attendees.filter((a) => a.attendance === "REQUIRED").map((a) => name(a.employeeId)).join(" and ")}${m.recurrence !== "NONE" ? ` · repeats ${m.recurrence.toLowerCase()}` : ""}`}
      actions={<Link className="btn ghost" href="/performance/one-on-ones">All 1:1s</Link>}
    />
  );
  if (r.access !== "PARTICIPANT") {
    return <>{head}<Callout tone="info" title={`This 1:1 is ${m.status.toLowerCase()}`}>Only the two people in a 1:1 can read its agenda and notes.</Callout></>;
  }

  const [points, items, carried, privateNote] = await Promise.all([
    prisma.meetingTalkingPoint.findMany({ where: { meetingId: m.id }, include: { author: { select: { displayName: true } } }, orderBy: { displayOrder: "asc" } }),
    prisma.meetingActionItem.findMany({ where: { meetingId: m.id }, include: { owner: { select: { displayName: true } } }, orderBy: { createdAt: "asc" } }),
    r.pair ? prisma.meetingActionItem.findMany({
      where: { meetingId: { not: m.id }, status: { in: ["OPEN", "IN_PROGRESS"] }, meeting: { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", startsAt: { lt: m.startsAt }, AND: r.pair.map((pid) => ({ attendees: { some: { employeeId: pid } } })) } },
      include: { owner: { select: { displayName: true } }, meeting: { select: { startsAt: true } } }, orderBy: { createdAt: "asc" }, take: 20,
    }) : [],
    prisma.meetingPrivateNote.findUnique({ where: { meetingId_authorId: { meetingId: m.id, authorId: me } } }),
  ]);
  const saved = m.aiSummary as { summary?: string; decisions?: string[] } | null;
  const started = m.startsAt.getTime() <= Date.now();
  const owners = people.map((p) => ({ value: p.id, label: p.id === me ? "Me" : p.displayName ?? "" }));

  return (
    <>
      {head}
      <div className="row gap-2" style={{ marginBottom: 14, alignItems: "center" }}>
        <Badge tone={m.status === "COMPLETED" ? "success" : m.status === "CANCELLED" ? "neutral" : "info"}>{m.status.toLowerCase()}</Badge>
        {m.meetingUrl ? <a className="btn sm" href={m.meetingUrl} target="_blank" rel="noreferrer">Join call</a> : room ? <span className="text-sm">Room: {room.name}</span> : null}
        <MeetingOps meetingId={m.id} canComplete={m.status === "SCHEDULED" && started} canCancel={m.status === "SCHEDULED" && m.organiserId === me} series={!!m.seriesId} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 2fr)", gap: 18, alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Agenda"><AgendaEditor meetingId={m.id} agenda={m.agenda ?? ""} purpose={m.purpose ?? ""} /></Card>
          <Card title={`Talking points (${points.length})`}>
            <div className="stack gap-2">
              {points.map((p) => (
                <div key={p.id} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <span className="text-sm" style={p.isDone ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{p.text} <span className="text-xs subtle">· {p.authorId === me ? "you" : p.author.displayName}</span></span>
                  <TalkingPointToggle id={p.id} done={p.isDone} mine={p.authorId === me} />
                </div>
              ))}
              <AddTalkingPoint meetingId={m.id} />
            </div>
          </Card>
          <Card title="Shared notes" description="Both of you can read and edit these."><NotesEditor meetingId={m.id} value={m.minutes ?? ""} kind="shared" /></Card>
          {saved?.summary ? (
            <Card title="Summary" description={m.aiSummaryAt ? `Saved ${formatDate(m.aiSummaryAt)}` : undefined}>
              <p className="text-sm" style={{ marginTop: 0 }}>{saved.summary}</p>
              {saved.decisions?.length ? <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>{saved.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
            </Card>
          ) : null}
          {aiEnabled() && started ? <Card title="AI summary" description="Uses the agenda, talking points, shared notes and action items. Private notes are never sent."><AiSummary meetingId={m.id} /></Card> : null}
        </div>
        <div className="stack gap-4">
          <Card title="Action items">
            <div className="stack gap-2">
              {items.length === 0 ? <div className="text-sm subtle">None yet.</div> : items.map((i) => (
                <div key={i.id} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <span className="text-sm" style={i.status === "DONE" ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{i.description}<div className="text-xs subtle">{i.ownerId === me ? "you" : i.owner?.displayName ?? "—"}{i.dueDate ? ` · due ${formatDate(i.dueDate)}` : ""}</div></span>
                  <ActionItemToggle id={i.id} done={i.status === "DONE"} />
                </div>
              ))}
              <AddActionItem meetingId={m.id} people={owners} />
            </div>
          </Card>
          {carried.length ? (
            <Card title="Still open from earlier 1:1s">
              <div className="stack gap-2">
                {carried.map((i) => (
                  <div key={i.id} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                    <span className="text-sm">{i.description}<div className="text-xs subtle">{i.ownerId === me ? "you" : i.owner?.displayName ?? "—"} · from {formatDate(i.meeting.startsAt)}</div></span>
                    <ActionItemToggle id={i.id} done={false} viewing={m.id} />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <Card title="Private note" description="Only you can see this. It is never shared or sent to AI."><NotesEditor meetingId={m.id} value={privateNote?.body ?? ""} kind="private" /></Card>
          {items.length === 0 && points.length === 0 && !m.agenda ? <Empty title="Add a talking point to get started" /> : null}
        </div>
      </div>
    </>
  );
}
