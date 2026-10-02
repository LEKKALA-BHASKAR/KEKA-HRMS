"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { decideTimeRequestAction } from "@/app/actions/time-requests";

/** Approve, or reject with a reason — for comp-off claims and encashment requests. */
export function TimeOffDecision({ requestId, kind }: { requestId: string; kind: "compoff" | "encash" }) {
  const [state, formAction, pending] = useForm(decideTimeRequestAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs" style={{ color: "var(--success)" }}>{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ minWidth: 220 }}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="entity" value={kind === "compoff" ? "CompOffRequest" : "LeaveEncashmentRequest"} />
      {rejecting ? <input className="input" name="note" placeholder="Reason for rejecting" required autoFocus /> : null}
      <div className="row gap-2">
        {rejecting ? (
          <>
            <button className="btn sm danger" type="submit" name="decision" value="reject" disabled={pending}>{pending ? "…" : "Confirm reject"}</button>
            <button className="btn sm ghost" type="button" onClick={() => setRejecting(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn sm primary" type="submit" name="decision" value="approve" disabled={pending}>{pending ? "…" : "Approve"}</button>
            <button className="btn sm" type="button" onClick={() => setRejecting(true)}>Reject</button>
          </>
        )}
      </div>
      {state.message && !state.ok ? <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}
