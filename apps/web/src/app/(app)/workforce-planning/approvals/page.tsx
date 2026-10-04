import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { WorkforceApprovals } from "@/components/workforce-approvals";

export default async function PlanningApprovalsPage() {
  const viewer = await requireAuth(PERMISSIONS.WORKFORCE_PLAN_VIEW);
  return <WorkforceApprovals viewer={viewer} area="planning" title="Plan & budget approvals" exportHref="/workforce-planning/export?report=approvals" />;
}
