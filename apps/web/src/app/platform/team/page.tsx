import { prisma } from "@keka/db";
import { Badge, Card } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { addPlatformAdmin, togglePlatformAdmin } from "@/app/actions/platform";
import { PlatformShell } from "../_shell";
import { ActionForm } from "../_ui";
import s from "../platform.module.css";

export const metadata = { title: "Platform team — BooS-HR Platform" };

const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");

export default async function TeamPage() {
  const admin = await requirePlatformAdmin();
  const team = await prisma.platformAdmin.findMany({ orderBy: { createdAt: "asc" } });
  return (
    <PlatformShell admin={admin}>
      <div className="page-head">
        <div className="page-title-group">
          <h1>Platform team</h1>
          <div className="page-subtitle">People who can sign in to this panel and run every company. Keep this list short.</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 18 }}>
        <Card title="Members">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Name</th><th>Email</th><th>Last sign-in</th><th>State</th><th /></tr></thead>
            <tbody>{team.map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.id === admin.id ? <span className="muted"> (you)</span> : null}</td>
                <td className="mono text-xs">{m.email}</td>
                <td className="text-xs">{when(m.lastLoginAt)}</td>
                <td>{!m.isActive ? <Badge tone="danger">Disabled</Badge> : m.mustChangePassword ? <Badge tone="warning">Temporary password</Badge> : <Badge tone="success">Active</Badge>}</td>
                <td style={{ minWidth: 160 }}>{m.id === admin.id ? null : (
                  <ActionForm action={togglePlatformAdmin} submit={m.isActive ? "Disable" : "Enable"} danger={m.isActive} confirm={m.isActive ? `Disable ${m.email}? They are signed out now.` : undefined}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="active" value={m.isActive ? "0" : "1"} />
                  </ActionForm>
                )}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
        <Card title="Add a member or reset their password">
          <ActionForm action={addPlatformAdmin} submit="Add or reset" pendingLabel="Saving…">
            <div className={s.formGrid}>
              <div className="field"><label className="label" htmlFor="name">Name</label><input id="name" name="name" className="input" required /></div>
              <div className="field"><label className="label" htmlFor="email">Email</label><input id="email" name="email" type="email" className="input" required /></div>
            </div>
            <div className="hint">An existing email gets a new temporary password. Either way the password is shown once.</div>
          </ActionForm>
        </Card>
      </div>
    </PlatformShell>
  );
}
