import { prisma } from "@keka/db";
import type { WorkforceArea } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { requestsOf } from "@/lib/workforce";
import { PageHead, Card } from "@/components/ui";
import { RequestsTable } from "@/components/workforce-tables";

/** The approvals page of a workforce area: what waits on the viewer, then the history. */
export async function WorkforceApprovals({ viewer, area, title, exportHref }: { viewer: Viewer; area: WorkforceArea; title: string; exportHref: string }) {
  const [pending, history, users] = await Promise.all([
    requestsOf(viewer.tenantId, area, "PENDING"),
    requestsOf(viewer.tenantId, area),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u.email]));
  return (
    <>
      <PageHead title={title} subtitle="Requests are decided by someone other than the requester; every decision is audited." actions={<a className="btn sm" href={exportHref}>Export CSV</a>} />
      <Card title={`Pending (${pending.length})`}><RequestsTable rows={pending} viewer={viewer} users={userMap} empty="Nothing is waiting for approval." /></Card>
      <Card title="History"><RequestsTable rows={history.filter((r) => r.status !== "PENDING")} viewer={viewer} users={userMap} empty="No decisions yet." /></Card>
    </>
  );
}
