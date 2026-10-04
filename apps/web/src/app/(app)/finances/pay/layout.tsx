import type { ReactNode } from "react";
import { isMyPayHidden } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";
import { Card, Empty } from "@/components/ui";

/** My Pay: the sub-tab row sits first on every page beneath it. Payroll settings can hide the page from employees. */
export default async function MyPayLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  if (await isMyPayHidden(viewer.tenantId)) {
    return (
      <Card>
        <Empty title="My Pay is not available">Your organisation has hidden this page. Contact your payroll team for your salary details and payslips.</Empty>
      </Card>
    );
  }
  return (
    <>
      <SubTabs items={[
        { label: "My Salary", href: "/finances/pay" },
        { label: "Pay Slips", href: "/finances/pay/payslips" },
        { label: "Income Tax", href: "/finances/pay/tax" },
        { label: "Component Claim", href: "/finances/pay/component-claims" },
        { label: "Flexible Benefits", href: "/finances/pay/fbp" },
      ]} />
      {children}
    </>
  );
}
