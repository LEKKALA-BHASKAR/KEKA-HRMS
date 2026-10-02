"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { saveFbpDeclarationAction } from "@/app/actions/fbp";

const inr = (v: number) => `INR ${v.toLocaleString("en-IN")}`;

/** The employee's split of their flexible amount across the plan's components. */
export function FbpForm({ pool, components, editable }: { pool: number; components: Array<{ id: string; name: string; limit: number; declared: number }>; editable: boolean }) {
  const [state, formAction, pending] = useForm(saveFbpDeclarationAction);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(components.map((c) => [c.id, c.declared ? String(c.declared) : ""])));
  const total = Object.values(values).reduce((s, v) => s + (Number(v.replace(/,/g, "")) || 0), 0);
  const over = total > pool;
  return (
    <form action={formAction} className="stack gap-3">
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Component</th><th className="num">Allowed a year</th><th className="num">Your amount a year</th><th className="num">A month</th></tr></thead>
          <tbody>
            {components.map((c) => {
              const v = Number(values[c.id]?.replace(/,/g, "")) || 0;
              const err = state.errors?.[`amount:${c.id}`];
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{inr(c.limit)}</td>
                  <td className="num">
                    {editable ? (
                      <input className="input num" name={`amount:${c.id}`} type="number" min={0} max={c.limit} step="100" value={values[c.id]}
                        onChange={(e) => setValues({ ...values, [c.id]: e.target.value })} aria-label={`${c.name} a year`} style={{ width: 140 }} />
                    ) : inr(c.declared)}
                    {err ? <div className="text-xs neg">{err}</div> : null}
                  </td>
                  <td className="num muted">{inr(Math.round((editable ? v : c.declared) / 12))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><th>Total</th><th /><th className={`num ${over ? "neg" : ""}`}>{inr(editable ? total : components.reduce((s, c) => s + c.declared, 0))}</th><th className="num">of {inr(pool)} available</th></tr>
          </tfoot>
        </table>
      </div>
      {editable ? (
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <button className="btn primary" disabled={pending || over || total <= 0}>{pending ? "Saving…" : "Submit declaration"}</button>
          <span className="text-sm muted">Once submitted it is locked for the year; the payroll team can reopen it.</span>
        </div>
      ) : null}
      {state.message ? <div className={`text-sm ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}
