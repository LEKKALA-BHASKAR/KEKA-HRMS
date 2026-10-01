"use client";

import { useForm } from "@/components/form";
import { reopenFbpDeclarationAction } from "@/app/actions/fbp";

export function ReopenFbp({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(reopenFbpDeclarationAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button className="btn sm" disabled={pending}>{pending ? "…" : "Reopen"}</button>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
