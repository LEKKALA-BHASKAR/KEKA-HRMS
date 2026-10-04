import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty, Badge, Money, Callout } from "@/components/ui";
import { DepthForm } from "../_forms/depth";
import { saveComponentOverrideAction, deleteComponentOverrideAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;
const ym = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Per-employee salary component overrides: a fixed monthly amount for one
 * component, from a month (and optionally to a month). The payroll engine
 * uses it in place of the structure's formula for that employee.
 */
export default async function SalaryOverridesPage({ searchParams }: { searchParams: Promise<{ employee?: string; all?: string }> }) {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const sp = await searchParams;
  const scope = scopedEmployeeWhere(viewer, P.SALARY_REVISE);
  const now = new Date();
  const [employees, components, overrides] = await Promise.all([
    prisma.employee.findMany({ where: { ...scope, status: { notIn: ["EXITED"] }, id: { not: viewer.employee?.id ?? "" } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
    prisma.salaryComponent.findMany({ where: { tenantId: viewer.tenantId, isActive: true, type: { in: ["EARNING", "DEDUCTION", "REIMBURSEMENT"] } }, select: { id: true, name: true, code: true, type: true }, orderBy: [{ type: "asc" }, { displayOrder: "asc" }] }),
    prisma.employeeComponentOverride.findMany({
      where: { tenantId: viewer.tenantId, employee: scope, ...(sp.employee ? { employeeId: sp.employee } : {}), ...(sp.all ? {} : { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }) },
      include: { employee: { select: { id: true, displayName: true, employeeNumber: true } }, component: { select: { name: true, code: true, type: true } } },
      orderBy: [{ employee: { employeeNumber: "asc" } }, { effectiveFrom: "desc" }],
    }),
  ]);
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return (
    <>
      <PageHead title="Salary component overrides" subtitle="A fixed monthly amount for one component, for one employee, from a month — used by payroll in place of the structure's formula" />
      <Callout tone="info" title="How an override works">
        The component is paid at exactly this amount (before loss-of-pay proration, if it prorates) from the start month, and components whose formulas
        use it follow the new value. A component the structure does not have is added. Open payroll runs are recalculated straight away; finalised months are never changed.
      </Callout>
      <div style={{ height: 14 }} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <Card tight title={`Overrides (${overrides.length})`}
          action={<div className="row gap-2">
            <Link className={`btn sm${sp.all ? "" : " primary"}`} href="/payroll/salary-overrides">In force</Link>
            <Link className={`btn sm${sp.all ? " primary" : ""}`} href="/payroll/salary-overrides?all=1">All</Link>
          </div>}>
          {overrides.length === 0 ? <Empty title="No overrides">Every employee is paid exactly as their salary structure says.</Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Component</th><th className="num">Monthly amount</th><th>From</th><th>To</th><th>Note</th><th /></tr></thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr key={o.id}>
                      <td><Link href={`/payroll/salary-overrides?employee=${o.employee.id}`}><span className="mono text-xs">{o.employee.employeeNumber}</span> {o.employee.displayName}</Link></td>
                      <td>{o.component.name} <Badge tone={o.component.type === "DEDUCTION" ? "danger" : "success"}>{o.component.code}</Badge></td>
                      <td className="num strong"><Money value={o.monthlyAmount} /></td>
                      <td className="nowrap">{formatDate(o.effectiveFrom)}</td>
                      <td className="nowrap">{o.effectiveTo ? formatDate(o.effectiveTo) : <span className="subtle">Ongoing</span>}</td>
                      <td className="text-xs">{o.note ?? ""}</td>
                      <td><DepthForm action={deleteComponentOverrideAction} inline variant="ghost" submitLabel="Remove" hidden={{ id: o.id }} confirmText="Remove this override? Open payroll runs will be recalculated." /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="New override">
          <DepthForm action={saveComponentOverrideAction} submitLabel="Save override">
            <div className="field"><label className="label" htmlFor="ov-emp">Employee</label>
              <select id="ov-emp" className="select" name="employeeId" required defaultValue={sp.employee ?? ""}>
                <option value="">Choose…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.displayName}</option>)}
              </select>
            </div>
            <div className="field"><label className="label" htmlFor="ov-comp">Component</label>
              <select id="ov-comp" className="select" name="componentId" required>
                <option value="">Choose…</option>
                {components.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code}) — {c.type.toLowerCase()}</option>)}
              </select>
            </div>
            <div className="field"><label className="label" htmlFor="ov-amt">Monthly amount (₹)</label><input id="ov-amt" className="input num" name="amount" type="number" min={0} step="1" required /></div>
            <div className="grid grid-2">
              <div className="field"><label className="label" htmlFor="ov-from">From month</label><input id="ov-from" className="input" name="from" type="month" required defaultValue={ym(nextMonth)} /></div>
              <div className="field"><label className="label" htmlFor="ov-to">To month</label><input id="ov-to" className="input" name="to" type="month" /><div className="hint">Blank: until removed</div></div>
            </div>
            <div className="field"><label className="label" htmlFor="ov-note">Note</label><input id="ov-note" className="input" name="note" maxLength={300} placeholder="Why this employee is different" /></div>
          </DepthForm>
        </Card>
      </div>
    </>
  );
}
