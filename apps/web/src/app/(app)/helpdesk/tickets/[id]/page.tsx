import { notFound, redirect } from "next/navigation";
import { requireViewer, can } from "@/lib/context";
import { PERMISSIONS } from "@keka/rbac";
import { HelpdeskTabs } from "../../_ui/tabs";
import { ticketAccess } from "../../_ui/ticket-access";
import { loadTicket } from "../../_ui/ticket-data";
import { Thread } from "../../_ui/thread";
import { Composer } from "../../_ui/composer";
import { DetailsPanel, FollowersPanel, NotesPanel, AssignToMe, AiSummary } from "../../_ui/ticket-panels";
import { BackLink, Initials, StatusPill } from "../../_ui/bits";
import { SlaHint } from "../../_ui/sla";
import { CaseOps, loadCaseOps } from "../../_ui/case-ops";
import { bannerTime, dayTime } from "../../_ui/format";
import s from "../../_ui/hd.module.css";

/**
 * A ticket as an agent works it (Org › Helpdesk › Tickets): the thread with
 * a reply box, and side panels for its details, followers and internal
 * notes. The raiser and followers are sent to their own view.
 */
export default async function AgentTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const a = await ticketAccess(viewer, id);
  if (!a) notFound();
  if (!a.agent) {
    if (a.own || a.follower) redirect(`/me/helpdesk/${id}`);
    notFound();
  }
  const t = await loadTicket(viewer, id, true);
  const ag = t.agentData!;
  const ops = await loadCaseOps(viewer.tenantId, t.id);
  const awaitingFirst = !t.closed && !t.firstResponseAt && t.firstResponseDueAt;

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings={can(viewer, PERMISSIONS.HELPDESK_SETTINGS)} active="/helpdesk/tickets" />
      <div className={s.topBar}><BackLink href={t.closed ? "/helpdesk/tickets?tab=closed" : "/helpdesk/tickets"} /></div>
      <div className={s.detailGrid}>
        <div className={s.panel}>
          <div className={s.ticketHead}>
            <div style={{ minWidth: 0 }}>
              <span className={s.ticketNoAgent}>#{t.number}</span>
              <span className={s.ticketTitle}>{t.subject}</span>
              <div className={s.sub}>{t.category} · raised {dayTime(t.createdAt)}</div>
            </div>
            <div className={s.headRight}>
              <SlaHint t={t} />
              <StatusPill status={t.status} />
              {!ag.mine && !t.closed ? <AssignToMe ticketId={t.id} /> : null}
            </div>
          </div>
          {awaitingFirst ? <div className={s.respondBy} style={{ marginTop: 16 }}>Please respond by {bannerTime(t.firstResponseDueAt!)}</div> : null}
          <div style={{ padding: "14px 20px 0" }}><AiSummary ticketId={t.id} /></div>
          <Thread
            opening={{ authorLabel: t.raiser.name, body: t.description, createdAt: t.createdAt, files: t.openingFiles, mine: false }}
            items={t.items}
            mineUserIds={new Set(t.items.filter((c) => c.authorUserId && c.authorUserId !== t.raiser.userId).map((c) => c.authorUserId!))}
          />
          {t.closed ? (
            <div className={s.respondBy} style={{ marginBottom: 20 }}>
              This ticket is closed{t.closingReason ? ` · ${t.closingReason}` : ""}{t.closedBy ? ` · by ${t.closedBy}` : ""}. Change its status to reopen it.
            </div>
          ) : <Composer ticketId={t.id} agent canned={ag.canned} reasons={ag.reasons} onHold={t.onHold} />}
        </div>

        <div className={s.side}>
          <div className={s.sideCard}>
            <div className={s.sideHead}>Raised by</div>
            <div className={s.sideBody}>
              <div className={s.raiser}>
                <Initials name={t.raiser.name} size={40} photoUrl={t.raiser.photoUrl} />
                <div>
                  <div className={s.raiserName}>{t.raiser.name}</div>
                  <div className={s.raiserMeta}>{[t.raiser.number, t.raiser.title, t.raiser.department].filter(Boolean).join(" · ")}</div>
                </div>
              </div>
              {t.raiser.location ? <div className={s.location}>{t.raiser.location}</div> : null}
            </div>
          </div>
          <div className={s.sideCard}>
            <div className={s.sideHead}>Ticket details</div>
            <div className={s.sideBody}>
              <DetailsPanel
                ticketId={t.id} status={t.status} priority={t.priority} categoryId={t.categoryId} assigneeUserId={t.assigneeUserId}
                categories={ag.categories} assignees={ag.assignees} reasons={ag.reasons} onHold={t.onHold}
              />
            </div>
          </div>
          <div className={s.sideCard}>
            <div className={s.sideHead}>Followers</div>
            <div className={s.sideBody}><FollowersPanel ticketId={t.id} followers={t.followers} roles={ag.roles} people={ag.people} /></div>
          </div>
          <div className={s.sideCard}>
            <div className={s.sideHead}>Notes</div>
            <div className={s.sideBody}><NotesPanel ticketId={t.id} notes={ag.notes} /></div>
          </div>
          <CaseOps data={ops} ticketId={t.id} viewerUserId={viewer.user.id} closed={t.closed} categories={ag.categories} />
        </div>
      </div>
    </div>
  );
}
