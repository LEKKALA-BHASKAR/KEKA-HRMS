import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.HELPDESK_VIEW);
  return (
    <ModuleRoadmap
      title="Helpdesk"
      subtitle="Internal ticketing with category-level SLA and escalation"
      built={["Help Desk Manager is one of the eleven built-in roles, with its own permission set"]}
      next={["Categories carrying audience, category head, business hours and sub-categories",
       "SLA per priority: first-response and expected-resolution times",
       "Two-trigger escalation routing to designated employees",
       "Auto-assignment, followers, canned and closing responses",
       "Analytics on open versus closed, average resolution and first-response times"]}
      schemaTables={["roles", "role_permissions"]}
    />
  );
}
