import Link from "next/link";
import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { managedTeam } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty, Progress } from "@/components/ui";

export const metadata = { title: "Team insights — BooS-HR" };

/**
 * My Team › Insights: side by side for everyone a manager looks after —
 * documents still owed, onboarding progress, the latest review, goals,
 * skills, policies not yet acknowledged and succession cover — so gaps
 * stand out before they become problems.
 */
export default async function TeamInsightsPage() {
  const viewer = await requireViewer();
  const team = await managedTeam(viewer);
  const ids = [...team.keys()];
  if (!ids.length) return <><PageHead title="Team insights" /><Card><Empty title="No team yet" /></Card></>;
  const t = viewer.tenantId;
  const [people, docs, checklists, reviews, goals, skills, ackDocs, acks, successors] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: t, id: { in: ids } }, select: { id: true, displayName: true, firstName: true, jobTitleName: true, profileCompletion: true }, orderBy: { firstName: "asc" } }),
    prisma.employeeDocument.groupBy({ by: ["employeeId", "status"], where: { tenantId: t, employeeId: { in: ids } }, _count: { _all: true } }),
    prisma.hrChecklist.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: { in: ["OPEN", "REOPENED"] } }, select: { employeeId: true, title: true, items: { select: { done: true } } } }),
    prisma.employeeReview.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, status: true, finalRating: true, rawRating: true, cycle: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.goal.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: { notIn: ["CANCELLED", "DRAFT"] } }, select: { employeeId: true, status: true, progressPercent: true } }),
    prisma.employeeSkill.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids } }, _count: { _all: true } }),
    prisma.orgDocument.findMany({ where: { tenantId: t, requireAck: true, isPublished: true }, select: { id: true } }),
    prisma.orgDocumentAck.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, document: { tenantId: t, requireAck: true, isPublished: true } }, _count: { _all: true } }),
    prisma.successor.findMany({ where: { employeeId: { in: ids }, plan: { tenantId: t } }, select: { employeeId: true, plan: { select: { positionTitle: true } } } }),
  ]);
  const owed = (id: string) => docs.filter((d) => d.employeeId === id && ["PENDING_ON_EMPLOYEE", "REJECTED", "EXPIRED"].includes(d.status)).reduce((n, d) => n + d._count._all, 0);
  const verifying = (id: string) => docs.filter((d) => d.employeeId === id && d.status === "PENDING_VERIFICATION").reduce((n, d) => n + d._count._all, 0);
  const review = (id: string) => reviews.find((r) => r.employeeId === id);
  const goalStats = (id: string) => {
    const g = goals.filter((x) => x.employeeId === id);
    return { n: g.length, avg: g.length ? Math.round(g.reduce((s, x) => s + Number(x.progressPercent), 0) / g.length) : 0, risk: g.filter((x) => x.status === "AT_RISK" || x.status === "NEEDS_ATTENTION").length };
  };
  const ackMissing = (id: string) => ackDocs.length - (acks.find((a) => a.employeeId === id)?._count._all ?? 0);
  const rated = reviews.filter((r, i) => reviews.findIndex((x) => x.employeeId === r.employeeId) === i && (r.finalRating ?? r.rawRating) != null);
  const avgRating = rated.length ? (rated.reduce((s, r) => s + Number(r.finalRating ?? r.rawRating), 0) / rated.length).toFixed(2) : "—";
  const onboarding = checklists.map((c) => ({ ...c, pct: c.items.length ? Math.round((c.items.filter((i) => i.done).length / c.items.length) * 100) : 0 }));
  const name = (id: string) => { const p = people.find((x) => x.id === id); return p?.displayName ?? p?.firstName ?? "—"; };
  return (
    <>
      <PageHead title="Team insights" subtitle={`${ids.length} people you look after`} actions={<><Link className="btn" href="/team/dashboard">Dashboard</Link><Link className="btn" href="/team/activity">Activity</Link></>} />
      <div className="grid grid-4" style={{ margin: "14px 0" }}>
        <div className="stat"><div className="stat-label">Documents owed</div><div className="stat-value">{ids.reduce((n, id) => n + owed(id), 0)}</div></div>
        <div className="stat"><div className="stat-label">Open checklists</div><div className="stat-value">{checklists.length}</div></div>
        <div className="stat"><div className="stat-label">Average latest rating</div><div className="stat-value">{avgRating}</div></div>
        <div className="stat"><div className="stat-label">Policies not acknowledged</div><div className="stat-value">{ids.reduce((n, id) => n + Math.max(0, ackMissing(id)), 0)}</div></div>
      </div>
      <Card title="Compare your team" tight>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Employee</th><th>Profile</th><th>Documents</th><th>Latest review</th><th>Goals</th><th>Skills</th><th>Policies to acknowledge</th><th>Successor for</th></tr></thead>
          <tbody>{people.map((p) => {
            const r = review(p.id); const g = goalStats(p.id); const miss = Math.max(0, ackMissing(p.id));
            return (
              <tr key={p.id}>
                <td><Link href={`/employees/${p.id}`}>{p.displayName ?? p.firstName}</Link><div className="text-xs muted">{p.jobTitleName ?? ""}</div></td>
                <td>{p.profileCompletion ?? 0}%</td>
                <td>{owed(p.id) ? <Badge tone="warning">{owed(p.id)} owed</Badge> : <Badge tone="success">up to date</Badge>}{verifying(p.id) ? <div className="text-xs muted">{verifying(p.id)} being verified</div> : null}</td>
                <td>{r ? <>{r.cycle.name}<div className="text-xs muted">{r.status.toLowerCase().replace(/_/g, " ")}{(r.finalRating ?? r.rawRating) != null ? ` · ${Number(r.finalRating ?? r.rawRating)}` : ""}</div></> : "—"}</td>
                <td>{g.n ? <>{g.n} · {g.avg}%{g.risk ? <div><Badge tone="danger">{g.risk} at risk</Badge></div> : null}</> : "—"}</td>
                <td>{skills.find((s) => s.employeeId === p.id)?._count._all ?? 0}</td>
                <td>{miss ? <Badge tone="warning">{miss}</Badge> : <Badge tone="success">0</Badge>}</td>
                <td className="text-sm">{successors.filter((s) => s.employeeId === p.id).map((s) => s.plan.positionTitle).join(", ") || "—"}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>
      <Card title="Onboarding and checklists in progress">
        {onboarding.length ? <ul className="stack" style={{ listStyle: "none", padding: 0 }}>{onboarding.map((c, i) => <li key={i}><strong>{name(c.employeeId)}</strong> — {c.title} <Progress value={c.pct} /> <span className="text-xs muted">{c.pct}%</span></li>)}</ul> : <Empty title="No open checklists" />}
      </Card>
    </>
  );
}
