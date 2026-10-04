import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar } from "@/components/workforce-tables";
import { saveJobAction } from "@/app/actions/positions";
import { JobFields } from "./fields";

const P = PERMISSIONS;

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; familyId?: string; levelId?: string }> }) {
  const viewer = await requireAuth(P.POSITION_VIEW);
  const sp = await searchParams;
  const q = sp.q?.trim();
  const [jobs, families, levels, titles] = await Promise.all([
    prisma.jobProfile.findMany({
      where: {
        tenantId: viewer.tenantId,
        ...(sp.status ? { status: sp.status as never } : {}), ...(sp.familyId ? { familyId: sp.familyId } : {}), ...(sp.levelId ? { levelId: sp.levelId } : {}),
        ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { competencies: { has: q } }, { skills: { has: q } }, { summary: { contains: q, mode: "insensitive" } }] } : {}),
      },
      include: { family: { select: { name: true } }, level: { select: { name: true } }, _count: { select: { positions: true } } },
      orderBy: { code: "asc" },
    }),
    prisma.jobFamily.findMany({ where: { tenantId: viewer.tenantId, status: { not: "RETIRED" } }, orderBy: { name: "asc" } }),
    prisma.jobLevel.findMany({ where: { tenantId: viewer.tenantId, status: { not: "RETIRED" } }, orderBy: { rank: "asc" } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const opts = {
    families: families.map((f) => ({ value: f.id, label: `${f.name}${f.status !== "ACTIVE" ? ` (${f.status.toLowerCase()})` : ""}` })),
    levels: levels.map((l) => ({ value: l.id, label: `${l.name}${l.status !== "ACTIVE" ? ` (${l.status.toLowerCase()})` : ""}` })),
    titles: titles.map((t) => ({ value: t.id, label: t.name })),
  };
  return (
    <>
      <PageHead title="Job catalogue" subtitle="Jobs describe the work; positions are the seats that use them. Descriptions are versioned and approved." actions={<a className="btn sm" href="/positions/export?report=jobs">Export CSV</a>} />
      {can(viewer, P.POSITION_MANAGE) ? (
        <Card title="Add a job">
          <Disclosure label="New job">
            <SimpleForm action={saveJobAction} submitLabel="Create job"><JobFields opts={opts} /></SimpleForm>
          </Disclosure>
        </Card>
      ) : null}
      <Card title="Jobs">
        <FilterBar action="/positions/jobs">
          <F label="Search"><input className="input" name="q" defaultValue={sp.q} placeholder="Code, title, skill or competency" /></F>
          <F label="Status"><Select name="status" options={["DRAFT", "PENDING_APPROVAL", "ACTIVE", "REJECTED", "RETIRED"].map((s) => ({ value: s, label: s.toLowerCase().replace("_", " ") }))} defaultValue={sp.status} placeholder="Any" /></F>
          <F label="Family"><Select name="familyId" options={opts.families} defaultValue={sp.familyId} placeholder="Any" /></F>
          <F label="Level"><Select name="levelId" options={opts.levels} defaultValue={sp.levelId} placeholder="Any" /></F>
        </FilterBar>
        {jobs.length === 0 ? <Empty title="No jobs match." /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Code</th><th>Title</th><th>Family</th><th>Level</th><th>Competencies</th><th>Version</th><th>Status</th><th className="num">Positions</th></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id}>
                <td className="mono"><Link href={`/positions/jobs/${j.id}`}>{j.code}</Link></td><td>{j.title}</td><td>{j.family?.name ?? "—"}</td><td>{j.level?.name ?? "—"}</td>
                <td className="text-xs">{j.competencies.join(", ")}</td><td>v{j.version}</td><td><StatusPill status={j.status} /></td><td className="num">{j._count.positions}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
