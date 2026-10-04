import Link from "next/link";
import { prisma } from "@keka/db";
import { TICKET_SEVERITIES, CASE_CHANNELS } from "@keka/services";
import { userOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Pill } from "@/components/gov-ui";
import {
  addTicketTaskAction, toggleTicketTaskAction, deleteTicketTaskAction, mergeTicketAction, splitTicketAction,
  escalateTicketAction, acknowledgeEscalationAction, requestCaseApprovalAction, linkArticleAction,
} from "@/app/actions/helpdesk-ops";
import s from "./hd.module.css";

/**
 * Case operations on an agent's ticket: task checklist, escalation,
 * approvals through the workflow engine, knowledge articles, merge and split.
 */
export async function loadCaseOps(tenantId: string, ticketId: string) {
  const [t, tasks, escalations, links, articles, users] = await Promise.all([
    prisma.helpdeskTicket.findFirstOrThrow({ where: { id: ticketId, tenantId }, select: { severity: true, channel: true, mergedIntoId: true, splitFromId: true, escalationLevel: true, approvalStatus: true, approvalRequestId: true, satisfactionComment: true } }),
    prisma.helpdeskTicketTask.findMany({ where: { tenantId, ticketId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.helpdeskTicketEscalation.findMany({ where: { tenantId, ticketId }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.helpdeskTicketArticle.findMany({ where: { tenantId, ticketId }, include: { article: { select: { id: true, title: true } } } }),
    prisma.kbArticle.findMany({ where: { tenantId, status: "PUBLISHED" }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 300 }),
    userOptions(tenantId),
  ]);
  const related = await prisma.helpdeskTicket.findMany({ where: { tenantId, id: { in: [t.mergedIntoId, t.splitFromId].filter((x): x is string => !!x) } }, select: { id: true, number: true } });
  const num = new Map(related.map((r) => [r.id, r.number]));
  const names = await userNames(tenantId, [...tasks.map((x) => x.assigneeUserId), ...escalations.map((e) => e.escalatedToUserId)]);
  const linked = new Set(links.map((l) => l.article.id));
  return { t, tasks, escalations, links, articles, users, num, names, linked };
}
export type CaseOpsData = Awaited<ReturnType<typeof loadCaseOps>>;

/** Rendered from data the page loads first, so the panel itself stays synchronous. */
export function CaseOps({ data, ticketId, viewerUserId, closed, categories }: { data: CaseOpsData; ticketId: string; viewerUserId: string; closed: boolean; categories: Array<{ value: string; label: string }> }) {
  const { t, tasks, escalations, links, articles, users, num, names, linked } = data;
  return (
    <>
      <div className={s.sideCard}>
        <div className={s.sideHead}>Case</div>
        <div className={s.sideBody}>
          <div className="text-sm stack gap-1">
            <div>Received via {CASE_CHANNELS[t.channel as keyof typeof CASE_CHANNELS] ?? t.channel}</div>
            {t.severity ? <div>Severity {TICKET_SEVERITIES[t.severity as keyof typeof TICKET_SEVERITIES] ?? t.severity}</div> : null}
            {t.escalationLevel ? <div className="neg">Escalated to level {t.escalationLevel}</div> : null}
            {t.mergedIntoId ? <div>Merged into <Link href={`/helpdesk/tickets/${t.mergedIntoId}`}>#{num.get(t.mergedIntoId)}</Link></div> : null}
            {t.splitFromId ? <div>Split from <Link href={`/helpdesk/tickets/${t.splitFromId}`}>#{num.get(t.splitFromId)}</Link></div> : null}
            {t.approvalStatus !== "NONE" ? <div>Approval <Pill s={t.approvalStatus} /></div> : null}
            {t.satisfactionComment ? <div className="muted">Employee feedback: &ldquo;{t.satisfactionComment}&rdquo;</div> : null}
          </div>
        </div>
      </div>

      <div className={s.sideCard}>
        <div className={s.sideHead}>Tasks ({tasks.filter((x) => x.doneAt).length}/{tasks.length})</div>
        <div className={s.sideBody}>
          <div className="stack gap-2">
            {tasks.map((x) => (
              <div key={x.id} className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <ActButton action={toggleTicketTaskAction} hidden={{ taskId: x.id }} label={x.doneAt ? "Done" : "To do"} variant={x.doneAt ? "ghost" : undefined} />
                <span className="text-sm" style={x.doneAt ? { textDecoration: "line-through" } : undefined}>{x.title}</span>
                <span className="muted text-xs">{x.assigneeUserId ? names.get(x.assigneeUserId) : ""}{x.dueOn ? ` · due ${fmtDate(x.dueOn)}` : ""}</span>
                {!x.doneAt ? <ActButton action={deleteTicketTaskAction} hidden={{ taskId: x.id }} label="Remove" variant="ghost" /> : null}
              </div>
            ))}
          </div>
          {!closed ? <div style={{ marginTop: 8 }}><SpecForm action={addTicketTaskAction} hidden={{ ticketId }} submitLabel="Add task" columns={1} fields={[
            { name: "title", label: "Task", required: true }, { name: "assigneeUserId", label: "Assignee", type: "select", options: users }, { name: "dueOn", label: "Due", type: "date" },
          ]} /></div> : null}
        </div>
      </div>

      <div className={s.sideCard}>
        <div className={s.sideHead}>Knowledge articles</div>
        <div className={s.sideBody}>
          {links.length ? <ul className="text-sm">{links.map((l) => <li key={l.id}><Link href={`/me/knowledge/${l.article.id}`}>{l.article.title}</Link></li>)}</ul> : <p className="muted text-sm">None linked.</p>}
          {articles.length ? <SpecForm action={linkArticleAction} hidden={{ ticketId }} submitLabel="Send article" columns={1} fields={[
            { name: "articleId", label: "Article", type: "select", required: true, options: articles.filter((a) => !linked.has(a.id)).map((a) => ({ value: a.id, label: a.title })) },
          ]} /> : null}
        </div>
      </div>

      <div className={s.sideCard}>
        <div className={s.sideHead}>Escalation</div>
        <div className={s.sideBody}>
          {escalations.map((e) => (
            <div key={e.id} className="text-sm" style={{ marginBottom: 6 }}>
              L{e.level} · {e.reason} · {e.escalatedToUserId ? names.get(e.escalatedToUserId) : "—"} · {fmtWhen(e.createdAt)}
              {e.acknowledgedAt ? <span className="muted"> · acknowledged</span> : e.escalatedToUserId === viewerUserId ? <ActButton action={acknowledgeEscalationAction} hidden={{ escalationId: e.id }} label="Acknowledge" /> : null}
            </div>
          ))}
          {!closed ? <SpecForm action={escalateTicketAction} hidden={{ ticketId }} submitLabel="Escalate" columns={1} fields={[
            { name: "reason", label: "Reason", required: true }, { name: "toUserId", label: "To", type: "select", options: users, placeholder: "Category head" },
          ]} /> : null}
        </div>
      </div>

      {!closed ? (
        <div className={s.sideCard}>
          <div className={s.sideHead}>Approval, merge and split</div>
          <div className={s.sideBody}>
            <div className="stack gap-3">
              {t.approvalStatus !== "PENDING" ? <SpecForm action={requestCaseApprovalAction} hidden={{ ticketId }} submitLabel="Request approval" columns={1} fields={[
                { name: "summary", label: "Decision needed", required: true, placeholder: "One-off salary advance beyond policy" }, { name: "amount", label: "Amount (₹)", type: "number" },
              ]} /> : <p className="muted text-sm">Approval pending in Inbox › Approvals.</p>}
              <SpecForm action={mergeTicketAction} hidden={{ ticketId }} submitLabel="Merge" columns={1} fields={[{ name: "targetNumber", label: "Merge into case number", type: "number", required: true, hint: "This case closes and its thread is copied into that case." }]} />
              <SpecForm action={splitTicketAction} hidden={{ ticketId }} submitLabel="Split out" columns={1} fields={[
                { name: "subject", label: "New case subject", required: true }, { name: "description", label: "Description", type: "textarea", required: true },
                { name: "categoryId", label: "Category", type: "select", options: categories, placeholder: "Same category" },
              ]} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
