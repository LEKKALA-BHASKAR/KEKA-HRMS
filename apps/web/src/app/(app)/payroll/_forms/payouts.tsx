"use client";

import type { ReactNode } from "react";
import { useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";

/**
 * A small form bound to one payout action: hidden fields, whatever inputs the
 * server page passes as children (checkbox tables included), a button, and
 * the action's message next to it.
 */
export function PayoutForm({
  action, hidden, label, children, variant, inline = true, confirm,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  hidden?: Record<string, string>;
  label: string;
  children?: ReactNode;
  variant?: "primary" | "danger" | "ghost";
  inline?: boolean;
  confirm?: string;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form
      action={formAction}
      className={inline ? "row gap-2 wrap" : "stack gap-2"}
      style={inline ? { alignItems: "center" } : undefined}
      onSubmit={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
    >
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <button className={`btn sm${variant ? ` ${variant}` : ""}`} disabled={pending}>{pending ? "…" : label}</button>
        {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ maxWidth: 340 }}>{state.message}</span> : null}
      </div>
    </form>
  );
}
