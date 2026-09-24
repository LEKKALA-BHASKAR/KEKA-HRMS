import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.ASSET_VIEW);
  return (
    <ModuleRoadmap
      title="Assets"
      subtitle="Categories, assignment, acknowledgement and damage recovery"
      built={["Asset damage recovery is a seeded ad-hoc deduction component",
       "Recovery flows into the full-and-final settlement as a deduction line",
       "Asset Manager is one of the eleven built-in roles"]}
      next={["Asset categories, types and a configurable asset ID series",
       "Assignment, acknowledgement and condition tracking",
       "Employee-raised asset requests",
       "Damage charge capture that posts to the settlement"]}
      schemaTables={["salary_components", "fnf_settlements", "adhoc_transactions"]}
    />
  );
}
