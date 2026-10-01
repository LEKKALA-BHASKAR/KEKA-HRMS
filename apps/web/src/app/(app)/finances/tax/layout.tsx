import type { ReactNode } from "react";
import { SubTabs } from "@/components/subtabs";

/** Manage Tax: the sub-tab row sits first on every page beneath it. */
export default function ManageTaxLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SubTabs items={[
        { label: "Declaration", href: "/finances/tax" },
        { label: "Previous Income", href: "/finances/tax/previous-income" },
        { label: "Forms", href: "/finances/tax/forms" },
        { label: "Tax Filing", href: "/finances/tax/tax-filing" },
        { label: "Tax Saving Investment", href: "/finances/tax/tax-saving-investment" },
      ]} />
      {children}
    </>
  );
}
