import Link from "next/link";
import { Badge } from "@/components/ui";
import { WithdrawRequestButton } from "../../../_time/attendance-forms";
import { REQUEST_LABEL, dateLabel } from "../_lib";
import { Tm } from "./hours";
import s from "../attendance.module.css";

export interface RequestRow {
  id: string;
  type: string;
  status: string;
  from: Date;
  to: Date;
  /** Minutes after local midnight, for adjustments. */
  inMin: number | null;
  outMin: number | null;
  partialMinutes: number | null;
  reason: string;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

const TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  APPROVED: "success", REJECTED: "danger", PENDING: "warning", CANCELLED: "neutral",
};

/** The viewer's own attendance requests, filterable by type. */
export function RequestsPanel({
  rows, counts, active, filterHref, newHref,
}: {
  rows: RequestRow[];
  counts: Record<string, number>;
  active: string | null;
  filterHref: (type: string | null) => string;
  newHref: string;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <section className={s.panel} aria-label="Attendance requests">
      <div className={s.panelHead}>
        <nav className={s.filters} aria-label="Request type">
          <Link href={filterHref(null)} scroll={false} className={`${s.filter}${!active ? ` ${s.filterActive}` : ""}`} aria-current={!active ? "true" : undefined}>
            All ({total})
          </Link>
          {Object.entries(REQUEST_LABEL).map(([type, label]) => (
            <Link key={type} href={filterHref(type)} scroll={false}
              className={`${s.filter}${active === type ? ` ${s.filterActive}` : ""}`} aria-current={active === type ? "true" : undefined}>
              {label} ({counts[type] ?? 0})
            </Link>
          ))}
        </nav>
        <Link href={newHref} scroll={false} className="btn primary sm">New request</Link>
      </div>
      {rows.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>No attendance requests{active ? ` of this type` : ""}</div>
          <div>Adjustments, regularisations, partial days, work from home and on-duty requests you raise appear here.</div>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table} style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Dates</th>
                <th scope="col">Details</th>
                <th scope="col">Reason</th>
                <th scope="col">Status</th>
                <th scope="col">Requested on</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sameDay = r.from.getTime() === r.to.getTime();
                const days = Math.round((r.to.getTime() - r.from.getTime()) / 86_400_000) + 1;
                return (
                  <tr key={r.id}>
                    <th scope="row">{REQUEST_LABEL[r.type] ?? r.type}</th>
                    <td className={s.num}>
                      {dateLabel(r.from)}{sameDay ? "" : ` – ${dateLabel(r.to)}`}
                      <div className={s.sub}>{days} day{days === 1 ? "" : "s"}</div>
                    </td>
                    <td className={s.num}>
                      {r.inMin !== null && r.outMin !== null ? <><Tm m={r.inMin} /> – <Tm m={r.outMin} /></>
                        : r.partialMinutes ? `${r.partialMinutes} min away` : <span className="subtle">—</span>}
                    </td>
                    <td style={{ maxWidth: 260 }}>{r.reason}</td>
                    <td>
                      <Badge tone={TONE[r.status] ?? "neutral"}>{r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Badge>
                      {r.decidedBy || r.decidedAt ? (
                        <div className={s.sub}>{r.decidedBy ? `by ${r.decidedBy}` : ""}{r.decidedAt ? ` · ${dateLabel(r.decidedAt)}` : ""}</div>
                      ) : null}
                      {r.decisionNote ? <div className={s.sub}>“{r.decisionNote}”</div> : null}
                    </td>
                    <td className={s.num}>{dateLabel(r.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>{r.status === "PENDING" ? <WithdrawRequestButton requestId={r.id} /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
