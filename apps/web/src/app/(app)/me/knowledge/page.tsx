import Link from "next/link";
import { prisma } from "@keka/db";
import { searchKb } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card } from "@/components/ui";
import { MeCasesTabs } from "../cases/tabs";

export const metadata = { title: "Knowledge base" };

/** Me › Cases › Knowledge base: search the published HR answers before raising a ticket. */
export default async function MyKnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const t = viewer.tenantId;
  const [cats, rows] = await Promise.all([
    prisma.kbCategory.findMany({ where: { tenantId: t, articles: { some: { status: "PUBLISHED" } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    searchKb(t, sp.q ?? "", { categoryId: sp.category || null, limit: 100 }),
  ]);
  return (
    <>
      <PageHead title="Knowledge base" subtitle="Answers to common HR questions. Can't find yours? Raise a helpdesk ticket." actions={<Link className="btn primary" href="/me/helpdesk?new=1">Raise a ticket</Link>} />
      <MeCasesTabs />
      <Card>
        <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
          <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Search, e.g. how do I download my payslip" style={{ width: 320 }} aria-label="Search the knowledge base" />
          <select className="select" name="category" defaultValue={sp.category ?? ""} aria-label="Section"><option value="">All sections</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn sm" type="submit">Search</button>
        </form>
        {rows.length ? (
          <ul className="stack gap-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rows.map((a) => (
              <li key={a.id}>
                <Link href={`/me/knowledge/${a.id}`}><strong>{a.title}</strong></Link>
                <div className="muted text-xs">{a.category?.name ?? "General"}</div>
                <div className="text-sm">{a.body.replace(/<[^>]+>/g, " ").slice(0, 200)}{a.body.length > 200 ? "…" : ""}</div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">{sp.q ? "No articles match that search." : "No articles have been published yet."}</p>}
      </Card>
    </>
  );
}
