import Link from "next/link";
import { prisma } from "@keka/db";
import { searchKb, KB_STATUS_LABEL } from "@keka/services";
import { userOptions, userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Stat } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveKbArticleAction, saveKbCategoryAction, bulkArchiveKbAction } from "@/app/actions/helpdesk-ops";
import { requireHelpdeskAgent } from "../_ui/access";
import { HelpdeskTabs } from "../_ui/tabs";
import { categoryOptions } from "../_ui/data";

export const metadata = { title: "Knowledge base" };
const TABS = { articles: "Articles", new: "New article", categories: "Categories", insights: "Insights" };
type Tab = keyof typeof TABS;

/**
 * Org › Helpdesk › Knowledge base: articles agents write, an approver
 * publishes (through the workflow engine), employees search and rate, and
 * the helpdesk suggests while a ticket is being raised.
 */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { viewer, canSettings } = await requireHelpdeskAgent();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "articles";
  const t = viewer.tenantId;
  const [cats, hdCats] = await Promise.all([prisma.kbCategory.findMany({ where: { tenantId: t }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { _count: { select: { articles: true } } } }), categoryOptions(t)]);
  return (
    <>
      <PageHead title="Knowledge base" subtitle="Answers employees find before they raise a ticket" actions={<Link className="btn" href="/me/knowledge">Employee view</Link>} />
      <HelpdeskTabs canSettings={canSettings} />
      <Tabs base="/helpdesk/knowledge" tabs={TABS} active={tab} />
      {tab === "articles" ? <Articles tenantId={t} q={sp.q} status={sp.status} category={sp.category} cats={cats} canSettings={canSettings} /> : null}
      {tab === "new" ? (
        <Card title="New article" description="Saved as a draft; submit it from the article page to publish.">
          <SpecForm action={saveKbArticleAction} submitLabel="Save draft" fields={[
            { name: "title", label: "Title", required: true, wide: true },
            { name: "categoryId", label: "Section", type: "select", options: cats.map((c) => ({ value: c.id, label: c.name })) },
            { name: "helpdeskCategoryId", label: "Answers tickets in", type: "select", options: hdCats.map((c) => ({ value: c.value, label: `${c.depth ? "— " : ""}${c.label}` })) },
            { name: "keywords", label: "Keywords", placeholder: "payslip, salary slip, download", hint: "Comma-separated words people might search for." },
            { name: "ownerUserId", label: "Owner", type: "select", options: await userOptions(t), hint: "Reviews it yearly. Defaults to you." },
            { name: "body", label: "Article", type: "textarea", required: true, wide: true, hint: "Plain text or simple HTML. Scripts are not allowed." },
          ]} />
        </Card>
      ) : null}
      {tab === "categories" ? (
        <Card title="Sections">
          <Table head={["Section", "Articles", "Description"]} empty={!cats.length}>
            {cats.map((c) => <tr key={c.id}><td>{c.name}</td><td className="num">{c._count.articles}</td><td className="text-sm">{c.description ?? ""}</td></tr>)}
          </Table>
          {canSettings ? <div style={{ marginTop: 12 }}><SpecForm action={saveKbCategoryAction} submitLabel="Add section" columns={3} fields={[{ name: "name", label: "Name", required: true }, { name: "description", label: "Description" }, { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 }]} /></div> : null}
        </Card>
      ) : null}
      {tab === "insights" ? <Insights tenantId={t} /> : null}
    </>
  );
}

async function Articles({ tenantId, q, status, category, cats, canSettings }: { tenantId: string; q?: string; status?: string; category?: string; cats: Array<{ id: string; name: string }>; canSettings: boolean }) {
  const rows = await searchKb(tenantId, q ?? "", { statuses: status ? [status] : ["DRAFT", "PENDING_APPROVAL", "PUBLISHED"], categoryId: category || null, limit: 200 });
  const owners = await userNames(tenantId, rows.map((r) => r.ownerUserId));
  const now = new Date();
  return (
    <Card title={`Articles (${rows.length})`}>
      <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input type="hidden" name="tab" value="articles" />
        <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search articles…" style={{ width: 240 }} />
        <select className="select" name="status" defaultValue={status ?? ""}><option value="">Draft, pending and published</option>{Object.entries(KB_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="select" name="category" defaultValue={category ?? ""}><option value="">Any section</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn sm" type="submit">Search</button>
      </form>
      <div>
        <Table head={["", "Article", "Section", "Status", "Owner", "Review due", "Views", "Helpful"]} empty={!rows.length}>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>{canSettings ? <input type="checkbox" name="ids" value={a.id} form="kb-bulk" aria-label={`Select ${a.title}`} /> : null}</td>
              <td><Link href={`/helpdesk/knowledge/${a.id}`}>{a.title}</Link> <span className="muted text-xs">v{a.version}</span></td>
              <td>{a.category?.name ?? "—"}</td>
              <td><Pill s={a.status} /></td>
              <td>{a.ownerUserId ? owners.get(a.ownerUserId) : "—"}</td>
              <td className={a.reviewDueOn && a.reviewDueOn < now ? "neg" : ""}>{fmtDate(a.reviewDueOn)}</td>
              <td className="num">{a.views}</td>
              <td className="num">{a.helpfulYes}/{a.helpfulYes + a.helpfulNo}</td>
            </tr>
          ))}
        </Table>
      </div>
      {canSettings && rows.length ? <div id="kb-bulk-wrap" style={{ marginTop: 8 }}><BulkArchive /></div> : null}
    </Card>
  );
}

function BulkArchive() {
  // The checkboxes above post with this form through their form="kb-bulk" attribute.
  return <ActButton action={bulkArchiveKbAction} hidden={{}} formId="kb-bulk" label="Archive selected" variant="danger" confirmText="Archive the selected articles?" />;
}

async function Insights({ tenantId }: { tenantId: string }) {
  const [byStatus, top, unhelpful, linked] = await Promise.all([
    prisma.kbArticle.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
    prisma.kbArticle.findMany({ where: { tenantId, status: "PUBLISHED" }, orderBy: { views: "desc" }, take: 10 }),
    prisma.kbArticle.findMany({ where: { tenantId, status: "PUBLISHED", helpfulNo: { gt: 0 } }, orderBy: { helpfulNo: "desc" }, take: 10 }),
    prisma.helpdeskTicketArticle.count({ where: { tenantId } }),
  ]);
  const n = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return (
    <div className="stack gap-4">
      <div className="grid grid-4"><Stat label="Published" value={n("PUBLISHED")} /><Stat label="Drafts" value={n("DRAFT")} /><Stat label="Awaiting approval" value={n("PENDING_APPROVAL")} /><Stat label="Linked to tickets" value={linked} /></div>
      <div className="grid grid-2">
        <Card title="Most read"><Table head={["Article", "Views"]} empty={!top.length}>{top.map((a) => <tr key={a.id}><td><Link href={`/helpdesk/knowledge/${a.id}`}>{a.title}</Link></td><td className="num">{a.views}</td></tr>)}</Table></Card>
        <Card title="Rated not helpful"><Table head={["Article", "Not helpful", "Helpful"]} empty={!unhelpful.length}>{unhelpful.map((a) => <tr key={a.id}><td><Link href={`/helpdesk/knowledge/${a.id}`}>{a.title}</Link></td><td className="num">{a.helpfulNo}</td><td className="num">{a.helpfulYes}</td></tr>)}</Table></Card>
      </div>
    </div>
  );
}
