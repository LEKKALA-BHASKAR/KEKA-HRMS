import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { SettingsTabs } from "../../billing/nav";
import { BillingEntityForm } from "../forms";

/**
 * Projects › Settings › Billing entities: which legal entity raises project
 * invoices, how it numbers invoices, proformas and credit notes, its default
 * payment term, bank details and footer. An entity is "ready" once set up.
 */
export default async function BillingEntitiesPage() {
  const viewer = await requireAuth(P.BILLING_MANAGE);
  const [entities, settings, used] = await Promise.all([
    prisma.legalEntity.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, state: true, city: true }, orderBy: { name: "asc" } }),
    prisma.billingEntitySetting.findMany({ where: { tenantId: viewer.tenantId } }),
    prisma.invoice.groupBy({ by: ["billingEntityId"], where: { tenantId: viewer.tenantId, billingEntityId: { not: null } }, _count: { _all: true } }),
  ]);
  return (
    <>
      <PageHead title="Billing entities" subtitle="Invoice numbering and terms for each legal entity that bills clients" />
      <SettingsTabs viewer={viewer} active="/projects/settings/billing-entities" />
      <div className="stack gap-3">
        {entities.length === 0 ? <Card><Empty title="No legal entities">Add one under Organisation first.</Empty></Card> : null}
        {entities.map((e) => {
          const s = settings.find((x) => x.legalEntityId === e.id);
          const count = used.find((u) => u.billingEntityId === e.id)?._count._all ?? 0;
          return (
            <Card key={e.id} title={<>{e.name} {s ? <Badge tone="success">Ready</Badge> : <Badge tone="neutral">Not set up</Badge>}</>}
              description={`${e.state ?? "No state"}${e.city ? ` · ${e.city}` : ""} · ${count} invoice(s) raised${s ? ` · next invoice ${s.invoicePrefix}${s.nextInvoiceNumber}${s.invoiceSuffix ?? ""}` : " · invoices fall back to INV-YYYY-NNNN"}`}>
              <BillingEntityForm legalEntityId={e.id} values={s ? {
                invoicePrefix: s.invoicePrefix, invoiceSuffix: s.invoiceSuffix, nextInvoiceNumber: s.nextInvoiceNumber, proformaPrefix: s.proformaPrefix, nextProformaNumber: s.nextProformaNumber,
                creditNotePrefix: s.creditNotePrefix, nextCreditNoteNumber: s.nextCreditNoteNumber, defaultPaymentTermDays: s.defaultPaymentTermDays, bankDetails: s.bankDetails, footer: s.footer,
              } : undefined} />
            </Card>
          );
        })}
      </div>
    </>
  );
}
