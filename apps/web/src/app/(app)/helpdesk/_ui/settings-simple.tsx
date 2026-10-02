"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Sheet } from "@/components/sheet";
import { DangerButton, FormBanner } from "@/components/form";
import {
  saveCannedResponseAction, deleteCannedResponseAction,
  saveClosingReasonAction, setClosingReasonActiveAction, deleteClosingReasonAction,
} from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import { Editor } from "./editor";
import { Rich } from "./rich";
import { day } from "./format";
import s from "./hd.module.css";

type Action = (prev: ActionState, f: FormData) => Promise<ActionState>;

/** A one-button form (activate, duplicate…) that reports a failure inline. */
export function ActionButton({ action, hidden, label, className = "btn ghost sm" }: { action: Action; hidden: Record<string, string>; label: ReactNode; className?: string }) {
  const [state, run, pending] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={run} style={{ display: "inline-block" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={className} disabled={pending}>{pending ? "…" : label}</button>
      {state.message && !state.ok ? <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}

/** Sheet-hosted create/edit form that closes itself once the save succeeds. */
function SheetForm({ action, onDone, children, submit }: { action: Action; onDone: () => void; children: (state: ActionState) => ReactNode; submit: string }) {
  const [state, run, pending] = useActionState<ActionState, FormData>(action, {});
  useEffect(() => { if (state.ok) onDone(); }, [state, onDone]);
  return (
    <form action={run}>
      <FormBanner state={state.ok ? {} : state} />
      {children(state)}
      <div className={s.drawerFoot}>
        <button type="button" className="btn lg" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary lg" disabled={pending}>{pending ? "Saving…" : submit}</button>
      </div>
    </form>
  );
}

const fieldErr = (state: ActionState, k: string) => (state.errors?.[k] ? <div className={s.err}>{state.errors[k]}</div> : null);

// ---------------------------------------------------------------------------
//  Canned responses
// ---------------------------------------------------------------------------

export interface CannedRow { id: string; title: string; body: string; updatedBy: string | null; updatedAt: string }

export function CannedResponses({ rows }: { rows: CannedRow[] }) {
  const [editing, setEditing] = useState<CannedRow | "new" | null>(null);
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => `${r.title} ${r.body}`.toLowerCase().includes(q.trim().toLowerCase()));
  const current = editing && editing !== "new" ? editing : null;
  return (
    <div className={s.panel}>
      <div className={`${s.toolbar} ${s.toolbarLeft}`}>
        <div className={s.search}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search responses" />
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>+ Add response</button>
      </div>
      {shown.length === 0 ? <div className={s.empty}>{rows.length ? "No responses match." : "No canned responses yet. Add the replies your team sends most."}</div> : (
        <table className={s.table}>
          <thead><tr><th>Title</th><th>Response</th><th>Last updated</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className={s.titleCell}><button type="button" className={s.addLink} onClick={() => setEditing(r)}>{r.title}</button></td>
                <td style={{ maxWidth: 480 }}><div className={s.templatePreview}><Rich text={r.body} /></div></td>
                <td className={s.nowrap}>{day(r.updatedAt)}{r.updatedBy ? <div className={s.sub}>{r.updatedBy}</div> : null}</td>
                <td className={s.nowrap} style={{ textAlign: "right" }}>
                  <button type="button" className="btn ghost sm" onClick={() => setEditing(r)}>Edit</button>
                  <DangerButton action={deleteCannedResponseAction} hidden={{ id: r.id }} label="Delete" confirmLabel={`Delete "${r.title}"?`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={current ? "Edit canned response" : "Add canned response"} side>
        <SheetForm action={saveCannedResponseAction} onDone={() => setEditing(null)} submit="Save">
          {(state) => (
            <>
              {current ? <input type="hidden" name="id" value={current.id} /> : null}
              <div className={s.formField}>
                <label className={s.formLabel} htmlFor="title">Title</label>
                <input id="title" name="title" className={s.input} maxLength={120} defaultValue={state.values?.title ?? current?.title} />
                {fieldErr(state, "title")}
              </div>
              <div className={s.formField}>
                <label className={s.formLabel} htmlFor="body">Response</label>
                <Editor name="body" rows={10} defaultValue={state.values?.body ?? current?.body} invalid={!!state.errors?.body} />
                {fieldErr(state, "body")}
              </div>
            </>
          )}
        </SheetForm>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Closing reasons
// ---------------------------------------------------------------------------

export interface ReasonRow { id: string; name: string; description: string | null; isActive: boolean; used: number }

export function ClosingReasons({ rows }: { rows: ReasonRow[] }) {
  const [editing, setEditing] = useState<ReasonRow | "new" | null>(null);
  const current = editing && editing !== "new" ? editing : null;
  return (
    <div className={s.panel}>
      <div className={`${s.toolbar} ${s.toolbarLeft}`}>
        <span className="text-sm muted">Agents pick one of the active reasons when they close a ticket.</span>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>+ Add reason</button>
      </div>
      {rows.length === 0 ? <div className={s.empty}>No closing reasons yet. Without any, tickets close without one.</div> : (
        <table className={s.table}>
          <thead><tr><th>Reason</th><th>Description</th><th>Used on</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className={s.muted}>{r.description ?? "—"}</td>
                <td className={s.num}>{r.used} ticket{r.used === 1 ? "" : "s"}</td>
                <td>{r.isActive ? <span className="badge success">Active</span> : <span className="badge neutral">Inactive</span>}</td>
                <td className={s.nowrap} style={{ textAlign: "right" }}>
                  <button type="button" className="btn ghost sm" onClick={() => setEditing(r)}>Edit</button>
                  <ActionButton action={setClosingReasonActiveAction} hidden={{ id: r.id, active: String(!r.isActive) }} label={r.isActive ? "Deactivate" : "Activate"} />
                  {r.used === 0 ? <DangerButton action={deleteClosingReasonAction} hidden={{ id: r.id }} label="Delete" confirmLabel={`Delete "${r.name}"?`} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={current ? "Edit closing reason" : "Add closing reason"} side>
        <SheetForm action={saveClosingReasonAction} onDone={() => setEditing(null)} submit="Save">
          {(state) => (
            <>
              {current ? <input type="hidden" name="id" value={current.id} /> : null}
              <div className={s.formField}>
                <label className={s.formLabel} htmlFor="name">Reason</label>
                <input id="name" name="name" className={s.input} maxLength={80} defaultValue={state.values?.name ?? current?.name} />
                {fieldErr(state, "name")}
              </div>
              <div className={s.formField}>
                <label className={s.formLabel} htmlFor="description">Description</label>
                <textarea id="description" name="description" className="textarea" rows={3} maxLength={300} defaultValue={state.values?.description ?? current?.description ?? ""} />
                {fieldErr(state, "description")}
              </div>
            </>
          )}
        </SheetForm>
      </Sheet>
    </div>
  );
}
