import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireStringList, recommendationScore, cadenceStepsOf, pendingHireRequest, formatInZone } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue, Callout } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import {
  saveSourcingProfileAction, recordConsentAction, captureProfileAction, requestReattributionAction, enrollCadenceAction, stopCadenceAction, requestPoolMemberAction,
} from "@/app/actions/hire-sourcing";
import {
  logCommunicationAction, emailCandidateAction, uploadCandidateDocumentAction, verifyCandidateDocumentAction, transferOwnershipAction, updateReferralAction, createTaskAction,
} from "@/app/actions/hire-ops";
import { recruiterOptions } from "@/lib/hire-depth";
import { CandidateTabs, when, day, inr, pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Candidate · Hire" };

const SOURCES = ["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"];

/**
 * A candidate's 360° view: every application and where it stands, the
 * sourcing profile (engagement, tags, consent, time zone), the full
 * communication history, documents and their verification, referral,
 * outreach cadences, pools and projects, and job recommendations.
 */
export default async function Candidate360Page({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const c = await prisma.candidate.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      sourcingProfile: true, referralRecord: true, referredBy: { select: { id: true, displayName: true } },
      applications: { include: { job: { select: { id: true, title: true } }, interviews: { select: { id: true, title: true, scheduledAt: true, status: true } }, offer: { select: { status: true, annualCtc: true } } }, orderBy: { appliedAt: "desc" } },
      communications: { orderBy: { occurredAt: "desc" }, take: 100 }, documents: { orderBy: { createdAt: "desc" } },
      cadenceEnrollments: { include: { cadence: true }, orderBy: { startedAt: "desc" } }, projectEntries: { include: { project: { select: { id: true, name: true } } } },
      talentPools: { include: { pool: { select: { id: true, name: true } } } },
    },
  });
  if (!c) notFound();
  const p = c.sourcingProfile;
  const [recruiters, cadences, pools, jobs, channels, agencies, employees, reattr] = await Promise.all([
    recruiterOptions(viewer),
    prisma.outreachCadence.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true } }),
    prisma.talentPool.findMany({ where: { tenantId: viewer.tenantId, archivedAt: null }, select: { id: true, name: true, requiresApproval: true } }),
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN" }, select: { id: true, title: true, skills: true, minExperienceYears: true }, take: 100 }),
    prisma.sourcingChannel.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.recruitmentAgency.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 1000 }),
    pendingHireRequest(viewer.tenantId, "SOURCE_REATTRIBUTION", id),
  ]);
  const name = new Map(recruiters.map((r) => [r.value, r.label]));
  const applied = new Set(c.applications.map((a) => a.jobId));
  const recs = jobs.filter((j) => !applied.has(j.id)).map((j) => ({ j, r: recommendationScore({ title: j.title, skills: j.skills, minExperienceYears: j.minExperienceYears === null ? null : Number(j.minExperienceYears) }, { skills: c.skills, experienceYears: c.totalExperienceYears === null ? null : Number(c.totalExperienceYears), currentTitle: c.currentTitle }) }))
    .filter((x) => x.r.score > 0).sort((a, b) => b.r.score - a.r.score).slice(0, 5);
  const linked = (p?.linkedProfile ?? null) as { headline?: string | null; url?: string | null; summary?: string | null } | null;
  const active = c.applications.filter((a) => ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"].includes(a.status));
  return (
    <>
      <CandidateTabs />
      <PageHead title={`${c.firstName} ${c.lastName}`} subtitle={[c.currentTitle, c.currentEmployer, c.city, c.email, c.phone].filter(Boolean).join(" · ")} actions={<Link className="btn" href={`/hiring/candidates/duplicates?focus=${c.id}`}>Find duplicates</Link>} />
      {p?.consentStatus === "WITHDRAWN" ? <Callout tone="danger" title="Consent withdrawn">Do not contact {c.firstName}; outreach is stopped.</Callout> : null}
      <div className="grid grid-2" style={{ alignItems: "start", gap: 16 }}>
        <div className="stack gap-3">
          <Card title="Applications" tight>
            {c.applications.length === 0 ? <Empty title="No applications">A sourced prospect. Recommended roles are on the right.</Empty> : (
              <table className="data"><tbody>
                {c.applications.map((a) => (
                  <tr key={a.id}>
                    <td><Link href={`/hiring/applications/${a.id}`}>{a.job.title}</Link><div className="text-xs muted">Applied {day(a.appliedAt)} · owner {a.ownerId ? name.get(a.ownerId) ?? "—" : "unassigned"}</div></td>
                    <td><Badge tone={a.status === "HIRED" ? "success" : ["REJECTED", "WITHDRAWN"].includes(a.status) ? "neutral" : "info"}>{pretty(a.status)}</Badge></td>
                    <td className="text-xs">{a.interviews.length} interview(s){a.offer ? ` · offer ${pretty(a.offer.status).toLowerCase()} ${inr(a.offer.annualCtc)}` : ""}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            {active.length ? (
              <div style={{ padding: 12 }}>
                <Reveal label="Transfer ownership">
                  <GrowthForm action={transferOwnershipAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Transfer open applications" fields={[{ name: "ownerUserId", label: "New owner", type: "select", required: true, options: recruiters }]} />
                </Reveal>
              </div>
            ) : null}
          </Card>
          <Card title="Communication history" description="Every email, call and message, newest first.">
            <div className="row gap-2 wrap" style={{ marginBottom: 10 }}>
              <Reveal label="Log a conversation">
                <GrowthForm action={logCommunicationAction} hidden={{ candidateId: c.id }} cols={3} submitLabel="Log" fields={[
                  { name: "channel", label: "How", type: "select", required: true, options: ["EMAIL", "CALL", "SMS", "MEETING", "LINKEDIN", "NOTE"].map((x) => ({ value: x, label: pretty(x) })) },
                  { name: "direction", label: "Direction", type: "select", options: [{ value: "OUTBOUND", label: "We reached out" }, { value: "INBOUND", label: "They reached out" }], defaultValue: "OUTBOUND" },
                  { name: "occurredAt", label: "When", type: "date" },
                  { name: "subject", label: "Subject", wide: true },
                  { name: "body", label: "What was said", type: "textarea" },
                ]} />
              </Reveal>
              {p?.consentStatus !== "WITHDRAWN" ? (
                <Reveal label="Email">
                  <GrowthForm action={emailCandidateAction} hidden={{ candidateId: c.id }} cols={1} submitLabel="Send" fields={[{ name: "subject", label: "Subject", required: true }, { name: "body", label: "Message", type: "textarea", required: true, rows: 6 }]} />
                </Reveal>
              ) : null}
            </div>
            {c.communications.length === 0 ? <div className="text-sm subtle">Nothing logged yet.</div> : (
              <ul className="stack gap-2" style={{ listStyle: "none", padding: 0 }} data-testid="comm-history">
                {c.communications.map((m) => (
                  <li key={m.id} className="text-sm">
                    <Badge>{pretty(m.channel)}</Badge> <span className="subtle">{m.direction === "INBOUND" ? "from them" : "to them"} · {when(m.occurredAt)} · {m.byUserId ? name.get(m.byUserId) ?? "" : ""}</span>
                    {m.subject ? <div className="strong">{m.subject}</div> : null}
                    {m.body ? <div style={{ whiteSpace: "pre-wrap" }}>{m.body.slice(0, 600)}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Documents" description="Uploaded for verification by someone other than the uploader.">
            <GrowthForm action={uploadCandidateDocumentAction} hidden={{ candidateId: c.id }} cols={3} submitLabel="Upload" fields={[
              { name: "kind", label: "Type", type: "select", required: true, options: ["ID_PROOF", "EDUCATION", "EXPERIENCE", "ADDRESS", "OTHER"].map((x) => ({ value: x, label: pretty(x) })) },
              { name: "file", label: "PDF or image", type: "file" },
            ]} />
            {c.documents.length ? (
              <table className="data" style={{ marginTop: 10 }}><tbody>
                {c.documents.map((d) => (
                  <tr key={d.id}>
                    <td><a href={`/files/${d.fileId}`}>{d.fileName}</a><div className="text-xs muted">{pretty(d.kind)} · {day(d.createdAt)}</div></td>
                    <td><Badge tone={d.status === "VERIFIED" ? "success" : d.status === "REJECTED" ? "danger" : "warning"}>{pretty(d.status)}</Badge>{d.note ? <div className="text-xs">{d.note}</div> : null}</td>
                    <td className="right">{d.status === "PENDING" ? <><ActButton action={verifyCandidateDocumentAction} hidden={{ id: d.id, decision: "VERIFIED" }} label="Verify" variant="primary" /> <ActButton action={verifyCandidateDocumentAction} hidden={{ id: d.id, decision: "REJECTED" }} label="Reject" input={{ name: "note", placeholder: "What is wrong", required: true }} /></> : null}</td>
                  </tr>
                ))}
              </tbody></table>
            ) : null}
          </Card>
        </div>
        <div className="stack gap-3">
          <Card title="Sourcing profile">
            <KeyValue items={[
              ["Source", <>{pretty(c.source)}{reattr ? <Badge tone="warning">Change pending approval</Badge> : null}</>],
              ["Campaign / UTM", [p?.utmSource, p?.utmCampaign].filter(Boolean).join(" / ") || null],
              ["Consent", p && p.consentStatus !== "NONE" ? `${pretty(p.consentStatus)} (${p.consentSource ?? ""})${p.consentExpiresAt ? ` until ${day(p.consentExpiresAt)}` : ""}` : "Not recorded"],
              ["Last contacted", p?.lastContactedAt ? when(p.lastContactedAt) : null],
              ["Local time", p?.timeZone ? `${formatInZone(new Date(), p.timeZone)} (${p.timeZone})` : null],
              ["Public profile", linked?.headline ? <>{linked.url ? <a href={linked.url} target="_blank" rel="noreferrer">{linked.headline}</a> : linked.headline}</> : null],
            ]} />
            <div style={{ marginTop: 10 }}>
              <GrowthForm action={saveSourcingProfileAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Save profile" fields={[
                { name: "engagementStatus", label: "Engagement", type: "select", options: ["NEW", "CONTACTED", "ENGAGED", "INTERESTED", "NOT_INTERESTED", "UNRESPONSIVE"].map((x) => ({ value: x, label: pretty(x) })), defaultValue: p?.engagementStatus ?? "NEW" },
                { name: "timeZone", label: "Time zone", defaultValue: p?.timeZone ?? "", placeholder: "Asia/Kolkata" },
                { name: "tags", label: "Tags (comma separated)", defaultValue: hireStringList(p?.tags).join(", "), wide: true },
                { name: "agencyId", label: "Agency", type: "select", options: agencies.map((a) => ({ value: a.id, label: a.name })), defaultValue: p?.agencyId ?? "" },
                { name: "isPassive", label: "Passive candidate (not actively looking)", type: "checkbox", defaultChecked: p?.isPassive ?? false },
                { name: "isHighPotential", label: "High potential", type: "checkbox", defaultChecked: p?.isHighPotential ?? false },
              ]} />
            </div>
            <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
              <Reveal label="Record consent">
                <GrowthForm action={recordConsentAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Record" fields={[
                  { name: "status", label: "Consent", type: "select", options: [{ value: "GRANTED", label: "Granted" }, { value: "WITHDRAWN", label: "Withdrawn" }], defaultValue: "GRANTED" },
                  { name: "source", label: "How", required: true, placeholder: "e.g. replied by email" },
                ]} />
              </Reveal>
              <Reveal label="Capture public profile">
                <GrowthForm action={captureProfileAction} hidden={{ candidateId: c.id }} cols={1} submitLabel="Capture" fields={[
                  { name: "url", label: "Profile URL", type: "url" },
                  { name: "profileText", label: "Paste the profile text (headline first; a “Skills:” line is picked up)", type: "textarea", rows: 6, required: true },
                ]} />
              </Reveal>
              <Reveal label="Correct the source">
                <GrowthForm action={requestReattributionAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Request change" fields={[
                  { name: "source", label: "Correct source", type: "select", required: true, options: SOURCES.map((x) => ({ value: x, label: pretty(x) })) },
                  { name: "channelId", label: "Channel", type: "select", options: channels.map((x) => ({ value: x.id, label: x.name })) },
                  { name: "reason", label: "Why", required: true, wide: true },
                ]} />
              </Reveal>
            </div>
          </Card>
          <Card title="Recommended open roles">
            {recs.length === 0 ? <div className="text-sm subtle">No open role matches their skills yet.</div> : (
              <ul className="stack gap-1" style={{ listStyle: "none", padding: 0 }} data-testid="recommendations">
                {recs.map(({ j, r }) => <li key={j.id} className="text-sm"><Link href={`/hiring/jobs/${j.id}`}>{j.title}</Link> — {r.score}% <span className="subtle">{r.matched.length ? `matches ${r.matched.join(", ")}` : ""}</span></li>)}
              </ul>
            )}
          </Card>
          <Card title="Outreach cadences">
            {c.cadenceEnrollments.map((e) => (
              <div key={e.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between" }}>
                <span>{e.cadence.name} · {cadenceStepsOf(e.cadence.steps).length} steps · since {day(e.startedAt)} · <Badge tone={e.status === "ACTIVE" ? "info" : "neutral"}>{pretty(e.status)}</Badge></span>
                {e.status === "ACTIVE" ? <ActButton action={stopCadenceAction} hidden={{ id: e.id }} label="Stop" /> : null}
              </div>
            ))}
            {cadences.length ? <GrowthForm action={enrollCadenceAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Enroll" fields={[{ name: "cadenceId", label: "Cadence", type: "select", required: true, options: cadences.map((x) => ({ value: x.id, label: x.name })) }]} /> : <div className="text-sm subtle">No cadences yet — create one under Sourcing.</div>}
          </Card>
          <Card title="Pools and projects">
            <div className="text-sm">{c.talentPools.map((m) => <span key={m.id}><Link href={`/hiring/pools/${m.poolId}`}>{m.pool.name}</Link> <Badge tone={m.status === "ACTIVE" ? "success" : "warning"}>{pretty(m.status)}</Badge>{m.expiresAt ? <span className="subtle"> until {day(m.expiresAt)}</span> : null} </span>)}</div>
            <div className="text-sm">{c.projectEntries.map((e) => <span key={e.id}><Link href={`/hiring/sourcing/projects/${e.projectId}`}>{e.project.name}</Link> ({pretty(e.stage)}) </span>)}</div>
            <GrowthForm action={requestPoolMemberAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Add to pool" fields={[
              { name: "poolId", label: "Pool", type: "select", required: true, options: pools.map((x) => ({ value: x.id, label: `${x.name}${x.requiresApproval ? " (needs approval)" : ""}` })) },
              { name: "note", label: "Why" },
            ]} />
          </Card>
          <Card title="Referral">
            {c.referredBy ? <div className="text-sm">Referred by {c.referredBy.displayName}{c.referralRecord?.relationship ? ` (${c.referralRecord.relationship})` : ""}. Bonus: {pretty(c.referralRecord?.bonusStatus ?? "NONE")}</div> : <div className="text-sm subtle">Not a referral.</div>}
            <Reveal label={c.referredBy ? "Edit referral" : "Record a referral"}>
              <GrowthForm action={updateReferralAction} hidden={{ candidateId: c.id }} cols={2} submitLabel="Save" fields={[
                { name: "referrerEmployeeId", label: "Referred by", type: "select", required: true, options: employees.map((e) => ({ value: e.id, label: e.displayName ?? e.id })), defaultValue: c.referredById ?? "" },
                { name: "relationship", label: "Relationship", defaultValue: c.referralRecord?.relationship ?? "" },
                { name: "recommendation", label: "Their recommendation", type: "textarea", defaultValue: c.referralRecord?.recommendation ?? "" },
              ]} />
            </Reveal>
          </Card>
          <Card title="Follow-up">
            <GrowthForm action={createTaskAction} hidden={{ candidateId: c.id, queue: "SOURCING" }} cols={2} submitLabel="Add task" fields={[
              { name: "title", label: "Task", required: true, defaultValue: `Follow up with ${c.firstName}` },
              { name: "dueAt", label: "Due", type: "date" },
              { name: "assigneeUserId", label: "Assign to", type: "select", options: recruiters, defaultValue: viewer.user.id },
            ]} />
          </Card>
        </div>
      </div>
    </>
  );
}
