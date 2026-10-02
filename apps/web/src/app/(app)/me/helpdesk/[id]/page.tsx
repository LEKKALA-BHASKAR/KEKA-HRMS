import { notFound, redirect } from "next/navigation";
import { requireViewer } from "@/lib/context";
import { ticketAccess } from "../../../helpdesk/_ui/ticket-access";
import { loadTicket } from "../../../helpdesk/_ui/ticket-data";
import { Thread } from "../../../helpdesk/_ui/thread";
import { Composer } from "../../../helpdesk/_ui/composer";
import { ReopenTicket, RateTicket, CloseOwnTicket } from "../../../helpdesk/_ui/ticket-panels";
import { BackLink, PriorityPill, StatusPill } from "../../../helpdesk/_ui/bits";
import { day, dayPlain } from "../../../helpdesk/_ui/format";
import s from "../../../helpdesk/_ui/hd.module.css";

/**
 * A ticket as the employee who raised it sees it (Me › Helpdesk), and as its
 * followers read it. Internal notes never reach this page. Agents opening a
 * ticket they work are sent to the agent view.
 */
export default async function MyTicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ raised?: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const sp = await searchParams;
  const a = await ticketAccess(viewer, id);
  if (!a) notFound();
  if (!a.own && !a.follower) {
    if (a.agent) redirect(`/helpdesk/tickets/${id}`);
    notFound();
  }
  const t = await loadTicket(viewer, id, false);
  const mine = new Set([t.raiser.userId].filter((x): x is string => !!x));

  return (
    <div className={s.page}>
      <div className={s.topBar}><BackLink href={a.follower ? "/me/helpdesk?tab=following" : t.closed ? "/me/helpdesk?tab=closed" : "/me/helpdesk"} /></div>
      {sp.raised && a.own ? <div className="callout success"><div>Ticket #{t.number} added successfully. We will reply here.</div></div> : null}
      <div className={s.detailGrid}>
        <div className={s.panel}>
          <div className={s.ticketHead}>
            <div style={{ minWidth: 0 }}>
              <span className={s.ticketNo}>#{t.number}</span>
              <span className={s.ticketTitle}>{t.subject}</span>
              <div className={s.sub}>Ticket raised on {dayPlain(t.createdAt)}{a.follower ? ` by ${t.raiser.name}` : ""}</div>
            </div>
            <div className={s.headRight}><StatusPill status={t.status} /></div>
          </div>
          <Thread
            opening={{ authorLabel: t.raiser.name, body: t.description, createdAt: t.createdAt, files: t.openingFiles, mine: a.own }}
            items={t.items}
            mineUserIds={a.own ? mine : new Set()}
          />
          {a.own && !t.closed ? <Composer ticketId={t.id} agent={false} /> : null}
          {t.closed ? (
            <div className={s.respondBy} style={{ marginBottom: 20 }}>
              This ticket was closed on {day(t.closedAt)}{t.closingReason ? ` · ${t.closingReason}` : ""}.
              {a.own ? (t.canReopen ? " Not sorted? Reopen it." : " Raise a new ticket if you still need help.") : ""}
            </div>
          ) : null}
          {a.follower && !t.closed ? <div className={s.hint} style={{ padding: "0 20px 20px" }}>You are following this ticket. Only {t.raiser.name} and the helpdesk team can reply.</div> : null}
        </div>

        <div className={s.side}>
          <div className={s.sideCard}>
            <div className={s.sideHead}>Ticket details</div>
            <div className={s.sideBody}>
              <div className={s.fieldLabel}>Category</div><div className={s.fieldValue}>{t.category}</div>
              <div className={s.fieldLabel}>Priority</div><div className={s.fieldValue}><PriorityPill p={t.priority} /></div>
              <div className={s.fieldLabel}>Assigned to</div><div className={s.fieldValue}>{t.assignee ?? "Not assigned yet"}</div>
              {t.followers.length ? (<><div className={s.fieldLabel}>Followers</div><div className={s.fieldValue}>{t.followers.map((f) => f.name).join(", ")}</div></>) : null}
            </div>
            {a.own ? (
              <div className={s.sideBody}>
                {!t.closed ? <CloseOwnTicket ticketId={t.id} /> : null}
                {t.closed && t.canReopen ? <ReopenTicket ticketId={t.id} /> : null}
                {t.closed ? <div style={{ marginTop: t.canReopen ? 16 : 0 }}><RateTicket ticketId={t.id} current={t.satisfaction} /></div> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
