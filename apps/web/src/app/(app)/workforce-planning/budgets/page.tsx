import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fiscalYearOf, fiscalYearLabel } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { orgNames, budgetActuals } from "@/lib/workforce";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar, inr } from "@/components/workforce-tables";
import { saveBudgetAction, submitPlanningAction, reviseBudgetAction } from "@/app/actions/workforce-planning";

const P = PERMISSIONS;

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ fy?: string; q?: string; history?: string }> }) {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_VIEW);
  const sp = await searchParams;
  const fy = Number(sp.fy) || fiscalYearOf(new Date());
  const q = sp.q?.trim();
  const canManage = can(viewer, P.WORKFORCE_PLAN_MANAGE);
  const [names, budgets, plans] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.workforceBudget.findMany({ where: { tenantId: viewer.tenantId, fiscalYear: fy, ...(sp.history ? {} : { isCurrent: true }), ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, orderBy: [{ name: "asc" }, { version: "desc" }] }),
    prisma.workforcePlan.findMany({ where: { tenantId: viewer.tenantId, fiscalYear: fy }, select: { id: true, name: true } }),
  ]);
  const withActuals = await Promise.all(budgets.map(async (b) => ({ b, a: await budgetActuals(viewer.tenantId, b) })));
  const deptOpts = names.departments.map((d) => ({ value: d.id, label: d.name }));
  const fields = (b?: (typeof budgets)[number]) => (
    <div className="grid grid-3">
      <F label="Name *"><input className="input" name="name" required defaultValue={b?.name} /></F>
      <F label="Fiscal year"><Select name="fiscalYear" options={[fy, fy + 1].map((y) => ({ value: String(y), label: fiscalYearLabel(y) }))} defaultValue={String(b?.fiscalYear ?? fy)} /></F>
      <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={b?.departmentId} placeholder="Whole organisation" /></F>
      <F label="Linked plan"><Select name="planId" options={plans.map((p) => ({ value: p.id, label: p.name }))} defaultValue={b?.planId} placeholder="—" /></F>
      <F label="Salary budget"><input className="input" type="number" name="salaryBudget" min={0} defaultValue={b ? Number(b.salaryBudget) : undefined} /></F>
      <F label="Benefits budget"><input className="input" type="number" name="benefitsBudget" min={0} defaultValue={b ? Number(b.benefitsBudget) : undefined} /></F>
      <F label="Hiring budget"><input className="input" type="number" name="hiringBudget" min={0} defaultValue={b ? Number(b.hiringBudget) : undefined} /></F>
      <F label="Contractor budget"><input className="input" type="number" name="contractorBudget" min={0} defaultValue={b ? Number(b.contractorBudget) : undefined} /></F>
      <F label="Notes"><input className="input" name="notes" defaultValue={b?.notes ?? undefined} /></F>
    </div>
  );

  return (
    <>
      <PageHead title="Workforce budgets" subtitle={`${fiscalYearLabel(fy)} — salary, benefits, hiring and contractor budgets against payroll and contractor actuals.`} actions={<a className="btn sm" href={`/workforce-planning/export?report=budgets&fy=${fy}`}>Export CSV</a>} />
      <FilterBar action="/workforce-planning/budgets">
        <F label="Fiscal year"><Select name="fy" options={[fy - 1, fy, fy + 1].map((y) => ({ value: String(y), label: fiscalYearLabel(y) }))} defaultValue={String(fy)} /></F>
        <F label="Search"><input className="input" name="q" defaultValue={sp.q} /></F>
        <label className="checkbox-row"><input type="checkbox" name="history" value="1" defaultChecked={!!sp.history} /> <span className="text-sm">Include earlier versions</span></label>
      </FilterBar>
      {canManage ? <Card title="New budget"><Disclosure label="Create budget"><SimpleForm action={saveBudgetAction} submitLabel="Create budget">{fields()}</SimpleForm></Disclosure></Card> : null}
      {withActuals.length === 0 ? <Empty title="No budgets for this year." /> : withActuals.map(({ b, a }) => (
        <Card key={b.id} title={<>{b.name} <Badge>v{b.version}</Badge> <StatusPill status={b.status} /> {!b.isCurrent ? <Badge>superseded</Badge> : null}</>}
          description={`${b.departmentId ? names.dept.get(b.departmentId) : "Organisation"} · total ${inr(a.budgetTotal)}`}
          action={canManage && b.isCurrent ? (
            <div className="row gap-2">
              {b.status === "DRAFT" || b.status === "REJECTED" ? <ActionButton action={submitPlanningAction} hidden={{ kind: "budget", id: b.id }} label="Submit" variant="primary" /> : null}
              {b.status !== "PENDING_APPROVAL" ? <ActionButton action={reviseBudgetAction} hidden={{ id: b.id }} label="Revise (new version)" /> : null}
            </div>
          ) : null}>
          <table className="data"><thead><tr><th>Line</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Used</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>Salary (gross pay)</td><td className="num">{inr(b.salaryBudget)}</td><td className="num">{inr(a.actual.salary)}</td><td className="num">{inr(a.salary.variance)}</td><td className="num">{a.salary.utilisationPct}%</td><td className="text-xs">{a.salary.status.toLowerCase()}</td></tr>
              <tr><td>Benefits (employer contributions)</td><td className="num">{inr(b.benefitsBudget)}</td><td className="num">{inr(a.actual.employer)}</td><td className="num">{inr(a.benefits.variance)}</td><td className="num">{a.benefits.utilisationPct}%</td><td className="text-xs">{a.benefits.status.toLowerCase()}</td></tr>
              <tr><td>Contractors</td><td className="num">{inr(b.contractorBudget)}</td><td className="num">{inr(a.contractor)}</td><td className="num">{inr(a.contractorVar.variance)}</td><td className="num">{a.contractorVar.utilisationPct}%</td><td className="text-xs">{a.contractorVar.status.toLowerCase()}</td></tr>
              <tr><td>Hiring</td><td className="num">{inr(b.hiringBudget)}</td><td colSpan={4} className="text-xs muted">Tracked against requisitions</td></tr>
              <tr><td><strong>Total</strong></td><td className="num"><strong>{inr(a.budgetTotal)}</strong></td><td className="num"><strong>{inr(a.actual.total + a.contractor)}</strong></td><td className="num">{inr(a.total.variance)}</td><td className="num">{a.total.utilisationPct}%</td><td className="text-xs">{a.total.status.toLowerCase()}</td></tr>
            </tbody></table>
          {canManage && b.isCurrent && (b.status === "DRAFT" || b.status === "REJECTED") ? (
            <div style={{ marginTop: 10 }}><Disclosure label="Edit" variant="default"><SimpleForm action={saveBudgetAction} hidden={{ id: b.id }}>{fields(b)}</SimpleForm></Disclosure></div>
          ) : null}
        </Card>
      ))}
    </>
  );
}
