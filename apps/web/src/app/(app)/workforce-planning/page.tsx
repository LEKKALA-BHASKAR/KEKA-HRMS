import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fiscalYearOf, fiscalYearLabel, PLAN_TEMPLATES, payrollActuals } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { orgNames, costOf, headcountVsPlan, riskHeatmap } from "@/lib/workforce";
import { PageHead, Card, Stat, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar, inr } from "@/components/workforce-tables";
import { savePlanAction } from "@/app/actions/workforce-planning";

const P = PERMISSIONS;
const RISK_BG: Record<string, string> = { HIGH: "#f8d7d3", MEDIUM: "#fbeccc", LOW: "#dff1e1" };

export default async function WorkforcePlanningPage({ searchParams }: { searchParams: Promise<{ fy?: string; q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_VIEW);
  const sp = await searchParams;
  const fy = Number(sp.fy) || fiscalYearOf(new Date());
  const q = sp.q?.trim();
  const [names, plans, actuals, risk] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.workforcePlan.findMany({
      where: { tenantId: viewer.tenantId, fiscalYear: fy, ...(sp.status ? { status: sp.status as never } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }] } : {}) },
      include: { lines: true }, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    }),
    payrollActuals(viewer.tenantId, fy),
    riskHeatmap(viewer.tenantId, fy),
  ]);
  const active = plans.filter((p) => p.isActive);
  const activeHc = (await Promise.all(active.map((p) => headcountVsPlan(viewer.tenantId, p)))).flat();
  const planned = activeHc.reduce((s, r) => s + r.planned, 0);
  const projected = activeHc.reduce((s, r) => s + r.projected, 0);
  const activeCost = active.reduce((s, p) => s + costOf(p).total, 0);
  const templates = await prisma.workforcePlan.findMany({ where: { tenantId: viewer.tenantId, isTemplate: true }, select: { id: true, name: true } });
  const deptOpts = names.departments.filter((d) => d.isActive).map((d) => ({ value: d.id, label: d.name }));

  return (
    <>
      <PageHead title="Workforce planning" subtitle={`${fiscalYearLabel(fy)} — plans, headcount against live data, cost and risk.`} actions={<>
        <a className="btn sm" href={`/workforce-planning/export?report=plans&fy=${fy}`}>Plans CSV</a>
        <a className="btn sm" href={`/workforce-planning/export?report=package&fy=${fy}`}>Plan export package</a>
      </>} />
      <FilterBar action="/workforce-planning">
        <F label="Fiscal year"><Select name="fy" options={[fy - 1, fy, fy + 1].map((y) => ({ value: String(y), label: fiscalYearLabel(y) }))} defaultValue={String(fy)} /></F>
        <F label="Search plans"><input className="input" name="q" defaultValue={sp.q} /></F>
        <F label="Status"><Select name="status" options={["DRAFT", "PENDING_APPROVAL", "ACTIVE", "REJECTED"].map((s) => ({ value: s, label: s === "ACTIVE" ? "approved" : s.toLowerCase().replace("_", " ") }))} defaultValue={sp.status} placeholder="Any" /></F>
      </FilterBar>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Planned headcount (plans in force)" value={planned} />
        <Stat label="Projected headcount" value={projected} meta="active + pre-joining − exiting + open requisitions" tone={projected > planned ? "neg" : undefined} />
        <Stat label="Planned cost (plans in force)" value={inr(activeCost)} />
        <Stat label="Payroll cost to date" value={inr(actuals.total)} meta="locked and finalised runs" />
      </div>

      {can(viewer, P.WORKFORCE_PLAN_MANAGE) ? (
        <Card title="New workforce plan">
          <Disclosure label="Create plan">
            <SimpleForm action={savePlanAction} submitLabel="Create plan">
              <div className="grid grid-3">
                <F label="Name *"><input className="input" name="name" required maxLength={120} /></F>
                <F label="Fiscal year *"><Select name="fiscalYear" options={[fy, fy + 1].map((y) => ({ value: String(y), label: fiscalYearLabel(y) }))} defaultValue={String(fy)} /></F>
                <F label="Department"><Select name="departmentId" options={deptOpts} placeholder="Whole organisation" /></F>
                <F label="Assumption template"><Select name="template" options={Object.entries(PLAN_TEMPLATES).map(([k, t]) => ({ value: k, label: t.label }))} placeholder="— None —" /></F>
                <F label="Copy lines from template plan"><Select name="copyFromId" options={templates.map((t) => ({ value: t.id, label: t.name }))} placeholder="— None —" /></F>
                <F label="Attrition %"><input className="input" type="number" step="0.1" name="attritionPct" min={0} max={100} /></F>
                <F label="Salary increase %"><input className="input" type="number" step="0.1" name="salaryIncreasePct" min={0} max={100} /></F>
                <F label="Benefits load %"><input className="input" type="number" step="0.1" name="benefitsLoadPct" min={0} max={100} /></F>
                <F label="Overtime %"><input className="input" type="number" step="0.1" name="overtimePct" min={0} max={100} /></F>
                <F label="Contractor cost (₹/yr)"><input className="input" type="number" name="contractorCost" min={0} /></F>
              </div>
              <F label="Notes"><textarea className="textarea" name="notes" /></F>
              <label className="checkbox-row"><input type="checkbox" name="isTemplate" /> <span className="text-sm">Save as a reusable template</span></label>
            </SimpleForm>
          </Disclosure>
        </Card>
      ) : null}

      <Card title="Plans">
        {plans.length === 0 ? <Empty title={`No plans for ${fiscalYearLabel(fy)}.`} /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Plan</th><th>Scope</th><th>Status</th><th className="num">Planned HC</th><th className="num">Hires</th><th className="num">Planned cost</th></tr></thead>
            <tbody>{plans.map((p) => {
              const c = costOf(p);
              return (
                <tr key={p.id}>
                  <td><Link href={`/workforce-planning/${p.id}`}>{p.name}</Link> {p.isActive ? <Badge tone="success">In force</Badge> : null} {p.isScenario ? <Badge tone="info">Scenario</Badge> : null} {p.isTemplate ? <Badge>Template</Badge> : null}</td>
                  <td>{p.departmentId ? names.dept.get(p.departmentId) : "Organisation"}</td><td><StatusPill status={p.status} /></td>
                  <td className="num">{c.headcount}</td><td className="num">{c.hires}</td><td className="num">{inr(c.total)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Workforce risk heatmap" description="By department: vacancy rate, share of the team on notice, and empty critical seats.">
        {risk.length === 0 ? <Empty title="No departments with people or plans yet." /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Department</th><th className="num">Planned</th><th className="num">Active</th><th className="num">On notice</th><th className="num">Vacant seats</th><th className="num">Critical vacant</th><th className="num">Risk score</th></tr></thead>
            <tbody>{risk.map((r) => (
              <tr key={r.departmentId} style={{ background: RISK_BG[r.level] }}>
                <td>{names.dept.get(r.departmentId) ?? "—"}</td><td className="num">{r.planned}</td><td className="num">{r.active}</td><td className="num">{r.exiting}</td><td className="num">{r.vacant}</td><td className="num">{r.criticalVacant}</td><td className="num"><strong>{r.score}</strong> {r.level.toLowerCase()}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Headcount vs plans in force">
        {activeHc.length === 0 ? <Empty title="No plan is in force for this year.">Approve a plan and activate it to track hiring against it.</Empty> : (
          <table className="data"><thead><tr><th>Department</th><th className="num">Planned</th><th className="num">Active</th><th className="num">Pre-joining</th><th className="num">Exiting</th><th className="num">Open reqs</th><th className="num">Projected</th><th className="num">Gap</th><th>Status</th></tr></thead>
            <tbody>{activeHc.map((r) => (
              <tr key={r.departmentId}><td>{names.dept.get(r.departmentId)}</td><td className="num">{r.planned}</td><td className="num">{r.active}</td><td className="num">{r.preJoining}</td><td className="num">{r.exiting}</td><td className="num">{r.openRequisitions}</td><td className="num">{r.projected}</td><td className="num">{r.gap}</td><td className="text-xs">{r.status.replace("_", " ").toLowerCase()}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
    </>
  );
}
