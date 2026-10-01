import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireViewer, can } from "@/lib/context";
import { IMPORTS, IMPORT_KINDS, type ImportKind } from "@/lib/imports";
import { PageHead, Card, Badge } from "@/components/ui";
import { ImportUpload } from "./upload";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const viewer = await requireViewer();
  const allowed = IMPORT_KINDS.filter((k) => can(viewer, IMPORTS[k].permission));
  if (allowed.length === 0) forbidden();
  const sp = await searchParams;
  const kind: ImportKind = allowed.includes(sp.kind as ImportKind) ? (sp.kind as ImportKind) : allowed[0];
  const spec = IMPORTS[kind];

  return (
    <>
      <PageHead title="Bulk import" subtitle="Bring people, balances, salaries and bank details in from a spreadsheet saved as CSV" />
      <div className="tabs">
        {allowed.map((k) => (
          <Link key={k} href={`/admin/import?kind=${k}`} className={`tab${k === kind ? " active" : ""}`}>{IMPORTS[k].label}</Link>
        ))}
      </div>
      <div className="stack gap-4">
        <Card
          title={spec.label}
          description={spec.description}
          action={<a className="btn sm" href={`/admin/import/template?kind=${kind}`}>Download template</a>}
          tight
        >
          <ImportUpload kind={kind} />
        </Card>
        <Card title="Columns" description="Headers are matched ignoring case, spaces and punctuation. Columns not listed here are ignored." tight>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Column</th><th>Notes</th><th>Example</th></tr></thead>
              <tbody>
                {spec.columns.map((c) => (
                  <tr key={c.key}>
                    <td><span className="strong">{c.label}</span> {c.required ? <Badge tone="warning">required</Badge> : null}</td>
                    <td className="text-sm muted">{c.hint ?? ""}</td>
                    <td className="mono text-xs">{c.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
