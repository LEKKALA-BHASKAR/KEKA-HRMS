import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReviewButtons } from "@/components/growth-report";
import { saveFeedbackTemplateAction, feedbackTemplateReviewAction } from "@/app/actions/skills";

const P = PERMISSIONS;
const PURPOSES = [{ value: "PEER", label: "Peer" }, { value: "MANAGER", label: "Manager" }, { value: "UPWARD", label: "Upward" }, { value: "THREE_SIXTY", label: "360°" }, { value: "ADHOC", label: "Ad hoc" }];

export default async function FeedbackTemplatesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await requireAuth(P.PERFORMANCE_MANAGE);
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const templates = await prisma.feedbackTemplate.findMany({ where: { tenantId: viewer.tenantId, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, orderBy: [{ status: "asc" }, { name: "asc" }] });
  return (
    <>
      <PageHead title="Feedback Templates" subtitle="Question sets for peer, manager, upward and 360° feedback — approved before use" />
      <form className="row gap-2" style={{ marginBottom: 12 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search templates" style={{ maxWidth: 280 }} />
        <button className="btn">Search</button>
      </form>
      <Reveal label="+ New template">
        <Panel title="New feedback template">
          <GrowthForm action={saveFeedbackTemplateAction} submitLabel="Create" cols={2} fields={[
            { name: "name", label: "Name", required: true },
            { name: "purpose", label: "For", type: "select", required: true, options: PURPOSES, defaultValue: "PEER" },
            { name: "description", label: "Description", wide: true },
            { name: "questions", label: "Questions, one per line", type: "textarea", required: true, rows: 6 },
          ]} />
        </Panel>
      </Reveal>
      <div className="stack gap-3">
        {templates.length === 0 ? <Panel><EmptyState title="No templates yet" /></Panel> : templates.map((t) => (
          <Panel key={t.id} title={t.name} subtitle={`${PURPOSES.find((p) => p.value === t.purpose)?.label ?? t.purpose} · ${t.questions.length} questions · updated ${formatDate(t.updatedAt)}${t.decisionNote ? ` · note: ${t.decisionNote}` : ""}`} action={<span className="row gap-1 wrap">
            <Badge tone={STATUS_TONE[t.status]} dot>{t.status.toLowerCase()}</Badge>
            <ReviewButtons action={feedbackTemplateReviewAction} hidden={{ templateId: t.id }} status={t.status} submittedByMe={t.submittedBy === viewer.user.id} />
            {t.status === "DRAFT" ? <ActButton action={feedbackTemplateReviewAction} hidden={{ templateId: t.id, op: "delete" }} label="Delete" variant="ghost" confirmText="Delete this template?" /> : null}
          </span>}>
            <ol className="text-sm" style={{ margin: 0, paddingLeft: 20 }}>{t.questions.map((x, i) => <li key={i}>{x}</li>)}</ol>
            {t.status === "DRAFT" || t.status === "REJECTED" ? (
              <Reveal label="Edit">
                <GrowthForm action={saveFeedbackTemplateAction} hidden={{ id: t.id }} cols={2} compact fields={[
                  { name: "name", label: "Name", required: true, defaultValue: t.name },
                  { name: "purpose", label: "For", type: "select", required: true, options: PURPOSES, defaultValue: t.purpose },
                  { name: "description", label: "Description", wide: true, defaultValue: t.description },
                  { name: "questions", label: "Questions, one per line", type: "textarea", defaultValue: t.questions.join("\n") },
                ]} />
              </Reveal>
            ) : null}
          </Panel>
        ))}
      </div>
    </>
  );
}
