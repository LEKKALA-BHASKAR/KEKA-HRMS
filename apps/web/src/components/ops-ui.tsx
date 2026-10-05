import Link from "next/link";
import type { OpsApprovalRequest } from "@keka/db";
import { OPS_WORKFLOW_TYPES } from "@keka/services";
import { Pill, Table } from "@/components/gov-ui";
import { fmtDate } from "@/lib/governance";

/** Presentational bits shared by the ops control pages. Server components. */

export function OpsRequests({ rows, names }: { rows: OpsApprovalRequest[]; names: Map<string, string> }) {
  return (
    <Table head={["Raised", "What", "Request", "By", "Status", "Note"]} empty={rows.length === 0}>
      {rows.map((r) => (
        <tr key={r.id}>
          <td className="nowrap text-sm">{fmtDate(r.createdAt)}</td>
          <td className="text-sm">{OPS_WORKFLOW_TYPES[r.kind as keyof typeof OPS_WORKFLOW_TYPES] ?? r.kind}</td>
          <td className="text-sm">{r.targetLabel}{r.effectiveFrom ? <div className="text-xs subtle">effective {fmtDate(r.effectiveFrom)}</div> : null}</td>
          <td className="text-sm">{names.get(r.requestedBy) ?? "—"}</td>
          <td><Pill s={r.status} />{r.workflowRequestId && r.status === "PENDING" ? <div className="text-xs"><Link href="/inbox?cat=workflows">In approvals</Link></div> : null}</td>
          <td className="text-xs">{r.error ?? r.reason ?? ""}</td>
        </tr>
      ))}
    </Table>
  );
}

export const monthOptions = () => Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(Date.UTC(2000, i, 1)).toLocaleString("en-IN", { month: "long", timeZone: "UTC" }) }));
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
