import { Card, Callout } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { platformChangePassword } from "@/app/actions/platform";
import { PlatformShell } from "../_shell";
import { ActionForm } from "../_ui";

export const metadata = { title: "My account — BooS-HR Platform" };

export default async function PlatformAccountPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const admin = await requirePlatformAdmin({ allowPasswordChange: true });
  const { required } = await searchParams;
  return (
    <PlatformShell admin={admin}>
      <h1 style={{ fontSize: 22, margin: "0 0 18px" }}>My account</h1>
      {required || admin.mustChangePassword ? (
        <div style={{ marginBottom: 16 }}><Callout tone="warning" title="Choose your own password">You signed in with a temporary password. Set a new one to continue.</Callout></div>
      ) : null}
      <div style={{ maxWidth: 460 }}>
        <Card title="Change password" description={`${admin.email} · at least 12 characters with upper- and lower-case letters, a digit and a symbol.`}>
          <ActionForm action={platformChangePassword} submit="Change password">
            <div className="field"><label className="label" htmlFor="current">Current password</label><input id="current" name="current" type="password" className="input" autoComplete="current-password" required /></div>
            <div className="field"><label className="label" htmlFor="next">New password</label><input id="next" name="next" type="password" className="input" autoComplete="new-password" required minLength={12} /></div>
            <div className="field"><label className="label" htmlFor="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" className="input" autoComplete="new-password" required /></div>
          </ActionForm>
        </Card>
      </div>
    </PlatformShell>
  );
}
