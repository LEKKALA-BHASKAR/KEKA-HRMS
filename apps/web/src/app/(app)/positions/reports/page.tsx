import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { orgNames, vacancyReport, reconciliationReport } from "@/lib/workforce";
import { PageHead, Card, Stat, Empty } from "@/components/ui";
import { StatusPill, inr } from "@/components/workforce-tables";

export default async function PositionReportsPage() {
  const viewer = await requireAuth(PERMISSIONS.POSITION_VIEW);
  const [names, vacancy, recon, byDept] = await Promise.all([
    orgNames(viewer.tenantId),
    vacancyReport(viewer.tenantId),
    reconciliationReport(viewer.tenantId),
    prisma.position.groupBy({ by: ["departmentId", "status"], where: { tenantId: viewer.tenantId, isHeadcount: true }, _count: { _all: true }, _sum: { budgetedAnnualSalary: true, fte: true } }),
  ]);
  const depts = [...new Set(byDept.map((r) => r.departmentId))];
  const cell = (d: string | null, s: string) => byDept.find((r) => r.departmentId === d && r.status === s)?._count._all ?? 0;
  return (
    <>
      <PageHead title="Position reports" subtitle="Vacancy aging, headcount positions by department and position-to-headcount reconciliation." actions={<>
        <a className="btn sm" href="/positions/export?report=vacancy">Vacancy CSV</a>
        <a className="btn sm" href="/positions/export?report=headcount">Headcount CSV</a>
        <a className="btn sm" href="/positions/export?report=reconciliation">Reconciliation CSV</a>
      </>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Vacant 0–30 days" value={vacancy.aging.buckets["0-30"]} />
        <Stat label="31–60 days" value={vacancy.aging.buckets["31-60"]} />
        <Stat label="61–90 days" value={vacancy.aging.buckets["61-90"]} />
        <Stat label="Over 90 days" value={vacancy.aging.buckets["90+"]} meta={`average ${vacancy.aging.averageDays} days · oldest ${vacancy.aging.oldestDays}`} />
      </div>
      <Card title="Vacancy aging" description={`Budget tied up in vacant seats: ${inr(vacancy.vacantBudget)}`}>
        {vacancy.vacant.length === 0 ? <Empty title="No vacant or frozen positions." /> : (
          <table className="data"><thead><tr><th>Position</th><th>Department</th><th>Status</th><th>Vacant since</th><th className="num">Days</th><th>Reason</th><th>Criticality</th><th className="num">Budget</th></tr></thead>
            <tbody>{vacancy.vacant.map((p) => (
              <tr key={p.id}><td><Link href={`/positions/${p.id}`}>{p.code}</Link> {p.title}</td><td>{p.departmentId ? names.dept.get(p.departmentId) : "—"}</td><td><StatusPill status={p.status} /></td>
                <td>{formatDate(p.vacantSince)}</td><td className="num">{p.ageDays}</td><td className="text-xs">{p.vacancyReason ?? ""}</td><td className="text-xs">{p.criticality}</td><td className="num">{inr(p.budgetedAnnualSalary)}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
      <Card title="Headcount positions by department">
        {depts.length === 0 ? <Empty title="No headcount positions yet." /> : (
          <table className="data"><thead><tr><th>Department</th><th className="num">Proposed</th><th className="num">Filled</th><th className="num">Vacant</th><th className="num">Frozen</th><th className="num">Approved seats</th><th className="num">Budget (open seats)</th></tr></thead>
            <tbody>{depts.map((d) => {
              const budget = byDept.filter((r) => r.departmentId === d && ["FILLED", "VACANT", "FROZEN"].includes(r.status)).reduce((s, r) => s + Number(r._sum.budgetedAnnualSalary ?? 0), 0);
              return <tr key={d ?? "none"}><td>{d ? names.dept.get(d) : "No department"}</td><td className="num">{cell(d, "PROPOSED")}</td><td className="num">{cell(d, "FILLED")}</td><td className="num">{cell(d, "VACANT")}</td><td className="num">{cell(d, "FROZEN")}</td>
                <td className="num">{cell(d, "FILLED") + cell(d, "VACANT") + cell(d, "FROZEN")}</td><td className="num">{inr(budget)}</td></tr>;
            })}</tbody></table>
        )}
      </Card>
      <Card title="Position-to-headcount reconciliation" description="Active employees vs filled headcount positions. Employees without seats need a position; seats without employees point at stale incumbents.">
        <table className="data"><thead><tr><th>Department</th><th className="num">Active employees</th><th className="num">Filled positions</th><th className="num">Vacant positions</th><th className="num">Difference</th><th>Status</th></tr></thead>
          <tbody>{recon.map((r) => (
            <tr key={r.departmentId ?? "none"}><td>{r.departmentId ? names.dept.get(r.departmentId) : "No department"}</td><td className="num">{r.activeEmployees}</td><td className="num">{r.filledPositions}</td><td className="num">{r.vacantPositions}</td><td className="num">{r.unpositioned}</td><td className="text-xs">{r.status.replace(/_/g, " ").toLowerCase()}</td></tr>
          ))}</tbody></table>
      </Card>
    </>
  );
}
