import { prisma } from "@keka/db";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, Progress } from "@/components/ui";
import { ApplyLoanForm } from "../../payroll/_forms/loans";

export default async function MyLoansPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <Callout tone="info" title="No employee record">This login is not linked to an employee record.</Callout>;
  const [loans, categories] = await Promise.all([
    prisma.loan.findMany({ where: { employeeId: viewer.employee.id }, include: { category: true, schedule: { orderBy: { sequence: "asc" } } }, orderBy: { requestedAt: "desc" } }),
    prisma.loanCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true, policyRules: { some: {} } }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHead title="My loans" subtitle="Salary advances and loans, repaid through payroll" />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Apply" description="Check the EMI and your eligibility before you submit.">
          {categories.length ? <ApplyLoanForm categories={categories.map((c) => ({ value: c.id, label: c.name }))} /> : <Empty title="No loan types are open" />}
        </Card>
        <div className="stack gap-4">
          {loans.length === 0 ? <Card><Empty title="No loans" /></Card> : loans.map((l) => {
            const paid = l.schedule.filter((i) => ["DEDUCTED", "PREPAID"].includes(i.status)).length;
            return (
              <Card key={l.id} title={`${l.category.name} — ${formatINR(Number(l.principal))}`}
                description={`${l.installments} × ${formatINR(Number(l.emiAmount))} · requested ${formatDate(l.requestedAt)}`}
                action={<Badge tone={["ACTIVE", "APPROVED"].includes(l.status) ? "success" : l.status === "REJECTED" ? "danger" : l.status === "PENDING_APPROVAL" ? "warning" : "neutral"}>{l.status.replace(/_/g, " ").toLowerCase()}</Badge>}>
                {l.decisionNote ? <div className="text-sm muted" style={{ marginBottom: 10 }}>{l.decisionNote}</div> : null}
                {l.schedule.length ? (
                  <>
                    <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                      <span className="text-sm">{paid} of {l.schedule.length} EMIs paid</span>
                      <span className="text-sm strong">{formatINR(Number(l.outstanding))} outstanding</span>
                    </div>
                    <Progress value={paid} max={l.schedule.length} />
                    <details style={{ marginTop: 10 }}>
                      <summary className="text-sm" style={{ cursor: "pointer" }}>Repayment schedule</summary>
                      <div className="table-wrap" style={{ marginTop: 8 }}>
                        <table className="data">
                          <thead><tr><th>#</th><th>Month</th><th className="num">Principal</th><th className="num">Interest</th><th className="num">EMI</th><th className="num">Balance</th><th /></tr></thead>
                          <tbody>
                            {l.schedule.map((i) => (
                              <tr key={i.id} style={i.status !== "SCHEDULED" ? { opacity: 0.6 } : undefined}>
                                <td className="num">{i.sequence}</td>
                                <td className="nowrap">{i.month}/{i.year}</td>
                                <td className="num">{formatINR(Number(i.principalPart))}</td>
                                <td className="num">{formatINR(Number(i.interestPart))}</td>
                                <td className="num">{formatINR(Number(i.totalAmount))}</td>
                                <td className="num">{formatINR(Number(i.balanceAfter))}</td>
                                <td className="text-xs">{i.status === "SCHEDULED" ? "" : i.status.toLowerCase()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </>
                ) : <div className="text-sm subtle">The schedule is created on approval.</div>}
              </Card>
            );
          })}
        </div>
      </div>
    </>
  );
}
