import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { skillsReport, SKILL_REPORTS, type SkillReportKind } from "@/lib/growth-reports";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReviewButtons, ReportView } from "@/components/growth-report";
import { createSkillAction } from "@/app/actions/career";
import { updateSkillAction, toggleSkillAction, decideSkillProposalAction, saveFrameworkAction, frameworkItemAction, frameworkReviewAction, deleteFrameworkAction, saveScaleAction, scaleReviewAction, applyScaleAction } from "@/app/actions/skills";

const P = PERMISSIONS;
const TABS = { library: "Skill library", frameworks: "Competency frameworks", scales: "Proficiency scales", reports: "Reports" } as const;
type Tab = keyof typeof TABS;
const levelsOf = (raw: unknown): string[] => (Array.isArray(raw) ? (raw as string[]) : []);

export default async function SkillsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; report?: string; frameworkId?: string; category?: string }> }) {
  const viewer = await requireAuth(P.SKILL_MANAGE);
  const sp = await searchParams;
  const tab = (sp.tab && sp.tab in TABS ? sp.tab : "library") as Tab;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const t = viewer.tenantId;

  const skills = await prisma.skill.findMany({
    where: { tenantId: t, ...(tab === "library" && q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { category: { contains: q, mode: "insensitive" } }] } : {}), ...(tab === "library" && sp.category ? { category: sp.category } : {}) },
    include: { _count: { select: { employeeSkills: true, competencyItems: true } } },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const active = skills.filter((s) => s.status === "ACTIVE" && s.isActive);
  const categories = [...new Set(skills.map((s) => s.category).filter((c): c is string => !!c))].sort();

  return (
    <>
      <PageHead title="Skills & Competencies" subtitle="The skill library, what each role needs, and where people stand" actions={<Link className="btn" href="/performance/careers">Career paths</Link>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/performance/skills?tab=${k}`} className={`tab${k === tab ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "library" ? <Library skills={skills} categories={categories} q={q} category={sp.category} /> : null}
      {tab === "frameworks" ? <Frameworks tenantId={t} me={viewer.user.id} skills={active} /> : null}
      {tab === "scales" ? <Scales tenantId={t} me={viewer.user.id} skills={active} /> : null}
      {tab === "reports" ? await Reports({ viewer, kind: (sp.report && sp.report in SKILL_REPORTS ? sp.report : "inventory") as SkillReportKind, frameworkId: sp.frameworkId }) : null}
    </>
  );
}

type SkillRow = Prisma.SkillGetPayload<{ include: { _count: { select: { employeeSkills: true; competencyItems: true } } } }>;

function Library({ skills, categories, q, category }: { skills: SkillRow[]; categories: string[]; q: string; category?: string }) {
  const proposed = skills.filter((s) => s.status === "PROPOSED");
  const listed = skills.filter((s) => s.status !== "PROPOSED");
  return (
    <div className="stack gap-4">
      <form className="row gap-2 wrap">
        <input type="hidden" name="tab" value="library" />
        <input className="input" name="q" defaultValue={q} placeholder="Search skills" style={{ maxWidth: 280 }} />
        <select className="select" name="category" defaultValue={category ?? ""} style={{ maxWidth: 200 }}>
          <option value="">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="btn">Search</button>
      </form>
      <Reveal label="+ Add a skill">
        <Panel title="New skill">
          <GrowthForm action={createSkillAction} submitLabel="Add skill" fields={[
            { name: "name", label: "Name", required: true },
            { name: "category", label: "Category" },
            { name: "levels", label: "Levels (comma separated)", hint: "Blank for Beginner, Working knowledge, Proficient, Expert" },
            { name: "description", label: "Description", type: "textarea" },
          ]} />
        </Panel>
      </Reveal>
      {proposed.length ? (
        <Panel title={`Suggested by employees (${proposed.length})`} pad={false}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Skill</th><th>Category</th><th>Suggested</th><th /></tr></thead>
              <tbody>
                {proposed.map((s) => (
                  <tr key={s.id}>
                    <td><span className="strong">{s.name}</span>{s.description ? <div className="text-xs subtle">{s.description}</div> : null}</td>
                    <td className="text-sm">{s.category ?? "—"}</td>
                    <td className="text-sm">{formatDate(s.createdAt)}</td>
                    <td className="right"><span className="row gap-1">
                      <ActButton action={decideSkillProposalAction} hidden={{ skillId: s.id, decision: "approve" }} label="Add to library" variant="primary" />
                      <ActButton action={decideSkillProposalAction} hidden={{ skillId: s.id, decision: "reject" }} label="Decline" />
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <Panel title={`Library (${listed.length})`} pad={false}>
        {listed.length === 0 ? <EmptyState title="No skills match" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Skill</th><th>Category</th><th>Levels</th><th className="num">People</th><th className="num">Frameworks</th><th>Status</th><th /></tr></thead>
              <tbody>
                {listed.map((s) => (
                  <tr key={s.id}>
                    <td><span className="strong">{s.name}</span>{s.isCritical ? <Badge tone="warning">Critical</Badge> : null}{s.validityMonths ? <div className="text-xs subtle">Re-confirm every {s.validityMonths} months</div> : null}</td>
                    <td className="text-sm">{s.category ?? "—"}</td>
                    <td className="text-xs">{levelsOf(s.levels).join(" › ")}</td>
                    <td className="num">{s._count.employeeSkills}</td>
                    <td className="num">{s._count.competencyItems}</td>
                    <td><Badge tone={s.status === "ACTIVE" && s.isActive ? "success" : "neutral"} dot>{s.status === "ACTIVE" ? (s.isActive ? "active" : "inactive") : s.status.toLowerCase()}</Badge></td>
                    <td className="right" style={{ minWidth: 200 }}>
                      {s.status === "ACTIVE" ? <ActButton action={toggleSkillAction} hidden={{ skillId: s.id }} label={s.isActive ? "Deactivate" : "Reactivate"} /> : null}
                      <Reveal label="Edit">
                        <GrowthForm action={updateSkillAction} hidden={{ skillId: s.id }} cols={2} compact fields={[
                          { name: "name", label: "Name", required: true, defaultValue: s.name },
                          { name: "category", label: "Category", defaultValue: s.category },
                          { name: "levels", label: "Levels (one per line or commas)", type: "textarea", rows: 2, defaultValue: levelsOf(s.levels).join(", ") },
                          { name: "validityMonths", label: "Re-confirm after (months)", type: "number", min: 1, max: 120, defaultValue: s.validityMonths },
                          { name: "description", label: "Description", defaultValue: s.description },
                          { name: "isCritical", label: "Critical skill", type: "checkbox", defaultChecked: s.isCritical },
                        ]} />
                      </Reveal>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

async function Frameworks({ tenantId, me, skills }: { tenantId: string; me: string; skills: SkillRow[] }) {
  const frameworks = await prisma.competencyFramework.findMany({ where: { tenantId }, include: { items: { include: { skill: { select: { name: true, levels: true } } } } }, orderBy: [{ name: "asc" }, { version: "desc" }] });
  const titles = await prisma.jobTitle.findMany({ where: { tenantId }, select: { name: true }, orderBy: { name: "asc" } });
  return (
    <div className="stack gap-4">
      <Reveal label="+ New framework">
        <Panel title="New competency framework" subtitle="The skills a role needs, and at what level">
          <GrowthForm action={saveFrameworkAction} submitLabel="Create" fields={[
            { name: "name", label: "Name", required: true, placeholder: "Software Engineer" },
            { name: "jobTitle", label: "Job title it describes", type: "select", options: titles.map((x) => ({ value: x.name, label: x.name })), hint: "People with this job title are measured against it" },
            { name: "description", label: "Description", type: "textarea" },
          ]} />
        </Panel>
      </Reveal>
      {frameworks.length === 0 ? <Panel><EmptyState title="No frameworks yet" /></Panel> : frameworks.map((f) => {
        const editable = f.status === "DRAFT" || f.status === "REJECTED";
        return (
          <Panel key={f.id} title={`${f.name} · v${f.version}`} subtitle={`${f.jobTitle ? `For ${f.jobTitle} · ` : ""}${f.items.length} skills${f.decisionNote ? ` · note: ${f.decisionNote}` : ""}`} action={<span className="row gap-1 wrap">
            <Badge tone={STATUS_TONE[f.status]} dot>{f.status.toLowerCase()}</Badge>
            <ReviewButtons action={frameworkReviewAction} hidden={{ frameworkId: f.id }} status={f.status} submittedByMe={f.submittedBy === me} />
            {f.status === "APPROVED" ? <ActButton action={frameworkReviewAction} hidden={{ frameworkId: f.id, op: "version" }} label="New version" /> : null}
            {f.status === "APPROVED" && f.jobTitle ? <Link className="btn sm" href={`/performance/skills?tab=reports&report=gaps&frameworkId=${f.id}`}>Gap report</Link> : null}
            {f.status === "DRAFT" ? <ActButton action={deleteFrameworkAction} hidden={{ frameworkId: f.id }} label="Delete" variant="ghost" confirmText="Delete this draft?" /> : null}
          </span>}>
            {f.items.length === 0 ? <div className="text-sm subtle">No skills yet.</div> : (
              <table className="data">
                <thead><tr><th>Skill</th><th>Required level</th><th className="num">Weight</th><th>Critical</th>{editable ? <th /> : null}</tr></thead>
                <tbody>
                  {f.items.map((i) => (
                    <tr key={i.id}>
                      <td className="text-sm">{i.skill.name}</td>
                      <td className="text-sm">{levelsOf(i.skill.levels)[i.requiredLevel] ?? i.requiredLevel}</td>
                      <td className="num">{i.weight}</td>
                      <td className="text-sm">{i.isCritical ? "Yes" : "No"}</td>
                      {editable ? <td className="right"><ActButton action={frameworkItemAction} hidden={{ frameworkId: f.id, skillId: i.skillId, op: "remove" }} label="Remove" variant="ghost" /></td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {editable ? (
              <div style={{ marginTop: 10 }}>
                <GrowthForm action={frameworkItemAction} hidden={{ frameworkId: f.id, op: "add" }} cols={4} compact submitLabel="Add / update skill" fields={[
                  { name: "skillId", label: "Skill", type: "select", required: true, options: skills.map((s) => ({ value: s.id, label: s.name })) },
                  { name: "requiredLevel", label: "Required level (0 = first)", type: "number", min: 0, max: 9, defaultValue: 1 },
                  { name: "weight", label: "Weight (1–5)", type: "number", min: 1, max: 5, defaultValue: 1 },
                  { name: "isCritical", label: "Critical for the role", type: "checkbox" },
                ]} />
                <Reveal label="Edit details">
                  <GrowthForm action={saveFrameworkAction} hidden={{ id: f.id }} compact fields={[
                    { name: "name", label: "Name", required: true, defaultValue: f.name },
                    { name: "jobTitle", label: "Job title", type: "select", options: titles.map((x) => ({ value: x.name, label: x.name })), defaultValue: f.jobTitle },
                    { name: "description", label: "Description", type: "textarea", defaultValue: f.description },
                  ]} />
                </Reveal>
              </div>
            ) : null}
          </Panel>
        );
      })}
    </div>
  );
}

async function Scales({ tenantId, me, skills }: { tenantId: string; me: string; skills: SkillRow[] }) {
  const scales = await prisma.proficiencyScale.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  return (
    <div className="stack gap-4">
      <Reveal label="+ New scale">
        <Panel title="New proficiency scale" subtitle="A reusable ladder of levels; once approved it can be applied to skills">
          <GrowthForm action={saveScaleAction} submitLabel="Create" cols={2} fields={[
            { name: "name", label: "Name", required: true, placeholder: "Five-step technical" },
            { name: "levels", label: "Levels, one per line", type: "textarea", required: true },
            { name: "descriptions", label: "What each level means, one per line", type: "textarea" },
          ]} />
        </Panel>
      </Reveal>
      {scales.length === 0 ? <Panel><EmptyState title="No scales yet" /></Panel> : scales.map((s) => (
        <Panel key={s.id} title={s.name} subtitle={s.levels.map((l, i) => `${l}${s.descriptions[i] ? ` — ${s.descriptions[i]}` : ""}`).join(" · ")} action={<span className="row gap-1 wrap">
          <Badge tone={STATUS_TONE[s.status]} dot>{s.status.toLowerCase()}</Badge>
          <ReviewButtons action={scaleReviewAction} hidden={{ scaleId: s.id }} status={s.status} submittedByMe={s.submittedBy === me} />
        </span>}>
          {s.status === "APPROVED" ? (
            <GrowthForm action={applyScaleAction} hidden={{ scaleId: s.id }} cols={2} compact submitLabel="Apply to skill" fields={[{ name: "skillId", label: "Skill", type: "select", required: true, options: skills.map((k) => ({ value: k.id, label: k.name })) }]} />
          ) : s.status === "DRAFT" || s.status === "REJECTED" ? (
            <Reveal label="Edit">
              <GrowthForm action={saveScaleAction} hidden={{ id: s.id }} cols={2} compact fields={[
                { name: "name", label: "Name", required: true, defaultValue: s.name },
                { name: "levels", label: "Levels, one per line", type: "textarea", defaultValue: s.levels.join("\n") },
                { name: "descriptions", label: "Descriptions, one per line", type: "textarea", defaultValue: s.descriptions.join("\n") },
              ]} />
            </Reveal>
          ) : null}
        </Panel>
      ))}
    </div>
  );
}

async function Reports({ viewer, kind, frameworkId }: { viewer: Awaited<ReturnType<typeof requireAuth>>; kind: SkillReportKind; frameworkId?: string }) {
  const [report, frameworks] = await Promise.all([
    skillsReport(viewer, kind, frameworkId),
    prisma.competencyFramework.findMany({ where: { tenantId: viewer.tenantId, status: "APPROVED" }, select: { id: true, name: true, version: true } }),
  ]);
  const extra = kind === "gaps" ? (
    <form className="row gap-1">
      <input type="hidden" name="tab" value="reports" /><input type="hidden" name="report" value="gaps" />
      <select className="select" name="frameworkId" defaultValue={frameworkId ?? ""} style={{ height: 30 }}>
        <option value="">All approved frameworks</option>{frameworks.map((f) => <option key={f.id} value={f.id}>{f.name} v{f.version}</option>)}
      </select>
      <button className="btn sm">Show</button>
    </form>
  ) : null;
  return <ReportView report={report} base="/performance/skills?tab=reports" kinds={SKILL_REPORTS} kind={kind} extra={extra} exportHref={`/performance/skills/export?kind=${kind}${frameworkId ? `&frameworkId=${frameworkId}` : ""}`} />;
}
