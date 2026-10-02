import Link from "next/link";
import { notFound } from "next/navigation";
import { PERMISSIONS as P } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { datasetsFor, savedReportFor, resolveSpec, runCustomReport } from "@/lib/report-builder";
import { PageHead, Card, Empty, Callout } from "@/components/ui";
import { SpecEditor, SaveReport, DeleteReport } from "../forms";
import { ResultTable } from "../table";

export default async function CustomReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ spec?: string; dataset?: string }> }) {
  const viewer = await requireAuth(P.REPORT_VIEW);
  const { id } = await params;
  const sp = await searchParams;
  const builder = can(viewer, P.REPORT_BUILD);
  const saved = id === "new" ? null : await savedReportFor(viewer, id);
  if (id !== "new" && !saved) notFound();
  if (id === "new" && !builder) notFound();
  const spec = resolveSpec(builder ? sp.spec : undefined, saved, sp.dataset);
  const result = await runCustomReport(viewer, spec);
  const datasets = datasetsFor(viewer).map((d) => ({ key: d.key, title: d.title, window: d.window, fields: d.fields }));
  const mine = !!saved && saved.createdBy === viewer.user.id;
  const exportQs = new URLSearchParams(sp.spec && builder ? { spec: sp.spec } : saved ? { id: saved.id } : { spec: JSON.stringify(spec) }).toString();
  const unsaved = !!sp.spec && builder;

  return (
    <>
      <PageHead title={saved?.name ?? "New report"} subtitle={saved?.description ?? (result.ok ? result.dataset.description : undefined)}
        actions={<><Link className="btn" href="/reports/builder">All custom reports</Link>{result.ok ? <a className="btn primary" href={`/reports/builder/export?${exportQs}`}>Download CSV</a> : null}</>} />
      <div className="stack gap-4">
        {builder && datasets.length ? (
          <Card title="Build" description={unsaved && saved ? "You have changed this report; save to keep the changes." : undefined}>
            <SpecEditor key={JSON.stringify(spec)} basePath={`/reports/builder/${id}`} datasets={datasets} initial={spec} />
          </Card>
        ) : null}
        {!result.ok ? <Callout tone="warning" title="This report cannot run yet">{result.errors.join(" ")}</Callout> : (
          <Card tight title={`${result.rows.length.toLocaleString("en-IN")} row${result.rows.length === 1 ? "" : "s"}`}
            description={`${result.matched.toLocaleString("en-IN")} record${result.matched === 1 ? "" : "s"} matched your filters${result.capped || result.truncated ? ". The data was cut off at 5,000 records; narrow the date window or add filters." : "."}`}>
            {result.rows.length === 0 ? <Empty title="No records match" /> : <ResultTable result={result} />}
            {result.rows.length > 500 ? <div className="text-xs subtle" style={{ padding: "10px 18px" }}>Showing the first 500 rows. The download has all of them.</div> : null}
          </Card>
        )}
        {builder && result.ok ? (
          <Card title={saved ? (mine ? "Save" : "Save your own copy") : "Save this report"}>
            <SaveReport spec={spec} saved={saved ? { id: saved.id, name: saved.name, description: saved.description, shared: saved.shared, mine } : null} />
            {mine ? <div style={{ marginTop: 12 }}><DeleteReport id={saved!.id} /></div> : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
