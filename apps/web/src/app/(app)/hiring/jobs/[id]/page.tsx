import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { CandidateForm, JobStatus } from "../../forms";
import { Disclosure } from "../../../org/forms";

const DAY = 86_400_000;

export default async function JobPipeline({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const job = await prisma.job.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      flow: { include: { stages: { orderBy: { sequence: "asc" } } } },
      applications: { include: { candidate: true, stageHistory: { where: { exitedAt: null } }, interviews: { select: { status: true } } }, orderBy: { appliedAt: "asc" } },
    },
  });
  if (!job) notFound();
  const stages = job.flow?.stages ?? [];
  const active = job.applications.filter((a) => ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"].includes(a.status));
  const closed = job.applications.filter((a) => !active.includes(a));
  return (
    <>
      <PageHead title={job.title} subtitle={`${job.code} · ${job.openings} opening(s)${job.maxAnnualCtc ? ` · budget up to ${formatINR(Number(job.maxAnnualCtc))}` : ""}`}
        actions={<div className="row gap-2"><Badge tone={job.status === "OPEN" ? "success" : "neutral"}>{job.status.toLowerCase().replace("_", " ")}</Badge>{can(viewer, PERMISSIONS.JOB_MANAGE) ? <JobStatus jobId={job.id} status={job.status} /> : null}<Link className="btn" href="/hiring">All jobs</Link></div>} />
      {job.status === "OPEN" ? <Card title="Add a candidate"><Disclosure label="Add candidate"><CandidateForm jobId={job.id} /></Disclosure></Card> : null}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, stages.length)}, minmax(200px, 1fr))`, gap: 12, overflowX: "auto", marginTop: 16, paddingBottom: 6 }}>
        {stages.map((s) => {
          const here = active.filter((a) => a.currentStageId === s.id);
          return (
            <div key={s.id} className="card" style={{ minWidth: 200 }}>
              <div className="card-head"><div><div className="card-title">{s.name}</div><div className="card-desc">{here.length} candidate(s){s.requireScorecard ? " · needs feedback" : ""}</div></div></div>
              <div className="stack gap-2" style={{ padding: 10 }}>
                {here.length === 0 ? <div className="text-xs subtle" style={{ padding: 6 }}>Empty</div> : here.map((a) => {
                  const since = a.stageHistory[0]?.enteredAt ?? a.appliedAt;
                  const days = Math.floor((Date.now() - since.getTime()) / DAY);
                  const stale = s.staleAfterDays ? days > s.staleAfterDays : days > 7;
                  return (
                    <Link key={a.id} href={`/hiring/applications/${a.id}`} style={{ display: "block", border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                      <div className="strong text-sm">{a.candidate.firstName} {a.candidate.lastName}</div>
                      <div className="text-xs subtle">{a.candidate.currentTitle ?? "—"}{a.candidate.currentEmployer ? ` at ${a.candidate.currentEmployer}` : ""}</div>
                      <div className="row gap-2 wrap" style={{ marginTop: 6 }}>
                        {a.averageScore ? <Badge tone="info">{Number(a.averageScore).toFixed(1)}/5</Badge> : null}
                        {a.status !== "ACTIVE" ? <Badge tone="warning">{a.status.toLowerCase().replace(/_/g, " ")}</Badge> : null}
                        {a.candidate.source === "REFERRAL" ? <Badge>referral</Badge> : null}
                        <span className={`text-xs ${stale ? "neg" : "subtle"}`}>{days}d here</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Card tight title={`Closed applications (${closed.length})`}>
        {closed.length === 0 ? <Empty title="None" /> : (
          <div className="table-wrap"><table className="data"><tbody>
            {closed.map((a) => <tr key={a.id}><td><Link href={`/hiring/applications/${a.id}`} className="text-sm strong">{a.candidate.firstName} {a.candidate.lastName}</Link></td><td><Badge tone={a.status === "HIRED" ? "success" : "neutral"}>{a.status.toLowerCase().replace(/_/g, " ")}</Badge></td><td className="text-xs muted">{a.rejectReason ?? ""}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </>
  );
}
