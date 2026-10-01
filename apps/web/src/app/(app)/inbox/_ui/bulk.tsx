"use client";

import { createContext, useActionState, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { decideManyAction, decideTimeRequestAction, addRequestCommentAction } from "@/app/actions/time-requests";
import type { ActionState } from "@/lib/forms";
import s from "../inbox.module.css";

/**
 * Keka's bulk approval: tick requests in the list and the detail pane turns
 * into "Take action on N selected … requests" with Approve all / Reject all,
 * confirmed in a dialog. Selection lives here, on the client; every decision
 * is re-checked item by item on the server.
 */

interface BulkCtx {
  entity: string;
  noun: string;
  ids: string[];
  selected: Set<string>;
  toggle: (id: string) => void;
  setAll: (on: boolean) => void;
  clear: () => void;
}

const Ctx = createContext<BulkCtx | null>(null);

export function BulkScope({ entity, noun, ids, children }: { entity: string; noun: string; ids: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Drop selections that are no longer in the list (decided elsewhere, filtered out).
  const key = ids.join(",");
  useEffect(() => { setSelected((prev) => new Set([...prev].filter((id) => ids.includes(id)))); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const value: BulkCtx = {
    entity, noun, ids, selected,
    toggle: (id) => setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
    setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The header checkbox: select every request in the list. */
export function SelectAll({ label }: { label: string }) {
  const ctx = useContext(Ctx);
  const ref = useRef<HTMLInputElement>(null);
  const all = !!ctx && ctx.ids.length > 0 && ctx.selected.size === ctx.ids.length;
  const some = !!ctx && ctx.selected.size > 0 && !all;
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  if (!ctx) return null;
  return (
    <input ref={ref} type="checkbox" className={s.check} checked={all} disabled={ctx.ids.length === 0}
      onChange={(e) => ctx.setAll(e.target.checked)} aria-label={`Select all ${label}`} />
  );
}

/** One row's checkbox. */
export function RowCheck({ id, label }: { id: string; label: string }) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <input type="checkbox" className={`${s.check} ${s.rowCheck}`} checked={ctx.selected.has(id)}
      onChange={() => ctx.toggle(id)} aria-label={`Select ${label}`} />
  );
}

/** A green confirmation card at the top right, as Keka shows after an action. */
export function Toast({ state, onDone }: { state: ActionState; onDone?: () => void }) {
  const [shown, setShown] = useState<ActionState | null>(null);
  useEffect(() => {
    if (!state.message) return;
    setShown(state);
    const t = setTimeout(() => { setShown(null); onDone?.(); }, 4200);
    return () => clearTimeout(t);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown?.message) return null;
  return (
    <div className={`${s.toast}${shown.ok ? "" : ` ${s.toastBad}`}`} role="status" aria-live="polite">
      <span className={s.toastIcon} aria-hidden="true">
        {shown.ok
          ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9.5" /><path d="m8 12.5 2.8 2.7L16.5 9.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5v5.5M12 16.4h.01" strokeLinecap="round" /></svg>}
      </span>
      <span>
        <span className={s.toastTitle}>{shown.ok ? "Success!" : "Not done"}</span>
        <span className={s.toastText}>{shown.message}</span>
      </span>
      <button type="button" className={s.toastClose} aria-label="Dismiss" onClick={() => setShown(null)}>×</button>
    </div>
  );
}

/**
 * The detail pane: the selected item's detail, or — once anything is
 * ticked — the bulk card.
 */
export function BulkSwap({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx);
  const router = useRouter();
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState(decideManyAction, {} as ActionState);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (confirm && !d.open) d.showModal();
    if (!confirm && d.open) d.close();
  }, [confirm]);
  useEffect(() => {
    if (state.ok) { setConfirm(null); ctx?.clear(); router.refresh(); }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = ctx?.selected.size ?? 0;
  const noun = ctx?.noun ?? "request";
  return (
    <>
      {n === 0 || !ctx ? children : (
        <div className={s.bulk}>
          <div className={s.bulkStack} aria-hidden="true">
            <span className={s.bulkCard}><b>{n}</b><span>{noun}</span></span>
          </div>
          <p className={s.bulkText}>Take action on {n} selected {noun.toLowerCase()} request{n === 1 ? "" : "s"}</p>
          <div className={s.bulkActions}>
            <button type="button" className={`btn ${s.approve}`} onClick={() => setConfirm("approve")}>Approve all</button>
            <button type="button" className={`btn ${s.reject}`} onClick={() => setConfirm("reject")}>Reject all</button>
          </div>
        </div>
      )}
      <dialog ref={dialog} className={s.confirm} onClose={() => setConfirm(null)} aria-labelledby="bulk-confirm-title">
        {ctx && confirm ? (
          <form action={action}>
            <input type="hidden" name="entity" value={ctx.entity} />
            <input type="hidden" name="decision" value={confirm} />
            {[...ctx.selected].map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
            <div className={s.confirmHead}>
              <h2 id="bulk-confirm-title">Confirm action on selected items in Inbox</h2>
              <button type="button" className={s.toastClose} aria-label="Close" onClick={() => setConfirm(null)}>×</button>
            </div>
            <div className={s.confirmBody}>
              <p>You are {confirm === "approve" ? "approving" : "rejecting"} {n} selected {noun} request{n === 1 ? "" : "s"}.</p>
              {confirm === "reject" ? (
                <label className="field" style={{ marginTop: 14 }}>
                  <span className="label">Reason <span style={{ color: "var(--danger)" }}>*</span></span>
                  <textarea name="note" className="textarea" rows={3} required placeholder="Type in an appropriate reason" />
                </label>
              ) : null}
              {state.message && !state.ok ? <div className="callout danger" style={{ marginTop: 12 }}>{state.message}</div> : null}
            </div>
            <div className={s.confirmFoot}>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={pending}>{pending ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        ) : null}
      </dialog>
      <Toast state={state} />
    </>
  );
}

/**
 * The bar at the foot of a request: a comment box, the comment button, and
 * Approve / Reject. Rejecting needs the comment as its reason.
 */
export function DecisionBar({ entity, requestId, canDecide, placeholder = "Add comment here" }: {
  entity: string; requestId: string; canDecide: boolean; placeholder?: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [decided, decide, deciding] = useActionState(decideTimeRequestAction, {} as ActionState);
  const [commented, comment, commenting] = useActionState(
    async (prev: ActionState, fd: FormData) => {
      fd.set("body", String(fd.get("note") ?? ""));
      return addRequestCommentAction(prev, fd);
    },
    {} as ActionState,
  );
  useEffect(() => { if (commented.ok) { setNote(""); router.refresh(); } }, [commented]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (decided.ok) router.refresh(); }, [decided]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = deciding || commenting;
  return (
    <>
      <form className={s.decisionBar}>
        <input type="hidden" name="entity" value={entity} />
        <input type="hidden" name="requestId" value={requestId} />
        <input name="note" className={s.decisionInput} placeholder={placeholder} value={note} maxLength={1000}
          onChange={(e) => setNote(e.target.value)} aria-label={placeholder} />
        <button type="submit" formAction={comment} className={s.commentBtn} disabled={busy || !note.trim()} aria-label="Post comment" title="Post comment">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
        </button>
        {canDecide ? (
          <>
            <button type="submit" formAction={decide} name="decision" value="approve" className={`btn ${s.approve}`} disabled={busy}>Approve</button>
            <button type="submit" formAction={decide} name="decision" value="reject" className={`btn ${s.reject}`} disabled={busy}
              onClick={(e) => { if (!note.trim()) { e.preventDefault(); alert("Add a comment as the reason for rejecting."); } }}>Reject</button>
          </>
        ) : null}
      </form>
      <Toast state={decided.message ? decided : commented} />
    </>
  );
}
