import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { WORKFLOW_ENTITY_TYPES, GENERIC_REQUEST_CATEGORIES } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { userNames, fmtWhen } from "@/lib/governance";
import { PageHead, Card, KeyValue, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { ActButton } from "@/components/gov-forms";
import { decideWorkflowTaskAction, withdrawWorkflowAction, retryWorkflowAction } from "@/app/actions/workflows";

/** One request: its route, approvers and full execution history. */
export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const r = await prisma.workflowRequest.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { definition: { select: { id: true, name: true, version: true } }, tasks: { orderBy: [{ stepOrder: "asc" }, { createdAt: "asc" }] }, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!r) notFound();
  const admin = can(viewer, PERMISSIONS.WORKFLOW_MANAGE);
  const involved = r.requesterUserId === viewer.user.id || r.tasks.some((x) => x.approverUserId === viewer.user.id || x.delegatedFromUserId === viewer.user.id);
  if (!involved && !admin) notFound();
  const names = await userNames(viewer.tenantId, [r.requesterUserId, ...r.tasks.flatMap((x) => [x.approverUserId, x.delegatedFromUserId]), ...r.events.map((e) => e.actorUserId)]);
  const mine = r.tasks.find((x) => x.status === "PENDING" && x.approverUserId === viewer.user.id);
  return (
    <>
      <PageHead title={r.title} subtitle={<><Pill s={r.status} /> {WORKFLOW_ENTITY_TYPES[r.entityType as keyof typeof WORKFLOW_ENTITY_TYPES] ?? r.entityType}</>} actions={<Link className="btn" href="/me/requests">My requests</Link>} />
      <div className="stack gap-4">
        {r.status === "ERROR" ? <Callout tone="danger" title="The decision could not be applied">{r.lastError}</Callout> : null}
        <Card title="Details" action={
          <div className="row gap-2">
            {r.status === "PENDING" && r.requesterUserId === viewer.user.id ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: r.id }} label="Withdraw" variant="ghost" /> : null}
            {r.status === "ERROR" && admin ? <ActButton action={retryWorkflowAction} hidden={{ requestId: r.id }} label="Retry" /> : null}
          </div>}>
          <KeyValue items={[
            ["Requested by", names.get(r.requesterUserId)], ["Submitted", fmtWhen(r.createdAt)],
            ["Category", r.category ? GENERIC_REQUEST_CATEGORIES[r.category as keyof typeof GENERIC_REQUEST_CATEGORIES] ?? r.category : null],
            ["Amount", r.amount !== null ? Number(r.amount).toLocaleString("en-IN") : null], ["Details", r.details],
            ["Route", r.definition ? (admin ? <Link href={`/admin/workflows/${r.definition.id}`}>{r.definition.name} v{r.definition.version}</Link> : `${r.definition.name} v${r.definition.version}`) : "Built-in route"],
            ["Completed", fmtWhen(r.completedAt)],
          ]} />
        </Card>
        {mine ? (
          <Card title="Your decision">
            <div className="row gap-2 wrap">
              <ActButton action={decideWorkflowTaskAction} hidden={{ taskId: mine.id, decision: "approve" }} label="Approve" variant="primary" input={{ name: "comment", placeholder: "Comment (optional)" }} />
              <ActButton action={decideWorkflowTaskAction} hidden={{ taskId: mine.id, decision: "reject" }} label="Reject" variant="danger" input={{ name: "comment", placeholder: "Reason", required: true }} />
            </div>
          </Card>
        ) : null}
        <Card tight title="Approvals">
          <Table head={["Step", "Approver", "Decision", "Due", "Decided", "Comment"]} empty={r.tasks.length === 0}>
            {r.tasks.map((x) => <tr key={x.id}><td>{x.stepOrder + 1}. {x.stepName}{x.mode === "ALL" ? " (all)" : ""}</td><td>{names.get(x.approverUserId)}{x.delegatedFromUserId ? <div className="text-xs muted">for {names.get(x.delegatedFromUserId)}</div> : null}</td><td><Pill s={x.status} /></td><td className="text-xs">{fmtWhen(x.dueAt)}</td><td className="text-xs">{fmtWhen(x.decidedAt)}</td><td className="text-xs">{x.comment}</td></tr>)}
          </Table>
        </Card>
        <Card tight title="History">
          <Table head={["When", "Event", "By", "Note"]}>
            {r.events.map((e) => <tr key={e.id}><td className="text-xs">{fmtWhen(e.createdAt)}</td><td><Pill s={e.kind} /></td><td>{e.actorUserId ? names.get(e.actorUserId) : "System"}</td><td className="text-xs">{e.note}</td></tr>)}
          </Table>
        </Card>
      </div>
    </>
  );
}
