"use client";

import type { ReactNode } from "react";
import { useForm, FormBanner, SubmitButton } from "./form";
import type { ActionState } from "@/lib/forms";

/**
 * A form whose inputs are laid out by a server page (a roster grid, a
 * table of shares): the page renders the inputs as children, this only
 * wires the action, the result banner and the submit button.
 */
export function GridForm({ action, hidden, submitLabel = "Save", children }: { action: (prev: ActionState, formData: FormData) => Promise<ActionState>; hidden?: Record<string, string>; submitLabel?: string; children: ReactNode }) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FormBanner state={state} />
      {children}
      <div className="row gap-2" style={{ marginTop: 10 }}>
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
