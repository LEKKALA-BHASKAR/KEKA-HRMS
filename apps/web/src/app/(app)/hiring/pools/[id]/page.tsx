import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { asStringList, parseSegmentRules, hireStringList } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { RemoveFromPool, PoolToJobForm } from "../../_parts/talent-forms";
import { kDate } from "../../_lib/data";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { savePoolSettingsAction, archivePoolAction, refreshSegmentAction, requestPoolMemberAction } from "@/app/actions/hire-sourcing";
import s from "../../hire.module.css";

export const metadata = { title: "Talent pool · Hire" };

/** One talent pool: its candidates, where they last applied, and a way to put them forward for an open job. */
export default async function PoolPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const tenantId = viewer.tenantId;
  const pool = await prisma.talentPool.findFirst({
    where: { id, tenantId },
    include: { members: { orderBy: { addedAt: "desc" }, include: { candidate: { include: { applications: { orderBy: { appliedAt: "desc" }, take: 1, include: { job: { select: { title: true } } } } } } } } },
  });
  if (!pool) notFound();
  const jobs = await prisma.job.findMany({ where: { tenantId, status: "OPEN" }, select: { id: true, title: true, code: true }, orderBy: { title: "asc" } });
  const candidates = await prisma.candidate.findMany({ where: { tenantId, talentPools: { none: { poolId: pool.id } } }, select: { id: true, firstName: true, lastName: true, email: true }, orderBy: { createdAt: "desc" }, take: 500 });
  const rules = parseSegmentRules(pool.rules);
  const jobOptions = jobs.map((j) => ({ value: j.id, label: `${j.title}${j.code ? ` (${j.code})` : ""}` }));
  return (
    <>
      <div className={s.head}>
        <div><div className="text-sm"><Link href="/hiring/pools">Talent pools</Link> /</div><h1 className={s.h1}>{pool.name}{pool.archivedAt ? " (archived)" : ""}</h1>{pool.description ? <p className={s.sub}>{pool.description}</p> : null}
          <p className="text-xs subtle" data-testid="pool-settings">{pool.kind.toLowerCase().replace(/_/g, " ")}{pool.memberExpiryDays ? ` · members expire after ${pool.memberExpiryDays} days` : ""}{pool.requiresApproval ? " · adding needs approval" : ""}{rules ? " · segment rules set" : ""}</p></div>
        <div className="row gap-2">
          {rules ? <ActButton action={refreshSegmentAction} hidden={{ poolId: pool.id }} label="Refresh segment" /> : null}
          <ActButton action={archivePoolAction} hidden={{ poolId: pool.id }} label={pool.archivedAt ? "Restore" : "Archive"} confirmText={pool.archivedAt ? undefined : `Archive ${pool.name}?`} />
        </div>
      </div>
      <div className="row gap-3 wrap" style={{ marginBottom: 16, alignItems: "flex-start" }}>
        <Reveal label="Pool settings">
          <GrowthForm action={savePoolSettingsAction} hidden={{ poolId: pool.id }} cols={2} submitLabel="Save pool" fields={[
            { name: "name", label: "Name", defaultValue: pool.name, required: true },
            { name: "kind", label: "Kind", type: "select", defaultValue: pool.kind, options: ["STANDARD", "SILVER_MEDALIST", "HIGH_POTENTIAL", "COMMUNITY", "REACTIVATION"].map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, " ") })) },
            { name: "description", label: "Description", type: "textarea", defaultValue: pool.description },
            { name: "memberExpiryDays", label: "Members expire after (days)", type: "number", defaultValue: pool.memberExpiryDays },
            { name: "requiresApproval", label: "Adding a member needs approval", type: "checkbox", defaultChecked: pool.requiresApproval },
            { name: "segSkills", label: "Segment: any of these skills", defaultValue: hireStringList(rules?.skills).join(", ") },
            { name: "segCity", label: "Segment: city", defaultValue: rules?.city ?? "" },
            { name: "segMinExperience", label: "Segment: minimum years", type: "number", defaultValue: rules?.minExperience ?? null },
            { name: "segTags", label: "Segment: tags", defaultValue: hireStringList(rules?.tags).join(", ") },
            { name: "segSource", label: "Segment: source (e.g. REFERRAL)", defaultValue: rules?.source ?? "" },
            { name: "segHighPotential", label: "Segment: high-potential only", type: "checkbox", defaultChecked: rules?.highPotential ?? false },
          ]} />
        </Reveal>
        {!pool.archivedAt ? (
          <Reveal label="Add a candidate">
            <GrowthForm action={requestPoolMemberAction} hidden={{ poolId: pool.id }} cols={2} submitLabel={pool.requiresApproval ? "Request" : "Add"} fields={[
              { name: "candidateId", label: "Candidate", type: "select", required: true, options: candidates.map((c) => ({ value: c.id, label: `${c.firstName} ${c.lastName} (${c.email})` })) },
              { name: "note", label: "Note" },
            ]} />
          </Reveal>
        ) : null}
      </div>
      <section className={s.listCard}>
        <div className={s.listHead}><span className={s.listTitle}>Candidates</span><span className="text-xs subtle">{pool.members.length}</span></div>
        {pool.members.length === 0 ? <div className={s.empty}>Nobody in this pool yet. Save candidates to it from their candidate page.</div> : (
          <table className={s.table}><tbody>
            {pool.members.map((m) => {
              const c = m.candidate, last = c.applications[0];
              return (
                <tr key={m.id}>
                  <td>
                    {last ? <Link href={`/hiring/applications/${last.id}`} className="strong">{c.firstName} {c.lastName}</Link> : <span className="strong">{c.firstName} {c.lastName}</span>}
                    <div className={s.metaLine}>{[c.currentTitle, c.currentEmployer, c.totalExperienceYears !== null ? `${Number(c.totalExperienceYears)} yrs` : null].filter(Boolean).join(" · ")}</div>
                    {m.note ? <div className="text-xs muted">{m.note}</div> : null}
                    {m.status !== "ACTIVE" ? <div className="text-xs neg">{m.status === "PENDING_APPROVAL" ? "Waiting for approval" : m.status.toLowerCase()}</div> : m.expiresAt ? <div className="text-xs subtle">until {kDate(m.expiresAt)}</div> : null}
                  </td>
                  <td className="text-sm muted">{asStringList(c.skills).slice(0, 6).join(", ") || "—"}</td>
                  <td className="text-xs subtle">{last ? `${last.job.title} · ${last.status.toLowerCase().replace(/_/g, " ")}` : "No applications"}<div>added {kDate(m.addedAt)}</div></td>
                  <td style={{ minWidth: 280 }}><div className="stack gap-1" style={{ alignItems: "flex-end" }}><PoolToJobForm candidateId={c.id} jobs={jobOptions} /><RemoveFromPool id={m.id} /></div></td>
                </tr>
              );
            })}
          </tbody></table>
        )}
      </section>
    </>
  );
}
