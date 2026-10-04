import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { countGroups, EEO_OPTIONS } from "@keka/services";
import { requireAuth } from "@/lib/context";
import s from "../hire.module.css";

export const metadata = { title: "Reports · Hire" };

const DAY = 86_400_000;
const RANGES = [["90", "Last 90 days"], ["180", "Last 6 months"], ["365", "Last 12 months"]] as const;
/** EEO groups smaller than this are folded together so no one can be singled out. */
const EEO_MIN_GROUP = 5;
const EEO_FIELDS = [["gender", "Gender"], ["ethnicity", "Ethnicity"], ["veteranStatus", "Veteran status"], ["disabilityStatus", "Disability"]] as const;

/**
 * Hire › Reports: the EEO report (voluntary self-identification, aggregated
 * with small groups suppressed), how active each interview panel member has
 * been, and each recruiter's pipeline.
 */
export default async function HireReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const tenantId = viewer.tenantId;
  const want = (await searchParams).days;
  const days = RANGES.some(([d]) => d === want) ? Number(want) : 180;
  const since = new Date(Date.now() - days * DAY);

  const [apps, panel, eeo] = await Promise.all([
    prisma.application.findMany({ where: { tenantId, appliedAt: { gte: since } }, select: { id: true, status: true, ownerId: true, appliedAt: true, job: { select: { recruiterId: true } }, offer: { select: { status: true } }, interviews: { select: { id: true } } } }),
    prisma.interviewPanelist.findMany({
      where: { interview: { application: { tenantId }, scheduledAt: { gte: since } } },
      select: { employeeId: true, response: true, interviewId: true, interview: { select: { status: true, scheduledAt: true, scorecards: { select: { panelistId: true, status: true, submittedAt: true } } } } },
    }),
    prisma.candidateEeo.findMany({ where: { tenantId, candidate: { applications: { some: { appliedAt: { gte: since } } } } }, select: { gender: true, ethnicity: true, veteranStatus: true, disabilityStatus: true, declined: true } }),
  ]);

  // Panel member activity.
  type PanelRow = { interviews: number; completed: number; submitted: number; pending: number; declined: number; turnaroundHours: number[] };
  const byPanelist = new Map<string, PanelRow>();
  for (const p of panel) {
    const row = byPanelist.get(p.employeeId) ?? { interviews: 0, completed: 0, submitted: 0, pending: 0, declined: 0, turnaroundHours: [] };
    row.interviews += 1;
    if (p.response === "DECLINED") row.declined += 1;
    if (p.interview.status === "COMPLETED") row.completed += 1;
    const card = p.interview.scorecards.find((c) => c.panelistId === p.employeeId && c.status === "SUBMITTED");
    if (card) {
      row.submitted += 1;
      row.turnaroundHours.push(Math.max(0, (card.submittedAt.getTime() - p.interview.scheduledAt.getTime()) / 3_600_000));
    } else if (p.interview.status === "COMPLETED" || (p.interview.status === "SCHEDULED" && p.interview.scheduledAt < new Date())) row.pending += 1;
    byPanelist.set(p.employeeId, row);
  }

  // Per recruiter: the application's owner, else the job's recruiter.
  type RecRow = { applications: number; active: number; interviewed: number; offers: number; accepted: number; hired: number; rejected: number };
  const byRecruiter = new Map<string, RecRow>();
  for (const a of apps) {
    const owner = a.ownerId ?? a.job.recruiterId ?? "unassigned";
    const row = byRecruiter.get(owner) ?? { applications: 0, active: 0, interviewed: 0, offers: 0, accepted: 0, hired: 0, rejected: 0 };
    row.applications += 1;
    if (a.status === "ACTIVE" || a.status === "ON_HOLD") row.active += 1;
    if (a.interviews.length) row.interviewed += 1;
    if (a.offer) row.offers += 1;
    if (a.status === "OFFER_ACCEPTED" || a.status === "HIRED") row.accepted += 1;
    if (a.status === "HIRED") row.hired += 1;
    if (a.status === "REJECTED") row.rejected += 1;
    byRecruiter.set(owner, row);
  }

  const people = await prisma.employee.findMany({ where: { tenantId, id: { in: [...byPanelist.keys(), ...byRecruiter.keys()] } }, select: { id: true, displayName: true, firstName: true, lastName: true } });
  const nameOf = new Map(people.map((p) => [p.id, p.displayName ?? `${p.firstName} ${p.lastName}`]));
  const answered = eeo.filter((e) => !e.declined);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

  return (
    <>
      <div className={s.head}>
        <div><h1 className={s.h1}>Hiring reports</h1><p className={s.sub}>Applications received since {since.toISOString().slice(0, 10)}.</p></div>
        <div className="row gap-2">{RANGES.map(([d, label]) => <Link key={d} className={`btn sm${Number(d) === days ? " primary" : ""}`} href={`/hiring/reports?days=${d}`}>{label}</Link>)}</div>
      </div>

      <section className={s.listCard} style={{ marginBottom: 16 }}>
        <div className={s.listHead}><span className={s.listTitle}>Recruiters</span><span className="text-xs subtle">{apps.length} applications</span></div>
        {byRecruiter.size === 0 ? <div className={s.empty}>No applications in this period.</div> : (
          <table className={s.table}>
            <thead><tr><th>Recruiter</th><th>Applications</th><th>In progress</th><th>Interviewed</th><th>Offers</th><th>Accepted</th><th>Hired</th><th>Rejected</th><th>Offer → hire</th></tr></thead>
            <tbody>
              {[...byRecruiter].sort((a, b) => b[1].applications - a[1].applications).map(([id, r]) => (
                <tr key={id} data-testid="recruiter-row">
                  <td>{id === "unassigned" ? <span className="muted">Unassigned</span> : nameOf.get(id) ?? "—"}</td>
                  <td>{r.applications}</td><td>{r.active}</td><td>{r.interviewed}</td><td>{r.offers}</td><td>{r.accepted}</td><td>{r.hired}</td><td>{r.rejected}</td><td>{pct(r.hired, r.offers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={s.listCard} style={{ marginBottom: 16 }}>
        <div className={s.listHead}><span className={s.listTitle}>Panel member activity</span><span className="text-xs subtle">{byPanelist.size} interviewers</span></div>
        {byPanelist.size === 0 ? <div className={s.empty}>No interviews in this period.</div> : (
          <table className={s.table}>
            <thead><tr><th>Interviewer</th><th>Interviews</th><th>Completed</th><th>Feedback given</th><th>Feedback overdue</th><th>Declined</th><th>Avg. hours to feedback</th></tr></thead>
            <tbody>
              {[...byPanelist].sort((a, b) => b[1].interviews - a[1].interviews).map(([id, r]) => (
                <tr key={id} data-testid="panel-row">
                  <td>{nameOf.get(id) ?? "—"}</td><td>{r.interviews}</td><td>{r.completed}</td><td>{r.submitted}</td>
                  <td className={r.pending ? "neg" : ""}>{r.pending}</td><td>{r.declined}</td><td>{avg(r.turnaroundHours) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={s.listCard}>
        <div className={s.listHead}><span className={s.listTitle}>EEO report</span><span className="text-xs subtle">{eeo.length} responses · {eeo.length - answered.length} declined</span></div>
        <div style={{ padding: "8px 18px 0" }} className="text-xs muted">Self-identification is voluntary and never shown with an application. Groups under {EEO_MIN_GROUP} are combined so no individual can be identified.</div>
        {answered.length === 0 ? <div className={s.empty}>No self-identification responses yet. Switch it on in Settings › Career site.</div> : (
          <div className="grid grid-2" style={{ padding: 18, gap: 18 }}>
            {EEO_FIELDS.map(([key, label]) => {
              const rows = countGroups(answered, (e) => e[key] ?? "Not answered", EEO_MIN_GROUP);
              return (
                <div key={key}>
                  <div className="strong text-sm" style={{ marginBottom: 6 }}>{label}</div>
                  <table className={s.table}><tbody>
                    {rows.map((r) => <tr key={r.key}><td>{r.key}</td><td style={{ width: 70 }}>{r.count}</td><td style={{ width: 70 }}>{r.percent}%</td></tr>)}
                  </tbody></table>
                  <div className="text-xs subtle" style={{ marginTop: 4 }}>Options: {EEO_OPTIONS[key].join(", ")}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
