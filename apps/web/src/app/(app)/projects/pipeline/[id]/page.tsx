import Link from "next/link";
import { notFound, forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { estimateTotals, BILLING_LABEL } from "@keka/services/src/psa";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat, KeyValue } from "@/components/ui";
import { Disclosure } from "../../../org/forms";
import { money, iso, label } from "../../billing/nav";
import {
  OpportunityForm, StageMove, OpportunityOps, CommentForm, EstimateCreate, EstimateHeader, EstimateLineForm, EstimateOps, LineDelete, ProjectRequestForm,
} from "../forms";

const STATUS_TONE: Record<string, "info" | "success" | "danger" | "neutral"> = { OPEN: "info", WON: "success", LOST: "danger", ARCHIVED: "neutral" };
const REQ_TONE: Record<string, "info" | "warning" | "success" | "danger" | "neutral"> = { NEW: "info", PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };

/** One opportunity: details and stage, estimates (task and resource) and the hand-off to a project. */
export default async function OpportunityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ estimate?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE])) forbidden();
  const manage = can(viewer, P.OPPORTUNITY_MANAGE);
  const { id } = await params;
  const sp = await searchParams;
  const o = await prisma.opportunity.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      stage: true, client: { select: { name: true } }, prospect: { select: { name: true } }, source: { select: { name: true } }, owner: { select: { displayName: true } },
      estimates: { orderBy: { createdAt: "asc" }, include: { lines: { orderBy: { sequence: "asc" } }, rateCard: { select: { name: true } } } },
      comments: { orderBy: { createdAt: "desc" }, take: 30 }, projectRequests: { orderBy: { requestedAt: "desc" } }, project: { select: { id: true, name: true } },
    },
  });
  if (!o) notFound();
  const [stages, sources, clients, prospects, people, rateCards, roles, authors, settings] = await Promise.all([
    prisma.opportunityStage.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { sequence: "asc" } }),
    prisma.opportunitySource.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.prospect.findMany({ where: { tenantId: viewer.tenantId, clientId: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    prisma.rateCard.findMany({ where: { tenantId: viewer.tenantId, isActive: true, OR: [{ clientId: null }, ...(o.clientId ? [{ clientId: o.clientId }] : [])] }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.billingRole.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { in: [...new Set(o.comments.map((c) => c.authorId))] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }),
    prisma.psaSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { projectCreationNeedsApproval: true } }),
  ]);
  const est = o.estimates.find((e) => e.id === sp.estimate) ?? o.estimates.find((e) => e.status === "PUBLISHED") ?? o.estimates[0];
  const totals = est ? estimateTotals(est.lines.map((l) => ({ kind: l.kind, startDate: l.startDate, endDate: l.endDate, headcount: l.headcount, allocationPercent: Number(l.allocationPercent), hours: Number(l.hours), billRate: Number(l.billRate), costRate: Number(l.costRate), amount: Number(l.amount) }))) : null;
  const openRequest = o.projectRequests.find((r) => ["NEW", "PENDING"].includes(r.status));
  const stageOpts = stages.map((s) => ({ value: s.id, label: s.name, kind: s.kind }));
  const peopleOpts = people.map((p) => ({ value: p.id, label: p.displayName ?? "" }));
  const canRequest = canAny(viewer, [P.OPPORTUNITY_MANAGE, P.PROJECT_MANAGE]);
  const canApprove = can(viewer, P.PROJECT_MANAGE) && !settings?.projectCreationNeedsApproval;
  const lineName = (lid: string | null) => est?.lines.find((l) => l.id === lid)?.name;
  return (
    <>
      <PageHead title={o.name} subtitle={<>{o.number} · {o.client?.name ?? `${o.prospect?.name ?? "—"} (prospect)`} · <Badge tone={STATUS_TONE[o.status]}>{label(o.status)}</Badge> <span className="text-sm subtle">{o.stage.name}, {o.winProbability}%</span></>}
        actions={<Link className="btn sm" href="/projects/pipeline">Pipeline</Link>} />
      <div className="stack gap-3">
        <div className="grid grid-4">
          <Stat label="Estimated revenue" value={money(o.estimatedRevenue, o.currency)} meta={o.currency !== "INR" ? `${money(Number(o.estimatedRevenue) * Number(o.fxRate))} at ${Number(o.fxRate)}` : undefined} />
          <Stat label="Weighted" value={money((Number(o.estimatedRevenue) * Number(o.fxRate) * o.winProbability) / 100)} meta={`${o.winProbability}% win probability`} />
          <Stat label="Closes" value={formatDate(o.closeDate)} meta={o.closedAt ? `closed ${formatDate(o.closedAt)}` : undefined} />
          <Stat label="Estimates" value={o.estimates.length} meta={o.estimates.some((e) => e.status === "PUBLISHED") ? "one published" : "none published"} />
        </div>

        <Card title="Opportunity" action={manage ? <Disclosure label="Edit" variant="default"><OpportunityForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} prospects={[...prospects, ...(o.prospectId && o.prospect ? [{ id: o.prospectId, name: o.prospect.name }] : [])].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i).map((p) => ({ value: p.id, label: p.name }))}
          stages={stageOpts} sources={sources.map((s) => ({ value: s.id, label: s.name }))} people={peopleOpts}
          opp={{ id: o.id, name: o.name, description: o.description, clientId: o.clientId, prospectId: o.prospectId, sourceId: o.sourceId, stageId: o.stageId, ownerId: o.ownerId, billingModel: o.billingModel, estimatedRevenue: Number(o.estimatedRevenue), fxRate: Number(o.fxRate), startDate: iso(o.startDate), closeDate: iso(o.closeDate), expectedProjectStart: iso(o.expectedProjectStart), expectedProjectEnd: o.expectedProjectEnd ? iso(o.expectedProjectEnd) : null }} /></Disclosure> : null}>
          <div className="stack gap-3">
            <KeyValue items={[
              ["Owner", o.owner.displayName], ["Source", o.source?.name ?? null], ["Billing", BILLING_LABEL[o.billingModel] ?? label(o.billingModel)],
              ["Project", `${formatDate(o.expectedProjectStart)} – ${o.expectedProjectEnd ? formatDate(o.expectedProjectEnd) : "open"}`],
              ["Lost because", o.lostReason], ["About", o.description],
            ]} />
            {manage ? <div className="row gap-3 wrap" style={{ justifyContent: "space-between" }}>{o.archivedAt ? <span className="text-sm subtle">Archived — restore it to move it.</span> : <StageMove id={o.id} stageId={o.stageId} stages={stageOpts} />}<OpportunityOps id={o.id} archived={!!o.archivedAt} won={o.stage.kind === "WON"} requested={!!openRequest || !!o.project} /></div> : null}
          </div>
        </Card>

        {o.stage.kind === "WON" || o.projectRequests.length ? (
          <Card title="Project" description="A won opportunity becomes a project request; the project admin approves it and the project is created, with the published resource estimate's roles as resource requests.">
            <div className="stack gap-3">
              {o.project ? <div className="text-sm">Created: <Link href={`/projects/${o.project.id}`} className="strong">{o.project.name}</Link></div> : null}
              {o.projectRequests.map((r) => (
                <div key={r.id} className="row gap-2 text-sm"><Badge tone={REQ_TONE[r.status]}>{label(r.status)}</Badge> {r.name} · raised {formatDate(r.requestedAt)}{r.rejectReason ? <span className="subtle"> — {r.rejectReason}</span> : null}</div>
              ))}
              {openRequest?.status === "NEW" && canRequest ? (
                <ProjectRequestForm requestId={openRequest.id} clients={clients.map((c) => ({ value: c.id, label: c.name }))} people={peopleOpts} rateCards={rateCards.map((c) => ({ value: c.id, label: c.name }))} canApprove={canApprove}
                  defaults={{ name: o.name, clientId: o.clientId, billingModel: o.billingModel, budget: Number(o.estimatedRevenue) * Number(o.fxRate), startDate: iso(o.expectedProjectStart), endDate: o.expectedProjectEnd ? iso(o.expectedProjectEnd) : null, rateCardId: est?.rateCardId ?? null }} />
              ) : null}
              {openRequest?.status === "PENDING" ? <div className="text-sm">Waiting for a project admin. <Link href="/projects/pipeline/requests">Project requests</Link></div> : null}
              {!openRequest && !o.project && o.stage.kind === "WON" ? <span className="text-sm subtle">Use “Convert to project” above to start the request.</span> : null}
            </div>
          </Card>
        ) : null}

        <Card title="Estimates" description="Task estimates price phases, tasks and milestones; resource estimates price roles over dates from a rate card. Publishing one marks it as the estimate of record.">
          <div className="stack gap-3">
            {o.estimates.length ? (
              <div className="row gap-2 wrap">
                {o.estimates.map((e) => <Link key={e.id} href={`?estimate=${e.id}`} className={`btn sm${e.id === est?.id ? " primary" : ""}`}>{e.name} · {label(e.type)}{e.status === "PUBLISHED" ? " · published" : ""}</Link>)}
              </div>
            ) : <span className="text-sm subtle">No estimates yet.</span>}
            {manage ? <EstimateCreate opportunityId={o.id} /> : null}
          </div>
        </Card>

        {est && totals ? (
          <Card tight title={`${est.name} (${label(est.type)} estimate)`} description={`${totals.hours} h · billing ${money(totals.billing, o.currency)} · cost ${money(totals.cost, o.currency)}${totals.margin === null ? "" : ` · margin ${totals.margin}%`}${est.rateCard ? ` · rate card ${est.rateCard.name}` : ""}`}
            action={manage ? <EstimateOps estimateId={est.id} published={est.status === "PUBLISHED"} /> : <Badge tone={est.status === "PUBLISHED" ? "success" : "neutral"}>{label(est.status)}</Badge>}>
            {manage ? <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}><EstimateHeader estimateId={est.id} name={est.name} rateCardId={est.rateCardId} rateCards={rateCards.map((c) => ({ value: c.id, label: c.name }))} /></div> : null}
            {est.lines.length === 0 ? <Empty title="No lines yet">{est.type === "RESOURCE" && !est.rateCardId ? "Choose a rate card to start adding resources." : undefined}</Empty> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Line</th><th>Kind</th><th>Dates</th><th className="num">Hours</th><th className="num">Bill rate</th><th className="num">Billing</th><th className="num">Cost</th>{manage ? <th /> : null}</tr></thead>
                <tbody>{est.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="text-sm" style={{ paddingLeft: l.parentId ? 28 : undefined }}><span className={l.kind === "PHASE" ? "strong" : ""}>{l.name}</span>{l.kind === "ROLE" ? <div className="text-xs subtle">{l.headcount} × {Number(l.allocationPercent)}%</div> : l.parentId ? <div className="text-xs subtle">{lineName(l.parentId)}</div> : null}</td>
                    <td className="text-sm">{label(l.kind)}</td>
                    <td className="text-sm nowrap">{l.startDate ? formatDate(l.startDate) : ""}{l.endDate ? ` – ${formatDate(l.endDate)}` : ""}</td>
                    <td className="num">{Number(l.hours) || "—"}</td>
                    <td className="num">{Number(l.billRate) ? money(l.billRate, o.currency) : "—"}</td>
                    <td className="num">{Number(l.amount) ? money(l.amount, o.currency) : "—"}</td>
                    <td className="num">{Number(l.cost) ? money(l.cost, o.currency) : "—"}</td>
                    {manage ? <td><LineDelete estimateId={est.id} lineId={l.id} /></td> : null}
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {manage ? <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><EstimateLineForm estimateId={est.id} type={est.type} roles={roles.map((r) => ({ value: r.id, label: r.name }))} people={peopleOpts} phases={est.lines.filter((l) => l.kind === "PHASE").map((l) => ({ value: l.id, label: l.name }))} /></div> : null}
          </Card>
        ) : null}

        <Card tight title="Comments">
          <div style={{ padding: 14 }}><CommentForm id={o.id} /></div>
          {o.comments.length === 0 ? null : (
            <div className="stack">{o.comments.map((c) => {
              const a = authors.find((u) => u.id === c.authorId);
              return <div key={c.id} style={{ padding: "8px 16px", borderTop: "1px solid var(--border)" }} className="text-sm"><span className="strong">{a?.employee?.displayName ?? a?.email ?? "Someone"}</span> <span className="text-xs subtle">{formatDate(c.createdAt)}</span><div>{c.body}</div></div>;
            })}</div>
          )}
        </Card>
      </div>
    </>
  );
}
