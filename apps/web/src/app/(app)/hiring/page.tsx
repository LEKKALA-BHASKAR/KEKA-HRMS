import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { RequisitionForm, RequisitionDecision, OpenJob, ReferForm } from "./forms";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function HiringPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const recruiter = canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE]);
  const tabs = [...(recruiter ? ["jobs", "requisitions"] : []), "interviews", "refer"];
  const sp = await searchParams;
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : tabs[0];
  return (
    <>
      <PageHead title="Hiring" subtitle="From an approved requisition to a joiner with their onboarding already under way" />
      <div className="tabs">
        {tabs.map((t) => <Link key={t} href={`/hiring?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{{ jobs: "Jobs", requisitions: "Requisitions", interviews: "My interviews", refer: "Refer someone" }[t]}</Link>)}
      </div>
      {tab === "jobs" ? <Jobs tenantId={viewer.tenantId} /> : null}
      {tab === "requisitions" ? <Requisitions viewer={viewer} /> : null}
      {tab === "interviews" ? <Interviews employeeId={viewer.employee?.id} /> : null}
      {tab === "refer" ? <Refer viewer={viewer} /> : null}
    </>
  );
}

async function Jobs({ tenantId }: { tenantId: string }) {
  const jobs = await prisma.job.findMany({
    where: { tenantId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { applications: { select: { status: true, currentStageId: true } }, flow: { include: { stages: { orderBy: { sequence: "asc" } } } } },
  });
  const active = jobs.flatMap((j) => j.applications).filter((a) => a.status === "ACTIVE").length;
  const offers = jobs.flatMap((j) => j.applications).filter((a) => a.status === "OFFER_EXTENDED").length;
  const hired = jobs.flatMap((j) => j.applications).filter((a) => a.status === "HIRED").length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Open jobs" value={String(jobs.filter((j) => j.status === "OPEN").length)} meta={`${jobs.filter((j) => j.status === "OPEN").reduce((s, j) => s + j.openings, 0)} positions`} />
        <Stat label="In the pipeline" value={String(active)} meta="active candidates" />
        <Stat label="Offers out" value={String(offers)} meta="awaiting a reply" />
        <Stat label="Hired" value={String(hired)} meta="converted to employees" />
      </div>
      <Card tight title="Jobs">
        {jobs.length === 0 ? <Empty title="No jobs yet">Open one from an approved requisition.</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Job</th><th>Status</th><th>Pipeline</th><th className="num">Openings</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><Link href={`/hiring/jobs/${j.id}`} className="strong text-sm">{j.title}</Link><div className="text-xs subtle">{j.code} · {j.workMode.toLowerCase()} · {j.employmentType.toLowerCase().replace("_", " ")}</div></td>
                  <td><Badge tone={j.status === "OPEN" ? "success" : j.status === "FILLED" ? "info" : "neutral"}>{j.status.toLowerCase().replace("_", " ")}</Badge></td>
                  <td className="text-xs">
                    <span className="row gap-2 wrap">
                      {(j.flow?.stages ?? []).map((s) => {
                        const n = j.applications.filter((a) => a.status === "ACTIVE" && a.currentStageId === s.id).length;
                        return <span key={s.id} className={n ? "strong" : "subtle"}>{s.name} {n}</span>;
                      })}
                    </span>
                  </td>
                  <td className="num">{j.openings}</td>
                  <td className="right"><Link className="btn sm" href={`/hiring/jobs/${j.id}`}>Pipeline</Link></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Requisitions({ viewer }: { viewer: Awaited<ReturnType<typeof requireViewer>> }) {
  const [reqs, departments, locations, employees] = await Promise.all([
    prisma.requisition.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, include: { jobs: { select: { id: true, openings: true } }, replacingEmployee: { select: { displayName: true } } } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
  ]);
  const opt = (xs: Array<{ id: string; name?: string; displayName?: string | null }>) => xs.map((x) => ({ value: x.id, label: x.name ?? x.displayName ?? "" }));
  return (
    <div className="stack gap-4">
      {can(viewer, P.REQUISITION_MANAGE) ? <Card title="Raise a requisition" description="Approval fixes the budget; an offer above it needs a second approval."><Disclosure label="New requisition"><RequisitionForm departments={opt(departments)} locations={opt(locations)} employees={opt(employees)} /></Disclosure></Card> : null}
      <Card tight title="Requisitions">
        {reqs.length === 0 ? <Empty title="No requisitions yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Role</th><th>Type</th><th className="num">Positions</th><th>Budget</th><th>Status</th><th /></tr></thead>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id} style={{ verticalAlign: "top" }}>
                  <td><div className="strong text-sm">{r.title}</div><div className="text-xs subtle">{r.justification}</div></td>
                  <td className="text-sm">{r.type === "BACKFILL" ? `Backfill for ${r.replacingEmployee?.displayName ?? "—"}` : "New"}</td>
                  <td className="num">{r.positions}</td>
                  <td className="text-sm nowrap">{r.minAnnualCtc || r.maxAnnualCtc ? `${formatINR(Number(r.minAnnualCtc ?? 0))} – ${formatINR(Number(r.maxAnnualCtc ?? 0))}` : "—"}</td>
                  <td><Badge tone={r.status === "APPROVED" ? "success" : r.status === "PENDING_APPROVAL" ? "warning" : r.status === "FULFILLED" ? "info" : "neutral"}>{r.status.toLowerCase().replace(/_/g, " ")}</Badge>{r.rejectReason ? <div className="text-xs neg">{r.rejectReason}</div> : null}</td>
                  <td className="right">
                    {r.status === "PENDING_APPROVAL" && can(viewer, P.REQUISITION_APPROVE) && r.raisedBy !== viewer.user.id ? <RequisitionDecision id={r.id} /> : null}
                    {r.status === "APPROVED" && can(viewer, P.JOB_MANAGE) && r.jobs.reduce((s, j) => s + j.openings, 0) < r.positions ? <OpenJob requisitionId={r.id} managers={opt(employees)} /> : null}
                    {r.jobs.map((j) => <div key={j.id}><Link className="text-xs" href={`/hiring/jobs/${j.id}`}>View job</Link></div>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Interviews({ employeeId }: { employeeId?: string }) {
  if (!employeeId) return <Card><Empty title="No employee record" /></Card>;
  const panels = await prisma.interviewPanelist.findMany({
    where: { employeeId, interview: { status: { not: "CANCELLED" } } },
    include: { interview: { include: { scorecards: { where: { panelistId: employeeId } }, application: { include: { candidate: true, job: true } } } } },
    orderBy: { interview: { scheduledAt: "desc" } },
  });
  return (
    <Card tight title="Interviews you are on" description="Feedback opens when the interview starts; give it the same day while it is fresh.">
      {panels.length === 0 ? <Empty title="No interviews" /> : (
        <div className="table-wrap"><table className="data"><tbody>
          {panels.map((p) => {
            const iv = p.interview, done = iv.scorecards.length > 0, past = iv.scheduledAt.getTime() < Date.now();
            return (
              <tr key={p.id}>
                <td><div className="strong text-sm">{iv.application.candidate.firstName} {iv.application.candidate.lastName}</div><div className="text-xs subtle">{iv.application.job.title} · {iv.title}{p.isLead ? " · lead" : ""}</div></td>
                <td className="nowrap text-sm">{when(iv.scheduledAt)}</td>
                <td>{done ? <Badge tone="success">feedback given</Badge> : past ? <Badge tone="warning">feedback due</Badge> : <Badge>upcoming</Badge>}</td>
                <td className="right"><Link className={`btn sm${!done && past ? " primary" : ""}`} href={`/hiring/applications/${iv.applicationId}`}>{!done && past ? "Give feedback" : "Open"}</Link></td>
              </tr>
            );
          })}
        </tbody></table></div>
      )}
    </Card>
  );
}

async function Refer({ viewer }: { viewer: Awaited<ReturnType<typeof requireViewer>> }) {
  const [jobs, mine] = await Promise.all([
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN", allowReferral: true }, orderBy: { title: "asc" } }),
    viewer.employee ? prisma.candidate.findMany({ where: { referredById: viewer.employee.id }, include: { applications: { include: { job: { select: { title: true } } } } }, orderBy: { createdAt: "desc" } }) : [],
  ]);
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Refer someone" description="They go straight into the pipeline with you credited as the referrer.">
        {jobs.length === 0 ? <Empty title="No open jobs right now" /> : <ReferForm jobs={jobs.map((j) => ({ value: j.id, label: `${j.title} (${j.code})` }))} />}
      </Card>
      <Card tight title="Your referrals">
        {mine.length === 0 ? <Empty title="No referrals yet" /> : (
          <div className="table-wrap"><table className="data"><tbody>
            {mine.flatMap((c) => c.applications.map((a) => (
              <tr key={a.id}><td><Person name={`${c.firstName} ${c.lastName}`} meta={a.job.title} /></td><td><Badge tone={a.status === "HIRED" ? "success" : a.status === "REJECTED" ? "neutral" : "info"}>{a.status.toLowerCase().replace(/_/g, " ")}</Badge></td><td className="text-xs subtle">{formatDate(a.appliedAt)}</td></tr>
            )))}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
