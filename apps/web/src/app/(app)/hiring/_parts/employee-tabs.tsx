import { PERMISSIONS } from "@keka/rbac";
import { canAny, type Viewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";

const P = PERMISSIONS;

/** Mirrors the Hire section's gate in lib/nav.ts. */
export const hasHireSection = (viewer: Viewer) =>
  canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE, P.JOB_MANAGE, P.CANDIDATE_MANAGE, P.INTERVIEW_MANAGE]);

/**
 * Employees without the Hire workspace reach Interviews and Refer & Apply
 * from Me › Apps; they get these two as a row of tabs instead.
 */
export function EmployeeHireTabs({ viewer }: { viewer: Viewer }) {
  if (hasHireSection(viewer)) return null;
  return <SubTabs items={[{ label: "Interviews", href: "/hiring/interviews" }, { label: "Refer & Apply", href: "/hiring/refer" }]} />;
}
