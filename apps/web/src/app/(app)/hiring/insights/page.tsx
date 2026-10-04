import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { PageHead, Card, Badge, Stat, Empty } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { balanceWorkloadAction } from "@/app/actions/hire-ops";
import { requireAnyOf } from "@/lib/hire-depth";
import { sourceInsights, workloadInsights, offerInsights, calibrationInsights, stageInsights, visitInsights, timeToHire, talentMap, interviewsByRole, HIRE_REPORTS } from "@/lib/hire-insights";
import { inr } from "../_parts/depth-tabs";

export const metadata = { title: "Hiring insights · Hire" };

/**
 * Hire › Insights: which sources bring hires and at what cost (against the
 * company-wide benchmark), how candidates convert stage by stage, how work
 * is spread between recruiters, how fast offers move, how interviewers
 * score against their panels, and where careers-site visitors come from.
 */
export default async function HiringInsightsPage({ searchParams }: { searchParams: Promise<{ days?: string; job?: string; value?: string }> }) {
  const viewer = await requireAnyOf([PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE]);
  const sp = await searchParams;
  const days = Math.min(730, Math.max(7, Number(sp.days ?? 180) || 180));
  const value = Math.max(0, Number(sp.value ?? 0) || 0);
  const since = new Date(Date.now() - days * 86_400_000);
  const t = viewer.tenantId;
  const jobs = await prisma.job.findMany({ where: { tenantId: t, status: { in: ["OPEN", "ON_HOLD", "FILLED"] } }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 100 });
  const jobId = sp.job && jobs.some((j) => j.id === sp.job) ? sp.job : jobs[0]?.id;
  const [sources, workload, offers, cal, stages, visits, tth, map, byRole] = await Promise.all([
    sourceInsights(t, since, value), workloadInsights(t), offerInsights(t, since), calibrationInsights(t, since), jobId ? stageInsights(t, jobId) : Promise.resolve([]), visitInsights(t, since), timeToHire(t, since),
    talentMap(t), interviewsByRole(t, since),
  ]);
  return (
    <>
      <PageHead title="Hiring insights" subtitle={`The last ${days} days.`} actions={
        <form className="row gap-2">
          <select className="input" name="days" defaultValue={String(days)} aria-label="Period">{[30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>
          <input className="input" name="value" type="number" defaultValue={value || ""} placeholder="Value of a hire (₹) for ROI" aria-label="Value of a hire" style={{ width: 200 }} />
          <button className="btn">Apply</button>
        </form>
      } />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Median days to hire" value={tth ?? "—"} />
        <Stat label="Offer acceptance" value={offers.acceptanceRate === null ? "—" : `${offers.acceptanceRate}%`} meta={`${offers.accepted} accepted · ${offers.declined} declined`} />
        <Stat label="Median offer cycle" value={offers.medianTotal === null ? "—" : `${offers.medianTotal} days`} meta={`approve ${offers.medianToApprove ?? "—"} · extend ${offers.medianToExtend ?? "—"} · answer ${offers.medianToRespond ?? "—"}`} />
        <Stat label="Careers site visits" value={visits.total} meta={`${visits.jobViews} job views`} />
      </div>
      <Card title="Source quality, benchmark and ROI" description={`Company hire rate ${sources.benchmarkHireRate}%. Quality blends hire rate, interview rate and interview scores.`} tight action={<a className="btn sm" href={`/hiring/insights/export?kind=sources&days=${days}`}>CSV</a>}>
        {sources.rows.length === 0 ? <Empty title="No applicants in this period" /> : (
          <div className="table-wrap"><table className="data" data-testid="source-table">
            <thead><tr><th>Source</th><th>Applicants</th><th>Interviewed</th><th>Offered</th><th>Hired</th><th>Hire rate</th><th>vs benchmark</th><th>Quality</th><th>Cost</th><th>Cost / hire</th>{value ? <th>ROI</th> : null}</tr></thead>
            <tbody>{sources.rows.map((r) => (
              <tr key={r.key}><td>{r.label}</td><td>{r.applicants}</td><td>{r.interviewed}</td><td>{r.offered}</td><td>{r.hired}</td><td>{r.hireRate}%</td>
                <td><Badge tone={r.vsBenchmark > 0 ? "success" : r.vsBenchmark < 0 ? "danger" : "neutral"}>{r.vsBenchmark > 0 ? "+" : ""}{r.vsBenchmark}</Badge></td>
                <td>{r.quality}</td><td>{inr(r.cost)}</td><td>{r.costPerHire === null ? "—" : inr(r.costPerHire)}</td>{value ? <td>{r.roi === null ? "—" : `${r.roi}%`}</td> : null}</tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start", marginTop: 16 }}>
        <Card title="Stage conversion" tight action={<form className="row gap-1"><input type="hidden" name="days" value={days} /><select className="input" name="job" defaultValue={jobId} aria-label="Job">{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select><button className="btn sm">Show</button></form>}>
          {stages.length === 0 ? <Empty title="No pipeline yet" /> : (
            <table className="data" data-testid="stage-table"><thead><tr><th>Stage</th><th>Entered</th><th>Moved on</th><th>Conversion</th><th>Avg days</th></tr></thead>
              <tbody>{stages.map((s) => <tr key={s.stageId}><td>{s.name}</td><td>{s.entered}</td><td>{s.advanced}</td><td>{s.conversion}%</td><td>{s.avgDays ?? "—"}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Recruiter workload" tight action={<><a className="btn sm" href="/hiring/insights/export?kind=workload">CSV</a> <ActButton action={balanceWorkloadAction} hidden={{}} label="Balance open applications" confirmText="Reassign open applications so every recruiter has a fair share?" /></>}>
          {workload.length === 0 ? <Empty title="No open work" /> : (
            <table className="data" data-testid="workload-table"><thead><tr><th>Recruiter</th><th>Open applications</th><th>Open tasks</th></tr></thead>
              <tbody>{workload.map((w) => <tr key={w.userId ?? "none"}><td>{w.name}</td><td>{w.openApplications}</td><td>{w.openTasks}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Interviewer calibration" description="How each interviewer scores against the rest of the same panels." tight action={<a className="btn sm" href={`/hiring/insights/export?kind=calibration&days=${days}`}>CSV</a>}>
          {cal.length === 0 ? <Empty title="No submitted feedback" /> : (
            <table className="data" data-testid="calibration-table"><thead><tr><th>Interviewer</th><th>Cards</th><th>Mean</th><th>vs panel</th><th>Hire %</th><th /></tr></thead>
              <tbody>{cal.map((c) => <tr key={c.panelistId}><td>{c.name}</td><td>{c.count}</td><td>{c.mean ?? "—"}</td><td>{c.delta ?? "—"}</td><td>{c.hireRate}%</td><td><Badge tone={c.label === "Calibrated" ? "success" : c.label === "No peers to compare" ? "neutral" : "warning"}>{c.label}</Badge></td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Careers site traffic" tight action={<a className="btn sm" href={`/hiring/insights/export?kind=visits&days=${days}`}>CSV</a>}>
          <table className="data"><thead><tr><th>Source or referrer</th><th>Visits</th></tr></thead><tbody>{visits.bySource.map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
          <table className="data"><thead><tr><th>Campaign</th><th>Visits</th></tr></thead><tbody>{visits.byCampaign.map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
        </Card>
      </div>
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start", marginTop: 16 }}>
        <Card title="Talent map by location" description="Where the candidate database lives, and who in it is active, passive or high-potential." tight action={<a className="btn sm" href="/hiring/insights/export?kind=locations">CSV</a>}>
          {map.length === 0 ? <Empty title="No candidates yet" /> : (
            <table className="data" data-testid="talent-map"><thead><tr><th>City</th><th>Candidates</th><th>Active</th><th>Passive</th><th>High potential</th><th>Top skills</th></tr></thead>
              <tbody>{map.slice(0, 25).map((r) => <tr key={r.city}><td><Link href={`/hiring/candidates?q=${encodeURIComponent(r.city === "Unknown" ? "" : r.city)}`}>{r.city}</Link></td><td>{r.candidates}</td><td>{r.active}</td><td>{r.passive}</td><td>{r.highPotential}</td><td className="text-xs">{r.topSkills.join(", ") || "—"}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Interviews by role" description="Volume, no-shows, scores and hire recommendations for each job's interviews." tight action={<a className="btn sm" href={`/hiring/insights/export?kind=interviews&days=${days}`}>CSV</a>}>
          {byRole.length === 0 ? <Empty title="No interviews in this period" /> : (
            <table className="data" data-testid="interviews-by-role"><thead><tr><th>Role</th><th>Interviews</th><th>Done</th><th>No-show %</th><th>Avg score</th><th>Hire %</th></tr></thead>
              <tbody>{byRole.map((r) => <tr key={r.jobId}><td>{r.role}</td><td>{r.interviews}</td><td>{r.completed}</td><td>{r.noShowRate}%</td><td>{r.avgScore ?? "—"}</td><td>{r.hireRate === null ? "—" : `${r.hireRate}%`}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <Card title="Reports" description="Download any of these as CSV; each download is recorded in the audit log.">
        <div className="row gap-2 wrap">{Object.entries(HIRE_REPORTS).map(([k, label]) => <a key={k} className="btn sm" href={`/hiring/insights/export?kind=${k}&days=${days}`}>{label}</a>)}</div>
        <p className="text-xs subtle" style={{ marginTop: 8 }}>Offers revised in this period: {offers.revised}. See <Link href="/hiring/exceptions">exceptions</Link> for SLA breaches.</p>
      </Card>
    </>
  );
}
