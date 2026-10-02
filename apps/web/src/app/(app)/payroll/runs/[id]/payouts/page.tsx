import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatDate, formatINRCompact } from "@keka/shared";
import { runPayoutSummary, releaseTargets, payableKey } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Stat, Money, Badge, Empty, Callout, Person } from "@/components/ui";
import { releasePayslips } from "@/app/actions/payroll";
import {
  holdSalaryAction, releaseHoldAction, undoReleaseAction, createBatchAction, markItemsAction, deleteBatchAction,
  verifyBankAccountAction, payslipReleaseAction,
} from "@/app/actions/payroll-payout";
import { PayoutForm } from "../../../_forms/payouts";

const P = PERMISSIONS;

/**
 * Paying a finalised run: salary holds and their release, payment batches
 * with a per-transfer outcome, bank-account checks, and payslip release.
 */
export default async function RunPayoutsPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_VIEW);
  const { id } = await params;
  const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { payGroup: { select: { name: true } } } });
  if (!run) notFound();
  const title = `${formatPeriod(run.year, run.month)}${run.type === "OFF_CYCLE" ? ` off-cycle ${run.sequence}` : ""} payouts`;
  const back = <Link className="btn" href={`/payroll/runs/${run.id}`}>Back to the run</Link>;

  if (run.status !== "FINALIZED") {
    return (
      <>
        <PageHead title={title} subtitle={run.payGroup.name} actions={back} />
        <Empty title="Payouts start once the payroll is finalised">
          Until then, hold a salary from step 5 of the run (Hold payout only). Salaries released into this run from earlier holds are paid once it is finalised.
        </Empty>
      </>
    );
  }

  const canPay = can(viewer, P.PAYROLL_LOCK), canHold = can(viewer, P.PAYROLL_RUN), canRelease = can(viewer, P.PAYSLIP_RELEASE);
  const [lines, heldHere, releasedIn, batches, payslips, summary] = await Promise.all([
    prisma.payrollRunEmployee.findMany({
      where: { runId: run.id }, orderBy: { employee: { employeeNumber: "asc" } },
      select: { employeeId: true, payAction: true, netPay: true, employee: { select: { employeeNumber: true, displayName: true } } },
    }),
    prisma.salaryHold.findMany({ where: { runId: run.id }, include: { employee: { select: { employeeNumber: true, displayName: true } }, releaseRun: { select: { id: true, year: true, month: true, type: true, sequence: true } } }, orderBy: { heldAt: "asc" } }),
    prisma.salaryHold.findMany({ where: { releaseRunId: run.id, NOT: { runId: run.id } }, include: { employee: { select: { employeeNumber: true, displayName: true } }, run: { select: { id: true, year: true, month: true } } } }),
    prisma.paymentBatch.findMany({ where: { runId: run.id }, orderBy: { number: "desc" }, include: { items: { include: { employee: { select: { employeeNumber: true, displayName: true } } }, orderBy: { employee: { employeeNumber: "asc" } } } } }),
    prisma.payslip.findMany({ where: { runId: run.id, isSegregated: false }, select: { employeeId: true, status: true, releasedAt: true } }),
    runPayoutSummary(run.id),
  ]);
  const payeeIds = [...new Set(summary.payables.map((p) => p.employeeId))];
  const accounts = await prisma.employeeBankAccount.findMany({
    where: { employeeId: { in: payeeIds }, isPrimary: true },
    include: { employee: { select: { employeeNumber: true, displayName: true } } },
    orderBy: { employee: { employeeNumber: "asc" } },
  });
  const noAccount = payeeIds.filter((e) => !accounts.some((a) => a.employeeId === e));
  const unverified = accounts.filter((a) => !a.isVerified);
  const firstHeld = heldHere.find((h) => h.status === "HELD");
  const targets = firstHeld ? await releaseTargets(firstHeld.id, viewer.tenantId) : [];
  const nameOf = new Map(lines.map((l) => [l.employeeId, `${l.employee.employeeNumber} — ${l.employee.displayName}`]));
  const stateOf = new Map<string, string>();
  for (const [k, list] of Object.entries(summary.state)) for (const p of list) stateOf.set(payableKey(p), k);
  const slipOf = new Map(payslips.map((p) => [p.employeeId, p]));
  const holdable = lines.filter((l) => l.payAction === "PROCESS_AS_SALARY" && Number(l.netPay) > 0 && stateOf.get(payableKey({ employeeId: l.employeeId, holdId: null })) !== "paid" && stateOf.get(payableKey({ employeeId: l.employeeId, holdId: null })) !== "pending");
  const runLabel = (r: { year: number; month: number; type: string; sequence: number }) => `${formatPeriod(r.year, r.month)}${r.type === "OFF_CYCLE" ? ` off-cycle ${r.sequence}` : ""}`;
  const released = payslips.filter((p) => p.status === "RELEASED").length;

  return (
    <>
      <PageHead
        title={title}
        subtitle={`${run.payGroup.name} · finalised ${formatDate(run.finalizedAt)}`}
        actions={<div className="row gap-2">{back}<a className="btn" href={`/payroll/runs/${run.id}/payslips-zip`}>Download all payslips (ZIP)</a></div>}
      />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="To pay" value={formatINRCompact(summary.totals.all)} meta={`${summary.payables.length} transfer(s)`} />
        <Stat label="Not yet batched" value={formatINRCompact(summary.totals.unbatched)} meta={`${summary.state.unbatched.length} transfer(s)`} />
        <Stat label="Paid" value={formatINRCompact(summary.totals.paid)} meta={`${summary.state.pending.length} awaiting the bank (${formatINRCompact(summary.totals.pending)})`} />
        <Stat label="Failed" value={formatINRCompact(summary.totals.failed)} meta={`${summary.state.failed.length} to re-batch`} />
      </div>

      {unverified.length || noAccount.length ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${unverified.length + noAccount.length} payee(s) without a verified bank account`}>
            Transfers to unverified accounts stay in the bank file but are flagged. Check a cancelled cheque or a penny-drop result, then mark the account verified below.
            {noAccount.length ? ` ${noAccount.length} have no primary account at all and will be left out: ${noAccount.map((e) => nameOf.get(e) ?? e).slice(0, 4).join(", ")}.` : ""}
          </Callout>
        </div>
      ) : null}

      <Card title="Payment batches" description="Split the run's transfers into bank files. Record each transfer's outcome; failures can be re-batched once the account is fixed — the new batch picks up the corrected account." tight>
        {canPay ? (
          <div className="row gap-2 wrap" style={{ padding: 14 }}>
            <PayoutForm action={createBatchAction} hidden={{ runId: run.id, mode: "UNBATCHED" }} label={`New batch of everyone not yet batched (${summary.state.unbatched.length})`} variant="primary" />
            {summary.state.failed.length ? <PayoutForm action={createBatchAction} hidden={{ runId: run.id, mode: "FAILED" }} label={`Re-batch failed transfers (${summary.state.failed.length})`} /> : null}
          </div>
        ) : null}
        {batches.length === 0 ? <Empty title="No batches yet" /> : batches.map((b) => {
          const pending = b.items.filter((i) => i.status === "PENDING");
          return (
            <div key={b.id} style={{ borderTop: "1px solid var(--border)", padding: 14 }}>
              <div className="row gap-2 wrap" style={{ alignItems: "center", marginBottom: 8 }}>
                <strong>Batch {b.number}</strong>
                <Badge tone={b.status === "CLOSED" ? "success" : "warning"}>{b.status === "CLOSED" ? "closed" : `${pending.length} awaiting outcome`}</Badge>
                <span className="text-xs subtle">{formatDate(b.createdAt)} · {b.items.length} transfer(s) · <Money value={b.items.reduce((s, i) => s + Number(i.amount), 0)} />{b.note ? ` · ${b.note}` : ""}</span>
                {canPay ? <a className="btn sm" href={`/payroll/runs/${run.id}/payouts/file?batch=${b.id}`}>Bank file</a> : null}
                {canPay && pending.length === b.items.length ? <PayoutForm action={deleteBatchAction} hidden={{ batchId: b.id }} label="Delete" variant="ghost" confirm="Delete this batch?" /> : null}
              </div>
              {(() => {
                const table = (
                  <div className="table-wrap" style={{ width: "100%" }}>
                    <table className="data">
                      <thead><tr><th /><th>Employee</th><th>Account</th><th className="num">Amount</th><th>Outcome</th></tr></thead>
                      <tbody>
                        {b.items.map((i) => (
                          <tr key={i.id}>
                            <td>{i.status === "PENDING" && canPay ? <input type="checkbox" name="itemIds" value={i.id} aria-label={`Select ${i.employee.displayName}`} /> : null}</td>
                            <td><Person name={i.employee.displayName ?? ""} meta={`${i.employee.employeeNumber}${i.salaryHoldId ? " · released hold" : ""}`} /></td>
                            <td className="text-sm">
                              {i.accountNumber ? <span className="mono">{i.ifsc} · XXXX{i.accountNumber.slice(-4)}</span> : <span className="neg">no account</span>}
                              {!i.accountVerified ? <> <Badge tone="warning">unverified</Badge></> : null}
                            </td>
                            <td className="num"><Money value={i.amount} /></td>
                            <td>
                              {i.status === "PAID" ? <Badge tone="success">paid{i.reference ? ` · ${i.reference}` : ""}</Badge>
                                : i.status === "FAILED" ? <><Badge tone="danger">failed</Badge> <span className="text-xs muted">{i.failureReason}</span></>
                                : <Badge>pending</Badge>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
                if (!canPay || pending.length === 0) return table;
                return (
                  <div className="stack gap-2">
                    <PayoutForm action={markItemsAction} hidden={{ batchId: b.id, status: "PAID" }} label="Mark ticked paid" inline={false}>
                      {table}
                      <input className="input" name="reference" placeholder="Bank reference / UTR (optional)" style={{ maxWidth: 260 }} />
                    </PayoutForm>
                    <details>
                      <summary className="text-sm" style={{ cursor: "pointer" }}>Mark transfers failed…</summary>
                      <PayoutForm action={markItemsAction} hidden={{ batchId: b.id, status: "FAILED" }} label="Mark failed" variant="danger">
                        <select className="select" name="itemIds" multiple required style={{ minWidth: 240, height: 90 }} aria-label="Transfers that failed">
                          {pending.map((i) => <option key={i.id} value={i.id}>{i.employee.employeeNumber} — {i.employee.displayName}</option>)}
                        </select>
                        <input className="input" name="failureReason" placeholder="Bank's reason, e.g. account closed" required style={{ maxWidth: 260 }} />
                      </PayoutForm>
                    </details>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </Card>

      <div className="grid grid-2" style={{ marginTop: 16, alignItems: "start" }}>
        <Card title={`Salary holds (${heldHere.length})`} description="A held salary stays out of every bank file. Release it into this run, a later run or an off-cycle run; that run's bank file then carries it." tight>
          {heldHere.length === 0 ? <Empty title="No salary is held in this run" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th className="num">Held</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {heldHere.map((h) => (
                    <tr key={h.id} style={{ verticalAlign: "top" }}>
                      <td><Person name={h.employee.displayName ?? ""} meta={`${h.employee.employeeNumber}${h.reason ? ` · ${h.reason}` : ""}`} /></td>
                      <td className="num"><Money value={h.amount} /></td>
                      <td>{h.status === "HELD" ? <Badge tone="warning">held</Badge> : <Badge tone="success">released to {h.releaseRun ? (h.releaseRun.id === run.id ? "this run" : runLabel(h.releaseRun)) : "—"}</Badge>}</td>
                      <td>
                        {canHold && h.status === "HELD" ? (
                          <PayoutForm action={releaseHoldAction} hidden={{ holdId: h.id }} label="Release">
                            <select className="select" name="targetRunId" defaultValue={run.id} aria-label="Release into" style={{ maxWidth: 200 }}>
                              {targets.map((t) => <option key={t.id} value={t.id}>{t.id === run.id ? "This run" : `${runLabel(t)} (${t.status.toLowerCase().replace("_", " ")})`}</option>)}
                            </select>
                          </PayoutForm>
                        ) : null}
                        {canHold && h.status === "RELEASED" ? <PayoutForm action={undoReleaseAction} hidden={{ holdId: h.id }} label="Hold again" variant="ghost" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canHold && holdable.length ? (
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
              <PayoutForm action={holdSalaryAction} hidden={{ runId: run.id }} label="Hold salary" variant="danger">
                <select className="select" name="employeeId" required style={{ maxWidth: 230 }} aria-label="Employee">
                  <option value="">Select employee…</option>
                  {holdable.map((l) => <option key={l.employeeId} value={l.employeeId}>{nameOf.get(l.employeeId)}</option>)}
                </select>
                <input className="input" name="reason" placeholder="Reason" required style={{ maxWidth: 200 }} />
              </PayoutForm>
            </div>
          ) : null}
          {releasedIn.length ? (
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
              <div className="text-sm strong" style={{ marginBottom: 6 }}>Released into this run from earlier holds</div>
              {releasedIn.map((h) => (
                <div key={h.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between" }}>
                  <span>{h.employee.employeeNumber} {h.employee.displayName} · held in <Link href={`/payroll/runs/${h.run.id}/payouts`}>{formatPeriod(h.run.year, h.run.month)}</Link></span>
                  <Money value={h.amount} />
                </div>
              ))}
            </div>
          ) : null}
        </Card>

        <Card title="Bank accounts" description="Verified by hand: someone has seen proof the account is the employee's." tight>
          {accounts.length === 0 ? <Empty title="No payees with a bank account" /> : (
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table className="data">
                <thead><tr><th>Employee</th><th>Account</th><th /></tr></thead>
                <tbody>
                  {[...unverified, ...accounts.filter((a) => a.isVerified)].map((a) => (
                    <tr key={a.id}>
                      <td className="text-sm">{a.employee.employeeNumber} {a.employee.displayName}</td>
                      <td className="text-sm"><span className="mono">{a.ifsc} · XXXX{a.accountNumber.slice(-4)}</span> {a.isVerified ? <Badge tone="success">verified{a.verifiedAt ? ` ${formatDate(a.verifiedAt)}` : ""}</Badge> : <Badge tone="warning">unverified</Badge>}</td>
                      <td>{canPay ? <PayoutForm action={verifyBankAccountAction} hidden={{ accountId: a.id, runId: run.id, verified: a.isVerified ? "0" : "1" }} label={a.isVerified ? "Unverify" : "Mark verified"} variant={a.isVerified ? "ghost" : undefined} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title={`Payslips (${released} of ${payslips.length} released)`} description="Employees see a payslip only once it is released. Withhold one to keep it back while the rest go out; 'Release all' leaves withheld payslips alone." tight>
        {canRelease && payslips.some((p) => p.status === "GENERATED" || p.status === "NOT_GENERATED") ? (
          <form action={releasePayslips} style={{ padding: 14 }}>
            <input type="hidden" name="runId" value={run.id} />
            <button className="btn primary sm" type="submit">Release all generated payslips</button>
          </form>
        ) : null}
        <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
          <table className="data">
            <thead><tr><th>Employee</th><th className="num">Net pay</th><th>Payslip</th><th /></tr></thead>
            <tbody>
              {lines.filter((l) => slipOf.has(l.employeeId)).map((l) => {
                const s = slipOf.get(l.employeeId)!;
                return (
                  <tr key={l.employeeId}>
                    <td className="text-sm">{nameOf.get(l.employeeId)}</td>
                    <td className="num"><Money value={l.netPay} /></td>
                    <td>{s.status === "RELEASED" ? <Badge tone="success">released</Badge> : s.status === "HELD" ? <Badge tone="danger">withheld</Badge> : <Badge>not released</Badge>}</td>
                    <td>
                      {canRelease ? (
                        <PayoutForm action={payslipReleaseAction} hidden={{ runId: run.id, employeeId: l.employeeId, release: s.status === "RELEASED" ? "0" : "1" }}
                          label={s.status === "RELEASED" ? "Withhold" : "Release"} variant={s.status === "RELEASED" ? "ghost" : undefined} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
