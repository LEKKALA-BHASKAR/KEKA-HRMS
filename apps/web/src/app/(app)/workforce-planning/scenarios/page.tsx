import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { compareCosts, fiscalYearLabel } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { orgNames, costOf } from "@/lib/workforce";
import { PageHead, Card, Empty } from "@/components/ui";
import { F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar, inr } from "@/components/workforce-tables";

/** Side-by-side scenario modelling: a base plan and every scenario copied from it. */
export default async function ScenariosPage({ searchParams }: { searchParams: Promise<{ base?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.WORKFORCE_PLAN_VIEW);
  const sp = await searchParams;
  const [names, bases] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.workforcePlan.findMany({ where: { tenantId: viewer.tenantId, isScenario: false, scenarios: { some: {} } }, select: { id: true, name: true, fiscalYear: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const baseId = sp.base ?? bases[0]?.id;
  const base = baseId ? await prisma.workforcePlan.findFirst({ where: { id: baseId, tenantId: viewer.tenantId }, include: { lines: true, scenarios: { include: { lines: true }, orderBy: { createdAt: "asc" } } } }) : null;
  const baseCost = base ? costOf(base) : null;
  // Department headcount per plan, for restructuring comparisons.
  const depts = base ? [...new Set([base, ...base.scenarios].flatMap((p) => p.lines.map((l) => l.departmentId)))] : [];
  const hcOf = (p: { lines: Array<{ departmentId: string; plannedHeadcount: number }> }, d: string) => p.lines.filter((l) => l.departmentId === d).reduce((s, l) => s + l.plannedHeadcount, 0);

  return (
    <>
      <PageHead title="Scenario planning" subtitle="Compare a plan with its scenarios: headcount, increment and attrition changes, and organisation restructuring." actions={base ? <a className="btn sm" href={`/workforce-planning/export?report=scenarios&base=${base.id}`}>Export comparison CSV</a> : null} />
      <FilterBar action="/workforce-planning/scenarios">
        <F label="Base plan"><Select name="base" options={bases.map((b) => ({ value: b.id, label: `${b.name} (${fiscalYearLabel(b.fiscalYear)})` }))} defaultValue={baseId} placeholder="Choose" /></F>
      </FilterBar>
      {!base || !baseCost ? <Empty title="No scenarios yet.">Open a plan and create a scenario from it.</Empty> : (
        <>
          <Card title="Cost and headcount side by side">
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Plan</th><th>Status</th><th className="num">Headcount</th><th className="num">Hires</th><th className="num">Increase %</th><th className="num">Attrition %</th><th className="num">Total cost</th><th className="num">Δ cost</th><th className="num">Δ %</th><th className="num">Δ heads</th></tr></thead>
              <tbody>
                <tr><td><Link href={`/workforce-planning/${base.id}`}>{base.name}</Link> (base)</td><td><StatusPill status={base.status} /></td><td className="num">{baseCost.headcount}</td><td className="num">{baseCost.hires}</td><td className="num">{Number(base.salaryIncreasePct)}</td><td className="num">{Number(base.attritionPct)}</td><td className="num">{inr(baseCost.total)}</td><td /><td /><td /></tr>
                {base.scenarios.map((s) => {
                  const c = costOf(s);
                  const d = compareCosts(baseCost, c);
                  return <tr key={s.id}><td><Link href={`/workforce-planning/${s.id}`}>{s.name}</Link></td><td><StatusPill status={s.status} /></td><td className="num">{c.headcount}</td><td className="num">{c.hires}</td><td className="num">{Number(s.salaryIncreasePct)}</td><td className="num">{Number(s.attritionPct)}</td><td className="num">{inr(c.total)}</td><td className="num">{inr(d.costDelta)}</td><td className="num">{d.costDeltaPct}%</td><td className="num">{d.headcountDelta}</td></tr>;
                })}
              </tbody>
            </table></div>
          </Card>
          <Card title="Headcount by department (restructuring view)">
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Department</th><th className="num">{base.name}</th>{base.scenarios.map((s) => <th key={s.id} className="num">{s.name}</th>)}</tr></thead>
              <tbody>{depts.map((d) => <tr key={d}><td>{names.dept.get(d)}</td><td className="num">{hcOf(base, d)}</td>{base.scenarios.map((s) => <td key={s.id} className="num">{hcOf(s, d)}</td>)}</tr>)}</tbody>
            </table></div>
          </Card>
        </>
      )}
    </>
  );
}
