import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatPeriod } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { PageHead, Card, Stat, Money, Badge, Empty, RunStatusBadge, Callout } from "@/components/ui";
import { AddOffCycleItemForm, RemoveOffCycleItem, ToggleOffCycleBonus, FinalizeOffCycle, ReleaseOffCycle, RollbackOffCycle } from "../../_forms/off-cycle";

const P = PERMISSIONS;

/** An off-cycle payroll: what is being paid to whom, then finalise. */
export async function OffCycleView({ runId, viewer }: { runId: string; viewer: Viewer }) {
  const run = await prisma.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      payGroup: { select: { name: true } }, baseRun: { select: { id: true } },
      lines: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true } }, lines: { orderBy: { sequence: "asc" } } }, orderBy: { employee: { employeeNumber: "asc" } } },
      _count: { select: { payslips: true } },
    },
  });
  const ids = run.lines.map((l) => l.employeeId);
  const editable = run.status !== "FINALIZED" && can(viewer, P.PAYROLL_RUN);
  const [items, bonuses, released] = await Promise.all([
    prisma.adhocTransaction.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
    prisma.employeeBonus.findMany({
      where: { employeeId: { in: ids }, isProcessed: false, payAction: { not: "VOID" }, OR: [{ runId: null }, { runId }] },
      include: { bonusType: { select: { name: true } } },
      orderBy: [{ payoutYear: "asc" }, { payoutMonth: "asc" }],
    }),
    prisma.payslip.count({ where: { runId, status: "RELEASED" } }),
  ]);
  const name = new Map(run.lines.map((l) => [l.employeeId, `${l.employee.employeeNumber} — ${l.employee.displayName ?? ""}`]));
  const reason = (run.stepState as { reason?: string } | null)?.reason;

  return (
    <>
      <PageHead
        title={`Off-cycle payroll ${run.sequence} · ${formatPeriod(run.year, run.month)}`}
        subtitle={<>{run.payGroup.name}{reason ? ` · ${reason}` : ""}{run.payDate ? ` · pays on ${formatDate(run.payDate)}` : ""} · <Link href={`/payroll/runs/${run.baseRunId}`}>regular run</Link></>}
        actions={<><RunStatusBadge status={run.status} />{run.status === "FINALIZED" ? <Link className="btn" href={`/payroll/runs/${run.id}/payouts`}>Payouts &amp; payslips</Link> : null}</>}
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Employees" value={String(run.employeeCount)} />
        <Stat label="Gross" value={<Money value={run.totalGross} />} />
        <Stat label="Deductions" value={<Money value={run.totalDeductions} />} meta="income tax and recoveries" />
        <Stat label="Net pay" value={<Money value={run.totalNetPay} />} />
      </div>

      <Card title="Bonuses" description="Scheduled or held bonuses for these people. Paying one here takes it off the monthly schedule." tight>
        {bonuses.length === 0 ? <Empty title="No unpaid bonuses for these employees" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Bonus</th><th>Scheduled for</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {bonuses.map((b) => (
                  <tr key={b.id}>
                    <td className="text-sm">{name.get(b.employeeId)}</td>
                    <td>{b.bonusType.name}{b.payAction === "ON_HOLD" ? <Badge tone="warning">On hold</Badge> : null}</td>
                    <td className="text-sm">{formatPeriod(b.payoutYear, b.payoutMonth)}</td>
                    <td className="num"><Money value={b.paidAmount ?? b.amount} /></td>
                    <td className="right">{editable ? <ToggleOffCycleBonus runId={run.id} bonusId={b.id} include={b.runId !== run.id} /> : b.runId === run.id ? <Badge tone="success">In this run</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ height: 16 }} />
      <Card title="Payments and deductions" tight>
        {items.length === 0 ? <Empty title="Nothing added yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Description</th><th>Kind</th><th className="num">Amount</th><th>Tax</th>{editable ? <th /> : null}</tr></thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{name.get(a.employeeId)}</td>
                    <td>{a.name}</td>
                    <td>{a.type === "PAYMENT" ? "Payment" : "Deduction"}</td>
                    <td className="num"><Money value={a.amount} /></td>
                    <td>{a.type === "DEDUCTION" ? "—" : a.taxTreatment === "NON_TAXABLE" ? <Badge tone="success">Not taxable</Badge> : <Badge tone="warning">Taxable</Badge>}</td>
                    {editable ? <td className="right"><RemoveOffCycleItem runId={run.id} itemId={a.id} /></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable ? <AddOffCycleItemForm runId={run.id} employees={run.lines.map((l) => ({ value: l.employeeId, label: name.get(l.employeeId) ?? "" }))} /> : null}
      </Card>

      <div style={{ height: 16 }} />
      <Card title="Outcome" tight>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Lines</th><th className="num">Gross</th><th className="num">TDS</th><th className="num">Net pay</th></tr></thead>
            <tbody>
              {run.lines.map((l) => (
                <tr key={l.id}>
                  <td className="text-sm">{name.get(l.employeeId)}</td>
                  <td className="text-xs muted">{l.lines.map((x) => `${x.name} ${Number(x.amount).toLocaleString("en-IN")}`).join(" · ") || "—"}</td>
                  <td className="num"><Money value={l.grossEarnings} /></td>
                  <td className="num"><Money value={l.tds} /></td>
                  <td className="num strong"><Money value={l.netPay} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ height: 16 }} />
      {run.status !== "FINALIZED" ? (
        can(viewer, P.PAYROLL_LOCK) ? <Card title="Finalise"><FinalizeOffCycle runId={run.id} /></Card> : null
      ) : (
        <Card title="Finalised" description={`${run._count.payslips} payslip(s), ${released} released.`}>
          <div className="row gap-2 wrap">
            {can(viewer, P.PAYSLIP_RELEASE) && released < run._count.payslips ? <ReleaseOffCycle runId={run.id} /> : null}
            {can(viewer, P.PAYROLL_ROLLBACK) ? <RollbackOffCycle runId={run.id} /> : null}
          </div>
        </Card>
      )}
      {run.rolledBackAt ? <Callout tone="info" title="Rolled back before">{run.rollbackReason}</Callout> : null}
    </>
  );
}
