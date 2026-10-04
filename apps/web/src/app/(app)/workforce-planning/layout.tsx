import type { ReactNode } from "react";
import { SubTabs } from "@/components/subtabs";

/** Workforce planning & budgeting: the sub-tab row over every page beneath it. */
export default function WorkforcePlanningLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SubTabs items={[
        { label: "Dashboard & plans", href: "/workforce-planning" },
        { label: "Scenarios", href: "/workforce-planning/scenarios" },
        { label: "Budgets", href: "/workforce-planning/budgets" },
        { label: "Capacity", href: "/workforce-planning/capacity" },
        { label: "Approvals", href: "/workforce-planning/approvals" },
      ]} />
      {children}
    </>
  );
}
