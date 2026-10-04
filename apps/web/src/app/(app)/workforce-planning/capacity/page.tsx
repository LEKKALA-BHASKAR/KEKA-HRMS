import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { orgNames, capacitySupply } from "@/lib/workforce";
import { PageHead, Card, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar } from "@/components/workforce-tables";
import { saveCapacityPlanAction, saveCapacityLineAction, deleteCapacityLineAction, submitPlanningAction } from "@/app/actions/workforce-planning";

const P = PERMISSIONS;

export default async function CapacityPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.WORKFORCE_PLAN_VIEW);
  const sp = await searchParams;
  const q = sp.q?.trim();
  const canManage = can(viewer, P.WORKFORCE_PLAN_MANAGE);
  const [names, plans] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.capacityPlan.findMany({ where: { tenantId: viewer.tenantId, ...(sp.status ? { status: sp.status as never } : {}), ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, include: { lines: true }, orderBy: { periodStart: "desc" } }),
  ]);
  const supplied = await Promise.all(plans.map(async (p) => ({ p, rows: await capacitySupply(viewer.tenantId, p) })));
  const deptOpts = names.departments.map((d) => ({ value: d.id, label: d.name }));
  return (
    <>
      <PageHead title="Capacity planning" subtitle="FTE demand per role against today's supply of people in that role." actions={<a className="btn sm" href="/workforce-planning/export?report=capacity">Export CSV</a>} />
      <FilterBar action="/workforce-planning/capacity">
        <F label="Search"><input className="input" name="q" defaultValue={sp.q} /></F>
        <F label="Status"><Select name="status" options={["DRAFT", "PENDING_APPROVAL", "ACTIVE", "REJECTED"].map((s) => ({ value: s, label: s.toLowerCase().replace("_", " ") }))} defaultValue={sp.status} placeholder="Any" /></F>
      </FilterBar>
      {canManage ? (
        <Card title="New capacity plan"><Disclosure label="Create capacity plan">
          <SimpleForm action={saveCapacityPlanAction} submitLabel="Create">
            <div className="grid grid-3">
              <F label="Name *"><input className="input" name="name" required /></F>
              <F label="Department"><Select name="departmentId" options={deptOpts} placeholder="All" /></F>
              <F label="From *"><input className="input" type="date" name="periodStart" required /></F>
              <F label="To *"><input className="input" type="date" name="periodEnd" required /></F>
              <F label="Notes"><input className="input" name="notes" /></F>
            </div>
          </SimpleForm>
        </Disclosure></Card>
      ) : null}
      {supplied.length === 0 ? <Empty title="No capacity plans yet." /> : supplied.map(({ p, rows }) => {
        const editable = canManage && (p.status === "DRAFT" || p.status === "REJECTED");
        return (
          <Card key={p.id} title={<>{p.name} <StatusPill status={p.status} /></>} description={`${p.departmentId ? names.dept.get(p.departmentId) : "All departments"} · ${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`}
            action={editable ? <ActionButton action={submitPlanningAction} hidden={{ kind: "capacity", id: p.id }} label="Submit for approval" variant="primary" /> : null}>
            {rows.length === 0 ? <Empty title="No roles yet." /> : (
              <table className="data"><thead><tr><th>Role</th><th>Department</th><th className="num">Demand FTE</th><th className="num">Supply FTE</th><th className="num">Gap</th><th className="num">Coverage</th><th>Status</th><th /></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}><td>{r.role}</td><td>{r.departmentId ? names.dept.get(r.departmentId) : "All"}</td><td className="num">{r.demand}</td><td className="num">{r.supply}</td><td className="num">{r.gap.gap}</td><td className="num">{r.gap.coveragePct}%</td><td className="text-xs">{r.gap.status.toLowerCase()}</td>
                    <td>{editable ? <ActionButton action={deleteCapacityLineAction} hidden={{ id: r.id }} label="Remove" /> : null}</td></tr>
                ))}</tbody></table>
            )}
            {editable ? (
              <div style={{ marginTop: 10 }}><SimpleForm action={saveCapacityLineAction} hidden={{ planId: p.id }} submitLabel="Add role" inline>
                <F label="Role (job title)"><input className="input" name="role" required /></F>
                <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={p.departmentId} placeholder="All" /></F>
                <F label="Demand FTE"><input className="input" type="number" step="0.5" min={0} name="demandFte" required /></F>
              </SimpleForm></div>
            ) : null}
          </Card>
        );
      })}
    </>
  );
}
