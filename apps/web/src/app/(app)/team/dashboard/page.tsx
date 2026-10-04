import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { tenure } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { managedTeam, teamTime, decidableChangeRequests } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";

export const metadata = { title: "Manager dashboard — BooS-HR" };

const DAY = 86_400_000;
const LINK_LABEL = { DIRECT: "Direct", INDIRECT: "Indirect", DOTTED: "Dotted line", ACTING: "Acting for" } as const;

/**
 * My Team › Dashboard: a manager's day at a glance — headcount by how each
 * person is linked to them, who is away today, everything waiting for their
 * decision, span of control against the company's limit, probation ends and
 * work anniversaries coming up, and profiles that need attention.
 */
export default async function ManagerDashboardPage() {
  const viewer = await requireViewer();
  const team = await managedTeam(viewer);
  const ids = [...team.keys()];
  if (!viewer.employee || ids.length === 0) {
    return <><PageHead title="Manager dashboard" /><Card><Empty title="No team yet">When people report to you — directly, on a dotted line, or while you act for another manager — they appear here.</Empty></Card></>;
  }
  const t = viewer.tenantId;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const soon = new Date(today.getTime() + 30 * DAY);
  const [people, time, changes, rules, delegations, docs] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: t, id: { in: ids } }, select: { id: true, displayName: true, employeeNumber: true, status: true, dateOfJoining: true, probation: { select: { endDate: true } }, profileCompletion: true, jobTitleName: true }, orderBy: { firstName: "asc" } }),
    teamTime(t, ids, today, today),
    decidableChangeRequests(viewer, { take: 50 }),
    prisma.workingRules.findUnique({ where: { tenantId: t } }),
    prisma.managerDelegation.findMany({ where: { tenantId: t, revokedAt: null, endDate: { gte: today }, OR: [{ delegatorId: viewer.employee.id }, { delegateId: viewer.employee.id }] } }),
    prisma.hrChecklistItem.count({ where: { owner: "MANAGER", done: false, checklist: { tenantId: t, employeeId: { in: ids }, status: { in: ["OPEN", "REOPENED"] } } } }),
  ]);
  const direct = [...team.values()].filter((v) => v === "DIRECT").length;
  const max = rules?.maxSpanOfControl ?? 12;
  const away = time.leave.filter((l) => l.status === "APPROVED");
  const teamChanges = changes.filter((c) => c.employeeId && team.has(c.employeeId));
  const probation = people.filter((p) => p.status === "PROBATION" && p.probation && p.probation.endDate <= soon);
  const anniversaries = people.filter((p) => {
    if (!p.dateOfJoining) return false;
    const next = new Date(Date.UTC(today.getUTCFullYear(), p.dateOfJoining.getUTCMonth(), p.dateOfJoining.getUTCDate()));
    if (next < today) next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next <= soon && next.getUTCFullYear() > p.dateOfJoining.getUTCFullYear();
  });
  const incomplete = people.filter((p) => (p.profileCompletion ?? 100) < 70);
  const byLink = (k: keyof typeof LINK_LABEL) => [...team.values()].filter((v) => v === k).length;
  const name = new Map(people.map((p) => [p.id, p.displayName ?? p.employeeNumber]));
  const pendingTotal = time.pendingLeave + time.pendingAttendance + teamChanges.length;
  return (
    <>
      <PageHead title="Manager dashboard" subtitle={`Your team on ${formatDate(today)}`}
        actions={<><Link className="btn" href="/team/delegation">Delegation</Link><Link className="btn primary" href="/inbox">Inbox</Link></>} />
      {delegations.length ? <Callout title="Delegation in force">{delegations.map((d) => d.delegatorId === viewer.employee!.id ? `Your approvals go to ${name.get(d.delegateId) ?? "a colleague"} until ${formatDate(d.endDate)}.` : `You are ${d.kind === "ACTING" ? "acting manager" : "approving"} for a colleague's team until ${formatDate(d.endDate)}.`).join(" ")}</Callout> : null}
      <div className="grid grid-4" style={{ margin: "14px 0" }}>
        <div className="stat"><div className="stat-label">People you look after</div><div className="stat-value">{ids.length}</div><div className="stat-meta text-xs muted">{byLink("DIRECT")} direct · {byLink("INDIRECT")} indirect · {byLink("DOTTED")} dotted · {byLink("ACTING")} acting</div></div>
        <div className="stat"><div className="stat-label">Away today</div><div className="stat-value">{away.length}</div></div>
        <div className="stat"><div className="stat-label">Waiting for you</div><div className="stat-value">{pendingTotal}</div><div className="text-xs muted">{time.pendingLeave} leave · {time.pendingAttendance} attendance · {teamChanges.length} profile</div></div>
        <div className="stat"><div className="stat-label">Direct reports / limit</div><div className="stat-value" style={{ color: direct > max ? "var(--danger)" : undefined }}>{direct} / {max}</div></div>
      </div>
      {direct > max ? <Callout tone="warning" title="Over the span-of-control limit">You have {direct} direct reports; the company guideline is {max}. Talk to HR about a team lead or a split.</Callout> : null}
      <div className="grid grid-2" style={{ alignItems: "start", marginTop: 14 }}>
        <Card title="Waiting for your decision" tight>
          <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0, gap: 8 }}>
            <li><Link href="/team/leave">Leave requests</Link> <Badge tone={time.pendingLeave ? "warning" : "neutral"}>{time.pendingLeave}</Badge></li>
            <li><Link href="/team/attendance">Attendance requests</Link> <Badge tone={time.pendingAttendance ? "warning" : "neutral"}>{time.pendingAttendance}</Badge></li>
            <li><Link href="/admin/change-requests">Profile change requests</Link> <Badge tone={teamChanges.length ? "warning" : "neutral"}>{teamChanges.length}</Badge></li>
            <li>Checklist items for you <Badge tone={docs ? "warning" : "neutral"}>{docs}</Badge></li>
          </ul>
        </Card>
        <Card title="Away today" tight>
          {away.length === 0 ? <Empty title="Everyone is in" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{away.map((l) => <li key={l.id}>{name.get(l.employeeId)} — {l.leaveType.name} until {formatDate(l.toDate)}</li>)}</ul>
          )}
        </Card>
        <Card title="Coming up in 30 days" tight>
          {probation.length + anniversaries.length === 0 ? <Empty title="Nothing coming up" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>
              {probation.map((p) => <li key={`p${p.id}`}><Badge tone="warning">Probation ends</Badge> {name.get(p.id)} on {formatDate(p.probation?.endDate)}</li>)}
              {anniversaries.map((p) => <li key={`a${p.id}`}><Badge tone="brand">Anniversary</Badge> {name.get(p.id)} — {tenure(p.dateOfJoining!, soon).years} year(s)</li>)}
            </ul>
          )}
        </Card>
        <Card title="Profiles that need attention" description="Less than 70% complete." tight>
          {incomplete.length === 0 ? <Empty title="All profiles look complete" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{incomplete.map((p) => <li key={p.id}><Link href={`/employees/${p.id}`}>{name.get(p.id)}</Link> — {p.profileCompletion ?? 0}%</li>)}</ul>
          )}
        </Card>
      </div>
      <div style={{ height: 14 }} />
      <Card title="Your team" tight>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Employee</th><th>Role</th><th>Link to you</th><th>Status</th><th>With us</th></tr></thead>
          <tbody>{people.map((p) => (
            <tr key={p.id}><td><Link href={`/employees/${p.id}`}>{name.get(p.id)}</Link></td><td className="text-sm">{p.jobTitleName ?? "—"}</td><td>{LINK_LABEL[team.get(p.id)!]}</td>
              <td><Badge>{p.status.toLowerCase().replace(/_/g, " ")}</Badge></td><td className="text-sm">{p.dateOfJoining ? tenure(p.dateOfJoining).label : "—"}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}
