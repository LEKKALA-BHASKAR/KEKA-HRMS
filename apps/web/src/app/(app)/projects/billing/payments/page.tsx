import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Stat } from "@/components/ui";
import { BillingTabs, money, label, iso } from "../nav";

/** Projects › Billing › Payments: every receipt recorded against an invoice, in a date window. */
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; client?: string }> }) {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const sp = await searchParams;
  const now = new Date();
  const ok = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
  const from = ok(sp.from) ? new Date(`${sp.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const to = ok(sp.to) ? new Date(`${sp.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const [payments, clients] = await Promise.all([
    prisma.invoicePayment.findMany({
      where: { invoice: { tenantId: viewer.tenantId, ...(sp.client ? { clientId: sp.client } : {}) }, paidOn: { gte: from, lte: to } },
      include: { invoice: { select: { id: true, invoiceNumber: true, currency: true, client: { select: { name: true } }, project: { select: { name: true } } } } },
      orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }], take: 500,
    }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const total = payments.reduce((s, p) => s + Number(p.amount), 0);
  const byClient = new Map<string, number>();
  for (const p of payments) byClient.set(p.invoice.client.name, (byClient.get(p.invoice.client.name) ?? 0) + Number(p.amount));
  const top = [...byClient].sort((a, b) => b[1] - a[1])[0];
  return (
    <>
      <PageHead title="Payments" subtitle={`Receipts from ${formatDate(from)} to ${formatDate(to)}. Record one from the invoice it pays.`} />
      <BillingTabs active="/projects/billing/payments" />
      <div className="stack gap-3">
        <div className="grid grid-3">
          <Stat label="Received" value={money(total)} meta={`${payments.length} payment(s)`} />
          <Stat label="Clients paying" value={byClient.size} />
          <Stat label="Largest payer" value={top ? top[0] : "—"} meta={top ? money(top[1]) : undefined} />
        </div>
        <Card tight title="Payments"
          action={
            <form className="row gap-2">
              <input className="input" type="date" name="from" defaultValue={iso(from)} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="From" />
              <input className="input" type="date" name="to" defaultValue={iso(to)} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="To" />
              <select className="select" name="client" defaultValue={sp.client ?? ""} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Client"><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <button className="btn sm">Apply</button>
            </form>
          }>
          {payments.length === 0 ? <Empty title="No payments in this window" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Client</th><th>Invoice</th><th>Method</th><th>Reference</th><th className="num">Amount</th></tr></thead>
              <tbody>{payments.map((p) => (
                <tr key={p.id}>
                  <td className="text-sm nowrap">{formatDate(p.paidOn)}</td>
                  <td className="text-sm">{p.invoice.client.name}<div className="text-xs subtle">{p.invoice.project?.name ?? ""}</div></td>
                  <td className="text-sm"><Link href={`/projects/billing/${p.invoice.id}`}>{p.invoice.invoiceNumber}</Link></td>
                  <td className="text-sm">{label(p.method)}</td>
                  <td className="text-sm">{p.reference ?? "—"}</td>
                  <td className="num">{money(p.amount, p.invoice.currency)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
