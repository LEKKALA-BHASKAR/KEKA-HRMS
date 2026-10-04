"use client";

import { useState } from "react";
import { Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, SubmitButton, useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";

/**
 * Declarative forms for the growth pages (learning, succession, mobility,
 * skills, development). A server page describes the fields and passes the
 * server action; this renders them with inline errors and the result banner.
 */

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;
export interface Opt { value: string; label: string }
export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "textarea" | "date" | "datetime-local" | "number" | "select" | "checkbox" | "file" | "checklist" | "url" | "time";
  options?: Opt[];
  defaultValue?: string | number | null;
  defaultChecked?: boolean;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  rows?: number;
  min?: number;
  max?: number;
  /** "full" spans the whole row. */
  wide?: boolean;
  /** For checklists: which values start ticked. */
  checked?: string[];
}

function Input({ f, state }: { f: FieldSpec; state: ActionState }) {
  const t = f.type ?? "text";
  if (t === "textarea") return <TextArea name={f.name} state={state} rows={f.rows ?? 3} defaultValue={f.defaultValue === null || f.defaultValue === undefined ? undefined : String(f.defaultValue)} placeholder={f.placeholder} required={f.required} />;
  if (t === "select") return <SelectInput name={f.name} state={state} options={f.options ?? []} defaultValue={f.defaultValue === null || f.defaultValue === undefined ? undefined : String(f.defaultValue)} required={f.required} placeholder={f.required ? undefined : (f.placeholder ?? "—")} />;
  if (t === "file") return <input className="input" type="file" name={f.name} id={f.name} />;
  if (t === "checklist") return <Checklist name={f.name} options={f.options ?? []} checked={f.checked ?? []} />;
  return <TextInput name={f.name} state={state} type={t} defaultValue={f.defaultValue} placeholder={f.placeholder} required={f.required} min={f.min} max={f.max} />;
}

function Checklist({ name, options, checked }: { name: string; options: Opt[]; checked: string[] }) {
  const [filter, setFilter] = useState("");
  const shown = new Set(options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())).map((o) => o.value));
  return (
    <div>
      {options.length > 8 ? <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" style={{ marginBottom: 6 }} /> : null}
      <div className="stack gap-1" style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 10 }}>
        {options.length === 0 ? <span className="text-sm subtle">Nobody to choose.</span> : null}
        {options.map((o) => (
          <label key={o.value} className="row gap-2 text-sm" style={{ display: shown.has(o.value) ? undefined : "none" }}>
            <input type="checkbox" name={name} value={o.value} defaultChecked={checked.includes(o.value)} />{o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A full form: a grid of fields, then the submit button. */
export function GrowthForm({ action, fields, hidden, submitLabel = "Save", cols = 3, compact }: {
  action: Action; fields: FieldSpec[]; hidden?: Record<string, string>; submitLabel?: string; cols?: 1 | 2 | 3 | 4; compact?: boolean;
}) {
  const [state, formAction, pending] = useForm(action);
  const boxes = fields.filter((f) => f.type === "checkbox");
  const rest = fields.filter((f) => f.type !== "checkbox");
  return (
    <form action={formAction} encType={fields.some((f) => f.type === "file") ? "multipart/form-data" : undefined}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FormBanner state={state} />
      <div className={cols === 1 ? "stack gap-2" : `grid grid-${cols}`}>
        {rest.map((f) => (
          <div key={f.name} style={f.wide || f.type === "textarea" || f.type === "checklist" ? { gridColumn: "1 / -1" } : undefined}>
            <Field label={f.label} name={f.name} state={state} required={f.required} hint={f.hint}><Input f={f} state={state} /></Field>
          </div>
        ))}
      </div>
      {boxes.map((f) => <CheckboxInput key={f.name} name={f.name} label={f.label} defaultChecked={f.defaultChecked} hint={f.hint} />)}
      <div className="row gap-2" style={{ marginTop: compact ? 4 : 10 }}>
        <SubmitButton pending={pending} size={compact ? "sm" : undefined}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

/**
 * One button that posts hidden values — optionally with a short note or a
 * value the user types first (reject reasons, evidence, a score).
 */
export function ActButton({ action, hidden, label, variant = "default", confirmText, input }: {
  action: Action; hidden: Record<string, string>; label: string;
  variant?: "primary" | "default" | "danger" | "ghost"; confirmText?: string;
  input?: { name: string; placeholder: string; type?: "text" | "number" | "date"; required?: boolean };
}) {
  const [state, act, pending] = useForm(action);
  return (
    <form action={act} onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }} className="row gap-1" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "flex-start" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {input ? <input className="input" style={{ width: input.type === "number" ? 80 : 200, height: 30 }} name={input.name} placeholder={input.placeholder} type={input.type ?? "text"} required={input.required} /> : null}
      <button className={`btn sm ${variant === "default" ? "" : variant}`} disabled={pending} style={variant === "ghost" ? { color: "var(--danger)" } : undefined}>{pending ? "…" : label}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ flexBasis: "100%", marginTop: 2 }}>{state.message}</div> : null}
    </form>
  );
}

/** A details/summary toggle around a form, so pages stay compact. */
export function Reveal({ label, children, open }: { label: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} style={{ marginBottom: 12 }}>
      <summary className="btn sm" style={{ display: "inline-flex", listStyle: "none", cursor: "pointer" }}>{label}</summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}
