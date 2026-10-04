import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { FLIGHT_CLASSES } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, ActButton, Reveal, type FieldSpec } from "@/components/growth-forms";
import { saveTravelPolicyAction, travelPolicyOpAction, saveTripPurposeAction, saveDestinationRiskAction } from "@/app/actions/travel-depth";

const TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = { ACTIVE: "success", PENDING_APPROVAL: "warning", DRAFT: "neutral", RETIRED: "neutral", LOW: "success", MEDIUM: "warning", HIGH: "danger", CRITICAL: "danger" };
const lbl = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** Travel policy profiles by band, the trip-purpose list and destination risk flags. */
export default async function TravelPoliciesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.TRAVEL_MANAGE);
  const sp = await searchParams;
  const [policies, bands, purposes, risks, history] = await Promise.all([
    prisma.travelPolicy.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    prisma.band.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.tripPurpose.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { code: "asc" } }),
    prisma.destinationRisk.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { destination: "asc" } }),
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: { in: ["TravelPolicy", "TripPurpose", "DestinationRisk"] } }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  const editing = policies.find((p) => p.id === sp.edit && p.status === "DRAFT");
  const classes = FLIGHT_CLASSES.map((c) => ({ value: c, label: lbl(c) }));
  const fields = (p?: (typeof policies)[number]): FieldSpec[] => [
    { name: "name", label: "Policy name", required: true, defaultValue: p?.name },
    { name: "domesticFlightClass", label: "Domestic flight class", type: "select", required: true, options: classes, defaultValue: p?.domesticFlightClass ?? "ECONOMY" },
    { name: "internationalFlightClass", label: "International flight class", type: "select", required: true, options: classes, defaultValue: p?.internationalFlightClass ?? "ECONOMY" },
    { name: "hotelCapPerNight", label: "Hotel cap per night (₹)", type: "number", defaultValue: p?.hotelCapPerNight === null || p?.hotelCapPerNight === undefined ? null : Number(p.hotelCapPerNight) },
    { name: "groundDailyCap", label: "Ground transport per day (₹)", type: "number", defaultValue: p?.groundDailyCap === null || p?.groundDailyCap === undefined ? null : Number(p.groundDailyCap) },
    { name: "minAdvanceDays", label: "Book at least (days ahead)", type: "number", required: true, defaultValue: p?.minAdvanceDays ?? 7 },
    { name: "secondApprovalAbove", label: "Second approval above (₹)", type: "number", defaultValue: p?.secondApprovalAbove === null || p?.secondApprovalAbove === undefined ? null : Number(p.secondApprovalAbove) },
    { name: "passportValidityMonths", label: "Passport valid for (months past return)", type: "number", required: true, defaultValue: p?.passportValidityMonths ?? 6 },
    { name: "bandIds", label: "Bands (none: everyone)", type: "checklist", options: bands.map((b) => ({ value: b.id, label: b.name })), checked: p?.bandIds ?? [] },
    { name: "description", label: "Description", type: "textarea", defaultValue: p?.description },
    { name: "internationalNeedsSecondApproval", label: "International trips need a second approval", type: "checkbox", defaultChecked: p?.internationalNeedsSecondApproval ?? true },
    { name: "requireInsuranceInternational", label: "International trips need travel insurance", type: "checkbox", defaultChecked: p?.requireInsuranceInternational ?? true },
  ];
  return (
    <>
      <PageHead title="Travel policies" subtitle="Entitlements by band, what needs a second approval, trip purposes and destination risk" actions={<><Link className="btn" href="/expenses/travel">Trips</Link><Link className="btn" href="/admin/workflows">Travel approval matrix</Link></>} />
      <Callout title="Travel approval matrix">After the manager approves, a trip goes to the TRAVEL_APPROVAL workflow when it breaks policy, is international (where the policy says so), costs more than the second-approval amount, or goes to a high-risk place. Configure who approves under Approval routes.</Callout>
      <Card title={editing ? `Edit ${editing.name}` : "New travel policy"}>
        <Reveal label={editing ? "Edit draft" : "New policy"} open={!!editing}>
          <GrowthForm action={saveTravelPolicyAction} hidden={editing ? { id: editing.id } : undefined} fields={fields(editing)} submitLabel="Save as draft" />
        </Reveal>
      </Card>
      <Card tight title={`Policies (${policies.length})`}>
        {policies.length === 0 ? <Empty title="No travel policies yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Policy</th><th>Bands</th><th>Flights</th><th>Hotel / ground</th><th>Second approval</th><th>Status</th><th /></tr></thead>
            <tbody>{policies.map((p) => (
              <tr key={p.id}>
                <td><div className="strong text-sm">{p.name}</div><div className="text-xs subtle">book {p.minAdvanceDays}+ days ahead{p.supersedesId ? " · revision" : ""}</div></td>
                <td className="text-sm">{p.bandIds.length ? p.bandIds.map((b) => bands.find((x) => x.id === b)?.name ?? "?").join(", ") : "Everyone"}</td>
                <td className="text-sm">{lbl(p.domesticFlightClass)} / {lbl(p.internationalFlightClass)}</td>
                <td className="text-sm">{p.hotelCapPerNight ? formatINR(Number(p.hotelCapPerNight)) : "—"} / {p.groundDailyCap ? formatINR(Number(p.groundDailyCap)) : "—"}</td>
                <td className="text-sm">{p.secondApprovalAbove ? `above ${formatINR(Number(p.secondApprovalAbove))}` : "—"}{p.internationalNeedsSecondApproval ? ", international" : ""}</td>
                <td><Badge tone={TONE[p.status] ?? "neutral"}>{lbl(p.status)}</Badge></td>
                <td className="right"><div className="row gap-1" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {p.status === "DRAFT" ? <><Link className="btn sm" href={`/expenses/travel/policies?edit=${p.id}`}>Edit</Link><ActButton action={travelPolicyOpAction} hidden={{ id: p.id, op: "submit" }} label="Submit for approval" variant="primary" /></> : null}
                  {p.status === "ACTIVE" ? <><ActButton action={travelPolicyOpAction} hidden={{ id: p.id, op: "revise" }} label="Revise" /><ActButton action={travelPolicyOpAction} hidden={{ id: p.id, op: "retire" }} label="Retire" variant="ghost" confirmText="Retire this policy?" /></> : null}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title="Trip purposes" description="The taxonomy trips are classified by, for reporting and billing.">
          {purposes.length ? <div className="table-wrap"><table className="data"><tbody>{purposes.map((p) => (
            <tr key={p.id}><td className="text-sm strong">{p.code}</td><td className="text-sm">{p.name}{p.isBillable ? <Badge tone="info">billable</Badge> : null}{!p.isActive ? <Badge>inactive</Badge> : null}</td>
              <td className="right"><Reveal label="Edit"><GrowthForm action={saveTripPurposeAction} hidden={{ id: p.id }} cols={2} compact fields={[{ name: "code", label: "Code", required: true, defaultValue: p.code }, { name: "name", label: "Name", required: true, defaultValue: p.name }, { name: "isBillable", label: "Billable to a client", type: "checkbox", defaultChecked: p.isBillable }, { name: "isActive", label: "Active", type: "checkbox", defaultChecked: p.isActive }]} /></Reveal></td></tr>
          ))}</tbody></table></div> : <Empty title="No purposes yet" />}
          <div style={{ padding: 12 }}><Reveal label="Add purpose"><GrowthForm action={saveTripPurposeAction} cols={2} compact submitLabel="Add" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "isBillable", label: "Billable to a client", type: "checkbox" }, { name: "isActive", label: "Active", type: "checkbox", defaultChecked: true }]} /></Reveal></div>
        </Card>
        <Card tight title="Destination risk" description="High and critical destinations need a second approval; blocked ones cannot be requested.">
          {risks.length ? <div className="table-wrap"><table className="data"><tbody>{risks.map((r) => (
            <tr key={r.id}><td className="text-sm strong">{r.destination}</td><td><Badge tone={TONE[r.level]}>{r.level.toLowerCase()}</Badge>{r.blockTravel ? <Badge tone="danger">blocked</Badge> : null}</td><td className="text-xs">{r.advisory ?? ""}</td></tr>
          ))}</tbody></table></div> : <Empty title="No risk flags" />}
          <div style={{ padding: 12 }}><Reveal label="Flag a destination"><GrowthForm action={saveDestinationRiskAction} cols={2} compact submitLabel="Save" fields={[{ name: "destination", label: "City or country", required: true }, { name: "level", label: "Risk", type: "select", required: true, options: ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((l) => ({ value: l, label: l.toLowerCase() })) }, { name: "advisory", label: "Advisory", wide: true }, { name: "blockTravel", label: "Block travel", type: "checkbox" }]} /></Reveal></div>
        </Card>
      </div>
      <Card tight title="Audit trail">
        {history.length === 0 ? <Empty title="No changes yet" /> : <div className="table-wrap"><table className="data"><tbody>{history.map((h) => <tr key={h.id}><td className="text-xs nowrap">{formatDate(h.createdAt)}</td><td className="text-xs">{h.actorLabel}</td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>}
      </Card>
    </>
  );
}
