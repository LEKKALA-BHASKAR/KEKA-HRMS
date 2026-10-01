"use client";

import { useEffect } from "react";
import { useForm, Field, TextInput, TextArea, FormBanner } from "@/components/form";
import { submitComponentClaimAction, withdrawComponentClaimAction, withdrawLoanAction } from "@/app/actions/finances";
import { DialogButton } from "./dialog";
import { inr0 } from "./fmt";
import s from "../finances.module.css";

/** The "Claim" action on a component row, and its drawer. */
export function ClaimButton({ componentId, name, remaining, today, fyStart }: {
  componentId: string; name: string; remaining: number; today: string; fyStart: string;
}) {
  return (
    <DialogButton label="Claim" title={`Claim ${name}`} className={s.linkBtn} disabled={remaining <= 0}
      tooltip={remaining <= 0 ? "Nothing left to claim right now" : undefined}>
      {(close) => <ClaimForm componentId={componentId} remaining={remaining} today={today} fyStart={fyStart} onDone={close} />}
    </DialogButton>
  );
}

function ClaimForm({ componentId, remaining, today, fyStart, onDone }: {
  componentId: string; remaining: number; today: string; fyStart: string; onDone: () => void;
}) {
  const [state, action, pending] = useForm(submitComponentClaimAction);
  useEffect(() => { if (state.ok) { const t = setTimeout(onDone, 900); return () => clearTimeout(t); } }, [state, onDone]);
  return (
    <form action={action} className={s.dlgForm} encType="multipart/form-data">
      <input type="hidden" name="componentId" value={componentId} />
      <FormBanner state={state} />
      <Field label="Claim Amount" name="amount" state={state} required hint={`You can claim up to ${inr0(remaining)} right now.`}>
        <div className={s.prefixInput}>
          <span>INR</span>
          <TextInput name="amount" type="number" state={state} required min={1} max={remaining} step="1" placeholder="Claim amount" />
        </div>
      </Field>
      <div className={s.formCols}>
        <Field label="Bill Date" name="billDate" state={state} required>
          <TextInput name="billDate" type="date" state={state} required min={fyStart} max={today} />
        </Field>
        <Field label="Bill Number" name="billNumber" state={state}>
          <TextInput name="billNumber" state={state} maxLength={40} placeholder="Invoice or receipt number" />
        </Field>
      </div>
      <Field label="Note" name="note" state={state}>
        <TextArea name="note" state={state} rows={3} />
      </Field>
      <Field label="Upload bills" name="file" state={state} required hint="PDF, PNG or JPEG, up to 10 MB.">
        <input id="file" name="file" type="file" accept="application/pdf,image/png,image/jpeg" required className="input" />
      </Field>
      <div className={s.dlgFormFoot}>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Claiming…" : "Claim"}</button>
      </div>
    </form>
  );
}

/** Withdraw a pending claim or loan request, after a confirm. */
export function WithdrawButton({ kind, id, label }: { kind: "claim" | "loan"; id: string; label: string }) {
  const [state, action, pending] = useForm(kind === "claim" ? withdrawComponentClaimAction : withdrawLoanAction);
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Withdraw ${label}?`)) e.preventDefault(); }} style={{ display: "inline" }}>
      <input type="hidden" name={kind === "claim" ? "claimId" : "loanId"} value={id} />
      <button type="submit" className={s.linkBtn} disabled={pending} aria-label={`Withdraw ${label}`}>{pending ? "Withdrawing…" : "Withdraw"}</button>
      {state.message && !state.ok ? <div className="text-xs" role="alert" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}
