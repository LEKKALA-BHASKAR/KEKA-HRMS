"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  updateTicketAction, assignToMeAction, addFollowerAction, removeFollowerAction, addNoteAction,
  reopenTicketAction, rateTicketAction, aiSummariseTicketAction,
} from "@/app/actions/helpdesk";
import { ticketStatusAction } from "@/app/actions/lifecycle";
import type { ActionState } from "@/lib/forms";
import { Initials } from "./bits";
import { PRIORITY_DOT, threadTime } from "./format";
import s from "./hd.module.css";

type Opt = { value: string; label: string };

function Msg({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", marginTop: 8 }}>{state.message}</div>;
}

// ---------------------------------------------------------------------------
//  Agent side
// ---------------------------------------------------------------------------

/** Status, priority, category, assignee and — when closing — the reason, saved together with "Update". */
export function DetailsPanel({ ticketId, status, priority, categoryId, assigneeUserId, categories, assignees, reasons, onHold }: {
  ticketId: string; status: string; priority: string; categoryId: string; assigneeUserId: string | null;
  categories: Opt[]; assignees: Opt[]; reasons: Opt[]; onHold: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateTicketAction, {});
  const [st, setSt] = useState(status);
  const [pr, setPr] = useState(priority);
  useEffect(() => { setSt(status); setPr(priority); }, [status, priority]);
  const statuses: Opt[] = [
    { value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In Progress" },
    ...(onHold || status === "ON_HOLD" ? [{ value: "ON_HOLD", label: "On Hold" }] : []), { value: "CLOSED", label: "Closed" },
  ];
  const closing = st === "CLOSED" && status !== "CLOSED";
  const err = (k: string) => state.errors?.[k];
  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label className={s.fieldLabel} htmlFor="hd-status">Status</label>
      <select id="hd-status" name="status" className="select" value={st} onChange={(e) => setSt(e.target.value)} style={{ marginBottom: 14, width: "100%" }}>
        {statuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {closing && reasons.length ? (
        <>
          <label className={s.fieldLabel} htmlFor="hd-reason">Closing reason</label>
          <select id="hd-reason" name="closingReasonId" className="select" defaultValue="" style={{ marginBottom: 14, width: "100%", ...(err("closingReasonId") ? { borderColor: "var(--danger)" } : {}) }}>
            <option value="">Select a reason</option>
            {reasons.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </>
      ) : null}
      <label className={s.fieldLabel} htmlFor="hd-priority">Priority</label>
      <div className={s.dotSelect} style={{ ["--dot" as string]: PRIORITY_DOT[pr] ?? "transparent", marginBottom: 14 }}>
        <select id="hd-priority" name="priority" className="select" value={pr} onChange={(e) => setPr(e.target.value)} style={{ width: "100%" }}>
          {[["NA", "NA"], ["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <label className={s.fieldLabel} htmlFor="hd-category">Category</label>
      <select id="hd-category" name="categoryId" className="select" defaultValue={categoryId} style={{ marginBottom: 14, width: "100%" }}>
        {categories.some((c) => c.value === categoryId) ? null : <option value={categoryId}>(current category)</option>}
        {categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label className={s.fieldLabel} htmlFor="hd-assignee">Assigned to</label>
      <select id="hd-assignee" name="assigneeUserId" className="select" defaultValue={assigneeUserId ?? ""} style={{ marginBottom: 14, width: "100%", ...(err("assigneeUserId") ? { borderColor: "var(--danger)" } : {}) }}>
        <option value="">Not assigned</option>
        {assignees.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className={s.updateBtn} disabled={pending}>{pending ? "Updating…" : "Update"}</button>
      </div>
      <Msg state={state} />
    </form>
  );
}

export function AssignToMe({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(assignToMeAction, {});
  return (
    <form action={action} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <button type="submit" className={s.outlineBtn} disabled={pending}>{pending ? "Assigning…" : "Assign to me"}</button>
      {state.message && !state.ok ? <span className={s.err}>{state.message}</span> : null}
    </form>
  );
}

export function FollowersPanel({ ticketId, followers, roles, people }: {
  ticketId: string;
  followers: Array<{ id: string; name: string; via: string | null }>;
  /** Roles that resolve to someone for this raiser, e.g. { value: "REPORTING_MANAGER", label: "Reporting Manager (Ananya Rao)" }. */
  roles: Opt[];
  people: Opt[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addFollowerAction, {});
  const [removeState, remove] = useActionState<ActionState, FormData>(removeFollowerAction, {});
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  useEffect(() => { if (state.ok) { setAdding(false); setPick(""); } }, [state]);
  const [kind, id] = pick.split(":");
  return (
    <div>
      {followers.length ? (
        <div className={s.followers}>
          {followers.map((f) => (
            <form key={f.id} action={remove} className={s.followerChip}>
              <input type="hidden" name="ticketId" value={ticketId} />
              <input type="hidden" name="followerId" value={f.id} />
              <Initials name={f.name} size={22} />
              <span title={f.via ?? undefined}>{f.name}</span>
              <button type="submit" className={s.chipX} aria-label={`Remove ${f.name}`}>×</button>
            </form>
          ))}
        </div>
      ) : <div className="text-sm muted">No followers yet.</div>}
      {adding ? (
        <form action={action} style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="role" value={kind === "role" ? id : ""} />
          <input type="hidden" name="employeeId" value={kind === "emp" ? id : ""} />
          <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Follower">
            <option value="">Select a role or an employee</option>
            {roles.length ? <optgroup label="By role">{roles.map((r) => <option key={r.value} value={`role:${r.value}`}>{r.label}</option>)}</optgroup> : null}
            <optgroup label="Employees">{people.map((p) => <option key={p.value} value={`emp:${p.value}`}>{p.label}</option>)}</optgroup>
          </select>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" className="btn primary sm" disabled={pending || !pick}>{pending ? "Adding…" : "Add"}</button>
          </div>
        </form>
      ) : <button type="button" className={s.addLink} style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Add follower</button>}
      <Msg state={state.message ? state : removeState} />
    </div>
  );
}

export function NotesPanel({ ticketId, notes }: { ticketId: string; notes: Array<{ id: string; author: string; body: string; createdAt: string }> }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addNoteAction, {});
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (state.ok) { if (area.current) area.current.value = ""; setOpen(false); } }, [state]);
  return (
    <div>
      {open ? (
        <form action={action} style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <textarea ref={area} name="body" className="textarea" rows={3} maxLength={5000} placeholder="Only agents see notes" autoFocus />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary sm" disabled={pending}>{pending ? "Saving…" : "Add note"}</button>
          </div>
        </form>
      ) : <button type="button" className={s.noteInput} onClick={() => setOpen(true)}>Add a note for the team</button>}
      <Msg state={state} />
      {notes.length ? (
        <div className={s.notes}>
          {notes.map((n) => (
            <div key={n.id} className={s.note}>
              <div className={s.noteMeta}>{n.author} · {threadTime(n.createdAt)}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AiSummary({ ticketId }: { ticketId: string }) {
  const [pending, start] = useTransition();
  const [out, setOut] = useState<{ summary: string; nextStep: string } | { error: string } | null>(null);
  const run = () => start(async () => {
    const res = await aiSummariseTicketAction(ticketId);
    setOut(res.ok ? res.value : { error: res.reason });
  });
  return out ? (
    <div className={s.aiCard} role="status">
      {"error" in out ? out.error : <><div><strong>Summary.</strong> {out.summary}</div><div style={{ marginTop: 6 }}><strong>Next step.</strong> {out.nextStep}</div></>}
    </div>
  ) : <button type="button" className={s.aiBtn} onClick={run} disabled={pending}>{pending ? "Summarising…" : "Summarise with AI"}</button>;
}

// ---------------------------------------------------------------------------
//  Employee side
// ---------------------------------------------------------------------------

export function ReopenTicket({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(reopenTicketAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <button type="submit" className={s.outlineBtn} disabled={pending}>{pending ? "Reopening…" : "Reopen ticket"}</button>
      <Msg state={state} />
    </form>
  );
}

export function CloseOwnTicket({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(ticketStatusAction, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm("Close this ticket? You can reopen it within 7 days.")) e.preventDefault(); }}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="status" value="CLOSED" />
      <button type="submit" className={s.outlineBtn} disabled={pending}>{pending ? "Closing…" : "Close ticket"}</button>
      <Msg state={state} />
    </form>
  );
}

export function RateTicket({ ticketId, current }: { ticketId: string; current: number | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(rateTicketAction, {});
  const [hover, setHover] = useState(0);
  const value = hover || current || 0;
  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <div className={s.fieldLabel}>How was the support?</div>
      <div style={{ display: "flex", gap: 4 }} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="submit" name="rating" value={n} disabled={pending} aria-label={`${n} of 5`} onMouseEnter={() => setHover(n)}
            style={{ background: "none", border: 0, cursor: "pointer", fontSize: 24, lineHeight: 1, color: n <= value ? "#f2b23a" : "var(--border-strong)" }}>★</button>
        ))}
      </div>
      <textarea name="comment" className="textarea" rows={2} maxLength={1000} placeholder="Anything we could have done better? (optional, sent with your rating)" style={{ marginTop: 6 }} />
      <Msg state={state} />
    </form>
  );
}
