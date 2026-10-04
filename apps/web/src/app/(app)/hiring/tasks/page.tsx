import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { pendingHireRequests } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { createTaskAction, completeTaskAction, updateTaskAction } from "@/app/actions/hire-ops";
import { userOptions } from "@/lib/hire-depth";
import { TaskTabs, day, pretty } from "../_parts/depth-tabs";

export const metadata = { title: "Recruiting tasks · Hire" };

const QUEUES = ["SOURCING", "SCREENING", "SCHEDULING", "FEEDBACK", "OFFER", "OUTREACH", "OTHER"];

/**
 * Hire › Tasks: recruiter work queues. Tasks come from people (with an
 * optional sign-off by whoever set them), from outreach cadences, and from
 * the hiring alerts (SLA breaches, stalled candidates).
 */
export default async function RecruiterTasksPage({ searchParams }: { searchParams: Promise<{ queue?: string; who?: string; status?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE])) forbidden();
  const sp = await searchParams;
  const manager = can(viewer, PERMISSIONS.CANDIDATE_MANAGE);
  const who = sp.who === "all" && manager ? "all" : "me";
  const status = ["OPEN", "PENDING_APPROVAL", "DONE", "CANCELLED"].includes(sp.status ?? "") ? sp.status! : "OPEN";
  const tasks = await prisma.recruiterTask.findMany({
    where: { tenantId: viewer.tenantId, status, ...(who === "me" ? { assigneeUserId: viewer.user.id } : {}), ...(QUEUES.includes(sp.queue ?? "") ? { queue: sp.queue } : {}) },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take: 300,
  });
  const counts = await prisma.recruiterTask.groupBy({ by: ["queue"], where: { tenantId: viewer.tenantId, status: "OPEN", ...(who === "me" ? { assigneeUserId: viewer.user.id } : {}) }, _count: { _all: true } });
  const users = await userOptions(viewer);
  const name = new Map(users.map((u) => [u.value, u.label]));
  const apps = await prisma.application.findMany({ where: { tenantId: viewer.tenantId, id: { in: tasks.map((t) => t.applicationId).filter((x): x is string => !!x) } }, include: { candidate: { select: { firstName: true, lastName: true } } } });
  const appName = new Map(apps.map((a) => [a.id, `${a.candidate.firstName} ${a.candidate.lastName}`]));
  const signing = await pendingHireRequests(viewer.tenantId, "TASK_SIGNOFF", tasks.map((t) => t.id));
  const now = Date.now();
  const q = (extra: Record<string, string>) => `?${new URLSearchParams({ who, status, ...(sp.queue ? { queue: sp.queue } : {}), ...extra }).toString()}`;
  return (
    <>
      <TaskTabs />
      <PageHead title="Recruiting tasks" subtitle="Your work queues: screening, scheduling, feedback chasers, outreach steps and offers." />
      <div className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <Link className={`btn sm${who === "me" ? " primary" : ""}`} href={q({ who: "me" })}>Mine</Link>
        {manager ? <Link className={`btn sm${who === "all" ? " primary" : ""}`} href={q({ who: "all" })}>Everyone&apos;s</Link> : null}
        <span className="subtle">|</span>
        {["OPEN", "PENDING_APPROVAL", "DONE", "CANCELLED"].map((s) => <Link key={s} className={`btn sm${status === s ? " primary" : ""}`} href={q({ status: s })}>{pretty(s)}</Link>)}
        <span className="subtle">|</span>
        <Link className={`btn sm${!sp.queue ? " primary" : ""}`} href={`?${new URLSearchParams({ who, status }).toString()}`}>All queues</Link>
        {QUEUES.map((k) => {
          const n = counts.find((c) => c.queue === k)?._count._all ?? 0;
          return <Link key={k} className={`btn sm${sp.queue === k ? " primary" : ""}`} href={q({ queue: k })}>{pretty(k)}{n ? ` (${n})` : ""}</Link>;
        })}
      </div>
      {manager ? (
        <Reveal label="New task">
          <Card>
            <GrowthForm action={createTaskAction} cols={3} submitLabel="Add task" fields={[
              { name: "title", label: "Task", required: true, wide: true },
              { name: "queue", label: "Queue", type: "select", options: QUEUES.map((k) => ({ value: k, label: pretty(k) })), defaultValue: "OTHER" },
              { name: "priority", label: "Priority", type: "select", options: ["LOW", "MEDIUM", "HIGH"].map((k) => ({ value: k, label: pretty(k) })), defaultValue: "MEDIUM" },
              { name: "assigneeUserId", label: "Assign to", type: "select", options: users, defaultValue: viewer.user.id },
              { name: "dueAt", label: "Due", type: "date" },
              { name: "details", label: "Details", type: "textarea" },
              { name: "requiresSignOff", label: "Needs my sign-off when done", type: "checkbox" },
            ]} />
          </Card>
        </Reveal>
      ) : null}
      <Card tight>
        {tasks.length === 0 ? <Empty title="Nothing here">No {pretty(status).toLowerCase()} tasks{sp.queue ? ` in ${pretty(sp.queue).toLowerCase()}` : ""}.</Empty> : (
          <table className="data" data-testid="task-table">
            <thead><tr><th>Task</th><th>Queue</th><th>Priority</th><th>Assignee</th><th>Due</th><th /></tr></thead>
            <tbody>
              {tasks.map((t) => {
                const late = t.status === "OPEN" && t.dueAt && t.dueAt.getTime() < now;
                return (
                  <tr key={t.id}>
                    <td>
                      <div className="strong">{t.title}</div>
                      {t.details ? <div className="text-xs muted">{t.details}</div> : null}
                      {t.applicationId ? <Link className="text-xs" href={`/hiring/applications/${t.applicationId}`}>{appName.get(t.applicationId) ?? "Application"}</Link> : t.candidateId ? <Link className="text-xs" href={`/hiring/candidates/${t.candidateId}`}>Candidate</Link> : null}
                      {t.outcome ? <div className="text-xs">Outcome: {t.outcome}</div> : null}
                    </td>
                    <td>{pretty(t.queue)}</td>
                    <td><Badge tone={t.priority === "HIGH" ? "danger" : t.priority === "LOW" ? "neutral" : "info"}>{pretty(t.priority)}</Badge></td>
                    <td className="text-sm">{t.assigneeUserId ? name.get(t.assigneeUserId) ?? "—" : "Unassigned"}</td>
                    <td className="nowrap">{late ? <Badge tone="danger">Overdue {day(t.dueAt)}</Badge> : day(t.dueAt)}</td>
                    <td className="right">
                      {t.status === "OPEN" && (manager || t.assigneeUserId === viewer.user.id) ? (
                        <div className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                          <ActButton action={completeTaskAction} hidden={{ id: t.id }} label={t.requiresSignOff ? "Done — sign off" : "Done"} variant="primary" input={{ name: "outcome", placeholder: "Outcome (optional)" }} />
                          {manager ? <ActButton action={updateTaskAction} hidden={{ id: t.id, status: "CANCELLED" }} label="Cancel" confirmText="Cancel this task?" /> : null}
                        </div>
                      ) : t.status === "PENDING_APPROVAL" ? <Badge tone="warning">{signing.has(t.id) ? "Awaiting sign-off" : "Pending"}</Badge> : <Badge tone={t.status === "DONE" ? "success" : "neutral"}>{pretty(t.status)}</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
