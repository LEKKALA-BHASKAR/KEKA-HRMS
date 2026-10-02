import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { invoiceStatusLabel } from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { BillingTabs, firstSettingsHref, money } from "./nav";

const FILTERS: Record<string, { label: string; where: Record<string, unknown> }> = {
  all: { label: "All", where: {} },
  draft: { label: "Drafts", where: { status: "DRAFT" } },
  open: { label: "Unpaid", where: { kind: "TAX", status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] } } },
  overdue: { label: "Overdue", where: { status: "OVERDUE" } },
  proforma: { label: "Proforma", where: { kind: "PROFORMA" } },
  closed: { label: "Paid, written off or cancelled", where: { status: { in: ["PAID", "WRITTEN_OFF", "CANCELLED"] } } },
};

/** Projects › Billing: every invoice and proforma, with what is still owed. */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ status?: string; client?: string }> }) {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const sp = await searchParams;
  const filter = FILTERS[sp.status ?? ""] ? sp.status! : "all";
  const today = new Date();
  const year = today.getUTCFullYear();
  const [list, open, collected, clients, written] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId: viewer.tenantId, ...FILTERS[filter].where, ...(sp.client ? { clientId: sp.client } : {}) },
      include: { client: { select: { name: true } }, project: { select: { id: true, name: true } }, _count: { select: { creditNotes: true } } },
      orderBy: [{ issueDate: "desc" }, { invoiceNumber: "desc" }], take: 200,
    }),
    prisma.invoice.findMany({ where: { tenantId: viewer.tenantId, kind: "TAX", status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] } }, select: { amountDue: true, dueDate: true } }),
    prisma.invoicePayment.aggregate({ where: { invoice: { tenantId: viewer.tenantId }, paidOn: { gte: new Date(Date.UTC(year, 0, 1)) } }, _sum: { amount: true } }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.invoice.aggregate({ where: { tenantId: viewer.tenantId, status: "WRITTEN_OFF", writtenOffAt: { gte: new Date(Date.UTC(year, 0, 1)) } }, _sum: { writeOffAmount: true } }),
  ]);
  const overdue = open.filter((i) => i.dueDate < today);
  const settings = firstSettingsHref(viewer);
  return (
    <>
      <PageHead title="Billing" subtitle="Invoices raised from project charges; write-offs, cancellations and credit notes keep the books in step"
        actions={<>{settings ? <Link className="btn" href={settings}>Billing settings</Link> : null}<Link className="btn" href="/projects?tab=billing">Clients</Link></>} />
      <BillingTabs active="/projects/billing" />
      <div className="stack gap-3">
        <div className="grid grid-4">
          <Stat label="Receivable" value={money(open.reduce((s, i) => s + Number(i.amountDue), 0))} meta={`${open.length} unpaid invoice(s)`} />
          <Stat label="Overdue" value={money(overdue.reduce((s, i) => s + Number(i.amountDue), 0))} meta={`${overdue.length} invoice(s)`} tone={overdue.length ? "neg" : undefined} />
          <Stat label={`Collected in ${year}`} value={money(collected._sum.amount ?? 0)} />
          <Stat label={`Written off in ${year}`} value={money(written._sum.writeOffAmount ?? 0)} />
        </div>
        <Card tight title="Invoices" description="Draft them from Charges; open one to send, record a payment, credit, write off or cancel it."
          action={
            <form className="row gap-2">
              <select className="select" name="status" defaultValue={filter} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Status">{Object.entries(FILTERS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}</select>
              <select className="select" name="client" defaultValue={sp.client ?? ""} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Client"><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <button className="btn sm">Apply</button>
            </form>
          }>
          {list.length === 0 ? <Empty title="No invoices match"><Link href="/projects/billing/charges">Draft one from charges</Link></Empty> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
              <tbody>{list.map((i) => {
                const st = invoiceStatusLabel({ status: i.status, dueDate: i.dueDate, amountDue: Number(i.amountDue), kind: i.kind }, today);
                return (
                  <tr key={i.id}>
                    <td><Link href={`/projects/billing/${i.id}`} className="strong text-sm">{i.invoiceNumber}</Link>{i.kind === "PROFORMA" ? <Badge tone="neutral">Proforma</Badge> : null}
                      <div className="text-xs subtle">{i.project ? i.project.name : "Several projects"}{i._count.creditNotes ? ` · ${i._count.creditNotes} credit note(s)` : ""}</div></td>
                    <td className="text-sm">{i.client.name}</td>
                    <td className="text-sm nowrap">{formatDate(i.issueDate)}</td>
                    <td className="text-sm nowrap">{formatDate(i.dueDate)}</td>
                    <td className="num">{money(i.total, i.currency)}</td>
                    <td className="num">{Number(i.amountDue) ? money(i.amountDue, i.currency) : "—"}</td>
                    <td><Badge tone={st.tone}>{st.text}</Badge></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
