import { forbidden } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { SubTabs } from "@/components/subtabs";

const TONE: Record<string, "success" | "info" | "neutral"> = { SCHEDULED: "info", COMPLETED: "success", CANCELLED: "neutral" };
const DAY = 86_400_000;

/**
 * Performance › 1:1 Meetings › Org log: every 1:1 held by people in HR's
 * scope — who met whom, when, how often, and whether it happened. HR sees
 * that a conversation happened and how many talking points and action items
 * it had; never the agenda text, the shared notes or anyone's private notes.
 */
export default async function OneOnOneLogPage({ searchParams }: { searchParams: Promise<{ days?: string; status?: string; q?: string }> }) {
  const viewer = await requireViewer();
  const perm: Permission | undefined = [PERMISSIONS.PERFORMANCE_MANAGE, PERMISSIONS.PERFORMANCE_VIEW].find((p) => can(viewer, p));
  if (!perm) forbidden();
  const sp = await searchParams;
  const days = [30, 90, 180, 365].includes(Number(sp.days)) ? Number(sp.days) : 90;
  const status = ["SCHEDULED", "COMPLETED", "CANCELLED"].includes(sp.status ?? "") ? sp.status : undefined;
  const q = (sp.q ?? "").trim().slice(0, 60);
  const since = new Date(Date.now() - days * DAY);
  const scope = scopedEmployeeWhere(viewer, perm) as Prisma.EmployeeWhereInput;
  const where: Prisma.MeetingWhereInput = {
    tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", startsAt: { gte: since }, ...(status ? { status: status as never } : {}),
    attendees: { some: { employee: { AND: [scope, q ? { displayName: { contains: q, mode: "insensitive" } } : {}] } } },
  };
  const meetings = await prisma.meeting.findMany({
    where, orderBy: { startsAt: "desc" }, take: 500,
    select: {
      id: true, title: true, startsAt: true, status: true, recurrence: true, completedAt: true, organiserId: true,
      attendees: { select: { employeeId: true, attendance: true, employee: { select: { displayName: true, department: { select: { name: true } } } } } },
      _count: { select: { talkingPoints: true, actionItems: true } },
    },
  });
  const done = meetings.filter((m) => m.status === "COMPLETED").length;
  const pairs = new Map<string, { names: string; count: number; last: Date }>();
  for (const m of meetings) {
    const names = m.attendees.filter((a) => a.attendance === "REQUIRED").map((a) => a.employee.displayName).sort().join(" & ");
    const p = pairs.get(names) ?? { names, count: 0, last: m.startsAt };
    p.count++; if (m.startsAt > p.last) p.last = m.startsAt;
    pairs.set(names, p);
  }
  const managers = new Set(meetings.map((m) => m.organiserId).filter(Boolean));

  return (
    <>
      <SubTabs items={[{ label: "My 1:1s", href: "/performance/one-on-ones" }, { label: "Org-wide log", href: "/performance/one-on-ones/log" }]} />
      <PageHead title="1:1 meeting log" subtitle="Every 1:1 in your scope. Content stays between the two people — this shows only that it happened." />
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search a person" aria-label="Search a person" style={{ width: 220 }} />
        <select className="select" name="days" defaultValue={String(days)} aria-label="Period">{[30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>
        <select className="select" name="status" defaultValue={status ?? ""} aria-label="Status"><option value="">Any status</option><option value="SCHEDULED">Scheduled</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></select>
        <button className="btn">Filter</button>
      </form>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="1:1s" value={meetings.length} meta={`last ${days} days`} />
        <Stat label="Held" value={done} meta={`${meetings.length ? Math.round((done / meetings.length) * 100) : 0}% completed`} />
        <Stat label="Pairs meeting" value={pairs.size} />
        <Stat label="Organisers" value={managers.size} />
      </div>
      <Card tight title="By pair" description="How often each pair met in the period.">
        {pairs.size === 0 ? <Empty title="No 1:1s in this period" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>People</th><th className="num">1:1s</th><th>Most recent</th></tr></thead>
            <tbody>{[...pairs.values()].sort((a, b) => b.count - a.count).map((p) => <tr key={p.names}><td className="text-sm">{p.names}</td><td className="num">{p.count}</td><td className="text-sm">{formatDate(p.last)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      <Card tight title={`Meetings (${meetings.length})`}>
        {meetings.length === 0 ? <Empty title="No 1:1s match" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>When (UTC)</th><th>People</th><th>Department</th><th>Repeats</th><th>Status</th><th className="num">Talking points</th><th className="num">Action items</th></tr></thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id}>
                  <td className="text-sm nowrap">{formatDate(m.startsAt)} {m.startsAt.toISOString().slice(11, 16)}</td>
                  <td className="text-sm">{m.attendees.filter((a) => a.attendance === "REQUIRED").map((a) => a.employee.displayName).join(" & ")}</td>
                  <td className="text-sm">{[...new Set(m.attendees.map((a) => a.employee.department?.name).filter(Boolean))].join(", ") || "—"}</td>
                  <td className="text-sm">{m.recurrence === "NONE" ? "—" : m.recurrence.toLowerCase()}</td>
                  <td><Badge tone={TONE[m.status] ?? "neutral"}>{m.status.toLowerCase()}</Badge></td>
                  <td className="num">{m._count.talkingPoints}</td>
                  <td className="num">{m._count.actionItems}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
