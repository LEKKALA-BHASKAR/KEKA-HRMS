import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select } from "@/components/workforce-ui";
import { FilterBar, inr } from "@/components/workforce-tables";
import { saveRateCardAction, endRateCardAction } from "@/app/actions/contingent";

const P = PERMISSIONS;

export default async function RateCardsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await requireAuth(P.CONTINGENT_VIEW);
  const sp = await searchParams;
  const q = sp.q?.trim();
  const canManage = can(viewer, P.CONTINGENT_MANAGE);
  const [cards, vendors] = await Promise.all([
    prisma.contractorRateCard.findMany({ where: { tenantId: viewer.tenantId, ...(q ? { role: { contains: q, mode: "insensitive" } } : {}) }, include: { vendor: { select: { name: true } } }, orderBy: [{ role: "asc" }, { effectiveFrom: "desc" }] }),
    prisma.contingentVendor.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const today = new Date();
  return (
    <>
      <PageHead title="Contractor rate cards" subtitle="Effective-dated rates per role, generic or per vendor. A contract without a rate takes the card in force on its start date." actions={<a className="btn sm" href="/contingent/export?report=rate-cards">Export CSV</a>} />
      {canManage ? (
        <Card title="Add a rate"><Disclosure label="New rate">
          <SimpleForm action={saveRateCardAction} submitLabel="Save rate">
            <div className="grid grid-3">
              <F label="Role *"><input className="input" name="role" required /></F>
              <F label="Vendor"><Select name="vendorId" options={vendors.map((v) => ({ value: v.id, label: v.name }))} placeholder="Any (generic)" /></F>
              <F label="Rate type"><Select name="rateType" options={["HOURLY", "DAILY", "MONTHLY", "FIXED"].map((v) => ({ value: v, label: v.toLowerCase() }))} defaultValue="HOURLY" /></F>
              <F label="Rate *"><input className="input" type="number" name="rate" step="0.01" min={0} required /></F>
              <F label="Effective from *"><input className="input" type="date" name="effectiveFrom" required /></F>
              <F label="Effective to"><input className="input" type="date" name="effectiveTo" /></F>
            </div>
          </SimpleForm>
        </Disclosure></Card>
      ) : null}
      <Card title="Rates">
        <FilterBar action="/contingent/rate-cards"><F label="Role"><input className="input" name="q" defaultValue={sp.q} /></F></FilterBar>
        {cards.length === 0 ? <Empty title="No rate cards yet." /> : (
          <table className="data"><thead><tr><th>Role</th><th>Vendor</th><th className="num">Rate</th><th>From</th><th>To</th><th /><th /></tr></thead>
            <tbody>{cards.map((c) => {
              const live = c.effectiveFrom <= today && (!c.effectiveTo || c.effectiveTo >= today);
              return (
                <tr key={c.id}><td>{c.role}</td><td>{c.vendor?.name ?? "Generic"}</td><td className="num">{inr(c.rate)} {c.rateType.toLowerCase()}</td><td>{formatDate(c.effectiveFrom)}</td><td>{c.effectiveTo ? formatDate(c.effectiveTo) : "open"}</td>
                  <td>{live ? <Badge tone="success">in force</Badge> : c.effectiveFrom > today ? <Badge tone="info">future</Badge> : <Badge>ended</Badge>}</td>
                  <td>{canManage && !c.effectiveTo ? <SimpleForm action={endRateCardAction} hidden={{ id: c.id }} submitLabel="End" inline><input className="input" type="date" name="effectiveTo" required /></SimpleForm> : null}</td></tr>
              );
            })}</tbody></table>
        )}
      </Card>
    </>
  );
}
