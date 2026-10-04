import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar } from "@/components/workforce-tables";
import { saveJobFamilyAction, saveJobLevelAction, submitArchitectureAction, retireArchitectureAction } from "@/app/actions/positions";

const P = PERMISSIONS;

export default async function ArchitecturePage({ searchParams }: { searchParams: Promise<{ q?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.POSITION_VIEW);
  const sp = await searchParams;
  const q = sp.q?.trim().toLowerCase() ?? "";
  const canManage = can(viewer, P.POSITION_MANAGE);
  const [families, levels, jobs, bands, grades] = await Promise.all([
    prisma.jobFamily.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { jobs: true } } }, orderBy: { name: "asc" } }),
    prisma.jobLevel.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { jobs: true } } }, orderBy: { rank: "asc" } }),
    prisma.jobProfile.findMany({ where: { tenantId: viewer.tenantId, status: { not: "RETIRED" } }, select: { familyId: true, levelId: true } }),
    prisma.band.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { rank: "asc" } }),
    prisma.payGrade.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
  ]);
  const match = (s: string | null | undefined) => !q || (s ?? "").toLowerCase().includes(q);
  const famRows = families.filter((f) => match(f.name) || match(f.code) || match(f.description));
  const lvlRows = levels.filter((l) => match(l.name) || match(l.code) || match(l.careerDefinition));
  const editF = families.find((f) => f.id === sp.edit);
  const editL = levels.find((l) => l.id === sp.edit);
  const famName = new Map(families.map((f) => [f.id, f.name]));
  const depth = (f: { parentId: string | null }) => { let d = 0; let c = f.parentId; while (c && d < 10) { d++; c = families.find((x) => x.id === c)?.parentId ?? null; } return d; };
  // Families listed parent-first, so the tree reads top-down.
  const ordered: typeof famRows = [];
  const walk = (parent: string | null) => { for (const f of famRows.filter((x) => x.parentId === parent)) { ordered.push(f); walk(f.id); } };
  walk(null);
  for (const f of famRows) if (!ordered.includes(f)) ordered.push(f);
  const actions = (kind: "family" | "level", r: { id: string; status: string }) => canManage ? (
    <div className="row gap-2">
      <Link className="btn sm" href={`/positions/architecture?edit=${r.id}`}>Edit</Link>
      {r.status === "DRAFT" || r.status === "REJECTED" ? <ActionButton action={submitArchitectureAction} hidden={{ kind, id: r.id }} label="Submit" variant="primary" /> : null}
      {r.status === "ACTIVE" ? <ActionButton action={retireArchitectureAction} hidden={{ kind, id: r.id }} label="Retire" confirmText="Retire it?" /> : null}
    </div>
  ) : null;

  return (
    <>
      <PageHead title="Job families & levels" subtitle="The job architecture: nested job families crossed with ranked career levels. New entries are approved before use." actions={<><a className="btn sm" href="/positions/export?report=families">Families CSV</a><a className="btn sm" href="/positions/export?report=levels">Levels CSV</a></>} />
      <FilterBar action="/positions/architecture"><F label="Search"><input className="input" name="q" defaultValue={sp.q} placeholder="Name, code or description" /></F></FilterBar>
      <div className="grid grid-2">
        <Card title="Job families">
          {canManage ? (
            <Disclosure label={editF ? `Edit ${editF.name}` : "New family"} defaultOpen={!!editF}>
              <SimpleForm action={saveJobFamilyAction} hidden={editF ? { id: editF.id } : undefined}>
                <F label="Name *"><input className="input" name="name" required defaultValue={editF?.name} /></F>
                <F label="Code"><input className="input" name="code" defaultValue={editF?.code ?? undefined} /></F>
                <F label="Parent family"><Select name="parentId" options={families.filter((f) => f.id !== editF?.id).map((f) => ({ value: f.id, label: f.name }))} defaultValue={editF?.parentId} placeholder="— Top level —" /></F>
                <F label="Description"><textarea className="textarea" name="description" defaultValue={editF?.description ?? undefined} /></F>
              </SimpleForm>
            </Disclosure>
          ) : null}
          {ordered.length === 0 ? <Empty title="No job families yet." /> : (
            <table className="data" style={{ marginTop: 12 }}><thead><tr><th>Family</th><th>Status</th><th className="num">Jobs</th><th /></tr></thead>
              <tbody>{ordered.map((f) => (
                <tr key={f.id}><td style={{ paddingLeft: 8 + depth(f) * 18 }}>{f.name}{f.code ? <span className="muted text-xs"> {f.code}</span> : null}{f.parentId ? <div className="text-xs muted">under {famName.get(f.parentId)}</div> : null}</td>
                  <td><StatusPill status={f.status} /></td><td className="num">{f._count.jobs}</td><td>{actions("family", f)}</td></tr>
              ))}</tbody></table>
          )}
        </Card>
        <Card title="Job levels" description="Career level definitions, mapped to bands and pay grades.">
          {canManage ? (
            <Disclosure label={editL ? `Edit ${editL.name}` : "New level"} defaultOpen={!!editL}>
              <SimpleForm action={saveJobLevelAction} hidden={editL ? { id: editL.id } : undefined}>
                <div className="grid grid-2">
                  <F label="Name *"><input className="input" name="name" required defaultValue={editL?.name} /></F>
                  <F label="Code"><input className="input" name="code" defaultValue={editL?.code ?? undefined} /></F>
                  <F label="Rank (seniority)"><input className="input" type="number" name="rank" min={0} max={100} defaultValue={editL?.rank ?? 0} /></F>
                  <F label="Track"><Select name="track" options={[{ value: "IC", label: "Individual contributor" }, { value: "MANAGER", label: "Manager" }, { value: "EXECUTIVE", label: "Executive" }]} defaultValue={editL?.track ?? "IC"} /></F>
                  <F label="Band"><Select name="bandId" options={bands.map((b) => ({ value: b.id, label: b.name }))} defaultValue={editL?.bandId} placeholder="—" /></F>
                  <F label="Pay grade"><Select name="payGradeId" options={grades.map((g) => ({ value: g.id, label: g.name }))} defaultValue={editL?.payGradeId} placeholder="—" /></F>
                </div>
                <F label="Career level definition"><textarea className="textarea" name="careerDefinition" defaultValue={editL?.careerDefinition ?? undefined} /></F>
              </SimpleForm>
            </Disclosure>
          ) : null}
          {lvlRows.length === 0 ? <Empty title="No job levels yet." /> : (
            <table className="data" style={{ marginTop: 12 }}><thead><tr><th>Rank</th><th>Level</th><th>Track</th><th>Definition</th><th>Status</th><th /></tr></thead>
              <tbody>{lvlRows.map((l) => (
                <tr key={l.id}><td>{l.rank}</td><td>{l.name}{l.code ? <span className="muted text-xs"> {l.code}</span> : null}<div className="text-xs muted">{bands.find((b) => b.id === l.bandId)?.name ?? ""} {grades.find((g) => g.id === l.payGradeId)?.name ?? ""}</div></td>
                  <td className="text-xs">{l.track}</td><td className="text-xs">{l.careerDefinition}</td><td><StatusPill status={l.status} /></td><td>{actions("level", l)}</td></tr>
              ))}</tbody></table>
          )}
        </Card>
      </div>
      <Card title="Architecture matrix" description="Jobs per family and level.">
        {families.length === 0 || levels.length === 0 ? <Empty title="Add families and levels to see the matrix." /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Family \ Level</th>{levels.map((l) => <th key={l.id} className="num">{l.name}</th>)}</tr></thead>
            <tbody>{families.map((f) => <tr key={f.id}><td>{f.name}</td>{levels.map((l) => <td key={l.id} className="num">{jobs.filter((j) => j.familyId === f.id && j.levelId === l.id).length || ""}</td>)}</tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
