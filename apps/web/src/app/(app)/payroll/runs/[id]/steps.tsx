import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate, formatPeriod } from "@keka/shared";
import { Card, Money, Badge, Empty, Callout, Person, StatusBadge } from "@/components/ui";
import {
  setPayAction, setLopAdjustment, addAdhoc, deleteAdhoc, setStatutoryOverride,
} from "@/app/actions/payroll";
import type { Viewer } from "@/lib/context";
import { bonusesForRun } from "@keka/services";
import { BonusDecision, ClaimDecision } from "../../_forms/bonuses";

/**
 * The six run steps.
 *
 * Each step is a server component that reads only what it needs and posts to a
 * server action. Every action recalculates the whole run afterwards, so a
 * change at step 1 is reflected in the step 6 totals immediately — which is
 * the behaviour a payroll admin expects and the reason the engine is a pure
 * function.
 */

type RunLike = {
  id: string; year: number; month: number;
  periodStart: Date; periodEnd: Date;
  attendanceFrom?: Date | null; attendanceTo?: Date | null;
  status: string;
  employeeCount: number;
  payGroup: {
    name: string;
    attendanceCutoffDay: number | null;
    pfEnabled: boolean; esiEnabled: boolean; ptEnabled: boolean; lwfEnabled: boolean;
    filingDetail: {
      pfWageCeiling: unknown; esiWageLimit: unknown;
      pfEmployeeRate: unknown; esiEmployeeRate: unknown; esiEmployerRate: unknown;
    } | null;
  };
};

type LineLike = {
  id: string; employeeId: string; payAction: string; comment: string | null;
  totalDays: number;
  payableDays: unknown; lopDays: unknown;
  attendanceLopDays?: unknown; carriedLopDays?: unknown; lopReversalDays?: unknown;
  grossEarnings: unknown; totalDeductions: unknown; netPay: unknown; employerCost: unknown;
  pfWage: unknown; pfEmployee: unknown; pfEmployer: unknown; epsEmployer: unknown; vpf: unknown;
  esiGross: unknown; esiEmployee: unknown; esiEmployer: unknown;
  professionalTax: unknown; lwfEmployee: unknown; lwfEmployer: unknown; tds: unknown;
  ptOverride: unknown; esiOverride: unknown; tdsOverride: unknown; lwfOverride: unknown;
  annualCtc: unknown;
  calculatedAt: Date | null;
  errors: unknown;
  employee: {
    id: string; employeeNumber: string; displayName: string | null;
    firstName: string; lastName: string; jobTitleName: string | null;
    dateOfJoining: Date; lastWorkingDay: Date | null; status: string;
    department: { name: string } | null;
    location: { name: string; stateCode: string | null } | null;
  };
  lines: Array<{
    id: string; code: string; name: string; type: string;
    fullAmount: unknown; amount: unknown; sequence: number;
  }>;
};

interface StepProps {
  run: RunLike;
  lines: LineLike[];
  editable: boolean;
}

const n = (v: unknown) => Number(v ?? 0);
const empName = (e: LineLike["employee"]) => e.displayName ?? `${e.firstName} ${e.lastName}`;

const PAY_ACTIONS = [
  { value: "PROCESS_AS_SALARY", label: "Process as salary" },
  { value: "HOLD_SALARY_PROCESSING", label: "Hold salary processing" },
  { value: "VOID_SALARY_PROCESSING", label: "Void processing" },
  { value: "HOLD_PAYOUT", label: "Hold payout" },
  { value: "VOID_PAYOUT", label: "Void payout" },
  { value: "ALREADY_PAID", label: "Already paid" },
];

// ===========================================================================
//  Step 1 — Leave, Attendance & Daily Wages
// ===========================================================================

export async function Step1({ run, lines, editable }: StepProps) {
  const employeeIds = lines.map((l) => l.employeeId);

  const [pendingLeave, adjustments, attendanceGaps] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: "PENDING",
        fromDate: { lte: run.periodEnd },
        toDate: { gte: run.periodStart },
      },
      include: {
        leaveType: { select: { name: true, isPaid: true } },
      },
      orderBy: { fromDate: "asc" },
    }),
    prisma.lopAdjustment.findMany({
      where: { employeeId: { in: employeeIds }, year: run.year, month: run.month },
      orderBy: [{ reversalForYear: "asc" }, { reversalForMonth: "asc" }],
    }),
    prisma.attendanceRecord.groupBy({
      by: ["employeeId"],
      where: {
        employeeId: { in: employeeIds },
        date: { gte: run.attendanceFrom ?? run.periodStart, lte: run.attendanceTo ?? run.periodEnd },
        status: "NO_ATTENDANCE",
      },
      _count: true,
    }),
  ]);

  // Carried rows (from closed months) are recalculated with the run; only
  // the manual adjustment is edited here.
  const adjByEmp = new Map(adjustments.filter((a) => a.reversalForYear === null).map((a) => [a.employeeId, a]));
  const carried = adjustments.filter((a) => a.reversalForYear !== null && a.runId === run.id);
  const windowFrom = run.attendanceFrom ?? run.periodStart, windowTo = run.attendanceTo ?? run.periodEnd;
  const gapsByEmp = new Map(attendanceGaps.map((g) => [g.employeeId, g._count]));
  const nameByEmp = new Map(lines.map((l) => [l.employeeId, empName(l.employee)]));

  const withLop = lines.filter((l) => n(l.lopDays) > 0 || adjByEmp.has(l.employeeId));

  return (
    <div className="stack gap-4">
      <Callout tone="info" title="Update leave and attendance before you begin">
        Loss of pay flows in from exactly three places: an unpaid-leave request, a
        penalisation policy set to treat penalties as LOP, and a manual override here.
        {run.payGroup.attendanceCutoffDay
          ? ` The attendance cut-off for this pay group is day ${run.payGroup.attendanceCutoffDay} — LOP after that date rolls into next month.`
          : ""}
        {" "}This run counts attendance and unpaid leave from <strong>{formatDate(windowFrom)}</strong> to <strong>{formatDate(windowTo)}</strong>.
      </Callout>

      <Card
        title={`Carried from closed months (${carried.length})`}
        description="LOP recorded after an earlier month was finalised is charged here as LOP days; LOP reversed after it closed is paid back as arrears at that month's day rate. Worked out again on every recalculation."
        tight
      >
        {carried.length === 0 ? (
          <Empty title="Nothing carried">No LOP changed in months that are already finalised.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>From month</th><th>What changed</th><th className="num">Days</th><th className="num">Arrears</th></tr></thead>
              <tbody>
                {carried.map((a) => (
                  <tr key={a.id}>
                    <td>{nameByEmp.get(a.employeeId) ?? a.employeeId}</td>
                    <td className="nowrap">{formatPeriod(a.reversalForYear!, a.reversalForMonth!)}</td>
                    <td>{n(a.days) > 0 ? <Badge tone="danger">LOP recorded late — deducted now</Badge> : <Badge tone="success">LOP reversed — paid as arrears</Badge>}</td>
                    <td className="num">{n(a.days).toFixed(2)}</td>
                    <td className="num">{a.amount ? <Money value={a.amount} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Leave applied"
        description={`${pendingLeave.length} request${pendingLeave.length === 1 ? "" : "s"} still pending for this period. Resolve them before proceeding, or they will not be reflected.`}
        tight
      >
        {pendingLeave.length === 0 ? (
          <Empty title="No pending leave for this period">
            Every request overlapping this pay period has been approved or rejected.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th>Leave type</th><th>From</th><th>To</th><th className="num">Days</th><th>Paid</th></tr>
              </thead>
              <tbody>
                {pendingLeave.map((r) => (
                  <tr key={r.id}>
                    <td>{nameByEmp.get(r.employeeId) ?? r.employeeId}</td>
                    <td>{r.leaveType.name}</td>
                    <td className="nowrap">{formatDate(r.fromDate)}</td>
                    <td className="nowrap">{formatDate(r.toDate)}</td>
                    <td className="num">{n(r.totalDays).toFixed(1)}</td>
                    <td>
                      {r.leaveType.isPaid
                        ? <Badge tone="success">Paid</Badge>
                        : <Badge tone="danger">Unpaid — creates LOP</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Loss of pay"
        description="System-calculated LOP from attendance and unpaid leave, with a manual adjustment column. A positive adjustment adds days; a negative one reverses them."
        tight
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="num">Days in month</th>
                <th className="num">No-attendance days</th>
                <th className="num">LOP in window</th>
                <th className="num">Carried LOP</th>
                <th className="num">Total LOP</th>
                <th className="num">Payable days</th>
                <th>Manual adjustment</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const adj = adjByEmp.get(l.employeeId);
                const gaps = gapsByEmp.get(l.employeeId) ?? 0;
                return (
                  <tr key={l.id}>
                    <td>
                      <Link href={`/employees/${l.employeeId}`}>
                        <Person name={empName(l.employee)} meta={`${l.employee.employeeNumber} · ${l.employee.department?.name ?? "—"}`} />
                      </Link>
                    </td>
                    <td className="num">{l.totalDays}</td>
                    <td className="num">
                      {gaps > 0 ? <Badge tone="warning">{gaps}</Badge> : <span className="subtle">0</span>}
                    </td>
                    <td className="num">{l.attendanceLopDays === null || l.attendanceLopDays === undefined ? "—" : n(l.attendanceLopDays).toFixed(2)}</td>
                    <td className="num">{n(l.carriedLopDays) ? n(l.carriedLopDays).toFixed(2) : <span className="subtle">0</span>}</td>
                    <td className="num">{n(l.lopDays).toFixed(2)}</td>
                    <td className="num strong">{n(l.payableDays).toFixed(2)}</td>
                    <td>
                      {editable ? (
                        <form action={setLopAdjustment} className="row gap-1">
                          <input type="hidden" name="runId" value={run.id} />
                          <input type="hidden" name="employeeId" value={l.employeeId} />
                          <input
                            className="input num" name="days" type="number" step="0.5"
                            defaultValue={adj ? n(adj.days) : 0}
                            style={{ width: 78, padding: "4px 8px", fontSize: 12.5 }}
                          />
                          <input
                            className="input" name="note" placeholder="Note"
                            defaultValue={adj?.note ?? ""}
                            style={{ width: 120, padding: "4px 8px", fontSize: 12.5 }}
                          />
                          <button className="btn sm" type="submit">Set</button>
                        </form>
                      ) : (
                        <span className="num">{adj ? n(adj.days).toFixed(2) : "—"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {withLop.length > 0 ? (
        <Callout tone="warning" title={`${withLop.length} employee${withLop.length === 1 ? "" : "s"} with loss of pay`}>
          Earnings and the PF ceiling both prorate against payable days, so a part-month
          employee is not credited a full month of PF.
        </Callout>
      ) : null}
    </div>
  );
}

// ===========================================================================
//  Step 2 — New Joinees & Exits
// ===========================================================================

export async function Step2({ run, lines, editable }: StepProps) {
  const joinersThisMonth = lines.filter(
    (l) => l.employee.dateOfJoining >= run.periodStart && l.employee.dateOfJoining <= run.periodEnd,
  );
  const exitingThisMonth = lines.filter(
    (l) => l.employee.lastWorkingDay &&
      l.employee.lastWorkingDay >= run.periodStart && l.employee.lastWorkingDay <= run.periodEnd,
  );
  const onNotice = lines.filter((l) => l.employee.status === "NOTICE_PERIOD");

  const settlements = await prisma.fnfSettlement.findMany({
    where: {
      employeeId: { in: lines.map((l) => l.employeeId) },
      status: { notIn: ["FINALIZED", "PAID", "VOIDED"] },
    },
    include: { employee: { select: { displayName: true, employeeNumber: true } } },
  });

  const table = (rows: LineLike[], emptyLabel: string) =>
    rows.length === 0 ? (
      <Empty title={emptyLabel} />
    ) : (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Employee</th><th>Date</th>
              <th className="num">Payable days</th>
              <th className="num">Gross</th><th className="num">Net pay</th>
              <th>Pay action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/employees/${l.employeeId}`}>
                    <Person name={empName(l.employee)} meta={l.employee.employeeNumber} />
                  </Link>
                </td>
                <td className="nowrap text-sm">
                  {l.employee.lastWorkingDay &&
                   l.employee.lastWorkingDay >= run.periodStart &&
                   l.employee.lastWorkingDay <= run.periodEnd
                    ? `LWD ${formatDate(l.employee.lastWorkingDay)}`
                    : `Joined ${formatDate(l.employee.dateOfJoining)}`}
                </td>
                <td className="num">{n(l.payableDays).toFixed(2)} / {l.totalDays}</td>
                <td className="num"><Money value={l.grossEarnings} /></td>
                <td className="num strong"><Money value={l.netPay} /></td>
                <td>
                  {editable ? (
                    <form action={setPayAction} className="row gap-1">
                      <input type="hidden" name="runId" value={run.id} />
                      <input type="hidden" name="employeeId" value={l.employeeId} />
                      <select
                        className="select" name="payAction" defaultValue={l.payAction}
                        style={{ width: 186, padding: "4px 8px", fontSize: 12.5 }}
                      >
                        {PAY_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                      <button className="btn sm" type="submit">Set</button>
                    </form>
                  ) : (
                    <Badge tone="neutral">
                      {PAY_ACTIONS.find((a) => a.value === l.payAction)?.label ?? l.payAction}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="stack gap-4">
      <Card
        title={`New joiners (${joinersThisMonth.length})`}
        description="Employees who joined during this pay period. Earnings are prorated from the joining date."
        tight
      >
        {table(joinersThisMonth, "No one joined during this period")}
      </Card>

      <Card
        title={`Employees in exit (${exitingThisMonth.length + onNotice.length})`}
        description="Last working day inside this period, plus anyone serving notice."
        tight
      >
        {table(
          [...exitingThisMonth, ...onNotice.filter((l) => !exitingThisMonth.includes(l))],
          "No exits in this period",
        )}
      </Card>

      <Card
        title={`Full & final settlements (${settlements.length})`}
        description="Every settlement must be complete before this step closes. Payroll has to be locked for a settlement to proceed."
        tight
      >
        {settlements.length === 0 ? (
          <Empty title="No settlements pending">
            Completed exits with an outstanding settlement appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th className="num">Net settlement</th><th>Mode</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id}>
                    <td>{s.employee.displayName} <span className="mono text-xs subtle">{s.employee.employeeNumber}</span></td>
                    <td className="num"><Money value={s.netSettlement} /></td>
                    <td className="text-sm">{s.mode === "ONE_TIME" ? "One-time" : "Periodic partial"}</td>
                    <td><Badge tone="warning">{s.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td className="right"><Link className="btn sm" href={`/exits`}>Manage</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ===========================================================================
//  Step 3 — Bonus, Salary Revisions & Overtime
// ===========================================================================

export async function Step3({ run, lines, editable }: StepProps) {
  const employeeIds = lines.map((l) => l.employeeId);

  const [bonuses, revisions, overtime, shiftAllowances] = await Promise.all([
    bonusesForRun(run, employeeIds),
    prisma.salaryRevision.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: "APPLIED",
        effectiveFrom: { gte: run.periodStart, lte: run.periodEnd },
      },
      include: { employee: { select: { displayName: true, employeeNumber: true } } },
    }),
    prisma.overtimeEntry.findMany({
      where: { employeeId: { in: employeeIds }, year: run.year, month: run.month },
    }),
    prisma.shiftAllowanceEntry.findMany({
      where: { employeeId: { in: employeeIds }, year: run.year, month: run.month },
    }),
  ]);

  const nameByEmp = new Map(lines.map((l) => [l.employeeId, empName(l.employee)]));

  // Back-dated revisions from earlier periods generate arrears rather than
  // appearing here.
  const backdated = await prisma.salaryRevision.findMany({
    where: {
      employeeId: { in: employeeIds },
      effectiveFrom: { lt: run.periodStart },
      arrearsProcessed: false,
      status: "APPLIED",
    },
    include: { employee: { select: { displayName: true, employeeNumber: true } } },
    take: 20,
  });

  return (
    <div className="stack gap-4">
      <Card
        title={`Bonus (${bonuses.length})`}
        description="Pay actions: pay, hold, void, pay outside payroll, or partially pay."
        tight
      >
        {bonuses.length === 0 ? (
          <Empty title="No bonus scheduled for this period" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th>Type</th><th className="num">Amount</th><th className="num">Paying</th><th>Taxable</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {bonuses.map((b) => (
                  <tr key={b.id}>
                    <td>{b.employee.displayName} <span className="mono text-xs subtle">{b.employee.employeeNumber}</span></td>
                    <td>
                      {b.bonusType.name}
                      {b.payoutYear !== run.year || b.payoutMonth !== run.month ? <div className="text-xs subtle">Held since {formatPeriod(b.payoutYear, b.payoutMonth)}</div> : null}
                    </td>
                    <td className="num"><Money value={b.amount} /></td>
                    <td className="num strong">{["PAY", "PARTIALLY_PAY"].includes(b.payAction) && (b.payoutYear === run.year && b.payoutMonth === run.month) ? <Money value={b.paidAmount ?? b.amount} /> : "—"}</td>
                    <td>{b.bonusType.isTaxable ? <Badge tone="warning">Taxable</Badge> : <Badge tone="success">Exempt</Badge>}</td>
                    <td className="right">
                      {editable && !b.isProcessed
                        ? <BonusDecision runId={run.id} bonusId={b.id} amount={Number(b.amount)} current={b.payAction} />
                        : <Badge tone="neutral">{b.payAction.replace(/_/g, " ").toLowerCase()}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`Salary revisions effective this cycle (${revisions.length})`}
        description="Old salary, new salary and the percentage change."
        tight
      >
        {revisions.length === 0 ? (
          <Empty title="No revisions effective in this period" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th>Effective</th><th className="num">Previous CTC</th><th className="num">New CTC</th><th className="num">Change</th><th>Status</th></tr>
              </thead>
              <tbody>
                {revisions.map((r) => {
                  const prev = n(r.previousCtc);
                  const next = n(r.annualCtc);
                  const pct = prev > 0 ? ((next - prev) / prev) * 100 : null;
                  return (
                    <tr key={r.id}>
                      <td>{r.employee.displayName} <span className="mono text-xs subtle">{r.employee.employeeNumber}</span></td>
                      <td className="nowrap">{formatDate(r.effectiveFrom)}</td>
                      <td className="num">{prev > 0 ? <Money value={prev} /> : <span className="subtle">—</span>}</td>
                      <td className="num strong"><Money value={next} /></td>
                      <td className={`num ${pct && pct > 0 ? "pos" : ""}`}>
                        {pct === null ? <span className="subtle">—</span> : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                      </td>
                      <td><Badge tone={r.status === "APPLIED" ? "success" : "warning"}>{r.status.toLowerCase()}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {backdated.length > 0 ? (
        <Callout tone="info" title={`${backdated.length} back-dated revision${backdated.length === 1 ? "" : "s"} awaiting arrears`}>
          A revision effective before this period does not change this month's regular
          salary — it produces arrears, which are reviewed in step 5.
        </Callout>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title={`Overtime (${overtime.length})`} tight>
          {overtime.length === 0 ? <Empty title="No overtime recorded" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th className="num">Hours</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {overtime.map((o) => (
                    <tr key={o.id}>
                      <td className="text-sm">{nameByEmp.get(o.employeeId)}</td>
                      <td className="num">{n(o.hours).toFixed(1)}</td>
                      <td className="num"><Money value={o.rate} /></td>
                      <td className="num strong"><Money value={o.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={`Shift allowance (${shiftAllowances.length})`} tight>
          {shiftAllowances.length === 0 ? <Empty title="No shift allowance recorded" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Shift</th><th className="num">Days</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {shiftAllowances.map((s) => (
                    <tr key={s.id}>
                      <td className="text-sm">{nameByEmp.get(s.employeeId)}</td>
                      <td className="text-sm">{s.shiftCode ?? "—"}</td>
                      <td className="num">{n(s.days).toFixed(1)}</td>
                      <td className="num strong"><Money value={s.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ===========================================================================
//  Step 4 — Reimbursements, Ad-hoc Payments, Deductions
// ===========================================================================

export async function Step4({ run, lines, editable, viewer }: StepProps & { viewer?: Viewer }) {
  const employeeIds = lines.map((l) => l.employeeId);

  const [claims, adhoc] = await Promise.all([
    prisma.componentClaim.findMany({
      where: {
        employeeId: { in: employeeIds },
        OR: [
          { status: "SUBMITTED" },
          { status: "APPROVED", payoutYear: run.year, payoutMonth: run.month },
        ],
      },
      include: {
        component: { select: { name: true, code: true, taxTreatment: true } },
        employee: { select: { displayName: true, employeeNumber: true } },
      },
    }),
    prisma.adhocTransaction.findMany({
      where: { employeeId: { in: employeeIds }, year: run.year, month: run.month, OR: [{ runId: null }, { runId: run.id }] },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const nameByEmp = new Map(lines.map((l) => [l.employeeId, empName(l.employee)]));
  const payments = adhoc.filter((a) => a.type === "PAYMENT");
  const deductions = adhoc.filter((a) => a.type === "DEDUCTION");

  const adhocTable = (rows: typeof adhoc, kind: "PAYMENT" | "DEDUCTION") => (
    rows.length === 0 ? (
      <Empty title={`No ad-hoc ${kind === "PAYMENT" ? "payments" : "deductions"} this period`} />
    ) : (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Employee</th><th>Description</th><th className="num">Amount</th><th>Tax</th>{editable ? <th /> : null}</tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="text-sm">{nameByEmp.get(a.employeeId)}</td>
                <td>{a.name}</td>
                <td className="num strong"><Money value={a.amount} /></td>
                <td>
                  {a.taxTreatment === "NON_TAXABLE"
                    ? <Badge tone="success">Not taxable</Badge>
                    : <Badge tone="warning">Taxable</Badge>}
                </td>
                {editable && (a.sourceType || a.runId !== run.id) ? (
                  <td className="right text-xs subtle">{a.sourceType ? `From ${a.sourceType.replace(/([A-Z])/g, " $1").trim().toLowerCase()}` : "Scheduled"}</td>
                ) : editable ? (
                  <td className="right">
                    <form action={deleteAdhoc}>
                      <input type="hidden" name="runId" value={run.id} />
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn ghost sm" type="submit">Remove</button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  );

  const addForm = (kind: "PAYMENT" | "DEDUCTION") => (
    <form action={addAdhoc} className="row gap-2 wrap" style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
      <input type="hidden" name="runId" value={run.id} />
      <input type="hidden" name="type" value={kind} />
      <select className="select" name="employeeId" style={{ maxWidth: 230 }} required>
        <option value="">Select employee…</option>
        {lines.map((l) => (
          <option key={l.employeeId} value={l.employeeId}>
            {l.employee.employeeNumber} — {empName(l.employee)}
          </option>
        ))}
      </select>
      <input className="input" name="name" placeholder="Description" style={{ maxWidth: 190 }} required />
      <input className="input num" name="amount" type="number" step="0.01" min="0.01" placeholder="Amount" style={{ maxWidth: 120 }} required />
      <label className="row gap-1 text-sm nowrap">
        <input type="checkbox" name="taxable" defaultChecked />
        Taxable
      </label>
      <button className="btn primary" type="submit">Add</button>
    </form>
  );

  return (
    <div className="stack gap-4">
      <Card
        title={`Salary component claims (${claims.length})`}
        description="Reimbursement and FBP claims. Tax-exempt reimbursements are paid on a separate segregated payslip and never appear on Form 16."
        tight
      >
        {claims.length === 0 ? (
          <Empty title="No claims to review">
            Employees claim against payroll-eligible components from their own portal.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th>Component</th><th className="num">Claimed</th><th className="num">Payable</th><th>Tax treatment</th><th>Status</th>{editable ? <th /> : null}</tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="text-sm">{c.employee.displayName}</td>
                    <td>{c.component.name} <span className="mono text-xs subtle">{c.component.code}</span></td>
                    <td className="num"><Money value={c.claimedAmount} /></td>
                    <td className="num strong"><Money value={c.payableAmount ?? c.claimedAmount} /></td>
                    <td>
                      {c.component.taxTreatment === "FULLY_EXEMPT"
                        ? <Badge tone="success">Exempt — segregated payslip</Badge>
                        : <Badge tone="warning">Taxable</Badge>}
                    </td>
                    <td>
                      <Badge tone={c.status === "APPROVED" ? "success" : "info"}>{c.status.toLowerCase()}</Badge>
                      {c.reviewerNote ? <div className="text-xs muted">{c.reviewerNote}</div> : null}
                    </td>
                    {editable ? (
                      <td className="right">
                        {c.status === "SUBMITTED" && c.employeeId !== viewer?.employee?.id ? <ClaimDecision runId={run.id} claimId={c.id} claimed={Number(c.claimedAmount)} /> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Ad-hoc payments (${payments.length})`} tight>
        {adhocTable(payments, "PAYMENT")}
        {editable ? addForm("PAYMENT") : null}
      </Card>

      <Card title={`Ad-hoc deductions (${deductions.length})`} tight>
        {adhocTable(deductions, "DEDUCTION")}
        {editable ? addForm("DEDUCTION") : null}
      </Card>
    </div>
  );
}

// ===========================================================================
//  Step 5 — Salary on Hold & Arrears
// ===========================================================================

export async function Step5({ run, lines, editable }: StepProps) {
  const employeeIds = lines.map((l) => l.employeeId);

  const arrears = await prisma.arrear.findMany({
    where: { employeeId: { in: employeeIds }, isProcessed: false },
    include: { employee: { select: { displayName: true, employeeNumber: true } } },
    orderBy: [{ forYear: "asc" }, { forMonth: "asc" }],
  });

  const processingHolds = lines.filter(
    (l) => l.payAction === "HOLD_SALARY_PROCESSING" || l.payAction === "VOID_SALARY_PROCESSING",
  );
  const payoutHolds = lines.filter(
    (l) => l.payAction === "HOLD_PAYOUT" || l.payAction === "VOID_PAYOUT",
  );

  const ARREAR_SOURCE_LABEL: Record<string, string> = {
    BACKDATED_REVISION: "Back-dated revision",
    SALARY_HOLD_RELEASE: "Salary hold released",
    LOP_REVERSAL: "LOP reversal",
    ARREAR_LOP_RECOVERY: "Arrear LOP recovery",
  };

  return (
    <div className="stack gap-4">
      <Callout tone="info" title="Processing hold and payout hold are different things">
        A <strong>processing hold</strong> removes the employee from the pay register
        entirely — no components get values and no statutory contributions apply. A{" "}
        <strong>payout hold</strong> still processes the salary and computes statutory
        deductions, but withholds the payment for release later.
      </Callout>

      <Card
        title={`Salary processing on hold (${processingHolds.length})`}
        description="For absconding employees or uninformed leave. These employees do not appear in the pay register."
        tight
      >
        {processingHolds.length === 0 ? <Empty title="No processing holds" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Action</th><th>Comment</th><th className="num">Net pay</th><th>Change</th></tr></thead>
              <tbody>
                {processingHolds.map((l) => (
                  <tr key={l.id}>
                    <td><Person name={empName(l.employee)} meta={l.employee.employeeNumber} /></td>
                    <td><Badge tone="danger">{l.payAction.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td className="text-sm muted">{l.comment ?? "—"}</td>
                    <td className="num"><Money value={l.netPay} /></td>
                    <td>
                      {editable ? (
                        <form action={setPayAction} className="row gap-1">
                          <input type="hidden" name="runId" value={run.id} />
                          <input type="hidden" name="employeeId" value={l.employeeId} />
                          <input type="hidden" name="payAction" value="PROCESS_AS_SALARY" />
                          <button className="btn sm" type="submit">Release &amp; process</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`Salary payout on hold (${payoutHolds.length})`}
        description="Salary is processed and statutory applies; only the payment is withheld."
        tight
      >
        {payoutHolds.length === 0 ? <Empty title="No payout holds" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Action</th><th className="num">Net withheld</th><th>Change</th></tr></thead>
              <tbody>
                {payoutHolds.map((l) => (
                  <tr key={l.id}>
                    <td><Person name={empName(l.employee)} meta={l.employee.employeeNumber} /></td>
                    <td><Badge tone="warning">{l.payAction.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td className="num strong"><Money value={l.netPay} /></td>
                    <td>
                      {editable ? (
                        <form action={setPayAction} className="row gap-1">
                          <input type="hidden" name="runId" value={run.id} />
                          <input type="hidden" name="employeeId" value={l.employeeId} />
                          <input type="hidden" name="payAction" value="PROCESS_AS_SALARY" />
                          <button className="btn sm" type="submit">Release payout</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`Arrears (${arrears.length})`}
        description="Arrears arise from exactly four sources: back-dated revisions, salary holds released, LOP reversals, and arrear-LOP recoveries."
        tight
      >
        {arrears.length === 0 ? (
          <Empty title="No outstanding arrears" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th><th>Source</th><th>For period</th><th className="num">Amount</th><th>Note</th></tr>
              </thead>
              <tbody>
                {arrears.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{a.employee.displayName} <span className="mono text-xs subtle">{a.employee.employeeNumber}</span></td>
                    <td><Badge tone="info">{ARREAR_SOURCE_LABEL[a.source] ?? a.source}</Badge></td>
                    <td className="nowrap">{formatPeriod(a.forYear, a.forMonth)}</td>
                    <td className="num strong"><Money value={a.amount} /></td>
                    <td className="text-sm muted">{a.note ?? "—"}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3}>Total arrears in this run</td>
                  <td className="num"><Money value={arrears.reduce((s, a) => s + n(a.amount), 0)} /></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Put a salary on hold"
        description="Select an employee and the hold type. Recalculation runs immediately."
      >
        {editable ? (
          <form action={setPayAction} className="row gap-2 wrap">
            <input type="hidden" name="runId" value={run.id} />
            <select className="select" name="employeeId" style={{ maxWidth: 250 }} required>
              <option value="">Select employee…</option>
              {lines.filter((l) => l.payAction === "PROCESS_AS_SALARY").map((l) => (
                <option key={l.employeeId} value={l.employeeId}>
                  {l.employee.employeeNumber} — {empName(l.employee)}
                </option>
              ))}
            </select>
            <select className="select" name="payAction" style={{ maxWidth: 200 }}>
              <option value="HOLD_SALARY_PROCESSING">Hold salary processing</option>
              <option value="HOLD_PAYOUT">Hold payout only</option>
              <option value="VOID_SALARY_PROCESSING">Void processing</option>
            </select>
            <input className="input" name="comment" placeholder="Reason" style={{ maxWidth: 200 }} />
            <button className="btn" type="submit">Apply hold</button>
          </form>
        ) : (
          <span className="text-sm muted">This run is locked; holds can no longer be changed.</span>
        )}
      </Card>
    </div>
  );
}

// ===========================================================================
//  Step 6 — Overrides & Finalizing
// ===========================================================================

export async function Step6({
  run, lines, editable, viewer,
}: StepProps & { viewer: Viewer }) {
  const totals = lines.reduce(
    (acc, l) => ({
      gross: acc.gross + n(l.grossEarnings),
      pfEmployee: acc.pfEmployee + n(l.pfEmployee),
      pfEmployer: acc.pfEmployer + n(l.pfEmployer) + n(l.epsEmployer),
      vpf: acc.vpf + n(l.vpf),
      esiEmployee: acc.esiEmployee + n(l.esiEmployee),
      esiEmployer: acc.esiEmployer + n(l.esiEmployer),
      pt: acc.pt + n(l.professionalTax),
      lwfEmployee: acc.lwfEmployee + n(l.lwfEmployee),
      lwfEmployer: acc.lwfEmployer + n(l.lwfEmployer),
      tds: acc.tds + n(l.tds),
      deductions: acc.deductions + n(l.totalDeductions),
      net: acc.net + n(l.netPay),
      employerCost: acc.employerCost + n(l.employerCost),
    }),
    {
      gross: 0, pfEmployee: 0, pfEmployer: 0, vpf: 0, esiEmployee: 0, esiEmployer: 0,
      pt: 0, lwfEmployee: 0, lwfEmployer: 0, tds: 0, deductions: 0, net: 0, employerCost: 0,
    },
  );

  const overridden = lines.filter(
    (l) => l.ptOverride !== null || l.esiOverride !== null ||
           l.tdsOverride !== null || l.lwfOverride !== null,
  );
  const negativeNet = lines.filter((l) => n(l.netPay) < 0);
  const heldRows = lines.filter((l) => l.payAction !== "PROCESS_AS_SALARY");

  return (
    <div className="stack gap-4">
      <Callout tone="info" title="One-off statutory adjustments">
        Professional Tax, ESI, TDS and Labour Welfare Fund can each be overridden per
        employee for this period. Leave a field blank to fall back to the computed value.
      </Callout>

      <Card title="Statutory summary" description="What the run will remit, by head." tight>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Head</th><th className="num">Employee share</th><th className="num">Employer share</th><th className="num">Total</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Provident Fund {run.payGroup.pfEnabled ? "" : <Badge tone="neutral">disabled</Badge>}</td>
                <td className="num"><Money value={totals.pfEmployee + totals.vpf} /></td>
                <td className="num"><Money value={totals.pfEmployer} /></td>
                <td className="num strong"><Money value={totals.pfEmployee + totals.vpf + totals.pfEmployer} /></td>
              </tr>
              <tr>
                <td>ESI {run.payGroup.esiEnabled ? "" : <Badge tone="neutral">disabled</Badge>}</td>
                <td className="num"><Money value={totals.esiEmployee} /></td>
                <td className="num"><Money value={totals.esiEmployer} /></td>
                <td className="num strong"><Money value={totals.esiEmployee + totals.esiEmployer} /></td>
              </tr>
              <tr>
                <td>Professional Tax</td>
                <td className="num"><Money value={totals.pt} /></td>
                <td className="num"><span className="subtle">—</span></td>
                <td className="num strong"><Money value={totals.pt} /></td>
              </tr>
              <tr>
                <td>Labour Welfare Fund</td>
                <td className="num"><Money value={totals.lwfEmployee} /></td>
                <td className="num"><Money value={totals.lwfEmployer} /></td>
                <td className="num strong"><Money value={totals.lwfEmployee + totals.lwfEmployer} /></td>
              </tr>
              <tr>
                <td>Income tax (TDS)</td>
                <td className="num"><Money value={totals.tds} /></td>
                <td className="num"><span className="subtle">—</span></td>
                <td className="num strong"><Money value={totals.tds} /></td>
              </tr>
              <tr className="total-row">
                <td>Total</td>
                <td className="num"><Money value={totals.deductions} /></td>
                <td className="num"><Money value={totals.employerCost} /></td>
                <td className="num"><Money value={totals.deductions + totals.employerCost} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Per-employee overrides"
        description="Blank means no override. Setting a value replaces the computed figure for this period only."
        tight
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="num">Gross</th>
                <th className="num">PT</th>
                <th className="num">ESI</th>
                <th className="num">LWF</th>
                <th className="num">TDS</th>
                <th className="num">Net pay</th>
                {editable ? <th>Override</th> : null}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/employees/${l.employeeId}`}>
                      <Person
                        name={empName(l.employee)}
                        meta={`${l.employee.employeeNumber} · ${l.employee.location?.stateCode ?? "—"}`}
                      />
                    </Link>
                  </td>
                  <td className="num"><Money value={l.grossEarnings} /></td>
                  <td className="num">
                    <Money value={l.professionalTax} />
                    {l.ptOverride !== null ? <Badge tone="warning">ovr</Badge> : null}
                  </td>
                  <td className="num">
                    <Money value={l.esiEmployee} showZero={false} />
                    {l.esiOverride !== null ? <Badge tone="warning">ovr</Badge> : null}
                  </td>
                  <td className="num">
                    <Money value={l.lwfEmployee} showZero={false} />
                    {l.lwfOverride !== null ? <Badge tone="warning">ovr</Badge> : null}
                  </td>
                  <td className="num">
                    <Money value={l.tds} showZero={false} />
                    {l.tdsOverride !== null ? <Badge tone="warning">ovr</Badge> : null}
                  </td>
                  <td className={`num strong ${n(l.netPay) < 0 ? "neg" : ""}`}>
                    <Money value={l.netPay} />
                  </td>
                  {editable ? (
                    <td>
                      <form action={setStatutoryOverride} className="row gap-1">
                        <input type="hidden" name="runId" value={run.id} />
                        <input type="hidden" name="employeeId" value={l.employeeId} />
                        <select className="select" name="field" style={{ width: 74, padding: "3px 6px", fontSize: 12 }}>
                          <option value="pt">PT</option>
                          <option value="esi">ESI</option>
                          <option value="lwf">LWF</option>
                          <option value="tds">TDS</option>
                        </select>
                        <input
                          className="input num" name="value" type="number" step="0.01"
                          placeholder="blank = auto"
                          style={{ width: 96, padding: "3px 7px", fontSize: 12 }}
                        />
                        <button className="btn sm" type="submit">Set</button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
              <tr className="total-row">
                <td>Total — {lines.length} employees</td>
                <td className="num"><Money value={totals.gross} /></td>
                <td className="num"><Money value={totals.pt} /></td>
                <td className="num"><Money value={totals.esiEmployee} /></td>
                <td className="num"><Money value={totals.lwfEmployee} /></td>
                <td className="num"><Money value={totals.tds} /></td>
                <td className="num"><Money value={totals.net} /></td>
                {editable ? <td /> : null}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* --- Pre-finalise checks --- */}
      <Card title="Before you finalise" description="Anything outstanding is listed here.">
        <div className="stack gap-2">
          <CheckRow
            ok={negativeNet.length === 0}
            label="No negative net pay"
            detail={negativeNet.length === 0
              ? "Every employee's earnings cover their deductions."
              : `${negativeNet.length} employee(s) have a negative net. This is legitimate when a recovery exceeds a month's pay, but confirm it is intended.`}
          />
          <CheckRow
            ok={heldRows.length === 0}
            label="No unresolved holds"
            detail={heldRows.length === 0
              ? "All employees are set to process as salary."
              : `${heldRows.length} employee(s) carry a hold, void or already-paid action. These are excluded or withheld as configured.`}
            warnOnly
          />
          <CheckRow
            ok={overridden.length === 0}
            label="No statutory overrides"
            detail={overridden.length === 0
              ? "Every statutory figure is the computed value."
              : `${overridden.length} employee(s) have a manual override. These will not be recomputed.`}
            warnOnly
          />
          <CheckRow
            ok={lines.every((l) => l.calculatedAt !== null || n(l.grossEarnings) > 0 || l.payAction !== "PROCESS_AS_SALARY")}
            label="All employees calculated"
            detail={`${lines.length} rows in the run, ${run.employeeCount} counted toward totals.`}
          />
        </div>
      </Card>
    </div>
  );
}

function CheckRow({
  ok, label, detail, warnOnly,
}: { ok: boolean; label: string; detail: string; warnOnly?: boolean }) {
  const tone = ok ? "success" : warnOnly ? "warning" : "danger";
  return (
    <div className="row gap-3" style={{ alignItems: "flex-start" }}>
      <Badge tone={tone}>{ok ? "✓" : "!"}</Badge>
      <div style={{ minWidth: 0 }}>
        <div className="strong text-sm">{label}</div>
        <div className="text-sm muted">{detail}</div>
      </div>
    </div>
  );
}
