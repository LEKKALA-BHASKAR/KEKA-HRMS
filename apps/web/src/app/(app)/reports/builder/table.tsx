import { formatINR } from "@keka/shared";
import type { EngineResult } from "@keka/services";

type Col = EngineResult["columns"][number];
const num = (c: Col) => !!c.format && !["text", "date"].includes(c.format);

function Cell({ v, c }: { v: unknown; c: Col }) {
  if (v === null || v === undefined || v === "") return <span className="subtle">—</span>;
  if (typeof v === "boolean") return <>{v ? "Yes" : "No"}</>;
  if (typeof v === "number") {
    if (c.format === "inr") return <>{formatINR(v)}</>;
    if (c.format === "pct") return <>{(v * 100).toFixed(1)}%</>;
    if (c.format === "int") return <>{Math.round(v).toLocaleString("en-IN")}</>;
    return <>{Math.round(v * 100) / 100}</>;
  }
  return <>{String(v)}</>;
}

/** The result table for a custom report; the CSV route writes the same cells. */
export function ResultTable({ result, limit = 500 }: { result: EngineResult; limit?: number }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{result.columns.map((c) => <th key={c.key} className={num(c) ? "num" : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {result.rows.slice(0, limit).map((row, i) => (
            <tr key={i}>{result.columns.map((c) => <td key={c.key} className={num(c) ? "num" : undefined}><Cell v={row[c.key]} c={c} /></td>)}</tr>
          ))}
          {result.totals ? (
            <tr style={{ fontWeight: 650, borderTop: "2px solid var(--border-strong)" }}>
              {result.columns.map((c, j) => <td key={c.key} className={num(c) ? "num" : undefined}>{result.totals![c.key] !== undefined ? <Cell v={result.totals![c.key]} c={c} /> : j === 0 ? "Total" : null}</td>)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
