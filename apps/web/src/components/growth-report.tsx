import Link from "next/link";
import { Panel, EmptyState } from "@/components/keka";
import type { Report } from "@/lib/growth-reports";
import type { ActionState } from "@/lib/forms";
import { ActButton } from "@/components/growth-forms";

/** Badge tones for the shared DRAFT → SUBMITTED → APPROVED review status. */
export const STATUS_TONE: Record<string, "success" | "neutral" | "warning" | "danger" | "info"> = { APPROVED: "success", DRAFT: "neutral", SUBMITTED: "warning", REJECTED: "danger", ARCHIVED: "info" };

/** The review buttons a definition shows for its status. */
export function reviewOps(status: string, submittedByMe: boolean): Array<{ op: string; label: string; primary?: boolean; note?: boolean }> {
  if (status === "DRAFT" || status === "REJECTED") return [{ op: "submit", label: "Submit for approval", primary: true }, ...(status === "DRAFT" ? [{ op: "archive", label: "Archive" }] : [])];
  if (status === "SUBMITTED") return submittedByMe ? [{ op: "withdraw", label: "Withdraw" }] : [{ op: "approve", label: "Approve", primary: true }, { op: "reject", label: "Send back", note: true }];
  if (status === "APPROVED") return [{ op: "reopen", label: "Reopen for changes" }, { op: "archive", label: "Archive" }];
  return [{ op: "reopen", label: "Restore as draft" }];
}

export function ReviewButtons({ action, hidden, status, submittedByMe }: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>; hidden: Record<string, string>; status: string; submittedByMe: boolean;
}) {
  return (
    <span className="row gap-1 wrap">
      {reviewOps(status, submittedByMe).map((o) => (
        <ActButton key={o.op} action={action} hidden={{ ...hidden, op: o.op }} label={o.label} variant={o.primary ? "primary" : "default"} input={o.note ? { name: "note", placeholder: "What should change?", required: true } : undefined} />
      ))}
    </span>
  );
}

/** A report's tabs, its table (first 200 rows) and its CSV download. */
export function ReportView({ report, base, kinds, kind, exportHref, extra }: {
  report: Report; base: string; kinds: Record<string, string>; kind: string; exportHref: string; extra?: React.ReactNode;
}) {
  const shown = report.rows.slice(0, 200);
  return (
    <>
      <div className="tabs">
        {Object.entries(kinds).map(([k, label]) => <Link key={k} href={`${base}${base.includes("?") ? "&" : "?"}report=${k}`} className={`tab${k === kind ? " active" : ""}`}>{label}</Link>)}
      </div>
      <Panel title={report.title} subtitle={`${report.rows.length} row${report.rows.length === 1 ? "" : "s"}${report.rows.length > shown.length ? ` — showing the first ${shown.length}; the download has them all` : ""}`} action={<span className="row gap-2">{extra}<a className="btn sm" href={exportHref}>Download CSV</a></span>} pad={false}>
        {report.rows.length === 0 ? <EmptyState title="Nothing to report yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr>{report.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {shown.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === "number" ? "num" : "text-sm"}>{c === null || c === "" ? <span className="subtle">—</span> : String(c)}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
