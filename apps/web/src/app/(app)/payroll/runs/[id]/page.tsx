import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatDate, formatINRCompact } from "@keka/shared";
import { explainRun } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { ExplainCard } from "@/components/explain";
import {
  PageHead, Card, Stat, Money, Badge, Empty, Callout, RunStatusBadge, Person,
} from "@/components/ui";
import {
  recalculateRun, setRunStep, lockRun, finalizeRun, releasePayslips,
  rollbackRun, withdrawApproval, approveLock,
} from "@/app/actions/payroll";
import { Step1, Step2, Step3, Step4, Step5, Step6 } from "./steps";
import { OffCycleView } from "./off-cycle-view";

const P = PERMISSIONS;

/** Keka's documented step names, in order. */
const STEPS = [
  { n: 1, label: "Leave, Attendance & Daily Wages", short: "Attendance" },
  { n: 2, label: "New Joinees & Exits", short: "Joiners & exits" },
  { n: 3, label: "Bonus, Salary Revisions & Overtime", short: "Bonus & revisions" },
  { n: 4, label: "Reimbursements, Ad-hoc Payments, Deductions", short: "Reimbursements" },
  { n: 5, label: "Salary on Hold & Arrears", short: "Holds & arrears" },
  { n: 6, label: "Overrides & Finalizing", short: "Overrides" },
];

export default async function PayrollRunPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const viewer = await requireAuth(P.PAYROLL_VIEW);
  const { id } = await params;
  const sp = await searchParams;

  const run = await prisma.payrollRun.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      payGroup: {
        include: {
          filingDetail: true,
          legalEntity: { select: { legalName: true } },
          approvalRules: { where: { isActive: true } },
        },
      },
      approvalRequests: { orderBy: { requestedAt: "desc" }, take: 1 },
      _count: { select: { payslips: true } },
    },
  });
  if (!run) notFound();
  if (run.type === "OFF_CYCLE") return <OffCycleView runId={run.id} viewer={viewer} />;

  const step = Math.min(6, Math.max(1, Number(sp.step ?? run.currentStep)));
  const editable = run.status !== "FINALIZED" && run.status !== "PENDING_APPROVAL";
  // Where this month stands in the books.
  const ledger = run.status === "FINALIZED" && can(viewer, P.LEDGER_VIEW)
    ? await prisma.ledgerEntry.findMany({ where: { tenantId: viewer.tenantId, sourceRefType: { in: ["PayrollRun", "PayrollRunPayment"] }, sourceRefId: run.id, status: "POSTED" }, select: { sourceRefType: true, entryNumber: true } })
    : null;
  const canRun = can(viewer, P.PAYROLL_RUN);

  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId: run.id },
    orderBy: { employee: { employeeNumber: "asc" } },
    include: {
      employee: {
        select: {
          id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true,
          jobTitleName: true, dateOfJoining: true, lastWorkingDay: true, status: true,
          department: { select: { name: true } },
          location: { select: { name: true, stateCode: true } },
        },
      },
      lines: { orderBy: { sequence: "asc" } },
    },
  });

  const releasedPayslips = await prisma.payslip.count({
    where: { runId: run.id, status: "RELEASED" },
  });
  const totalPayslips = run._count.payslips;

  const warnings = lines.flatMap((l) =>
    Array.isArray(l.errors) ? (l.errors as string[]).map((w) => ({ emp: l.employee, w })) : [],
  );

  const pendingRequest = run.approvalRequests[0]?.status === "PENDING"
    ? run.approvalRequests[0] : null;

  return (
    <>
      <PageHead
        title={`${formatPeriod(run.year, run.month)} payroll`}
        subtitle={
          <>
            {run.payGroup.name} · {run.payGroup.legalEntity.legalName} ·{" "}
            {formatDate(run.periodStart)} to {formatDate(run.periodEnd)}
            {run.payGroup.attendanceCutoffDay
              ? ` · attendance cut-off day ${run.payGroup.attendanceCutoffDay}`
              : ""}
            {run.attendanceFrom && run.attendanceTo
              ? ` · attendance counted ${formatDate(run.attendanceFrom)} to ${formatDate(run.attendanceTo)}`
              : ""}
          </>
        }
        actions={
          <>
            <RunStatusBadge status={run.status} />
            {editable && canRun ? (
              <form action={recalculateRun}>
                <input type="hidden" name="runId" value={run.id} />
                <button className="btn" type="submit">Recalculate</button>
              </form>
            ) : null}
            <Link className="btn" href={`/payroll/register?run=${run.id}`}>Pay register</Link>
          </>
        }
      />

      {/* --- Totals --- */}
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Employees" value={run.employeeCount} meta={`${lines.length} rows in the run`} />
        <Stat label="Gross earnings" value={formatINRCompact(Number(run.totalGross))} meta="Before deductions" />
        <Stat label="Deductions" value={formatINRCompact(Number(run.totalDeductions))} meta="PF, ESI, PT, LWF, TDS, recoveries" />
        <Stat label="Net payable" value={formatINRCompact(Number(run.totalNetPay))} meta={`Employer cost ${formatINRCompact(Number(run.totalEmployerCost))}`} />
      </div>

      {/* --- Why did it move? Reviewers ask this before they approve. --- */}
      <details style={{ marginBottom: 16 }}>
        <summary className="btn sm" style={{ listStyle: "none", display: "inline-flex" }}>Why did this month change?</summary>
        <div className="grid grid-2" style={{ marginTop: 12, alignItems: "start" }}>
          <ExplainCard title="Gross earnings" measure="Gross" explanation={await explainRun(run.id, "gross")} />
          <ExplainCard title="Net payable" measure="Net pay" explanation={await explainRun(run.id, "net")} />
        </div>
      </details>

      {/* --- Approval / status banners --- */}
      {pendingRequest ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title="Waiting for approval to lock">
            <p>
              Maker-checker is on for this pay group, so locking raised an approval request
              rather than locking directly. Further payroll processing is blocked while it is pending.
            </p>
            <div className="row gap-2" style={{ marginTop: 10 }}>
              {can(viewer, P.PAYROLL_APPROVE) ? (
                <>
                  <form action={approveLock}>
                    <input type="hidden" name="runId" value={run.id} />
                    <input type="hidden" name="decision" value="approve" />
                    <button className="btn primary sm" type="submit">Approve &amp; lock</button>
                  </form>
                  <form action={approveLock}>
                    <input type="hidden" name="runId" value={run.id} />
                    <input type="hidden" name="decision" value="reject" />
                    <button className="btn sm" type="submit">Reject</button>
                  </form>
                </>
              ) : null}
              {pendingRequest.requestedBy === viewer.user.id ? (
                <form action={withdrawApproval}>
                  <input type="hidden" name="runId" value={run.id} />
                  <button className="btn ghost sm" type="submit">Withdraw request</button>
                </form>
              ) : null}
            </div>
          </Callout>
        </div>
      ) : null}

      {run.status === "FINALIZED" ? (
        <div style={{ marginBottom: 16 }}>
          <Callout
            tone={releasedPayslips < totalPayslips ? "warning" : "success"}
            title={
              releasedPayslips < totalPayslips
                ? "Payroll is finalised — payslips are not fully released"
                : "Payroll finalised and all payslips released"
            }
          >
            <p>
              {totalPayslips} payslip{totalPayslips === 1 ? "" : "s"} generated,{" "}
              {releasedPayslips} released, {totalPayslips - releasedPayslips} still held.
            </p>
            {ledger ? (
              <p className="text-sm" style={{ marginTop: 6 }}>
                Ledger: {ledger.find((e) => e.sourceRefType === "PayrollRun")?.entryNumber ?? "accrual not posted"}
                {" · "}{ledger.find((e) => e.sourceRefType === "PayrollRunPayment") ? `paid ${ledger.find((e) => e.sourceRefType === "PayrollRunPayment")!.entryNumber}` : "salaries not yet paid"}
                {" · "}<Link href="/accounting">Accounting</Link>
              </p>
            ) : null}
            <div className="row gap-2" style={{ marginTop: 10 }}>
              <Link className="btn sm" href={`/payroll/runs/${run.id}/payouts`}>Payouts, holds &amp; payslips</Link>
              {releasedPayslips < totalPayslips && can(viewer, P.PAYSLIP_RELEASE) ? (
                <form action={releasePayslips}>
                  <input type="hidden" name="runId" value={run.id} />
                  <button className="btn primary sm" type="submit">Release payslips</button>
                </form>
              ) : null}
              {can(viewer, P.PAYROLL_ROLLBACK) ? (
                <form action={rollbackRun} className="row gap-2">
                  <input type="hidden" name="runId" value={run.id} />
                  <input className="input sm" name="reason" placeholder="Reason for rollback" style={{ width: 220, padding: "4px 9px", fontSize: 12 }} />
                  <button className="btn danger sm" type="submit">Roll back</button>
                </form>
              ) : null}
            </div>
          </Callout>
        </div>
      ) : null}

      {warnings.length > 0 && step === 6 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${warnings.length} calculation warning${warnings.length === 1 ? "" : "s"}`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.slice(0, 8).map((x, i) => (
                <li key={i}>{x.emp.employeeNumber} {x.emp.displayName}: {x.w}</li>
              ))}
            </ul>
            {warnings.length > 8 ? <p className="text-sm" style={{ marginTop: 6 }}>…and {warnings.length - 8} more.</p> : null}
          </Callout>
        </div>
      ) : null}

      {/* --- Stepper --- */}
      <div className="stepper no-print" style={{ marginBottom: 18 }}>
        {STEPS.map((s) => (
          <Link
            key={s.n}
            href={`/payroll/runs/${run.id}?step=${s.n}`}
            className={`step${step === s.n ? " active" : ""}${step > s.n ? " done" : ""}`}
          >
            <span className="step-num">{step > s.n ? "✓" : s.n}</span>
            <span>
              <span className="step-label">{s.short}</span>
              <span className="step-meta">{s.label}</span>
            </span>
          </Link>
        ))}
      </div>

      {/* --- Step body --- */}
      {step === 1 ? <Step1 run={run} lines={lines} editable={editable && canRun} /> : null}
      {step === 2 ? <Step2 run={run} lines={lines} editable={editable && canRun} /> : null}
      {step === 3 ? <Step3 run={run} lines={lines} editable={editable && canRun} /> : null}
      {step === 4 ? <Step4 run={run} lines={lines} editable={editable && canRun} viewer={viewer} /> : null}
      {step === 5 ? <Step5 run={run} lines={lines} editable={editable && canRun} /> : null}
      {step === 6 ? <Step6 run={run} lines={lines} editable={editable && canRun} viewer={viewer} /> : null}

      {/* --- Step navigation --- */}
      <div className="row gap-2 no-print" style={{ marginTop: 18, justifyContent: "space-between" }}>
        <div>
          {step > 1 ? (
            <Link className="btn" href={`/payroll/runs/${run.id}?step=${step - 1}`}>
              Back to step {step - 1}
            </Link>
          ) : null}
        </div>
        <div className="row gap-2">
          {step < 6 ? (
            canRun && editable ? (
              <form action={setRunStep}>
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="step" value={step + 1} />
                <button className="btn primary" type="submit">Save &amp; continue</button>
              </form>
            ) : (
              <Link className="btn primary" href={`/payroll/runs/${run.id}?step=${step + 1}`}>
                Next step
              </Link>
            )
          ) : (
            <>
              {run.status === "IN_PROGRESS" || run.status === "DRAFT" ? (
                can(viewer, P.PAYROLL_LOCK) ? (
                  <form action={lockRun}>
                    <input type="hidden" name="runId" value={run.id} />
                    <button className="btn primary lg" type="submit">
                      {run.payGroup.approvalWorkflowEnabled &&
                       run.payGroup.approvalRules.some((r) => r.action === "LOCK_PAYROLL")
                        ? "Lock & Send for Approval"
                        : "Lock payroll"}
                    </button>
                  </form>
                ) : (
                  <span className="text-sm muted">You do not have permission to lock payroll.</span>
                )
              ) : null}

              {run.status === "LOCKED" ? (
                can(viewer, P.PAYROLL_LOCK) ? (
                  <form action={finalizeRun}>
                    <input type="hidden" name="runId" value={run.id} />
                    <button className="btn primary lg" type="submit">Save &amp; Close — finalise month</button>
                  </form>
                ) : null
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
