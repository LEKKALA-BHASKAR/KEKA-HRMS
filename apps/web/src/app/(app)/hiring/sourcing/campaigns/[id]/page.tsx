import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { PageHead, Card, Badge, Stat, KeyValue } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveCampaignAction, submitCampaignAction, campaignStatusAction } from "@/app/actions/hire-sourcing";
import { requireAnyOf } from "@/lib/hire-depth";
import { SourcingTabs, day, inr, pretty } from "../../../_parts/depth-tabs";

export const metadata = { title: "Campaign · Hire" };

/** One sourcing campaign: its funnel (visits → applicants → interviews → offers → hires), cost per hire, and settings. */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAnyOf([PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE]);
  const { id } = await params;
  const c = await prisma.sourcingCampaign.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { channel: true } });
  if (!c) notFound();
  const [visits, profiles, channels, jobs] = await Promise.all([
    prisma.careerSiteVisit.count({ where: { tenantId: viewer.tenantId, campaignCode: c.code } }),
    prisma.candidateSourcingProfile.findMany({ where: { tenantId: viewer.tenantId, campaignId: c.id }, select: { candidateId: true } }),
    prisma.sourcingChannel.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN" }, select: { id: true, title: true } }),
  ]);
  const apps = await prisma.application.findMany({ where: { tenantId: viewer.tenantId, candidateId: { in: profiles.map((p) => p.candidateId) } }, include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } }, _count: { select: { interviews: true } }, offer: { select: { status: true } } } });
  const interviewed = apps.filter((a) => a._count.interviews > 0).length, offered = apps.filter((a) => a.offer).length, hired = apps.filter((a) => a.status === "HIRED").length;
  const budget = c.budget === null ? null : Number(c.budget);
  const editable = ["DRAFT", "PAUSED", "REJECTED"].includes(c.status);
  return (
    <>
      <SourcingTabs />
      <PageHead title={c.name} subtitle={`${c.code} · ${pretty(c.status)}${c.channel ? ` · ${c.channel.name}` : ""}`} actions={<>
        {["DRAFT", "REJECTED"].includes(c.status) ? <ActButton action={submitCampaignAction} hidden={{ id: c.id }} label="Submit to launch" variant="primary" /> : null}
        {c.status === "ACTIVE" ? <ActButton action={campaignStatusAction} hidden={{ id: c.id, status: "PAUSED" }} label="Pause" /> : null}
        {c.status === "PAUSED" ? <ActButton action={campaignStatusAction} hidden={{ id: c.id, status: "ACTIVE" }} label="Resume" /> : null}
      </>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }} data-testid="campaign-funnel">
        <Stat label="Career site visits" value={visits} />
        <Stat label="Applicants" value={apps.length} meta={c.targetApplicants ? `target ${c.targetApplicants}` : undefined} />
        <Stat label="Interviewed / offered" value={`${interviewed} / ${offered}`} />
        <Stat label="Hires" value={hired} meta={budget && hired ? `${inr(Math.round(budget / hired))} per hire` : budget ? `${inr(budget)} budget` : undefined} />
      </div>
      <div className="grid grid-2" style={{ alignItems: "start", gap: 16 }}>
        <Card title="Applicants" tight>
          <table className="data"><tbody>
            {apps.length === 0 ? <tr><td className="subtle">No applicants yet. Share <code>/careers?campaign={c.code}</code>.</td></tr> : apps.map((a) => (
              <tr key={a.id}><td><Link href={`/hiring/applications/${a.id}`}>{a.candidate.firstName} {a.candidate.lastName}</Link></td><td>{a.job.title}</td><td><Badge>{pretty(a.status)}</Badge></td></tr>
            ))}
          </tbody></table>
        </Card>
        <Card title="Details">
          <KeyValue items={[["Runs", `${day(c.startsOn)} – ${day(c.endsOn)}`], ["Budget", inr(c.budget)], ["Plan", c.description]]} />
          {editable ? (
            <div style={{ marginTop: 12 }}>
              <GrowthForm action={saveCampaignAction} hidden={{ id: c.id }} cols={2} submitLabel="Save" fields={[
                { name: "name", label: "Name", required: true, defaultValue: c.name }, { name: "code", label: "Tracking code", defaultValue: c.code },
                { name: "channelId", label: "Channel", type: "select", options: channels.map((x) => ({ value: x.id, label: x.name })), defaultValue: c.channelId ?? "" },
                { name: "jobId", label: "For job", type: "select", options: jobs.map((j) => ({ value: j.id, label: j.title })), defaultValue: c.jobId ?? "" },
                { name: "budget", label: "Budget (₹)", type: "number", defaultValue: budget }, { name: "targetApplicants", label: "Target applicants", type: "number", defaultValue: c.targetApplicants },
                { name: "startsOn", label: "Starts", type: "date", defaultValue: c.startsOn?.toISOString().slice(0, 10) }, { name: "endsOn", label: "Ends", type: "date", defaultValue: c.endsOn?.toISOString().slice(0, 10) },
                { name: "description", label: "Plan", type: "textarea", defaultValue: c.description },
              ]} />
            </div>
          ) : <p className="text-xs subtle" style={{ marginTop: 8 }}>Pause the campaign to edit it.</p>}
        </Card>
      </div>
    </>
  );
}
