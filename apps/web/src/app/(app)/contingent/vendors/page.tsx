import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { VENDOR_CHECKLIST } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { vendorScorecards } from "@/lib/workforce";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar } from "@/components/workforce-tables";
import { saveVendorAction } from "@/app/actions/contingent";
import { VendorFields } from "./fields";

const P = PERMISSIONS;

export default async function VendorsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.CONTINGENT_VIEW);
  const sp = await searchParams;
  const q = sp.q?.trim();
  const [vendors, cards] = await Promise.all([
    prisma.contingentVendor.findMany({
      where: { tenantId: viewer.tenantId, ...(sp.status ? { status: sp.status } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { gstin: { contains: q, mode: "insensitive" } }] } : {}) },
      include: { _count: { select: { workers: true } } }, orderBy: { name: "asc" },
    }),
    vendorScorecards(viewer.tenantId),
  ]);
  const card = new Map(cards.map((c) => [c.id, c]));
  return (
    <>
      <PageHead title="Vendor workforce registry" subtitle="Staffing agencies: onboarding checklist, compliance documents and scorecards." actions={<a className="btn sm" href="/contingent/export?report=vendors">Export CSV</a>} />
      {can(viewer, P.CONTINGENT_MANAGE) ? <Card title="Add a vendor"><Disclosure label="New vendor"><SimpleForm action={saveVendorAction} submitLabel="Add vendor"><VendorFields /></SimpleForm></Disclosure></Card> : null}
      <Card title="Vendors">
        <FilterBar action="/contingent/vendors">
          <F label="Search"><input className="input" name="q" defaultValue={sp.q} placeholder="Name, code or GSTIN" /></F>
          <F label="Status"><Select name="status" options={["ONBOARDING", "ACTIVE", "SUSPENDED", "INACTIVE"].map((s) => ({ value: s, label: s.toLowerCase() }))} defaultValue={sp.status} placeholder="Any" /></F>
        </FilterBar>
        {vendors.length === 0 ? <Empty title="No vendors match." /> : (
          <table className="data"><thead><tr><th>Vendor</th><th>GSTIN</th><th>Contact</th><th className="num">Workers</th><th>Onboarding</th><th>Compliance</th><th>Score</th><th>Status</th></tr></thead>
            <tbody>{vendors.map((v) => {
              const c = card.get(v.id);
              return (
                <tr key={v.id}><td><Link href={`/contingent/vendors/${v.id}`}>{v.name}</Link>{v.code ? <span className="muted text-xs"> {v.code}</span> : null}</td><td className="mono text-xs">{v.gstin}</td><td className="text-xs">{v.contactName}<div className="muted">{v.email}</div></td>
                  <td className="num">{v._count.workers}</td><td className="text-xs">{v.checklist.length}/{VENDOR_CHECKLIST.length}</td>
                  <td>{c?.compliance.compliant ? <Badge tone="success">compliant</Badge> : <Badge tone="danger">gaps</Badge>}</td><td>{c ? `${c.score} (${c.grade})` : ""}</td><td><StatusPill status={v.status} /></td></tr>
              );
            })}</tbody></table>
        )}
      </Card>
    </>
  );
}
