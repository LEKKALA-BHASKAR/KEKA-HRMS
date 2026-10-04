import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { CHANGE_TARGETS, CHANGE_CATEGORIES, diffChanges, fieldLabel } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { decidableChangeRequests, visibleChangeRequestWhere, displayChangeValue } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { DecideForm, ActionButton } from "@/components/spec-form";
import { decideChangeRequestAction, withdrawChangeRequestAction } from "@/app/actions/core-hr-depth";

export const metadata = { title: "Change requests — BooS-HR" };

const CAT_LABEL: Record<string, string> = { CONFIG: "Settings", ORG: "Org structure", PROFILE: "Employee profile", CORRECTION: "Data correction" };
const STATUSES = ["PENDING", "SCHEDULED", "APPLIED", "REJECTED", "WITHDRAWN", "FAILED"] as const;
const TONE: Record<string, "success" | "brand" | "danger" | "neutral" | "warning"> = { APPLIED: "success", PENDING: "warning", SCHEDULED: "brand", REJECTED: "danger", FAILED: "danger", WITHDRAWN: "neutral" };

type Row = { id: string; category: string; targetType: string; title: string; changes: Prisma.JsonValue; previous: Prisma.JsonValue; reason: string | null; effectiveDate: Date | null; operation: string; employeeId: string | null };

/**
 * One queue for every change that waits for someone's approval: settings
 * (maker-checker), org changes, employees' profile change requests and data
 * corrections. Shows what changes, old → new, and lets the right person decide.
 */
export default async function ChangeRequestsPage({ searchParams }: { searchParams: Promise<{ category?: string; status?: string; q?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const category = (CHANGE_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? sp.category! : "";
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : "";
  const q = (sp.q ?? "").trim().slice(0, 60);
  const visible = await visibleChangeRequestWhere(viewer);
  const [toDecide, history] = await Promise.all([
    decidableChangeRequests(viewer, { take: 100 }),
    prisma.recordChangeRequest.findMany({
      where: { AND: [visible, category ? { category } : {}, status ? { status: status as never } : {}, q ? { title: { contains: q, mode: "insensitive" } } : {}] },
      orderBy: { createdAt: "desc" }, take: 200,
    }),
  ]);
  const queue = toDecide.filter((r) => !category || r.category === category);
  const ids = [...new Set([...history, ...queue].flatMap((r) => [r.employeeId, r.requestedByEmployeeId]).filter((x): x is string => !!x))];
  const users = [...new Set([...history, ...queue].flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const [people, accounts] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids } }, select: { id: true, displayName: true, employeeNumber: true } }),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { in: users } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }),
  ]);
  const person = new Map(people.map((p) => [p.id, `${p.displayName} (${p.employeeNumber})`]));
  const user = new Map(accounts.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const exportHref = `/exports/core-hr/change-requests?${new URLSearchParams({ ...(category ? { category } : {}), ...(status ? { status } : {}) })}`;

  return (
    <>
      <PageHead title="Change requests" subtitle="Settings, org structure, profile changes and data corrections waiting for approval"
        actions={<Link className="btn" href={exportHref}>Export CSV</Link>} />
      <form method="get" className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <select className="select" name="category" defaultValue={category} style={{ maxWidth: 200 }}>
          <option value="">Every kind</option>
          {CHANGE_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
        </select>
        <select className="select" name="status" defaultValue={status} style={{ maxWidth: 180 }}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
        <input className="input" name="q" defaultValue={q} placeholder="Search titles" style={{ maxWidth: 240 }} />
        <button className="btn sm" type="submit">Filter</button>
        {category || status || q ? <Link className="btn ghost sm" href="/admin/change-requests">Clear</Link> : null}
      </form>

      <Card title={`Waiting for you (${queue.length})`} description="You can decide these: they are in your area, or the person is on your team. You never decide your own." tight>
        {queue.length === 0 ? <Empty title="Nothing to decide" /> : (
          <div className="stack">
            {queue.map((r) => (
              <div key={r.id} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
                <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="strong">{r.title}</div>
                    <div className="text-xs muted">{CAT_LABEL[r.category] ?? r.category} · {CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType}
                      {r.employeeId ? <> · for <Link href={`/employees/${r.employeeId}`}>{person.get(r.employeeId) ?? "employee"}</Link></> : null}
                      {" "}· raised by {user.get(r.requestedBy) ?? "someone"} on {formatDate(r.createdAt)}
                      {r.effectiveDate ? ` · effective ${formatDate(r.effectiveDate)}` : ""}
                      {r.approverType === "MANAGER" ? " · manager approval" : " · HR approval"}</div>
                  </div>
                </div>
                <Diff r={r} />
                {r.reason ? <div className="text-sm" style={{ margin: "6px 0" }}><span className="muted">Reason:</span> {r.reason}</div> : null}
                <DecideForm action={decideChangeRequestAction} hidden={{ id: r.id }} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ height: 16 }} />
      <Card title="All requests you can see" description="Your own, and those in your area." tight>
        {history.length === 0 ? <Empty title="No change requests match" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Request</th><th>Kind</th><th>For</th><th>Raised</th><th>Effective</th><th>Status</th><th>Decided</th><th /></tr></thead>
            <tbody>{history.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.title}{r.reason ? <div className="text-xs muted">{r.reason}</div> : null}</td>
                <td className="text-sm">{CAT_LABEL[r.category] ?? r.category}</td>
                <td className="text-sm">{r.employeeId ? <Link href={`/employees/${r.employeeId}`}>{person.get(r.employeeId) ?? "—"}</Link> : "—"}</td>
                <td className="text-sm">{formatDate(r.createdAt)}<div className="text-xs muted">{user.get(r.requestedBy) ?? ""}</div></td>
                <td className="text-sm">{r.effectiveDate ? formatDate(r.effectiveDate) : "On approval"}</td>
                <td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge>{r.error ? <div className="text-xs" style={{ color: "var(--danger)" }}>{r.error}</div> : null}</td>
                <td className="text-sm">{r.decidedAt ? <>{formatDate(r.decidedAt)}<div className="text-xs muted">{user.get(r.decidedBy ?? "") ?? ""}{r.decisionNote ? ` — ${r.decisionNote}` : ""}</div></> : "—"}</td>
                <td className="right">{r.requestedBy === viewer.user.id && (r.status === "PENDING" || r.status === "SCHEDULED") ? <ActionButton action={withdrawChangeRequestAction} hidden={{ id: r.id }} label="Withdraw" /> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function Diff({ r }: { r: Row }) {
  if (r.operation === "DELETE") return <div className="text-sm" style={{ margin: "8px 0" }}><Badge tone="danger">Remove / retire</Badge></div>;
  const rows = diffChanges((r.previous ?? null) as Record<string, unknown> | null, (r.changes ?? {}) as Record<string, unknown>);
  if (rows.length === 0) return null;
  return (
    <table className="data" style={{ margin: "8px 0", maxWidth: 720 }}>
      <thead><tr><th>Field</th><th>Now</th><th>Becomes</th></tr></thead>
      <tbody>{rows.map((d) => (
        <tr key={d.field}><td className="text-sm">{fieldLabel(d.field)}</td><td className="text-sm muted">{displayChangeValue(d.field, d.from)}</td><td className="text-sm strong">{displayChangeValue(d.field, d.to)}</td></tr>
      ))}</tbody>
    </table>
  );
}
