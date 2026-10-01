"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { decideApprovalAction, withdrawApprovalAction } from "@/app/actions/payroll-approvals";

export function ApprovalDecision({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useForm(decideApprovalAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="requestId" value={requestId} />
      <input className="input" name="comment" placeholder={rejecting ? "Reason" : "Comment (optional)"} required={rejecting} style={{ width: 220 }} />
      <div className="row gap-2">
        {rejecting ? (
          <>
            <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Reject</button>
            <button type="button" className="btn sm ghost" onClick={() => setRejecting(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
            <button type="button" className="btn sm" onClick={() => setRejecting(true)}>Reject</button>
          </>
        )}
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function WithdrawRequest({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useForm(withdrawApprovalAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <button className="btn sm ghost" disabled={pending}>{pending ? "…" : "Withdraw"}</button>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
