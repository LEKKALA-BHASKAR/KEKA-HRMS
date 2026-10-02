import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { markupPct } from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { SettingsTabs, money } from "../../billing/nav";
import { RateCardForm, RoleRateForm } from "../forms";

/**
 * Projects › Settings › Rate cards: the organisation's reference cards and
 * each client's negotiated card, with a bill rate (and suggested cost) per
 * billing role. Projects and resource estimates take their rates from here.
 */
export default async function RateCardsPage({ searchParams }: { searchParams: Promise<{ card?: string }> }) {
  const viewer = await requireAuth(P.RATE_CARD_MANAGE);
  const sp = await searchParams;
  const [cards, clients, roles] = await Promise.all([
    prisma.rateCard.findMany({ where: { tenantId: viewer.tenantId }, include: { client: { select: { name: true } }, rates: { orderBy: [{ billingRole: "asc" }, { rateCategory: "asc" }] }, _count: { select: { projects: true, estimates: true } } }, orderBy: [{ clientId: "asc" }, { name: "asc" }] }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.billingRole.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { name: true }, orderBy: { name: "asc" } }),
  ]);
  const orgCards = cards.filter((c) => !c.clientId), clientCards = cards.filter((c) => c.clientId);
  const card = cards.find((c) => c.id === sp.card) ?? cards[0];
  const clientOpts = clients.map((c) => ({ value: c.id, label: c.name }));
  const row = (c: (typeof cards)[number]) => (
    <tr key={c.id} style={c.id === card?.id ? { background: "var(--surface-sunken)" } : undefined}>
      <td><Link href={`?card=${c.id}`} className="strong text-sm">{c.name}</Link>{c.isActive ? null : <Badge tone="neutral">Inactive</Badge>}</td>
      <td className="text-sm">{c.client?.name ?? <span className="subtle">Reference</span>}</td>
      <td className="text-sm">{c.currency} · {c.rateUnit.toLowerCase()}</td>
      <td className="num">{c.rates.length}</td>
      <td className="num">{c._count.projects}</td>
    </tr>
  );
  return (
    <>
      <PageHead title="Rate cards" subtitle="Bill rates by billing role: an organisation reference, and cards negotiated per client" />
      <SettingsTabs viewer={viewer} active="/projects/settings/rate-cards" />
      <div className="stack gap-3">
        <Card title="New rate card" description="Leave the client empty for an organisation reference card.">
          <RateCardForm clients={clientOpts} />
        </Card>
        <div className="grid grid-2">
          <Card tight title={`Organisation reference (${orgCards.length})`}>
            {orgCards.length === 0 ? <Empty title="No reference card yet" /> : (
              <table className="data"><thead><tr><th>Card</th><th>Client</th><th>Unit</th><th className="num">Roles</th><th className="num">Projects</th></tr></thead><tbody>{orgCards.map(row)}</tbody></table>
            )}
          </Card>
          <Card tight title={`Client cards (${clientCards.length})`}>
            {clientCards.length === 0 ? <Empty title="No client cards yet" /> : (
              <table className="data"><thead><tr><th>Card</th><th>Client</th><th>Unit</th><th className="num">Roles</th><th className="num">Projects</th></tr></thead><tbody>{clientCards.map(row)}</tbody></table>
            )}
          </Card>
        </div>
        {card ? (
          <Card title={card.name} description={`${card.client ? `Negotiated with ${card.client.name}` : "Organisation reference"} · used by ${card._count.projects} project(s) and ${card._count.estimates} estimate(s)`}>
            <div className="stack gap-3">
              <RateCardForm card={{ id: card.id, name: card.name, currency: card.currency, rateUnit: card.rateUnit, clientId: card.clientId }} clients={clientOpts} />
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }} className="stack gap-2">
                {card.rates.length === 0 ? <span className="text-sm subtle">No rates on this card yet.</span> : null}
                {card.rates.map((r) => {
                  const m = markupPct(Number(r.billRate), r.suggestedCost === null ? null : Number(r.suggestedCost));
                  return (
                    <div key={r.id} className="stack gap-1">
                      <RoleRateForm rateCardId={card.id} roles={[...new Set([...roles.map((x) => x.name), r.billingRole])]} rate={{ id: r.id, billingRole: r.billingRole, rateCategory: r.rateCategory, billRate: Number(r.billRate), suggestedCost: r.suggestedCost === null ? null : Number(r.suggestedCost) }} />
                      <span className="text-xs subtle">{money(r.billRate, card.currency)}/{card.rateUnit === "DAILY" ? "day" : "hr"}{m === null ? "" : ` · markup ${m}%`}</span>
                    </div>
                  );
                })}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  {roles.length ? <RoleRateForm rateCardId={card.id} roles={roles.map((r) => r.name)} /> : <Empty title="Add billing roles first"><Link href="/projects/resources/settings">Roles & cost</Link></Empty>}
                </div>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
