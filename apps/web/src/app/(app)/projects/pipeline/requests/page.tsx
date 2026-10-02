import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { formFromJson, BILLING_LABEL } from "@keka/services/src/psa";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { Disclosure } from "../../../org/forms";
import { money, label } from "../../billing/nav";
import { ProjectRequestForm, RequestDecision } from "../forms";

const TONE: Record<string, "info" | "warning" | "success" | "danger" | "neutral"> = { NEW: "info", PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };

/** Projects › Pipeline › Project requests: won deals waiting to become projects, and requests raised directly. */
export default async function ProjectRequestsPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE, P.PROJECT_MANAGE])) forbidden();
  const admin = can(viewer, P.PROJECT_MANAGE);
  const canRaise = canAny(viewer, [P.OPPORTUNITY_MANAGE, P.PROJECT_MANAGE]);
  const [open, decided, clients, people, rateCards, settings] = await Promise.all([
    prisma.projectRequest.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["NEW", "PENDING"] } }, include: { opportunity: { select: { id: true, number: true } }, client: { select: { name: true } }, prospect: { select: { name: true } } }, orderBy: { requestedAt: "asc" } }),
    prisma.projectRequest.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["NEW", "PENDING"] } }, include: { project: { select: { id: true, name: true } } }, orderBy: { decidedAt: "desc" }, take: 20 }),
    prisma.client.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    prisma.rateCard.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.psaSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { projectCreationNeedsApproval: true } }),
  ]);
  const names = new Map(people.map((p) => [p.id, p.displayName ?? ""]));
  return (
    <>
      <PageHead title="Project requests" subtitle={admin ? "Approve a request to create its project" : "Requests wait here for a project admin"} actions={<Link className="btn sm" href="/projects/pipeline">Pipeline</Link>} />
      <div className="stack gap-3">
        {canRaise ? (
          <Card title="Request a project" description="Not every project starts as an opportunity.">
            <Disclosure label="New request">
              <ProjectRequestForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} people={people.map((p) => ({ value: p.id, label: p.displayName ?? "" }))} rateCards={rateCards.map((c) => ({ value: c.id, label: c.name }))}
                canApprove={admin && !settings?.projectCreationNeedsApproval} defaults={{ name: "", clientId: null, billingModel: "TIME_AND_MATERIAL", budget: null, startDate: null, endDate: null }} />
            </Disclosure>
          </Card>
        ) : null}
        <Card tight title={`Open (${open.length})`}>
          {open.length === 0 ? <Empty title="Nothing waiting" /> : (
            <div className="stack">{open.map((r) => {
              const f = formFromJson(r.payload);
              return (
                <div key={r.id} className="row wrap gap-3" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", justifyContent: "space-between" }}>
                  <div style={{ minWidth: 260 }} className="stack gap-1">
                    <div className="text-sm"><span className="strong">{f?.name ?? r.name}</span> <Badge tone={TONE[r.status]}>{r.status === "NEW" ? "needs project details" : "awaiting approval"}</Badge></div>
                    <div className="text-xs subtle">
                      {r.client?.name ?? (r.prospect ? `${r.prospect.name} (prospect)` : "No client")} · {BILLING_LABEL[f?.billingModel ?? r.billingModel] ?? label(r.billingModel)}
                      {r.estimatedRevenue ? ` · ${money(r.estimatedRevenue, r.currency)}` : ""} · raised {formatDate(r.requestedAt)}
                      {f?.projectManagerId ? ` · PM ${names.get(f.projectManagerId) ?? ""}` : ""}{f?.startDate ? ` · from ${formatDate(f.startDate)}` : ""}
                    </div>
                    {r.opportunity ? <Link className="text-xs" href={`/projects/pipeline/${r.opportunity.id}`}>From {r.opportunity.number}</Link> : null}
                  </div>
                  {r.status === "PENDING" && admin ? <RequestDecision id={r.id} /> : r.status === "NEW" && r.opportunity ? <Link className="btn sm" href={`/projects/pipeline/${r.opportunity.id}`}>Fill in the project</Link> : null}
                </div>
              );
            })}</div>
          )}
        </Card>
        <Card tight title="Decided">
          {decided.length === 0 ? <Empty title="None yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Request</th><th>Status</th><th>Decided</th><th>Project</th></tr></thead>
              <tbody>{decided.map((r) => (
                <tr key={r.id}><td className="text-sm">{r.name}{r.rejectReason ? <div className="text-xs subtle">{r.rejectReason}</div> : null}</td><td><Badge tone={TONE[r.status]}>{label(r.status)}</Badge></td><td className="text-sm">{r.decidedAt ? formatDate(r.decidedAt) : "—"}</td><td className="text-sm">{r.project ? <Link href={`/projects/${r.project.id}`}>{r.project.name}</Link> : "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
