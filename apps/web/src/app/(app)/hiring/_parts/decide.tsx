"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/sheet";
import { bulkDecideRequisitionsAction } from "@/app/actions/hiring";
import type { ActionState } from "@/lib/forms";
import { Toast } from "./toast";
import s from "../hire.module.css";

/**
 * Keka's approve/reject confirmation (R09): "Approve Requisitions — Are you
 * sure you want to approve N requisition(s)?", with Cancel and Confirm.
 * Rejecting asks for the reason, which the raiser is told.
 */
export function DecideDialog({ ids, decision, open, onClose, onDone }: {
  ids: string[]; decision: "approve" | "reject"; open: boolean; onClose: () => void; onDone: (state: ActionState) => void;
}) {
  const [state, action, pending] = useActionState(bulkDecideRequisitionsAction, {} as ActionState);
  const handled = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.message && handled.current !== state) {
      handled.current = state;
      onDone(state);
    }
  }, [state, onDone]);
  const n = ids.length;
  const approve = decision === "approve";
  return (
    <Sheet open={open} onClose={onClose} title={approve ? "Approve Requisitions" : "Reject Requisitions"}>
      <form action={action}>
        {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
        <input type="hidden" name="decision" value={decision} />
        <p style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 14 }}>
          Are you sure you want to {decision} {n} requisition{n === 1 ? "" : "s"}.
        </p>
        {approve ? (
          <p style={{ fontSize: 13.5, lineHeight: 1.6, maxWidth: 500 }}>
            When you approve the requisitions, you can no longer make any changes to requisition details, only super recruiters/global admins can make changes in active requisitions from keka hire.
          </p>
        ) : (
          <label style={{ display: "block" }}>
            <span style={{ fontSize: 13.5 }}>Reason for rejecting <span className={s.req}>*</span></span>
            <textarea name="reason" required maxLength={500} rows={3} className="textarea" style={{ marginTop: 6 }} placeholder="The requester will see this" />
          </label>
        )}
        {state.message && !state.ok ? <div className="callout danger" style={{ marginTop: 14 }}>{state.message}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)", marginInline: -22, paddingInline: 22 }}>
          <button type="button" className={s.outlineBtn} onClick={onClose}>Cancel</button>
          <button type="submit" className={s.primaryBtn} disabled={pending || n === 0}>{pending ? "Working…" : "Confirm"}</button>
        </div>
      </form>
    </Sheet>
  );
}

/** Approve / Reject buttons for one requisition (the View Requisition footer). */
export function DecideButtons({ id, closeHref }: { id: string; closeHref: string }) {
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [toast, setToast] = useState<ActionState | null>(null);
  return (
    <>
      <button type="button" className={s.secondaryBtn} onClick={() => setMode("reject")}>Reject</button>
      <button type="button" className={s.primaryBtn} onClick={() => setMode("approve")}>Approve</button>
      {mode ? (
        <DecideDialog key={mode} ids={[id]} decision={mode} open onClose={() => setMode(null)}
          onDone={(st) => {
            if (st.ok) {
              setMode(null);
              window.location.assign(`${closeHref}${closeHref.includes("?") ? "&" : "?"}flash=${mode === "approve" ? "approved" : "rejected"}`);
            } else setToast(st);
          }} />
      ) : null}
      {toast?.message ? <Toast message={toast.message} ok={!!toast.ok} onClose={() => setToast(null)} /> : null}
    </>
  );
}
