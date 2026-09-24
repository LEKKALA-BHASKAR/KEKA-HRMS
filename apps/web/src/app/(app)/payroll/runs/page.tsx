import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, MONTH_NAMES } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, RunStatusBadge, Money, Empty, Callout } from "@/components/ui";
import { startPayrollRun } from "@/app/actions/payroll";
import { IconPlay } from "@/components/icons";

const P = PERMISSIONS;

export default async function PayrollRunsPage() {
  const viewer = await requireAuth(P.PAYROLL_VIEW);

  const [runs, payGroups] = await Promise.all([
    prisma.payrollRun.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: [{ year: "desc" }, { month: "desc" }, { sequence: "asc" }],
      include: {
        payGroup: { select: { name: true } },
        _count: { select: { payslips: true } },
      },
      take: 30,
    }),
    prisma.payGroup.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true, _count: { select: { employees: true } } },
    }),
  ]);

  const now = new Date();
  // Default to the month just ended — payroll is run in arrears.
  const defaultMonth = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  const defaultYear = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();

  return (
    <>
      <PageHead
        title="Run payroll"
        subtitle="Six guided steps from attendance to a locked, finalised month"
      />

      {can(viewer, P.PAYROLL_RUN) && payGroups.length > 0 ? (
        <Card
          title="Start a new run"
          description="Pick a pay group and period. Existing runs for the same period reopen rather than duplicate."
        >
          <form action={startPayrollRun} className="row gap-2 wrap">
            <select className="select" name="payGroupId" style={{ maxWidth: 300 }} required>
              {payGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g._count.employees} employees)
                </option>
              ))}
            </select>
            <select className="select" name="month" defaultValue={defaultMonth} style={{ maxWidth: 150 }}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select className="select" name="year" defaultValue={defaultYear} style={{ maxWidth: 110 }}>
              {[defaultYear - 1, defaultYear, defaultYear + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <button className="btn primary" type="submit">
              <IconPlay width={15} height={15} />Start run
            </button>
          </form>
        </Card>
      ) : null}

      <div style={{ height: 16 }} />

      <Card title="Payroll runs" tight>
        {runs.length === 0 ? (
          <Empty title="No payroll runs yet">
            Start one above. The run walks through leave and attendance, joiners and exits,
            bonuses and revisions, reimbursements, holds and arrears, then overrides and finalising.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Period</th><th>Pay group</th><th>Type</th>
                  <th className="num">Employees</th>
                  <th className="num">Gross</th>
                  <th className="num">Deductions</th>
                  <th className="num">Net pay</th>
                  <th>Step</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="strong nowrap">{formatPeriod(r.year, r.month)}</td>
                    <td className="text-sm">{r.payGroup.name}</td>
                    <td className="text-sm muted">{r.type === "OFF_CYCLE" ? "Off-cycle" : "Regular"}</td>
                    <td className="num">{r.employeeCount}</td>
                    <td className="num"><Money value={r.totalGross} compact /></td>
                    <td className="num"><Money value={r.totalDeductions} compact /></td>
                    <td className="num strong"><Money value={r.totalNetPay} compact /></td>
                    <td className="num">{r.status === "FINALIZED" ? "—" : `${r.currentStep} / 6`}</td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td className="right">
                      <Link className="btn sm" href={`/payroll/runs/${r.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
