import "server-only";
import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { TICKET_CLOSED_STATUSES, TICKET_OPEN_STATUSES, HELPDESK_PERIODS, helpdeskCategoryPath, helpdeskUserNames, type HelpdeskPeriod } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { raisableCategories } from "./data";
import { NewTicketButton } from "./raise";
import { ListControls } from "./controls";
import { Segments } from "./tabs";
import { Pager, PriorityPill, StatusPill, pageOf } from "./bits";
import { day } from "./format";
import type { PickerCategory } from "./category-picker";
import s from "./hd.module.css";

/**
 * "My Tickets": what the signed-in employee raised (Open / Closed) and what
 * they follow, with search, a period and paging. Shown at /me/helpdesk and,
 * for employees who are not agents, at /helpdesk.
 */

const SIZE = 10;
const PERIODS = [{ value: "all", label: "All time" }, ...Object.entries(HELPDESK_PERIODS).map(([value, p]) => ({ value, label: p.label }))];

export type MyTicketsSearch = { tab?: string; q?: string; period?: string; page?: string };

export async function loadMyTickets(viewer: Viewer, sp: MyTicketsSearch) {
  const tab = sp.tab === "closed" ? "closed" : sp.tab === "following" ? "following" : "open";
  const q = (sp.q ?? "").trim().slice(0, 100);
  const period = sp.period && sp.period in HELPDESK_PERIODS ? (sp.period as HelpdeskPeriod) : "all";
  const employeeId = viewer.employee?.id ?? "__none__";
  const since = period === "all" ? null : new Date(Date.now() - HELPDESK_PERIODS[period].days * 86_400_000);
  const n = Number(q.replace(/^#/, ""));
  const where: Prisma.HelpdeskTicketWhereInput = {
    tenantId: viewer.tenantId,
    ...(tab === "following" ? { followers: { some: { userId: viewer.user.id } } } : { employeeId, status: { in: tab === "closed" ? TICKET_CLOSED_STATUSES : TICKET_OPEN_STATUSES } }),
    ...(since ? { createdAt: { gte: since } } : {}),
    ...(q ? { OR: [...(Number.isInteger(n) && n > 0 ? [{ number: n }] : []), { subject: { contains: q, mode: "insensitive" as const } }] } : {}),
  };
  const [total, openCount, closedCount, followingCount, categories] = await Promise.all([
    prisma.helpdeskTicket.count({ where }),
    prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, employeeId, status: { in: TICKET_OPEN_STATUSES } } }),
    prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, employeeId, status: { in: TICKET_CLOSED_STATUSES } } }),
    prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, followers: { some: { userId: viewer.user.id } } } }),
    raisableCategories(viewer.tenantId, viewer.employee?.id),
  ]);
  const page = pageOf(sp.page, total, SIZE);
  const rows = await prisma.helpdeskTicket.findMany({
    where, orderBy: { createdAt: "desc" }, skip: (page - 1) * SIZE, take: SIZE,
    select: {
      id: true, number: true, subject: true, status: true, priority: true, createdAt: true, closedAt: true, assigneeUserId: true,
      category: { select: { name: true, parent: { select: { name: true } } } },
      employee: { select: { displayName: true } },
    },
  });
  const names = await helpdeskUserNames(viewer.tenantId, rows.map((r) => r.assigneeUserId));
  return {
    tab, q, period, page, total, categories, canRaise: !!viewer.employee,
    counts: { open: openCount, closed: closedCount, following: followingCount },
    rows: rows.map((r) => ({
      id: r.id, number: r.number, subject: r.subject, status: r.status, priority: r.priority, createdAt: r.createdAt, closedAt: r.closedAt,
      category: helpdeskCategoryPath(r.category), raisedBy: r.employee.displayName ?? "", assignee: r.assigneeUserId ? names.get(r.assigneeUserId) ?? "—" : "Not assigned",
    })),
  };
}

export type MyTicketsData = Awaited<ReturnType<typeof loadMyTickets>>;

export function MyTicketsView({ data, basePath, categories }: { data: MyTicketsData; basePath: string; categories?: PickerCategory[] }) {
  const link = (patch: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    const merged = { tab: data.tab === "open" ? undefined : data.tab, q: data.q || undefined, period: data.period === "all" ? undefined : data.period, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "" && !(k === "page" && String(v) === "1")) q.set(k, String(v));
    const qs = q.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const following = data.tab === "following";
  return (
    <div className={s.page}>
      <div className={s.headRow}>
        <div>
          <div className={s.h1}>My Tickets</div>
          <div className={s.caption}>Ask HR, payroll, IT or admin for help, and follow the answer here.</div>
        </div>
        {data.canRaise ? <NewTicketButton categories={categories ?? data.categories} /> : null}
      </div>
      <Segments active={data.tab} items={[
        { key: "open", label: `Open Tickets (${data.counts.open})`, href: link({ tab: undefined, page: undefined }) },
        { key: "closed", label: `Closed Tickets (${data.counts.closed})`, href: link({ tab: "closed", page: undefined }) },
        ...(data.counts.following || following ? [{ key: "following", label: `Following (${data.counts.following})`, href: link({ tab: "following", page: undefined }) }] : []),
      ]} />
      <div className={s.panel}>
        <ListControls qKey="q" periodKey="period" pageKey="page" q={data.q} period={data.period} periods={PERIODS} />
        {data.rows.length === 0 ? (
          <div className={s.empty}>{data.q ? "No tickets match your search." : following ? "You are not following any tickets." : data.tab === "closed" ? "No closed tickets yet." : "No open tickets. Raise one when you need help."}</div>
        ) : (
          <div className="table-wrap">
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Ticket</th>
                  {following ? <th>Raised by</th> : null}
                  <th>Raised on</th><th>Priority</th><th>Assigned to</th><th>Status</th>
                  {data.tab === "closed" ? <th>Closed on</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={s.titleCell}>
                      <Link href={`/me/helpdesk/${r.id}`} className={s.link}>#{r.number} {r.subject}</Link>
                      <div className={s.sub}>{r.category}</div>
                    </td>
                    {following ? <td>{r.raisedBy}</td> : null}
                    <td className={s.nowrap}>{day(r.createdAt)}</td>
                    <td><PriorityPill p={r.priority} /></td>
                    <td>{r.assignee}</td>
                    <td><StatusPill status={r.status} /></td>
                    {data.tab === "closed" ? <td className={s.nowrap}>{day(r.closedAt)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={data.total} page={data.page} size={SIZE} link={(p) => link({ page: p })} />
      </div>
    </div>
  );
}
