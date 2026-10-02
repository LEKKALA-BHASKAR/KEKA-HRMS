import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { ensurePipelineSetup, funnel } from "@keka/services/src/psa";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { Disclosure } from "../../org/forms";
import { money } from "../billing/nav";
import { OpportunityForm, ProspectForm, StageMove } from "./forms";

/**
 * Projects › Pipeline: open opportunities as a board, one column per stage,
 * with the weighted value of each. A won deal is converted to a project from
 * its own page.
 */
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ archived?: string; owner?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE])) forbidden();
  const manage = can(viewer, P.OPPORTUNITY_MANAGE);
  const sp = await searchParams;
  await ensurePipelineSetup(viewer.tenantId);
  const archived = sp.archived === "1";
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const [stages, sources, opps, prospects, clients, people, pendingRequests] = await Promise.all([
    prisma.opportunityStage.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { sequence: "asc" } }),
    prisma.opportunitySource.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.opportunity.findMany({
      where: { tenantId: viewer.tenantId, archivedAt: archived ? { not: null } : null, ...(sp.owner ? { ownerId: sp.owner } : {}), ...(archived ? {} : { OR: [{ status: "OPEN" }, { closedAt: { gte: yearStart } }] }) },
      include: { client: { select: { name: true } }, prospect: { select: { name: true } }, owner: { select: { displayName: true } }, _count: { select: { estimates: true } }, projectRequests: { select: { status: true } }, project: { select: { id: true } } },
      orderBy: [{ closeDate: "asc" }],
    }),
    prisma.prospect.findMany({ where: { tenantId: viewer.tenantId, clientId: null }, include: { _count: { select: { opportunities: true } } }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    prisma.projectRequest.count({ where: { tenantId: viewer.tenantId, status: { in: ["NEW", "PENDING"] } } }),
  ]);
  const base = (o: (typeof opps)[number]) => Number(o.estimatedRevenue) * Number(o.fxRate);
  const open = opps.filter((o) => o.status === "OPEN");
  const won = opps.filter((o) => o.status === "WON");
  const f = funnel(stages.map((s) => ({ ...s })), opps.map((o) => ({ stageId: o.stageId, estimatedRevenue: Number(o.estimatedRevenue), fxRate: Number(o.fxRate) })), "AMOUNT", true);
  const stageOpts = stages.map((s) => ({ value: s.id, label: s.name, kind: s.kind }));
  const owners = [...new Map(opps.map((o) => [o.ownerId, o.owner.displayName ?? ""])).entries()];
  return (
    <>
      <PageHead title="Sales pipeline" subtitle="Opportunities by stage; a won deal becomes a project through a project request"
        actions={<><Link className="btn" href="/projects/pipeline/requests">Project requests{pendingRequests ? ` (${pendingRequests})` : ""}</Link><Link className="btn" href="/projects?tab=projects">Projects</Link></>} />
      <div className="stack gap-3">
        <div className="grid grid-4">
          <Stat label="Open pipeline" value={money(open.reduce((s, o) => s + base(o), 0))} meta={`${open.length} opportunit${open.length === 1 ? "y" : "ies"}`} />
          <Stat label="Weighted" value={money(open.reduce((s, o) => s + (base(o) * o.winProbability) / 100, 0))} meta="value × win probability" />
          <Stat label={`Won since ${formatDate(yearStart)}`} value={money(won.reduce((s, o) => s + base(o), 0))} meta={`${won.length} deal(s)`} />
          <Stat label="Lost" value={opps.filter((o) => o.status === "LOST").length} meta="this year" />
        </div>
        {manage ? (
          <Card title="New opportunity" description="For an existing client or a prospect; a deal created as won asks for its project straight away.">
            <Disclosure label="New opportunity">
              <OpportunityForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} prospects={prospects.map((p) => ({ value: p.id, label: p.name }))}
                stages={stageOpts} sources={sources.map((s) => ({ value: s.id, label: s.name }))} people={people.map((p) => ({ value: p.id, label: p.displayName ?? "" }))} meId={viewer.employee?.id} />
            </Disclosure>
          </Card>
        ) : null}
        <form className="row gap-2">
          <select className="select" name="owner" defaultValue={sp.owner ?? ""} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Owner"><option value="">All owners</option>{owners.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
          <label className="row gap-1 text-sm"><input type="checkbox" name="archived" value="1" defaultChecked={archived} /> Archived</label>
          <button className="btn sm">Apply</button>
        </form>
        <div className="row gap-3" style={{ alignItems: "flex-start", overflowX: "auto", paddingBottom: 8 }}>
          {stages.map((s) => {
            const col = opps.filter((o) => o.stageId === s.id);
            const fs = f.find((x) => x.stageId === s.id);
            return (
              <div key={s.id} className="card" style={{ minWidth: 250, flex: "1 0 250px" }}>
                <div className="card-head" style={{ borderTop: `3px solid ${s.color}` }}>
                  <div><div className="card-title">{s.name} <span className="subtle text-sm">({col.length})</span></div><div className="card-desc">{s.winProbability}% · {money(fs?.amount ?? 0)}{fs && s.kind === "OPEN" ? ` · weighted ${money(fs.weighted)}` : ""}</div></div>
                </div>
                <div className="card-body stack gap-2" style={{ padding: 10 }}>
                  {col.length === 0 ? <span className="text-xs subtle">Nothing here</span> : null}
                  {col.map((o) => (
                    <div key={o.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }} className="stack gap-1">
                      <Link href={`/projects/pipeline/${o.id}`} className="strong text-sm">{o.name}</Link>
                      <div className="text-xs subtle">{o.number} · {o.client?.name ?? `${o.prospect?.name ?? "—"} (prospect)`}</div>
                      <div className="text-sm">{money(o.estimatedRevenue, o.currency)} <span className="text-xs subtle">· closes {formatDate(o.closeDate)}</span></div>
                      <div className="text-xs subtle">{o.owner.displayName}{o._count.estimates ? ` · ${o._count.estimates} estimate(s)` : ""}</div>
                      {o.project ? <Badge tone="success"><Link href={`/projects/${o.project.id}`}>Project created</Link></Badge> : o.projectRequests.some((r) => ["NEW", "PENDING"].includes(r.status)) ? <Badge tone="warning">Project requested</Badge> : null}
                      {manage && !o.archivedAt ? <StageMove id={o.id} stageId={o.stageId} stages={stageOpts} /> : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <Card tight title={`Prospects (${prospects.length})`} description="Would-be clients. A prospect becomes a client when a project for it is approved.">
          {prospects.length === 0 ? <Empty title="No open prospects" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Prospect</th><th>Contact</th><th>Place</th><th>Currency</th><th className="num">Opportunities</th></tr></thead>
              <tbody>{prospects.map((p) => (
                <tr key={p.id}><td className="strong text-sm">{p.name}</td><td className="text-sm">{p.contactName ?? "—"}{p.contactEmail ? <div className="text-xs subtle">{p.contactEmail}</div> : null}</td><td className="text-sm">{[p.city, p.state, p.countryCode].filter(Boolean).join(", ")}</td><td className="text-sm">{p.currency}</td><td className="num">{p._count.opportunities}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {manage ? <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><Disclosure label="Add a prospect" variant="default"><ProspectForm people={people.map((p) => ({ value: p.id, label: p.displayName ?? "" }))} /></Disclosure></div> : null}
        </Card>
      </div>
    </>
  );
}
