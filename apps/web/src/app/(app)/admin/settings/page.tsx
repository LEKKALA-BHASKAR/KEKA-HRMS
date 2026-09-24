import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.ORG_SETTINGS_MANAGE);
  return (
    <ModuleRoadmap
      title="Settings"
      subtitle="Tenant, authentication and notification configuration"
      built={["Tenant record with subdomain, plan tier, currency, timezone and financial-year start",
       "Org-wide visibility settings implementing the documented privilege-UNION-visibility rule",
       "Session handling with signed, httpOnly, eight-hour tokens",
       "Login disable, account deactivation and exit modelled as three distinct states"]}
      next={["Authentication method toggles for password, mobile OTP, Microsoft and Google",
       "OIDC single sign-on configuration",
       "Two-factor enforcement and session timeout controls",
       "Email, Slack and webhook event triggers"]}
      schemaTables={["tenants", "tenant_visibility_settings", "users", "sessions", "otp_challenges"]}
    />
  );
}
