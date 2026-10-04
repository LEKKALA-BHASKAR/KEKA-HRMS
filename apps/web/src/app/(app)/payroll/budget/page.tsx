import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatINR } from "@keka/shared";
import { budgetPreview, scenarioReport } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty, Stat, Callout } from "@/components/ui";
import { DepthForm } from "../_forms/depth";
import { saveScenarioAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;

/**
 * Upcoming months: what payroll will cost over the next three months from
 * current salaries and approved revisions; and compensation budget
 * scenarios — increment percentages by department, priced on today's CTCs.
 */
export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ scenario?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_VIEW);
  const sp = await searchParams;
  const canPlan = can(viewer, P.SALARY_REVISE);
  const [preview, scenarios, departments] = await Promise.all([
    budgetPreview(viewer.tenantId, 3),
    prisma.compBudgetScenario.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { updatedAt: "desc" } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const selected = sp.scenario ?? scenarios[0]?.id;
  const report = selected ? await scenarioReport(viewer.tenantId, selected, viewer.tenant.fyStartMonth) : null;
  const editing = sp.edit === "new" ? null : sp.edit ? scenarios.find((s) => s.id === sp.edit) ?? null : null;
  const editPcts = (editing?.departmentPercents ?? {}) as Record<string, number>;
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const total3 = preview.months.reduce((s, m) => s + m.cost, 0);

  return (
    <>
      <PageHead title="Payroll budget" subtitle="Projected cost for the coming months, and increment scenarios by department" />

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        {preview.months.map((m) => (
          <Stat key={`${m.year}-${m.month}`} label={formatPeriod(m.year, m.month)} value={formatINR(m.cost, false)}
            meta={`${m.headcount} employees${m.revisionImpact ? ` · revisions +${formatINR(m.revisionImpact, false)}` : ""}`} />
        ))}
        <Stat label="Next 3 months" value={formatINR(total3, false)} meta={preview.lastRun ? `Last run ${formatPeriod(preview.lastRun.year, preview.lastRun.month)}: ${formatINR(preview.lastRun.cost, false)}` : "No payroll run yet"} />
      </div>
      <Callout tone="info" title="How the projection works">
        Monthly cost is annual CTC ÷ 12 for everyone employed in the month, switching to an approved salary revision from its effective month and leaving out anyone
        whose last working day has passed. It is a budget figure, not a payroll run: no LOP, variable pay or statutory changes.
        {preview.withoutSalary ? ` ${preview.withoutSalary} employee(s) have no salary on record and count as zero.` : ""}
      </Callout>
      <div style={{ height: 14 }} />
      <Card tight title="By department">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Department</th>{preview.months.map((m) => <th key={`${m.year}-${m.month}`} className="num">{formatPeriod(m.year, m.month)}</th>)}</tr></thead>
            <tbody>
              {preview.byDept.map((d) => (
                <tr key={d.department}><td>{d.department}</td>{d.months.map((m) => <td key={`${m.year}-${m.month}`} className="num">{formatINR(m.cost, false)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ height: 20 }} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
        <Card tight title={report ? `Scenario — ${report.scenario.name}` : "Increment scenarios"}
          description={report ? `Effective ${formatPeriod(report.scenario.effectiveYear, report.scenario.effectiveMonth)}: ${report.monthsInYear} month(s) left in the financial year. Default ${report.scenario.defaultPercent}%.` : undefined}
          action={scenarios.length ? <div className="row gap-2 wrap">{scenarios.map((s) => <Link key={s.id} className={`btn sm${s.id === selected ? " primary" : ""}`} href={`/payroll/budget?scenario=${s.id}`}>{s.name}</Link>)}</div> : null}>
          {!report ? <Empty title="No scenarios yet">Create one to price increments by department.</Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Department</th><th className="num">Headcount</th><th className="num">Current CTC</th><th className="num">Increment</th><th className="num">Annual increase</th><th className="num">New CTC</th><th className="num">Cost this FY</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.departmentId ?? "none"}>
                      <td>{r.department}</td><td className="num">{r.headcount}</td><td className="num">{formatINR(r.currentCtc, false)}</td>
                      <td className="num">{r.percent}%</td><td className="num">{formatINR(r.increase, false)}</td><td className="num">{formatINR(r.newCtc, false)}</td><td className="num">{formatINR(r.inYearCost, false)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 650 }}>
                    <td>Total</td><td className="num">{report.totals.headcount}</td><td className="num">{formatINR(report.totals.currentCtc, false)}</td>
                    <td className="num">{report.totals.currentCtc ? `${((report.totals.increase / report.totals.currentCtc) * 100).toFixed(2)}%` : "—"}</td>
                    <td className="num">{formatINR(report.totals.increase, false)}</td><td className="num">{formatINR(report.totals.newCtc, false)}</td><td className="num">{formatINR(report.totals.inYearCost, false)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {report && canPlan ? <div style={{ padding: 12 }}><Link className="btn sm" href={`/payroll/budget?scenario=${report.scenario.id}&edit=${report.scenario.id}`}>Edit this scenario</Link></div> : null}
        </Card>
        {canPlan ? (
          <Card title={editing ? `Edit ${editing.name}` : "New scenario"} action={editing ? <Link className="btn sm" href={`/payroll/budget?scenario=${editing.id}`}>New instead</Link> : null}>
            <DepthForm action={saveScenarioAction} submitLabel={editing ? "Save scenario" : "Create scenario"} hidden={editing ? { id: editing.id } : undefined}>
              <div className="field"><label className="label" htmlFor="sc-n">Name</label><input id="sc-n" className="input" name="name" required maxLength={120} defaultValue={editing?.name ?? ""} placeholder="e.g. FY27 merit cycle" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label" htmlFor="sc-d">Default increment %</label><input id="sc-d" className="input num" name="defaultPercent" type="number" step="0.1" min={-50} max={100} defaultValue={editing ? Number(editing.defaultPercent) : 8} /></div>
                <div className="field"><label className="label" htmlFor="sc-e">Effective month</label><input id="sc-e" className="input" name="effective" type="month" required defaultValue={editing ? `${editing.effectiveYear}-${String(editing.effectiveMonth).padStart(2, "0")}` : nextMonth} /></div>
              </div>
              <div className="text-xs strong subtle" style={{ margin: "6px 0" }}>BY DEPARTMENT (blank uses the default)</div>
              {departments.map((d) => (
                <div key={d.id} className="row gap-2" style={{ marginBottom: 6 }}>
                  <label className="text-sm" htmlFor={`dept_${d.id}`} style={{ flex: 1 }}>{d.name}</label>
                  <input id={`dept_${d.id}`} className="input num" name={`dept_${d.id}`} type="number" step="0.1" min={-50} max={100} defaultValue={editPcts[d.id] ?? ""} style={{ width: 90 }} />
                </div>
              ))}
            </DepthForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
