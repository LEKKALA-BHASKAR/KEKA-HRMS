import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireStringList } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { createProjectAction } from "@/app/actions/hire-sourcing";
import { userOptions } from "@/lib/hire-depth";
import { SourcingTabs, day } from "../../_parts/depth-tabs";

export const metadata = { title: "Sourcing projects · Hire" };

/** Sourcing projects: a shared list of prospects for a role, worked by a team of recruiters. */
export default async function SourcingProjectsPage() {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const [projects, jobs, users] = await Promise.all([
    prisma.sourcingProject.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { prospects: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN" }, select: { id: true, title: true } }),
    userOptions(viewer),
  ]);
  const jobName = new Map(jobs.map((j) => [j.id, j.title]));
  return (
    <>
      <SourcingTabs />
      <PageHead title="Sourcing projects" subtitle="Collaborate on a list of prospects for a role." />
      <Reveal label="New project">
        <Card>
          <GrowthForm action={createProjectAction} cols={2} submitLabel="Create" fields={[
            { name: "name", label: "Name", required: true }, { name: "jobId", label: "For job", type: "select", options: jobs.map((j) => ({ value: j.id, label: j.title })) },
            { name: "description", label: "Brief", type: "textarea" },
            { name: "memberUserIds", label: "Collaborators", type: "checklist", options: users },
          ]} />
        </Card>
      </Reveal>
      <Card tight>
        {projects.length === 0 ? <Empty title="No projects yet" /> : (
          <table className="data"><thead><tr><th>Project</th><th>Job</th><th>Prospects</th><th>Team</th><th>Started</th></tr></thead><tbody>
            {projects.map((p) => (
              <tr key={p.id}><td><Link href={`/hiring/sourcing/projects/${p.id}`}>{p.name}</Link></td><td>{p.jobId ? jobName.get(p.jobId) ?? "—" : "—"}</td><td>{p._count.prospects}</td><td>{hireStringList(p.memberUserIds).length + 1}</td><td>{day(p.createdAt)}</td></tr>
            ))}
          </tbody></table>
        )}
      </Card>
    </>
  );
}
