import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { auditTrail } from "@/lib/workforce";
import { PageHead, Card, KeyValue, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton } from "@/components/workforce-ui";
import { StatusPill, RequestsTable, AuditTable } from "@/components/workforce-tables";
import { saveJobAction, submitJobDescriptionAction, retireJobAction } from "@/app/actions/positions";
import { JobFields } from "../fields";

const P = PERMISSIONS;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.POSITION_VIEW);
  const { id } = await params;
  const job = await prisma.jobProfile.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { family: true, level: true, versions: { orderBy: { version: "desc" } }, positions: { select: { id: true, code: true, title: true, status: true }, orderBy: { code: "asc" } } },
  });
  if (!job) notFound();
  const [families, levels, titles, requests, audit, users] = await Promise.all([
    prisma.jobFamily.findMany({ where: { tenantId: viewer.tenantId, status: { not: "RETIRED" } }, orderBy: { name: "asc" } }),
    prisma.jobLevel.findMany({ where: { tenantId: viewer.tenantId, status: { not: "RETIRED" } }, orderBy: { rank: "asc" } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.workforceRequest.findMany({ where: { tenantId: viewer.tenantId, entityType: "JobProfile", entityId: job.id }, orderBy: { requestedAt: "desc" } }),
    auditTrail(viewer.tenantId, ["JobProfile"], job.id),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
  ]);
  const canManage = can(viewer, P.POSITION_MANAGE);
  const latest = job.versions[0];
  const userMap = new Map(users.map((u) => [u.id, u.email]));
  // The form edits the newest version (a draft), or starts the next one from the current.
  const working = latest ?? job;
  return (
    <>
      <PageHead title={<>{job.code} · {job.title}</>} subtitle={<><StatusPill status={job.status} /> current description v{job.version}</>} actions={<Link className="btn sm" href="/positions/jobs">All jobs</Link>} />
      <div className="grid grid-2">
        <Card title="Job">
          <KeyValue items={[
            ["Family", job.family?.name], ["Level", job.level ? `${job.level.name} (${job.level.track.toLowerCase()})` : null],
            ["Org job title", titles.find((t) => t.id === job.jobTitleId)?.name],
            ["Summary", job.summary], ["Responsibilities", job.responsibilities ? <div style={{ whiteSpace: "pre-wrap" }}>{job.responsibilities}</div> : null],
            ["Qualifications", job.qualifications], ["Competencies", job.competencies.join(", ") || null], ["Skills", job.skills.join(", ") || null],
          ]} />
        </Card>
        <Card title="Positions using this job">
          {job.positions.length === 0 ? <Empty title="No positions yet." /> : (
            <ul>{job.positions.map((p) => <li key={p.id}><Link href={`/positions/${p.id}`}>{p.code}</Link> {p.title} <StatusPill status={p.status} /></li>)}</ul>
          )}
        </Card>
      </div>
      {canManage && job.status !== "RETIRED" ? (
        <Card title="Maintain" description="Changing an approved description saves a new draft version; the approved one stays current until the new one is approved.">
          <div className="row gap-2 wrap" style={{ alignItems: "flex-start" }}>
            <Disclosure label="Edit job & description" variant="default">
              <SimpleForm action={saveJobAction} hidden={{ id: job.id }}>
                <JobFields d={{ ...job, summary: working.summary, responsibilities: working.responsibilities, qualifications: working.qualifications, competencies: working.competencies, skills: working.skills }}
                  opts={{ families: families.map((f) => ({ value: f.id, label: f.name })), levels: levels.map((l) => ({ value: l.id, label: l.name })), titles: titles.map((t) => ({ value: t.id, label: t.name })) }} />
              </SimpleForm>
            </Disclosure>
            {latest && (latest.status === "DRAFT" || latest.status === "REJECTED") ? <ActionButton action={submitJobDescriptionAction} hidden={{ id: job.id }} label={`Submit v${latest.version} for approval`} variant="primary" /> : null}
            <ActionButton action={retireJobAction} hidden={{ id: job.id }} label="Retire job" confirmText="Retire this job?" />
          </div>
        </Card>
      ) : null}
      <Card title="Description versions">
        <table className="data">
          <thead><tr><th>Version</th><th>Status</th><th>Summary</th><th>Competencies</th><th>Created</th><th>Approved</th></tr></thead>
          <tbody>{job.versions.map((v) => (
            <tr key={v.id}><td>v{v.version}</td><td><StatusPill status={v.status} /></td><td className="text-sm">{v.summary}</td><td className="text-xs">{v.competencies.join(", ")}</td>
              <td className="text-xs">{formatDate(v.createdAt)} · {v.createdBy ? userMap.get(v.createdBy) : ""}</td><td className="text-xs">{v.approvedAt ? `${formatDate(v.approvedAt)} · ${userMap.get(v.approvedBy ?? "") ?? ""}` : ""}</td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Approval history"><RequestsTable rows={requests} viewer={viewer} users={userMap} /></Card>
      <Card title="Audit trail"><AuditTable rows={audit} /></Card>
    </>
  );
}
