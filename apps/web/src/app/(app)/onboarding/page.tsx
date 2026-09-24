import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.ONBOARDING_VIEW);
  return (
    <ModuleRoadmap
      title="Onboarding"
      subtitle="Preboarding, onboarding tasks and probation confirmation"
      built={["Employee status lifecycle: preboarding, onboarding, probation, confirmed",
       "Job history is effective-dated, so a confirmation is recorded as a dated change",
       "Employee number series generate numbers on creation",
       "Custom field definitions can be turned into profile-field tasks"]}
      next={["Task templates with an Applies-To engine triggering on department, location and worker type",
       "Dependent tasks, where one task gates another",
       "Candidate experience portal for offer acceptance and document collection",
       "New joiners and onboarding-task dashboards",
       "Probation policies with evaluation workflows, Any-vs-All completion and auto-approval"]}
      schemaTables={["employees", "employee_job_records", "custom_field_definitions", "employee_number_series"]}
    />
  );
}
