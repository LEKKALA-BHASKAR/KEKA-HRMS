"use client";

import { useActionState } from "react";
import { runImportAction, type ImportResult } from "@/app/actions/import";

const EMPTY: ImportResult = {};

/** Upload a CSV, check it, then import it. Every row problem is listed by spreadsheet line. */
export function ImportUpload({ kind }: { kind: string }) {
  const [state, action, pending] = useActionState(runImportAction, EMPTY);
  return (
    <form action={action} style={{ padding: 14 }}>
      <input type="hidden" name="kind" value={kind} />
      <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
        <input type="file" name="file" accept=".csv,text/csv" required className="input" style={{ maxWidth: 360 }} />
        <button className="btn" type="submit" name="mode" value="check" disabled={pending}>{pending ? "Working…" : "Check file"}</button>
        <button className="btn primary" type="submit" name="mode" value="import" disabled={pending}>{pending ? "Working…" : "Import"}</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>Checking changes nothing. Import checks again and refuses the whole file if any row is wrong.</div>
      {state.message ? (
        <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginTop: 12 }}>
          <div>{state.message}</div>
        </div>
      ) : null}
      {state.rowErrors?.length ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead><tr><th className="num">Line</th><th>Problem</th></tr></thead>
            <tbody>
              {state.rowErrors.map((e) => (
                <tr key={e.line}><td className="num mono">{e.line}</td><td className="text-sm">{e.message}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}
