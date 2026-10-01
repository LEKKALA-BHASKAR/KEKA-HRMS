import "server-only";
import Link from "next/link";
import type { ReactNode } from "react";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { defaultApproved } from "@keka/services";
import { formatDate, formatINR, formatPeriod } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeIds, scopedEmployeeWhere, inScope, timesheetsToApproveWhere } from "@/lib/scope";
import {
  IconCalendar, IconClock, IconTimer, IconReceipt, IconWallet, IconDollarCircle, IconLogout,
  IconUserPlus, IconFile, IconHeadset, IconLedger,
} from "@/components/icons";
import { DecisionForm } from "../../_time/leave-forms";
import { TimeOffDecision } from "../../_time/timeoff-decision";
import { LoanDecision } from "../../payroll/_forms/loans";
import { TimesheetDecision } from "../../projects/forms";
import { ClaimDecision } from "../../expenses/forms";
import { ExitDecisionForm, TaskControls, ReplyForm } from "../../_lifecycle/forms";
import { DetailPane, Facts, Message, PersonStrip, type ActivityEntry, type ListItem } from "../_ui/panes";
import { formatInstantDate, formatTime, humanise } from "../_ui/format";
import { resolvePeople, who, type PersonRef } from "../_ui/people";
import { verifyDocumentFromInbox } from "./actions";
import s from "../inbox.module.css";

/**
 * Everything a viewer can act on, one source per category. Each source owns
 * a single `where` — the same one the previous inbox used, scoped to the
 * viewer's approval line and never including their own requests — and uses
 * it for the count, the list and the detail. A detail is looked up through
 * that `where` plus its id, so a link to something outside the viewer's
 * scope (or already decided) finds nothing.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;

export interface TakeSource {
  key: string;
  label: string;
  icon: ReactNode;
  /** Listed even with nothing waiting, because the viewer holds the right. */
  always: boolean;
  count: () => Promise<number>;
  list: () => Promise<ListItem[]>;
  detail: (id: string) => Promise<ReactNode | null>;
}

const EMP = { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true } as const;
const EMP_CARD = { ...EMP, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } } as const;

type Emp = { id: string; displayName: string | null; firstName: string; lastName: string; photoUrl: string | null };
type EmpCard = Emp & { employeeNumber: string; jobTitleName: string | null; department: { name: string } | null };

const person = (e: Emp): PersonRef => ({ id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl });
const cardMeta = (e: EmpCard) => [e.jobTitleName, e.department?.name, e.employeeNumber].filter(Boolean).join(" · ");
const days = (n: unknown) => {
  const v = Number(n);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} day${v === 1 ? "" : "s"}`;
};
const range = (from: Date, to: Date) => (from.getTime() === to.getTime() ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`);
const initiated = (d: Date) => `Initiated on ${formatInstantDate(d)}`;
const PENDING = { label: "Pending", tone: "pending" as const };
const PORTION: Record<string, string> = { FULL_DAY: "Full day", FIRST_HALF: "First half", SECOND_HALF: "Second half", QUARTER: "Quarter day" };

export async function takeActionSources(viewer: Viewer): Promise<TakeSource[]> {
  const tenantId = viewer.tenantId;
  const me = viewer.employee?.id ?? null;
  const notSelf = me ? { NOT: { employeeId: me } } : {};
  const sources: TakeSource[] = [];

  // ---- Leave ---------------------------------------------------------------
  if (can(viewer, P.LEAVE_APPROVE)) {
    const scope = await scopedEmployeeIds(viewer, P.LEAVE_APPROVE);
    const where = { tenantId, status: "PENDING", ...inScope(scope), ...notSelf } as Prisma.LeaveRequestWhereInput;
    const employeesOf = async (ids: string[]) => new Map((await prisma.employee.findMany({
      where: { tenantId, id: { in: ids } }, select: EMP_CARD,
    })).map((e) => [e.id, e]));
    sources.push({
      key: "leave", label: "Leave", icon: <IconCalendar />, always: true,
      count: () => prisma.leaveRequest.count({ where }),
      list: async () => {
        const rows = await prisma.leaveRequest.findMany({ where, include: { leaveType: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
        const emps = await employeesOf([...new Set(rows.map((r) => r.employeeId))]);
        return rows.flatMap((r) => {
          const e = emps.get(r.employeeId);
          return e ? [{ id: r.id, person: person(e), title: `${r.leaveType.name} · ${days(r.totalDays)} · ${range(r.fromDate, r.toDate)}`, at: r.createdAt }] : [];
        });
      },
      detail: async (id) => {
        const r = await prisma.leaveRequest.findFirst({ where: { ...where, id }, include: { leaveType: { select: { name: true, isPaid: true } } } });
        if (!r) return null;
        const [e, balance] = await Promise.all([
          prisma.employee.findFirst({ where: { tenantId, id: r.employeeId }, select: EMP_CARD }),
          prisma.leaveBalance.findFirst({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId }, orderBy: { yearStart: "desc" }, select: { available: true } }),
        ]);
        if (!e) return null;
        const p = person(e);
        const single = r.fromDate.getTime() === r.toDate.getTime();
        return (
          <DetailPane title={`${r.leaveType.name} request`} sub={initiated(r.createdAt)} status={PENDING}
            actions={<DecisionForm requestId={r.id} kind="leave" />}
            activity={[{ who: p, text: `Applied for ${days(r.totalDays)} of ${r.leaveType.name}`, at: r.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(e)} />
            <Facts items={[
              ["From", `${formatDate(r.fromDate)} · ${PORTION[r.fromPortion]}`],
              !single && ["To", `${formatDate(r.toDate)} · ${PORTION[r.toPortion]}`],
              ["Days", Number(r.sandwichDays) > 0 ? `${days(r.totalDays)} (incl. ${days(r.sandwichDays)} sandwich)` : days(r.totalDays)],
              ["Pay impact", r.leaveType.isPaid ? "Paid" : <span className="neg strong">Creates loss of pay</span>],
              balance ? ["Balance available", days(balance.available)] : null,
            ]} />
            {r.reason ? <Message label="Reason">{r.reason}</Message> : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Comp-off claims -----------------------------------------------------
  if (can(viewer, P.LEAVE_APPROVE)) {
    const scope = await scopedEmployeeIds(viewer, P.LEAVE_APPROVE);
    const where = { tenantId, status: "PENDING", ...inScope(scope), ...notSelf } as Prisma.CompOffRequestWhereInput;
    sources.push({
      key: "compoff", label: "Comp-off", icon: <IconCalendar />, always: false,
      count: () => prisma.compOffRequest.count({ where }),
      list: async () => (await prisma.compOffRequest.findMany({ where, include: { employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 }))
        .map((r) => ({ id: r.id, person: person(r.employee), title: `${days(r.days)} comp-off · worked ${formatDate(r.workedOn)}`, at: r.createdAt })),
      detail: async (id) => {
        const r = await prisma.compOffRequest.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
        if (!r) return null;
        const day = await prisma.attendanceRecord.findFirst({ where: { tenantId, employeeId: r.employeeId, date: r.workedOn }, select: { firstIn: true, lastOut: true, effectiveHours: true } });
        const p = person(r.employee);
        return (
          <DetailPane title="Comp-off credit request" sub={initiated(r.createdAt)} status={PENDING}
            actions={<TimeOffDecision requestId={r.id} kind="compoff" />}
            activity={[{ who: p, text: `Claimed ${days(r.days)} for working on ${formatDate(r.workedOn)}`, at: r.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(r.employee)} />
            <Facts items={[
              ["Worked on", `${formatDate(r.workedOn)} · ${r.dayType}`],
              ["Credit", days(r.days)],
              day ? ["Hours recorded", `${Number(day.effectiveHours).toFixed(2)} h${day.firstIn ? ` · ${formatTime(day.firstIn)}–${day.lastOut ? formatTime(day.lastOut) : "?"}` : ""}`] : null,
              r.expiresOn ? ["Use by", formatDate(r.expiresOn)] : null,
            ]} />
            <Message label="Reason">{r.reason}</Message>
          </DetailPane>
        );
      },
    });
  }

  // ---- Leave encashment ----------------------------------------------------
  if (can(viewer, P.LEAVE_MANAGE)) {
    const where = { tenantId, status: "PENDING", ...notSelf, employee: scopedEmployeeWhere(viewer, P.LEAVE_MANAGE) } as Prisma.LeaveEncashmentRequestWhereInput;
    sources.push({
      key: "encash", label: "Leave encashment", icon: <IconWallet />, always: false,
      count: () => prisma.leaveEncashmentRequest.count({ where }),
      list: async () => {
        const rows = await prisma.leaveEncashmentRequest.findMany({ where, include: { employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 });
        return rows.map((r) => ({ id: r.id, person: person(r.employee), title: `${days(r.days)} · ${formatINR(Number(r.amount))}`, at: r.createdAt }));
      },
      detail: async (id) => {
        const r = await prisma.leaveEncashmentRequest.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
        if (!r) return null;
        const [type, balance] = await Promise.all([
          prisma.leaveType.findUnique({ where: { id: r.leaveTypeId }, select: { name: true } }),
          prisma.leaveBalance.findFirst({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId }, orderBy: { yearStart: "desc" }, select: { available: true } }),
        ]);
        const p = person(r.employee);
        return (
          <DetailPane title={`${type?.name ?? "Leave"} encashment`} sub={initiated(r.createdAt)} status={PENDING}
            actions={<TimeOffDecision requestId={r.id} kind="encash" />}
            activity={[{ who: p, text: `Asked to encash ${days(r.days)}`, at: r.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(r.employee)} />
            <Facts items={[
              ["Days", days(r.days)],
              ["Amount", <span key="a" className="strong">{formatINR(Number(r.amount))}</span>],
              ["Basis", r.basis],
              balance ? ["Balance available", days(balance.available)] : null,
              ["On approval", "Days leave the balance and the amount is added to the open payroll run as a taxable payment"],
            ]} />
            {r.reason ? <Message label="Reason">{r.reason}</Message> : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Attendance ----------------------------------------------------------
  if (can(viewer, P.ATTENDANCE_APPROVE)) {
    const where = {
      tenantId, status: "PENDING", ...notSelf,
      employee: scopedEmployeeWhere(viewer, P.ATTENDANCE_APPROVE),
    } as Prisma.AttendanceRequestWhereInput;
    sources.push({
      key: "attendance", label: "Attendance", icon: <IconClock />, always: true,
      count: () => prisma.attendanceRequest.count({ where }),
      list: async () => (await prisma.attendanceRequest.findMany({ where, include: { employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 }))
        .map((r) => ({ id: r.id, person: person(r.employee), title: `${humanise(r.type)} · ${range(r.fromDate, r.toDate)}`, at: r.createdAt })),
      detail: async (id) => {
        const r = await prisma.attendanceRequest.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
        if (!r) return null;
        const day = r.fromDate.getTime() === r.toDate.getTime()
          ? await prisma.attendanceRecord.findFirst({ where: { tenantId, employeeId: r.employeeId, date: r.fromDate }, select: { status: true, firstIn: true, lastOut: true } })
          : null;
        const p = person(r.employee);
        return (
          <DetailPane title={`${humanise(r.type)} request`} sub={initiated(r.createdAt)} status={PENDING}
            actions={<DecisionForm requestId={r.id} kind="attendance" />}
            activity={[{ who: p, text: `Requested ${humanise(r.type).toLowerCase()} for ${range(r.fromDate, r.toDate)}`, at: r.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(r.employee)} />
            <Facts items={[
              ["Request", humanise(r.type)],
              ["Dates", range(r.fromDate, r.toDate)],
              r.proposedIn ? ["Proposed in", formatTime(r.proposedIn)] : null,
              r.proposedOut ? ["Proposed out", formatTime(r.proposedOut)] : null,
              r.partialMinutes ? ["Time away", `${r.partialMinutes} min`] : null,
              day ? ["Recorded that day", [humanise(day.status), day.firstIn ? `in ${formatTime(day.firstIn)}` : null, day.lastOut ? `out ${formatTime(day.lastOut)}` : null].filter(Boolean).join(" · ")] : null,
            ]} />
            <Message label="Reason">{r.reason}</Message>
          </DetailPane>
        );
      },
    });
  }

  // ---- Timesheets ----------------------------------------------------------
  if (me) {
    const where = timesheetsToApproveWhere(viewer) as Prisma.TimesheetWhereInput;
    sources.push({
      key: "timesheets", label: "Timesheets", icon: <IconTimer />, always: can(viewer, P.TIMESHEET_APPROVE),
      count: () => prisma.timesheet.count({ where }),
      list: async () => (await prisma.timesheet.findMany({ where, include: { employee: { select: EMP } }, orderBy: { submittedAt: "desc" }, take: 200 }))
        .map((t) => ({ id: t.id, person: person(t.employee), title: `Week of ${formatDate(t.periodStart)} · ${Number(t.totalHours)} h`, at: t.submittedAt ?? t.createdAt })),
      detail: async (id) => {
        const t = await prisma.timesheet.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
        if (!t) return null;
        const entries = await prisma.timeEntry.findMany({ where: { tenantId, timesheetId: t.id }, select: { hours: true, isBillable: true, project: { select: { name: true } } } });
        const byProject = new Map<string, { hours: number; billable: number }>();
        for (const e of entries) {
          const row = byProject.get(e.project.name) ?? { hours: 0, billable: 0 };
          row.hours += Number(e.hours);
          if (e.isBillable) row.billable += Number(e.hours);
          byProject.set(e.project.name, row);
        }
        const p = person(t.employee);
        const at = t.submittedAt ?? t.createdAt;
        return (
          <DetailPane title={`Timesheet · week of ${formatDate(t.periodStart)}`} sub={initiated(at)} status={PENDING}
            actions={<><TimesheetDecision timesheetId={t.id} /><Link className="btn sm ghost" href="/projects?tab=approvals">See the hours</Link></>}
            activity={[{ who: p, text: `Submitted ${Number(t.totalHours)} h for ${range(t.periodStart, t.periodEnd)}`, at }]}>
            <PersonStrip person={p} meta={cardMeta(t.employee)} />
            <Facts items={[
              ["Week", range(t.periodStart, t.periodEnd)],
              ["Total hours", `${Number(t.totalHours)} h`],
              ["Billable", `${Number(t.billableHours)} h`],
            ]} />
            {byProject.size > 0 ? (
              <table className={s.lines}>
                <thead><tr><th>Project</th><th className={s.num}>Hours</th><th className={s.num}>Billable</th></tr></thead>
                <tbody>
                  {[...byProject].map(([name, v]) => (
                    <tr key={name}><td>{name}</td><td className={s.num}>{v.hours}</td><td className={s.num}>{v.billable}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Expenses ------------------------------------------------------------
  const expenseRoutes: Prisma.ExpenseClaimWhereInput[] = [];
  if (can(viewer, P.EXPENSE_APPROVE)) {
    expenseRoutes.push({ tenantId, stage: "SUBMITTED", employee: scopedEmployeeWhere(viewer, P.EXPENSE_APPROVE), ...notSelf } as Prisma.ExpenseClaimWhereInput);
  }
  if (can(viewer, P.EXPENSE_MANAGE)) {
    expenseRoutes.push({ tenantId, stage: "PARTIALLY_APPROVED", employee: scopedEmployeeWhere(viewer, P.EXPENSE_MANAGE), ...notSelf } as Prisma.ExpenseClaimWhereInput);
  }
  if (expenseRoutes.length > 0) {
    const where: Prisma.ExpenseClaimWhereInput = { tenantId, OR: expenseRoutes };
    sources.push({
      key: "expenses", label: "Expenses", icon: <IconReceipt />, always: true,
      count: () => prisma.expenseClaim.count({ where }),
      list: async () => (await prisma.expenseClaim.findMany({ where, include: { employee: { select: EMP } }, orderBy: { submittedAt: "desc" }, take: 200 }))
        .map((c) => ({
          id: c.id, person: person(c.employee), title: `${c.claimNumber} · ${c.title} · ${formatINR(Number(c.claimedTotal))}`,
          at: c.submittedAt ?? c.createdAt, tag: c.stage === "PARTIALLY_APPROVED" ? "Finance approval" : undefined,
        })),
      detail: async (id) => {
        const c = await prisma.expenseClaim.findFirst({
          where: { ...where, id },
          include: { lines: { include: { category: true }, orderBy: { expenseDate: "asc" } }, policy: { include: { categories: true } }, employee: { select: EMP_CARD } },
        });
        if (!c) return null;
        const cap = (l: (typeof c.lines)[number]) => {
          const pc = c.policy?.categories.find((x) => x.categoryId === l.categoryId)?.maxAmount;
          const caps = [l.category.maxAmount, pc].filter((v) => v !== null && v !== undefined).map(Number);
          return caps.length ? Math.min(...caps) : null;
        };
        const approvers = await resolvePeople(tenantId, [c.approvedBy]);
        const p = person(c.employee);
        const at = c.submittedAt ?? c.createdAt;
        const activity: ActivityEntry[] = [{ who: p, text: `Submitted ${c.lines.length} expense${c.lines.length === 1 ? "" : "s"} for ${formatINR(Number(c.claimedTotal))}`, at }];
        if (c.stage === "PARTIALLY_APPROVED") activity.push({ who: who(approvers, c.approvedBy), text: `Approved ${formatINR(Number(c.approvedTotal))}; now with finance`, at: c.approvedAt });
        return (
          <DetailPane title={`${c.claimNumber} · ${c.title}`} sub={initiated(at)}
            status={{ label: c.stage === "PARTIALLY_APPROVED" ? "Pending with finance" : "Pending", tone: "pending" }}
            actions={(
              <div className="stack gap-2" style={{ width: "100%" }}>
                <ClaimDecision claimId={c.id} lines={c.lines.map((l) => ({
                  id: l.id, label: `${l.category.name}${l.merchant ? ` · ${l.merchant}` : ""}`, amount: Number(l.amount),
                  suggested: l.approvedAmount !== null ? Number(l.approvedAmount) : defaultApproved(Number(l.amount), cap(l)),
                }))} />
                <Link className="btn sm ghost" href={`/expenses/${c.id}`} style={{ alignSelf: "flex-start" }}>Open the full claim</Link>
              </div>
            )}
            activity={activity}>
            <PersonStrip person={p} meta={cardMeta(c.employee)} />
            <table className={s.lines}>
              <thead><tr><th>Date</th><th>Category</th><th>Merchant</th><th className={s.num}>Claimed</th></tr></thead>
              <tbody>
                {c.lines.map((l) => {
                  const limit = cap(l);
                  return (
                    <tr key={l.id}>
                      <td className="nowrap">{formatDate(l.expenseDate)}</td>
                      <td>{l.category.name}{limit !== null && Number(l.amount) > limit ? <div className="text-xs" style={{ color: "var(--warning)" }}>over the {formatINR(limit)} limit</div> : null}</td>
                      <td className="muted">{l.merchant ?? "—"}</td>
                      <td className={s.num}>{formatINR(Number(l.amount))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DetailPane>
        );
      },
    });
  }

  // ---- Reimbursement claims (decided in the payroll run) -------------------
  if (can(viewer, P.PAYROLL_RUN)) {
    const where = { status: "SUBMITTED", employee: { tenantId }, ...notSelf } as Prisma.ComponentClaimWhereInput;
    sources.push({
      key: "claims", label: "Reimbursements", icon: <IconLedger />, always: true,
      count: () => prisma.componentClaim.count({ where }),
      list: async () => (await prisma.componentClaim.findMany({ where, include: { component: { select: { name: true } }, employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 }))
        .map((c) => ({ id: c.id, person: person(c.employee), title: `${c.component.name} · ${formatINR(Number(c.claimedAmount))}`, at: c.createdAt })),
      detail: async (id) => {
        const c = await prisma.componentClaim.findFirst({ where: { ...where, id }, include: { component: { select: { name: true } }, employee: { select: EMP_CARD } } });
        if (!c) return null;
        const p = person(c.employee);
        return (
          <DetailPane title={`${c.component.name} claim`} sub={initiated(c.createdAt)} status={PENDING}
            actions={<Link className="btn sm primary" href="/payroll/runs">Review in the payroll run</Link>}
            activity={[{ who: p, text: `Claimed ${formatINR(Number(c.claimedAmount))} against ${c.component.name}`, at: c.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(c.employee)} />
            <Facts items={[
              ["Component", c.component.name],
              ["Claimed", formatINR(Number(c.claimedAmount))],
              ["Financial year", `FY ${c.fyStartYear}-${String((c.fyStartYear + 1) % 100).padStart(2, "0")}`],
              c.billDate ? ["Bill date", formatDate(c.billDate)] : null,
              c.billNumber ? ["Bill number", c.billNumber] : null,
            ]} />
            {c.comment ? <Message label="Comment">{c.comment}</Message> : null}
            <p className="muted text-sm">Reimbursements are reviewed and paid in step 4 of the payroll run.</p>
          </DetailPane>
        );
      },
    });
  }

  // ---- Loans ---------------------------------------------------------------
  if (can(viewer, P.LOAN_APPROVE)) {
    const where = {
      status: { in: ["REQUESTED", "PENDING_APPROVAL"] },
      employee: scopedEmployeeWhere(viewer, P.LOAN_APPROVE), ...notSelf,
    } as Prisma.LoanWhereInput;
    sources.push({
      key: "loans", label: "Loans", icon: <IconWallet />, always: true,
      count: () => prisma.loan.count({ where }),
      list: async () => (await prisma.loan.findMany({ where, include: { category: { select: { name: true } }, employee: { select: EMP } }, orderBy: { requestedAt: "desc" }, take: 200 }))
        .map((l) => ({ id: l.id, person: person(l.employee), title: `${l.category.name} · ${formatINR(Number(l.principal))}`, at: l.requestedAt })),
      detail: async (id) => {
        const l = await prisma.loan.findFirst({ where: { ...where, id }, include: { category: { select: { name: true } }, employee: { select: EMP_CARD } } });
        if (!l) return null;
        const p = person(l.employee);
        return (
          <DetailPane title={`${l.category.name} request`} sub={initiated(l.requestedAt)} status={PENDING}
            actions={<LoanDecision loanId={l.id} />}
            activity={[{ who: p, text: `Requested ${formatINR(Number(l.principal))} over ${l.installments} months`, at: l.requestedAt }]}>
            <PersonStrip person={p} meta={cardMeta(l.employee)} />
            <Facts items={[
              ["Principal", formatINR(Number(l.principal))],
              ["EMI", formatINR(Number(l.emiAmount))],
              ["Instalments", `${l.installments} months`],
              ["Interest", l.interestType === "NONE" ? "Interest free" : `${Number(l.interestRate)}% · ${humanise(l.interestType)}`],
            ]} />
            {l.purpose ? <Message label="Purpose">{l.purpose}</Message> : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Payroll approvals ---------------------------------------------------
  if (can(viewer, P.PAYROLL_APPROVE)) {
    const where: Prisma.PayrollApprovalRequestWhereInput = { status: "PENDING", run: { tenantId } };
    const include = { run: { select: { id: true, year: true, month: true, totalNetPay: true, payGroup: { select: { name: true } } } } } as const;
    sources.push({
      key: "payroll", label: "Payroll approvals", icon: <IconDollarCircle />, always: true,
      count: () => prisma.payrollApprovalRequest.count({ where }),
      list: async () => {
        const rows = await prisma.payrollApprovalRequest.findMany({ where, include, orderBy: { requestedAt: "desc" }, take: 200 });
        const people = await resolvePeople(tenantId, rows.map((r) => r.requestedBy));
        return rows.map((r) => ({
          id: r.id, person: who(people, r.requestedBy), at: r.requestedAt,
          title: `${r.run ? `${formatPeriod(r.run.year, r.run.month)} · ${r.run.payGroup.name}` : "Payroll"} · ${humanise(r.action)}`,
        }));
      },
      detail: async (id) => {
        const r = await prisma.payrollApprovalRequest.findFirst({ where: { ...where, id }, include });
        if (!r) return null;
        const people = await resolvePeople(tenantId, [r.requestedBy]);
        const requester = who(people, r.requestedBy);
        return (
          <DetailPane title={r.run ? `${formatPeriod(r.run.year, r.run.month)} payroll · ${r.run.payGroup.name}` : "Payroll approval"} sub={initiated(r.requestedAt)} status={PENDING}
            actions={r.run ? <Link className="btn sm primary" href={`/payroll/runs/${r.run.id}?step=6`}>Review payroll</Link> : null}
            activity={[{ who: requester, text: `Asked for approval to ${humanise(r.action).toLowerCase()}`, at: r.requestedAt }]}>
            <Facts items={[
              r.run ? ["Period", formatPeriod(r.run.year, r.run.month)] : null,
              r.run ? ["Pay group", r.run.payGroup.name] : null,
              r.run ? ["Net payable", formatINR(Number(r.run.totalNetPay))] : null,
              ["Action", humanise(r.action)],
              ["Approval level", String(r.currentLevel + 1)],
            ]} />
          </DetailPane>
        );
      },
    });
  }

  // ---- Exits ---------------------------------------------------------------
  if (can(viewer, P.EXIT_APPROVE)) {
    const where = {
      status: "PENDING_APPROVAL",
      employee: { ...scopedEmployeeWhere(viewer, P.EXIT_APPROVE), ...(me ? { NOT: { id: me } } : {}) },
    } as Prisma.ExitRecordWhereInput;
    sources.push({
      key: "exits", label: "Exits", icon: <IconLogout />, always: true,
      count: () => prisma.exitRecord.count({ where }),
      list: async () => (await prisma.exitRecord.findMany({ where, include: { employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 }))
        .map((x) => ({ id: x.id, person: person(x.employee), title: `${humanise(x.type)} · last day ${formatDate(x.lastWorkingDay)}`, at: x.createdAt })),
      detail: async (id) => {
        const x = await prisma.exitRecord.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
        if (!x) return null;
        const people = await resolvePeople(tenantId, [x.initiatedBy]);
        const p = person(x.employee);
        const initiator = x.initiatedBy ? who(people, x.initiatedBy) : p;
        return (
          <DetailPane title={`${humanise(x.type)} · ${p.name}`} sub={initiated(x.createdAt)} status={PENDING}
            actions={(
              <div className="stack gap-2" style={{ width: "100%" }}>
                <ExitDecisionForm exitId={x.id} lastWorkingDay={x.lastWorkingDay.toISOString().slice(0, 10)} />
                <Link className="btn sm ghost" href={`/exits/${x.id}`} style={{ alignSelf: "flex-start" }}>Open the exit</Link>
              </div>
            )}
            activity={[{ who: initiator, text: `${x.type === "RESIGNATION" ? "Resigned" : `Initiated ${humanise(x.type).toLowerCase()}`}, notice given ${formatDate(x.noticeDate)}`, at: x.createdAt }]}>
            <PersonStrip person={p} meta={cardMeta(x.employee)} />
            <Facts items={[
              ["Exit type", humanise(x.type)],
              ["Notice given", formatDate(x.noticeDate)],
              ["Proposed last day", formatDate(x.lastWorkingDay)],
              x.noticeBuyoutDays ? ["Notice buyout", days(x.noticeBuyoutDays)] : null,
            ]} />
            {x.reason ? <Message label="Reason">{x.reason}</Message> : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Onboarding and exit tasks assigned to the viewer -------------------
  if (me) {
    const where: Prisma.JourneyTaskWhereInput = {
      assigneeEmployeeId: me, status: "PENDING", dueDate: { lte: new Date(Date.now() + 7 * DAY) },
      journey: { status: "ACTIVE", tenantId },
    };
    const include = { journey: { select: { id: true, title: true, trigger: true, createdAt: true, createdBy: true, employee: { select: EMP_CARD } } } } as const;
    sources.push({
      key: "tasks", label: "Onboarding & exit tasks", icon: <IconUserPlus />, always: true,
      count: () => prisma.journeyTask.count({ where }),
      list: async () => (await prisma.journeyTask.findMany({ where, include, orderBy: { dueDate: "asc" }, take: 200 }))
        .map((t) => ({
          id: t.id, person: person(t.journey.employee), title: `${t.title} · due ${formatDate(t.dueDate)}`, at: t.journey.createdAt,
          tag: t.dueDate.getTime() < Date.now() - DAY ? "Overdue" : humanise(t.journey.trigger === "JOINING" ? "ONBOARDING" : t.journey.trigger),
          tagTone: t.dueDate.getTime() < Date.now() - DAY ? "danger" as const : undefined,
        })),
      detail: async (id) => {
        const t = await prisma.journeyTask.findFirst({ where: { ...where, id }, include });
        if (!t) return null;
        const people = await resolvePeople(tenantId, [t.journey.createdBy]);
        const p = person(t.journey.employee);
        const overdue = t.dueDate.getTime() < Date.now() - DAY;
        return (
          <DetailPane title={t.title} sub={initiated(t.journey.createdAt)} status={overdue ? { label: "Overdue", tone: "danger" } : { label: "Not started", tone: "pending" }}
            actions={<><TaskControls taskId={t.id} status={t.status} required={t.isRequired} auto={!!t.autoCheck} /><Link className="btn sm ghost" href={`/onboarding/${t.journey.id}`}>Open the journey</Link></>}
            activity={[{ who: t.journey.createdBy ? who(people, t.journey.createdBy) : null, text: `Started “${t.journey.title}”; this task was assigned to you`, at: t.journey.createdAt }]}>
            <p>Hello {viewer.employee?.displayName},<br />{t.description ?? `“${t.title}” is waiting on you for ${p.name}.`}</p>
            <PersonStrip person={p} meta={cardMeta(t.journey.employee)} />
            <Facts items={[
              ["Journey", t.journey.title],
              ["Due", <span key="due" className={overdue ? "neg strong" : undefined}>{formatDate(t.dueDate)}</span>],
              ["Owner", humanise(t.owner)],
              ["Category", humanise(t.category)],
              ["Required", t.isRequired ? "Yes" : "Optional"],
            ]} />
          </DetailPane>
        );
      },
    });
  }

  // ---- Documents to verify -------------------------------------------------
  if (can(viewer, P.DOCUMENT_VERIFY)) {
    const where = {
      tenantId, status: "PENDING_VERIFICATION", ...notSelf,
      employee: scopedEmployeeWhere(viewer, P.DOCUMENT_VERIFY),
    } as Prisma.EmployeeDocumentWhereInput;
    sources.push({
      key: "documents", label: "Documents to verify", icon: <IconFile />, always: true,
      count: () => prisma.employeeDocument.count({ where }),
      list: async () => (await prisma.employeeDocument.findMany({ where, include: { employee: { select: EMP } }, orderBy: { uploadedAt: "desc" }, take: 200 }))
        .map((d) => ({ id: d.id, person: person(d.employee), title: d.name, at: d.uploadedAt ?? d.createdAt })),
      detail: async (id) => {
        const d = await prisma.employeeDocument.findFirst({
          where: { ...where, id },
          include: { employee: { select: EMP_CARD }, documentType: { select: { name: true, isMandatory: true } }, folder: { select: { name: true, isConfidential: true } } },
        });
        if (!d) return null;
        const people = await resolvePeople(tenantId, [d.uploadedBy]);
        const p = person(d.employee);
        const at = d.uploadedAt ?? d.createdAt;
        return (
          <DetailPane title={d.name} sub={initiated(at)} status={{ label: "Pending verification", tone: "pending" }}
            actions={(
              <>
                <form action={verifyDocumentFromInbox}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <button className="btn sm primary" type="submit">Verify</button>
                </form>
                <form action={verifyDocumentFromInbox} className="row gap-2">
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <input className="input" name="reason" placeholder="Reason for rejecting" aria-label="Reason for rejecting" required style={{ width: 200, padding: "4px 8px", fontSize: 13 }} />
                  <button className="btn sm" type="submit">Reject</button>
                </form>
              </>
            )}
            activity={[{ who: d.uploadedBy ? who(people, d.uploadedBy) : p, text: "Uploaded the document for verification", at }]}>
            <PersonStrip person={p} meta={cardMeta(d.employee)} />
            <Facts items={[
              ["Document type", d.documentType ? `${d.documentType.name}${d.documentType.isMandatory ? " · mandatory" : ""}` : null],
              ["Folder", d.folder ? `${d.folder.name}${d.folder.isConfidential ? " · confidential" : ""}` : null],
              d.issuedOn ? ["Issued on", formatDate(d.issuedOn)] : null,
              d.expiresOn ? ["Expires on", formatDate(d.expiresOn)] : null,
            ]} />
            {d.fileUrl?.startsWith("/files/") ? <a className="btn sm" href={d.fileUrl} target="_blank" rel="noreferrer">View the file</a> : null}
          </DetailPane>
        );
      },
    });
  }

  // ---- Helpdesk tickets assigned to the viewer -----------------------------
  if (can(viewer, P.HELPDESK_MANAGE)) {
    const where: Prisma.HelpdeskTicketWhereInput = { tenantId, assigneeUserId: viewer.user.id, status: { in: ["OPEN", "IN_PROGRESS"] } };
    sources.push({
      key: "helpdesk", label: "Helpdesk tickets", icon: <IconHeadset />, always: true,
      count: () => prisma.helpdeskTicket.count({ where }),
      list: async () => (await prisma.helpdeskTicket.findMany({ where, include: { employee: { select: EMP } }, orderBy: { createdAt: "desc" }, take: 200 }))
        .map((t) => ({
          id: t.id, person: person(t.employee), title: `HD-${t.number} · ${t.subject}`, at: t.createdAt,
          tag: t.dueAt < new Date() ? "Overdue" : t.priority === "HIGH" || t.priority === "URGENT" ? humanise(t.priority) : undefined,
          tagTone: t.dueAt < new Date() ? "danger" as const : undefined,
        })),
      detail: async (id) => {
        const t = await prisma.helpdeskTicket.findFirst({
          where: { ...where, id },
          include: {
            employee: { select: EMP_CARD }, category: { select: { name: true } },
            comments: { where: { isInternal: false }, orderBy: { createdAt: "asc" }, select: { authorUserId: true, body: true, createdAt: true } },
          },
        });
        if (!t) return null;
        const people = await resolvePeople(tenantId, t.comments.map((c) => c.authorUserId));
        const p = person(t.employee);
        const overdue = t.dueAt < new Date();
        return (
          <DetailPane title={`HD-${t.number} · ${t.subject}`} sub={initiated(t.createdAt)} status={{ label: humanise(t.status), tone: overdue ? "danger" : "pending" }}
            actions={(
              <div className="stack gap-2" style={{ width: "100%" }}>
                <ReplyForm ticketId={t.id} asAgent />
                <Link className="btn sm ghost" href={`/helpdesk/${t.id}`} style={{ alignSelf: "flex-start" }}>Open the ticket</Link>
              </div>
            )}
            activity={[
              { who: p, text: `Raised the ticket in ${t.category.name}`, at: t.createdAt },
              ...t.comments.map((c) => ({ who: who(people, c.authorUserId), text: "Replied", note: c.body.length > 280 ? `${c.body.slice(0, 280)}…` : c.body, at: c.createdAt })),
            ]}>
            <PersonStrip person={p} meta={cardMeta(t.employee)} />
            <Facts items={[
              ["Category", t.category.name],
              ["Priority", humanise(t.priority)],
              ["Due", <span key="due" className={overdue ? "neg strong" : undefined}>{formatInstantDate(t.dueAt)}</span>],
            ]} />
            <Message label="Description">{t.description}</Message>
          </DetailPane>
        );
      },
    });
  }

  return sources;
}
