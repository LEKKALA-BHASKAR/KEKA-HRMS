import type { ReactNode } from "react";
import { SubTabs } from "@/components/subtabs";

/** Contingent workforce: the sub-tab row over every page beneath it. */
export default function ContingentLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SubTabs items={[
        { label: "Dashboard", href: "/contingent" },
        { label: "Workers", href: "/contingent/workers" },
        { label: "Vendors", href: "/contingent/vendors" },
        { label: "Rate cards", href: "/contingent/rate-cards" },
        { label: "Approvals", href: "/contingent/approvals" },
      ]} />
      {children}
    </>
  );
}
