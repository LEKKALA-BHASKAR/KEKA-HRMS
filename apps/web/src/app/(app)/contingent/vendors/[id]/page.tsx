import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { VENDOR_CHECKLIST, vendorCompliance, vendorScore } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { auditTrail } from "@/lib/workforce";
import { PageHead, Card, KeyValue, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, AuditTable, inr } from "@/components/workforce-tables";
import { saveVendorAction, saveVendorChecklistAction, setVendorStatusAction, addVendorDocumentAction, deleteVendorDocumentAction } from "@/app/actions/contingent";
import { VendorFields } from "../fields";

const P = PERMISSIONS;

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.CONTINGENT_VIEW);
  const { id } = await params;
  const v = await prisma.contingentVendor.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { documents: { orderBy: { createdAt: "desc" } }, workers: { include: { feedback: { select: { rating: true } } }, orderBy: { code: "asc" } }, rateCards: { orderBy: { effectiveFrom: "desc" } } },
  });
  if (!v) notFound();
  const canManage = can(viewer, P.CONTINGENT_MANAGE);
  const audit = await auditTrail(viewer.tenantId, ["ContingentVendor"], v.id);
  const compliance = vendorCompliance(v.documents, new Date());
  const score = vendorScore({ ratings: v.workers.flatMap((w) => w.feedback.map((f) => f.rating)), compliant: compliance.compliant, checklistDone: v.checklist.length, checklistTotal: VENDOR_CHECKLIST.length });
  return (
    <>
      <PageHead title={v.name} subtitle={<><StatusPill status={v.status} /> scorecard {score.score}/100 (grade {score.grade}){score.avgRating !== null ? ` · average rating ${score.avgRating}` : ""}</>} actions={<Link className="btn sm" href="/contingent/vendors">All vendors</Link>} />
      <div className="grid grid-2">
        <Card title="Vendor">
          <KeyValue items={[["Code", v.code], ["GSTIN", v.gstin], ["PAN", v.pan], ["Contact", v.contactName], ["Email", v.email], ["Phone", v.phone], ["Address", v.address]]} />
          {canManage ? (
            <div className="row gap-2 wrap" style={{ marginTop: 10, alignItems: "flex-start" }}>
              <Disclosure label="Edit" variant="default"><SimpleForm action={saveVendorAction} hidden={{ id: v.id }}><VendorFields d={v} /></SimpleForm></Disclosure>
              {v.status !== "ACTIVE" ? <ActionButton action={setVendorStatusAction} hidden={{ id: v.id, status: "ACTIVE" }} label="Activate" variant="primary" /> : null}
              {v.status === "ACTIVE" ? <ActionButton action={setVendorStatusAction} hidden={{ id: v.id, status: "SUSPENDED" }} label="Suspend" /> : null}
              {v.status !== "INACTIVE" ? <ActionButton action={setVendorStatusAction} hidden={{ id: v.id, status: "INACTIVE" }} label="Deactivate" /> : null}
            </div>
          ) : null}
        </Card>
        <Card title="Onboarding checklist" description={`${v.checklist.length} of ${VENDOR_CHECKLIST.length} done`}>
          {canManage ? (
            <SimpleForm action={saveVendorChecklistAction} hidden={{ id: v.id }} submitLabel="Save checklist">
              {VENDOR_CHECKLIST.map((c) => <label key={c.key} className="checkbox-row"><input type="checkbox" name="items" value={c.key} defaultChecked={v.checklist.includes(c.key)} /> <span className="text-sm">{c.label}</span></label>)}
            </SimpleForm>
          ) : <ul>{VENDOR_CHECKLIST.map((c) => <li key={c.key} className="text-sm">{v.checklist.includes(c.key) ? "✓" : "○"} {c.label}</li>)}</ul>}
        </Card>
      </div>
      <Card title="Compliance documents" description={compliance.compliant ? "All required documents are present and in date." : `Missing: ${compliance.missing.join(", ") || "none"} · expired: ${compliance.expired.join(", ") || "none"}`}>
        {v.documents.length === 0 ? <Empty title="No documents yet." /> : (
          <table className="data"><thead><tr><th>Type</th><th>Number</th><th>Valid from</th><th>Valid until</th><th /><th /></tr></thead>
            <tbody>{v.documents.map((d) => (
              <tr key={d.id}><td>{d.docType}</td><td className="mono">{d.number}</td><td>{formatDate(d.validFrom)}</td><td>{formatDate(d.validUntil)}</td>
                <td>{d.validUntil && d.validUntil < new Date() ? <Badge tone="danger">expired</Badge> : compliance.expiringSoon.includes(d.docType) ? <Badge tone="warning">expiring</Badge> : null}</td>
                <td>{canManage ? <ActionButton action={deleteVendorDocumentAction} hidden={{ id: d.id }} label="Remove" confirmText="Remove this document?" /> : null}</td></tr>
            ))}</tbody></table>
        )}
        {canManage ? (
          <div style={{ marginTop: 10 }}><SimpleForm action={addVendorDocumentAction} hidden={{ vendorId: v.id }} submitLabel="Add document" inline>
            <F label="Type"><Select name="docType" options={["MSA", "GST_CERT", "PAN", "INSURANCE", "LABOUR_LICENCE", "PF_REG", "ESI_REG", "OTHER"].map((t) => ({ value: t, label: t.replace("_", " ") }))} /></F>
            <F label="Number"><input className="input" name="number" /></F>
            <F label="Valid from"><input className="input" type="date" name="validFrom" /></F>
            <F label="Valid until"><input className="input" type="date" name="validUntil" /></F>
          </SimpleForm></div>
        ) : null}
      </Card>
      <div className="grid grid-2">
        <Card title="Workers from this vendor">
          {v.workers.length === 0 ? <Empty title="None yet." /> : <table className="data"><tbody>{v.workers.map((w) => <tr key={w.id}><td><Link href={`/contingent/workers/${w.id}`}>{w.code}</Link> {w.firstName} {w.lastName}</td><td><StatusPill status={w.status} /></td></tr>)}</tbody></table>}
        </Card>
        <Card title="Vendor rate cards">
          {v.rateCards.length === 0 ? <Empty title="No vendor-specific rates." /> : <table className="data"><tbody>{v.rateCards.map((r) => <tr key={r.id}><td>{r.role}</td><td className="num">{inr(r.rate)} {r.rateType.toLowerCase()}</td><td className="text-xs">{formatDate(r.effectiveFrom)} → {r.effectiveTo ? formatDate(r.effectiveTo) : "open"}</td></tr>)}</tbody></table>}
        </Card>
      </div>
      <Card title="Audit trail"><AuditTable rows={audit} /></Card>
    </>
  );
}
