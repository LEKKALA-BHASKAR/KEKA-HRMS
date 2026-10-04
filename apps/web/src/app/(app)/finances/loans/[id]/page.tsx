import Link from "next/link";
import { notFound } from "next/navigation";
import { loanStatement } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { prisma } from "@keka/db";
import { PageHead, Card, Badge, Empty, KeyValue, Stat } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { updateLoanRequestAction, requestLoanAdjustmentAction } from "@/app/actions/loan-depth";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { SCHEDULED: "neutral", DEDUCTED: "success", PREPAID: "success", WAIVED: "info", SKIPPED: "warning", PENDING: "warning", APPLIED: "success", REJECTED: "danger", WITHDRAWN: "neutral", PLANNED: "neutral", PAID: "success" };
const ym = (y: number | null, m: number | null) => (y && m ? `${y}-${String(m).padStart(2, "0")}` : null);

/** My loan: the statement, changing a pending request, and asking for a prepayment, settlement, reschedule or skip. */
export default async function MyLoanPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  if (!viewer.employee) notFound();
  const own = await prisma.loan.findFirst({ where: { id, employeeId: viewer.employee.id, employee: { tenantId: viewer.tenantId } }, select: { id: true } });
  if (!own) notFound();
  const st = (await loanStatement(viewer.tenantId, id))!;
  const l = st.loan;
  const pendingRequest = ["REQUESTED", "PENDING_APPROVAL"].includes(l.status);
  const live = ["ACTIVE", "DISBURSED"].includes(l.status);
  const upcoming = l.schedule.filter((i) => i.status === "SCHEDULED").slice(0, 6).map((i) => ({ value: `${i.year}-${String(i.month).padStart(2, "0")}`, label: `${i.month}/${i.year}` }));
  return (
    <>
      <PageHead title={l.category.name} subtitle={`${formatINR(Number(l.principal))} over ${l.installments} months · ${l.status.toLowerCase().replace(/_/g, " ")}`}
        actions={<><a className="btn" href={`/payroll/loans/${id}/statement`}>Download statement</a><Link className="btn" href="/finances/loans">My loans</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <Stat label="EMI" value={formatINR(Number(l.emiAmount))} />
        <Stat label="Repaid" value={formatINR(st.totals.repaid)} />
        <Stat label="Outstanding" value={formatINR(st.totals.outstanding)} />
        <Stat label="Interest paid" value={formatINR(st.totals.interestPaid)} />
      </div>
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          {pendingRequest ? (
            <Card title="Change this request" description="You can change the amount, tenure or timing until it is decided.">
              <GrowthForm action={updateLoanRequestAction} hidden={{ loanId: id }} submitLabel="Update request" fields={[
                { name: "amount", label: "Amount (₹)", type: "number", required: true, defaultValue: Number(l.principal) },
                { name: "installments", label: "Months", type: "number", required: true, defaultValue: l.installments },
                { name: "expectedMonth", label: "Needed by (yyyy-mm)", placeholder: "2026-11", defaultValue: ym(l.expectedYear, l.expectedMonth) },
                { name: "startMonth", label: "First EMI (yyyy-mm)", placeholder: "2026-12", defaultValue: ym(l.startYear, l.startMonth) },
                { name: "purpose", label: "Purpose", defaultValue: l.purpose, wide: true },
                { name: "document", label: "Replace supporting document", type: "file" },
              ]} />
            </Card>
          ) : null}
          <Card tight title="Statement">
            {st.lines.length === 0 ? <Empty title="No repayment schedule yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr>{st.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{st.lines.map((r, i) => <tr key={i}><td className="text-sm">{r.period}</td><td>{r.sequence}</td><td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge></td><td className="num">{formatINR(r.principal)}</td><td className="num">{formatINR(r.interest)}</td><td className="num">{formatINR(r.total)}</td><td className="num">{r.balance === null ? "" : formatINR(r.balance)}</td><td className="text-xs">{r.when ? formatDate(r.when) : ""}</td></tr>)}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <div className="stack gap-4">
          <Card title="Details">
            <KeyValue items={[
              ["Interest", l.interestType === "NONE" ? "Interest-free" : `${Number(l.interestRate)}% ${l.interestType.toLowerCase()}`],
              ["Processing fee", Number(l.processingFee) ? formatINR(Number(l.processingFee)) : "—"],
              ["Requested", formatDate(l.requestedAt)],
              ["Paid out", l.disbursedAt ? formatDate(l.disbursedAt) : "—"],
              ["Document", l.documentUrl ? <a key="d" href={l.documentUrl}>open</a> : "—"],
              ["Decision note", l.decisionNote],
            ]} />
          </Card>
          {st.tranches.length ? (
            <Card title="Disbursements">
              <div className="stack gap-1">{st.tranches.map((t) => <div key={t.id} className="row gap-2" style={{ justifyContent: "space-between" }}><span className="text-sm">#{t.sequence} · {formatINR(Number(t.amount))} · {formatDate(t.plannedOn)}</span><Badge tone={TONE[t.status] ?? "neutral"}>{t.status.toLowerCase()}</Badge></div>)}</div>
            </Card>
          ) : null}
          <Card title="Changes to repayment" description="Requests go to the loan desk for approval.">
            {st.adjustments.length === 0 ? <div className="text-sm subtle">None yet.</div> : (
              <div className="stack gap-2">{st.adjustments.map((a) => (
                <div key={a.id}>
                  <div className="row gap-2" style={{ justifyContent: "space-between" }}><span className="text-sm strong">{a.kind.toLowerCase()}{a.amount === null ? "" : ` · ${formatINR(Number(a.amount))}`}</span><Badge tone={TONE[a.status] ?? "neutral"}>{a.status.toLowerCase()}</Badge></div>
                  <div className="text-xs subtle">{formatDate(a.createdAt)} · {a.reason}{a.result ? ` · ${a.result}` : ""}</div>
                </div>
              ))}</div>
            )}
            {live ? (
              <div style={{ marginTop: 10 }}>
                <Reveal label="Ask for a change">
                  <GrowthForm action={requestLoanAdjustmentAction} hidden={{ loanId: id }} cols={1} compact submitLabel="Send request" fields={[
                    { name: "kind", label: "I want to", type: "select", required: true, options: [{ value: "PREPAYMENT", label: "Prepay part of the loan" }, { value: "SETTLEMENT", label: "Settle it in full" }, { value: "RESCHEDULE", label: "Change the number of EMIs" }, { value: "SKIP", label: "Skip an EMI" }] },
                    { name: "amount", label: "Prepayment amount (₹)", type: "number" },
                    { name: "keep", label: "After prepaying keep", type: "select", options: [{ value: "EMI", label: "The EMI (finish sooner)" }, { value: "TENURE", label: "The tenure (lower EMI)" }], defaultValue: "EMI" },
                    { name: "installments", label: "New number of EMIs", type: "number" },
                    { name: "period", label: "EMI to skip", type: "select", options: upcoming },
                    { name: "reason", label: "Reason", required: true },
                  ]} />
                </Reveal>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
