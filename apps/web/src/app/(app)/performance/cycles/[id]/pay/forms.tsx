"use client";

import { useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import { saveMeritMatrixAction, buildProposalsAction, updateProposalAction, applyProposalsAction } from "@/app/actions/review-to-pay";

export function MeritMatrix({ cycleId, bands }: { cycleId: string; bands: Array<{ id: string; name: string; inc: number; bonus: number }> }) {
  const [state, formAction, pending] = useForm(saveMeritMatrixAction);
  return (
    <form action={formAction} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="cycleId" value={cycleId} />
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Band</th><th className="num">Increment %</th><th className="num">Bonus % of CTC</th></tr></thead>
        <tbody>
          {bands.map((b) => (
            <tr key={b.id}>
              <td className="strong text-sm">{b.name}<input type="hidden" name="bandId" value={b.id} /></td>
              <td className="num"><input className="input sm num" style={{ width: 90 }} type="number" step="0.1" min={0} max={100} name={`inc:${b.id}`} defaultValue={b.inc} aria-label={`${b.name} increment`} /></td>
              <td className="num"><input className="input sm num" style={{ width: 90 }} type="number" step="0.1" min={0} max={100} name={`bonus:${b.id}`} defaultValue={b.bonus} aria-label={`${b.name} bonus`} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div><button className="btn sm" disabled={pending}>Save matrix</button></div>
    </form>
  );
}

export function BuildProposals({ cycleId, label }: { cycleId: string; label: string }) {
  const [state, formAction, pending] = useForm(buildProposalsAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="cycleId" value={cycleId} />
      <button className="btn primary sm" disabled={pending}>{label}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function ProposalEditor({ id, pct, bonus, note, recommended }: { id: string; pct: number; bonus: number; note: string; recommended: number }) {
  const [state, formAction, pending] = useForm(updateProposalAction);
  const [value, setValue] = useState(pct);
  const off = Math.abs(value - recommended) > 0.001;
  return (
    <form action={formAction} className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="id" value={id} />
      <input className="input sm num" style={{ width: 70 }} type="number" step="0.1" min={0} max={100} name="proposedPercent" value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label="Increment %" />
      <input className="input sm num" style={{ width: 100 }} type="number" step="1" min={0} name="bonusAmount" defaultValue={bonus} aria-label="Bonus" />
      {off || note ? <input className="input sm" style={{ width: 160 }} name="note" defaultValue={note} placeholder="Why it differs" aria-label="Reason" /> : null}
      <button className="btn sm" name="op" value="save" disabled={pending}>Save</button>
      <button className="btn ghost sm" name="op" value="skip" disabled={pending}>Skip</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function RestoreProposal({ id }: { id: string }) {
  const [, formAction, pending] = useForm(updateProposalAction);
  return <form action={formAction}><input type="hidden" name="id" value={id} /><button className="btn ghost sm" name="op" value="restore" disabled={pending}>Restore</button></form>;
}

export function ApplyProposals({ cycleId, ids, bonusTypes, needsBonus }: { cycleId: string; ids: string[]; bonusTypes: Array<{ value: string; label: string }>; needsBonus: boolean }) {
  const [state, formAction, pending] = useForm(applyProposalsAction);
  const month = new Date().toISOString().slice(0, 7);
  return (
    <form action={formAction} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="cycleId" value={cycleId} />
      {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      <div className="row gap-2 wrap">
        <label className="text-sm">Increases take effect <input className="input sm" type="date" name="effectiveFrom" required defaultValue={`${month}-01`} /></label>
        {needsBonus ? (
          <>
            <label className="text-sm">Bonus type <select className="select" name="bonusTypeId" required style={{ width: 180 }}><option value="">Choose…</option>{bonusTypes.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></label>
            <label className="text-sm">Paid in <input className="input sm" type="month" name="payoutMonth" required defaultValue={month} /></label>
          </>
        ) : null}
        <button className="btn primary" disabled={pending || ids.length === 0}>{pending ? "Applying…" : `Apply ${ids.length} proposal${ids.length === 1 ? "" : "s"}`}</button>
      </div>
      <div className="text-xs subtle">Each increase becomes a salary revision. Pay groups with a compensation approval chain send it there first.</div>
    </form>
  );
}
