import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatPeriod, fyLabel, fyStartYear } from "@keka/shared";
import { form24qQuarter } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, Money, KeyValue } from "@/components/ui";
import { deleteChallanAction } from "@/app/actions/payroll-payout";
import { PayoutForm } from "../../_forms/payouts";
import { ChallanForm } from "./forms";

/**
 * Form 24Q for one quarter: the salary TDS deposited (challans), each month's
 * deductee rows booked against them, and what does not reconcile.
 */
export default async function Form24qPage({ searchParams }: { searchParams: Promise<{ fy?: string; q?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.STATUTORY_MANAGE);
  const sp = await searchParams;
  const now = new Date();
  const fy = Number(sp.fy) || fyStartYear(now, viewer.tenant.fyStartMonth);
  const currentQ = Math.floor(((now.getUTCMonth() + 12 - 3) % 12) / 3) + 1;
  const q = Math.min(4, Math.max(1, Number(sp.q) || currentQ));
  const [data, payGroups] = await Promise.all([
    form24qQuarter(viewer.tenantId, fy, q),
    prisma.payGroup.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const { statement } = data;
  const monthOptions = data.months.map((m) => ({ value: `${m.year}-${String(m.month).padStart(2, "0")}`, label: formatPeriod(m.year, m.month) }));
  const nav = (f: number, qq: number) => `/payroll/filings/24q?fy=${f}&q=${qq}`;
  const prev = q === 1 ? nav(fy - 1, 4) : nav(fy, q - 1), next = q === 4 ? nav(fy + 1, 1) : nav(fy, q + 1);
  const deducted = statement.months.reduce((s, m) => s + m.deducted, 0), deposited = statement.months.reduce((s, m) => s + m.deposited, 0);

  return (
    <>
      <PageHead
        title={`Form 24Q · Q${q} ${fyLabel(fy)}`}
        subtitle="Salary TDS deposited and the deductee rows it covers, from finalised payroll"
        actions={
          <div className="row gap-2">
            <Link className="btn sm" href={prev}>‹ Previous quarter</Link>
            <Link className="btn sm" href={next}>Next quarter ›</Link>
            <Link className="btn sm" href={`/payroll/filings?fy=${fy}`}>All filings</Link>
          </div>
        }
      />
      <Callout tone="warning" title="This is not an FVU file">
        The export is a structured CSV of the quarter&apos;s deductor, challan and deductee data. The NSDL/Protean FVU text layout could not be
        reproduced credibly here, so it is not generated. Key this data into the NSDL Return Preparation Utility (RPU), then validate the
        prepared return with the official File Validation Utility (FVU) before uploading it on TRACES or at a TIN facilitation centre.
      </Callout>

      <div className="grid grid-2" style={{ marginTop: 16, alignItems: "start" }}>
        <Card title="Deductor" description="From the pay group's filing details.">
          <KeyValue items={[
            ["Deductor", data.deductor.name ?? "—"],
            ["TAN", data.deductor.tan ?? <span className="neg">missing</span>],
            ["PAN", data.deductor.pan ?? "—"],
            ["Responsible person", data.deductor.responsible ?? "—"],
            ["TDS deducted / deposited", <><Money value={deducted} /> / <Money value={deposited} /></>],
          ]} />
          <div className="row gap-2" style={{ marginTop: 12 }}>
            <a className="btn primary sm" href={`/payroll/filings/24q/export?fy=${fy}&q=${q}`}>Export 24Q data (CSV)</a>
          </div>
        </Card>
        <Card title="Reconciliation" description="TDS deducted in payroll against challans deposited, month by month." tight>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Month</th><th className="num">Deductees</th><th className="num">Deducted</th><th className="num">Deposited</th><th>Status</th></tr></thead>
              <tbody>
                {data.months.map((m) => {
                  const row = statement.months.find((x) => x.year === m.year && x.month === m.month);
                  const ok = row && Math.abs(row.deducted - row.deposited) < 1;
                  return (
                    <tr key={`${m.year}-${m.month}`}>
                      <td>{formatPeriod(m.year, m.month)}</td>
                      <td className="num">{row?.employees ?? 0}</td>
                      <td className="num"><Money value={row?.deducted ?? 0} /></td>
                      <td className="num"><Money value={row?.deposited ?? 0} /></td>
                      <td>{!row ? <Badge>no payroll</Badge> : ok ? <Badge tone="success">matches</Badge> : <Badge tone="danger">{row.challans ? "short / over" : "no challan"}</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {data.issues.length ? (
        <div style={{ marginTop: 16 }}>
          <Callout tone="warning" title={`${data.issues.length} thing(s) to fix before filing`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{data.issues.slice(0, 12).map((i, k) => <li key={k}>{i}</li>)}</ul>
            {data.issues.length > 12 ? <p className="text-sm">…and {data.issues.length - 12} more.</p> : null}
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ marginTop: 16, alignItems: "start" }}>
        <Card title={`Challans (${data.challans.length})`} description="One row per bank counterfoil: BSR code, date of deposit and challan serial identify it." tight>
          {data.challans.length === 0 ? <Empty title="No challans recorded for this quarter" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Month</th><th>BSR</th><th>Serial</th><th>Deposited</th><th className="num">TDS</th><th /></tr></thead>
                <tbody>
                  {data.challans.map((c) => (
                    <tr key={c.id}>
                      <td>{formatPeriod(c.year!, c.month!)}</td>
                      <td className="mono">{c.bsrCode}</td>
                      <td className="mono">{c.challanNumber}</td>
                      <td className="nowrap">{formatDate(c.paymentDate)}</td>
                      <td className="num"><Money value={c.tdsAmount} /></td>
                      <td><PayoutForm action={deleteChallanAction} hidden={{ id: c.id }} label="Remove" variant="ghost" confirm="Remove this challan?" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Record a challan" description="After depositing the month's TDS (by the 7th of the next month; 30 April for March).">
          <ChallanForm months={monthOptions} payGroups={payGroups.map((g) => ({ value: g.id, label: g.name }))} defaultMonth={monthOptions[0]?.value ?? ""} />
        </Card>
      </div>

      <Card title={`Deductee rows (${statement.allocations.length})`} description="Section 192. Each row is booked against its month's challans in order; a row can split across two." tight>
        {statement.allocations.length === 0 ? <Empty title="No finalised salary in this quarter" /> : (
          <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Month</th><th>Employee</th><th>PAN</th><th>Paid on</th><th className="num">Amount paid</th><th className="num">TDS</th><th>Challan</th></tr></thead>
              <tbody>
                {statement.allocations.map((a, i) => (
                  <tr key={i}>
                    <td className="nowrap">{formatPeriod(a.year, a.month)}</td>
                    <td className="text-sm">{a.employeeNumber} {a.name}</td>
                    <td className="mono text-sm">{a.pan && /^[A-Z]{5}\d{4}[A-Z]$/.test(a.pan.toUpperCase()) ? a.pan.toUpperCase() : <span className="neg">PANNOTAVBL</span>}</td>
                    <td className="nowrap">{formatDate(a.paymentDate)}</td>
                    <td className="num"><Money value={a.amountPaid} /></td>
                    <td className="num"><Money value={a.tdsBooked} /></td>
                    <td className="mono text-sm">{a.challanSerial ? `${a.bsrCode} / ${a.challanSerial}` : a.tds > 0 ? <Badge tone="danger">none</Badge> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
