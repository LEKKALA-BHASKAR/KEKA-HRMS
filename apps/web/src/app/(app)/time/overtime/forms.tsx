"use client";

import { useForm, ActionForm, Field, TextInput, SelectInput } from "@/components/form";
import { decideOvertimeAction, setOvertimeRateAction, addOvertimeAction } from "@/app/actions/overtime";

export function OvertimeDecision({ id, current }: { id: string; current: string }) {
  const [state, formAction, pending] = useForm(decideOvertimeAction);
  return (
    <form action={formAction} className="row gap-2" style={{ justifyContent: "flex-end", alignItems: "center" }}>
      <input type="hidden" name="id" value={id} />
      <select className="input sm" name="action" defaultValue={current}>
        <option value="PAY">Pay in run</option>
        <option value="PAID_OUTSIDE">Paid outside</option>
        <option value="VOID">Void</option>
      </select>
      <button className="btn sm" disabled={pending}>Save</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function OvertimeRate({ id, rate }: { id: string; rate: number }) {
  const [state, formAction, pending] = useForm(setOvertimeRateAction);
  return (
    <form action={formAction} className="row gap-2" style={{ alignItems: "center", justifyContent: "flex-end" }}>
      <input type="hidden" name="id" value={id} />
      <input className="input sm num" name="rate" type="number" step="0.01" min={0} defaultValue={rate || ""} style={{ width: 90 }} aria-label="Hourly rate" />
      <button className="btn sm ghost" disabled={pending}>Set</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function AddOvertime({ employees, month }: { employees: { value: string; label: string }[]; month: string }) {
  return (
    <ActionForm action={addOvertimeAction} submitLabel="Add overtime">
      {(state) => (
        <div className="grid grid-2">
          <Field label="Employee" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={employees} required placeholder="Choose" /></Field>
          <Field label="Pay month" name="month" state={state} required><TextInput name="month" type="month" state={state} defaultValue={month} required /></Field>
          <Field label="Hours" name="hours" state={state} required><TextInput name="hours" type="number" step="0.25" state={state} required /></Field>
          <Field label="Hourly rate" name="rate" state={state} hint="Blank uses annual basic ÷ 2,920"><TextInput name="rate" type="number" step="0.01" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}
