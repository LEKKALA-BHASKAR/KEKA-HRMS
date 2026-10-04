import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { reconciliationSummary } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { checkLineAction, closeReconciliationAction } from "@/app/actions/asset-ops";

export const metadata = { title: "Stock-take" };

/** One stock-take: mark each expected asset found or missing, then close it. */
export default async function ReconciliationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) forbidden();
  const { id } = await params;
  const sp = await searchParams;
  const r = await prisma.assetReconciliation.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { lines: { orderBy: { id: "asc" } } } });
  if (!r) notFound();
  const assets = new Map((await prisma.asset.findMany({ where: { tenantId: viewer.tenantId, id: { in: r.lines.map((l) => l.assetId) } }, select: { id: true, assetTag: true, name: true, assetType: { select: { name: true } } } })).map((a) => [a.id, `${a.assetTag} · ${a.name ?? a.assetType.name}`]));
  const sum = reconciliationSummary(r.lines);
  const show = sp.show === "unchecked" ? r.lines.filter((l) => l.found === null) : sp.show === "missing" ? r.lines.filter((l) => l.found === false) : r.lines;
  const open = r.status === "OPEN";
  return (
    <>
      <PageHead title={r.name} subtitle={`Started ${fmtWhen(r.createdAt)}${r.closedAt ? ` · closed ${fmtWhen(r.closedAt)}` : ""}`} actions={<Link className="btn ghost" href="/assets/operations?tab=reconciliation">All stock-takes</Link>} />
      <div className="grid grid-4"><Stat label="Expected" value={sum.total} /><Stat label="Checked" value={sum.checked} /><Stat label="Missing" value={sum.missing} /><Stat label="Misplaced" value={sum.misplaced} /></div>
      <Card title="Assets" description={open ? "Mark each asset as you find it. Close the stock-take once every line is checked." : undefined}>
        <div className="row gap-2" style={{ marginBottom: 8 }}>
          <Link className="btn sm" href={`/assets/operations/reconciliation/${r.id}`}>All</Link>
          <Link className="btn sm" href={`/assets/operations/reconciliation/${r.id}?show=unchecked`}>Unchecked ({sum.unchecked})</Link>
          <Link className="btn sm" href={`/assets/operations/reconciliation/${r.id}?show=missing`}>Missing ({sum.missing})</Link>
          <a className="btn sm" href={`/assets/operations/export?tab=reconciliation&id=${r.id}`}>Download CSV</a>
        </div>
        <Table head={["Asset", "Expected", "Holder", "Location", "Result", ""]} empty={!show.length}>
          {show.map((l) => (
            <tr key={l.id}>
              <td>{assets.get(l.assetId) ?? "—"}</td><td><Pill s={l.expectedStatus} /></td><td>{l.expectedHolder ?? "—"}</td><td>{l.expectedLocation ?? "—"}</td>
              <td>{l.found === null ? <span className="muted">Not checked</span> : l.found ? `Found${l.foundLocation ? ` at ${l.foundLocation}` : ""}${l.foundCondition ? ` · ${l.foundCondition.toLowerCase()}` : ""}` : <span className="neg">Missing</span>}{l.note ? <div className="muted text-xs">{l.note}</div> : null}</td>
              <td>{open ? <div className="row gap-2 wrap"><ActButton action={checkLineAction} hidden={{ lineId: l.id, found: "yes" }} label="Found" variant="primary" input={{ name: "location", placeholder: "Where (if elsewhere)" }} /><ActButton action={checkLineAction} hidden={{ lineId: l.id, found: "no" }} label="Missing" variant="danger" /></div> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {open ? (
        <Card title="Close stock-take">
          <SpecForm action={closeReconciliationAction} hidden={{ id: r.id }} submitLabel="Close" fields={[{ name: "markMissingLost", label: "Missing assets", type: "checkbox", placeholder: "Mark every missing asset as lost in the register" }]} />
        </Card>
      ) : null}
    </>
  );
}
