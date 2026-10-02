"use client";

import { useState } from "react";
import { useForm, ActionForm, Field, TextInput, SelectInput } from "@/components/form";
import { saveRosterAction, applyPatternAction, copyWeekAction, savePatternAction, deletePatternAction } from "@/app/actions/roster";

type Shift = { id: string; name: string; code: string; color: string | null };
type Cell = { date: string; shiftId: string | null; off: boolean; explicit: boolean };
type Row = { id: string; name: string; number: string; cells: Cell[] };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The week grid: one select per employee-day. Blank follows their policy. */
export function RosterGrid({ rows, days, shifts, week }: { rows: Row[]; days: string[]; shifts: Shift[]; week: string }) {
  const [state, formAction, pending] = useForm(saveRosterAction);
  const [copyState, copyAction, copying] = useForm(copyWeekAction);
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const policyLabel = (c: Cell) => (c.off ? "Off" : c.shiftId ? byId.get(c.shiftId)?.code ?? "Shift" : "—");
  return (
    <>
      <form action={formAction}>
        <div className="table-wrap">
          <table className="data roster">
            <thead>
              <tr>
                <th>Employee</th>
                {days.map((d) => {
                  const dt = new Date(`${d}T00:00:00Z`);
                  return <th key={d} className="center">{DOW[dt.getUTCDay()]}<div className="text-xs subtle">{dt.getUTCDate()}</div></th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap"><strong>{r.name}</strong><div className="text-xs subtle">{r.number}</div></td>
                  {r.cells.map((c) => {
                    const value = c.explicit ? (c.off ? "OFF" : c.shiftId ?? "") : "";
                    const color = c.off ? undefined : (c.shiftId ? byId.get(c.shiftId)?.color : null) ?? undefined;
                    return (
                      <td key={c.date} className="center" style={{ borderLeft: color ? `3px solid ${color}` : undefined, opacity: c.explicit ? 1 : 0.75 }}>
                        <select className="input sm" name={`cell:${r.id}:${c.date}`} defaultValue={value} style={{ minWidth: 84 }} aria-label={`${r.name} ${c.date}`}>
                          <option value="">{policyLabel(c)} (policy)</option>
                          {shifts.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                          <option value="OFF">Weekly off</option>
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row gap-2" style={{ marginTop: 12, alignItems: "center" }}>
          <button className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save roster"}</button>
          {state.message ? <span className={`text-sm ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
        </div>
      </form>
      <form action={copyAction} className="row gap-2" style={{ marginTop: 8, alignItems: "center" }}>
        <input type="hidden" name="week" value={week} />
        {rows.map((r) => <input key={r.id} type="hidden" name="employeeIds" value={r.id} />)}
        <button className="btn sm" disabled={copying}>Copy this week to next week</button>
        {copyState.message ? <span className={`text-sm ${copyState.ok ? "pos" : "neg"}`}>{copyState.message}</span> : null}
      </form>
    </>
  );
}

export function ApplyPatternForm({ patterns, employees, defaultFrom, defaultTo }: {
  patterns: { id: string; name: string }[]; employees: { id: string; label: string }[]; defaultFrom: string; defaultTo: string;
}) {
  return (
    <ActionForm action={applyPatternAction} submitLabel="Apply pattern">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Pattern" name="patternId" state={state} required>
              <SelectInput name="patternId" state={state} required options={patterns.map((p) => ({ value: p.id, label: p.name }))} placeholder="Choose" />
            </Field>
            <Field label="Employees" name="employeeIds" state={state} required hint="Hold Ctrl or Cmd to pick several">
              <select className="input" name="employeeIds" multiple size={5}>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </Field>
            <Field label="From" name="from" state={state} required><TextInput type="date" name="from" state={state} defaultValue={defaultFrom} required /></Field>
            <Field label="To" name="to" state={state} required><TextInput type="date" name="to" state={state} defaultValue={defaultTo} required /></Field>
            <Field label="Start on day" name="startStep" state={state} hint="Which day of the cycle the first date is"><TextInput type="number" name="startStep" state={state} defaultValue={1} min={1} /></Field>
            <Field label="Stagger each employee by" name="staggerBy" state={state} hint="Days; 0 keeps everyone in step"><TextInput type="number" name="staggerBy" state={state} defaultValue={0} min={0} /></Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PatternForm({ shifts, pattern }: { shifts: Shift[]; pattern?: { id: string; name: string; steps: { shiftId: string | null; off: boolean }[] } }) {
  const [len, setLen] = useState(Math.max(7, pattern?.steps.length ?? 7));
  return (
    <ActionForm action={savePatternAction} submitLabel={pattern ? "Save pattern" : "Create pattern"} hidden={pattern ? { id: pattern.id } : undefined}>
      {(state) => (
        <>
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} defaultValue={pattern?.name} required placeholder="e.g. 5 mornings, 2 off, 5 nights, 2 off" />
          </Field>
          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            {Array.from({ length: len }, (_, i) => {
              const st = pattern?.steps[i];
              return (
                <label key={i} className="stack text-xs" style={{ width: 92 }}>
                  Day {i + 1}
                  <select className="input sm" name={`step${i}`} defaultValue={st ? (st.off ? "OFF" : st.shiftId ?? "") : ""}>
                    <option value="">—</option>
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                    <option value="OFF">Off</option>
                  </select>
                </label>
              );
            })}
          </div>
          <div className="row gap-2">
            <button type="button" className="btn sm ghost" onClick={() => setLen((n) => Math.min(56, n + 7))}>Add a week</button>
            {len > 7 ? <button type="button" className="btn sm ghost" onClick={() => setLen((n) => Math.max(7, n - 7))}>Remove a week</button> : null}
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeletePattern({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(deletePatternAction);
  if (state.ok) return <span className="text-xs pos">Deleted</span>;
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button className="btn sm ghost" disabled={pending}>Delete</button>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
