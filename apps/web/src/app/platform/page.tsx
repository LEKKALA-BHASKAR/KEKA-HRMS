import Link from "next/link";
import { Badge } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { companySummaries } from "@/lib/platform/tenants";
import { companyUrl } from "@/lib/tenant-host-shared";
import { MODULES } from "@keka/rbac";
import { PlatformShell } from "./_shell";
import s from "./platform.module.css";

export const metadata = { title: "Companies — BooS-HR Platform" };

const date = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "Never");

export default async function PlatformHome({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const admin = await requirePlatformAdmin();
  const { q = "", status = "all" } = await searchParams;
  const all = await companySummaries();
  const needle = q.trim().toLowerCase();
  const rows = all.filter((t) =>
    (status === "all" || (status === "active" ? t.isActive : !t.isActive)) &&
    (!needle || t.name.toLowerCase().includes(needle) || t.subdomain.includes(needle) || (t.contactEmail ?? "").includes(needle)));
  const active = all.filter((t) => t.isActive);
  return (
    <PlatformShell admin={admin}>
      <div className="page-head">
        <div className="page-title-group">
          <h1>Companies</h1>
          <div className="page-subtitle">Every company on BooS-HR. Open one to change its plan, modules, admins or status.</div>
        </div>
        <Link href="/platform/companies/new" className="btn primary">Onboard a company</Link>
      </div>

      <div className={s.stats}>
        <div className={s.stat}><div className={s.statLabel}>Companies</div><div className={s.statValue}>{all.length}</div></div>
        <div className={s.stat}><div className={s.statLabel}>Active</div><div className={s.statValue}>{active.length}</div></div>
        <div className={s.stat}><div className={s.statLabel}>Suspended</div><div className={s.statValue}>{all.length - active.length}</div></div>
        <div className={s.stat}><div className={s.statLabel}>Employees</div><div className={s.statValue}>{active.reduce((n, t) => n + t.activeEmployees, 0)}</div></div>
      </div>

      <div className="card">
        <form className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <input name="q" defaultValue={q} className="input" placeholder="Search by name, subdomain or contact" style={{ maxWidth: 320 }} />
          <select name="status" defaultValue={status} className="select" style={{ maxWidth: 160 }}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <button className="btn" type="submit">Filter</button>
        </form>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Company</th><th>Address</th><th>Plan</th><th>Modules</th><th className="num">Employees</th><th>Last sign-in</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="muted" style={{ padding: 24, textAlign: "center" }}>{all.length ? "No company matches." : "No companies yet. Onboard the first one."}</td></tr>
              ) : rows.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/platform/companies/${t.id}`} style={{ fontWeight: 600 }}>{t.name}</Link><div className="muted text-xs">{t.contactEmail ?? ""}</div></td>
                  <td><a href={companyUrl(t.subdomain)} target="_blank" rel="noreferrer" className="mono text-xs">{t.subdomain}</a></td>
                  <td>{t.plan.charAt(0) + t.plan.slice(1).toLowerCase()}</td>
                  <td className="text-xs">{MODULES.length - t.disabledModules.length} of {MODULES.length}</td>
                  <td className="num">{t.activeEmployees}{t.employeeLimit ? <span className="muted"> / {t.employeeLimit}</span> : null}</td>
                  <td className="text-xs">{date(t.lastLoginAt)}</td>
                  <td>{t.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </PlatformShell>
  );
}
