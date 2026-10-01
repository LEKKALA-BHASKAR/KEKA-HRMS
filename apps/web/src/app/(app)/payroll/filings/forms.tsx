"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { generateMonthlyFiling, generate24q, markFiled, generateForm16 } from "@/app/actions/filings";

function Result({ state }: { state: { ok?: boolean; message?: string } }) {
  return state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ marginTop: 4, maxWidth: 260 }}>{state.message}</div> : null;
}

export function GenerateButton({ runId, kind, label }: { runId: string; kind: "PF_ECR" | "ESI_ECR" | "BANK"; label: string }) {
  const [state, action, pending] = useForm(generateMonthlyFiling);
  return (
    <form action={action}>
      <input type="hidden" name="runId" value={runId} /><input type="hidden" name="kind" value={kind} />
      <button className="btn sm" disabled={pending}>{pending ? "…" : label}</button>
      <Result state={state} />
    </form>
  );
}

export function Generate24q({ fy, quarter, label }: { fy: number; quarter: number; label: string }) {
  const [state, action, pending] = useForm(generate24q);
  return (
    <form action={action}>
      <input type="hidden" name="fy" value={fy} /><input type="hidden" name="quarter" value={quarter} />
      <button className="btn sm" disabled={pending}>{pending ? "…" : label}</button>
      <Result state={state} />
    </form>
  );
}

export function MarkFiled({ filingId, hint }: { filingId: string; hint: string }) {
  const [state, action, pending] = useForm(markFiled);
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn sm ghost" type="button" onClick={() => setOpen(true)}>Mark filed</button>;
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="filingId" value={filingId} />
      <input className="input" name="receipt" placeholder={hint} required style={{ width: 150 }} autoFocus />
      <button className="btn sm primary" disabled={pending}>Save</button>
      <Result state={state} />
    </form>
  );
}

export function GenerateForm16({ fy }: { fy: number }) {
  const [state, action, pending] = useForm(generateForm16);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="fy" value={fy} />
      <button className="btn sm primary" disabled={pending}>{pending ? "Generating…" : "Generate Form 16 Part B for everyone"}</button>
      <Result state={state} />
    </form>
  );
}
