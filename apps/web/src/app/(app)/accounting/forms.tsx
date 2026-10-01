"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, FormBanner, useForm } from "@/components/form";
import { postJournalAction, reverseEntryAction, saveAccountAction, setAccountActiveAction, periodAction, postPayrollAction, salaryPaymentAction, remitAction } from "@/app/actions/accounting";

export interface Option { value: string; label: string }
const today = () => new Date().toISOString().slice(0, 10);
const inr = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A manual journal: as many lines as it needs, posting only when it balances. */
export function JournalForm({ accounts }: { accounts: Option[] }) {
  const [state, action, pending] = useForm(postJournalAction);
  const [rows, setRows] = useState([0, 1]);
  const [dr, setDr] = useState<Record<number, number>>({});
  const [cr, setCr] = useState<Record<number, number>>({});
  const totalDr = Object.values(dr).reduce((s, v) => s + (v || 0), 0), totalCr = Object.values(cr).reduce((s, v) => s + (v || 0), 0);
  const diff = Math.round((totalDr - totalCr) * 100) / 100;
  return (
    <form action={action}>
      <FormBanner state={state} />
      <div className="grid grid-3">
        <Field label="Date" name="date" state={state} required><TextInput name="date" type="date" state={state} defaultValue={today()} required /></Field>
        <div style={{ gridColumn: "span 2" }}><Field label="Narration" name="narration" state={state} required><TextInput name="narration" state={state} placeholder="Office rent for October" required /></Field></div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th style={{ minWidth: 220 }}>Account</th><th className="num">Debit</th><th className="num">Credit</th><th>Line note</th><th /></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i}>
                <td><select className="select" name={`account_${i}`} aria-label="Account" defaultValue=""><option value="">Select…</option>{accounts.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</select></td>
                <td className="num"><input className="input num" name={`debit_${i}`} type="number" step="0.01" min={0} aria-label="Debit" style={{ width: 130 }} disabled={(cr[i] ?? 0) > 0} onChange={(e) => setDr({ ...dr, [i]: Number(e.target.value) })} /></td>
                <td className="num"><input className="input num" name={`credit_${i}`} type="number" step="0.01" min={0} aria-label="Credit" style={{ width: 130 }} disabled={(dr[i] ?? 0) > 0} onChange={(e) => setCr({ ...cr, [i]: Number(e.target.value) })} /></td>
                <td><input className="input" name={`note_${i}`} aria-label="Line note" /></td>
                <td>{rows.length > 2 ? <button type="button" className="btn sm ghost" aria-label="Remove line" onClick={() => { setRows(rows.filter((r) => r !== i)); const a = { ...dr }, b = { ...cr }; delete a[i]; delete b[i]; setDr(a); setCr(b); }}>×</button> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td className="strong">Totals</td><td className="num strong">{inr(totalDr)}</td><td className="num strong">{inr(totalCr)}</td>
              <td colSpan={2} className="text-sm" style={{ color: diff === 0 ? "var(--success)" : "var(--danger)" }}>{diff === 0 ? (totalDr > 0 ? "Balanced" : "") : `Out by ${inr(Math.abs(diff))}`}</td></tr>
          </tfoot>
        </table>
      </div>
      <div className="row gap-2" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <button type="button" className="btn sm" onClick={() => setRows([...rows, Math.max(...rows) + 1])}>+ Add a line</button>
        <button className="btn primary" disabled={pending || diff !== 0 || totalDr === 0}>{pending ? "Posting…" : "Post entry"}</button>
      </div>
    </form>
  );
}

export function ReverseButton({ entryId }: { entryId: string }) {
  const [state, action, pending] = useForm(reverseEntryAction);
  const [open, setOpen] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  if (!open) return <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>Reverse</button>;
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="entryId" value={entryId} />
      <input className="input" name="reason" placeholder="Why" required aria-label="Reason for reversal" style={{ width: 180 }} />
      <button className="btn sm danger" disabled={pending}>Post reversal</button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function AccountForm({ groups }: { groups: Option[] }) {
  return (
    <ActionForm action={saveAccountAction} submitLabel="Add account" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Under" name="parentId" state={state} required><SelectInput name="parentId" state={state} options={groups} placeholder="Choose a group" required /></Field>
          <Field label="Code" name="code" state={state} required hint="Numbered within its group, e.g. 5300"><TextInput name="code" state={state} required maxLength={6} /></Field>
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required /></Field>
          <Field label="Bank name" name="bankName" state={state} hint="Only for a bank account"><TextInput name="bankName" state={state} /></Field>
          <Field label="Account number" name="accountNumber" state={state}><TextInput name="accountNumber" state={state} /></Field>
          <Field label="IFSC" name="ifsc" state={state}><TextInput name="ifsc" state={state} maxLength={11} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function AccountToggle({ accountId, active }: { accountId: string; active: boolean }) {
  const [state, action, pending] = useForm(setAccountActiveAction);
  return (
    <form action={action} className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="active" value={String(!active)} />
      <button className="btn sm ghost" disabled={pending}>{active ? "Deactivate" : "Reactivate"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function PeriodToggle({ code, closed }: { code: string; closed: boolean }) {
  const [state, action, pending] = useForm(periodAction);
  return (
    <form action={action} className="row gap-2" style={{ justifyContent: "flex-end" }}
      onSubmit={(e) => { if (!closed && !confirm(`Close ${code}? Nothing more can be posted into it until it is reopened.`)) e.preventDefault(); }}>
      <input type="hidden" name="code" value={code} />
      <button className={`btn sm${closed ? "" : " primary"}`} name="op" value={closed ? "reopen" : "close"} disabled={pending}>{closed ? "Reopen" : "Close month"}</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function PostPayrollButton({ runId }: { runId: string }) {
  const [state, action, pending] = useForm(postPayrollAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="runId" value={runId} />
      <button className="btn sm primary" disabled={pending}>{pending ? "Posting…" : "Post to ledger"}</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function SalaryPaymentForm({ runId, payDate }: { runId: string; payDate: string }) {
  const [state, action, pending] = useForm(salaryPaymentAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="runId" value={runId} />
      <input className="input" type="date" name="date" defaultValue={payDate} aria-label="Paid on" required />
      <input className="input" name="reference" placeholder="Bank ref" aria-label="Bank reference" style={{ width: 120 }} />
      <button className="btn sm" disabled={pending}>Record payment</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function RemitForm({ accountCode, owed }: { accountCode: string; owed: number }) {
  const [state, action, pending] = useForm(remitAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="accountCode" value={accountCode} />
      <input className="input num" type="number" step="0.01" name="amount" defaultValue={owed} max={owed} min={0.01} aria-label="Amount" style={{ width: 130 }} required />
      <input className="input" type="date" name="date" defaultValue={today()} aria-label="Paid on" required />
      <input className="input" name="reference" placeholder="Challan / CIN" aria-label="Challan reference" style={{ width: 130 }} />
      <button className="btn sm" disabled={pending}>Pay</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}
