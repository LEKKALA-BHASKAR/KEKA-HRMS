import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hiringFunnel, sourceEffectiveness, timeToHire, offerAcceptance, lastMonths, type FunnelApp } from "@keka/services";
import { requireAuth, canAny } from "@/lib/context";
import { Stat } from "@/components/ui";
import { Panel, Bars, EmptyState } from "@/components/keka";
import { HBars } from "@/components/charts";
import { DashboardTabs } from "../_components/dashboard";

export const metadata = { title: "Hiring dashboard — Analytics" };
const P = PERMISSIONS;
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Org › Dashboard › Hiring: pipeline, funnel, sources, speed and offers over a window. */
export default async function HiringDashboard({ searchParams }: { searchParams: Promise<{ months?: string; job?: string }> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  if (!canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE])) forbidden();
  const sp = await searchParams;
  const months = [3, 6, 12].includes(Number(sp.months)) ? Number(sp.months) : 6;
  const today = new Date();
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
  const jobs = await prisma.job.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true, status: true, openings: true, flowId: true }, orderBy: { title: "asc" } });
  const job = jobs.find((j) => j.id === sp.job) ?? null;
  const apps = await prisma.application.findMany({
    where: { tenantId: viewer.tenantId, appliedAt: { gte: since }, ...(job ? { jobId: job.id } : {}) },
    select: {
      status: true, appliedAt: true, updatedAt: true, jobId: true, candidate: { select: { source: true } },
      stageHistory: { select: { enteredAt: true, stage: { select: { sequence: true, stageKind: true } } } },
      offer: { select: { status: true, respondedAt: true } },
    },
  });
  const rows: FunnelApp[] = apps.map((a) => ({
    status: a.status, source: titleCase(a.candidate.source), appliedAt: a.appliedAt,
    furthestSequence: a.stageHistory.length ? Math.max(...a.stageHistory.map((h) => h.stage.sequence)) : null,
    hiredAt: a.status === "HIRED" || a.status === "OFFER_ACCEPTED" ? a.offer?.respondedAt ?? a.updatedAt : null,
  }));
  // The funnel follows one flow: the chosen job's, or the one most applications used.
  const flowCounts = new Map<string, number>();
  for (const a of apps) { const f = jobs.find((j) => j.id === a.jobId)?.flowId; if (f) flowCounts.set(f, (flowCounts.get(f) ?? 0) + 1); }
  const flowId = job?.flowId ?? [...flowCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const stages = flowId ? await prisma.hiringStage.findMany({ where: { flowId }, select: { sequence: true, name: true }, orderBy: { sequence: "asc" } }) : [];
  const flowApps = flowId ? rows.filter((_, i) => jobs.find((j) => j.id === apps[i]!.jobId)?.flowId === flowId) : [];
  const funnel = hiringFunnel(flowApps, stages);
  const sources = sourceEffectiveness(rows);
  const tth = timeToHire(rows);
  const acceptance = offerAcceptance(apps.map((a) => a.offer?.status).filter((s): s is NonNullable<typeof s> => !!s));
  const hires = rows.filter((r) => r.hiredAt).length;
  const openJobs = jobs.filter((j) => j.status === "OPEN");
  const openings = openJobs.reduce((s, j) => s + j.openings, 0);
  const monthly = lastMonths(today, months).map((m) => ({ label: m.label, value: apps.filter((a) => a.appliedAt.toISOString().slice(0, 7) === m.key).length }));
  const hiresMonthly = lastMonths(today, months).map((m) => ({ label: m.label, value: rows.filter((r) => r.hiredAt && r.hiredAt.toISOString().slice(0, 7) === m.key).length }));
  const rejected = apps.filter((a) => a.status === "REJECTED" || a.status === "WITHDRAWN").length;

  return (
    <>
      <DashboardTabs viewer={viewer} active="hiring" />
      <div className="page-head">
        <div className="page-title-group"><h1>Hiring dashboard</h1><div className="page-subtitle">Applications received in the last {months} months{job ? ` for ${job.title}` : ", every job"}</div></div>
        <form className="row gap-2 no-print">
          <select name="job" className="select" defaultValue={job?.id ?? ""} aria-label="Job"><option value="">All jobs</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>
          <select name="months" className="select" defaultValue={String(months)} aria-label="Window">{[3, 6, 12].map((m) => <option key={m} value={m}>Last {m} months</option>)}</select>
          <button className="btn">Apply</button>
        </form>
      </div>
      {apps.length === 0 && openJobs.length === 0 ? <EmptyState title="No hiring activity in this window" /> : (
        <div className="stack gap-3">
          <div className="grid grid-4">
            <Stat label="Open positions" value={openings} meta={`${openJobs.length} open job${openJobs.length === 1 ? "" : "s"}`} />
            <Stat label="Applications" value={apps.length} meta={`${apps.filter((a) => a.status === "ACTIVE" || a.status === "ON_HOLD").length} still in progress · ${rejected} closed`} />
            <Stat label="Hires" value={hires} meta={tth === null ? "No hires yet" : `Median ${tth} days from application`} />
            <Stat label="Offer acceptance" value={acceptance === null ? "—" : `${acceptance}%`} meta={`${apps.filter((a) => a.offer).length} offers made`} />
          </div>
          <div className="grid grid-2">
            <Panel title="Pipeline funnel" subtitle={stages.length ? "Applications that reached each stage, and the share that moved on" : "No hiring flow in use"}>
              {funnel.length ? (
                <div className="stack gap-2">
                  <HBars rows={funnel.map((f) => ({ label: f.label, value: f.value, note: f.conversion === null ? undefined : `${f.conversion}%` }))} color="#5bc0d0" />
                </div>
              ) : <EmptyState title="Nothing to show" />}
            </Panel>
            <Panel title="Source effectiveness" subtitle="Applications and hires by where candidates came from">
              {sources.length ? (
                <table className="data">
                  <thead><tr><th>Source</th><th className="num">Applications</th><th className="num">Hires</th><th className="num">Hire rate</th></tr></thead>
                  <tbody>{sources.map((s) => <tr key={s.source}><td>{s.source}</td><td className="num">{s.applications}</td><td className="num">{s.hires}</td><td className="num">{s.rate}%</td></tr>)}</tbody>
                </table>
              ) : <EmptyState title="No applications" />}
            </Panel>
            <Panel title="Applications per month"><Bars data={monthly} height={120} /></Panel>
            <Panel title="Hires per month"><Bars data={hiresMonthly} height={120} colour="#7cc47f" /></Panel>
          </div>
          <Panel title="Open jobs" pad={false}>
            {openJobs.length ? (
              <table className="data">
                <thead><tr><th>Job</th><th className="num">Openings</th><th className="num">Applications</th><th className="num">In progress</th><th className="num">Hired</th></tr></thead>
                <tbody>{openJobs.map((j) => {
                  const ja = apps.filter((a) => a.jobId === j.id);
                  return <tr key={j.id}><td><Link href={`/hiring/jobs/${j.id}`}>{j.title}</Link></td><td className="num">{j.openings}</td><td className="num">{ja.length}</td><td className="num">{ja.filter((a) => a.status === "ACTIVE" || a.status === "ON_HOLD").length}</td><td className="num">{ja.filter((a) => a.status === "HIRED" || a.status === "OFFER_ACCEPTED").length}</td></tr>;
                })}</tbody>
              </table>
            ) : <EmptyState title="No open jobs" />}
          </Panel>
        </div>
      )}
    </>
  );
}
