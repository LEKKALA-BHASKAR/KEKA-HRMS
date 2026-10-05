import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { SubTabs } from "@/components/subtabs";

export const metadata = { title: "My activity — BooS-HR" };

/**
 * Everything I did in BooS-HR, and every change someone else made to my
 * record — who, when and what — for the last 90 days.
 */
export default async function MyActivityPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const view = sp.view === "mine" ? "mine" : "record";
  const since = new Date(Date.now() - 90 * 86_400_000);
  const me = viewer.employee?.id;
  const where = view === "mine"
    ? { tenantId: viewer.tenantId, actorId: viewer.user.id, createdAt: { gte: since } }
    : { tenantId: viewer.tenantId, createdAt: { gte: since }, entityId: { in: [me ?? "-", viewer.user.id] }, OR: [{ actorId: null }, { actorId: { not: viewer.user.id } }] };
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, module: true, action: true, entityType: true, summary: true, actorLabel: true, createdAt: true } });
  return (
    <>
      <PageHead title="My activity" subtitle="The last 90 days" actions={<Link className="btn" href="/me/privacy">Privacy</Link>} />
      <SubTabs items={[{ label: "Changes to my record", href: "/me/activity" }, { label: "What I did", href: "/me/activity?view=mine" }]} active={view === "mine" ? "/me/activity?view=mine" : "/me/activity"} />
      <Card tight>
        {rows.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>When</th><th>Area</th><th>What</th>{view === "record" ? <th>By</th> : null}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td className="text-sm">{formatDate(r.createdAt)}</td><td><Badge>{r.module.toLowerCase()}</Badge></td><td>{r.summary ?? `${r.action.toLowerCase()} ${r.entityType}`}</td>{view === "record" ? <td className="text-sm muted">{r.actorLabel ?? "system"}</td> : null}</tr>)}</tbody>
          </table></div>
        ) : <Empty title="Nothing in the last 90 days" />}
      </Card>
    </>
  );
}
