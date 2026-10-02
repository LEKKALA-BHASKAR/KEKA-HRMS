import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { AUDIT_MODULES, AUDIT_ACTIONS, auditWhere, auditQuery, type AuditFilters } from "./filters";

const P = PERMISSIONS;
const PAGE_SIZE = 50;

const MODULE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral" | "brand"> = {
  PAYROLL: "brand", EMPLOYEE: "info", LEAVE: "neutral",
  ATTENDANCE: "neutral", ROLE: "warning", AUTH: "neutral", FINANCE: "danger",
};

export default async function AuditPage({
  searchParams,
}: { searchParams: Promise<AuditFilters & { page?: string }> }) {
  const viewer = await requireAuth(P.AUDIT_LOG_VIEW);
  const { page: rawPage, ...filters } = await searchParams;
  const sp = filters;
  const page = Math.max(1, Number(rawPage ?? 1));
  const where = auditWhere(viewer.tenantId, filters);
  const filtered = !!(sp.module || sp.action || sp.from || sp.to || sp.q);

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <DashboardTabs viewer={viewer} active="audit" />
      <PageHead
        title="Audit logs"
        subtitle={`${total} entries · who, when, what, and the old and new values`}
        actions={<a className="btn" href={`/admin/audit/export?${auditQuery(filters)}`}>Download CSV</a>}
      />

      <Callout tone="info" title="Coverage">
        This log covers employee, payroll, leave and attendance changes, plus role and
        authentication events. Retention for generated reports is three months; the
        queryable window runs to about eighteen months.
      </Callout>

      <div style={{ height: 14 }} />

      <Card tight>
        <form className="row gap-2 wrap" style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
          <select className="select" name="module" defaultValue={sp.module ?? ""} style={{ maxWidth: 180 }}>
            <option value="">All modules</option>
            {AUDIT_MODULES.map((m) => (
              <option key={m} value={m}>{m.toLowerCase()}</option>
            ))}
          </select>
          <select className="select" name="action" defaultValue={sp.action ?? ""} style={{ maxWidth: 180 }}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{a.toLowerCase()}</option>
            ))}
          </select>
          <input className="input" type="date" name="from" defaultValue={sp.from ?? ""} aria-label="From" style={{ maxWidth: 160 }} />
          <input className="input" type="date" name="to" defaultValue={sp.to ?? ""} aria-label="To" style={{ maxWidth: 160 }} />
          <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Search summary or actor" style={{ maxWidth: 220 }} />
          <button className="btn" type="submit">Filter</button>
          {filtered ? <Link className="btn ghost" href="/admin/audit">Clear</Link> : null}
        </form>

        {logs.length === 0 ? (
          <Empty title="No audit entries match" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Module</th><th>Action</th><th>Entity</th><th>Summary</th><th>Actor</th></tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap text-sm">
                      {l.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td><Badge tone={MODULE_TONE[l.module] ?? "neutral"}>{l.module.toLowerCase()}</Badge></td>
                    <td className="text-sm">{l.action.toLowerCase()}</td>
                    <td className="text-sm muted">{l.entityType}</td>
                    <td className="text-sm">{l.summary ?? "—"}</td>
                    <td className="text-sm muted">{l.actorLabel ?? "system"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="card-foot row gap-2" style={{ justifyContent: "space-between" }}>
            <span className="text-sm muted">Page {page} of {totalPages}</span>
            <div className="row gap-2">
              {page > 1 ? <Link className="btn sm" href={`/admin/audit?${auditQuery(filters, { page: page - 1 })}`}>Previous</Link> : null}
              {page < totalPages ? <Link className="btn sm" href={`/admin/audit?${auditQuery(filters, { page: page + 1 })}`}>Next</Link> : null}
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
