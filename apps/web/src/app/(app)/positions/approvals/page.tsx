import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { WorkforceApprovals } from "@/components/workforce-approvals";

export default async function PositionApprovalsPage() {
  const viewer = await requireAuth(PERMISSIONS.POSITION_VIEW);
  return <WorkforceApprovals viewer={viewer} area="positions" title="Position & job approvals" exportHref="/positions/export?report=approvals" />;
}
