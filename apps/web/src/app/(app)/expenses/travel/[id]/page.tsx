import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { PER_DIEM_TIERS, TRIP_CHECKLIST_KINDS, type Violation } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue, Callout, Person } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import {
  editTripAction, requestTripChangeAction, saveBookingAction, cancelBookingAction, uploadItineraryAction, checklistAction, tripInsuranceAction, linkTripAdvanceAction, travelSettlementAction,
} from "@/app/actions/travel-depth";
import { TripOps } from "../../forms";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { REQUESTED: "warning", APPROVED: "info", BOOKED: "info", IN_PROGRESS: "info", COMPLETED: "success", REJECTED: "danger", CANCELLED: "neutral", CONFIRMED: "success", PENDING_APPROVAL: "warning", AMENDED: "neutral", PENDING: "warning", APPLIED: "success", DRAFT: "neutral", SUBMITTED: "warning", WITHDRAWN: "neutral" };
const lbl = (s: string) => s.replace(/_/g, " ").toLowerCase();
const d10 = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

/** One trip: approvals, bookings and itinerary, pre-travel checklist, changes, advance and settlement. */
export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const t = await prisma.travelRequest.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { employee: { select: { id: true, displayName: true, employeeNumber: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!t) notFound();
  const own = t.employeeId === viewer.employee?.id;
  const desk = can(viewer, PERMISSIONS.TRAVEL_MANAGE);
  const manager = viewer.allReportIds.has(t.employeeId);
  if (!own && !desk && !manager && !canAccessEmployee(viewer, t.employee, PERMISSIONS.EXPENSE_APPROVE)) notFound();
  const [bookings, checklist, changes, settlement, claims, advance, openAdvances, purposes, policy, profile, history] = await Promise.all([
    prisma.travelBooking.findMany({ where: { tripId: id }, orderBy: { startsAt: "asc" } }),
    prisma.tripChecklistItem.findMany({ where: { tripId: id, tenantId: viewer.tenantId }, orderBy: [{ kind: "asc" }, { label: "asc" }] }),
    prisma.tripChange.findMany({ where: { tripId: id }, orderBy: { createdAt: "desc" } }),
    prisma.travelSettlement.findUnique({ where: { tripId: id } }),
    prisma.expenseClaim.findMany({ where: { tripId: id }, select: { id: true, claimNumber: true, stage: true, approvedTotal: true, claimedTotal: true } }),
    t.advanceId ? prisma.cashAdvance.findUnique({ where: { id: t.advanceId } }) : null,
    prisma.cashAdvance.findMany({ where: { employeeId: t.employeeId, status: { in: ["REQUESTED", "APPROVED", "DISBURSED", "PARTIALLY_SETTLED"] } } }),
    prisma.tripPurpose.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    t.policyId ? prisma.travelPolicy.findUnique({ where: { id: t.policyId } }) : null,
    desk || own ? prisma.travelerProfile.findUnique({ where: { employeeId: t.employeeId } }) : null,
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityId: { in: [id] }, entityType: { in: ["TravelRequest", "TripChecklistItem"] } }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  const bookingAudit = bookings.length ? await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: "TravelBooking", entityId: { in: bookings.map((b) => b.id) } }, orderBy: { createdAt: "desc" }, take: 30 }) : [];
  const violations = (Array.isArray(t.violations) ? t.violations : []) as unknown as Violation[];
  const ops = [
    ...(t.status === "REQUESTED" && !t.approvedAt && !own && manager ? ["approve", "reject"] : []),
    ...(["BOOKED", "IN_PROGRESS"].includes(t.status) && (own || desk) ? ["complete"] : []),
    ...(["REQUESTED"].includes(t.status) && (own || desk) ? ["cancel"] : []),
    ...(["APPROVED", "BOOKED"].includes(t.status) && desk && !own ? ["cancel"] : []),
  ];
  const changeable = own && ["APPROVED", "BOOKED", "IN_PROGRESS"].includes(t.status);
  const purposeName = purposes.find((p) => p.id === t.purposeId)?.name;
  const timeline = [...history, ...bookingAudit].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return (
    <>
      <PageHead title={`${t.requestNumber}: ${t.fromCity} → ${t.toCity}`} subtitle={`${t.employee.displayName} · ${formatDate(t.departDate)}${t.returnDate ? ` – ${formatDate(t.returnDate)}` : ""} · ${lbl(t.status)}`}
        actions={<>{ops.length ? <TripOps tripId={t.id} ops={ops} /> : null}<Link className="btn" href="/expenses/travel">All trips</Link></>} />
      {t.rejectReason ? <Callout tone="danger" title="Not going ahead">{t.rejectReason}</Callout> : null}
      {t.status === "REQUESTED" && t.approvedAt ? <Callout tone="warning" title="Second approval">The manager approved; the travel approval matrix (policy exceptions, international or risky destinations) is deciding. It is in Approvals.</Callout> : null}
      {violations.length ? <Callout tone={violations.some((v) => v.severity !== "warning") ? "warning" : "info"} title="Policy checks">{violations.map((v, i) => <div key={i}>{v.severity === "approval" ? "Needs approval: " : ""}{v.message}</div>)}</Callout> : null}
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start", marginTop: 12 }}>
        <div className="stack gap-4">
          <Card tight title="Bookings and itinerary" description={desk ? "Out-of-policy bookings (class, hotel or cab limits) wait for approval before they are confirmed." : undefined}>
            {bookings.length === 0 ? <Empty title="Nothing booked yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Booking</th><th>When</th><th className="num">Cost</th><th>Status</th><th>Itinerary</th><th /></tr></thead>
                <tbody>{bookings.map((b) => (
                  <tr key={b.id}>
                    <td><div className="strong text-sm">{lbl(b.kind)} · {b.vendor}</div><div className="text-xs subtle">{b.reference}{b.travelClass ? ` · ${lbl(b.travelClass)}` : ""}</div>{!b.inPolicy && b.violation ? <div className="text-xs" style={{ color: "var(--warning)" }}>{b.violation}</div> : null}</td>
                    <td className="text-sm nowrap">{formatDate(b.startsAt)}{b.endsAt ? ` – ${formatDate(b.endsAt)}` : ""}</td>
                    <td className="num">{formatINR(Number(b.cost))}</td>
                    <td><Badge tone={TONE[b.status] ?? "neutral"}>{lbl(b.status)}</Badge></td>
                    <td>{b.itineraryUrl ? <a className="text-xs" href={b.itineraryUrl}>Open</a> : <span className="text-xs subtle">—</span>}
                      {(own || desk) && !["CANCELLED", "AMENDED"].includes(b.status) ? <details><summary className="text-xs" style={{ cursor: "pointer" }}>Upload</summary><GrowthForm action={uploadItineraryAction} hidden={{ bookingId: b.id }} cols={1} compact submitLabel="Store" fields={[{ name: "itinerary", label: "Ticket / voucher", type: "file" }]} /></details> : null}
                    </td>
                    <td className="right">{desk && ["CONFIRMED", "PENDING_APPROVAL"].includes(b.status) ? (
                      <div className="row gap-1" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <Reveal label="Amend">
                          <GrowthForm action={saveBookingAction} hidden={{ tripId: t.id, bookingId: b.id, kind: b.kind }} cols={2} compact submitLabel="Save amendment" fields={[
                            { name: "vendor", label: "Vendor", required: true, defaultValue: b.vendor }, { name: "reference", label: "Reference", required: true, defaultValue: b.reference },
                            { name: "travelClass", label: "Class", defaultValue: b.travelClass }, { name: "cost", label: "Cost (₹)", type: "number", required: true, defaultValue: Number(b.cost) },
                            { name: "startsAt", label: "Starts", type: "date", required: true, defaultValue: d10(b.startsAt) }, { name: "endsAt", label: "Ends", type: "date", defaultValue: d10(b.endsAt) },
                          ]} />
                        </Reveal>
                        <ActButton action={cancelBookingAction} hidden={{ bookingId: b.id }} label="Cancel" variant="ghost" confirmText="Cancel this booking?" />
                      </div>
                    ) : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {desk && ["APPROVED", "BOOKED", "IN_PROGRESS"].includes(t.status) ? (
              <div style={{ padding: 12 }}>
                <Reveal label="Add booking">
                  <GrowthForm action={saveBookingAction} hidden={{ tripId: t.id }} submitLabel="Add booking" fields={[
                    { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "FLIGHT", label: "Flight" }, { value: "HOTEL", label: "Hotel" }, { value: "TRAIN", label: "Train" }, { value: "CAB", label: "Cab / ground" }, { value: "OTHER", label: "Other" }] },
                    { name: "vendor", label: "Vendor", required: true }, { name: "reference", label: "PNR / reference", required: true },
                    { name: "travelClass", label: "Class", type: "select", options: [{ value: "ECONOMY", label: "Economy" }, { value: "PREMIUM_ECONOMY", label: "Premium economy" }, { value: "BUSINESS", label: "Business" }, { value: "FIRST", label: "First" }] },
                    { name: "startsAt", label: "Starts", type: "date", required: true, defaultValue: d10(t.departDate) }, { name: "endsAt", label: "Ends", type: "date", defaultValue: d10(t.returnDate) },
                    { name: "cost", label: "Cost (₹)", type: "number", required: true }, { name: "itinerary", label: "Itinerary file", type: "file" },
                  ]} />
                </Reveal>
              </div>
            ) : null}
          </Card>
          <Card tight title="Pre-travel checklist" description={t.travelType === "INTERNATIONAL" ? "Passport validity, visa and insurance are checked before an international trip." : undefined}>
            {checklist.length === 0 ? <Empty title="Nothing to check" /> : (
              <div className="table-wrap"><table className="data"><tbody>{checklist.map((c) => (
                <tr key={c.id}>
                  <td><div className="text-sm strong">{c.label}</div><div className="text-xs subtle">{TRIP_CHECKLIST_KINDS[c.kind as keyof typeof TRIP_CHECKLIST_KINDS] ?? c.kind}</div></td>
                  <td>{c.done ? <Badge tone="success">done {c.doneAt ? formatDate(c.doneAt) : ""}</Badge> : <Badge tone="warning">to do</Badge>}{c.fileUrl ? <div><a className="text-xs" href={c.fileUrl}>Document</a></div> : null}</td>
                  <td className="right">{own || desk ? (c.done ? <ActButton action={checklistAction} hidden={{ tripId: t.id, itemId: c.id, done: "false" }} label="Reopen" variant="ghost" />
                    : <Reveal label="Mark done"><GrowthForm action={checklistAction} hidden={{ tripId: t.id, itemId: c.id, done: "true" }} cols={1} compact submitLabel="Done" fields={[{ name: "file", label: "Document (visa, policy…)", type: "file" }]} /></Reveal>) : null}</td>
                </tr>
              ))}</tbody></table></div>
            )}
            {own || desk ? <div style={{ padding: 12 }}><Reveal label="Add item"><GrowthForm action={checklistAction} hidden={{ tripId: t.id, op: "add" }} cols={2} compact submitLabel="Add" fields={[{ name: "kind", label: "Kind", type: "select", options: Object.entries(TRIP_CHECKLIST_KINDS).map(([value, label]) => ({ value, label })) }, { name: "label", label: "Item", required: true }]} /></Reveal></div> : null}
          </Card>
          {own && t.status === "REQUESTED" && !t.approvedAt ? (
            <Card title="Edit request">
              <Reveal label="Edit">
                <GrowthForm action={editTripAction} hidden={{ tripId: t.id }} submitLabel="Save" fields={[
                  { name: "fromCity", label: "From", required: true, defaultValue: t.fromCity }, { name: "toCity", label: "To", required: true, defaultValue: t.toCity },
                  { name: "travelType", label: "Type", type: "select", required: true, defaultValue: t.travelType, options: [{ value: "DOMESTIC", label: "Domestic" }, { value: "INTERNATIONAL", label: "International" }] },
                  { name: "departDate", label: "Depart", type: "date", required: true, defaultValue: d10(t.departDate) }, { name: "returnDate", label: "Return", type: "date", defaultValue: d10(t.returnDate) },
                  { name: "estimatedCost", label: "Estimated cost (₹)", type: "number", defaultValue: t.estimatedCost === null ? null : Number(t.estimatedCost) },
                  { name: "purposeId", label: "Trip purpose", type: "select", options: purposes.map((p) => ({ value: p.id, label: p.name })), defaultValue: t.purposeId },
                  { name: "destinationCountry", label: "Destination country", defaultValue: t.destinationCountry },
                  { name: "purpose", label: "Purpose", required: true, wide: true, defaultValue: t.purpose },
                  { name: "needsAccommodation", label: "Needs a hotel", type: "checkbox", defaultChecked: t.needsAccommodation },
                ]} />
              </Reveal>
            </Card>
          ) : null}
          <Card tight title="Changes and cancellations" description={changeable ? "Changing or cancelling an approved trip goes back for approval." : undefined}>
            {changes.length === 0 ? <Empty title="No changes" /> : (
              <div className="table-wrap"><table className="data"><thead><tr><th>Requested</th><th>Change</th><th>Reason</th><th>Status</th></tr></thead>
                <tbody>{changes.map((c) => <tr key={c.id}><td className="text-sm nowrap">{formatDate(c.createdAt)}</td><td className="text-sm">{c.kind === "CANCEL" ? "Cancel the trip" : Object.entries((c.changes ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" && /^\d{4}-/.test(v) ? v.slice(0, 10) : String(v)}`).join(", ")}</td><td className="text-sm">{c.reason}</td><td><Badge tone={TONE[c.status] ?? "neutral"}>{lbl(c.status)}</Badge></td></tr>)}</tbody></table></div>
            )}
            {changeable ? (
              <div style={{ padding: 12 }} className="row gap-2 wrap">
                <Reveal label="Request a change">
                  <GrowthForm action={requestTripChangeAction} hidden={{ tripId: t.id, kind: "CHANGE" }} submitLabel="Request change" fields={[
                    { name: "departDate", label: "New departure", type: "date" }, { name: "returnDate", label: "New return", type: "date" },
                    { name: "toCity", label: "New destination" }, { name: "estimatedCost", label: "New estimate (₹)", type: "number" },
                    { name: "reason", label: "Why", required: true, wide: true },
                  ]} />
                </Reveal>
                <Reveal label="Cancel trip">
                  <GrowthForm action={requestTripChangeAction} hidden={{ tripId: t.id, kind: "CANCEL" }} cols={1} submitLabel="Request cancellation" fields={[{ name: "reason", label: "Why", required: true }]} />
                </Reveal>
              </div>
            ) : null}
          </Card>
          <Card title="Settlement" description="Per diem at the approved rate for the city tier settles any advance first; the rest is paid with salary, or recovered.">
            {settlement ? (
              <KeyValue items={[
                ["Per diem", `${Number(settlement.perDiemDays)} day(s) × ${formatINR(Number(settlement.perDiemRate))} = ${formatINR(Number(settlement.perDiemAmount))}`],
                ["Expense claims on this trip", formatINR(Number(settlement.claimsTotal))],
                ["Company-paid bookings", formatINR(Number(settlement.bookingsTotal))],
                ["Advance outstanding", formatINR(Number(settlement.advanceAmount))],
                ["Net", Number(settlement.netAmount) >= 0 ? `${formatINR(Number(settlement.netAmount))} payable` : `${formatINR(-Number(settlement.netAmount))} to recover`],
                ["Status", <Badge key="s" tone={TONE[settlement.status] ?? "neutral"}>{lbl(settlement.status)}</Badge>],
              ]} />
            ) : <Empty title="Not settled yet" />}
            {(own || desk) && ["BOOKED", "IN_PROGRESS", "COMPLETED"].includes(t.status) && (!settlement || ["DRAFT", "REJECTED"].includes(settlement.status)) ? (
              <div style={{ marginTop: 10 }}>
                <GrowthForm action={travelSettlementAction} hidden={{ tripId: t.id }} cols={2} submitLabel="Work out / refresh" fields={[
                  { name: "perDiemTier", label: "City tier", type: "select", required: true, options: Object.entries(PER_DIEM_TIERS).map(([value, label]) => ({ value, label })), defaultValue: t.travelType === "INTERNATIONAL" ? "INTERNATIONAL" : "TIER_1" },
                  { name: "notes", label: "Notes" },
                ]} />
                {settlement ? <div style={{ marginTop: 8 }}><ActButton action={travelSettlementAction} hidden={{ tripId: t.id, intent: "submit", perDiemTier: t.travelType === "INTERNATIONAL" ? "INTERNATIONAL" : "TIER_1" }} label="Submit settlement for approval" variant="primary" /></div> : null}
              </div>
            ) : null}
          </Card>
          <Card tight title="Travel audit history">
            {timeline.length === 0 ? <Empty title="No entries yet" /> : (
              <div className="table-wrap"><table className="data"><thead><tr><th>When</th><th>Who</th><th>Summary</th></tr></thead>
                <tbody>{timeline.map((h) => <tr key={h.id}><td className="text-xs nowrap">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{h.actorLabel}</td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>
            )}
          </Card>
        </div>
        <div className="stack gap-4">
          <Card title="Trip">
            <Person name={t.employee.displayName ?? ""} meta={t.employee.employeeNumber} />
            <div className="divider" />
            <KeyValue items={[
              ["Status", <Badge key="s" tone={TONE[t.status] ?? "neutral"}>{lbl(t.status)}</Badge>],
              ["Type", lbl(t.travelType)],
              ["Purpose", `${t.purpose}${purposeName ? ` (${purposeName})` : ""}`],
              ["Destination", `${t.toCity}${t.destinationCountry ? `, ${t.destinationCountry}` : ""}`],
              ["Risk", t.riskLevel ? <Badge key="r" tone={t.riskLevel === "LOW" ? "success" : t.riskLevel === "MEDIUM" ? "warning" : "danger"}>{t.riskLevel.toLowerCase()}</Badge> : "—"],
              ["Policy", policy ? `${policy.name} (${lbl(policy.domesticFlightClass)} / ${lbl(policy.internationalFlightClass)})` : "—"],
              ["Estimated", t.estimatedCost ? formatINR(Number(t.estimatedCost)) : "—"],
              ["Booked cost", t.actualCost ? formatINR(Number(t.actualCost)) : "—"],
              ["Insurance", t.insuranceProvider ? `${t.insuranceProvider} ${t.insurancePolicyNo ?? ""} to ${formatDate(t.insuranceValidTo)}` : "—"],
            ]} />
          </Card>
          {profile ? <Card title="Traveller preferences"><KeyValue items={[["Seat", profile.seatPreference], ["Meal", profile.mealPreference], ["Frequent flyer", profile.frequentFlyer], ["Hotel", profile.hotelPreference], ["Passport", profile.passportNumber ? `${profile.passportNumber} · expires ${formatDate(profile.passportExpiry)}` : null]]} /></Card> : null}
          {(own || desk) && t.travelType === "INTERNATIONAL" ? (
            <Card title="Travel insurance">
              <GrowthForm action={tripInsuranceAction} hidden={{ tripId: t.id }} cols={1} compact submitLabel="Save insurance" fields={[
                { name: "provider", label: "Insurer", required: true, defaultValue: t.insuranceProvider }, { name: "policyNo", label: "Policy number", required: true, defaultValue: t.insurancePolicyNo },
                { name: "validTo", label: "Valid to", type: "date", required: true, defaultValue: d10(t.insuranceValidTo) },
              ]} />
            </Card>
          ) : null}
          <Card title="Advance">
            {advance ? <KeyValue items={[["Amount", formatINR(Number(advance.amount))], ["Outstanding", formatINR(Number(advance.outstanding))], ["Status", lbl(advance.status)]]} /> : <div className="text-sm subtle">No advance linked. <Link href="/expenses?tab=advances">Request one</Link> for this trip.</div>}
            {!advance && (own || desk) && openAdvances.length ? <div style={{ marginTop: 8 }}><GrowthForm action={linkTripAdvanceAction} hidden={{ tripId: t.id }} cols={1} compact submitLabel="Link" fields={[{ name: "advanceId", label: "Open advance", type: "select", required: true, options: openAdvances.map((a) => ({ value: a.id, label: `${a.purpose} — ${formatINR(Number(a.amount))}` })) }]} /></div> : null}
          </Card>
          <Card title="Expense claims">
            {claims.length === 0 ? <div className="text-sm subtle">None filed against this trip.</div> : <ul className="text-sm">{claims.map((c) => <li key={c.id}><Link href={`/expenses/${c.id}`}>{c.claimNumber}</Link> · {lbl(c.stage)} · {formatINR(Number(c.approvedTotal) || Number(c.claimedTotal))}</li>)}</ul>}
          </Card>
        </div>
      </div>
    </>
  );
}
