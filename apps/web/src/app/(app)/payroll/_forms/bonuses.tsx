"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, CheckboxInput, DangerButton, useForm } from "@/components/form";
import {
  saveBonusTypeAction, deleteBonusTypeAction, scheduleBonusAction, removeBonusAction, decideBonusAction, decideClaimAction,
} from "@/app/actions/bonuses";

export interface Option { value: string; label: string }

export function BonusTypeForm({ type }: { type?: { id: string; name: string; description: string | null; isPartOfCtc: boolean; isTaxable: boolean; affectsEsi: boolean; isActive: boolean } }) {
  return (
    <ActionForm action={saveBonusTypeAction} submitLabel={type ? "Save" : "Add bonus type"} hidden={type ? { id: type.id } : undefined} compact>
      {(state) => (
        <div className="stack gap-2">
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={type?.name} maxLength={60} required /></Field>
            <Field label="Description" name="description" state={state}><TextInput name="description" state={state} defaultValue={type?.description ?? ""} maxLength={200} /></Field>
          </div>
          <div className="row gap-4 wrap">
            <CheckboxInput name="isTaxable" label="Taxable" defaultChecked={type?.isTaxable ?? true} />
            <CheckboxInput name="isPartOfCtc" label="Part of annual CTC" defaultChecked={type?.isPartOfCtc} />
            <CheckboxInput name="affectsEsi" label="Counts towards ESI wages" defaultChecked={type?.affectsEsi} />
            {type ? <CheckboxInput name="isActive" label="Active" defaultChecked={type.isActive} /> : <input type="hidden" name="isActive" value="on" />}
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function DeleteBonusType({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteBonusTypeAction} hidden={{ id }} label="Delete" confirmLabel={`Delete ${name}?`} />;
}

export function ScheduleBonusForm({ employees, types, month }: { employees: Option[]; types: Option[]; month: string }) {
  return (
    <ActionForm action={scheduleBonusAction} submitLabel="Schedule bonus" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Employee" name="employeeId" state={state} required>
            <SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required />
          </Field>
          <Field label="Bonus type" name="bonusTypeId" state={state} required>
            <SelectInput name="bonusTypeId" state={state} options={types} placeholder="Select…" required />
          </Field>
          <Field label="Amount (₹)" name="amount" state={state} required><TextInput name="amount" type="number" step="1" min={1} state={state} required /></Field>
          <Field label="Pay in" name="payout" state={state} required><TextInput name="payout" type="month" state={state} defaultValue={month} required /></Field>
          <Field label="Note" name="note" state={state}><TextInput name="note" state={state} maxLength={200} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveBonus({ id }: { id: string }) {
  return <DangerButton action={removeBonusAction} hidden={{ id }} label="Remove" confirmLabel="Remove this bonus?" />;
}

/** Step 3: what happens to one bonus in this run. */
export function BonusDecision({ runId, bonusId, amount, current }: { runId: string; bonusId: string; amount: number; current: string }) {
  const [state, formAction, pending] = useForm(decideBonusAction);
  const [action, setAction] = useState(current);
  return (
    <form action={formAction} className="row gap-2" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="bonusId" value={bonusId} />
      <select className="select" name="action" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Pay action" style={{ maxWidth: 190 }}>
        <option value="PAY">Pay</option>
        <option value="PARTIALLY_PAY">Pay part</option>
        <option value="ON_HOLD">Hold for later</option>
        <option value="PAY_OUTSIDE_PAYROLL">Paid outside payroll</option>
        <option value="VOID">Void</option>
      </select>
      {action === "PARTIALLY_PAY" ? <input className="input num" name="paidAmount" type="number" min={1} max={amount - 1} step="1" placeholder="Amount" required style={{ width: 110 }} aria-label="Amount to pay" /> : null}
      <button className="btn sm" disabled={pending || (action === current && action !== "PARTIALLY_PAY")}>{pending ? "Saving…" : "Apply"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ flexBasis: "100%", textAlign: "right" }}>{state.message}</div> : null}
    </form>
  );
}

/** Step 4: approve or reject one reimbursement claim. */
export function ClaimDecision({ runId, claimId, claimed }: { runId: string; claimId: string; claimed: number }) {
  const [state, formAction, pending] = useForm(decideClaimAction);
  const [mode, setMode] = useState<"idle" | "partial" | "reject">("idle");
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="claimId" value={claimId} />
      {mode === "partial" ? <input className="input num" name="payableAmount" type="number" min={1} max={claimed} step="1" defaultValue={claimed} required style={{ width: 120 }} aria-label="Payable amount" /> : null}
      {mode !== "idle" ? <input className="input" name="note" placeholder={mode === "reject" ? "Reason" : "Why less is paid"} required autoFocus style={{ width: 220 }} /> : null}
      <div className="row gap-2">
        {mode === "idle" ? (
          <>
            <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
            <button type="button" className="btn sm" onClick={() => setMode("partial")}>Pay less</button>
            <button type="button" className="btn sm" onClick={() => setMode("reject")}>Reject</button>
          </>
        ) : (
          <>
            <button className={`btn sm ${mode === "reject" ? "danger" : "primary"}`} name="decision" value={mode === "reject" ? "reject" : "approve"} disabled={pending}>{mode === "reject" ? "Reject" : "Approve amount"}</button>
            <button type="button" className="btn sm ghost" onClick={() => setMode("idle")}>Back</button>
          </>
        )}
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
