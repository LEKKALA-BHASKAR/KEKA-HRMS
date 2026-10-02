import Link from "next/link";
import { forbidden } from "next/navigation";
import { PERMISSIONS as P } from "@keka/rbac";
import { utilisationByPerson, utilisationSeries } from "@keka/services/src/psa";
import { requireViewer, canAny } from "@/lib/context";
import { parseMonth, monthKey, shiftMonth } from "@/lib/scope";
import { PageHead, Card, Empty, Stat } from "@/components/ui";
import { Bars } from "@/components/keka";
import { ResourceTabs } from "../nav";

const n1 = (n: number) => Math.round(n * 10) / 10;

/** Projects › Resources › Utilisation: billable hours over available hours, per person and over time. */
export default async function UtilisationPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.RESOURCE_VIEW, P.RESOURCE_MANAGE])) forbidden();
  const sp = await searchParams;
  const { year, month } = parseMonth(sp.month);
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const trendFrom = new Date(Date.UTC(year, month - 6, 1));
  const [rows, trend] = await Promise.all([utilisationByPerson(viewer.tenantId, from, to), utilisationSeries(viewer.tenantId, trendFrom, to, "MONTH")]);
  const totals = rows.reduce((s, r) => ({ cap: s.cap + r.capacity - r.leave, bill: s.bill + r.billable, non: s.non + r.nonBillable, gap: s.gap + r.notLogged }), { cap: 0, bill: 0, non: 0, gap: 0 });
  const prev = shiftMonth(year, month, -1), next = shiftMonth(year, month, 1);
  const below = rows.filter((r) => r.target !== null && r.pct < r.target).length;
  const label = from.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <PageHead title="Utilisation" subtitle={`${label} · billable hours over available hours (capacity less approved leave)`}
        actions={<><Link className="btn" href={`/projects/resources/utilisation?month=${monthKey(prev.year, prev.month)}`}>‹ Previous</Link><Link className="btn" href={`/projects/resources/utilisation?month=${monthKey(next.year, next.month)}`}>Next ›</Link></>} />
      <ResourceTabs viewer={viewer} active="/projects/resources/utilisation" />
      <div className="stack gap-3">
        <div className="grid grid-4">
          <Stat label="Billable utilisation" value={`${totals.cap ? n1((totals.bill / totals.cap) * 100) : 0}%`} meta={`${n1(totals.bill)} of ${n1(totals.cap)} available hours`} />
          <Stat label="Non-billable" value={`${n1(totals.non)} h`} meta="Logged on internal or non-billable work" />
          <Stat label="Not logged" value={`${n1(totals.gap)} h`} meta="Available but no time entered" tone={totals.gap > 0 ? "neg" : undefined} />
          <Stat label="Below target" value={below} meta={`of ${rows.filter((r) => r.target !== null).length} people with a target`} />
        </div>
        <Card title="Last six months"><Bars data={trend.map((t) => ({ label: t.label, value: t.pct, title: `${t.label}: ${t.pct}%` }))} height={110} colour="#5bc0d0" /></Card>
        <Card tight title="By person">
          {rows.length === 0 ? <Empty title="Nobody was allocated or logged time this month" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Person</th><th>Department</th><th className="num">Available</th><th className="num">Planned</th><th className="num">Billable</th><th className="num">Non-billable</th><th className="num">Leave</th><th className="num">Not logged</th><th className="num">Utilisation</th><th className="num">Target</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/employees/${r.id}`}>{r.name}</Link> <span className="subtle text-xs">{r.number}</span></td>
                      <td>{r.department ?? "—"}</td>
                      <td className="num">{n1(r.capacity - r.leave)}</td><td className="num">{n1(r.planned)}</td><td className="num">{n1(r.billable)}</td><td className="num">{n1(r.nonBillable)}</td>
                      <td className="num">{n1(r.leave)}</td><td className="num">{n1(r.notLogged)}</td>
                      <td className={`num strong${r.target !== null && r.pct < r.target ? " neg" : ""}`}>{r.pct}%</td>
                      <td className="num">{r.target === null ? "—" : `${r.target}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
