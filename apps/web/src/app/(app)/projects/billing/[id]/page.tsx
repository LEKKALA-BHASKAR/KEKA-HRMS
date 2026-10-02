import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { invoiceStatusLabel } from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat, KeyValue } from "@/components/ui";
import { InvoiceOps } from "../../forms";
import { InvoiceActions, CreditNoteForm, CreditNoteOps } from "../forms";
import { BillingTabs, money, label, CN_TONE } from "../nav";

/** One invoice: its lines and totals, payments and credit notes, and what can still be done to it. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const { id } = await params;
  const inv = await prisma.invoice.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      client: true, project: { select: { id: true, name: true } }, lines: { orderBy: { sequence: "asc" } },
      payments: { orderBy: { paidOn: "asc" } }, creditNotes: { orderBy: { issueDate: "asc" } }, charges: { select: { id: true, number: true, name: true, status: true } },
    },
  });
  if (!inv) notFound();
  const [entity, convertedTo, convertedFrom, openNotes] = await Promise.all([
    inv.billingEntityId ? prisma.legalEntity.findFirst({ where: { tenantId: viewer.tenantId, id: inv.billingEntityId }, select: { name: true } }) : null,
    prisma.invoice.findFirst({ where: { tenantId: viewer.tenantId, convertedFromId: inv.id, status: { not: "CANCELLED" } }, select: { id: true, invoiceNumber: true } }),
    inv.convertedFromId ? prisma.invoice.findFirst({ where: { tenantId: viewer.tenantId, id: inv.convertedFromId }, select: { id: true, invoiceNumber: true } }) : null,
    prisma.creditNote.findMany({ where: { tenantId: viewer.tenantId, clientId: inv.clientId, status: "OPEN" }, orderBy: { issueDate: "asc" } }),
  ]);
  const st = invoiceStatusLabel({ status: inv.status, dueDate: inv.dueDate, amountDue: Number(inv.amountDue), kind: inv.kind }, new Date());
  const cur = inv.currency;
  const applied = inv.creditNotes.filter((c) => c.status === "APPLIED").reduce((s, c) => s + Number(c.amount) + Number(c.taxAmount), 0);
  const open = inv.kind === "TAX" && ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status);
  return (
    <>
      <PageHead title={`${inv.documentTitle} ${inv.invoiceNumber}`}
        subtitle={<>{inv.client.name}{inv.project ? <> · <Link href={`/projects/${inv.project.id}`}>{inv.project.name}</Link></> : null} · <Badge tone={st.tone}>{st.text}</Badge></>}
        actions={<Link className="btn sm" href="/projects/billing">All invoices</Link>} />
      <BillingTabs active="/projects/billing" />
      <div className="stack gap-3">
        <div className="grid grid-4">
          <Stat label="Total" value={money(inv.total, cur)} meta={`${money(inv.subtotal, cur)} + tax ${money(inv.taxTotal, cur)}`} />
          <Stat label="Paid" value={money(inv.amountPaid, cur)} meta={`${inv.payments.length} payment(s)`} />
          <Stat label="Credited" value={money(applied, cur)} meta={`${inv.creditNotes.length} credit note(s)`} />
          <Stat label={inv.status === "WRITTEN_OFF" ? "Written off" : "Outstanding"} value={money(inv.status === "WRITTEN_OFF" ? inv.writeOffAmount : inv.amountDue, cur)} tone={inv.status === "OVERDUE" ? "neg" : undefined} />
        </div>
        <Card title="Actions" description={inv.kind === "PROFORMA" ? "A proforma is a quote: it never reaches the books and nothing is due on it." : "Sending posts the receivable; a write-off moves what is left to bad debts; cancelling reverses the posting and frees the charges to bill again."}>
          <div className="stack gap-2">
            <InvoiceActions invoiceId={inv.id} status={inv.status} kind={inv.kind} paid={Number(inv.amountPaid)} converted={!!convertedTo} />
            {inv.status === "DRAFT" || open ? <InvoiceOps invoiceId={inv.id} status={inv.status} due={Number(inv.amountDue)} /> : null}
          </div>
        </Card>
        <Card title="Details">
          <KeyValue items={[
            ["Issued", formatDate(inv.issueDate)], ["Due", `${formatDate(inv.dueDate)} (${inv.paymentTermDays} days)`],
            ["Period", inv.periodStart ? `${formatDate(inv.periodStart)} – ${inv.periodEnd ? formatDate(inv.periodEnd) : "—"}` : null],
            ["Billing entity", entity?.name ?? null], ["PO number", inv.poNumber], ["Attention", [inv.attentionName, inv.attentionEmail].filter(Boolean).join(" · ") || null],
            ["Tax", inv.notes], ["Terms", inv.terms],
            ["Converted from", convertedFrom ? <Link key="f" href={`/projects/billing/${convertedFrom.id}`}>{convertedFrom.invoiceNumber}</Link> : null],
            ["Converted to", convertedTo ? <Link key="t" href={`/projects/billing/${convertedTo.id}`}>{convertedTo.invoiceNumber}</Link> : null],
            ["Written off", inv.writtenOffAt ? `${formatDate(inv.writtenOffAt)} — ${inv.writeOffReason ?? ""}` : null],
            ["Cancelled", inv.cancelledAt ? `${formatDate(inv.cancelledAt)} — ${inv.cancelReason ?? ""}` : null],
            ["PDF", inv.fileUrl ? <a key="pdf" href={inv.fileUrl}>Download</a> : null],
          ]} />
        </Card>
        <Card tight title="Lines">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Description</th><th>Type</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th><th className="num">Tax</th></tr></thead>
            <tbody>{inv.lines.map((l) => (
              <tr key={l.id}><td className="text-sm">{l.description}</td><td className="text-sm">{label(l.lineType)}</td><td className="num">{Number(l.quantity)}</td><td className="num">{money(l.unitRate, cur)}</td><td className="num">{money(l.amount, cur)}</td><td className="num">{Number(l.taxPercent)}%</td></tr>
            ))}</tbody>
            <tfoot>
              <tr><td colSpan={4} className="strong">Subtotal</td><td className="num">{money(inv.subtotal, cur)}</td><td /></tr>
              <tr><td colSpan={4}>Tax</td><td className="num">{money(inv.taxTotal, cur)}</td><td /></tr>
              <tr><td colSpan={4} className="strong">Total</td><td className="num strong">{money(inv.total, cur)}</td><td /></tr>
            </tfoot>
          </table></div>
          {inv.charges.length ? <div className="text-xs subtle" style={{ padding: "8px 16px" }}>Charges: {inv.charges.map((c) => `${c.number} ${c.name}`).join(" · ")}</div> : null}
        </Card>
        <div className="grid grid-2">
          <Card tight title="Payments">
            {inv.payments.length === 0 ? <Empty title="No payments recorded" /> : (
              <table className="data"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th></tr></thead>
                <tbody>{inv.payments.map((p) => <tr key={p.id}><td className="text-sm">{formatDate(p.paidOn)}</td><td className="text-sm">{label(p.method)}</td><td className="text-sm">{p.reference ?? "—"}</td><td className="num">{money(p.amount, cur)}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
          <Card tight title="Credit notes">
            {inv.creditNotes.length === 0 ? <Empty title="None against this invoice" /> : (
              <table className="data"><thead><tr><th>Credit note</th><th>Reason</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>{inv.creditNotes.map((c) => <tr key={c.id}><td className="text-sm strong">{c.number}<div className="text-xs subtle">{formatDate(c.issueDate)}</div></td><td className="text-sm">{c.reason}</td><td className="num">{money(Number(c.amount) + Number(c.taxAmount), cur)}</td><td><Badge tone={CN_TONE[c.status]}>{label(c.status)}</Badge></td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>
        {open ? (
          <Card title="Credit this invoice" description={`Up to ${money(inv.amountDue, cur)} can be credited. Applying reduces revenue, output tax and the receivable together.`}>
            <div className="stack gap-3">
              <CreditNoteForm invoiceId={inv.id} clientId={inv.clientId} />
              {openNotes.filter((c) => c.invoiceId === null || c.invoiceId === inv.id).map((c) => (
                <div key={c.id} className="row gap-2 wrap" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <span className="text-sm"><span className="strong">{c.number}</span> · {money(Number(c.amount) + Number(c.taxAmount), cur)} · {c.reason} <span className="subtle">(open)</span></span>
                  <CreditNoteOps creditNoteId={c.id} invoices={[{ value: inv.id, label: inv.invoiceNumber }]} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
