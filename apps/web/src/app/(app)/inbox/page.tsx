import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS, hasPermission } from "@keka/rbac";
import { formatDate, formatPeriod } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Money, Person } from "@/components/ui";

const P = PERMISSIONS;

export default async function InboxPage() {
  const viewer = await requireViewer();

  // Only fetch what this viewer could actually act on.
  const [leaveRequests, payrollApprovals, loanRequests, claims] = await Promise.all([
    can(viewer, P.LEAVE_APPROVE)
      ? prisma.leaveRequest.findMany({
          where: {
            tenantId: viewer.tenantId,
            status: "PENDING",
            ...(viewer.allReportIds.size > 0 && !viewer.permissions.has(P.LEAVE_MANAGE)
              ? { employeeId: { in: [...viewer.allReportIds] } }
              : {}),
          },
          include: {
            leaveType: { select: { name: true, isPaid: true } },
          },
          orderBy: { fromDate: "asc" },
          take: 20,
        })
      : Promise.resolve([]),
    can(viewer, P.PAYROLL_APPROVE)
      ? prisma.payrollApprovalRequest.findMany({
          where: { status: "PENDING", run: { tenantId: viewer.tenantId } },
          include: { run: { select: { id: true, year: true, month: true, totalNetPay: true, payGroup: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
    can(viewer, P.LOAN_APPROVE)
      ? prisma.loan.findMany({
          where: {
            status: { in: ["REQUESTED", "PENDING_APPROVAL"] },
            employee: { tenantId: viewer.tenantId },
          },
          include: {
            category: { select: { name: true } },
            employee: { select: { id: true, displayName: true, employeeNumber: true } },
          },
        })
      : Promise.resolve([]),
    can(viewer, P.PAYROLL_RUN)
      ? prisma.componentClaim.findMany({
          where: { status: "SUBMITTED", employee: { tenantId: viewer.tenantId } },
          include: {
            component: { select: { name: true } },
            employee: { select: { id: true, displayName: true, employeeNumber: true } },
          },
          take: 20,
        })
      : Promise.resolve([]),
  ]);

  const employeeIds = leaveRequests.map((r) => r.employeeId);
  const employees = employeeIds.length > 0
    ? await prisma.employee.findMany({
        where: { id: { in: employeeIds } },
        select: { id: true, displayName: true, employeeNumber: true },
      })
    : [];
  const empById = new Map(employees.map((e) => [e.id, e]));

  const total = leaveRequests.length + payrollApprovals.length + loanRequests.length + claims.length;

  return (
    <>
      <PageHead
        title="Inbox"
        subtitle={total === 0 ? "Nothing waiting on you" : `${total} item${total === 1 ? "" : "s"} waiting on you`}
      />

      {total === 0 ? (
        <Card>
          <Empty title="Your inbox is clear">
            Approvals routed to your roles appear here — leave, payroll locks, loans and claims.
          </Empty>
        </Card>
      ) : (
        <div className="stack gap-4">
          {payrollApprovals.length > 0 ? (
            <Card title={`Payroll locks awaiting approval (${payrollApprovals.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Period</th><th>Pay group</th><th className="num">Net payable</th><th>Requested</th><th /></tr></thead>
                  <tbody>
                    {payrollApprovals.map((a) => (
                      <tr key={a.id}>
                        <td className="strong">{a.run ? formatPeriod(a.run.year, a.run.month) : "—"}</td>
                        <td className="text-sm">{a.run?.payGroup.name}</td>
                        <td className="num"><Money value={a.run?.totalNetPay ?? 0} compact /></td>
                        <td className="text-sm muted">{formatDate(a.requestedAt)}</td>
                        <td className="right">
                          {a.run ? <Link className="btn sm primary" href={`/payroll/runs/${a.run.id}?step=6`}>Review</Link> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {leaveRequests.length > 0 ? (
            <Card title={`Leave requests (${leaveRequests.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Impact</th></tr></thead>
                  <tbody>
                    {leaveRequests.map((r) => {
                      const emp = empById.get(r.employeeId);
                      return (
                        <tr key={r.id}>
                          <td>
                            {emp ? (
                              <Link href={`/employees/${emp.id}`}>
                                <Person name={emp.displayName ?? ""} meta={emp.employeeNumber} />
                              </Link>
                            ) : r.employeeId}
                          </td>
                          <td>{r.leaveType.name}</td>
                          <td className="nowrap">{formatDate(r.fromDate)}</td>
                          <td className="nowrap">{formatDate(r.toDate)}</td>
                          <td className="num">{Number(r.totalDays).toFixed(1)}</td>
                          <td>
                            {r.leaveType.isPaid
                              ? <Badge tone="success">Paid</Badge>
                              : <Badge tone="danger">Creates LOP</Badge>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {loanRequests.length > 0 ? (
            <Card title={`Loan requests (${loanRequests.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Category</th><th className="num">Principal</th><th className="num">EMI</th><th className="num">Months</th></tr></thead>
                  <tbody>
                    {loanRequests.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link href={`/employees/${l.employee.id}`}>
                            <Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} />
                          </Link>
                        </td>
                        <td>{l.category.name}</td>
                        <td className="num"><Money value={l.principal} /></td>
                        <td className="num"><Money value={l.emiAmount} /></td>
                        <td className="num">{l.installments}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {claims.length > 0 ? (
            <Card title={`Reimbursement claims (${claims.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Component</th><th className="num">Claimed</th></tr></thead>
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link href={`/employees/${c.employee.id}`}>
                            <Person name={c.employee.displayName ?? ""} meta={c.employee.employeeNumber} />
                          </Link>
                        </td>
                        <td>{c.component.name}</td>
                        <td className="num"><Money value={c.claimedAmount} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
