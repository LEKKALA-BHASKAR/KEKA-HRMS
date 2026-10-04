import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { managedTeam, teamTime } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { ApprovalsView, type ApprovalParams } from "../../_time/approvals-view";

export const metadata = { title: "Team leave — BooS-HR" };

const DAY = 86_400_000;
const LINK_LABEL = { DIRECT: "Direct", INDIRECT: "Indirect", DOTTED: "Dotted line", ACTING: "Acting for" } as const;

/**
 * My Team › Leave: the team's leave requests to decide (with bulk approve),
 * who is off over the next four weeks, and each person's balances — for
 * direct and indirect reports, dotted-line reports, and the team of anyone
 * the manager is acting for.
 */
export default async function TeamLeavePage({ searchParams }: { searchParams: Promise<ApprovalParams & { view?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.LEAVE_APPROVE);
  const sp = await searchParams;
  const view = sp.view === "calendar" || sp.view === "balances" ? sp.view : "requests";
  const tabs = { requests: "Requests to decide", calendar: "Who is off", balances: "Balances" } as const;
  return (
    <>
      <PageHead title="Team leave" subtitle="Decide your team's leave, and see who is away" />
      <div className="tabs">
        {(Object.keys(tabs) as Array<keyof typeof tabs>).map((k) => <Link key={k} href={`/team/leave?view=${k}`} className={`tab${view === k ? " active" : ""}`}>{tabs[k]}</Link>)}
      </div>
      {view === "requests" ? <ApprovalsView viewer={viewer} scope="team" cats={["leave", "compoff", "encashment"]} sp={sp} base="/team/leave" /> : <Overview view={view} />}
    </>
  );
}

async function Overview({ view }: { view: "calendar" | "balances" }) {
  const viewer = await requireAuth(PERMISSIONS.LEAVE_APPROVE);
  const team = await managedTeam(viewer);
  const ids = [...team.keys()];
  if (ids.length === 0) return <Card><Empty title="No one reports to you">Your team&rsquo;s leave appears here.</Empty></Card>;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const until = new Date(today.getTime() + 28 * DAY);
  const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } });
  const name = new Map(people.map((p) => [p.id, p.displayName ?? p.employeeNumber]));
  if (view === "calendar") {
    const { leave } = await teamTime(viewer.tenantId, ids, today, until);
    const days = Array.from({ length: 28 }, (_, i) => new Date(today.getTime() + i * DAY));
    const offOn = (d: Date) => leave.filter((l) => l.fromDate <= d && l.toDate >= d);
    return (
      <div className="stack gap-4">
        <Card title="Away in the next four weeks" tight>
          {leave.length === 0 ? <Empty title="No one is away" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Employee</th><th>Link</th><th>Leave</th><th>From</th><th>To</th><th className="num">Days</th><th>Status</th></tr></thead>
              <tbody>{leave.map((l) => (
                <tr key={l.id}><td><Link href={`/employees/${l.employeeId}`}>{name.get(l.employeeId)}</Link></td><td className="text-xs">{LINK_LABEL[team.get(l.employeeId)!]}</td><td>{l.leaveType.name}</td>
                  <td>{formatDate(l.fromDate)}</td><td>{formatDate(l.toDate)}</td><td className="num">{Number(l.totalDays)}</td>
                  <td>{l.status === "APPROVED" ? <Badge tone="success">Approved</Badge> : <Badge tone="warning">Pending</Badge>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Team coverage by day" description={`How many of ${ids.length} are away each day.`} tight>
          <div className="row wrap" style={{ gap: 4, padding: 14 }}>
            {days.map((d) => {
              const n = offOn(d).length;
              const share = n / ids.length;
              return (
                <div key={d.toISOString()} title={offOn(d).map((l) => name.get(l.employeeId)).join(", ") || "Everyone in"} style={{ width: 44, textAlign: "center", padding: "6px 0", borderRadius: 6, border: "1px solid var(--border)", background: share >= 0.3 ? "var(--danger-soft, #fde8e8)" : n ? "var(--warning-soft, #fff4e0)" : undefined }}>
                  <div className="text-xs muted">{d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</div>
                  <div className="strong">{d.getUTCDate()}</div>
                  <div className="text-xs">{n ? `${n} off` : "—"}</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    );
  }
  const balances = await prisma.leaveBalance.findMany({ where: { employeeId: { in: ids }, leaveType: { tenantId: viewer.tenantId } }, include: { leaveType: { select: { name: true } } }, orderBy: { yearStart: "desc" } });
  const latest = new Map<string, typeof balances[number]>();
  for (const b of balances) { const k = `${b.employeeId}:${b.leaveTypeId}`; if (!latest.has(k)) latest.set(k, b); }
  const types = [...new Set([...latest.values()].map((b) => b.leaveType.name))].sort();
  return (
    <Card title="Leave balances" description="Available days for the current leave year." tight>
      {types.length === 0 ? <Empty title="No balances yet" /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Employee</th>{types.map((t) => <th key={t} className="num">{t}</th>)}</tr></thead>
          <tbody>{people.map((p) => (
            <tr key={p.id}><td><Link href={`/employees/${p.id}`}>{name.get(p.id)}</Link> <span className="text-xs muted">{LINK_LABEL[team.get(p.id)!]}</span></td>
              {types.map((t) => { const b = [...latest.values()].find((x) => x.employeeId === p.id && x.leaveType.name === t); return <td key={t} className="num">{b ? Number(b.available) : "—"}</td>; })}</tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}
