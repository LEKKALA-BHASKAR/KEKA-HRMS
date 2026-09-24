import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatINRCompact } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Stat, Card, Person, StatusBadge, RunStatusBadge, Money, Empty, Progress } from "@/components/ui";

const P = PERMISSIONS;

export default async function DashboardPage() {
  const viewer = await requireViewer();
  const now = new Date();

  const canSeePeople = can(viewer, P.EMPLOYEE_VIEW_ALL);
  const canSeePayroll = can(viewer, P.PAYROLL_VIEW);

  const [
    headcount, byStatus, newJoiners, onNotice, recentRuns, departments, myPayslip, myLeave,
  ] = await Promise.all([
    canSeePeople
      ? prisma.employee.count({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } } })
      : Promise.resolve(0),
    canSeePeople
      ? prisma.employee.groupBy({
          by: ["status"],
          where: { tenantId: viewer.tenantId },
          _count: true,
        })
      : Promise.resolve([] as Array<{ status: string; _count: number }>),
    canSeePeople
      ? prisma.employee.findMany({
          where: {
            tenantId: viewer.tenantId,
            dateOfJoining: { gte: new Date(now.getTime() - 120 * 86400000) },
          },
          orderBy: { dateOfJoining: "desc" },
          take: 5,
          select: {
            id: true, employeeNumber: true, displayName: true, jobTitleName: true,
            dateOfJoining: true, status: true,
            department: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    canSeePeople
      ? prisma.employee.count({ where: { tenantId: viewer.tenantId, status: "NOTICE_PERIOD" } })
      : Promise.resolve(0),
    canSeePayroll
      ? prisma.payrollRun.findMany({
          where: { tenantId: viewer.tenantId },
          orderBy: [{ year: "desc" }, { month: "desc" }],
          take: 4,
          include: { payGroup: { select: { name: true } } },
        })
      : Promise.resolve([]),
    canSeePeople
      ? prisma.department.findMany({
          where: { tenantId: viewer.tenantId },
          select: { id: true, name: true, _count: { select: { employees: true } } },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    viewer.employee
      ? prisma.payslip.findFirst({
          where: { employeeId: viewer.employee.id, status: "RELEASED" },
          orderBy: [{ year: "desc" }, { month: "desc" }],
        })
      : Promise.resolve(null),
    viewer.employee
      ? prisma.leaveBalance.findMany({
          where: { employeeId: viewer.employee.id },
          include: { leaveType: { select: { name: true, code: true } } },
          orderBy: { leaveType: { name: "asc" } },
          take: 4,
        })
      : Promise.resolve([]),
  ]);

  const statusCount = (s: string) =>
    byStatus.find((b) => b.status === s)?._count ?? 0;

  const maxDept = Math.max(1, ...departments.map((d) => d._count.employees));

  return (
    <>
      <PageHead
        title={`Good ${now.getUTCHours() < 12 ? "morning" : now.getUTCHours() < 17 ? "afternoon" : "evening"}, ${viewer.employee?.firstName ?? "there"}`}
        subtitle={
          viewer.roleNames.length > 0
            ? `Signed in as ${viewer.roleNames.join(" · ")}`
            : "Employee self-service"
        }
      />

      {canSeePeople ? (
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <Stat label="Headcount" value={headcount} meta={`${statusCount("CONFIRMED")} confirmed`} />
          <Stat label="On probation" value={statusCount("PROBATION")} meta="Pending confirmation" />
          <Stat label="Serving notice" value={onNotice} meta="Exit in progress" />
          <Stat label="Onboarding" value={statusCount("ONBOARDING") + statusCount("PREBOARDING")} meta="Not yet started" />
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {/* --- Self-service --- */}
        {viewer.employee ? (
          <Card
            title="My pay"
            description="Your most recently released payslip"
            action={<Link className="btn sm" href="/me/pay">View all</Link>}
          >
            {myPayslip ? (
              <div className="stack gap-3">
                <div className="row gap-4">
                  <div>
                    <div className="stat-label">Net pay</div>
                    <div className="stat-value sm"><Money value={myPayslip.netPay} /></div>
                  </div>
                  <div>
                    <div className="stat-label">Period</div>
                    <div className="stat-value sm">{formatPeriod(myPayslip.year, myPayslip.month)}</div>
                  </div>
                </div>
                <div className="text-sm muted">
                  Payslips are password protected. The password is your PAN in uppercase.
                </div>
              </div>
            ) : (
              <Empty title="No payslip released yet">
                Your first payslip appears here once payroll is finalised and released.
              </Empty>
            )}
          </Card>
        ) : null}

        {viewer.employee && myLeave.length > 0 ? (
          <Card title="My leave balances" action={<Link className="btn sm" href="/me/leave">Details</Link>}>
            <div className="stack gap-3">
              {myLeave.map((b) => (
                <div key={b.id}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <span className="text-sm strong">{b.leaveType.name}</span>
                    <span className="text-sm num">
                      {Number(b.available).toFixed(1)} / {Number(b.accrued).toFixed(1)} days
                    </span>
                  </div>
                  <Progress value={Number(b.available)} max={Math.max(1, Number(b.accrued))} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        {/* --- Payroll --- */}
        {canSeePayroll ? (
          <Card
            title="Payroll runs"
            description="Most recent pay periods"
            action={<Link className="btn sm" href="/payroll/runs">All runs</Link>}
          >
            {recentRuns.length === 0 ? (
              <Empty title="No payroll runs yet">
                Start your first run from the Run Payroll screen.
              </Empty>
            ) : (
              <div className="stack gap-2">
                {recentRuns.map((run) => (
                  <Link
                    key={run.id}
                    href={`/payroll/runs/${run.id}`}
                    className="row gap-3"
                    style={{
                      padding: "10px 12px", border: "1px solid var(--border)",
                      borderRadius: "var(--radius)", justifyContent: "space-between",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="strong text-sm">{formatPeriod(run.year, run.month)}</div>
                      <div className="text-xs subtle">{run.payGroup.name}</div>
                    </div>
                    <div className="row gap-3">
                      <div className="right">
                        <div className="text-sm num strong">{formatINRCompact(Number(run.totalNetPay))}</div>
                        <div className="text-xs subtle">{run.employeeCount} employees</div>
                      </div>
                      <RunStatusBadge status={run.status} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        ) : null}

        {/* --- People --- */}
        {canSeePeople && newJoiners.length > 0 ? (
          <Card title="Recent joiners" description="Last 120 days">
            <div className="stack gap-3">
              {newJoiners.map((e) => (
                <Link key={e.id} href={`/employees/${e.id}`} className="row gap-3" style={{ justifyContent: "space-between" }}>
                  <Person
                    name={e.displayName ?? ""}
                    meta={`${e.employeeNumber} · ${e.department?.name ?? "—"}`}
                  />
                  <div className="row gap-2">
                    <span className="text-xs subtle nowrap">
                      {e.dateOfJoining.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })}
                    </span>
                    <StatusBadge status={e.status} />
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        ) : null}

        {canSeePeople && departments.length > 0 ? (
          <Card title="Headcount by department">
            <div className="stack gap-3">
              {departments.filter((d) => d._count.employees > 0).map((d) => (
                <div key={d.id}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <span className="text-sm">{d.name}</span>
                    <span className="text-sm num strong">{d._count.employees}</span>
                  </div>
                  <Progress value={d._count.employees} max={maxDept} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
