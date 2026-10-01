"use client";

import { useEffect, useRef } from "react";
import { useForm, Field, TextInput, SelectInput, CheckboxInput, FormBanner, SubmitButton } from "@/components/form";
import {
  addDeclarationItemAction, removeDeclarationItemAction, submitProofAction, saveRentAction,
  savePreviousIncomeAction, switchRegimeAction,
} from "@/app/actions/tax";
import { IconTrash, IconUpload } from "./icons";
import s from "../finances.module.css";

/** Add a line under one of the tab's sections. */
export function AddDeclarationForm({ sections, hint }: {
  sections: Array<{ value: string; name: string; label: string; room: string }>; hint?: string;
}) {
  const [state, action, pending] = useForm(addDeclarationItemAction);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) ref.current?.reset(); }, [state]);
  return (
    <form ref={ref} action={action} className={`${s.boxed} ${s.form}`} aria-label="Add a declaration">
      <h3 className={s.subhead} style={{ marginBottom: 12 }}>Add a declaration</h3>
      <FormBanner state={state} />
      <div className={s.formGrid}>
        <Field label="Section" name="section" state={state} required>
          <SelectInput name="section" state={state} required placeholder="Choose…"
            options={sections.map((o) => ({ value: o.value, label: `${o.name} — ${o.label}` }))} />
        </Field>
        <Field label="Investment / payment" name="category" state={state} required>
          <TextInput name="category" state={state} required maxLength={120} placeholder="e.g. PPF, LIC premium, ELSS" />
        </Field>
        <Field label="Amount (INR)" name="amount" state={state} required>
          <TextInput name="amount" type="number" state={state} required min={1} step="1" placeholder="0" />
        </Field>
        <div className="field" style={{ marginBottom: 0 }}>
          <SubmitButton pending={pending}>Add</SubmitButton>
        </div>
      </div>
      <div className={s.capHint}>
        {sections.map((o) => `${o.name}: ${o.room}`).join(" · ")}
        {hint ? <div style={{ marginTop: 4 }}>{hint}</div> : null}
      </div>
    </form>
  );
}

/** Remove a line, after a confirm. */
export function RemoveDeclarationButton({ itemId, label }: { itemId: string; label: string }) {
  const [state, action, pending] = useForm(removeDeclarationItemAction);
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Remove ${label}?`)) e.preventDefault(); }} style={{ display: "inline" }}>
      <input type="hidden" name="itemId" value={itemId} />
      <button type="submit" className="k-icon-btn" disabled={pending} aria-label={`Remove ${label}`} title="Remove">
        <IconTrash width={17} height={17} />
      </button>
      {state.message && !state.ok ? <div className="text-xs" role="alert" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}

/** Upload proof for a line: a PDF, PNG or JPEG of up to 10 MB. */
export function ProofUploadForm({ itemId, label, replace }: { itemId: string; label: string; replace?: boolean }) {
  const [state, action, pending] = useForm(submitProofAction);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) ref.current?.reset(); }, [state]);
  return (
    <form ref={ref} action={action} className={s.proofForm}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={`Proof for ${label}`} />
      <button type="submit" className="btn sm" disabled={pending}>
        <IconUpload width={14} height={14} /> {pending ? "Uploading…" : replace ? "Replace" : "Upload"}
      </button>
      {state.message ? (
        <div className="text-xs" role={state.ok ? "status" : "alert"} style={{ color: state.ok ? "var(--success)" : "var(--danger)", flexBasis: "100%" }}>{state.message}</div>
      ) : null}
    </form>
  );
}

/** Rent paid, for the HRA exemption. */
export function RentForm({ defaults }: {
  defaults: { annualRent: number | null; isMetro: boolean; landlordName: string | null; landlordPan: string | null; rentAddress: string | null };
}) {
  const [state, action, pending] = useForm(saveRentAction);
  return (
    <form action={action} className={`${s.boxed} ${s.form}`} aria-label="Rent paid">
      <h3 className={s.subhead} style={{ marginBottom: 12 }}>House Rent Allowance — rent paid</h3>
      <FormBanner state={state} />
      <div className={s.fieldsForm}>
        <Field label="Annual rent (INR)" name="annualRent" state={state} required hint="Enter 0 to remove the declaration.">
          <TextInput name="annualRent" type="number" state={state} required min={0} step="1" defaultValue={defaults.annualRent ?? ""} />
        </Field>
        <Field label="Landlord's name" name="landlordName" state={state}>
          <TextInput name="landlordName" state={state} maxLength={120} defaultValue={defaults.landlordName} />
        </Field>
        <Field label="Landlord's PAN" name="landlordPan" state={state} hint="Required when annual rent exceeds INR 1,00,000.">
          <TextInput name="landlordPan" state={state} maxLength={10} defaultValue={defaults.landlordPan} />
        </Field>
        <Field label="Rented property address" name="rentAddress" state={state}>
          <TextInput name="rentAddress" state={state} maxLength={300} defaultValue={defaults.rentAddress} />
        </Field>
      </div>
      <CheckboxInput name="isMetro" label="I live in a metro city (Delhi, Mumbai, Kolkata or Chennai)" defaultChecked={defaults.isMetro}
        hint="Metro cities allow an exemption of up to 50% of basic salary rather than 40%." />
      <div style={{ marginTop: 12 }}><SubmitButton pending={pending}>Save rent</SubmitButton></div>
    </form>
  );
}

/** Income, tax and contributions from an earlier employer this year. */
export function PreviousIncomeForm({ defaults }: {
  defaults: { previousEmployerIncome: number | null; previousEmployerTds: number | null; previousEmployerPf: number | null; previousEmployerPt: number | null };
}) {
  const [state, action, pending] = useForm(savePreviousIncomeAction);
  const row = (name: keyof typeof defaults, label: string, hint?: string, max?: number) => (
    <Field label={label} name={name} state={state} hint={hint}>
      <TextInput name={name} type="number" state={state} min={0} max={max} step="1" defaultValue={defaults[name] ?? ""} placeholder="0" />
    </Field>
  );
  return (
    <form action={action} className={`${s.boxed} ${s.form}`} aria-label="Previous employment">
      <FormBanner state={state} />
      <div className={s.fieldsForm}>
        {row("previousEmployerIncome", "Income after exemptions (INR)", "Taxable salary paid by your previous employer this year, as on their Form 16 / 12B.")}
        {row("previousEmployerTds", "Income tax deducted (INR)", "TDS your previous employer deducted.")}
        {row("previousEmployerPf", "Provident Fund (INR)", "Your PF contribution there.")}
        {row("previousEmployerPt", "Professional tax (INR)", "At most INR 2,500 a year.", 2500)}
      </div>
      <div style={{ marginTop: 6 }}><SubmitButton pending={pending}>Save</SubmitButton></div>
    </form>
  );
}

/** Move to the other regime, after a confirm. */
export function SwitchRegimeButton({ target }: { target: "OLD" | "NEW" }) {
  const [state, action, pending] = useForm(switchRegimeAction);
  const name = target === "NEW" ? "New Tax Regime" : "Old Tax Regime";
  return (
    <form action={action} onSubmit={(e) => {
      if (!confirm(`Switch to the ${name}? Your remaining TDS for the year will be recomputed under it.`)) e.preventDefault();
    }}>
      <input type="hidden" name="regime" value={target} />
      <button type="submit" className="btn primary" disabled={pending}>{pending ? "Switching…" : `Switch to ${name}`}</button>
      {state.message ? (
        <div className="text-sm" role={state.ok ? "status" : "alert"} style={{ marginTop: 8, color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</div>
      ) : null}
    </form>
  );
}
