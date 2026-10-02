"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import { bulkTicketAction } from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import { MultiSelect, SearchIcon, Dropdown, useQueryPatch, type MultiOption } from "./controls";
import { PriorityPill, StatusPill, Initials } from "./bits";
import { day, ago } from "./format";
import s from "./hd.module.css";

export interface QueueRow {
  id: string; number: number; subject: string; category: string; raisedBy: string; employeeNumber: string; photoUrl: string | null;
  createdAt: string; closedAt: string | null; priority: string; status: string; assignee: string | null;
  missedFirstResponse: boolean; missedResolution: boolean; overdue: boolean; dueAt: string; closingReason: string | null;
}

const PRIORITIES: MultiOption[] = [{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }, { value: "NA", label: "NA" }];
const STATUSES: MultiOption[] = [{ value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In Progress" }, { value: "ON_HOLD", label: "On Hold" }];
const ESCALATIONS: MultiOption[] = [
  { value: "RESOLUTION", label: "Overdue (missed resolution time)" },
  { value: "FIRST_RESPONSE", label: "Missed first response time" },
  { value: "NONE", label: "Not escalated" },
];

/**
 * The ticket table with its filter bar and bulk actions. Filters live in the
 * URL, so a filtered queue can be bookmarked and the pager keeps them.
 */
export function TicketQueue({ tab, rows, total, filters, options, bulk, pager }: {
  tab: "open" | "closed"; rows: QueueRow[]; total: number;
  filters: { cat: string[]; priority: string[]; status: string[]; assignee: string[]; esc: string[]; reason: string[]; q: string };
  options: { categories: MultiOption[]; assignees: MultiOption[]; reasons: MultiOption[] };
  bulk: { categories: MultiOption[]; reasons: MultiOption[] };
  pager: ReactNode;
}) {
  const patch = useQueryPatch();
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [rows]);
  const apply = (key: string) => (v: string[]) => patch({ [key]: v }, ["page", ...(key === "esc" ? ["overdue"] : [])]);
  const any = filters.cat.length + filters.priority.length + filters.status.length + filters.assignee.length + filters.esc.length + filters.reason.length > 0 || !!filters.q;
  const allOnPage = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  return (
    <>
      <div className={s.filters} role="search">
        <MultiSelect label="Category" options={options.categories} value={filters.cat} onApply={apply("cat")} />
        <MultiSelect label="Priority" options={PRIORITIES} value={filters.priority} onApply={apply("priority")} />
        {tab === "open"
          ? <MultiSelect label="Status" options={STATUSES} value={filters.status} onApply={apply("status")} />
          : <MultiSelect label="Closing reason" options={options.reasons} value={filters.reason} onApply={apply("reason")} />}
        <MultiSelect label="Assigned to" options={options.assignees} value={filters.assignee} onApply={apply("assignee")} />
        <MultiSelect label="Escalation" options={ESCALATIONS} value={filters.esc} onApply={apply("esc")} />
        <div className={s.filterSearch} style={{ gridColumn: "span 2" }}>
          <SearchIcon />
          <form style={{ width: "100%" }} onSubmit={(e) => { e.preventDefault(); patch({ q: q.trim() }, ["page"]); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by ticket number, title or employee" aria-label="Search tickets"
              onBlur={() => q.trim() !== filters.q && patch({ q: q.trim() }, ["page"])} />
          </form>
        </div>
        <div className={s.filterClear}>
          <button type="button" className={s.iconBtn} title="Clear filters" aria-label="Clear filters" disabled={!any}
            onClick={() => patch({ cat: null, priority: null, status: null, assignee: null, esc: null, reason: null, q: null, overdue: null }, ["page"])}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>

      <div className={s.panel}>
        <div className={s.bulkBar}>
          {tab === "open" ? <BulkActions ids={selected} bulk={bulk} /> : <span className="text-sm muted">Closed tickets can be reopened from the ticket.</span>}
          <span className={s.total}>{selected.length ? `${selected.length} selected · ` : ""}{total} ticket{total === 1 ? "" : "s"}</span>
        </div>
        {rows.length === 0 ? (
          <div className={s.empty}>{any ? "No tickets match these filters." : tab === "open" ? "No open tickets. Nice work." : "No closed tickets yet."}</div>
        ) : (
          <div className="table-wrap">
            <table className={s.table}>
              <thead>
                <tr>
                  {tab === "open" ? (
                    <th className={s.check}><input type="checkbox" aria-label="Select all on this page" checked={allOnPage}
                      onChange={() => setSelected(allOnPage ? [] : rows.map((r) => r.id))} /></th>
                  ) : null}
                  <th>Ticket</th><th>Raised by</th><th>Raised on</th><th>Priority</th><th>Status</th><th>Assigned to</th>
                  {tab === "open" ? <th>Escalation</th> : <><th>Closed on</th><th>Closing reason</th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {tab === "open" ? (
                      <td className={s.check}><input type="checkbox" aria-label={`Select ticket #${r.number}`} checked={selected.includes(r.id)}
                        onChange={() => setSelected((xs) => (xs.includes(r.id) ? xs.filter((x) => x !== r.id) : [...xs, r.id]))} /></td>
                    ) : null}
                    <td className={s.titleCell}>
                      <Link href={`/helpdesk/tickets/${r.id}`} className={s.link}>#{r.number} {r.subject}</Link>
                      <div className={s.sub}>{r.category}</div>
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <Initials name={r.raisedBy} size={28} photoUrl={r.photoUrl} />
                        <span><span style={{ display: "block" }}>{r.raisedBy}</span><span className={s.sub}>{r.employeeNumber}</span></span>
                      </span>
                    </td>
                    <td className={s.nowrap} title={ago(r.createdAt)}>{day(r.createdAt)}</td>
                    <td><PriorityPill p={r.priority} /></td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{r.assignee ?? <span className={s.subtle}>Not assigned</span>}</td>
                    {tab === "open" ? (
                      <td className={s.nowrap}>
                        {r.missedResolution || r.overdue ? <span className={s.escalated}>Missed resolution time</span>
                          : r.missedFirstResponse ? <span className={s.escalated}>Missed first response time</span>
                            : <span className={s.notEscalated}>Not escalated</span>}
                      </td>
                    ) : (
                      <>
                        <td className={s.nowrap}>{day(r.closedAt)}</td>
                        <td>{r.closingReason ?? <span className={s.subtle}>—</span>}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pager}
      </div>
    </>
  );
}

function BulkActions({ ids, bulk }: { ids: string[]; bulk: { categories: MultiOption[]; reasons: MultiOption[] } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(bulkTicketAction, {});
  const none = ids.length === 0;
  const hidden = ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Dropdown boxed button={<span>Close tickets</span>}>
        {(close) => (
          <form action={(f) => { action(f); close(); }} style={{ padding: "4px 14px", display: "grid", gap: 10, minWidth: 260 }}>
            {hidden}
            <input type="hidden" name="op" value="close" />
            <div className="text-sm">{none ? "Select tickets in the table first." : `Close ${ids.length} ticket${ids.length === 1 ? "" : "s"}`}</div>
            {bulk.reasons.length ? (
              <select name="closingReasonId" className="select" defaultValue="" aria-label="Closing reason" required>
                <option value="">Closing reason…</option>
                {bulk.reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            ) : null}
            <button type="submit" className="btn primary sm" disabled={none || pending}>Close</button>
          </form>
        )}
      </Dropdown>
      <Dropdown boxed button={<span>Change category</span>}>
        {(close) => (
          <form action={(f) => { action(f); close(); }} style={{ padding: "4px 14px", display: "grid", gap: 10, minWidth: 280 }}>
            {hidden}
            <input type="hidden" name="op" value="category" />
            <div className="text-sm">{none ? "Select tickets in the table first." : `Move ${ids.length} ticket${ids.length === 1 ? "" : "s"} to`}</div>
            <select name="categoryId" className="select" defaultValue="" aria-label="Category" required>
              <option value="">Category…</option>
              {bulk.categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <button type="submit" className="btn primary sm" disabled={none || pending}>Move</button>
          </form>
        )}
      </Dropdown>
      {pending ? <span className="text-sm muted">Working…</span> : state.message ? <span className="text-sm" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</span> : null}
    </span>
  );
}
