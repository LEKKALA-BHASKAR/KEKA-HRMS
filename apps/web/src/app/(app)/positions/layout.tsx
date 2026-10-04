import type { ReactNode } from "react";
import { SubTabs } from "@/components/subtabs";

/** Positions & job architecture: the sub-tab row over every page beneath it. */
export default function PositionsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SubTabs items={[
        { label: "Positions", href: "/positions" },
        { label: "Job catalogue", href: "/positions/jobs" },
        { label: "Families & levels", href: "/positions/architecture" },
        { label: "Approvals", href: "/positions/approvals" },
        { label: "Reports", href: "/positions/reports" },
      ]} />
      {children}
    </>
  );
}
