"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, CheckboxInput, FormBanner, useForm } from "@/components/form";
import {
  submitClaimAction, decideClaimAction, claimOpAction, requestAdvanceAction, advanceOpAction, requestTripAction, tripOpAction, saveExpenseCategoryAction,
} from "@/app/actions/expenses";

export interface Option { value: string; label: string }
const today = () => new Date().toISOString().slice(0, 10);

export function ClaimForm({ categories, advances }: { categories: Array<Option & { cap: number | null; receiptAbove: number | null }>; advances: Option[] }) {
  const [state, action, pending] = useForm(submitClaimAction);
  const [rows, setRows] = useState([0]);
  const [amounts, setAmounts] = useState<Record<number, number>>({});
  const [cats, setCats] = useState<Record<number, string>>({});
  const total = Object.values(amounts).reduce((s, v) => s + (v || 0), 0);
  return (
    <form action={action}>
      <FormBanner state={state} />
      <div className="grid grid-2">
        <Field label="What is this for?" name="title" state={state} required><TextInput name="title" state={state} required placeholder="Client visit, Mumbai — Sep" /></Field>
        {advances.length ? <Field label="Settle against advance" name="advanceId" state={state}><SelectInput name="advanceId" state={state} options={advances} placeholder="None" /></Field> : <div />}
      </div>
      <div className="stack gap-2" style={{ marginBottom: 12 }}>
        {rows.map((i) => {
          const cat = categories.find((c) => c.value === cats[i]);
          const amt = amounts[i] ?? 0;
          return (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              <div className="grid grid-3">
                <Field label="Category" name={`categoryId_${i}`}><select name={`categoryId_${i}`} className="select" required value={cats[i] ?? ""} onChange={(e) => setCats({ ...cats, [i]: e.target.value })}><option value="">Select…</option>{categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>
                <Field label="Date" name={`expenseDate_${i}`}><input type="date" name={`expenseDate_${i}`} className="input" defaultValue={today()} max={today()} required /></Field>
                <Field label="Amount (₹)" name={`amount_${i}`}><input type="number" step="0.01" name={`amount_${i}`} className="input num" required onChange={(e) => setAmounts({ ...amounts, [i]: Number(e.target.value) })} /></Field>
                <Field label="Merchant" name={`merchant_${i}`}><input name={`merchant_${i}`} className="input" /></Field>
                <Field label="Receipt" name={`receipt_${i}`} hint={cat?.receiptAbove !== null && cat?.receiptAbove !== undefined ? `Required above ₹${cat.receiptAbove.toLocaleString("en-IN")}` : "PDF, PNG or JPEG"}><input type="file" name={`receipt_${i}`} accept="application/pdf,image/png,image/jpeg" className="text-xs" /></Field>
                <div className="text-xs" style={{ paddingTop: 24, color: cat?.cap && amt > cat.cap ? "var(--warning)" : "var(--text-subtle)" }}>
                  {cat?.cap ? (amt > cat.cap ? `Over the ₹${cat.cap.toLocaleString("en-IN")} limit` : `Limit ₹${cat.cap.toLocaleString("en-IN")}`) : ""}
                  {rows.length > 1 ? <button type="button" className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => { setRows(rows.filter((r) => r !== i)); const a = { ...amounts }; delete a[i]; setAmounts(a); }}>Remove</button> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn sm" onClick={() => setRows([...rows, Math.max(...rows) + 1])}>+ Add another expense</button>
        <span className="strong">Total ₹{total.toLocaleString("en-IN")}</span>
      </div>
      <div className="row gap-2" style={{ marginTop: 12 }}>
        <button className="btn primary" name="intent" value="submit" disabled={pending}>{pending ? "Submitting…" : "Submit for approval"}</button>
        <button className="btn" name="intent" value="draft" disabled={pending}>Save draft</button>
      </div>
    </form>
  );
}

export function ClaimDecision({ claimId, lines }: { claimId: string; lines: Array<{ id: string; label: string; amount: number; suggested: number }> }) {
  const [state, action, pending] = useForm(decideClaimAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="claimId" value={claimId} />
      {lines.map((l) => (
        <div key={l.id} className="row" style={{ justifyContent: "space-between", gap: 10 }}>
          <span className="text-sm">{l.label} <span className="subtle">· claimed ₹{l.amount.toLocaleString("en-IN")}</span></span>
          <input className="input num" name={`approved_${l.id}`} type="number" step="0.01" min={0} max={l.amount} defaultValue={l.suggested} style={{ width: 120 }} aria-label="Approve amount" />
        </div>
      ))}
      {rejecting ? <input className="input" name="reason" placeholder="Why it is rejected" required /> : null}
      <div className="row gap-2">
        {rejecting ? <><button className="btn danger" name="decision" value="reject" disabled={pending}>Reject claim</button><button type="button" className="btn ghost" onClick={() => setRejecting(false)}>Back</button></>
          : <><button className="btn primary" name="decision" value="approve" disabled={pending}>{pending ? "…" : "Approve these amounts"}</button><button type="button" className="btn" onClick={() => setRejecting(true)}>Reject</button></>}
      </div>
    </form>
  );
}

export function ClaimOps({ claimId, ops }: { claimId: string; ops: Array<"submit" | "cancel" | "paid"> }) {
  const [state, action, pending] = useForm(claimOpAction);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="claimId" value={claimId} />
      {ops.includes("submit") ? <button className="btn sm primary" name="op" value="submit" disabled={pending}>Submit for approval</button> : null}
      {ops.includes("cancel") ? <button className="btn sm ghost" name="op" value="cancel" disabled={pending}>Withdraw</button> : null}
      {ops.includes("paid") ? <button className="btn sm" name="op" value="paid" disabled={pending}>Mark paid</button> : null}
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function AdvanceForm() {
  return (
    <ActionForm action={requestAdvanceAction} submitLabel="Request advance" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Amount (₹)" name="amount" state={state} required><TextInput name="amount" type="number" state={state} required /></Field>
          <Field label="Needed by" name="neededBy" state={state}><TextInput name="neededBy" type="date" state={state} /></Field>
          <Field label="Purpose" name="purpose" state={state} required><TextInput name="purpose" state={state} required /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function AdvanceOps({ advanceId, ops }: { advanceId: string; ops: string[] }) {
  const [state, action, pending] = useForm(advanceOpAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="advanceId" value={advanceId} />
      {ops.map((op) => <button key={op} className={`btn sm${op === "approve" || op === "disburse" ? " primary" : ""}`} name="op" value={op} disabled={pending}>{{ approve: "Approve", reject: "Reject", disburse: "Mark disbursed", recover: "Recover via payroll" }[op]}</button>)}
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ width: "100%", textAlign: "right" }}>{state.message}</span> : null}
    </form>
  );
}

export function TripForm() {
  return (
    <ActionForm action={requestTripAction} submitLabel="Request trip">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="From" name="fromCity" state={state} required><TextInput name="fromCity" state={state} required defaultValue="Bengaluru" /></Field>
            <Field label="To" name="toCity" state={state} required><TextInput name="toCity" state={state} required /></Field>
            <Field label="Type" name="travelType" state={state}><SelectInput name="travelType" state={state} options={[{ value: "DOMESTIC", label: "Domestic" }, { value: "INTERNATIONAL", label: "International" }]} /></Field>
            <Field label="Depart" name="departDate" state={state} required><TextInput name="departDate" type="date" state={state} required /></Field>
            <Field label="Return" name="returnDate" state={state}><TextInput name="returnDate" type="date" state={state} /></Field>
            <Field label="Estimated cost (₹)" name="estimatedCost" state={state}><TextInput name="estimatedCost" type="number" state={state} /></Field>
          </div>
          <Field label="Purpose" name="purpose" state={state} required><TextInput name="purpose" state={state} required /></Field>
          <CheckboxInput name="needsAccommodation" label="Needs a hotel" />
        </>
      )}
    </ActionForm>
  );
}

export function TripOps({ tripId, ops }: { tripId: string; ops: string[] }) {
  const [state, action, pending] = useForm(tripOpAction);
  const [mode, setMode] = useState<string | null>(null);
  return (
    <form action={action} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="tripId" value={tripId} />
      {mode === "book" ? <div className="row gap-2"><input className="input" name="bookingRef" placeholder="PNR / booking ref" required style={{ width: 150 }} /><input className="input num" name="actualCost" type="number" placeholder="Cost" style={{ width: 100 }} /></div> : null}
      {mode === "reject" ? <input className="input" name="reason" placeholder="Reason" required style={{ width: 200 }} /> : null}
      <div className="row gap-2">
        {mode ? <><button className="btn sm primary" name="op" value={mode} disabled={pending}>Confirm</button><button type="button" className="btn sm ghost" onClick={() => setMode(null)}>Back</button></>
          : ops.map((op) => op === "book" || op === "reject"
            ? <button key={op} type="button" className="btn sm" onClick={() => setMode(op)}>{op === "book" ? "Book" : "Reject"}</button>
            : <button key={op} className={`btn sm${op === "approve" ? " primary" : ""}`} name="op" value={op} disabled={pending}>{{ approve: "Approve", complete: "Complete", cancel: "Cancel" }[op]}</button>)}
      </div>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function CategoryForm({ c }: { c?: { id: string; name: string; maxAmount: number | null; receiptRequiredAbove: number | null } }) {
  return (
    <ActionForm action={saveExpenseCategoryAction} submitLabel={c ? "Save" : "Add category"} hidden={c ? { id: c.id } : undefined} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Category" name="name" state={state} required><TextInput name="name" state={state} defaultValue={c?.name} required /></Field>
          <Field label="Limit per expense (₹)" name="maxAmount" state={state}><TextInput name="maxAmount" type="number" state={state} defaultValue={c?.maxAmount ?? ""} /></Field>
          <Field label="Receipt needed above (₹)" name="receiptRequiredAbove" state={state}><TextInput name="receiptRequiredAbove" type="number" state={state} defaultValue={c?.receiptRequiredAbove ?? ""} /></Field>
        </div>
      )}
    </ActionForm>
  );
}
