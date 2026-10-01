import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { datasetsFor, datasetFor, savedReportsFor } from "@/lib/report-builder";
import { PageHead, Card, Empty, Badge } from "@/components/ui";

export default async function ReportBuilderPage() {
  const viewer = await requireAuth(P.REPORT_VIEW);
  const builder = can(viewer, P.REPORT_BUILD);
  const datasets = datasetsFor(viewer);
  const saved = await savedReportsFor(viewer);
  const owners = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(saved.map((s) => s.createdBy))] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } })).map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const mine = saved.filter((s) => s.createdBy === viewer.user.id);
  const shared = saved.filter((s) => s.createdBy !== viewer.user.id);
  const list = (rows: typeof saved, showOwner: boolean) => (
    <table className="data">
      <thead><tr><th>Report</th><th>Data</th>{showOwner ? <th>Made by</th> : <th>Shared</th>}<th>Updated</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/reports/builder/${r.id}`} className="strong">{r.name}</Link>{r.description ? <div className="text-xs subtle">{r.description}</div> : null}</td>
            <td>{datasetFor(r.dataset)?.title ?? r.dataset}</td>
            {showOwner ? <td>{owners.get(r.createdBy) ?? "Someone"}</td> : <td>{r.shared ? <Badge tone="info">Shared</Badge> : <span className="subtle">Only you</span>}</td>}
            <td>{formatDate(r.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <PageHead title="Custom reports" subtitle="Pick the data, columns, filters and grouping. Every report shows only the people your role covers."
        actions={<Link className="btn" href="/reports">Standard reports</Link>} />
      <div className="stack gap-4">
        {builder ? (
          <Card title="Start a report">
            {datasets.length === 0 ? <Empty title="Your role cannot read any report data" /> : (
              <div className="grid grid-2">
                {datasets.map((d) => (
                  <Link key={d.key} href={`/reports/builder/new?dataset=${d.key}`} className="card" style={{ padding: 14, display: "block" }}>
                    <div className="strong">{d.title}</div>
                    <div className="text-sm subtle">{d.description}</div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        ) : null}
        <Card tight title="My reports">{mine.length ? list(mine, false) : <Empty title="No saved reports yet">{builder ? "Run a report and save it to find it here." : null}</Empty>}</Card>
        <Card tight title="Shared with me">{shared.length ? list(shared, true) : <Empty title="Nothing shared yet" />}</Card>
      </div>
    </>
  );
}
