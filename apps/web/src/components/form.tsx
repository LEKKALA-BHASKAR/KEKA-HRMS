"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionState } from "@/lib/forms";

/**
 * Form primitives bound to the ActionState contract.
 *
 * Every field reads its own error out of state, so a failed submit lands the
 * message next to the input that caused it rather than at the top of the page.
 */

const EMPTY: ActionState = {};

export function useForm(
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>,
) {
  return useActionState(action, EMPTY);
}

export function Field({
  label, name, children, hint, state, required,
}: {
  label: string; name: string; children: ReactNode;
  hint?: string; state?: ActionState; required?: boolean;
}) {
  const error = state?.errors?.[name];
  return (
    <div className="field">
      <label className="label" htmlFor={name}>
        {label}
        {required ? <span style={{ color: "var(--danger)" }}> *</span> : null}
      </label>
      {children}
      {error ? (
        <div className="text-xs" style={{ color: "var(--danger)", marginTop: 4 }}>{error}</div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}

export function TextInput({
  name, state, type = "text", defaultValue, placeholder, required, min, max, step, maxLength, className,
}: {
  name: string; state?: ActionState; type?: string;
  defaultValue?: string | number | null; placeholder?: string; required?: boolean;
  min?: number | string; max?: number | string; step?: number | string;
  maxLength?: number; className?: string;
}) {
  const hasError = !!state?.errors?.[name];
  const echoed = state?.values?.[name];
  return (
    <input
      id={name} name={name} type={type}
      className={`input ${className ?? ""}${type === "number" ? " num" : ""}`}
      defaultValue={echoed ?? (defaultValue ?? undefined)}
      placeholder={placeholder} required={required}
      min={min} max={max} step={step} maxLength={maxLength}
      style={hasError ? { borderColor: "var(--danger)" } : undefined}
    />
  );
}

export function SelectInput({
  name, state, options, defaultValue, required, placeholder, className,
}: {
  name: string; state?: ActionState;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string | null; required?: boolean; placeholder?: string; className?: string;
}) {
  const hasError = !!state?.errors?.[name];
  const echoed = state?.values?.[name];
  return (
    <select
      id={name} name={name} className={`select ${className ?? ""}`}
      defaultValue={echoed ?? (defaultValue ?? "")} required={required}
      style={hasError ? { borderColor: "var(--danger)" } : undefined}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function TextArea({
  name, state, defaultValue, placeholder, rows = 3, required,
}: {
  name: string; state?: ActionState; defaultValue?: string | null;
  placeholder?: string; rows?: number; required?: boolean;
}) {
  const hasError = !!state?.errors?.[name];
  const echoed = state?.values?.[name];
  return (
    <textarea
      id={name} name={name} className="textarea" rows={rows}
      defaultValue={echoed ?? (defaultValue ?? undefined)}
      placeholder={placeholder} required={required}
      style={hasError ? { borderColor: "var(--danger)" } : undefined}
    />
  );
}

export function CheckboxInput({
  name, label, defaultChecked, hint,
}: { name: string; label: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="checkbox-row">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>
        <span className="text-sm">{label}</span>
        {hint ? <div className="hint" style={{ marginTop: 1 }}>{hint}</div> : null}
      </span>
    </label>
  );
}

export function FormBanner({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 14 }}>
      <div>{state.message}</div>
    </div>
  );
}

export function SubmitButton({
  children, pending, variant = "primary", size,
}: {
  children: ReactNode; pending: boolean;
  variant?: "primary" | "danger" | "default"; size?: "sm" | "lg";
}) {
  const cls = [
    "btn",
    variant === "primary" ? "primary" : variant === "danger" ? "danger" : "",
    size ?? "",
  ].filter(Boolean).join(" ");
  return (
    <button className={cls} type="submit" disabled={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}

/**
 * A complete create/edit form. Children receive the current ActionState so
 * fields can render their own errors.
 */
export function ActionForm({
  action, children, submitLabel = "Save", onDone, hidden, compact,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: (state: ActionState) => ReactNode;
  submitLabel?: string;
  onDone?: ReactNode;
  hidden?: Record<string, string>;
  compact?: boolean;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction}>
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <FormBanner state={state} />
      {children(state)}
      <div className="row gap-2" style={{ marginTop: compact ? 4 : 10 }}>
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        {onDone}
      </div>
    </form>
  );
}

/** A one-line inline form, for quick-add rows inside a table card. */
export function InlineForm({
  action, children, submitLabel = "Add", hidden,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: (state: ActionState) => ReactNode;
  submitLabel?: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction} style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {state.message ? (
        <div
          className="text-xs"
          style={{ color: state.ok ? "var(--success)" : "var(--danger)", marginBottom: 8 }}
        >
          {state.message}
        </div>
      ) : null}
      <div className="row gap-2 wrap">
        {children(state)}
        <SubmitButton pending={pending} size="sm">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

/** A destructive action with a confirm step, for delete buttons. */
export function DangerButton({
  action, hidden, label, confirmLabel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  hidden: Record<string, string>;
  label: string;
  confirmLabel?: string;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(confirmLabel ?? `${label}? This cannot be undone.`)) e.preventDefault();
      }}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button className="btn ghost sm" type="submit" disabled={pending}
        style={{ color: "var(--danger)" }}>
        {pending ? "…" : label}
      </button>
      {state.message && !state.ok ? (
        <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div>
      ) : null}
    </form>
  );
}
