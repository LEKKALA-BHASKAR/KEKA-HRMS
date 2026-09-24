import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.EXIT_MANAGE);
  return (
    <ModuleRoadmap
      title="Exits & settlements"
      subtitle="Exit initiation, clearance and full-and-final settlement"
      built={["Exit record schema with reason, notice date, last working day and rehire eligibility",
       "Notice period policies with buyout basis, seeded for standard and leadership terms",
       "Full-and-final settlement across all six documented payable groups",
       "Gratuity, leave encashment and notice buyout calculators, all unit-tested",
       "Payroll step 2 surfaces pending settlements and blocks the step until they are complete"]}
      next={["Exit initiation form and the approval workflow",
       "Exit task lists per employee group, covering asset return and clearance",
       "The settlement review screen with one-time and periodic-partial modes",
       "Exit survey with downloadable responses",
       "Backfill requisition raised from exit approval"]}
      schemaTables={["exit_records", "fnf_settlements", "notice_period_policies", "arrears"]}
    />
  );
}
