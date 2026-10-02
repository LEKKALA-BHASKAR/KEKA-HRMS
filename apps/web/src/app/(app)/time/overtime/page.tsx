import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, canAny } from "@/lib/context";
import { scopedEmployeeWhere, parseMonth, monthKey, shiftMonth } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Stat, Money } from "@/components/ui";
import { OvertimeDecision, OvertimeRate, AddOvertime } from "./forms";

const P = PERMISSIONS;
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Overtime for a pay month: approved overtime requests and hours added here,
 * each priced at its hourly rate and decided before payroll picks it up.
 */
export default async function OvertimePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.ATTENDANCE_MANAGE, P.PAYROLL_RUN])) forbidden();
  const sp = await searchParams;
  const { year, month } = parseMonth(sp.month);
  const scope = { OR: [scopedEmployeeWhere(viewer, P.ATTENDANCE_MANAGE), scopedEmployeeWhere(viewer, P.PAYROLL_RUN)] };
  const ids = (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id);
  const [entries, pendingRequests, employees] = await Promise.all([
    prisma.overtimeEntry.findMany({ where: { tenantId: viewer.tenantId, year, month, employeeId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    prisma.overtimeRequest.count({ where: { tenantId: viewer.tenantId, status: "PENDING", employeeId: { in: ids } } }),
    prisma.employee.findMany({ where: { AND: [scope, { status: { notIn: ["EXITED", "PREBOARDING"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
  ]);
  const name = new Map(employees.map((e) => [e.id, `${e.displayName} (${e.employeeNumber})`]));
  const missing = ids.filter((id) => entries.some((e) => e.employeeId === id) && !name.has(id));
  if (missing.length) for (const e of await prisma.employee.findMany({ where: { id: { in: missing } }, select: { id: true, displayName: true, employeeNumber: true } })) name.set(e.id, `${e.displayName} (${e.employeeNumber})`);
  const toPay = entries.filter((e) => e.payAction === "PAY");
  const prev = shiftMonth(year, month, -1), next = shiftMonth(year, month, 1);

  return (
    <>
      <PageHead title="Overtime" subtitle="Overtime going into payroll, by pay month. Approved overtime requests land here; you can also add hours directly." />
      <div className="grid grid-3">
        <Stat label="Hours to pay" value={toPay.reduce((s, e) => s + Number(e.hours), 0).toFixed(2)} />
        <Stat label="Amount to pay" value={<Money value={toPay.reduce((s, e) => s + Number(e.amount), 0)} />} />
        <Stat label="Requests waiting" value={pendingRequests} meta={pendingRequests ? <Link href="/attendance?tab=requests">Review them</Link> : undefined} />
      </div>
      <Card tight title={`${MONTHS[month]} ${year}`} action={
        <div className="row gap-2">
          <Link className="btn sm" href={`/time/overtime?month=${monthKey(prev.year, prev.month)}`}>‹ Prev</Link>
          <Link className="btn sm" href={`/time/overtime?month=${monthKey(next.year, next.month)}`}>Next ›</Link>
        </div>
      }>
        {entries.length === 0 ? <Empty title="No overtime for this month" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th className="num">Hours</th><th className="num">Rate / hr</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{name.get(e.employeeId) ?? "—"}</td>
                    <td className="num">{Number(e.hours).toFixed(2)}</td>
                    <td className="num">{e.isProcessed ? Number(e.rate).toFixed(2) : <OvertimeRate id={e.id} rate={Number(e.rate)} />}</td>
                    <td className="num"><Money value={e.amount} /></td>
                    <td>
                      {e.isProcessed ? <Link href={`/payroll/runs/${e.runId}`}><Badge tone="success">paid in payroll</Badge></Link>
                        : <Badge tone={e.payAction === "PAY" ? (Number(e.rate) > 0 ? "info" : "warning") : "neutral"}>{e.payAction === "PAY" ? (Number(e.rate) > 0 ? "to pay" : "needs a rate") : e.payAction === "VOID" ? "void" : "paid outside"}</Badge>}
                    </td>
                    <td className="right">{e.isProcessed ? null : <OvertimeDecision id={e.id} current={e.payAction} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Add overtime">
        <AddOvertime employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} · ${e.displayName}` }))} month={monthKey(year, month)} />
      </Card>
    </>
  );
}
