import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { probationStage, probationReviewSummary, reviewOpensOn, confirmationEffectiveDate } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Callout, KeyValue, Person, Progress, Empty } from "@/components/ui";
import { STAGE, REC } from "../_lib";
import { ChangePolicyForm, OpenReviewButton, DecisionForm } from "../forms";

const P = PERMISSIONS;
const EV_TONE = { PENDING: "warning", SUBMITTED: "success", SKIPPED: "neutral" } as const;

export default async function ProbationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const { id } = await params;
  const p = await prisma.employeeProbation.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      policy: true,
      employee: {
        select: {
          id: true, displayName: true, employeeNumber: true, jobTitleName: true, dateOfJoining: true, status: true,
          departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true,
          department: { select: { name: true } }, reportingManager: { select: { displayName: true } },
        },
      },
      evaluations: { include: { evaluator: { select: { displayName: true } } }, orderBy: [{ round: "desc" }, { role: "asc" }] },
    },
  });
  if (!p) notFound();
  const e = p.employee;
  // Out of scope, or the viewer's own probation, reads as not found.
  if (e.id === viewer.employee?.id || !canAccessEmployee(viewer, e, P.PROBATION_MANAGE)) notFound();

  const today = new Date();
  const s = probationStage(p, p.policy.reviewLeadDays, today);
  const current = p.evaluations.filter((x) => x.round === p.round);
  const summary = probationReviewSummary(current);
  const open = p.status === "ACTIVE" || p.status === "IN_REVIEW";
  const canExtend = p.extensions < p.policy.maxExtensions;
  const policies = await prisma.probationPolicy.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const rounds = [...new Set(p.evaluations.map((x) => x.round))];

  return (
    <>
      <PageHead
        title={<span className="row gap-2">{e.displayName} <Badge tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Badge></span>}
        subtitle={`${e.employeeNumber} · ${[e.jobTitleName, e.department?.name].filter(Boolean).join(" · ")} · probation ${formatDate(p.startDate)} – ${formatDate(p.endDate)}`}
        actions={<><Link className="btn" href={`/employees/${e.id}`}>Profile</Link><Link className="btn" href="/probation">All probations</Link></>}
      />

      {open && s.stage === "OVERDUE" ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="danger" title={`Probation ended ${-s.daysLeft} day${s.daysLeft === -1 ? "" : "s"} ago`}>
            Confirming now takes effect from {formatDate(confirmationEffectiveDate(p.endDate, today))}, the day after probation ended.
          </Callout>
        </div>
      ) : null}
      {p.status === "NOT_CONFIRMED" ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title="Not confirmed">
            {p.decisionNote} {e.status === "PROBATION" ? <>If {e.displayName} is leaving, <Link href="/exits">start the exit</Link>.</> : null}
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Probation">
            <KeyValue items={[
              ["Policy", p.policy.name],
              ["Started", formatDate(p.startDate)],
              ["Ends", <>{formatDate(p.endDate)}{p.extensions ? <span className="text-xs subtle"> (originally {formatDate(p.originalEndDate)})</span> : null}</>],
              ["Extensions", `${p.extensions} of ${p.policy.maxExtensions}`],
              ["Reporting manager", e.reportingManager?.displayName ?? "None — HR decides without manager feedback"],
              p.policy.completion === "AUTO_CONFIRM"
                ? ["Ends with", "Automatic confirmation the day after the end"]
                : ["Review opens", p.reviewOpenedAt ? `Opened ${formatDate(p.reviewOpenedAt)}` : formatDate(reviewOpensOn(p.startDate, p.endDate, p.policy.reviewLeadDays))],
              ...(p.decidedAt ? [["Decided", `${REC[p.decision ?? ""] ?? "—"} on ${formatDate(p.decidedAt)}${p.decidedBy ? "" : " (automatically)"}`] as [string, string]] : []),
              ...(p.confirmedOn ? [["Confirmed from", formatDate(p.confirmedOn)] as [string, string]] : []),
            ]} />
            {open ? (
              <div style={{ marginTop: 12 }}>
                <Progress value={s.progress} tone={s.stage === "OVERDUE" ? "warning" : undefined} />
                <div className="text-xs subtle" style={{ marginTop: 4 }}>{s.progress}% through · {s.daysLeft < 0 ? `${-s.daysLeft} days overdue` : `${s.daysLeft} days left`}</div>
              </div>
            ) : null}
          </Card>

          {open ? (
            <Card title="Policy" description="Moving to another policy recomputes the end date from the start, keeping any extension already granted.">
              <ChangePolicyForm probationId={p.id} policyId={p.policyId} policies={policies.map((x) => ({ value: x.id, label: x.name }))} />
            </Card>
          ) : null}
        </div>

        <div className="stack gap-4">
          {open ? (
            <Card title="Decision" description={summary.recommendation ? `The manager recommends: ${REC[summary.recommendation].toLowerCase()}.` : p.status === "IN_REVIEW" ? "Waiting for the manager's feedback; you can decide without it." : undefined}>
              {p.status === "ACTIVE" && p.policy.completion === "EVALUATION" ? (
                <div style={{ marginBottom: 14 }}>
                  <OpenReviewButton probationId={p.id} />
                </div>
              ) : null}
              <DecisionForm probationId={p.id} canExtend={canExtend} extensionDays={p.policy.extensionDays} suggested={summary.recommendation} />
              {!canExtend ? <div className="hint" style={{ marginTop: 8 }}>No extensions left under {p.policy.name}.</div> : null}
            </Card>
          ) : p.decisionNote && p.status === "CONFIRMED" ? (
            <Card title="Decision note"><p className="text-sm" style={{ margin: 0 }}>{p.decisionNote}</p></Card>
          ) : null}

          <Card title="Reviews" tight>
            {p.evaluations.length === 0 ? (
              <Empty title="No reviews yet">{p.policy.completion === "AUTO_CONFIRM" ? "This policy confirms without a review." : "The review opens before probation ends."}</Empty>
            ) : rounds.map((round) => (
              <div key={round} style={{ padding: 14, borderTop: round === rounds[0] ? undefined : "1px solid var(--border)" }}>
                {rounds.length > 1 ? <div className="text-xs subtle" style={{ marginBottom: 8 }}>Round {round}{round === p.round ? " (current)" : ""}</div> : null}
                <div className="stack gap-3">
                  {p.evaluations.filter((x) => x.round === round).map((x) => (
                    <div key={x.id}>
                      <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                        <Person size="sm" name={x.evaluator.displayName ?? ""} meta={x.role === "MANAGER" ? "Reporting manager" : "Self review"} />
                        <span className="row gap-2">
                          {x.rating ? <Badge tone="info">{x.rating}/5</Badge> : null}
                          {x.recommendation ? <Badge tone={x.recommendation === "CONFIRM" ? "success" : "warning"}>{REC[x.recommendation]}</Badge> : null}
                          <Badge tone={EV_TONE[x.status]}>{x.status.toLowerCase()}</Badge>
                        </span>
                      </div>
                      {x.status === "SUBMITTED" ? (
                        <div className="text-sm" style={{ marginTop: 6, paddingLeft: 32 }}>
                          {x.strengths ? <div><span className="subtle">Strengths: </span>{x.strengths}</div> : null}
                          {x.improvements ? <div><span className="subtle">To improve: </span>{x.improvements}</div> : null}
                          {x.comments ? <div><span className="subtle">Comments: </span>{x.comments}</div> : null}
                        </div>
                      ) : x.status === "PENDING" ? <div className="text-xs subtle" style={{ paddingLeft: 32 }}>Due {formatDate(x.dueDate)}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
