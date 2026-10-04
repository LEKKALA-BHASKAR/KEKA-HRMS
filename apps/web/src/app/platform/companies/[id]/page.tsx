import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { MODULES } from "@keka/rbac";
import { Badge, Card } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { companyAdmins } from "@/lib/platform/tenants";
import { companyUrl } from "@/lib/tenant-host-shared";
import { addAdmin, changeCompanyStatus, resetAdminPassword, saveCompany, saveModules } from "@/app/actions/platform";
import { PlatformShell } from "../../_shell";
import { ActionForm, ModulePicker } from "../../_ui";
import s from "../../platform.module.css";

export const metadata = { title: "Company — BooS-HR Platform" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  const { id } = await params;
  const t = await prisma.tenant.findUnique({ where: { id } });
  if (!t) notFound();
  const [admins, employees, users, audit] = await Promise.all([
    companyAdmins(t.id),
    prisma.employee.count({ where: { tenantId: t.id, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] } } }),
    prisma.user.count({ where: { tenantId: t.id } }),
    prisma.platformAuditLog.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const url = companyUrl(t.subdomain);
  const enabled = MODULES.map((m) => m.key).filter((k) => !t.disabledModules.includes(k));

  return (
    <PlatformShell admin={admin}>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t.name} {t.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>}</h1>
          <div className="page-subtitle"><a href={url} target="_blank" rel="noreferrer">{url}</a> · created {when(t.createdAt)}</div>
        </div>
        <Link href="/platform" className="btn">Back to companies</Link>
      </div>

      <div className={s.stats}>
        <div className={s.stat}><div className={s.statLabel}>Active employees</div><div className={s.statValue}>{employees}{t.employeeLimit ? <span className="muted" style={{ fontSize: 15 }}> / {t.employeeLimit}</span> : null}</div></div>
        <div className={s.stat}><div className={s.statLabel}>User logins</div><div className={s.statValue}>{users}</div></div>
        <div className={s.stat}><div className={s.statLabel}>Modules on</div><div className={s.statValue}>{enabled.length} / {MODULES.length}</div></div>
        <div className={s.stat}><div className={s.statLabel}>Plan</div><div className={s.statValue} style={{ fontSize: 20 }}>{t.plan.charAt(0) + t.plan.slice(1).toLowerCase()}</div></div>
      </div>

      {!t.isActive && t.suspendedReason ? <div className={s.error} style={{ marginBottom: 18 }}>Suspended {when(t.suspendedAt)}: {t.suspendedReason}</div> : null}

      <div style={{ display: "grid", gap: 18 }}>
        <Card title="Company admins">
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table className="data">
              <thead><tr><th>Name</th><th>Email</th><th>Last sign-in</th><th>State</th><th /></tr></thead>
              <tbody>
                {admins.length === 0 ? <tr><td colSpan={5} className="muted">No Global Admin. Add one below.</td></tr> : admins.map((u) => (
                  <tr key={u.id}>
                    <td>{u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : "—"}</td>
                    <td className="mono text-xs">{u.email}</td>
                    <td className="text-xs">{when(u.lastLoginAt)}</td>
                    <td>{u.isDeactivated || u.loginDisabled ? <Badge tone="danger">Disabled</Badge> : u.mustChangePassword ? <Badge tone="warning">Temporary password</Badge> : <Badge tone="success">Active</Badge>}</td>
                    <td style={{ minWidth: 220 }}>
                      <ActionForm action={resetAdminPassword} submit="Reset password" pendingLabel="Resetting…" confirm={`Reset the password for ${u.email}? Their current sessions end.`}>
                        <input type="hidden" name="tenantId" value={t.id} />
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="url" value={url} />
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ActionForm action={addAdmin} submit="Add admin" pendingLabel="Adding…">
            <input type="hidden" name="tenantId" value={t.id} />
            <input type="hidden" name="url" value={url} />
            <div className={s.formGrid}>
              <div className="field"><label className="label" htmlFor="firstName">First name</label><input id="firstName" name="firstName" className="input" required /></div>
              <div className="field"><label className="label" htmlFor="lastName">Last name</label><input id="lastName" name="lastName" className="input" required /></div>
              <div className="field"><label className="label" htmlFor="email">Work email</label><input id="email" name="email" type="email" className="input" required /></div>
            </div>
          </ActionForm>
        </Card>

        <Card title="Modules">
          <ActionForm action={saveModules} submit="Save modules">
            <input type="hidden" name="tenantId" value={t.id} />
            <ModulePicker modules={MODULES} enabled={enabled} />
            <div className="hint" style={{ marginTop: 8 }}>Turning a module off hides it and removes its permissions. Its data is kept, so turning it back on restores everything.</div>
          </ActionForm>
        </Card>

        <Card title="Details">
          <ActionForm action={saveCompany} submit="Save details">
            <input type="hidden" name="tenantId" value={t.id} />
            <div className={s.formGrid}>
              <div className="field"><label className="label" htmlFor="name">Company name</label><input id="name" name="name" className="input" defaultValue={t.name} required /></div>
              <div className="field"><label className="label" htmlFor="plan">Plan</label>
                <select id="plan" name="plan" className="select" defaultValue={t.plan}><option value="FOUNDATION">Foundation</option><option value="STRENGTH">Strength</option><option value="GROWTH">Growth</option></select>
              </div>
              <div className="field"><label className="label" htmlFor="employeeLimit">Employee limit</label><input id="employeeLimit" name="employeeLimit" type="number" min={1} className="input" defaultValue={t.employeeLimit ?? ""} placeholder="No limit" /></div>
              <div className="field"><label className="label" htmlFor="countryCode">Country</label><input id="countryCode" name="countryCode" className="input" defaultValue={t.countryCode} maxLength={2} /></div>
              <div className="field"><label className="label" htmlFor="currency">Currency</label><input id="currency" name="currency" className="input" defaultValue={t.currency} maxLength={3} /></div>
              <div className="field"><label className="label" htmlFor="timezone">Time zone</label><input id="timezone" name="timezone" className="input" defaultValue={t.timezone} /></div>
              <div className="field"><label className="label" htmlFor="fyStartMonth">Financial year starts</label>
                <select id="fyStartMonth" name="fyStartMonth" className="select" defaultValue={String(t.fyStartMonth)}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
              </div>
              <div className="field"><label className="label" htmlFor="contactName">Contact name</label><input id="contactName" name="contactName" className="input" defaultValue={t.contactName ?? ""} /></div>
              <div className="field"><label className="label" htmlFor="contactEmail">Contact email</label><input id="contactEmail" name="contactEmail" type="email" className="input" defaultValue={t.contactEmail ?? ""} /></div>
              <div className="field"><label className="label" htmlFor="contactPhone">Contact phone</label><input id="contactPhone" name="contactPhone" className="input" defaultValue={t.contactPhone ?? ""} /></div>
            </div>
            <div className="field"><label className="label" htmlFor="platformNotes">Internal notes <span className="muted">(only the platform team sees these)</span></label><textarea id="platformNotes" name="platformNotes" className="textarea" rows={3} defaultValue={t.platformNotes ?? ""} /></div>
          </ActionForm>
        </Card>

        <Card title={t.isActive ? "Suspend company" : "Reactivate company"}>
          {t.isActive ? (
            <ActionForm action={changeCompanyStatus} submit="Suspend company" pendingLabel="Suspending…" danger confirm={`Suspend ${t.name}? Everyone in the company is signed out immediately.`}>
              <input type="hidden" name="tenantId" value={t.id} />
              <input type="hidden" name="active" value="0" />
              <div className="field"><label className="label" htmlFor="reason">Reason (shown to the company's users)</label><input id="reason" name="reason" className="input" required placeholder="Subscription payment overdue" /></div>
              <div className="hint">Nothing is deleted. Reactivating restores access straight away.</div>
            </ActionForm>
          ) : (
            <ActionForm action={changeCompanyStatus} submit="Reactivate company" pendingLabel="Reactivating…">
              <input type="hidden" name="tenantId" value={t.id} />
              <input type="hidden" name="active" value="1" />
            </ActionForm>
          )}
        </Card>

        <Card title="Recent platform activity">
          {audit.length === 0 ? <div className="muted">Nothing yet.</div> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
              <tbody>{audit.map((a) => <tr key={a.id}><td className="text-xs">{when(a.createdAt)}</td><td className="text-xs">{a.adminEmail}</td><td>{a.summary}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </PlatformShell>
  );
}
