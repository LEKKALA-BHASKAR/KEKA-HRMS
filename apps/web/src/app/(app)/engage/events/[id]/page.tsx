import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { departmentOptions } from "@/lib/governance";
import { employeeNames, fmtDay, fmtTime, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Badge, Stat } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { rsvpAction, eventOpAction, markAttendanceAction, askQuestionAction, voteQuestionAction, answerQuestionAction } from "@/app/actions/engage-comms";
import { EventForm } from "../event-form";

/** One event: details, RSVP (with waitlist), questions for town halls, and for organisers the guest list, attendance and editing. */
export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const e = await prisma.companyEvent.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { rsvps: { orderBy: { createdAt: "asc" } }, questions: { orderBy: { createdAt: "asc" } } } });
  if (!e) notFound();
  const comms = can(viewer, PERMISSIONS.ANNOUNCEMENT_MANAGE);
  const organiser = e.createdBy === viewer.user.id;
  if (e.status !== "PUBLISHED" && e.status !== "CANCELLED" && !comms && !organiser) notFound();
  const me = viewer.employee?.id ?? null;
  const mine = me ? e.rsvps.find((r) => r.employeeId === me) : undefined;
  const names = await employeeNames(viewer.tenantId, [...e.rsvps.map((r) => r.employeeId), ...e.questions.map((q) => q.authorId)]);
  const count = (s: string) => e.rsvps.filter((r) => r.response === s).length;
  const going = count("GOING");
  const now = new Date();
  const open = e.status === "PUBLISHED" && e.endsAt > now && !(e.rsvpBy && e.rsvpBy.getTime() + 86_400_000 < now.getTime());
  const questions = e.questions.filter((q) => q.status !== "HIDDEN" || comms).sort((a, b) => b.voterIds.length - a.voterIds.length);
  const attendees = e.rsvps.filter((r) => r.response === "GOING" || r.response === "MAYBE");
  return (
    <>
      <PageHead title={e.title} subtitle={`${pretty(e.kind)} · ${fmtTime(e.startsAt)} – ${fmtTime(e.endsAt)}`} actions={<div className="row gap-2"><Pill s={e.status} /><Link className="btn" href="/engage/events">Calendar</Link></div>} />
      {e.status === "CANCELLED" ? <Callout tone="danger" title="This event was cancelled">Attendees were notified.</Callout> : null}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 16 }}>
        <div className="stack gap-4">
          <Card title="About">
            {e.description ? <p style={{ whiteSpace: "pre-wrap" }}>{e.description}</p> : null}
            <div className="text-sm">{e.location ? <div>Venue: {e.location}</div> : null}{e.onlineUrl ? <div>Online: <a href={e.onlineUrl} target="_blank" rel="noreferrer">{e.onlineUrl}</a></div> : null}{e.rsvpBy ? <div>RSVP by {fmtDay(e.rsvpBy)}</div> : null}</div>
          </Card>
          {e.allowQuestions ? (
            <Card title="Questions" description="Upvote what you most want answered.">
              {e.status === "PUBLISHED" && me ? <SpecForm action={askQuestionAction} hidden={{ eventId: e.id }} submitLabel="Ask" columns={1} fields={[{ name: "body", label: "Your question", type: "textarea", required: true }, { name: "anonymous", label: "Anonymous", type: "checkbox", placeholder: "Ask anonymously" }]} /> : null}
              <div className="stack gap-2" style={{ marginTop: 12 }}>
                {questions.length === 0 ? <div className="muted text-sm">No questions yet.</div> : questions.map((q) => (
                  <div key={q.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, opacity: q.status === "HIDDEN" ? 0.5 : 1 }}>
                    <div className="row gap-2 wrap" style={{ alignItems: "center" }}><strong className="text-sm">{q.body}</strong>{q.status !== "OPEN" ? <Pill s={q.status} /> : null}</div>
                    <div className="text-xs muted">{q.authorId ? names.get(q.authorId) : "Anonymous"} · {q.voterIds.length} vote{q.voterIds.length === 1 ? "" : "s"}</div>
                    {q.answer ? <div className="text-sm" style={{ marginTop: 4 }}><Badge tone="success">Answer</Badge> {q.answer}</div> : null}
                    <div className="row gap-2 wrap" style={{ marginTop: 4 }}>
                      {me && q.status !== "HIDDEN" ? <ActButton action={voteQuestionAction} hidden={{ questionId: q.id }} label={q.voterIds.includes(me) ? "Remove vote" : "Upvote"} variant="ghost" /> : null}
                      {comms && q.status === "OPEN" ? <><ActButton action={answerQuestionAction} hidden={{ questionId: q.id, op: "answer" }} label="Answer" input={{ name: "answer", placeholder: "Answer", required: true }} /><ActButton action={answerQuestionAction} hidden={{ questionId: q.id, op: "hide" }} label="Hide" variant="danger" /></> : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          {(comms || organiser) ? (
            <Card tight title="Guest list" action={<a className="btn sm" href={`/engage/export?report=event-rsvps&id=${e.id}`}>Export CSV</a>}>
              <Table head={["Employee", "Response", "Since", "Attended"]} empty={e.rsvps.length === 0}>
                {e.rsvps.map((r) => <tr key={r.id}><td>{names.get(r.employeeId)}</td><td><Pill s={r.response} /></td><td className="text-xs">{fmtDay(r.createdAt)}</td><td>{r.attended === null ? "—" : r.attended ? "Yes" : "No"}</td></tr>)}
              </Table>
              {comms && e.startsAt <= now && attendees.length ? (
                <div style={{ marginTop: 12 }}>
                  <SpecForm action={markAttendanceAction} hidden={{ eventId: e.id }} submitLabel="Save attendance" columns={1} fields={[
                    { name: "attended", label: "Who attended", type: "multiselect", options: attendees.map((r) => ({ value: r.employeeId, label: names.get(r.employeeId) ?? r.employeeId })), defaultValue: attendees.filter((r) => r.attended).map((r) => r.employeeId) },
                  ]} />
                </div>
              ) : null}
            </Card>
          ) : null}
          {(comms || (organiser && ["DRAFT", "REJECTED"].includes(e.status))) && e.status !== "CANCELLED" ? (
            <Card title="Edit event"><EventForm depts={await departmentOptions(viewer.tenantId)} comms={comms} e={e} /></Card>
          ) : null}
        </div>
        <div className="stack gap-4">
          <Stat label="Going" value={e.capacity ? `${going} / ${e.capacity}` : going} meta={`${count("MAYBE")} maybe · ${count("WAITLIST")} waitlisted`} />
          {me && open ? (
            <Card title="Will you attend?">
              {mine ? <div className="text-sm" style={{ marginBottom: 8 }}>Your response: <Pill s={mine.response} /></div> : null}
              <div className="row gap-2 wrap">
                {(["GOING", "MAYBE", "DECLINED"] as const).filter((r) => mine?.response !== r && !(r === "GOING" && mine?.response === "WAITLIST")).map((r) => <ActButton key={r} action={rsvpAction} hidden={{ eventId: e.id, response: r }} label={r === "GOING" ? "Going" : r === "MAYBE" ? "Maybe" : "Can't go"} variant={r === "GOING" ? "primary" : "ghost"} />)}
              </div>
            </Card>
          ) : null}
          {organiser && ["DRAFT", "REJECTED"].includes(e.status) ? <Card title="Submit"><ActButton action={eventOpAction} hidden={{ id: e.id, op: "submit" }} label="Submit for approval" variant="primary" /></Card> : null}
          {comms && ["DRAFT", "REJECTED"].includes(e.status) ? <Card title="Publish"><ActButton action={eventOpAction} hidden={{ id: e.id, op: "publish" }} label="Publish to the calendar" variant="primary" /></Card> : null}
          {comms && e.status === "PUBLISHED" ? <Card title="Cancel"><ActButton action={eventOpAction} hidden={{ id: e.id, op: "cancel" }} label="Cancel event" variant="danger" input={{ name: "reason", placeholder: "Reason (sent to attendees)" }} confirmText="Cancel this event?" /></Card> : null}
        </div>
      </div>
    </>
  );
}
