import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, Stat, Person } from "@/components/ui";
import { publishAnnouncement, acknowledgeAnnouncement, archiveAnnouncement } from "@/app/actions/workplace";

const P = PERMISSIONS;

export default async function AnnouncementsPage() {
  const viewer = await requireAuth(P.ANNOUNCEMENT_VIEW);
  const canManage = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const myId = viewer.employee?.id;

  const [announcements, headcount] = await Promise.all([
    prisma.announcement.findMany({
      where: {
        tenantId: viewer.tenantId,
        // Employees see only what is live; managers see drafts and scheduled too.
        ...(canManage ? {} : { status: "PUBLISHED" }),
      },
      orderBy: [{ isPinned: "desc" }, { publishAt: "desc" }, { createdAt: "desc" }],
      include: {
        // Scoped to this viewer, but included unconditionally so the row type
        // keeps the relation.
        reads: {
          where: { employeeId: myId ?? "__none__" },
          select: { viewedAt: true, acknowledgedAt: true },
        },
        _count: { select: { reads: true } },
      },
    }),
    prisma.employee.count({
      where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
    }),
  ]);

  // Acknowledgement counts, for the ones that require it.
  const ackRequiring = announcements.filter((a) => a.requireAck).map((a) => a.id);
  const ackCounts = ackRequiring.length > 0
    ? await prisma.announcementRead.groupBy({
        by: ["announcementId"],
        where: { announcementId: { in: ackRequiring }, acknowledgedAt: { not: null } },
        _count: true,
      })
    : [];
  const ackByAnnouncement = new Map(ackCounts.map((a) => [a.announcementId, a._count]));

  const live = announcements.filter((a) => a.status === "PUBLISHED");
  const pendingMyAck = live.filter(
    (a) => a.requireAck && (a.reads.length === 0 || !a.reads[0].acknowledgedAt),
  );

  return (
    <>
      <PageHead
        title="Announcements"
        subtitle={`${live.length} live${pendingMyAck.length > 0 ? ` · ${pendingMyAck.length} needing your acknowledgement` : ""}`}
      />

      {canManage ? (
        <div className="grid grid-3" style={{ marginBottom: 18 }}>
          <Stat label="Live" value={live.length} meta="Visible to employees now" />
          <Stat
            label="Awaiting acknowledgement"
            value={live.filter((a) => a.requireAck && (ackByAnnouncement.get(a.id) ?? 0) < headcount).length}
            meta="Not yet acknowledged by everyone"
          />
          <Stat label="Scheduled or draft" value={announcements.length - live.length} meta="Not yet visible" />
        </div>
      ) : null}

      {canManage ? (
        <Card
          title="Publish an announcement"
          description="Published immediately. Tick acknowledgement when you need a record that people have read it."
        >
          <form action={publishAnnouncement} className="stack gap-3">
            <div className="field" style={{ margin: 0 }}>
              <label className="label" htmlFor="title">Title</label>
              <input id="title" className="input" name="title" required maxLength={200} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label className="label" htmlFor="body">Body</label>
              <textarea id="body" className="textarea" name="body" required rows={4} />
            </div>
            <div className="row gap-4 wrap">
              <div className="field" style={{ margin: 0 }}>
                <label className="label" htmlFor="expiresAt">Expires on</label>
                <input id="expiresAt" className="input" name="expiresAt" type="date" style={{ width: 170 }} />
              </div>
              <label className="row gap-2 text-sm nowrap" style={{ alignSelf: "flex-end", paddingBottom: 8 }}>
                <input type="checkbox" name="requireAck" /> Require acknowledgement
              </label>
              <label className="row gap-2 text-sm nowrap" style={{ alignSelf: "flex-end", paddingBottom: 8 }}>
                <input type="checkbox" name="isPinned" /> Pin to the top
              </label>
              <label className="row gap-2 text-sm nowrap" style={{ alignSelf: "flex-end", paddingBottom: 8 }}>
                <input type="checkbox" name="notifyByEmail" /> Email employees
              </label>
              <button className="btn primary" type="submit" style={{ alignSelf: "flex-end", marginBottom: 8 }}>
                Publish
              </button>
            </div>
          </form>
        </Card>
      ) : null}

      <div style={{ height: 16 }} />

      {announcements.length === 0 ? (
        <Card><Empty title="No announcements yet" /></Card>
      ) : (
        <div className="stack gap-3">
          {announcements.map((a) => {
            const myRead = a.reads.length > 0 ? a.reads[0] : null;
            const ackCount = ackByAnnouncement.get(a.id) ?? 0;
            const needsMyAck = a.requireAck && a.status === "PUBLISHED" && !myRead?.acknowledgedAt;

            return (
              <div
                key={a.id}
                className="card"
                style={needsMyAck ? { borderColor: "var(--warning)" } : undefined}
              >
                <div className="card-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="row gap-2 wrap">
                      <span className="card-title">{a.title}</span>
                      {a.isPinned ? <Badge tone="brand">Pinned</Badge> : null}
                      {a.status !== "PUBLISHED" ? (
                        <Badge tone={a.status === "SCHEDULED" ? "info" : "neutral"}>
                          {a.status.toLowerCase()}
                        </Badge>
                      ) : null}
                      {a.requireAck ? <Badge tone="warning">Acknowledgement required</Badge> : null}
                    </div>
                    <div className="card-desc">
                      {a.status === "SCHEDULED"
                        ? `Publishes ${formatDate(a.publishAt)}`
                        : `Published ${formatDate(a.publishAt)}`}
                      {a.expiresAt ? ` · expires ${formatDate(a.expiresAt)}` : ""}
                    </div>
                  </div>
                  {canManage && a.status === "PUBLISHED" ? (
                    <form action={archiveAnnouncement}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn ghost sm" type="submit">Archive</button>
                    </form>
                  ) : null}
                </div>

                <div className="card-body">
                  <p style={{ whiteSpace: "pre-wrap", marginBottom: 14 }}>{a.body}</p>

                  <div className="row gap-3 wrap" style={{ justifyContent: "space-between" }}>
                    {needsMyAck ? (
                      <form action={acknowledgeAnnouncement}>
                        <input type="hidden" name="announcementId" value={a.id} />
                        <button className="btn primary sm" type="submit">
                          I have read and understood this
                        </button>
                      </form>
                    ) : myRead?.acknowledgedAt ? (
                      <Badge tone="success" dot>
                        Acknowledged {formatDate(myRead.acknowledgedAt)}
                      </Badge>
                    ) : <span />}

                    {canManage ? (
                      <div style={{ minWidth: 230 }}>
                        <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                          <span>{a.requireAck ? "Acknowledged" : "Viewed"}</span>
                          <span className="num">
                            {a.requireAck ? ackCount : a._count.reads} of {headcount}
                          </span>
                        </div>
                        <Progress
                          value={a.requireAck ? ackCount : a._count.reads}
                          max={Math.max(1, headcount)}
                          tone={(a.requireAck ? ackCount : a._count.reads) >= headcount ? "success" : "warning"}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
