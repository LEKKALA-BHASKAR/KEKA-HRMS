import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { ModuleRoadmap } from "@/components/roadmap";

export default async function Page() {
  await requireAuth(PERMISSIONS.ATTENDANCE_VIEW);
  return (
    <ModuleRoadmap
      title="Time & attendance"
      subtitle="Capture, shifts, regularisation and penalisation"
      built={["Attendance records with gross and effective hours, payable value and LOP value per day",
       "Raw punch log with source, device, geolocation and IP, ready for biometric ingestion",
       "Shifts with per-day schedules, flexible hours, break duration and cross-midnight handling",
       "Weekly-off policies with instance selectors, the primitive behind alternate-Saturday patterns",
       "Overtime and shift-allowance entries that flow into payroll step 3"]}
      next={["Web, mobile and kiosk clock-in with geofencing",
       "The biometric ingestion endpoint and device roster mapping",
       "Penalisation policy for late arrival, work-hour shortage and missing punches",
       "Regularisation, adjustment and partial-day requests",
       "Shift boards for delegated rostering"]}
      schemaTables={["attendance_records", "attendance_logs", "shifts", "shift_assignments", "weekly_off_policies", "overtime_entries", "lop_adjustments"]}
    />
  );
}
