import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { GenerateCharges, AdhocChargeForm, DraftFromCharges } from "../forms";
import { BillingTabs, money, label } from "../nav";

const KIND_TONE: Record<string, "info" | "success" | "warning" | "neutral"> = { TIME: "info", MILESTONE: "success", RETAINER: "warning", EXPENSE: "neutral", ADHOC: "neutral" };

/**
 * Projects › Billing › Charges: what is ready to bill — approved time by
 * month, completed milestones, retainer periods, expenses charged to a
 * project and ad hoc charges. Select one client's charges to draft an invoice.
 */
export default async function ChargesPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const sp = await searchParams;
  const [unbilled, recent, entities, settings, projects, clients] = await Promise.all([
    prisma.projectCharge.findMany({
      where: { tenantId: viewer.tenantId, status: "UNBILLED", ...(sp.client ? { project: { clientId: sp.client } } : {}) },
      include: { project: { select: { id: true, name: true, client: { select: { id: true, name: true } } } }, invoice: { select: { id: true, invoiceNumber: true } } },
      orderBy: [{ periodStart: "asc" }, { number: "asc" }],
    }),
    prisma.projectCharge.findMany({ where: { tenantId: viewer.tenantId, status: "INVOICED" }, include: { project: { select: { name: true } }, invoice: { select: { id: true, invoiceNumber: true } } }, orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.legalEntity.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.billingEntitySetting.findMany({ where: { tenantId: viewer.tenantId } }),
    prisma.project.findMany({ where: { tenantId: viewer.tenantId, clientId: { not: null }, billingModel: { not: "NON_BILLABLE" }, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const byClient = new Map<string, { name: string; rows: typeof unbilled }>();
  for (const c of unbilled) {
    const k = c.project.client?.id ?? "none";
    const g = byClient.get(k) ?? { name: c.project.client?.name ?? "No client", rows: [] };
    g.rows.push(c);
    byClient.set(k, g);
  }
  const ready = settings.map((s) => s.legalEntityId);
  const entityOpts = entities.map((e) => ({ value: e.id, label: ready.includes(e.id) ? e.name : `${e.name} (numbering not set up)`, termDays: settings.find((s) => s.legalEntityId === e.id)?.defaultPaymentTermDays ?? null }));
  return (
    <>
      <PageHead title="Charges" subtitle="Everything ready to bill, by client. Charges of one client go on one invoice." actions={<GenerateCharges />} />
      <BillingTabs active="/projects/billing/charges" />
      <div className="stack gap-3">
        <div className="grid grid-3">
          <Stat label="Unbilled" value={money(unbilled.reduce((s, c) => s + Number(c.amount), 0))} meta={`${unbilled.length} charge(s), ${byClient.size} client(s)`} />
          <Stat label="Expenses to bill" value={money(unbilled.filter((c) => c.kind === "EXPENSE").reduce((s, c) => s + Number(c.amount), 0))} meta="approved claims charged to projects" />
          <Stat label="On a proforma" value={unbilled.filter((c) => c.invoice).length} meta="convert the proforma to bill them" />
        </div>
        <Card title="Ad hoc charge" description="Anything else to bill: a pass-through licence, travel agreed as a fixed fee.">
          <AdhocChargeForm projects={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Card>
        <form className="row gap-2">
          <select className="select" name="client" defaultValue={sp.client ?? ""} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Client"><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn sm">Filter</button>
        </form>
        {byClient.size === 0 ? <Card><Empty title="Nothing to bill">Approved time, completed milestones, retainer periods and charged expenses appear here once charges are brought up to date.</Empty></Card> : null}
        {[...byClient.entries()].map(([clientId, g]) => (
          <Card key={clientId} tight title={g.name} description={`${g.rows.length} unbilled · ${money(g.rows.reduce((s, c) => s + Number(c.amount), 0))}`}>
            <DraftFromCharges entities={entityOpts}>
              <div className="table-wrap"><table className="data">
                <thead><tr><th style={{ width: 28 }} /><th>Charge</th><th>Project</th><th>Kind</th><th>Period</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
                <tbody>{g.rows.map((c) => (
                  <tr key={c.id}>
                    <td><input type="checkbox" name="chargeId" value={c.id} defaultChecked={!c.invoice} disabled={!!c.invoice} aria-label={`Bill ${c.number}`} /></td>
                    <td className="text-sm"><span className="strong">{c.number}</span> {c.name}{c.invoice ? <div className="text-xs subtle">On proforma <Link href={`/projects/billing/${c.invoice.id}`}>{c.invoice.invoiceNumber}</Link></div> : null}</td>
                    <td className="text-sm"><Link href={`/projects/${c.project.id}/billing`}>{c.project.name}</Link></td>
                    <td><Badge tone={KIND_TONE[c.kind]}>{label(c.kind)}</Badge></td>
                    <td className="text-sm nowrap">{c.periodStart ? formatDate(c.periodStart) : "—"}{c.periodEnd && c.periodStart && c.periodEnd.getTime() !== c.periodStart.getTime() ? ` – ${formatDate(c.periodEnd)}` : ""}</td>
                    <td className="num">{Number(c.quantity)}</td>
                    <td className="num">{money(c.amount, c.currency)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </DraftFromCharges>
          </Card>
        ))}
        <Card tight title="Recently invoiced">
          {recent.length === 0 ? <Empty title="Nothing invoiced yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Charge</th><th>Project</th><th>Kind</th><th className="num">Amount</th><th>Invoice</th></tr></thead>
              <tbody>{recent.map((c) => (
                <tr key={c.id}><td className="text-sm"><span className="strong">{c.number}</span> {c.name}</td><td className="text-sm">{c.project.name}</td><td><Badge tone={KIND_TONE[c.kind]}>{label(c.kind)}</Badge></td><td className="num">{money(c.amount, c.currency)}</td>
                  <td className="text-sm">{c.invoice ? <Link href={`/projects/billing/${c.invoice.id}`}>{c.invoice.invoiceNumber}</Link> : "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
