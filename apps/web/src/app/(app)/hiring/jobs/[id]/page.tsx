import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { kitOf } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { Disclosure } from "../../../org/forms";
import { CandidateForm, JobStatus } from "../../forms";
import { JobDetailsForm, KitEditor } from "../../_parts/job-forms";
import { QuestionsButton, type QSection } from "../../_parts/questions";
import { Markdown } from "../../_parts/markdown";
import { rupees } from "../../_lib/data";
import s from "../../hire.module.css";

const DAY = 86_400_000;
const TABS = [["pipeline", "Pipeline"], ["details", "Job Details"], ["scorecard", "Scorecard"]] as const;
const JOB_INCLUDE = {
  flow: { include: { stages: { orderBy: { sequence: "asc" } } } },
  requisition: { select: { id: true, code: true } },
  applications: { include: { candidate: true, stageHistory: { where: { exitedAt: null } } }, orderBy: { appliedAt: "asc" } },
  questionSets: { orderBy: [{ section: "asc" }, { attempt: "asc" }] },
} satisfies Prisma.JobInclude;
type JobFull = Prisma.JobGetPayload<{ include: typeof JOB_INCLUDE }>;

/** One job: its candidates by stage, its description, and the scorecard interviewers use. */
export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const tab = (await searchParams).tab ?? "pipeline";
  const job = await prisma.job.findFirst({
    where: { id, tenantId: viewer.tenantId }, include: JOB_INCLUDE,
  });
  if (!job) notFound();
  const manage = can(viewer, PERMISSIONS.JOB_MANAGE);
  return (
    <>
      <div className={s.head}>
        <div>
          <div className={s.crumbs}><Link href="/hiring/jobs">Jobs</Link><span className="subtle">›</span><span className={s.crumbStage}>{job.code}</span></div>
          <h1 className={s.h1} style={{ marginTop: 6 }}>{job.title}</h1>
          <p className={s.sub}>{job.openings} opening{job.openings === 1 ? "" : "s"}{job.maxAnnualCtc ? ` · budget up to ${rupees(job.maxAnnualCtc)}` : ""}{job.requisition ? <> · from <Link className={s.reqLink} href={`/hiring/requisitions?req=${job.requisition.id}`}>{job.requisition.code}</Link></> : null}</p>
        </div>
        <div className={s.headActions}>
          <span className={`${s.statusChip} ${job.status === "OPEN" ? s.good : ""}`}>{job.status.toLowerCase().replace("_", " ")}</span>
          {manage ? <JobStatus jobId={job.id} status={job.status} /> : null}
        </div>
      </div>
      <nav className={s.candTabs} style={{ padding: 0 }}>
        {TABS.map(([k, label]) => <Link key={k} href={`/hiring/jobs/${job.id}?tab=${k}`} className={`${s.candTab}${tab === k ? ` ${s.active}` : ""}`}>{label}</Link>)}
      </nav>
      {tab === "details" ? <Details job={job} manage={manage} /> : tab === "scorecard" ? <Scorecard job={job} manage={manage} /> : <Pipeline job={job} />}
    </>
  );
}

function Pipeline({ job }: { job: JobFull }) {
  const stages = job.flow?.stages ?? [];
  const active = job.applications.filter((a) => ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"].includes(a.status));
  const closed = job.applications.filter((a) => !active.includes(a));
  return (
    <>
      {job.status === "OPEN" ? <div className={s.cardAlone} style={{ padding: 16, marginBottom: 16 }}><Disclosure label="Add candidate"><CandidateForm jobId={job.id} /></Disclosure></div> : null}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, stages.length)}, minmax(210px, 1fr))`, gap: 12, overflowX: "auto", paddingBottom: 6 }}>
        {stages.map((st) => {
          const here = active.filter((a) => a.currentStageId === st.id);
          return (
            <div key={st.id} className={s.cardAlone} style={{ minWidth: 210 }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{st.name}</div>
                <div className="text-xs subtle">{here.length} candidate{here.length === 1 ? "" : "s"}{st.requireScorecard ? " · needs feedback" : ""}</div>
              </div>
              <div className="stack gap-2" style={{ padding: 10 }}>
                {here.length === 0 ? <div className="text-xs subtle" style={{ padding: 6 }}>Empty</div> : here.map((a) => {
                  const since = a.stageHistory[0]?.enteredAt ?? a.appliedAt;
                  const days = Math.floor((Date.now() - since.getTime()) / DAY);
                  const stale = st.staleAfterDays ? days > st.staleAfterDays : days > 7;
                  return (
                    <Link key={a.id} href={`/hiring/applications/${a.id}`} style={{ display: "block", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
                      <div style={{ fontSize: 14, color: "var(--brand-600)" }}>{a.candidate.firstName} {a.candidate.lastName}</div>
                      <div className="text-xs subtle">{a.candidate.currentTitle ?? "—"}{a.candidate.currentEmployer ? ` at ${a.candidate.currentEmployer}` : ""}</div>
                      <div className="row gap-2 wrap" style={{ marginTop: 6 }}>
                        {a.averageScore ? <span className={`${s.statusChip} ${s.info}`}>{Number(a.averageScore).toFixed(1)}/5</span> : null}
                        {a.status !== "ACTIVE" ? <span className={`${s.statusChip} ${s.warn}`}>{a.status.toLowerCase().replace(/_/g, " ")}</span> : null}
                        {a.candidate.source === "REFERRAL" ? <span className={s.statusChip}>referral</span> : null}
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
      <div className={s.listCard} style={{ marginTop: 18 }}>
        <div className={s.listHead}><span className={s.listTitle}>Archived candidates ({closed.length})</span></div>
        {closed.length === 0 ? <div className={s.empty}>None</div> : (
          <table className={s.table}><tbody>
            {closed.map((a) => <tr key={a.id}><td><Link className={s.reqLink} href={`/hiring/applications/${a.id}`}>{a.candidate.firstName} {a.candidate.lastName}</Link></td><td><span className={`${s.statusChip} ${a.status === "HIRED" ? s.good : ""}`}>{a.status.toLowerCase().replace(/_/g, " ")}</span></td><td className="text-xs muted">{a.rejectReason ?? ""}</td></tr>)}
          </tbody></table>
        )}
      </div>
    </>
  );
}

function Details({ job, manage }: { job: JobFull; manage: boolean }) {
  return (
    <div className={s.cardAlone} style={{ padding: 22 }}>
      {manage ? (
        <JobDetailsForm jobId={job.id} title={job.title} departmentId={job.departmentId} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE}
          initial={{ description: job.description ?? "", requirements: job.requirements ?? "", minExperienceYears: job.minExperienceYears === null ? "" : String(Number(job.minExperienceYears)), employmentType: job.employmentType }} />
      ) : (
        <>
          <div className={s.blockLabel} style={{ marginTop: 0 }}>Job Description</div>
          <Markdown text={job.description} className={s.markdown} />
          {job.requirements ? <><div className={s.blockLabel}>Requirements</div><Markdown text={job.requirements} className={s.markdown} /></> : null}
        </>
      )}
    </div>
  );
}

async function Scorecard({ job, manage }: { job: JobFull; manage: boolean }) {
  const kit = kitOf(job.scorecardTemplate);
  const setting = await prisma.hiringSetting.findUnique({ where: { tenantId: job.tenantId }, select: { aiQuestionAttempts: true } });
  const max = setting?.aiQuestionAttempts ?? 2;
  const sections: QSection[] = kit.map((k) => ({
    section: k.section, skills: k.skills.map((x) => ({ name: x.name, description: x.description ?? null })),
    sets: job.questionSets.filter((q) => q.section === k.section).map((q) => ({ attempt: q.attempt, questions: q.questions as QSection["sets"][number]["questions"] })),
  }));
  return (
    <div className={s.settingsGrid}>
      <div className={s.listCard}>
        <div className={s.listHead}>
          <span className={s.listTitle}>Interview kit</span>
          <span className="text-xs subtle">{job.scorecardTemplate ? "Set for this job" : "Default scorecard"}</span>
        </div>
        {sections.map((sec) => (
          <div key={sec.section} style={{ padding: "14px 18px", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".03em" }}>{sec.section} <span className="subtle" style={{ textTransform: "none", fontWeight: 400 }}>({sec.skills.length})</span></div>
              <QuestionsButton jobId={job.id} section={sec} max={max} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} round={false} />
            </div>
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
              {sec.skills.map((k) => <li key={k.name}><strong style={{ fontWeight: 550 }}>{k.name}</strong>{k.description ? <span className="muted"> — {k.description}</span> : null}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {manage ? (
        <div className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Edit scorecard</span></div>
          <div style={{ padding: 16 }}>
            <KitEditor jobId={job.id} initial={kit.map((k) => ({ section: k.section, skills: k.skills.map((x) => ({ name: x.name, description: x.description ?? "" })) }))} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
