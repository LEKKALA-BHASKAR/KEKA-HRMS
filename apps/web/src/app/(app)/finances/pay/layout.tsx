import type { ReactNode } from "react";
import { SubTabs } from "@/components/subtabs";

/** My Pay: the sub-tab row sits first on every page beneath it. */
export default function MyPayLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SubTabs items={[
        { label: "My Salary", href: "/finances/pay" },
        { label: "Pay Slips", href: "/finances/pay/payslips" },
        { label: "Income Tax", href: "/finances/pay/tax" },
        { label: "Component Claim", href: "/finances/pay/component-claims" },
      ]} />
      {children}
    </>
  );
}
