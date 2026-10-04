import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { ensureReadinessLevels, isReadyNow, planRisk } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Badge, Callout, KeyValue } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReviewButtons } from "@/components/growth-report";
import { saveSuccessionPlanAction, successionPlanReviewAction, deleteSuccessionPlanAction, nominateSuccessorAction, decideSuccessorAction, updateSuccessorAction, decideReadinessChangeAction, removeSuccessorAction, successorDevelopmentAction } from "@/app/actions/succession";

const P = PERMISSIONS;
const LMH = [{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }];

/** A succession plan: HR runs it; the position's holder may see it and nominate. */
export default async function SuccessionPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const hr = can(viewer, P.SUCCESSION_MANAGE);
  const plan = await prisma.successionPlan.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { incumbent: { select: { id: true, displayName: true, jobTitleName: true } }, successors: { include: { readiness: true, employee: { select: { id: true, displayName: true, jobTitleName: true, employeeNumber: true } } }, orderBy: [{ status: "asc" }, { rank: "asc" }] } },
  });
  const incumbent = !!plan?.incumbentId && plan.incumbentId === viewer.employee?.id;
  if (!plan || (!hr && !incumbent)) notFound();
  const [levels, people, departments] = await Promise.all([
    ensureReadinessLevels(viewer.tenantId),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] }, id: { notIn: [...plan.successors.filter((s) => s.status !== "DECLINED").map((s) => s.employeeId), plan.incumbentId ?? ""] } }, select: { id: true, displayName: true, jobTitleName: true }, orderBy: { firstName: "asc" }, take: 2000 }),
    hr ? prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);
  const levelOpts = levels.filter((l) => l.isActive).map((l) => ({ value: l.id, label: l.name }));
  const levelName = new Map(levels.map((l) => [l.id, l.name]));
  const locked = plan.status === "SUBMITTED" || plan.status === "ARCHIVED";
  const risk = planRisk({ criticality: plan.criticality, riskOfLoss: plan.riskOfLoss, successors: plan.successors.map((s) => ({ status: s.status, readyNow: isReadyNow(s.readiness) })) });

  return (
    <>
      <PageHead
        title={plan.positionTitle}
        subtitle={<span className="row gap-2"><Badge tone={STATUS_TONE[plan.status]} dot>{plan.status.toLowerCase()}</Badge><Badge tone={risk === "COVERED" ? "success" : risk === "WATCH" ? "warning" : "danger"} dot>{risk.replace("_", " ").toLowerCase()}</Badge></span>}
        actions={<>
          <Link className="btn" href={hr ? "/performance/succession" : "/me/career"}>Back</Link>
          {hr ? <ReviewButtons action={successionPlanReviewAction} hidden={{ planId: plan.id }} status={plan.status} submittedByMe={plan.submittedBy === viewer.user.id} /> : null}
          {hr && plan.status === "DRAFT" ? <ActButton action={deleteSuccessionPlanAction} hidden={{ planId: plan.id }} label="Delete" variant="ghost" confirmText="Delete this succession plan?" /> : null}
        </>}
      />
      {plan.decisionNote ? <div style={{ marginBottom: 12 }}><Callout tone={plan.status === "APPROVED" ? "success" : "warning"} title={plan.status === "APPROVED" ? "Approved" : "Note from the approver"}>{plan.decisionNote}</Callout></div> : null}
      <div className="stack gap-4">
        <Panel title="Position">
          <KeyValue items={[
            ["Holder", plan.incumbent ? `${plan.incumbent.displayName}${plan.incumbent.jobTitleName ? ` · ${plan.incumbent.jobTitleName}` : ""}` : "Vacant"],
            ["Criticality", plan.criticality.toLowerCase()],
            ["Risk of loss", plan.riskOfLoss.toLowerCase()],
            ["Impact if vacant", plan.vacancyImpact ?? "—"],
            ["Last decision", plan.decidedAt ? formatDate(plan.decidedAt) : "—"],
          ]} />
        </Panel>

        <Panel title={`Successors (${plan.successors.length})`} subtitle="A nomination is approved by someone other than the nominator; a readiness change on an approved successor needs a second sign-off" pad={false}>
          {plan.successors.length === 0 ? <EmptyState title="No successors yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th className="num">Rank</th><th>Successor</th><th>Readiness</th><th>Status</th><th>Notes</th>{hr ? <th /> : null}</tr></thead>
                <tbody>
                  {plan.successors.map((s) => (
                    <tr key={s.id}>
                      <td className="num">{s.rank}</td>
                      <td><span className="strong">{s.employee.displayName}</span>{s.isEmergency ? <Badge tone="warning">Emergency cover</Badge> : null}<div className="text-xs subtle">{s.employee.jobTitleName ?? s.employee.employeeNumber}</div></td>
                      <td className="text-sm">{s.readiness.name}{s.pendingReadinessId ? <div className="text-xs neg">Change to “{levelName.get(s.pendingReadinessId)}” pending: {s.pendingReason}</div> : null}</td>
                      <td><Badge tone={s.status === "APPROVED" ? "success" : s.status === "NOMINATED" ? "warning" : "neutral"} dot>{s.status.toLowerCase()}</Badge></td>
                      <td className="text-sm">{s.notes ?? "—"}{s.developmentPlanId ? <div className="text-xs"><Link href="/performance/development">Development plan linked</Link></div> : null}</td>
                      {hr ? (
                        <td className="right" style={{ minWidth: 240 }}>
                          <span className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                            {s.status === "NOMINATED" && s.nominatedBy !== viewer.user.id ? <>
                              <ActButton action={decideSuccessorAction} hidden={{ successorId: s.id, decision: "approve" }} label="Approve" variant="primary" />
                              <ActButton action={decideSuccessorAction} hidden={{ successorId: s.id, decision: "decline" }} label="Decline" />
                            </> : null}
                            {s.pendingReadinessId && s.pendingBy !== viewer.user.id ? <>
                              <ActButton action={decideReadinessChangeAction} hidden={{ successorId: s.id, decision: "approve" }} label="Approve change" variant="primary" />
                              <ActButton action={decideReadinessChangeAction} hidden={{ successorId: s.id, decision: "decline" }} label="Reject change" />
                            </> : null}
                            {s.status === "APPROVED" && !s.developmentPlanId ? <ActButton action={successorDevelopmentAction} hidden={{ successorId: s.id }} label="Start development plan" /> : null}
                            {!locked ? <ActButton action={removeSuccessorAction} hidden={{ successorId: s.id }} label="Remove" variant="ghost" confirmText="Remove this successor?" /> : null}
                          </span>
                          {!locked && s.status !== "DECLINED" ? (
                            <Reveal label="Edit">
                              <GrowthForm action={updateSuccessorAction} hidden={{ successorId: s.id }} cols={2} compact fields={[
                                { name: "readinessId", label: "Readiness", type: "select", required: true, options: levelOpts, defaultValue: s.readinessId },
                                { name: "rank", label: "Rank", type: "number", min: 1, max: 20, defaultValue: s.rank },
                                { name: "reason", label: "Reason (needed to change an approved successor's readiness)" },
                                { name: "notes", label: "Notes", defaultValue: s.notes },
                                { name: "isEmergency", label: "Emergency cover", type: "checkbox", defaultChecked: s.isEmergency },
                              ]} />
                            </Reveal>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!locked ? (
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
              <div className="strong text-sm" style={{ marginBottom: 6 }}>Nominate a successor</div>
              <GrowthForm action={nominateSuccessorAction} hidden={{ planId: plan.id }} cols={3} compact submitLabel="Nominate" fields={[
                { name: "employeeId", label: "Employee", type: "select", required: true, options: people.map((p) => ({ value: p.id, label: `${p.displayName}${p.jobTitleName ? ` · ${p.jobTitleName}` : ""}` })) },
                { name: "readinessId", label: "Readiness", type: "select", required: true, options: levelOpts },
                { name: "rank", label: "Rank", type: "number", min: 1, max: 20 },
                { name: "notes", label: "Why them", wide: true },
                { name: "isEmergency", label: "Emergency cover", type: "checkbox" },
              ]} />
            </div>
          ) : null}
        </Panel>

        {hr && !locked ? (
          <Reveal label="Edit plan">
            <Panel title="Plan details">
              <GrowthForm action={saveSuccessionPlanAction} hidden={{ id: plan.id }} fields={[
                { name: "positionTitle", label: "Position", required: true, defaultValue: plan.positionTitle },
                { name: "incumbentId", label: "Holder", type: "select", options: [...(plan.incumbent ? [{ value: plan.incumbent.id, label: plan.incumbent.displayName ?? "" }] : []), ...people.map((p) => ({ value: p.id, label: p.displayName ?? "" }))], defaultValue: plan.incumbentId },
                { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })), defaultValue: plan.departmentId },
                { name: "criticality", label: "Criticality", type: "select", required: true, options: LMH, defaultValue: plan.criticality },
                { name: "riskOfLoss", label: "Risk of loss", type: "select", required: true, options: LMH, defaultValue: plan.riskOfLoss },
                { name: "vacancyImpact", label: "Impact if vacant", type: "textarea", defaultValue: plan.vacancyImpact },
                { name: "notes", label: "Notes", type: "textarea", defaultValue: plan.notes },
              ]} />
            </Panel>
          </Reveal>
        ) : null}
      </div>
    </>
  );
}
