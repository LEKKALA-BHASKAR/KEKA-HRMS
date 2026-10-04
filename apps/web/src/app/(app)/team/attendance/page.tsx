import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { managedTeam, teamTime } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { ApprovalsView, type ApprovalParams } from "../../_time/approvals-view";

export const metadata = { title: "Team attendance — BooS-HR" };

const DAY = 86_400_000;
const LABEL: Record<string, string> = { PRESENT: "Present", ABSENT: "Absent", HALF_DAY: "Half day", ON_LEAVE: "On leave", WEEKLY_OFF: "Weekly off", HOLIDAY: "Holiday", WORK_FROM_HOME: "WFH", ON_DUTY: "On duty", NO_ATTENDANCE: "No attendance" };

/**
 * My Team › Attendance: requests to decide (regularisation, WFH / on duty,
 * remote clock-in, overtime, shift changes), and the team's attendance over
 * the last two weeks with hours and exceptions.
 */
export default async function TeamAttendancePage({ searchParams }: { searchParams: Promise<ApprovalParams & { view?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.ATTENDANCE_APPROVE);
  const sp = await searchParams;
  const view = sp.view === "register" ? "register" : "requests";
  return (
    <>
      <PageHead title="Team attendance" subtitle="Decide your team's attendance requests and see how the last two weeks went" />
      <div className="tabs">
        <Link href="/team/attendance" className={`tab${view === "requests" ? " active" : ""}`}>Requests to decide</Link>
        <Link href="/team/attendance?view=register" className={`tab${view === "register" ? " active" : ""}`}>Attendance register</Link>
      </div>
      {view === "requests" ? <ApprovalsView viewer={viewer} scope="team" cats={["regularization", "wfh-od", "remote", "overtime", "shift"]} sp={sp} base="/team/attendance" /> : <Register />}
    </>
  );
}

async function Register() {
  const viewer = await requireAuth(PERMISSIONS.ATTENDANCE_APPROVE);
  const team = await managedTeam(viewer);
  const ids = [...team.keys()];
  if (ids.length === 0) return <Card><Empty title="No one reports to you" /></Card>;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today.getTime() - 13 * DAY);
  const [people, { attendance }] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
    teamTime(viewer.tenantId, ids, from, today),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => new Date(from.getTime() + i * DAY));
  const rec = new Map(attendance.map((a) => [`${a.employeeId}:${a.date.toISOString().slice(0, 10)}`, a]));
  const short = (s: string) => ({ PRESENT: "P", ABSENT: "A", HALF_DAY: "½", ON_LEAVE: "L", WEEKLY_OFF: "W", HOLIDAY: "H", WORK_FROM_HOME: "WFH", ON_DUTY: "OD", NO_ATTENDANCE: "–" }[s] ?? s.slice(0, 2));
  return (
    <Card title={`Last 14 days (${formatDate(from)} – ${formatDate(today)})`} description="P present · A absent · L leave · W weekly off · H holiday · ½ half day. Hover a cell for hours." tight>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th>{days.map((d) => <th key={d.toISOString()} className="num text-xs">{d.getUTCDate()}</th>)}<th className="num">Avg hrs</th><th className="num">Absent</th></tr></thead>
        <tbody>{people.map((p) => {
          const cells = days.map((d) => rec.get(`${p.id}:${d.toISOString().slice(0, 10)}`));
          const worked = cells.filter((c) => c && Number(c.effectiveHours) > 0);
          const avg = worked.length ? worked.reduce((a, c) => a + Number(c!.effectiveHours), 0) / worked.length : 0;
          const absent = cells.filter((c) => (c?.manualStatus ?? c?.status) === "ABSENT").length;
          return (
            <tr key={p.id}><td><Link href={`/employees/${p.id}`}>{p.displayName}</Link></td>
              {cells.map((c, i) => { const st = c ? (c.manualStatus ?? c.status) : null; return <td key={i} className="num text-xs" title={c ? `${LABEL[st!] ?? st} · ${Number(c.effectiveHours)} h${c.isRegularised ? " · regularised" : ""}` : "No record"} style={{ color: st === "ABSENT" ? "var(--danger)" : undefined }}>{st ? short(st) : ""}</td>; })}
              <td className="num">{avg ? avg.toFixed(1) : "—"}</td><td className="num">{absent ? <Badge tone="danger">{absent}</Badge> : 0}</td></tr>
          );
        })}</tbody>
      </table></div>
    </Card>
  );
}
