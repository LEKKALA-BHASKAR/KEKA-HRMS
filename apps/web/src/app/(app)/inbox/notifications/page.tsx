import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import {
  IconBell, IconTimer, IconWallet, IconHeadset, IconBriefcase, IconUserPlus, IconLogout, IconReceipt,
  IconTarget, IconCalendar, IconClock, IconDollarCircle, IconFile, IconEngage, IconTrophy, IconCheck,
} from "@/components/icons";
import { MarkReadButton } from "../../_lifecycle/forms";
import { CategoryPane, DetailEmpty, DetailPane, Facts, InboxFrame, ListPane, hrefFor, readNav, sortByDate, type ListItem } from "../_ui/panes";
import { formatDateTime, humanise, matches, safeInternalLink } from "../_ui/format";
import { SYSTEM } from "../_ui/people";
import s from "../inbox.module.css";

/**
 * Inbox → Notifications. The viewer's own notifications — never anyone
 * else's — grouped by kind, with read state and "Mark all read".
 */

const KINDS: Record<string, { label: string; icon: ReactNode }> = {
  LEAVE: { label: "Leave", icon: <IconCalendar /> },
  ATTENDANCE: { label: "Attendance", icon: <IconClock /> },
  TIMESHEET: { label: "Timesheets", icon: <IconTimer /> },
  EXPENSE: { label: "Expenses", icon: <IconReceipt /> },
  TRAVEL: { label: "Travel", icon: <IconBriefcase /> },
  LOAN: { label: "Loans", icon: <IconWallet /> },
  PAYROLL: { label: "Payroll", icon: <IconDollarCircle /> },
  JOURNEY: { label: "Onboarding & journeys", icon: <IconUserPlus /> },
  EXIT: { label: "Exits", icon: <IconLogout /> },
  PROBATION: { label: "Probation", icon: <IconCheck /> },
  DOCUMENT: { label: "Documents", icon: <IconFile /> },
  HELPDESK: { label: "Helpdesk", icon: <IconHeadset /> },
  PERFORMANCE: { label: "Performance", icon: <IconTarget /> },
  ANNOUNCEMENT: { label: "Announcements", icon: <IconEngage /> },
  AWARD: { label: "Praise & awards", icon: <IconTrophy /> },
};
const kindOf = (k: string) => KINDS[k] ?? { label: humanise(k), icon: <IconBell /> };

export default async function NotificationsTab({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const nav = readNav("/inbox/notifications", await searchParams, ["unread"]);
  const mine = { tenantId: viewer.tenantId, userId: viewer.user.id };

  const [totals, unreadTotals] = await Promise.all([
    prisma.notification.groupBy({ by: ["kind"], where: mine, _count: { _all: true } }),
    prisma.notification.groupBy({ by: ["kind"], where: { ...mine, readAt: null }, _count: { _all: true } }),
  ]);
  const unreadBy = new Map(unreadTotals.map((g) => [g.kind, g._count._all]));
  const unreadAll = unreadTotals.reduce((n, g) => n + g._count._all, 0);
  const kinds = totals.map((g) => g.kind).sort((a, b) => kindOf(a).label.localeCompare(kindOf(b).label));

  const cat = nav.cat && kinds.includes(nav.cat) ? nav.cat : "all";
  const unreadOnly = nav.extra?.unread === "1";
  const view = { ...nav, cat };

  const rows = await prisma.notification.findMany({
    where: { ...mine, ...(cat !== "all" ? { kind: cat } : {}), ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const items: ListItem[] = sortByDate(
    rows.filter((n) => matches(nav.q, n.title, n.body, kindOf(n.kind).label)).map((n) => ({
      id: n.id, person: null, at: n.createdAt, unread: !n.readAt,
      icon: <span className={s.kindIcon} aria-hidden="true">{kindOf(n.kind).icon}</span>,
      heading: kindOf(n.kind).label, title: n.title,
    })),
    nav.sort,
  );

  const selectedId = nav.id || items[0]?.id;
  // Looked up by id *and* owner, so another user's notification id finds nothing.
  const n = selectedId ? await prisma.notification.findFirst({ where: { ...mine, id: selectedId } }) : null;
  const me = viewer.employee ? { id: viewer.employee.id, name: viewer.employee.displayName, photoUrl: viewer.employee.photoUrl } : { id: null, name: viewer.user.email, photoUrl: null };
  const link = safeInternalLink(n?.link);

  const label = cat === "all" ? "All notifications" : kindOf(cat).label;
  return (
    <InboxFrame categories={(
      <CategoryPane heading="Notifications" nav={view}
        action={unreadAll > 0 ? <MarkReadButton /> : null}
        categories={[
          { key: "all", label: "All", icon: <IconBell />, count: unreadAll, hot: unreadAll > 0 },
          ...kinds.map((k) => ({ key: k, label: kindOf(k).label, icon: kindOf(k).icon, count: unreadBy.get(k) ?? 0 })),
        ]} />
    )}>
      <ListPane label={label} nav={view} items={items} activeId={n?.id ?? nav.id}
        empty={unreadOnly ? "No unread notifications here." : "Nothing here yet. Approvals, replies and tasks assigned to you show up here."}
        toolbar={(
          <>
            <span>Show</span>
            <Link href={hrefFor(view, { extra: { unread: null } })} aria-current={!unreadOnly ? "true" : undefined} scroll={false}>All</Link>
            <Link href={hrefFor(view, { extra: { unread: "1" } })} aria-current={unreadOnly ? "true" : undefined} scroll={false}>Unread</Link>
          </>
        )} />
      {n ? (
        <Fragment key={n.id}>
          <DetailPane title={n.title} sub={`Received on ${formatDateTime(n.createdAt)}`}
            status={n.readAt ? { label: "Read", tone: "neutral" } : { label: "Unread", tone: "info" }}
            actions={(
              <>
                {link ? <Link className="btn sm primary" href={link}>Open</Link> : null}
                {!n.readAt ? <MarkReadButton id={n.id} label="Mark as read" /> : null}
              </>
            )}
            activity={[
              { who: SYSTEM, text: `Sent you a ${kindOf(n.kind).label.toLowerCase()} notification`, at: n.createdAt },
              ...(n.readAt ? [{ who: me, text: "Marked it as read", at: n.readAt }] : []),
            ]}>
            {n.body ? <p style={{ whiteSpace: "pre-wrap" }}>{n.body}</p> : null}
            <Facts items={[["Category", kindOf(n.kind).label], ["Received", formatDateTime(n.createdAt)]]} />
          </DetailPane>
        </Fragment>
      ) : (
        <DetailEmpty title={nav.id ? "Notification not found" : "No notifications"} icon={<IconBell />}>
          {nav.id ? "It may have been removed." : "You're all caught up."}
        </DetailEmpty>
      )}
    </InboxFrame>
  );
}
