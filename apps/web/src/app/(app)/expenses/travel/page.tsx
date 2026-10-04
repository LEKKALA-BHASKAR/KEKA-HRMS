import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { tripWhere, type Violation } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { saveTravelerProfileAction } from "@/app/actions/travel-depth";
import { tripEmployeeScope, tripFilter, TRAVEL_REPORTS } from "./data";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { REQUESTED: "warning", APPROVED: "info", BOOKED: "info", IN_PROGRESS: "info", COMPLETED: "success", REJECTED: "danger", CANCELLED: "neutral" };
const RISK: Record<string, "success" | "warning" | "danger" | "neutral"> = { LOW: "success", MEDIUM: "warning", HIGH: "danger", CRITICAL: "danger" };

/** Every trip the viewer may see, searchable, with the traveller's own preferences. */
export default async function TravelPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const desk = can(viewer, PERMISSIONS.TRAVEL_MANAGE);
  const scope = await tripEmployeeScope(viewer);
  const f = tripFilter(sp, scope);
  const [trips, purposes, profile] = await Promise.all([
    prisma.travelRequest.findMany({ where: tripWhere(viewer.tenantId, f), include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { departDate: "desc" }, take: 200 }),
    prisma.tripPurpose.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
    viewer.employee ? prisma.travelerProfile.findUnique({ where: { employeeId: viewer.employee.id } }) : null,
  ]);
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as Array<[string, string]>);
  return (
    <>
      <PageHead title="Business travel" subtitle="Trips, bookings, itineraries, checklists and settlements"
        actions={<>
          {desk ? <><Link className="btn" href="/expenses/travel/dashboard">Dashboard & calendar</Link><Link className="btn" href="/expenses/travel/policies">Policies</Link></> : null}
          <Link className="btn" href="/expenses?tab=travel">Request a trip</Link>
        </>} />
      <form className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Trip, city, purpose or traveller" style={{ maxWidth: 240 }} />
        <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ maxWidth: 160 }}><option value="">Any status</option>{Object.keys(TONE).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}</select>
        <select className="select" name="travelType" defaultValue={sp.travelType ?? ""} style={{ maxWidth: 160 }}><option value="">Domestic & international</option><option value="DOMESTIC">Domestic</option><option value="INTERNATIONAL">International</option></select>
        <select className="select" name="purposeId" defaultValue={sp.purposeId ?? ""} style={{ maxWidth: 180 }}><option value="">Any purpose</option>{purposes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <input className="input" type="date" name="from" defaultValue={sp.from ?? ""} aria-label="Departing from" style={{ maxWidth: 160 }} />
        <input className="input" type="date" name="to" defaultValue={sp.to ?? ""} aria-label="Departing to" style={{ maxWidth: 160 }} />
        <button className="btn">Search</button>
      </form>
      <Card tight title={`Trips (${trips.length})`} action={<div className="row gap-1">{Object.entries(TRAVEL_REPORTS).map(([k, l]) => <Link key={k} className="btn sm" href={`/expenses/travel/export?${new URLSearchParams({ ...Object.fromEntries(qs), kind: k })}`}>{l} CSV</Link>)}</div>}>
        {trips.length === 0 ? <Empty title="No trips match" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Trip</th><th>Traveller</th><th>Dates</th><th className="num">Cost</th><th>Risk / policy</th><th>Status</th></tr></thead>
            <tbody>{trips.map((t) => {
              const v = (Array.isArray(t.violations) ? t.violations : []) as unknown as Violation[];
              return (
                <tr key={t.id}>
                  <td><Link href={`/expenses/travel/${t.id}`} className="strong text-sm">{t.fromCity} → {t.toCity}</Link><div className="text-xs subtle">{t.requestNumber} · {t.purpose}</div></td>
                  <td><Person name={t.employee.displayName ?? ""} meta={t.employee.employeeNumber} /></td>
                  <td className="text-sm nowrap">{formatDate(t.departDate)}{t.returnDate ? ` – ${formatDate(t.returnDate)}` : ""}</td>
                  <td className="num text-sm">{t.actualCost ? formatINR(Number(t.actualCost)) : t.estimatedCost ? `~${formatINR(Number(t.estimatedCost))}` : "—"}</td>
                  <td>{t.riskLevel ? <Badge tone={RISK[t.riskLevel]}>{t.riskLevel.toLowerCase()} risk</Badge> : null}{v.length ? <Badge tone="warning">{v.length} policy note(s)</Badge> : null}</td>
                  <td><Badge tone={TONE[t.status] ?? "neutral"}>{t.status.replace(/_/g, " ").toLowerCase()}</Badge>{t.status === "REQUESTED" && t.approvedAt ? <div className="text-xs subtle">second approval</div> : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      {viewer.employee ? (
        <Card title="My travel preferences" description="The travel desk books with these. Passport details are checked against international trips.">
          <Reveal label="Edit preferences">
            <GrowthForm action={saveTravelerProfileAction} submitLabel="Save" fields={[
              { name: "seatPreference", label: "Seat", type: "select", options: [{ value: "WINDOW", label: "Window" }, { value: "AISLE", label: "Aisle" }, { value: "ANY", label: "No preference" }], defaultValue: profile?.seatPreference },
              { name: "mealPreference", label: "Meal", type: "select", options: [{ value: "VEG", label: "Vegetarian" }, { value: "NON_VEG", label: "Non-vegetarian" }, { value: "VEGAN", label: "Vegan" }, { value: "JAIN", label: "Jain" }], defaultValue: profile?.mealPreference },
              { name: "frequentFlyer", label: "Frequent-flyer numbers", defaultValue: profile?.frequentFlyer },
              { name: "hotelPreference", label: "Hotel preference", defaultValue: profile?.hotelPreference },
              { name: "passportNumber", label: "Passport number", defaultValue: profile?.passportNumber },
              { name: "passportExpiry", label: "Passport expires", type: "date", defaultValue: profile?.passportExpiry?.toISOString().slice(0, 10) },
              { name: "passportCountry", label: "Passport country", defaultValue: profile?.passportCountry },
              { name: "notes", label: "Notes for the travel desk", type: "textarea", defaultValue: profile?.notes },
            ]} />
          </Reveal>
        </Card>
      ) : null}
    </>
  );
}
