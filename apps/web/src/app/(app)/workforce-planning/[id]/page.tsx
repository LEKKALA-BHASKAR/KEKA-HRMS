import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fiscalYearLabel, fiscalMonthLabel, headcountCalendar, budgetVariance, payrollActuals } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { orgNames, costOf, headcountVsPlan, auditTrail } from "@/lib/workforce";
import { PageHead, Card, KeyValue, Stat, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, RequestsTable, AuditTable, inr } from "@/components/workforce-tables";
import {
  savePlanAction, savePlanLineAction, deletePlanLineAction, forecastPlanLinesAction, submitPlanningAction, activatePlanAction, createScenarioAction, budgetFromPlanAction,
} from "@/app/actions/workforce-planning";

const P = PERMISSIONS;

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_VIEW);
  const { id } = await params;
  const plan = await prisma.workforcePlan.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { lines: true, baseplan: { select: { id: true, name: true } }, scenarios: { select: { id: true, name: true, status: true } } } });
  if (!plan) notFound();
  const [names, hc, requests, audit, users, actual] = await Promise.all([
    orgNames(viewer.tenantId),
    headcountVsPlan(viewer.tenantId, plan),
    prisma.workforceRequest.findMany({ where: { tenantId: viewer.tenantId, entityType: "WorkforcePlan", entityId: plan.id }, orderBy: { requestedAt: "desc" } }),
    auditTrail(viewer.tenantId, ["WorkforcePlan"], plan.id),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
    payrollActuals(viewer.tenantId, plan.fiscalYear, plan.departmentId),
  ]);
  const cost = costOf(plan);
  const editable = can(viewer, P.WORKFORCE_PLAN_MANAGE) && (plan.status === "DRAFT" || plan.status === "REJECTED");
  const canManage = can(viewer, P.WORKFORCE_PLAN_MANAGE);
  const startHc = hc.reduce((s, r) => s + r.active + r.preJoining, 0);
  const calendar = headcountCalendar(startHc, plan.lines);
  const variance = budgetVariance(cost.total, actual.total);
  const deptOpts = names.departments.map((d) => ({ value: d.id, label: d.name }));
  const locOpts = names.locations.map((l) => ({ value: l.id, label: l.name }));
  const jobOpts = names.jobs.map((j) => ({ value: j.id, label: `${j.code} ${j.title}` }));
  const monthOpts = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: fiscalMonthLabel(plan.fiscalYear, i + 1) }));
  // Location cost comparison: annual salary cost by location from the lines.
  const byLoc = new Map<string, { heads: number; cost: number }>();
  for (const l of plan.lines) {
    const k = l.locationId ? names.loc.get(l.locationId) ?? "—" : "Any location";
    const r = byLoc.get(k) ?? { heads: 0, cost: 0 };
    r.heads += l.plannedHeadcount; r.cost += l.plannedHeadcount * Number(l.avgAnnualSalary);
    byLoc.set(k, r);
  }

  return (
    <>
      <PageHead
        title={plan.name}
        subtitle={<>{fiscalYearLabel(plan.fiscalYear)} · {plan.departmentId ? names.dept.get(plan.departmentId) : "Organisation"} · <StatusPill status={plan.status} /> {plan.isActive ? <Badge tone="success">In force</Badge> : null} {plan.isScenario ? <Badge tone="info">Scenario</Badge> : null}</>}
        actions={<><a className="btn sm" href={`/workforce-planning/export?report=plan&id=${plan.id}`}>Export plan CSV</a><Link className="btn sm" href="/workforce-planning">All plans</Link></>}
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Planned headcount" value={cost.headcount} meta={`${cost.hires} hires · ~${cost.expectedAttrition} expected leavers`} />
        <Stat label="Salary cost" value={inr(cost.salary)} meta={`+${Number(plan.salaryIncreasePct)}% increase`} />
        <Stat label="Total cost" value={inr(cost.total)} meta={`benefits ${inr(cost.benefits)} · overtime ${inr(cost.overtime)} · contractors ${inr(cost.contractor)}`} />
        <Stat label="Payroll actual to date" value={inr(actual.total)} meta={`${variance.utilisationPct}% of plan cost used`} tone={variance.status === "OVER" ? "neg" : undefined} />
      </div>

      <div className="row gap-2 wrap" style={{ marginBottom: 16 }}>
        {editable ? <ActionButton action={submitPlanningAction} hidden={{ kind: "plan", id: plan.id }} label="Submit for approval" variant="primary" /> : null}
        {canManage && plan.status === "ACTIVE" && !plan.isActive ? <ActionButton action={activatePlanAction} hidden={{ id: plan.id }} label={plan.isScenario ? "Adopt scenario as the plan" : "Activate plan"} variant="primary" /> : null}
        {canManage ? <ActionButton action={budgetFromPlanAction} hidden={{ planId: plan.id }} label="Build budget from plan" /> : null}
        {editable ? <ActionButton action={forecastPlanLinesAction} hidden={{ planId: plan.id }} label="Forecast lines from live headcount" /> : null}
      </div>

      <div className="grid grid-2">
        <Card title="Assumptions">
          <KeyValue items={[
            ["Attrition", `${Number(plan.attritionPct)}%`], ["Salary increase (inflation)", `${Number(plan.salaryIncreasePct)}%`], ["Benefits load", `${Number(plan.benefitsLoadPct)}%`],
            ["Overtime", `${Number(plan.overtimePct)}%`], ["Contractor cost", inr(plan.contractorCost)], ["Based on", plan.baseplan ? <Link href={`/workforce-planning/${plan.baseplan.id}`}>{plan.baseplan.name}</Link> : null],
            ["Scenarios", plan.scenarios.length ? plan.scenarios.map((s) => <div key={s.id}><Link href={`/workforce-planning/${s.id}`}>{s.name}</Link> ({s.status.toLowerCase()})</div>) : null],
            ["Notes", plan.notes],
          ]} />
          {editable ? (
            <Disclosure label="Edit plan" variant="default">
              <SimpleForm action={savePlanAction} hidden={{ id: plan.id, fiscalYear: String(plan.fiscalYear) }}>
                <div className="grid grid-2">
                  <F label="Name"><input className="input" name="name" defaultValue={plan.name} required /></F>
                  <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={plan.departmentId} placeholder="Whole organisation" /></F>
                  <F label="Attrition %"><input className="input" type="number" step="0.1" name="attritionPct" defaultValue={Number(plan.attritionPct)} /></F>
                  <F label="Salary increase %"><input className="input" type="number" step="0.1" name="salaryIncreasePct" defaultValue={Number(plan.salaryIncreasePct)} /></F>
                  <F label="Benefits load %"><input className="input" type="number" step="0.1" name="benefitsLoadPct" defaultValue={Number(plan.benefitsLoadPct)} /></F>
                  <F label="Overtime %"><input className="input" type="number" step="0.1" name="overtimePct" defaultValue={Number(plan.overtimePct)} /></F>
                  <F label="Contractor cost"><input className="input" type="number" name="contractorCost" defaultValue={Number(plan.contractorCost)} /></F>
                </div>
                <F label="Notes"><textarea className="textarea" name="notes" defaultValue={plan.notes ?? undefined} /></F>
              </SimpleForm>
            </Disclosure>
          ) : null}
        </Card>
        <Card title="Scenario" description="Copy this plan with headcount scaled and different assumptions, then compare under Scenarios.">
          {canManage ? (
            <SimpleForm action={createScenarioAction} hidden={{ planId: plan.id }} submitLabel="Create scenario">
              <div className="grid grid-2">
                <F label="Scenario name"><input className="input" name="name" required defaultValue={`${plan.name} — scenario`} /></F>
                <F label="Headcount change %"><input className="input" type="number" step="1" name="headcountChangePct" defaultValue={0} /></F>
                <F label="Salary increase %"><input className="input" type="number" step="0.1" name="salaryIncreasePct" defaultValue={Number(plan.salaryIncreasePct)} /></F>
                <F label="Attrition %"><input className="input" type="number" step="0.1" name="attritionPct" defaultValue={Number(plan.attritionPct)} /></F>
              </div>
            </SimpleForm>
          ) : <Empty title="Only planners can create scenarios." />}
        </Card>
      </div>

      <Card title="Headcount plan" description="Year-end targets per department; new hires start in their hire month.">
        {plan.lines.length === 0 ? <Empty title="No lines yet." /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Department</th><th>Location</th><th>Job</th><th className="num">Planned</th><th className="num">New hires</th><th className="num">Replacements</th><th className="num">Avg salary</th><th>Hire month</th><th>Note</th><th /></tr></thead>
            <tbody>{plan.lines.map((l) => (
              <tr key={l.id}><td>{names.dept.get(l.departmentId)}</td><td>{l.locationId ? names.loc.get(l.locationId) : "—"}</td><td className="text-xs">{l.jobId ? names.job.get(l.jobId) : "—"}</td>
                <td className="num">{l.plannedHeadcount}</td><td className="num">{l.newHires}</td><td className="num">{l.replacementHires}</td><td className="num">{inr(l.avgAnnualSalary)}</td><td className="text-xs">{fiscalMonthLabel(plan.fiscalYear, l.hireMonth)}</td><td className="text-xs">{l.note}</td>
                <td>{editable ? <ActionButton action={deletePlanLineAction} hidden={{ id: l.id }} label="Remove" /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {editable ? (
          <div style={{ marginTop: 12 }}>
            <Disclosure label="Add headcount line">
              <SimpleForm action={savePlanLineAction} hidden={{ planId: plan.id }} submitLabel="Add line">
                <div className="grid grid-3">
                  <F label="Department *"><Select name="departmentId" options={deptOpts} defaultValue={plan.departmentId} placeholder="Choose" required /></F>
                  <F label="Location"><Select name="locationId" options={locOpts} placeholder="Any" /></F>
                  <F label="Job"><Select name="jobId" options={jobOpts} placeholder="Any" /></F>
                  <F label="Planned headcount *"><input className="input" type="number" name="plannedHeadcount" min={0} required /></F>
                  <F label="New hires"><input className="input" type="number" name="newHires" min={0} defaultValue={0} /></F>
                  <F label="Replacement hires"><input className="input" type="number" name="replacementHires" min={0} defaultValue={0} /></F>
                  <F label="Average annual salary"><input className="input" type="number" name="avgAnnualSalary" min={0} /></F>
                  <F label="Hire month"><Select name="hireMonth" options={monthOpts} defaultValue="1" /></F>
                  <F label="Note"><input className="input" name="note" /></F>
                </div>
              </SimpleForm>
            </Disclosure>
          </div>
        ) : null}
      </Card>

      <Card title="Plan vs live headcount" description="Active, pre-joining, exiting and open requisitions are counted from employee and hiring records now.">
        {hc.length === 0 ? <Empty title="Add lines to compare." /> : (
          <table className="data"><thead><tr><th>Department</th><th className="num">Planned</th><th className="num">Active</th><th className="num">Pre-joining</th><th className="num">Exiting</th><th className="num">Open reqs</th><th className="num">Projected</th><th className="num">Variance</th><th>Status</th></tr></thead>
            <tbody>{hc.map((r) => (
              <tr key={r.departmentId}><td>{names.dept.get(r.departmentId)}</td><td className="num">{r.planned}</td><td className="num">{r.active}</td><td className="num">{r.preJoining}</td><td className="num">{r.exiting}</td><td className="num">{r.openRequisitions}</td><td className="num">{r.projected}</td><td className="num">{r.gap}</td><td className="text-xs">{r.status.replace("_", " ").toLowerCase()}</td></tr>
            ))}</tbody></table>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Future headcount calendar" description="Projected headcount at each month end.">
          <table className="data"><tbody>{calendar.map((v, i) => <tr key={i}><td>{fiscalMonthLabel(plan.fiscalYear, i + 1)}</td><td className="num">{v}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Location cost comparison">
          {byLoc.size === 0 ? <Empty title="No lines yet." /> : (
            <table className="data"><thead><tr><th>Location</th><th className="num">Heads</th><th className="num">Annual salary</th><th className="num">Per head</th></tr></thead>
              <tbody>{[...byLoc.entries()].map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v.heads}</td><td className="num">{inr(v.cost)}</td><td className="num">{inr(v.heads ? v.cost / v.heads : 0)}</td></tr>)}</tbody></table>
          )}
          <div className="text-xs muted" style={{ marginTop: 8 }}>Payroll actual by month: {actual.byMonth.map((v, i) => `${fiscalMonthLabel(plan.fiscalYear, i + 1)} ${inr(v)}`).join(" · ")}</div>
        </Card>
      </div>
      <Card title="Approval history"><RequestsTable rows={requests} viewer={viewer} users={new Map(users.map((u) => [u.id, u.email]))} /></Card>
      <Card title="Audit trail"><AuditTable rows={audit} /></Card>
    </>
  );
}
