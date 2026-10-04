"use client";

import { useState, type ReactNode } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, useForm, FormBanner, SubmitButton } from "./form";
import type { ActionState } from "@/lib/forms";

/**
 * Forms described as data, so a server page can lay out a create or edit
 * form without a client component of its own: each field says its name,
 * label, kind and default. The action is a server action passed straight
 * through.
 */

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export interface FieldSpec {
  name: string;
  label: string;
  kind?: "text" | "email" | "date" | "number" | "select" | "multi" | "textarea" | "checkbox" | "checks" | "color";
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | null;
  /** For checkboxes and check groups. */
  defaultChecked?: boolean;
  defaultValues?: string[];
  required?: boolean;
  hint?: string;
  placeholder?: string;
  /** Spans both columns. */
  wide?: boolean;
  step?: string;
}

function Input({ f, state }: { f: FieldSpec; state: ActionState }) {
  const kind = f.kind ?? "text";
  if (kind === "select") return <SelectInput name={f.name} state={state} options={f.options ?? []} defaultValue={f.defaultValue == null ? null : String(f.defaultValue)} required={f.required} placeholder={f.required ? undefined : f.placeholder ?? "—"} />;
  if (kind === "multi") {
    return (
      <select id={f.name} name={f.name} multiple className="select" defaultValue={f.defaultValues ?? []} style={{ minHeight: 110 }}>
        {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (kind === "textarea") return <TextArea name={f.name} state={state} defaultValue={f.defaultValue == null ? null : String(f.defaultValue)} placeholder={f.placeholder} required={f.required} rows={4} />;
  if (kind === "checks") {
    return (
      <div className="row gap-3 wrap">
        {(f.options ?? []).map((o) => (
          <label key={o.value} className="row gap-1 text-sm">
            <input type="checkbox" name={f.name} value={o.value} defaultChecked={(f.defaultValues ?? []).includes(o.value)} /> {o.label}
          </label>
        ))}
      </div>
    );
  }
  return <TextInput name={f.name} state={state} type={kind} defaultValue={f.defaultValue} placeholder={f.placeholder} required={f.required} step={f.step ?? (kind === "number" ? "any" : undefined)} />;
}

export function SpecFields({ fields, state }: { fields: FieldSpec[]; state: ActionState }) {
  return (
    <div className="grid grid-2">
      {fields.map((f) => (f.kind === "checkbox" ? (
        <div key={f.name} style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
          <CheckboxInput name={f.name} label={f.label} defaultChecked={f.defaultChecked} hint={f.hint} />
        </div>
      ) : (
        <div key={f.name} style={f.wide || f.kind === "textarea" ? { gridColumn: "1 / -1" } : undefined}>
          <Field label={f.label} name={f.name} state={state} required={f.required} hint={f.hint}>
            <Input f={f} state={state} />
          </Field>
        </div>
      )))}
    </div>
  );
}

export function SpecForm({ action, fields, hidden, submitLabel, compact }: { action: Action; fields: FieldSpec[]; hidden?: Record<string, string>; submitLabel?: string; compact?: boolean }) {
  return (
    <ActionForm action={action} hidden={hidden} submitLabel={submitLabel} compact={compact}>
      {(state) => <SpecFields fields={fields} state={state} />}
    </ActionForm>
  );
}

/** A form behind a button, to keep long pages calm. */
export function SpecDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn${open ? "" : " primary"} sm`} onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : label}</button>
      {open ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </>
  );
}

/** One button that runs an action, with optional hidden fields and a confirm prompt. */
export function ActionButton({ action, hidden, label, confirm: ask, variant }: { action: Action; hidden: Record<string, string>; label: string; confirm?: string; variant?: "primary" | "danger" | "default" }) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} onSubmit={(e) => { if (ask && !window.confirm(ask)) e.preventDefault(); }} style={{ display: "inline-block" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm${variant === "primary" ? " primary" : ""}${variant === "danger" ? " danger" : ""}`} type="submit" disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", maxWidth: 260 }}>{state.message}</div> : null}
    </form>
  );
}

/** Approve, or reject with a reason. */
export function DecideForm({ action, hidden, approveLabel = "Approve", rejectLabel = "Reject" }: { action: Action; hidden: Record<string, string>; approveLabel?: string; rejectLabel?: string }) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FormBanner state={state} />
      <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
        <input className="input" name="note" placeholder="Note (required to reject)" style={{ minWidth: 220, flex: 1 }} />
        <button className="btn primary sm" type="submit" name="decision" value="approve" disabled={pending}>{approveLabel}</button>
        <button className="btn sm" type="submit" name="decision" value="reject" disabled={pending} style={{ color: "var(--danger)" }}>{rejectLabel}</button>
      </div>
    </form>
  );
}

export { SubmitButton };
