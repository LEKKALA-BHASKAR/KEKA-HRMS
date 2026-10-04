import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { orgNames, positionRows } from "@/lib/workforce";
import { PageHead, Card, Stat, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select, CheckList } from "@/components/workforce-ui";
import { StatusPill, FilterBar, inr } from "@/components/workforce-tables";
import { savePositionAction, bulkUpdatePositionsAction } from "@/app/actions/positions";
import { PositionFields } from "./fields";

const P = PERMISSIONS;
const STATUSES = ["PROPOSED", "VACANT", "FILLED", "FROZEN", "CLOSED", "REJECTED"];

export default async function PositionsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; departmentId?: string; criticality?: string }> }) {
  const viewer = await requireAuth(P.POSITION_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.POSITION_MANAGE);
  const [names, rows, counts, allPositions] = await Promise.all([
    orgNames(viewer.tenantId),
    positionRows(viewer.tenantId, sp),
    prisma.position.groupBy({ by: ["status"], where: { tenantId: viewer.tenantId }, _count: { _all: true }, _sum: { budgetedAnnualSalary: true } }),
    prisma.position.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["CLOSED", "REJECTED"] } }, select: { id: true, code: true, title: true }, orderBy: { code: "asc" } }),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const budget = counts.filter((c) => ["VACANT", "FILLED", "FROZEN"].includes(c.status)).reduce((s, c) => s + Number(c._sum.budgetedAnnualSalary ?? 0), 0);
  const opt = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => ({ value: x.id, label: x.name }));
  const opts = {
    jobs: names.jobs.filter((j) => j.status !== "RETIRED").map((j) => ({ value: j.id, label: `${j.code} ${j.title}${j.status !== "ACTIVE" ? ` (${j.status.toLowerCase()})` : ""}` })),
    departments: opt(names.departments.filter((d) => d.isActive)), locations: opt(names.locations.filter((l) => l.isActive)),
    costCenters: opt(names.costCenters), payGrades: opt(names.payGrades),
    positions: allPositions.map((p) => ({ value: p.id, label: `${p.code} ${p.title}` })),
  };
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => !!v) as Array<[string, string]>).toString();

  return (
    <>
      <PageHead
        title="Positions"
        subtitle="Budgeted seats: each a job in a department, location and cost centre — vacant, filled, frozen or closed."
        actions={<a className="btn sm" href={`/positions/export?report=positions${qs ? `&${qs}` : ""}`}>Export CSV</a>}
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Filled" value={count("FILLED")} />
        <Stat label="Vacant" value={count("VACANT")} meta={`${count("FROZEN")} frozen`} />
        <Stat label="Awaiting approval" value={count("PROPOSED")} />
        <Stat label="Budgeted salary (open seats)" value={inr(budget)} />
      </div>

      {canManage ? (
        <Card title="Request a position" description="A new position opens (as vacant) once a position approver approves it.">
          <Disclosure label="New position">
            <SimpleForm action={savePositionAction} submitLabel="Send for approval">
              <PositionFields opts={opts} creating />
            </SimpleForm>
          </Disclosure>
        </Card>
      ) : null}

      <Card title="All positions">
        <FilterBar action="/positions">
          <F label="Search"><input className="input" name="q" defaultValue={sp.q} placeholder="Code, title, job or skill" /></F>
          <F label="Status"><Select name="status" options={STATUSES.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }))} defaultValue={sp.status} placeholder="Any" /></F>
          <F label="Department"><Select name="departmentId" options={opts.departments} defaultValue={sp.departmentId} placeholder="Any" /></F>
          <F label="Criticality"><Select name="criticality" options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((v) => ({ value: v, label: v }))} defaultValue={sp.criticality} placeholder="Any" /></F>
        </FilterBar>
        {rows.length === 0 ? <Empty title="No positions match.">Request one above.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Control no.</th><th>Title / job</th><th>Department</th><th>Location</th><th>Incumbent</th><th>Status</th><th>Criticality</th><th className="num">Budget</th><th>Effective</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="mono"><Link href={`/positions/${p.id}`}>{p.code}</Link></td>
                    <td>{p.title}{p.job ? <div className="text-xs muted">{p.job.code} {p.job.title}</div> : null}</td>
                    <td>{p.departmentId ? names.dept.get(p.departmentId) : "—"}</td>
                    <td>{p.locationId ? names.loc.get(p.locationId) : "—"}<div className="text-xs muted">{p.workMode.toLowerCase()}</div></td>
                    <td>{p.incumbentEmployeeId ? names.emp.get(p.incumbentEmployeeId) : <span className="muted">—</span>}</td>
                    <td><StatusPill status={p.status} /></td>
                    <td className="text-xs">{p.criticality}</td>
                    <td className="num">{inr(p.budgetedAnnualSalary)}<div className="text-xs muted">{p.budgetStatus.toLowerCase()}</div></td>
                    <td className="text-xs">{formatDate(p.effectiveFrom)}{p.effectiveTo ? ` → ${formatDate(p.effectiveTo)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canManage && allPositions.length > 0 ? (
        <Card title="Bulk update" description="Change several positions at once; every change is audited per position.">
          <Disclosure label="Bulk update positions" variant="default">
            <SimpleForm action={bulkUpdatePositionsAction} submitLabel="Apply to selected">
              <CheckList name="ids" rows={allPositions.map((p) => ({ value: p.id, label: `${p.code} ${p.title}` }))} />
              <div className="grid grid-3">
                <F label="Department"><Select name="departmentId" options={opts.departments} placeholder="(unchanged)" /></F>
                <F label="Cost centre"><Select name="costCenterId" options={opts.costCenters} placeholder="(unchanged)" /></F>
                <F label="Pay grade"><Select name="payGradeId" options={opts.payGrades} placeholder="(unchanged)" /></F>
                <F label="Criticality"><Select name="criticality" options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((v) => ({ value: v, label: v }))} placeholder="(unchanged)" /></F>
                <F label="Work mode"><Select name="workMode" options={["ONSITE", "HYBRID", "REMOTE"].map((v) => ({ value: v, label: v }))} placeholder="(unchanged)" /></F>
                <F label="Budget change %"><input className="input" name="budgetChangePct" type="number" step="0.5" min={-50} max={100} /></F>
              </div>
            </SimpleForm>
          </Disclosure>
        </Card>
      ) : null}
    </>
  );
}
