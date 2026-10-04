import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { WorkforceApprovals } from "@/components/workforce-approvals";

export default async function ContingentApprovalsPage() {
  const viewer = await requireAuth(PERMISSIONS.CONTINGENT_VIEW);
  return <WorkforceApprovals viewer={viewer} area="contingent" title="Contingent workforce approvals" exportHref="/contingent/export?report=approvals" />;
}
