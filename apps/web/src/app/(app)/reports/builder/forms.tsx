"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Field, TextInput, FormBanner } from "@/components/form";
import { saveCustomReportAction, deleteCustomReportAction } from "@/app/actions/report-builder";
import type { FieldDef, ReportSpec, FilterOp, AggFn } from "@keka/services";

const OPS: Record<FilterOp, string> = {
  eq: "is", neq: "is not", contains: "contains", gt: "more than", gte: "at least", lt: "less than", lte: "at most", in: "is one of", empty: "is empty", notEmpty: "is not empty",
};
const OPS_FOR: Record<FieldDef["type"], FilterOp[]> = {
  text: ["eq", "neq", "contains", "in", "empty", "notEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  date: ["eq", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  bool: ["eq"],
};
const FNS: Record<AggFn, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum" };
const small = { padding: "4px 6px", fontSize: 13 } as const;

export interface DatasetOption { key: string; title: string; window: string | null; fields: FieldDef[] }

export function SpecEditor({ basePath, datasets, initial }: { basePath: string; datasets: DatasetOption[]; initial: ReportSpec }) {
  const router = useRouter();
  const [spec, setSpec] = useState<ReportSpec>(initial);
  const ds = datasets.find((d) => d.key === spec.dataset) ?? datasets[0]!;
  const fieldOf = (k: string) => ds.fields.find((f) => f.key === k);
  const set = (patch: Partial<ReportSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const sortable = spec.groupBy
    ? [{ key: spec.groupBy, label: fieldOf(spec.groupBy)?.label ?? spec.groupBy }, ...(spec.aggregates.length ? spec.aggregates : [{ field: spec.groupBy, fn: "count" as const }]).map((a) => ({ key: `${a.fn}_${a.field}`, label: a.fn === "count" ? "Count" : `${FNS[a.fn]} of ${fieldOf(a.field)?.label ?? a.field}` }))]
    : spec.columns.map((c) => ({ key: c, label: fieldOf(c)?.label ?? c }));

  const run = () => router.push(`${basePath}?spec=${encodeURIComponent(JSON.stringify(spec))}`);

  return (
    <div className="stack gap-3">
      <div className="row gap-3 wrap" style={{ alignItems: "end" }}>
        <label className="stack gap-1"><span className="label">Report on</span>
          <select className="select" value={spec.dataset} style={small}
            onChange={(e) => setSpec({ dataset: e.target.value, columns: datasets.find((d) => d.key === e.target.value)!.fields.slice(0, 4).map((f) => f.key), filters: [], aggregates: [], groupBy: null, sort: null, from: spec.from, to: spec.to })}>
            {datasets.map((d) => <option key={d.key} value={d.key}>{d.title}</option>)}
          </select>
        </label>
        {ds.window ? (
          <>
            <label className="stack gap-1"><span className="label">From ({ds.window})</span><input type="date" className="input" style={small} value={spec.from ?? ""} onChange={(e) => set({ from: e.target.value || null })} /></label>
            <label className="stack gap-1"><span className="label">To</span><input type="date" className="input" style={small} value={spec.to ?? ""} onChange={(e) => set({ to: e.target.value || null })} /></label>
          </>
        ) : null}
        <label className="stack gap-1"><span className="label">Group by</span>
          <select className="select" style={small} value={spec.groupBy ?? ""} onChange={(e) => set({ groupBy: e.target.value || null, sort: null })}>
            <option value="">No grouping (one row each)</option>
            {ds.fields.filter((f) => f.type !== "number").map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
      </div>

      {!spec.groupBy ? (
        <div>
          <div className="label">Columns</div>
          <div className="row gap-3 wrap">
            {ds.fields.map((f) => (
              <label key={f.key} className="row gap-1 text-sm">
                <input type="checkbox" checked={spec.columns.includes(f.key)}
                  onChange={(e) => set({ columns: e.target.checked ? [...spec.columns, f.key] : spec.columns.filter((c) => c !== f.key) })} />
                {f.label}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <div className="label">Filters</div>
        <div className="stack gap-1">
          {spec.filters.map((f, i) => {
            const def = fieldOf(f.field);
            const upd = (patch: Partial<typeof f>) => set({ filters: spec.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="row gap-1">
                <select className="select" style={small} value={f.field} aria-label="Filter field" onChange={(e) => upd({ field: e.target.value, op: OPS_FOR[fieldOf(e.target.value)!.type][0]!, value: "" })}>
                  {ds.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select className="select" style={small} value={f.op} aria-label="Condition" onChange={(e) => upd({ op: e.target.value as FilterOp })}>
                  {OPS_FOR[def?.type ?? "text"].map((o) => <option key={o} value={o}>{OPS[o]}</option>)}
                </select>
                {f.op === "empty" || f.op === "notEmpty" ? null : def?.type === "bool" ? (
                  <select className="select" style={small} value={f.value || "yes"} aria-label="Value" onChange={(e) => upd({ value: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select>
                ) : (
                  <input className="input" style={{ ...small, width: 180 }} aria-label="Value" type={def?.type === "date" ? "date" : def?.type === "number" ? "number" : "text"}
                    placeholder={f.op === "in" ? "a, b, c" : ""} value={f.value ?? ""} onChange={(e) => upd({ value: e.target.value })} />
                )}
                <button type="button" className="btn ghost sm" onClick={() => set({ filters: spec.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">✕</button>
              </div>
            );
          })}
          <div><button type="button" className="btn sm" onClick={() => set({ filters: [...spec.filters, { field: ds.fields[0]!.key, op: "eq", value: "" }] })}>Add filter</button></div>
        </div>
      </div>

      <div>
        <div className="label">{spec.groupBy ? "Values per group" : "Totals row"}</div>
        <div className="stack gap-1">
          {spec.aggregates.map((a, i) => {
            const upd = (patch: Partial<typeof a>) => set({ aggregates: spec.aggregates.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            const numeric = fieldOf(a.field)?.type === "number";
            return (
              <div key={i} className="row gap-1">
                <select className="select" style={small} value={a.fn} aria-label="Calculation" onChange={(e) => upd({ fn: e.target.value as AggFn })}>
                  {(Object.keys(FNS) as AggFn[]).filter((f) => numeric || !["sum", "avg"].includes(f)).map((f) => <option key={f} value={f}>{FNS[f]}</option>)}
                </select>
                <span className="text-sm subtle">of</span>
                <select className="select" style={small} value={a.field} aria-label="Field" onChange={(e) => upd({ field: e.target.value, fn: fieldOf(e.target.value)?.type === "number" ? a.fn : "count" })}>
                  {ds.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <button type="button" className="btn ghost sm" onClick={() => set({ aggregates: spec.aggregates.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
              </div>
            );
          })}
          <div><button type="button" className="btn sm" onClick={() => { const f = ds.fields.find((x) => x.type === "number") ?? ds.fields[0]!; set({ aggregates: [...spec.aggregates, { field: f.key, fn: f.type === "number" ? "sum" : "count" }] }); }}>Add {spec.groupBy ? "value" : "total"}</button></div>
        </div>
      </div>

      <div className="row gap-2" style={{ alignItems: "end" }}>
        <label className="stack gap-1"><span className="label">Sort by</span>
          <select className="select" style={small} value={spec.sort?.field ?? ""} onChange={(e) => set({ sort: e.target.value ? { field: e.target.value, dir: spec.sort?.dir ?? "asc" } : null })}>
            <option value="">As loaded</option>
            {sortable.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        {spec.sort ? (
          <select className="select" style={small} value={spec.sort.dir} aria-label="Direction" onChange={(e) => set({ sort: { field: spec.sort!.field, dir: e.target.value as "asc" | "desc" } })}>
            <option value="asc">Ascending</option><option value="desc">Descending</option>
          </select>
        ) : null}
        <button type="button" className="btn primary" onClick={run}>Run report</button>
      </div>
    </div>
  );
}

export function SaveReport({ spec, saved }: { spec: ReportSpec; saved: { id: string; name: string; description: string | null; shared: boolean; mine: boolean } | null }) {
  const [state, formAction, pending] = useForm(saveCustomReportAction);
  const json = JSON.stringify(spec);
  return (
    <form action={formAction} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="spec" value={json} />
      {saved ? <input type="hidden" name="id" value={saved.id} /> : null}
      <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={saved ? (saved.mine ? saved.name : `${saved.name} (copy)`) : ""} maxLength={120} /></Field>
      <Field label="Description" name="description" state={state}><TextInput name="description" state={state} defaultValue={saved?.description ?? ""} maxLength={500} /></Field>
      <label className="row gap-2 text-sm"><input type="checkbox" name="shared" defaultChecked={saved?.mine ? saved.shared : false} /> Share with colleagues who can read this data (each sees only their own people)</label>
      <div className="row gap-2">
        {saved?.mine ? <button className="btn primary" disabled={pending}>Save changes</button> : null}
        <button className={`btn${saved?.mine ? "" : " primary"}`} name="copy" value="1" disabled={pending}>{saved ? "Save as new report" : "Save report"}</button>
      </div>
      <span className="text-xs subtle">Saving keeps the last settings you ran.</span>
    </form>
  );
}

export function DeleteReport({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(deleteCustomReportAction);
  return (
    <form action={formAction} className="row gap-2" onSubmit={(e) => { if (!confirm("Delete this report?")) e.preventDefault(); }}>
      <input type="hidden" name="id" value={id} />
      <button className="btn ghost sm danger" disabled={pending}>Delete report</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}
