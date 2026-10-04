import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { parseBooleanQuery, matchesBoolean, candidateHaystack, hireStringList, CANDIDATE_IMPORT_FIELDS } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { importCandidatesAction, saveSearchAction } from "@/app/actions/hire-sourcing";
import { CandidateTabs, day, pretty } from "../_parts/depth-tabs";

export const metadata = { title: "Candidates · Hire" };

const ENGAGEMENT = ["NEW", "CONTACTED", "ENGAGED", "INTERESTED", "NOT_INTERESTED", "UNRESPONSIVE"];
const SOURCES = ["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"];

type SP = { q?: string; tag?: string; engagement?: string; source?: string; owner?: string; passive?: string; hipo?: string };

/**
 * Hire › Candidates: everyone in the database — applicants and sourced
 * prospects — searchable with boolean queries (AND, OR, NOT, quotes,
 * brackets) across name, title, employer, skills and city, and filterable by
 * tag, engagement, source, owner, passive and high-potential flags.
 */
export default async function CandidatesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 300);
  const parsed = q ? parseBooleanQuery(q) : { node: null };
  const where: Prisma.CandidateWhereInput = {
    tenantId: viewer.tenantId,
    ...(SOURCES.includes(sp.source ?? "") ? { source: sp.source as Prisma.CandidateWhereInput["source"] } : {}),
    ...(sp.owner === "me" ? { applications: { some: { ownerId: viewer.user.id } } } : {}),
    ...(ENGAGEMENT.includes(sp.engagement ?? "") || sp.passive || sp.hipo ? { sourcingProfile: { ...(ENGAGEMENT.includes(sp.engagement ?? "") ? { engagementStatus: sp.engagement } : {}), ...(sp.passive ? { isPassive: true } : {}), ...(sp.hipo ? { isHighPotential: true } : {}) } } : {}),
  };
  const all = await prisma.candidate.findMany({ where, include: { sourcingProfile: true, applications: { select: { id: true, status: true, job: { select: { title: true } } }, orderBy: { appliedAt: "desc" }, take: 3 } }, orderBy: { updatedAt: "desc" }, take: 2000 });
  const tag = (sp.tag ?? "").trim().toLowerCase();
  const rows = all.filter((c) => (!parsed.node || matchesBoolean(parsed.node, candidateHaystack(c))) && (!tag || hireStringList(c.sourcingProfile?.tags).map((t) => t.toLowerCase()).includes(tag))).slice(0, 200);
  const [projects, tagsInUse] = await Promise.all([
    prisma.sourcingProject.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.candidateSourcingProfile.findMany({ where: { tenantId: viewer.tenantId }, select: { tags: true }, take: 2000 }),
  ]);
  const tagSet = [...new Set(tagsInUse.flatMap((t) => hireStringList(t.tags).map((x) => x.toLowerCase())))].sort().slice(0, 40);
  return (
    <>
      <CandidateTabs />
      <PageHead title="Candidates" subtitle="Search the whole candidate database, applicants and sourced prospects alike." actions={<><a className="btn" href="/hiring/insights/export?kind=candidates&days=730">CSV</a> <Link className="btn" href="/hiring/sourcing/projects">Sourcing projects</Link></>} />
      <form className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input className="input" name="q" defaultValue={q} placeholder={'e.g. (react OR vue) AND "bengaluru" NOT intern'} aria-label="Boolean search" style={{ flex: 2, minWidth: 260 }} />
        <select className="input" name="tag" defaultValue={tag} aria-label="Tag"><option value="">Any tag</option>{tagSet.map((t) => <option key={t} value={t}>#{t}</option>)}</select>
        <select className="input" name="engagement" defaultValue={sp.engagement ?? ""} aria-label="Engagement"><option value="">Any engagement</option>{ENGAGEMENT.map((e) => <option key={e} value={e}>{pretty(e)}</option>)}</select>
        <select className="input" name="source" defaultValue={sp.source ?? ""} aria-label="Source"><option value="">Any source</option>{SOURCES.map((e) => <option key={e} value={e}>{pretty(e)}</option>)}</select>
        <label className="row gap-1 text-sm"><input type="checkbox" name="owner" value="me" defaultChecked={sp.owner === "me"} /> Mine</label>
        <label className="row gap-1 text-sm"><input type="checkbox" name="passive" value="1" defaultChecked={!!sp.passive} /> Passive</label>
        <label className="row gap-1 text-sm"><input type="checkbox" name="hipo" value="1" defaultChecked={!!sp.hipo} /> High potential</label>
        <button className="btn primary">Search</button>
      </form>
      {"error" in parsed && parsed.error ? <Callout tone="warning">{parsed.error}</Callout> : null}
      <div className="row gap-2 wrap" style={{ marginBottom: 8 }}>
        {q ? (
          <Reveal label="Save this search">
            <GrowthForm action={saveSearchAction} cols={3} hidden={{ q, source: sp.source ?? "" }} submitLabel="Save search" fields={[
              { name: "name", label: "Name", required: true },
              { name: "projectId", label: "For project", type: "select", options: projects.map((p) => ({ value: p.id, label: p.name })) },
              { name: "isShared", label: "Share in the team's search library", type: "checkbox" },
            ]} />
          </Reveal>
        ) : null}
        <Reveal label="Import candidates">
          <Card>
            <p className="text-sm muted">Upload a CSV with a header row. Columns named like the fields map themselves; otherwise type the column header next to each field.</p>
            <GrowthForm action={importCandidatesAction} cols={4} submitLabel="Import" fields={[
              { name: "file", label: "CSV file", type: "file", wide: true },
              { name: "tag", label: "Tag everyone imported", placeholder: "e.g. meetup-2026" },
              ...CANDIDATE_IMPORT_FIELDS.map((k) => ({ name: `map_${k}`, label: `Column for ${k}`, placeholder: k })),
            ]} />
          </Card>
        </Reveal>
      </div>
      <Card tight>
        {rows.length === 0 ? <Empty title="No candidates match">Try a broader search.</Empty> : (
            <div className="table-wrap">
              <table className="data" data-testid="candidate-table">
                <thead><tr><th>Candidate</th><th>Source</th><th>Engagement</th><th>Tags</th><th>Applications</th><th>Consent</th></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="strong" href={`/hiring/candidates/${c.id}`}>{c.firstName} {c.lastName}</Link>
                        <div className="text-xs muted">{[c.currentTitle, c.currentEmployer, c.city].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="text-sm">{pretty(c.source)}</td>
                      <td>{c.sourcingProfile ? <Badge tone="info">{pretty(c.sourcingProfile.engagementStatus)}</Badge> : <span className="subtle">—</span>}{c.sourcingProfile?.isPassive ? <Badge>Passive</Badge> : null}{c.sourcingProfile?.isHighPotential ? <Badge tone="brand">HiPo</Badge> : null}</td>
                      <td className="text-xs">{hireStringList(c.sourcingProfile?.tags).slice(0, 5).map((t) => `#${t}`).join(" ")}</td>
                      <td className="text-xs">{c.applications.map((a) => <div key={a.id}><Link href={`/hiring/applications/${a.id}`}>{a.job.title}</Link> · {pretty(a.status)}</div>)}</td>
                      <td className="text-xs">{c.sourcingProfile?.consentStatus && c.sourcingProfile.consentStatus !== "NONE" ? `${pretty(c.sourcingProfile.consentStatus)}${c.sourcingProfile.consentExpiresAt ? ` to ${day(c.sourcingProfile.consentExpiresAt)}` : ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        )}
      </Card>
      <p className="text-xs subtle">Showing {rows.length} of {all.length} matching candidates.</p>
    </>
  );
}

