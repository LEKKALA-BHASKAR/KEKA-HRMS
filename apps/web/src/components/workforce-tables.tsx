import type { ReactNode } from "react";
import { formatDate } from "@keka/shared";
import type { Permission } from "@keka/rbac";
import { REQUEST_KINDS } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { Badge, Empty } from "@/components/ui";
import { DecisionForm, WithdrawButton } from "@/components/workforce-ui";

/** Server-rendered tables shared by the workforce pages. */

const TONE: Record<string, "warning" | "success" | "danger" | "neutral" | "info" | "brand"> = {
  PENDING: "warning", PENDING_APPROVAL: "warning", APPROVED: "success", ACTIVE: "success", VERIFIED: "success", GRANTED: "success", FILLED: "success",
  REJECTED: "danger", EXPIRED: "danger", SUSPENDED: "danger", WITHDRAWN: "neutral", RETIRED: "neutral", CLOSED: "neutral", ENDED: "neutral", REVOKED: "neutral", INACTIVE: "neutral",
  DRAFT: "info", PROPOSED: "warning", VACANT: "info", FROZEN: "brand", ONBOARDING: "info", CONVERTED: "brand", SUBMITTED: "warning", PAID: "success", COMPLETED: "info",
};

export function StatusPill({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? "neutral"} dot>{status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge>;
}

interface Req { id: string; kind: string; label: string; status: string; reason: string | null; requestedBy: string; requestedAt: Date; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; payload: unknown }

function payloadText(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  return Object.entries(p as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : String(v)}`)
    .join(" · ");
}

/** Requests with their decisions; pending ones carry approve/reject (or withdraw for the requester). */
export function RequestsTable({ rows, viewer, users, empty = "No requests." }: { rows: Req[]; viewer: Viewer; users: Map<string, string>; empty?: string }) {
  if (rows.length === 0) return <Empty title={empty} />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Request</th><th>Record</th><th>Requested</th><th>Status</th><th>Decision</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => {
            const def = REQUEST_KINDS[r.kind];
            const mine = r.requestedBy === viewer.user.id;
            const mayDecide = r.status === "PENDING" && !mine && !!def && can(viewer, def.permission as Permission);
            return (
              <tr key={r.id}>
                <td>{def?.label ?? r.kind}{r.reason ? <div className="text-xs muted">{r.reason}</div> : null}{payloadText(r.payload) ? <div className="text-xs muted">{payloadText(r.payload)}</div> : null}</td>
                <td>{r.label}</td>
                <td className="text-xs">{users.get(r.requestedBy) ?? "—"}<div className="muted">{formatDate(r.requestedAt)}</div></td>
                <td><StatusPill status={r.status} /></td>
                <td className="text-xs">{r.decidedBy ? <>{users.get(r.decidedBy) ?? "—"} · {formatDate(r.decidedAt)}</> : null}{r.decisionNote ? <div className="muted">{r.decisionNote}</div> : null}</td>
                <td>{mayDecide ? <DecisionForm id={r.id} /> : r.status === "PENDING" && mine ? <WithdrawButton id={r.id} /> : r.status === "PENDING" ? <span className="text-xs muted">Waiting on an approver</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface AuditRow { id: string; createdAt: Date; action: string; summary: string | null; actorLabel: string | null }

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <Empty title="Nothing recorded yet." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>When</th><th>Action</th><th>What</th><th>By</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}><td className="text-xs">{a.createdAt.toISOString().replace("T", " ").slice(0, 16)}</td><td><Badge>{a.action}</Badge></td><td className="text-sm">{a.summary}</td><td className="text-xs">{a.actorLabel ?? "system"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A GET filter bar: inputs submit as query params to the same page. */
export function FilterBar({ children, action }: { children: ReactNode; action: string }) {
  return (
    <form method="get" action={action} className="row gap-2 wrap" style={{ alignItems: "flex-end", marginBottom: 14 }}>
      {children}
      <button className="btn sm" type="submit">Search</button>
    </form>
  );
}

export const inr = (n: unknown) => (n === null || n === undefined ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
