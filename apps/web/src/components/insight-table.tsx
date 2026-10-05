import type { ReactNode } from "react";
import type { InsightTable, CellFormat } from "@/lib/insight/export";

/**
 * An insight table on screen, with its CSV / Excel / PDF downloads. The
 * download runs the same dataset through /insights/export, so the file
 * always matches what is shown. Server component.
 */

export function fmtCell(v: unknown, f: CellFormat = "text"): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (f === "pct") return `${Math.round(v * 10) / 10}%`;
    if (f === "int") return Math.round(v).toLocaleString("en-IN");
    if (f === "inr") return `₹${Math.round(v).toLocaleString("en-IN")}`;
    return (Math.round(v * 100) / 100).toLocaleString("en-IN");
  }
  return String(v);
}

export function exportHref(ds: string, format: "csv" | "xlsx" | "pdf", params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams({ ds, format });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "" && k !== "ds" && k !== "format" && k !== "tab") q.set(k, v);
  return `/insights/export?${q.toString()}`;
}

export function ExportLinks({ ds, params }: { ds: string; params?: Record<string, string | undefined> }) {
  return (
    <span className="row gap-2" aria-label="Download">
      <a className="btn sm" href={exportHref(ds, "csv", params)}>CSV</a>
      <a className="btn sm" href={exportHref(ds, "xlsx", params)}>Excel</a>
      <a className="btn sm" href={exportHref(ds, "pdf", params)}>PDF</a>
    </span>
  );
}

export function InsightTableView({ table, ds, params, limit = 300, extra, extraHead, hideExport }: {
  table: InsightTable | null; ds?: string; params?: Record<string, string | undefined>; limit?: number;
  extra?: (row: Record<string, unknown>) => ReactNode; extraHead?: string; hideExport?: boolean;
}) {
  if (!table) return <div className="empty"><div className="empty-title">You do not have access to this table.</div></div>;
  return (
    <div className="stack gap-2">
      <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <strong className="text-sm">{table.title} <span className="muted">· {table.rows.length} row(s)</span></strong>
        {ds && !hideExport ? <ExportLinks ds={ds} params={params} /> : null}
      </div>
      {(table.notes ?? []).map((n, i) => <div key={i} className="hint">{n}</div>)}
      {table.rows.length === 0 ? <div className="empty"><div className="empty-title">Nothing here yet</div></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>{table.columns.map((c) => <th key={c.key} className={c.format && c.format !== "text" && c.format !== "date" ? "num" : undefined}>{c.label}</th>)}{extra ? <th>{extraHead ?? ""}</th> : null}</tr></thead>
            <tbody>
              {table.rows.slice(0, limit).map((r, i) => (
                <tr key={i}>
                  {table.columns.map((c) => <td key={c.key} className={c.format && c.format !== "text" && c.format !== "date" ? "num" : undefined}>{fmtCell(r[c.key], c.format)}</td>)}
                  {extra ? <td>{extra(r)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.rows.length > limit ? <div className="hint">Showing the first {limit}; download for all {table.rows.length}.</div> : null}
    </div>
  );
}
