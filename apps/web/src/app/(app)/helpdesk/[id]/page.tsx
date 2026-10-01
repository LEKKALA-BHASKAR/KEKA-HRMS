import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { usersWithPermission } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Person, Avatar } from "@/components/ui";
import { ReplyForm, TicketStatusControls, EmployeeTicketControls, RateTicket } from "../../_lifecycle/forms";

const TONE: Record<string, "warning" | "info" | "success" | "neutral"> = {
  OPEN: "warning", IN_PROGRESS: "info", WAITING_ON_EMPLOYEE: "neutral", RESOLVED: "success", CLOSED: "neutral",
};
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const t = await prisma.helpdeskTicket.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } } },
      category: true, comments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!t) notFound();
  const own = t.employee.id === viewer.employee?.id;
  const agent = can(viewer, PERMISSIONS.HELPDESK_MANAGE) && !own;
  if (!own && !agent) notFound();
  const thread = t.comments.filter((c) => agent || !c.isInternal);
  const agents = agent ? (await prisma.user.findMany({
    where: { id: { in: await usersWithPermission(viewer.tenantId, PERMISSIONS.HELPDESK_MANAGE) } },
    select: { id: true, email: true, employee: { select: { displayName: true } } },
  })).map((u) => ({ value: u.id, label: u.employee?.displayName ?? u.email })) : [];

  return (
    <>
      <PageHead title={<span className="row gap-2">HD-{t.number} <Badge tone={TONE[t.status]}>{t.status.replace(/_/g, " ").toLowerCase()}</Badge></span>}
        subtitle={t.subject} actions={<Link className="btn" href="/helpdesk">Back</Link>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }}>
        <Card title="Conversation">
          <div className="stack gap-4">
            <div className="row gap-3" style={{ alignItems: "flex-start", gap: 12 }}>
              <Avatar name={t.employee.displayName ?? "?"} size="sm" />
              <div style={{ flex: 1 }}>
                <div className="text-sm"><strong>{t.employee.displayName}</strong> <span className="subtle text-xs">{when(t.createdAt)}</span></div>
                <div className="text-sm" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{t.description}</div>
              </div>
            </div>
            {thread.map((c) => (
              <div key={c.id} className="row gap-3" style={{ alignItems: "flex-start", gap: 12, ...(c.isInternal ? { background: "var(--warning-bg)", padding: 10, borderRadius: 8 } : {}) }}>
                <Avatar name={c.authorLabel} size="sm" />
                <div style={{ flex: 1 }}>
                  <div className="text-sm"><strong>{c.authorLabel}</strong> <span className="subtle text-xs">{when(c.createdAt)}</span>{c.isInternal ? <> <Badge tone="warning">internal</Badge></> : null}</div>
                  <div className="text-sm" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{c.body}</div>
                </div>
              </div>
            ))}
            {t.status !== "CLOSED" ? <ReplyForm ticketId={t.id} asAgent={agent} /> : <div className="text-sm muted">This ticket is closed.</div>}
          </div>
        </Card>
        <div className="stack gap-4">
          <Card title="Details">
            <Person name={t.employee.displayName ?? ""} meta={`${t.employee.employeeNumber} · ${t.employee.department?.name ?? ""}`} />
            <div className="divider" />
            <KeyValue items={[
              ["Category", t.category.name],
              ["Priority", t.priority.toLowerCase()],
              ["Raised", when(t.createdAt)],
              ["Answer by", when(t.dueAt)],
              ["First response", t.firstResponseAt ? when(t.firstResponseAt) : "—"],
              ["Resolved", t.resolvedAt ? when(t.resolvedAt) : "—"],
            ]} />
          </Card>
          {agent ? <Card title="Manage"><TicketStatusControls ticketId={t.id} status={t.status} assigneeUserId={t.assigneeUserId} agents={agents} /></Card> : null}
          {own && t.status === "RESOLVED" ? <Card title="Is it fixed?"><EmployeeTicketControls ticketId={t.id} /></Card> : null}
          {own && ["RESOLVED", "CLOSED"].includes(t.status) ? <Card><RateTicket ticketId={t.id} current={t.satisfaction} /></Card> : null}
        </div>
      </div>
    </>
  );
}
