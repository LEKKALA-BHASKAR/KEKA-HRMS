import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { userOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, KeyValue, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveKbArticleAction, submitKbArticleAction, archiveKbArticleAction, reviewKbArticleAction } from "@/app/actions/helpdesk-ops";
import { requireHelpdeskAgent } from "../../_ui/access";
import { HelpdeskTabs } from "../../_ui/tabs";
import { categoryOptions } from "../../_ui/data";

export const metadata = { title: "Knowledge article" };

/** One knowledge article: edit (keeps a revision), submit for publication, review, archive, feedback. */
export default async function KnowledgeArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { viewer, canSettings } = await requireHelpdeskAgent();
  const { id } = await params;
  const t = viewer.tenantId;
  const a = await prisma.kbArticle.findFirst({ where: { id, tenantId: t }, include: { category: true } });
  if (!a) notFound();
  const [cats, hdCats, users, revisions, feedback, tickets, policies] = await Promise.all([
    prisma.kbCategory.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    categoryOptions(t), userOptions(t),
    prisma.kbArticleRevision.findMany({ where: { tenantId: t, articleId: a.id }, orderBy: { version: "desc" }, take: 30 }),
    prisma.kbArticleFeedback.findMany({ where: { tenantId: t, articleId: a.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.helpdeskTicketArticle.findMany({ where: { tenantId: t, articleId: a.id }, include: { ticket: { select: { id: true, number: true, subject: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.orgDocument.findMany({ where: { tenantId: t }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 200 }),
  ]);
  const names = await userNames(t, [a.authorUserId, a.ownerUserId, a.publishedByUserId, ...revisions.map((r) => r.editedByUserId), ...feedback.map((f) => f.userId)]);
  const overdue = a.reviewDueOn && a.reviewDueOn < new Date();
  return (
    <>
      <PageHead title={a.title} subtitle={`${a.category?.name ?? "No section"} · v${a.version}`} actions={<Link className="btn ghost" href="/helpdesk/knowledge">Back to knowledge base</Link>} />
      <HelpdeskTabs canSettings={canSettings} active="/helpdesk/knowledge" />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Status">
          <KeyValue items={[
            ["Status", <Pill key="s" s={a.status} />], ["Author", names.get(a.authorUserId)], ["Owner", a.ownerUserId ? names.get(a.ownerUserId) : null],
            ["Published", a.publishedAt ? `${fmtDate(a.publishedAt)} by ${a.publishedByUserId ? names.get(a.publishedByUserId) : "—"}` : null],
            ["Review due", <span key="r" className={overdue ? "neg" : ""}>{fmtDate(a.reviewDueOn)}{overdue ? " (overdue)" : ""}</span>],
            ["Views", a.views], ["Helpful", `${a.helpfulYes} yes · ${a.helpfulNo} no`],
          ]} />
          {a.status === "PENDING_APPROVAL" ? <div style={{ marginTop: 12 }}><Callout>Awaiting approval in Inbox › Approvals. Someone other than the author must approve it.</Callout></div> : null}
          <div className="row gap-2 wrap" style={{ marginTop: 12 }}>
            {a.status === "DRAFT" ? <ActButton action={submitKbArticleAction} hidden={{ id: a.id }} label="Submit for publication" variant="primary" /> : null}
            {a.status === "PUBLISHED" ? <ActButton action={reviewKbArticleAction} hidden={{ id: a.id }} label="Mark reviewed — still accurate" /> : null}
            {canSettings && a.status !== "ARCHIVED" && a.status !== "PENDING_APPROVAL" ? <ActButton action={archiveKbArticleAction} hidden={{ id: a.id, archive: "true" }} label="Archive" variant="danger" confirmText="Archive this article? Employees will no longer see it." /> : null}
            {canSettings && a.status === "ARCHIVED" ? <ActButton action={archiveKbArticleAction} hidden={{ id: a.id, archive: "false" }} label="Restore as draft" /> : null}
          </div>
        </Card>
        <Card title="Article">
          <div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>
          {a.keywords ? <div className="muted text-xs" style={{ marginTop: 8 }}>Keywords: {a.keywords}</div> : null}
        </Card>
      </div>
      {a.status !== "PENDING_APPROVAL" ? (
        <Card title="Edit" description={a.status === "PUBLISHED" ? "Saving changes to a published article returns it to draft for approval; the published text stays in the revisions." : "Each save keeps the earlier text as a revision."}>
          <SpecForm action={saveKbArticleAction} hidden={{ id: a.id }} submitLabel="Save" fields={[
            { name: "title", label: "Title", required: true, wide: true, defaultValue: a.title },
            { name: "categoryId", label: "Section", type: "select", options: cats.map((c) => ({ value: c.id, label: c.name })), defaultValue: a.categoryId },
            { name: "helpdeskCategoryId", label: "Answers tickets in", type: "select", options: hdCats.map((c) => ({ value: c.value, label: `${c.depth ? "— " : ""}${c.label}` })), defaultValue: a.helpdeskCategoryId },
            { name: "keywords", label: "Keywords", defaultValue: a.keywords },
            { name: "ownerUserId", label: "Owner", type: "select", options: users, defaultValue: a.ownerUserId },
            { name: "policyDocumentId", label: "Linked policy", type: "select", options: policies.map((p) => ({ value: p.id, label: p.title })), defaultValue: a.policyDocumentId },
            { name: "note", label: "Change note" },
            { name: "body", label: "Article", type: "textarea", required: true, wide: true, defaultValue: a.body },
          ]} />
        </Card>
      ) : null}
      <div className="grid grid-2" style={{ alignItems: "start", marginTop: 16 }}>
        <Card title="Revisions">
          <Table head={["Version", "Saved", "By", "Note"]} empty={!revisions.length}>
            {revisions.map((r) => <tr key={r.id}><td className="num">v{r.version}</td><td>{fmtWhen(r.createdAt)}</td><td>{names.get(r.editedByUserId)}</td><td className="text-sm">{r.note ?? ""}</td></tr>)}
          </Table>
        </Card>
        <Card title="Feedback">
          <Table head={["When", "Who", "Helpful", "Comment"]} empty={!feedback.length}>
            {feedback.map((f) => <tr key={f.id}><td>{fmtDate(f.createdAt)}</td><td>{names.get(f.userId)}</td><td>{f.helpful ? "Yes" : "No"}</td><td className="text-sm">{f.comment ?? ""}</td></tr>)}
          </Table>
        </Card>
      </div>
      <Card title="Linked tickets">
        <Table head={["Ticket", "Subject"]} empty={!tickets.length}>
          {tickets.map((l) => <tr key={l.id}><td><Link href={`/helpdesk/tickets/${l.ticket.id}`}>#{l.ticket.number}</Link></td><td>{l.ticket.subject}</td></tr>)}
        </Table>
      </Card>
    </>
  );
}
