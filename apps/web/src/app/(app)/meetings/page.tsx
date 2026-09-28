import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat, Avatar, Callout } from "@/components/ui";
import {
  respondToMeeting, saveMeetingMinutes, addMeetingActionItem, completeActionItem,
} from "@/app/actions/workplace";

const P = PERMISSIONS;

const fmtTime = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

const RESPONSE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ACCEPTED: "success", DECLINED: "danger", TENTATIVE: "warning", PENDING: "neutral",
};

export default async function MeetingsPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; id?: string }> }) {
  const viewer = await requireAuth(P.MEETING_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.MEETING_MANAGE);
  const myId = viewer.employee?.id;
  const tab = sp.tab === "actions" ? "actions" : sp.tab === "rooms" ? "rooms" : "meetings";

  const now = new Date();

  const [meetings, rooms, myActions, employees] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        tenantId: viewer.tenantId,
        // Without manage rights you see only meetings you are in.
        ...(canManage || !myId
          ? {}
          : { OR: [{ organiserId: myId }, { attendees: { some: { employeeId: myId } } }] }),
      },
      orderBy: { startsAt: "desc" },
      take: 40,
      include: {
        room: { select: { name: true, capacity: true } },
        attendees: {
          include: {
            employee: { select: { id: true, displayName: true, jobTitleName: true } },
          },
        },
        actionItems: {
          include: { owner: { select: { id: true, displayName: true } } },
          orderBy: { dueDate: "asc" },
        },
      },
    }),
    prisma.meetingRoom.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { meetings: true } },
        meetings: {
          where: { startsAt: { gte: now } },
          orderBy: { startsAt: "asc" },
          take: 3,
          select: { id: true, title: true, startsAt: true, endsAt: true },
        },
      },
    }),
    myId
      ? prisma.meetingActionItem.findMany({
          where: { ownerId: myId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          orderBy: { dueDate: "asc" },
          include: { meeting: { select: { id: true, title: true, startsAt: true } } },
        })
      : Promise.resolve([]),
    canManage
      ? prisma.employee.findMany({
          where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
          select: { id: true, displayName: true, employeeNumber: true },
          orderBy: { firstName: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const upcoming = meetings.filter((m) => m.startsAt >= now && m.status === "SCHEDULED");
  const past = meetings.filter((m) => m.startsAt < now || m.status === "COMPLETED");
  const selected = sp.id ? meetings.find((m) => m.id === sp.id) : undefined;

  const myPendingInvites = myId
    ? upcoming.filter((m) =>
        m.attendees.some((a) => a.employeeId === myId && a.response === "PENDING"))
    : [];

  const allOpenActions = meetings.flatMap((m) =>
    m.actionItems
      .filter((a) => a.status !== "DONE" && a.status !== "CANCELLED")
      .map((a) => ({ ...a, meetingTitle: m.title })));
  const overdue = allOpenActions.filter((a) => a.dueDate && a.dueDate < now);

  return (
    <>
      <PageHead
        title="Meetings"
        subtitle={`${upcoming.length} upcoming · ${allOpenActions.length} open action items${overdue.length > 0 ? ` (${overdue.length} overdue)` : ""}`}
      />

      {myPendingInvites.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${myPendingInvites.length} invitation(s) awaiting your response`}>
            <div className="stack gap-2" style={{ marginTop: 8 }}>
              {myPendingInvites.map((m) => (
                <div key={m.id} className="row gap-2 wrap">
                  <span className="text-sm strong">{m.title}</span>
                  <span className="text-xs subtle">
                    {formatDate(m.startsAt)} {fmtTime(m.startsAt)}
                  </span>
                  {(["ACCEPTED", "TENTATIVE", "DECLINED"] as const).map((r) => (
                    <form action={respondToMeeting} key={r}>
                      <input type="hidden" name="meetingId" value={m.id} />
                      <input type="hidden" name="response" value={r} />
                      <button className={`btn sm${r === "ACCEPTED" ? " primary" : ""}`} type="submit">
                        {r === "ACCEPTED" ? "Accept" : r === "TENTATIVE" ? "Maybe" : "Decline"}
                      </button>
                    </form>
                  ))}
                </div>
              ))}
            </div>
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Upcoming" value={upcoming.length} meta="Scheduled and not yet held" />
        <Stat label="Rooms" value={rooms.length} meta={`${rooms.reduce((s, r) => s + (r.capacity ?? 0), 0)} total seats`} />
        <Stat label="Open action items" value={allOpenActions.length} meta={`${overdue.length} overdue`} />
        <Stat label="My action items" value={myActions.length} meta="Assigned to me" />
      </div>

      <div className="tabs">
        <Link href="/meetings" className={`tab${tab === "meetings" ? " active" : ""}`}>Meetings</Link>
        <Link href="/meetings?tab=actions" className={`tab${tab === "actions" ? " active" : ""}`}>
          Action items{allOpenActions.length > 0 ? ` (${allOpenActions.length})` : ""}
        </Link>
        <Link href="/meetings?tab=rooms" className={`tab${tab === "rooms" ? " active" : ""}`}>Rooms</Link>
      </div>

      {tab === "meetings" ? (
        <div className="stack gap-4">
          <Card title={`Upcoming (${upcoming.length})`} tight>
            {upcoming.length === 0 ? <Empty title="Nothing scheduled" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Meeting</th><th>When</th><th>Where</th><th>Attendees</th><th>My response</th></tr>
                  </thead>
                  <tbody>
                    {upcoming.map((m) => {
                      const mine = myId ? m.attendees.find((a) => a.employeeId === myId) : null;
                      return (
                        <tr key={m.id}>
                          <td>
                            <Link href={`/meetings?id=${m.id}`} className="strong">{m.title}</Link>
                            <div className="text-xs subtle">
                              <Badge tone="neutral">{m.meetingType.replace(/_/g, " ").toLowerCase()}</Badge>
                            </div>
                          </td>
                          <td className="text-sm nowrap">
                            {formatDate(m.startsAt)}
                            <div className="text-xs subtle">{fmtTime(m.startsAt)}–{fmtTime(m.endsAt)}</div>
                          </td>
                          <td className="text-sm">
                            {m.room?.name ?? (m.meetingUrl ? <Badge tone="info">Video</Badge> : "—")}
                          </td>
                          <td>
                            <div className="row gap-1" style={{ alignItems: "center" }}>
                              {m.attendees.slice(0, 5).map((a) => (
                                <Avatar key={a.id} name={a.employee.displayName ?? ""} size="sm" />
                              ))}
                              {m.attendees.length > 5 ? (
                                <span className="text-xs subtle">+{m.attendees.length - 5}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            {!mine ? <span className="subtle text-xs">Not invited</span>
                              : mine.response === "PENDING" ? (
                                <div className="row gap-1">
                                  {(["ACCEPTED", "DECLINED"] as const).map((r) => (
                                    <form action={respondToMeeting} key={r}>
                                      <input type="hidden" name="meetingId" value={m.id} />
                                      <input type="hidden" name="response" value={r} />
                                      <button className={`btn sm${r === "ACCEPTED" ? " primary" : ""}`} type="submit">
                                        {r === "ACCEPTED" ? "Accept" : "Decline"}
                                      </button>
                                    </form>
                                  ))}
                                </div>
                              ) : (
                                <Badge tone={RESPONSE_TONE[mine.response] ?? "neutral"} dot>
                                  {mine.response.toLowerCase()}
                                </Badge>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {selected ? (
            <Card
              title={selected.title}
              description={`${formatDate(selected.startsAt)} ${fmtTime(selected.startsAt)}–${fmtTime(selected.endsAt)} · ${selected.room?.name ?? "Video"}`}
              action={<Link className="btn sm" href="/meetings">Close</Link>}
            >
              {selected.agenda ? (
                <>
                  <div className="stat-label" style={{ marginBottom: 6 }}>Agenda</div>
                  <p className="text-sm" style={{ whiteSpace: "pre-wrap", marginBottom: 14 }}>{selected.agenda}</p>
                </>
              ) : null}

              <div className="stat-label" style={{ marginBottom: 6 }}>
                Attendees ({selected.attendees.length})
              </div>
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table className="data">
                  <thead><tr><th>Person</th><th>Required</th><th>Response</th><th>Attended</th></tr></thead>
                  <tbody>
                    {selected.attendees.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link href={`/employees/${a.employee.id}`}>
                            <Person name={a.employee.displayName ?? ""} meta={a.employee.jobTitleName} />
                          </Link>
                        </td>
                        <td className="text-sm">{a.attendance === "REQUIRED" ? "Required" : "Optional"}</td>
                        <td><Badge tone={RESPONSE_TONE[a.response] ?? "neutral"}>{a.response.toLowerCase()}</Badge></td>
                        <td>
                          {a.attended === null ? <span className="subtle">—</span>
                            : a.attended ? <Badge tone="success">Yes</Badge>
                            : <Badge tone="danger">No</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="stat-label" style={{ marginBottom: 6 }}>Minutes</div>
              {canManage ? (
                <form action={saveMeetingMinutes} className="stack gap-2" style={{ marginBottom: 16 }}>
                  <input type="hidden" name="meetingId" value={selected.id} />
                  <textarea
                    className="textarea" name="minutes" rows={4}
                    defaultValue={selected.minutes ?? ""}
                    placeholder="What was decided, and what happens next."
                  />
                  <button className="btn primary sm" type="submit" style={{ alignSelf: "flex-start" }}>
                    Save minutes &amp; mark completed
                  </button>
                </form>
              ) : (
                <p className="text-sm" style={{ whiteSpace: "pre-wrap", marginBottom: 16 }}>
                  {selected.minutes ?? <span className="subtle">No minutes recorded yet.</span>}
                </p>
              )}

              <div className="stat-label" style={{ marginBottom: 6 }}>
                Action items ({selected.actionItems.length})
              </div>
              {selected.actionItems.length === 0 ? (
                <p className="text-sm subtle" style={{ marginBottom: 10 }}>None recorded.</p>
              ) : (
                <div className="table-wrap" style={{ marginBottom: 12 }}>
                  <table className="data">
                    <thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                    <tbody>
                      {selected.actionItems.map((a) => {
                        const isOverdue = a.dueDate && a.dueDate < now && a.status !== "DONE";
                        return (
                          <tr key={a.id}>
                            <td className="text-sm">{a.description}</td>
                            <td className="text-sm">{a.owner?.displayName ?? <span className="subtle">Unassigned</span>}</td>
                            <td className={`text-sm nowrap ${isOverdue ? "neg" : ""}`}>{formatDate(a.dueDate)}</td>
                            <td>
                              {a.status === "DONE" ? (
                                <Badge tone="success" dot>done</Badge>
                              ) : (a.ownerId === myId || canManage) ? (
                                <form action={completeActionItem}>
                                  <input type="hidden" name="id" value={a.id} />
                                  <button className="btn sm" type="submit">Mark done</button>
                                </form>
                              ) : (
                                <Badge tone={isOverdue ? "danger" : "warning"}>
                                  {isOverdue ? "overdue" : a.status.toLowerCase()}
                                </Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {canManage ? (
                <form action={addMeetingActionItem} className="row gap-2 wrap">
                  <input type="hidden" name="meetingId" value={selected.id} />
                  <input className="input" name="description" placeholder="Action item" required style={{ maxWidth: 280 }} />
                  <select className="select" name="ownerId" style={{ maxWidth: 200 }}>
                    <option value="">Unassigned</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{e.displayName}</option>
                    ))}
                  </select>
                  <input className="input" name="dueDate" type="date" style={{ maxWidth: 160 }} />
                  <button className="btn" type="submit">Add</button>
                </form>
              ) : null}
            </Card>
          ) : null}

          <Card title={`Past meetings (${past.length})`} tight>
            {past.length === 0 ? <Empty title="No past meetings" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Meeting</th><th>When</th><th>Minutes</th><th className="num">Actions</th><th /></tr>
                  </thead>
                  <tbody>
                    {past.map((m) => (
                      <tr key={m.id}>
                        <td className="strong">{m.title}</td>
                        <td className="text-sm nowrap">{formatDate(m.startsAt)}</td>
                        <td>
                          {m.minutes
                            ? <Badge tone="success">Recorded</Badge>
                            : <Badge tone="warning">Not recorded</Badge>}
                        </td>
                        <td className="num">
                          {m.actionItems.filter((a) => a.status !== "DONE").length} / {m.actionItems.length}
                        </td>
                        <td className="right">
                          <Link className="btn sm" href={`/meetings?id=${m.id}`}>Open</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "actions" ? (
        <Card title={`Open action items (${allOpenActions.length})`} tight>
          {allOpenActions.length === 0 ? <Empty title="Everything is closed" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Action</th><th>From meeting</th><th>Owner</th><th>Due</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {allOpenActions.map((a) => {
                    const isOverdue = a.dueDate && a.dueDate < now;
                    return (
                      <tr key={a.id}>
                        <td className="text-sm">{a.description}</td>
                        <td className="text-sm muted">{a.meetingTitle}</td>
                        <td className="text-sm">{a.owner?.displayName ?? <span className="subtle">Unassigned</span>}</td>
                        <td className={`text-sm nowrap ${isOverdue ? "neg strong" : ""}`}>{formatDate(a.dueDate)}</td>
                        <td>
                          {(a.ownerId === myId || canManage) ? (
                            <form action={completeActionItem}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className="btn sm" type="submit">Mark done</button>
                            </form>
                          ) : (
                            <Badge tone={isOverdue ? "danger" : "warning"}>
                              {isOverdue ? "overdue" : a.status.toLowerCase()}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "rooms" ? (
        <Card title={`Meeting rooms (${rooms.length})`} tight>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Room</th><th className="num">Capacity</th><th>Facilities</th><th className="num">Bookings</th><th>Next up</th></tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">{r.name}</td>
                    <td className="num">{r.capacity ?? <span className="subtle">—</span>}</td>
                    <td>
                      <div className="row gap-1 wrap">
                        {((r.facilities ?? []) as string[]).map((f) => (
                          <Badge key={f} tone="neutral">{f}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="num">{r._count.meetings}</td>
                    <td className="text-sm">
                      {r.meetings.length === 0 ? <span className="subtle">Free</span> : (
                        <>
                          {r.meetings[0].title}
                          <div className="text-xs subtle">
                            {formatDate(r.meetings[0].startsAt)} {fmtTime(r.meetings[0].startsAt)}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
