"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { reviewProofAction } from "@/app/actions/tax-proofs";

export function ProofReview({ itemId, declared }: { itemId: string; declared: number }) {
  const [state, formAction, pending] = useForm(reviewProofAction);
  const [mode, setMode] = useState<"idle" | "partial" | "reject">("idle");
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="itemId" value={itemId} />
      {mode === "partial" ? (
        <input className="input" name="approvedAmount" type="number" step="1" min={1} max={declared} defaultValue={declared} required style={{ width: 140 }} aria-label="Amount accepted" />
      ) : null}
      {mode !== "idle" ? (
        <input className="input" name="remark" placeholder={mode === "reject" ? "What's wrong with the proof" : "Why less is accepted"} required autoFocus style={{ width: 240 }} />
      ) : null}
      <div className="row gap-2">
        {mode === "idle" ? (
          <>
            <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Accept</button>
            <button type="button" className="btn sm" onClick={() => setMode("partial")}>Accept less</button>
            <button type="button" className="btn sm" onClick={() => setMode("reject")}>Reject</button>
          </>
        ) : (
          <>
            <button className={`btn sm ${mode === "reject" ? "danger" : "primary"}`} name="decision" value={mode === "reject" ? "reject" : "approve"} disabled={pending}>
              {mode === "reject" ? "Reject" : "Accept amount"}
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setMode("idle")}>Back</button>
          </>
        )}
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
