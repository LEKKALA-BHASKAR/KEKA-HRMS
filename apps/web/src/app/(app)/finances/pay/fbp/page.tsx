import Link from "next/link";
import { fbpPlan } from "@keka/services";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { EmptyState } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { FbpForm } from "../../_components/fbp-form";
import { fySpan } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Flexible Benefits" };

/**
 * Flexible benefit plan: split part of the Special Allowance across the
 * plan's reimbursements for the year, then claim them back against bills.
 */
export default async function FbpPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const plan = await fbpPlan(viewer.employee.id);
  return (
    <>
      <div className={s.titleRow}>
        <h1 className={s.bigTitle}>Flexible Benefit Plan · {fySpan(plan.fy, viewer.tenant.fyStartMonth)}</h1>
      </div>
      {!plan.eligible ? (
        <section className={`${s.boxed} ${s.mt}`}><p className={s.muted} style={{ padding: 16 }}>{plan.reason}</p></section>
      ) : (
        <section className={`${s.boxed} ${s.mt}`} style={{ padding: 16 }}>
          <p style={{ marginTop: 0 }}>
            Choose how much of your {plan.poolComponent ?? "Special Allowance"} to take as tax-free reimbursements this year. The amount you declare is set aside from
            each month&apos;s salary and paid back when you <Link className={s.link} href="/finances/pay/component-claims">claim it against bills</Link>.
            Anything you have not claimed by March is paid with March salary, taxed as usual.
          </p>
          {plan.declaration ? (
            <p className={s.muted}>
              Submitted on {formatDate(plan.declaration.submittedAt)}.{" "}
              {plan.declaration.isLocked ? "Locked for the year; ask the payroll team if you need to change it." : "Reopened by payroll; you can change it now."}
            </p>
          ) : null}
          <FbpForm pool={plan.pool} editable={plan.editable} components={plan.components.map((c) => ({ id: c.id, name: c.name, limit: c.limit, declared: c.declared }))} />
        </section>
      )}
    </>
  );
}
