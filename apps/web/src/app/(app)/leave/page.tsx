import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.LEAVE_VIEW);
  return (
    <ModuleRoadmap
      title="Leave management"
      subtitle="Leave types, plans, balances and the sandwich engine"
      built={["Eight leave types seeded across all four categories: regular, incident, comp-off and unpaid",
       "Roughly seventy configuration settings per regular leave type",
       "Sandwich configuration with independent weekly-off and holiday triggers, clubbed across leave types",
       "Balances accrue and feed payroll: unpaid leave is one of the three documented LOP drivers",
       "Year-end actions: reset, pay, carry forward, or pay-then-carry in either order"]}
      next={["The leave application form and multi-level approval chains",
       "The accrual job that credits balances monthly, quarterly or annually",
       "Team leave calendar and the encashment workflow",
       "Comp-off credit from the overtime policy"]}
      schemaTables={["leave_types", "leave_plans", "leave_balances", "leave_requests", "leave_request_days", "holiday_calendars"]}
    />
  );
}
