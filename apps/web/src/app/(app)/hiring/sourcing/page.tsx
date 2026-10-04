import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { cadenceStepsOf, pendingHireRequests } from "@keka/services";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import {
  createChannelAction, deactivateChannelAction, reactivateChannelAction, saveCampaignAction, submitCampaignAction, campaignStatusAction,
  runSavedSearchAction, deleteSearchAction, saveAgencyAction, toggleAgencyAction, agencySubmissionAction, saveCadenceAction,
} from "@/app/actions/hire-sourcing";
import { requireAnyOf, recruiterOptions } from "@/lib/hire-depth";
import { SourcingTabs, day, inr, pretty, when } from "../_parts/depth-tabs";

export const metadata = { title: "Sourcing · Hire" };

const SOURCES = ["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"];
const tone = (s: string) => (s === "ACTIVE" ? "success" : s === "PENDING_APPROVAL" ? "warning" : s === "REJECTED" ? "danger" : "neutral") as "success" | "warning" | "danger" | "neutral";

/**
 * Hire › Sourcing: the channels candidates come through (approved before
 * they count), campaigns with budgets and tracking codes (approved before
 * launch), saved boolean searches and the shared search library, agencies
 * and their submissions, and outreach cadences.
 */
export default async function SourcingPage() {
  const viewer = await requireAnyOf([PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE]);
  const t = viewer.tenantId;
  const [channels, campaigns, searches, agencies, cadences, jobs, recruiters, apps] = await Promise.all([
    prisma.sourcingChannel.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.sourcingCampaign.findMany({ where: { tenantId: t }, include: { channel: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.savedSourcingSearch.findMany({ where: { tenantId: t, OR: [{ ownerUserId: viewer.user.id }, { isShared: true }] }, include: { project: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.recruitmentAgency.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.outreachCadence.findMany({ where: { tenantId: t }, include: { _count: { select: { enrollments: true } } }, orderBy: { name: "asc" } }),
    prisma.job.findMany({ where: { tenantId: t, status: "OPEN" }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    recruiterOptions(viewer),
    prisma.candidateSourcingProfile.groupBy({ by: ["campaignId"], where: { tenantId: t, campaignId: { not: null } }, _count: { _all: true } }),
  ]);
  const perCampaign = new Map(apps.map((a) => [a.campaignId, a._count._all]));
  const chanPending = await pendingHireRequests(t, "CHANNEL_ACTIVATION", channels.map((c) => c.id));
  const campPending = await pendingHireRequests(t, "CAMPAIGN_LAUNCH", campaigns.map((c) => c.id));
  return (
    <>
      <SourcingTabs />
      <PageHead title="Sourcing" subtitle="Where candidates come from, and the campaigns, searches, agencies and outreach that bring them in." actions={<Link className="btn" href="/hiring/insights">Source analytics</Link>} />
      <div className="grid grid-2" style={{ alignItems: "start", gap: 16 }}>
        <Card title="Channels" description="A new channel needs approval before campaigns can use it." tight>
          {channels.length === 0 ? <Empty title="No channels yet" /> : (
            <table className="data"><tbody>
              {channels.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}<div className="text-xs muted">{pretty(c.baseSource)}{c.monthlyCost ? ` · ${inr(c.monthlyCost)}/month` : ""}</div></td>
                  <td><Badge tone={tone(c.status)}>{chanPending.has(c.id) ? "Awaiting approval" : pretty(c.status)}</Badge></td>
                  <td className="right">{c.status === "ACTIVE" ? <ActButton action={deactivateChannelAction} hidden={{ id: c.id }} label="Switch off" /> : ["INACTIVE", "REJECTED"].includes(c.status) ? <ActButton action={reactivateChannelAction} hidden={{ id: c.id }} label="Propose again" /> : null}</td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <Reveal label="Propose a channel">
              <GrowthForm action={createChannelAction} cols={2} submitLabel="Send for approval" fields={[
                { name: "name", label: "Name", required: true }, { name: "baseSource", label: "Kind of source", type: "select", required: true, options: SOURCES.map((s) => ({ value: s, label: pretty(s) })) },
                { name: "monthlyCost", label: "Monthly cost (₹)", type: "number" }, { name: "description", label: "Notes" },
              ]} />
            </Reveal>
          </div>
        </Card>
        <Card title="Campaigns" description="Share a campaign's tracking code in links (?campaign=CODE) to attribute applicants." tight>
          {campaigns.length === 0 ? <Empty title="No campaigns yet" /> : (
            <table className="data"><tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/hiring/sourcing/campaigns/${c.id}`}>{c.name}</Link><div className="text-xs muted">{c.code} · {c.channel?.name ?? "any channel"} · {inr(c.budget)} · {day(c.startsOn)}–{day(c.endsOn)}</div></td>
                  <td className="text-sm">{perCampaign.get(c.id) ?? 0} candidate(s)</td>
                  <td><Badge tone={tone(c.status)}>{campPending.has(c.id) ? "Awaiting approval" : pretty(c.status)}</Badge></td>
                  <td className="right">
                    {["DRAFT", "REJECTED"].includes(c.status) ? <ActButton action={submitCampaignAction} hidden={{ id: c.id }} label="Submit to launch" variant="primary" /> : null}
                    {c.status === "ACTIVE" ? <ActButton action={campaignStatusAction} hidden={{ id: c.id, status: "PAUSED" }} label="Pause" /> : null}
                    {c.status === "PAUSED" ? <ActButton action={campaignStatusAction} hidden={{ id: c.id, status: "ACTIVE" }} label="Resume" /> : null}
                    {["ACTIVE", "PAUSED", "DRAFT"].includes(c.status) ? <ActButton action={campaignStatusAction} hidden={{ id: c.id, status: "CLOSED" }} label="Close" confirmText="Close this campaign?" /> : null}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <Reveal label="New campaign">
              <GrowthForm action={saveCampaignAction} cols={2} submitLabel="Save draft" fields={[
                { name: "name", label: "Name", required: true }, { name: "code", label: "Tracking code", placeholder: "e.g. CAMPUS-26" },
                { name: "channelId", label: "Channel", type: "select", options: channels.filter((c) => c.status === "ACTIVE").map((c) => ({ value: c.id, label: c.name })) },
                { name: "jobId", label: "For job", type: "select", options: jobs.map((j) => ({ value: j.id, label: j.title })) },
                { name: "budget", label: "Budget (₹)", type: "number" }, { name: "targetApplicants", label: "Target applicants", type: "number" },
                { name: "startsOn", label: "Starts", type: "date" }, { name: "endsOn", label: "Ends", type: "date" },
                { name: "description", label: "Plan", type: "textarea" },
              ]} />
            </Reveal>
          </div>
        </Card>
        <Card title="Saved searches & library" description="Your searches and the ones colleagues shared. Save one from Candidates." tight>
          {searches.length === 0 ? <Empty title="No saved searches"><Link href="/hiring/candidates">Search candidates</Link> and save the query.</Empty> : (
            <table className="data"><tbody>
              {searches.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/hiring/candidates?q=${encodeURIComponent(s.query)}${(s.filters as { source?: string } | null)?.source ? `&source=${(s.filters as { source: string }).source}` : ""}`}>{s.name}</Link>{s.isShared ? <Badge tone="brand">Shared</Badge> : null}<div className="text-xs muted"><code>{s.query}</code>{s.project ? ` · ${s.project.name}` : ""}</div></td>
                  <td className="text-xs">{s.lastRunAt ? `${s.lastCount} on ${when(s.lastRunAt)}` : "Not run"}</td>
                  <td className="right"><ActButton action={runSavedSearchAction} hidden={{ id: s.id }} label="Run" />{s.ownerUserId === viewer.user.id ? <ActButton action={deleteSearchAction} hidden={{ id: s.id }} label="Delete" variant="ghost" /> : null}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>
        <Card title="Agencies" description="Submissions go to the agency's owner, at its entry stage." tight>
          {agencies.length === 0 ? <Empty title="No agencies" /> : (
            <table className="data"><tbody>
              {agencies.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}<div className="text-xs muted">{a.contactEmail ?? ""}{a.feePercent ? ` · ${Number(a.feePercent)}% fee` : ""}{a.entryStage ? ` · enters at ${a.entryStage}` : ""}</div></td>
                  <td><Badge tone={a.isActive ? "success" : "neutral"}>{a.isActive ? "Active" : "Paused"}</Badge></td>
                  <td className="right"><ActButton action={toggleAgencyAction} hidden={{ id: a.id }} label={a.isActive ? "Pause" : "Resume"} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div style={{ padding: 12 }} className="stack gap-2">
            <Reveal label="Add agency">
              <GrowthForm action={saveAgencyAction} cols={2} submitLabel="Add" fields={[
                { name: "name", label: "Name", required: true }, { name: "contactEmail", label: "Contact email" }, { name: "feePercent", label: "Fee (%)", type: "number" },
                { name: "ownerUserId", label: "Routed to", type: "select", options: recruiters }, { name: "entryStage", label: "Entry stage name", placeholder: "e.g. Screening" },
              ]} />
            </Reveal>
            {agencies.some((a) => a.isActive) && jobs.length ? (
              <Reveal label="Log an agency submission">
                <GrowthForm action={agencySubmissionAction} cols={2} submitLabel="Submit candidate" fields={[
                  { name: "agencyId", label: "Agency", type: "select", required: true, options: agencies.filter((a) => a.isActive).map((a) => ({ value: a.id, label: a.name })) },
                  { name: "jobId", label: "Job", type: "select", required: true, options: jobs.map((j) => ({ value: j.id, label: j.title })) },
                  { name: "firstName", label: "First name", required: true }, { name: "lastName", label: "Last name" }, { name: "email", label: "Email", required: true },
                  { name: "phone", label: "Phone" }, { name: "currentTitle", label: "Current title" },
                ]} />
              </Reveal>
            ) : null}
          </div>
        </Card>
        <Card title="Outreach cadences" description="Enrolling a candidate queues each step as an outreach task on its day." tight>
          {cadences.length === 0 ? <Empty title="No cadences" /> : (
            <table className="data"><tbody>
              {cadences.map((c) => <tr key={c.id}><td>{c.name}<div className="text-xs muted">{cadenceStepsOf(c.steps).map((s) => `Day ${s.day} ${s.channel.toLowerCase()}`).join(" → ")}</div></td><td className="text-sm">{c._count.enrollments} enrolled</td></tr>)}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <Reveal label="New cadence">
              <GrowthForm action={saveCadenceAction} cols={1} submitLabel="Save" fields={[
                { name: "name", label: "Name", required: true },
                { name: "steps", label: "Steps, one per line", type: "textarea", rows: 5, required: true, placeholder: "Day 0: email: introduce the role\nDay 3: call: follow up\nDay 7: linkedin: final nudge" },
              ]} />
            </Reveal>
          </div>
        </Card>
      </div>
    </>
  );
}
