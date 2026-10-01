"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CancelLeaveButton } from "../../../_time/leave-forms";
import { Popover, MoreIcon } from "../../attendance/_parts/overlay";
import ps from "../../attendance/_parts/parts.module.css";
import s from "../leave.module.css";

export interface HistoryRow {
  id: string;
  dates: string;
  days: string;
  sortKey: string;
  typeId: string;
  typeName: string;
  requestedOn: string;
  status: string;
  statusLabel: string;
  by: string | null;
  requestedBy: string;
  actionOn: string | null;
  note: string | null;
  reason: string | null;
  sandwich: string | null;
  cancel: "Withdraw" | "Cancel" | null;
}

const PAGE = 5;
const STATUS_CLASS: Record<string, string> = {
  APPROVED: "stApproved", PENDING: "stPending", REJECTED: "stRejected", CANCELLED: "stCancelled", WITHDRAWN: "stCancelled",
};

/**
 * Leave History: filter by type and status, search, five to a page. All of
 * the year's requests arrive at once (they are the viewer's own and few), so
 * filtering never waits on the server.
 */
export function LeaveHistory({
  rows, types, detailsHref,
}: {
  rows: HistoryRow[];
  types: Array<{ value: string; label: string }>;
  detailsHref: Record<string, string>;
}) {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!type || r.typeId === type) &&
      (!status || r.status === status) &&
      (!needle || [r.dates, r.typeName, r.statusLabel, r.by, r.requestedBy, r.note, r.reason, r.requestedOn]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [rows, type, status, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const statuses = [...new Set(rows.map((r) => r.status))];
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(0); };

  return (
    <section className={s.panel} aria-label="Leave history">
      <div className={s.filterBar}>
        <label className={s.filterSelect}>
          <span className="sr-only">Leave type</span>
          <select value={type} onChange={(e) => reset(setType)(e.target.value)}>
            <option value="">Leave Type</option>
            {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <Caret />
        </label>
        <label className={s.filterSelect}>
          <span className="sr-only">Status</span>
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">Status</option>
            {statuses.map((st) => <option key={st} value={st}>{st.charAt(0) + st.slice(1).toLowerCase()}</option>)}
          </select>
          <Caret />
        </label>
        <label className={s.search}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className="sr-only">Search leave history</span>
          <input type="search" placeholder="Search" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        </label>
      </div>
      <div className={s.total}>Total: {filtered.length}</div>

      {filtered.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>{rows.length === 0 ? "No leave requests in this leave year" : "Nothing matches these filters"}</div>
          <div>{rows.length === 0 ? "Requests you raise appear here with their approval trail." : "Clear a filter or the search to see more."}</div>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Leave dates</th>
                <th scope="col">Leave type</th>
                <th scope="col">Status</th>
                <th scope="col">Requested by</th>
                <th scope="col">Action taken on</th>
                <th scope="col">Leave note</th>
                <th scope="col">Reject/Cancellation reason</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <div>{r.dates}</div>
                    <div className={s.sub}>{r.days}{r.sandwich ? ` · ${r.sandwich}` : ""}</div>
                  </th>
                  <td>
                    <div>{r.typeName}</div>
                    <div className={s.sub}>Requested on {r.requestedOn}</div>
                  </td>
                  <td>
                    <div className={s[STATUS_CLASS[r.status] ?? "stCancelled"]}>{r.statusLabel}</div>
                    {r.by ? <div className={s.sub}>by {r.by}</div> : null}
                  </td>
                  <td>{r.requestedBy}</td>
                  <td className={s.nowrap}>{r.actionOn ?? <span className="subtle">—</span>}</td>
                  <td><div className={s.clamp} title={r.note ?? undefined}>{r.note ?? <span className="subtle">—</span>}</div></td>
                  <td><div className={s.clamp} title={r.reason ?? undefined}>{r.reason ?? <span className="subtle">—</span>}</div></td>
                  <td>
                    <Popover label={`Actions for ${r.typeName}, ${r.dates}`} trigger={<MoreIcon />} width={210}>
                      {r.cancel ? (
                        <div style={{ padding: "2px 2px 4px" }}>
                          <CancelLeaveButton requestId={r.id} label={r.cancel === "Withdraw" ? "Withdraw request" : "Cancel leave"} />
                        </div>
                      ) : (
                        <div className={ps.menuText}>
                          {r.status === "APPROVED" ? "This leave has started. Ask HR to cancel it." : "No actions for this request."}
                        </div>
                      )}
                      {detailsHref[r.typeId] ? (
                        <Link href={detailsHref[r.typeId]} scroll={false} className={ps.menuItem}>View {r.typeName} balance</Link>
                      ) : null}
                    </Popover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 ? (
        <nav className={s.pager} aria-label="Leave history pages">
          <span className={s.pagerCount}>
            {current * PAGE + 1} to {Math.min(filtered.length, current * PAGE + PAGE)} of {filtered.length}
          </span>
          <button type="button" className={s.pageBtn} onClick={() => setPage(0)} disabled={current === 0} aria-label="First page">«</button>
          <button type="button" className={s.pageBtn} onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page">‹</button>
          <span aria-live="polite">Page {current + 1} of {pages}</span>
          <button type="button" className={s.pageBtn} onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page">›</button>
          <button type="button" className={s.pageBtn} onClick={() => setPage(pages - 1)} disabled={current >= pages - 1} aria-label="Last page">»</button>
        </nav>
      ) : null}
    </section>
  );
}

function Caret() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}
