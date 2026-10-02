"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { decideManyAction, decideTimeRequestAction } from "@/app/actions/time-requests";
import type { ActionState } from "@/lib/forms";
import s from "./time.module.css";

/**
 * A Keka approvals table: tick rows and approve or reject them together, or
 * decide one with the ✓ / ✕ on its row. Rejecting always asks for a reason.
 * Every decision is checked again on the server, row by row.
 */

export interface TableRow {
  id: string;
  employee: { id: string; name: string; number: string; department: string | null; photoUrl: string | null };
  status: string;
  requestedOn: string;
  cells: Record<string, string>;
  mapUrl?: string | null;
  lastActionBy: string | null;
  lastActionAt: string | null;
  decisionNote: string | null;
  nextApprover: string | null;
  canDecide: boolean;
}

const STATUS_TONE: Record<string, string> = {
  PENDING: s.stPending, APPROVED: s.stApproved, REJECTED: s.stRejected, CANCELLED: s.stCancelled, WITHDRAWN: s.stCancelled,
};
const title = (st: string) => st.charAt(0) + st.slice(1).toLowerCase();
const when = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const h = d.getUTCHours();
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()} ${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export function ApprovalsTable({ rows, columns, entity, inboxCat, empty }: {
  rows: TableRow[];
  columns: Array<{ key: string; label: string }>;
  entity: string;
  /** The inbox category, for the comment thread link. */
  inboxCat: string;
  empty: string;
}) {
  const router = useRouter();
  const decidable = rows.filter((r) => r.canDecide).map((r) => r.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<{ ids: string[]; decision: "approve" | "reject" } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [many, decideMany, pendingMany] = useActionState(decideManyAction, {} as ActionState);
  const [one, decideOne, pendingOne] = useActionState(decideTimeRequestAction, {} as ActionState);
  const [toast, setToast] = useState<ActionState | null>(null);

  useEffect(() => { setSelected((p) => new Set([...p].filter((id) => decidable.includes(id)))); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (ask && !d.open) d.showModal();
    if (!ask && d.open) d.close();
  }, [ask]);
  const settle = (st: ActionState) => {
    if (!st.message) return;
    setToast(st);
    if (st.ok) { setAsk(null); setSelected(new Set()); router.refresh(); }
  };
  useEffect(() => settle(many), [many]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => settle(one), [one]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const all = decidable.length > 0 && selected.size === decidable.length;
  const toggle = (id: string) => setSelected((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const busy = pendingMany || pendingOne;

  if (rows.length === 0) {
    return <div className={s.emptyBar}>{empty}</div>;
  }

  return (
    <>
      {selected.size > 0 ? (
        <div className={s.bulkBar} role="region" aria-label="Selected requests">
          <span><b>{selected.size}</b> selected</span>
          <button type="button" className={`btn sm ${s.approveBtn}`} disabled={busy} onClick={() => setAsk({ ids: [...selected], decision: "approve" })}>Approve</button>
          <button type="button" className={`btn sm ${s.rejectBtn}`} disabled={busy} onClick={() => setAsk({ ids: [...selected], decision: "reject" })}>Reject</button>
          <button type="button" className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th className={s.checkCol}>
                {decidable.length ? (
                  <input type="checkbox" checked={all} onChange={(e) => setSelected(e.target.checked ? new Set(decidable) : new Set())} aria-label="Select all pending requests" />
                ) : null}
              </th>
              <th>Employee</th>
              {columns.map((c) => <th key={c.key}>{c.label}</th>)}
              <th>Requested on</th>
              <th>Status</th>
              <th>Last action by</th>
              <th>Next approver</th>
              <th className={s.actionsCol}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? s.rowSelected : undefined}>
                <td className={s.checkCol}>
                  {r.canDecide ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.employee.name}`} /> : null}
                </td>
                <td>
                  <span className={s.person}>
                    <Avatar name={r.employee.name} photoUrl={r.employee.photoUrl} size={32} />
                    <span>
                      <Link href={`/directory/${r.employee.id}`} className={s.personName}>{r.employee.name}</Link>
                      <span className={s.personMeta}>{r.employee.number}{r.employee.department ? ` · ${r.employee.department}` : ""}</span>
                    </span>
                  </span>
                </td>
                {columns.map((c) => (
                  <td key={c.key} className={c.key === "note" ? s.noteCell : undefined}>
                    {c.key === "location" && r.mapUrl
                      ? <a href={r.mapUrl} target="_blank" rel="noopener noreferrer" className="link">View map</a>
                      : r.cells[c.key] || <span className="subtle">—</span>}
                  </td>
                ))}
                <td className={s.nowrap}>{when(r.requestedOn)}</td>
                <td><span className={`${s.status} ${STATUS_TONE[r.status] ?? ""}`}>{title(r.status)}</span></td>
                <td className={s.nowrap}>
                  {r.lastActionBy ? <>{r.lastActionBy}<span className={s.personMeta}>{r.lastActionAt ? `on ${when(r.lastActionAt).slice(0, 11)}` : ""}</span></> : <span className="subtle">—</span>}
                  {r.decisionNote ? <span className={s.personMeta} title={r.decisionNote}>“{r.decisionNote.length > 40 ? `${r.decisionNote.slice(0, 40)}…` : r.decisionNote}”</span> : null}
                </td>
                <td className={s.nowrap}>{r.nextApprover ?? <span className="subtle">—</span>}</td>
                <td className={s.actionsCol}>
                  <span className={s.rowActions}>
                    {r.canDecide ? (
                      <>
                        <form action={decideOne}>
                          <input type="hidden" name="entity" value={entity} />
                          <input type="hidden" name="requestId" value={r.id} />
                          <button type="submit" name="decision" value="approve" className={`${s.iconBtn} ${s.iconOk}`} disabled={busy} title="Approve" aria-label={`Approve ${r.employee.name}'s request`}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.6L16 9.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                        </form>
                        <button type="button" className={`${s.iconBtn} ${s.iconNo}`} disabled={busy} title="Reject" aria-label={`Reject ${r.employee.name}'s request`}
                          onClick={() => setAsk({ ids: [r.id], decision: "reject" })}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" strokeLinecap="round" /></svg>
                        </button>
                      </>
                    ) : null}
                    <Link href={`/inbox${r.status === "PENDING" ? `?cat=${inboxCat}&id=${r.id}` : `/archive`}`} className={s.iconBtn} title="Comments" aria-label="Comments">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg>
                    </Link>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.pager}>1 to {rows.length} of {rows.length}<span>Page 1 of 1</span></div>

      <dialog ref={dialog} className={s.dialog} onClose={() => setAsk(null)} aria-labelledby="ap-confirm">
        {ask ? (
          <form action={ask.ids.length === 1 && ask.decision === "reject" ? decideOne : decideMany}>
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="decision" value={ask.decision} />
            {ask.ids.length === 1 ? <input type="hidden" name="requestId" value={ask.ids[0]} /> : null}
            {ask.ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
            <div className={s.dialogHead}><h2 id="ap-confirm">{ask.decision === "approve" ? "Approve requests" : "Reject request"}{ask.ids.length > 1 ? "s" : ""}</h2></div>
            <div className={s.dialogBody}>
              <p>You are {ask.decision === "approve" ? "approving" : "rejecting"} {ask.ids.length} selected request{ask.ids.length === 1 ? "" : "s"}.</p>
              {ask.decision === "reject" ? (
                <label className="field" style={{ marginTop: 12 }}>
                  <span className="label">Reason <span style={{ color: "var(--danger)" }}>*</span></span>
                  <textarea name="note" className="textarea" rows={3} required placeholder="Type in an appropriate reason" />
                </label>
              ) : null}
            </div>
            <div className={s.dialogFoot}>
              <button type="button" className="btn" onClick={() => setAsk(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        ) : null}
      </dialog>
      {toast ? (
        <div className={`${s.toast}${toast.ok ? "" : ` ${s.toastBad}`}`} role="status">
          <b>{toast.ok ? "Success!" : "Not done"}</b><span>{toast.message}</span>
        </div>
      ) : null}
    </>
  );
}
