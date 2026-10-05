import Link from "next/link";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR, formatDate, fyLabel } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { reportsFor, defaultParams, type Column, type ReportResult } from "@/lib/reports";
import { PageHead, Card, Empty } from "@/components/ui";
import { ReportSchedules } from "./schedules";
import { DashboardTabs } from "../analytics/_components/dashboard";

function Cell({ v, c }: { v: unknown; c: Column }) {
  if (v === null || v === undefined || v === "") return <span className="subtle">—</span>;
  if (v instanceof Date) return <>{formatDate(v)}</>;
  if (typeof v === "number") {
    if (c.format === "inr") return <>{formatINR(v)}</>;
    if (c.format === "pct") return <>{(v * 100).toFixed(1)}%</>;
    if (c.format === "int") return <>{Math.round(v).toLocaleString("en-IN")}</>;
    return <>{Math.round(v * 100) / 100}</>;
  }
  return <>{String(v)}</>;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ r?: string; fy?: string; month?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.REPORT_VIEW);
  const sp = await searchParams;
  const available = reportsFor(viewer);
  const report = available.find((r) => r.key === sp.r) ?? available[0];
  const params = defaultParams(viewer, sp);
  const result: ReportResult | null = report ? await report.run(viewer, params) : null;
  const groups = [...new Set(available.map((r) => r.group))];
  const qs = (extra: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ r: report?.key, fy: params.fy, month: params.month, ...extra })) if (v !== undefined) u.set(k, String(v));
    return u.toString();
  };
  const num = (c: Column) => c.format && c.format !== "text" && c.format !== "date";

  return (
    <>
      <DashboardTabs viewer={viewer} active="reports" />
      <PageHead title="Employee Reports" subtitle="Each report shows only the people your role covers, on screen and in the download" actions={<span className="row gap-2"><Link className="btn" href="/insights/reports">Report operations</Link><Link className="btn" href="/reports/builder">Custom reports</Link></span>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "250px minmax(0, 1fr)", alignItems: "start" }}>
        <Card tight>
          <div className="stack" style={{ padding: 6 }}>
            {groups.map((g) => (
              <div key={g}>
                <div className="nav-section-label" style={{ padding: "8px 8px 4px" }}>{g}</div>
                {available.filter((r) => r.group === g).map((r) => (
                  <Link key={r.key} href={`/reports?r=${r.key}&fy=${params.fy}`} className={`nav-item${r.key === report?.key ? " active" : ""}`} style={{ display: "block" }}>{r.title}</Link>
                ))}
              </div>
            ))}
          </div>
        </Card>
        {report && result ? (
          <div className="stack gap-4">
          <Card tight title={report.title} description={report.description}
            action={
              <div className="row gap-2">
                <Link className="btn sm" href={`/reports?${qs({ fy: params.fy - 1 })}`}>‹ {fyLabel(params.fy - 1)}</Link>
                <span className="text-sm strong">{fyLabel(params.fy)}</span>
                <Link className="btn sm" href={`/reports?${qs({ fy: params.fy + 1 })}`}>{fyLabel(params.fy + 1)} ›</Link>
                <a className="btn sm primary" href={`/reports/export?${qs({})}`}>Download CSV</a>
                <a className="btn sm" href={`/reports/export?${qs({ format: "xlsx" })}`}>Excel</a>
                <a className="btn sm" href={`/reports/export?${qs({ format: "pdf" })}`}>PDF</a>
              </div>
            }>
            {report.key === "attendance-summary" ? (
              <div className="row gap-2 wrap" style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
                {[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((m) => (
                  <Link key={m} className={`btn sm${(params.month ?? new Date().getUTCMonth() + 1) === m ? " primary" : ""}`} href={`/reports?${qs({ month: m })}`}>
                    {["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m]}
                  </Link>
                ))}
              </div>
            ) : null}
            {result.rows.length === 0 ? <Empty title="Nothing to report">{result.notes?.[0]}</Empty> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr>{result.columns.map((c) => <th key={c.key} className={num(c) ? "num" : undefined}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} style={row._tone ? { background: row._tone === "danger" ? "var(--danger-bg)" : "var(--warning-bg)" } : undefined}>
                        {result.columns.map((c, j) => (
                          <td key={c.key} className={num(c) ? "num" : undefined}>
                            {j === 0 && row._href ? <Link href={row._href}><Cell v={row[c.key]} c={c} /></Link> : <Cell v={row[c.key]} c={c} />}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {result.totals ? (
                      <tr style={{ fontWeight: 650, borderTop: "2px solid var(--border-strong)" }}>
                        {result.columns.map((c) => <td key={c.key} className={num(c) ? "num" : undefined}>{result.totals![c.key] !== undefined ? <Cell v={result.totals![c.key]} c={c} /> : null}</td>)}
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
            {result.notes?.length && result.rows.length ? <div className="text-xs subtle" style={{ padding: "10px 18px" }}>{result.notes.join(" ")}</div> : null}
          </Card>
          <ReportSchedules viewer={viewer} reportKey={report.key} title={report.title} />
          </div>
        ) : <Card><Empty title="No reports available for your role" /></Card>}
      </div>
    </>
  );
}
