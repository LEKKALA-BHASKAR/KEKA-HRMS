import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.REPORT_VIEW);
  return (
    <ModuleRoadmap
      title="Reports"
      subtitle="Payroll, statutory and people reporting"
      built={["Pay register with a CSV export that includes every component column plus a totals row",
       "Payroll run reports: component comparison, cost breakdown, arrears and statutory reconciliation",
       "Audit log with filters and pagination",
       "Growth, exit and retention figures on the dashboard"]}
      next={["The twelve documented report families as individual screens",
       "Income tax reports: HRA, declarations, proof submission, rent and landlord details",
       "PF ECR, ESI ECR and state-wise PT and LWF statements",
       "Scheduled report emailing",
       "Custom report builder"]}
      schemaTables={["payroll_runs", "payroll_run_employees", "payslip_lines", "audit_logs", "statutory_filings"]}
    />
  );
}
