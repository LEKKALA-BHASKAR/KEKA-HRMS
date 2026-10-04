import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { stockLevels, checklistFor, parseChecklistItems, DISPOSAL_METHODS, MAINTENANCE_KINDS } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { locationOptions, employeeOptions, userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  saveChecklistTemplateAction, completeChecklistAction, scheduleMaintenanceAction, progressMaintenanceAction, savePoolAction, setAssetPoolAction,
  reserveAssetAction, decideReservationAction, moveReservationAction, saveStockThresholdAction, requestDisposalAction, completeDisposalAction, startReconciliationAction,
} from "@/app/actions/asset-ops";

export const metadata = { title: "Asset operations" };
const TABS = { checklists: "Checklists", maintenance: "Maintenance", pools: "Shared pools", stock: "Stock levels", disposal: "Disposal", reconciliation: "Stock-take" };
type Tab = keyof typeof TABS;
const money = (v: unknown) => (v === null || v === undefined ? "—" : `₹${Number(v).toLocaleString("en-IN")}`);

/**
 * Org › Assets › Operations (asset managers): issue/return checklists,
 * maintenance and repairs, shared pools and bookings, stock thresholds,
 * disposal through approval, and physical stock-takes.
 */
export default async function AssetOperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "checklists";
  const t = viewer.tenantId;
  const assets = await prisma.asset.findMany({ where: { tenantId: t }, select: { id: true, assetTag: true, name: true, status: true, poolId: true, assetType: { select: { name: true } } }, orderBy: { assetTag: "asc" } });
  const tag = new Map(assets.map((a) => [a.id, `${a.assetTag} · ${a.name ?? a.assetType.name}`]));
  const assetOpts = (pred: (a: (typeof assets)[number]) => boolean = () => true) => assets.filter(pred).map((a) => ({ value: a.id, label: tag.get(a.id)! }));
  return (
    <>
      <PageHead title="Asset operations" subtitle="Checklists, maintenance, bookings, stock, disposal and stock-takes" actions={<a className="btn" href={`/assets/operations/export?tab=${tab}`}>Download CSV</a>} />
      <Tabs base="/assets/operations" tabs={TABS} active={tab} />
      {tab === "checklists" ? <Checklists tenantId={t} run={sp.run} kind={sp.kind === "RETURN" ? "RETURN" : "ISSUE"} /> : null}
      {tab === "maintenance" ? <Maintenance tenantId={t} tag={tag} assetOpts={assetOpts((a) => a.status !== "RETIRED")} /> : null}
      {tab === "pools" ? <Pools tenantId={t} tag={tag} assetOpts={assetOpts((a) => a.status === "AVAILABLE")} poolAssets={assetOpts((a) => !!a.poolId)} /> : null}
      {tab === "stock" ? <Stock tenantId={t} /> : null}
      {tab === "disposal" ? <Disposal tenantId={t} tag={tag} assetOpts={assetOpts((a) => a.status !== "RETIRED" && a.status !== "ASSIGNED")} /> : null}
      {tab === "reconciliation" ? <Reconciliation tenantId={t} /> : null}
    </>
  );
}

async function Checklists({ tenantId, run, kind }: { tenantId: string; run?: string; kind: "ISSUE" | "RETURN" }) {
  const [templates, cats, active, runs] = await Promise.all([
    prisma.assetChecklistTemplate.findMany({ where: { tenantId }, orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    prisma.assetCategory.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.assetAssignment.findMany({ where: { returnedOn: null, asset: { tenantId } }, orderBy: { assignedOn: "desc" }, take: 50, include: { employee: { select: { displayName: true } }, asset: { select: { assetTag: true, assetType: { select: { name: true, categoryId: true } } } } } }),
    prisma.assetChecklistRun.findMany({ where: { tenantId }, select: { assignmentId: true, kind: true } }),
  ]);
  const done = new Set(runs.map((r) => `${r.assignmentId}:${r.kind}`));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const target = run ? active.find((a) => a.id === run) : null;
  const tpl = target ? await checklistFor(tenantId, kind, target.asset.assetType.categoryId) : null;
  return (
    <div className="stack gap-4">
      {target ? (
        <Card title={`${kind === "ISSUE" ? "Issue" : "Return"} checklist · ${target.asset.assetTag} · ${target.employee.displayName}`}>
          {tpl ? (
            <SpecForm action={completeChecklistAction} hidden={{ assignmentId: target.id, kind }} submitLabel="Complete checklist" columns={1} fields={[
              { name: "done", label: tpl.name, type: "multiselect", options: parseChecklistItems(tpl.items).map((i, idx) => ({ value: String(idx), label: `${i.label}${i.required ? " (required)" : ""}` })) },
            ]} />
          ) : <Callout>No {kind.toLowerCase()} checklist applies to this asset&apos;s category.</Callout>}
        </Card>
      ) : null}
      <Card title="Assets out with employees" description="Run the issue checklist on hand-over. A return checklist, when one exists, must be done before the asset can be recovered.">
        <Table head={["Asset", "Employee", "Since", "Issue", "Return"]} empty={!active.length}>
          {active.map((a) => (
            <tr key={a.id}>
              <td>{a.asset.assetTag} · {a.asset.assetType.name}</td><td>{a.employee.displayName}</td><td>{fmtDate(a.assignedOn)}</td>
              <td>{done.has(`${a.id}:ISSUE`) ? "Done" : <Link href={`/assets/operations?tab=checklists&run=${a.id}&kind=ISSUE`}>Run</Link>}</td>
              <td>{done.has(`${a.id}:RETURN`) ? "Done" : <Link href={`/assets/operations?tab=checklists&run=${a.id}&kind=RETURN`}>Run</Link>}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Checklist templates">
        <Table head={["Name", "Kind", "Category", "Items", "Active"]} empty={!templates.length}>
          {templates.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.kind === "ISSUE" ? "Issue" : "Return"}</td><td>{x.categoryId ? catName.get(x.categoryId) : "Every category"}</td><td className="num">{parseChecklistItems(x.items).length}</td><td>{x.isActive ? "Yes" : "No"}</td></tr>)}
        </Table>
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveChecklistTemplateAction} submitLabel="Save template" fields={[
            { name: "name", label: "Name", required: true },
            { name: "kind", label: "When", type: "select", required: true, options: [{ value: "ISSUE", label: "On issue" }, { value: "RETURN", label: "On return" }] },
            { name: "categoryId", label: "Category", type: "select", options: cats.map((c) => ({ value: c.id, label: c.name })), placeholder: "Every category" },
            { name: "items", label: "Items, one per line", type: "textarea", required: true, wide: true, hint: "Start a line with * to make it required, e.g. *Data wiped." },
          ]} />
        </div>
      </Card>
    </div>
  );
}

async function Maintenance({ tenantId, tag, assetOpts }: { tenantId: string; tag: Map<string, string>; assetOpts: Array<{ value: string; label: string }> }) {
  const rows = await prisma.assetMaintenance.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { scheduledOn: "asc" }], take: 200 });
  const reporters = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: rows.map((r) => r.reportedByEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const open = rows.filter((r) => r.status === "SCHEDULED" || r.status === "IN_PROGRESS");
  const now = new Date();
  return (
    <div className="stack gap-4">
      <div className="grid grid-3"><Stat label="Open work" value={open.length} /><Stat label="Overdue" value={open.filter((r) => r.scheduledOn < now).length} /><Stat label="Spent (done)" value={money(rows.filter((r) => r.status === "DONE").reduce((s, r) => s + Number(r.cost ?? 0), 0))} /></div>
      <Card title="Maintenance and repairs">
        <Table head={["Asset", "Work", "Due", "Status", "Vendor", "Cost", ""]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{tag.get(r.assetId) ?? "—"}</td>
              <td>{MAINTENANCE_KINDS[r.kind as keyof typeof MAINTENANCE_KINDS] ?? r.kind}: {r.title}{r.reportedByEmployeeId ? <div className="muted text-xs">Reported by {reporters.get(r.reportedByEmployeeId)}</div> : null}{r.intervalMonths ? <div className="muted text-xs">Every {r.intervalMonths} months</div> : null}</td>
              <td className={r.scheduledOn < now && (r.status === "SCHEDULED" || r.status === "IN_PROGRESS") ? "neg" : ""}>{fmtDate(r.scheduledOn)}</td>
              <td><Pill s={r.status} /></td><td>{r.vendor ?? "—"}</td><td className="num">{money(r.cost)}</td>
              <td>
                {r.status === "SCHEDULED" ? <ActButton action={progressMaintenanceAction} hidden={{ id: r.id, to: "IN_PROGRESS" }} label="Start" /> : null}
                {r.status === "SCHEDULED" || r.status === "IN_PROGRESS" ? <ActButton action={progressMaintenanceAction} hidden={{ id: r.id, to: "DONE" }} label="Done" variant="primary" input={{ name: "cost", placeholder: "Cost ₹ (optional)" }} /> : null}
                {r.status === "SCHEDULED" || r.status === "IN_PROGRESS" ? <ActButton action={progressMaintenanceAction} hidden={{ id: r.id, to: "CANCELLED" }} label="Cancel" variant="ghost" /> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Schedule work" description="A repair takes the asset out of service until it is done. Preventive work with an interval books the next visit when completed.">
        <SpecForm action={scheduleMaintenanceAction} submitLabel="Schedule" fields={[
          { name: "assetId", label: "Asset", type: "select", required: true, options: assetOpts },
          { name: "kind", label: "Kind", type: "select", required: true, options: Object.entries(MAINTENANCE_KINDS).map(([value, label]) => ({ value, label })) },
          { name: "title", label: "Title", required: true }, { name: "scheduledOn", label: "Date", type: "date", required: true },
          { name: "vendor", label: "Vendor" }, { name: "intervalMonths", label: "Repeat every (months)", type: "number" },
          { name: "description", label: "Details", type: "textarea", wide: true },
        ]} />
      </Card>
    </div>
  );
}

async function Pools({ tenantId, tag, assetOpts, poolAssets }: { tenantId: string; tag: Map<string, string>; assetOpts: Array<{ value: string; label: string }>; poolAssets: Array<{ value: string; label: string }> }) {
  const [pools, bookings, locations, employees] = await Promise.all([
    prisma.assetPool.findMany({ where: { tenantId }, include: { assets: { select: { id: true } } }, orderBy: { name: "asc" } }),
    prisma.assetReservation.findMany({ where: { tenantId, status: { in: ["REQUESTED", "APPROVED", "CHECKED_OUT"] } }, orderBy: { fromDate: "asc" }, take: 200 }),
    locationOptions(tenantId), employeeOptions(tenantId),
  ]);
  const people = new Map(employees.map((e) => [e.value, e.label]));
  return (
    <div className="stack gap-4">
      <Card title="Bookings" description="Requests from employees wait for approval here; then hand the asset over and take it back.">
        <Table head={["Asset", "Employee", "From", "To", "Purpose", "Status", ""]} empty={!bookings.length}>
          {bookings.map((b) => (
            <tr key={b.id}>
              <td>{tag.get(b.assetId)}</td><td>{people.get(b.employeeId) ?? "—"}</td><td>{fmtDate(b.fromDate)}</td><td>{fmtDate(b.toDate)}</td><td className="text-sm">{b.purpose}</td><td><Pill s={b.status} /></td>
              <td>
                {b.status === "REQUESTED" ? <><ActButton action={decideReservationAction} hidden={{ id: b.id, decision: "approve" }} label="Approve" variant="primary" /><ActButton action={decideReservationAction} hidden={{ id: b.id, decision: "reject" }} label="Reject" variant="danger" input={{ name: "note", placeholder: "Reason" }} /></> : null}
                {b.status === "APPROVED" ? <ActButton action={moveReservationAction} hidden={{ id: b.id, to: "CHECKED_OUT" }} label="Hand over" /> : null}
                {b.status === "CHECKED_OUT" ? <ActButton action={moveReservationAction} hidden={{ id: b.id, to: "RETURNED" }} label="Returned" /> : null}
              </td>
            </tr>
          ))}
        </Table>
        {poolAssets.length ? <div style={{ marginTop: 12 }}><SpecForm action={reserveAssetAction} submitLabel="Book for an employee" fields={[
          { name: "assetId", label: "Pool asset", type: "select", required: true, options: poolAssets }, { name: "employeeId", label: "Employee", type: "select", required: true, options: employees },
          { name: "fromDate", label: "From", type: "date", required: true }, { name: "toDate", label: "To", type: "date", required: true }, { name: "purpose", label: "Purpose", required: true, wide: true },
        ]} /></div> : null}
      </Card>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Pools">
          <Table head={["Pool", "Assets", "Max days"]} empty={!pools.length}>
            {pools.map((p) => <tr key={p.id}><td>{p.name}{p.description ? <div className="muted text-xs">{p.description}</div> : null}</td><td className="num">{p.assets.length}</td><td className="num">{p.maxDays}</td></tr>)}
          </Table>
          <div style={{ marginTop: 12 }}><SpecForm action={savePoolAction} submitLabel="Add pool" fields={[
            { name: "name", label: "Name", required: true }, { name: "maxDays", label: "Longest booking (days)", type: "number", defaultValue: 14 },
            { name: "locationId", label: "Location", type: "select", options: locations }, { name: "description", label: "Description" },
          ]} /></div>
        </Card>
        <Card title="Pool membership" description="Pool assets are booked for dates instead of being assigned.">
          {pools.length ? <SpecForm action={setAssetPoolAction} submitLabel="Add to pool" fields={[
            { name: "assetId", label: "Available asset", type: "select", required: true, options: assetOpts }, { name: "poolId", label: "Pool", type: "select", required: true, options: pools.map((p) => ({ value: p.id, label: p.name })) },
          ]} /> : <p className="muted text-sm">Create a pool first.</p>}
          {poolAssets.length ? <div style={{ marginTop: 12 }}><SpecForm action={setAssetPoolAction} submitLabel="Remove from pool" fields={[{ name: "assetId", label: "Pool asset", type: "select", required: true, options: poolAssets }]} /></div> : null}
        </Card>
      </div>
    </div>
  );
}

async function Stock({ tenantId }: { tenantId: string }) {
  const rows = await stockLevels(tenantId);
  return (
    <Card title="Stock by asset type" description="Set a minimum number of available units; the asset team is alerted (at most weekly) when a type drops below it.">
      <Table head={["Type", "Category", "Available", "Assigned", "In repair", "Total", "Minimum", ""]} empty={!rows.length}>
        {rows.map((r) => (
          <tr key={r.assetTypeId}>
            <td>{r.name}</td><td>{r.category}</td><td className={`num${r.low ? " neg" : ""}`}>{r.available}{r.low ? " (low)" : ""}</td><td className="num">{r.assigned}</td><td className="num">{r.inRepair}</td><td className="num">{r.total}</td><td className="num">{r.minAvailable ?? "—"}</td>
            <td><ActButton action={saveStockThresholdAction} hidden={{ assetTypeId: r.assetTypeId }} label="Set" input={{ name: "minAvailable", placeholder: "Minimum (0 clears)" }} /></td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Disposal({ tenantId, tag, assetOpts }: { tenantId: string; tag: Map<string, string>; assetOpts: Array<{ value: string; label: string }> }) {
  const rows = await prisma.assetDisposal.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 });
  const names = await userNames(tenantId, rows.map((r) => r.requestedByUserId));
  return (
    <div className="stack gap-4">
      <Card title="Disposals" description="Every disposal is approved in Inbox › Approvals by someone other than the requester before the asset is retired.">
        <Table head={["Asset", "Method", "Reason", "Book value", "Expected", "Realised", "Status", "Requested by", ""]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{tag.get(r.assetId)}</td><td>{DISPOSAL_METHODS[r.method as keyof typeof DISPOSAL_METHODS] ?? r.method}</td><td className="text-sm">{r.reason}</td>
              <td className="num">{money(r.bookValue)}</td><td className="num">{money(r.expectedValue)}</td><td className="num">{money(r.realisedValue)}</td><td><Pill s={r.status} /></td><td>{names.get(r.requestedByUserId)}</td>
              <td>{r.status === "APPROVED" ? <ActButton action={completeDisposalAction} hidden={{ id: r.id }} label="Mark disposed" variant="primary" input={{ name: "realisedValue", placeholder: "Amount realised ₹" }} /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Request disposal">
        <SpecForm action={requestDisposalAction} submitLabel="Send for approval" fields={[
          { name: "assetId", label: "Asset", type: "select", required: true, options: assetOpts },
          { name: "method", label: "Method", type: "select", required: true, options: Object.entries(DISPOSAL_METHODS).map(([value, label]) => ({ value, label })) },
          { name: "expectedValue", label: "Expected value (₹)", type: "number" }, { name: "reason", label: "Reason", required: true },
        ]} />
      </Card>
    </div>
  );
}

async function Reconciliation({ tenantId }: { tenantId: string }) {
  const [rows, locations] = await Promise.all([
    prisma.assetReconciliation.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50, include: { lines: { select: { found: true } } } }),
    locationOptions(tenantId),
  ]);
  const loc = new Map(locations.map((l) => [l.value, l.label]));
  return (
    <div className="stack gap-4">
      <Card title="Stock-takes" description="Snapshot what the register expects, check each asset physically, then close to see what is missing.">
        <Table head={["Stock-take", "Location", "Started", "Checked", "Missing", "Status"]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/assets/operations/reconciliation/${r.id}`}>{r.name}</Link></td><td>{r.locationId ? loc.get(r.locationId) : "All locations"}</td><td>{fmtDate(r.createdAt)}</td>
              <td className="num">{r.lines.filter((l) => l.found !== null).length}/{r.lines.length}</td><td className="num">{r.lines.filter((l) => l.found === false).length}</td><td><Pill s={r.status} /></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Start a stock-take">
        <SpecForm action={startReconciliationAction} submitLabel="Start" fields={[{ name: "name", label: "Name", required: true, placeholder: "Q3 2026 Bengaluru" }, { name: "locationId", label: "Location", type: "select", options: locations, placeholder: "All locations" }]} />
      </Card>
    </div>
  );
}
