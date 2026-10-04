import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { departmentOptions } from "@/lib/governance";
import { fmtTime, matches, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat, Badge } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { ActButton } from "@/components/gov-forms";
import { eventOpAction, rsvpAction } from "@/app/actions/engage-comms";
import { EventForm } from "./event-form";
import { withdrawWorkflowAction } from "@/app/actions/workflows";

const P = PERMISSIONS;
const ALL_TABS = { calendar: "Calendar", mine: "My events", propose: "Propose an event", manage: "Manage", reports: "Reports" };
type Tab = keyof typeof ALL_TABS;
const IST = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);

/** Company events calendar: month view and upcoming list with RSVP, proposals with approval, management and attendance reports. */
export default async function EventsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const comms = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => comms || !["manage", "reports"].includes(k))) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "calendar";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="Events" subtitle="Town halls, celebrations, health camps and team events" actions={<Link className="btn primary" href="/engage/events?tab=propose">{comms ? "New event" : "Propose an event"}</Link>} />
      <Tabs base="/engage/events" tabs={tabs} active={tab} />
      {tab === "calendar" ? <Calendar tenantId={t} me={viewer.employee?.id ?? null} month={sp.month} q={sp.q} /> : null}
      {tab === "mine" ? <Mine tenantId={t} me={viewer.employee?.id ?? null} userId={viewer.user.id} /> : null}
      {tab === "propose" ? <Propose tenantId={t} comms={comms} /> : null}
      {tab === "manage" && comms ? <Manage tenantId={t} status={sp.status} /> : null}
      {tab === "reports" && comms ? <Reports tenantId={t} /> : null}
    </>
  );
}

async function Calendar({ tenantId, me, month, q }: { tenantId: string; me: string | null; month?: string; q?: string }) {
  const now = new Date();
  const m = /^\d{4}-\d{2}$/.test(month ?? "") ? month! : istDay(now).slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const last = new Date(Date.UTC(y, mo, 1));
  const prev = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
  const next = last.toISOString().slice(0, 7);
  const emp = me ? await prisma.employee.findUnique({ where: { id: me }, select: { departmentId: true } }) : null;
  const events = (await prisma.companyEvent.findMany({
    where: { tenantId, status: "PUBLISHED", OR: [{ startsAt: { gte: new Date(first.getTime() - IST), lt: new Date(last.getTime() - IST) } }, { startsAt: { gte: now } }] },
    orderBy: { startsAt: "asc" },
    include: { rsvps: { where: { employeeId: me ?? "__none__" }, select: { response: true } }, _count: { select: { rsvps: { where: { response: "GOING" } } } } },
  })).filter((e) => (!e.departmentIds.length || e.departmentIds.includes(emp?.departmentId ?? "")) && matches(q, e.title, e.description, e.location));
  const inMonth = events.filter((e) => istDay(e.startsAt).startsWith(m));
  const upcoming = events.filter((e) => e.endsAt >= now).slice(0, 20);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2"><input type="hidden" name="month" value={m} /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search events…" /><button className="btn sm">Search</button></form>
      <Card title={first.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })} action={<div className="row gap-2"><Link className="btn sm ghost" href={`/engage/events?month=${prev}`}>Previous</Link><Link className="btn sm ghost" href={`/engage/events?month=${next}`}>Next</Link></div>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="text-xs muted strong" style={{ textAlign: "center" }}>{d}</div>)}
          {cells.map((d, i) => {
            const key = d ? `${m}-${String(d).padStart(2, "0")}` : `x${i}`;
            const evs = d ? inMonth.filter((e) => istDay(e.startsAt) === key) : [];
            return (
              <div key={key} style={{ minHeight: 64, border: "1px solid var(--border)", borderRadius: 6, padding: 4, background: d ? undefined : "var(--surface-2, transparent)" }}>
                {d ? <div className="text-xs muted">{d}</div> : null}
                {evs.map((e) => <Link key={e.id} href={`/engage/events/${e.id}`} className="text-xs" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</Link>)}
              </div>
            );
          })}
        </div>
      </Card>
      <Card tight title="Upcoming">
        {upcoming.length === 0 ? <div className="muted text-sm">Nothing scheduled.</div> : (
          <Table head={["When", "Event", "Where", "Places", "You", ""]}>
            {upcoming.map((e) => (
              <tr key={e.id}>
                <td className="text-xs">{fmtTime(e.startsAt)}</td>
                <td><Link className="strong" href={`/engage/events/${e.id}`}>{e.title}</Link><div className="text-xs muted">{pretty(e.kind)}</div></td>
                <td className="text-xs">{e.location ?? ""}{e.onlineUrl ? " · online" : ""}</td>
                <td>{e.capacity ? `${e._count.rsvps} / ${e.capacity}` : e._count.rsvps}</td>
                <td>{e.rsvps[0] ? <Pill s={e.rsvps[0].response} /> : "—"}</td>
                <td className="row gap-2">{me ? <>
                  {e.rsvps[0]?.response !== "GOING" && e.rsvps[0]?.response !== "WAITLIST" ? <ActButton action={rsvpAction} hidden={{ eventId: e.id, response: "GOING" }} label="Going" variant="primary" /> : null}
                  {e.rsvps[0]?.response !== "DECLINED" ? <ActButton action={rsvpAction} hidden={{ eventId: e.id, response: "DECLINED" }} label="Can't go" variant="ghost" /> : null}
                </> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

async function Mine({ tenantId, me, userId }: { tenantId: string; me: string | null; userId: string }) {
  const [rsvps, organised] = await Promise.all([
    me ? prisma.eventRsvp.findMany({ where: { employeeId: me, event: { tenantId } }, include: { event: true }, orderBy: { event: { startsAt: "desc" } } }) : Promise.resolve([]),
    prisma.companyEvent.findMany({ where: { tenantId, createdBy: userId }, orderBy: { startsAt: "desc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title="My RSVPs">
        <Table head={["When", "Event", "My response", "Attended"]} empty={rsvps.length === 0}>
          {rsvps.map((r) => <tr key={r.id}><td className="text-xs">{fmtTime(r.event.startsAt)}</td><td><Link href={`/engage/events/${r.eventId}`}>{r.event.title}</Link>{r.event.status === "CANCELLED" ? <span className="text-xs neg"> (cancelled)</span> : null}</td><td><Pill s={r.response} /></td><td>{r.attended === null ? "—" : r.attended ? "Yes" : "No"}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="Events I organise">
        <Table head={["When", "Event", "Status", ""]} empty={organised.length === 0}>
          {organised.map((e) => (
            <tr key={e.id}>
              <td className="text-xs">{fmtTime(e.startsAt)}</td><td><Link href={`/engage/events/${e.id}`}>{e.title}</Link></td><td><Pill s={e.status} /></td>
              <td className="row gap-2">
                {["DRAFT", "REJECTED"].includes(e.status) ? <ActButton action={eventOpAction} hidden={{ id: e.id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
                {e.status === "PENDING_APPROVAL" && e.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: e.workflowRequestId }} label="Withdraw" variant="ghost" /> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Propose({ tenantId, comms }: { tenantId: string; comms: boolean }) {
  const depts = await departmentOptions(tenantId);
  return (
    <Card title={comms ? "New event" : "Propose an event"} description={comms ? "Publish straight to the calendar, or keep it as a draft." : "Saved as a draft; submit it from My events and communications approve it (Inbox › Approvals). Times are IST."}>
      <EventForm depts={depts} comms={comms} />
    </Card>
  );
}

async function Manage({ tenantId, status }: { tenantId: string; status?: string }) {
  const rows = await prisma.companyEvent.findMany({ where: { tenantId, ...(status ? { status } : {}) }, orderBy: { startsAt: "desc" }, take: 200, include: { _count: { select: { rsvps: { where: { response: "GOING" } } } } } });
  return (
    <Card tight title="All events" action={<a className="btn sm" href="/engage/export?report=events">Export CSV</a>}>
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="manage" />
        <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 180 }}><option value="">Any status</option>{["DRAFT", "PENDING_APPROVAL", "PUBLISHED", "CANCELLED", "REJECTED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
        <button className="btn sm">Filter</button></form>
      <Table head={["When", "Event", "Kind", "Going", "Status", ""]} empty={rows.length === 0}>
        {rows.map((e) => (
          <tr key={e.id}>
            <td className="text-xs">{fmtTime(e.startsAt)}</td><td><Link href={`/engage/events/${e.id}`}>{e.title}</Link></td><td>{pretty(e.kind)}</td><td>{e._count.rsvps}{e.capacity ? ` / ${e.capacity}` : ""}</td><td><Pill s={e.status} /></td>
            <td className="row gap-2">
              {["DRAFT", "REJECTED"].includes(e.status) ? <ActButton action={eventOpAction} hidden={{ id: e.id, op: "publish" }} label="Publish" variant="primary" /> : null}
              {e.status === "PUBLISHED" ? <ActButton action={eventOpAction} hidden={{ id: e.id, op: "cancel" }} label="Cancel" variant="danger" input={{ name: "reason", placeholder: "Reason (sent to attendees)" }} confirmText="Cancel this event?" /> : null}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Reports({ tenantId }: { tenantId: string }) {
  const rows = await prisma.companyEvent.findMany({ where: { tenantId, status: "PUBLISHED", startsAt: { lte: new Date() } }, orderBy: { startsAt: "desc" }, take: 50, include: { rsvps: { select: { response: true, attended: true } } } });
  const going = rows.reduce((s, e) => s + e.rsvps.filter((r) => r.response === "GOING").length, 0);
  const attended = rows.reduce((s, e) => s + e.rsvps.filter((r) => r.attended).length, 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Past events" value={rows.length} />
        <Stat label="RSVP'd going" value={going} />
        <Stat label="Show-up rate" value={going ? `${Math.round((attended / going) * 100)}%` : "—"} />
      </div>
      <Card tight title="Attendance by event" action={<a className="btn sm" href="/engage/export?report=events">Export CSV</a>}>
        {rows.length === 0 ? <Callout title="No past events">Attendance appears after events take place.</Callout> : (
          <Table head={["Event", "When", "Going", "Maybe", "Declined", "Waitlist", "Attended", ""]}>
            {rows.map((e) => {
              const c = (s: string) => e.rsvps.filter((r) => r.response === s).length;
              return <tr key={e.id}><td><Link href={`/engage/events/${e.id}`}>{e.title}</Link></td><td className="text-xs">{fmtTime(e.startsAt)}</td><td>{c("GOING")}</td><td>{c("MAYBE")}</td><td>{c("DECLINED")}</td><td>{c("WAITLIST")}</td><td>{e.rsvps.filter((r) => r.attended).length}</td><td><a className="btn sm ghost" href={`/engage/export?report=event-rsvps&id=${e.id}`}>CSV</a></td></tr>;
            })}
          </Table>
        )}
      </Card>
      <div className="text-xs muted"><Badge>Tip</Badge> Mark attendance on each event&apos;s page.</div>
    </div>
  );
}
