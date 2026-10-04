import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { fmtDate } from "@/lib/governance";
import { Card } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { reserveAssetAction, moveReservationAction, reportRepairAction, reportLostAction } from "@/app/actions/asset-ops";
import { Segments, PageHead, Yellow } from "../../../assets/_parts";

export const metadata = { title: "Asset bookings" };

/**
 * Me › Assets › Bookings, repairs and loss: book a shared-pool asset for
 * dates (approved by the asset team), and report a held asset broken or lost.
 */
export default async function MyAssetBookingsPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="Asset bookings" /><Yellow>This login is not linked to an employee record.</Yellow></>;
  const me = viewer.employee.id, t = viewer.tenantId;
  const [pools, mine, held, repairs] = await Promise.all([
    prisma.assetPool.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, include: { assets: { where: { status: "AVAILABLE" }, select: { id: true, assetTag: true, name: true, assetType: { select: { name: true } } } } } }),
    prisma.assetReservation.findMany({ where: { tenantId: t, employeeId: me }, orderBy: { fromDate: "desc" }, take: 50 }),
    prisma.assetAssignment.findMany({ where: { employeeId: me, returnedOn: null, asset: { tenantId: t } }, include: { asset: { select: { id: true, assetTag: true, name: true, assetType: { select: { name: true } } } } } }),
    prisma.assetMaintenance.findMany({ where: { tenantId: t, reportedByEmployeeId: me }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const label = (a: { assetTag: string; name: string | null; assetType: { name: string } }) => `${a.name ?? a.assetType.name} (${a.assetTag})`;
  const poolAssets = pools.flatMap((p) => p.assets.map((a) => ({ value: a.id, label: `${label(a)} · ${p.name}, up to ${p.maxDays} days` })));
  const tags = new Map((await prisma.asset.findMany({ where: { tenantId: t, id: { in: [...mine.map((m) => m.assetId), ...repairs.map((r) => r.assetId)] } }, select: { id: true, assetTag: true, name: true, assetType: { select: { name: true } } } })).map((a) => [a.id, label(a)]));
  const heldOpts = held.map((h) => ({ value: h.id, label: label(h.asset) }));
  return (
    <>
      <PageHead title="Asset bookings" sub="Borrow shared equipment for a few days, and tell the asset team when something you hold breaks or goes missing." />
      <Segments items={[{ label: "Assigned to me", href: "/me/assets", on: false }, { label: "My requests", href: "/me/assets?view=requests", on: false }, { label: "Bookings, repairs & loss", href: "/me/assets/bookings", on: true }]} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Book a shared asset">
          {poolAssets.length ? <SpecForm action={reserveAssetAction} submitLabel="Request booking" fields={[
            { name: "assetId", label: "Asset", type: "select", required: true, options: poolAssets },
            { name: "fromDate", label: "From", type: "date", required: true }, { name: "toDate", label: "To", type: "date", required: true },
            { name: "purpose", label: "Purpose", required: true, wide: true, placeholder: "Client demo in Pune" },
          ]} /> : <p className="muted text-sm">No shared assets are free to book right now.</p>}
        </Card>
        <Card title="My bookings">
          <Table head={["Asset", "From", "To", "Status", ""]} empty={!mine.length}>
            {mine.map((b) => <tr key={b.id}><td>{tags.get(b.assetId)}</td><td>{fmtDate(b.fromDate)}</td><td>{fmtDate(b.toDate)}</td><td><Pill s={b.status} />{b.decisionNote ? <div className="muted text-xs">{b.decisionNote}</div> : null}</td><td>{b.status === "REQUESTED" || b.status === "APPROVED" ? <ActButton action={moveReservationAction} hidden={{ id: b.id, to: "CANCELLED" }} label="Cancel" variant="ghost" /> : null}</td></tr>)}
          </Table>
        </Card>
      </div>
      {heldOpts.length ? (
        <div className="grid grid-2" style={{ alignItems: "start", marginTop: 16 }}>
          <Card title="Report a fault">
            <SpecForm action={reportRepairAction} submitLabel="Report for repair" columns={1} fields={[
              { name: "assignmentId", label: "Asset", type: "select", required: true, options: heldOpts }, { name: "title", label: "What is wrong", required: true }, { name: "description", label: "Details", type: "textarea" },
            ]} />
          </Card>
          <Card title="Report lost or stolen">
            <SpecForm action={reportLostAction} submitLabel="Report lost" columns={1} fields={[
              { name: "assignmentId", label: "Asset", type: "select", required: true, options: heldOpts }, { name: "circumstances", label: "What happened", type: "textarea", required: true, hint: "When and where you last had it. HR may raise a damage recovery." },
            ]} />
          </Card>
        </div>
      ) : null}
      <Card title="Faults I reported">
        <Table head={["Asset", "Problem", "Reported", "Status"]} empty={!repairs.length}>
          {repairs.map((r) => <tr key={r.id}><td>{tags.get(r.assetId)}</td><td>{r.title}</td><td>{fmtDate(r.createdAt)}</td><td><Pill s={r.status} /></td></tr>)}
        </Table>
      </Card>
    </>
  );
}
