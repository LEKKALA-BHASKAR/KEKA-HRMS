import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.EMPLOYEE_CREATE);
  return (
    <ModuleRoadmap
      title="Add employee"
      subtitle="The four-step add-employee wizard"
      built={["Every field the wizard writes to already exists on the employee record",
       "Employee number series generate the number automatically",
       "Salary structures are selected by annual CTC range",
       "Statutory profile, bank account and identity documents are created alongside the employee"]}
      next={["Step 1 basic details, step 2 job details, step 3 work details, step 4 compensation",
       "Login invitation and onboarding flow assignment",
       "Leave plan, shift, weekly-off, expense and overtime policy assignment",
       "Bulk import from an Excel template with required fields validated"]}
      schemaTables={["employees", "employee_addresses", "employee_identities", "employee_bank_accounts", "employee_statutory_profiles", "salary_revisions"]}
    />
  );
}
