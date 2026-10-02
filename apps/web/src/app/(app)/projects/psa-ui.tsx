"use client";

import { useState, type ReactNode } from "react";
import { useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";

/** Small pieces shared by the PSA billing, pipeline and settings screens. */

export type Opt = { value: string; label: string };
export type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;
export const sm = { padding: "4px 6px", fontSize: 13 } as const;

export function Msg({ state }: { state: ActionState }) {
  return state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null;
}

/** One button posting fixed fields, with an optional confirm. */
export function OpButton({ action, fields, label, confirmText, variant = "", disabled }: {
  action: Action; fields: Record<string, string>; label: string; confirmText?: string; variant?: "" | "primary" | "danger" | "ghost"; disabled?: boolean;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} className="row gap-1" onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm ${variant}`} disabled={pending || disabled}>{pending ? "…" : label}</button>
      <Msg state={state} />
    </form>
  );
}

/**
 * A button that opens a small inline form (a reason, a date, an amount)
 * before posting — "Write off…", "Cancel…".
 */
export function RevealForm({ action, fields, label, submitLabel, variant = "", children }: {
  action: Action; fields: Record<string, string>; label: string; submitLabel: string; variant?: "" | "primary" | "danger"; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useForm(action);
  if (!open) return <button type="button" className="btn sm" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form action={formAction} className="row gap-2 wrap" style={{ alignItems: "end" }}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      <button className={`btn sm ${variant}`} disabled={pending}>{pending ? "…" : submitLabel}</button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Back</button>
      <Msg state={state} />
    </form>
  );
}

/** A row of labelled inputs posting to an action, with the result beside the button. */
export function RowForm({ action, fields, submitLabel, children, variant = "primary" }: {
  action: Action; fields?: Record<string, string>; submitLabel: string; children: ReactNode; variant?: "" | "primary";
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} className="stack gap-2">
      {Object.entries(fields ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        {children}
        <button className={`btn sm ${variant}`} disabled={pending}>{pending ? "…" : submitLabel}</button>
      </div>
      <Msg state={state} />
    </form>
  );
}

export function L({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return <label className="stack gap-1" style={grow ? { flex: 1, minWidth: 160 } : undefined}><span className="label">{label}</span>{children}</label>;
}

export function Select({ name, options, defaultValue, placeholder, required, width }: { name: string; options: Opt[]; defaultValue?: string | null; placeholder?: string; required?: boolean; width?: number }) {
  return (
    <select className="select" name={name} defaultValue={defaultValue ?? ""} required={required} style={{ ...sm, ...(width ? { width } : {}) }} aria-label={name}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Input({ name, type = "text", defaultValue, placeholder, required, width, min, max, step }: {
  name: string; type?: string; defaultValue?: string | number | null; placeholder?: string; required?: boolean; width?: number; min?: number; max?: number; step?: string | number;
}) {
  return <input className={`input${type === "number" ? " num" : ""}`} name={name} type={type} defaultValue={defaultValue ?? undefined} placeholder={placeholder} required={required} min={min} max={max} step={step} style={{ ...sm, ...(width ? { width } : {}) }} aria-label={name} />;
}
