import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { managedTeam } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty } from "@/components/ui";

export const metadata = { title: "Team activity — BooS-HR" };

/**
 * My Team › Activity: the last 30 days of changes to my team's records
 * (job moves, profile edits, attendance corrections, documents) and what
 * my team did themselves, newest first.
 */
export default async function TeamActivityPage({ searchParams }: { searchParams: Promise<{ who?: string; module?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const team = await managedTeam(viewer);
  const ids = [...team.keys()];
  if (!ids.length) return <><PageHead title="Team activity" /><Card><Empty title="No team yet" /></Card></>;
  const t = viewer.tenantId;
  const people = await prisma.employee.findMany({ where: { tenantId: t, id: { in: ids } }, select: { id: true, displayName: true, firstName: true, userId: true }, orderBy: { firstName: "asc" } });
  const scope = sp.who && ids.includes(sp.who) ? people.filter((p) => p.id === sp.who) : people;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.auditLog.findMany({
    where: {
      tenantId: t, createdAt: { gte: since }, action: { not: "VIEW" },
      ...(sp.module ? { module: sp.module as never } : {}),
      OR: [{ entityId: { in: scope.map((p) => p.id) } }, { actorId: { in: scope.map((p) => p.userId).filter((x): x is string => !!x) } }],
    },
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, module: true, action: true, summary: true, entityId: true, actorId: true, actorLabel: true, createdAt: true },
  });
  const byUser = new Map(people.filter((p) => p.userId).map((p) => [p.userId!, p]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const modules = [...new Set(rows.map((r) => r.module))].sort();
  return (
    <>
      <PageHead title="Team activity" subtitle="Changes to your team's records in the last 30 days" actions={<Link className="btn" href="/team/compare">Compare</Link>} />
      <form className="row gap-2" style={{ marginBottom: 12 }}>
        <select className="select" name="who" defaultValue={sp.who ?? ""} aria-label="Person"><option value="">Everyone</option>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.firstName}</option>)}</select>
        <select className="select" name="module" defaultValue={sp.module ?? ""} aria-label="Area"><option value="">All areas</option>{modules.map((m) => <option key={m} value={m}>{m.toLowerCase()}</option>)}</select>
        <button className="btn" type="submit">Filter</button>
      </form>
      <Card tight>
        {rows.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>When</th><th>Who</th><th>Area</th><th>What</th><th>By</th></tr></thead>
            <tbody>{rows.map((r) => {
              const subject = (r.entityId && byId.get(r.entityId)) || (r.actorId && byUser.get(r.actorId)) || null;
              return <tr key={r.id}><td className="text-sm">{formatDate(r.createdAt)}</td><td>{subject ? subject.displayName ?? subject.firstName : "—"}</td><td><Badge>{r.module.toLowerCase()}</Badge></td><td>{r.summary ?? `${r.action.toLowerCase()}`}</td><td className="text-sm muted">{r.actorLabel ?? "system"}</td></tr>;
            })}</tbody>
          </table></div>
        ) : <Empty title="Nothing in the last 30 days" />}
      </Card>
    </>
  );
}
