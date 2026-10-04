"use client";

import { useState, type ReactNode } from "react";
import { useForm, FormBanner, SubmitButton } from "@/components/form";
import type { ActionState } from "@/lib/forms";
import { decideWorkforceRequestAction, withdrawWorkforceRequestAction } from "@/app/actions/workforce-requests";

/**
 * Small client pieces shared by the positions, workforce planning and
 * contingent workforce pages.
 */

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** A collapsible panel holding a form. */
export function Disclosure({ label, children, defaultOpen, variant = "primary" }: { label: string; children: ReactNode; defaultOpen?: boolean; variant?: "primary" | "default" }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button type="button" className={`btn${variant === "primary" ? " primary" : ""} sm`} onClick={() => setOpen((v) => !v)}>
        {open ? "Cancel" : label}
      </button>
      {open ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </div>
  );
}

/** A one-button form posting hidden fields. */
export function ActionButton({ action, hidden, label, variant = "default", confirmText }: {
  action: Action; hidden: Record<string, string>; label: string; variant?: "primary" | "default" | "danger"; confirmText?: string;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} style={{ display: "inline-block" }} onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm${variant === "primary" ? " primary" : variant === "danger" ? " danger" : ""}`} type="submit" disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", maxWidth: 360 }}>{state.message}</div> : null}
    </form>
  );
}

/** A form whose fields are plain children (no per-field error plumbing needed). */
export function SimpleForm({ action, hidden, children, submitLabel = "Save", inline }: {
  action: Action; hidden?: Record<string, string>; children: ReactNode; submitLabel?: string; inline?: boolean;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FormBanner state={state} />
      <div className={inline ? "row gap-2 wrap" : undefined} style={inline ? { alignItems: "flex-end" } : undefined}>
        {children}
        <div style={{ marginTop: inline ? 0 : 10 }}><SubmitButton pending={pending} size={inline ? "sm" : undefined}>{submitLabel}</SubmitButton></div>
      </div>
    </form>
  );
}

/** Approve / reject a workforce request, with a note (required to reject). */
export function DecisionForm({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(decideWorkforceRequestAction);
  return (
    <form action={formAction} className="row gap-2 wrap" style={{ alignItems: "center" }}>
      <input type="hidden" name="id" value={id} />
      <input className="input" name="note" placeholder="Note (required to reject)" style={{ maxWidth: 240 }} />
      <button className="btn sm primary" name="decision" value="approve" type="submit" disabled={pending}>Approve</button>
      <button className="btn sm" name="decision" value="reject" type="submit" disabled={pending}>Reject</button>
      {state.message ? <span className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</span> : null}
    </form>
  );
}

export function WithdrawButton({ id }: { id: string }) {
  return <ActionButton action={withdrawWorkforceRequestAction} hidden={{ id }} label="Withdraw" confirmText="Withdraw this request?" />;
}

/** A labelled field wrapper for SimpleForm children. */
export function F({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export interface Opt { value: string; label: string }

export function Select({ name, options, defaultValue, placeholder, required, multiple }: { name: string; options: Opt[]; defaultValue?: string | string[] | null; placeholder?: string; required?: boolean; multiple?: boolean }) {
  return (
    <select className="select" name={name} defaultValue={defaultValue ?? (multiple ? [] : "")} required={required} multiple={multiple} size={multiple ? Math.min(6, Math.max(3, options.length)) : undefined}>
      {placeholder !== undefined && !multiple ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Pick rows (by checkbox) and post them with the form's other fields. */
export function CheckList({ name, rows }: { name: string; rows: Opt[] }) {
  const [all, setAll] = useState(false);
  return (
    <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginBottom: 10 }}>
      <label className="checkbox-row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> <span className="text-sm">Select all</span></label>
      {rows.map((r) => (
        <label key={r.value} className="checkbox-row"><input type="checkbox" name={name} value={r.value} defaultChecked={all} key={`${r.value}-${all}`} /> <span className="text-sm">{r.label}</span></label>
      ))}
    </div>
  );
}
