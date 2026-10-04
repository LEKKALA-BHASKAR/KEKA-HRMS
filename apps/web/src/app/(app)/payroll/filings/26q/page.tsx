import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fyLabel, formatDate, formatINR } from "@keka/shared";
import { CONTRACTOR_SECTIONS, quarterRange, quarterOfMonth, currentFy } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Badge, Stat, Callout } from "@/components/ui";
import { IconDownload } from "@/components/icons";
import { DepthForm } from "../../_forms/depth";
import { saveContractorAction, recordContractorPaymentAction, deleteContractorPaymentAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;

/**
 * Contractor TDS: the contractors and professionals paid outside salary, a
 * register of payments with TDS worked out by section, and the quarterly
 * Form 26Q data export (like the 24Q export for salary).
 */
export default async function Form26qPage({ searchParams }: { searchParams: Promise<{ fy?: string; q?: string }> }) {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const sp = await searchParams;
  const now = new Date();
  const fy = Number(sp.fy) || currentFy(now, viewer.tenant.fyStartMonth);
  const q = Number(sp.q) >= 1 && Number(sp.q) <= 4 ? Number(sp.q) : quarterOfMonth(now.getUTCMonth() + 1);
  const { start, end } = quarterRange(fy, q);
  const [contractors, payments] = await Promise.all([
    prisma.tdsContractor.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, include: { _count: { select: { payments: true } } } }),
    prisma.contractorPayment.findMany({ where: { tenantId: viewer.tenantId, paymentDate: { gte: start, lte: end } }, include: { contractor: { select: { name: true, pan: true } } }, orderBy: { paymentDate: "desc" } }),
  ]);
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const tds = payments.reduce((s, p) => s + Number(p.tdsAmount), 0);
  const undeposited = payments.filter((p) => !p.challanNumber).reduce((s, p) => s + Number(p.tdsAmount), 0);
  const qs = (f: number, qq: number) => `/payroll/filings/26q?fy=${f}&q=${qq}`;

  return (
    <>
      <PageHead title="Contractor TDS — Form 26Q" subtitle={`Payments to contractors and professionals, Q${q} of FY ${fyLabel(fy)} (${formatDate(start)} – ${formatDate(end)})`}
        actions={<>
          <Link className="btn sm" href={q === 1 ? qs(fy - 1, 4) : qs(fy, q - 1)}>‹ Previous quarter</Link>
          <Link className="btn sm" href={q === 4 ? qs(fy + 1, 1) : qs(fy, q + 1)}>Next quarter ›</Link>
          <Link className="btn" href="/payroll/filings/24q">Salary TDS (24Q)</Link>
          <a className="btn primary" href={`/payroll/filings/26q/export?fy=${fy}&q=${q}`}><IconDownload width={15} height={15} />26Q CSV</a>
        </>} />
      <Callout tone="info" title="Not an FVU file">
        The export carries the quarter&apos;s deductee and challan data for the Return Preparation Utility; validate the prepared return with the official FVU before upload.
      </Callout>
      <div className="grid grid-4" style={{ margin: "14px 0" }}>
        <Stat label="Payments" value={payments.length} />
        <Stat label="Amount paid" value={formatINR(paid, false)} />
        <Stat label="TDS deducted" value={formatINR(tds, false)} />
        <Stat label="Not yet deposited" value={formatINR(undeposited, false)} tone={undeposited > 0 ? "neg" : undefined} />
      </div>
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
        <Card tight title="Payments this quarter">
          {payments.length === 0 ? <Empty title="No payments recorded this quarter" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th>Contractor</th><th>Section</th><th className="num">Paid</th><th className="num">Rate</th><th className="num">TDS</th><th>Challan</th><th /></tr></thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">{formatDate(p.paymentDate)}</td>
                      <td>{p.contractor.name}{p.contractor.pan ? <div className="mono text-xs subtle">{p.contractor.pan}</div> : <div><Badge tone="warning">No PAN</Badge></div>}{p.invoiceNumber ? <div className="text-xs subtle">Inv {p.invoiceNumber}</div> : null}</td>
                      <td className="mono">{p.section}</td>
                      <td className="num">{formatINR(Number(p.amount), false)}</td>
                      <td className="num">{Number(p.tdsRate)}%</td>
                      <td className="num strong">{formatINR(Number(p.tdsAmount), false)}</td>
                      <td className="text-xs">{p.challanNumber ? `${p.bsrCode ?? ""} / ${p.challanNumber}` : <Badge tone="warning">Pending</Badge>}</td>
                      <td><DepthForm action={deleteContractorPaymentAction} inline variant="ghost" submitLabel="Remove" hidden={{ id: p.id }} confirmText="Remove this payment?" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="stack gap-4">
          <Card title="Record a payment">
            {contractors.length === 0 ? <div className="text-sm subtle">Add a contractor first.</div> : (
              <DepthForm action={recordContractorPaymentAction} submitLabel="Record payment">
                <div className="field"><label className="label" htmlFor="cp-c">Contractor</label>
                  <select id="cp-c" className="select" name="contractorId" required>
                    {contractors.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name} — {c.section} @ {Number(c.tdsRate)}%</option>)}
                  </select></div>
                <div className="grid grid-2">
                  <div className="field"><label className="label" htmlFor="cp-d">Date paid</label><input id="cp-d" className="input" type="date" name="paymentDate" required defaultValue={now.toISOString().slice(0, 10)} /></div>
                  <div className="field"><label className="label" htmlFor="cp-a">Amount (₹)</label><input id="cp-a" className="input num" type="number" name="amount" min={1} required /></div>
                  <div className="field"><label className="label" htmlFor="cp-i">Invoice no.</label><input id="cp-i" className="input" name="invoiceNumber" /></div>
                  <div className="field"><label className="label" htmlFor="cp-dd">Deposited on</label><input id="cp-dd" className="input" type="date" name="depositDate" /></div>
                  <div className="field"><label className="label" htmlFor="cp-b">BSR code</label><input id="cp-b" className="input mono" name="bsrCode" maxLength={7} /></div>
                  <div className="field"><label className="label" htmlFor="cp-ch">Challan serial</label><input id="cp-ch" className="input mono" name="challanNumber" maxLength={10} /></div>
                </div>
              </DepthForm>
            )}
          </Card>
          <Card title="Add a contractor">
            <DepthForm action={saveContractorAction} submitLabel="Add contractor">
              <div className="field"><label className="label" htmlFor="ct-n">Name</label><input id="ct-n" className="input" name="name" required maxLength={160} /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label" htmlFor="ct-p">PAN</label><input id="ct-p" className="input mono" name="pan" maxLength={10} placeholder="ABCDE1234F" /></div>
                <div className="field"><label className="label" htmlFor="ct-t">Deductee</label>
                  <select id="ct-t" className="select" name="deducteeType"><option value="INDIVIDUAL">Individual / HUF</option><option value="OTHER">Company / firm</option></select></div>
                <div className="field"><label className="label" htmlFor="ct-s">Section</label>
                  <select id="ct-s" className="select" name="section">{Object.entries(CONTRACTOR_SECTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="ct-r">TDS rate %</label><input id="ct-r" className="input num" name="tdsRate" type="number" step="0.01" min={0} max={30} placeholder="Section default" /></div>
              </div>
              <div className="field"><label className="label" htmlFor="ct-e">Email</label><input id="ct-e" className="input" name="email" type="email" /></div>
            </DepthForm>
          </Card>
          <Card tight title={`Contractors (${contractors.length})`}>
            {contractors.length === 0 ? <Empty title="None yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {contractors.map((c) => (
                      <tr key={c.id}><td>{c.name}<div className="mono text-xs subtle">{c.pan ?? "No PAN — 20% applies"}</div></td><td className="mono">{c.section}</td><td className="num">{Number(c.tdsRate)}%</td><td className="num text-xs">{c._count.payments} paid</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
