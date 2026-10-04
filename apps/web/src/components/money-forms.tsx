"use client";

import { useState } from "react";
import { FormBanner, useForm } from "@/components/form";
import { updateDraftClaimAction } from "@/app/actions/expense-depth";

/**
 * Client pieces for the money pages that the declarative GrowthForm cannot
 * express: editing a claim's lines in place.
 */

interface Opt { value: string; label: string }
export interface DraftLine { id: string; categoryId: string; expenseDate: string; amount: number; merchant: string | null; description: string | null }

export function DraftClaimEditor({ claimId, title, lines, categories }: { claimId: string; title: string; lines: DraftLine[]; categories: Opt[] }) {
  const [state, action, pending] = useForm(updateDraftClaimAction);
  const [extra, setExtra] = useState<number[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const row = (key: string, i: number, l?: DraftLine) => (
    <tr key={key}>
      <td>{l ? <input type="hidden" name={`id_${i}`} value={l.id} /> : null}<select className="select" name={`categoryId_${i}`} defaultValue={l?.categoryId ?? ""} required={!l} aria-label="Category"><option value="">Select…</option>{categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></td>
      <td><input className="input" type="date" name={`expenseDate_${i}`} defaultValue={l?.expenseDate ?? today} max={today} aria-label="Date" /></td>
      <td><input className="input num" type="number" step="0.01" min={0} name={`amount_${i}`} defaultValue={l?.amount ?? ""} style={{ width: 110 }} aria-label="Amount" /></td>
      <td><input className="input" name={`merchant_${i}`} defaultValue={l?.merchant ?? ""} aria-label="Merchant" /></td>
      <td>{l ? <label className="row gap-1 text-xs"><input type="checkbox" name={`delete_${i}`} />Remove</label> : null}</td>
    </tr>
  );
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="claimId" value={claimId} />
      <label className="text-sm strong" htmlFor="title">Title</label>
      <input className="input" id="title" name="title" defaultValue={title} required />
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Category</th><th>Date</th><th className="num">Amount</th><th>Merchant</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => row(l.id, i, l))}
          {extra.map((n) => row(`new-${n}`, lines.length + n))}
        </tbody>
      </table></div>
      <div className="row gap-2">
        <button type="button" className="btn sm" onClick={() => setExtra([...extra, extra.length])}>+ Add expense</button>
        <button className="btn sm primary" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
  );
}
