import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fyStartYear, formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { ReopenFbp } from "../_forms/fbp";

const P = PERMISSIONS;

export default async function FbpAdminPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const currentFy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const fy = Number((await searchParams).fy) || currentFy;
  const scope = scopedEmployeeWhere(viewer, P.PAYROLL_RUN);
  const [decls, eligible] = await Promise.all([
    prisma.fbpDeclaration.findMany({
      where: { fyStartYear: fy, employee: scope },
      include: {
        employee: { select: { id: true, displayName: true, employeeNumber: true } },
        lines: { include: { component: { select: { name: true } } } },
      },
      orderBy: { submittedAt: "desc" },
    }),
    prisma.employee.count({ where: { ...scope, status: { not: "EXITED" }, salaryRevisions: { some: { status: "APPLIED", structure: { isPartOfFbp: true } } } } }),
  ]);
  const claimed = decls.length
    ? await prisma.componentClaim.groupBy({ by: ["employeeId"], where: { fyStartYear: fy, employeeId: { in: decls.map((d) => d.employeeId) }, status: { in: ["APPROVED", "PAID"] } }, _sum: { payableAmount: true } })
    : [];
  const claimedOf = new Map(claimed.map((c) => [c.employeeId, Number(c._sum.payableAmount ?? 0)]));
  const total = decls.reduce((s, d) => s + Number(d.totalAmount), 0);

  return (
    <>
      <PageHead title="Flexible benefits" subtitle="What employees on a flexible-benefit structure have declared for the year. Declarations lock on submission; reopen one to let the employee change it." />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Declared" value={`${decls.length} of ${eligible}`} meta="employees on a plan structure" />
        <Stat label="Total declared" value={formatINR(total)} meta="a year, carved out of Special Allowance" />
        <Stat label="Claimed so far" value={formatINR([...claimedOf.values()].reduce((a, b) => a + b, 0))} meta="approved or paid" />
      </div>
      <div className="tabs">
        {[currentFy, currentFy - 1].map((y) => <Link key={y} href={`/payroll/fbp?fy=${y}`} className={`tab${fy === y ? " active" : ""}`}>FY {y}–{String(y + 1).slice(2)}</Link>)}
      </div>
      <Card tight>
        {decls.length === 0 ? <Empty title="No declarations for this year" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Split</th><th className="num">Declared</th><th className="num">Claimed</th><th>Submitted</th><th /></tr></thead>
              <tbody>
                {decls.map((d) => (
                  <tr key={d.id}>
                    <td><Person name={d.employee.displayName ?? ""} meta={d.employee.employeeNumber} /></td>
                    <td className="text-sm">{d.lines.map((l) => `${l.component.name} ${formatINR(Number(l.annualAmount))}`).join(" · ")}</td>
                    <td className="num">{formatINR(Number(d.totalAmount))}</td>
                    <td className="num">{formatINR(claimedOf.get(d.employeeId) ?? 0)}</td>
                    <td className="nowrap text-sm">{formatDate(d.submittedAt)}</td>
                    <td className="right">{d.isLocked ? (fy === currentFy ? <ReopenFbp id={d.id} /> : <Badge tone="neutral">Closed</Badge>) : <Badge tone="warning">Open to change</Badge>}</td>
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
