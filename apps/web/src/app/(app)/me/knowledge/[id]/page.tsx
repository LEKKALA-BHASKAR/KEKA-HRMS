import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { fmtDate } from "@/lib/governance";
import { PageHead, Card } from "@/components/ui";
import { ActButton } from "@/components/gov-forms";
import { kbFeedbackAction } from "@/app/actions/helpdesk-ops";
import { MeCasesTabs } from "../../cases/tabs";

export const metadata = { title: "Knowledge article" };

/** One published article; counts the view and asks whether it helped. */
export default async function MyKnowledgeArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const a = await prisma.kbArticle.findFirst({ where: { id, tenantId: viewer.tenantId, status: "PUBLISHED" }, include: { category: true } });
  if (!a) notFound();
  await prisma.kbArticle.updateMany({ where: { id: a.id, tenantId: viewer.tenantId }, data: { views: { increment: 1 } } });
  const [mine, policy] = await Promise.all([
    prisma.kbArticleFeedback.findUnique({ where: { articleId_userId: { articleId: a.id, userId: viewer.user.id } } }),
    a.policyDocumentId ? prisma.orgDocument.findFirst({ where: { id: a.policyDocumentId, tenantId: viewer.tenantId }, select: { id: true, title: true } }) : null,
  ]);
  return (
    <>
      <PageHead title={a.title} subtitle={`${a.category?.name ?? "General"} · updated ${fmtDate(a.updatedAt)}`} actions={<Link className="btn ghost" href="/me/knowledge">All articles</Link>} />
      <MeCasesTabs />
      <Card>
        <div style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>
        {policy ? <p className="text-sm" style={{ marginTop: 12 }}>Policy: <Link href={`/documents?doc=${policy.id}`}>{policy.title}</Link></p> : null}
      </Card>
      <Card title="Was this helpful?">
        {mine ? <p className="muted text-sm">You said this was {mine.helpful ? "helpful" : "not helpful"}. You can change your answer.</p> : null}
        <div className="row gap-2 wrap">
          <ActButton action={kbFeedbackAction} hidden={{ articleId: a.id, helpful: "yes" }} label="Yes, it answered my question" variant="primary" />
          <ActButton action={kbFeedbackAction} hidden={{ articleId: a.id, helpful: "no" }} label="No" input={{ name: "comment", placeholder: "What was missing? (optional)" }} />
        </div>
        <p className="muted text-sm" style={{ marginTop: 12 }}>Still stuck? <Link href="/me/helpdesk?new=1">Raise a helpdesk ticket</Link>.</p>
      </Card>
    </>
  );
}
