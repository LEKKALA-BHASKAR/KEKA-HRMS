import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { aiEnabled } from "@/lib/ai";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { oneOnOnePeers } from "../_parts/access";
import { ScheduleOneOnOne, DeleteTemplate, ActionItemToggle } from "./forms";

const when = (d: Date) => `${formatDate(d)} ${d.toISOString().slice(11, 16)}`;
const TONE: Record<string, "success" | "info" | "neutral" | "warning"> = { SCHEDULED: "info", COMPLETED: "success", CANCELLED: "neutral" };

/** Your 1:1s with your manager and your reporting line: schedule, prepare, follow up. */
export default async function OneOnOnesPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const me = viewer.employee?.id;
  if (!me) return <><PageHead title="1:1 meetings" /><Card><Empty title="This login is not linked to an employee" /></Card></>;
  const { managerId, reportIds } = await oneOnOnePeers(viewer);
  const mine = { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", OR: [{ organiserId: me }, { attendees: { some: { employeeId: me } } }] };
  const now = new Date();
  const include = { attendees: { include: { employee: { select: { id: true, displayName: true } } } }, _count: { select: { actionItems: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } } } } } } satisfies Prisma.MeetingInclude;
  const [upcoming, past, people, rooms, templates, items] = await Promise.all([
    prisma.meeting.findMany({ where: { ...mine, status: "SCHEDULED", endsAt: { gte: now } }, include, orderBy: { startsAt: "asc" }, take: 30 }),
    prisma.meeting.findMany({ where: { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", AND: [{ OR: mine.OR }, { OR: [{ endsAt: { lt: now } }, { status: { not: "SCHEDULED" } }] }] }, include, orderBy: { startsAt: "desc" }, take: 30 }),
    prisma.employee.findMany({ where: { id: { in: [...reportIds, ...(managerId ? [managerId] : [])] }, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
    prisma.meetingRoom.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.meetingAgendaTemplate.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
    prisma.meetingActionItem.findMany({ where: { ownerId: me, status: { in: ["OPEN", "IN_PROGRESS"] }, meeting: { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE" } }, include: { meeting: { select: { id: true, title: true } } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] }),
  ]);
  const other = (m: (typeof upcoming)[number]) => m.attendees.filter((a) => a.employeeId !== me && a.attendance === "REQUIRED").map((a) => a.employee.displayName).join(", ") || "—";
  const row = (m: (typeof upcoming)[number]) => (
    <tr key={m.id}>
      <td><Link className="strong" href={`/performance/one-on-ones/${m.id}`}>{m.title}</Link><div className="text-xs subtle">with {other(m)}</div></td>
      <td className="text-sm nowrap">{when(m.startsAt)}</td>
      <td className="text-sm">{m.recurrence === "NONE" ? "—" : m.recurrence.toLowerCase()}</td>
      <td><Badge tone={TONE[m.status] ?? "neutral"}>{m.status.toLowerCase()}</Badge></td>
      <td className="num text-sm">{m._count.actionItems || ""}</td>
    </tr>
  );

  return (
    <>
      <PageHead title="1:1 meetings" subtitle="Regular conversations with your manager and your team. Agenda, talking points and shared notes are visible to both of you; private notes only to you." />
      <div className="stack gap-4">
        {people.length ? (
          <Card title="Schedule a 1:1">
            {sp.new ? <ScheduleOneOnOne people={people.map((p) => ({ value: p.id, label: `${p.displayName}${p.id === managerId ? " (your manager)" : ""}` }))} rooms={rooms.map((r) => ({ value: r.id, label: r.name }))} templates={templates.map((t) => ({ id: t.id, name: t.name, items: t.items, purpose: t.purpose }))} ai={aiEnabled()} />
              : <Link className="btn primary" href="/performance/one-on-ones?new=1">Schedule a 1:1</Link>}
          </Card>
        ) : null}
        {items.length ? (
          <Card tight title={`Your open action items (${items.length})`}>
            <div className="table-wrap"><table className="data"><tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="text-sm">{i.description}</td>
                  <td className="text-xs"><Link href={`/performance/one-on-ones/${i.meeting.id}`}>{i.meeting.title}</Link></td>
                  <td className={`text-sm nowrap ${i.dueDate && i.dueDate < now ? "neg" : ""}`}>{i.dueDate ? `due ${formatDate(i.dueDate)}` : ""}</td>
                  <td className="right"><ActionItemToggle id={i.id} done={false} /></td>
                </tr>
              ))}
            </tbody></table></div>
          </Card>
        ) : null}
        <Card tight title={`Upcoming (${upcoming.length})`}>
          {upcoming.length === 0 ? <Empty title="No 1:1s scheduled" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Meeting</th><th>When (UTC)</th><th>Repeats</th><th>Status</th><th className="num">Open items</th></tr></thead>
              <tbody>{upcoming.map(row)}</tbody>
            </table></div>
          )}
        </Card>
        <Card tight title="Past">
          {past.length === 0 ? <Empty title="No past 1:1s" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Meeting</th><th>When (UTC)</th><th>Repeats</th><th>Status</th><th className="num">Open items</th></tr></thead>
              <tbody>{past.map(row)}</tbody>
            </table></div>
          )}
        </Card>
        {templates.length ? (
          <Card tight title="Agenda templates">
            <div className="table-wrap"><table className="data"><tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td className="strong text-sm">{t.name}{t.isSystem ? <> <Badge tone="neutral">system</Badge></> : null}</td>
                  <td className="text-xs subtle">{t.items.split("\n").slice(0, 3).join(" · ")}{t.items.split("\n").length > 3 ? " …" : ""}</td>
                  <td className="right">{!t.isSystem && t.createdById === me ? <DeleteTemplate id={t.id} /> : null}</td>
                </tr>
              ))}
            </tbody></table></div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
