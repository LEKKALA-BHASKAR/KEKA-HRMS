import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { travelSpend, tripMonthGrid, onTripOn } from "@keka/services";
import { formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Stat, Person, Badge } from "@/components/ui";

/** Travel spend, the business-trip calendar and who is travelling where today. */
export default async function TravelDashboardPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.TRAVEL_MANAGE);
  const sp = await searchParams;
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(sp.month ?? "");
  const year = m ? Number(m[1]) : now.getUTCFullYear(), month = m ? Number(m[2]) : now.getUTCMonth() + 1;
  const monthStart = new Date(Date.UTC(year, month - 1, 1)), monthEnd = new Date(Date.UTC(year, month, 0));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const [spend, monthTrips, today] = await Promise.all([
    travelSpend(viewer.tenantId, yearStart, new Date(Date.UTC(now.getUTCFullYear(), 11, 31))),
    prisma.travelRequest.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["APPROVED", "BOOKED", "IN_PROGRESS", "COMPLETED"] }, departDate: { lte: monthEnd }, OR: [{ returnDate: { gte: monthStart } }, { returnDate: null, departDate: { gte: monthStart } }] }, include: { employee: { select: { displayName: true } } }, orderBy: { departDate: "asc" } }),
    prisma.travelRequest.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["APPROVED", "BOOKED", "IN_PROGRESS"] }, departDate: { lte: now }, OR: [{ returnDate: { gte: new Date(now.getTime() - 86_400_000) } }, { returnDate: null }] }, include: { employee: { select: { displayName: true, employeeNumber: true, userId: true } } } }),
  ]);
  const away = today.filter((t) => onTripOn(t, now));
  const grid = tripMonthGrid(year, month);
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  const max = Math.max(1, ...spend.byMonth.map((b) => b.spend));
  const bars = (rows: Array<{ key: string; trips: number; spend: number }>) => rows.length === 0 ? <Empty title="No trips" /> : (
    <div className="stack gap-1">{rows.map((r) => (
      <div key={r.key} className="row gap-2 text-sm"><span style={{ width: 150 }} className="truncate">{r.key}</span><div style={{ flex: 1, background: "var(--surface-2, #eee)", borderRadius: 4 }}><div style={{ width: `${(r.spend / Math.max(1, ...rows.map((x) => x.spend))) * 100}%`, background: "var(--primary, #4f46e5)", height: 10, borderRadius: 4 }} /></div><span className="num" style={{ width: 110, textAlign: "right" }}>{formatINR(r.spend)}</span><span className="subtle text-xs" style={{ width: 50 }}>{r.trips} trip{r.trips === 1 ? "" : "s"}</span></div>
    ))}</div>
  );
  return (
    <>
      <PageHead title="Travel dashboard" subtitle={`Spend this year, the ${monthStart.toLocaleString("en-IN", { month: "long", timeZone: "UTC" })} calendar and who is away today`} actions={<><Link className="btn" href="/expenses/travel">Trips</Link><Link className="btn" href="/expenses/travel/export?kind=trips">Trips CSV</Link></>} />
      <div className="grid grid-4">
        <Stat label="Spend this year" value={formatINR(spend.total)} meta={`${spend.count} trip(s)`} />
        <Stat label="International" value={spend.international} />
        <Stat label="With policy exceptions" value={spend.outOfPolicy} tone={spend.outOfPolicy ? "neg" : undefined} />
        <Stat label="Travelling today" value={away.length} />
      </div>
      <div className="grid grid-2" style={{ marginTop: 12, alignItems: "start" }}>
        <Card title="Spend by month">
          {spend.byMonth.length === 0 ? <Empty title="No trips this year" /> : <div className="row gap-1" style={{ alignItems: "flex-end", height: 140 }}>{spend.byMonth.map((b) => <div key={b.key} title={`${b.key}: ${formatINR(b.spend)}`} style={{ flex: 1, textAlign: "center" }}><div style={{ height: `${(b.spend / max) * 110}px`, background: "var(--primary, #4f46e5)", borderRadius: 3 }} /><div className="text-xs subtle">{b.key.slice(5)}</div></div>)}</div>}
        </Card>
        <Card title="Who is where today" description="Travellers on an approved or booked trip today">
          {away.length === 0 ? <Empty title="Nobody is travelling today" /> : <div className="stack gap-2">{away.map((t) => <div key={t.id} className="row gap-2" style={{ justifyContent: "space-between" }}><Person name={t.employee.displayName ?? ""} meta={t.employee.employeeNumber} /><Link className="text-sm" href={`/expenses/travel/${t.id}`}>{t.toCity}{t.destinationCountry ? `, ${t.destinationCountry}` : ""}</Link>{t.riskLevel && t.riskLevel !== "LOW" ? <Badge tone="warning">{t.riskLevel.toLowerCase()} risk</Badge> : null}</div>)}</div>}
        </Card>
        <Card title="By purpose">{bars(spend.byPurpose)}</Card>
        <Card title="By department">{bars(spend.byDepartment)}</Card>
        <Card title="Top destinations">{bars(spend.byDestination)}</Card>
      </div>
      <Card title="Business trip calendar" action={<div className="row gap-1"><Link className="btn sm" href={`/expenses/travel/dashboard?month=${prev}`}>‹</Link><Link className="btn sm" href={`/expenses/travel/dashboard?month=${next}`}>›</Link></div>}>
        <div className="table-wrap"><table className="data" style={{ tableLayout: "fixed" }}>
          <thead><tr>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <th key={d}>{d}</th>)}</tr></thead>
          <tbody>{grid.map((week, i) => (
            <tr key={i}>{week.map((d, j) => (
              <td key={j} style={{ verticalAlign: "top", height: 70 }}>
                {d ? <>
                  <div className="text-xs subtle">{d.getUTCDate()}</div>
                  {monthTrips.filter((t) => onTripOn(t, d)).slice(0, 3).map((t) => <Link key={t.id} href={`/expenses/travel/${t.id}`} className="text-xs" style={{ display: "block" }} title={`${t.employee.displayName}: ${t.toCity}`}>{(t.employee.displayName ?? "").split(" ")[0]} · {t.toCity}</Link>)}
                  {monthTrips.filter((t) => onTripOn(t, d)).length > 3 ? <div className="text-xs subtle">+{monthTrips.filter((t) => onTripOn(t, d)).length - 3} more</div> : null}
                </> : null}
              </td>
            ))}</tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}
