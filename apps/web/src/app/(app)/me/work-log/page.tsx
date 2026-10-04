import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { resolveTimePolicy, workLogWeek } from "@keka/services";
import { weekStartOf, classifyDay, dayKey } from "@keka/time";
import { formatDate } from "@keka/shared";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { WorkLogForm, WorkLogDecision } from "../../_time/depth-forms";

const P = PERMISSIONS;
const DAY = 86_400_000;
const TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { APPROVED: "success", SUBMITTED: "warning", REJECTED: "danger", DRAFT: "neutral" };

/**
 * A simple weekly timesheet for people who are not on project timesheets:
 * hours and a note per day, submitted weekly, approved by the manager.
 */
export default async function WorkLogPage({ searchParams }: { searchParams: Promise<{ week?: string; view?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const reports = viewer.employee ? await prisma.employee.count({ where: { tenantId: viewer.tenantId, reportingManagerId: viewer.employee.id } }) : 0;
  const approver = reports > 0 || can(viewer, P.ATTENDANCE_APPROVE);
  const view = sp.view === "team" && approver ? "team" : "mine";
  return (
    <>
      <PageHead title="Work log" subtitle="Daily hours and notes, submitted each week for your manager's approval" />
      {approver ? (
        <div className="tabs">
          <Link href="/me/work-log" className={`tab${view === "mine" ? " active" : ""}`}>My week</Link>
          <Link href="/me/work-log?view=team" className={`tab${view === "team" ? " active" : ""}`}>To approve</Link>
        </div>
      ) : null}
      {view === "team" ? <TeamView viewer={viewer} /> : <MyWeek viewer={viewer} week={sp.week} />}
    </>
  );
}

async function MyWeek({ viewer, week }: { viewer: Viewer; week?: string }) {
  if (!viewer.employee) return <Empty title="No employee record">Your login is not linked to an employee.</Empty>;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const requested = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? new Date(`${week}T00:00:00Z`) : today;
  const start = weekStartOf(requested.getTime() > today.getTime() ? today : requested);
  const [row, policy, recent] = await Promise.all([
    workLogWeek(viewer.employee.id, start),
    resolveTimePolicy(viewer.employee.id, start),
    prisma.workLogWeek.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { weekStart: "desc" }, take: 8 }),
  ]);
  const byDay = new Map((row?.days ?? []).map((d) => [dayKey(d.date), d]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start.getTime() + i * DAY);
    const k = dayKey(date);
    const kind = classifyDay(date, policy.calendar);
    return {
      date: k, label: date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      hours: Number(byDay.get(k)?.hours ?? 0), notes: byDay.get(k)?.notes ?? "",
      future: date.getTime() > today.getTime(), offDay: kind === "WEEKLY_OFF" || kind === "HOLIDAY",
    };
  });
  const editable = !row || row.status === "DRAFT" || row.status === "REJECTED";
  const prev = dayKey(new Date(start.getTime() - 7 * DAY));
  const next = new Date(start.getTime() + 7 * DAY);
  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0,1fr) 320px", alignItems: "start" }}>
      <Card title={`Week of ${formatDate(start)}`}
        action={<div className="row gap-2">
          <Link className="btn sm" href={`/me/work-log?week=${prev}`}>← Previous</Link>
          {next.getTime() <= today.getTime() ? <Link className="btn sm" href={`/me/work-log?week=${dayKey(next)}`}>Next →</Link> : null}
        </div>}>
        {row ? (
          <div className="row gap-2" style={{ marginBottom: 10 }}>
            <Badge tone={TONE[row.status]}>{row.status.toLowerCase()}</Badge>
            {row.decisionNote ? <span className="text-sm muted">{row.decisionNote}</span> : null}
          </div>
        ) : null}
        {row?.status === "REJECTED" ? <Callout tone="warning">Sent back — correct the week and submit it again.</Callout> : null}
        <WorkLogForm key={`${dayKey(start)}-${row?.updatedAt.toISOString() ?? ""}`} weekStart={dayKey(start)} days={days} editable={editable} />
      </Card>
      <Card tight title="Recent weeks">
        {recent.length === 0 ? <Empty title="Nothing logged yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Week</th><th className="num">Hours</th><th>Status</th></tr></thead>
              <tbody>
                {recent.map((w) => (
                  <tr key={w.id}>
                    <td><Link href={`/me/work-log?week=${dayKey(w.weekStart)}`}>{formatDate(w.weekStart)}</Link></td>
                    <td className="num">{Number(w.totalHours)}</td>
                    <td><Badge tone={TONE[w.status]}>{w.status.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function TeamView({ viewer }: { viewer: Viewer }) {
  const scope = can(viewer, P.ATTENDANCE_APPROVE) ? scopedEmployeeWhere(viewer, P.ATTENDANCE_APPROVE) : { tenantId: viewer.tenantId, id: "__none__" };
  const weeks = await prisma.workLogWeek.findMany({
    where: {
      tenantId: viewer.tenantId, status: "SUBMITTED", employeeId: { not: viewer.employee?.id ?? "__none__" },
      employee: { OR: [scope, { reportingManagerId: viewer.employee?.id ?? "__none__" }] },
    },
    include: { employee: { select: { displayName: true, employeeNumber: true } }, days: { orderBy: { date: "asc" } } },
    orderBy: { weekStart: "asc" },
  });
  return (
    <Card tight title="Submitted work logs">
      {weeks.length === 0 ? <Empty title="Nothing waiting">Submitted weeks from your team appear here.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Week</th><th className="num">Hours</th><th>Days</th><th /></tr></thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.id}>
                  <td>{w.employee.displayName} <span className="text-xs subtle">{w.employee.employeeNumber}</span></td>
                  <td className="nowrap">{formatDate(w.weekStart)}</td>
                  <td className="num strong">{Number(w.totalHours)}</td>
                  <td className="text-xs" style={{ maxWidth: 360 }}>
                    {w.days.map((d) => (
                      <div key={d.id}>{d.date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", timeZone: "UTC" })}: {Number(d.hours)}h{d.notes ? ` — ${d.notes}` : ""}</div>
                    ))}
                  </td>
                  <td className="right"><WorkLogDecision weekId={w.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
