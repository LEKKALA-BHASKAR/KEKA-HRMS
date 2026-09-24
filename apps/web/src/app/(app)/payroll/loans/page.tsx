import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.LOAN_MANAGE);
  return (
    <ModuleRoadmap
      title="Loans & advances"
      subtitle="Categories, policies, approval chains and EMI recovery"
      built={["Two loan categories and a standard policy seeded, with concessional tracking against the SBI benchmark rate",
       "Policy eligibility on probation completion, days from joining, salary range and notice status",
       "Flat and reducing interest, EMI caps, and limits as an amount or a percentage of salary",
       "A live loan with a full twenty-four month schedule",
       "EMIs are deducted by the payroll run and marked consumed on finalise, then released on rollback"]}
      next={["The loan application form and the role-based approval chain with auto-approve after N days",
       "EMI skip for a month, and foreclosure",
       "Outstanding balance and loan status reports",
       "Perquisite valuation on concessional loans"]}
      schemaTables={["loan_categories", "loan_policies", "loan_policy_rules", "loans", "loan_installments"]}
    />
  );
}
