"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionState } from "@/lib/forms";
import type { ReqRow } from "../_lib/data";
import { DecideDialog } from "./decide";
import { Toast } from "./toast";
import s from "../hire.module.css";

/**
 * Pending Approvals (R04, R08): a checkbox per requisition and one in the
 * header, then Approve / Reject for everything selected. Rows the viewer
 * may not decide (their own) cannot be ticked, and say why.
 */
export function PendingTable({ rows, total, exportHref, viewHref }: { rows: ReqRow[]; total: number; exportHref: string; viewHref: Record<string, string> }) {
  const decidable = useMemo(() => rows.filter((r) => r.canDecide).map((r) => r.id), [rows]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [toast, setToast] = useState<ActionState | null>(null);
  const head = useRef<HTMLInputElement>(null);
  const all = decidable.length > 0 && decidable.every((id) => selected.includes(id));
  const some = selected.length > 0 && !all;
  useEffect(() => { if (head.current) head.current.indeterminate = some; }, [some]);
  // Rows that left the list (decided elsewhere) drop out of the selection.
  useEffect(() => { setSelected((sel) => sel.filter((id) => decidable.includes(id))); }, [decidable]);

  const toggle = (id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  const done = useCallback((st: ActionState) => {
    if (st.ok) { setMode(null); setSelected([]); }
    setToast(st);
  }, []);

  return (
    <div className={s.card}>
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          <button type="button" className={s.primaryBtn} disabled={selected.length === 0} onClick={() => setMode("approve")}>Approve</button>
          <button type="button" className={s.secondaryBtn} disabled={selected.length === 0} onClick={() => setMode("reject")}>Reject</button>
          {selected.length ? <span className="text-sm muted">{selected.length} selected</span> : null}
        </div>
        <div className={s.toolbarRight}>
          <span>Total: {total}</span>
          <a className={s.iconLink} href={exportHref} title="Download" aria-label="Download as CSV">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        </div>
      </div>
      {rows.length === 0 ? <div className={s.empty}>No requisitions are waiting for your approval.</div> : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.checkCol}>
                  <input ref={head} type="checkbox" className={s.check} aria-label="Select all" checked={all} disabled={decidable.length === 0}
                    onChange={() => setSelected(all ? [] : decidable)} />
                </th>
                <th>Requisition For</th><th>Department</th><th>Requested By</th><th>Location</th><th>Priority</th><th>Salary Range</th><th>Open Positions</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={s.checkCol}>
                    <input type="checkbox" className={s.check} aria-label={`Select ${r.title}`} checked={selected.includes(r.id)} disabled={!r.canDecide}
                      title={r.canDecide ? undefined : `You cannot decide this: ${r.blocker}`} onChange={() => toggle(r.id)} />
                  </td>
                  <td><Link className={s.reqLink} href={viewHref[r.id]} scroll={false}>{r.title}</Link><div className={s.code}>{r.code}</div></td>
                  <td>{r.department}</td>
                  <td>{r.requestedBy}<div className={s.metaLine}>on {r.requestedOn}</div></td>
                  <td>{r.location}</td>
                  <td className={r.priority ? s.priorityYes : undefined}>{r.priority ? "Yes" : "No"}</td>
                  <td className="nowrap">{r.salary}</td>
                  <td>{r.openPositions}</td>
                  <td>{r.canDecide ? <Link className={s.takeAction} href={viewHref[r.id]} scroll={false}>Take Action</Link> : <span className="text-xs subtle">{r.blocker}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mode ? <DecideDialog key={`${mode}-${selected.join()}`} ids={selected} decision={mode} open onClose={() => setMode(null)} onDone={done} /> : null}
      {toast?.message ? <Toast message={toast.message} ok={!!toast.ok} onClose={() => setToast(null)} /> : null}
    </div>
  );
}
