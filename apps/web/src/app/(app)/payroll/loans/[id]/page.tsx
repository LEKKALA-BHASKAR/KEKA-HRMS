import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { loanStatement, delegatorsOf } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can, viewerForUser } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue, Person, Stat, Callout } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { planTranchesAction, releaseTrancheAction, adminLoanAdjustmentAction } from "@/app/actions/loan-depth";
import { LoanDecision } from "../../_forms/loans";

const P = PERMISSIONS;
const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { SCHEDULED: "neutral", DEDUCTED: "success", PREPAID: "success", WAIVED: "info", SKIPPED: "warning", PLANNED: "neutral", PAID: "success", CANCELLED: "neutral", PENDING: "warning", APPLIED: "success", REJECTED: "danger", WITHDRAWN: "neutral" };

/** One loan for the loan desk: statement, disbursement tranches, adjustments and history. */
export default async function LoanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const loan = await prisma.loan.findFirst({ where: { id, employee: { tenantId: viewer.tenantId } }, include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!loan) notFound();
  const manage = can(viewer, P.LOAN_MANAGE) && canAccessEmployee(viewer, loan.employee, P.LOAN_MANAGE);
  let approve = loan.employeeId !== viewer.employee?.id && can(viewer, P.LOAN_APPROVE) && canAccessEmployee(viewer, loan.employee, P.LOAN_APPROVE);
  let delegate = false;
  if (!approve && loan.employeeId !== viewer.employee?.id) {
    for (const u of await delegatorsOf(viewer.tenantId, viewer.user.id, "LOAN_REQUEST")) {
      const v = await viewerForUser(u);
      if (v && can(v, P.LOAN_APPROVE) && canAccessEmployee(v, loan.employee, P.LOAN_APPROVE)) { approve = true; delegate = true; break; }
    }
  }
  if (!manage && !approve) notFound();
  const st = (await loanStatement(viewer.tenantId, id))!;
  const l = st.loan;
  const history = await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: { in: ["Loan", "LoanAdjustment"] }, OR: [{ entityId: id }, { entityId: { in: st.adjustments.map((a) => a.id) } }] }, orderBy: { createdAt: "desc" }, take: 40 });
  const upcoming = l.schedule.filter((i) => i.status === "SCHEDULED").slice(0, 6).map((i) => ({ value: `${i.year}-${String(i.month).padStart(2, "0")}`, label: `${i.month}/${i.year}` }));
  const live = ["ACTIVE", "DISBURSED"].includes(l.status);
  return (
    <>
      <PageHead title={`${l.employee.displayName}: ${l.category.name}`} subtitle={`${formatINR(Number(l.principal))} over ${l.installments} months · ${l.status.toLowerCase()}`}
        actions={<><Link className="btn" href={`/payroll/loans/${id}/statement`}>Statement CSV</Link><Link className="btn" href="/payroll/loans">All loans</Link></>} />
      {["REQUESTED", "PENDING_APPROVAL"].includes(l.status) && approve ? (
        <Card title="Decision" description={delegate ? "You are deciding as a delegate; it is recorded as such." : undefined}>
          {l.documentUrl ? <p className="text-sm">Supporting document: <a href={l.documentUrl}>open</a></p> : null}
          <LoanDecision loanId={l.id} />
        </Card>
      ) : null}
      <div className="grid grid-4" style={{ margin: "12px 0" }}>
        <Stat label="Principal" value={formatINR(st.totals.principal)} />
        <Stat label="Repaid" value={formatINR(st.totals.repaid)} />
        <Stat label="Outstanding" value={formatINR(st.totals.outstanding)} />
        <Stat label="Interest paid" value={formatINR(st.totals.interestPaid)} meta={st.totals.fee ? `fee ${formatINR(st.totals.fee)}` : undefined} />
      </div>
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          <Card tight title="Statement">
            {st.lines.length === 0 ? <Empty title="No schedule yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr>{st.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{st.lines.map((r, i) => <tr key={i}><td className="text-sm">{r.period}</td><td>{r.sequence}</td><td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge></td><td className="num">{formatINR(r.principal)}</td><td className="num">{formatINR(r.interest)}</td><td className="num">{formatINR(r.total)}</td><td className="num">{r.balance === null ? "" : formatINR(r.balance)}</td><td className="text-xs">{r.when ? formatDate(r.when) : ""}</td></tr>)}</tbody>
              </table></div>
            )}
          </Card>
          <Card tight title="Adjustments" description="Prepayments, settlements, reschedules, skipped EMIs and balance write-downs">
            {st.adjustments.length === 0 ? <Empty title="None" /> : (
              <div className="table-wrap"><table className="data"><thead><tr><th>When</th><th>Kind</th><th className="num">Amount</th><th>Reason</th><th>Status</th><th>Result</th></tr></thead>
                <tbody>{st.adjustments.map((a) => <tr key={a.id}><td className="text-sm nowrap">{formatDate(a.createdAt)}</td><td className="text-sm">{a.kind.toLowerCase()}</td><td className="num">{a.amount === null ? "—" : formatINR(Number(a.amount))}</td><td className="text-sm">{a.reason}</td><td><Badge tone={TONE[a.status] ?? "neutral"}>{a.status.toLowerCase()}</Badge></td><td className="text-xs">{a.result ?? ""}</td></tr>)}</tbody></table></div>
            )}
            {manage && live ? (
              <div style={{ padding: 12 }}>
                <Reveal label="Adjust this loan">
                  <GrowthForm action={adminLoanAdjustmentAction} hidden={{ loanId: id }} submitLabel="Apply" fields={[
                    { name: "kind", label: "Adjustment", type: "select", required: true, options: [{ value: "PREPAYMENT", label: "Part prepayment" }, { value: "SETTLEMENT", label: "Settle in full (foreclose)" }, { value: "RESCHEDULE", label: "Reschedule remaining EMIs" }, { value: "SKIP", label: "Skip an EMI" }, { value: "BALANCE", label: "Write down the balance" }] },
                    { name: "amount", label: "Amount (₹) — prepayment / write-down", type: "number" },
                    { name: "installments", label: "New number of EMIs — reschedule", type: "number" },
                    { name: "period", label: "EMI to skip", type: "select", options: upcoming },
                    { name: "keep", label: "After a prepayment keep", type: "select", options: [{ value: "EMI", label: "The EMI (finish sooner)" }, { value: "TENURE", label: "The tenure (lower EMI)" }], defaultValue: "EMI" },
                    { name: "reason", label: "Reason", required: true, wide: true },
                  ]} />
                </Reveal>
              </div>
            ) : null}
          </Card>
          <Card tight title="Audit trail">
            {history.length === 0 ? <Empty title="No entries" /> : <div className="table-wrap"><table className="data"><tbody>{history.map((h) => <tr key={h.id}><td className="text-xs nowrap">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{h.actorLabel}</td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>}
          </Card>
        </div>
        <div className="stack gap-4">
          <Card title="Loan">
            <Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} />
            <div className="divider" />
            <KeyValue items={[
              ["Type", `${l.category.name}${l.category.code ? ` (${l.category.code})` : ""}`],
              ["Interest", l.interestType === "NONE" ? "Interest-free" : `${Number(l.interestRate)}% ${l.interestType.toLowerCase()}`],
              ["EMI", formatINR(Number(l.emiAmount))],
              ["Processing fee", Number(l.processingFee) ? formatINR(Number(l.processingFee)) : "—"],
              ["Requested", formatDate(l.requestedAt)],
              ["Disbursed", l.disbursedAt ? formatDate(l.disbursedAt) : "—"],
              ["Document", l.documentUrl ? <a key="d" href={l.documentUrl}>open</a> : "—"],
              ["Purpose", l.purpose],
            ]} />
          </Card>
          <Card title="Disbursement schedule" description="Pay a large loan out in tranches; the first is released on disbursal.">
            {st.tranches.length === 0 ? <div className="text-sm subtle">Paid out in one go.</div> : (
              <div className="stack gap-1">{st.tranches.map((t) => (
                <div key={t.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                  <span className="text-sm">#{t.sequence} · {formatINR(Number(t.amount))} · {formatDate(t.plannedOn)}</span>
                  {t.status === "PLANNED" && manage && live ? <ActButton action={releaseTrancheAction} hidden={{ trancheId: t.id }} label="Release" /> : <Badge tone={TONE[t.status] ?? "neutral"}>{t.status.toLowerCase()}</Badge>}
                </div>
              ))}</div>
            )}
            {manage && l.status === "APPROVED" ? <div style={{ marginTop: 10 }}><Reveal label="Plan tranches"><GrowthForm action={planTranchesAction} hidden={{ loanId: id }} cols={1} compact submitLabel="Plan" fields={[{ name: "count", label: "Tranches", type: "number", required: true, defaultValue: 2 }, { name: "gapMonths", label: "Months between", type: "number", required: true, defaultValue: 1 }, { name: "firstOn", label: "First on", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) }]} /></Reveal></div> : null}
          </Card>
          {l.status === "REJECTED" && l.decisionNote ? <Callout tone="danger" title="Declined">{l.decisionNote}</Callout> : null}
        </div>
      </div>
    </>
  );
}
