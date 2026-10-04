import Link from "next/link";
import { prisma } from "@keka/db";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { PlatformShell } from "../_shell";

export const metadata = { title: "Activity — BooS-HR Platform" };

const when = (d: Date) => d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function AuditPage() {
  const admin = await requirePlatformAdmin();
  const rows = await prisma.platformAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 300, include: { tenant: { select: { name: true } } } });
  return (
    <PlatformShell admin={admin}>
      <div className="page-head">
        <div className="page-title-group">
          <h1>Activity</h1>
          <div className="page-subtitle">Every sign-in and change made in this panel, newest first (latest 300).</div>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>When</th><th>Who</th><th>Company</th><th>What</th></tr></thead>
          <tbody>{rows.length === 0 ? <tr><td colSpan={4} className="muted">Nothing yet.</td></tr> : rows.map((a) => (
            <tr key={a.id}>
              <td className="text-xs" style={{ whiteSpace: "nowrap" }}>{when(a.createdAt)}</td>
              <td className="text-xs">{a.adminEmail}</td>
              <td>{a.tenant && a.tenantId ? <Link href={`/platform/companies/${a.tenantId}`}>{a.tenant.name}</Link> : <span className="muted">—</span>}</td>
              <td>{a.summary}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </PlatformShell>
  );
}
