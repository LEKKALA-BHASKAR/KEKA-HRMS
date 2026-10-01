"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, useForm } from "@/components/form";
import {
  startOffCycleAction, addOffCycleItemAction, removeOffCycleItemAction, toggleOffCycleBonusAction, finalizeOffCycleAction, releaseOffCycleAction, rollbackOffCycleAction,
} from "@/app/actions/off-cycle";

export interface Option { value: string; label: string }

export function StartOffCycleForm({ baseRunId, employees, today }: { baseRunId: string; employees: Option[]; today: string }) {
  const [filter, setFilter] = useState("");
  const shown = employees.filter((e) => e.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <ActionForm action={startOffCycleAction} submitLabel="Start off-cycle payroll" hidden={{ baseRunId }}>
      {(state) => (
        <div className="stack gap-3">
          <div className="grid grid-2">
            <Field label="What it is for" name="reason" state={state} required><TextInput name="reason" state={state} maxLength={200} required placeholder="e.g. Retention bonus, salary correction" /></Field>
            <Field label="Pay date" name="payDate" state={state}><TextInput name="payDate" type="date" state={state} defaultValue={today} /></Field>
          </div>
          <div>
            <div className="row gap-2" style={{ marginBottom: 6, alignItems: "center" }}>
              <strong className="text-sm">Employees</strong>
              <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 220 }} />
            </div>
            <div className="stack gap-1" style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
              {employees.map((e) => (
                <label key={e.value} className="row gap-2 text-sm" style={{ display: shown.includes(e) ? "flex" : "none" }}>
                  <input type="checkbox" name="employeeIds" value={e.value} /> {e.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function AddOffCycleItemForm({ runId, employees }: { runId: string; employees: Option[] }) {
  const [state, formAction, pending] = useForm(addOffCycleItemAction);
  return (
    <form action={formAction} className="row gap-2 wrap" style={{ padding: 14, borderTop: "1px solid var(--border)", alignItems: "center" }}>
      <input type="hidden" name="runId" value={runId} />
      <select className="select" name="employeeId" required style={{ maxWidth: 230 }}>
        <option value="">Select employee…</option>
        {employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
      </select>
      <select className="select" name="type" defaultValue="PAYMENT" style={{ maxWidth: 140 }}>
        <option value="PAYMENT">Payment</option>
        <option value="DEDUCTION">Deduction</option>
      </select>
      <input className="input" name="name" placeholder="Description" required style={{ maxWidth: 200 }} />
      <input className="input num" name="amount" type="number" min={1} step="1" placeholder="Amount" required style={{ maxWidth: 120 }} />
      <label className="row gap-1 text-sm nowrap"><input type="checkbox" name="taxable" defaultChecked /> Taxable</label>
      <button className="btn primary" disabled={pending}>{pending ? "Adding…" : "Add"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

function SmallAction({ action, hidden, label, className = "btn sm ghost" }: { action: Parameters<typeof useForm>[0]; hidden: Record<string, string>; label: string; className?: string }) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} style={{ display: "inline" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={className} disabled={pending}>{pending ? "…" : label}</button>
      {state.message && !state.ok ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export const RemoveOffCycleItem = ({ runId, itemId }: { runId: string; itemId: string }) => <SmallAction action={removeOffCycleItemAction} hidden={{ runId, itemId }} label="Remove" />;
export const ToggleOffCycleBonus = ({ runId, bonusId, include }: { runId: string; bonusId: string; include: boolean }) =>
  <SmallAction action={toggleOffCycleBonusAction} hidden={{ runId, bonusId, include: include ? "1" : "0" }} label={include ? "Pay in this run" : "Take out"} className={include ? "btn sm" : "btn sm ghost"} />;

export function FinalizeOffCycle({ runId }: { runId: string }) {
  const [state, formAction, pending] = useForm(finalizeOffCycleAction);
  return (
    <form action={formAction} onSubmit={(e) => { if (!confirm("Finalise this off-cycle payroll? Payslips are generated and the items are marked paid.")) e.preventDefault(); }}>
      <input type="hidden" name="runId" value={runId} />
      <button className="btn primary" disabled={pending}>{pending ? "Finalising…" : "Finalise"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export const ReleaseOffCycle = ({ runId }: { runId: string }) => <SmallAction action={releaseOffCycleAction} hidden={{ runId }} label="Release payslips" className="btn" />;

export function RollbackOffCycle({ runId }: { runId: string }) {
  const [state, formAction, pending] = useForm(rollbackOffCycleAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="runId" value={runId} />
      <input className="input" name="reason" placeholder="Reason for rolling back" required style={{ maxWidth: 240 }} />
      <button className="btn danger" disabled={pending}>{pending ? "…" : "Roll back"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}
