"use client";

import type { ReactNode } from "react";
import { useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";

/**
 * One client wrapper for the payroll depth forms: the fields are plain,
 * uncontrolled inputs rendered by the server page; this posts them to the
 * server action and shows the outcome. `inline` lays the fields out in a row.
 */
export function DepthForm({
  action, children, submitLabel = "Save", hidden, inline, confirmText, variant = "primary", encType,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  hidden?: Record<string, string>;
  inline?: boolean;
  confirmText?: string;
  variant?: "primary" | "default" | "danger" | "ghost";
  encType?: "multipart/form-data";
}) {
  const [state, formAction, pending] = useForm(action);
  const btn = `btn ${variant === "primary" ? "primary" : variant === "danger" ? "danger" : variant === "ghost" ? "ghost" : ""}${inline ? " sm" : ""}`;
  return (
    <form
      action={formAction}
      encType={encType}
      onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}
      className={inline ? "row gap-2 wrap" : undefined}
      style={inline ? { alignItems: "center" } : undefined}
    >
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {!inline && state.message ? (
        <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 12 }}><div>{state.message}</div></div>
      ) : null}
      {children}
      <div className={inline ? undefined : "row gap-2"} style={inline ? undefined : { marginTop: 10 }}>
        <button className={btn} type="submit" disabled={pending}>{pending ? "Working…" : submitLabel}</button>
      </div>
      {inline && state.message ? (
        <span className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", flexBasis: "100%" }}>{state.message}</span>
      ) : null}
    </form>
  );
}
