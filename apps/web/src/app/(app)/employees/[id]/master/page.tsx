import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { completenessGaps, dataFreshness, NOMINEE_BENEFITS } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { isHrFor } from "@/lib/core-hr";
import { peopleQualityFacts } from "@/lib/core2";
import { PageHead, Card, Badge, Empty, KeyValue, Callout, AccessDenied } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton } from "@/components/spec-form";
import { saveProfileExtraAction, changeNationalityAction, saveEmployeeIdentifierAction, deleteEmployeeIdentifierAction } from "@/app/actions/core2-people";
import { setEmployeeStatusTagAction } from "@/app/actions/core2-setup";

export const metadata = { title: "Master data — BooS-HR" };

const P = PERMISSIONS;

/**
 * An employee's master data beyond the profile: salutation, pronouns,
 * languages and a work-address override; the company's own status; the
 * nationality history; aliases and external system identifiers; nominee
 * shares; and what the completeness rules still want.
 */
export default async function MasterDataPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.EMPLOYEE_VIEW);
  const { id } = await params;
  const emp = await prisma.employee.findFirst({ where: { id, tenantId: viewer.tenantId }, select: { id: true, displayName: true, employeeNumber: true, status: true, nationality: true, workerTypeId: true, updatedAt: true } });
  if (!emp) notFound();
  if (!(await isHrFor(viewer, id, P.EMPLOYEE_VIEW))) return <AccessDenied permission={P.EMPLOYEE_VIEW} what="this master data" />;
  const hr = await isHrFor(viewer, id);
  const t = viewer.tenantId;
  const [extra, tag, catalog, nationality, identifiers, rules, facts, nominees, deps] = await Promise.all([
    prisma.employeeProfileExtra.findUnique({ where: { employeeId: id } }),
    prisma.employeeStatusTag.findUnique({ where: { employeeId: id } }),
    prisma.employeeStatusCatalog.findMany({ where: { tenantId: t, isActive: true }, orderBy: { label: "asc" } }),
    prisma.nationalityHistory.findMany({ where: { tenantId: t, employeeId: id }, orderBy: { validFrom: "desc" } }),
    prisma.employeeIdentifier.findMany({ where: { tenantId: t, employeeId: id }, orderBy: [{ kind: "asc" }, { system: "asc" }] }),
    prisma.fieldCompletenessRule.findMany({ where: { tenantId: t, isActive: true } }),
    peopleQualityFacts({ id, tenantId: t }),
    prisma.nomineeAllocation.findMany({ where: { tenantId: t, employeeId: id } }),
    prisma.dependent.findMany({ where: { employeeId: id }, select: { id: true, name: true, relationship: true } }),
  ]);
  const gaps = facts[0] ? completenessGaps(facts[0], rules) : [];
  const status = tag ? catalog.find((c) => c.id === tag.catalogId) : null;
  const fresh = dataFreshness(extra && extra.updatedAt > emp.updatedAt ? extra.updatedAt : emp.updatedAt);
  const own = catalog.filter((c) => c.baseStatus === emp.status);
  return (
    <>
      <PageHead title={`${emp.displayName} — master data`} subtitle={`${emp.employeeNumber} · ${emp.status.toLowerCase().replace("_", " ")}`} actions={<><Link className="btn" href={`/employees/${id}`}>Profile</Link><Link className="btn" href={`/hr-ops/quality?tab=compare&a=${id}`}>Compare with…</Link></>} />
      <div className="row gap-2" style={{ marginBottom: 12 }}>
        <Badge tone={fresh.level === "FRESH" ? "success" : fresh.level === "AGING" ? "warning" : "danger"}>{fresh.label}</Badge>
        {status ? <Badge tone="info">{status.label}</Badge> : null}
        {extra?.personalEmailVerifiedAt ? <Badge tone="success">personal email verified</Badge> : null}
      </div>
      {gaps.length ? <Callout tone={gaps.some((g) => g.severity === "ERROR") ? "danger" : "warning"} title="Missing master data">{gaps.map((g) => g.label).join(", ")}</Callout> : null}
      <div className="grid grid-2">
        <Card title="Name and address details">
          <KeyValue items={[
            ["Salutation", extra?.salutation ?? "—"], ["Pronouns", extra?.pronouns ?? "—"], ["Languages", extra?.languages.join(", ") || "—"],
            ["Work address", extra?.workAddressLine1 ? [extra.workAddressLine1, extra.workAddressLine2, extra.workCity, extra.workState, extra.workPostalCode].filter(Boolean).join(", ") : "Office location"],
          ]} />
          {hr ? <SpecDisclosure label="Edit"><SpecForm action={saveProfileExtraAction} hidden={{ employeeId: id }} fields={[
            { name: "salutation", label: "Salutation", kind: "select", options: ["Mr", "Ms", "Mrs", "Mx", "Dr", "Prof"].map((s) => ({ value: s, label: s })), defaultValue: extra?.salutation },
            { name: "pronouns", label: "Pronouns", defaultValue: extra?.pronouns, placeholder: "she/her" }, { name: "languages", label: "Languages (comma-separated)", defaultValue: extra?.languages.join(", "), wide: true },
            { name: "workAddressLine1", label: "Work address line 1", defaultValue: extra?.workAddressLine1 }, { name: "workAddressLine2", label: "Line 2", defaultValue: extra?.workAddressLine2 },
            { name: "workCity", label: "City", defaultValue: extra?.workCity }, { name: "workState", label: "State", defaultValue: extra?.workState },
            { name: "workPostalCode", label: "PIN code", defaultValue: extra?.workPostalCode }, { name: "workAddressNote", label: "Why it differs", defaultValue: extra?.workAddressNote },
          ]} /></SpecDisclosure> : null}
        </Card>
        <Card title="Company status" description="The company's own status, under the system status.">
          <div style={{ marginBottom: 8 }}>{status ? <><Badge tone="info">{status.label}</Badge> <span className="text-sm muted">since {formatDate(tag!.since)}{tag!.note ? ` · ${tag!.note}` : ""}</span></> : <span className="muted">None set</span>}</div>
          {hr && own.length ? <SpecForm compact action={setEmployeeStatusTagAction} hidden={{ employeeId: id }} submitLabel="Set" fields={[{ name: "catalogId", label: "Status", kind: "select", options: own.map((c) => ({ value: c.id, label: c.label })), defaultValue: tag?.catalogId }, { name: "note", label: "Note" }]} /> : hr ? <div className="text-sm muted">No catalog statuses sit under {emp.status.toLowerCase()}. Add them under <Link href="/admin/setup?tab=catalogs">Company setup</Link>.</div> : null}
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Nationality" description={`Now: ${emp.nationality ?? "—"}`}>
          {nationality.length ? <ul>{nationality.map((n) => <li key={n.id}>{n.nationality} · {formatDate(n.validFrom)} – {n.validTo ? formatDate(n.validTo) : "now"}{n.note ? <span className="text-xs muted"> · {n.note}</span> : null}</li>)}</ul> : <div className="text-sm muted">No changes recorded.</div>}
          {hr ? <SpecDisclosure label="Record a change"><SpecForm action={changeNationalityAction} hidden={{ employeeId: id }} fields={[{ name: "nationality", label: "New nationality", required: true }, { name: "validFrom", label: "From", kind: "date", required: true }, { name: "note", label: "Note", wide: true }]} /></SpecDisclosure> : null}
        </Card>
        <Card title="Identifiers" description="Aliases (other names or numbers) and IDs in outside systems: badge, vendor portal, client timesheet.">
          {identifiers.length ? <ul>{identifiers.map((x) => <li key={x.id} className="row gap-2"><Badge>{x.kind === "ALIAS" ? "alias" : "external"}</Badge> {x.system}: <span className="mono">{x.value}</span>{hr ? <ActionButton action={deleteEmployeeIdentifierAction} hidden={{ id: x.id }} label="×" /> : null}</li>)}</ul> : <Empty title="None" />}
          {hr ? <SpecDisclosure label="Add"><SpecForm action={saveEmployeeIdentifierAction} hidden={{ employeeId: id }} fields={[
            { name: "kind", label: "Kind", kind: "select", required: true, options: [{ value: "ALIAS", label: "Alias" }, { value: "EXTERNAL", label: "External system ID" }] },
            { name: "system", label: "System / type", required: true, placeholder: "Badge system" }, { name: "value", label: "Value", required: true },
            { name: "validFrom", label: "From", kind: "date" }, { name: "validTo", label: "Until", kind: "date" },
          ]} /></SpecDisclosure> : null}
        </Card>
      </div>
      <Card title="Nominees" description="Share of each benefit by dependent.">
        {nominees.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Benefit</th><th>Nominees</th></tr></thead>
            <tbody>{Object.entries(NOMINEE_BENEFITS).filter(([b]) => nominees.some((n) => n.benefit === b)).map(([b, label]) => <tr key={b}><td>{label}</td><td>{nominees.filter((n) => n.benefit === b).map((n) => `${deps.find((d) => d.id === n.dependentId)?.name ?? "?"} ${n.sharePct}%`).join(", ")}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No nominee shares">The employee sets them under Me → My details → Nominees.</Empty>}
      </Card>
    </>
  );
}
