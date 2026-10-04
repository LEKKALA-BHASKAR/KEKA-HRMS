import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { careerGap, placeOnPath } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Person, Progress } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import {
  RateSkill, RejectSkill, SkillForm, PathForm, StepForm, StepSkillForm, RemoveStepSkill,
} from "../../me/career/forms";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReviewButtons } from "@/components/growth-report";
import { careerPathReviewAction, updateCareerPathAction, deleteCareerPathAction, updateCareerStepAction } from "@/app/actions/mobility";

const P = PERMISSIONS;
const DEFAULT_LEVELS = ["Beginner", "Working knowledge", "Proficient", "Expert"];
const levelsOf = (raw: unknown) => (Array.isArray(raw) && raw.length ? (raw as string[]) : DEFAULT_LEVELS);

type Tab = "team" | "paths" | "catalogue";

export default async function CareersAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string; skill?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const isManager = viewer.allReportIds.size > 0;
  const manageSkills = can(viewer, P.SKILL_MANAGE);
  const managePaths = can(viewer, P.CAREER_PATH_MANAGE);
  if (!isManager && !manageSkills && !managePaths) forbidden();

  const tabs: Array<{ key: Tab; label: string }> = [
    ...(isManager || manageSkills ? [{ key: "team" as const, label: manageSkills ? "People's skills" : "My team's skills" }] : []),
    { key: "paths", label: "Career paths" },
    ...(manageSkills ? [{ key: "catalogue" as const, label: "Skill catalogue" }] : []),
  ];
  const tab: Tab = tabs.find((t) => t.key === sp.tab)?.key ?? tabs[0].key;

  const [skills, paths, departments] = await Promise.all([
    prisma.skill.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: [{ category: "asc" }, { name: "asc" }], include: { _count: { select: { employeeSkills: true } } } }),
    prisma.careerPath.findMany({
      where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" },
      include: { steps: { orderBy: { sequence: "asc" }, include: { skills: { include: { skill: true } }, _count: { select: { aspirants: true } } } } },
    }),
    managePaths ? prisma.department.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const skillOptions = skills.map((s) => ({ id: s.id, name: s.name, levels: levelsOf(s.levels) }));

  // People: direct and indirect reports for a manager, everyone in scope for a skills admin.
  const people = tab === "team"
    ? await prisma.employee.findMany({
        where: {
          ...(manageSkills ? scopedEmployeeWhere(viewer, P.SKILL_MANAGE) : { tenantId: viewer.tenantId, id: { in: [...viewer.allReportIds] } }),
          status: { notIn: ["EXITED", "INACTIVE"] },
          ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}),
        },
        select: {
          id: true, displayName: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } },
          employeeSkills: { include: { skill: true } }, careerAspiration: { include: { step: { include: { skills: true } } } },
        },
        orderBy: { firstName: "asc" },
      })
    : [];
  const pending = people.flatMap((p) => p.employeeSkills.filter((s) => !s.isApproved).map((s) => ({ person: p, row: s })));
  const matrixSkill = skills.find((s) => s.id === sp.skill) ?? null;

  return (
    <>
      <PageHead title="Skills & Career Paths" subtitle="Confirm skills, define the ladders people climb, and see who is ready for what" />
      <div className="tabs">
        {tabs.map((t) => <Link key={t.key} href={`/performance/careers?tab=${t.key}`} className={`tab${tab === t.key ? " active" : ""}`}>{t.label}{t.key === "team" && pending.length ? ` (${pending.length})` : ""}</Link>)}
      </div>

      {tab === "team" ? (
        <div className="stack gap-4">
          <Panel title={`Waiting for confirmation (${pending.length})`} subtitle="Self-rated skills only count towards readiness once confirmed" pad={false}>
            {pending.length === 0 ? <EmptyState title="Nothing to review" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Skill</th><th>Self-rated</th><th>Confirm at</th><th /></tr></thead>
                  <tbody>
                    {pending.map(({ person, row }) => (
                      <tr key={row.id}>
                        <td><Person name={person.displayName ?? ""} meta={person.jobTitleName ?? undefined} /></td>
                        <td className="strong">{row.skill.name}</td>
                        <td className="text-sm">{levelsOf(row.skill.levels)[row.level]}</td>
                        <td><RateSkill employeeId={person.id} skillId={row.skillId} levels={levelsOf(row.skill.levels)} current={row.level} /></td>
                        <td className="right"><RejectSkill id={row.id} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Readiness" subtitle="Against the role each person is working towards, or the next rung on their ladder" pad={false}>
            {people.length === 0 ? <EmptyState title="Nobody in view" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Current role</th><th>Working towards</th><th style={{ minWidth: 150 }}>Readiness</th><th className="num">Skills</th></tr></thead>
                  <tbody>
                    {people.map((p) => {
                      let target: { title: string; skills: Array<{ skillId: string; level: number }> } | null = p.careerAspiration?.step ?? null;
                      if (!target) {
                        for (const path of paths) {
                          const here = placeOnPath(path.steps, p.jobTitleName);
                          const next = here ? path.steps.find((s) => s.sequence === here.sequence + 1) : null;
                          if (next) { target = next; break; }
                        }
                      }
                      const gap = target ? careerGap(target.skills, p.employeeSkills) : null;
                      return (
                        <tr key={p.id}>
                          <td><Person name={p.displayName ?? ""} meta={`${p.employeeNumber} · ${p.department?.name ?? "—"}`} /></td>
                          <td className="text-sm">{p.jobTitleName ?? "—"}</td>
                          <td className="text-sm">{target ? <>{target.title}{p.careerAspiration ? <span className="text-xs subtle"> · chosen</span> : null}</> : <span className="subtle">—</span>}</td>
                          <td>{gap && gap.total > 0 ? <div className="row gap-2"><div style={{ flex: 1 }}><Progress value={gap.readiness} max={100} tone={gap.readiness === 100 ? "success" : undefined} /></div><span className="num text-xs">{gap.readiness}%</span></div> : <span className="subtle text-xs">—</span>}</td>
                          <td className="num">{p.employeeSkills.filter((s) => s.isApproved).length}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Skill matrix" subtitle="Pick a skill to see and set everyone's level"
            action={
              <form className="row gap-2">
                <input type="hidden" name="tab" value="team" />
                <select name="skill" className="select" defaultValue={matrixSkill?.id ?? ""} aria-label="Skill">
                  <option value="">Choose a skill…</option>
                  {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button className="btn sm">Show</button>
              </form>
            } pad={false}>
            {!matrixSkill ? <div style={{ padding: 14 }} className="text-sm muted">Choose a skill above.</div> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Current level</th><th>Set level</th></tr></thead>
                  <tbody>
                    {people.map((p) => {
                      const row = p.employeeSkills.find((s) => s.skillId === matrixSkill.id);
                      const lv = levelsOf(matrixSkill.levels);
                      return (
                        <tr key={p.id}>
                          <td><Person name={p.displayName ?? ""} meta={p.jobTitleName ?? undefined} size="sm" /></td>
                          <td className="text-sm">{row ? <>{lv[row.level]} {row.isApproved ? null : <Badge tone="warning">unconfirmed</Badge>}</> : <span className="subtle">Not recorded</span>}</td>
                          <td><RateSkill employeeId={p.id} skillId={matrixSkill.id} levels={lv} current={row?.level ?? null} label="Save" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === "paths" ? (
        <div className="stack gap-4">
          {managePaths ? <Panel title="New career path"><PathForm departments={departments.map((d) => ({ value: d.id, label: d.name }))} /></Panel> : null}
          {paths.length === 0 ? <Panel><EmptyState title="No career paths yet" /></Panel> : paths.map((path) => (
            <Panel key={path.id} title={path.name} subtitle={`${path.description ?? `${path.steps.length} steps`}${path.decisionNote ? ` · note: ${path.decisionNote}` : ""}`} action={<span className="row gap-1 wrap">
              <Badge tone={STATUS_TONE[path.status] ?? "neutral"} dot>{path.status.toLowerCase()}</Badge>
              {managePaths ? <ReviewButtons action={careerPathReviewAction} hidden={{ pathId: path.id }} status={path.status} submittedByMe={path.submittedBy === viewer.user.id} /> : null}
              {managePaths && path.status === "DRAFT" ? <ActButton action={deleteCareerPathAction} hidden={{ pathId: path.id }} label="Delete" variant="ghost" confirmText="Delete this draft path?" /> : null}
            </span>}>
              {managePaths ? (
                <Reveal label="Edit path">
                  <GrowthForm action={updateCareerPathAction} hidden={{ pathId: path.id }} cols={2} compact fields={[
                    { name: "name", label: "Name", required: true, defaultValue: path.name },
                    { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })), defaultValue: path.departmentId },
                    { name: "description", label: "Description", type: "textarea", defaultValue: path.description },
                  ]} />
                </Reveal>
              ) : null}
              <div className="stack gap-3">
                {path.steps.map((step) => (
                  <div key={step.id} className="career-step">
                    <div className="row gap-2 wrap" style={{ marginBottom: 6 }}>
                      <span className="career-step-num">{step.sequence}</span>
                      <span className="strong">{step.title}</span>
                      {step.minYears ? <span className="text-xs subtle">typically {step.minYears}+ yrs</span> : null}
                      {step._count.aspirants ? <Badge tone="info">{step._count.aspirants} working towards this</Badge> : null}
                    </div>
                    {step.description ? <div className="text-sm muted" style={{ marginBottom: 6 }}>{step.description}</div> : null}
                    <div className="row gap-2 wrap" style={{ marginBottom: managePaths ? 8 : 0 }}>
                      {step.skills.length === 0 ? <span className="text-xs subtle">No skills required yet</span> : step.skills.map((ss) => (
                        <span key={ss.id} className="skill-chip">{ss.skill.name} · {levelsOf(ss.skill.levels)[ss.level]}{managePaths ? <RemoveStepSkill id={ss.id} /> : null}</span>
                      ))}
                    </div>
                    {managePaths && skillOptions.length ? <StepSkillForm stepId={step.id} skills={skillOptions} /> : null}
                    {managePaths ? (
                      <span className="row gap-1" style={{ marginTop: 6 }}>
                        <Reveal label="Edit step">
                          <GrowthForm action={updateCareerStepAction} hidden={{ stepId: step.id, op: "edit" }} cols={2} compact fields={[
                            { name: "title", label: "Title", required: true, defaultValue: step.title },
                            { name: "minYears", label: "Typical years", type: "number", min: 0, max: 40, defaultValue: step.minYears },
                            { name: "description", label: "Description", type: "textarea", defaultValue: step.description },
                          ]} />
                        </Reveal>
                        <ActButton action={updateCareerStepAction} hidden={{ stepId: step.id, op: "delete" }} label="Delete step" variant="ghost" confirmText="Delete this step?" />
                      </span>
                    ) : null}
                  </div>
                ))}
                {managePaths ? <div><div className="label">Add the next step</div><StepForm pathId={path.id} /></div> : null}
              </div>
            </Panel>
          ))}
        </div>
      ) : null}

      {tab === "catalogue" ? (
        <div className="stack gap-4">
          <Panel title="Add a skill"><SkillForm /></Panel>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Skill</th><th>Category</th><th>Levels</th><th className="num">People</th></tr></thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.id}>
                      <td className="strong"><Link href={`/performance/careers?tab=team&skill=${s.id}`}>{s.name}</Link></td>
                      <td className="text-sm">{s.category ?? "—"}</td>
                      <td className="text-sm">{levelsOf(s.levels).join(" → ")}</td>
                      <td className="num">{s._count.employeeSkills}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
