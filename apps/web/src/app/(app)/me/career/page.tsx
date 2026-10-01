import Link from "next/link";
import { prisma } from "@keka/db";
import { careerGap, placeOnPath, yearsBetween } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Badge, Progress } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { AddMySkill, RemoveMySkill, AspirationForm } from "./forms";

const DEFAULT_LEVELS = ["Beginner", "Working knowledge", "Proficient", "Expert"];
const levelsOf = (raw: unknown) => (Array.isArray(raw) && raw.length ? (raw as string[]) : DEFAULT_LEVELS);
const SOURCE: Record<string, string> = { SELF: "Self-rated", MANAGER: "Manager", COURSE_COMPLETION: "Course", IMPORT: "Imported" };

/** Skill dots: filled up to the level held, out of the skill's levels. */
function LevelDots({ level, of }: { level: number | null; of: number }) {
  return (
    <span className="row gap-1" aria-label={level === null ? "Not held" : `Level ${level + 1} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: level !== null && i <= level ? "var(--brand-500)" : "var(--surface-sunken)", border: "1px solid var(--border)" }} />
      ))}
    </span>
  );
}

export default async function MyCareerPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <EmptyState title="No employee record">This login is not linked to an employee.</EmptyState>;
  const myId = viewer.employee.id;

  const [me, mySkills, catalogue, paths, aspiration] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: myId }, select: { jobTitleName: true, dateOfJoining: true, departmentId: true } }),
    prisma.employeeSkill.findMany({ where: { employeeId: myId }, include: { skill: true }, orderBy: [{ isApproved: "desc" }, { level: "desc" }] }),
    prisma.skill.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: [{ category: "asc" }, { name: "asc" }] }),
    prisma.careerPath.findMany({
      where: { tenantId: viewer.tenantId },
      include: { steps: { orderBy: { sequence: "asc" }, include: { skills: { include: { skill: true } } } } },
      orderBy: { name: "asc" },
    }),
    prisma.careerAspiration.findUnique({ where: { employeeId: myId }, include: { step: { include: { path: true, skills: { include: { skill: true } } } } } }),
  ]);

  // Where am I now? The first ladder with a rung matching my job title.
  let placed: { path: (typeof paths)[number]; step: (typeof paths)[number]["steps"][number] } | null = null;
  for (const p of paths) {
    const step = placeOnPath(p.steps, me.jobTitleName);
    if (step) { placed = { path: p, step }; break; }
  }
  const nextStep = placed ? placed.path.steps.find((s) => s.sequence === placed!.step.sequence + 1) ?? null : null;
  const target = aspiration?.step ?? nextStep;
  const targetPath = aspiration?.step.path ?? placed?.path ?? null;
  const gap = target ? careerGap(target.skills.map((s) => ({ skillId: s.skillId, level: s.level })), mySkills) : null;
  const gapSkillIds = gap ? gap.rows.filter((r) => !r.met).map((r) => r.skillId) : [];
  const courses = gapSkillIds.length
    ? (await prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED", skillId: { in: gapSkillIds } }, select: { id: true, title: true, skillId: true, skillLevel: true, skill: { select: { name: true, levels: true } } } }))
        // Only courses that would raise the confirmed level actually close the gap.
        .filter((c) => c.skillLevel > (mySkills.find((m) => m.skillId === c.skillId && m.isApproved)?.level ?? -1))
    : [];
  const held = new Set(mySkills.map((s) => s.skillId));
  const experience = Math.floor(yearsBetween(me.dateOfJoining, new Date()) * 10) / 10;

  return (
    <>
      <PageHead title="Skills & Career" subtitle="What you are good at, where you are on your career path, and what it takes to grow" />

      <div className="grid grid-2" style={{ marginBottom: 18, alignItems: "start" }}>
        <Panel title="Your career path" subtitle={placed ? `${placed.path.name} · you are a ${placed.step.title}` : me.jobTitleName ? `No ladder lists “${me.jobTitleName}” yet` : "No job title on your record"}>
          {placed ? (
            <ol className="career-ladder">
              {placed.path.steps.map((s) => (
                <li key={s.id} className={s.id === placed!.step.id ? "here" : s.sequence < placed!.step.sequence ? "past" : target?.id === s.id ? "target" : ""}>
                  <span className="strong text-sm">{s.title}</span>
                  {s.id === placed!.step.id ? <Badge tone="brand">You are here</Badge> : target?.id === s.id ? <Badge tone="success">Next goal</Badge> : null}
                  {s.minYears ? <span className="text-xs subtle"> · typically {s.minYears}+ yrs</span> : null}
                </li>
              ))}
            </ol>
          ) : <div className="text-sm muted">HR has not published a career path for your role. You can still pick a goal from any path below.</div>}
          <div className="label" style={{ marginTop: 14 }}>The role you are working towards</div>
          <AspirationForm
            current={aspiration?.stepId ?? null}
            steps={paths.flatMap((p) => p.steps.map((s) => ({ value: s.id, label: `${p.name} → ${s.title}` })))}
          />
          {!aspiration && nextStep ? <div className="text-xs subtle" style={{ marginTop: 4 }}>Until you choose, the next rung on your ladder is used.</div> : null}
        </Panel>

        <Panel title={target ? `Readiness for ${target.title}` : "Readiness"} subtitle={target ? `${targetPath?.name ?? ""}${target.minYears ? ` · typically ${target.minYears}+ years; you have ${experience} here` : ""}` : undefined}>
          {!target || !gap ? <div className="text-sm muted">Choose a target role to see the skills it needs.</div> : (
            <>
              <div className="row gap-3" style={{ marginBottom: 12 }}>
                <div style={{ flex: 1 }}><Progress value={gap.readiness} max={100} tone={gap.readiness === 100 ? "success" : undefined} /></div>
                <span className="strong">{gap.readiness}%</span>
                <span className="text-xs subtle">{gap.met} of {gap.total} skills</span>
              </div>
              {gap.total === 0 ? <div className="text-sm muted">No skills are listed for this role yet.</div> : (
                <table className="data">
                  <thead><tr><th>Skill</th><th>Needed</th><th>You</th><th /></tr></thead>
                  <tbody>
                    {target.skills.map((req) => {
                      const row = gap.rows.find((r) => r.skillId === req.skillId)!;
                      const lv = levelsOf(req.skill.levels);
                      const mine = mySkills.find((m) => m.skillId === req.skillId);
                      return (
                        <tr key={req.id}>
                          <td className="text-sm">{req.skill.name}</td>
                          <td className="text-sm">{lv[req.level]}</td>
                          <td className="text-sm">{mine ? <>{lv[mine.level]}{!mine.isApproved ? <span className="subtle text-xs"> (awaiting approval)</span> : null}</> : <span className="subtle">—</span>}</td>
                          <td>{row.met ? <Badge tone="success">Met</Badge> : <Badge tone="warning">Gap</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {courses.length ? (
                <div style={{ marginTop: 12 }}>
                  <div className="label">Courses that close the gap</div>
                  <ul className="stack gap-1" style={{ margin: 0, paddingLeft: 18 }}>
                    {courses.map((c) => <li key={c.id} className="text-sm"><Link href={`/learn/courses/${c.id}`}>{c.title}</Link> <span className="subtle text-xs">· {c.skill?.name} to {levelsOf(c.skill?.levels)[c.skillLevel]}</span></li>)}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </Panel>
      </div>

      <SectionTitle sub="Skills confirmed by your manager or earned through courses count towards readiness">My skills</SectionTitle>
      <Panel pad={false}>
        {mySkills.length === 0 ? <EmptyState title="No skills on your profile yet">Add the skills you use at work below.</EmptyState> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Skill</th><th>Category</th><th>Level</th><th>Source</th><th>Status</th><th /></tr></thead>
              <tbody>
                {mySkills.map((s) => {
                  const lv = levelsOf(s.skill.levels);
                  return (
                    <tr key={s.id}>
                      <td className="strong">{s.skill.name}</td>
                      <td className="text-sm">{s.skill.category ?? "—"}</td>
                      <td><div className="row gap-2"><LevelDots level={s.level} of={lv.length} /><span className="text-sm">{lv[s.level]}</span></div></td>
                      <td className="text-sm">{SOURCE[s.source] ?? s.source}</td>
                      <td>{s.isApproved ? <Badge tone="success" dot>Confirmed</Badge> : <Badge tone="warning" dot>Awaiting manager</Badge>}</td>
                      <td className="right">{!s.isApproved ? <RemoveMySkill id={s.id} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
          <div className="label">Add a skill</div>
          <AddMySkill skills={catalogue.filter((c) => !held.has(c.id)).map((c) => ({ id: c.id, name: c.name, levels: levelsOf(c.levels) }))} />
        </div>
      </Panel>
    </>
  );
}
