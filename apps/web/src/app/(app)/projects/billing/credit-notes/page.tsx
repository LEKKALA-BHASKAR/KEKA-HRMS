import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { CreditNoteForm, CreditNoteOps } from "../forms";
import { BillingTabs, money, label, CN_TONE } from "../nav";

/** Projects › Billing › Credit notes: raised, applied to an open invoice, or voided. */
export default async function CreditNotesPage() {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const [notes, clients, openInvoices] = await Promise.all([
    prisma.creditNote.findMany({ where: { tenantId: viewer.tenantId }, include: { client: { select: { name: true } }, invoice: { select: { id: true, invoiceNumber: true } } }, orderBy: [{ issueDate: "desc" }, { number: "desc" }], take: 200 }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.invoice.findMany({ where: { tenantId: viewer.tenantId, kind: "TAX", status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] } }, select: { id: true, clientId: true, invoiceNumber: true, amountDue: true, currency: true }, orderBy: { issueDate: "asc" } }),
  ]);
  const open = notes.filter((n) => n.status === "OPEN");
  return (
    <>
      <PageHead title="Credit notes" subtitle="Credit owed to a client. Applied to one of their open invoices, it reduces revenue, output tax and the receivable." />
      <BillingTabs active="/projects/billing/credit-notes" />
      <div className="stack gap-3">
        <div className="grid grid-3">
          <Stat label="Open" value={money(open.reduce((s, n) => s + Number(n.amount) + Number(n.taxAmount), 0))} meta={`${open.length} not yet applied`} />
          <Stat label="Applied" value={notes.filter((n) => n.status === "APPLIED").length} />
          <Stat label="Voided" value={notes.filter((n) => n.status === "VOID").length} />
        </div>
        <Card title="Raise a credit note" description="To credit a particular invoice, raise it from the invoice instead.">
          <CreditNoteForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} />
        </Card>
        <Card tight title="Credit notes">
          {notes.length === 0 ? <Empty title="No credit notes yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Credit note</th><th>Client</th><th>Reason</th><th className="num">Amount</th><th className="num">GST</th><th>Invoice</th><th>Status</th><th /></tr></thead>
              <tbody>{notes.map((n) => (
                <tr key={n.id}>
                  <td className="text-sm"><span className="strong">{n.number}</span><div className="text-xs subtle">{formatDate(n.issueDate)}</div></td>
                  <td className="text-sm">{n.client.name}</td>
                  <td className="text-sm">{n.reason}</td>
                  <td className="num">{money(n.amount, n.currency)}</td>
                  <td className="num">{Number(n.taxAmount) ? money(n.taxAmount, n.currency) : "—"}</td>
                  <td className="text-sm">{n.invoice ? <Link href={`/projects/billing/${n.invoice.id}`}>{n.invoice.invoiceNumber}</Link> : "—"}</td>
                  <td><Badge tone={CN_TONE[n.status]}>{label(n.status)}</Badge>{n.appliedAt ? <div className="text-xs subtle">{formatDate(n.appliedAt)}</div> : null}</td>
                  <td>{n.status === "OPEN" ? <CreditNoteOps creditNoteId={n.id} invoices={openInvoices.filter((i) => i.clientId === n.clientId && (!n.invoiceId || i.id === n.invoiceId)).map((i) => ({ value: i.id, label: `${i.invoiceNumber} (${money(i.amountDue, i.currency)} due)` }))} /> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
