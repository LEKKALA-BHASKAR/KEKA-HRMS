"use client";

import { useState } from "react";
import { ActionForm, DangerButton, Field, TextInput, SelectInput, TextArea, CheckboxInput, useForm } from "@/components/form";
import {
  voidSettlementAction, emailFnfStatementAction, addFnfAdjustmentAction, attachFnfAdjustmentAction, removeFnfAdjustmentAction,
} from "@/app/actions/fnf";

export interface Option { value: string; label: string }

export function VoidSettlementForm({ employeeId }: { employeeId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn ghost" type="button" style={{ color: "var(--danger)" }} onClick={() => setOpen(true)}>Void settlement…</button>;
  return (
    <ActionForm action={voidSettlementAction} hidden={{ employeeId }} submitLabel="Void settlement"
      onDone={<button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>}>
      {(state) => (
        <Field label="Why is it being voided?" name="reason" state={state} required
          hint="Loans, recoveries, claims and bonuses the settlement closed are put back, its ledger entry is reversed, unpaid adjustments are removed and the exit reopens for a fresh settlement. Sign-in stays disabled.">
          <TextArea name="reason" state={state} rows={2} required placeholder="e.g. Gratuity computed on the wrong basic" />
        </Field>
      )}
    </ActionForm>
  );
}

export function EmailStatementForm({ employeeId, email }: { employeeId: string; email: string | null }) {
  const [state, action, pending] = useForm(emailFnfStatementAction);
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="row gap-2">
        <input className="input" name="to" type="email" defaultValue={email ?? ""} placeholder="Email address" style={{ width: 220 }} />
        <button className="btn" disabled={pending}>{pending ? "Sending…" : "Email statement"}</button>
      </div>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export function AddAdjustmentForm({ employeeId, targets }: { employeeId: string; targets: Option[] }) {
  return (
    <ActionForm action={addFnfAdjustmentAction} hidden={{ employeeId }} submitLabel="Add adjustment">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Type" name="type" state={state}>
              <SelectInput name="type" state={state} options={[{ value: "PAYMENT", label: "Pay the employee" }, { value: "DEDUCTION", label: "Recover from the employee" }]} />
            </Field>
            <Field label="Description" name="name" state={state} required>
              <TextInput name="name" state={state} required placeholder="e.g. Late travel reimbursement" maxLength={120} />
            </Field>
            <Field label="Amount (₹)" name="amount" state={state} required>
              <TextInput name="amount" state={state} type="number" min={1} step="0.01" required />
            </Field>
          </div>
          <Field label="Paid in" name="target" state={state} required hint="An open payroll the employee is in, or a month to hold it for until an off-cycle payroll picks it up.">
            <SelectInput name="target" state={state} options={targets} required />
          </Field>
          <Field label="Note" name="comment" state={state}>
            <TextInput name="comment" state={state} placeholder="Optional" maxLength={200} />
          </Field>
          <CheckboxInput name="taxable" label="Taxable (TDS applies when it is paid)" defaultChecked />
        </>
      )}
    </ActionForm>
  );
}

export function AttachAdjustment({ adjustmentId, runs }: { adjustmentId: string; runs: Option[] }) {
  const [state, action, pending] = useForm(attachFnfAdjustmentAction);
  if (runs.length === 0) return null;
  return (
    <form action={action} className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="adjustmentId" value={adjustmentId} />
      <select className="select" name="runId" style={{ width: 190 }} defaultValue={runs[0].value}>
        {runs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <button className="btn sm" disabled={pending}>{pending ? "…" : "Move"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function RemoveAdjustment({ adjustmentId }: { adjustmentId: string }) {
  return <DangerButton action={removeFnfAdjustmentAction} hidden={{ adjustmentId }} label="Remove" confirmLabel="Remove this adjustment?" />;
}
