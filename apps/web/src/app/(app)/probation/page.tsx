import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { probationStage, probationReviewSummary, type ProbationStage } from "@keka/services";
import { STAGE, REC } from "./_lib";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress, Callout } from "@/components/ui";
import { Disclosure } from "../org/forms";
import { PolicyForm, StartProbationButton } from "./forms";

const P = PERMISSIONS;

export default async function ProbationPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const { view: raw } = await searchParams;
  const view = raw === "decided" || raw === "policies" ? raw : "open";
  const scope = { ...scopedEmployeeWhere(viewer, P.PROBATION_MANAGE), NOT: viewer.employee ? { id: viewer.employee.id } : undefined };
  const today = new Date();

  const [probations, untracked, policies] = await Promise.all([
    prisma.employeeProbation.findMany({
      where: { tenantId: viewer.tenantId, employee: scope, status: view === "decided" ? { in: ["CONFIRMED", "NOT_CONFIRMED"] } : { in: ["ACTIVE", "IN_REVIEW"] } },
      include: {
        policy: { select: { name: true, reviewLeadDays: true, maxExtensions: true } },
        employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } }, reportingManager: { select: { displayName: true } } } },
        evaluations: { select: { round: true, role: true, status: true, rating: true, recommendation: true } },
      },
      orderBy: view === "decided" ? { decidedAt: "desc" } : { endDate: "asc" },
      take: 500,
    }),
    prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, ...scope, status: "PROBATION", probation: null },
      select: { id: true, displayName: true, employeeNumber: true, dateOfJoining: true, department: { select: { name: true } } },
      orderBy: { dateOfJoining: "asc" },
    }),
    prisma.probationPolicy.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { probations: { where: { status: { in: ["ACTIVE", "IN_REVIEW"] } } } } } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
  ]);

  const rows = probations.map((p) => ({ p, s: probationStage(p, p.policy.reviewLeadDays, today), r: probationReviewSummary(p.evaluations.filter((e) => e.round === p.round)) }));
  const count = (st: ProbationStage) => rows.filter((x) => x.s.stage === st).length;
  const endingSoon = rows.filter((x) => x.s.daysLeft >= 0 && x.s.daysLeft <= 30).length;
  const policyOptions = policies.filter((x) => x.isActive).map((x) => ({ value: x.id, label: x.name }));

  return (
    <>
      <PageHead title="Probation" subtitle="Probation periods, reviews and confirmation" />

      {view === "open" ? (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="On probation" value={String(rows.length)} meta={`${count("ON_TRACK")} on track`} />
          <Stat label="Ending in 30 days" value={String(endingSoon)} meta="confirm, extend or decide" />
          <Stat label="In review" value={String(count("IN_REVIEW"))} meta={`${rows.filter((x) => x.p.status === "IN_REVIEW" && x.r.managerDone).length} with manager feedback`} />
          <Stat label="Overdue" value={String(count("OVERDUE"))} meta="past the end, undecided" tone={count("OVERDUE") ? "neg" : undefined} />
        </div>
      ) : null}

      <div className="tabs">
        <Link href="/probation" className={`tab${view === "open" ? " active" : ""}`}>On probation</Link>
        <Link href="/probation?view=decided" className={`tab${view === "decided" ? " active" : ""}`}>Decided</Link>
        <Link href="/probation?view=policies" className={`tab${view === "policies" ? " active" : ""}`}>Policies</Link>
      </div>

      {view === "policies" ? (
        <>
          <Card title="New policy" description="Policies set how long probation runs, how it ends and how often it can be extended.">
            <Disclosure label="Add policy"><PolicyForm /></Disclosure>
          </Card>
          <div style={{ height: 16 }} />
          {policies.length === 0 ? <Card><Empty title="No probation policies yet" /></Card> : policies.map((x) => (
            <div key={x.id} style={{ marginBottom: 16 }}>
              <Card
                title={<span className="row gap-2">{x.name}{x.isDefault ? <Badge tone="brand">Default</Badge> : null}{x.isActive ? null : <Badge>Inactive</Badge>}</span>}
                description={`${x.durationDays} days · ${x.completion === "AUTO_CONFIRM" ? "confirms automatically" : `review opens ${x.reviewLeadDays} days before the end`} · ${x.maxExtensions === 0 ? "no extensions" : `up to ${x.maxExtensions} extension${x.maxExtensions === 1 ? "" : "s"} of ${x.extensionDays} days`} · ${x._count.probations} on it now`}>
                {x.description ? <p className="text-sm muted" style={{ marginTop: 0 }}>{x.description}</p> : null}
                <Disclosure label="Edit" variant="default">
                  <PolicyForm policy={{ ...x }} />
                </Disclosure>
              </Card>
            </div>
          ))}
        </>
      ) : (
        <>
          {view === "open" && untracked.length > 0 ? (
            <div style={{ marginBottom: 16 }}>
              <Callout tone="warning" title={`${untracked.length} employee${untracked.length === 1 ? " is" : "s are"} on probation with no probation period`}>
                Start one to track the end date and open the review. The nightly job starts these under the default policy.
                <div className="stack gap-2" style={{ marginTop: 10 }}>
                  {untracked.map((e) => (
                    <div key={e.id} className="row gap-3 wrap" style={{ justifyContent: "space-between" }}>
                      <Person name={e.displayName ?? ""} meta={`${e.employeeNumber} · joined ${formatDate(e.dateOfJoining)}`} size="sm" />
                      <StartProbationButton employeeId={e.id} policies={policyOptions} />
                    </div>
                  ))}
                </div>
              </Callout>
            </div>
          ) : null}
          <Card tight>
            {rows.length === 0 ? <Empty title={view === "open" ? "Nobody is on probation" : "No decided probations"} /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th><th>Policy</th><th>Started</th><th>{view === "open" ? "Ends" : "Decided"}</th>
                      {view === "open" ? <th style={{ width: 150 }}>Progress</th> : null}
                      <th>Status</th><th>Manager says</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ p, s, r }) => (
                      <tr key={p.id}>
                        <td><Person name={p.employee.displayName ?? ""} meta={[p.employee.employeeNumber, p.employee.jobTitleName, p.employee.department?.name].filter(Boolean).join(" · ")} /></td>
                        <td className="text-sm">{p.policy.name}{p.extensions ? <div className="text-xs subtle">extended {p.extensions}×</div> : null}</td>
                        <td className="nowrap text-sm">{formatDate(p.startDate)}</td>
                        <td className="nowrap text-sm">
                          {view === "open" ? (
                            <>
                              {formatDate(p.endDate)}
                              <div className="text-xs" style={{ color: s.daysLeft < 0 ? "var(--danger)" : undefined }}>
                                {s.daysLeft < 0 ? `${-s.daysLeft}d overdue` : s.daysLeft === 0 ? "ends today" : `${s.daysLeft}d left`}
                              </div>
                            </>
                          ) : p.decidedAt ? formatDate(p.decidedAt) : "—"}
                        </td>
                        {view === "open" ? (
                          <td><Progress value={s.progress} tone={s.stage === "OVERDUE" ? "warning" : undefined} /><div className="text-xs subtle" style={{ marginTop: 3 }}>{s.progress}%</div></td>
                        ) : null}
                        <td><Badge tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Badge></td>
                        <td className="text-sm">
                          {view === "decided"
                            ? (p.confirmedOn ? <>from {formatDate(p.confirmedOn)}</> : <span className="subtle">—</span>)
                            : r.recommendation ? <>{REC[r.recommendation]}{r.averageRating ? <div className="text-xs subtle">rated {r.averageRating}/5</div> : null}</>
                            : p.status === "IN_REVIEW" ? <span className="subtle">awaiting {p.employee.reportingManager?.displayName ?? "feedback"}</span>
                            : <span className="subtle">—</span>}
                        </td>
                        <td className="right"><Link className="btn sm" href={`/probation/${p.id}`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
